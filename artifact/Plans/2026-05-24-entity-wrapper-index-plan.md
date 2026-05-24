# 实体多 Wrapper 叙事状态视角迭代计划

## 0. 目标

在现有叙事状态图系统中，一个实体可以通过多个 `wrapperGraph` 参与多条叙事线。编辑器需要提供以实体为中心的聚合视角，让策划能够集中查看某个实体绑定的全部 wrapper、每个 wrapper 的状态机内容，以及这些 wrapper 与叙事流程、对话、区域、小游戏、任务等内容之间的读写和信号连线关系。

本迭代的核心目标：

```text
1. 实体可以绑定多个 wrapperGraph。
2. 每个 wrapperGraph 仍然是独立的 NarrativeGraph，用 graphId 作为唯一运行时身份。
3. wrapperGraph 可以带用户自由填写的分类备注，帮助策划理解用途。
4. 编辑器从 narrative_graphs.json 派生实体到 wrapper 的聚合索引。
5. 实体视角窗口展示 wrapper 列表、状态、迁移、输入信号、输出广播和读取关系。
6. 对话图、条件编辑器、Projection、校验器等外部接口显式指向具体 wrapper graph，避免多 wrapper 场景下的读取歧义。
```

---

## 1. 概念模型

### 1.1 上层叙事状态机

上层叙事状态机描述一条叙事线、流程线、任务线或场景线自己的进度。

示例：

```text
flow_dock_water_monkey:
initial -> board_read -> waterside_available -> crate_minigame_done
```

它表达“码头水鬼流程推进到哪里了”。

### 1.2 实体 Wrapper 状态机

实体 wrapper 状态机是绑定到某个实体的局部状态机。它通过 `ownerType + ownerId` 表明自己服务于哪个实体。

示例：

```text
npc_ringboy:
before_event -> after_event -> ring_taken -> ring_returned
```

它表达“滚铁环小孩在某段叙事中的局部状态”。

### 1.3 实体多 Wrapper

同一个实体可以绑定多个 wrapper。

示例：

```text
npc:npc_ringboy
  -> graphId = npc_ringboy_water_monkey
  -> graphId = npc_ringboy_followup_quest
  -> graphId = npc_ringboy_scene_behavior
```

每个 wrapper 都有自己的 `graphId`、状态、迁移、信号监听、广播和生命周期 actions。

### 1.4 Wrapper 分类备注

wrapper 可以使用 `category` 表示用途分类或备注。

示例：

```text
category = 水猴子事件状态
category = 归还铁环任务
category = 码头场景行为
category = 后续支线备用
```

`category` 由用户自由填写，系统不定义枚举、不解释含义、不根据内容做逻辑判断。

分类备注用于：

```text
1. 在实体窗口中分组；
2. 在 wrapper 选择器中辅助理解；
3. 在校验报告中给出提示；
4. 在策划整理实体状态时作为备注。
```

`graphId` / wrapper element id 是 wrapper 的精确身份。`category` 只是分类备注。

### 1.5 运行时核心身份

运行时继续以 `graphId` 管理状态：

```text
graphId -> activeState
signal -> transition
broadcastOnEnter -> state:<graphId>:<stateId>
```

实体聚合视角由编辑器、Projection 和校验器通过扫描数据生成。

---

## 2. 数据需求

### R1. Wrapper 元数据字段

为叙事状态图类型补充可选字段：

```ts
interface NarrativeGraph {
  category?: string;
}
```

字段含义：

```text
category: 用户自由填写的 wrapper 分类或备注。
```

编辑器展示要求：

```text
1. 在 wrapper inspector 中显示和编辑 category。
2. 在实体窗口中按 category 分组。
3. 在 wrapper 选择器中展示 graphId、composition、category、状态数量和迁移数量。
```

### R2. 实体绑定派生索引

编辑器扫描所有 Composition 和 wrapperGraph，生成实体绑定索引：

```text
ownerType + ownerId -> wrapperGraph[]
graphId -> wrapperGraph 所属 composition / element
```

索引条目包含：

```text
ownerType
ownerId
compositionId
compositionLabel
elementId
elementLabel
graphId
category
states
transitions
broadcast states
onEnter/onExit actions summary
```

该索引用于：

