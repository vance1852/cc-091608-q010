import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  CarePlanVersion,
  SensorCandidate,
  SignedPlanInput,
  SilenceWindow,
} from "./contracts.ts";
import { correlateCandidates } from "./domain.ts";
import { AlertEngine, type PatientRoster } from "./engine.ts";
import { PlanRegistry, AuthorizationError } from "./plan.ts";
import { emptyStoreData } from "./records.ts";
import { createNocturnalService } from "./service.ts";
import { buildNightReview } from "./report.ts";

const PATIENT = "child-06";
const ROSTER: Record<string, PatientRoster> = {
  [PATIENT]: {
    guardianIds: ["guardian-a", "guardian-b"],
    hospital: { name: "神经科值班", phone: "010-5555" },
  },
};

function planInput(overrides: Partial<SignedPlanInput> = {}): SignedPlanInput {
  return {
    planId: "plan-06",
    patientId: PATIENT,
    effectiveFrom: "2026-09-15T22:00:00+08:00",
    effectiveUntil: "2026-09-16T06:00:00+08:00",
    correlationWindowSeconds: 120,
    escalationAfterSeconds: 180,
    motionThreshold: 0.8,
    heartRateDeltaThreshold: 20,
    signedBy: "dr-chen",
    familyQuestions: ["夜间翻身时孩子是否醒来？"],
    emergencyContacts: [{ name: "陈医生", role: "主治", phone: "138-0000" }],
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

function harness() {
  const registry = new PlanRegistry();
  const data = emptyStoreData();
  const engine = new AlertEngine(registry, data, ROSTER);
  return { registry, data, engine };
}

function signedPlan(registry: PlanRegistry): CarePlanVersion {
  return registry.signPlan(planInput(), "clinician", "2026-09-15T18:00:00+08:00");
}

const T22 = new Date("2026-09-15T22:00:00+08:00");
const silence = (
  from = "2026-09-15T23:30:00+08:00",
  until = "2026-09-16T00:15:00+08:00",
): SilenceWindow => ({ patientId: PATIENT, from, until, maximumSeverity: "ordinary" });

beforeEach(() => {
  // 引擎内自增 id 是模块级序号；测试只断言相对关系，不依赖具体值
});

// ---------------- 关联与标注 ----------------

test("普通翻身未达阈值：只记事件，不产生告警", () => {
  const { registry, engine } = harness();
  signedPlan(registry);
  const alerts = engine.ingestCandidates(
    [candidate("turn-1", "2026-09-15T22:50:00+08:00", 0.35, 2)],
    T22,
  );
  assert.equal(alerts.length, 0);
});

test("时间接近的运动+心率关联为同一高严重度事件", () => {
  const { registry, engine } = harness();
  signedPlan(registry);
  const alerts = engine.ingestCandidates(
    [
      candidate("event-2a", "2026-09-15T23:54:00+08:00", 0.91, 28),
      candidate("event-2b", "2026-09-15T23:55:10+08:00", 0.88, 31),
    ],
    T22,
  );
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.severity, "high");
  assert.deepEqual(alerts[0]!.candidateIds, ["event-2a", "event-2b"]);
});

test("仅运动异常为普通级别；间隔超过观察窗口拆成两个事件", () => {
  const plan = signedPlan(new PlanRegistry());
  const events = correlateCandidates(
    [
      candidate("m1", "2026-09-15T23:00:00+08:00", 0.85, 5),
      candidate("m2", "2026-09-15T23:10:00+08:00", 0.86, 4),
    ],
    plan,
  );
  assert.equal(events.length, 2);
  assert.equal(events[0]!.severity, "ordinary");
});

test("设备脱落与低质量区间如实标注，不被丢弃", () => {
  const { registry, data, engine } = harness();
  signedPlan(registry);
  engine.ingestCandidates(
    [
      candidate("e1", "2026-09-16T00:08:00+08:00", 0.9, 29),
      candidate("off", "2026-09-16T00:09:00+08:00", 0, 0, {
        worn: false,
        qualityFlags: ["device-off", "low-quality"],
      }),
    ],
    T22,
  );
  const alert = Object.values(data.alerts)[0]!;
  assert.equal(alert.hadDeviceOff, true);
  assert.equal(alert.hadLowQuality, true);
  const offNote = alert.candidateAnnotations.find((c) => c.candidateId === "off")!;
  assert.equal(offNote.deviceOff, true);
  assert.equal(offNote.lowQuality, true);
  assert.equal(offNote.abnormal, false);
});

// ---------------- 静音边界 ----------------

test("静音只压低普通通知且留痕；高严重度照常送达", () => {
  const { registry, engine } = harness();
  signedPlan(registry);
  engine.addSilence(silence(), "guardian-a");

  // 23:40 静音中：仅运动异常 -> ordinary，通知被压低
  const ordinary = engine.ingestCandidates(
    [candidate("blip", "2026-09-15T23:40:00+08:00", 0.85, 5)],
    T22,
  )[0]!;
  assert.ok(ordinary.notifications.every((n) => n.suppressed));
  assert.equal(ordinary.notifications[0]!.suppressReason, "silence-window");

  // 23:54 静音中：运动+心率 -> high，绝不被静音
  const high = engine.ingestCandidates(
    [
      candidate("h1", "2026-09-15T23:54:00+08:00", 0.91, 28),
      candidate("h2", "2026-09-15T23:55:00+08:00", 0.9, 27),
    ],
    T22,
  )[0]!;
  assert.ok(high.notifications.every((n) => !n.suppressed));
});

test("静音窗口不允许覆盖高严重度", () => {
  const { registry, engine } = harness();
  signedPlan(registry);
  assert.throws(
    () => engine.addSilence({ ...silence(), maximumSeverity: "high" }, "guardian-a"),
    /不得覆盖高严重度/,
  );
});

test("静音窗口外的普通通知正常送达", () => {
  const { registry, engine } = harness();
  signedPlan(registry);
  engine.addSilence(silence(), "guardian-a");
  const alert = engine.ingestCandidates(
    [candidate("early", "2026-09-15T22:55:00+08:00", 0.85, 5)],
    T22,
  )[0]!;
  assert.ok(alert.notifications.every((n) => !n.suppressed));
});

// ---------------- 持续升级 ----------------

test("普通事件在静音中持续未响应仍按计划升级，升级呼叫不被静音", () => {
  const { registry, engine } = harness();
  signedPlan(registry);
  engine.addSilence(silence(), "guardian-a");
  const alert = engine.ingestCandidates(
    [candidate("blip", "2026-09-15T23:40:00+08:00", 0.85, 5)],
    T22,
  )[0]!;

  engine.runDue(new Date("2026-09-15T23:42:59+08:00"));
  assert.equal(alert.status, "open");

  const ran = engine.runDue(new Date("2026-09-15T23:43:00+08:00"));
  assert.equal(ran.length, 1);
  assert.equal(alert.status, "escalated");
  const calls = alert.notifications.filter((n) => n.channel === "escalation-call");
  assert.ok(calls.length >= 2); // 紧急联系人 + 医院
  assert.ok(calls.every((n) => !n.suppressed));
  assert.match(alert.escalationReasons[0]!, /180s/);
});

test("首个有效处置 false-alarm 在阈值前关闭告警并取消定时升级", () => {
  const { registry, data, engine } = harness();
  signedPlan(registry);
  const alert = engine.ingestCandidates(
    [candidate("b", "2026-09-15T23:40:00+08:00", 0.85, 5)],
    T22,
  )[0]!;
  engine.acknowledge({
    alertId: alert.alertId,
    guardianId: "guardian-b",
    response: "false-alarm",
    receivedAt: "2026-09-15T23:41:00+08:00",
  });
  assert.equal(alert.status, "resolved");
  engine.runDue(new Date("2026-09-16T01:00:00+08:00"));
  assert.equal(alert.status, "resolved");
  const action = Object.values(data.scheduled)[0]!;
  assert.equal(action.status, "cancelled");
});

test("needs-help 立即升级，不等持续阈值", () => {
  const { registry, engine } = harness();
  signedPlan(registry);
  const alert = engine.ingestCandidates(
    [candidate("b", "2026-09-15T23:40:00+08:00", 0.85, 5)],
    T22,
  )[0]!;
  engine.acknowledge({
    alertId: alert.alertId,
    guardianId: "guardian-a",
    response: "needs-help",
    receivedAt: "2026-09-15T23:40:20+08:00",
  });
  assert.equal(alert.status, "escalated");
  assert.equal(
    new Date(alert.escalatedAt!).getTime(),
    new Date("2026-09-15T23:40:20+08:00").getTime(),
  );
});

// ---------------- 矛盾回执 ----------------

test("首个有效处置锁定结果；后来矛盾意见保留但不改变锁定", () => {
  const { registry, engine } = harness();
  signedPlan(registry);
  const alert = engine.ingestCandidates(
    [
      candidate("h1", "2026-09-15T23:54:00+08:00", 0.91, 28),
      candidate("h2", "2026-09-15T23:55:00+08:00", 0.9, 27),
    ],
    T22,
  )[0]!;

  engine.acknowledge({
    acknowledgementId: "ack-a",
    alertId: alert.alertId,
    guardianId: "guardian-a",
    response: "observing",
    receivedAt: "2026-09-15T23:54:30+08:00",
  });
  engine.acknowledge({
    acknowledgementId: "ack-b",
    alertId: alert.alertId,
    guardianId: "guardian-b",
    response: "false-alarm",
    receivedAt: "2026-09-15T23:55:40+08:00",
  });
  assert.equal(alert.locked!.guardianId, "guardian-b");
  assert.equal(alert.status, "resolved");

  engine.acknowledge({
    acknowledgementId: "ack-c",
    alertId: alert.alertId,
    guardianId: "guardian-a",
    response: "observing",
    receivedAt: "2026-09-15T23:56:00+08:00",
  });
  assert.deepEqual(alert.laterOpinionIds, ["ack-c"]);
  assert.equal(alert.acknowledgements.length, 3); // 后来意见仍然保留
  assert.equal(alert.locked!.guardianId, "guardian-b"); // 锁定不变
});

test("锁定为误报后再收到 needs-help：保留原锁定并再次升级，不吞掉救助事件", () => {
  const { registry, engine } = harness();
  signedPlan(registry);
  const alert = engine.ingestCandidates(
    [candidate("h1", "2026-09-15T23:54:00+08:00", 0.91, 28)],
    T22,
  )[0]!;
  engine.acknowledge({
    acknowledgementId: "ack-b",
    alertId: alert.alertId,
    guardianId: "guardian-b",
    response: "false-alarm",
    receivedAt: "2026-09-15T23:55:40+08:00",
  });
  assert.equal(alert.status, "resolved");

  engine.acknowledge({
    acknowledgementId: "ack-a",
    alertId: alert.alertId,
    guardianId: "guardian-a",
    response: "needs-help",
    receivedAt: "2026-09-15T23:56:30+08:00",
  });
  assert.equal(alert.status, "escalated");
  assert.equal(alert.locked!.response, "false-alarm"); // 首个处置仍锁定
  assert.deepEqual(alert.laterOpinionIds, ["ack-a"]); // 矛盾意见留痕
  assert.match(alert.escalationReasons.at(-1)!, /needs-help/);
});

test("已升级后再收到 false-alarm 也不能降级关闭", () => {
  const { registry, engine } = harness();
  signedPlan(registry);
  const alert = engine.ingestCandidates(
    [candidate("b", "2026-09-15T23:40:00+08:00", 0.85, 5)],
    T22,
  )[0]!;
  engine.runDue(new Date("2026-09-15T23:43:00+08:00"));
  assert.equal(alert.status, "escalated");
  engine.acknowledge({
    acknowledgementId: "ack-late",
    alertId: alert.alertId,
    guardianId: "guardian-b",
    response: "false-alarm",
    receivedAt: "2026-09-15T23:44:00+08:00",
  });
  assert.equal(alert.status, "escalated");
  assert.equal(alert.locked!.response, "false-alarm");
  assert.deepEqual(alert.laterOpinionIds, []); // 首个回执即锁定，无后来意见
});

// ---------------- 计划权限与边界 ----------------

test("监护人不能签署或改动生效中的计划", () => {
  const registry = new PlanRegistry();
  assert.throws(
    () => registry.signPlan(planInput(), "guardian", "2026-09-15T18:00:00+08:00"),
    AuthorizationError,
  );
});

test("每版计划必须写明有效期/观察窗口/持续阈值/家庭询问/紧急联系人", () => {
  const registry = new PlanRegistry();
  assert.throws(
    () =>
      registry.signPlan(
        planInput({ familyQuestions: [] }),
        "clinician",
        "2026-09-15T18:00:00+08:00",
      ),
    /家庭询问/,
  );
  assert.throws(
    () =>
      registry.signPlan(
        planInput({ emergencyContacts: [] }),
        "clinician",
        "2026-09-15T18:00:00+08:00",
      ),
    /紧急联系人/,
  );
  assert.throws(
    () =>
      registry.signPlan(
        planInput({
          effectiveFrom: "2026-09-16T06:00:00+08:00",
          effectiveUntil: "2026-09-16T05:00:00+08:00",
        }),
        "clinician",
        "2026-09-15T18:00:00+08:00",
      ),
    /有效期/,
  );
  assert.throws(
    () =>
      registry.signPlan(
        planInput({ escalationAfterSeconds: 0 }),
        "clinician",
        "2026-09-15T18:00:00+08:00",
      ),
    /持续阈值/,
  );
});

test("家庭可提交误报反馈与调整申请，但生效规则不变；医生批准并签署新版", () => {
  const registry = new PlanRegistry();
  registry.signPlan(planInput(), "clinician", "2026-09-15T18:00:00+08:00");

  registry.submitFeedback({
    feedbackId: "fb-1",
    patientId: PATIENT,
    alertId: "alert-x",
    guardianId: "guardian-b",
    falseAlarm: true,
    comment: "翻身误报",
  });
  const req = registry.requestAdjustment({
    requestId: "adj-1",
    planId: "plan-06",
    patientId: PATIENT,
    requestedBy: "guardian-b",
    requestedAt: "2026-09-16T07:05:00+08:00",
    proposed: { motionThreshold: 0.9 },
    reason: "减少翻身误报",
    relatedAlertIds: ["alert-x"],
  });
  assert.equal(req.status, "pending");
  assert.equal(registry.getPlan("plan-06", 1)!.motionThreshold, 0.8);

  // 监护人不能批准
  assert.throws(
    () =>
      registry.approveAdjustment(
        "adj-1",
        "guardian-b",
        "guardian",
        "2026-09-16T08:00:00+08:00",
        2,
      ),
    AuthorizationError,
  );

  const v2 = registry.signPlan(
    planInput({
      effectiveFrom: "2026-09-16T20:00:00+08:00",
      effectiveUntil: "2026-09-23T08:00:00+08:00",
      motionThreshold: 0.9,
    }),
    "clinician",
    "2026-09-16T08:10:00+08:00",
  );
  registry.approveAdjustment(
    "adj-1",
    "dr-chen",
    "clinician",
    "2026-09-16T08:10:00+08:00",
    v2.version,
  );
  assert.equal(v2.version, 2);
  assert.equal(registry.getAdjustment("adj-1")!.status, "approved");
  assert.equal(registry.getAdjustment("adj-1")!.signedVersion, 2);
  // 旧版保留未变
  assert.equal(registry.getPlan("plan-06", 1)!.motionThreshold, 0.8);
  assert.equal(registry.getPlan("plan-06", 2)!.motionThreshold, 0.9);
});

test("家庭不能申请调整白名单之外的临床字段", () => {
  const registry = new PlanRegistry();
  assert.throws(
    () =>
      registry.requestAdjustment({
        requestId: "adj-bad",
        planId: "plan-06",
        patientId: PATIENT,
        requestedBy: "guardian-b",
        requestedAt: "2026-09-16T07:05:00+08:00",
        proposed: { signedBy: 1 } as never,
        reason: "试图自行改签署医生",
        relatedAlertIds: [],
      }),
    /不允许/,
  );
});

// ---------------- 重启恢复（真实文件） ----------------

test("重启后尚未执行的定时动作继续执行", () => {
  const dir = mkdtempSync(join(tmpdir(), "nocturnal-"));
  const statePath = join(dir, "state.json");
  try {
    let svc = createNocturnalService({
      statePath,
      rosters: ROSTER,
      tickIntervalMs: 0,
      now: () => new Date("2026-09-15T22:00:00+08:00"),
    });
    svc.registry.signPlan(planInput(), "clinician", "2026-09-15T18:00:00+08:00");
    const alert = svc.engine.ingestCandidates(
      [candidate("late", "2026-09-16T00:08:00+08:00", 0.9, 29)],
      T22,
    )[0]!;
    assert.equal(svc.pendingCount(), 1);
    svc.stop();

    // 重启：此时已超过 dueAt（00:11）
    svc = createNocturnalService({
      statePath,
      rosters: ROSTER,
      tickIntervalMs: 0,
      now: () => new Date("2026-09-16T00:30:00+08:00"),
    });
    assert.equal(svc.pendingCount(), 0); // 启动追赶时已执行
    const reloaded = svc.engine.getAlert(alert.alertId)!;
    assert.equal(reloaded.status, "escalated");
    assert.equal(
      new Date(reloaded.escalatedAt!).getTime(),
      new Date("2026-09-16T00:11:00+08:00").getTime(),
    );
    svc.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("重启时未到期的定时动作保持 pending，随后到点仍会执行", () => {
  const dir = mkdtempSync(join(tmpdir(), "nocturnal-"));
  const statePath = join(dir, "state.json");
  try {
    let svc = createNocturnalService({
      statePath,
      rosters: ROSTER,
      tickIntervalMs: 0,
      now: () => new Date("2026-09-15T22:00:00+08:00"),
    });
    svc.registry.signPlan(planInput(), "clinician", "2026-09-15T18:00:00+08:00");
    const alert = svc.engine.ingestCandidates(
      [candidate("late2", "2026-09-16T00:20:00+08:00", 0.9, 29)],
      T22,
    )[0]!;
    svc.stop();

    // 重启时刻 00:21，定时动作 00:23 才到期：必须仍是 pending
    svc = createNocturnalService({
      statePath,
      rosters: ROSTER,
      tickIntervalMs: 0,
      now: () => new Date("2026-09-16T00:21:00+08:00"),
    });
    assert.equal(svc.pendingCount(), 1);
    assert.equal(svc.engine.getAlert(alert.alertId)!.status, "open");
    svc.catchUp(new Date("2026-09-16T00:23:00+08:00"));
    assert.equal(svc.engine.getAlert(alert.alertId)!.status, "escalated");
    assert.equal(svc.pendingCount(), 0);
    svc.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("纯设备脱落/低质量区间不产生告警，但事件被记录并标注", () => {
  const { registry, data, engine } = harness();
  signedPlan(registry);
  const alerts = engine.ingestCandidates(
    [
      candidate("off-1", "2026-09-16T00:10:00+08:00", 0, 0, {
        worn: false,
        qualityFlags: ["device-off"],
      }),
    ],
    T22,
  );
  assert.equal(alerts.length, 0);
  assert.equal(data.events.length, 1);
  assert.equal(data.events[0]!.hadDeviceOff, true);
});

test("observing 不是终结处置：到持续阈值仍会升级", () => {
  const { registry, engine } = harness();
  signedPlan(registry);
  const alert = engine.ingestCandidates(
    [candidate("b", "2026-09-15T23:40:00+08:00", 0.85, 5)],
    T22,
  )[0]!;
  engine.acknowledge({
    acknowledgementId: "ack-observe",
    alertId: alert.alertId,
    guardianId: "guardian-a",
    response: "observing",
    receivedAt: "2026-09-15T23:40:30+08:00",
  });
  assert.equal(alert.locked, undefined);
  engine.runDue(new Date("2026-09-15T23:43:00+08:00"));
  assert.equal(alert.status, "escalated");
  assert.equal(alert.locked, undefined);
});

test("调度升级后首个 needs-help 不重复呼叫，但记录回执", () => {
  const { registry, engine } = harness();
  signedPlan(registry);
  const alert = engine.ingestCandidates(
    [candidate("b", "2026-09-15T23:40:00+08:00", 0.85, 5)],
    T22,
  )[0]!;
  engine.runDue(new Date("2026-09-15T23:43:00+08:00"));
  const callsAfterEscalation = alert.notifications.filter(
    (n) => n.channel === "escalation-call",
  ).length;

  engine.acknowledge({
    acknowledgementId: "ack-help",
    alertId: alert.alertId,
    guardianId: "guardian-a",
    response: "needs-help",
    receivedAt: "2026-09-15T23:43:30+08:00",
  });
  assert.equal(alert.status, "escalated");
  assert.equal(alert.locked!.response, "needs-help");
  assert.equal(
    alert.notifications.filter((n) => n.channel === "escalation-call").length,
    callsAfterEscalation,
  );
});

// ---------------- 复诊统计 ----------------

test("复诊报告分别统计未打扰事件、静音压低、送达与升级", () => {
  const { registry, data, engine } = harness();
  signedPlan(registry);
  engine.addSilence(silence(), "guardian-a");
  engine.ingestCandidates(
    [
      candidate("turn-1", "2026-09-15T22:50:00+08:00", 0.35, 2),
      candidate("blip", "2026-09-15T23:40:00+08:00", 0.85, 5),
      candidate("h1", "2026-09-15T23:54:00+08:00", 0.91, 28),
      candidate("h2", "2026-09-15T23:55:00+08:00", 0.9, 27),
    ],
    T22,
  );
  engine.runDue(new Date("2026-09-15T23:43:00+08:00"));

  const review = buildNightReview(PATIENT, data, registry, "2026-09-16T08:00:00+08:00");
  assert.equal(review.statistics.totalEvents, 3);
  assert.equal(review.statistics.nonAlertingEvents, 1);
  assert.equal(review.statistics.totalAlerts, 2);
  assert.equal(review.statistics.highSeverityAlerts, 1);
  assert.equal(review.statistics.suppressedNotifications, 2); // 2 位监护人的普通通知
  assert.equal(review.statistics.deliveredNotifications, 2); // high 的 2 条
  assert.ok(review.statistics.escalationCalls >= 2);
  assert.equal(review.alerts[0]!.timeline.length > 0, true);
});
