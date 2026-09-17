---
target: editor-change-verification-gate
date: 2026-09-14
session: 动作大纲编辑器重写
---

现象: 把一段子布局换成独立宿主 QWidget 后，父布局按控件项（QWidgetItemV2）缓存它的 sizeHint；控件从未 show 过时往宿主里加子控件不会刷新该缓存（LayoutRequest 不投递），条件树高度冻在「只有头行」的 55px——验证门「布局塌陷」条只写了显隐切换，没写这种「挪进独立宿主控件」的形态。
证据: tools/dialogue_graph_editor/tests/test_gui_review_2026_08_06.py::ConditionTreeHeightTests 红（180 not greater than 180）；修法 condition_expr_tree.py `_refresh_ancestor_geometry` 先 `_body.invalidate()` + `_body_host.updateGeometry()`。
建议: 「布局塌陷」判据补一条：动态内容放进独立宿主控件时，增删后必须对宿主显式 updateGeometry，未显示状态下量 sizeHint 才可信。
