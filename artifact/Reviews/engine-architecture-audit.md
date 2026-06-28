# 游戏引擎架构审计报告

> 审查日期：2026-06-21　｜　范围：`src/`（42,298 行 TS，约 140 个文件）
> 方法：对照 `docs/游戏架构设计文档.md` 的 8 条铁律，实际读取源码逐条核验。所有问题均附 `文件:行号` 证据，且已人工复核，排除 agent 误报。
> 性质：**core-framework-architecture-review** — 只诊断、出问题清单，默认不修。报告末尾按优先级给修复建议，需你明确指示"开始修复"再动手。

---

## 总体结论

**这套引擎的架构纪律执行得相当好，没有数据腐坏/崩溃/单例泄漏级的事故。** 绝大多数系统正确实现 `IGameSystem`、经 `ActionExecutor` 执行动作、经 `EventBus`/`FlagStore` 解耦、`destroy()` 主体完整。下面的问题清单里：

- **致命 0 条**
- **严重 3 条**（都是真实违规，建议修）
- **中等 5 条**
- **轻微 5 条**

按铁律分布：违反**铁律 5（统一条件源）的问题最集中**（2 条严重），其次是**铁律 1（分层依赖）**（1 严重 + 1 中等），**铁律 8（完整生命周期）** 有若干一致性缺陷。

---

## 严重（建议修）

### S1 · 铁律 1：核心层 value-import 系统层，形成模块依赖环
- **位置**：`src/core/FlagStore.ts:3-4`
  ```ts
  import type { ConditionEvalContext } from '../systems/graphDialogue/evaluateGraphCondition';
  import { evaluateConditionExprList } from '../systems/graphDialogue/conditionEvalBridge';
  ```
  同样见 `src/core/NarrativeStateManager.ts:7`。
- **为什么是问题**：分层铁律是 `UI → 系统 → 渲染 → 核心 → 数据`，核心是底层，不应依赖系统层。`FlagStore` 是最底层的运行时状态存储，却编译期 value-import 了 `systems/graphDialogue/*`。而 `graphDialogue` 反过来又依赖 `FlagStore` —— **这构成了模块依赖环**。后果：①无法在不拉入整个图对话子系统的情况下单独测试/复用 FlagStore；②任何对图对话求值器的改动都可能波及最底层状态存储；③打包层面核心层失去独立性。
- **注意**：`import type`（第 3 行）是类型擦除、可接受；**第 4 行的 value-import 是真违规**。
- **影响范围**：核心层独立性、构建图健康度。

### S2 · 铁律 5：FlagStore 内藏一套独立的条件求值器，与统一求值器并存
- **位置**：`src/core/FlagStore.ts:208-279`（`evalPureFlagConjunction` / `checkConditions`）
- **现状**：`checkConditions` 在注入了 `conditionCtxFactory` 时走统一路径 `evaluateConditionExprList`；但**仍保留一条自研运算符分支**（`==/!=/>=/<=/>/<`，由 `evalPureFlagConjunction` 实现），在工厂未注入或叶子为纯 flag 时启用。
- **被广泛调用**（9 处，已 Grep 确认）：`ArchiveManager.ts:372`、`EncounterManager.ts:59`、`InteractionSystem.ts:68`、`InventoryManager.ts:140`、`QuestManager.ts:51`、`ZoneSystem.ts:48`、`MapUI.ts:50`、`utils/depthFloorZones.ts:30`、`GraphDialogueManager.ts:762`。
- **为什么是问题**：铁律 5 要求"广义条件统一走 `evaluateGraphCondition`"。现在存在两套 `==/>/<` 语义实现（FlagStore 的 `looseEqual`/`compareOrder` vs 统一求值器的叶子逻辑），调用方行为取决于"工厂是否注入"这一隐式状态。多数调用点恰好工厂已注入，但 `GraphDialogueManager.ts:762` 用 `[{flag,op:'!=',value:false}]` 内联构造并直调 `flagStore.checkConditions`，是绕过统一入口的典型痕迹。
- **影响范围**：条件语义一致性；新增运算符/叶子类型时两套实现易漂移。这是 S1 的下游表现。

