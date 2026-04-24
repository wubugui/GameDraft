# 迭代计划：Cutscene → Action、唯一 resolveActor、Timeline

**前提**：内容未正式投产，**不做向后兼容**——不保留旧 cutscene 指令名、不做 JSON normalize、不双写。

---

## 已定方向

1. **Cutscene 是纯演出（A 类表演），没有世界副作用。** Cutscene 不调用 `setFlag`、`giveItem`、`updateQuest` 等改变游戏状态的动作。副作用由 Cutscene 的调用方（任务奖励、对话 `runActions` 等）在演出前后执行。Cutscene 只需支持**跳过**（skip = 中断 + cleanup），不需要回放副作用。
2. **A 类表演与 B/C 类表演完全分离。** A 类（Cutscene）是纯演出，由 Timeline / CutsceneManager 调度，`GameState = Cutscene`。B/C 类是游戏事件（对话图组合），可以包含副作用，由 `GraphDialogueManager` + `ActionExecutor` 驱动，`GameState = Dialogue`。两者共用底层基础设施（`ActionExecutor`、`resolveActor`），但在调度层、副作用策略、跳过机制上完全独立。Timeline 仅服务 A 类。
3. **唯一一套** `ActionExecutor` + `ActionRegistry`。动实体、音频、切场景等一律 **`executeAwait(ActionDef)`**。Cutscene 中仅允许无副作用的 Action 子集（白名单）。
4. **Action 与 Present 是两类步骤。** Action 通过 `ActionExecutor` 执行（如 `moveEntityTo`、`playSfx`），Present 是 Cutscene 自有的演出指令（如 `fadeToBlack`、`showTitle`、`showDialogue`），由 CutsceneManager / CutsceneRenderer 直接处理。用户在制作具体演出时自行决定某个步骤用哪类。
5. **唯一 `resolveActor(id)`**：既能解析场景内玩家/NPC，也能解析过场临时实体。查询顺序：**临时表 → 场景 NPC → `player`**。
6. **临时实体由 CutsceneManager 独占管理。** 临时实体 ID 不可与场景实体冲突（强制 `_cut_` 前缀），不支持跨场景，在 Cutscene cleanup 时统一销毁。业务上不与其他系统的实体混为一谈。
7. **Timeline**：与上述同一执行与解析模型；每个 Clip 完成语义 = `Promise`，调度器负责并行与汇合。
8. **编辑器围绕 Timeline 全新设计。** 老的 `cutscene_editor.py` 废弃，不做渐进改造。

---

## 依赖顺序（防返工）

```
resolveActor（阶段 1）
    → 补 Action + 工具链（阶段 2）
    → 重写 CutsceneManager + 换 JSON（阶段 3～4）
    → Timeline 运行时 + skip + 新编辑器（阶段 5，可部分与阶段 3 并行设计接口）
```

**必须先完成 `resolveActor` 合并**，再大量新增依赖实体的 Action，否则过场临时 id 在 Action 路径下解析不到。

---

## 阶段 0：规格冻结

### 输出物

1. **`src/data/types.ts` 中新的 `CutsceneDef` / `CutsceneStep` 接口**（代码即规格）。
2. **一份示例 JSON**（将现有 `prologue_opening` 按新 schema 重写，验证可用性）。
3. **`resolveActor` 优先级的代码注释**（在 `Game.ts` 或 `ActionRegistryDeps` 中标注）。
4. **Cutscene Action 白名单**（初始版本，后续按需扩充）。

### 规格要点

