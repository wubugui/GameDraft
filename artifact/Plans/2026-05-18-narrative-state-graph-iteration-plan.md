# 叙事状态图系统落地迭代计划

## 0. 目标

把现有叙事状态图系统从“能运行但概念混杂”的状态，收敛为一套可落地、可维护、可给策划使用的工作流。

最终目标：

```text
1. Graph 只表示某个叙事对象自己的状态机。
2. Transition 只做本 Graph 内部状态迁移。
3. 图与图之间只通过 signal / lifecycle trigger 互相触发。
4. 实体必须通过 wrapperGraph 才拥有叙事状态。
5. DialogueGraph 增加 OwnerStateNode，用于读取所属实体 wrapper 状态。
6. DialogueGraph 可选增加 ContextStateNode，用于读取显式声明的上层 flow/scenario 状态。
7. projectFlags 禁用。
8. setNarrativeState 降级为调试/修复能力。
9. 编辑器中把“真实迁移边”和“派生因果边”分清楚。
```

---

## 1. 当前实现基线

### 1.1 运行时现状

当前 `NarrativeStateManager` 已经具备：

```text
1. 加载 narrative_graphs.json；
2. 注册 Graph；
3. 维护 activeStates；
4. 处理 emitNarrativeSignal；
5. 处理 setNarrativeState；
6. 按 activeState + signal + conditions + priority 匹配 Transition；
7. 执行 onExitActions / onEnterActions；
8. 产生 stateExited / stateEntered lifecycle trigger；
9. serialize / deserialize activeStates；
10. debugSnapshot。
```

当前运行时仍支持跨图 endpoint：

```text
Transition.from / to 可以是：
  stateId
  或 { graphId, stateId }
```

这是后续需要收敛的重点。

### 1.2 DialogueGraph 现状

当前 `DialogueGraphNodeDef` 只有：

```text
line
runActions
choice
switch
end
```

也就是说：

```text
当前没有专用“状态机节点”。
```

当前对话图可以通过普通 switch 节点和 condition 读取 narrativeState：

```text
{ narrative: graphId, state: stateId }
```

但这要求策划手写 graphId/stateId，缺少“所属实体 wrapper”的强约束和编辑器可视化。

### 1.3 条件系统现状

`evaluateConditionExpr` 已支持 narrative leaf：

```text
{ narrative: graphId, state: stateId }
```

运行时通过：

```text
ctx.narrativeState.isStateActive(graphId, stateId)
```

判断叙事状态。

这个能力应保留。

### 1.4 编辑器现状

当前叙事状态编辑器由：

```text
PySide shell
  + QWebChannel bridge
  + React Flow web editor
```

组成。

React 编辑器当前支持：

```text
Composition
mainGraph
wrapperGraph
scenarioSubgraph
blackbox element
graph/state/transition inspector
projection trigger/read/command edges
runtime simulate / emit / pull
```

当前 projection 能派生：

```text
triggerEdges
readEdges
stateCommandEdges
```

但当前编辑器仍允许或暗示跨图 Transition，并且 projectFlags 仍存在 UI/数据路径。

---

## 2. 总体迭代顺序

建议按 6 个阶段推进：

```text
阶段 1：收敛 NarrativeGraph/Transition 规则
阶段 2：禁用 projectFlags 与管控 setNarrativeState
阶段 3：建立实体 wrapper 绑定模型
阶段 4：DialogueGraph 增加 OwnerStateNode
阶段 5：可选增加 ContextStateNode / FlowStateNode
阶段 6：编辑器 Projection 与校验整体升级
```

每个阶段都应该做到：

```text
1. 运行时可用；
2. 编辑器可配；
3. 校验能发现错误；
4. 老数据有迁移或兼容策略；
5. 有最小验收场景。
```

---

# 阶段 1：收敛 NarrativeGraph / Transition 规则

## 1.1 目标

把 Transition 从“可能跨图迁移”收敛为“只在本 Graph 内部迁移”。

最终规则：

