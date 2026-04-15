# 叙事框架迭代方案

## 设计决策（已敲定）

以下约束贯穿 Phase 1～5 的实现与编辑器，避免与「全局 flag 满天飞」的旧模式混用。

| 决策 | 说明 |
|------|------|
| **Scenario 严清单** | 权威数据为 [`public/assets/data/scenarios.json`](public/assets/data/scenarios.json)：每个 `scenarioId` 定义 `phases`、**每 phase 可选 `requires`**（须先 `done` 的其它 phase，见 §4.1）、可选 **scenario 级 `requires`**（**仅表示进线门槛**：开始本条叙事线之前，列出的 phase 须已为 `done`，与 per-phase 依赖不同）。另可选 `exposeAfterPhase` + `exposes`。非法引用在**编辑器校验**阶段报错；运行时 dev 下可对违反 per-phase `requires` 的写入告警。 |
| **分支仅在图内** | 叙事分支只通过图节点 [`switch`](src/data/types.ts) + 条件求值完成。**不**引入带 `nextIfTrue` / `nextIfFalse` 的 Action 来改对话流，避免与 [`evaluateGraphCondition`](src/systems/graphDialogue/evaluateGraphCondition.ts) 双通道。 |
| **条件单入口** | 扩展 **scenario** 叶子与 **`ConditionExpr`**（`all` / `any` / `not`）后，图 `preconditions` / `switch`、文档揭示 `revealCondition`、以及 [`FlagStore.checkConditions`](src/core/FlagStore.ts) 的旧 `Condition[]` 路径均归一到同一套求值实现；禁止各子系统自写一套解析。 |
| **存档形态** | 推荐 `ScenarioStateManager` 实现 [`IGameSystem`](src/data/types.ts) 的 `serialize` / `deserialize`，经 [`Game`](src/core/Game.ts) 的 `registeredSystems` 写入存档桶（与 `QuestManager` 等一致）。当前工程**没有**顶层 `saveVersion` 字段；缺省键在 `deserialize` 内初始化为空，不必虚构版本号叙事。 |

## 术语与单一真相来源

- **Scenario 桶**：按 `scenarioId` 存储各 `phase` 的 `status`、可选 `outcome` 等；**不**把 scenario 键写进 `flag_registry.json`。对地图、任务、成就等系统的「对外通知」通过清单中的 **`exposes`**（见 Phase 4）或**唯一一处**桥接逻辑写入全局 flag，避免多处手写 `setFlag` 描述同一进度。
- **图对话图**：`public/assets/dialogues/graphs/<graphId>.json`；可选 `meta.scenarioId` 仅作编辑归属与检索。**Inspect 热区**开图时若存在 **`meta.title`**，运行时用作对话显示名（否则仍为「旁白」）；`meta.scenarioId` 仍不用于玩法分支。
- **文档揭示**：玩家「是否看清告示」的**表现与持久化**由 `DocumentRevealManager` + `document_reveals.json` 负责；**剧情上是否已得知内容**以 scenario /叙事状态为准。`revealedFlag` 仅为与旧系统或外部查询的**可选桥接**，避免与 scenario 双写同一事实。
- **ConditionExpr**：递归条件 JSON；**叶子**与 `GraphCondition` 原子部分对齐（flag、quest、scenario）。`revealCondition` 的类型即 **`ConditionExpr`**，与图条件**同一求值器**，不是另一套 DSL。

## 实现状态（相对本文档）

以下为截至当前仓库的**实现子集**说明，避免与正文「目标」混淆。

| 主题 | 已实现 | 未实现或部分实现 |
|------|--------|------------------|
| Scenario 桶 / `setScenarioPhase` /存档 | 有 | 清单内 `status` 非法值运行时仅 dev 警告（见 `ScenarioStateManager`） |
| `exposes` | 有 | 仅当配置 **`exposeAfterPhase`** 且该 phase 被设为 `status: done` 时写入；**无 `exposeAfterPhase` 则不会写 exposes**；复杂触发规则（outcome 等）未扩展 |
| **per-phase `requires`** | 清单与运行时 dev 警告 | scenario 顶栏 `requires` 保留为可选 **「进线门槛」**（见 §4.1 说明） |
| 条件 `ConditionExpr` | 图 / switch / 文档揭示 | 热区/任务等走 `conditionEvalBridge`；主编辑器 [`condition_editor.py`](tools/editor/shared/condition_editor.py) 在 flag 行下提供 **附加 JSON** 编辑 scenario/quest/`all`/`any`/`not` |
| Inspect 图模式 | 有 | `meta.scenarioId` 仍仅编辑器归属；**`meta.title`** 在 Inspect 开图时用作对话标题名（`preferGraphMetaTitle`，见 `GraphDialogueManager`） |
| `revealDocument` | 有 | 部分图仍含 `blendOverlayImage`，宜迁移 |
| 共享 ConditionExpr 编辑器（§5.1） | flag 行 + **表达式树**（`condition_expr_tree.py`）+ 专家 JSON；graph_editor 已 re-export 共享控件 | 图对话 switch case 仍以节点内 JSON/表单为主（与计划一致） |

