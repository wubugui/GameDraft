# 架构审查报告

**审查时间戳：** 2026-04-04 21:30

**审查范围：** `src/` 全部 TypeScript 源码（core / systems / rendering / entities / ui / data / debug），对照 `游戏架构设计文档.md` 中的 8 条铁律与配置驱动清单。

---

## 文档同步说明

以下变更已在本次审查中同步到 `游戏架构设计文档.md`（以代码为准）：

1. **系统层概览图**：将"NPC"替换为"区域"——代码中 NPC 是实体（`entities/Npc.ts`），不是独立系统；区域系统 `ZoneSystem` 此前未体现在概览图中。
2. **核心层概览图**：补充"深度系统"——`SceneDepthSystem` 是核心层的重要组件。
3. **新增章节 3.9 SceneDepthSystem**：记录深度图/碰撞图/遮挡滤镜的职责与 API。
4. **新增章节 4.4 DepthOcclusionFilter**：记录深度遮挡滤镜。
5. **目录结构补全**：添加 `core/SceneDepthSystem.ts`、`core/depthLog.ts`、`rendering/DepthOcclusionFilter.ts`、`rendering/BackgroundDebugFilter.ts`、`debug/DepthDebugVisualizer.ts`。

---

## 问题列表

### 1. 耦合

- [ ] **1-1 | SceneManager 直接操作 Renderer 渲染层**
  - 位置：`src/systems/SceneManager.ts`（构造函数第 3 参数、第 1/148/158/175/198-204/310-314 行等）
  - 描述：`SceneManager` 直接导入 `pixi.js` 的 `Container`、`Graphics`、`Sprite`，向 `renderer.backgroundLayer`、`renderer.entityLayer`、`renderer.uiLayer` 添加/移除子节点，自行创建淡入淡出遮罩（`fadeOverlay`）并用 `requestAnimationFrame` 驱动动画。作为系统层模块，它承担了大量本应由渲染层封装的职责。
  - 违反原则：铁律 1（分层依赖）——系统层对渲染层的依赖超出了"通过封装好的渲染/实体接口"的范畴，直接操作了底层 Pixi 对象。

- [ ] **1-2 | EmoteBubbleManager 直接创建 Pixi 渲染对象**
  - 位置：`src/systems/EmoteBubbleManager.ts`（第 1 行 `import { Container, Graphics, Text } from 'pixi.js'`，第 17-43 行）
  - 描述：作为 `systems/` 下的模块，直接构造 `Container`、`Graphics`、`Text` 等渲染元素。
  - 违反原则：铁律 1（分层依赖）——系统层不应直接创建渲染层原语，应通过渲染层封装（类似 `CutsceneRenderer` 对 `CutsceneManager` 的关系）。

- [ ] **1-3 | EncounterManager 独立加载 rules.json，与 RulesManager 数据重复**
  - 位置：`src/systems/EncounterManager.ts`（第 44-56 行）
  - 描述：`EncounterManager.loadDefs()` 独立 `fetch` 并缓存 `rules.json` 中的规则定义和碎片定义（`ruleDefs`、`fragmentDefs`），而 `RulesManager` 已经加载并管理同一份数据。两个同层系统各自维护一份相同的数据副本。
  - 违反原则：铁律 2（系统解耦）——虽然没有直接互调，但数据重复加载是隐性耦合：修改数据格式需要同步两处解析逻辑。应通过 FlagStore 标记或 GameContext 扩展来让 EncounterManager 读取所需的规则状态。

- [ ] **1-4 | DialogueManager 维护 ACTION_PARAM_NAMES 映射表，与 ActionRegistry 平行耦合**
  - 位置：`src/systems/DialogueManager.ts`（第 9-27 行）
  - 描述：`DialogueManager` 内硬编码了一个 `ACTION_PARAM_NAMES` 字典，列出每种动作类型对应的参数名列表。每当 `ActionRegistry` 新增/修改动作类型时，此字典也须手工同步，否则 ink 标签解析会出错。
  - 违反原则：铁律 6（统一动作执行）——对话标签的动作解析与 ActionExecutor 的 handler 注册之间缺乏单一事实源，形成平行维护的耦合。

### 2. 过度设计

- [ ] **2-1 | SceneManager 的回调 setter 模式过多**
  - 位置：`src/systems/SceneManager.ts`（第 62-88 行，7 个 `set*` 方法）
  - 描述：`SceneManager` 通过 7 个独立的回调 setter（`setPlayerPositionSetter`、`setCameraSetter`、`setAudioApplier`、`setZoneSetter`、`setInteractionSetter`、`setDepthLoader`、`setDepthUnloader`）接收外部注入。每个 setter 保存一个可空回调并在 `loadScene` 中通过 `?.()` 调用。虽然意图是解耦 SceneManager 与其他系统，但回调数量过多导致 Game 中的装配代码繁琐（`setupSceneManager` 约 50 行纯 setter 调用），且不如 EventBus 或接口注入清晰。
  - 违反原则：有过度设计倾向——可考虑用事件或统一回调接口替代。

