# 图编排对话系统（Graph Dialogue）详细设计

**版本**：草案 v3  
**前提**：**叙事对话仅采用本方案**（图 JSON + `GraphDialogueManager`）。**不得**以已废除的叙事中间层实现为参照；本文件只描述**目标架构**与 **UI/EventBus 等通用模块**的契约。  
**目标**：对话 = **有向图上的节点** + **严格串行执行**；与 `ActionDef`、`FlagStore`、`Condition`、`QuestManager` **一等公民对接**；**全流程数据驱动**（运行时 JSON + 场景/NPC 数据 + 校验 + 编辑器，缺一不可）。

---

## 1. 与现有系统的关系

| 现有能力 | 在本系统中的用法 |
|----------|------------------|
| [`ActionExecutor.executeForDialogue`](f:\GameDraft\src\core\ActionExecutor.ts) | 节点类型 `runActions` 内**逐条** `await`；与热区 `execute` 非阻塞语义分离 |
| [`ActionDef`](f:\GameDraft\src\data\types.ts) | 节点内嵌 `actions: ActionDef[]`，与 `ActionRegistry` 一致，编辑器枚举校验 |
| [`Condition`](f:\GameDraft\src\data\types.ts) / `FlagStore` | 条件、`switch`、选项可用性、整图 `preconditions` 共用求值入口 |
| [`QuestManager`](f:\GameDraft\src\systems\QuestManager.ts) | 条件联合类型中增加任务状态谓词，内部查询 Quest |
| [`GameState.Dialogue`](f:\GameDraft\src\data\types.ts) | 进入/离开对话由 `GameStateController` 切换 |
| [`InteractionCoordinator`](f:\GameDraft\src\core\InteractionCoordinator.ts) | NPC 交互仅根据 **`dialogueGraphId`**（及可选 `dialogueGraphEntry`）启动图对话；镜头/NPC 准备与现有一致 |
| [`DialogueUI`](f:\GameDraft\src\ui\DialogueUI.ts) | 消费 `dialogue:line` / `dialogue:choices` / `dialogue:prepareBeat` / `dialogue:willEnd` / `dialogue:end` / `dialogue:advanceEnd`；运行时**只发事件** |
| [`EventBridge`](f:\GameDraft\src\core\EventBridge.ts) | 绑定**唯一**对话运行时：`GraphDialogueManager` 的 `advance` / `chooseOption`（**必须** `await` 或推进互斥，禁止 `void` 丢异步） |
| [`DialogueLogUI`](f:\GameDraft\src\ui\DialogueLogUI.ts) | 监听 `dialogue:line`、`dialogue:choiceSelected:log` |

**原则**：单一底栏 UI；单一对话运行时 **`GraphDialogueManager`** + 图资源 + 校验 + 编辑器。

---

## 2. 核心概念

### 2.1 对话图（DialogueGraph）

- **图**：节点集合 + 有向边；**入口**为 `entry` 节点 id。
- **运行时状态**：`graphId`、`currentNodeId`、可选 **调用栈**（子图 `call`/`return`，见 §5.2）。
- **执行语义**：任意时刻**最多一条**「正在执行的节点」；节点未完成（含异步与玩家确认）**不得**进入下一节点。

### 2.2 节点（Node）

每个节点有稳定 **`id`**（图内唯一）、**`type`**、类型相关 **payload**。执行完毕根据类型产生 **0 或 1 条缺省出边**（`line` / `runActions`）或 **多条出边**（`choice` / `switch`）。

### 2.3 编排

「怎么连」= 有向边 **`from` → `to`**，可带 **边条件**（与节点条件同构）。

---

## 3. 数据格式（JSON）

路径约定：`public/assets/dialogues/graphs/<graphId>.json`。

### 3.1 顶层

```json
{
  "schemaVersion": 1,
  "id": "wharf_boy_ring",
  "entry": "n_start",
  "preconditions": [],
  "nodes": { },
  "meta": { "title": "滚铁环小孩" }
}
```

- **`preconditions`**：`Condition[]`，不满足则整图不启动。
- **`nodes`**：`Record<nodeId, NodeDef>`。

### 3.2 节点类型（v1 最小集）

| type | 作用 | 完成后 |
|------|------|--------|
| `line` | 展示一行对白（speaker + text） | 发 `dialogue:line`，等待玩家 advance → 走唯一 `next` |
| `runActions` | 执行 `actions: ActionDef[]` | 逐条 `await executeForDialogue`，无 UI；完成后走 `next` |
| `choice` | 展示选项 | 发 `dialogue:choices`，转为 `DialogueChoice[]`，等待 `chooseOption` → 走选中边 |
| `switch` | 条件分流 | 求值 `cases`，命中第一条，否则 `defaultNext` |
| `end` | 结束对话 | `dialogue:willEnd` → 末拍确认 → `dialogue:advanceEnd` → `dialogue:end`（与 `DialogueUI` 状态机一致，见 §7） |

