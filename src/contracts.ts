// 夜间发作告警协作的边界类型。
// 照护计划只能由医生签署新版本；家庭端只能写入回执与调整申请。

export type AlertSeverity = "ordinary" | "high";
export type GuardianResponse = "false-alarm" | "observing" | "needs-help";

export interface EmergencyContact {
  name: string;
  role: string;
  phone: string;
}

export interface CarePlanVersion {
  planId: string;
  version: number;
  patientId: string;
  /** 签署时间，审计用 */
  signedAt: string;
  signedBy: string;
  /** 有效期：[effectiveFrom, effectiveUntil) */
  effectiveFrom: string;
  effectiveUntil: string;
  /** 观察窗口（秒）：间隔不超过该值的腕部运动归为同一次事件 */
  correlationWindowSeconds: number;
  /** 持续阈值（秒）：事件持续且无响应超过该值即升级 */
  escalationAfterSeconds: number;
  /** 临床判定阈值：腕部分值或心率变化超过阈值才算异常，二者同时超过为高严重度 */
  motionThreshold: number;
  heartRateDeltaThreshold: number;
  /** 复诊时医生要向家庭确认的问题 */
  familyQuestions: string[];
  /** 升级时呼叫的紧急联系人 */
  emergencyContacts: EmergencyContact[];
}

/** 医生签署新版本时需要提供的内容；version 与 signedAt 由服务填写 */
export type SignedPlanInput = Omit<CarePlanVersion, "version" | "signedAt">;

/** 允许家庭申请调整的临床字段 */
export type AdjustablePlanField =
  | "correlationWindowSeconds"
  | "escalationAfterSeconds"
  | "motionThreshold"
  | "heartRateDeltaThreshold";

export type PlanAdjustmentStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "superseded";

export interface PlanAdjustmentRequest {
  requestId: string;
  planId: string;
  patientId: string;
  requestedBy: string;
  requestedAt: string;
  /** 期望修改的字段与建议值，不得直接改动生效中的计划 */
  proposed: Partial<Record<AdjustablePlanField, number>>;
  reason: string;
  /** 关联的告警/事件，便于复诊核对误报 */
  relatedAlertIds: string[];
  status: PlanAdjustmentStatus;
  decidedBy?: string;
  decidedAt?: string;
  /** 批准后新生效的计划版本号 */
  signedVersion?: number;
  decisionNote?: string;
}

export interface SensorCandidate {
  candidateId: string;
  patientId: string;
  capturedAt: string;
  motionScore: number;
  heartRateDelta: number;
  worn: boolean;
  qualityFlags: string[];
}

export interface FamilyAcknowledgement {
  acknowledgementId: string;
  alertId: string;
  guardianId: string;
  response: GuardianResponse;
  receivedAt: string;
}

export interface SilenceWindow {
  patientId: string;
  from: string;
  until: string;
  /** 静音最多压到的级别：ordinary 表示仅普通通知被压低，high 不受影响 */
  maximumSeverity: AlertSeverity;
}
