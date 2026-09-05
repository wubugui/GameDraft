---
id: narrative-signal-spine
title: 信号驱动 5 层编排脊椎
domain: runtime
type: mechanism
summary: 世界→对话(只演+打信号)→scenario子图→主线里程碑图→quest镜像+一个玩家意图槽;主线叙事图是唯一进度真相源
status: active
authority:
  - src/core/NarrativeStateManager.ts
  - src/core/NarrativeStateManager.ts#planRemoteAdvance
  - src/systems/QuestManager.ts
  - public/assets/data/narrative_graphs.json
  - public/assets/data/quests.json
triggers:
  paths: ["src/core/NarrativeStateManager.ts", "public/assets/data/narrative_graphs.json", "public/assets/data/quests.json", "public/assets/dialogues/graphs/**"]
  topics: [叙事编排, 信号, emitNarrativeSignal, 主线, 任务镜像, reactive 迁移, 当前任务槽, warp, 远程置态]
verified_by:
  - src/core/XungouMainFlowIntegration.test.ts
  - src/systems/QuestManager.test.ts
last_governed: 2026-09-03
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
5. **任务清单层**(quests.json):**镜像 + 一个玩家意图槽**。镜像部分不驱动,
   completionConditions 用 narrative 叶子 `reached:true`,零 setFlag;意图槽是全局唯一的
   "当前任务"(玩家选的,**进存档**,驱动 HUD 与引导),它不是叙事状态的投影。
   **两槽之间的桥接只能单向**:聚焦一个活计 → 顺带激活它的活计图;
   **聚焦一次性任务 → 绝不去清活计激活槽**。反向清槽会把非 resumable 的在途活计当场作废,
   是一条**静默销毁玩家进度**的路——UI 上只是换了个当前任务。

**层外补充:dev 远程置态(warp)** ——它造的是一段本没发生过的历史,与读档恢复**语义相反**,
别拿存档那条路去实现:

- **补历史 ≠ 置态**:读档是静默写状态 map(副作用早已落在各系统档里,所以读档从不重播演出);
  warp 的副作用无处可取,**必须沿链逐跳补跑 onEnter**。
- **重放静默用黑名单不用白名单**:途经的中间跳跳过阻塞式演出、只落钱物规矩信号,
  **最后一跳完整执行**(那才是要测的那一拍)。清单刻意收黑名单——漏登记新演出动作 =
  warp 卡住(一眼可见);白名单漏登记状态动作 = 铺垫静默缺失(贵得多)。
- **落地复核认 reached 不认 active**:无 trigger 的无条件边会让引擎当场穿过目标状态,
  停在别处而 `reached` 为真是**正常语义**;按 active 相等判定会满屏误报。

## 已知坑

- **同一信号到达多张图的先后无稳定序**:迭代序 = 图的注册序(JSON 位置),且动作内发射的信号
  经嵌套排空会插队先完成。这是现行语义不是 bug——**别编排跨图顺序依赖**。
- **reactive 迁移只在有限的几个唤醒点重评**(flag 变化 / 队列排空 / 注册 / 读档 / 注入求值上下文)。
  条件叶子若不在这些唤醒源上(如位面被 `activatePlane` 手动改),迁移会"沉睡"到下一个信号才醒;
  **新增条件叶子必须同时回答"谁唤醒它"**,否则写出来的 reactive 迁移是死的。
- **主线里有一处刻意的显式信号例外**:绝大多数拍靠子图末态 `broadcastOnEnter` 派生的
  `state:<图>:<末态>` 推进,唯独开局那一拍的出口是对话里直接 `emitNarrativeSignal` 的命名信号
  (那个末态的广播已被有意关掉,因为无人监听)。读脊椎时**别把它当漏配去"修好"**。
- 配一个"信号驱动拍子"最少动 5 处:①场景 zone + 门闸 ②对话图(演 + 信号)③叙事子图
  (states + 末态 broadcastOnEnter)④主图接一条 transition ⑤补被引用资产。少接第④步 = 支线,不是漏配。
- scenarios.json 与 narrative 的 scenario_* 子图撞名但完全是两套,且前者已退役清空
  (见 [scenario-catalog-semantics](scenario-catalog-semantics.md))。
- **章节包标记是纯组织标签,不是开关**:图恒吃信号、恒跑 reactive,与它所属的包被标成"在演"
  还是"休眠"**毫无关系**;可扫描图集也不按它过滤。权威源的注释里记着历史上有人想按它过滤、
  被拍回。这是本域最像陷阱的一处——**改了标记发现"图还是照常在跑"是设计如此,不是 bug**,
  别去"修好"它。
- **镜像层那个"取当前主线"的便捷取数口已废弃**:它只返回第一条进行中的主线,而多条主线并行
  是常态——拿它当列表源会**静默吞掉第二条以后的主线**。
- "谁在发/谁在听"的权威口径与悬垂告警语义见 [emitted-signal-catalog](../../editor-tools/mechanisms/emitted-signal-catalog.md)。

## 怎么验证

`XungouMainFlowIntegration.test.ts` 是脊椎规格;单拍用命令通道 emitNarrativeSignal 后读快照 narrative 状态断言。
