# 规矩系统迭代方案 — 象理术分层

> 将现有扁平的规矩系统重构为三层深度结构（象 / 理 / 术），同时**严格保留**所有现存数据约定与公开行为。
>
> **核心变更**：每条 `RuleDef` 内嵌可选的 `layers` 描述（象 / 理 / 术），每条 `RuleFragmentDef` 标注归属哪一层；遭遇 / 对话 / 区域可选地查询"已知到哪一层"。
>
> **定位**：`RulesManager` 仍是项目内规矩与碎片的唯一权威；不耦合 UI 与遭遇逻辑，对外接口在保留旧契约的基础上增量扩展。

---

## 一、前置事实清单（迁移前必读）

下列事实贯穿现有代码与数据，**新方案必须兼容**，否则会破坏游戏与编辑器中的引用：

1. `RulesManager` 在每次规矩 / 碎片状态变化时，会向 [`FlagStore`](../src/core/FlagStore.ts) 写入若干 flag，被 `encounters.json` / `graphs/*.json` / `books.json` / `*.ink` 直接 `flag:` 引用：
   - `rule_<ruleId>_acquired: bool` — 完整规矩已掌握（`giveRule` 或碎片自动合成时写入）
   - `rule_<ruleId>_discovered: bool` — 至少收集到一个碎片
   - `rule_<ruleId>_fragments_collected: number` / `rule_<ruleId>_fragments_total: number` — 碎片进度
   - `fragment_<fragmentId>_acquired: bool`
   - `rule_used_<ruleId>: bool` — 由 `EventBridge` 在 `ruleUse:apply` 时写入
2. 这些 flag 的合法性由 [`flag_registry.json`](../public/assets/data/flag_registry.json) 的 `static` 与 `patterns` 段约束（`rule_acquired` / `rule_discovered` / `rule_fragments_collected` / `rule_fragments_total` / `fragment_acquired` / `rule_used` 共 5 条 pattern + 若干 static 项）。
3. 现存数据中的硬编码引用（**改字段不改 flag 名是底线**）：
   - `public/assets/data/encounters.json` 用 `flag: rule_rule_no_go_night_acquired`
   - `public/assets/data/archive/books.json` 用 `flag: rule_rule_ghost_origin_acquired`
   - `public/assets/dialogues/graphs/码头看板官差.json` 用 `requireFlag: rule_rule_no_go_night_acquired` 与 `ruleHintId: rule_no_go_night`
   - `public/assets/dialogues/*.ink` 用 `# require:rule_rule_no_go_night_acquired`、`# ruleHint:rule_zombie_fire`
   - `public/assets/scenes/test_room_b.json` 的 `enableRuleOffers` slots 内嵌 `giveRule` 动作
4. [`IRulesDataProvider`](../src/data/types.ts) 是 UI 层访问规矩数据的契约，至少 `getAcquiredRules` / `getDiscoveredRules` / `getFragmentProgress` / `hasRule` / `hasFragment` / `getRuleDef` / `isDiscovered` / `getCategoryName` / `getVerifiedLabel` / `incompleteName` 字段都被 [`RulesPanelUI`](../src/ui/RulesPanelUI.ts) 与 [`RuleUseUI`](../src/ui/RuleUseUI.ts) 直接消费。
5. [`ActionRegistry`](../src/core/ActionRegistry.ts) 注册了 `giveRule` / `giveFragment` 两个 Action；前者被 `enableRuleOffers` 数据使用，**不能删**。
6. [`EncounterManager`](../src/systems/EncounterManager.ts) 检查 `requiredRuleId` 时**只读 FlagStore**（`rule_xxx_acquired` / `rule_xxx_discovered`），不直接调 RulesManager 接口；这是已有的解耦设计，新方案应保持。
7. [`GraphDialogueManager`](../src/systems/GraphDialogueManager.ts) 通过 `rulesManager.getRuleDef(ruleHintId)?.name` 取规矩名渲染禁用提示，新结构必须仍能返回 `name`。
8. [`tag_catalog.py`](../tools/editor/shared/tag_catalog.py) 与 [`ref_validator.py`](../tools/editor/shared/ref_validator.py) 校验 `[tag:rule:<id>]` 与 rules / fragments 内嵌引用；现行扫描包括 `rule.name / description / source / incompleteName` 与 `fragment.text / source`。
9. [`copy_manager/constants.py`](../tools/copy_manager/constants.py) 的 `JSON_EXTRACTION_RULES` 列死了 `rules.json` 抽取字段为 `["name", "description", "source", "incompleteName"]`，`NESTED_EXTRACTION_RULES` 抽 `fragments` 的 `["text", "source"]`；schema 改名后必须同步登记。
10. 旧存档形如 `{ acquiredRules: string[], acquiredFragments: string[] }`；新版本必须能读旧存档并语义保持（已掌握的规矩→新结构里被视为"三层均已解锁"）。

