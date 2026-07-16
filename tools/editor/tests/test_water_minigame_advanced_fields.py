"""water_minigame 高级字段编辑（glow / depthOsc / motion.jitter / shoreForeground）+
往返格式保真护栏：

- 浏览/重选不得给从未配过动作的实体注入空 onPick/onPullSuccess/onPullFail（存在性保留）；
- 既有显式空数组（onPick:[]）须原样保留；
- glow/depthOsc/jitter 开关写出正确结构、关掉移除键、jitter=0 不写键；
- shoreForeground.banks 主从增删改、清空后移除整个 shoreForeground 空壳；
- 编辑实例级字段（location 等触发画布重建）不得取消当前实体选中（伪 entity_selected(-1) 回归）。
"""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtWidgets import QApplication

from tools.editor.editors.water_minigame_editor import WaterMinigameEditor, _combo_set_text
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_SHORE_SPR = "/resources/runtime/images/minigames/water/shore_bank_dock_gen.png"


class WaterMinigameAdvancedFieldsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list[WaterMinigameEditor] = []
        p = patch("tools.editor.shared.confirm.confirm_delete", return_value=True)
        p.start()
        self.addCleanup(p.stop)

    def tearDown(self) -> None:
        for ed in self._editors:
            ed.deleteLater()
        self._editors.clear()
        QApplication.processEvents()

    def _editor(self, root: Path, instances: dict) -> tuple[WaterMinigameEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.water_minigames_index = [{"id": "wm1", "label": "t", "file": "wm1.json"}]
        model.water_minigames_instances = instances
        ed = WaterMinigameEditor(model)
        ed._inst_list_w.setCurrentRow(0)
        self._editors.append(ed)
        return ed, model

    def _doc(self, model: ProjectModel) -> dict:
        return model.water_minigames_instances["wm1"]

    def _ents(self, model: ProjectModel) -> list[dict]:
        return self._doc(model)["entities"]

    def _base_instances(self, entities: list[dict] | None = None, **doc_extra) -> dict:
        doc = {
            "id": "wm1", "label": "t", "spotId": "s",
            "surface": {"location": "dock", "time": "day", "weather": "clear"},
            "bounds": {"width": 720, "height": 480},
            "entities": entities if entities is not None else [
                {"id": "e0", "category": "swimming", "sprite": "", "depth": 0.3, "pos": {"x": 100, "y": 100}},
            ],
        }
        doc.update(doc_extra)
        return {"wm1": doc}

    # ---- 存在性保留：不注入空数组 / 保留既有空数组 ------------------------

    def test_browsing_does_not_inject_empty_action_arrays(self) -> None:
        with TemporaryDirectory() as td:
            ents = [
                {"id": "a", "category": "grass", "sprite": "", "depth": 0.1, "pos": {"x": 1, "y": 1}},
                {"id": "b", "category": "grass", "sprite": "", "depth": 0.1, "pos": {"x": 2, "y": 2},
                 "onPick": [{"type": "showNotification", "params": {"text": "hi"}}]},
            ]
            ed, model = self._editor(Path(td) / "p", self._base_instances(copy.deepcopy(ents)))
            # 浏览每个实体再 flush
            ed._on_canvas_entity_selected(0)
            ed._on_canvas_entity_selected(1)
            ed._on_canvas_entity_selected(0)
            ed.flush_to_model()
            got = self._ents(model)
            # a 从未配动作 -> 不应被注入任何 on* 键
            self.assertNotIn("onPick", got[0])
            self.assertNotIn("onPullSuccess", got[0])
            self.assertNotIn("onPullFail", got[0])
            # b 仅有 onPick -> 不应补出 onPullSuccess/onPullFail
            self.assertEqual([x["type"] for x in got[1]["onPick"]], ["showNotification"])
            self.assertNotIn("onPullSuccess", got[1])
            self.assertNotIn("onPullFail", got[1])

    def test_existing_empty_arrays_preserved(self) -> None:
        with TemporaryDirectory() as td:
            ents = [{"id": "a", "category": "grass", "sprite": "", "depth": 0.1, "pos": {"x": 1, "y": 1},
                     "onPick": [], "onPullSuccess": [], "onPullFail": []}]
            ed, model = self._editor(Path(td) / "p", self._base_instances(copy.deepcopy(ents)))
            ed._on_canvas_entity_selected(0)
            ed.flush_to_model()
            got = self._ents(model)[0]
            self.assertEqual(got["onPick"], [])
            self.assertEqual(got["onPullSuccess"], [])
            self.assertEqual(got["onPullFail"], [])

    # ---- glow / depthOsc / jitter 读写 + 移除 -----------------------------

    def test_glow_osc_jitter_write_and_clear(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", self._base_instances())
            ed._on_canvas_entity_selected(0)
            e0 = self._ents(model)[0]

            ed._glow_group.setChecked(True)
            ed._glow_color.set_hex("#66ccff")
            ed._glow_daylight.setValue(0.25)
            ed._osc_group.setChecked(True)
            ed._osc_curve.setCurrentText("sine")
            ed._osc_amp.setValue(0.08)
            ed._osc_period.setValue(2.4)
            ed._motion_group.setChecked(True)
            ed._motion_path.setCurrentText("drift")
            ed._motion_speed.setValue(0.06)
            ed._motion_jitter.setValue(0.08)

            self.assertEqual(e0["glow"], {"enabled": True, "color": "#66ccff", "daylightHint": 0.25})
            self.assertEqual(e0["depthOsc"], {"curve": "sine", "amplitude": 0.08, "period": 2.4})
            self.assertEqual(e0["motion"], {"path": "drift", "speed": 0.06, "jitter": 0.08})

            # 关掉移除键；jitter 归零不写键
            ed._glow_group.setChecked(False)
            ed._osc_group.setChecked(False)
            ed._motion_jitter.setValue(0.0)
            self.assertNotIn("glow", e0)
            self.assertNotIn("depthOsc", e0)
            self.assertEqual(e0["motion"], {"path": "drift", "speed": 0.06})

    # ---- shoreForeground.banks 主从增删改 + 清空移除空壳 -------------------

    def test_shore_bank_add_edit_remove(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", self._base_instances())
            doc = self._doc(model)
            self.assertNotIn("shoreForeground", doc)

            ed._add_shore_bank()
            ed._shore_sprite.set_path(_SHORE_SPR)
            ed._shore_sprite.changed.emit()  # 模拟 Browse 的 changed
            ed._shore_edge.setCurrentText("bottom")
            ed._shore_thickness.setValue(92)
            ed._shore_inset.setValue(16)
            # overhang / alpha 未触碰，不应出现
            banks = doc["shoreForeground"]["banks"]
            self.assertEqual(banks, [{"sprite": _SHORE_SPR, "edge": "bottom", "thickness": 92, "inset": 16}])

            # 清空最后一条 -> 整个 shoreForeground 不留空壳
            ed._remove_shore_bank()
            self.assertNotIn("shoreForeground", doc)

    def test_shore_soft_cap_two(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", self._base_instances())
            ed._add_shore_bank()
            ed._add_shore_bank()
            with patch("tools.editor.editors.water_minigame_editor.QMessageBox.information") as info:
                ed._add_shore_bank()
                info.assert_called_once()
            self.assertEqual(len(self._doc(model)["shoreForeground"]["banks"]), 2)

    # ---- 编辑实例级字段不丢实体选中（画布伪 -1 回归）----------------------

    def test_instance_field_edit_keeps_entity_selection(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", self._base_instances())
            ed._on_canvas_entity_selected(0)
            e0 = self._ents(model)[0]
            _combo_set_text(ed._surf_loc, "secret_cove")  # 触发画布重建
            self.assertIs(ed._cur_ent, e0)
            self.assertEqual(ed._selected_ent_row, 0)
            self.assertEqual(self._doc(model)["surface"]["location"], "secret_cove")

    # ---- 真实复杂实例：浏览 + flush 后与输入深相等（零篡改）--------------

    def test_complex_instance_roundtrip_lossless(self) -> None:
        with TemporaryDirectory() as td:
            ents = [
                {"id": "minnow", "category": "swimming", "sprite": "", "depth": 0.4,
                 "pos": {"x": 200, "y": 120},
                 "motion": {"path": "drift", "speed": 0.06, "jitter": 0.08},
                 "depthOsc": {"curve": "sine", "amplitude": 0.08, "period": 2.4},
                 "glow": {"enabled": True, "color": "#66ccff", "daylightHint": 0.25},
                 "onPick": [{"type": "showNotification", "params": {"text": "捞到了", "type": "info"}}]},
                {"id": "weed", "category": "grass", "sprite": "", "depth": 0.1,
                 "pos": {"x": 50, "y": 60}, "onPick": [], "onPullSuccess": [], "onPullFail": []},
            ]
            shore = {"banks": [
                {"sprite": _SHORE_SPR, "edge": "top", "thickness": 92, "inset": 16, "overhang": 64},
                {"sprite": _SHORE_SPR, "edge": "bottom", "thickness": 118, "inset": 10},
            ]}
            instances = self._base_instances(copy.deepcopy(ents), shoreForeground=copy.deepcopy(shore))
            golden = copy.deepcopy(instances["wm1"])
            ed, model = self._editor(Path(td) / "p", instances)
            # 浏览每个实体、每条岸边，再 flush
            for r in range(ed._ent_list_w.count()):
                ed._on_canvas_entity_selected(r)
            for r in range(ed._shore_list_w.count()):
                ed._shore_list_w.setCurrentRow(r)
            ed._on_canvas_entity_selected(0)
            ed.flush_to_model()
            self.assertEqual(self._doc(model), golden, "浏览/flush 后实例被意外改动（格式漂移/丢失）")


if __name__ == "__main__":
    unittest.main()
