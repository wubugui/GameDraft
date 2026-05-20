# 叙事状态图策划使用规范

## 心智模型

- **Graph** 只描述单个叙事对象自己的状态机（NPC wrapper、任务 wrapper、主流程 flow 等）。
- **Transition** 只在同一 Graph 内迁移：`from` / `to` 均为本图 `stateId`。
- 图与图之间通过 **external signal** 联动；某图进入状态时会自动广播 `external:state:<graphId>:<stateId>`（可用 `emitNarrativeSignal` 补发）。
- 实体要拥有叙事状态，必须在叙事编辑器中绑定 **wrapperGraph**（`ownerType` + `ownerId`）。

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

## 工作流建议

1. 在叙事 Composition 画布绑定 wrapper → 配置 states / transitions / signal。
2. 在对话图入口或分支处放 OwnerStateNode，按 wrapper 状态接不同对白。
3. 需要读主流程阶段时用 ContextStateNode 指向 `flow_*` 或 scenario 图。
4. 剧情事件用 **emitNarrativeSignal**；响应方在 wrapper/flow 内用 Transition 监听。

## 编辑器

- **叙事状态 Web 编辑器**：真实迁移边 vs Projection 触发/读取/危险命令边。
- **对话图 Qt 编辑器**：可创建 ownerState / contextState，Owner 状态列表可从 narrative 反查刷新。