（`line` / `runActions` / `choice` / `switch` 示例同前版 schema，略；实现以 JSON Schema / TS 类型为准。）

### 3.3 与 Quest 的显式对接

扩展 [`Condition`](f:\GameDraft\src\data\types.ts) 为可辨识联合（如 `ConditionFlag` | `ConditionQuest`），**一处** `evaluateCondition(cond, ctx)`；示例：

```json
{ "quest": "支线-归还小孩铁环-归还铁环", "status": "Active" }
```

### 3.4 文案与本地化

- **v1**：`line.text` 可直接填正文。
- **推荐**：`textKey` 走 [`StringsProvider`](f:\GameDraft\src\core\StringsProvider.ts)；`textKey` 与 `text` 互斥或优先级由校验器规定。

### 3.5 `choice` 与 `LinePayload`

抽取共用 **`LinePayload`**（`speaker` + `text` | `textKey`）；`choice.promptLine` 为 `LinePayload | null`，**禁止**重复嵌套一套与 `line` 节点不一致的字段。

---

## 4. 运行时：`GraphDialogueManager`

### 4.1 职责

- 加载图 JSON（`AssetManager.loadText`）。
- 维护 `context`：`npcId`、`npcName`、`graphId`、`currentNodeId`。
- **单通道**：`advance()` / `chooseOption(i)` 互斥；异步 **必须** settle 后再接下一输入。
- 将节点执行映射为 **`dialogue:*` 事件**（见 §7）。
- `runActions`：不发 `line`；连续 `runActions` 在同一推进链内顺序执行，中间是否 `prepareBeat` 由 §4.3 固定规则规定，**禁止**含糊的「合并优化」。

### 4.2 启动 API

```ts
startDialogueGraph(params: {
  graphId: string;
  entry?: string;
  npcName: string;
  npcId?: string;
}): Promise<void>;
```

`InteractionCoordinator` 在 NPC 配置合法时调用；**唯一**对话入口（另见 Action `startDialogueGraph`）。

### 4.3 节拍

1. `prepareBeat`（除文档 §7 规定的「仅选项保留底栏」例外）。
2. 执行当前节点：`runActions` 全 await → 移下一节点；`line` 发事件后等待 advance；`choice` 发选项后等待选择；`switch` 无 UI，跳到目标并继续直到需停下的节点类型。
3. `end`：`willEnd` → 用户最后一次 advance → `advanceEnd` → 内部 `endDialogue` + `dialogue:end`。

### 4.4 序列化（存档）

保存 `{ active, graphId, npcName, nodeId?, schemaVersion }` 等字段的策略须**显式文档化**：v1 可与全局策略一致——**读档结束对话**不恢复中途，或立项「对话快照」后统一升级。

`schemaVersion` 不匹配时：回退 `entry` 或拒绝加载并日志。

---

## 5. 图结构能力

- **汇合**：允许多父 → 一子。
- **环**：v1 校验器默认**禁止**；需可重复对话时用显式 `maxVisits` / 边类型再开放。
- **子图 v2**：`call` / `return`；v1 用复制节点 + 编辑器模板。

---

## 6. 接入点

| 接入点 | 行为 |
|--------|------|
| **NpcDef** | **`dialogueGraphId`**（必填则对话可用）、**`dialogueGraphEntry`**（可选，缺省用图 `entry`）；旧字段若曾存在「文件路径类对话」应在数据迁移中**删除或映射**，由工程规范规定 |
| **Action** | `startDialogueGraph`：`{ graphId, entry?, npcId? }`，由 `Game` 注入 |
| **热区** | v1 未支持则 validator **禁止**热区填图 id；v1.1 扩展 `HotspotDef` + 协调器 |

---

## 7. UI 与 EventBridge

**单一运行时**：[`EventBridge`](f:\GameDraft\src\core\EventBridge.ts) 只连接 **`GraphDialogueManager`**，**不需要**双后端 Facade。

**必须满足的事件序列**（[`DialogueUI`](f:\GameDraft\src\ui\DialogueUI.ts) / [`DialogueLogUI`](f:\GameDraft\src\ui\DialogueLogUI.ts) / [`ArchiveManager`](f:\GameDraft\src\systems\ArchiveManager.ts) / [`InteractionCoordinator`](f:\GameDraft\src\core\InteractionCoordinator.ts)）：

| 事件 | 说明 |
|------|------|
| `dialogue:start` | 会话开始；`payload` 含 `npcName`，可选 `graphId` |
| `dialogue:prepareBeat` | 每拍清 UI 前的节拍（「仅选项」时是否跳过以 **本文件 §7.1** 为准，**不**外引已废除实现） |
| `dialogue:line` | 一行对白 |
| `dialogue:choices` | 选项列表 |
| `dialogue:choiceSelected:log` | 选项确定后打日志 |
| `dialogue:willEnd` | 进入「最后一拍需点击结束」 |
| `dialogue:advance` / `dialogue:advanceEnd` | 与 `DialogueUI.handleAdvance` 一致 |
| `dialogue:end` | 会话结束；协调器做镜头/NPC 清理 |

