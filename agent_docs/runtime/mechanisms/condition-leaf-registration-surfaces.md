---
id: condition-leaf-registration-surfaces
title: 加条件叶的登记面
domain: runtime
type: mechanism
summary: 新条件叶要同步运行时求值 / 叙事校验放行口径 / 条件树编辑器 / 分支守卫 / 校验器 / json_lang / 叙事关联人话 / 引用改名跟随;漏哪一面都不报错,只是该叶在那一面恒假、配不出或改名后悬垂
status: active
authority:
  - src/systems/graphDialogue/evaluateGraphCondition.ts
  - src/core/narrativeGraphValidation.ts#validateConditionExpr
  - tools/editor/shared/condition_expr_tree.py
  - tools/dialogue_graph_editor/dialogue_condition_text.py#_is_recognized_leaf
  - tools/editor/editors/narrative_state_editor.py#_is_condition_shape
  - tools/editor/validator.py#_scan_condition_expr
  - tools/json_lang/extract.py#_MODELED_LEAVES
  - tools/narrative_xref/phrases.py
triggers:
  paths: ["src/systems/graphDialogue/evaluateGraphCondition.ts", "src/core/narrativeGraphValidation.ts", "tools/editor/shared/condition_expr_tree.py", "tools/dialogue_graph_editor/dialogue_condition_text.py", "tools/json_lang/extract.py"]
  tasks: [加条件叶, 新条件类型, 条件读新状态]
  topics: [条件叶, ConditionExpr, evaluateGraphCondition, 条件树编辑器, reactive 唤醒]
verified_by:
  - tools/editor/tests/test_condition_expr_roundtrip.py
  - tools/editor/tests/test_held_prop_condition_leaf.py
  - tools/dialogue_graph_editor/tests/test_switch_node_safety.py
last_governed: 2026-09-23
---

## 是什么(一句话)

与 [加 Action 的登记面](action-registration-registry-surfaces.md) 对称:一种条件叶子由多个登记面共同构成,
**漏任何一面都不报错**——运行时认不出的形状求值为**恒假**(不是恒真),编辑器漏了就配不出或只能靠原样透传。
叶子清单本身以 `evaluateGraphCondition.ts` 为准,别在文档里抄。

## 登记面(漏了会怎样)

| 登记面 | 权威源 | 漏了的表现 |
|---|---|---|
| 运行时叶类型 + 求值(含 trace) | `src/data/types.ts` 叶类型、`evaluateGraphCondition.ts` | 形状认不出 → warn + 恒假 |
| 叙事图放行口径 | `narrativeGraphValidation.validateConditionExpr`(TS 权威)+ 叙事页 Python 兜底 `_is_condition_shape` | 叙事图里写它被拒存;兜底必须是 TS 的子集 |
| 条件树编辑器 | `condition_expr_tree.py` 的类型下拉与叶表单 | 选不到;旧数据只能靠"未编辑原样透传"活着,一碰就丢 |
| 分支守卫 | 图对话 `dialogue_condition_text._is_recognized_leaf`(与运行时守卫对账) | switch 分支被判"永不命中" |
| 校验器 | `validator._scan_condition_expr` | 引用存在性 / flag 登记等检查整片缺席 |
| json_lang | `extract._MODELED_LEAVES` + schema | tripwire 出 warning(未建模叶);IDE 无补全 |
| 叙事关联人话 | `narrative_xref/phrases.py` | 关联面板里读状态那一行说不出人话 |
| 引用改名跟随 | 条件叶里的实体引用**不在**重构引擎的动作参数表里 | 改名后条件悬垂,零报错 |

## 硬契约

- **叙事图只放行"变化时有唤醒事件"的叶子**:reactive 迁移靠事件叫醒重评,状态变了却不发事件的叶子
  (姿态 / 时段 / 粒子状态一类)在叙事图里被有意拒绝——这是契约,不是缺口。新叶要进叙事图,
  先让它的状态变化发出唤醒事件(先例:挂件变化发 `heldProp:changed`),再改两侧放行口径。
- 叶子里有实体 id 时,改名跟随要单写改写函数并接进重构的扫描/改名/迁移/撤销四条路径
  (判据同动作卡「长在数据结构里的实体引用」那条)。
- 编辑器侧兜底校验只许比 TS 松(editor-tools 不变量 7)。

## 已知坑(2026-09-23 核实仍在)

- 粒子状态叶至今**不在**条件树类型下拉里。
- 实体重构引擎只走动作参数表,改 NPC 名**不跟**手持挂件叶里的持有者 id。
- 叙事页的资产扫描面(`narrative_state_editor` 的资产遍历)不扫挂件预设。

## 怎么验证

条件树往返(`test_condition_expr_roundtrip.py`)+ 分支守卫对账(`test_switch_node_safety.py`)+ 叙事图里真写一条
保存不被拒 + `validate-data` + DEV 真跑一次让条件为真/为假各一回(恒假是这族最常见的静默失败)。
