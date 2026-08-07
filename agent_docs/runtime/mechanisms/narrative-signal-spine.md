---
id: narrative-signal-spine
title: 信号驱动 5 层编排脊椎
domain: runtime
type: mechanism
summary: 世界→对话(只演+打信号)→scenario子图→主线里程碑图→quest纯镜像;主线叙事图是唯一进度真相源
status: active
authority:
  - src/core/NarrativeStateManager.ts
  - src/systems/QuestManager.ts
  - public/assets/data/narrative_graphs.json
  - public/assets/data/quests.json
triggers:
  paths: ["src/core/NarrativeStateManager.ts", "public/assets/data/narrative_graphs.json", "public/assets/data/quests.json", "public/assets/dialogues/graphs/**"]
  topics: [叙事编排, 信号, emitNarrativeSignal, 主线, 任务镜像, reactive 迁移]
verified_by:
  - src/core/XungouMainFlowIntegration.test.ts
last_governed: 2026-08-05
---

## 是什么(一句话)

事件/任务编排的运行时模型:5 层各司其职、层间只靠信号与状态派生耦合;做内容或理解流程先认这套。

## 权威源(读代码从哪进)

`NarrativeStateManager.ts`(状态机 / 信号队列排空 / reactive 重评 / broadcastOnEnter)、
`QuestManager.ts`(镜像)、规格测试 `XungouMainFlowIntegration.test.ts`;数据在 narrative_graphs.json / quests.json。

## 硬契约(违反即 bug)

1. **世界层**(zone/hotspot/npc):玩家动手;zone.onEnter 挂 startDialogueGraph,`conditions` 读 narrative 状态当门闸。
2. **对话/动作层**:只"演 + 打信号"(`emitNarrativeSignal` 是第一主导动词),**绝不碰存档/换场景/setFlag 推进度**;防重入用 switch 节点读 `{narrative, state, reached}`。
3. **拍子状态机层**(narrative 的 scenario_* 子图):消费信号沿 states 走;演出/发钱/发物放 state 的 `onEnterActions`(**initialState 的不执行**;禁 setNarrativeState);末态开 `broadcastOnEnter` 自动广播派生信号 `state:<图id>:<末态>`;多路汇聚用 reactiveAll/reactiveAny。
4. **主线脊椎层**(主图纯里程碑 state):transition 全靠监听子图末态派生信号线性推进,**唯一进度真相源**。挂进主线监听 = 主线拍,不挂 = 可选支线。
5. **任务清单层**(quests.json):纯镜像不驱动,completionConditions 用 narrative 叶子 `reached:true`,零 setFlag。

## 已知坑

- **同一信号到达多张图的先后无稳定序**:迭代序 = 图的注册序(JSON 位置),且动作内发射的信号
  经嵌套排空会插队先完成。这是现行语义不是 bug——**别编排跨图顺序依赖**。
- **reactive 迁移只在有限的几个唤醒点重评**(flag 变化 / 队列排空 / 注册 / 读档 / 注入求值上下文)。
  条件叶子若不在这些唤醒源上(如位面被 `activatePlane` 手动改),迁移会"沉睡"到下一个信号才醒;
  **新增条件叶子必须同时回答"谁唤醒它"**,否则写出来的 reactive 迁移是死的。
- 配一个"信号驱动拍子"最少动 5 处:①场景 zone + 门闸 ②对话图(演 + 信号)③叙事子图
  (states + 末态 broadcastOnEnter)④主图接一条 transition ⑤补被引用资产。少接第④步 = 支线,不是漏配。
- scenarios.json 与 narrative 的 scenario_* 子图撞名但完全是两套,且前者已退役清空
  (见 [scenario-catalog-semantics](scenario-catalog-semantics.md))。
- "谁在发/谁在听"的权威口径与悬垂告警语义见 [emitted-signal-catalog](../../editor-tools/mechanisms/emitted-signal-catalog.md)。

## 怎么验证

`XungouMainFlowIntegration.test.ts` 是脊椎规格;单拍用命令通道 emitNarrativeSignal 后读快照 narrative 状态断言。
