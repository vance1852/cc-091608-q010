// 复诊报告：医生先看懂这一夜“普通翻身如何被关闭、静音期间的持续事件
// 为何升级、哪位监护人何时做了什么处置”，再据误报统计调整下一版计划。

import type { AlertSeverity, CarePlanVersion, SilenceWindow } from "./contracts.ts";
import type { ObservedEvent } from "./domain.ts";
import type { PlanRegistry, FamilyFeedback } from "./plan.ts";
import type { AlertRecord, StoreData } from "./records.ts";
import { formatInOffset } from "./time.ts";

export interface AlertTimelineEntry {
  at: string;
  kind:
    | "event-started"
    | "guardian-push"
    | "escalation"
    | "acknowledged"
    | "closed";
  actor?: string;
  detail: string;
}

export interface AlertReview {
  alertId: string;
  planVersion: number;
  startedAt: string;
  severity: AlertSeverity;
  status: string;
  candidateIds: string[];
  hadDeviceOff: boolean;
  hadLowQuality: boolean;
  suppressedPushCount: number;
  deliveredPushCount: number;
  escalated: boolean;
  escalatedAt?: string;
  escalationReasons: string[];
  lockedBy?: { guardianId: string; response: string; at: string };
  /** 首个处置之后保留的后来意见（含矛盾回执） */
  laterOpinions: Array<{ guardianId: string; response: string; at: string }>;
  timeline: AlertTimelineEntry[];
}

export interface NightReview {
  patientId: string;
  generatedAt: string;
  plansInEffect: CarePlanVersion[];
  silenceWindows: SilenceWindow[];
  /** 未达异常阈值的普通翻身/低质量区间：如何被关闭（不打扰） */
  nonAlertingEvents: Array<{
    eventId: string;
    startedAt: string;
    endedAt: string;
    candidateIds: string[];
    hadDeviceOff: boolean;
    hadLowQuality: boolean;
    reason: string;
  }>;
  alerts: AlertReview[];
  statistics: {
    totalEvents: number;
    nonAlertingEvents: number;
    totalAlerts: number;
    highSeverityAlerts: number;
    escalatedAlerts: number;
    /** 首个处置判定为误报的告警数（即便后来 needs-help 再次升级也计入误报统计） */
    lockedFalseAlarm: number;
    /** 最终以误报关闭、未再升级的告警数 */
    closedFalseAlarm: number;
    /** 静音压低的普通通知数（与真正送达的通知分别统计） */
    suppressedNotifications: number;
    deliveredNotifications: number;
    escalationCalls: number;
    eventsWithDeviceOff: number;
    eventsWithLowQuality: number;
  };
  falseAlarmFeedback: FamilyFeedback[];
}

