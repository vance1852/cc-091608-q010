// 告警协作引擎：候选事件 -> 告警 -> 通知/升级 -> 家庭回执。
//
// 关键边界：
//  - 静音窗口只压低普通通知（guardian-push / ordinary），且留痕；
//    高严重度通知与升级呼叫（escalation-call）永远不被静音吞掉。
//  - 每个未锁定的告警都在“起点 + 持续阈值”安排一次升级检查；
//    定时动作持久化，重启后 runDue/恢复实时调度仍会执行。
//  - 首个有效（终结性）回执锁定处置结果；后来的矛盾回执全部保留，
//    needs-help 永不静默：即使已有 false-alarm 锁定，也会在保留
//    原锁定记录的同时再次升级并审计。

import type {
  AlertSeverity,
  CarePlanVersion,
  FamilyAcknowledgement,
  GuardianResponse,
  SensorCandidate,
  SilenceWindow,
} from "./contracts.ts";
import {
  annotate,
  correlateCandidates,
  type ObservedEvent,
} from "./domain.ts";
import type { PlanRegistry } from "./plan.ts";
import type {
  AlertRecord,
  AuditEvent,
  CandidateAnnotation,
  NotificationRecord,
  ScheduledAction,
  StoreData,
} from "./records.ts";

export interface PatientRoster {
  /** 接收普通通知的监护人 */
  guardianIds: string[];
  /** 升级时除计划紧急联系人外的医院值班通道 */
  hospital: { name: string; phone: string };
}

export interface AckInput {
  acknowledgementId?: string;
  alertId: string;
  guardianId: string;
  response: GuardianResponse;
  receivedAt: string;
}

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

/** 从已持久化记录恢复自增序号，避免重启后与历史 id 冲突 */
function seedSeq(data: StoreData): void {
  const numeric = (s: string | undefined): number => {
    if (!s) return 0;
    const m = /-(\d+)$/.exec(s);
    return m ? Number(m[1]) : 0;
  };
  let max = 0;
  for (const a of Object.values(data.alerts)) {
    max = Math.max(max, numeric(a.alertId));
    for (const n of a.notifications) max = Math.max(max, numeric(n.notificationId));
    for (const k of a.acknowledgements) max = Math.max(max, numeric(k.acknowledgementId));
  }
  for (const s of Object.values(data.scheduled)) max = Math.max(max, numeric(s.actionId));
  for (const e of data.audit) max = Math.max(max, numeric(e.auditId));
  seq = Math.max(seq, max);
}

const severityRank = (s: AlertSeverity): number => (s === "high" ? 1 : 0);

const TERMINAL: ReadonlySet<GuardianResponse> = new Set([
  "false-alarm",
  "needs-help",
]);

export class AlertEngine {
  constructor(
    private readonly registry: PlanRegistry,
    private readonly data: StoreData,
    private readonly rosters: Record<string, PatientRoster>,
    private readonly persist?: () => void,
  ) {
    seedSeq(data);
  }

  // ---------------- 静音 ----------------

  addSilence(window: SilenceWindow, actorId: string): SilenceWindow {
    if (new Date(window.from).getTime() >= new Date(window.until).getTime()) {
      throw new Error("静音窗口起点必须早于终点。");
    }
    // 临床边界：短时静音只能压低普通通知，任何静音都不得覆盖高严重度
    if (window.maximumSeverity === "high") {
      throw new Error("静音不得覆盖高严重度告警：只能压低 ordinary 普通通知。");
    }
    this.data.silences.push(window);
    this.audit(actorId, "guardian", "silence.window-opened", {
      patientId: window.patientId,
      from: window.from,
      until: window.until,
      maximumSeverity: window.maximumSeverity,
    });
    this.save();
    return window;
  }

  /**
   * 该时刻该严重度的普通通知是否被静音压低。
   * 仅当窗口允许压低的最高级别 >= 通知级别时才压制；high 永远不被压制。
   */
  isSuppressed(patientId: string, severity: AlertSeverity, at: Date): boolean {
    const t = at.getTime();
    return this.data.silences.some(
      (w) =>
        w.patientId === patientId &&
        new Date(w.from).getTime() <= t &&
        t < new Date(w.until).getTime() &&
        severityRank(w.maximumSeverity) >= severityRank(severity),
    );
  }

  // ---------------- 候选摄入 ----------------