```text
Transition.from: stateId
Transition.to: stateId
```

禁止：

```text
Transition.from = { graphId, stateId }
Transition.to   = { graphId, stateId }
```

图间影响统一通过：

```text
stateEntered:<graphId>:<stateId>
stateExited:<graphId>:<stateId>
external:<sourceType>:<sourceId>:<signal>
```

## 1.2 需要修改的文件

```text
src/core/NarrativeStateManager.ts
src/data/types.ts 或叙事状态专用 types 文件
/tools/narrative_editor_web/src/types.ts
/tools/narrative_editor_web/src/editorModel.ts
/tools/narrative_editor_web/src/NarrativeEditorApp.tsx
tools/editor/editors/narrative_state_editor.py
```

## 1.3 运行时修改

### 修改点 A：收窄 Transition endpoint

当前 `NarrativeEndpoint` 支持 string 或 object。

要改为：

```text
NarrativeEndpoint = string
```

运行时处理逻辑从：

```text
resolveEndpoint(endpoint, ownerGraphId)
```

收敛为：

```text
fromStateId = transition.from
toStateId = transition.to
```

### 修改点 B：删除或废弃 cross-graph enter 逻辑

当前 `applyTransition` 中有逻辑：

```text
if to.graphId === from.graphId:
  enterState(graph)
else:
  enterState(targetGraph)
```

目标实现应该只有：

```text
enterState(ownerGraph, fromStateId, toStateId)
```

不再支持 targetGraph remote-enter。

### 修改点 C：保留 lifecycle trigger

`enterState` 仍然必须：

```text
enqueue stateExited:<graphId>:<fromState>
activeState = toState
enqueue stateEntered:<graphId>:<toState>
```

因为图间触发依赖 lifecycle trigger。

### 修改点 D：保留 Transition.conditions

`conditionsMet` 保留。

条件语义：

```text
signal 代表发生了什么；
conditions 代表本 Graph 如何响应该事件。
```

不能删除。

## 1.4 编辑器修改

### 修改点 A：禁止跨图连线创建 Transition

当前 React Flow `onConnect` 支持跨 graph endpoint。

要改为：

```text
只有同一个 Graph 内的 State -> State 才能创建 Transition。
```

如果用户拖线跨图：

```text
不创建 Transition；
提示：跨图关系请通过 signal / lifecycle trigger 表达。
```

### 修改点 B：TransitionInspector 移除跨图 endpoint 输入

当前 from/to 支持 `graphId.stateId`。

应改为：

```text
from: 下拉选择当前 Graph states
to: 下拉选择当前 Graph states
```

不要再让策划手写跨图 endpoint。

### 修改点 C：现有跨图 Transition 数据校验报错

校验规则：

```text
transition.from 必须是当前 graph 的 stateId
transition.to 必须是当前 graph 的 stateId
```

如果遇到 object endpoint：

```text
error: transition.crossGraphEndpoint.unsupported
```

## 1.5 数据迁移策略

如果老数据存在：

```text
Graph A: A1 -> { graphId: B, stateId: B2 }
```

不能自动等价迁移成 Transition，因为语义不完全相同。

建议迁移工具给出半自动建议：

```text
1. 在 Graph A 的 A1 -> A2 迁移中保留原 signal；如果 A 不应变状态，则需要策划补一个 A 内部状态或取消该边。
2. 在 Graph B 内创建：B_current -> B2
3. Graph B 新 Transition.signal = stateEntered:GraphA:<某状态>
```

如果无法确定 A 应进入哪个状态，则只生成 migration warning，不自动改。

## 1.6 验收标准

```text
1. 新建 Transition 时只能连同图 State。
2. Runtime 中 Transition 永远只改变自身 Graph activeState。
3. 其他 Graph 只能通过 stateEntered/stateExited 响应。
4. 老跨图 endpoint 被校验拦截。
5. 现有正常同图 Transition、conditions、priority、onEnter/onExit 不受影响。
```

---

# 阶段 2：禁用 projectFlags 与管控 setNarrativeState

