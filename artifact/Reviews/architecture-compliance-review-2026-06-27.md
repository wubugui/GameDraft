# 架构合规审查报告 — 2026-06-27

> 类型：core-framework-architecture-review（仅问题清单，默认不修）

---

## 汇总

| 律条 | 状态 | 违规数 |
|------|------|--------|
| 1. 分层依赖 | ✓ 合规 | 0 |
| 2. 系统解耦 | ✗ 严重违规 | 4 |
| 3. 依赖注入 | ✓ 基本合规 | 0 |
| 4. 数据驱动 | ✓ 合规 | 0 |
| 5. 统一条件源 | ✓ 合规 | 0 |
| 6. 统一动作执行 | ✓ 合规 | 0 |
| 7. 统一接口 | ✓ 合规 | 0 |
| 8. 完整生命周期 | ⚠ 部分合规 | 3 |

---

## 违规清单

### 律2 — 系统解耦（HIGH）

**V1：GraphDialogueManager 直接持有其他系统引用**
- 文件：`src/systems/GraphDialogueManager.ts`（导入 L5-8，字段 L65-68，构造 L113-133）
- 持有：`SceneManager`、`RulesManager`、`QuestManager`、`InventoryManager` 的具体实例
- 在 `conditionCtx()` 内直接调用这些系统的方法
- 应改为通过 FlagStore / EventBus 取数据，不持有引用

**V2：DocumentRevealManager 直接持有其他系统引用**
- 文件：`src/systems/DocumentRevealManager.ts`（导入 L9-10，构造 L46-57）
- 持有：`QuestManager`、`ScenarioStateManager` 的具体实例
- 同层 system 不应互持引用

**V3：InteractionCoordinator 直接访问系统属性/方法**
- 文件：`src/core/InteractionCoordinator.ts`（导入 L4-6，接口 L21-37，使用 L72-109）
- 直接访问：
  - `sceneManager.switching`（L75）
  - `sceneManager.currentSceneData`、`.getCurrentHotspots()`、`.getNpcById()`（L135, 144-145）
  - `dialogueManager.isActive`、`.advance()`、`.endDialogue()`、`.chooseOption()`（L99-131）
  - `graphDialogueManager.isActive`、`.startDialogueGraph()` 等
- 应完全通过 EventBus 通信

**V4：EventBridge 直接调用系统方法**
- 文件：`src/core/EventBridge.ts`（导入 L4-6，接口 L12-14，调用 L33-65）
- 直接调用：
  - `dialogueManager.advance()`、`.endDialogue()`、`.chooseOption()`（L38-52）
  - `graphDialogueManager.advance()`、`.endDialogue()`（L41, 46）
  - `encounterManager.generateOptions()`、`.chooseOption()`、`.endEncounter()`（L58-64）
- 直接读取：`dialogueManager.isActive`、`graphDialogueManager.isActive`
- EventBridge 本质上成了"上帝中间人"，把 UI 事件绕过 EventBus 直接桥接到系统

---

### 律8 — 完整生命周期（MEDIUM/LOW）

**V5：SceneManager.destroy() 未清理部分回调（MEDIUM）**
- 文件：`src/systems/SceneManager.ts`（destroy L1453-1471）
- 漏掉：
  - `audioManifestResolver` setter 回调（L141 定义，destroy 未清理）
  - `sceneEnterRunner` 回调（L97 定义，destroy 未清理）
  - `entityFilterReleaser` 回调（L93 定义，destroy 未清理）

**V6：SceneManager.init() 可能累积监听器（MEDIUM）**
- 文件：`src/systems/SceneManager.ts`（init L116-119，destroy L1457-1458）
- 多次调用 `init()` 未先 destroy 时，事件监听器会累积
- 应在 `init()` 内先 unsubscribe，或检查是否已注册

**V7：CutsceneManager.destroy() 未 nullify assetManager（LOW）**
- 文件：`src/systems/CutsceneManager.ts`（destroy L932-957，字段 L92）
- `assetManager` 字段在 destroy 后未显式置 null，可能阻碍 GC
- 影响有限（GC 压力，非功能性 bug）

---

## 根本原因分析

律2违规集中在"需要跨系统查询状态"的场景（条件求值上下文、对话流程控制）。直接持有引用是为了避免过度异步化，但代价是强耦合。

更合规的方向：
1. 系统通过 EventBus 发布域事件，不跨系统直接调用方法
2. 跨系统读状态改为通过 FlagStore 快照 + 接口（`IQuestDataProvider` 等），不持有系统实例
3. InteractionCoordinator 和 EventBridge 角色应收窄，避免"上帝协调器"模式

---

## 已核实合规项

- **律4**：所有内容 ID 走 JSON 数据文件，代码无硬编码
- **律5**：条件判断全走 `evaluateGraphCondition` / `evaluateConditionExprList()`，FlagStore 是唯一状态存储
- **律6**：游戏行为全走 `ActionExecutor` + `ActionRegistry`，系统不自己处理动作
- **律7**：所有系统均实现 `IGameSystem`（init/update/serialize/deserialize/destroy）
