/**
 * 端到端测试：以 fixture 回放为骨架，覆盖静音边界、升级、回执锁定、
 * 设备脱落标注、重启续跑与"家庭不能改临床规则"。
 */
import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SensorCandidate, SilenceWindow } from "./contracts.js";
import { FakeClock, addSeconds, iso } from "./time.js";
import { correlateCandidates, classifyCluster, DEFAULT_THRESHOLDS } from "./correlation.js";
import { InMemoryGateway, NocturnalAlertService, type SignPlanInput } from "./service.js";
import { JsonFileStore } from "./persistence.js";
import { loadFixture, nightPlanInput, replayNight } from "./replay.js";

const PATIENT = "child-test";

function basePlan(overrides: Partial<SignPlanInput> = {}): SignPlanInput {
  return {
    planId: "plan-test",
    version: 1,
    patientId: PATIENT,
    effectiveFrom: "2026-09-15T20:00:00+08:00",
    effectiveUntil: "2026-09-16T08:00:00+08:00",
    correlationWindowSeconds: 90,
    escalationAfterSeconds: 300,
    rationale: "测试计划",
    familyQuestions: [{ questionId: "q1", text: "夜间翻身频率？" }],
    emergencyContacts: [
      { contactId: "mom", name: "母亲", role: "primary", channel: "tel:1" },
      { contactId: "clinic", name: "值班医生", role: "clinic-oncall", channel: "tel:9" },
    ],
    guardians: [
      { guardianId: "g-a", name: "妈妈", channel: "app:a" },
      { guardianId: "g-b", name: "爸爸", channel: "app:b" },
    ],
    signedBy: "dr-li",
    ...overrides,
  };
}

function candidate(
  candidateId: string,
  capturedAt: string,
  motionScore: number,
  heartRateDelta: number,
  extra: Partial<SensorCandidate> = {},
): SensorCandidate {
  return {
    candidateId,
    patientId: PATIENT,
    capturedAt,
    motionScore,
    heartRateDelta,
    worn: true,
    qualityFlags: [],
    ...extra,
  };
}

async function harness(): Promise<{
  clock: FakeClock;
  gateway: InMemoryGateway;
  service: NocturnalAlertService;
}> {
  const clock = new FakeClock("2026-09-15T20:00:00+08:00");
  const gateway = new InMemoryGateway(clock);
  const service = new NocturnalAlertService(clock, gateway);
  service.signCarePlan(basePlan());
  return { clock, gateway, service };
}

describe("关联与普通翻身关闭", () => {
  test("运动与心率互不印证的孤立候选不产生告警", async () => {
    const { clock, gateway, service } = await harness();
    clock.advanceTo("2026-09-15T22:50:00+08:00");
    const { alert } = await service.ingestCandidate(
      candidate("turn-1", "2026-09-15T22:50:00+08:00", 0.35, 2),
    );
    assert.equal(alert, undefined);
    assert.equal(service.alertsFor(PATIENT).length, 0);
    assert.equal(gateway.pushes.length, 0);
  });

  test("观察窗口内的强运动+心率升高归为同一簇并判为 high", async () => {
    const { clock, service } = await harness();
    const c1 = candidate("e1", "2026-09-15T23:54:00+08:00", 0.91, 28);
    const c2 = candidate("e2", "2026-09-15T23:55:10+08:00", 0.88, 31);
    clock.advanceTo(c1.capturedAt);
    const r1 = await service.ingestCandidate(c1);
    assert.equal(r1.alert?.severity, "high");
    clock.advanceTo(c2.capturedAt);
    const r2 = await service.ingestCandidate(c2);
    // 70s < 90s 观察窗口：并入同一告警，不重复开单
    assert.equal(r2.alert?.alertId, r1.alert?.alertId);
    assert.equal(r2.cluster.candidateIds.length, 2);
    assert.equal(service.alertsFor(PATIENT).length, 1);
  });

  test("超过观察窗口的后续运动另成一簇", () => {
    const clusters = correlateCandidates(
      [
        candidate("a", "2026-09-15T23:00:00+08:00", 0.9, 25),
        candidate("b", "2026-09-15T23:05:00+08:00", 0.9, 25),
      ],
      90,
    );
    assert.equal(clusters.length, 2);
  });

  test("classifyCluster 不采信脱落/低质量样本", () => {
    const c = candidate("x", "2026-09-15T23:00:00+08:00", 0.95, 30, {
      worn: false,
    });
    const clusters = correlateCandidates([c], 90);
    const verdict = classifyCluster(clusters[0]!, new Map([[c.candidateId, c]]), DEFAULT_THRESHOLDS);
    assert.equal(verdict, "none");
    assert.equal(clusters[0]!.quality, "device-off");
  });
});

