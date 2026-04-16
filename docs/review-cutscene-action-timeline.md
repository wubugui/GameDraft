# 评审：Cutscene → Action、唯一 resolveActor、Timeline 迭代计划

**评审对象**：`docs/plan-cutscene-action-timeline.md`
**评审依据**：当前仓库代码深度分析 + 业界游戏 timeline 系统最佳实践

---

## 核心约束（来自业务澄清）

以下五条约束作为本评审的基础假设：

1. **Cutscene 无副作用，只需支持跳过**。Cutscene 是纯粹用来看的，它不执行 `setFlag`、`giveItem` 等改变游戏世界状态的动作。跳过 = 直接结束，无需回放副作用。
2. **Action 与 Present 是两类东西**。用户在实现具体演出时自行决定某个步骤是 Action 还是 Present，架构不做强制统一假设。
3. **临时实体由 CutsceneManager 独占管理**。临时实体的系统 ID 不可与其他实体冲突，不需要跨场景行为，但必须与场景实体在业务上隔离。
4. **编辑器围绕 Timeline 全新设计**。老的 `cutscene_editor.py` 废弃，不做渐进改造。
5. **Cutscene（A 类表演）与对话图（B/C 类表演）是完全不同的东西**。对话图是游戏事件，可以组合成 B/C 类表演；Cutscene 是独立的 A 类纯演出。两者不应混为一谈。

---

## 一、总体评价

计划方向正确，抓住了当前代码中两个核心架构痛点：

1. **实体解析二元性**：`Game.ts:382` 的 `resolveActor`（不含临时实体）与 `CutsceneManager:320-324` 的 `resolveEntity`（含临时实体）是两套独立解析路径。
2. **CutsceneManager 的巨型 switch**：`executeOne` 中 30+ 个 case 分支，大量本质上是对 `ActionExecutor.executeAwait` 的手动 wrapper。

阶段 1-4 的依赖顺序合理，「不做向后兼容」的前提判断准确。但计划在以下几个关键维度需要补充和修正。

---

## 二、优点

### 2.1 依赖顺序清晰，防返工思路正确

```
resolveActor（阶段 1）
    → 补 Action + 编辑器/校验（阶段 2）
    → 重写 CutsceneManager + 换 JSON（阶段 3～4）
    → Timeline 运行时（阶段 5）
```

`resolveActor` 合并是所有后续工作的前提，这个判断准确。当前两套解析路径：

- `Game.ts:382`——`resolveActor: (id) => id === 'player' ? this.player : this.sceneManager.getNpcById(id)` 不含临时实体
- `CutsceneManager:320-324`——先查 `tempActors`，再查 `entityResolver`（即上面那个）

合并后统一为一套才能让新增的 `moveEntityTo`、`cutsceneSpawnActor` 等 Action 在过场上下文中正确工作。

### 2.2 「不做向后兼容」的决策务实

当前 `cutscenes/index.json` 仅 9 条演出，内容未投产，果断抛弃旧 schema 是正确的。

### 2.3 Promise 完成语义统一

「每个 Clip `play(context): Promise<void>`」与当前 `ActionExecutor.executeAwait` 一脉相承，是正确的接口约定。

### 2.4 验收清单可量化

5 条验收条目都能通过全仓库搜索 / 类型检查 / 集合比对自动验证。

---

## 三、不足与修改建议

### 3.1 [严重] Cutscene 无副作用这一核心性质未在计划中体现

计划当前的措辞（「改变世界、动实体、音频、切场景、嵌套动作一律 `executeAwait(ActionDef)`」）暗示 Cutscene 会执行 `setFlag`、`giveItem` 等改变世界状态的动作。但根据约束 1，**Cutscene 是纯演出，没有副作用**。

这条性质对架构的影响是根本性的：

- **跳过变得简单**：不需要「快速回放所有副作用」的复杂逻辑，skip 直接等于中断 + cleanup + 恢复快照。当前代码中 `CutsceneManager` 已有 `snapshot` / `restoreSnapshot` 机制，skip 只需在此基础上加一个提前退出路径。
- **Action 与 Present 的关系变清晰**：既然 Cutscene 无副作用，那么 Cutscene 中调用的 Action 应该仅限于**无副作用的 Action**（如 `moveEntityTo`、`cameraMove`、`playSfx`）。副作用类 Action（`setFlag`、`giveItem`）不应出现在 Cutscene 内部——它们属于触发 Cutscene 前后的游戏逻辑。
- **与 B/C 类表演的根本区别**：B/C 类表演（对话图组合）可以包含副作用（因为它们是游戏事件）。A 类表演（Cutscene）不可以。这不是用户偏好，而是架构约束。

