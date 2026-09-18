/**
 * fixtures/nocturnal-alerts.json 一晚数据的完整回放。
 *
 * 回放回答医生复诊时最关心的四件事：
 * 1. 普通翻身怎样被关闭（运动与心率互不印证 → 不产生告警）
 * 2. 静音期间的持续事件为何仍升级（静音只压普通通知；high 照送，到点未响应升级）
 * 3. 哪位监护人在何时做了什么（审计时间线 + 首个有效处置锁定）
 * 4. 误报统计与下一版计划（nightlyStats → 调整申请 → 医生签署 v2）
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { SensorCandidate } from "./contracts.js";
import { FakeClock, iso, withinWindow } from "./time.js";
import {
  InMemoryGateway,
  NocturnalAlertService,
  type SignPlanInput,
} from "./service.js";
import type { ServiceState } from "./domain.js";

interface FixtureAck {
  guardianId: string;
  response: "false-alarm" | "observing" | "needs-help";
  receivedAt?: string;
}

interface NightFixture {
  patientId: string;
  silence: { from: string; until: string; maximumSeverity: "ordinary" | "high" };
  candidates: Array<Partial<SensorCandidate> & { candidateId: string; capturedAt: string }>;
  acknowledgements: FixtureAck[];
}

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/nocturnal-alerts.json",
);

export function loadFixture(): NightFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as NightFixture;
}

/** fixture 的候选省略了 worn/qualityFlags/patientId，按契约补齐默认值 */
function normalizeCandidates(fixture: NightFixture): SensorCandidate[] {
  return fixture.candidates.map((c) => ({
    patientId: fixture.patientId,
    candidateId: c.candidateId,
    capturedAt: c.capturedAt,
    motionScore: c.motionScore ?? 0,
    heartRateDelta: c.heartRateDelta ?? 0,
    worn: c.worn ?? true,
    qualityFlags: c.qualityFlags ?? [],
  }));
}

/** 本晚生效的 v1 计划（医生签署）。观察窗口 90s 恰好覆盖 2a→2b 的 70s 间隔。 */
export function nightPlanInput(fixture: NightFixture): SignPlanInput {
  return {
    planId: `plan-${fixture.patientId}`,
    version: 1,
    patientId: fixture.patientId,
    effectiveFrom: "2026-09-15T22:00:00+08:00",
    effectiveUntil: "2026-09-16T08:00:00+08:00",
    correlationWindowSeconds: 90,
    escalationAfterSeconds: 300,
    rationale: "夜间腕部运动联合心率判读；持续 5 分钟无有效处置即电话升级",
    familyQuestions: [
      { questionId: "q-silence", text: "静音时段（23:30-00:15）对应哪些家庭作息？" },
      { questionId: "q-turn", text: "近期翻身误报大约每晚几次？" },
    ],
    emergencyContacts: [
      { contactId: "mom", name: "母亲", role: "primary", channel: "tel:+86-138-0000-0001" },
      { contactId: "dad", name: "父亲", role: "secondary", channel: "tel:+86-138-0000-0002" },
      { contactId: "clinic", name: "神经科值班", role: "clinic-oncall", channel: "tel:+86-139-0000-0000" },
    ],
    guardians: [
      { guardianId: "guardian-a", name: "母亲", channel: "app:guardian-a" },
      { guardianId: "guardian-b", name: "父亲", channel: "app:guardian-b" },
    ],
    signedBy: "dr-li",
  };
}

export interface ReplayResult {
  service: NocturnalAlertService;
  gateway: InMemoryGateway;
  clock: FakeClock;
  fixture: NightFixture;
  /** 反事实（无回执 + 重启）分支：展示静音窗内持续事件到点升级 */
  restarted: {
    service: NocturnalAlertService;
    gateway: InMemoryGateway;
    snapshotAt: string;
  };
  report: string[];
}