> 上述任何一条若被破坏，等同回归失败。所有 schema 变更必须配套数据迁移脚本与编辑器更新。

---

## 二、设计动机

### 现状问题

现有 `rules.json` 中每条规矩是扁平的：

```json
{
  "id": "rule_zombie_fire",
  "name": "白毛僵尸怕火",
  "description": "据说白毛僵尸最怕火……",
  "fragmentCount": 2
}
```

- 辨识信息（"白毛僵尸长什么样"）、原理信息（"魄锁于体不散"）、应对方法（"用火对付"）全部塞在一段 `description`。
- `EncounterManager` 检查 `requiredRuleId` 是二元的：`rule_xxx_acquired` 才解锁选项；玩家无法只凭"知道这是什么"做出局部判断。
- 玩家面对一条规矩时，对其理解深度无从展示。

### 目标

- 规矩知识分三层：**象**（表象）→ **理**（原理）→ **术**（应对方法）
- 玩家可能"知象不知术"或"知术不知理"，遭遇 / 对话 / 区域可基于"已知层"判定可选项
- **不破坏**任何现存数据格式与 flag 约定；旧 `description` 通过迁移脚本拆为 `layers`，旧 `giveRule` / `giveFragment` 行为完全保留

---

## 三、数据格式变更

### 3.1 RuleDef（[`src/data/types.ts`](../src/data/types.ts)）

**旧结构**（保留以便兼容判断）：
```typescript
interface RuleDef {
  id: string;
  name: string;
  incompleteName?: string;
  category: 'ward' | 'taboo' | 'jargon' | 'streetwise';
  description: string;
  source: string;
  sourceType: 'npc' | 'fragment' | 'experience';
  verified: 'unverified' | 'effective' | 'questionable';
  fragmentCount?: number;
}
```

**新结构**：
```typescript
type RuleLayerKey = 'xiang' | 'li' | 'shu';

interface RuleLayerDef {
  /** 完全解锁该层后展示的正文（编辑器写死的固定文案） */
  text: string;
  /** 可选：该层未解锁时面板上的占位（不填则走 strings.rulesPanel.hidden） */
  lockedHint?: string;
}

interface RuleDef {
  id: string;
  name: string;
  /** 至少一层未解锁时，规矩条目以该名称出现（保留旧字段，含义不变） */
  incompleteName?: string;
  category: 'ward' | 'taboo' | 'jargon' | 'streetwise';
  /** 至少要填一层；未列出的层视为该规矩不存在该深度 */
  layers: Partial<Record<RuleLayerKey, RuleLayerDef>>;
  /** 来源类型仍由 fragment 自带（见 3.2）；规矩级 source / sourceType / description / fragmentCount 字段移除 */
  verified: 'unverified' | 'effective' | 'questionable';
}
```

**变更说明**：
- `description` / `source` / `sourceType` / `fragmentCount` 字段删除；`description` 的内容由迁移脚本拆入 `layers`，`source` 信息由各 fragment 单独承担。
- `incompleteName` 保留，语义不变（"未完整掌握时的占位名"）。
- `category` / `verified` 保留；顶级 `categories` / `verifiedLabels` 字典维持不变。
- 三层均为可选；同一规矩允许只填 1～3 层（如行话类只填 `shu`）。`layers` 必须至少有一层非空，否则该规矩没有任何可解锁内容。

### 3.2 RuleFragmentDef

**旧结构**：
```typescript
interface RuleFragmentDef {
  id: string;
  text: string;
  ruleId: string;
  index: number;
  source?: string;
}
```

**新结构**：
```typescript
interface RuleFragmentDef {
  id: string;
  text: string;
  ruleId: string;
  /** 必填：该碎片解锁的目标层 */
  layer: RuleLayerKey;
  /** 必填：碎片来源（旧 source 升为必填，避免 UI 上 "—— ?" 出现） */
  source: string;
}
```

- `index` 移除：层内按数组顺序排序即可。
- `layer` 新增、必填；目标层必须在所属规矩的 `layers` 中存在。
- 旧 fragment 的 `source` 已是常态，迁移时若个别缺失要求人工补齐。

### 3.3 顶级 JSON 结构（不变）

`public/assets/data/rules.json` 顶级保留：
```json
{
  "categories":     { "ward": "避祸", "taboo": "禁忌", "jargon": "行话", "streetwise": "江湖" },
  "verifiedLabels": { "unverified": "未验证", "effective": "有效", "questionable": "存疑" },
  "rules":     [...],
  "fragments": [...]
}
```

### 3.4 示例（迁移后）