## 目标

将游戏中所有叙事交互（NPC 对话、看板/Inspect、热区交互）统一到图对话系统，
引入 Scenario 局部状态管理替代散乱的全局 flag，建立独立的文档揭示系统。
统一**条件表达式**能力：在 flag / 任务 / scenario 等原子条件之上支持 **AND / OR / NOT**（可嵌套），全项目共用同一套求值语义。

---

## Phase 1：基础设施 — Scenario 状态管理器

**目标**：建立局部状态命名空间，解决全局 flag 散乱问题。

### 1.1 新增 `ScenarioStateManager`

文件：`src/core/ScenarioStateManager.ts`

核心职责：
- 按 `scenarioId` 分桶管理状态（内存形状可与 `scenarios.json` 的 phase 清单对齐；持久化用稳定 JSON）
- 提供 **`setScenarioPhase(scenarioId, phase, { status, outcome? })`** / **`getScenarioPhase(scenarioId, phase)`**（或 `getPhaseState`）读写接口；**不再**使用与上述不一致的 `setPhase(scenarioId, phase, key, value)` 泛型拼字
- 提供 `checkPrerequisites(scenarioId, requiredPhases)`（或读取清单内 `requires`）检查前置依赖
- 实现 **`IGameSystem`**：`init` / `serialize` / `deserialize`，供 [`Game.collectSaveData`](src/core/Game.ts) 通过 `registeredSystems` 自动收集（与 `QuestManager` 等一致）；旧存档缺少本系统桶时 **`deserialize` 内初始化为空 Map**

关键设计决策：
- Scenario 状态**跨 session 持久化**，不清理（玩家跨天回来可继续）
- 对清单中声明的 **`exposes`**：在对应 phase 达成时由本管理器或**唯一钩子**写入全局 flag / 任务信号（见 Phase 4），避免图里散落重复 `setFlag`
- 底层不依赖 FlagStore 存储 scenario 正文，独立的 Map（或结构化对象）存储；求值时由 `evaluateConditionExpr` 读取

### 1.2 集成到存档系统

文件：`src/core/Game.ts`

改动：
- 将 `ScenarioStateManager` **注册为 `registeredSystems` 一员**，无需在 `collectSaveData()` 手写额外顶层键（除非团队选择非 `IGameSystem` 方案）
- `distributeSaveData()` 随现有循环调用各系统 `deserialize`；**兼容**旧存档：无本系统数据时等价于空 scenario状态

说明：当前仓库存档为扁平 `Record`，**无**统一 `saveVersion`；本迭代以「缺键即默认」为迁移策略即可。

### 1.3 扩展 ActionExecutor

文件：`src/core/ActionExecutor.ts`

新增 Action 类型（**仅副作用，不改对话节点流**）：

| Action 类型 | 参数 | 说明 |
|------------|------|------|
| `setScenarioPhase` | `{ scenarioId, phase, status, outcome? }` | 写入 scenario 阶段状态；必要时触发 `exposes` 同步 |

**不**增加 `checkScenarioPhase` 或任何「条件满足则跳到某节点」类 Action；分支一律在图的 `switch` 上表达。

### 1.4 扩展图对话条件系统

文件：`src/systems/graphDialogue/evaluateGraphCondition.ts`
文件：`src/data/types.ts`
文件：`src/systems/GraphDialogueManager.ts`（构造注入）

`GraphCondition` 类型新增 **scenario** 叶子；求值时 [`evaluateGraphCondition`](src/systems/graphDialogue/evaluateGraphCondition.ts)（或统一的 `evaluateConditionExpr`）须能访问 **`ScenarioStateManager`（只读）**，与现有 `flagStore`、`questManager` 一并传入。

```typescript
type GraphCondition =
  | Condition                                           // 原有 flag 条件
  | { quest: string; questStatus: ... }                  // 原有任务条件
  | { scenario: string; phase: string; status: string }; // 新增，与 scenarios.json 清单一致
```

