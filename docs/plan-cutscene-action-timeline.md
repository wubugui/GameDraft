# 迭代计划：Cutscene → Action、唯一 resolveActor、Timeline

**前提**：内容未正式投产，**不做向后兼容**——不保留旧 cutscene 指令名、不做 JSON normalize、不双写。

**已定方向**：

1. **唯一一套** `ActionExecutor` + `ActionRegistry`；改变世界、动实体、音频、切场景、嵌套动作一律 **`executeAwait(ActionDef)`**。
2. **唯一** `resolveActor(id)`：**既要能解析场景内玩家/NPC，也要能解析过场 `tempActors` 临时实体**（实现顺序需在代码注释中写死，建议：**临时表 → 场景 NPC → `player`** 或等价规则）。
3. **Cutscene** 只保留 **编排**（顺序、并行、等待、快照/恢复、过场级元数据）+ **纯演出**（若未全部收进 Action，则保留极少 `present` 步骤类型；若演出也全部 Action，则过场编排层不再含业务 `switch`）。
4. **Timeline**：与上述同一执行与解析模型；**每个 Clip 完成语义 = `Promise`**，调度器负责并行与汇合。

---

## 依赖顺序（防返工）

```
resolveActor（阶段 1）
    → 补 Action + 编辑器/校验（阶段 2）
    → 重写 CutsceneManager + 换 JSON（阶段 3～4）
    → Timeline 运行时（阶段 5，可部分与阶段 3 并行设计接口）
```

**必须先完成 `resolveActor` 合并**，再大量新增依赖实体的 Action，否则过场临时 id 在 Action 路径下解析不到。

---

## 阶段 0：规格冻结

| 项 | 说明 |
|----|------|
| **`CutsceneDef` 新 schema** | 例如：`id`、可选过场级字段（目标场景、是否恢复状态等）+ `steps[]`。每项为 **`ActionDef`**，或 **`{ kind: "present", ... }`** 二选一（若演出不收进 Action）。**二选一后写死，不长期并存两套 JSON。** |
| **`resolveActor` 顺序** | 文档 + 代码注释：临时 / 场景 / `player` 的优先级与冲突规则。 |
| **临时实体 ID** | 是否强制前缀（如 `__cut_*`）可选；若强制，validator 与编辑器需一致。 |

---

## 阶段 1：`resolveActor` 唯一入口（必须先做）

- 在 **`Game`（或当前唯一注入 `ActionRegistryDeps` 的地方）** 实现 **单一** `resolveActor`：
  - 查询 **`cutsceneManager.getTempActors()`**（按 id）；
  - 再 **`sceneManager.getNpcById`**（或当前等价 API）；
  - 再 **`player`**（`id === 'player'` 等现有约定）。
- 删除或合并任何 **第二套**「按 id 找实体」的逻辑（过场内若仍保留 `resolveEntity`，应 **委托** 到同一套或 **直接删** 仅留 `resolveActor` 调用路径——以「单一真相」为准）。

**验收**：从对话、热区、过场、（后续）Timeline 调 `playNpcAnimation` / `moveEntityTo` 等，**同一 id** 在临时存在时命中临时，否则命中场景实体。

---

## 阶段 2：Action 补全 + 工具链

- 在 **`ActionRegistry`** 注册过场迁出所需的 **全部** `type`（示例，名称以最终实现为准）：
  - `moveEntityTo`（`await moveTo`）
  - `faceEntity`
  - `cutsceneSpawnActor` / `cutsceneRemoveActor`（或统一命名），仅操作 `CutsceneManager` 临时表 + 显示层挂载
  - `showEmoteAndWait`（与 fire-and-forget 的 `showEmote` 区分）
  - 其余已从过场 `switch` 迁出的世界侧行为
- **`tools/editor/shared/action_editor.py`** 的 `ACTION_TYPES`、`_PARAM_SCHEMAS` / 表单与 **`tools/editor/validator.py`** 同步；未知 `type` **报错**。
- **`src/data/types.ts`**：`CutsceneDef` / step 类型与旧 `CutsceneCommand` **替换**，不保留废弃字段。

---

## 阶段 3：重写 `CutsceneManager`

- **删除** `executeOne` 中所有 **世界侧** `case`；世界侧 **仅** `actionExecutor.executeAwait({ type, params })`。
- 保留：**顺序执行**、**`parallel` 组 → `Promise.all`**、**`wait_click` / 过场专用等待**、**快照与 `sceneSwitcher` / 恢复**（若仍由过场负责）。
- **纯演出**：要么走 **Present 小 runner**，要么已是 **Action**（handler 内调 `CutsceneRenderer`），**不要**再在 Manager 里堆业务分支。

---

## 阶段 4：数据与全局清理

- **`public/assets/data/cutscenes/index.json`**（及任何引用过场 id 的配置）按 **新 schema 一次性重写**。
- 全局 **`rg`/搜索** 旧 cutscene `type` 字符串至 **零命中**。
- 删除死代码、过时注释。

---

## 阶段 5：Timeline

**目标**：时间轴驱动 **何时** 执行；执行口 **仍是** `executeAwait` + **同一** `resolveActor`。

| 项 | 说明 |
|----|------|
| **Clip 接口** | 每个 Clip **`play(context): Promise<void>`**（或等价）；**禁止**「无 Promise 却表示异步」的半套语义。 |
| **调度器** | 解析轨道、并行轨 **`Promise.all`**、条件/跳转（若需要）、**暂停/取消**（若需要）与 **当前 `GameState`** 的交互规则在规格中单开一小节。 |
| **与 Cutscene 关系**（选一种写进规格） | **A**：Timeline **替代**当前过场 `steps` 循环，过场 JSON 只存 timeline 资源 id；**B**：过场仍是一段 timeline 的 **子图**。选定后不混用两套调度入口。 |
| **Action 上下文** | Timeline 下发 `ActionDef` 时是否与热区/对话区分 `zoneContext`——若不需要，**统一 null**；若需要，在 `GameContext`/clip context 中扩展。 |

**验收**：同一 `ActionDef` 从 Timeline、对话、热区触发，**实体解析一致**；并行轨在异步 Clip 下 **结束时刻正确**。

---

## 明确不在本文件展开（可另开文档）

- 具体每个 Action 的 `params` 字段表（由编辑器 schema 与 `ActionRegistry` 为源）。
- Timeline 编辑器 UI（若与游戏内编辑器分离，单独 PRD）。

---

## 验收总清单（发布前）

- [ ] 全仓库仅 **一处** `resolveActor` 语义，含 **临时 + 场景 + player**。
- [ ] 无旧 cutscene 专有 `type` 字符串残留。
- [ ] `validator` / 编辑器与运行时 **ACTION 集合一致**。
- [ ] Timeline Clip **全部为 Promise 完成语义**，与 `executeAwait` 行为一致。
- [ ] 过场、对话、热区、Timeline **任一入口**调用同一套 Action 时，**同一 id 解析结果一致**。

---

*本文档为架构与迭代顺序的约定；实现以仓库代码与编辑器工具为准。*