describe("静音边界", () => {
  const silence: SilenceWindow = {
    patientId: PATIENT,
    from: "2026-09-15T23:30:00+08:00",
    until: "2026-09-16T00:15:00+08:00",
    maximumSeverity: "ordinary",
  };

  test("静音窗内 ordinary 通知被压低但留痕", async () => {
    const { clock, service } = await harness();
    service.setSilenceWindow(silence);
    clock.advanceTo("2026-09-15T23:40:00+08:00");
    // 仅运动强、心率不显著 → ordinary
    const { alert } = await service.ingestCandidate(
      candidate("m1", "2026-09-15T23:40:00+08:00", 0.9, 5),
    );
    assert.equal(alert?.severity, "ordinary");
    for (const n of alert!.notifications) assert.equal(n.status, "suppressed");
  });

  test("静音窗内 high 通知照常送达，不被静音吞掉", async () => {
    const { clock, gateway, service } = await harness();
    service.setSilenceWindow(silence);
    clock.advanceTo("2026-09-15T23:54:00+08:00");
    const { alert } = await service.ingestCandidate(
      candidate("h1", "2026-09-15T23:54:00+08:00", 0.91, 28),
    );
    assert.equal(alert?.severity, "high");
    assert.equal(alert?.mutedAtBirth, false);
    assert.ok(alert!.notifications.every((n) => n.status === "delivered"));
    assert.equal(gateway.pushes.length, 2);
  });

  test("静音窗结束后普通通知恢复送达", async () => {
    const { clock, service } = await harness();
    service.setSilenceWindow(silence);
    clock.advanceTo("2026-09-16T00:20:00+08:00");
    const { alert } = await service.ingestCandidate(
      candidate("m2", "2026-09-16T00:20:00+08:00", 0.85, 1),
    );
    assert.equal(alert?.severity, "ordinary");
    assert.ok(alert!.notifications.every((n) => n.status === "delivered"));
  });

  test("家庭不能设置覆盖 high 的静音窗", async () => {
    const { service } = await harness();
    assert.throws(
      () =>
        service.setSilenceWindow({
          patientId: PATIENT,
          from: "2026-09-15T23:30:00+08:00",
          until: "2026-09-16T00:15:00+08:00",
          maximumSeverity: "high",
        }),
      /high/,
    );
  });
});