| 项 | 说明 |
|----|------|
| **`CutsceneDef` 新 schema** | `id` + 可选过场级字段（`targetScene`、`targetSpawnPoint`、`targetX`/`targetY`、`restoreState`）+ `steps[]`。每项为 `ActionDef`（无副作用子集）或 `PresentDef`（过场自有演出指令）。支持显式并行组。 |
| **`resolveActor` 顺序** | 临时表（`_cut_` 前缀）→ 场景 NPC → `player`。文档 + 代码注释写死。 |
| **临时实体 ID** | 强制 `_cut_` 前缀。validator 与编辑器统一校验。 |
| **Cutscene Action 白名单** | 仅允许无副作用的 Action 出现在 Cutscene steps 中。初始白名单：`moveEntityTo`、`faceEntity`、`cutsceneSpawnActor`、`cutsceneRemoveActor`、`showEmoteAndWait`、`playNpcAnimation`、`setEntityEnabled`、`playSfx`、`playBgm`、`stopBgm`。编辑器和 validator 据此校验；Present 类型不受此限。 |

### Step schema 草案

单个 step 为以下两种之一：

```typescript
// Action 步骤——通过 ActionExecutor.executeAwait 执行
interface ActionStep {
  kind: 'action';
  type: string;          // ActionRegistry 中注册的 type（白名单内）
  params: Record<string, unknown>;
}

// Present 步骤——CutsceneManager / CutsceneRenderer 直接处理
interface PresentStep {
  kind: 'present';
  type: string;          // fadeToBlack / fadeIn / showTitle / showDialogue / showImg / hideImg / showMovieBar / hideMovieBar / showSubtitle / cameraMove / cameraZoom / flashWhite / waitTime / waitClick 等
  [key: string]: unknown;
}

// 并行组——组内所有 step 同时启动，全部完成后继续
interface ParallelGroup {
  kind: 'parallel';
  tracks: CutsceneStep[];
}

type CutsceneStep = ActionStep | PresentStep | ParallelGroup;

interface CutsceneDef {
  id: string;
  steps: CutsceneStep[];
  targetScene?: string;
  targetSpawnPoint?: string;
  targetX?: number;
  targetY?: number;
  restoreState?: boolean;     // 默认 true
}
```

### 示例 JSON（`prologue_opening` 新 schema）

```json
{
  "id": "prologue_opening",
  "targetScene": "teahouse",
  "steps": [
    { "kind": "present", "type": "showImg", "image": "/assets/images/illustrations/taoist_finds_scroll_cliff.png" },
    { "kind": "action",  "type": "playSfx", "params": { "id": "story_intro" } },
    { "kind": "present", "type": "showTitle", "text": "雾津", "duration": 1000 },
    { "kind": "present", "type": "waitTime", "duration": 1000 },
    { "kind": "present", "type": "showTitle", "text": "第一天", "duration": 1000 },
    { "kind": "present", "type": "showDialogue", "speaker": "旁白", "text": "茶馆里，张叨叨正说到李天狗的段子。..." },
    { "kind": "present", "type": "hideImg" },
    { "kind": "present", "type": "fadeIn", "duration": 1000 },
    { "kind": "present", "type": "showDialogue", "speaker": "旁白", "text": "雾津，地处西南山区盆地。..." },
    { "kind": "present", "type": "showDialogue", "speaker": "旁白", "text": "你——关二狗，从小没爹没娘..." }
  ]
}
```

并行组示例：

```json
{
  "kind": "parallel",
  "tracks": [
    { "kind": "present", "type": "cameraMove", "x": 850, "y": 500, "duration": 2000 },
    { "kind": "action",  "type": "moveEntityTo", "params": { "target": "_cut_figure", "x": 700, "y": 500 } }
  ]
}
```

---

## 阶段 1：`resolveActor` 唯一入口（必须先做）

- 在 **`Game`（或当前唯一注入 `ActionRegistryDeps` 的地方）** 实现 **单一** `resolveActor`：
  1. 查询 `cutsceneManager.getTempActors()`（按 id，仅 `_cut_` 前缀命中）；
  2. 查询 `sceneManager.getNpcById`；
  3. 匹配 `player`（`id === 'player'`）。
- **删除** `CutsceneManager.resolveEntity`，改为通过构造注入或 setter 持有外部提供的 `resolveActor`（与 `ActionRegistryDeps.resolveActor` 同一个实例）。
- 删除或合并任何第二套「按 id 找实体」的逻辑——以「单一真相」为准。

