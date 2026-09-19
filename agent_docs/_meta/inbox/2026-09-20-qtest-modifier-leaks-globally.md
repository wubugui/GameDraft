---
target: editor-change-verification-gate
date: 2026-09-20
session: 修 test_scene_group_entities 间歇性失败
---

现象: `QTest.keyClick(w, key, ControlModifier)` 会把该修饰键永久留在 `QGuiApplication.keyboardModifiers()` 里（QTest 不补「松开」事件），整个 worker 进程后续所有测试都认为 Ctrl 还按着；`QTreeWidget.setCurrentItem(item)` 在 ExtendedSelection 下据此把选择命令从 ClearAndSelect 解析成 Toggle，选中被再取消一次 —— **不报错，只是选中结果不对**。`--dist loadfile` 每次现分文件到 worker，所以症状是间歇性的、单跑该文件必过。
证据: `test_action_outline_editor.py:386` 的 Ctrl+Z 泄给 `test_scene_group_entities.py::test_malformed_group_pending_blocks_tree_navigation_and_restores_selection`，两文件同进程（`-n0`）100% 复现；offscreen 与真 windows 平台表现一致（**不是离屏能力缺失**，别按那个方向 skip）。已在 `tools/conftest.py` 加 `_release_leaked_keyboard_modifiers` 收尾复位 + 护栏 `tools/editor/tests/test_global_keyboard_modifier_hygiene.py`。
建议: 把「合成按键的修饰键是全进程状态」补进该 recipe 的「Qt 生命周期与测试环境硬规矩」一节；生产侧配套纪律是**程序化定位选中必须显式传 SelectionFlag**，别用单参 `setCurrentItem`（它读用户手上真按着的键）。