describe("持续未响应升级", () => {
  test("到 escalationAfterSeconds 无有效处置则按联系人顺序电话升级，静音不阻止", async () => {
    const { clock, gateway, service } = await harness();
    service.setSilenceWindow({
      patientId: PATIENT,
      from: "2026-09-15T23:30:00+08:00",
      until: "2026-09-16T00:15:00+08:00",
      maximumSeverity: "ordinary",
    });
    clock.advanceTo("2026-09-15T23:54:00+08:00");
    const { alert } = await service.ingestCandidate(
      candidate("h", "2026-09-15T23:54:00+08:00", 0.91, 28),
    );
    assert.equal(alert?.escalateAfter, iso(addSeconds("2026-09-15T23:54:00+08:00", 300)));

    // observing 不是有效处置，不能取消升级
    clock.advanceTo("2026-09-15T23:56:00+08:00");
    service.acknowledge({ alertId: alert!.alertId, guardianId: "g-a", response: "observing" });

    // 差一秒未到期
    clock.advanceTo("2026-09-15T23:58:59+08:00");
    assert.equal((await service.runDueActions()).length, 0);
    assert.equal(gateway.calls.length, 0);

    clock.advanceTo("2026-09-16T00:05:00+08:00"); // 静音窗仍在
    const fired = await service.runDueActions();
    assert.equal(fired.length, 1);
    assert.equal(gateway.calls.length, 1);
    assert.equal(gateway.calls[0]!.contact.role, "primary");

    const after = service.alertsFor(PATIENT).find((a) => a.alertId === alert!.alertId)!;
    assert.equal(after.state, "escalated");
  });

  test("首个终结性处置在到期前到达则取消升级动作", async () => {
    const { clock, service } = await harness();
    clock.advanceTo("2026-09-15T23:54:00+08:00");
    const { alert } = await service.ingestCandidate(
      candidate("h", "2026-09-15T23:54:00+08:00", 0.91, 28),
    );
    assert.equal(service.getSnapshot().pendingActions.length, 1);

    clock.advanceTo("2026-09-15T23:55:00+08:00");
    const r = service.acknowledge({ alertId: alert!.alertId, guardianId: "g-b", response: "false-alarm" });
    assert.equal(r.status, "locked");
    assert.equal(service.getSnapshot().pendingActions.length, 0);

    clock.advanceTo("2026-09-16T01:00:00+08:00");
    assert.equal((await service.runDueActions()).length, 0);
    assert.equal(r.alert.state, "resolved");
  });

  test("primary 联系人未送达时依次尝试后续联系人", async () => {
    const clock = new FakeClock("2026-09-15T20:00:00+08:00");
    const gateway = new InMemoryGateway(clock);
    gateway.failRoles.add("primary"); // 模拟主联系人电话未接通
    const service = new NocturnalAlertService(clock, gateway);
    service.signCarePlan(basePlan());
    clock.advanceTo("2026-09-15T23:54:00+08:00");
    const { alert } = await service.ingestCandidate(
      candidate("h", "2026-09-15T23:54:00+08:00", 0.91, 28),
    );
    clock.advanceTo("2026-09-16T00:00:00+08:00");
    await service.runDueActions();
    assert.deepEqual(
      gateway.calls.map((c) => c.contact.role),
      ["primary", "clinic-oncall"],
    );
    const escalated = service.alertsFor(PATIENT).find((a) => a.alertId === alert!.alertId)!;
    assert.deepEqual(
      escalated.escalations.map((e) => e.result),
      ["failed", "delivered"],
    );
  });
});