  /**
   * 摄入一批传感器候选（同一患者、同一夜可一次性给全）。
   * 用摄入时刻生效的计划做关联，返回被创建/更新的告警。
   * 设备脱落、低质量区间一律标注；普通翻身（无异常信号）只记事件不发告警。
   */
  ingestCandidates(raw: SensorCandidate[], observedAt: Date): AlertRecord[] {
    const byPatient = new Map<string, SensorCandidate[]>();
    for (const c of raw) {
      byPatient.set(c.patientId, [...(byPatient.get(c.patientId) ?? []), c]);
    }
    const touched: AlertRecord[] = [];
    for (const [patientId, batch] of byPatient) {
      const plan = this.registry.activePlanAt(patientId, observedAt);
      if (!plan) {
        throw new Error(`患者 ${patientId} 在 ${observedAt.toISOString()} 没有生效中的照护计划。`);
      }
      const events = correlateCandidates(batch, plan);
      for (const event of events) {
        this.upsertEvent(event, plan, touched);
      }
    }
    this.save();
    return touched;
  }

  private upsertEvent(
    event: ObservedEvent,
    plan: CarePlanVersion,
    touched: AlertRecord[],
  ): void {
    const knownEvent = this.data.events.find((e) => e.eventId === event.eventId);
    if (!knownEvent) {
      this.data.events.push(event);
    } else {
      // 又有关联候选并入：用最新的关联结果替换（时间线延长、标注更新）
      Object.assign(knownEvent, event);
    }
    // 无任何异常信号 = 普通翻身/脱落/低质量区间：如实记录，不打扰家庭
    if (event.abnormalCandidateCount === 0) return;

    const existing = Object.values(this.data.alerts).find((a) =>
      event.candidateIds.some((cid) => a.candidateIds.includes(cid)),
    );
    if (existing) {
      existing.lastActivityAt = event.endedAt;
      existing.candidateIds = event.candidateIds;
      existing.candidateAnnotations = event.candidates.map(toAnnotation);
      existing.hadDeviceOff = event.hadDeviceOff;
      existing.hadLowQuality = event.hadLowQuality;
      if (severityRank(event.severity) > severityRank(existing.severity)) {
        existing.severity = event.severity;
        // 仍在 open 时升级为高严重度：即便在静音窗口内也要立刻送达；
        // 已关闭/已升级的告警只更新严重度记录，不重复推送
        if (existing.status === "open") {
          this.pushGuardianNotifications(existing, plan, event.endedAt, true);
        }
      }
      touched.push(existing);
      return;
    }

    const alert: AlertRecord = {
      alertId: id("alert"),
      patientId: event.patientId,
      planId: plan.planId,
      planVersion: plan.version,
      eventId: event.eventId,
      startedAt: event.startedAt,
      lastActivityAt: event.endedAt,
      severity: event.severity,
      status: "open",
      candidateIds: event.candidateIds,
      candidateAnnotations: event.candidates.map(toAnnotation),
      hadDeviceOff: event.hadDeviceOff,
      hadLowQuality: event.hadLowQuality,
      escalationAfterSeconds: plan.escalationAfterSeconds,
      notifications: [],
      acknowledgements: [],
      laterOpinionIds: [],
      escalationReasons: [],
    };
    this.pushGuardianNotifications(alert, plan, event.startedAt, false);

    // 安排“持续未响应”升级检查；needs-help / false-alarm 提前锁定会取消它
    const due = new Date(
      new Date(event.startedAt).getTime() +
        plan.escalationAfterSeconds * 1000,
    ).toISOString();
    const action: ScheduledAction = {
      actionId: id("sched"),
      type: "escalation-check",
      alertId: alert.alertId,
      patientId: alert.patientId,
      dueAt: due,
      status: "pending",
    };
    alert.scheduledActionId = action.actionId;
    this.data.scheduled[action.actionId] = action;

    this.data.alerts[alert.alertId] = alert;
    this.audit("device", "device", "alert.created", {
      alertId: alert.alertId,
      eventId: event.eventId,
      severity: alert.severity,
      sustained: event.sustained,
      hadDeviceOff: event.hadDeviceOff,
      hadLowQuality: event.hadLowQuality,
    });
    touched.push(alert);
  }

