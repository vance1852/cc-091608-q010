// 照护计划版本管理。
// 只有临床角色能签署版本；家庭只能提交误报反馈与调整申请，
// 申请在医生批准前不会影响任何生效中的临床规则。

import type {
  AdjustablePlanField,
  CarePlanVersion,
  PlanAdjustmentRequest,
  SignedPlanInput,
} from "./contracts.ts";

export type Role = "clinician" | "guardian";

export interface FamilyFeedback {
  feedbackId: string;
  patientId: string;
  alertId: string;
  guardianId: string;
  /** 是否认为该告警是误报（普通翻身等） */
  falseAlarm: boolean;
  comment: string;
  createdAt: string;
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class PlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

const ADJUSTABLE_FIELDS: readonly AdjustablePlanField[] = [
  "correlationWindowSeconds",
  "escalationAfterSeconds",
  "motionThreshold",
  "heartRateDeltaThreshold",
];

export function assertClinician(role: Role): void {
  if (role !== "clinician") {
    throw new AuthorizationError(
      "只有值班/复诊医生可以签署或修改照护计划；家庭只能提交调整申请。",
    );
  }
}

function validatePlan(input: SignedPlanInput): void {
  if (input.effectiveFrom >= input.effectiveUntil) {
    throw new PlanValidationError("计划有效期必须满足 from < until。");
  }
  if (input.correlationWindowSeconds <= 0) {
    throw new PlanValidationError("观察窗口必须为正数。");
  }
  if (input.escalationAfterSeconds <= 0) {
    throw new PlanValidationError("持续阈值（升级秒数）必须为正数。");
  }
  if (input.familyQuestions.length === 0) {
    throw new PlanValidationError("每版计划必须写明复诊家庭询问。");
  }
  if (input.emergencyContacts.length === 0) {
    throw new PlanValidationError("每版计划必须至少有一位紧急联系人。");
  }
  for (const contact of input.emergencyContacts) {
    if (!contact.name || !contact.phone) {
      throw new PlanValidationError("紧急联系人必须包含姓名与电话。");
    }
  }
  if (input.motionThreshold < 0 || input.motionThreshold > 1) {
    throw new PlanValidationError("腕部异常阈值应在 [0,1]。");
  }
  if (input.heartRateDeltaThreshold <= 0) {
    throw new PlanValidationError("心率变化阈值必须为正数。");
  }
}

export class PlanRegistry {
  /** planId -> 按版本号升序的已签署版本 */
  private readonly versions = new Map<string, CarePlanVersion[]>();
  private readonly adjustments = new Map<string, PlanAdjustmentRequest>();
  private readonly feedback: FamilyFeedback[] = [];

  /**
   * 医生签署新版本。版本号单调递增；旧版本保留用于审计，不就地修改。
   * 允许同一 planId 的新版本与旧版本有效期重叠（复诊时提前签署下一版），
   * activePlanAt 按“起点最晚且覆盖该时刻”的规则选择。
   */
  signPlan(input: SignedPlanInput, role: Role, signedAt: string): CarePlanVersion {
    assertClinician(role);
    validatePlan(input);
    const history = this.versions.get(input.planId) ?? [];
    const version = history.length === 0 ? 1 : history[history.length - 1]!.version + 1;
    const signed: CarePlanVersion = { ...input, version, signedAt };
    history.push(signed);
    this.versions.set(input.planId, history);
    return signed;
  }

  getPlan(planId: string, version: number): CarePlanVersion | undefined {
    return this.versions.get(planId)?.find((p) => p.version === version);
  }

  listVersions(planId: string): CarePlanVersion[] {
    return [...(this.versions.get(planId) ?? [])];
  }

  /** 返回某时刻对患者生效的计划版本（有效期覆盖该时刻，取最新版本） */
  activePlanAt(patientId: string, at: Date): CarePlanVersion | undefined {
    const t = at.getTime();
    let active: CarePlanVersion | undefined;
    for (const history of this.versions.values()) {
      for (const plan of history) {
        if (plan.patientId !== patientId) continue;
        if (
          new Date(plan.effectiveFrom).getTime() <= t &&
          t < new Date(plan.effectiveUntil).getTime()
        ) {
          if (!active || plan.version > active.version) active = plan;
        }
      }
    }
    return active;
  }

