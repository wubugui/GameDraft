---
id: scenario-catalog-semantics
title: scenarios.json 运行时消费语义(退役中)
domain: runtime
type: mechanism
summary: 一等公民 scenario 已数据侧退役、零数据喂养;新内容一律走 narrative scenario_* 子图,别把活儿写进 Scenarios 面板
status: active
authority:
  - src/core/ScenarioStateManager.ts
  - public/assets/data/scenarios.json
triggers:
  paths: ["public/assets/data/scenarios.json", "src/core/ScenarioStateManager.ts"]
  topics: [scenario, 剧本清单, phase, exposes, 退役]
last_governed: 2026-08-05
---

## 是什么(一句话)

`scenarios.json` 一等公民 scenario 系统的现状:**stage-1 已数据侧退役**(数据清空、遗留线迁入
narrative 子图),运行时代码仍在但零数据喂养,stage-2 代码删除待做
(拍板见 [decision 卡](../decisions/2026-07-15-scenario-firstclass-retirement.md))。

## 权威源(读代码从哪进)

`src/core/ScenarioStateManager.ts`——判断某字段到底有没有消费方,只以它为准,不以文档或编辑器表单为准。

## 硬契约(违反即 bug)

- **新的拍子编排一律走 narrative `scenario_*` 子图**,不要往 scenarios.json / Scenarios 面板加内容。
- catalog 里 per-phase 的默认 `status` 与 `outcome` 是**惰性摆设**:从不播种进初始状态,
  未被动作写过一律按 `pending` 比较。若哪天要复活这套,别指望在数据里配默认值。
- 老存档的 scenario 进度失联**不做迁移**(已拍板)。

## 已知坑

- **scenarios.json ≠ narrative 的 `scenario_*` 子图**:名字像,实为两套、id 无交集
  (见 [narrative-signal-spine](narrative-signal-spine.md))。
- **narrative 无内建 exposes**:要把叙事状态暴露成通用 flag 只能在 state 的 onEnterActions 里 setFlag。

## 怎么验证

开局读快照确认 catalog status 未播种;`scenarios.json` 应保持为空。
