"""可勾选的工具按钮**必须看得出自己被选中**。

QSS 一旦接管 `QToolButton`，Qt 就不再画原生的按下/选中外观。主题里只写了
`:hover` 与 `:pressed`、漏掉 `:checked` 时，进了某个模式的按钮和没进的**长得
一模一样** —— 场景画布的工具栏就是整排互斥工具，用户点了完全看不出自己在哪个
模式，而在那套画布里"现在是哪个工具"决定了按下鼠标会发生什么。

这条只能靠样式表本身来守：`isChecked()` 一直是 True（逻辑层没坏），坏的是**画面**，
所以断言必须落在 QSS 文本上。
"""
from __future__ import annotations

import sys
import unittest

from PySide6.QtGui import QActionGroup
from PySide6.QtWidgets import QApplication, QToolBar

from tools.editor import theme

#: 三套主题的样式表构造函数
_BUILDERS = ("_stylesheet_flat_dark", "_stylesheet_flat_light",
             "_stylesheet_flat_modern")


class ToolButtonCheckedStateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def test_every_theme_styles_the_checked_state(self) -> None:
        for name in _BUILDERS:
            builder = getattr(theme, name, None)
            self.assertTrue(callable(builder), f"主题构造函数 {name} 不见了")
            qss = builder()
            with self.subTest(theme=name):
                self.assertIn(
                    "QToolButton:checked", qss,
                    f"{name} 没有为勾选态定义样式 —— "
                    "工具按钮点了看不出被选中（QSS 接管后原生外观不再绘制）")

    def test_checked_style_differs_from_the_idle_one(self) -> None:
        """光有规则不够，取值得和常态**不一样**，否则等于没写。"""
        for name in _BUILDERS:
            qss = getattr(theme, name)()
            block = qss.split("QToolButton:checked", 1)[1].split("}", 1)[0]
            with self.subTest(theme=name):
                self.assertIn("background-color", block,
                              f"{name} 的勾选态没给背景色")
                self.assertNotIn("transparent", block,
                                 f"{name} 的勾选态背景仍是透明 —— 看不出区别")

    def test_exclusive_group_keeps_exactly_one_checked(self) -> None:
        """逻辑层面的互斥（画面之外的另一半）。"""
        bar = QToolBar()
        group = QActionGroup(bar)
        group.setExclusive(True)
        acts = []
        for label in ("选择", "移动", "编辑多边形"):
            act = bar.addAction(label)
            act.setCheckable(True)
            group.addAction(act)
            acts.append(act)
        acts[0].setChecked(True)
        self.assertEqual([a.isChecked() for a in acts], [True, False, False])
        acts[2].setChecked(True)
        self.assertEqual([a.isChecked() for a in acts], [False, False, True])
        bar.deleteLater()
        QApplication.processEvents()


if __name__ == "__main__":
    unittest.main()
