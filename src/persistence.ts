/**
 * 状态持久化：定时动作、告警、计划与审计流水都落在一个 JSON 文件中。
 * 进程重启后用 loadState 重建服务，pendingActions 中尚未执行的动作继续生效。
 */
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import type { ServiceState } from "./domain.js";
import { emptyState } from "./service.js";

export interface StateStore {
  load(): ServiceState;
  save(state: ServiceState): void;
}

export class JsonFileStore implements StateStore {
  constructor(private readonly path: string) {}

  load(): ServiceState {
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as Partial<ServiceState>;
      // 合并默认值，兼容老状态文件缺少新增集合的情况
      return { ...emptyState(), ...parsed };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw err;
    }
  }

  /** 先写临时文件再原子替换，避免重启时读到半截状态 */
  save(state: ServiceState): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, this.path);
  }
}