### S3 · 铁律 5：ScenarioStateManager 自研 all/any/not 求值器，第三套条件实现
- **位置**：`src/core/ScenarioStateManager.ts:234-273`（`evalCatalogRequiresMet`）
- **现状**：该方法实现了 `all` / `any` / `not` / 数组AND / 叶子字符串(phase done) 的完整求值，与 `evaluateGraphCondition` 的组合子语义重复但**独立实现**。被 `assertScenarioLineEntryMetOrThrow`（:168）与 `setScenarioPhase`（:316）使用，即 catalog 的 `requires` 校验走这套。
- **为什么是问题**：进线/前置条件是"广义条件"的一种，铁律 5 要求统一走 `evaluateGraphCondition`。这里另起一套运算符实现，且其叶子只认 phase-status，无法复用统一求值器的 flag/quest/scenarioLine/narrative 叶子。而且其 `any.length===0 → false` 等边界行为与统一求值器是否一致需各自维护。
- **影响范围**：catalog requires 的表达力被锁死在自研子集；条件求值"三套并存"。与 S2 同源。

---

## 中等（建议修）

### M1 · 铁律 6：图对话扣铜钱绕过 ActionExecutor
- **位置**：`src/systems/GraphDialogueManager.ts:534-539`
  ```ts
  // 扣除该选项标注的铜钱花费……与背包铜钱一致，走 InventoryManager。
  const cost = opt.costCoins;
  if (typeof cost === 'number' && cost > 0) {
    this.inventoryManager.removeCoins(cost);
  }
  ```
- **为什么是问题**：铁律 6 要求"一切游戏行为经 `ActionExecutor`"。而 `removeCurrency` 动作是存在的（`src/core/ActionRegistry.ts:389`，内部正是 `inventoryManager.removeCoins(amt)`）。这里直接调 `InventoryManager.removeCoins()`，绕过了 Action 链。后果：①这次扣费不进入 Action 审计/日志/重放；②与 `EncounterManager.chooseOption`（同样有 consumeItems，却走 `actionExecutor.executeAwait({type:'removeItem',...})`，见 `EncounterManager.ts:210`）规范不一致；③未来若给 removeCurrency 加副作用（通知、统计、成就 hook），图对话扣费会漏掉。
- **代码注释已自承是临时实现**（"与背包铜钱一致，走 InventoryManager"）。
- **影响范围**：动作统一性、审计一致性。**这是全审计里唯一一处真实绕过 ActionExecutor 的代码**（其余 ~95 个 handler 全部经 ActionExecutor，已 Grep 核验）。

### M2 · 铁律 1：系统层 import UI 层（反向跨层依赖）
- **位置**：`src/systems/sugarWheel/SugarWheelMinigameScene.ts:5`
  ```ts
  import { UITheme } from '../../ui/UITheme';
  ```
  在该文件 189–1446 行共 ~50 处使用 `UITheme.colors.*` / `UITheme.fonts.ui` / `UITheme.panel.*` / `UITheme.alpha.*`。
- **为什么是问题**：分层是 `UI → 系统`，系统层不应依赖 UI 层。`Game.ts` 的"组装层例外"只覆盖 Game 本身的 bootstrap 职责，不覆盖系统文件。后果：sugarWheel 系统对 UI 主题模块形成编译期依赖；改/删 UITheme 会破坏小游戏；小游戏无法脱离 UI 层单独测试。对照 `WaterMinigameScene` / `PaperCraftMinigameScene` 均**未** import UITheme（它们各自硬编码颜色，见 M3），三个小游戏对"视觉常量从哪来"处理各不相同。
- **影响范围**：层级边界、小游戏可移植性。