**建议**：

1. 在计划的「已定方向」第 1 条后补充：**Cutscene 为纯演出，不产生世界副作用（不调用 `setFlag`、`giveItem` 等状态变更 Action）。副作用由 Cutscene 的调用方（任务奖励、对话 `runActions` 等）在演出前后执行。**
2. 在阶段 0 规格冻结中增加：**Cutscene steps 中允许的 Action type 白名单 vs 黑名单策略**。建议用白名单——只有明确标记为「无副作用」的 Action 类型可以出现在 Cutscene 中。编辑器和 validator 据此校验。
3. 在阶段 5 中增加 skip 的具体实现策略，基于无副作用的假设可以大幅简化：

```
skip 流程：
  1. 设置 skipping = true
  2. 所有正在 await 的 Promise 立即 resolve（演出类 Action 跳到终态）
  3. 执行 cleanup()（清理临时实体、overlay、movie bar 等）
  4. 执行 restoreSnapshot()（若有场景/镜头快照）
  5. emit cutscene:end
```

### 3.2 [严重] Timeline 阶段 5 缺乏时间模型定义

阶段 5 是计划的最终目标，但只有一张表格和几个待定选项。以下关键架构决策需要在规格阶段确定：

#### 3.2.1 时间模型选型

当前 `CutsceneManager.executeCommands` 是纯 command-list，没有时间轴概念。计划提出 Timeline 但未定义其核心时间模型。

业界两种主要模式：

| 模式 | 代表 | 优势 | 劣势 | 适用场景 |
|------|------|------|------|---------|
| Track-based 绝对时间 | Unity Timeline | 精确同步、可 seek、编辑器友好 | 不适合非确定时长的操作 | 纯动画、镜头语言 |
| Cue-list 顺序执行 | Godot CutsceneDirector | 天然支持 await、灵活 | 无法 seek/倒放 | 叙事、交互式 |

由于 Cutscene 是纯演出（无副作用、只需跳过不需要 seek），且当前数据中存在非确定时长的步骤（如 `show_dialogue` 等待点击），建议采用：

**Cue-list 主干 + 结构化并行段**。即保持顺序执行为主（await-chain），在需要的地方用显式并行组实现多轨同步。这是对当前 `parallel` 标记的结构化升级，而非引入完全不同的调度模型。

#### 3.2.2 并行组 JSON schema

当前后附式 `parallel` 标记存在语义模糊问题：

```json
{ "type": "camera_move", "x": 300, "y": 300, "duration": 1500 },
{ "type": "camera_zoom", "scale": 1.3, "duration": 1500, "parallel": true },
{ "type": "entity_move", "target": "npc_a", "x": 700, "y": 500, "parallel": true }
```

这里第 3 条的 `parallel` 是与第 1 条还是第 2 条并行？（实际代码是全部一组 `Promise.all`，但可读性差。）

**建议**：定义显式并行组：

```json
{
  "kind": "parallel",
  "tracks": [
    { "type": "cameraMove", "params": { "x": 300, "y": 300, "duration": 1500 } },
    { "type": "fadingZoom", "params": { "zoom": 1.3, "durationMs": 1500 } },
    { "type": "moveEntityTo", "params": { "target": "npc_a", "x": 700, "y": 500 } }
  ]
}
```

这样 JSON 自描述性强，编辑器可直接渲染为多轨道视图。

### 3.3 [中等] 临时实体的隔离边界需要更具体

计划提到 `resolveActor` 合并时查询顺序为「临时表 → 场景 NPC → player」，但根据约束 3，临时实体需要在业务上与其他系统实体隔离。当前的合并方案存在隐患：

**问题**：合并后的 `resolveActor` 是全局统一入口，这意味着**非 Cutscene 上下文**（如对话图 `runActions` 中的 `playNpcAnimation`）也会查到临时实体。但临时实体是 Cutscene 私有的，不应该被外部系统看到。

当前代码中这个问题不明显，因为临时实体只在 Cutscene 播放期间存在，且 Cutscene 播放时 GameState 为 `Cutscene`，其他系统基本不活跃。但如果未来 B/C 类表演也使用 `resolveActor`（它们是对话图组合的游戏事件），就可能产生命名冲突。

**建议**：

