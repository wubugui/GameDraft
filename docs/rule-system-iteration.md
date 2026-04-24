# 规矩系统迭代方案 — 象理术分层

> 将现有扁平的规矩系统重构为三层深度结构。
>
> **核心变更**：规矩数据从 `rule + fragment` 两层改为 `rule(象/理/术) + fragment(归属某一层)`。
>
> **定位**：RulesManager 是纯数据管理系统，不耦合任何 UI 或遭遇逻辑。其他系统通过查询接口获取知识深度。

---

## 一、设计动机

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

**问题**：
1. 辨识信息（"白毛僵尸长什么样"）、原理信息（"魄锁于体不散"）、应对方法（"用火对付"）全部塞在一条 description 里
2. EncounterManager 中选项解锁是二元的——有规矩就解锁，没有就不解锁
3. 玩家不知道自己对一件事的理解有多深

### 目标

- 规矩知识分三层：象（表象）→ 理（原理）→ 术（方法）
- 玩家可能知道"这是什么"但不知道"怎么对付"，反之亦然
- **RulesManager 只负责管理和查询，不关心谁在用、怎么用**

---

## 二、数据格式变更

### 2.1 RuleDef

**旧结构：**
```typescript
interface RuleDef {
  id: string;
  name: string;
  category: 'ward' | 'taboo' | 'jargon' | 'streetwise';
  description: string;
  source: string;
  sourceType: 'npc' | 'fragment' | 'experience';
  verified: 'unverified' | 'effective' | 'questionable';
  fragmentCount?: number;
}
```

**新结构：**
```typescript
interface RuleDef {
  id: string;
  name: string;
  category: 'ward' | 'taboo' | 'jargon' | 'streetwise';
  layers: RuleLayers;
  verified: 'unverified' | 'effective' | 'questionable';
}

interface RuleLayers {
  xiang?: { text: string };   // 象：表象描述
  li?:    { text: string };   // 理：原理/分类
  shu?:   { text: string };   // 术：应对方法
}
```

- `source` / `sourceType` 移除——每条 fragment 自带 source
- `fragmentCount` 移除——各层独立计数
- `description` 移除——拆入 `layers`

### 2.2 RuleFragmentDef

**旧结构：**
```typescript
interface RuleFragmentDef {
  id: string;
  text: string;
  ruleId: string;
  index: number;
  source?: string;
}
```

**新结构：**
```typescript
interface RuleFragmentDef {
  id: string;
  text: string;
  ruleId: string;
  layer: 'xiang' | 'li' | 'shu';
  source: string;
}
```

- `index` 移除——层内自然排序
- `layer` 新增——标记该碎片贡献哪一层知识

### 2.3 rules.json 示例

```json
{
  "categories": { "ward": "避祸", "taboo": "禁忌", "jargon": "行话", "streetwise": "江湖" },
  "verifiedLabels": { "unverified": "未验证", "effective": "有效", "questionable": "存疑" },
  "rules": [
    {
      "id": "rule_zombie_fire",
      "name": "白毛僵尸",
      "category": "ward",
      "layers": {
        "xiang": { "text": "浑身长白毛的尸体会动，刀枪不入。" },
        "li":    { "text": "魄锁于体不散，化为白僵。阴气聚于肉身，故铜皮铁骨。" },
        "shu":   { "text": "怕火，桃木点燃最佳，寻常松脂火把也管用。糯米可阻其行。" }
      },
      "verified": "unverified"
    },
    {
      "id": "rule_ghost_origin",
      "name": "唱戏白影的来历",
      "category": "streetwise",
      "layers": {
        "xiang": { "text": "城隍庙后山三更天有白影飘来飘去，还会唱戏。" },
        "li":    { "text": "早年间柳家戏班子的人，横死含冤，怨气不散化为厉鬼。非害人，在找人。" },
        "shu":   { "text": "此物为厉鬼，非力可驱。知其来历后答其所问，或可自保。" }
      },
      "verified": "unverified"
    }
  ],
  "fragments": [
    {
      "id": "frag_zombie_fire_01",
      "text": "老道士说：见过赶尸的走过夜路，队伍里有个浑身长白毛的。",
      "ruleId": "rule_zombie_fire",
      "layer": "xiang",
      "source": "老道士"
    },
    {
      "id": "frag_zombie_fire_02",
      "text": "赶尸匠的手札上写着：遇白毛，魄锁于体，化为白僵，刀枪不入。",
      "ruleId": "rule_zombie_fire",
      "layer": "li",
      "source": "赶尸匠手札"
    }
  ]
}
```

