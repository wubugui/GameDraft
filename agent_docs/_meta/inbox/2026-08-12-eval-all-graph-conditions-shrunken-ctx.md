---
target: runtime-norms
date: 2026-08-12
session: 日夜循环系统落地
---

现象: runtime-norms 律8 要求「条件经统一求值器与**唯一上下文工厂**，禁止任何模块手工拼装缩水版上下文」，但 `evaluateGraphCondition.ts` 自己导出的 `evaluateAllGraphConditions(conds, flagStore, questManager, scenarioState)` 就地拼了一个只有三件套的 ctx——用它求值的条件里，plane / posture / narrative / timePhase 全部叶子静默失效（plane 按 'normal'、其余恒假）。
证据: `src/systems/graphDialogue/evaluateGraphCondition.ts:591-600`（函数体内 `const ctx: ConditionEvalContext = { flagStore, questManager, scenarioState };`）。本次接 NPC 日程时差点误用它，改走 `Game.buildConditionEvalContext()` + 逐条 `evaluateConditionExpr` 才对。
建议: 要么把它标 `@deprecated` 并列出「只在无位面/无姿态语境下可用」，要么让它收一个 ctx 参数；另可考虑在 norms 律8 补一句「导出的便捷包装函数同样受此约束」。