1. **ID 前缀强制化**：临时实体 ID 必须带 `_cut_` 前缀（或等价规则），编辑器和 validator 在 `cutsceneSpawnActor` 的 `id` 参数上强制校验。这样即使 `resolveActor` 全局可见，也不会与场景实体冲突。
2. **`resolveActor` 内部实现**：查询顺序保持「临时表 → 场景 NPC → player」，但临时表只在 `cutsceneManager.isPlaying` 时参与查询（或始终参与，靠 ID 前缀保证不冲突）。
3. **cleanup 时机**：临时实体在 `CutsceneManager.cleanup()` 中统一销毁，不依赖场景切换。这与当前实现一致。

### 3.4 [中等] A / B / C 类表演的架构边界需要写入计划

计划只讨论了 Cutscene（A 类），没有从架构上明确 B/C 类表演（对话图组合）与 A 类的关系。这很重要，因为两者共用部分基础设施（`resolveActor`、`ActionExecutor`、`CutsceneRenderer` 的部分能力），但业务语义完全不同：

| 维度 | A 类（Cutscene） | B/C 类（对话图组合） |
|------|-----------------|-------------------|
| 本质 | 纯演出 | 游戏事件 |
| 副作用 | 无 | 有（`setFlag`、`giveItem` 等） |
| 跳过 | 直接中断 + cleanup | 需要回放副作用或不可跳过 |
| 调度 | Timeline / CutsceneManager | 对话图 `runActions` + `ActionExecutor` |
| GameState | `Cutscene` | `Dialogue` |
| 临时实体 | 支持（CutsceneManager 管理） | 不支持 |
| 镜头控制 | 全权控制 | 受限（对话级缩放） |

**建议**：在计划「已定方向」部分增加一条：

> **A 类表演（Cutscene）与 B/C 类表演（对话图组合）共用底层执行基础设施（`ActionExecutor`、`resolveActor`），但在调度层、副作用策略、跳过机制上完全独立。Timeline 仅服务 A 类表演。B/C 类表演由现有对话图 `runActions` + `ActionExecutor` 驱动，不走 Timeline。**

### 3.5 [中等] 编辑器全新设计的范围和依赖需要明确

约束 4 确认老编辑器废弃、围绕 Timeline 全新设计。但计划当前的「明确不在本文件展开——Timeline 编辑器 UI 若与游戏内编辑器分离，单独 PRD」过于草率。

编辑器不仅是 UI 问题，它与运行时 schema 强耦合：

- 编辑器需要知道哪些 Action type 可以出现在 Cutscene 中（白名单，见 3.1）
- 编辑器需要渲染并行组结构（见 3.2.2）
- 编辑器需要支持 Present 步骤的编辑（与 Action 不同的表单）
- 编辑器需要临时实体 ID 的前缀校验（见 3.3）

**建议**：在阶段 5 中增加编辑器的**接口约束**（不需要完整 PRD，但需要明确编辑器对运行时 schema 的假设），例如：

1. 编辑器读写的 JSON schema 与 `CutsceneDef` TypeScript 接口一一对应
2. 每个 step 要么是 `ActionDef`（复用 `action_editor.py` 的 `ActionRow` 组件）、要么是 `PresentDef`（新的演出编辑组件）
3. 并行组在编辑器中渲染为多轨道视图（横向时间轴 + 纵向轨道）
4. validator 基于运行时 `ActionRegistry` 和 Cutscene 允许的 type 白名单进行校验

### 3.6 [低] 阶段 0 输出物需要具体化

阶段 0「规格冻结」列了 3 个表格项，但没有定义输出物。

**建议**：阶段 0 产出以下内容：

1. **`src/data/types.ts` 中新的 `CutsceneDef` / `CutsceneStep` 接口**——代码即规格
2. **一份示例 JSON**——将现有 `prologue_opening` 按新 schema 重写，验证 schema 的可用性
3. **`resolveActor` 优先级的代码注释**——在 `Game.ts` 或 `ActionRegistryDeps` 中标注
4. **Cutscene 允许的 Action type 白名单**——初始版本，后续可按需扩充

### 3.7 [低] 验收清单需要补充 skip 和表演分类相关条目

当前验收清单 5 条覆盖了 `resolveActor` 统一、旧类型清理、编辑器一致性、Promise 语义。但缺少：

- Cutscene skip 功能验收
- A / B / C 类表演边界验收（Cutscene 中不出现副作用 Action）
- 临时实体 ID 隔离验收

**建议补充**：

```
- [ ] Cutscene 支持 skip（中断 + cleanup + restoreSnapshot）
- [ ] Cutscene steps 中不出现副作用类 Action（validator 校验通过）
- [ ] 临时实体 ID 与场景实体 ID 无冲突（validator 校验或 ID 前缀约束）
- [ ] 老 cutscene_editor.py 废弃，新编辑器围绕 Timeline schema 实现
```

---

