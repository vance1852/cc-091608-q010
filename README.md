# 儿童夜间发作告警协作

该项目保存患儿照护计划、腕部传感器候选、家庭回执和升级动作。医疗计划与家庭偏好分别版本化，普通静音不会改变临床规则。

领域契约位于 `src/contracts.ts`。`fixtures/nocturnal-alerts.json` 是一晚脱敏的活动与心率摘要，包含普通翻身、短时静音和持续异常活动。

项目基于 Node.js 22 与 TypeScript，安装依赖后可通过 `npm test` 检查类型定义。