### M3 · 铁律 4：小游戏视觉常量硬编码且三套风格不统一
- **位置**：
  - `src/systems/waterMinigame/WaterMinigameScene.ts:201,207,303,431,460,464,471,472`（`0x071421`/`0xdbeafe`/`'sans-serif'` 等）
  - `src/systems/waterMinigame/WaterPullPanel.ts:60,103,104,111,112,119,120`（`0xe0e8f0`/`0xf59e0b` 等）
  - `src/systems/paperCraft/PaperCraftMinigameScene.ts:50,151,153,174,175,180,187,206,207,219,241,242,247,269,270`
- **现状**：水域/扎纸小游戏配色字体写死在代码里，不走数据、也不用全局主题；而 sugarWheel 又用了 `UITheme`（见 M2）。三条小游戏"视觉常量来源"三套做法。
- **影响范围**：换肤/暗色模式/本地化字体需逐文件改代码；与 UI 层其它面板视觉割裂。

### M4 · 铁律 1（超出组装层）：Game.ts 事实上是 God Object
- **位置**：`src/core/Game.ts`（**3392 行**，502 个类字段，`start()` 单方法 ~600 行）
- **现状**：Game 类内联了大量远超"组装/bootstrap"的职责：
  - **光照环境曲线求值**（`updateLightEnvFromCurve` :1734、`resolveLightCurveInto` :1721、字段 `currentProbe/currentLightEnv/currentLightCurve/currentShadowField` :249-255）
  - **实体阴影系统**（`rebuildEntityShadows/createShadowImpl/applyShadowAndAO/updateEntityShadows/makePlayerShadowSource/makeNpcShadowSource/makeHotspotShadowSource` :1680-1807，外加 12 个 `*Debug` 微调方法 :1835-1902）
  - **像素密度匹配**（`getEntityPixelDensityMatch*/syncEntityPixelDensityMatch` :2367-2720）
  - **NPC 巡逻协程**（`stopNpcPatrol/startNpcPatrolForNpc/sleepWhileNpcPatrolPaused` :1435-1512，含 `patrolGeneration`/`npcPatrolEpoch` 状态）
  - **远程命令轮询**（`setupRuntimeCommandPolling/pollRuntimeCommands/applyRuntimeCommand` :2920-3032）
- **为什么是问题**：铁律 1 把 Game.ts 列为"组装层例外"，但例外只覆盖依赖注入与系统编排。光照、阴影、像素密度匹配、巡逻协程都是**独立的渲染/系统职责**，被内联进 Game，使其成为上帝对象。这些逻辑无法独立测试或替换，且每帧 `tick()`（:3240-3390）混入深度遮挡/光照/阴影的逐帧驱动。
- **影响范围**：可维护性、可测试性。注意：这不是"违反铁律"的硬伤，而是"组装层例外被过度使用"的结构异味——Game.ts 还能跑、职责还清楚，只是会越来越难改。
- **对照**：文档已把 `SceneDepthSystem` 抽成独立 system，说明"逐帧渲染辅助逻辑外提"是有先例的正确方向，光照/阴影应效仿。

### M5 · 铁律 7/8：cutsceneManager 在 registeredSystems 中 null 占位后填
- **位置**：
  - `src/core/Game.ts:385`（构造期）：`{ name: 'cutsceneManager', system: null as any }`
  - `src/core/Game.ts:597-598`（start() 里）：`cmEntry.system = this.cutsceneManager`
- **现状**：`registeredSystems` 声明为 `IGameSystem[]`，用 `null as any` 绕过类型系统。若 `start()` 在 `:598` 之前因任何异常或提前 return（start() 有多处 await 与提前 return，如 :1128-1130）而中断，该槽位保持 null，后续 `destroy()`（:3226）的 `if (entry.system)` 会跳过它 → cutsceneManager 不被销毁。
- **影响范围**：cutsceneManager 生命周期脆弱地依赖 start() 完整执行；`null as any` 削弱类型保证。当前恰好能跑，但属脆弱设计。

