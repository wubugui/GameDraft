# 叙事状态图策划使用规范

## 心智模型

- **Graph** 只描述单个叙事对象自己的状态机（NPC wrapper、任务 wrapper、主流程 flow 等）。
- **Transition** 只在同一 Graph 内迁移：`from` / `to` 均为本图 `stateId`。
- 图与图之间通过 **语义事件信号** 联动；仅在 state 勾选 **broadcastOnEnter** 后，进入该状态才会广播 `state:<graphId>:<stateId>`。
- 实体要拥有叙事状态，必须在叙事编辑器中绑定 **wrapperGraph**（`ownerType` + `ownerId`）。

## 信号（schemaVersion 3）

| 类型 | 格式 | 说明 |
|------|------|------|
| **作者信号** | 自由命名，如 `board_read_done` | 登记在 `narrative_graphs.signals[]`，全局不重名 |
| **派生信号** | `state:<graphId>:<stateId>` | 仅 `broadcastOnEnter=true` 的 state 进状态时自动发射；只读，不入 signals 表 |
| **草稿** | `__draft__` | 新建迁移边默认值；保存 warning，运行时不匹配 |

- **Transition.signal** 填写作者信号 id 或派生 `state:...`。
- **emitNarrativeSignal** 只要求 `params.signal`（事件名）；`sourceType` / `sourceId` 可选，仅作元数据。
- 选中迁移边时用 **「选择信号…」** 打开信号窗口，可搜索、新建作者信号。

## 对话图节点

| 节点 | 用途 |
|------|------|
| **OwnerStateNode** | 按当前对话所属实体（NPC/Hotspot 等）的 wrapper `activeState` 分支；节点内不写 `graphId`。 |
| **ContextStateNode** | 显式读取上层 **flow / scenario** 图状态；必须选择允许的 `graphId`，不能选 npc wrapper。 |
| **switch + narrative 条件** | 仍可用于复杂条件；简单「读某图状态」优先用上述专用节点。 |

## 禁止事项

- 不要用 **setNarrativeState** 做普通剧情推进（仅调试/修复）。
- 不要新建 **projectFlags**（已废弃）。
- 不要在 Transition 上使用跨图 `{ graphId, stateId }` endpoint。
- 不要使用旧式 `external:type:id:event` 作为 transition 监听键（已迁移为语义事件名）。

- 派生信号需要先在被监听 state 上勾选 **进入时广播派生信号**，再在对方 transition 选择对应 `state:...`。
- 本图链式推进优先用**作者信号**；中间态不要开启 broadcast，避免向全局总线泄漏噪声。

## 工作流建议

1. 在叙事 Composition 画布绑定 wrapper → 配置 states / transitions（新建边默认为 `__draft__`）。
2. 跨图 milestone：在源 state 勾选 broadcast → 在目标 transition 选 `state:<graphId>:<stateId>`；本图内推进用作者信号。
3. 在对话图 / 玩法 Action 中 `emitNarrativeSignal`，`signal` 与状态机侧事件名一致。
4. 需要读主流程阶段时用 ContextStateNode 指向 `flow_*` 或 scenario 图。

## 编辑器

- **叙事状态 Web 编辑器**：State Inspector 可开关 broadcastOnEnter；真实迁移边 vs Projection 触发/读取/危险命令边。
- **主画布（Composition）**：编辑 `mainGraph` 状态机；黑盒 element 表示外部资源或 wrapper；双击 wrapper/scenario 元素可 **内联展开** 子图（`subgraphGroup` + 嵌套 state）。
- **独占子图**：左侧列表或 Element Inspector「独占打开子图」进入；与主图相同的状态机编辑能力（state 节点、transition 边、wiring 锚点、自动布局）；数据仍是同一 `NarrativeGraphDef`，仅视图不同。
- **内联 vs 独占**：内联在主画布上看 composition 上下文；独占适合专注编辑单个子图；两者正交，不互相耦合。
- **对话图 Qt 编辑器**：可创建 ownerState / contextState，Owner 状态列表可从 narrative 反查刷新。