### 3. 分层违反

- [ ] **3-1 | 多个系统绕过 AssetManager 直接 fetch**
  - 位置：`src/systems/` 下全部 7 个系统（ArchiveManager、CutsceneManager、AudioManager、EncounterManager、RulesManager、InventoryManager、QuestManager）、`src/core/StringsProvider.ts`、`src/core/Game.ts`（2 处）
  - 描述：这些模块均使用 `fetch(resolveAssetPath(...))` 直接加载 JSON 配置，而 `AssetManager` 提供了带缓存的 `loadJson()` 方法可以替代。系统层直接操作网络请求属于越过了核心层封装的资源管理。
  - 违反原则：铁律 1（分层依赖）——系统层应通过核心层的 `AssetManager` 统一管理资源加载，而非各自直接 `fetch`。同时这些系统的构造函数均未接收 `AssetManager` 实例（`DialogueManager` 和 `SceneManager` 例外）。

### 4. 生命周期与销毁

- [ ] **4-1 | DayManager 构造函数中触发 flag:changed 事件**
  - 位置：`src/systems/DayManager.ts`（第 18 行 `this.syncFlag()`）
  - 描述：`DayManager` 构造函数调用 `syncFlag()` → `flagStore.set('current_day', 1)` → 触发 `flag:changed` 事件。此时其他系统（如 `QuestManager`、`ArchiveManager`）可能尚未完成初始化（`init()` 尚未被调用），收到事件后可能执行不完整的逻辑。
  - 违反原则：铁律 8（完整生命周期）——构造阶段不应产生副作用，初始化逻辑应在 `init()` 中执行。

- [ ] **4-2 | Game.destroy() 中 UI 面板销毁路径不统一**
  - 位置：`src/core/Game.ts`（第 619-660 行）
  - 描述：`Game.destroy()` 手动销毁了部分 UI（`inspectBox`、`pickupNotification`、`dialogueUI`、`encounterUI`、`hud`、`notificationUI`、`bookReaderUI`、`emoteBubbleManager`），其余 UI 面板（`questPanelUI`、`inventoryUI`、`rulesPanelUI`、`shopUI`、`mapUI` 等）依赖 `stateController.destroy()` 间接销毁。两条销毁路径混合使用，容易遗漏或重复销毁。
  - 违反原则：铁律 8（完整生命周期）——销毁流程应有统一、可预测的路径。

- [ ] **4-3 | 多个系统 destroy() 不清理已写入 FlagStore 的标记**
  - 位置：`src/systems/InventoryManager.ts`（第 167-171 行）、`RulesManager.ts`（第 223-228 行）、`QuestManager.ts`（第 172-176 行）等
  - 描述：这些系统在运行期间通过 `flagStore.set()` 写入大量标记（如 `has_item_*`、`rule_*_acquired`、`quest_*_status` 等），但 `destroy()` 方法只清理了自身内部状态，未回收 FlagStore 中遗留的标记。若系统被销毁后重建（如存档加载），旧标记可能残留。
  - 违反原则：铁律 8（完整生命周期）——销毁后不应留任何状态残留。不过实际场景中 `FlagStore.deserialize()` 会整体覆盖，此问题影响有限。

- [ ] **4-4 | CutsceneManager 使用 window 事件监听器**
  - 位置：`src/systems/CutsceneManager.ts`（第 113-114 行、第 118-119 行）
  - 描述：演出播放时直接 `window.addEventListener('click', ...)` 和 `window.addEventListener('keydown', ...)`。虽然 `destroy()` 和播放结束后有清理，但这是系统层直接操作全局 DOM 事件，绕过了 `InputManager` 的输入管理体系。
  - 违反原则：铁律 1（分层依赖）/铁律 8（完整生命周期）——系统层不应直接操作 DOM，应通过 InputManager 或 EventBus 获取输入。

### 5. 数据驱动与配置驱动

- [ ] **5-1 | Game.ts 硬编码业务 ID 作为配置默认值**
  - 位置：`src/core/Game.ts`（第 121-124 行）
  - 描述：`gameConfig` 的默认值包含 `'test_room_a'`（场景 ID）和 `'main_01'`（任务 ID）。虽然 `loadGameConfig()` 会从 `game_config.json` 覆盖，但在配置文件缺失时这些硬编码值会生效。
  - 违反原则：铁律 4（数据驱动）——"代码中不出现具体的物件名、规矩名、NPC名、任务ID"。默认值也应从配置中获取或使用无业务含义的占位值。

- [ ] **5-2 | SaveManager 构造函数默认参数包含场景 ID**
  - 位置：`src/core/SaveManager.ts`（第 23 行 `fallbackScene: string = 'test_room_a'`）
  - 描述：`SaveManager` 构造函数的 `fallbackScene` 参数默认值为 `'test_room_a'`，虽然 `Game` 实际会传入配置值，但参数默认值仍硬编码了业务 ID。
  - 违反原则：铁律 4（数据驱动）。