```json
{
  "rules": [
    {
      "id": "rule_zombie_fire",
      "name": "白毛僵尸怕火",
      "incompleteName": "某种关于僵尸的传闻",
      "category": "ward",
      "layers": {
        "xiang": { "text": "浑身长白毛的尸体会动，刀枪不入。" },
        "li":    { "text": "魄锁于体不散，化为白僵；阴气聚于肉身，故铜皮铁骨。" },
        "shu":   { "text": "怕火，桃木点燃最佳，寻常松脂火把也管用。糯米可阻其行。" }
      },
      "verified": "unverified"
    },
    {
      "id": "rule_no_go_night",
      "name": "城隍庙后山三更勿去",
      "category": "taboo",
      "layers": {
        "xiang": { "text": "城隍庙后山半夜三更有白影子飘来飘去，还会唱戏。" }
      },
      "verified": "unverified"
    }
  ],
  "fragments": [
    {
      "id": "frag_zombie_fire_01",
      "text": "听一个老道说过，僵尸这东西，年份越久越厉害，白毛的最怕火……",
      "ruleId": "rule_zombie_fire",
      "layer": "shu",
      "source": "老道士"
    }
  ]
}
```

---

## 四、运行时语义

### 4.1 层的"已解锁"判定

为避免歧义，统一规则：

- **某层 `L` 视为已解锁**，当且仅当该层在 `rule.layers` 中有定义，并且：
  - 该层下所有 `fragment.layer === L` 的碎片均已收集；**或**
  - 该层被 `grantLayer(ruleId, L)` 直接授予（用于亲身经历等情况）。
- 若某层在 `rule.layers` 中无定义，则视为该规矩在该层"无内容"，既不计入分母也不会被解锁。
- **整条规矩 `acquired` 的旧语义保留**：当且仅当 `rule.layers` 中所有已定义的层都已解锁，等价于 `hasRule(ruleId) === true`，并对应写入 `rule_<id>_acquired = true`。
  - 因此旧 `giveRule(ruleId)` 等价于"对该规矩所有已定义层执行 `grantLayer`"。
  - 单层规矩（如只有 `xiang`）解锁该层即立即视为完整规矩。

### 4.2 RulesManager 接口（[`src/systems/RulesManager.ts`](../src/systems/RulesManager.ts)）

#### 内部状态（新）

```typescript
private ruleDefs:        Map<string, RuleDef> = new Map();
private fragmentDefs:    Map<string, RuleFragmentDef> = new Map();
private categoryNames:   Record<string, string> = {};
private verifiedLabels:  Record<string, string> = {};

private acquiredFragments: Set<string> = new Set();
/** 通过 grantLayer / giveRule 直接授予的层；与 fragments 路径并存 */
private grantedLayers:     Map<string, Set<RuleLayerKey>> = new Map();
```

> 注意：不再单独存 `acquiredRules`；规矩"完整掌握"由"所有已定义层都解锁"派生。`giveRule` 内部退化为"对所有已定义层调 `grantLayer`"。

#### 公开接口（向后兼容 + 新增）

**保留旧契约（行为不变）**：
```typescript
giveRule(ruleId: string): void;          // 等价于对所有已定义层 grantLayer
giveFragment(fragmentId: string): void;
hasRule(ruleId: string): boolean;        // 派生：所有已定义层均已解锁
hasFragment(fragmentId: string): boolean;
getRuleDef(ruleId: string): RuleDef | undefined;
getCategoryName(key: string): string;
getVerifiedLabel(key: string): string;
isDiscovered(ruleId: string): boolean;   // 至少一个 fragment 已获且尚未完整掌握
getDiscoveredRules(): { def: RuleDef; collected: number; total: number }[];
getAcquiredRules(): { def: RuleDef; acquired: boolean }[];
getFragmentProgress(ruleId: string):
  { collected: number; total: number; fragments: RuleFragmentDef[] };
getPendingFragments(): RuleFragmentDef[];
```

> `getFragmentProgress.collected/total` 为该规矩**所有层**碎片之和，与现行 `EncounterManager` 显示语义一致。

**新增**：
```typescript
type RuleLayerKey = 'xiang' | 'li' | 'shu';

/** 已解锁层数 / 已定义层数（用于 depth 比较） */
getRuleDepth(ruleId: string): { unlocked: number; total: number };

/** 单层解锁判定 */
hasLayer(ruleId: string, layer: RuleLayerKey): boolean;

/** 已解锁层的正文（key 缺失即未解锁） */
getUnlockedLayerTexts(ruleId: string): Partial<Record<RuleLayerKey, string>>;

/** 按层统计碎片进度（仅包含 rule.layers 中已定义的层） */
getLayerFragmentProgress(ruleId: string):
  Partial<Record<RuleLayerKey,
    { collected: number; total: number; fragments: RuleFragmentDef[] }>>;

/** 直接授予某一层（亲身经历 / 演出补全等用途） */
grantLayer(ruleId: string, layer: RuleLayerKey): void;
```

