// 领域判定：传感器候选 -> 观察事件 -> 严重度。
// 不产生副作用，便于回放与单测。

import type {
  AlertSeverity,
  CarePlanVersion,
  SensorCandidate,
} from "./contracts.ts";

/** 设备未佩戴 / 信号质量问题必须如实标注，不允许静默丢弃 */
export type QualityFlag = "device-off" | "low-quality";

export interface AnnotatedCandidate extends SensorCandidate {
  deviceOff: boolean;
  lowQuality: boolean;
  /** 该候选是否达到任一临床异常阈值 */
  abnormal: boolean;
  abnormalSignals: Array<"motion" | "heartRate">;
}

export interface ObservedEvent {
  eventId: string;
  patientId: string;
  startedAt: string;
  endedAt: string;
  /** 持续秒数 */
  durationSeconds: number;
  candidateIds: string[];
  candidates: AnnotatedCandidate[];
  /** 事件内是否出现过设备脱落 / 低质量区间 */
  hadDeviceOff: boolean;
  hadLowQuality: boolean;
  severity: AlertSeverity;
  /** 是否触发持续阈值（相对事件起点） */
  sustained: boolean;
  /** 持续异常的连续异常候选数（相邻候选间隔 <= 观察窗口） */
  abnormalCandidateCount: number;
}

const rank = (s: AlertSeverity): number => (s === "high" ? 1 : 0);
export const higherSeverity = (
  a: AlertSeverity,
  b: AlertSeverity,
): AlertSeverity => (rank(a) >= rank(b) ? a : b);

export function isWithinWindow(a: Date, b: Date, windowSeconds: number): boolean {
  return Math.abs(a.getTime() - b.getTime()) <= windowSeconds * 1000;
}

export function annotate(
  c: SensorCandidate,
  plan: Pick<CarePlanVersion, "motionThreshold" | "heartRateDeltaThreshold">,
): AnnotatedCandidate {
  const quality = new Set(c.qualityFlags);
  const deviceOff = !c.worn || quality.has("device-off");
  const lowQuality = quality.has("low-quality");
  const abnormalSignals: Array<"motion" | "heartRate"> = [];
  if (c.motionScore >= plan.motionThreshold) abnormalSignals.push("motion");
  if (c.heartRateDelta >= plan.heartRateDeltaThreshold)
    abnormalSignals.push("heartRate");
  return {
    ...c,
    deviceOff,
    lowQuality,
    abnormal: abnormalSignals.length > 0,
    abnormalSignals,
  };
}

/**
 * 把时间接近的腕部运动与心率变化关联为候选事件。
 * 相邻候选间隔 <= 观察窗口则归并为同一事件（按时序）。
 */
export function correlateCandidates(
  raw: SensorCandidate[],
  plan: CarePlanVersion,
): ObservedEvent[] {
  const ordered = [...raw].sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime(),
  );
  const events: ObservedEvent[] = [];
  let bucket: AnnotatedCandidate[] = [];

  const flush = (): void => {
    if (bucket.length === 0) return;
    const first = bucket[0]!;
    const last = bucket[bucket.length - 1]!;
    const start = new Date(first.capturedAt);
    const end = new Date(last.capturedAt);
    const abnormalMembers = bucket.filter((c) => c.abnormal);
    const bothSignals = abnormalMembers.some(
      (c) => c.abnormalSignals.length >= 2,
    );
    // 高严重度：运动与心率同时异常；普通：只有一路异常
    const severity: AlertSeverity =
      abnormalMembers.length > 0 && bothSignals ? "high" : "ordinary";
    const durationSeconds = Math.round((end.getTime() - start.getTime()) / 1000);
    // 持续：至少两个连续异常候选，且持续时间达到计划的持续阈值
    const sustained =
      abnormalMembers.length >= 2 &&
      durationSeconds >= plan.escalationAfterSeconds;
    events.push({
      eventId: `evt-${first.candidateId}`,
      patientId: first.patientId,
      startedAt: first.capturedAt,
      endedAt: last.capturedAt,
      durationSeconds,
      candidateIds: bucket.map((c) => c.candidateId),
      candidates: bucket,
      hadDeviceOff: bucket.some((c) => c.deviceOff),
      hadLowQuality: bucket.some((c) => c.lowQuality),
      severity,
      sustained,
      abnormalCandidateCount: abnormalMembers.length,
    });
    bucket = [];
  };

  for (const c of ordered) {
    const annotated = annotate(c, plan);
    if (bucket.length > 0) {
      const prev = bucket[bucket.length - 1]!;
      if (
        !isWithinWindow(
          new Date(prev.capturedAt),
          new Date(annotated.capturedAt),
          plan.correlationWindowSeconds,
        )
      ) {
        flush();
      }
    }
    bucket.push(annotated);
  }
  flush();
  return events;
}

/**
 * 持续阈值判定：在给定时刻（通常是“现在”或升级检查时刻），
 * 事件持续异常且距起点已超过计划的 escalationAfterSeconds。
 * 低质量/脱落区间不计入“干净的持续时间”，但事件仍保留并标注。
 */
export function isSustainedAt(
  event: ObservedEvent,
  at: Date,
  plan: Pick<CarePlanVersion, "escalationAfterSeconds">,
): boolean {
  if (event.abnormalCandidateCount < 1) return false;
  const start = new Date(event.startedAt).getTime();
  const elapsed = (at.getTime() - start) / 1000;
  return elapsed >= plan.escalationAfterSeconds;
}
