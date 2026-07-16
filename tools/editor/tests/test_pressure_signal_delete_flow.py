"""临场长按 / 信号 Cue 编辑器 P3 流程护栏：

1. 删除后选中相邻行（表单跟随实项），空表则清空表单 + 禁用 Apply，消除"残留已删条目
   的幽灵表单、Apply 静默无效"（审查 P3）。
2. 中断行 to_dict 未知键透传 + atRatio/resetToRatio decimals 放宽到 4（载入即显示原值）。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtWidgets import QApplication

from tools.editor.editors.pressure_signal_editor import (
    PressureHoldEditor,
    SignalCueEditor,
    _InterruptRow,
)
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list = []
        p = patch("tools.editor.shared.confirm.confirm_delete", return_value=True)
        p.start()
        self.addCleanup(p.stop)

    def tearDown(self) -> None:
        for ed in self._editors:
            ed.deleteLater()
        self._editors.clear()
        QApplication.processEvents()

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        return model


class PressureHoldDeleteFlowTests(_Base):
    def _editor(self, root: Path) -> tuple[PressureHoldEditor, ProjectModel]:
        model = self._model(root)
        model.pressure_holds = [
            {"id": "hold_0", "prompt": "甲", "fillSeconds": 3.0, "decayPerSecond": 0.6},
            {"id": "hold_1", "prompt": "乙", "fillSeconds": 4.0, "decayPerSecond": 0.5},
        ]
        ed = PressureHoldEditor(model)
        ed._refresh()
        self._editors.append(ed)
        return ed, model

    def test_delete_selects_adjacent_row(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)  # hold_0
            ed._delete()
            self.assertEqual([h["id"] for h in model.pressure_holds], ["hold_1"])
            # 删除后应选中相邻行（表单跟随实项），而非留 -1 幽灵表单。
            self.assertEqual(ed._current_idx, 0)
            self.assertEqual(ed._f_id.text(), "hold_1")
            self.assertTrue(ed._apply_btn.isEnabled())

    def test_delete_last_clears_form_and_disables_apply(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(0)
            ed._delete()
            ed._delete()  # 删空
            self.assertEqual(model.pressure_holds, [])
            self.assertEqual(ed._current_idx, -1)
            self.assertEqual(ed._f_id.text(), "", "空表应清空表单")
            self.assertFalse(ed._apply_btn.isEnabled(), "空表应禁用 Apply")
            self.assertFalse(ed._right_host.isEnabled())


class SignalCueDeleteFlowTests(_Base):
    def _editor(self, root: Path) -> tuple[SignalCueEditor, ProjectModel]:
        model = self._model(root)
        model.signal_cues = [
            {"id": "cue_0", "actions": []},
            {"id": "cue_1", "actions": []},
        ]
        ed = SignalCueEditor(model)
        ed._refresh()
        self._editors.append(ed)
        return ed, model

    def test_delete_selects_adjacent_then_clears(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._list.setCurrentRow(1)  # cue_1
            ed._delete()
            self.assertEqual([c["id"] for c in model.signal_cues], ["cue_0"])
            self.assertEqual(ed._f_id.text(), "cue_0")
            self.assertTrue(ed._apply_btn.isEnabled())
            ed._delete()  # 删空
            self.assertEqual(model.signal_cues, [])
            self.assertFalse(ed._apply_btn.isEnabled())
            self.assertEqual(ed._f_id.text(), "")


class InterruptRowSerializeTests(_Base):
    def test_unknown_keys_passthrough(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            data = {
                "atRatio": 0.5, "resetToRatio": 0.25, "actions": [],
                "customFutureKey": {"nested": 1}, "note": "保留我",
            }
            row = _InterruptRow(model, data, on_delete=lambda _r: None)
            out = row.to_dict()
            self.assertEqual(out.get("customFutureKey"), {"nested": 1}, "未知键必须透传")
            self.assertEqual(out.get("note"), "保留我")
            self.assertEqual(out["atRatio"], 0.5)
            self.assertEqual(out["resetToRatio"], 0.25)

    def test_ratio_decimals_preserve_original_value(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            # decimals 放宽到 4：0.333 / 0.125 载入即显示原值，不被规整成 2 位。
            data = {"atRatio": 0.333, "resetToRatio": 0.125, "actions": []}
            row = _InterruptRow(model, data, on_delete=lambda _r: None)
            self.assertEqual(row.at_ratio.decimals(), 4)
            self.assertEqual(row.reset_to.decimals(), 4)
            out = row.to_dict()
            self.assertEqual(out["atRatio"], 0.333, "atRatio 应保原值（decimals 4 + round 4）")
            self.assertEqual(out["resetToRatio"], 0.125)

    def test_abort_omits_reset_to_ratio(self) -> None:
        with TemporaryDirectory() as td:
            model = self._model(Path(td) / "p")
            data = {"atRatio": 0.8, "abort": True, "actions": []}
            row = _InterruptRow(model, data, on_delete=lambda _r: None)
            out = row.to_dict()
            self.assertTrue(out.get("abort"))
            self.assertNotIn("resetToRatio", out, "abort 时不写 resetToRatio")


if __name__ == "__main__":
    unittest.main()
