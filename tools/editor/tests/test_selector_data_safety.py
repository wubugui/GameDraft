"""新增选择器(自由文本→下拉/IdRefSelector)的数据安全回归:
- 既有值(含未登记的"孤儿"值)绝不被静默丢弃
- 空值语义保持(该缺省的字段不被写空键)
- 往返字节/语义一致

覆盖:audio systemSfx 系统键、pressure holdSfx、sugar atmos op/sectorId。
这些字段以前是裸 QLineEdit/QTableWidgetItem,换成选择器后必须保证导出格式不变。
"""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication, QComboBox

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class SelectorDataSafetyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        return m

    def test_audio_system_key_orphan_and_order_preserved(self) -> None:
        from tools.editor.editors.audio_editor import _SystemSfxTab
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.audio_config["systemSfx"] = {
                "questAccepted": "sfx_a",
                "customLegacyKey": "sfx_b",  # 不在运行时枚举里的孤儿键
                "uiHover": "",               # 显式空值
            }
            before = copy.deepcopy(m.audio_config["systemSfx"])
            tab = _SystemSfxTab(m)
            tab._apply()
            after = m.audio_config["systemSfx"]
            self.assertEqual(before, after, "systemSfx 往返应字节一致(含孤儿键/空值)")
            self.assertEqual(list(before.keys()), list(after.keys()), "键顺序须保持")

    def test_pressure_holdsfx_orphan_preserved_and_empty_absent(self) -> None:
        from tools.editor.editors.pressure_signal_editor import PressureHoldEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.pressure_holds = [
                {"id": "h0", "prompt": "按住", "fillSeconds": 3.0,
                 "decayPerSecond": 0.6, "holdSfx": "legacy_breath_loop"},
                {"id": "h1", "prompt": "x"},  # 无 holdSfx
            ]
            ed = PressureHoldEditor(m)
            ed._list.setCurrentRow(0)
            ed._apply()
            ed._list.setCurrentRow(1)
            ed._apply()
            self.assertEqual(m.pressure_holds[0].get("holdSfx"), "legacy_breath_loop",
                             "未登记的 holdSfx 仍须保留")
            self.assertNotIn("holdSfx", m.pressure_holds[1],
                             "空 holdSfx 不得写出空键")

    def test_sugar_atmos_op_combo_orphan_and_roundtrip(self) -> None:
        from tools.editor.editors.sugar_wheel_editor import SugarWheelEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            ed = SugarWheelEditor(m)
            # 已知枚举值往返
            cb = ed._make_atmos_op_combo("ph", "when_near_sector")
            self.assertIsInstance(cb, QComboBox)
            self.assertEqual(cb.currentText(), "when_near_sector")
            # 未知 op 也保留为可选项
            cb2 = ed._make_atmos_op_combo("ph", "legacy_op")
            self.assertEqual(cb2.currentText(), "legacy_op")

    def test_sugar_atmos_sector_combo_orphan_and_empty(self) -> None:
        from tools.editor.editors.sugar_wheel_editor import SugarWheelEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            ed = SugarWheelEditor(m)
            ed._doc = {"id": "sw", "sectors": [{"id": "s0"}, {"id": "s1"}]}
            # 空 = 不指定
            self.assertEqual(ed._make_atmos_sector_combo("ph", "").currentText(), "")
            # 已存在的格子
            self.assertEqual(ed._make_atmos_sector_combo("ph", "s1").currentText(), "s1")
            # 未知 sectorId 仍保留
            self.assertEqual(
                ed._make_atmos_sector_combo("ph", "ghost_sector").currentText(),
                "ghost_sector")


if __name__ == "__main__":
    unittest.main()
