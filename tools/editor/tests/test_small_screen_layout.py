"""小屏(13″)布局护栏：编辑器面板的最小宽度不得超出可用空间，弹窗不得高于屏幕。

13″ 笔记本(1280×800)上，主窗口左侧导航 ~160px，停靠的编辑器面板可用宽 ~1100px、
可用高 ~720px。若某编辑器的 minimumSizeHint 宽度超预算，就会强制横向滚动条或裁切
——这正是本轮"小屏大屏都友好"要修的根因。本测试把预算固化，防止回归。

只断言"最小尺寸 ≤ 预算"，不约束最大尺寸——大屏上面板仍可自由放大（splitter 把
多余空间分给画布），所以这层护栏对大屏无害。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor import theme
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.tests.test_all_editors_construct import _editor_classes

# 13″ 1280px 屏减去 ~160px 导航后，停靠面板约有 1100px。留一点余量到 1120。
PANEL_WIDTH_BUDGET = 1120
# 1280×800 减去标题栏/任务栏后可用高约 720px；弹窗下限不应超过它。
DIALOG_HEIGHT_BUDGET = 720
DIALOG_WIDTH_BUDGET = 1240


class SmallScreenLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._original_theme = theme.current_theme_id()
        self._original_font = theme.current_font_px()
        theme.apply_application_theme(
            self._app,
            theme.THEME_MODERN,
            theme.DEFAULT_FONT_PX,
        )

    def tearDown(self) -> None:
        theme.apply_application_theme(
            self._app,
            self._original_theme,
            self._original_font,
        )

    def test_no_editor_panel_exceeds_13in_width_budget(self) -> None:
        over: list[str] = []
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            for cls in _editor_classes():
                ed = cls(model)
                w = ed.minimumSizeHint().width()
                if w > PANEL_WIDTH_BUDGET:
                    over.append(f"{cls.__name__}: minimumSizeHint width {w} > {PANEL_WIDTH_BUDGET}")
                ed.deleteLater()
                QApplication.processEvents()
        if over:
            self.fail(
                "以下编辑器在 13″ 上会横向溢出（请用 setMaximumWidth/降低面板最小宽/"
                "缩小画布最小尺寸修复）:\n  " + "\n  ".join(over))

    def test_resizable_dialogs_fit_13in_height(self) -> None:
        """改造过的弹窗：最小尺寸须能塞进 13″ 屏(可缩放)。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)

            from tools.editor.shared.action_editor import ActionTypePickerDialog
            from tools.editor.shared.flag_picker_dialog import FlagPickerDialog

            checks = [
                ("ActionTypePickerDialog", ActionTypePickerDialog()),
                ("FlagPickerDialog", FlagPickerDialog(model, None, "")),
            ]
            for name, dlg in checks:
                self.assertLessEqual(
                    dlg.minimumHeight(), DIALOG_HEIGHT_BUDGET,
                    f"{name} 最小高 {dlg.minimumHeight()} 超出 13″ 可用高 {DIALOG_HEIGHT_BUDGET}")
                self.assertLessEqual(
                    dlg.minimumWidth(), DIALOG_WIDTH_BUDGET,
                    f"{name} 最小宽 {dlg.minimumWidth()} 超出 {DIALOG_WIDTH_BUDGET}")
                dlg.deleteLater()


if __name__ == "__main__":
    unittest.main()