`IRulesDataProvider` 同步扩展上述新增方法（保留全部旧方法）。

### 4.3 FlagStore 同步策略（向后兼容关键）

`giveFragment` / `grantLayer` / `giveRule` 触发后，按以下规则维护 FlagStore，**保证旧引用全部继续工作**：

| flag | 何时写入 / 更新 | 备注 |
|------|----------------|------|
| `fragment_<fid>_acquired = true` | 收集该碎片 | 不变 |
| `rule_<id>_discovered = true` | 至少一个碎片已收集 | 不变 |
| `rule_<id>_fragments_collected: number` | 全部层碎片之和 | 不变（语义同 `getFragmentProgress.collected`） |
| `rule_<id>_fragments_total: number` | 全部层碎片之和 | 不变 |
| `rule_<id>_acquired = true` | 所有已定义层均解锁时 | **派生**，与旧语义等价 |
| `rule_<id>_<layer>_done = true` | 对应层解锁时 | **新增**，需在 `flag_registry.json` 增 pattern（见 §6.3） |

`rule_used_<id>` 仍由 `EventBridge` 在 `ruleUse:apply` 中写入，与本系统无关。

### 4.4 事件（向后兼容）

```typescript
// 既有：保留以维持 NotificationUI 与外部监听
eventBus.emit('rule:fragment', { fragmentId, ruleId });
eventBus.emit('rule:acquired', { ruleId, name });           // 派生：所有层解锁时

// 新增：层级粒度
eventBus.emit('rule:layer',    { ruleId, layer, source: 'fragment' | 'grant' });
```

`notification:show` 维持现状：
- 收集到碎片：`type: 'rule'`，文案 `notifications.fragmentAcquired`
- 三层全齐（即旧 acquired）：`type: 'rule'`，文案 `notifications.ruleAcquired`（带 `{name}`）
- 自动合成：`notifications.fragmentSynthesized`
- 仅单层解锁但规矩未完整：**不**新增通知（避免打扰玩家），由 UI 自行展现（面板高亮、风物志徽章等）

### 4.5 序列化 / 反序列化（[`RulesManager.serialize`](../src/systems/RulesManager.ts)）

**新格式**：
```typescript
{
  acquiredFragments: string[];
  grantedLayers: Record<string, RuleLayerKey[]>;
}
```

**反序列化兼容旧存档**：
```typescript
deserialize(data: {
  acquiredFragments?: string[];
  grantedLayers?:     Record<string, RuleLayerKey[]>;
  // 旧字段
  acquiredRules?:     string[];
}): void {
  this.acquiredFragments = new Set(data.acquiredFragments ?? []);
  this.grantedLayers = new Map(
    Object.entries(data.grantedLayers ?? {})
      .map(([rid, ls]) => [rid, new Set(ls)] as const),
  );
  // 旧存档：把 acquiredRules 内的规矩转换为对所有已定义层的 grant
  for (const rid of data.acquiredRules ?? []) {
    const def = this.ruleDefs.get(rid);
    if (!def) continue;
    const set = this.grantedLayers.get(rid) ?? new Set<RuleLayerKey>();
    for (const layer of Object.keys(def.layers) as RuleLayerKey[]) {
      set.add(layer);
    }
    this.grantedLayers.set(rid, set);
  }
  // 之后：根据 acquiredFragments + grantedLayers 重算并写回所有相关 flag
  this.resyncAllRuleFlags();
}
```

`resyncAllRuleFlags` 遍历所有规矩，按 §4.3 写入 `rule_<id>_*` 与 `fragment_<id>_acquired` 系列 flag，确保读档后游戏内条件判断正确。

---

## 五、消费方对接

### 5.1 EncounterManager（[`src/systems/EncounterManager.ts`](../src/systems/EncounterManager.ts)）

`EncounterOptionDef` 新增可选字段（**不破坏旧数据**）：

```typescript
interface EncounterOptionDef {
  text: string;
  type: 'general' | 'rule' | 'special';
  conditions: ConditionExpr[];
  requiredRuleId?: string;
  /** 新增：要求已解锁的层。未填时退化为旧语义（要求规矩完整掌握）。 */
  requiredRuleLayers?: RuleLayerKey[];
  consumeItems?: { id: string; count: number }[];
  resultActions: ActionDef[];
  resultText?: string;
}
```

`generateOptions` 修改（**保持现有 FlagStore 优先策略**，避免引入新依赖）：

