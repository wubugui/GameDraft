---
target: dropdown-vs-popup-selector
date: 2026-08-10
session: 音频编辑器迭代
---

现象: 决策卡说「现存长下拉违规按编辑器待办逐个清理」，音频是最后一块——六个音频选择点里
五个仍是 editable 长下拉（sfx 127 项，`IdRefSelector._uses_search_picker` 因 `editable=True`
恒假，弹窗路径根本走不到），本轮已全部收敛到 `AudioPickerDialog`（搜索 + 时长/文件/状态列 +
走带试听 + 上下键即听），并补 `tools/editor/tests/test_audio_editor_iteration.py` 钉住。
证据: `tools/editor/shared/audio_picker_dialog.py`、`audio_preview_selector.py`（已无内嵌
QComboBox，护栏 `test_no_giant_combo_anymore`）、`audio_library.py`；改前形态见
`tools/editor/editors/audio_editor.py` 的 git diff。
建议: 决策卡「现存违规逐个清理」的音频项可以销账；四条新踩的 PyQt 死路值得进机制卡——
①`QTreeWidgetItem.__lt__` 覆写里调 `super().__lt__` = 无限递归 SIGSEGV（exit 139）；
②`setSortingEnabled(True)` 会立刻按当前指示列排一次，要保原序必须**先** `setSortIndicator(-1)`；
③后台线程往已析构 QObject 发信号抛 `RuntimeError: Signal source has been deleted`（全套测试里
真的报出来了，需要不持有 self 的共享存活标志断路）；④modern 主题下 QPushButton 的内边距会把
30px 窄按钮里的字形挤没，窄图标按钮一律走 `qt_icon_buttons.outline_row_tool_button`。
