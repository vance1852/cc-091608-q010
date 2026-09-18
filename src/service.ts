/**
 * 夜间发作告警协作服务核心。
 *
 * 临床边界：
 * - 计划（观察窗口、持续阈值、联系人、家庭询问）只能由医生签署新版本产生；
 *   监护人的入口是误报反馈与调整申请，申请在医生批准并签署新版本前不改变任何规则。
 * - 静音只压低 <= SilenceWindow.maximumSeverity 的普通通知；
 *   high 严重度通知照常送达，持续未响应到点仍按计划升级。
 * - 首个"有效处置"（false-alarm / needs-help）锁定告警结果；observing 只是过程意见，
 *   不终止告警；锁定后到达的矛盾回执进入 outcome.superseded，全部留痕。
 * - 定时升级动作保存在 pendingActions，服务重启后 runDueActions 继续执行。
 */
import { randomUUID } from "node:crypto";
import type {
  AdjustmentRequest,
  Alert,
  AlertOutcome,
  AuditEntry,
  CandidateQuality,
  CorrelatedCluster,
  CareGuardian,
  EmergencyContact,
  FalseAlarmFeedback,
  NightlyStats,
  NotificationRecord,
  QuestionAnswer,
  SignedCarePlan,
  ServiceState,
  ScheduledAction,
} from "./domain.js";
import type {
  AlertSeverity,
  FamilyAcknowledgement,
  GuardianResponse,
  SensorCandidate,
  SilenceWindow,
} from "./contracts.js";
import {
  classifyCluster,
  DEFAULT_THRESHOLDS,
} from "./correlation.js";
import {
  addSeconds,
  type Clock,
  iso,
  severityRank,
  SystemClock,
  toMs,
  withinWindow,
} from "./time.js";

export interface SignPlanInput {
  planId: string;
  version?: number;
  patientId: string;
  effectiveFrom: string;
  effectiveUntil: string;
  correlationWindowSeconds: number;
  escalationAfterSeconds: number;
  rationale: string;
  familyQuestions: { questionId: string; text: string }[];
  emergencyContacts: EmergencyContact[];
  guardians: CareGuardian[];
  signedBy: string;
}

export interface OutboundMessage {
  kind: "notification" | "escalation-call";
  alertId: string;
  patientId: string;
  severity: AlertSeverity;
  text: string;
}

/** 通知/电话外呼网关。生产环境接推送与语音网关，回放与测试用录制版。 */
export interface NotifyGateway {
  push(
    target: { guardianId: string; name: string; channel: string },
    message: OutboundMessage,
  ): { delivered: boolean } | Promise<{ delivered: boolean }>;
  call(
    contact: EmergencyContact,
    message: OutboundMessage,
  ): { delivered: boolean } | Promise<{ delivered: boolean }>;
}

/** 默认网关：不外呼，只记录，全部视为送达；可用 failRoles 注入未送达的联系人角色。 */
export class InMemoryGateway implements NotifyGateway {
  readonly pushes: Array<{ target: CareGuardian; message: OutboundMessage; at: string; delivered: boolean }> = [];
  readonly calls: Array<{ contact: EmergencyContact; message: OutboundMessage; at: string; delivered: boolean }> = [];
  readonly failRoles = new Set<EmergencyContact["role"]>();

  constructor(private readonly clock: Clock = new SystemClock()) {}

  push(target: CareGuardian, message: OutboundMessage): { delivered: boolean } {
    const delivered = true;
    this.pushes.push({ target, message, at: iso(this.clock.now()), delivered });
    return { delivered };
  }

  call(contact: EmergencyContact, message: OutboundMessage): { delivered: boolean } {
    const delivered = !this.failRoles.has(contact.role);
    this.calls.push({ contact, message, at: iso(this.clock.now()), delivered });
    return { delivered };
  }
}

const TERMINAL_RESPONSES: ReadonlySet<GuardianResponse> = new Set([
  "false-alarm",
  "needs-help",
]);

/** 两个终结性意见互相矛盾；observing 是过程意见，不与任何结论矛盾 */
function contradicts(locked: GuardianResponse, later: GuardianResponse): boolean {
  return TERMINAL_RESPONSES.has(later) && locked !== later;
}

export function emptyState(): ServiceState {
  return {
    plans: [],
    silenceWindows: [],
    candidates: [],
    clusters: [],
    alerts: [],
    feedback: [],
    adjustmentRequests: [],
    questionAnswers: [],
    pendingActions: [],
    auditLog: [],
  };
}