---

## 三、RulesManager API

RulesManager 是纯数据管理系统，**不包含任何 UI 渲染或遭遇逻辑**。它对外提供查询接口，供其他系统调用。

### 3.1 内部状态

```typescript
private ruleDefs: Map<string, RuleDef> = new Map();
private fragmentDefs: Map<string, RuleFragmentDef> = new Map();

// 玩家已收集的碎片 ID
private acquiredFragments: Set<string> = new Set();

// 每条规则已解锁的层
private trackedLayers: Map<string, Set<'xiang' | 'li' | 'shu'>> = new Map();
```

### 3.2 查询接口

```typescript
/** 获取某规则的当前知识深度（0=无，1=象，2=象+理，3=象+理+术） */
getRuleDepth(ruleId: string): number;

/** 检查某规则是否已解锁指定层 */
hasLayer(ruleId: string, layer: 'xiang' | 'li' | 'shu'): boolean;

/** 获取某规则的完整定义（含 layers） */
getRuleDef(ruleId: string): RuleDef | undefined;

/** 获取某规则已解锁层的实际文本内容 */
getUnlockedLayerTexts(ruleId: string): { xiang?: string; li?: string; shu?: string };

/** 获取某规则已收集的碎片进度（按层统计） */
getFragmentProgress(ruleId: string): {
  xiang: { collected: number; total: number; fragments: RuleFragmentDef[] };
  li:    { collected: number; total: number; fragments: RuleFragmentDef[] };
  shu:   { collected: number; total: number; fragments: RuleFragmentDef[] };
};

/** 列出所有已收集碎片的规则 */
getDiscoveredRules(): string[];

/** 列出某层全齐的规则 */
getCompletedRules(): string[];
```

### 3.3 写入接口

```typescript
/** 收集一个碎片 */
giveFragment(fragmentId: string): void;

/** 直接给予一条规则的某一层知识（用于亲身经历等直接获得的情况） */
grantLayer(ruleId: string, layer: 'xiang' | 'li' | 'shu'): void;
```

### 3.4 事件

RulesManager 通过 EventBus 发出纯数据事件，**不携带任何 UI 文案**：

```typescript
// 收集到新碎片
eventBus.emit('rule:fragment', {
  fragmentId: string,
  ruleId: string,
  layer: 'xiang' | 'li' | 'shu',
  source: string,
  text: string,
});

// 某规则的某一层知识解锁
eventBus.emit('rule:layer', {
  ruleId: string,
  layer: 'xiang' | 'li' | 'shu',
  depth: number,  // 当前总深度
});

// 某规则三层全齐
eventBus.emit('rule:complete', {
  ruleId: string,
  name: string,
});
```

通知系统监听这些事件并自行决定展示什么文案。RulesManager 不管展示。

### 3.5 序列化

```typescript
serialize(): object {
  return {
    acquiredFragments: Array.from(this.acquiredFragments),
    trackedLayers: Object.fromEntries(
      Array.from(this.trackedLayers.entries())
        .map(([ruleId, layers]) => [ruleId, Array.from(layers)])
    ),
  };
}

deserialize(data: {
  acquiredFragments?: string[];
  trackedLayers?: Record<string, ('xiang' | 'li' | 'shu')[]>;
}): void {
  this.acquiredFragments = new Set(data.acquiredFragments ?? []);
  this.trackedLayers = new Map(
    Object.entries(data.trackedLayers ?? {})
      .map(([ruleId, layers]) => [ruleId, new Set(layers)])
  );
}
```

