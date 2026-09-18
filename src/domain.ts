/**
 * 领域模型：在 src/contracts.ts 给出的边界之上扩展。
 *
 * 关键边界：
 * - CarePlanVersion 是医生签署的临床规则，家庭只能提出 AdjustmentRequest，
 *   不能直接改写生效中的计划。
 * - AlertOutcome 一旦由"首个有效处置"锁定即不可更改，后来的矛盾回执仍被保留。
 */
import type {
  AlertSeverity,
  CarePlanVersion,
  FamilyAcknowledgement,
  GuardianResponse,
  SensorCandidate,
  SilenceWindow,
} from "./contracts.js";

export type {
  AlertSeverity,
  CarePlanVersion,
  FamilyAcknowledgement,
  GuardianResponse,
  SensorCandidate,
  SilenceWindow,
};

/** 家庭询问：本版计划在复诊时需要向家庭确认的问题 */
export interface FamilyQuestion {
  questionId: string;
  /** 询问文本，例如"静音是否覆盖了喂奶时段" */
  text: string;
}

/** 家庭对询问的回答：独立留痕，不回写、不修改已签署的计划 */
export interface QuestionAnswer {
  planId: string;
  version: number;
  questionId: string;
  answer: string;
  guardianId: string;
  answeredAt: string;
}

export interface EmergencyContact {
  contactId: string;
  name: string;
  /** 升级角色顺序：primary 未响应才会尝试 secondary */
  role: "primary" | "secondary" | "clinic-oncall";
  channel: string;
}

/** 接收普通通知的监护人 */
export interface CareGuardian {
  guardianId: string;
  name: string;
  /** 推送通道，例如 app:guardian-a */
  channel: string;
}

/**
 * 完整的医生签署计划。CarePlanVersion（契约字段）之外补充
 * 家庭询问、紧急联系人与监护人；签署时即冻结，effectiveFrom/effectiveUntil 划定有效期。
 */
export interface SignedCarePlan extends CarePlanVersion {
  /** 阈值的临床依据，供复诊审阅 */
  rationale: string;
  familyQuestions: FamilyQuestion[];
  emergencyContacts: EmergencyContact[];
  guardians: CareGuardian[];
}

/** 候选的数据质量结论 */
export type CandidateQuality =
  | "usable"
  | "device-off" // 设备脱落（worn=false）
  | "low-quality"; // 低质量区间（qualityFlags 非空）

/** 关联后的候选事件簇：时间接近的腕部运动 + 心率变化 */
export interface CorrelatedCluster {
  clusterId: string;
  patientId: string;
  startedAt: string;
  endedAt: string;
  candidateIds: string[];
  peakMotionScore: number;
  maxHeartRateDelta: number;
  /** 如实标注：只要簇内有候选脱落/低质量就置位，不静默丢弃 */
  quality: CandidateQuality;
  qualityReasons: string[];
}

/** 告警的当前生命周期状态 */
export type AlertState =
  | "pending" // 已产生，尚未升级、未被处置
  | "escalated" // 持续未响应，已按计划升级给紧急联系人
  | "resolved"; // 已被首个有效处置锁定

/** 一次升级动作（打给哪位联系人、结果如何） */
export interface EscalationRecord {
  contactId: string;
  contactName: string;
  role: EmergencyContact["role"];
  at: string;
  result: "delivered" | "failed";
}

/** 处置锁定结果 */
export interface AlertOutcome {
  /** 生效的回执 */
  acknowledgement: FamilyAcknowledgement;
  /** 锁定时刻 */
  lockedAt: string;
  /**
   * 锁定后到达的、与结果相矛盾的回执，保留但不再改变结果。
   * 例如 observing 先锁定 needs-help 之后到达，或 false-alarm 与 needs-help 冲突。
   */
  superseded: FamilyAcknowledgement[];
}