```text
1. 实体叙事状态窗口；
2. ownerState wrapper 选择器；
3. 条件编辑器 graph 选择器；
4. Projection 连线视图；
5. 校验器问题定位。
```

### R3. 连线关系派生索引

编辑器和 Projection 扫描所有相关内容，生成 wrapper 的读写关系：

```text
emits: 外部内容发出的 emitNarrativeSignal；
listens: wrapper transition.signal 监听的信号；
reads: 对话图、条件、UI 或系统读取的 graph/state；
writes: setNarrativeState / debugSetNarrativeState 指向的 graph/state；
broadcasts: wrapper state 开启 broadcastOnEnter 后发出的派生信号；
downstream: 派生信号被哪些 transition 监听。
```

扫描范围：

```text
1. narrative_graphs.json 中所有 graph / state / transition；
2. DialogueGraph 的 ownerState / contextState / switch / choice / runActions；
3. zone / hotspot / minigame / cutscene / quest / encounter 等内容中的 actions；
4. condition 中的 narrative 状态读取；
5. state onEnterActions / onExitActions；
6. emitNarrativeSignal / setNarrativeState / debugSetNarrativeState。
```

---

## 3. 运行时需求

### R4. GraphId 主导查询接口

运行时继续提供明确 graph 查询：

```ts
getGraph(graphId: string)
getActiveState(graphId: string)
isStateActive(graphId: string, stateId: string)
getGraphsByOwner(ownerType: string, ownerId: string)
getGraphIdsByOwner(ownerType: string, ownerId: string)
```

这些接口支撑：

```text
1. 按 graphId 读取 wrapper 状态；
2. 编辑器调试面板展示运行时 activeState；
3. 对话图显式 wrapperGraphId 读取；
4. 条件系统 graphId 状态判断。
```

### R5. Primary Owner 兼容接口

保留现有 owner primary 读取接口，用于兼容旧内容：

```ts
getPrimaryGraphByOwner(ownerType: string, ownerId: string)
getPrimaryActiveStateByOwner(ownerType: string, ownerId: string)
isOwnerStateActive(ownerType: string, ownerId: string, stateId: string)
```

兼容规则：

```text
1. owner 绑定一个 wrapper 时返回该 wrapper。
2. owner 绑定多个 wrapper 时返回 undefined，并记录 warning。
3. 新增内容和新编辑器入口使用 graphId / wrapperGraphId 精确读取。
```

### R6. Debug Snapshot

`NarrativeStateManager.debugSnapshot()` 增加对多 wrapper 调试有用的信息：

```text
1. activeStates；
2. graphIds；
3. ownerIndex；
4. 多 wrapper owner 摘要；
5. recentTransitions；
6. recentIssues。
```

---

## 4. 对话图接口需求

### R7. ownerState 节点显式 wrapperGraphId

`ownerState` 节点增加 `wrapperGraphId` 字段：

```json
{
  "type": "ownerState",
  "wrapperGraphId": "npc_ringboy_water_monkey",
  "cases": [
    { "state": "before_event", "next": "before_evt_1" },
    { "state": "after_event", "next": "after_evt_1" }
  ],
  "defaultNext": "fallback"
}
```

运行逻辑：

```text
1. wrapperGraphId 有值时，读取该 graph 的 activeState。
2. wrapperGraphId 为空且当前 owner 只有一个 wrapper 时，使用旧 owner primary 逻辑。
3. wrapperGraphId 为空且当前 owner 有多个 wrapper 时，走 defaultNext / missingWrapperNext，并记录 warning。
4. wrapperGraphId 指向不存在 graph 时，走 defaultNext / missingWrapperNext，并记录 warning。
```

编辑器要求：

```text
1. ownerState 节点提供 wrapper 选择器。
2. 选择器优先列出当前对话 owner 绑定的 wrapper。
3. 每项展示 graphId、composition、category、states。
4. 多 wrapper owner 下提示选择具体 wrapper。
5. 选择后把 graphId 写入 wrapperGraphId。
```

### R8. contextState 节点选择器增强

`contextState` 节点继续按显式 `graphId` 读取。

编辑器选择器展示：

```text
1. graphId；
2. graph 类型：flow / scenario / wrapper；
3. ownerType / ownerId；
4. composition；
5. category；
6. states。
```

这样策划在选择 graph 时能看清自己读取的是上层叙事流程还是实体 wrapper。

