---
target: editor-data-sync-paradigm
date: 2026-09-16
session: 火把养成作者面可用性复核
---

现象: 主从列表在 `_loading = True` 里调 `setCurrentRow(0)` 载入第一条——`_on_select_row` 被同一个守卫早退，游标停在 -1：列表看着高亮、右侧表单空白且可编辑，打进去的字提交不到任何一条，只把高亮清掉再把整页判脏（数据丢失级，model 层测试全绿）。
证据: `tools/editor/editors/prop_preset_blocks.py::PropLevelsEditor._fill`（修前）；护栏见 `tools/editor/tests/test_prop_editor_usability_fixes.py::test_levels_first_row_is_really_selected_on_open` 与 `..._typing_into_the_first_level_commits...`。
建议: 卡里补一条「载入后自己把游标与详情摆到位，别指望被守卫吞掉的信号」，并附「点已选中那一行 Qt 不发 currentRowChanged ⇒ 要接 itemClicked 才回得来」。
