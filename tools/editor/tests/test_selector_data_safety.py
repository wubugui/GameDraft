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

    def test_sugar_atmos_unknown_op_preserved(self) -> None:
        """氛围指令编辑器：未知 op 及其字段原样保留，已知 op 正常往返。"""
        from tools.editor.editors.atmosphere_script_editor import AtmosphereScriptEditor
        ed = AtmosphereScriptEditor(
            roles_getter=lambda: [("", "")], sectors_getter=lambda: [], pools_getter=lambda: [])
        try:
            ed.set_data([
                {"op": "wait", "sec": 0.5},
                {"op": "legacy_op", "foo": 1, "bar": "x"},  # 未知 op
            ])
            out = ed.to_list()
            self.assertEqual(out[0]["op"], "wait")
            self.assertEqual(out[1]["op"], "legacy_op", "未知 op 须保留")
            self.assertEqual(out[1].get("foo"), 1, "未知 op 的字段须原样保留")
            self.assertEqual(out[1].get("bar"), "x")
        finally:
            ed.deleteLater()

    def test_sugar_atmos_sector_orphan_and_empty(self) -> None:
        """when_near_sector 的 sectorId：空=不写键、已知保留、未知孤儿不丢。"""
        from tools.editor.editors.atmosphere_script_editor import AtmosphereScriptEditor
        ed = AtmosphereScriptEditor(
            roles_getter=lambda: [("", "")],
            sectors_getter=lambda: ["s0", "s1"], pools_getter=lambda: [])
        try:
            ed.set_data([
                {"op": "when_near_sector", "degBuffer": 10},                  # 空 sectorId
                {"op": "when_near_sector", "sectorId": "s1", "degBuffer": 10},  # 已知
                {"op": "when_near_sector", "sectorId": "ghost", "degBuffer": 10},  # 未知孤儿
            ])
            out = ed.to_list()
            self.assertNotIn("sectorId", out[0], "空 sectorId 不写空键")
            self.assertEqual(out[1].get("sectorId"), "s1")
            self.assertEqual(out[2].get("sectorId"), "ghost", "未知 sectorId 须保留")
        finally:
            ed.deleteLater()


if __name__ == "__main__":
    unittest.main()
