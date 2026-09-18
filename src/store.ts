// 持久化：JSON 文件。
// 每次状态变更都原子落盘（临时文件 + rename），保证重启后：
//   1. 已签署计划、家庭申请、误报反馈不丢；
//   2. 尚未执行的定时动作（持续阈值检查）仍在并会继续执行。

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type {
  CarePlanVersion,
  PlanAdjustmentRequest,
} from "./contracts.ts";
import type { FamilyFeedback } from "./plan.ts";
import { emptyStoreData, type StoreData } from "./records.ts";

export interface PersistedState {
  plans: CarePlanVersion[];
  adjustments: PlanAdjustmentRequest[];
  feedback: FamilyFeedback[];
  store: StoreData;
}

export function emptyPersistedState(): PersistedState {
  return {
    plans: [],
    adjustments: [],
    feedback: [],
    store: emptyStoreData(),
  };
}

export class JsonStateStore {
  constructor(private readonly filePath: string) {}

  load(): PersistedState {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      return {
        plans: parsed.plans ?? [],
        adjustments: parsed.adjustments ?? [],
        feedback: parsed.feedback ?? [],
        store: { ...emptyStoreData(), ...(parsed.store ?? {}) },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyPersistedState();
      }
      throw err;
    }
  }

  save(state: PersistedState): void {
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, this.filePath);
  }
}
