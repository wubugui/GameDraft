---
target: editor-change-verification-gate
date: 2026-08-05
session: 图对话编辑器 GUI 专项审查（收尾时撞到全套测试挂死）
---

# 编辑器全套测试挂死在分组指派弹窗

- **现象**：`pytest tools/editor/tests` 永不返回（xdist worker 卡在 `QDialog::exec()`）。
  单独跑 `tools/editor/tests/test_scene_entity_tree_multiselect.py::test_assign_group_write_and_undo`
  也卡死；`--ignore` 掉该文件后 1024 passed / 49s 全绿。
- **根因**：实现已在 67f8f84（2026-08-03）把分组指派从 `QInputDialog.getItem` 换成
  `ReferencePickerDialog`（`tools/editor/editors/scene_editor.py:10601`），但测试仍打桩旧 API
  （`QInputDialog.getItem = staticmethod(...)`），于是真弹窗、offscreen 下永远等不到人点。
  属 2026-07-11「下拉 vs 弹窗」拍板的迁移遗留。
- **影响**：编辑器这道验收门现在无法收敛，任何人跑全套都会挂；只能靠排除该文件拿绿，
  被排除的 11 条测试等于没验。

## 2026-08-06 已修

stub 改打 `ReferencePickerDialog.exec/selected_value`（与 `test_scene_group_entities.py` 同法），
全量恢复 **1056 passed / 43s**，被排除的 11 条重新真验。
留给知识库的那句话：**实现换了交互控件，配套 stub 必须跟着换——打空的 stub 不是失败，是挂死。**