### R9. DialogueGraph 条件编辑器

条件编辑器中的 narrative 状态读取继续落到明确 graphId：

```json
{ "narrative": "npc_ringboy_water_monkey", "state": "ring_taken" }
```

编辑器能力：

```text
1. graph 选择器展示 wrapper 绑定实体和分类；
2. 从实体窗口可以跳转到读取该 wrapper 的条件；
3. 条件问题可以定位回 graphId / stateId / 对话节点；
4. 条件引用不存在 graph/state 时显示校验问题。
```

---

## 5. Action 与信号需求

### R10. emitNarrativeSignal

`emitNarrativeSignal` 保持语义事件广播模型：

```json
{
  "type": "emitNarrativeSignal",
  "params": {
    "signal": "ring_taken",
    "sourceType": "dialogue",
    "sourceId": "rolling_ring_boy"
  }
}
```

行为：

```text
1. 发出 signal；
2. NarrativeStateManager 遍历所有 graph；
3. 匹配 activeState + transition.signal + conditions；
4. 命中的 graph 自行迁移。
```

### R11. setNarrativeState / debugSetNarrativeState

状态修改 action 和调试 API 使用明确 graphId：

```json
{
  "type": "setNarrativeState",
  "params": {
    "graphId": "npc_ringboy_water_monkey",
    "stateId": "ring_taken"
  }
}
```

编辑器和校验器展示：

```text
1. graphId 对应的 ownerType / ownerId；
2. graphId 对应的 composition / wrapper；
3. 该 action 所在资源；
4. 该 action 绕过 transition 的风险提示。
```

---

## 6. 实体叙事状态窗口需求

### R12. 窗口入口

提供以下入口之一或多个：

```text
1. 叙事编辑器侧栏中的“实体叙事状态”面板；
2. wrapper inspector 中的“查看实体所有 wrapper”；
3. 黑盒资源 inspector 中的实体跳转；
4. 校验问题列表中的 owner 跳转；
5. 对话图 ownerState 节点中的 wrapper 选择器跳转。
```

### R13. Wrapper 列表展示

实体窗口顶部显示实体身份：

```text
ownerType: npc
ownerId: npc_ringboy
```

随后展示所有绑定 wrapper：

```text
- graphId: npc_ringboy_water_monkey
  composition: 码头水鬼 / dock_water_monkey_ring_flow
  element: wrapper_npc_ringboy
  category: 水猴子事件状态
  states: before_event / after_event / ring_taken / ring_returned
  transitions: 3
  broadcasts: ring_taken
```

支持：

```text
1. 按 composition 分组；
2. 按 category 分组；
3. 按 graphId 分组；
4. 搜索 graphId / stateId / signal；
5. 跳转到 wrapper 所在 Composition；
6. 聚焦 wrapper 子图。
```

### R14. 输入关系展示

对每个 wrapper 展示哪些内容推动它：

```text
signal: state:flow_dock_water_monkey:crate_minigame_done
  emitted by: flow_dock_water_monkey.crate_minigame_done broadcast
  listened by: npc_ringboy_water_monkey.t_ringboy_after_event
  transition: before_event -> after_event

signal: ring_taken
  emitted by: dialogue 滚铁环小孩 / node take_ring_actions
  listened by: npc_ringboy_water_monkey.t_ring_taken
  transition: after_event -> ring_taken
```

### R15. 输出关系展示

对每个 wrapper 展示它进入状态后影响谁：

```text
state: npc_ringboy_water_monkey.ring_taken
  broadcast: state:npc_ringboy_water_monkey:ring_taken
  downstream:
    quest_return_ring.t_activate_return_ring
    inactive -> active
```

### R16. 读取关系展示

对每个 wrapper 展示哪些内容读取它：

```text
reads:
  dialogue 滚铁环小孩 / ownerState node / wrapperGraphId=npc_ringboy_water_monkey
  dialogue xxx / switch condition / narrative=npc_ringboy_water_monkey state=ring_taken
  zone xxx / condition / narrative=npc_ringboy_water_monkey state=after_event
```

### R17. 写入关系展示

对每个 wrapper 展示哪些内容直接写它：

```text
writes:
  action setNarrativeState graphId=npc_ringboy_water_monkey stateId=ring_taken
  dev api debugSetNarrativeState graphId=npc_ringboy_water_monkey stateId=after_event
```