- `requiredRuleLayers` 未填 → 走旧分支：检查 `rule_<id>_acquired` / `rule_<id>_discovered`，提示文案与现状一致。
- `requiredRuleLayers` 已填 → 检查 `rule_<id>_<layer>_done` 全部为 true：
  - 全部满足：选项正常显示。
  - 部分满足：选项灰色，提示文案 `encounter.layerInsufficient`（见 §6.4）。
  - 一个都没解锁：与旧"碎片不足"分支等价显示（已是 discovered 时显示 incompleteName）。

> 仍只读 FlagStore，避免编辑器场景下与 RulesManager 的循环依赖。

### 5.2 RulesPanelUI（[`src/ui/RulesPanelUI.ts`](../src/ui/RulesPanelUI.ts)）

- "已掌握"分区：`getAcquiredRules()` 不变（语义为 `hasRule`）。条目内部按 xiang / li / shu 顺序展示已解锁层 `text`；旧 `description` 渲染分支整段替换为按层渲染。
- "搜集中"分区：`getDiscoveredRules()` 不变；展开后改为按层显示进度条 + 已得碎片，未解锁层显示 `lockedHint ?? strings.rulesPanel.hidden`。
- 旧 `r.def.source` 整段移除（`source` 字段已迁移到 fragment）；fragment 行的"-- 老道士"渲染保留不变。
- `incompleteName` / `category` / `verifiedLabel` 渲染逻辑不变。

### 5.3 RuleUseUI（[`src/ui/RuleUseUI.ts`](../src/ui/RuleUseUI.ts)）

- 当前判断 `rulesData.hasRule(slot.ruleId)` → 启用；**保留**该路径作为默认。
- `ZoneRuleSlot` 新增可选字段 `requiredLayers?: RuleLayerKey[]`（数据形状改动详见 §5.4），`RuleUseUI` 在 `requiredLayers` 存在时改用 `hasLayer` 全部判定即可启用。
- 显示名仍走 `incompleteName` 分支（任意所需层未解锁则灰）。

### 5.4 ZoneRuleSlot 与 RuleOfferRegistry

[`ZoneRuleSlot`](../src/data/types.ts) 增加可选字段：
```typescript
interface ZoneRuleSlot {
  ruleId: string;
  /** 新增：仅需指定层即可使用；未填等价于完整 hasRule */
  requiredLayers?: RuleLayerKey[];
  resultActions: ActionDef[];
  resultText?: string;
}
```

`RuleOfferRegistry.register` 透传 `requiredLayers`；`enableRuleOffers` Action 透传至 `RuleOfferRegistry`（[`ActionRegistry`](../src/core/ActionRegistry.ts) 内已有的 `enableRuleOffers` handler 增加字段映射）。

### 5.5 GraphDialogueManager 的 ruleHintId

不变。`ruleHintId` 仍指向 ruleId，禁用提示走 `rulesManager.getRuleDef(id)?.name`，新结构下 `name` 字段保留，无需改动。

### 5.6 ActionRegistry

- `giveRule(id)` / `giveFragment(id)` **保留**，行为按 §4.1 / §4.2 调整。
- 新增 Action（编辑器与 validator 同步登记，见 §6）：
  - `grantRuleLayer { id, layer: RuleLayerKey }` — 直接授予某层（亲历演出 / 调试用）
- `enableRuleOffers` 的 `slots` 字段透传新增的 `requiredLayers`。

### 5.7 NotificationUI

无需改动。事件类型仍为 `rule`，颜色仍取 `notifRule`。

---

## 六、编辑器与工具链同步

> 这是原版方案漏掉的关键部分；不同步则编辑器无法保存或校验失败。

### 6.1 主编辑器（[`tools/editor/`](../tools/editor/)）

#### `editors/rule_editor.py`
- Rules Tab 表单：移除 `description` / `source` / `sourceType` / `fragmentCount` 三栏；新增 `layers` 编辑区：三个可折叠分组（象 / 理 / 术），各组含 `RichTextTextEdit`（text）+ 可选 `RichTextLineEdit`（lockedHint），加 "启用此层" 复选框控制 key 是否落入 JSON。
- Fragments Tab 表单：移除 `index`；新增 `layer` 下拉（必填，三选一），并在 ruleId 切换时根据所选规矩可用层动态过滤；`source` 改为必填。
- `_apply_rule` / `_add_rule`：写回新结构，并在保存前确认 `layers` 至少有一项非空。
- `_apply_frag`：保存前校验 `layer` 在所选规矩的 `layers` 列表内。

#### `editors/encounter_editor.py`（`OptionWidget`）
- 在 `requiredRuleId` 行下方新增 `requiredRuleLayers`（多选 chip：象 / 理 / 术）；为空表示沿用旧语义。
- `to_dict` 仅在非空时写入 `requiredRuleLayers`，避免无意义的空数组污染老数据。
- `_validate_before_apply` 校验：所选层都存在于目标规矩的 `layers` 中。