**类型关系**：Phase 1.5 的 **`ConditionExpr`** 叶子集合与上式**原子析取**一致；组合子仅 `all` / `any` / `not`。图的 `preconditions`、`switch` 的每条分支条件最终归一为 `ConditionExpr`（或兼容旧 `conditions[]` = `all`）。

### 1.5 条件表达式：逻辑组合（AND / OR / NOT）

**历史背景**：迭代前仅有 flag 原子与组内 AND；当前运行时已支持完整 `ConditionExpr`。

**目标**（已与实现对齐）：
- 引入递归类型 **`ConditionExpr`**（名称可斟酌，如 `LogicCondition`）：
  - **叶子**：现有原子条件（flag、`quest`+`questStatus`、`scenario`+`phase`+`status` 等），与上节 `GraphCondition` 对齐；
  - **组合**：`{ "all": ConditionExpr[] }`、`{ "any": ConditionExpr[] }`、`{ "not": ConditionExpr }`（NOT 仅包裹一棵子树，避免歧义）。
- **单一求值入口**：`evaluateConditionExpr` + `conditionEvalBridge`；[`FlagStore.checkConditions`](src/core/FlagStore.ts) 在 [`Game`](src/core/Game.ts) 注入 `setConditionEvalContextFactory` 后对 `ConditionExpr[]` **委托** `evaluateConditionExprList`；flag 叶子在求值器内走 [`evalPureFlagConjunction`](src/core/FlagStore.ts)（避免 `checkConditions` 与求值器互相递归）。未注入上下文且条件含非 flag 叶子时 dev 告警并返回不满足。
- **数据迁移策略**：  
  - **向后兼容**：未改写的 JSON 仍使用 `conditions: [...]` 数组时，语义保持为 `all(叶子)`，与今日行为一致；  
  - **新写法**：`switch` 的每一分支可逐步改为单个 `condition: ConditionExpr`（或同时支持数组与 `condition` 字段，文档中约定优先级），减少冗余数组。
- **适用范围（与本迭代相关）**：图对话 `preconditions` / `switch`、Phase 3 文档揭示的 `revealCondition`、以及后续任务/热区中引用同一类型的条件字段，均走同一求值器，避免「图里一套、别处一套」。

**验收标准**（Phase 1 追加）：
- [x] 图对话 JSON 中可使用 `all` / `any` / `not` 嵌套，且与纯 flag 旧数据共存
- [x] `not` + `any` 等组合在 switch 分支上行为符合布尔代数预期（可用手动场景回归）
- [x] 文档揭示条件与图条件共用 `ConditionExpr`，无重复解析代码

### 1.6 注册到 Game 初始化

文件：`src/core/Game.ts`

- 实例化 `ScenarioStateManager`
- 注入到 `GraphDialogueManager`（用于条件评估）
- 注入到 `ActionExecutor`（用于 Action 执行）

**验收标准**：
- [x] ScenarioStateManager 可独立创建、读写、序列化
- [x] 存档/读档后 scenario 状态正确恢复
- [x] 图对话 JSON 中可使用 `{ scenario: "xxx", phase: "yyy", status: "done" }` 条件
- [x] Action 中可使用 `setScenarioPhase`
- [x] 条件表达式支持 `all` / `any` / `not` 嵌套，且旧版「仅 flag 数组」仍可读

---

## Phase 2：统一叙事运行时 — 看板支持图对话

**目标**：让 Inspect 热区（看板等）也能使用图对话系统，消除独立的 inspect 文本逻辑。

### 2.1 扩展 `InspectData` 类型

文件：`src/data/types.ts`

**互斥约定**：`graphId` 与「纯文本 inspect」二选一；至少满足其一。推荐用**可辨识联合类型**表达，便于 TS 与校验器统一：

```typescript
/** 旧版：仅文本 + 可选 actions */
interface InspectDataTextMode {
  text: string;
  actions?: ActionDef[];
  graphId?: undefined;
  entry?: undefined;
}

/** 新版：图对话（看板等） */
interface InspectDataGraphMode {
  graphId: string;
  entry?: string;
  actions?: ActionDef[];
  text?: undefined;
}

export type InspectData = InspectDataTextMode | InspectDataGraphMode;
```

兼容策略：运行时 **`graphId` 有值**则走图对话；否则走 `inspectBox` 文本逻辑（`text` 必填）。校验器对「同时填 graphId 与 text」报**错**或**警告**（团队择一）。

### 2.2 修改 `InteractionCoordinator.handleInspect`

文件：`src/core/InteractionCoordinator.ts`

