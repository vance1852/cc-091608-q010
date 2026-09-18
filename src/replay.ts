// 回放 fixtures/nocturnal-alerts.json 的完整一夜：
//   普通翻身如何被关闭 -> 静音期间普通通知被压低但持续事件仍升级 ->
//   高严重度在静音中照常送达 -> 矛盾回执由首个有效处置锁定并保留后来意见 ->
//   崩溃重启后尚未执行的定时升级继续 -> 家庭误报反馈与调整申请 -> 医生签署下一版。
//
// 运行：node src/replay.ts [fixture路径]

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SensorCandidate, SilenceWindow } from "./contracts.ts";
import { createNocturnalService, type ServiceHandle } from "./service.ts";
import { buildNightReview, formatReview } from "./report.ts";
import { JsonStateStore } from "./store.ts";
import { formatInOffset } from "./time.ts";

interface FixtureAck {
  acknowledgementId?: string;
  guardianId: string;
  response: "false-alarm" | "observing" | "needs-help";
  receivedAt: string;
}

interface Fixture {
  patientId: string;
  silence: SilenceWindow;
  candidates: Array<
    SensorCandidate & { acknowledgementId?: string }
  >;
  acknowledgements: FixtureAck[];
}

const roster = {
  "child-06": {
    guardianIds: ["guardian-a", "guardian-b"],
    hospital: { name: "儿童神经科值班", phone: "010-5555-0606" },
  },
};

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const fixturePath = process.argv[2] ?? join(here, "..", "fixtures", "nocturnal-alerts.json");
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture;

  const dir = mkdtempSync(join(tmpdir(), "nocturnal-"));
  const statePath = join(dir, "state.json");

  const planInput = {
    planId: "plan-child-06",
    patientId: fixture.patientId,
    effectiveFrom: "2026-09-15T22:00:00+08:00",
    effectiveUntil: "2026-09-16T06:00:00+08:00",
    correlationWindowSeconds: 120,
    escalationAfterSeconds: 180,
    motionThreshold: 0.8,
    heartRateDeltaThreshold: 20,
    signedBy: "dr-chen",
    familyQuestions: [
      "翻身类告警时孩子是否真的醒来或哭闹？",
      "静音窗口内家长是否仍能察觉持续动作？",
      "设备脱落发生在睡前佩戴还是夜间松开？",
    ],
    emergencyContacts: [
      { name: "陈医生", role: "儿童神经科主治", phone: "138-0000-0006" },
    ],
  };

  // ---- 阶段一：服务启动、医生签署计划、家庭打开短时静音 ----
  let svc: ServiceHandle = createNocturnalService({
    statePath,
    rosters: roster,
    tickIntervalMs: 0,
    now: () => new Date("2026-09-15T22:00:00+08:00"),
  });

  const v1 = svc.registry.signPlan(
    planInput,
    "clinician",
    "2026-09-15T18:00:00+08:00",
  );
  console.log(
    `医生签署 v${v1.version}：有效期 ${v1.effectiveFrom} ~ ${v1.effectiveUntil}，` +
      `观察窗口 ${v1.correlationWindowSeconds}s，持续阈值 ${v1.escalationAfterSeconds}s`,
  );

  // 监护人无权签署：尝试必须失败
  try {
    svc.registry.signPlan(planInput, "guardian", "2026-09-15T18:05:00+08:00");
    throw new Error("不应允许监护人签署计划");
  } catch (err) {
    console.log(`监护人改计划被拒绝：${(err as Error).message}`);
  }
  // 静音不得覆盖高严重度
  try {
    svc.engine.addSilence(
      { ...fixture.silence, maximumSeverity: "high" },
      "guardian-a",
    );
    throw new Error("不应允许覆盖 high 的静音");
  } catch (err) {
    console.log(`高严重度静音被拒绝：${(err as Error).message}`);
  }
  svc.engine.addSilence(fixture.silence, "guardian-a");
  console.log(
    `监护人开启静音：${fixture.silence.from} ~ ${fixture.silence.until}（仅压低 ordinary）`,
  );

  // ---- 阶段二：摄入整夜候选 ----
  const candidates: SensorCandidate[] = fixture.candidates.map((c) => ({
    candidateId: c.candidateId,
    patientId: fixture.patientId,
    capturedAt: c.capturedAt,
    motionScore: c.motionScore,
    heartRateDelta: c.heartRateDelta,
    worn: c.worn,
    qualityFlags: c.qualityFlags,
  }));
  const alerts = svc.engine.ingestCandidates(
    candidates,
    new Date("2026-09-15T22:00:00+08:00"),
  );
  const findAlert = (cid: string) =>
    alerts.find((a) => a.candidateIds.includes(cid))!;
  const sustainedAlert = findAlert("event-2a");
  console.log(
    `整夜候选关联完成：生成 ${alerts.length} 条告警，` +
      `${alerts.filter((a) => a.severity === "high").length} 条高严重度；` +
      `普通翻身/脱落/低质量区间仅记录不打扰`,
  );

  // ---- 阶段三：按时间线处理回执与到期升级（崩溃前）----
  // 静音中的普通运动事件 180s 无响应 -> 仍按计划升级
  svc.catchUp(new Date("2026-09-15T23:43:00+08:00"));
  const ordinaryAlert = findAlert("blip-motion");
  console.log(
    `23:43 静音中的普通事件持续未响应 -> ${ordinaryAlert.status}，` +
      `升级呼叫 ${ordinaryAlert.notifications.filter((n) => n.channel === "escalation-call").length} 通`,
  );

  // 高严重度持续事件：observing -> false-alarm 锁定 -> needs-help 后来意见
  for (const ack of fixture.acknowledgements) {
    svc.engine.acknowledge({
      alertId: sustainedAlert.alertId,
      guardianId: ack.guardianId,
      response: ack.response,
      receivedAt: ack.receivedAt,
      ...(ack.acknowledgementId
        ? { acknowledgementId: ack.acknowledgementId }
        : {}),
    });
  }
  svc.catchUp(new Date("2026-09-15T23:57:00+08:00"));
  console.log(
    `持续事件：锁定=${sustainedAlert.locked?.guardianId}/${sustainedAlert.locked?.response}，` +
      `保留后来意见 ${sustainedAlert.laterOpinionIds.length} 条，最终状态 ${sustainedAlert.status}`,
  );

  const pendingBeforeCrash = svc.pendingCount();
  console.log(`23:57 服务崩溃；磁盘上仍有 ${pendingBeforeCrash} 个待执行定时动作`);

  // ---- 阶段四：重启，尚未执行的定时动作继续 ----
  svc.stop();
  svc = createNocturnalService({
    statePath,
    rosters: roster,
    tickIntervalMs: 0,
    now: () => new Date("2026-09-15T23:57:00+08:00"),
  });
  const pendingAfterRestart = svc.pendingCount();
  svc.catchUp(new Date("2026-09-16T00:12:00+08:00"));
  const event5 = svc.engine
    .listAlerts(fixture.patientId)
    .find((a) => a.candidateIds.includes("event-5a"))!;
  console.log(
    `重启后恢复 ${pendingAfterRestart} 个待执行动作；含设备脱落标注的高严重度事件于 ` +
      `${formatInOffset(new Date(event5.escalatedAt!), event5.startedAt)} 升级（脱落已如实标注：${event5.hadDeviceOff}）`,
  );

  // ---- 阶段五：家庭误报反馈与调整申请（不改生效规则）----
  const blipAfterRestart = svc.engine
    .listAlerts(fixture.patientId)
    .find((a) => a.candidateIds.includes("blip-motion"))!;
  svc.registry.submitFeedback({
    feedbackId: "fb-1",
    patientId: fixture.patientId,
    alertId: blipAfterRestart.alertId,
    guardianId: "guardian-b",
    falseAlarm: true,
    comment: "只是翻身，手机却被吵醒。",
    createdAt: "2026-09-16T07:00:00+08:00",
  });
  const req = svc.registry.requestAdjustment({
    requestId: "adj-1",
    planId: planInput.planId,
    patientId: fixture.patientId,
    requestedBy: "guardian-b",
    requestedAt: "2026-09-16T07:05:00+08:00",
    proposed: { motionThreshold: 0.9 },
    reason: "单纯翻身腕部分值约 0.85，建议提高运动阈值减少误报。",
    relatedAlertIds: [blipAfterRestart.alertId],
  });
  const stillV1 = svc.registry.getPlan(planInput.planId, 1)!;
  console.log(
    `家庭调整申请 ${req.requestId}（${req.status}）；生效中 v1 的运动阈值仍为 ${stillV1.motionThreshold}`,
  );

  // ---- 阶段六：医生复诊，批准申请并签署 v2，互相留痕 ----
  const v2 = svc.registry.signPlan(
    {
      ...planInput,
      effectiveFrom: "2026-09-16T20:00:00+08:00",
      effectiveUntil: "2026-09-23T08:00:00+08:00",
      motionThreshold: 0.9,
    },
    "clinician",
    "2026-09-16T08:10:00+08:00",
  );
  svc.registry.approveAdjustment(
    req.requestId,
    "dr-chen",
    "clinician",
    "2026-09-16T08:10:00+08:00",
    v2.version,
    "结合误报统计，运动阈值上调到 0.9；持续升级时长不变。",
  );
  console.log(
    `复诊后医生签署 v${v2.version}，申请 ${req.requestId} 已批准并关联 v${v2.version}`,
  );

  // ---- 复诊报告：从落盘状态读取 ----
  const persisted = new JsonStateStore(statePath).load();
  const review = buildNightReview(
    fixture.patientId,
    persisted.store,
    svc.registry,
    "2026-09-16T08:15:00+08:00",
  );
  console.log("\n" + formatReview(review));

  svc.stop();
  rmSync(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
