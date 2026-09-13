---
target: mainwindow-editor-hooks
date: 2026-09-12
session: 编辑器野窗口/卡顿排查
---

现象: 契约 6 写着"自动路径(主窗回到前台/外置进程退出)必须在镜像真变了才重建",但 `changeEvent(ActivationChange)` 那条路一直是**无条件** `_reload_all_reference_catalogs()`；只要还开着轨迹工作台(登记在 `_dialogue_external_processes`)，每次 alt-tab 回主窗都全页重建一遍。
证据: 实测场景页一次 218/255/320/864/1105ms(8 棵最外层 ActionEditor 全拆全建)；本次已按契约补上签名闸 `_resync_dialogue_catalog_if_changed`(main_window.py) + 测试 `test_main_window_process.py::test_主窗回前台_图对话目录没变就不重建`。
建议: 契约 6 补一句"闸要设在调用点上，不能只指望被调方自己门控"——轨迹/vfx/音频三条早就自己门控了，只有图对话目录这条漏在调用点。
