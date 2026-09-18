# 儿童夜间发作告警协作

该服务保存患儿照护计划、腕部传感器候选、家庭回执与升级动作，并围绕四条临床边界构建：

1. **普通翻身怎样被关闭** —— 候选按医生签署计划的 `correlationWindowSeconds` 会话式聚类，
   只有当同一簇内存在「强腕部运动 **且** 显著心率升高」的候选才判 `high`；仅单一信号突出为
   `ordinary`；运动与心率互不印证（如 fixture 中的 `turn-1`）直接关闭，不产生告警。
2. **静音与升级的边界** —— 家庭可设短时静音窗（`SilenceWindow`），但入口强制
   `maximumSeverity: "ordinary"`：静音只压低普通通知。`high` 通知任何时刻照常推送；
   持续事件到达计划的 `escalationAfterSeconds` 仍无有效处置时，按
   primary → secondary → clinic-oncall 顺序电话升级（主联系人未接通自动顺延，全失败则 60s 重试）。
3. **首个有效处置锁定 + 矛盾意见保留** —— `observing` 是过程意见不锁定；首个
   `false-alarm` / `needs-help` 锁定结果并取消未执行升级；锁定后到达的矛盾回执进入
   `outcome.superseded`。若升级电话已打出，状态保留 `escalated`，同时记录家庭处置，
   「曾经升级」的事实不会被回执抹掉。
4. **家庭不能改临床规则** —— 每版计划（有效期、观察窗口、家庭询问、持续阈值、紧急联系人、
   监护人）只能由医生签署新版本产生，版本只追加、有效期不重叠且签署即冻结；家庭的入口是
   误报反馈（`submitFalseAlarmFeedback`）与调整申请（`requestAdjustment`），
   批准也必须由医生当场签署下一版计划（`reviewAdjustment(..., "approved", ...)`）。

设备脱落（`worn: false`）与低质量区间（`qualityFlags` 非空）如实标注在簇与告警上：
降级数据只产生 `ordinary` 技术告警提醒检查佩戴，不安排临床升级；同簇后续若出现可靠强信号，
告警自动提升为临床告警并补排升级，事件不会被早先的技术状态吞掉。

## 文件

| 文件 | 职责 |
| --- | --- |
| `src/contracts.ts` | 给定边界：计划、候选、回执、静音窗（未改动） |
| `src/domain.ts` | 扩展领域模型：签署计划、关联簇、告警生命周期、反馈/申请、持久化状态 |
| `src/time.ts` | `Clock` 抽象（真实时钟 / 回放拨片时钟）、时间工具 |
| `src/correlation.ts` | 候选会话式聚类、质量标注、翻身 vs 异常的严重度判定 |
| `src/service.ts` | 核心：计划签署、静音、通知、定时升级、回执锁定、反馈/申请、夜间统计 |
| `src/persistence.ts` | JSON 文件原子读写（临时文件 + rename），重启恢复 |
| `src/scheduler.ts` | 常驻定时执行到点动作并落盘 |
| `src/replay.ts` | `fixtures/nocturnal-alerts.json` 完整流程回放（含无处置反事实 + 重启续跑） |
| `src/service.test.ts` | 28 个测试，覆盖全部边界 |

## 使用

```bash
npm install
npm test        # 类型检查 + node:test 全部用例
npm run replay  # 回放一晚：计划 → 静音 → 候选 → 回执锁定 → 反事实升级 → 统计 → v2
```

核心 API（完整导出见 `src/index.ts`）：

```ts
// 医生签署每版计划（有效期、观察窗口、家庭询问、持续阈值、紧急联系人齐备）
service.signCarePlan({ …, signedBy: "dr-li" });

// 家庭：设静音（只准 ordinary）、回执、误报反馈、申请调整
service.setSilenceWindow({ …, maximumSeverity: "ordinary" });
service.acknowledge({ alertId, guardianId, response });
service.submitFalseAlarmFeedback({ … });
service.requestAdjustment({ …, proposed: { escalationAfterSeconds: 420 } });

// 传感器候选摄入（无生效计划拒绝解释信号）
await service.ingestCandidate(candidate);

// 重启续跑：落盘 → 新进程加载 → 执行到期动作
store.save(service.getSnapshot());
const restored = new NocturnalAlertService(new SystemClock(), gateway, store.load());
await restored.runDueActions();

// 复诊：审计时间线（谁在何时做了什么）与误报统计
service.timeline(patientId);
service.nightlyStats(patientId, from, until);
```

设备脱落/低质量候选与普通候选走同一摄入路径，在簇上以 `quality` / `qualityReasons`
标注；夜间统计的 `degradedCandidates` 如实计入降级样本数。