改动逻辑：
```
if (data.graphId) {
    // 走图对话系统（和 NPC 对话同一套 GraphDialogueManager）
    await graphDialogueManager.startDialogueGraph({
        graphId: data.graphId,
        entry: data.entry,
        npcName: "旁白",  // 或从图 meta 读取
    });
} else {
    // 旧逻辑：显示 inspectBox 文本
    await inspectBox.show(data.text);
    ...
}
```

### 2.3 游戏状态管理

当前 inspect 设置 `GameState.UIOverlay`，**走 `graphId` 分支时**须与 NPC 图对话一致，使用 **`GameState.Dialogue`**（禁用移动、统一对话 UI），直至 `GraphDialogueManager` 结束后再恢复 `GameState.Exploring`。

需要确认：
- `GameState.Dialogue` 下玩家的输入控制是否正确（对话模式禁用移动）
- 对话结束后是否正确恢复 `GameState.Exploring`
- `InteractionCoordinator` 的 `dialogueManager.isActive || graphDialogueManager.isActive` 检查是否防止了 inspect 期间重复交互

### 2.4 编辑器适配

文件：`tools/editor/shared/action_editor.py`（如涉及）
文件：相关热区编辑器

- 热区类型 `inspect` 的配置表单增加 `graphId` 字段
- 填写了 `graphId` 时隐藏/禁用 `text` 字段
- 提供下拉选择已存在的图对话文件

**验收标准**：
- [x] 旧的热区 inspect 数据（只有 text）正常工作
- [x] 新的热区 inspect 数据（有 graphId）打开图对话
- [x] 看板图对话中可以正常使用 switch/choice/runActions
- [x] 对话结束后游戏状态正确恢复

---

## Phase 3：文档揭示系统

**目标**：将 `blendOverlayImage` 等文档模糊→清晰的动画逻辑独立成系统。

### 3.1 定义数据结构

文件：`src/data/types.ts`

**与图条件对齐**：`revealCondition` 使用 **`ConditionExpr`**，与图对话 `preconditions` / `switch` **同一求值函数**；其叶子为 `GraphCondition` 的原子形式（flag / quest / scenario），**不是**另一套字段名或另一套语义。

```typescript
interface DocumentRevealDef {
  id: string;                    // "告示-水猴子"
  blurredImagePath: string;      // 模糊版本
  clearImagePath: string;        // 清晰版本
  /** 揭示条件（满足后播放揭示动画）；与 Phase 1.5 的 ConditionExpr 一致，可含 all/any/not */
  revealCondition: ConditionExpr;
  /** 揭示动画配置 */
  animation: {
    durationMs: number;
    delayMs: number;
  };
  /** 揭示后写入的 flag，默认 document_revealed_{id} */
  revealedFlag?: string;
}
```

### 3.2 实现 `DocumentRevealManager`

文件：`src/systems/DocumentRevealManager.ts`

核心接口：
- `register(def: DocumentRevealDef)` — 注册文档定义
- `checkAndReveal(documentId: string)` — 检查条件，满足则播放揭示动画
- `getDocumentPhase(documentId)` — 返回 `'hidden' | 'blurred' | 'revealing' | 'revealed'`
- `getDisplayImage(documentId)` — 返回当前应显示的图片路径
- `isRevealed(documentId)` — 是否已揭示
- `serialize()` / `deserialize()` — 参与存档

### 3.3 注册到 ActionExecutor

文件：`src/core/ActionRegistry.ts`

```typescript
executor.register('revealDocument', (p) => {
  return documentRevealManager.checkAndReveal(p.documentId as string);
}, ['documentId']);
```

### 3.4 替换现有的 `blendOverlayImage` 用法

现有对话 JSON 中的 `blendOverlayImage` Action：
```json
{
  "type": "blendOverlayImage",
  "params": {
    "id": "blend",
    "fromImage": "/assets/images/illustrations/告示-抓水猴子X.png",
    "toImage": "/assets/images/illustrations/告示-抓水猴子.png",
    ...
  }
}
```

替换为：
```json
{
  "type": "revealDocument",
  "params": { "documentId": "告示-水猴子" }
}
```

`DocumentRevealManager` 内部复用现有的 overlay shader 和 blend 逻辑，
但对外只暴露 document 级别的抽象。

### 3.5 文档定义配置

文件位置：`public/assets/data/document_reveals.json`（新建）

```json
[
  {
    "id": "告示-水猴子",
    "blurredImagePath": "/assets/images/illustrations/告示-抓水猴子X.png",
    "clearImagePath": "/assets/images/illustrations/告示-抓水猴子.png",
    "revealCondition": {
      "scenario": "码头水鬼",
      "phase": "真相揭示",
      "status": "done"
    },
    "animation": { "durationMs": 2000, "delayMs": 500 }
  }
]
```