## 2.1 目标

禁止新流程继续把 narrativeState 投影成 FlagStore flag。

降低 setNarrativeState 在普通策划工作流中的存在感。

## 2.2 需要修改的文件

```text
src/core/NarrativeStateManager.ts
tools/narrative_editor_web/src/NarrativeEditorApp.tsx
tools/narrative_editor_web/src/editorModel.ts
tools/editor/editors/narrative_state_editor.py
src/core/ActionRegistry.ts
tools/editor/shared/action_editor.py
```

## 2.3 projectFlags 修改

### 修改点 A：编辑器隐藏 projectFlags

GraphInspector 中不再显示 projectFlags 复选框。

### 修改点 B：校验禁止新数据开启 projectFlags

校验规则：

```text
if graph.projectFlags === true:
  warning 或 error: projectFlags.deprecated
```

建议第一阶段 warning，稳定后改 error。

### 修改点 C：运行时兼容但不推荐

`NarrativeStateManager.projectActiveFlags` 可以暂时保留，但只为旧存档/旧数据兼容。

后续可加 dev warning：

```text
NarrativeStateManager: graph.projectFlags is deprecated
```

## 2.4 setNarrativeState 修改

### 修改点 A：ActionEditor 标记危险

`setNarrativeState` 在 ActionEditor 中标注：

```text
危险：绕过 Transition/conditions，仅用于调试或修复。
```

### 修改点 B：Projection 中 StateCommandEdge 标红

`stateCommandEdges` 视觉上与普通 triggerEdge 区分。

建议文案：

```text
强制设状态：绕过状态机因果链
```

### 修改点 C：校验普通资源中的 setNarrativeState

对 DialogueGraph、Zone、Quest、Cutscene 等普通资源中出现 setNarrativeState，给 warning：

```text
stateCommand.unsafeInContent
```

不用一开始禁止，因为有些旧数据或修复逻辑可能依赖。

## 2.5 验收标准

```text
1. 新图无法在 UI 中开启 projectFlags。
2. projectFlags=true 会被校验提示。
3. setNarrativeState 仍可用于 Runtime setState/调试。
4. 普通内容中使用 setNarrativeState 会被 Projection 标红。
```

---

# 阶段 3：建立实体 wrapper 绑定模型

## 3.1 目标

明确实体与 wrapperGraph 的绑定关系。

实体没有 wrapper 时，没有叙事状态；实体绑定 wrapper 后，对话图 OwnerStateNode 才能读取该 wrapper activeState。

## 3.2 当前缺口

当前数据里 NPC 有：

```text
dialogueGraphId
dialogueGraphEntry
conditions
conditionHidesEntity
```

但没有明确字段表示：

```text
这个实体绑定哪个 Narrative wrapperGraph。
```

当前 NarrativeGraph 有：

```text
ownerType
ownerId
```

但需要建立从实体到 wrapperGraph 的稳定查找规则。

## 3.3 绑定方案

推荐使用 NarrativeGraph 的 owner 作为主绑定源：

```text
wrapperGraph.ownerType = 'npc' | 'hotspot' | 'zone'
wrapperGraph.ownerId = entityId
```

对实体来说，不额外增加字段也可以查到 wrapper：

```text
getGraphsByOwner('npc', npcId)
```

但要加唯一性规则。

## 3.4 唯一性规则

对同一个实体：

```text
ownerType + ownerId
```

默认只能绑定一个主 wrapperGraph。

校验规则：

```text
如果同一个 ownerType:ownerId 对应多个 wrapperGraph：
  warning/error: owner.wrapper.duplicate
```

如果未来确实要多 wrapper，需要显式区分：

```text
primaryWrapper: true
或 wrapperRole: identity / scenario / temporary
```

但 MVP 不做多 wrapper。

## 3.5 Runtime API 增加

在 `NarrativeStateManager` 增加或明确使用：

