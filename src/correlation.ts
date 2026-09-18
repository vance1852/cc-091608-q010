/**
 * 候选关联与质量标注。
 *
 * - 将时间接近（落在照护计划 correlationWindowSeconds 观察窗口内）的腕部运动
 *   与心率变化归为同一候选簇；持续出现的高分行列式为高严重度事件。
 * - 设备脱落（worn=false）与低质量区间（qualityFlags 非空）如实标注在簇上，
 *   不静默丢弃——降级数据不能伪装成"没事"，也不能伪装成可靠发作证据。
 */
import type { CorrelatedCluster, CandidateQuality } from "./domain.js";
import type { SensorCandidate } from "./contracts.js";
import { toMs } from "./time.js";

/** 单候选的严重度判定输入（阈值由医生签署的计划之外的临床常量给出，此处为保守默认） */
export interface SeverityThresholds {
  /** 运动评分达到该值视为强烈运动 */
  strongMotion: number;
  /** 心率增量达到该值视为显著心率变化 */
  strongHeartRateDelta: number;
}

export const DEFAULT_THRESHOLDS: SeverityThresholds = {
  strongMotion: 0.8,
  strongHeartRateDelta: 20,
};

function candidateQuality(c: SensorCandidate): CandidateQuality {
  if (!c.worn) return "device-off";
  if (c.qualityFlags.length > 0) return "low-quality";
  return "usable";
}

/**
 * 把候选按时间排序后，用计划的观察窗口做会话式聚类：
 * 相邻候选间隔 <= correlationWindowSeconds 即归入同一簇。
 * 同一患者分别聚类。
 */
export function correlateCandidates(
  candidates: SensorCandidate[],
  correlationWindowSeconds: number,
): CorrelatedCluster[] {
  const byPatient = new Map<string, SensorCandidate[]>();
  for (const c of candidates) {
    const list = byPatient.get(c.patientId) ?? [];
    list.push(c);
    byPatient.set(c.patientId, list);
  }

  const clusters: CorrelatedCluster[] = [];
  const gapMs = correlationWindowSeconds * 1000;

  for (const [patientId, list] of byPatient) {
    const sorted = [...list].sort((a, b) => toMs(a.capturedAt) - toMs(b.capturedAt));

    let current: SensorCandidate[] = [];
    const flush = (): void => {
      if (current.length === 0) return;
      clusters.push(buildCluster(patientId, current));
      current = [];
    };

    for (const c of sorted) {
      const prev = current[current.length - 1];
      if (prev && toMs(c.capturedAt) - toMs(prev.capturedAt) > gapMs) {
        flush();
      }
      current.push(c);
    }
    flush();
  }

  return clusters.sort((a, b) => toMs(a.startedAt) - toMs(b.startedAt));
}

function buildCluster(patientId: string, members: SensorCandidate[]): CorrelatedCluster {
  const reasons = new Set<string>();
  let quality: CandidateQuality = "usable";

  for (const m of members) {
    const q = candidateQuality(m);
    if (q === "device-off") {
      quality = "device-off";
      reasons.add(`device-off@${m.capturedAt}`);
    } else if (q === "low-quality") {
      // 脱落比低质量更严重，不覆盖已有标注
      if (quality !== "device-off") quality = "low-quality";
      for (const f of m.qualityFlags) reasons.add(`${f}@${m.capturedAt}`);
    }
  }

  const first = members[0]!;
  const last = members[members.length - 1]!;
  return {
    clusterId: `cluster-${first.candidateId}`,
    patientId,
    startedAt: first.capturedAt,
    endedAt: last.capturedAt,
    candidateIds: members.map((m) => m.candidateId),
    peakMotionScore: Math.max(...members.map((m) => m.motionScore)),
    maxHeartRateDelta: Math.max(...members.map((m) => m.heartRateDelta)),
    quality,
    qualityReasons: [...reasons].sort(),
  };
}

/**
 * 严重度判定（决定簇是否成为告警）：
 * - 簇内至少一个候选同时满足强运动 + 显著心率变化 → high
 * - 仅单一信号突出 → ordinary（仍发普通通知）
 * - 两者都不突出 → none：普通翻身，在此关闭，不进入告警流程
 *   （这正是"普通翻身怎样被关闭"：运动与心率必须互相印证）
 * 降级数据不参与强信号判定，由调用方按技术告警单独处理。
 */
export function classifyCluster(
  cluster: CorrelatedCluster,
  candidatesById: Map<string, SensorCandidate>,
  thresholds: SeverityThresholds = DEFAULT_THRESHOLDS,
): "none" | "ordinary" | "high" {
  let strongBoth = false;
  let strongEither = false;
  for (const id of cluster.candidateIds) {
    const c = candidatesById.get(id);
    if (!c || !c.worn || c.qualityFlags.length > 0) continue;
    const motion = c.motionScore >= thresholds.strongMotion;
    const hr = c.heartRateDelta >= thresholds.strongHeartRateDelta;
    if (motion && hr) strongBoth = true;
    if (motion || hr) strongEither = true;
  }
  if (strongBoth) return "high";
  if (strongEither) return "ordinary";
  return "none";
}
