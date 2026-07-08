"""sugar_wheel 旋转氛围脚本（RPGMaker-event 式嵌套指令列表）：编辑/保存零数据丢失。

氛围脚本由 AtmosphereScriptEditor 编辑：每条指令一行，chance/when_near_sector 在行下
挂 then/else 子列表（同款控件递归）。本测试钉死：
  1. set_data → to_list 对真实结构逐字段全等（pool/text/durationMs/slot/then/else 全保真）；
  2. 「固定台词恰好等于池名」不被误判成池引用；
  3. 编辑某阶段会写回当前组，且不波及其它阶段/分支；
  4. 文案池改名传播到引用它的步骤（含嵌套）。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.atmosphere_script_editor import AtmosphereScriptEditor
from tools.editor.editors.sugar_wheel_editor import SugarWheelEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

# 覆盖全部 op + 嵌套 then/else + 各类无列字段（durationMs/slot）+ 「台词等于池名」陷阱。
START = [
    {"op": "say", "role": "child_a", "pool": "poolA", "durationMs": 1200},
    {"op": "pick", "pool": "poolA", "slot": "_x"},
    {"op": "chance", "p": 0.4,
     "then": [{"op": "say", "text": "深"}],
     "else": [{"op": "wait", "sec": 0.5}]},
    {"op": "when_near_sector", "sectorId": "s0", "degBuffer": 12,
     "then": [{"op": "say", "role": "child_b", "pool": "poolA"}]},
    {"op": "say", "role": "child_a", "text": "poolA"},  # 固定台词恰好=池名
]

_ROLES = [("（选角色）", ""), ("小孩A", "child_a"), ("小孩B", "child_b"), ("摊主", "stall_owner")]


def _make_widget() -> AtmosphereScriptEditor:
    return AtmosphereScriptEditor(
        roles_getter=lambda: _ROLES,
        sectors_getter=lambda: ["s0", "s1"],
        pools_getter=lambda: ["poolA"],
    )


def _instance() -> dict:
    return {
        "id": "sw1",
        "wheelImage": "w.png",
        "pointerImage": "p.png",
        "sectors": [{"id": "s0", "label": "A"}, {"id": "s1", "label": "B"}],
        "atmosphereGroups": [{
            "id": "g1", "label": "G1", "weight": 1,
            "vars": {"poolA": ["甲", "乙"]},
            "start": [dict(s) for s in START],
        }],
    }


class AtmosphereScriptWidgetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_set_data_to_list_roundtrip_exact(self) -> None:
        ed = _make_widget()
        try:
            ed.set_data([dict(s) for s in START])
            self.assertEqual(ed.to_list(), START, "set_data→to_list 必须逐字段全等")
        finally:
            ed.deleteLater()

    def test_pool_vs_literal_not_coerced(self) -> None:
        ed = _make_widget()
        try:
            ed.set_data([dict(s) for s in START])
            out = ed.to_list()
            self.assertEqual(out[0].get("pool"), "poolA")
            self.assertNotIn("text", out[0])
            self.assertEqual(out[4].get("text"), "poolA")  # 台词=池名仍是 text
            self.assertNotIn("pool", out[4])
        finally:
            ed.deleteLater()

    def test_nested_branches_preserved(self) -> None:
        ed = _make_widget()
        try:
            ed.set_data([dict(s) for s in START])
            out = ed.to_list()
            self.assertEqual(out[2].get("then"), [{"op": "say", "text": "深"}])
            self.assertEqual(out[2].get("else"), [{"op": "wait", "sec": 0.5}])
            self.assertEqual(out[3].get("then"), [{"op": "say", "role": "child_b", "pool": "poolA"}])
        finally:
            ed.deleteLater()

    def test_add_step_emits_change(self) -> None:
        ed = _make_widget()
        try:
            ed.set_data([])
            fired = []
            ed.changed.connect(lambda: fired.append(1))
            ed._add_step()
            self.assertTrue(fired, "新增指令必须触发 changed（供外层写回）")
            self.assertEqual(len(ed.to_list()), 1)
        finally:
            ed.deleteLater()


class SugarWheelAtmosphereIntegrationTests(unittest.TestCase):
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

    def _editor(self, root: Path) -> SugarWheelEditor:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.sugar_wheel_index = [{"id": "sw1", "file": "sw1.json"}]
        model.sugar_wheel_instances = {"sw1": _instance()}
        ed = SugarWheelEditor(model)
        ed._reload_list("sw1")
        ed._list.setCurrentRow(0)
        ed._atmos_group_list.setCurrentRow(0)
        self._editors.append(ed)
        return ed

    def test_phase_editor_reflects_group_data(self) -> None:
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            self.assertEqual(ed._atmos_phase_editors["start"].to_list(), START,
                             "阶段编辑器须忠实反映组数据")

    def test_editing_phase_writes_back_to_group(self) -> None:
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            ed._atmos_phase_editors["start"]._add_step()  # 触发 changed → 写回
            start = ed._model.sugar_wheel_instances["sw1"]["atmosphereGroups"][0]["start"]
            self.assertEqual(len(start), len(START) + 1, "编辑阶段应写回当前组")
            # 其它分支不受波及：原有 then/else 仍在
            self.assertEqual(start[2].get("then"), [{"op": "say", "text": "深"}])
            self.assertEqual(start[2].get("else"), [{"op": "wait", "sec": 0.5}])

    def test_rename_pool_propagates_to_step_refs(self) -> None:
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            g = ed._cur_atmos_group()
            ed._rename_pool_refs(g.get("start"), "poolA", "poolB")
            start = ed._model.sugar_wheel_instances["sw1"]["atmosphereGroups"][0]["start"]
            self.assertEqual(start[0].get("pool"), "poolB", "say 池引用应随改名更新")
            self.assertEqual(start[1].get("pool"), "poolB", "pick 池引用应随改名更新")
            self.assertEqual(start[3]["then"][0].get("pool"), "poolB", "嵌套 then 内池引用也应更新")


if __name__ == "__main__":
    unittest.main()
