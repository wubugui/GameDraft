---
target: editor-tools-norms
date: 2026-09-16
session: 火把养成作者面可用性复核
---

现象: 布局纪律只说「短字段设宽度上限」，没说上限不许低于控件自己的 `sizeHint()`；照着写出来的 `setFixedWidth(30)` 图标按钮（主题内边距 14px×2 = 28px）画出来是空白的，`setMaximumWidth(90)` 的下拉连自己的缺省项「（不限）」都切一半——两者都零报错，只有人眼看得见。
证据: `tools/editor/tests/test_prop_editor_usability_fixes.py` 里 `_clipped_buttons` / `_too_narrow`（断言 `sizeHint().width() <= maximumWidth()`，跨三套主题 × 三档字号跑）；修复见 `tools/editor/shared/form_layout.py` 的 `fit_width_cap` / `compact_icon_button` 与 `theme.COMPACT_BUTTON_PROP`。
建议: 纪律补一句「上限 = max(想要的上限, sizeHint)」，并点名字号可调到 `MAX_FONT_PX` ⇒ 只按缺省字号验收等于没验。
