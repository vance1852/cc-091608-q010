# 儿童夜间发作告警协作

该服务保存患儿照护计划、腕部传感器候选、家庭回执和升级动作，帮助复诊医生看清一夜里：

- 普通翻身、设备脱落、低质量区间如何被如实标注且不打扰家庭；
- 短时静音只压低普通通知，高严重度与持续未响应事件为何仍按计划升级；
- 哪位监护人在何时给出什么回执，首个有效处置如何锁定结果、后来矛盾意见如何保留；
- 据误报统计签署下一版计划。

## 边界与规则

- **医生签署的每版计划**（`src/contracts.ts` 的 `CarePlanVersion`）都必须写明：有效期、观察窗口 `correlationWindowSeconds`、持续阈值 `escalationAfterSeconds`、复诊家庭询问、紧急联系人，以及运动/心率临床阈值。版本不可变，只有 `clinician` 角色能签署；旧版本永久保留用于审计。
- **家庭端**只能提交误报反馈（`submitFeedback`）和调整申请（`requestAdjustment`），申请在医生批准并签署新版前不影响任何生效中的临床规则；可申请字段被限制在白名单内。
- **关联与标注**（`src/domain.ts`）：相邻候选间隔不超过观察窗口即归并为同一事件；运动与心率同时异常为 `high`，仅一路异常为 `ordinary`；`worn=false` 或 `device-off`/`low-quality` 标记如实保留。
- **静音**（`src/engine.ts`）：只压低 `ordinary` 的 `guardian-push` 并留痕（`suppressed` + `suppressReason`）；`high` 通知与所有 `escalation-call` 永不被静音；禁止创建覆盖高严重度的静音窗口。
- **持续升级**：每条告警在“起点 + 持续阈值”安排一次持久化的升级检查；未锁定/未解决即呼叫计划紧急联系人与医院值班。
- **回执锁定**：`false-alarm`/`needs-help` 为终结性回执，首个终结性回执锁定处置；后来回执（含矛盾意见）全部保留在 `laterOpinionIds`。锁定后的 `needs-help` 会保留原锁定并再次升级；已升级告警不能被随后的 `false-alarm` 降级。
- **重启恢复**（`src/service.ts`、`src/store.ts`）：每次状态变更原子落盘；定时动作持久化，重启时先追赶执行到期动作，未到期的继续调度。
- **复诊报告**（`src/report.ts`）：逐条时间线（通知/升级/回执/关闭）+ 误报、静音压低、送达、升级呼叫与数据质量统计。

## 运行

```bash
npm install
npm test      # tsc --noEmit + node:test（19 个用例）
npm run replay  # 回放 fixtures/nocturnal-alerts.json 的完整一夜（含模拟崩溃/重启）
```

领域契约位于 `src/contracts.ts`；`fixtures/nocturnal-alerts.json` 是一晚脱敏的活动与心率序列，包含普通翻身、静音中的普通运动告警、静音中的高严重度持续事件、低质量区间、设备脱落，以及两位监护人相互矛盾的回执。

项目基于 Node.js 22 与 TypeScript（ESM，通过 Node 原生 TS 支持直接运行 `.ts`）。
