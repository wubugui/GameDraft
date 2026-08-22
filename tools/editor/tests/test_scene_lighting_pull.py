"""灯位与游戏的**双向实时同步**在编辑器这一侧的流程探针。

摆灯最准的地方是跑起来的画面，改数值最顺手的地方是这张表——所以两边改的是同一份
`lighting`，任一边动了另一边就跟上。这一组锁的是编辑器这一头的两件事：
吃进来的整块真的落进了工作副本、且**真的入脏**（不入脏 = Save All 不写这个场景，
摆了半天的灯静默丢掉）；以及**什么时候不许吃**（人正在表里打字、正在画布上定位）。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtWidgets import QApplication, QMessageBox

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


def _scene() -> dict:
    return {
        "id": "sc_a",
        "name": "甲场景",
        "worldWidth": 4000.0,
        "worldHeight": 2251.2,
        "lighting": {
            "sky": {"intensity": 0.05, "hemi": 0.85},
            "day": {"sunIntensity": 0.0, "sunElevationDeg": 50.0, "sunAzimuthDeg": 180.0},
            "lights": [{"id": "old_1", "kind": "point", "intensity": 1.0, "pos": [0, 0, 0]}],
            "display": {"ev": 0.0, "tonemap": "filmic"},
            "fog": {"sigma": 0.25},
        },
    }


RUNTIME_LIGHTING = {
    "sky": {"intensity": 0.09, "hemi": 0.7},
    "day": {"sunIntensity": 0.0, "sunElevationDeg": 50.0, "sunAzimuthDeg": 180.0},
    "lights": [
        {"id": "lamp_1", "kind": "point", "intensity": 2.5, "pos": [1.0, 2.0, 3.0]},
        {"id": "lamp_2", "kind": "spot", "intensity": 4.0, "pos": [4.0, 5.0, 6.0]},
    ],
    "display": {"ev": 0.5, "tonemap": "filmic"},
    "fog": {"sigma": 0.9},
}

RUNTIME_DOC = {"sceneId": "sc_a", "lighting": RUNTIME_LIGHTING}


class SceneLightingSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list[SceneEditor] = []

    def tearDown(self) -> None:
        for ed in self._editors:
            try:
                ed._scene_npc_anim_timer.stop()
                ed._patrol_overlay_refresh_timer.stop()
                ed._canvas._gfx.blockSignals(True)
            except Exception:
                pass
            ed.deleteLater()
        QApplication.processEvents()

    def _editor(self, root: Path):
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.scenes = {"sc_a": _scene()}
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._editors.append(ed)
        model._dirty.clear()
        model._dirty_scene_ids.clear()
        model._dirty_scenes_all = False
        ed._undo.clear()
        return ed, model

    # ---- 吃进来 ---------------------------------------------------------

    def test_apply_synced_replaces_block_and_marks_dirty(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            panel = ed._props
            self.assertEqual([l["id"] for l in panel._sl_lights()], ["old_1"])
            panel.apply_synced_lighting(RUNTIME_LIGHTING)
            self.assertEqual([l["id"] for l in panel._sl_lights()], ["lamp_1", "lamp_2"])
            # 整块替换：面板不显示的键（fog / display）也得跟着走，否则同步一次就把它们清了
            self.assertEqual(panel._sc_lighting["fog"]["sigma"], 0.9)
            self.assertEqual(panel._sc_lighting["display"]["ev"], 0.5)
            # 真入脏：不入脏的话 Save All 根本不写这个场景
            ed.flush_to_model()
            self.assertIn("scene", model._dirty)
            self.assertEqual(
                [l["id"] for l in model.scenes["sc_a"]["lighting"]["lights"]],
                ["lamp_1", "lamp_2"])
            # 派生的编辑期字段不得落进数据契约
            for l in model.scenes["sc_a"]["lighting"]["lights"]:
                self.assertNotIn("_editorHeightWu", l)

    def test_apply_keeps_selected_row_so_the_table_is_usable_while_syncing(self) -> None:
        """同步是每 0.4s 一拍的：选中行每拍跳回第一行的话，表里根本改不了东西。"""
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            panel = ed._props
            panel.apply_synced_lighting(RUNTIME_LIGHTING)
            panel._sl_table.selectRow(1)
            self.assertEqual(panel._sl_selected, 1)
            panel.apply_synced_lighting(RUNTIME_LIGHTING)
            self.assertEqual(panel._sl_selected, 1)

    # ---- 什么时候不许吃 --------------------------------------------------

    def test_busy_while_placing_on_canvas(self) -> None:
        """「在画布上定位选中的灯」点亮时下一次点击就要落点——参数被换掉会摆到错的灯上。"""
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            panel = ed._props
            self.assertFalse(panel.sync_busy())
            panel._sl_place.setChecked(True)
            self.assertTrue(panel.sync_busy())
            panel._sl_place.setChecked(False)
            self.assertFalse(panel.sync_busy())

    def test_busy_while_typing_in_the_light_form(self) -> None:
        """人正在表单里打字时塞进整块参数 = 当场把这次编辑吞掉。"""
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            panel = ed._props
            panel.apply_synced_lighting(RUNTIME_LIGHTING)
            panel._sl_table.selectRow(0)
            panel._sl_id.setFocus()
            QApplication.processEvents()
            if QApplication.focusWidget() is panel._sl_id:   # 离屏下焦点未必给得到
                self.assertTrue(panel.sync_busy())

    # ---- 手动「立即抓一次」（同步被打断时的兜底） -------------------------

    def test_manual_grab_uses_http_slot_and_reports_when_unreachable(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            panel = ed._props
            with patch("tools.editor.editors.scene_lights.fetch_sync_doc",
                       return_value=(None, None, "连不上 dev server（http://x）：boom")):
                panel._on_sl_pull_runtime()
            self.assertIn("连不上 dev server", panel._sl_status.text())
            self.assertFalse(model.is_dirty)

    def test_manual_grab_applies_after_confirm(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            panel = ed._props
            with patch("tools.editor.editors.scene_lights.fetch_sync_doc",
                       return_value=(RUNTIME_DOC, 120, "")), \
                    patch.object(QMessageBox, "question",
                                 return_value=QMessageBox.StandardButton.Yes):
                panel._on_sl_pull_runtime()
            self.assertEqual([l["id"] for l in panel._sl_lights()], ["lamp_1", "lamp_2"])
            ed.flush_to_model()
            self.assertIn("scene", model._dirty)

    def test_manual_grab_refuses_cross_scene(self) -> None:
        """游戏停在别的场景时抓 = 把灯摆进错的场景。连确认框都不该弹。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            panel = ed._props
            other = dict(RUNTIME_DOC, sceneId="sc_b")
            with patch("tools.editor.editors.scene_lights.fetch_sync_doc",
                       return_value=(other, 120, "")), \
                    patch.object(QMessageBox, "question",
                                 side_effect=AssertionError("不该弹确认框")):
                panel._on_sl_pull_runtime()
            self.assertEqual([l["id"] for l in panel._sl_lights()], ["old_1"])
            self.assertFalse(model.is_dirty)


if __name__ == "__main__":
    unittest.main()