  private pushGuardianNotifications(
    alert: AlertRecord,
    plan: CarePlanVersion,
    atIso: string,
    upgrade: boolean,
  ): void {
    const roster = this.rosters[alert.patientId];
    const targets = roster?.guardianIds ?? [];
    const suppressed = this.isSuppressed(
      alert.patientId,
      alert.severity,
      new Date(atIso),
    );
    for (const guardianId of targets) {
      const note: NotificationRecord = {
        notificationId: id("notif"),
        at: atIso,
        channel: "guardian-push",
        target: guardianId,
        severity: alert.severity,
        suppressed,
        ...(suppressed
          ? { suppressReason: "silence-window" as const }
          : {}),
      };
      alert.notifications.push(note);
    }
    this.audit("device", "device", upgrade ? "alert.upgraded" : "alert.guardians-notified", {
      alertId: alert.alertId,
      severity: alert.severity,
      suppressed,
      planVersion: plan.version,
    });
  }

  // ---------------- 升级 ----------------

  /**
   * 执行到期的定时升级检查。实时模式与回放都走这里，保证语义一致。
   */
  runDue(now: Date): ScheduledAction[] {
    const executed: ScheduledAction[] = [];
    const pending = Object.values(this.data.scheduled)
      .filter((a) => a.status === "pending" && new Date(a.dueAt).getTime() <= now.getTime())
      .sort((a, b) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime());
    for (const action of pending) {
      const alert = this.data.alerts[action.alertId];
      if (!alert) {
        this.finishAction(action, "done", "告警不存在，忽略。", now);
        executed.push(action);
        continue;
      }
      if (alert.status === "open" && !alert.locked) {
        this.escalate(
          alert,
          new Date(action.dueAt),
          [
            `持续 ${alert.escalationAfterSeconds}s 未获有效处置（sustained-unacknowledged）`,
            alert.severity === "high" ? "事件为高严重度" : "普通事件持续未响应",
          ],
          { id: "scheduler", role: "system" },
        );
        this.finishAction(action, "done", "已按计划升级。", now);
      } else {
        this.finishAction(
          action,
          "done",
          `告警已为 ${alert.status}（锁定：${alert.locked?.response ?? "无"}），无需升级。`,
          now,
        );
      }
      executed.push(action);
    }
    if (executed.length > 0) this.save();
    return executed;
  }

  escalate(
    alert: AlertRecord,
    at: Date,
    reasons: string[],
    actor: { id: string; role: "system" | "guardian" },
  ): void {
    const plan =
      this.registry.getPlan(alert.planId, alert.planVersion) ?? undefined;
    const roster = this.rosters[alert.patientId];
    const contacts = [
      ...(plan?.emergencyContacts ?? []).map((c) => `${c.name}(${c.role}) ${c.phone}`),
      ...(roster ? [`${roster.hospital.name} ${roster.hospital.phone}`] : []),
    ];
    for (const target of contacts) {
      alert.notifications.push({
        notificationId: id("notif"),
        at: at.toISOString(),
        channel: "escalation-call",
        target,
        severity: "high",
        suppressed: false,
      });
    }
    alert.status = "escalated";
    alert.escalatedAt = at.toISOString();
    alert.escalationReasons.push(...reasons);
    this.audit(actor.id, actor.role, "alert.escalated", {
      alertId: alert.alertId,
      at: at.toISOString(),
      reasons,
      contacts,
    });
  }

  private finishAction(
    action: ScheduledAction,
    status: "done" | "cancelled",
    outcome: string,
    at: Date,
  ): void {
    action.status = status;
    action.outcome = outcome;
    action.finishedAt = at.toISOString();
    this.audit("system", "system", "scheduler.action-finished", {
      actionId: action.actionId,
      alertId: action.alertId,
      status,
      outcome,
    });
  }

  // ---------------- 家庭回执 ----------------

