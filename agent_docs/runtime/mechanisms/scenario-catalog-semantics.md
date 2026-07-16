---
id: scenario-catalog-semantics
title: scenarios.json 运行时消费语义
domain: runtime
type: mechanism
summary: catalog 里 phase 的默认 status 与 outcome 是惰性摆设,真被消费的只有 requires/exposes/manualLineLifecycle/dialogueGraphIds
status: active
authority:
  - src/core/ScenarioStateManager.ts
  - public/assets/data/scenarios.json
triggers:
  paths: ["public/assets/data/scenarios.json", "src/core/ScenarioStateManager.ts"]
  topics: [scenario, 剧本清单, phase, exposes]
last_governed: 2026-07-11
---

> **退役中(2026-07-13 用户拍板,见 [decision 卡](../decisions/2026-07-15-scenario-firstclass-retirement.md))**:一等公民 scenario 系统已数据侧退役——`scenarios.json` 清空为 `{"scenarios": []}`,码头两条遗留线(码头水鬼/外国人捞箱子,25 消费点)已迁入 narrative `scenario_*` 子图。运行时代码(`ScenarioStateManager` / `scenario`+`scenarioLine` 条件叶 / 四个 scenario 动作 / Scenarios 面板)仍在,但**零数据喂养**;代码删除为 stage-2 待办(届时 6→4 条件叶为 approval①)。本卡描述的消费语义仍是代码现实(未删),但已无数据触发;下方"码头两条遗留在用"等案例段落作废。老存档 scenario 进度失联按实体改名先例不做迁移。

## 是什么(一句话)

`scenarios.json`(ScenarioCatalogEntry)各字段在运行时的真实消费情况——以 `ScenarioStateManager.ts` 为准,不以文档/编辑器表单为准。

## 权威源(读代码从哪进)

`src/core/ScenarioStateManager.ts` 的 configureRuntime / phaseStatusEquals / tryApplyExposes。

## 硬契约(违反即 bug)

- **per-phase `status` 惰性**:configureRuntime 从不把 catalog status 播种进初始状态;未被 `setScenarioPhase` 写过的 phase 条件比较一律按 `pending`。把默认 status 配成 active/done 开局无效——初始推进只能用动作 `setScenarioPhase`。
- **per-phase `outcome` 当前无消费方**:运行时 outcome 只在 setScenarioPhase payload 写入;catalog 里的没人读(scenario 条件叶子可按 outcome 比较,但前提是运行时写过)。
- **真被消费的字段**:per-phase `requires`(推进时校验)、`exposes`+`exposeAfterPhase`(phase 变 done 时写全局 flag)、进线 `requires`、`manualLineLifecycle`、`dialogueGraphIds`。

## 已知坑

- **scenarios.json ≠ narrative 的 scenario_ 子图**:两套东西、id 无交集。寻狗主线的拍子状态机全是 narrative 子图(见 [narrative-signal-spine](narrative-signal-spine.md)),别把活儿写进 Scenarios 面板;scenarios.json 现已清空(码头两线 2026-07-13 迁 narrative,一等公民退役),新内容一律走 narrative 子图。
- narrative 无内建 exposes——要把叙事状态暴露成通用 flag 只能在 state.onEnterActions 里 setFlag;scenario 才有 exposes。

## 怎么验证

命令通道 `debugSetScenarioPhase` 推 phase 到 done,读 FlagStore 断言 exposes 落 flag;开局读快照确认 catalog status 未播种。