复杂门槛可在 `revealCondition` 中直接使用 Phase 1.5 的 `all` / `any` / `not` 嵌套，与图对话 switch 求值共用同一实现。

**验收标准**：
- [x] DocumentRevealManager 可注册、查询、播放揭示动画
- [x] `revealDocument` Action 在对话中正常工作
- [x] `revealCondition` 支持 `ConditionExpr`（含 `all` / `any` / `not`），与图条件求值一致
- [x] 现有使用 `blendOverlayImage` 的对话可逐步替换（图 JSON 侧已完成；Action 仍保留兼容）
- [x] 文档状态正确存档/读档

---

## Phase 4：数据迁移 — 码头事件重构

**目标**：将码头看板事件从散乱的全局 flag 迁移到 Scenario 系统，验证整体架构。

### 4.1 定义 Scenario

文件：`public/assets/data/scenarios.json`（新建）或写在码头场景 JSON 中

```json
{
  "id": "码头水鬼",
  "description": "码头告示与水猴子事件",
  "phases": {
    "看板初读": { "status": "pending" },
    "询问官差": { "status": "pending" },
    "询问脚帮": { "status": "pending", "requires": ["询问官差"] },
    "真相揭示": { "status": "locked" }
  },
  "exposeAfterPhase": "真相揭示",
  "exposes": {
    "码头水鬼真相已揭示": true
  }
}
```

**`requires`（两格别混用）**：

- **`phases.<name>.requires`**：该 phase 在被推进到非初始状态前，列出的其它 phase **须已为 `done`**（per-phase 依赖）；由编辑器 phases 表第三列维护，运行时 dev 下违反则 `console.warn`。
- **scenario 根上的 `requires`（可选）**：**进线门槛**——在开始本条 scenario 相关玩法前，这些 phase 须已为 `done`（通常留空；**不是**「本线 phase 前置自己」的另一种写法）。

**`exposes` 运行时语义**：清单中的键值表示「当本 scenario 达到约定完成条件时，应同步到游戏其余子系统的外部名」。**当前实现**：须在清单中配置 **`exposeAfterPhase`**（phase 名字符串）；当 `setScenarioPhase` 把**该 phase** 设为 `status: done` 时，`ScenarioStateManager` **唯一一处**写入 `exposes` 中为 `true` 的键到 `FlagStore`。**若只写 `exposes` 而不写 `exposeAfterPhase`，运行时不会写任何 exposes 键。** 复杂触发（outcome 等）尚未在清单中扩展，仍以图内 `switch` 为准。

### 4.2 重写官差对话图

文件：`public/assets/dialogues/graphs/码头看板官差.json`

变更要点：
- 删除 `码头_看板官差对话完结`、`码头-水鬼-和官差交流过` 等散乱 flag
- 使用 `{ scenario: "码头水鬼", phase: "询问官差", status: ... }` 条件
- 对话结束时使用 `setScenarioPhase` 写入状态

### 4.3 重写脚帮对话图

文件：`public/assets/dialogues/graphs/码头_脚帮帮众看板对话.json`

变更要点：
- 删除 `码头_看板官差对话完结`、`码头-看板-脚帮交流完结` 等散乱 flag
- 使用 scenario 条件判断是否可以进入深度对话
- 真相揭示时使用 `setScenarioPhase` + `revealDocument`

### 4.4 重写看板热区

文件：码头场景 JSON 中的 inspect 热区定义

变更：
- 从 `text + actions` 改为 `graphId: "码头看板"`
- 新建 `public/assets/dialogues/graphs/码头看板.json`
- 看板图中根据 scenario 状态展示不同文本

### 4.5 全局 flag 清理

迁移完成后，以下旧 flag 不再使用，可从 `flag_registry.json` 中标记废弃：

| 旧 flag | 替代方式 |
|---------|---------|
| `码头_看板官差对话完结` | `scenario.码头水鬼.询问官差.status` |
| `码头-水鬼-和官差交流过` | `scenario.码头水鬼.询问官差.outcome` |
| `码头_已经和过码头告示交互过` | `scenario.码头水鬼.看板初读.status` |
| `码头-看板-脚帮交流完结` | `scenario.码头水鬼.询问脚帮.status` |

**验收标准**：
- [x] 官差对话：被骂/打点/诈唬三种路径正确写入 scenario 状态（数据已迁移至 scenario；玩法需策划回归）
- [x] 脚帮对话：只有先问过官差才能深度对话（同上）
- [x] 看板：根据 scenario 状态显示不同内容
- [x] 真相揭示后 `revealDocument` 正确播放动画
- [x] 存档/读档后所有状态正确恢复（技术链路具备；需存档回归）
- [x] 旧 flag 不再被图 JSON 引用（遗留 `.ink` 若有则与 Ink 管线相关，非图对话主路径）

