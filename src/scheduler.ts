/**
 * 常驻调度：周期性执行到点动作并在动作触发后落盘。
 *
 * 重启续跑不依赖本进程：命令侧在产生定时动作后应自行 save 一次；
 * 新进程用持久化状态构造服务并 startScheduler，未执行的动作会被继续执行。
 */
import type { NocturnalAlertService } from "./service.js";
import type { StateStore } from "./persistence.js";
import type { ScheduledAction } from "./domain.js";

export interface SchedulerHandle {
  /** 立即执行一次到期检查（测试与关停前用） */
  tick(now?: Date | string): Promise<ScheduledAction[]>;
  /** 停止定时器 */
  stop(): void;
}

export interface StartSchedulerOptions {
  intervalMs?: number;
  /** 每次触发动作后回调（例如额外写日志）；状态落盘由 store 完成 */
  onFired?: (actions: ScheduledAction[]) => void;
  onError?: (err: unknown) => void;
}

export function startScheduler(
  service: NocturnalAlertService,
  store?: StateStore,
  options: StartSchedulerOptions = {},
): SchedulerHandle {
  const intervalMs = options.intervalMs ?? 1_000;

  const tick = async (now?: Date | string): Promise<ScheduledAction[]> => {
    const fired = await service.runDueActions(now);
    if (fired.length > 0) {
      store?.save(service.getSnapshot());
      options.onFired?.(fired);
    }
    return fired;
  };

  const timer = setInterval(() => {
    tick().catch(options.onError ?? ((err) => console.error("scheduler tick failed:", err)));
  }, intervalMs);
  // 不阻止进程退出
  timer.unref?.();

  return {
    tick,
    stop: () => clearInterval(timer),
  };
}