export class NocturnalAlertService {
  private state: ServiceState;

  constructor(
    private readonly clock: Clock = new SystemClock(),
    private readonly gateway: NotifyGateway = new InMemoryGateway(clock),
    initial?: ServiceState,
  ) {
    this.state = initial ? structuredClone(initial) : emptyState();
  }

  getSnapshot(): ServiceState {
    return structuredClone(this.state);
  }

  // ---------- 审计 ----------

  private audit(
    actorId: string,
    actorRole: AuditEntry["actorRole"],
    action: string,
    detail: Record<string, unknown>,
  ): void {
    this.state.auditLog.push({ at: iso(this.clock.now()), actorId, actorRole, action, detail });
  }

  timeline(patientId?: string): AuditEntry[] {
    const entries = patientId
      ? this.state.auditLog.filter((e) => e.detail["patientId"] === patientId)
      : this.state.auditLog;
    return [...entries].sort((a, b) => toMs(a.at) - toMs(b.at));
  }

  // ---------- 照护计划（医生侧） ----------

  /** 医生签署计划。新版本只追加、不覆盖；有效期不允许与同 planId 旧版本重叠。 */
  signCarePlan(input: SignPlanInput): SignedCarePlan {
    if (!input.signedBy.trim()) throw new Error("计划必须由医生签署（signedBy）");
    if (!input.rationale.trim()) throw new Error("计划必须写明临床依据 rationale");
    if (toMs(input.effectiveUntil) <= toMs(input.effectiveFrom)) {
      throw new Error("有效期无效：effectiveUntil 必须晚于 effectiveFrom");
    }
    if (!Number.isInteger(input.correlationWindowSeconds) || input.correlationWindowSeconds <= 0) {
      throw new Error("观察窗口 correlationWindowSeconds 必须为正整数秒");
    }
    if (!Number.isInteger(input.escalationAfterSeconds) || input.escalationAfterSeconds <= 0) {
      throw new Error("持续阈值 escalationAfterSeconds 必须为正整数秒");
    }
    if (input.familyQuestions.length === 0) throw new Error("每版计划必须包含家庭询问");
    if (input.emergencyContacts.length === 0) throw new Error("每版计划必须包含紧急联系人");
    if (input.guardians.length === 0) throw new Error("每版计划必须包含至少一名监护人");

    const prior = this.state.plans
      .filter((p) => p.planId === input.planId)
      .sort((a, b) => b.version - a.version);
    const version = input.version ?? (prior.length > 0 ? (prior[0]!.version + 1) : 1);
    if (prior.some((p) => p.version === version)) {
      throw new Error(`计划 ${input.planId} 版本 ${version} 已存在`);
    }
    // 新版本不能回溯覆盖旧版本的有效期（半开区间首尾相接允许）
    for (const p of prior) {
      if (
        toMs(input.effectiveFrom) < toMs(p.effectiveUntil) &&
        toMs(input.effectiveUntil) > toMs(p.effectiveFrom)
      ) {
        throw new Error(`新版本有效期与已签署版本 v${p.version} 重叠`);
      }
    }

    const plan: SignedCarePlan = {
      planId: input.planId,
      version,
      patientId: input.patientId,
      effectiveFrom: input.effectiveFrom,
      effectiveUntil: input.effectiveUntil,
      correlationWindowSeconds: input.correlationWindowSeconds,
      escalationAfterSeconds: input.escalationAfterSeconds,
      signedBy: input.signedBy,
      rationale: input.rationale,
      familyQuestions: input.familyQuestions.map((q) => ({ ...q })),
      emergencyContacts: input.emergencyContacts.map((c) => ({ ...c })),
      guardians: input.guardians.map((g) => ({ ...g })),
    };

    this.state.plans.push(plan);
    this.audit(input.signedBy, "clinician", "plan.signed", {
      patientId: input.patientId,
      planId: input.planId,
      version,
      effectiveFrom: input.effectiveFrom,
      effectiveUntil: input.effectiveUntil,
      correlationWindowSeconds: input.correlationWindowSeconds,
      escalationAfterSeconds: input.escalationAfterSeconds,
    });
    return structuredClone(plan);
  }

  /** 某时刻对患者生效的计划（取有效期覆盖该时刻的最新版本） */
  planAt(patientId: string, at: string | Date): SignedCarePlan | undefined {
    const ms = toMs(at);
    return this.state.plans
      .filter(
        (p) =>
          p.patientId === patientId &&
          ms >= toMs(p.effectiveFrom) &&
          ms < toMs(p.effectiveUntil),
      )
      .sort((a, b) => b.version - a.version)[0];
  }