describe("回执：首个有效处置锁定，矛盾意见保留", () => {
  async function sustainedAlert(): Promise<{ service: NocturnalAlertService; alertId: string; clock: FakeClock }> {
    const h = await harness();
    h.clock.advanceTo("2026-09-15T23:54:00+08:00");
    const { alert } = await h.service.ingestCandidate(
      candidate("h", "2026-09-15T23:54:00+08:00", 0.91, 28),
    );
    return { service: h.service, alertId: alert!.alertId, clock: h.clock };
  }

  test("observing 先到不锁定，随后 needs-help 锁定；迟到的 false-alarm 进 superseded", async () => {
    const { service, alertId, clock } = await sustainedAlert();
    clock.advanceTo("2026-09-15T23:55:00+08:00");
    assert.equal(
      service.acknowledge({ alertId, guardianId: "g-a", response: "observing" }).status,
      "recorded",
    );
    clock.advanceTo("2026-09-15T23:55:30+08:00");
    assert.equal(
      service.acknowledge({ alertId, guardianId: "g-b", response: "needs-help" }).status,
      "locked",
    );
    clock.advanceTo("2026-09-15T23:56:00+08:00");
    const later = service.acknowledge({ alertId, guardianId: "g-a", response: "false-alarm" });
    assert.equal(later.status, "superseded");

    const alert = service.alertsFor(PATIENT).find((a) => a.alertId === alertId)!;
    assert.equal(alert.outcome?.acknowledgement.response, "needs-help");
    assert.equal(alert.outcome?.acknowledgement.guardianId, "g-b");
    assert.deepEqual(alert.outcome?.superseded.map((a) => a.response), ["false-alarm"]);
    // 三条回执全部保留，回答"哪位监护人何时做了什么"
    assert.deepEqual(
      alert.acknowledgements.map((a) => `${a.guardianId}:${a.response}`),
      ["g-a:observing", "g-b:needs-help", "g-a:false-alarm"],
    );
    assert.equal(alert.state, "resolved");
  });

  test("锁定后再到的一致意见只记录、不重复锁定", async () => {
    const { service, alertId } = await sustainedAlert();
    service.acknowledge({ alertId, guardianId: "g-a", response: "needs-help" });
    const r = service.acknowledge({ alertId, guardianId: "g-b", response: "needs-help" });
    assert.equal(r.status, "recorded");
    assert.equal(r.alert.outcome?.superseded.length, 0);
  });

  test("非计划内监护人不能回执锁定", async () => {
    const { service, alertId } = await sustainedAlert();
    assert.throws(
      () => service.acknowledge({ alertId, guardianId: "stranger", response: "needs-help" }),
      /不是该患者计划中的监护人/,
    );
  });

  test("升级电话打出后家庭才终结：保留 escalated 事实，同时记录处置并取消重试", async () => {
    const { service, alertId, clock } = await sustainedAlert();
    clock.advanceTo("2026-09-16T00:00:00+08:00");
    await service.runDueActions();
    const before = service.alertsFor(PATIENT).find((a) => a.alertId === alertId)!;
    assert.equal(before.state, "escalated");
    assert.equal(before.escalations.length, 1);

    const r = service.acknowledge({ alertId, guardianId: "g-a", response: "needs-help" });
    assert.equal(r.status, "locked");
    assert.equal(r.alert.state, "escalated"); // 升级事实不被抹除
    assert.equal(r.alert.outcome?.acknowledgement.response, "needs-help");
    assert.equal(service.getSnapshot().pendingActions.length, 0);
  });
});

describe("设备脱落与低质量如实标注", () => {
  test("脱落簇产生 ordinary 技术告警、不安排升级，质量原因留痕", async () => {
    const { clock, service } = await harness();
    clock.advanceTo("2026-09-16T02:00:00+08:00");
    const { cluster, alert } = await service.ingestCandidate(
      candidate("off-1", "2026-09-16T02:00:00+08:00", 0.0, 0, { worn: false }),
    );
    assert.equal(cluster.quality, "device-off");
    assert.equal(alert?.severity, "ordinary");
    assert.equal(alert?.evidenceQuality, "device-off");
    assert.equal(alert?.escalateAfter, undefined);
    assert.equal(service.getSnapshot().pendingActions.length, 0);
  });

  test("低质量标志位原样保留在簇上", async () => {
    const { clock, service } = await harness();
    clock.advanceTo("2026-09-16T02:05:00+08:00");
    const { cluster } = await service.ingestCandidate(
      candidate("lq-1", "2026-09-16T02:05:00+08:00", 0.2, 1, {
        qualityFlags: ["motion-artifact", "hr-unreliable"],
      }),
    );
    assert.equal(cluster.quality, "low-quality");
    assert.deepEqual(cluster.qualityReasons, [
      "hr-unreliable@2026-09-16T02:05:00+08:00",
      "motion-artifact@2026-09-16T02:05:00+08:00",
    ]);
  });

  test("簇先可用后出现脱落样本，质量标注升级但不覆盖为更弱结论", async () => {
    const { clock, service } = await harness();
    clock.advanceTo("2026-09-16T02:10:00+08:00");
    const r1 = await service.ingestCandidate(
      candidate("ok", "2026-09-16T02:10:00+08:00", 0.91, 28),
    );
    assert.equal(r1.cluster.quality, "usable");
    clock.advanceTo("2026-09-16T02:10:30+08:00");
    const r2 = await service.ingestCandidate(
      candidate("off", "2026-09-16T02:10:30+08:00", 0, 0, { worn: false }),
    );
    assert.equal(r2.cluster.quality, "device-off");
    assert.ok(r2.cluster.qualityReasons.some((r) => r.startsWith("device-off")));
  });

  test("脱落技术告警后在同簇出现强临床信号，转为临床告警并补排升级", async () => {
    const { clock, gateway, service } = await harness();
    clock.advanceTo("2026-09-16T03:00:00+08:00");
    const r1 = await service.ingestCandidate(
      candidate("off", "2026-09-16T03:00:00+08:00", 0, 0, { worn: false }),
    );
    assert.equal(r1.alert?.escalateAfter, undefined);
    assert.equal(service.getSnapshot().pendingActions.length, 0);

    // 设备重新戴好，30s 后出现强运动+心率升高（仍在 90s 观察窗口内，同簇）
    clock.advanceTo("2026-09-16T03:00:30+08:00");
    const r2 = await service.ingestCandidate(
      candidate("seizure", "2026-09-16T03:00:30+08:00", 0.92, 29),
    );
    assert.equal(r2.alert?.alertId, r1.alert?.alertId);
    assert.equal(r2.alert?.severity, "high");
    assert.ok(r2.alert?.escalateAfter);
    assert.equal(service.getSnapshot().pendingActions.length, 1);

    // 到点不处置仍会升级——事件没有被早先的技术告警吞掉
    clock.advanceTo("2026-09-16T03:06:00+08:00");
    await service.runDueActions();
    assert.equal(gateway.calls.length, 1);
  });
});

