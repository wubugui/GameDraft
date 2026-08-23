"""并存期两个场景页的撤销栈**不许互撤** —— Step 0-d 的护栏。

新老两个场景页同时活着时，它们各自持**整场景快照**、改**同一份**模型 dict。
若不互相知会，在 A 页按 Ctrl+Z 会把 B 页刚做的改动**静默回滚，且 redo 找不回**
（A 的 before 快照拍在 B 改之前）。

这是重写方案里"最可能的死法一"：并存期数据事故。表现是"用了新画布之后数据反而
更容易坏"，一次就足以让整个方案被否掉。

代价说清楚：**切页 = 另一个页的撤销栈清空**。这是并存期的必然代价，语义诚实，
总好过两个栈互撤。本文件同时锁住这条代价，免得后人"优化"掉它。
"""
from __future__ import annotations

import sys
import unittest

from PySide6.QtGui import QUndoCommand
from PySide6.QtWidgets import QApplication, QWidget

from tools.editor.editors.scene_undo import (
    SceneUndoController,
    broadcast_external_scene_write,
)


class _FakeCmd(QUndoCommand):
    """最小快照命令替身：只需要带 `_sid`，那是清栈判定认的键。"""

    def __init__(self, sid: str) -> None:
        super().__init__(f"fake:{sid}")
        self._sid = sid

    def redo(self) -> None:  # pragma: no cover - 不参与断言
        pass

    def undo(self) -> None:  # pragma: no cover
        pass


class _FakeEditor(QWidget):
    """SceneUndoController 只用到 `_model` / `_props` / `_current_scene_id`。"""

    def __init__(self) -> None:
        super().__init__()
        self._model = type("M", (), {"scenes": {}})()
        self._props = None
        self._current_scene_id = ""


class CrossPageUndoIsolationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors = [_FakeEditor(), _FakeEditor()]
        self.a = SceneUndoController(self._editors[0])
        self.b = SceneUndoController(self._editors[1])

    def tearDown(self) -> None:
        for e in self._editors:
            e.deleteLater()
        QApplication.processEvents()

    def test_push_clears_the_other_pages_stack_for_that_scene(self) -> None:
        """A 页入栈后，B 页对**同一场景**的栈必须清空。"""
        self.b._push("街", _FakeCmd("街"))
        self.assertEqual(self.b.stack.count(), 1)

        self.a._push("街", _FakeCmd("街"))

        self.assertEqual(self.b.stack.count(), 0, "B 页的栈没被清 —— 会与 A 互撤")
        self.assertEqual(self.a.stack.count(), 1, "A 页不该清自己的栈")

    def test_other_scenes_are_untouched(self) -> None:
        """只清同一场景的栈；改甲场景不该把乙场景的撤销历史也毁掉。"""
        self.b._push("乙", _FakeCmd("乙"))
        self.a._push("甲", _FakeCmd("甲"))
        self.assertEqual(self.b.stack.count(), 1, "无关场景的栈被误清了")

    def test_broadcast_skips_origin(self) -> None:
        """广播不许清发起方自己的栈，否则每次操作都把自己的历史抹掉。"""
        self.a._push("街", _FakeCmd("街"))
        broadcast_external_scene_write("街", origin=self.a)
        self.assertEqual(self.a.stack.count(), 1)

    def test_broadcast_without_origin_clears_everyone(self) -> None:
        """无 origin = 栈外直写（背景导入等），所有页都得清。"""
        self.a._push("街", _FakeCmd("街"))
        self.b._push("街", _FakeCmd("街"))
        broadcast_external_scene_write("街")
        self.assertEqual(self.a.stack.count(), 0)
        self.assertEqual(self.b.stack.count(), 0)

    def test_restoring_controller_is_not_cleared(self) -> None:
        """命令回放期间不许被清 —— 那会在 undo 中途毁掉正在用的栈。"""
        self.b._push("街", _FakeCmd("街"))
        self.b.restoring = True
        try:
            broadcast_external_scene_write("街")
        finally:
            self.b.restoring = False
        self.assertEqual(self.b.stack.count(), 1)

    def test_empty_sid_is_a_noop(self) -> None:
        self.b._push("街", _FakeCmd("街"))
        broadcast_external_scene_write("")
        self.assertEqual(self.b.stack.count(), 1)

    def test_dead_controllers_drop_out(self) -> None:
        """弱引用登记：页销毁后不该再被广播命中（也不该抛异常）。"""
        ed = _FakeEditor()
        c = SceneUndoController(ed)
        c._push("街", _FakeCmd("街"))
        del c
        ed.deleteLater()
        QApplication.processEvents()
        import gc
        gc.collect()
        broadcast_external_scene_write("街")  # 不抛即可

    def test_destroyed_page_does_not_break_the_broadcast(self) -> None:
        """宿主页已析构、Python 侧控制器还没被 gc —— 广播不许因此抛异常。

        这是跨测试污染的真实形状：碰僵尸的 QUndoStack 会抛
        "Internal C++ object already deleted"，然后**当前**这个测试莫名其妙地失败。
        """
        dead_editor = _FakeEditor()
        dead_ctrl = SceneUndoController(dead_editor)
        dead_ctrl._push("街", _FakeCmd("街"))
        dead_editor.deleteLater()
        QApplication.processEvents()
        from PySide6.QtCore import QCoreApplication, QEvent
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)

        # 僵尸仍被本地变量引用着，故还在弱引用登记表里
        broadcast_external_scene_write("街")   # 不抛即通过

        self.b._push("街", _FakeCmd("街"))
        self.assertEqual(self.b.stack.count(), 1, "健康的页应当照常工作")

    def test_every_push_goes_through_the_single_exit(self) -> None:
        """入栈只准有一个出口 —— 绕过 `_push` 的入栈不会知会别的页。"""
        from pathlib import Path
        src = (Path(__file__).resolve().parents[1]
               / "editors" / "scene_undo.py").read_text(encoding="utf-8")
        # `_push` 自己那一行是唯一允许直接调 stack.push 的地方
        self.assertEqual(
            src.count("self.stack.push("), 1,
            "scene_undo 里出现了绕过 _push 的入栈，跨页知会会被跳过")


if __name__ == "__main__":
    unittest.main()