---

## 轻微（知悉即可）

### L1 · 铁律 4：玩家可见文本硬编码兜底
- `src/core/InteractionCoordinator.ts:250`：`npcName: '旁白'`（inspect 热区走图对话时硬编码中文）
- `src/core/Game.ts:414` & `src/systems/GraphDialogueManager.ts:962`：strings 缺省时玩家名回落到硬编码 `'你'`
- 影响：本地化/改名需改代码。属容错兜底，影响轻微。

### L2 · 铁律 8：NarrativeStateManager.destroy() 不完整
- `src/core/NarrativeStateManager.ts:483-489`：destroy 清了 graphs/activeStates/reachedStates/queue，但**未清** `recentTrace`(:210)/`recentIssues`(:209)/`recentTransitions`(:206)/`ownerIndex`(:198)/`primaryOwnerWarningKeys`(:212)/`traceSeq`(:211)/`drainPromise`(:202)/`completedQueueItems`(:200)/`runningActionsDepth`(:203)。
- `drainPromise` 可能持有未 resolve 的 Promise 链；trace/issues/transitions 缓存在重 init 时不被清，导致实例复用时旧快照残留（违反"重 init 与首次一致"）。

### L3 · 铁律 8：ScenarioStateManager.destroy() 不清注入引用
- `src/core/ScenarioStateManager.ts:103-106`：destroy 只清 `byScenario`/`lineLifecycleByScenario`，但 `flagStore`(:55)/`catalog`(:56)/`eventBus`(:57)/`manualLifecycleScenarioIds`(:54) 保留。
- 生产中 Game 整体重建会连带替换，影响小；调试/测试复用实例时可能读到旧 catalog。

### L4 · 铁律 8：多个系统的 conditionCtxFactory 在 destroy 未置空
- 位置：`DocumentRevealManager.ts:93-98`、`InventoryManager.ts:182-187`、`InteractionSystem.ts:308-316`、`ZoneSystem.ts:188-194`、`QuestManager.ts:281-287`
- 这些系统经 `setConditionEvalContextFactory(...)` 接收的工厂闭包，destroy 时没置 null。闭包在 Game.ts 里捕获了 flagStore/questManager/scenarioState 等引用。
- 影响：单次会话不泄漏（Game 整体回收）；但实例复用时旧 factory 残留指向已销毁依赖。属一致性缺陷。

### L5 · 铁律 2/3：UI 层 import systems 子目录（纯函数/类型）
- `src/ui/MapUI.ts:9-10`：import 了 `systems/graphDialogue/evaluateGraphCondition`（类型）与 `conditionEvalBridge`（value）
- `src/ui/PressureHoldUI.ts:4`：import 了 `systems/pressureHold/holdProgress`（纯数学类）
- 这不是"持有系统实例"（构造期只拿接口/纯函数），比 M2 轻，但让 UI 编译期依赖 systems 目录结构。建议把这套纯求值/数学逻辑下沉到 `core/` 或 `utils/`，systems 与 UI 都从那里引用。

---

## 已验证合规的点（排除误报）

为避免臆测，列出**主动核查并确认合规**的项：