  /**
   * 家庭提交误报反馈。任何角色都可以提交，但反馈永远不直接改写计划。
   */
  submitFeedback(
    record: Omit<FamilyFeedback, "createdAt"> & { createdAt?: string },
  ): FamilyFeedback {
    const saved: FamilyFeedback = {
      ...record,
      createdAt: record.createdAt ?? new Date().toISOString(),
    };
    this.feedback.push(saved);
    return saved;
  }

  listFeedback(patientId?: string): FamilyFeedback[] {
    return this.feedback.filter((f) => !patientId || f.patientId === patientId);
  }

  /**
   * 家庭申请调整。只能提议白名单字段；不触碰生效中的版本。
   */
  requestAdjustment(
    req: Omit<
      PlanAdjustmentRequest,
      "status" | "decidedBy" | "decidedAt" | "signedVersion" | "decisionNote"
    >,
  ): PlanAdjustmentRequest {
    const proposedKeys = Object.keys(req.proposed) as AdjustablePlanField[];
    for (const key of proposedKeys) {
      if (!ADJUSTABLE_FIELDS.includes(key)) {
        throw new PlanValidationError(`字段 ${key} 不允许由家庭申请调整。`);
      }
      if (typeof req.proposed[key] !== "number" || Number.isNaN(req.proposed[key])) {
        throw new PlanValidationError(`字段 ${key} 的建议值必须是数字。`);
      }
    }
    const saved: PlanAdjustmentRequest = { ...req, status: "pending" };
    this.adjustments.set(saved.requestId, saved);
    return saved;
  }

  getAdjustment(requestId: string): PlanAdjustmentRequest | undefined {
    return this.adjustments.get(requestId);
  }

  listAdjustments(patientId?: string): PlanAdjustmentRequest[] {
    return [...this.adjustments.values()].filter(
      (r) => !patientId || r.patientId === patientId,
    );
  }

  /** 医生批准申请：随后仍须正常签署新版本，申请记录与新版本互相留痕 */
  approveAdjustment(
    requestId: string,
    clinicianId: string,
    role: Role,
    decidedAt: string,
    signedVersion: number,
    note?: string,
  ): PlanAdjustmentRequest {
    assertClinician(role);
    const req = this.adjustments.get(requestId);
    if (!req) throw new PlanValidationError("调整申请不存在。");
    if (req.status !== "pending") {
      throw new PlanValidationError(`申请已是 ${req.status} 状态，不能重复处理。`);
    }
    const updated: PlanAdjustmentRequest = {
      ...req,
      status: "approved",
      decidedBy: clinicianId,
      decidedAt,
      signedVersion,
      ...(note !== undefined ? { decisionNote: note } : {}),
    };
    this.adjustments.set(requestId, updated);
    return updated;
  }

  rejectAdjustment(
    requestId: string,
    clinicianId: string,
    role: Role,
    decidedAt: string,
    note: string,
  ): PlanAdjustmentRequest {
    assertClinician(role);
    const req = this.adjustments.get(requestId);
    if (!req) throw new PlanValidationError("调整申请不存在。");
    if (req.status !== "pending") {
      throw new PlanValidationError(`申请已是 ${req.status} 状态，不能重复处理。`);
    }
    const updated: PlanAdjustmentRequest = {
      ...req,
      status: "rejected",
      decidedBy: clinicianId,
      decidedAt,
      decisionNote: note,
    };
    this.adjustments.set(requestId, updated);
    return updated;
  }

  /** 重启/装载历史用：直接放入已存在记录，不做角色判定 */
  hydrate(
    plans: CarePlanVersion[],
    adjustments: PlanAdjustmentRequest[],
    feedback: FamilyFeedback[],
  ): void {
    for (const plan of plans) {
      const history = this.versions.get(plan.planId) ?? [];
      if (!history.some((p) => p.version === plan.version)) history.push(plan);
      history.sort((a, b) => a.version - b.version);
      this.versions.set(plan.planId, history);
    }
    for (const adj of adjustments) this.adjustments.set(adj.requestId, adj);
    this.feedback.push(...feedback);
  }

  snapshot(): {
    plans: CarePlanVersion[];
    adjustments: PlanAdjustmentRequest[];
    feedback: FamilyFeedback[];
  } {
    return {
      plans: [...this.versions.values()].flat(),
      adjustments: [...this.adjustments.values()],
      feedback: [...this.feedback],
    };
  }
}
