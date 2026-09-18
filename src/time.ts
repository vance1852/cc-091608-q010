/**
 * 时间工具。核心服务只依赖 Clock 抽象，回放时可注入虚拟时钟；
 * 所有时刻在内部均以 epoch 毫秒数计算，展示时回到 ISO 字符串。
 */
export interface Clock {
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** 测试 / 回放用：外部拨片推进的时钟 */
export class FakeClock implements Clock {
  private current: number;

  constructor(start: Date | string | number) {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceTo(t: Date | string | number): void {
    const ms = new Date(t).getTime();
    if (ms < this.current) {
      throw new Error(`FakeClock 不能回拨：${new Date(ms).toISOString()} 早于 ${new Date(this.current).toISOString()}`);
    }
    this.current = ms;
  }

  advanceSeconds(seconds: number): void {
    this.current += seconds * 1000;
  }
}

export function toMs(t: Date | string | number): number {
  return new Date(t).getTime();
}

export function iso(t: Date | string | number): string {
  return new Date(t).toISOString();
}

export function addSeconds(t: Date | string | number, seconds: number): Date {
  return new Date(toMs(t) + seconds * 1000);
}

/** 半开区间 [from, until)：静音窗的 from/until 按此判定 */
export function withinWindow(
  t: Date | string | number,
  from: Date | string | number,
  until: Date | string | number,
): boolean {
  const ms = toMs(t);
  return ms >= toMs(from) && ms < toMs(until);
}

/** 严重度排序：ordinary < high，静音窗只压低 <= maximumSeverity 的通知 */
export function severityRank(s: "ordinary" | "high"): number {
  return s === "ordinary" ? 0 : 1;
}