export function buildNightReview(
  patientId: string,
  data: StoreData,
  registry: PlanRegistry,
  generatedAt: string,
): NightReview {
  const patientEvents = data.events.filter((e) => e.patientId === patientId);
  const alerts = Object.values(data.alerts)
    .filter((a) => a.patientId === patientId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

  const alertingEventIds = new Set(alerts.map((a) => a.eventId));
  const nonAlerting = patientEvents
    .filter((e) => !alertingEventIds.has(e.eventId))
    .map((e) => ({
      eventId: e.eventId,
      startedAt: e.startedAt,
      endedAt: e.endedAt,
      candidateIds: e.candidateIds,
      hadDeviceOff: e.hadDeviceOff,
      hadLowQuality: e.hadLowQuality,
      reason: nonAlertingReason(e),
    }));

  const alertReviews = alerts.map((a) => reviewAlert(a));

  const allNotifications = alerts.flatMap((a) => a.notifications);
  const plans = new Map<string, CarePlanVersion>();
  for (const a of alerts) {
    const plan = registry.getPlan(a.planId, a.planVersion);
    if (plan) plans.set(`${plan.planId}#v${plan.version}`, plan);
  }
  return {
    patientId,
    generatedAt,
    plansInEffect: [...plans.values()],
    silenceWindows: data.silences.filter((s) => s.patientId === patientId),
    nonAlertingEvents: nonAlerting,
    alerts: alertReviews,
    statistics: {
      totalEvents: patientEvents.length,
      nonAlertingEvents: nonAlerting.length,
      totalAlerts: alerts.length,
      highSeverityAlerts: alerts.filter((a) => a.severity === "high").length,
      escalatedAlerts: alerts.filter((a) => a.status === "escalated").length,
      lockedFalseAlarm: alerts.filter(
        (a) => a.locked?.response === "false-alarm",
      ).length,
      closedFalseAlarm: alerts.filter(
        (a) => a.status === "resolved" && a.closeReason === "family:false-alarm",
      ).length,
      suppressedNotifications: allNotifications.filter(
        (n) => n.channel === "guardian-push" && n.suppressed,
      ).length,
      deliveredNotifications: allNotifications.filter(
        (n) => n.channel === "guardian-push" && !n.suppressed,
      ).length,
      escalationCalls: allNotifications.filter((n) => n.channel === "escalation-call").length,
      eventsWithDeviceOff: patientEvents.filter((e) => e.hadDeviceOff).length,
      eventsWithLowQuality: patientEvents.filter((e) => e.hadLowQuality).length,
    },
    falseAlarmFeedback: registry
      .listFeedback(patientId)
      .filter((f) => f.falseAlarm),
  };
}

function nonAlertingReason(e: ObservedEvent): string {
  const parts: string[] = [];
  if (e.hadDeviceOff) parts.push("设备脱落");
  if (e.hadLowQuality) parts.push("信号低质量");
  if (e.abnormalCandidateCount === 0) parts.push("未达临床阈值（普通翻身）");
  return parts.length > 0 ? parts.join("、") : "未达临床阈值";
}

function reviewAlert(a: AlertRecord): AlertReview {
  const timeline: AlertTimelineEntry[] = [];
  timeline.push({
    at: a.startedAt,
    kind: "event-started",
    detail: `关联候选 ${a.candidateIds.join(", ")}（${a.severity}）` +
      (a.hadDeviceOff ? "；含设备脱落" : "") +
      (a.hadLowQuality ? "；含低质量区间" : ""),
  });
  for (const n of a.notifications) {
    if (n.channel === "guardian-push") {
      timeline.push({
        at: n.at,
        kind: "guardian-push",
        actor: n.target,
        detail: n.suppressed
          ? `普通通知被静音压低（${n.suppressReason}），仍留痕`
          : "普通通知送达",
      });
    } else {
      timeline.push({
        at: n.at,
        kind: "escalation",
        actor: n.target,
        detail: `升级呼叫：${n.target}`,
      });
    }
  }
  for (const ack of a.acknowledgements) {
    timeline.push({
      at: ack.receivedAt,
      kind: "acknowledged",
      actor: ack.guardianId,
      detail: `回执 ${ack.response}`,
    });
  }
  if (a.closedAt) {
    timeline.push({
      at: a.closedAt,
      kind: "closed",
      detail: a.closeReason ?? "closed",
    });
  }
  timeline.sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());
  // 统一用事件起点的时区偏移展示，避免 UTC 与本地偏移混排
  for (const entry of timeline) {
    entry.at = formatInOffset(new Date(entry.at), a.startedAt);
  }

  return {
    alertId: a.alertId,
    planVersion: a.planVersion,
    startedAt: a.startedAt,
    severity: a.severity,
    status: a.status,
    candidateIds: a.candidateIds,
    hadDeviceOff: a.hadDeviceOff,
    hadLowQuality: a.hadLowQuality,
    suppressedPushCount: a.notifications.filter((n) => n.suppressed).length,
    deliveredPushCount: a.notifications.filter(
      (n) => !n.suppressed && n.channel === "guardian-push",
    ).length,
    escalated: a.status === "escalated",
    ...(a.escalatedAt
      ? { escalatedAt: formatInOffset(new Date(a.escalatedAt), a.startedAt) }
      : {}),
    escalationReasons: a.escalationReasons,
    ...(a.locked
      ? {
          lockedBy: {
            guardianId: a.locked.guardianId,
            response: a.locked.response,
            at: a.locked.at,
          },
        }
      : {}),
    laterOpinions: a.acknowledgements
      .filter((ack) => a.laterOpinionIds.includes(ack.acknowledgementId))
      .map((ack) => ({
        guardianId: ack.guardianId,
        response: ack.response,
        at: ack.receivedAt,
      })),
    timeline,
  };
}

