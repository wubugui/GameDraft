"""护栏：带修饰键的合成按键不会把「Ctrl 一直按着」留给后面的测试。

`QTest.keyClick(w, key, ControlModifier)` 走平台事件通道，会把
`QGuiApplicationPrivate::modifier_buttons` 置成该修饰键，而 QTest **不补**对应的
「松开」事件——修饰键就此留在整个进程里，任何断言都看不见。

它咬人的地方在别的文件：`QAbstractItemView` 在 ExtendedSelection 下用
`QGuiApplication.keyboardModifiers()` 解析 `setCurrentItem(item)` 的选择命令，
Ctrl 卡住就从 ClearAndSelect 变成 Toggle（刚选中的项被再取消一次）。一律不报错，
只是选中结果不对。`--dist loadfile` 下同进程跑哪些文件每次现分，所以症状是间歇性的
（2026-09-20：`test_action_outline_editor.py` 末尾的 Ctrl+Z 泄给
`test_scene_group_entities.py`，后者的「阻断导航后恢复选中」随机挂）。

这两条按定义顺序跑（pytest 对模块级函数保持定义顺序），钉死：
① 泄漏是真的（别让护栏在 Qt 改语义后变成空断言）；
② 仓库级 conftest 的 `_release_leaked_keyboard_modifiers` 在测试之间收得干净。
"""
from __future__ import annotations

import sys

from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QWidget


def _app() -> QApplication:
    return QApplication.instance() or QApplication(sys.argv)


def test_key_click_with_modifier_really_leaks_global_state() -> None:
    _app()
    w = QWidget()
    QTest.keyClick(w, Qt.Key.Key_Z, Qt.KeyboardModifier.ControlModifier)

    # 这条断言若开始失败，说明 Qt/PySide 改了语义，届时 conftest 的收尾可以撤掉。
    assert QApplication.keyboardModifiers() == Qt.KeyboardModifier.ControlModifier


def test_next_test_starts_from_clean_modifier_state() -> None:
    _app()
    assert QApplication.keyboardModifiers() == Qt.KeyboardModifier.NoModifier, (
        "上一条测试泄漏的修饰键没被收尾清掉——"
        "tools/conftest.py 的 _release_leaked_keyboard_modifiers 失效了"
    )