```text
getPrimaryGraphByOwner(ownerType, ownerId)
getPrimaryActiveStateByOwner(ownerType, ownerId)
isOwnerStateActive(ownerType, ownerId, stateId)
```

如果暂时不新增，也至少封装一个 helper，避免 DialogueGraph 自己处理多个 graph 的情况。

## 3.6 编辑器修改

### 修改点 A：wrapperGraph Inspector

当 element.kind === wrapperGraph 时，Inspector 强化：

```text
ownerType
ownerId
```

并提示：

```text
该 wrapper 绑定实体后，DialogueGraph OwnerStateNode 才能引用它。
```

### 修改点 B：绑定选择器

ownerId 不建议纯手写。

应从 AuthoringCatalog 提供：

```text
sceneEntityRefs
zoneRefs
questIds
minigameIds
cutsceneIds
```

对 NPC/Hotspot 可显示 sceneId:entityId 或 entityId。

### 修改点 C：校验未绑定 wrapper

wrapperGraph 如果 ownerId 为空：

```text
warning: wrapper.unbound
```

当前已有类似 warning，保留并强化文案。

## 3.7 验收标准

```text
1. wrapperGraph 能明确绑定 npc_ringboy。
2. 运行时能通过 npc_ringboy 找到唯一 wrapperGraph。
3. 多 wrapper 绑定同一实体会被校验提示。
4. 未绑定 wrapper 时 OwnerStateNode 不允许创建或运行时走 default。
```

---

# 阶段 4：DialogueGraph 增加 OwnerStateNode

## 4.1 目标

给 DialogueGraph 增加专用节点：所属实体状态机节点。

该节点用于读取当前 DialogueGraph 所属实体绑定的 wrapperGraph.activeState，并按 state -> next 选择对白分支。

## 4.2 需要修改的文件

```text
src/data/types.ts
src/systems/GraphDialogueManager.ts
src/systems/graphDialogue/evaluateGraphCondition.ts  // 可能不需要改，OwnerStateNode 可直接查 narrativeState
tools/dialogue_graph_editor/*
tools/dialogue_graph_editor/node_inspector.py
可能还包括 dialogue graph schema / validator / exporter
```

## 4.3 数据结构设计

在 `DialogueGraphNodeDef` 增加新类型。

建议名称：

```text
ownerState
```

节点数据：

```text
{
  type: 'ownerState',
  cases: {
    state: string,
    next: string
  }[],
  defaultNext: string,
  missingWrapperNext?: string
}
```

含义：

```text
读取当前对话所属实体 wrapper.activeState，
如果 activeState 命中 cases.state，进入对应 next；
否则进入 defaultNext；
如果所属实体没有 wrapper，可进入 missingWrapperNext 或 defaultNext。
```

不允许在节点里写 graphId。

因为它只能引用所属实体 wrapper。

## 4.4 Runtime 修改

### 修改点 A：GraphDialogueManager 保存上下文实体

当前 `GraphDialogueManager.startDialogueGraph` 已经接收：

```text
npcId
```

并保存在：

```text
this.npcId
```

OwnerStateNode 运行时要使用这个上下文。

### 修改点 B：GraphDialogueManager 需要拿到 NarrativeStateManager

当前 GraphDialogueManager 构造函数没有注入 NarrativeStateManager。

但 conditionCtxFactory 能返回 narrativeState。

OwnerStateNode 可以通过：

```text
this.conditionCtx().narrativeState
```

读取状态。

但还需要按 owner 查 wrapperGraph。

因此 condition ctx 目前不够，因为它只有：

```text
getActiveState(graphId)
isStateActive(graphId,stateId)
```

建议新增一个专用 runtime dependency：

```text
GraphDialogueManager.setOwnerWrapperResolver(fn)
```

或者扩展 conditionCtx.narrativeState：

```text
getPrimaryGraphByOwner(ownerType, ownerId)
getPrimaryActiveStateByOwner(ownerType, ownerId)
```

推荐后者，让状态查询统一归 narrativeState。

### 修改点 C：drainUntilBlocking 增加 ownerState 分支