**§7.1 仅选项时的底栏**：若 `choice` 无 `promptLine`，须规定：**要么**先发一行空说话人占位 + 选项，**要么**在 `DialogueUI` 层支持「仅选项」布局；**二选一写进实现并在手测清单验收**。

**异步**：`advance` 在运行时内部未完成时，应忽略重复触发或队列一条，避免重入。

---

## 8. 校验与工具（数据驱动闭环）

### 8.1 TypeScript

- 加载后校验结构；`action.type` ∈ Registry；死边检测。

### 8.2 Python `validator.py`

- `ProjectModel.all_graph_dialogue_files()` 扫描 `graphs/*.json`。
- NPC：`dialogueGraphId` 文件存在；`dialogueGraphEntry` 合法。
- 图内：`entry`、所有 `next`、选项目标、无非法环（按 §5）。
- 图内 `actions[].type` ∈ [`ACTION_TYPES`](f:\GameDraft\tools\editor\shared\action_editor.py)。

### 8.3 桌面编辑器（交付物）

| 组件 | 职责 |
|------|------|
| **图编辑** | 节点、有向边、`entry`、保存为 `graphs/<id>.json` |
| **步进模拟器** | 本地步进 `line` / `choice` / `switch`；`runActions` 可标为模拟或接假 flag |
| **主窗口** | 菜单入口打开图对话工程 |
| **场景编辑器 NPC 面板** | 配置 `dialogueGraphId` / `dialogueGraphEntry` |

实现时可参考**通用节点图编辑器**交互（画布、列表、属性面板），**不要求**复用任何已废除工具代码。

### 8.4 JSON Schema

`dialogue-graph.schema.json`（或生成）与 TS 类型对齐，供 IDE 与 CI。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 场景数据入口配错 | validator + 运行时 assert |
| 图变大难维护 | `meta`、子图 v2、强校验 |
| `void advance` 竞态 | 互斥 + 可选 UI 禁连点 |
| 版本与存档 | `schemaVersion`、读档策略显式化 |

---

## 10. 落地顺序

1. `types.ts`：`DialogueGraphDef`、节点联合、`Condition` 联合与求值。  
2. `validator.py` + `ProjectModel` + NPC 规则。  
3. `GraphDialogueManager` + `EventBridge` 直连 + 全事件契约 + 推进互斥。  
4. `InteractionCoordinator` + `NpcDef` + 场景编辑器 + validator。  
5. `choice` / `switch` / `DialogueChoice` 完整映射。  
6. `ActionRegistry` + `action_editor.py` 增加 `startDialogueGraph`；`Game` 注入。  
7. 桌面图编辑器 + 模拟器。  
8. 热区（按 §6）或显式禁止。

---

## 11. 非目标（v1）

- 不实现通用脚本语言 VM；仅本图 DSL。  
- 不在 v1 做子图 `call`（可列 v2）。  
- 不承诺对话中途存档精确恢复节点（除非单独立项）。

---

## 12. 实现审查清单（原 P1–P17，去 Ink 化）

| 编号 | 项 | 决议 |
|------|----|------|
| P1 | EventBridge 单后端 | 仅 `GraphDialogueManager` |
| P2 | 异步推进 | 互斥 + 禁止无等待 fire-and-forget |
| P3 | 事件全集 | §7 表逐项实现并验收 |
| P4 | `end` 与 UI | `willEnd` → `advanceEnd` → `end`，与 `DialogueUI` 一致 |
| P5 | 仅选项底栏 | §7.1 固定策略 |
| P6 | 存档 | `serialize`/`deserialize` 行为显式文档化 |
| P7 | NPC 入口 | 仅 `dialogueGraphId` / `entry` |
| P8 | 对话中再开对话 | `isActive` 时 warn 或拒绝 |
| P9 | Condition | TS 联合 + 求值单点 + Python 校验 |
| P10 | 选项 index | `index` ↔ 选项 id 稳定映射 |
| P11 | LinePayload | 抽取共用，禁止重复 schema |
| P12 | ACTION_TYPES | 与 TS 同步策略（生成或双改同 PR） |
| P13 | 编辑器与 MVP 同迭代 | 已 §10 |
| P14 | 热区 | §6 禁止或做全 |
| P15 | 环 | §5 / §8.2 |
| P16 | Game 依赖注入 | 与现有系统构造 `Game` 时一致注入 |
| P17 | JSON Schema | §8.4 |

---

*审查项 P1–P17 关闭时应在 PR 中勾选。本文档不引用已废除的叙事实现为设计依据。*
