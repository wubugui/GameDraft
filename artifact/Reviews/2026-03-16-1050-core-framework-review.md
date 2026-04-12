## 架构审查报告

**审查时间戳：** 2026-03-16 10:50

> **后注（2026-04）**：运行时 NPC 对话已迁移为 **图对话 JSON**（`GraphDialogueManager`）；下文若仍出现 Ink，均为该次审查时的快照，不代表当前代码。

### 文档同步说明
- 已将 `游戏架构设计文档.md` 中的系统清单同步为当前代码现状：移除 `NPCManager`，补充 `ZoneSystem`。
- 已将 UI 结构同步为当前代码现状：移除 `UIManager`、`RulesBookUI`，补充 `InspectBox`、`PickupNotification`、`RulesPanelUI`、`RuleUseUI`。
- 已将资源目录同步为当前代码现状：补充 `shops.json`、`map_config.json`、`player_anim.json`、`cutscenes/index.json`、`archive/books.json`，移除文档中不存在的 `npcs.json`、`animations.json`、旧的目录描述。
- 已将对话动作机制同步为当时代码现状（后续已改为图节点 `actions` + `ActionExecutor`，见上文后注）。
- 已将 `ActionExecutor` 的当前动作类型、`InputManager` 的实际职责、UI 组织方式、部分事件名与 payload 描述同步到现状。

### 问题列表

#### 1. 耦合
- [ ] 位置：`src/core/Game.ts`。`Game` 直接持有并编排几乎所有系统、渲染对象和 UI，对热点交互、对话、遭遇、地图、商店、菜单、存档、演出、区域规矩都做了集中调度，已经从“主入口”演化为跨层总控器。违反原则：**系统解耦**、**核心层职责清晰**。
- [ ] 位置：`src/systems/EncounterManager.ts`。`EncounterManager` 构造函数直接依赖 `RulesManager`，同层系统之间不是通过 `EventBus` / `FlagStore` 交互，而是直接持有引用。违反原则：**系统解耦**。
- [ ] 位置：`src/ui/QuestPanelUI.ts`、`src/ui/InventoryUI.ts`、`src/ui/RulesPanelUI.ts`、`src/ui/BookshelfUI.ts`、`src/ui/ShopUI.ts`、`src/ui/MapUI.ts`、`src/ui/MenuUI.ts`、`src/ui/RuleUseUI.ts`。多个 UI 直接依赖业务系统实例甚至直接改状态，UI 层没有收敛到事件或少量稳定接口。违反原则：**系统解耦**。

#### 2. 过度设计
- [ ] 位置：`src/data/types.ts`。定义了 `IGameSystem` / `GameContext`，但代码中没有任何类显式 `implements IGameSystem`，也没有统一 `init(ctx)` 生命周期落点，这套抽象目前只停留在声明层。违反原则：**接口约定**，同时属于**未落地的预设抽象**。
- [ ] 位置：`src/core/ActionExecutor.ts`、`src/core/Game.ts`。`ActionExecutor` 内置了一套 `giveItem/removeItem/giveCurrency/removeCurrency` 等 handler，`Game.registerActionHandlers()` 又对同名动作注册第二套实现，后者实际覆盖前者，形成重复入口。违反原则：**统一动作执行**，同时属于**重复能力/过度设计**。

#### 3. 分层违反
- [ ] 位置：`src/core/Game.ts`。`Core` 层直接 import 并控制 `systems`、`rendering`、`ui` 的具体实现，尤其直接依赖 UI 层，和文档“上层依赖下层、下层不依赖上层”的方向相反。违反原则：**分层依赖**。
- [ ] 位置：`src/ui/ShopUI.ts`、`src/ui/InventoryUI.ts`、`src/ui/RuleUseUI.ts`、`src/ui/MenuUI.ts`。UI 层不仅展示数据，还直接调用库存、动作执行、存档、音频等业务能力，部分面板已经兼管显示、输入和业务修改。违反原则：**分层依赖**、**职责单一**。