#### `editors/scene_editor.py`（`enableRuleOffers` 的 slots 编辑器）
- `slots` 子表新增 `requiredLayers` 多选；为空保持旧行为。

#### `shared/action_editor.py`（`ACTION_TYPES`）
- 新增 `grantRuleLayer`，注册其参数 schema（`id`: rule 引用，`layer`: 三选一）。

#### `shared/ref_validator.py`（`validate_all_embedded_refs`）
- 移除对 `rule.description` / `rule.source` 的扫描；新增对 `rule.layers.{xiang|li|shu}.text` 与 `lockedHint` 的扫描。
- fragments 的 `text` / `source` 扫描保留。

#### `shared/tag_catalog.py`（`list_rules`）
- `[tag:rule:<id>]` 列表展示仍取 `r.get("name")`，无需改动；`validate_exists` 不变。

#### `validator.py`
- rule 校验段：新增 "至少一层有效"、"layer.text 非空" 检查；移除 `fragmentCount` 与 fragment count 一致性的校验。
- fragment 校验段：新增 `layer ∈ {xiang, li, shu}` 必填、且对应 `rule.layers[layer]` 存在；保留 `ruleId in rule_ids` 校验。
- encounter 校验段：在 `requiredRuleLayers` 非空时校验每个层都在目标规矩的 `layers` 中。
- `_walk_action_defs`：识别 `grantRuleLayer`，校验 `id`/`layer` 与规矩定义匹配。
- `_append_action_param_ref_issues`：`enableRuleOffers` 嵌套 `slots` 校验 `requiredLayers` 在目标规矩内。

### 6.2 图编辑器（[`tools/graph_editor/`](../tools/graph_editor/)）

#### `panels/rule_panel.py`
- 与主编辑器 `rule_editor.py` 保持一致：删旧字段、加 layers 三栏 + lockedHint。

#### `panels/encounter_panel.py`
- 同步主编辑器的 `requiredRuleLayers` 多选与 `to_dict` 写回。

#### `model/node_types.py` / `parsers/json_parser.py` / `serializer.py`
- 这些文件通过 `data` 透传保存数据，schema 改动后通常无需改动，但需要回归读取 / 保存场景确认无字段丢失。

### 6.3 文案抽取（[`tools/copy_manager/`](../tools/copy_manager/)）

#### `constants.py` 的 `JSON_EXTRACTION_RULES`
将 `rules.json` 的字段从：
```python
fields=["name", "description", "source", "incompleteName"]
```
改为：
```python
fields=["name", "incompleteName"]
```

#### `NESTED_EXTRACTION_RULES["public/assets/data/rules.json"]`
原仅含：
```python
[("fragments", ["text", "source"])]
```
扩展为：
```python
[
    ("fragments", ["text", "source"]),
    ("layers.xiang", ["text", "lockedHint"]),
    ("layers.li",    ["text", "lockedHint"]),
    ("layers.shu",   ["text", "lockedHint"]),
]
```
> 若现有 `_scan_nested_array` 不支持 dict 路径（仅 array），需要在 `scanner/json_scanner.py` 内增加 dict-typed sub-path 分支；此扩展在迁移阶段单独提交并补对应测试场景，避免与 schema 迁移混在一个 PR。

### 6.4 strings.json（玩家可见文案）

新增（不删除任何旧 key）：
```json
{
  "rulesPanel": {
    "layerXiang": "象",
    "layerLi":   "理",
    "layerShu":  "术"
  },
  "encounter": {
    "layerInsufficient": "对此事的「{layers}」尚无头绪。"
  }
}
```
- `notifications.ruleAcquired` / `fragmentAcquired` / `fragmentSynthesized` 维持现状。
- `rulesPanel.empty` / `hidden` / `unknown` 维持现状。

### 6.5 flag_registry.json

在 `patterns` 段新增（保留全部旧 pattern）：
```json
{
  "id": "rule_layer_done",
  "prefix": "rule_",
  "suffix": "_done",
  "idSource": "rule",
  "valueType": "bool"
}
```
> 该 pattern 会同时匹配 `rule_<id>_xiang_done` / `rule_<id>_li_done` / `rule_<id>_shu_done`。需要在 `flag_registry` 校验侧确认 `idSource: rule` 在 `<id>_<layer>` 这种合成 key 下不会误判；若校验过严，可改为 3 条独立 pattern（`prefix: rule_`, `suffix: _xiang_done` 等）。

`static` 段不需要变化。已存在的 `rule_rule_no_go_night_acquired` / `rule_rule_ghost_origin_acquired` 在迁移后仍然合法（语义不变）。

---

## 七、数据迁移

### 7.1 迁移目标