- **铁律 6（统一动作执行）**：`ActionRegistry.ts` 全部 ~95 个 handler 经 `executor.register` 注册；InteractionCoordinator、EventBridge、NarrativeStateManager.runActions、Zone onEnter/Exit/Stay、Day 延迟事件、Quest 奖励/接取、Encounter 结算全部走 `actionExecutor.executeAwait/executeBatchAwait`。**唯一例外是 M1**。
- **铁律 3（依赖注入/无全局单例）**：所有系统经构造函数注入；唯一模块级实例是 `main.ts:16` 的 `new Game()`（入口，非单例模式）；`window.__gameDevAPI` 是 dev 通道，destroy 时 `delete`。
- **铁律 2（系统解耦）**：`systems/` 下互不 value-import；`systems → core` 仅 import 纯工具与核心抽象。`InteractionCoordinator`/`EventBridge`/`DebugTools` 通过 deps 对象注入同层系统引用（Game 显式 wire），属"少数已知受控例外"。GraphDialogueManager/DocumentRevealManager 的跨系统直接引用是**文档已知张力**，且是 `import type` + 构造注入，合规。
- **铁律 7（IGameSystem 接口）**：21 个系统全部 `implements IGameSystem`，init/update/serialize/deserialize/destroy 齐全。
- **铁律 8（destroy 主体）**：`Game.destroy()`（:3132-3238）完整——ticker、gl drain、webgl handlers、snapshot/command 定时器、window listeners、renderer resize、各 UI destroy、coordinator/bridge/debugTools destroy、registeredSystems destroy、eventBus.clear()（顺序正确：各模块先 off 再清总线）。`AudioManager.destroy()`、`SceneManager.destroy()`、`PressureHoldUI.destroy()` 都是完整 destroy 的正面样本。
- **minigame 生命周期**：4 个 minigame manager 的 `update()` 都有 `if (!this.scene || !this.active) return` 守卫，不污染主循环；`Game.ts:3283-3291` 仅在 `GameState.Minigame` 分支调它们的 update；destroy 完整（unsubscribe 键盘、`setGameKeyboardBlocked(false)`、释放资源、destroy scene、resolve session、清缓存）。

---

## 优先级修复建议（需你指示"开始修复"再动手）

按性价比排序：

### 第一优先级（解决"条件求值三套并存"，一举解 S1+S2+S3）
1. **把条件求值器从 `systems/graphDialogue/` 下沉到 `core/`**（如 `core/conditionEval/`）。`evaluateConditionExpr`/`evaluateConditionExprList` 本质是纯函数，放 core 后：systems、UI 都从 core 引用，消除 S1 的模块环。
2. **让 FlagStore.checkConditions 与 ScenarioStateManager.requires 统一调用** `evaluateConditionExpr(List)`，删除 `evalPureFlagConjunction`（FlagStore）与 `evalCatalogRequiresMet`（ScenarioStateManager）两套自研实现。
- 收益：模块依赖环消除、条件语义单一化、三套实现合一。这是收益最高的一项。

### 第二优先级（动作与分层边界）
3. **M1**：GraphDialogueManager 的 `costCoins` 扣费改为 `actionExecutor.executeAwait({type:'removeCurrency', params:{amount:cost}})`，与 EncounterManager 对齐。改动小、语义统一。
4. **M2+M3**：把小游戏视觉常量统一——要么下沉一份小游戏可读的 theme token 到 `core/` 或 `data/`（让三个小游戏 + UI 共用），要么挪进各 minigame 实例 JSON。顺便消除 sugarWheel 对 UITheme 的反向 import。

### 第三优先级（结构与生命周期）
5. **M4**：把光照/阴影/像素密度/巡逻协程从 Game.ts 抽成独立 system（效仿 `SceneDepthSystem` 模式）。Game.ts 回归纯编排。这是工程量最大的一项，但能显著改善可维护性，建议配合下一轮 feature-iteration 进行。
6. **M5**：`registeredSystems` 里 cutsceneManager 改为延迟创建或用占位 system 模式，避免 `null as any`。
7. **L2/L3/L4**：补全 destroy() 的残留字段清理。改动琐碎但能闭环铁律 8。

---

## 一句话总结

> 架构纪律整体扎实（无致命事故、动作执行基本统一、生命周期主体完整），但**条件求值存在三套并存**（FlagStore/ScenarioStateManager/graphDialogue）是当前最值得修的结构债，且它和"核心层反向依赖系统层"是同一个病灶的两面。其次是 Game.ts 的 God Object 化趋势和图对话扣费绕过 ActionExecutor。建议优先做"条件求值下沉统一"这一项，收益最高。
