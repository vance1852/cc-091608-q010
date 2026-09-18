// 持久化记录：告警、通知、审计与“重启后仍须执行”的定时动作。
// 与 contracts 的边界类型分开，这里保存的是运行期状态。

import type {
  AlertSeverity,
  FamilyAcknowledgement,
  SilenceWindow,
} from "./contracts.ts";
import type { ObservedEvent } from "./domain.ts";
import type { Role } from "./plan.ts";

export type AlertStatus = "open" | "resolved" | "escalated";

export interface NotificationRecord {
  notificationId: string;
  at: string;
  /** guardian-push=给监护人的普通通知；escalation-call=按计划升级（含医院/紧急联系人） */
  channel: "guardian-push" | "escalation-call";
  target: string;
  severity: AlertSeverity;
  /** 静音只压低普通通知：被压低也留痕，不会直接消失 */
  suppressed: boolean;
  suppressReason?: "silence-window";
}

export interface LockRecord {
  acknowledgementId: string;
  guardianId: string;
  response: FamilyAcknowledgement["response"];
  at: string;
}

export interface CandidateAnnotation {
  candidateId: string;
  deviceOff: boolean;
  lowQuality: boolean;
  abnormal: boolean;
  abnormalSignals: Array<"motion" | "heartRate">;
}

export interface AlertRecord {
  alertId: string;
  patientId: string;
  planId: string;
  planVersion: number;
  eventId: string;
  startedAt: string;
  lastActivityAt: string;
  severity: AlertSeverity;
  status: AlertStatus;
  candidateIds: string[];
  candidateAnnotations: CandidateAnnotation[];
  hadDeviceOff: boolean;
  hadLowQuality: boolean;
  /** 创建该告警时生效的持续阈值（秒），便于复诊核对 */
  escalationAfterSeconds: number;
  notifications: NotificationRecord[];
  acknowledgements: FamilyAcknowledgement[];
  /** 与首个有效处置矛盾、但仍保留的后来回执 id */
  laterOpinionIds: string[];
  locked?: LockRecord;
  escalatedAt?: string;
  escalationReasons: string[];
  scheduledActionId?: string;
  closedAt?: string;
  closeReason?: string;
}

export interface AuditEvent {
  auditId: string;
  at: string;
  actorId: string;
  actorRole: Role | "device" | "system";
  action: string;
  detail: Record<string, unknown>;
}

export type ScheduledActionStatus = "pending" | "done" | "cancelled";

export interface ScheduledAction {
  actionId: string;
  type: "escalation-check";
  alertId: string;
  patientId: string;
  /** 计划的持续阈值到期时刻 */
  dueAt: string;
  status: ScheduledActionStatus;
  /** 执行/取消后记录原因，审计与复诊可见 */
  outcome?: string;
  finishedAt?: string;
}

export interface StoreData {
  schemaVersion: 1;
  /** 全部关联事件（含未达阈值的普通翻身），供复诊回放 */
  events: ObservedEvent[];
  alerts: Record<string, AlertRecord>;
  audit: AuditEvent[];
  scheduled: Record<string, ScheduledAction>;
  silences: SilenceWindow[];
}

export function emptyStoreData(): StoreData {
  return {
    schemaVersion: 1,
    events: [],
    alerts: {},
    audit: [],
    scheduled: {},
    silences: [],
  };
}