---

## Phase 5：编辑器迭代（完整清单）

**目标**：叙事运行时改什么，编辑器就必须能在**同一套数据**上无手写 JSON 地完成创作与校验；并与 Phase 1 的 **Scenario 严清单**、**ConditionExpr**、Phase 2 的 **Inspect 图对话**、Phase 3 的 **document_reveals** 对齐。

**原则**：
- **单一条件组件**：图对话、任务、热区、文档揭示等凡遇条件，优先复用同一套「条件表达式」控件（或薄封装），避免 `tools/editor/shared/condition_editor.py` 与 `tools/graph_editor/panels/condition_editor.py` 等分叉语义。
- **严清单驱动 UI**：`scenarioId` / `phase` / `status` 的下拉数据来自已加载的 `scenarios.json`（或项目内等价路径）；不在清单内的 phase 给出警告或禁止保存（策略与 Phase 1 一致）。
- **保存前校验**：沿用并扩展 [`tools/editor/validator.py`](tools/editor/validator.py)：`graphId` 文件存在、`entry` 节点存在、`setScenarioPhase` 参数合法、`revealDocument` 的 `documentId` 在 `document_reveals.json` 有定义等。

### 5.1 共享：`ConditionExpr` 条件编辑器

**主要文件**：[`tools/editor/shared/condition_editor.py`](tools/editor/shared/condition_editor.py)（现有为 `Condition[]` + flag 行编辑器）；可演进为内部嵌入「表达式树」或并列新模块 `condition_expr_editor.py` 供各处引用。

**能力**：
- **叶子行**：与今日一致——flag + op + value（走 `FlagKeyPickField` / `FlagValueEdit`）；**新增**叶子类型「任务」「Scenario」表单项（`quest`+`questStatus`、`scenario`+`phase`+`status`，phase/status 与清单联动下拉）。
- **逻辑组合**：树形或缩进面板编辑 `all` / `any` / `not`；支持添加子节点、提升/降级、删除；导出 JSON 与 Phase 1.5 的 `ConditionExpr` 一致；加载旧数据时 `conditions: [...]` 显示为等价 `all(叶子)`。
- **导入/导出**：可选「查看原始 JSON」子面板便于高级用户粘贴；常规作者只用表单。
- **递归深度**：与运行时上限一致时在 UI 上禁用「再嵌套」或提示。

**被引用方（需接线的调用点）**：图对话节点 Inspector、任务编辑器、场景热区条件（若有）、文档揭示表单、以及 [`tools/graph_editor/panels/condition_editor.py`](tools/graph_editor/panels/condition_editor.py) 若仍存在独立实现则改为包装共享组件，避免两套逻辑。

### 5.2 图对话编辑器（`dialogue_graph_editor`）

**主要文件**：[`tools/dialogue_graph_editor/node_inspector.py`](tools/dialogue_graph_editor/node_inspector.py)、[`tools/dialogue_graph_editor/editor_widget.py`](tools/dialogue_graph_editor/editor_widget.py)、必要时 [`tools/dialogue_graph_editor/graph_analysis.py`](tools/dialogue_graph_editor/graph_analysis.py)。

**能力**：
- **图级 meta**：在图属性区增加可选字段，例如 `meta.scenarioId`（下拉选自 `scenarios.json`），用于提示本图归属哪一叙事分量、便于检索与文档化（运行时是否读取由 Phase 1 决定，编辑器先落数据）。
- **整张图的 preconditions**：用5.1 的 `ConditionExpr` 编辑器替换/增强现有条件列表。
- **`switch` 节点**：每条 case 的条件改为编辑 **单个 `ConditionExpr`**，或与旧 `conditions` 数组双轨（数组 = `all`）；**禁止**在编辑器侧生成「Action 内改流」类动作。
- **`choice` 选项**：支持 `requireCondition`（`ConditionExpr`）与 `requireFlag` **并存（AND）**；表单位于 `node_inspector` 各选项折叠块内。
- **Action 行内编辑**：[`tools/editor/shared/action_editor.py`](tools/editor/shared/action_editor.py) 中登记 **`setScenarioPhase`**（参数 picker 绑定 scenario/phase/status）、**`revealDocument`**；对 **`blendOverlayImage`** 标为「优先改用 revealDocument + document_reveals」的迁移提示（仍可编辑旧图）。
- **资源选择**：`graphId` /嵌套开图处若有字符串输入，提供「从 graphs 目录选文件」对话框（与现有 node_picker 一致体验）。