展示时标明：

```text
1. 所在资源；
2. action 类型；
3. 目标 graphId / stateId；
4. 是否绕过 transition。
```

### R18. 关系图表现形式

第一版可以使用列表或树状视图。

推荐分区：

```text
1. Wrapper 列表；
2. 输入信号；
3. 输出广播；
4. 读取者；
5. 直接写入者；
6. 校验问题。
```

后续可以增加图形化视图，把真实 transition 边和 Projection 因果边分别绘制。

---

## 7. 删除与改绑需求

### R19. 删除 Wrapper 影响提示

删除 wrapper 前展示影响范围：

```text
1. 该 wrapper 的 graphId；
2. 绑定实体；
3. 所在 composition；
4. 被哪些 ownerState / contextState / condition 读取；
5. 被哪些 setNarrativeState 写入；
6. 该 wrapper broadcast 出去的信号被谁监听；
7. 该 wrapper 监听哪些外部信号。
```

确认删除后：

```text
1. 删除 wrapper element；
2. 重建实体绑定索引；
3. 相关悬空引用进入校验问题列表；
4. 实体窗口刷新。
```

### R20. 改绑 Wrapper 影响提示

修改 wrapper 的 `ownerType` / `ownerId` 前展示：

```text
1. 原实体；
2. 新实体；
3. 原实体窗口中将移除的 wrapper；
4. 新实体窗口中将新增的 wrapper；
5. ownerState 节点中 wrapperGraphId 与当前 owner 的关系提示。
```

保存后重建索引并刷新校验。

### R21. 删除或重命名实体时的 Wrapper 处理

当编辑器支持实体删除或实体 id 重命名时，提供绑定 wrapper 清单：

```text
ownerType + ownerId
绑定 wrapperGraph[]
每个 wrapper 的 composition / graphId / category / reads / writes
```

操作入口：

```text
1. 批量改绑到新 ownerId；
2. 批量解除 owner 绑定；
3. 批量删除 wrapper；
4. 逐个跳转处理。
```

---

## 8. 校验需求

### R22. Graph 与状态引用校验

校验：

```text
1. graphId 唯一；
2. transition.from / transition.to 状态存在；
3. narrative 条件引用的 graph/state 存在；
4. contextState graphId 存在；
5. ownerState wrapperGraphId 存在；
6. setNarrativeState 目标 graph/state 存在。
```

### R23. OwnerState 歧义校验

校验：

```text
1. ownerState 缺少 wrapperGraphId；
2. 当前 owner 绑定多个 wrapper；
3. 节点依赖旧 primary owner 解析。
```

问题信息包含：

```text
dialogue graph id
node id
ownerType
ownerId
候选 wrapperGraphId 列表
```

### R24. Wrapper 归属提示

校验 ownerState 的 `wrapperGraphId` 与当前对话 owner 的关系：

```text
1. wrapperGraphId 对应 graph 的 ownerType / ownerId；
2. 当前对话 ownerType / ownerId；
3. 二者关系一致时通过；
4. 二者关系不一致时给出提示，并允许策划确认是否为跨实体读取。
```

### R25. Signal 与 Broadcast 校验

校验：

```text
1. transition.signal 使用已登记作者信号或有效派生信号；
2. 派生信号 state:<graphId>:<stateId> 对应 graph/state 存在；
3. 被监听的派生 state 开启 broadcastOnEnter；
4. 开启 broadcastOnEnter 的 state 是否有监听者；
5. __draft__ signal 保持草稿提示。
```

### R26. Wrapper 分类提示

校验器提供信息提示：

```text
1. 某实体绑定了多个 wrapper；
2. 多个 wrapper 缺少 category；
3. 多个 wrapper 使用相同 category；
4. 某 wrapper 没有输入信号；
5. 某 wrapper 没有读取者或下游监听者。
```

这些提示用于帮助策划整理实体视角。

---

## 9. 实施阶段

### 阶段 A：模型与运行时兼容

覆盖需求：

```text
R1, R4, R5, R6
```

任务：

```text
1. 类型定义增加 category。
2. 编辑器 normalize / clone / rename 流程保留 category。
3. NarrativeStateManager 在 owner 多 wrapper 时记录 primary 读取 warning。
4. debugSnapshot 增加多 wrapper owner 摘要。
```