describe("计划签署与家庭权限边界", () => {
  test("签署时强制有效期、询问、联系人和正整数阈值", () => {
    const clock = new FakeClock("2026-09-16T08:00:00+08:00");
    const service = new NocturnalAlertService(clock);
    assert.throws(() => service.signCarePlan(basePlan({ signedBy: "" })), /signedBy/);
    assert.throws(
      () => service.signCarePlan(basePlan({ effectiveUntil: "2026-09-15T20:00:00+08:00" })),
      /有效期/,
    );
    assert.throws(
      () => service.signCarePlan(basePlan({ correlationWindowSeconds: 0 })),
      /观察窗口/,
    );
    assert.throws(
      () => service.signCarePlan(basePlan({ familyQuestions: [] })),
      /家庭询问/,
    );
    assert.throws(
      () => service.signCarePlan(basePlan({ emergencyContacts: [] })),
      /紧急联系人/,
    );
  });

  test("新版本有效期不得与已签署版本重叠", async () => {
    const { service } = await harness();
    assert.throws(
      () =>
        service.signCarePlan(
          basePlan({
            version: 2,
            effectiveFrom: "2026-09-16T07:00:00+08:00",
            effectiveUntil: "2026-09-16T09:00:00+08:00",
          }),
        ),
      /重叠/,
    );
    // 首尾相接允许
    service.signCarePlan(
      basePlan({
        version: 2,
        effectiveFrom: "2026-09-16T08:00:00+08:00",
        effectiveUntil: "2026-09-16T20:00:00+08:00",
      }),
    );
  });

  test("家庭提交调整申请不改变生效计划，批准后才产生新版本", async () => {
    const { service: s2, clock: c2 } = await harness();
    c2.advanceTo("2026-09-15T22:50:00+08:00");
    await s2.ingestCandidate(candidate("turn", "2026-09-15T22:50:00+08:00", 0.35, 2));
    const feedback = s2.submitFalseAlarmFeedback({
      patientId: PATIENT,
      candidateId: "turn",
      guardianId: "g-a",
      comment: "翻身误报",
    });
    c2.advanceTo("2026-09-16T07:30:00+08:00");
    const before = s2.planAt(PATIENT, "2026-09-15T23:00:00+08:00")!;
    const req = s2.requestAdjustment({
      patientId: PATIENT,
      guardianId: "g-a",
      proposed: { escalationAfterSeconds: 420 },
      feedbackIds: [feedback.feedbackId],
      reason: "误报多",
    });
    // 生效中的 v1 原封不动
    const after = s2.planAt(PATIENT, "2026-09-15T23:00:00+08:00")!;
    assert.equal(after.escalationAfterSeconds, before.escalationAfterSeconds);
    assert.equal(after.version, 1);

    // 批准必须由医生签署新版本，且有新有效期
    assert.throws(
      () => s2.reviewAdjustment(req.requestId, "approved", "dr-li"),
      /有效期/,
    );
    s2.reviewAdjustment(req.requestId, "approved", "dr-li", {
      from: "2026-09-16T20:00:00+08:00",
      until: "2026-09-17T08:00:00+08:00",
    });
    const v2 = s2.planAt(PATIENT, "2026-09-16T21:00:00+08:00")!;
    assert.equal(v2.version, 2);
    assert.equal(v2.escalationAfterSeconds, 420);
    // v1 仍可被追溯且冻结
    assert.equal(s2.getSnapshot().plans[0]!.escalationAfterSeconds, 300);
  });

  test("没有生效计划时拒绝摄入信号", async () => {
    const clock = new FakeClock("2026-09-16T08:00:00+08:00");
    const service = new NocturnalAlertService(clock);
    await assert.rejects(
      service.ingestCandidate(candidate("x", "2026-09-16T08:01:00+08:00", 0.9, 30)),
      /没有生效中的签署计划/,
    );
  });

  test("家庭回答询问独立留痕，不修改已签署计划", async () => {
    const { service } = await harness();
    const answer = service.answerFamilyQuestion("plan-test", 1, "q1", "每晚约三次", "g-a");
    assert.equal(answer.answer, "每晚约三次");
    const plan = service.getSnapshot().plans[0]!;
    assert.deepEqual(plan.familyQuestions, [{ questionId: "q1", text: "夜间翻身频率？" }]);
    const answers = service.questionAnswersFor("plan-test", 1);
    assert.equal(answers.length, 1);
    assert.equal(answers[0]!.guardianId, "g-a");
  });
});