### 6. 统一动作执行

- [ ] **6-1 | DialogueManager 的 ACTION_PARAM_NAMES 与 ActionExecutor 注册表不同源**
  - 位置：`src/systems/DialogueManager.ts`（第 9-27 行）
  - 描述：（同 1-4）ink 标签的动作类型-参数名映射独立于 ActionExecutor 的 handler 注册。新增动作类型需同步修改两处。这不仅是耦合问题，也是统一动作执行机制的漏洞：tag 解析与 handler 注册没有共享同一个动作定义源。
  - 违反原则：铁律 6（统一动作执行）。

### 7. 接口与约定

- [ ] **7-1 | EmoteBubbleManager 未实现 IGameSystem 但承担系统职责**
  - 位置：`src/systems/EmoteBubbleManager.ts`
  - 描述：`EmoteBubbleManager` 位于 `systems/` 目录下，具备 `update(dt)` 和 `destroy()` 方法，由 `Game.tick()` 每帧调用，但不实现 `IGameSystem`，不在 `registeredSystems` 列表中，没有 `init(ctx)` / `serialize()` / `deserialize()`。
  - 违反原则：铁律 7（接口约定）——文档约定所有系统实现 `IGameSystem` 保证生命周期和存档行为一致。即便文档将其定义为"辅助模块"，其实际角色（每帧更新、管理渲染资源、有销毁逻辑）与系统无异。

- [ ] **7-2 | SceneDepthSystem 未实现 IGameSystem**
  - 位置：`src/core/SceneDepthSystem.ts`
  - 描述：`SceneDepthSystem` 具备类似系统的完整生命周期方法（`load`/`unload`/`updatePerFrame`），由 `Game` 直接管理，但不实现 `IGameSystem`，不在 `registeredSystems` 中，没有标准的 `init(ctx)` / `serialize()` / `deserialize()` / `destroy()`。
  - 违反原则：铁律 7（接口约定）——其生命周期管理完全散落在 `Game.ts` 中，增加了维护成本。

### 8. 其他

- [ ] **8-1 | Player.ts 硬编码动画状态名**
  - 位置：`src/entities/Player.ts`（第 75/94/128/130/133 行）
  - 描述：`Player` 中硬编码了 `'idle'`、`'walk'`、`'run'` 等动画状态名。这些名称与 `player_anim.json` 的 `states` key 形成隐式约定，没有统一的常量或类型约束。
  - 违反原则：铁律 4（数据驱动）——动画状态名应由配置定义并提供类型安全的访问方式。

- [ ] **8-2 | Game.ts 占位动画 fallback 中硬编码帧配置**
  - 位置：`src/core/Game.ts`（第 386-397 行）
  - 描述：`setupPlayer()` 中 `player_anim.json` 加载失败时使用硬编码的动画定义（`cols: 6, rows: 1, states: { idle: ..., walk: ..., run: ... }`）。
  - 违反原则：铁律 4（数据驱动）——占位配置可内置，但不应与业务动画状态绑定。

- [ ] **8-3 | GameStateController 直接操作 window 键盘事件**
  - 位置：`src/core/GameStateController.ts`（第 40 行 `window.addEventListener('keydown', ...)`）
  - 描述：`GameStateController` 绕过 `InputManager` 直接在 window 上注册键盘监听器。虽然 `destroy()` 中有清理，但与 InputManager 的输入管理职责重叠。
  - 违反原则：铁律 3（依赖注入）——应通过 `InputManager` 获取键盘输入，而非直接监听 DOM 事件。

---

## 审查总结

| 类型 | 数量 |
|------|------|
| 耦合 | 4 |
| 过度设计 | 1 |
| 分层违反 | 1 |
| 生命周期与销毁 | 4 |
| 数据驱动与配置驱动 | 2 |
| 统一动作执行 | 1 |
| 接口与约定 | 2 |
| 其他 | 3 |
| **合计** | **18** |

**亮点（做得好的方面）：**

- UI 层全面使用数据提供接口（`IQuestDataProvider`、`IRulesDataProvider`、`IArchiveDataProvider`、`IInventoryDataProvider`、`IZoneDataProvider`、`ISaveDataProvider`、`IAudioSettingsProvider`）而非具体系统类型，解耦非常干净。
- EventBus + FlagStore 的核心通信模式执行到位，同层系统之间确实没有直接持有彼此引用或互调。
- ActionExecutor 统一动作执行覆盖面广，遭遇结果、演出指令、对话标签、区域动作、延迟事件均通过此机制。
- 所有 IGameSystem 实现类均提供了完整的 `serialize()` / `deserialize()` 方法。
- InteractionCoordinator、EventBridge、ActionRegistry 的提取有效减轻了 Game.ts 的职责。

---

## 下一步

当前仅完成审查与报告，未做任何代码修改。如需修复，请回复「开始修复」。