/** 复诊用的纯文本摘要，便于终端直接打印 */
export function formatReview(review: NightReview): string {
  const lines: string[] = [];
  lines.push(`夜间复诊报告 患者=${review.patientId} 生成于 ${review.generatedAt}`);
  lines.push("");
  for (const plan of review.plansInEffect) {
    lines.push(
      `计划 ${plan.planId} v${plan.version}（${plan.signedBy} 签署）` +
        ` 有效期 ${plan.effectiveFrom} ~ ${plan.effectiveUntil}` +
        ` 观察窗口 ${plan.correlationWindowSeconds}s` +
        ` 持续阈值 ${plan.escalationAfterSeconds}s` +
        ` 运动>=${plan.motionThreshold} 心率Δ>=${plan.heartRateDeltaThreshold}`,
    );
    lines.push(`  家庭询问：${plan.familyQuestions.join(" / ")}`);
    lines.push(
      `  紧急联系人：${plan.emergencyContacts
        .map((c) => `${c.name}(${c.role})${c.phone}`)
        .join("、")}`,
    );
  }
  for (const s of review.silenceWindows) {
    lines.push(
      `静音窗口 ${s.from} ~ ${s.until}（仅压低 ${s.maximumSeverity} 通知）`,
    );
  }
  lines.push("");
  lines.push("== 未打扰事件（普通翻身/脱落/低质量） ==");
  for (const e of review.nonAlertingEvents) {
    lines.push(
      `${e.startedAt} ${e.eventId} [${e.candidateIds.join(",")}] ${e.reason}`,
    );
  }
  lines.push("");
  lines.push("== 告警处置时间线 ==");
  for (const alert of review.alerts) {
    lines.push(
      `# ${alert.alertId} v${alert.planVersion} ${alert.severity} -> ${alert.status}` +
        (alert.escalatedAt ? `（${alert.escalatedAt} 升级）` : ""),
    );
    for (const entry of alert.timeline) {
      lines.push(`   ${entry.at} ${entry.kind}${entry.actor ? ` ${entry.actor}` : ""}: ${entry.detail}`);
    }
    if (alert.lockedBy) {
      lines.push(
        `   锁定：${alert.lockedBy.guardianId} 于 ${alert.lockedBy.at} 判定 ${alert.lockedBy.response}`,
      );
    }
    for (const op of alert.laterOpinions) {
      lines.push(`   保留后来意见：${op.guardianId} 于 ${op.at} 回执 ${op.response}`);
    }
  }
  lines.push("");
  const s = review.statistics;
  lines.push("== 误报/疲劳统计 ==");
  lines.push(
    `事件 ${s.totalEvents}（未打扰 ${s.nonAlertingEvents}），告警 ${s.totalAlerts}，` +
      `高严重度 ${s.highSeverityAlerts}，升级 ${s.escalatedAlerts}，` +
      `误报判定 ${s.lockedFalseAlarm}（其中最终关闭 ${s.closedFalseAlarm}，其余再升级）`,
  );
  lines.push(
    `通知：被静音压低 ${s.suppressedNotifications}，送达 ${s.deliveredNotifications}，` +
      `升级呼叫 ${s.escalationCalls}`,
  );
  lines.push(
    `数据质量：含设备脱落事件 ${s.eventsWithDeviceOff}，含低质量事件 ${s.eventsWithLowQuality}`,
  );
  return lines.join("\n");
}