把现行 `public/assets/data/rules.json` 中所有规矩 / 碎片转换为新结构，**不丢失任何已使用的引用**：
- 4 条规矩：`rule_no_go_night` / `rule_zombie_fire` / `rule_ghost_verified` / `rule_ghost_origin`
- 5 条碎片：`frag_zombie_fire_01/02` / `frag_ghost_origin_01/02/03`

### 7.2 迁移步骤

1. **人工拆分 description → layers**（不能脚本化，需要策划判断）。例如 `rule_zombie_fire`：
   - `xiang`：白毛僵尸的外观特征
   - `li`：白僵的成因
   - `shu`：怕火 / 桃木 / 糯米
2. **人工分配现有 fragment 到层**：依据每条 fragment 文本判断 `layer`。
   - `frag_zombie_fire_01`（"白毛的最怕火"）→ `shu`
   - `frag_zombie_fire_02`（"火光所及，其不敢进"）→ `shu`
   - `frag_ghost_origin_01`（戏曲细节）→ `xiang`
   - `frag_ghost_origin_02`（柳家戏班传闻）→ `li`
   - `frag_ghost_origin_03`（"她不是在害人"）→ `xiang`
3. **删除字段**：`description` / `source` / `sourceType` / `fragmentCount`（rule）；`index`（fragment）。
4. **保留字段**：`id` / `name` / `incompleteName` / `category` / `verified`（rule）；`id` / `text` / `ruleId` / `source`（fragment）。
5. **写迁移脚本** `tools/maintenance/migrate_rules_v2.py`：
   - 输入：当前 `rules.json`（旧）+ 一份人工标注的"layer 分配表"（YAML 或 JSON）
   - 输出：新 `rules.json`，含 `layers` 与 fragment 的 `layer`
   - 保留 `categories` / `verifiedLabels` 顶级字典原样
   - 在脚本里做完整性检查：每条 rule 至少一层；每个 fragment 的 layer 必须在所属 rule 的 layers 中
6. **就地替换** `rules.json` 后跑一次主编辑器 Validate Data；通过后跑一次完整试玩流程（含 `test_room_b` 的 `enableRuleOffers`、`码头看板官差` 对话、`old_box_encounter` 与 `ghost_encounter`）验证：
   - `rule_<id>_acquired` flag 仍按旧语义触发
   - 三层全齐才弹"规矩本新增"，否则只弹"获得规矩碎片"
   - 灰色选项的提示文案正确

### 7.3 旧数据兼容（过渡期）

`RulesManager.loadDefs` 需要做一次"软兼容"，便于在迁移完成前 / 演示分支上仍能跑：
```typescript
function normalizeRuleDef(raw: any): RuleDef {
  if (raw.layers) return raw as RuleDef;
  // 兼容旧字段：description 全部塞 xiang，便于 dev 模式调试
  return {
    id: raw.id,
    name: raw.name,
    incompleteName: raw.incompleteName,
    category: raw.category,
    verified: raw.verified ?? 'unverified',
    layers: { xiang: { text: raw.description ?? raw.name } },
  };
}

function normalizeFragmentDef(raw: any): RuleFragmentDef {
  return {
    id: raw.id,
    text: raw.text,
    ruleId: raw.ruleId,
    layer: (raw.layer ?? 'xiang') as RuleLayerKey,
    source: raw.source ?? '',
  };
}
```
> **正式发布前必须把 `rules.json` 全量迁移**；兼容路径仅供过渡期 / 单元调试使用，不当作长期 fallback。

### 7.4 存档迁移

无需独立工具：`RulesManager.deserialize` 内已包含旧 `acquiredRules` → `grantedLayers` 的转换（§4.5）。读档完成后立即 `resyncAllRuleFlags`，所有 `rule_<id>_*` flag 自动恢复到新语义。

---

## 八、实施顺序（与项目惯例一致）

> 每个 Phase 单独提交 / 单独可回归。所有改动经 `editor-tools-iteration` 与 `feature-iteration` SKILL 流程把关。

### Phase 1：类型与 RulesManager
- 修改 `src/data/types.ts`：新增 `RuleLayerKey` / `RuleLayerDef`；`RuleDef.layers`，`RuleFragmentDef.layer`；保留旧字段以便兼容窗口期编译通过。
- 重写 `RulesManager` 内部状态 / `serialize` / `deserialize` / `loadDefs`（含 §7.3 normalize）。
- 新增 `getRuleDepth` / `hasLayer` / `getUnlockedLayerTexts` / `getLayerFragmentProgress` / `grantLayer`。
- `IRulesDataProvider` 同步扩展。
- 调整 `giveRule` / `giveFragment` 行为为新语义。
- 单文件回归：UI / Encounter / Action / GraphDialogue 仍按旧契约工作。

