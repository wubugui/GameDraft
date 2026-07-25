"""护栏：控件收尾真的能销毁控件。

conftest 的 autouse fixture 是全套跑得快的唯一原因（823s → ~170s）。这条护栏钉死
两件事：① 光靠 ``deleteLater() + processEvents()`` 收不掉（所以那句收尾不能被"简化"
成 processEvents）；② ``destroy_leftover_qt_widgets()`` 收得掉。
"""
from __future__ import annotations

import sys
import unittest

from PySide6.QtWidgets import QApplication, QLabel, QWidget

from tools.editor.tests.qt_teardown import destroy_leftover_qt_widgets, live_widget_count


class QtWidgetTeardownTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _make_top_level(self) -> QWidget:
        w = QWidget()
        QLabel("x", w)
        return w

    def test_delete_later_plus_process_events_does_not_free(self) -> None:
        before = live_widget_count()
        w = self._make_top_level()
        self.assertGreaterEqual(live_widget_count(), before + 2)

        w.deleteLater()
        QApplication.processEvents()

        # loopLevel 0 下 processEvents 不投递 DeferredDelete——控件还活着。
        # 这条断言若开始失败，说明 Qt/PySide 改了语义，届时可以简化收尾。
        self.assertGreaterEqual(live_widget_count(), before + 2)
        self.assertIsNotNone(w)  # 别让 w 被提前回收，那样测的就不是 deleteLater 了

    def test_destroy_leftover_qt_widgets_frees_them(self) -> None:
        # 断相对量而不是 live_widget_count()==0：收尾函数有一条合法的
        # "线程等不回来就放弃销毁、故意泄漏"分支，绝对值断言会被别处的泄漏带偏，
        # 让这条护栏假失败并把矛头指错地方。
        destroy_leftover_qt_widgets()
        before = live_widget_count()

        # 必须留 Python 引用：不留的话控件当场被 GC，就测不到"销毁遗留控件"这件事。
        kept = [self._make_top_level() for _ in range(3)]
        self.assertGreaterEqual(live_widget_count(), before + 6)

        destroy_leftover_qt_widgets()

        self.assertEqual(live_widget_count(), before)
        self.assertEqual(len(kept), 3)  # Python 侧壳还在，C++ 已销毁


if __name__ == "__main__":
    unittest.main()