在 `GraphDialogueManager.drainUntilBlocking()` 中，当前按 node.type 处理：

```text
switch
runActions
line
choice
end
```

需要新增：

```text
ownerState
```

处理逻辑：

```text
1. 获取当前 this.npcId。
2. 如果 npcId 为空，走 missingWrapperNext/defaultNext。
3. 通过 narrativeState.getPrimaryActiveStateByOwner('npc', npcId) 找 activeState。
4. 如果找不到 wrapper 或 activeState，走 missingWrapperNext/defaultNext。
5. 在 cases 中找 state == activeState。
6. 命中则 currentNodeId = case.next。
7. 未命中则 currentNodeId = defaultNext。
8. pushNarrativeRouteStep。
9. continue drain。
```

### 修改点 D：支持 Hotspot 对话上下文

当前 `startDialogueGraph` 主要传 npcId。

如果 InspectDataGraphMode 或 Hotspot 也要使用 OwnerStateNode，需要扩展启动参数：

```text
ownerType?: 'npc' | 'hotspot' | 'zone' | ...
ownerId?: string
```

短期可以先只支持 NPC：

```text
ownerType = 'npc'
ownerId = npcId
```

但如果你的游戏里热点看板/物件也会走图对话，建议一次设计成通用：

```text
DialogueGraphRuntimeOwner:
  ownerType
  ownerId
```

然后 NPC 对话传：

```text
ownerType='npc', ownerId=npcId
```

Hotspot inspect 图对话传：

```text
ownerType='hotspot', ownerId=hotspotId
```

## 4.5 Dialogue Graph Editor 修改

### 修改点 A：节点类型列表新增 OwnerStateNode

编辑器新增节点按钮：

```text
所属实体状态
```

### 修改点 B：Inspector

OwnerStateNode Inspector 显示：

```text
数据源：所属实体 wrapper
cases:
  state -> next
默认 next
auto refresh states 按钮
```

由于节点不存 graphId，编辑器只有在知道该 DialogueGraph 可能绑定的实体时，才能列出 states。

因此编辑器至少要支持：

```text
1. 如果 DialogueGraph 被某个 NPC.dialogueGraphId 引用，尝试反查所属实体 wrapper。
2. 如果有多个实体引用同一个 DialogueGraph，则提示多上下文，状态列表不可唯一确定。
3. 仍允许手写 state 字符串，但校验 warning。
```

### 修改点 C：可选状态枚举

如果能定位 owner wrapper，则 cases.state 下拉来自：

```text
wrapperGraph.states
```

如果不能定位，则：

```text
允许手写，但 warning：无法静态确定所属实体 wrapper。
```

## 4.6 校验

新增校验规则：

```text
ownerState.defaultNext 必须存在。
ownerState.cases[].next 必须存在。
ownerState.cases[].state 不应为空。
如果能静态解析 owner wrapper，则 state 必须存在于 wrapper.states。
如果 graph 无任何可能 owner wrapper，warning。
```

## 4.7 Projection 修改

Projection 增加 ReadEdge：

```text
owner wrapper graph -> DialogueGraph OwnerStateNode
```

如果无法静态确定 owner wrapper，则 Projection warning。

## 4.8 验收标准

```text
1. NPC npc_ringboy 绑定 wrapperGraph。
2. rolling_ring_boy 对话图入口新增 OwnerStateNode。
3. 游戏运行时点击 npc_ringboy，OwnerStateNode 根据 wrapper activeState 选择不同对白。
4. wrapper 状态变化后，再次对话会进入不同分支。
5. 未绑定 wrapper 的 NPC 使用 OwnerStateNode 时，编辑器和运行时都有明确提示/兜底。
6. OwnerStateNode 不允许配置 graphId。
```

---

# 阶段 5：增加 ContextStateNode / FlowStateNode

## 5.1 目标

允许 DialogueGraph 显式读取上层 flow/scenario 状态，但不与 OwnerStateNode 混淆。

## 5.2 是否必须做