### Phase 2：FlagStore 写入与 flag_registry
- 新增 `rule_<id>_<layer>_done` 写入逻辑，旧 5 类 flag 维持写入。
- 在 `flag_registry.json` 增 `rule_layer_done` pattern。
- 跑一次 Validate Data 与 dev 试玩，确认未触发未知 flag 警告。

### Phase 3：rules.json 数据迁移
- 编写 `tools/maintenance/migrate_rules_v2.py` + 人工 layer 分配表。
- 替换 `public/assets/data/rules.json` 与备份。
- Validate Data 过线后提交。

### Phase 4：编辑器同步
- `tools/editor/editors/rule_editor.py`、`encounter_editor.py`、`scene_editor.py`、`shared/action_editor.py`、`shared/ref_validator.py`、`validator.py`。
- `tools/graph_editor/panels/rule_panel.py`、`encounter_panel.py`。
- `tools/copy_manager/constants.py` 与必要的 `scanner/json_scanner.py` 扩展。
- 每个文件改动后跑 PySide6 编辑器手工冒烟测试（开/编/保存/Validate）。

### Phase 5：UI 与新功能
- `RulesPanelUI` 改三层渲染。
- `RuleUseUI` + `ZoneRuleSlot.requiredLayers` 接入。
- `EncounterOptionDef.requiredRuleLayers` 接入；编辑器同步。
- `strings.json` 新增 layer 文案。

### Phase 6：清理与文档
- 在 `RuleDef` / `RuleFragmentDef` 上移除已不再需要的旧字段（确认无外部引用后）。
- 更新 [`docs/data-and-tools-manual.md`](data-and-tools-manual.md) 第八节 "Rule（规矩与碎片）" 表格。
- 更新 [`游戏架构设计文档.md`](../游戏架构设计文档.md) 5.6 节关于 RulesManager 的描述，加注三层语义。
- 重新生成 `tools/copy_manager/registry.json`（或在工具内点击 Reset & Rescan）。

---

## 九、验收标准

### 兼容性（最高优先级）
- [ ] 旧存档（含 `acquiredRules` / `acquiredFragments`）读档后所有 `rule_<id>_acquired` / `rule_<id>_discovered` / `rule_<id>_fragments_*` / `fragment_<id>_acquired` flag 与读档前等价
- [ ] `encounters.json` / `graphs/码头看板官差.json` / `archive/books.json` / `dialogues/*.ink` 中所有 `rule_<id>_acquired` 引用在新版本下行为不变
- [ ] `test_room_b.json` 的 `enableRuleOffers` 三个 slot 在新版本下：拥有完整规矩可触发，拥有部分层时按 `requiredLayers`（若设）或继续按完整 `hasRule`（若未设）判定
- [ ] `ActionRegistry` 的 `giveRule` / `giveFragment` 接口签名不变
- [ ] `IRulesDataProvider` 旧方法返回值形状不变；新增方法非破坏性
- [ ] `[tag:rule:<id>]` 仍能解析为规矩 `name`
- [ ] copy_manager 重新扫描后 `notifications.ruleAcquired` 等 strings 项 uid 不变

### 新功能
- [ ] `RuleDef.layers` 至少含一层；保存时校验
- [ ] `RuleFragmentDef.layer` 必填，且与所属规矩 `layers` 一致；保存时校验
- [ ] `getRuleDepth(ruleId)` 返回 `{unlocked, total}` 与实际层数匹配
- [ ] `hasLayer(ruleId, layer)` 在层全部碎片收集 / `grantLayer` 后为 true
- [ ] `getUnlockedLayerTexts` 仅返回已解锁层正文
- [ ] `getLayerFragmentProgress` 按层返回进度
- [ ] 事件 `rule:fragment` / `rule:acquired` / `rule:layer` 正确发出（前两者保持旧时机）
- [ ] `grantRuleLayer` Action 注册并通过 `validator` 校验
- [ ] `EncounterOptionDef.requiredRuleLayers` 在新数据中可写入并影响选项启用
- [ ] `ZoneRuleSlot.requiredLayers` 写入后 `RuleUseUI` 按层判定可用
- [ ] `RulesPanelUI` 三层渲染：未解锁层显示 `lockedHint` / `strings.rulesPanel.hidden`；已解锁层显示正文
- [ ] 主编辑器 `RuleEditor` / `EncounterEditor` / `SceneEditor`（rule slot 子表）均能保存新结构且 `Validate Data` 通过
- [ ] 主编辑器与图编辑器对同一份 `rules.json` 互相打开 / 保存不会丢字段

### 数据
- [ ] `public/assets/data/rules.json` 全量迁移到新结构，`tools/copy_manager/constants.py` 同步且重新扫描后无遗漏文案
- [ ] `public/assets/data/flag_registry.json` 新增 `rule_layer_done` pattern，旧 pattern 全部保留
