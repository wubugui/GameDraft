---
target: action-registration-registry-surfaces
date: 2026-09-12
session: 新增条件分支原语 runActionsIf（崖墓三把火只在夜里出现）
---

- 现实：新增一个**走自定义表单分支**（`_PARAM_SCHEMAS` 留空）而 TS manifest 里有 `required` 参数的 action 时，
  除卡上列的四个必填登记面外，还得同步 `tools/editor/tests/test_param_schema_manifest_parity.py` 的
  `_BESPOKE_BUILT_REQUIRED`，以及 `action_editor.py` 的 `ACTION_PERSISTENCE`（后者有
  `_assert_action_persistence_covers_types()` 在 import 期兜底，漏了直接炸；前者漏了只有
  `test_reverse_required_params_are_buildable` 一条红，四条门全绿）。
- 文档：`agent_docs/runtime/mechanisms/action-registration-registry-surfaces.md` 的登记面清单两处都没写。
- 建议：在「必填」表后补一行「required 参数走自定义表单分支 → 还要登记 `_BESPOKE_BUILT_REQUIRED` 并注明分支」，
  并把 `ACTION_PERSISTENCE` 补进必填表（它是 import 期硬断言，其实是最先炸的那一面）。