### 5.3 场景编辑器热区（`graph_editor` /主编辑器场景页）

**主要文件**：[`tools/graph_editor/panels/scene_panel.py`](tools/graph_editor/panels/scene_panel.py)（热区类型已含 `inspect`）。

**能力**：
- **Inspect 模式二选一**：`graphId` +可选 `entry` **与** 纯 `text`（+可选 `actions`）互斥；选图模式时隐藏或禁用纯文本大框，避免导出无效数据。
- **选图**：下拉或文件选择器列出 `public/assets/dialogues/graphs/*.json` 的 `id` 或文件名；`entry` 可选填，校验节点存在（可调用与图编辑器共享的校验或惰性在保存时由 validator 报）。
- **快捷操作**：「新建看板图」：创建空白图 JSON（带默认 `entry`）、写入默认 `meta`、并可选择是否立即把当前热区 `graphId` 指过去。
- **条件**：若 inspect 热区将来支持「显示/可交互条件」，使用 5.1 组件（本迭代若运行时未支持条件 inspect，则编辑器不强制，仅在文档中标注可选）。

### 5.4 Action 注册表与批量动作编辑

**主要文件**：[`tools/editor/shared/action_editor.py`](tools/editor/shared/action_editor.py)、[`tools/editor/editors/action_registry_editor.py`](tools/editor/editors/action_registry_editor.py)。

**能力**：
- 新 action 类型 **`setScenarioPhase`**、**`revealDocument`** 的参数模式、占位与校验与运行时 [`ActionRegistry`](src/core/ActionRegistry.ts) 一致。
- 在登记编辑器中可维护「描述 / 必填 params列表」，便于表单自动生成与 validator 对齐。

### 5.5 Scenario 清单编辑

**新建或集成**：建议在主编辑器 [`tools/editor/main_window.py`](tools/editor/main_window.py) / [`tools/editor/editors/game_browser.py`](tools/editor/editors/game_browser.py) 增加 **「Scenarios」** 页签，或独立 `editors/scenarios_editor.py` 编辑 [`public/assets/data/scenarios.json`](public/assets/data/scenarios.json)（路径以仓库为准）。

**能力**：
- 增删改 **scenarioId**、描述、`phases` 列表及每 phase 的 **允许 status**、**requires** 依赖；**exposes** 若存在则编辑对外 flag/任务名。
- **只读依赖预览**：由清单生成简单列表或小型图（哪一 phase 依赖谁），不必先做复杂可视化。
- **被消费方**：图对话 meta、条件叶子、Action `setScenarioPhase` 的下拉数据源均读此文件。

### 5.6 文档揭示配置编辑

**新建**：`editors/document_reveals_editor.py`（或并入 game_browser）编辑 [`public/assets/data/document_reveals.json`](public/assets/data/document_reveals.json)。

**能力**：
- 表格或表单维护 `id`、模糊/清晰图路径（可用现有 [`image_path_picker`](tools/editor/shared/image_path_picker.py)）、**`revealCondition`**（嵌入 5.1）、动画时长、`revealedFlag` 可选。
- 与 action_editor 中 `revealDocument` 的 `documentId` 下拉联动（条目来自本文件）。

### 5.7 校验、分析与文档化

**文件**：[`tools/editor/validator.py`](tools/editor/validator.py)、可选 [`tools/dialogue_graph_editor/graph_analysis.py`](tools/dialogue_graph_editor/graph_analysis.py)。

**能力**：
- 校验：`ConditionExpr` 结构合法、深度上限、`scenario` 叶子引用存在于清单、`graphId` 存在、`entry` 存在、文档 `id` 唯一等。
- **分析（可选）**：[`extract_narrative_refs`](tools/dialogue_graph_editor/graph_analysis.py) 已提供「本图 scenarioId + 嵌套 graphId」抽取；主界面分析面板若需展示可再接线。
- **策划文档**：在编辑器内或 README 片段中说明 **ConditionExpr** 与 **Inspect图模式** 的最小示例链接到 `docs/narrative-framework-iteration-plan.md`（可选）。

### 5.8 游戏内调试（非 Qt 编辑器，可选）

- 若已有 in-game debug 面板：增加 **Scenario 桶**只读或受控读写、当前 `ConditionExpr` 求值结果探针（可与项目内 debug 面板扩展流程对齐，后续迭代）。

### 5.9 验收标准（Phase 5 总览）

