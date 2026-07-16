---
id: wire-demo-beat
title: 配一个信号驱动拍子(动哪5处)
domain: content
type: recipe
summary: 给寻狗 demo 接一拍主线/支线内容,最少动 5 处(场景/对话图/叙事子图/主图/引用素材);含 scenarios.json 撞名坑与各层纪律
status: active
authority:
  - public/assets/data/narrative_graphs.json
  - public/assets/data/quests.json
  - src/core/NarrativeStateManager.ts
verified_by:
  - src/core/XungouMainFlowIntegration.test.ts
triggers:
  paths: ["public/assets/data/narrative_graphs.json", "public/assets/data/quests.json", "public/assets/data/scenarios.json"]
  topics: [拍子, beat, 叙事编排, 信号驱动, flow_xungou_main, scenario子图]
  tasks: [加主线拍, 加支线, 接叙事流程, 配任务]
last_governed: 2026-07-11
---

**实测环境与日期**:2026-07-02 由 3 个 agent 交叉核对 + 运行时亲验(demo 编排盘点);2026-07-11 复核关键锚点(flow_xungou_main / xungou_demo_main / 集成测试)仍在。

运行时 5 层脊椎模型(世界→对话→scenario 子图→主线主图→quest 镜像)见 **runtime 域**的叙事编排机制卡,此处只给内容侧操作面。

## 5 处改动(4 文件 / 4 编辑器面板)

1. **场景**:画 zone + `conditions` 读 narrative 状态当门闸 + `onEnter` 挂 `startDialogueGraph`
   (hotspot inspect 用 `data.graphId`;npc 用 `dialogueGraphId`)。
2. **图对话**:编 line/choice + switch 节点读 `{narrative:子图, state:末态, reached}` 做
   **防重入守卫** + runActions 里 `emitNarrativeSignal`。
3. **叙事状态机·子图**:建 `scenario_XXX`(ownerType=scenario)states + 信号 transition;
   演出/发钱/发物放各 state 的 `onEnterActions`;末态设 `exitStates` + `broadcastOnEnter`
   (自动广播派生信号 `state:<图id>:<末态>`)。
4. **叙事状态机·主图**:在 `flow_xungou_main` 加一条 `state:子图:末态` transition 接进脊椎。
   **挂进主线监听=主线拍;不挂=可选支线**(跑完主线不动)。quest 镜像按 `xgNN` 范式对
   `completionConditions` 读主图 state。
5. **补齐被引用的 item/overlay/signal_cue 等**,跑双校验门(见
   [content-validation-gate](content-validation-gate.md))。

## 各层纪律(违反=脊椎坏死)

- 对话/动作层只**"演 + 打信号"**,绝不碰存档/换场景/setFlag——推进全靠 `emitNarrativeSignal`。
- 子图 `initialState` 的 `onEnterActions` 不执行;禁在数据里用 `setNarrativeState` 硬跳。
- 多路汇聚用 `reactiveAll/reactiveAny` 读别的 wrapper 图状态。
- 主图是**唯一进度真相源**;quests.json 是纯镜像不驱动。

## 已知坑

- **scenarios.json ≠ narrative 的 scenario_ 子图**:撞名但是两套东西、id 无交集。
  scenarios.json(ScenarioStateManager)只剩少量遗留条目,寻狗主线**不用它**——每拍的
  `scenario_背尸/scenario_枯井…` 全是 narrative 子图,别把活儿写进 Scenarios 面板。
- narrative **无内建 exposes**:要把状态暴露成通用 flag,只能在 state 的 `onEnterActions`
  里 setFlag(scenario 清单才有 exposes)。
- composition id 是 `xungou_demo_main`,mainGraph.id 才是 `flow_xungou_main`,引用别拿错。