**验收**：从对话、热区、过场、（后续）Timeline 调 `playNpcAnimation` / `moveEntityTo` 等，**同一 id** 在临时存在时命中临时，否则命中场景实体。临时实体 ID 必须带 `_cut_` 前缀。

---

## 阶段 2：Action 补全 + 工具链

- 在 `ActionRegistry` 注册过场迁出所需的全部无副作用 Action（名称以最终实现为准）：
  - `moveEntityTo`（`await moveTo`）
  - `faceEntity`
  - `cutsceneSpawnActor` / `cutsceneRemoveActor`——仅操作 `CutsceneManager` 临时表 + 显示层挂载；spawn 时 validator 校验 id 带 `_cut_` 前缀
  - `showEmoteAndWait`（与 fire-and-forget 的 `showEmote` 区分）
  - 其余已从过场 `switch` 迁出的无副作用行为
- **`tools/editor/shared/action_editor.py`** 的 `ACTION_TYPES`、`_PARAM_SCHEMAS` 与 `tools/editor/validator.py` 同步；未知 `type` **报错**。
- **`src/data/types.ts`**：`CutsceneDef` / `CutsceneStep` / `PresentDef` / `ParallelGroup` 替换旧 `CutsceneCommand`，不保留废弃字段。
- **validator 增加 Cutscene Action 白名单校验**：Cutscene steps 中出现的 `kind: 'action'` 步骤，其 `type` 必须在白名单内，否则报错。

---

## 阶段 3：重写 `CutsceneManager`

- **删除** `executeOne` 中所有世界侧 `case`（`set_flag`、`play_bgm`、`switch_scene` 等旧命令全部移除）。
- **Action 步骤**：统一 `actionExecutor.executeAwait({ type, params })`。
- **Present 步骤**：由 `CutsceneManager` 内的 Present runner 处理，调用 `CutsceneRenderer` 对应方法。Present runner 为一个简单的 `switch`，仅处理 Cutscene 自有的演出指令（`fadeToBlack`、`showTitle`、`showDialogue`、`showImg`、`cameraMove` 等），不包含任何游戏逻辑。
- **并行组**：`kind === 'parallel'` 时，递归执行组内所有 step，`Promise.all` 汇合。
- **保留**：顺序执行、快照（`saveAndTransition` / `restoreSnapshot`）、`waitClick` / 过场专用等待。
- **临时实体管理**：`cutsceneSpawnActor` / `cutsceneRemoveActor` Action 通过 `ActionRegistryDeps` 代理调用 `CutsceneManager` 的临时表操作。CutsceneManager 在 `cleanup()` 中统一销毁所有临时实体。

---

## 阶段 4：数据与全局清理

- `public/assets/data/cutscenes/index.json`（及任何引用过场 id 的配置）按新 schema 一次性重写。
- 全局搜索旧 cutscene `type` 字符串（`fade_black`、`show_dialogue`、`entity_move` 等旧命名）至**零命中**。
- 删除 `cutscene_editor.py` 中的 `COMMAND_TYPES`、`_CMD_PARAMS`、`CommandWidget` 等旧代码。
- 删除死代码、过时注释。

---

## 阶段 5：Timeline 运行时 + skip + 新编辑器

### 5a 时间模型

**选型**：Cue-list 主干 + 结构化并行段。

- 保持顺序执行为主干（await-chain）。
- 并行需求通过显式 `ParallelGroup`（`kind: 'parallel'`）实现。组内所有 step 同时启动，`Promise.all` 汇合后继续主干。
- 不引入绝对时间定位（track-based）。Cutscene 中存在非确定时长步骤（如 `showDialogue` 等待点击），绝对时间模型不适用。
- 不需要 seek / 倒放。

**理由**：A 类表演是纯演出，只需跳过不需要 seek。当前数据中大量使用等待玩家交互的步骤，顺序执行模型与业务需求匹配。`ParallelGroup` 是对当前后附式 `parallel` 标记的结构化升级，语义清晰、编辑器友好。

### 5b skip 实现

基于 Cutscene 无副作用的前提，skip 实现简单：