#### 4. 生命周期与销毁
- [ ] 位置：`src/core/Game.ts`。根对象没有 `destroy()`，也没有统一下发系统/UI/输入/渲染销毁流程；一旦未来支持重新初始化、回主菜单后重开、热重载或多实例运行，现有监听和对象生命周期无法闭环。违反原则：**完整生命周期**。
- [ ] 位置：`src/core/Game.ts`。通过匿名函数注册了大量 `eventBus.on(...)` 和 `window.addEventListener(...)` 监听（如 `resize`、`keydown` 以及一整套业务事件），由于没有保留回调引用，也没有顶层销毁入口，无法可靠解绑。违反原则：**destroy() 后不留残留状态**。
- [ ] 位置：`src/systems/SceneManager.ts`、`src/systems/ArchiveManager.ts`。这两个系统在构造时使用匿名回调订阅 `EventBus`，其 `destroy()` 没有对应 `off()`，属于确定性的监听残留点。违反原则：**完整生命周期**。

#### 5. 数据驱动与配置驱动
- [ ] 位置：`src/core/Game.ts`、`src/core/SaveManager.ts`。启动任务 ID `main_01`、初始场景 `test_room_a`、读档回退场景 `test_room_a` 都写死在代码中，核心流程依赖具体业务 ID。违反原则：**数据驱动**。
- [ ] 位置：`src/core/Game.ts`。`setupPlayer()` 直接在代码中构造占位贴图和动画状态，而资源目录里已经存在 `public/assets/data/player_anim.json`；当前玩家动画配置没有真正走数据文件。违反原则：**数据驱动**。

#### 6. 统一动作执行
- [ ] 位置：`src/core/Game.ts`。`handlePickup()`、`handleEncounterTrigger()`、`handleTransition()` 直接修改系统状态或直接调用管理器，没有统一走 `ActionExecutor`，导致同类“游戏结果落地”存在并行路径。违反原则：**统一动作执行**。
- [ ] 位置：`src/systems/CutsceneManager.ts`。演出系统只有 `execute_action` 命令会走 `ActionExecutor`，大量行为仍由 `switch(cmd.type)` 内部硬编码执行，统一动作入口只覆盖了演出命令的一部分。违反原则：**统一动作执行**。

#### 7. 接口与约定
- [ ] 位置：`src/data/types.ts`、`src/core/Game.ts`、`src/systems/*.ts`。文档要求所有系统统一实现 `init/update/serialize/deserialize/destroy`，但当前系统更新、存档收集、反序列化分发全部由 `Game` 手工点名调用，接口契约没有成为真实约束。违反原则：**接口约定**。
- [ ] 位置：`src/systems/DialogueManager.ts`。事件名是 `dialogue:start`，payload 字段名写作 `npcId`，但实际传入的是 NPC 名称而不是 ID，事件契约的命名语义和真实数据不一致。违反原则：**接口与事件约定一致性**。

#### 8. 其他
- [ ] 位置：`src/systems/CutsceneManager.ts`、`src/systems/ArchiveManager.ts`、`src/ui/RuleUseUI.ts`、`src/systems/SceneManager.ts`。存在只发不收或未形成完整契约的事件，如 `cutscene:switchScene`、`archive:updated`、`rule:used`、`scene:ready`。这类事件会让架构看起来是事件驱动，实际却没有形成可验证的消费链。违反原则：**事件命名与文档一致或具备完整消费关系**。
- [ ] 位置：`src/core/Game.ts`。`Game` 同时承担装配、状态机、输入快捷键、热点结果处理、动作注册、存档分发、UI 切换、业务桥接等多类职责，属于明显的职责混杂。违反原则：**职责单一**、**核心层保持稳定边界**。

### 下一步
当前仅做审查与报告，未修改任何业务代码。如需开始按优先级修复，请回复“开始修复”。