  private planVersion(planId: string, version: number): SignedCarePlan {
    const plan = this.state.plans.find((p) => p.planId === planId && p.version === version);
    if (!plan) throw new Error(`计划 ${planId} v${version} 不存在`);
    return plan;
  }

  /** 复诊时家庭回答医生的询问；独立留痕，不回写已签署计划，更不改变临床规则。 */
  answerFamilyQuestion(
    planId: string,
    version: number,
    questionId: string,
    answer: string,
    guardianId: string,
  ): QuestionAnswer {
    const plan = this.planVersion(planId, version);
    const q = plan.familyQuestions.find((x) => x.questionId === questionId);
    if (!q) throw new Error(`问题 ${questionId} 不在计划 ${planId} v${version} 中`);
    const record: QuestionAnswer = {
      planId,
      version,
      questionId,
      answer,
      guardianId,
      answeredAt: iso(this.clock.now()),
    };
    this.state.questionAnswers.push(record);
    this.audit(guardianId, "guardian", "plan.question-answered", {
      patientId: plan.patientId,
      planId,
      version,
      questionId,
    });
    return structuredClone(record);
  }

  questionAnswersFor(planId: string, version: number): QuestionAnswer[] {
    return this.state.questionAnswers
      .filter((a) => a.planId === planId && a.version === version)
      .map((a) => structuredClone(a));
  }

  // ---------- 静音窗（家庭侧，边界明确） ----------

  setSilenceWindow(window: SilenceWindow): void {
    if (toMs(window.until) <= toMs(window.from)) throw new Error("静音窗 until 必须晚于 from");
    // 临床安全边界：家庭短时静音只能压低普通通知；high 严重度必须始终可送达，
    // 持续未响应也仍按计划电话升级。需要更宽静音必须由医生在计划中另行安排。
    if (window.maximumSeverity !== "ordinary") {
      throw new Error("家庭静音窗最高只能压低 ordinary 通知，high 严重度不允许静音");
    }
    this.state.silenceWindows.push({ ...window });
    this.audit("family", "guardian", "silence.set", {
      patientId: window.patientId,
      from: window.from,
      until: window.until,
      maximumSeverity: window.maximumSeverity,
    });
  }

  /** 该时刻此严重度的普通通知是否应被压低 */
  private isMuted(patientId: string, severity: AlertSeverity, at: Date): boolean {
    return this.state.silenceWindows.some(
      (w) =>
        w.patientId === patientId &&
        severityRank(severity) <= severityRank(w.maximumSeverity) &&
        withinWindow(at, w.from, w.until),
    );
  }

  // ---------- 传感器摄入与关联 ----------

  /**
   * 摄入一个腕部候选。没有生效计划时拒绝——临床阈值缺失时不得自行解释信号。
   * 增量归入当前观察窗口内的簇，并据此产生/更新告警。
   */
  async ingestCandidate(raw: SensorCandidate): Promise<{ cluster: CorrelatedCluster; alert?: Alert }> {
    const plan = this.planAt(raw.patientId, raw.capturedAt);
    if (!plan) {
      throw new Error(`患者 ${raw.patientId} 在 ${raw.capturedAt} 没有生效中的签署计划`);
    }
    if (this.state.candidates.some((c) => c.candidateId === raw.candidateId)) {
      throw new Error(`候选 ${raw.candidateId} 已存在`);
    }
    this.state.candidates.push({ ...raw, qualityFlags: [...raw.qualityFlags] });

    const cluster = this.attachToCluster(raw, plan.correlationWindowSeconds);
    const result = await this.evaluateCluster(cluster, plan);
    this.audit("device", "system", "candidate.ingested", {
      patientId: raw.patientId,
      candidateId: raw.candidateId,
      clusterId: cluster.clusterId,
      worn: raw.worn,
      qualityFlags: raw.qualityFlags,
    });
    return result;
  }

  /** 批量摄入（按时间排序）。返回每个簇最终的告警情况。 */
  async ingestBatch(rawCandidates: SensorCandidate[]): Promise<Array<{ cluster: CorrelatedCluster; alert?: Alert }>> {
    const out: Array<{ cluster: CorrelatedCluster; alert?: Alert }> = [];
    const sorted = [...rawCandidates].sort(
      (a, b) => toMs(a.capturedAt) - toMs(b.capturedAt),
    );
    for (const c of sorted) {
      const r = await this.ingestCandidate(c);
      const last = out[out.length - 1];
      if (last && last.cluster.clusterId === r.cluster.clusterId) {
        out[out.length - 1] = r;
      } else {
        out.push(r);
      }
    }
    return out;
  }