---

## 四、其他系统如何查询

### 4.1 EncounterManager 示例

遭遇系统根据自身需求定义选项所需的深度，然后查询 RulesManager：

```typescript
// EncounterOptionDef 新增字段
interface EncounterOptionDef {
  text: string;
  type: 'general' | 'rule' | 'special';
  conditions: ConditionExpr[];
  requiredRuleId?: string;
  requiredRuleDepth?: 1 | 2 | 3;   // 需要的知识深度
  lockedText?: string;             // 知识不足时显示的占位文案
  // ...
}

// generateOptions 中查询
if (opt.requiredRuleId && opt.requiredRuleDepth) {
  const depth = this.rulesManager.getRuleDepth(opt.requiredRuleId);
  if (depth >= opt.requiredRuleDepth) {
    // 知识足够 → 显示 opt.text
  } else {
    // 知识不足 → 显示 opt.lockedText ?? '未获取'
  }
}
```

### 4.2 RulesPanelUI 示例

规矩面板查询各规则的层状态来渲染：

```typescript
const rule = rulesManager.getRuleDef(ruleId);
const unlocked = rulesManager.getUnlockedLayerTexts(ruleId);

// 象层
{ unlocked.xiang
  ? rule.layers.xiang.text
  : '尚未知晓……'
}
```

### 4.3 档案/风物志 示例

风物志展示玩家已解锁的规矩内容：

```typescript
const completed = rulesManager.getCompletedRules();
for (const ruleId of completed) {
  const rule = rulesManager.getRuleDef(ruleId);
  // 三层文本全部展示
}
```

---

## 五、数据迁移

### 5.1 迁移策略

旧 `rules.json` 中的规则需要手动拆分为三层。

**迁移步骤：**
1. 对每条现有规则，分析 `description` 文本，拆分为象/理/术三层
2. 将现有 fragment 分配到对应的层
3. 为每层补充至少一个 fragment（如有缺失需新写）
4. 更新各 EncounterDef 中的 `requiredRuleDepth`

### 5.2 兼容处理

```typescript
// 旧规则无 layers 字段时，将 description 作为 xiang
const layers = rule.layers ?? { xiang: { text: rule.description ?? '' } };

// 旧选项无 requiredRuleDepth 时，默认 depth = 1
const depth = option.requiredRuleDepth ?? 1;
```

---

## 六、实施顺序

### Phase 1：数据结构重构
- 修改 `RuleDef` / `RuleFragmentDef` 类型定义（`src/data/types.ts`）
- 重写 `rules.json`（内容拆分）

### Phase 2：RulesManager 重构
- 内部状态改为 `trackedLayers`
- 实现新的查询/写入接口
- 修改 `serialize` / `deserialize`
- 修改事件 emit 格式

### Phase 3：消费方对接
- EncounterManager 增加 `requiredRuleDepth` 查询逻辑
- RulesPanelUI 改为三层展示
- 通知系统监听新事件格式

### Phase 4：数据迁移与回归
- 旧数据兼容处理
- 全场景回归测试

---

## 七、验收标准

- [ ] `RuleDef` 含 `layers` 字段，`RuleFragmentDef` 含 `layer` 字段
- [ ] `rules.json` 正确拆分为象/理/术三层
- [ ] `giveFragment()` 正确增加对应层的知识
- [ ] `getRuleDepth()` 返回正确的深度值（0~3）
- [ ] `hasLayer()` 正确判断指定层是否解锁
- [ ] `getUnlockedLayerTexts()` 返回已解锁层的实际文本
- [ ] `getFragmentProgress()` 按层返回收集进度
- [ ] 事件 `rule:fragment` / `rule:layer` / `rule:complete` 正确 emit
- [ ] 存档序列化/反序列化正确保存/恢复层级状态
- [ ] 旧数据兼容：无 `layers` 的规则降级为仅 `xiang`
