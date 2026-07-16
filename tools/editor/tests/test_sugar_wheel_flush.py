"""sugar_wheel：Save All 前必须把懒回写的 sector 动作落进模型（save-roundtrip 不丢）。

历史 flush_to_model 只做校验，不 flush 当前激活 sector 的动作编辑器，导致"最后一处
未切行的编辑"在保存时静默丢失。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPointF
from PySide6.QtWidgets import QApplication

from tools.editor import theme
from tools.editor.editors.sugar_wheel_editor import (
    SugarWheelEditor,
    _CenteredGraphicsSimpleTextItem,
    _SugarWheelChargeButtonItem,
)
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class SugarWheelFlushTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list[SugarWheelEditor] = []

    def tearDown(self) -> None:
        for ed in self._editors:
            ed.deleteLater()
        self._editors.clear()
        QApplication.processEvents()

    def _editor(self, root: Path) -> tuple[SugarWheelEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.sugar_wheel_index = [{"id": "sw1", "file": "sw1.json"}]
        model.sugar_wheel_instances = {"sw1": {
            "id": "sw1", "wheelImage": "w.png", "pointerImage": "p.png",
            "sectors": [
                {"id": "s0", "label": "A"},
                {"id": "s1", "label": "B"},
            ],
        }}
        ed = SugarWheelEditor(model)
        ed._reload_list("sw1")
        self._editors.append(ed)
        return ed, model

    def test_active_sector_actions_flushed_on_save(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            ed._sector_table.selectRow(0)
            # 模拟未切行的最后一处编辑：直接改 ActionEditor，不触发切行 flush
            ed._ae_sector_drag.set_data([{"type": "playSfx"}])
            ed.flush_to_model()
            sec0 = model.sugar_wheel_instances["sw1"]["sectors"][0]
            types = [a.get("type") for a in sec0.get("actionsOnPointerDrag") or []]
            self.assertEqual(types, ["playSfx"],
                             "Save All 前必须 flush 当前 sector 动作，否则静默丢失")

    def test_scaled_canvas_labels_remain_centered(self) -> None:
        original_theme = theme.current_theme_id()
        original_font = theme.current_font_px()
        try:
            theme.apply_application_theme(self._qt_app, theme.THEME_MODERN, theme.MAX_FONT_PX)
            centered = _CenteredGraphicsSimpleTextItem("扇区标签", QPointF(100, 50))
            theme.set_graphics_text_font(centered, theme.FONT_ROLE_CANVAS_PROMINENT)
            centered.refresh_editor_font()
            center = centered.mapRectToParent(centered.boundingRect()).center()
            self.assertAlmostEqual(center.x(), 100.0)
            self.assertAlmostEqual(center.y(), 50.0)

            class FakeCanvas:
                _move_silent = True

            charge = _SugarWheelChargeButtonItem(FakeCanvas())  # type: ignore[arg-type]
            charge.set_diameter(160, silent=True)
            charge_center = charge._label.mapRectToParent(charge._label.boundingRect()).center()
            self.assertAlmostEqual(charge_center.x(), 0.0)
            self.assertAlmostEqual(charge_center.y(), 0.0)
        finally:
            theme.apply_application_theme(self._qt_app, original_theme, original_font)


if __name__ == "__main__":
    unittest.main()