  private attachToCluster(raw: SensorCandidate, gapSeconds: number): CorrelatedCluster {
    const patientClusters = this.state.clusters
      .filter((c) => c.patientId === raw.patientId)
      .sort((a, b) => toMs(b.endedAt) - toMs(a.endedAt));
    const latest = patientClusters[0];
    const gapMs = gapSeconds * 1000;

    let target: CorrelatedCluster;
    if (latest && toMs(raw.capturedAt) - toMs(latest.endedAt) <= gapMs) {
      target = latest;
    } else {
      target = {
        clusterId: `cluster-${raw.candidateId}`,
        patientId: raw.patientId,
        startedAt: raw.capturedAt,
        endedAt: raw.capturedAt,
        candidateIds: [],
        peakMotionScore: -Infinity,
        maxHeartRateDelta: -Infinity,
        quality: "usable",
        qualityReasons: [],
      };
      this.state.clusters.push(target);
    }
    target.candidateIds.push(raw.candidateId);

    // 用簇内全部候选重算峰值与质量标注
    const byId = new Map(this.state.candidates.map((c) => [c.candidateId, c]));
    const members = target.candidateIds
      .map((id) => byId.get(id))
      .filter((c): c is SensorCandidate => Boolean(c));
    const sortedMembers = members.sort((a, b) => toMs(a.capturedAt) - toMs(b.capturedAt));
    target.startedAt = sortedMembers[0]!.capturedAt;
    target.endedAt = sortedMembers[sortedMembers.length - 1]!.capturedAt;
    target.peakMotionScore = Math.max(...members.map((m) => m.motionScore));
    target.maxHeartRateDelta = Math.max(...members.map((m) => m.heartRateDelta));

    const reasons = new Set<string>();
    let quality: CandidateQuality = "usable";
    for (const m of members) {
      if (!m.worn) {
        quality = "device-off";
        reasons.add(`device-off@${m.capturedAt}`);
      } else if (m.qualityFlags.length > 0) {
        if (quality !== "device-off") quality = "low-quality";
        for (const f of m.qualityFlags) reasons.add(`${f}@${m.capturedAt}`);
      }
    }
    target.quality = quality;
    target.qualityReasons = [...reasons].sort();
    return target;
  }

  private async evaluateCluster(
    cluster: CorrelatedCluster,
    plan: SignedCarePlan,
  ): Promise<{ cluster: CorrelatedCluster; alert?: Alert }> {
    const byId = new Map(this.state.candidates.map((c) => [c.candidateId, c]));
    const clinical = classifyCluster(cluster, byId, DEFAULT_THRESHOLDS);

    const existing = this.state.alerts.find((a) => a.clusterId === cluster.clusterId);

    // 普通翻身：运动与心率互不印证，在此关闭，不产生告警
    if (clinical === "none" && cluster.quality === "usable") {
      return existing ? { cluster, alert: existing } : { cluster };
    }

    if (existing) {
      if (existing.state !== "resolved") {
        // 技术告警（脱落/低质量，无升级安排）后续出现临床强信号：转为临床告警，补排升级
        const becameClinical = existing.escalateAfter === undefined && clinical !== "none";
        if (becameClinical) {
          existing.severity = clinical;
          existing.escalateAfter = iso(addSeconds(cluster.startedAt, plan.escalationAfterSeconds));
          await this.deliverNotifications(
            existing,
            plan,
            clinical === "high"
              ? "检测到持续剧烈腕部运动伴心率升高，疑似夜间发作"
              : "检测到腕部异常活动，请留意",
          );
          this.scheduleEscalation(existing);
          this.audit("system", "system", "alert.promoted-clinical", {
            patientId: existing.patientId,
            alertId: existing.alertId,
            severity: existing.severity,
            escalateAfter: existing.escalateAfter,
          });
        } else if (clinical === "high" && existing.severity === "ordinary") {
          // 簇延长时严重度只升不降
          existing.severity = "high";
          await this.deliverNotifications(existing, plan, "信号增强，告警升级为高严重度");
        }
      }
      // 其余生命周期（升级/锁定）不受后到样本影响
      existing.evidenceQuality = cluster.quality;
      existing.qualityReasons = [...cluster.qualityReasons];
      return { cluster, alert: structuredClone(existing) };
    }

    const now = this.clock.now();
    const technical = clinical === "none";
    const severity: AlertSeverity = technical ? "ordinary" : clinical;
    const alert: Alert = {
      alertId: `alert-${cluster.clusterId}`,
      patientId: cluster.patientId,
      clusterId: cluster.clusterId,
      planId: plan.planId,
      planVersion: plan.version,
      severity,
      evidenceQuality: cluster.quality,
      qualityReasons: [...cluster.qualityReasons],
      createdAt: iso(now),
      sustainedSince: cluster.startedAt,
      mutedAtBirth: this.isMuted(cluster.patientId, severity, now),
      state: "pending",
      notifications: [],
      escalations: [],
      acknowledgements: [],
    };
    if (!technical) {
      alert.escalateAfter = iso(addSeconds(cluster.startedAt, plan.escalationAfterSeconds));
    }
    this.state.alerts.push(alert);

    const text = technical
      ? `腕带信号异常（${cluster.quality === "device-off" ? "疑似设备脱落" : "低质量区间"}），请检查佩戴`
      : severity === "high"
        ? `检测到持续剧烈腕部运动伴心率升高，疑似夜间发作`
        : `检测到腕部异常活动，请留意`;
    await this.deliverNotifications(alert, plan, text);

    this.audit("system", "system", technical ? "alert.technical-created" : "alert.created", {
      patientId: alert.patientId,
      alertId: alert.alertId,
      clusterId: cluster.clusterId,
      severity,
      evidenceQuality: cluster.quality,
      mutedAtBirth: alert.mutedAtBirth,
      ...(alert.escalateAfter ? { escalateAfter: alert.escalateAfter } : {}),
    });

    if (alert.escalateAfter) {
      this.scheduleEscalation(alert);
    }
    return { cluster, alert: structuredClone(alert) };
  }

