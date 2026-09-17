---
target: missing
date: 2026-09-15
session: heldProp 条件叶 / hintBelow / recoverState 编辑器登记面
---

现象: 条件叶登记面没有一张清单卡——heldProp 补进了条件树 / 摘要 / 校验器 / json_lang / xref 人话 / 挂件改名跟随，但同类叶 `vfx+vfxState` 至今**不在条件树类型下拉里**（只能靠未编辑原样透传），叙事状态机页的 Python 兜底与 TS `narrativeGraphValidation` 不认 posture / timePhase / vfxState（heldProp 同日已放行：它有 heldProp:changed 唤醒 reactive，另三个变化时没有唤醒事件），NPC 改名（entity_refactor 只走 ENTITY_REF_PARAMS 动作参数）不跟 `{heldProp: <npc id>}`。
证据: `tools/editor/shared/condition_expr_tree.py` 类型下拉无 vfxState；`tools/editor/editors/narrative_state_editor.py::_is_condition_shape`；`src/core/narrativeGraphValidation.ts::validateConditionExpr`；`tools/editor/shared/entity_refactor.py::_walk_ref_actions`。
建议: 建一张「加条件叶的登记面」卡（运行时守卫 / 条件树 / dialogue_condition_text 守卫对账 / action_structure 摘要 / validator `_scan_condition_expr` / json_lang `_MODELED_LEAVES`+schema / xref phrases / 引用改名），并决定条件叶里的实体引用是否进重构引擎。