export interface Alert {
  alertId: string;
  patientId: string;
  clusterId: string;
  /** 产生告警时所用的计划 */
  planId: string;
  severity: AlertSeverity;
  /** 产生告警时所用的计划版本 */
  planVersion: number;
  /** 告警依据的数据质量；technical 表示源于设备脱落/低质量，需家庭排查佩戴 */
  evidenceQuality: CandidateQuality;
  qualityReasons: string[];
  createdAt: string;
  /** 持续事件的判定起点：首个候选的 capturedAt */
  sustainedSince: string;
  /** 到达 escalationAfterSeconds 仍无有效处置时应升级的时刻（技术告警不安排升级） */
  escalateAfter?: string;
  /** 产生时是否处于家庭静音窗内（仅影响普通通知） */
  mutedAtBirth: boolean;
  state: AlertState;
  notifications: NotificationRecord[];
  escalations: EscalationRecord[];
  /** 所有收到的回执（含未锁定结果的同意/观察意见），按到达顺序保留 */
  acknowledgements: FamilyAcknowledgement[];
  outcome?: AlertOutcome;
}

/** 发给监护人的普通通知 */
export interface NotificationRecord {
  guardianId: string;
  channel: string;
  at: string;
  /** 静音窗内被压低（suppressed）或正常送达（delivered） */
  status: "delivered" | "suppressed";
  reason: string;
}

/** 家庭对候选的误报反馈：可附在申请中供医生复诊评估 */
export interface FalseAlarmFeedback {
  feedbackId: string;
  patientId: string;
  candidateId: string;
  guardianId: string;
  comment: string;
  createdAt: string;
}

export type AdjustmentRequestStatus = "submitted" | "approved" | "rejected";

/**
 * 家长申请调整。仅承载申请，不触碰生效中的临床规则；
 * 医生批准后通过签署新版本计划生效（新版本号、新有效期）。
 */
export interface AdjustmentRequest {
  requestId: string;
  patientId: string;
  guardianId: string;
  /** 期望调整的字段（仅记录诉求，不直接写回计划） */
  proposed: Partial<
    Pick<
      CarePlanVersion,
      "correlationWindowSeconds" | "escalationAfterSeconds"
    >
  >;
  /** 关联的误报反馈，作为统计依据 */
  feedbackIds: string[];
  reason: string;
  createdAt: string;
  status: AdjustmentRequestStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  /** 批准后诞生的新版本计划 */
  resultingPlanVersion?: number;
}

/** 持久化状态的整体形状 */
export interface ServiceState {
  plans: SignedCarePlan[];
  silenceWindows: SilenceWindow[];
  candidates: SensorCandidate[];
  clusters: CorrelatedCluster[];
  alerts: Alert[];
  feedback: FalseAlarmFeedback[];
  adjustmentRequests: AdjustmentRequest[];
  /** 家庭对各版计划询问的回答 */
  questionAnswers: QuestionAnswer[];
  /** 尚未执行的定时升级动作（重启后据此继续） */
  pendingActions: ScheduledAction[];
  /** 单调事件流水，复诊时回答"谁在何时做了什么" */
  auditLog: AuditEntry[];
}

export type ScheduledActionKind = "escalate";

export interface ScheduledAction {
  actionId: string;
  kind: ScheduledActionKind;
  alertId: string;
  patientId: string;
  /** ISO 时刻，到点即执行 */
  dueAt: string;
  /** 重复执行时去重用：动作已执行（alerts.escalations 中体现）就跳过 */
  dedupeKey: string;
}

export interface AuditEntry {
  at: string;
  actorId: string;
  actorRole: "clinician" | "guardian" | "system" | "scheduler";
  action: string;
  detail: Record<string, unknown>;
}

/** 一晚回放结束后的统计，供医生据误报调整下一版计划 */
export interface NightlyStats {
  patientId: string;
  windowFrom: string;
  windowUntil: string;
  totalCandidates: number;
  /** 设备脱落/低质量的候选数（如实计入） */
  degradedCandidates: number;
  clusters: number;
  alertsBySeverity: Record<AlertSeverity, number>;
  alertsEscalated: number;
  outcomes: Record<GuardianResponse | "unresolved", number>;
  /** 标记为误报的候选数（家庭反馈口径） */
  falseAlarmFeedbackCount: number;
  /** 静音窗内被压低的普通通知数 */
  suppressedNotifications: number;
  /** 待医生处理的调整申请数 */
  pendingAdjustmentRequests: number;
}
