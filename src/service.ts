// 夜间告警协作服务：装配计划登记、告警引擎与持久化，
// 并负责重启恢复——尚未执行的定时升级检查在启动时追赶执行，
// 之后按固定间隔继续调度。

import { AlertEngine, type PatientRoster } from "./engine.ts";
import { PlanRegistry } from "./plan.ts";
import { JsonStateStore } from "./store.ts";
import type { ScheduledAction } from "./records.ts";

export interface ServiceHandle {
  registry: PlanRegistry;
  engine: AlertEngine;
  /** 启动/手动追赶：执行所有到期未完成的定时动作（重启恢复入口） */
  catchUp: (now?: Date) => ScheduledAction[];
  pendingCount: () => number;
  stop: () => void;
}

export interface NocturnalServiceOptions {
  statePath: string;
  rosters: Record<string, PatientRoster>;
  /** 实时模式下的轮询间隔（毫秒）；回放/测试可设 0 关闭定时调度 */
  tickIntervalMs?: number;
  now?: () => Date;
}

export function createNocturnalService(
  options: NocturnalServiceOptions,
): ServiceHandle {
  const jsonStore = new JsonStateStore(options.statePath);
  // 文件不存在 = 首次启动；其他读取/解析错误必须抛出，不能静默清空医疗数据
  const persisted = jsonStore.load();

  const registry = new PlanRegistry();
  registry.hydrate(
    persisted.plans,
    persisted.adjustments,
    persisted.feedback,
  );

  const save = (): void => {
    const snap = registry.snapshot();
    jsonStore.save({
      plans: snap.plans,
      adjustments: snap.adjustments,
      feedback: snap.feedback,
      store: persisted.store,
    });
  };

  const engine = new AlertEngine(
    registry,
    persisted.store,
    options.rosters,
    save,
  );

  const clock = options.now ?? (() => new Date());

  // 重启恢复：启动即追赶一次，到期的升级检查照常执行
  engine.runDue(clock());

  let timer: NodeJS.Timeout | undefined;
  const interval = options.tickIntervalMs ?? 15_000;
  if (interval > 0) {
    timer = setInterval(() => engine.runDue(clock()), interval);
  }

  return {
    registry,
    engine,
    catchUp: (now = clock()) => engine.runDue(now),
    pendingCount: () =>
      Object.values(persisted.store.scheduled).filter((a) => a.status === "pending")
        .length,
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