不是 MVP 必须。

如果当前需求主要是 NPC 根据自己状态分支，先做 OwnerStateNode 即可。

如果对话经常需要根据主流程阶段分支，再做 ContextStateNode。

## 5.3 数据结构设计

新增节点：

```text
{
  type: 'contextState',
  graphId: string,
  cases: {
    state: string,
    next: string
  }[],
  defaultNext: string
}
```

区别：

```text
OwnerStateNode:
  不存 graphId，只读所属实体 wrapper。

ContextStateNode:
  显式存 graphId，只读允许的 flow/scenario graph。
```

## 5.4 约束

ContextStateNode 不能任意选择所有 Graph。

推荐限制：

```text
1. 只能选择当前 Narrative Composition 中被标记为 context 的 mainGraph / scenarioGraph。
2. 或者只能选择 ownerType = flow / scenario 的 Graph。
3. 不能选择 npc/hotspot wrapper，避免绕过 OwnerStateNode。
```

## 5.5 Runtime 修改

GraphDialogueManager 处理：

```text
contextState:
  active = narrativeState.getActiveState(graphId)
  按 cases 匹配
  未命中走 defaultNext
```

## 5.6 编辑器修改

ContextStateNode Inspector：

```text
graphId 下拉
state -> next cases
默认 next
```

Projection 增加 ReadEdge：

```text
context graph -> DialogueGraph ContextStateNode
```

## 5.7 校验

```text
graphId 必须存在。
graphId 类型必须允许被读取。
cases[].state 必须存在于 graph.states。
next/defaultNext 必须存在。
```

## 5.8 验收标准

```text
1. DialogueGraph 可读取 flow_dock_water_monkey 状态。
2. ContextStateNode 与 OwnerStateNode UI 明显不同。
3. ContextStateNode 不能选择 npc wrapper。
4. Projection 能显示 flow -> DialogueGraph 的 ReadEdge。
```

---

# 阶段 6：编辑器 Projection 与校验整体升级

## 6.1 目标

让编辑器看到的关系完全符合最终心智模型：

```text
真实迁移：State -> State
触发关系：SignalSource -> Transition
读取关系：Graph activeState -> DialogueGraph StateNode
危险命令：StateCommandEdge 标红
```

## 6.2 Projection 修改

### TriggerEdge

目标应该尽量指向 Transition，而不是状态节点。

当前如果只能指状态节点，至少 label 中显示 transitionId。

推荐最终结构：

```text
triggerEdge:
  source: signal source node
  target: transition anchor node
  label: triggerKey
  graphId
  transitionId
```

### ReadEdge

新增来源：

```text
OwnerStateNode
ContextStateNode
普通 switch/choice 中 narrative condition
```

ReadEdge 应显示：

```text
Graph.activeState -> DialogueGraph node
```

### StateCommandEdge

保留，但标红。

## 6.3 校验汇总

最终校验应包含：

```text
1. graph id 唯一。
2. graph.initialState 存在。
3. state id 合法。
4. transition id 唯一。
5. transition.from/to 必须是本 Graph state。
6. transition.signal 非空。
7. transition.conditions 形状合法。
8. wrapperGraph.ownerType/ownerId 合法。
9. 同一 owner 不应多个主 wrapper。
10. projectFlags deprecated。
11. setNarrativeState 在普通内容中 warning。
12. OwnerStateNode next/defaultNext 存在。
13. OwnerStateNode 只读取所属实体 wrapper。
14. ContextStateNode graphId/state 合法。
15. 不允许跨图 Transition endpoint。
```

## 6.4 验收标准

```text
1. 编辑器画布中同图 Transition 与 ProjectionEdge 视觉区分明确。
2. 跨图因果边显示为 SignalSource -> Transition。
3. 对话图读取 wrapper 状态显示为 ReadEdge。
4. 强制 setState 显示为危险 StateCommandEdge。
5. 校验能拦截错误数据。
```

---

# 阶段 7：示例数据迁移与样板场景