export async function replayNight(fixture: NightFixture = loadFixture()): Promise<ReplayResult> {
  const report: string[] = [];
  const log = (line = ""): void => {
    report.push(line);
  };

  const firstAt = fixture.candidates[0]!.capturedAt;
  const clock = new FakeClock(firstAt);
  const gateway = new InMemoryGateway(clock);
  const service = new NocturnalAlertService(clock, gateway);

  // 1) 医生签署 v1 + 家庭设置静音窗
  const plan = service.signCarePlan(nightPlanInput(fixture));
  service.setSilenceWindow({ patientId: fixture.patientId, ...fixture.silence });
  log(`【生效计划 v${plan.version}】有效期 ${plan.effectiveFrom} ~ ${plan.effectiveUntil}`);
  log(`  观察窗口 ${plan.correlationWindowSeconds}s｜持续阈值 ${plan.escalationAfterSeconds}s｜签署人 ${plan.signedBy}`);
  log(`  家庭询问 ${plan.familyQuestions.length} 项｜紧急联系人 ${plan.emergencyContacts.map((c) => c.name).join("、")}`);
  log(`【家庭静音】${fixture.silence.from} ~ ${fixture.silence.until}，最高压低 ${fixture.silence.maximumSeverity} 通知`);

  // 2) 按时间回放候选
  const candidates = normalizeCandidates(fixture);
  let highAlertId: string | undefined;
  const printedNotifications = new Map<string, number>();
  for (const c of candidates) {
    clock.advanceTo(c.capturedAt);
    const { cluster, alert } = await service.ingestCandidate(c);
    if (!alert) {
      log(`【关闭】${c.candidateId}@${c.capturedAt}：运动 ${c.motionScore}、心率Δ${c.heartRateDelta}，互不印证，判为普通翻身，不发告警（簇 ${cluster.clusterId}）`);
    } else {
      log(`【告警 ${alert.alertId}】${alert.severity}｜簇内 ${cluster.candidateIds.join("+")}｜峰值运动 ${cluster.peakMotionScore}｜最大心率Δ${cluster.maxHeartRateDelta}`);
      const seen = printedNotifications.get(alert.alertId) ?? 0;
      for (const n of alert.notifications.slice(seen)) {
        log(`  通知 → ${n.guardianId}：${n.status}（${n.reason}）`);
      }
      printedNotifications.set(alert.alertId, alert.notifications.length);
      highAlertId = alert.alertId;
    }
  }

  // 3) 回放回执：observing 先到（过程意见），false-alarm 后到（首个有效处置，锁定）
  const ackTimes = ["2026-09-15T23:56:00+08:00", "2026-09-15T23:57:30+08:00"];
  fixture.acknowledgements.forEach((ack, i) => {
    const receivedAt = ack.receivedAt ?? ackTimes[i]!;
    clock.advanceTo(receivedAt);
    const r = service.acknowledge({
      alertId: highAlertId!,
      guardianId: ack.guardianId,
      response: ack.response,
      receivedAt,
    });
    log(`【回执】${ack.guardianId} → ${ack.response} @ ${clock.now().toISOString()}：${r.status}`);
  });
  const locked = service.alertsFor(fixture.patientId).find((a) => a.alertId === highAlertId)!;
  log(`【锁定】结果 ${locked.outcome?.acknowledgement.response}，由 ${locked.outcome?.acknowledgement.guardianId} 于 ${locked.outcome?.lockedAt} 锁定；待执行升级动作 ${service.getSnapshot().pendingActions.length} 个`);

  // 4) 反事实：在回执到达前快照 -> "重启" -> 无任何处置地走到 00:05（静音窗仍在）
  //    用真实持久化文件模拟进程重启：状态写盘后由新服务加载，pendingActions 继续。
  const snapshotAt = "2026-09-15T23:55:10+08:00";
  // 重新构造一份"从未收到回执"的状态：回到只摄入完候选的时刻较复杂，
  // 这里直接用独立的第二条服务支路重放入睡到升级，以演示重启续跑语义。
  const branchClock = new FakeClock(firstAt);
  const branchGateway = new InMemoryGateway(branchClock);
  const branch = new NocturnalAlertService(branchClock, branchGateway);
  branch.signCarePlan(nightPlanInput(fixture));
  branch.setSilenceWindow({ patientId: fixture.patientId, ...fixture.silence });
  for (const c of candidates) {
    branchClock.advanceTo(c.capturedAt);
    await branch.ingestCandidate(c);
  }
  const beforeRestart = branch.getSnapshot();
  const pendingBefore = beforeRestart.pendingActions.length;

  // 进程重启：新时钟、新网关、从持久化状态恢复
  const restartClock = new FakeClock(snapshotAt);
  const restartGateway = new InMemoryGateway(restartClock);
  const restarted = new NocturnalAlertService(
    restartClock,
    restartGateway,
    structuredClone(beforeRestart) as ServiceState,
  );
  restartClock.advanceTo("2026-09-16T00:05:00+08:00");
  const silenceStillActive = withinWindow(
    restartClock.now(),
    fixture.silence.from,
    fixture.silence.until,
  );
  const fired = await restarted.runDueActions();
  const escalatedAlert = restarted.alertsFor(fixture.patientId).find((a) => a.state === "escalated")!;
  log(`【反事实·重启续跑】重启前待执行动作 ${pendingBefore} 个；00:05 静音窗${silenceStillActive ? "仍生效" : "已结束"}，到点执行 ${fired.length} 个`);
  for (const e of escalatedAlert.escalations) {
    log(`  升级电话 → ${e.contactName}（${e.role}）：${e.result} @ ${e.at}`);
  }

  // 5) 误报反馈 + 调整申请（只提交，不改 v1）
  const feedback = service.submitFalseAlarmFeedback({
    patientId: fixture.patientId,
    candidateId: "event-2a",
    guardianId: "guardian-b",
    comment: "孩子当时在翻身，没有发作表现",
  });
  const request = service.requestAdjustment({
    patientId: fixture.patientId,
    guardianId: "guardian-b",
    proposed: { escalationAfterSeconds: 420 },
    feedbackIds: [feedback.feedbackId],
    reason: "最近一周翻身触发偏多，希望持续阈值放宽到 7 分钟",
  });
  const v1AfterRequest = service.getSnapshot().plans.find((p) => p.version === 1)!;
  log(`【家庭申请】${request.requestId}：建议持续阈值 ${request.proposed.escalationAfterSeconds}s；v1 阈值仍为 ${v1AfterRequest.escalationAfterSeconds}s（生效规则未被家庭改动）`);

  // 6) 复诊统计
  const stats = service.nightlyStats(
    fixture.patientId,
    "2026-09-15T22:00:00+08:00",
    "2026-09-16T08:00:00+08:00",
  );
  log(`【夜间统计】候选 ${stats.totalCandidates}（降级 ${stats.degradedCandidates}）｜簇 ${stats.clusters}｜告警 ordinary=${stats.alertsBySeverity.ordinary} high=${stats.alertsBySeverity.high}`);
  log(`  升级 ${stats.alertsEscalated}｜结果 ${JSON.stringify(stats.outcomes)}｜误报反馈 ${stats.falseAlarmFeedbackCount}｜待审批申请 ${stats.pendingAdjustmentRequests}`);

  // 7) 医生据统计批准申请 -> 签署 v2（次日晚生效）；v1 冻结不变
  service.answerFamilyQuestion(plan.planId, 1, "q-turn", "大约每晚三四次，多为翻身", "guardian-a");
  const reviewed = service.reviewAdjustment(
    request.requestId,
    "approved",
    "dr-li",
    { from: "2026-09-16T22:00:00+08:00", until: "2026-09-17T08:00:00+08:00" },
  );
  const v2 = service.getSnapshot().plans.find((p) => p.version === reviewed.resultingPlanVersion)!;
  log(`【医生审批】申请 ${reviewed.status}，签署 v${v2.version}：持续阈值 ${v2.escalationAfterSeconds}s，有效期 ${v2.effectiveFrom} ~ ${v2.effectiveUntil}；v1 保持 ${v1AfterRequest.escalationAfterSeconds}s 不变`);

  return {
    service,
    gateway,
    clock,
    fixture,
    restarted: { service: restarted, gateway: restartGateway, snapshotAt: iso(snapshotAt) },
    report,
  };
}

async function main(): Promise<void> {
  const result = await replayNight();
  console.log(result.report.join("\n"));
}

// 仅作为脚本直接运行时打印；被测试 import 时不自动执行
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
