/**
 * 夜间发作告警协作服务 —— 公共入口。
 */
export * from "./contracts.js";
export * from "./domain.js";
export {
  NocturnalAlertService,
  InMemoryGateway,
  emptyState,
  type NotifyGateway,
  type OutboundMessage,
  type SignPlanInput,
} from "./service.js";
export { SystemClock, FakeClock, type Clock } from "./time.js";
export { correlateCandidates, classifyCluster, DEFAULT_THRESHOLDS } from "./correlation.js";
export type { SeverityThresholds } from "./correlation.js";
export { JsonFileStore, type StateStore } from "./persistence.js";
export { startScheduler, type SchedulerHandle, type StartSchedulerOptions } from "./scheduler.js";
export { loadFixture, replayNight, nightPlanInput } from "./replay.js";