describe("重启续跑", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "nocturnal-"));
  });

  test("状态落盘后新进程加载，到期升级动作继续执行", async () => {
    const store = new JsonFileStore(path.join(dir, "state.json"));

    const clock1 = new FakeClock("2026-09-15T23:54:00+08:00");
    const gw1 = new InMemoryGateway(clock1);
    const svc1 = new NocturnalAlertService(clock1, gw1);
    svc1.signCarePlan(basePlan());
    await svc1.ingestCandidate(candidate("h", "2026-09-15T23:54:00+08:00", 0.91, 28));
    store.save(svc1.getSnapshot());
    assert.equal(gw1.calls.length, 0);

    // 模拟进程重启：新时钟、新网关、从磁盘恢复
    const clock2 = new FakeClock("2026-09-16T00:00:00+08:00");
    const gw2 = new InMemoryGateway(clock2);
    const svc2 = new NocturnalAlertService(clock2, gw2, store.load());
    await svc2.runDueActions();
    assert.equal(gw2.calls.length, 1);
    assert.equal(gw2.calls[0]!.contact.role, "primary");

    // 再次重启不会重复呼叫（动作已消费 + 已升级）
    store.save(svc2.getSnapshot());
    const clock3 = new FakeClock("2026-09-16T00:10:00+08:00");
    const gw3 = new InMemoryGateway(clock3);
    const svc3 = new NocturnalAlertService(clock3, gw3, store.load());
    await svc3.runDueActions();
    assert.equal(gw3.calls.length, 0);

    rmSync(dir, { recursive: true, force: true });
  });

  test("重启后到期时若告警已在旧进程被处置，动作作废", async () => {
    const clock = new FakeClock("2026-09-15T23:54:00+08:00");
    const gw = new InMemoryGateway(clock);
    const svc = new NocturnalAlertService(clock, gw);
    svc.signCarePlan(basePlan());
    const { alert } = await svc.ingestCandidate(
      candidate("h", "2026-09-15T23:54:00+08:00", 0.91, 28),
    );
    svc.acknowledge({ alertId: alert!.alertId, guardianId: "g-a", response: "false-alarm" });
    // 人为塞回一个动作模拟遗留状态
    const snapshot = svc.getSnapshot();
    snapshot.pendingActions.push({
      actionId: "stale",
      kind: "escalate",
      alertId: alert!.alertId,
      patientId: PATIENT,
      dueAt: "2026-09-15T23:59:00+08:00",
      dedupeKey: `esc:${alert!.alertId}`,
    });
    const clock2 = new FakeClock("2026-09-16T00:10:00+08:00");
    const gw2 = new InMemoryGateway(clock2);
    const svc2 = new NocturnalAlertService(clock2, gw2, snapshot);
    const fired = await svc2.runDueActions();
    assert.equal(fired.length, 1); // 动作被消费
    assert.equal(gw2.calls.length, 0); // 但不呼叫已处置告警
  });
});