  private async deliverNotifications(alert: Alert, plan: SignedCarePlan, text: string): Promise<void> {
    const now = iso(this.clock.now());
    const muted = this.isMuted(alert.patientId, alert.severity, this.clock.now());
    for (const g of plan.guardians) {
      const message: OutboundMessage = {
        kind: "notification",
        alertId: alert.alertId,
        patientId: alert.patientId,
        severity: alert.severity,
        text,
      };
      if (muted) {
        // 静音只压低普通通知；high 严重度走到下面的送达分支
        alert.notifications.push({
          guardianId: g.guardianId,
          channel: g.channel,
          at: now,
          status: "suppressed",
          reason: "家庭静音窗内，普通通知被压低",
        });
        continue;
      }
      const result = await this.gateway.push(g, message);
      alert.notifications.push({
        guardianId: g.guardianId,
        channel: g.channel,
        at: now,
        status: result.delivered ? "delivered" : "suppressed",
        reason: result.delivered ? "实时推送" : "推送网关未送达",
      });
    }
  }

  // ---------- 定时升级 ----------

  private scheduleEscalation(alert: Alert): void {
    if (!alert.escalateAfter) return;
    const action: ScheduledAction = {
      actionId: `act-${alert.alertId}-esc`,
      kind: "escalate",
      alertId: alert.alertId,
      patientId: alert.patientId,
      dueAt: alert.escalateAfter,
      dedupeKey: `esc:${alert.alertId}`,
    };
    this.state.pendingActions.push(action);
    this.audit("scheduler", "scheduler", "escalation.scheduled", {
      patientId: alert.patientId,
      alertId: alert.alertId,
      dueAt: action.dueAt,
    });
  }

  /**
   * 执行所有到期动作。重启后调用即可继续：动作持久化在 state.pendingActions，
   * 已处置（resolved）或已升级的告警对应动作直接作废，不会重复呼叫。
   */
  async runDueActions(at: Date | string = this.clock.now()): Promise<ScheduledAction[]> {
    const ms = toMs(at);
    const due = this.state.pendingActions
      .filter((a) => toMs(a.dueAt) <= ms)
      .sort((a, b) => toMs(a.dueAt) - toMs(b.dueAt));
    const fired: ScheduledAction[] = [];

    for (const action of due) {
      const alert = this.state.alerts.find((x) => x.alertId === action.alertId);
      this.state.pendingActions = this.state.pendingActions.filter((x) => x.actionId !== action.actionId);
      fired.push(action);

      if (!alert) {
        this.audit("scheduler", "scheduler", "escalation.skipped", {
          patientId: action.patientId,
          alertId: action.alertId,
          reason: "alert-missing",
        });
        continue;
      }
      if (alert.state === "resolved") {
        this.audit("scheduler", "scheduler", "escalation.skipped", {
          patientId: alert.patientId,
          alertId: alert.alertId,
          reason: "already-resolved",
        });
        continue;
      }
      if (alert.state === "escalated") continue; // 去重
      await this.escalate(alert);
    }
    return fired;
  }