## 7.1 目标

做一个最小但完整的样板，验证全流程。

建议使用：

```text
npc_ringboy + flow_dock_water_monkey + rolling_ring_boy DialogueGraph
```

## 7.2 样板配置

### Flow Graph

```text
flow_dock_water_monkey:
  initial
  board_read
  waterside_available
  crate_minigame_done
```

Transitions：

```text
initial -> board_read
signal: external:dialogue:dock_board:board_read_done

board_read -> waterside_available
signal: external:zone:waterside:entered

waterside_available -> crate_minigame_done
signal: external:minigame:dock_crate_tutorial:pull_success
```

### NPC Wrapper

```text
ownerType: npc
ownerId: npc_ringboy
```

States：

```text
before_event
after_event
ring_taken
ring_returned
```

Transitions：

```text
before_event -> after_event
signal: stateEntered:flow_dock_water_monkey:crate_minigame_done

after_event -> ring_taken
signal: external:dialogue:rolling_ring_boy:ring_taken

ring_taken -> ring_returned
signal: external:dialogue:rolling_ring_boy:ring_returned
```

### DialogueGraph

Entry：

```text
OwnerStateNode
  before_event -> line_before_event
  after_event -> line_after_event
  ring_taken -> line_ring_taken
  ring_returned -> line_ring_returned
  default -> line_default
```

runActions：

```text
玩家拿走铁环：
  emitNarrativeSignal(dialogue, rolling_ring_boy, ring_taken)

玩家归还铁环：
  emitNarrativeSignal(dialogue, rolling_ring_boy, ring_returned)
```

## 7.3 验收流程

```text
1. 开局点击 npc_ringboy，进入 before_event 白。
2. 模拟/触发 crate_minigame_done。
3. npc_ringboy wrapper 自动进入 after_event。
4. 再点击 npc_ringboy，OwnerStateNode 进入 after_event 白。
5. 对话中选择拿走铁环，发 ring_taken signal。
6. wrapper 进入 ring_taken。
7. 再点击 npc_ringboy，进入 ring_taken 白。
8. Projection 中能看到：
   flow stateEntered -> npc wrapper Transition
   DialogueGraph OwnerStateNode read -> npc wrapper
   DialogueGraph emit signal -> npc wrapper Transition
```

---

# 阶段 8：测试清单

## 8.1 Runtime 单元测试

重点测试 `NarrativeStateManager`：

```text
1. 同图 Transition 正常迁移。
2. signal 不匹配不迁移。
3. fromState 不等于 activeState 不迁移。
4. conditions 不满足不迁移。
5. 多候选按 priority 选择。
6. onExit/onEnter 顺序正确。
7. stateEntered/stateExited 可触发其他 Graph。
8. 跨图 endpoint 数据被拒绝或忽略。
9. serialize/deserialize activeStates 正确。
```

## 8.2 DialogueGraph 测试

重点测试 OwnerStateNode：

```text
1. 有 wrapper，state 命中 case。
2. 有 wrapper，state 不命中，走 default。
3. 无 wrapper，走 missingWrapperNext/default。
4. npcId 为空，走 missingWrapperNext/default。
5. wrapper 状态变化后，下一次进入对话分支变化。
6. OwnerStateNode 不依赖手写 graphId。
```

ContextStateNode 如果实现：

```text
1. graphId 存在，state 命中。
2. graphId 存在，state 未命中。
3. graphId 不存在，校验报错。
4. graphId 类型不允许，校验报错。
```

## 8.3 编辑器测试

```text
1. 不能跨图创建 Transition。
2. Transition from/to 只能选择本 Graph state。
3. wrapper ownerId 可选择实体。
4. OwnerStateNode 可创建、可编辑 cases。
5. OwnerStateNode 能根据 wrapper states 下拉。
6. Projection 正确显示 ReadEdge。
7. setNarrativeState 显示危险边。
8. projectFlags 被隐藏/警告。
```

---

# 阶段 9：建议实施顺序

推荐具体执行顺序：