- [x] 不写手写 JSON 即可完成：一张带 `switch` + `ConditionExpr` + `setScenarioPhase` 的图对话保存并通过 validator（switch/复杂条件仍以节点内表单 + JSON 为主）
- [x] Scenario 清单可编辑，且图条件 / Action 中 scenario 相关下拉与清单一致
- [x] Inspect 热区可配置 `graphId`+`entry`：**主编辑器** [`scene_editor.py`](tools/editor/editors/scene_editor.py) 与 **graph_editor** [`scene_panel.py`](tools/graph_editor/panels/scene_panel.py) 均已支持，与纯 text 互斥
- [x] `document_reveals.json` 可编辑（含 **表达式树** 模式），`revealDocument` 可选到已有 `documentId`
- [x] 共享条件编辑器 + 树控件服务热区、文档揭示等；图对话条件与 switch 与 validator 共用同一套 `ConditionExpr` 扫描
- [x] `blendOverlayImage` 在 [`action_editor.py`](tools/editor/shared/action_editor.py) 带迁移提示

### 主编辑器与 graph_editor 覆盖核对（补充）

| 能力 | 主编辑器 (`tools/editor`) |逻辑图编辑器 (`tools/graph_editor`) |
|------|---------------------------|--------------------------------------|
| Inspect graphId / text / entry / actions | [`scene_editor.py`](tools/editor/editors/scene_editor.py) | [`scene_panel.py` HotspotPanel](tools/graph_editor/panels/scene_panel.py) + `ProjectModel` 加载 |
| 热区 ConditionExpr | [`shared/condition_editor.py`](tools/editor/shared/condition_editor.py)（flag 行 + 树） | 同上（已 re-export，无重复 flag-only 实现） |
| Scenarios / document_reveals | `main_window` 页签 | 需开主编辑器或自行改 JSON（graph_editor 不重复做清单页，与计划「可并行」一致） |
| choice `requireCondition` |图对话编辑器 `node_inspector`（与主工程同源） | 同左 |

**仍可后续加分的非阻断项**：graph_editor 内「一键新建看板图」快捷按钮；在 Qt 图分析窗口中直接展示 `extract_narrative_refs` 结果；任务/遭遇等**其它**面板若仍有仅手输 flag、未接 `ConditionEditor` 的字段，可按页面逐步对齐（与叙事热区无强制绑定）。

---

## 实施顺序与依赖

```
Phase 1: ScenarioStateManager
  ↓
Phase 2: 看板图对话统一
  ↓
Phase 3: 文档揭示系统（可与 Phase 2 并行）
  ↓
Phase 4: 码头事件重构（验证 1+2+3）
  ↓
Phase 5: 编辑器迭代（可与 Phase 1-4 并行，但最后收尾）
```

Phase 2 和 Phase 3 可以并行开发，因为它们之间没有强依赖。
Phase 4 必须在 1/2/3 完成后进行，是整合验证阶段。
Phase 5 编辑器可以提前开始，但需要在 Phase 1-3 的运行时稳定后完成对接。

Phase 5 内部子项（5.1 共享条件、5.2 图对话、5.3 场景热区、5.4 Action、5.5 Scenario、5.6 文档揭示、5.7 校验）可由不同人并行，但建议 **先冻结 `ConditionExpr` 的 JSON 形状与 5.1 控件 API**，再铺开各面板接线，避免返工。

---

## 风险与注意事项

| 风险 | 应对 |
|------|------|
| 旧存档兼容 | `ScenarioStateManager.deserialize` 缺省空状态；不依赖虚构的顶层存档版本号（当前工程无统一 `saveVersion`） |
| 旧热区兼容 | `InspectData` 文本模式保留；`graphId` 为空时走旧逻辑 |
| 对话状态机冲突 | `InteractionCoordinator` 已有 `graphDialogueManager.isActive` 检查，inspect 和 NPC 对话不会重叠 |
| FlagStore 类型验证 | scenario 键不进 `flag_registry.json`；`exposes` 写入的 flag 仍须在登记表中声明若需静态校验 |
| 逻辑条件复杂度 | 编辑器用树形 UI 或缩进 JSON 降低出错率；求值器对递归深度可做合理上限（防恶意/误写极深嵌套） |
| **scenario 清单演进** | 重命名/删除 phase 时提供迁移说明或工具；旧存档内仍保留旧 phase 键时运行时宽松读取，新内容以新清单为准 |
| **内容引用无效** |扩展 [`validator.py`](tools/editor/validator.py)：`graphId` 文件存在、`entry` 节点存在、`documentId` 注册、`scenario` 叶子与清单一致 |