  private async escalate(alert: Alert): Promise<void> {
    const plan = this.state.plans.find(
      (p) => p.planId === alert.planId && p.version === alert.planVersion,
    );
    if (!plan) throw new Error(`告警 ${alert.alertId} 引用的计划版本已丢失`);

    const message: OutboundMessage = {
      kind: "escalation-call",
      alertId: alert.alertId,
      patientId: alert.patientId,
      severity: "high",
      text: `持续异常活动超过 ${plan.escalationAfterSeconds} 秒未获有效处置，请立即跟进`,
    };

    const roleOrder: EmergencyContact["role"][] = ["primary", "secondary", "clinic-oncall"];
    const contacts = [...plan.emergencyContacts].sort(
      (a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role),
    );

    let deliveredTo: EmergencyContact | undefined;
    for (const contact of contacts) {
      const result = await this.gateway.call(contact, message);
      alert.escalations.push({
        contactId: contact.contactId,
        contactName: contact.name,
        role: contact.role,
        at: iso(this.clock.now()),
        result: result.delivered ? "delivered" : "failed",
      });
      if (result.delivered) {
        deliveredTo = contact;
        break;
      }
    }

    if (deliveredTo) {
      alert.state = "escalated";
      this.audit("scheduler", "scheduler", "escalation.delivered", {
        patientId: alert.patientId,
        alertId: alert.alertId,
        contactId: deliveredTo.contactId,
        contactName: deliveredTo.name,
      });
    } else {
      // 全部联系人未送达：一分钟后重试，事件不被吞掉
      const retry: ScheduledAction = {
        actionId: `act-${alert.alertId}-esc-retry-${Date.now()}`,
        kind: "escalate",
        alertId: alert.alertId,
        patientId: alert.patientId,
        dueAt: iso(addSeconds(this.clock.now(), 60)),
        dedupeKey: `esc:${alert.alertId}`,
      };
      this.state.pendingActions.push(retry);
      this.audit("scheduler", "scheduler", "escalation.retry-scheduled", {
        patientId: alert.patientId,
        alertId: alert.alertId,
        dueAt: retry.dueAt,
      });
    }
  }

  // ---------- 家庭回执：首个有效处置锁定 ----------

  /**
   * 接收监护人回执。
   * - observing：过程意见，保留但不锁定，告警继续等待终结处置/到点升级。
   * - 首个 false-alarm / needs-help：锁定结果，取消尚未执行的升级动作。
   *   若升级电话已经打出，状态保留 escalated（升级事实不可抹除），只补记家庭处置结果。
   * - 锁定后到达的矛盾终结意见：进入 superseded，结果不再改变。
   */
  acknowledge(input: {
    acknowledgementId?: string;
    alertId: string;
    guardianId: string;
    response: GuardianResponse;
    receivedAt?: string;
  }): { status: "recorded" | "locked" | "superseded"; alert: Alert } {
    const alert = this.state.alerts.find((a) => a.alertId === input.alertId);
    if (!alert) throw new Error(`告警 ${input.alertId} 不存在`);
    const plan = this.state.plans.find(
      (p) => p.planId === alert.planId && p.version === alert.planVersion,
    );
    if (!plan) throw new Error(`告警 ${input.alertId} 引用的计划版本已丢失`);
    if (!plan.guardians.some((g) => g.guardianId === input.guardianId)) {
      throw new Error(`${input.guardianId} 不是该患者计划中的监护人，不能回执`);
    }

    const ack: FamilyAcknowledgement = {
      acknowledgementId: input.acknowledgementId ?? `ack-${randomUUID()}`,
      alertId: input.alertId,
      guardianId: input.guardianId,
      response: input.response,
      receivedAt: input.receivedAt ?? iso(this.clock.now()),
    };
    if (alert.acknowledgements.some((x) => x.acknowledgementId === ack.acknowledgementId)) {
      throw new Error(`回执 ${ack.acknowledgementId} 已存在`);
    }
    alert.acknowledgements.push(ack);

    if (alert.outcome) {
      if (contradicts(alert.outcome.acknowledgement.response, ack.response)) {
        alert.outcome.superseded.push(ack);
        this.audit(input.guardianId, "guardian", "ack.superseded", {
          patientId: alert.patientId,
          alertId: alert.alertId,
          response: ack.response,
          lockedResponse: alert.outcome.acknowledgement.response,
        });
        return { status: "superseded", alert: structuredClone(alert) };
      }
      this.audit(input.guardianId, "guardian", "ack.recorded", {
        patientId: alert.patientId,
        alertId: alert.alertId,
        response: ack.response,
      });
      return { status: "recorded", alert: structuredClone(alert) };
    }

    if (!TERMINAL_RESPONSES.has(ack.response)) {
      this.audit(input.guardianId, "guardian", "ack.observing", {
        patientId: alert.patientId,
        alertId: alert.alertId,
      });
      return { status: "recorded", alert: structuredClone(alert) };
    }

    const outcome: AlertOutcome = {
      acknowledgement: ack,
      lockedAt: iso(this.clock.now()),
      superseded: [],
    };
    alert.outcome = outcome;
    // 升级电话已打出时保留 escalated：升级已经发生的事实不能被家庭回执抹除；
    // pending（尚未升级）才转为 resolved。
    if (alert.state === "pending") alert.state = "resolved";
    // 锁定即取消尚未执行的升级（含全部联系人未送达后的重试动作）
    const canceled = this.state.pendingActions.filter(
      (x) => x.alertId === alert.alertId && x.kind === "escalate",
    );
    this.state.pendingActions = this.state.pendingActions.filter(
      (x) => !(x.alertId === alert.alertId && x.kind === "escalate"),
    );
    this.audit(input.guardianId, "guardian", "ack.locked", {
      patientId: alert.patientId,
      alertId: alert.alertId,
      response: ack.response,
      canceledActionIds: canceled.map((x) => x.actionId),
    });
    return { status: "locked", alert: structuredClone(alert) };
  }