```text
1. 先做阶段 1：禁止跨图 Transition。
2. 同时做阶段 2：隐藏 projectFlags，标红 setNarrativeState。
3. 做阶段 3：wrapper 绑定唯一性与 runtime 查询 API。
4. 做阶段 4：OwnerStateNode。
5. 用 npc_ringboy 做样板验收。
6. 再做阶段 6 的 Projection 美化和校验强化。
7. 如果确有需要，再做阶段 5：ContextStateNode。
```

不要一开始就同时做 ContextStateNode 和复杂 Projection，否则容易范围过大。

最小可交付版本应该是：

```text
Transition 同图化
projectFlags 禁用
wrapper owner 绑定唯一
OwnerStateNode 可运行
npc_ringboy 样板跑通
```

---

# 10. 最小可交付版本 MVP

MVP 必须完成：

```text
1. Runtime 禁止或不再执行跨图 Transition。
2. Editor 禁止创建跨图 Transition。
3. WrapperGraph 通过 ownerType/ownerId 绑定实体。
4. Runtime 能按 ownerType/ownerId 找到唯一 wrapper activeState。
5. DialogueGraph 新增 OwnerStateNode。
6. OwnerStateNode 能根据所属实体 wrapper.activeState 分支。
7. projectFlags UI 隐藏并校验 warning。
8. setNarrativeState 标记为危险。
9. npc_ringboy 样板验证成功。
```

MVP 暂不必须完成：

```text
1. ContextStateNode。
2. 完全删除旧 cross-graph endpoint 类型。
3. 自动迁移所有老数据。
4. Projection 指向 TransitionAnchor 的完整重构。
```

但 MVP 后必须补：

```text
1. 老数据迁移工具。
2. Projection 完整升级。
3. 校验 error 化。
4. 文档与策划使用规范。
```

---

# 11. 风险点

## 11.1 老数据兼容风险

如果已有数据使用跨图 endpoint，禁止后会失效。

应先跑校验，列出所有跨图 endpoint，再决定人工迁移。

## 11.2 DialogueGraph 复用风险

同一个 DialogueGraph 可能被多个 NPC 使用。

OwnerStateNode 在运行时没问题，因为运行时有当前 owner。

但编辑器静态列 state 时可能不知道具体 owner。

处理方式：

```text
1. 如果唯一 NPC 引用该 DialogueGraph，则静态显示 wrapper states。
2. 如果多个 NPC 引用，则显示多 owner 提示，允许手写 state。
3. 运行时按当前 owner 实际 wrapper 分支。
```

## 11.3 Hotspot/Inspect 图对话上下文风险

当前 NPC 对话有 npcId，但 Hotspot inspect graph 未必传 ownerType/ownerId。

如果要让 Hotspot 也用 OwnerStateNode，需要扩展 startDialogueGraph 参数。

建议 MVP 先支持 NPC，随后统一扩展为：

```text
ownerType
ownerId
```

## 11.4 setNarrativeState 滥用风险

如果不标红，策划可能继续拿它做普通剧情推进。

必须在编辑器中显著区分。

## 11.5 Transition.conditions 滥用风险

conditions 必须保留，但不要让它替代所有对话分支。

规则：

```text
事件语义不同 -> 发不同 signal。
同一事件下对象响应不同 -> 用 Transition.conditions。
```

---

# 12. 最终完成标准

整个迭代完成后，应该满足：

```text
1. 策划能清楚知道：实体必须绑定 wrapper 才有叙事状态。
2. 策划能在对话图里用 OwnerStateNode 按实体状态分支。
3. 策划不会再把跨图线理解为迁移。
4. 图间关系统一通过 signal / lifecycle trigger 表达。
5. projectFlags 不再进入新流程。
6. setNarrativeState 不再被当成普通剧情推进工具。
7. 编辑器能清楚显示：谁发 signal、谁响应、谁读取状态、谁强制设状态。
8. Runtime 逻辑简化为：signal + from + conditions + priority => to。
```