  acknowledge(input: AckInput): AlertRecord {
    const alert = this.data.alerts[input.alertId];
    if (!alert) throw new Error(`告警 ${input.alertId} 不存在。`);

    const ack: FamilyAcknowledgement = {
      acknowledgementId: input.acknowledgementId ?? id("ack"),
      alertId: input.alertId,
      guardianId: input.guardianId,
      response: input.response,
      receivedAt: input.receivedAt,
    };
    alert.acknowledgements.push(ack);
    const at = new Date(input.receivedAt);

    if (!alert.locked && TERMINAL.has(input.response)) {
      // 首个有效处置锁定结果
      alert.locked = {
        acknowledgementId: ack.acknowledgementId,
        guardianId: input.guardianId,
        response: input.response,
        at: input.receivedAt,
      };
      const action = alert.scheduledActionId
        ? this.data.scheduled[alert.scheduledActionId]
        : undefined;
      if (input.response === "false-alarm") {
        if (alert.status === "escalated") {
          // 升级已经发出（医院已介入）：误报意见保留并锁定，但状态不得降级关闭
          if (action && action.status === "pending") {
            this.finishAction(action, "cancelled", "首个处置为 false-alarm，但已升级，维持升级状态。", at);
          }
          this.audit(input.guardianId, "guardian", "alert.lock-retained-post-escalation", {
            alertId: alert.alertId,
            acknowledgementId: ack.acknowledgementId,
            response: "false-alarm",
          });
        } else {
          alert.status = "resolved";
          alert.closedAt = input.receivedAt;
          alert.closeReason = "family:false-alarm";
          if (action && action.status === "pending") {
            this.finishAction(action, "cancelled", "首个有效处置为 false-alarm，关闭告警。", at);
          }
          this.audit(input.guardianId, "guardian", "alert.locked-false-alarm", {
            alertId: alert.alertId,
            acknowledgementId: ack.acknowledgementId,
          });
        }
      } else {
        // needs-help：立即升级，不等持续阈值
        if (action && action.status === "pending") {
          this.finishAction(action, "cancelled", "监护人明确 needs-help，立即升级。", at);
        }
        if (alert.status !== "escalated") {
          this.escalate(alert, at, ["监护人确认需要救助（needs-help）"], {
            id: input.guardianId,
            role: "guardian",
          });
        }
        this.audit(input.guardianId, "guardian", "alert.locked-needs-help", {
          alertId: alert.alertId,
          acknowledgementId: ack.acknowledgementId,
        });
      }
      this.save();
      return alert;
    }

    if (alert.locked) {
      // 后来意见一律保留；与锁定结果矛盾时单独标记，供复诊核对
      alert.laterOpinionIds.push(ack.acknowledgementId);
      this.audit(input.guardianId, "guardian", "alert.later-opinion-retained", {
        alertId: alert.alertId,
        acknowledgementId: ack.acknowledgementId,
        response: input.response,
        lockedResponse: alert.locked.response,
      });
      // needs-help 不能被静音/先前的误报关闭吞掉：保留原锁定，同时再次升级
      if (input.response === "needs-help" && alert.status !== "escalated") {
        this.escalate(
          alert,
          at,
          ["锁定后另有监护人报告 needs-help，保留原锁定并再次升级"],
          { id: input.guardianId, role: "guardian" },
        );
      }
      // 已升级后即便收到 false-alarm 也只记录、不降级
      if (input.response === "false-alarm" && alert.status === "escalated") {
        this.audit(input.guardianId, "guardian", "alert.downgrade-blocked-post-escalation", {
          alertId: alert.alertId,
          acknowledgementId: ack.acknowledgementId,
        });
      }
      this.save();
      return alert;
    }

    // 已升级但尚无锁定：observing/false-alarm 都不能关闭事件，只记录
    if (alert.status === "escalated") {
      this.audit(input.guardianId, "guardian", "alert.ack-retained-post-escalation", {
        alertId: alert.alertId,
        acknowledgementId: ack.acknowledgementId,
        response: input.response,
      });
      this.save();
      return alert;
    }

    // observing：非终结性，只记录；持续升级检查仍然有效
    this.audit(input.guardianId, "guardian", "alert.observing", {
      alertId: alert.alertId,
      acknowledgementId: ack.acknowledgementId,
    });
    this.save();
    return alert;
  }

  getAlert(alertId: string): AlertRecord | undefined {
    return this.data.alerts[alertId];
  }

  listAlerts(patientId?: string): AlertRecord[] {
    return Object.values(this.data.alerts).filter(
      (a) => !patientId || a.patientId === patientId,
    );
  }

  // ---------------- 审计 ----------------

  audit(
    actorId: string,
    actorRole: AuditEvent["actorRole"],
    action: string,
    detail: Record<string, unknown>,
    at?: Date,
  ): void {
    this.data.audit.push({
      auditId: id("audit"),
      at: (at ?? new Date()).toISOString(),
      actorId,
      actorRole,
      action,
      detail,
    });
  }

  private save(): void {
    this.persist?.();
  }
}

function toAnnotation(c: ReturnType<typeof annotate>): CandidateAnnotation {
  return {
    candidateId: c.candidateId,
    deviceOff: c.deviceOff,
    lowQuality: c.lowQuality,
    abnormal: c.abnormal,
    abnormalSignals: c.abnormalSignals,
  };
}