  // ---------- 误报反馈与调整申请（家庭侧，不触碰生效规则） ----------

  submitFalseAlarmFeedback(input: {
    feedbackId?: string;
    patientId: string;
    candidateId: string;
    guardianId: string;
    comment: string;
  }): FalseAlarmFeedback {
    const candidate = this.state.candidates.find((c) => c.candidateId === input.candidateId);
    if (!candidate) {
      throw new Error(`候选 ${input.candidateId} 不存在，不能对其反馈误报`);
    }
    if (candidate.patientId !== input.patientId) {
      throw new Error(`候选 ${input.candidateId} 不属于患者 ${input.patientId}`);
    }
    const feedback: FalseAlarmFeedback = {
      feedbackId: input.feedbackId ?? `fb-${randomUUID()}`,
      patientId: input.patientId,
      candidateId: input.candidateId,
      guardianId: input.guardianId,
      comment: input.comment,
      createdAt: iso(this.clock.now()),
    };
    this.state.feedback.push(feedback);
    this.audit(input.guardianId, "guardian", "feedback.false-alarm", {
      patientId: input.patientId,
      feedbackId: feedback.feedbackId,
      candidateId: input.candidateId,
    });
    return structuredClone(feedback);
  }

  requestAdjustment(input: {
    requestId?: string;
    patientId: string;
    guardianId: string;
    proposed?: Partial<
      Pick<SignedCarePlan, "correlationWindowSeconds" | "escalationAfterSeconds">
    >;
    feedbackIds?: string[];
    reason: string;
  }): AdjustmentRequest {
    const proposed = input.proposed ?? {};
    for (const [key, value] of Object.entries(proposed)) {
      if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
        throw new Error(`申请调整的 ${key} 必须为正整数秒`);
      }
    }
    for (const id of input.feedbackIds ?? []) {
      if (!this.state.feedback.some((f) => f.feedbackId === id)) {
        throw new Error(`误报反馈 ${id} 不存在`);
      }
    }
    const request: AdjustmentRequest = {
      requestId: input.requestId ?? `req-${randomUUID()}`,
      patientId: input.patientId,
      guardianId: input.guardianId,
      proposed,
      feedbackIds: input.feedbackIds ?? [],
      reason: input.reason,
      createdAt: iso(this.clock.now()),
      status: "submitted",
    };
    this.state.adjustmentRequests.push(request);
    // 关键边界：只记录申请，不写回任何生效中的计划字段
    this.audit(input.guardianId, "guardian", "adjustment.requested", {
      patientId: input.patientId,
      requestId: request.requestId,
      proposed,
    });
    return structuredClone(request);
  }

  /** 医生审批：批准则必须当场签署一版新计划（新有效期），申请本身永不直接改规则。 */
  reviewAdjustment(
    requestId: string,
    decision: "approved" | "rejected",
    reviewerId: string,
    newEffective?: { from: string; until: string },
  ): AdjustmentRequest {
    const request = this.state.adjustmentRequests.find((r) => r.requestId === requestId);
    if (!request) throw new Error(`调整申请 ${requestId} 不存在`);
    if (request.status !== "submitted") throw new Error(`申请已处理：${request.status}`);

    if (decision === "rejected") {
      request.status = "rejected";
      request.reviewedBy = reviewerId;
      request.reviewedAt = iso(this.clock.now());
      this.audit(reviewerId, "clinician", "adjustment.rejected", {
        patientId: request.patientId,
        requestId,
      });
      return structuredClone(request);
    }

    if (!newEffective) throw new Error("批准调整必须提供新版本的有效期");
    const current = this.state.plans
      .filter((p) => p.patientId === request.patientId)
      .sort((a, b) => b.version - a.version)[0];
    if (!current) throw new Error("患者尚无签署计划，无法在其上修订");

    const signed = this.signCarePlan({
      planId: current.planId,
      patientId: current.patientId,
      effectiveFrom: newEffective.from,
      effectiveUntil: newEffective.until,
      correlationWindowSeconds: request.proposed.correlationWindowSeconds ?? current.correlationWindowSeconds,
      escalationAfterSeconds: request.proposed.escalationAfterSeconds ?? current.escalationAfterSeconds,
      rationale: `依据监护人 ${request.guardianId} 的调整申请与 ${request.feedbackIds.length} 条误报反馈，由 ${reviewerId} 修订`,
      familyQuestions: current.familyQuestions.map((q) => ({
        questionId: q.questionId,
        text: q.text,
      })),
      emergencyContacts: current.emergencyContacts,
      guardians: current.guardians,
      signedBy: reviewerId,
    });
    request.status = "approved";
    request.reviewedBy = reviewerId;
    request.reviewedAt = iso(this.clock.now());
    request.resultingPlanVersion = signed.version;
    this.audit(reviewerId, "clinician", "adjustment.approved", {
      patientId: request.patientId,
      requestId,
      resultingPlanVersion: signed.version,
    });
    return structuredClone(request);
  }

  // ---------- 复诊视图 ----------

  alertsFor(patientId: string): Alert[] {
    return this.state.alerts
      .filter((a) => a.patientId === patientId)
      .sort((a, b) => toMs(a.createdAt) - toMs(b.createdAt))
      .map((a) => structuredClone(a));
  }

  clustersFor(patientId: string): CorrelatedCluster[] {
    return this.state.clusters
      .filter((c) => c.patientId === patientId)
      .sort((a, b) => toMs(a.startedAt) - toMs(b.startedAt))
      .map((c) => structuredClone(c));
  }

  nightlyStats(patientId: string, from: string, until: string): NightlyStats {
    const inWindow = (t: string): boolean => withinWindow(t, from, until);
    const candidates = this.state.candidates.filter(
      (c) => c.patientId === patientId && inWindow(c.capturedAt),
    );
    const alerts = this.state.alerts.filter(
      (a) => a.patientId === patientId && inWindow(a.createdAt),
    );
    const stats: NightlyStats = {
      patientId,
      windowFrom: from,
      windowUntil: until,
      totalCandidates: candidates.length,
      degradedCandidates: candidates.filter((c) => !c.worn || c.qualityFlags.length > 0).length,
      clusters: this.state.clusters.filter(
        (c) => c.patientId === patientId && toMs(c.startedAt) >= toMs(from) && toMs(c.startedAt) < toMs(until),
      ).length,
      alertsBySeverity: { ordinary: 0, high: 0 },
      alertsEscalated: 0,
      outcomes: { "false-alarm": 0, observing: 0, "needs-help": 0, unresolved: 0 },
      falseAlarmFeedbackCount: this.state.feedback.filter(
        (f) => f.patientId === patientId && inWindow(f.createdAt),
      ).length,
      suppressedNotifications: 0,
      pendingAdjustmentRequests: this.state.adjustmentRequests.filter(
        (r) => r.patientId === patientId && r.status === "submitted",
      ).length,
    };
    for (const alert of alerts) {
      stats.alertsBySeverity[alert.severity] += 1;
      if (alert.state === "escalated") stats.alertsEscalated += 1;
      for (const n of alert.notifications) if (n.status === "suppressed") stats.suppressedNotifications += 1;
      if (alert.outcome) stats.outcomes[alert.outcome.acknowledgement.response] += 1;
      else stats.outcomes.unresolved += 1;
    }
    return stats;
  }
}