describe("fixture 完整回放", () => {
  test("一晚：翻身关闭、静音期 high 送达、回执锁定、反事实升级、统计与 v2 签署", async () => {
    const result = await replayNight();
    const { service, restarted, fixture } = result;

    // 翻身无告警，持续事件有一个 high 告警
    const alerts = service.alertsFor(fixture.patientId);
    assert.equal(alerts.length, 1);
    const high = alerts[0]!;
    assert.equal(high.severity, "high");
    assert.equal(high.clusterId, "cluster-event-2a");
    assert.deepEqual(high.clusterId && high.notifications.map((n) => n.status), ["delivered", "delivered"]);

    // 首个有效处置：observing 不锁定，false-alarm 锁定
    assert.equal(high.outcome?.acknowledgement.response, "false-alarm");
    assert.equal(high.outcome?.acknowledgement.guardianId, "guardian-b");
    assert.equal(high.state, "resolved");

    // 反事实分支：静音窗内无处置，到点升级给医院联系人链路
    const restartedAlert = restarted.service.alertsFor(fixture.patientId)[0]!;
    assert.equal(restartedAlert.state, "escalated");
    assert.equal(restartedAlert.escalations[0]!.contactName, "母亲");

    // 审计时间线回答"谁在何时做了什么"
    const timeline = service.timeline(fixture.patientId);
    const actions = timeline.map((e) => e.action);
    assert.ok(actions.includes("plan.signed"));
    assert.ok(actions.includes("silence.set"));
    assert.ok(actions.includes("alert.created"));
    assert.ok(actions.includes("ack.observing"));
    assert.ok(actions.includes("ack.locked"));
    assert.ok(actions.includes("feedback.false-alarm"));
    assert.ok(actions.includes("adjustment.requested"));
    assert.ok(actions.includes("adjustment.approved"));

    // 统计
    const stats = service.nightlyStats(
      fixture.patientId,
      "2026-09-15T22:00:00+08:00",
      "2026-09-16T08:00:00+08:00",
    );
    assert.equal(stats.totalCandidates, 3);
    assert.equal(stats.degradedCandidates, 0);
    assert.equal(stats.alertsBySeverity.high, 1);
    assert.equal(stats.outcomes["false-alarm"], 1);
    assert.equal(stats.falseAlarmFeedbackCount, 1);
    assert.equal(stats.pendingAdjustmentRequests, 0);

    // v2 已签署且 v1 冻结
    const plans = service.getSnapshot().plans;
    assert.equal(plans.length, 2);
    assert.equal(plans[0]!.escalationAfterSeconds, 300);
    assert.equal(plans[1]!.escalationAfterSeconds, 420);
  });

  test("fixture 可直接加载且包含三类候选", () => {
    const fixture = loadFixture();
    assert.equal(fixture.candidates.length, 3);
    assert.equal(fixture.silence.maximumSeverity, "ordinary");
  });
});
