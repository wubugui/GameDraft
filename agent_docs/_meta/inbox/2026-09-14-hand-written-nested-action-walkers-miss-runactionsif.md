---
target: editor-tools-norms
date: 2026-09-14
session: runActionsIf 嵌套遍历补漏
---

现象: 手写 if/elif 的嵌套动作遍历全部漏了 runActionsIf（actions / elseActions）：TS 叙事校验 validateActionDef、叙事 Python 兜底 _validate_action_def、ref_validator.walk_action_defs_embedded_refs、graph_editor json_parser._extract_flags_from_actions（后者还漏 runActions/chooseAction/addDelayedEvent）；已改为读 action_structure.NESTED_ACTION_SLOTS（TS 侧为同形槽位表 + 对账测试）。未修的同形残留：project_model._collect_flags_from_conditions / _collect_flags_from_scene 完全不下钻容器；docs/editor-authoring-surface.md:20 的容器清单缺 runActionsIf。
证据: tools/editor/tests/test_nested_action_walkers.py（修前 27/28 红）、src/core/narrativeGraphValidation.nestedActions.test.ts（修前 3/5 红）。
建议: 不变式 8 的固定检查项补一条「新增容器动作 → grep 全仓 aboveActions/resultActions 找手写遍历」，或把登记表当成 walker 的唯一入口写进 editor-tools norms。