验收：

```text
1. 现有内容可正常加载；
2. 同实体多个 wrapper 可被注册；
3. graphId 查询接口可读取具体 wrapper 状态；
4. primary owner 读取在多 wrapper 下有明确 warning。
```

### 阶段 B：对话图接口去歧义

覆盖需求：

```text
R7, R8, R9
```

任务：

```text
1. DialogueGraph 类型增加 ownerState.wrapperGraphId。
2. GraphDialogueManager 优先按 wrapperGraphId 读取。
3. 对话图编辑器增加 wrapper 选择器。
4. contextState / condition 选择器展示 graph 归属。
5. 更新相关测试。
```

验收：

```text
1. 单 wrapper 旧内容继续可用；
2. 多 wrapper ownerState 可以选择明确 wrapper；
3. 缺少 wrapperGraphId 的多 wrapper ownerState 会进入校验问题；
4. 滚铁环小孩样例可显式读取目标 wrapper。
```

### 阶段 C：Projection 与校验

覆盖需求：

```text
R2, R3, R22, R23, R24, R25, R26
```

任务：

```text
1. 构建实体绑定派生索引。
2. 扩展 Projection 扫描 emits / listens / reads / writes / broadcasts。
3. 调整 owner 绑定校验。
4. 新增 ownerState 歧义校验。
5. 新增 wrapper 分类提示。
```

验收：

```text
1. 能输出某实体全部 wrapper 清单；
2. 能输出某 wrapper 的输入、输出、读取、写入关系；
3. 多 wrapper 场景下的歧义读取能被校验器定位；
4. 校验问题能跳转到对应 composition / dialogue node / action。
```

### 阶段 D：实体叙事状态窗口

覆盖需求：

```text
R12, R13, R14, R15, R16, R17, R18
```

任务：

```text
1. 新增实体叙事状态窗口。
2. 展示 wrapper 列表。
3. 展示输入信号。
4. 展示输出广播。
5. 展示读取者。
6. 展示直接写入者。
7. 支持跳转和聚焦。
```

验收：

```text
策划选择 npc_ringboy 后，可以看到所有绑定 wrapper、每个 wrapper 的状态机内容、推动它的信号、它广播影响的下游、读取它的对话/条件/action。
```

### 阶段 E：删除、改绑与样例整理

覆盖需求：

```text
R19, R20, R21
```

任务：

```text
1. 删除 wrapper 前展示影响范围。
2. 改 ownerType / ownerId 前展示影响范围。
3. 实体 id 变更时展示绑定 wrapper 清单。
4. 更新 npc_ringboy 样例，补充 category。
5. 更新对话图 ownerState，写入 wrapperGraphId。
6. 更新策划使用规范。
```

验收：

```text
1. 删除 wrapper 后实体窗口同步刷新；
2. 悬空引用进入校验列表；
3. 改绑后原实体和新实体的 wrapper 列表正确变化；
4. 样例体现多 wrapper 体系下的明确读取方式。
```

---

## 10. 最终使用体验

策划在叙事 Composition 中创建或选择 wrapper，并绑定实体：

```text
ownerType = npc
ownerId = npc_ringboy
graphId = npc_ringboy_water_monkey
category = 水猴子事件状态
```

当实体参与多条叙事时，策划打开实体叙事状态窗口，可以看到：

```text
1. 该实体绑定的全部 wrapper；
2. 每个 wrapper 所在的 composition；
3. 每个 wrapper 的状态和迁移；
4. 哪些信号推动 wrapper；
5. wrapper 进入哪些状态会广播派生信号；
6. 派生信号影响哪些下游 graph；
7. 哪些对话、条件、任务、区域、小游戏正在读取 wrapper；
8. 哪些 action 直接写入 wrapper；
9. 哪些接口仍存在多 wrapper 读取歧义。
```

对话图读取实体局部状态时，通过编辑器选择具体 wrapper：

```json
{
  "type": "ownerState",
  "wrapperGraphId": "npc_ringboy_water_monkey",
  "cases": [
    { "state": "ring_taken", "next": "ring_taken_line" }
  ],
  "defaultNext": "fallback"
}
```

运行时按明确 graphId 读取状态，按 signal 推进所有 graph。编辑器提供实体全貌、关系投影和校验提示，帮助策划在多叙事线中统筹实体状态设计。