```
skip 流程：
  1. 设置 skipping = true
  2. 所有正在 await 的 Promise 立即 resolve
     - Present 类（fadeToBlack / cameraMove 等）：跳到终态
     - Action 类（moveEntityTo 等）：中断动画、实体位置跳到目标
     - 等待类（waitClick / showDialogue）：立即 resolve
  3. executeCommands 循环检测 skipping 标志，跳过后续 step
  4. 执行 cleanup()（清理临时实体、overlay、movie bar 等渲染残留）
  5. 执行 restoreSnapshot()（若有场景/镜头快照）
  6. emit cutscene:end
```

无需回放副作用（因为 Cutscene 没有副作用），无需记录「已执行到哪一步」。

### 5c Clip 接口与调度器

| 项 | 说明 |
|----|------|
| **Clip 接口** | 每个 Clip `play(context): Promise<void>`。禁止「无 Promise 却表示异步」的半套语义。 |
| **调度器** | 解析 `steps` 数组，按 `kind` 分派到 Action runner / Present runner / 并行组递归。支持 `skipping` 标志提前退出。 |
| **与 Cutscene 关系** | **Timeline 替代当前 steps 循环**。`CutsceneManager.startCutscene` 内部创建 Timeline 实例并 `await timeline.play()`。过场 JSON 中的 `steps` 即是 Timeline 数据。不混用两套调度入口。 |
| **Action 上下文** | Timeline 下发 `ActionDef` 时 `zoneContext` 统一为 `null`（Cutscene 不涉及区域逻辑）。 |

### 5d 新编辑器接口约束

新编辑器独立于老 `cutscene_editor.py` 从零设计，以下为对运行时 schema 的约束（完整 PRD 另开文档）：

1. 编辑器读写的 JSON schema 与 `CutsceneDef` TypeScript 接口一一对应。
2. 每个 step 要么是 `ActionStep`（复用 `action_editor.py` 的 `ActionRow` 组件，仅展示白名单内 type）、要么是 `PresentStep`（新的演出编辑组件）、要么是 `ParallelGroup`（子步骤列表）。
3. 并行组在编辑器中渲染为可视化多轨道视图。
4. `cutsceneSpawnActor` 的 `id` 参数自动添加 `_cut_` 前缀或校验前缀。
5. validator 基于 Cutscene Action 白名单校验，白名单外的 Action type 在 Cutscene 中报错。
6. 支持 Play 按钮（与当前 DevMode API 联动预览演出）。

---

## 明确不在本文件展开（可另开文档）

- 具体每个 Action 的 `params` 字段表（由编辑器 schema 与 `ActionRegistry` 为源）。
- 新 Timeline 编辑器的完整 PRD（UI 布局、交互流程、技术选型）。
- B/C 类表演（对话图组合）的设计——它们走现有对话图体系，不在本计划范围内。

---

## 验收总清单（发布前）

- [ ] 全仓库仅 **一处** `resolveActor` 语义，含 **临时（`_cut_` 前缀）+ 场景 + player**。
- [ ] 无旧 cutscene 专有 `type` 字符串残留（`fade_black`、`entity_move` 等旧命名零命中）。
- [ ] `validator` / 编辑器与运行时 **Action 集合一致**。
- [ ] Cutscene steps 中不出现副作用类 Action（validator 白名单校验通过）。
- [ ] 临时实体 ID 全部带 `_cut_` 前缀（validator 校验通过）。
- [ ] Timeline Clip 全部为 **Promise 完成语义**，与 `executeAwait` 行为一致。
- [ ] 过场、对话、热区、Timeline 任一入口调用同一套 Action 时，**同一 id 解析结果一致**。
- [ ] Cutscene 支持 **skip**（中断 + cleanup + restoreSnapshot，无需回放副作用）。
- [ ] 老 `cutscene_editor.py` 废弃，新编辑器围绕 Timeline schema 实现。

---

*本文档为架构与迭代顺序的约定；实现以仓库代码与编辑器工具为准。*