## 四、与业界实践的对照

### 4.1 Unity Timeline

Unity Timeline 的 track-based 模型适合精确的动画同步和镜头语言。但 Unity 也区分 **Timeline 控制的纯表演** 和 **事件触发的游戏逻辑**（通过 Signal Emitter/Receiver 将 Timeline 与游戏事件连接）。

**启示**：A 类 vs B/C 类的分离与 Unity 的「Timeline 表演 vs Signal 事件」模式一致。Cutscene 内不放游戏逻辑，通过 `cutscene:end` 事件触发后续游戏行为。

### 4.2 Godot CutsceneDirector

Godot CutsceneDirector 模式使用 `await` 链 + 信号，也明确区分了 `play_timeline`（纯动画）和 `load_dialogue`（游戏交互）。当前 `CutsceneManager` 的 `async/await + Promise` 风格与此高度相似。

**启示**：CutsceneDirector 的「模块化 action 函数 + await 链」思路适合本项目。Timeline 可以是对这个模式的结构化升级（增加并行组和 skip），而非引入完全不同的调度模型。

### 4.3 RPG Maker 事件系统

RPG Maker 的事件系统是典型的「命令列表 + 并行进程」模式，演出和游戏逻辑混在同一个事件中。这种设计简单但缺乏隔离，导致大型项目中演出和游戏逻辑互相干扰。

**启示**：A / B / C 类分离是避免 RPG Maker 式混乱的正确方向。

### 4.4 综合对照

| 实践 | 当前代码 | 计划覆盖 | 约束后状态 |
|------|---------|---------|-----------|
| 统一执行口 | 部分 | 是（阶段 2-3） | 保持 |
| 统一实体解析 | 否 | 是（阶段 1） | 保持 |
| 演出 vs 游戏事件分离 | 否（混在一起） | **未明确** | **需补充** |
| 可跳过 | 否 | 未提及 | **需补充**（无副作用简化了实现） |
| 临时实体隔离 | 部分 | 部分 | **需补充** ID 约束 |
| 编辑器全新设计 | 未计划 | 提及但未展开 | **需补充**接口约束 |
| 并行组结构化 | 否 | 模糊 | **需补充** JSON schema |

---

## 五、修改建议汇总（按优先级）

### P0（阻塞后续设计）

1. **在「已定方向」中明确 Cutscene 无副作用**。这是架构基石，影响 skip 实现、Action 白名单、A/B/C 类边界等所有后续决策。

2. **在阶段 0 中定义 Cutscene 允许的 Action type 白名单策略**。建议初始白名单：`moveEntityTo`、`faceEntity`、`cutsceneSpawnActor`、`cutsceneRemoveActor`、`showEmoteAndWait`、`playNpcAnimation`、`setEntityEnabled`、`playSfx`、`playBgm`、`stopBgm`。编辑器和 validator 据此校验。present 类型不受此限（它们是 Cutscene 自有的，不走 ActionExecutor）。

3. **在阶段 5 中定义时间模型**。建议：cue-list 主干 + 结构化并行段。给出并行组 JSON schema。

### P1（可在实现中细化）

4. **临时实体 ID 前缀强制化**。建议 `_cut_` 前缀，编辑器 `cutsceneSpawnActor` 的 id 字段自动加前缀或校验。

5. **在「已定方向」中补充 A/B/C 类表演的架构边界**。明确 Timeline 仅服务 A 类，B/C 类走现有对话图。

6. **在阶段 5 中增加 skip 实现策略**。基于无副作用前提：中断 + cleanup + restoreSnapshot。

### P2（低优先级）

7. **阶段 0 输出物具体化**：TypeScript 接口 + 示例 JSON + resolveActor 注释 + Action 白名单。

8. **验收清单补充** skip / 表演分类 / 临时实体隔离相关条目。

9. **编辑器接口约束**：不需要完整 PRD，但需在阶段 5 中明确编辑器对 runtime schema 的假设。

---

## 六、结论

计划的核心方向——统一 `resolveActor`、将 Cutscene 世界侧行为收编为 Action、引入 Timeline——完全正确。阶段 1-4 的执行路径设计质量较高。

主要需要补充的是：

1. **Cutscene 无副作用**这条核心性质必须写入计划，它大幅简化 skip 实现并明确 Action/Present 的边界
2. **A/B/C 类表演的架构分离**需要在计划中有一句话定性，防止后续实现时混淆
3. **Timeline 的时间模型和并行组 schema** 需要从「待定」变为「确定」

其余建议（临时实体 ID 前缀、编辑器接口约束、验收清单补充）可在实现过程中逐步细化。
