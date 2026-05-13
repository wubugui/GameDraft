"""复现"添加 NPC 巡逻路点 crash 闪退"。

模拟用户操作：选中 NPC → 启用巡逻 → 点添加路点。捕获任何 Python/Qt 层异常。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class TestNpcPatrolAddCrash(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        return model

    def _bootstrap_editor_with_npc(self, root: Path) -> tuple[SceneEditor, str]:
        model = self._model(root)
        sid = next(iter(model.scenes.keys()), None)
        if sid is None:
            model.scenes["s0"] = {
                "id": "s0", "name": "s0", "worldWidth": 800, "worldHeight": 600,
                "hotspots": [], "npcs": [], "zones": [],
            }
            sid = "s0"
        sc = model.scenes[sid]
        sc.setdefault("npcs", []).append({
            "id": "n0", "name": "N0", "x": 100, "y": 100,
            "interactionRange": 50,
        })
        editor = SceneEditor(model)
        editor._load_scene(sid)
        return editor, sid

    def test_add_patrol_point_does_not_crash(self) -> None:
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor_with_npc(Path(td) / "p")
            npc = editor._model.scenes[sid]["npcs"][0]
            editor._props.load_npc_props(npc)

            self.assertIs(editor._props._pending_npc, editor._props._staging_npc)
            self.assertIsNotNone(editor._props._pending_npc)

            editor._props._npc_patrol_enable.setChecked(True)
            self.assertTrue(editor._props._npc_patrol_enable.isChecked())

            for _ in range(3):
                editor._props._on_npc_patrol_add_point()
                self._qt_app.processEvents()

            pat = editor._props._pending_npc.get("patrol", {})
            route = pat.get("route", [])
            self.assertGreaterEqual(len(route), 4, f"route after 3 adds: {route}")

    def test_add_patrol_point_with_canvas_selected(self) -> None:
        """模拟用户先在画布选中 NPC，再启用 patrol 加点（触发画布 overlay 重建）。"""
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor_with_npc(Path(td) / "p")
            editor._on_item_selected("npc", "n0")
            self.assertIs(editor._props._stack.currentWidget(), editor._props._npc_panel)

            editor._props._npc_patrol_enable.setChecked(True)
            self._qt_app.processEvents()

            for _ in range(3):
                editor._props._on_npc_patrol_add_point()
                self._qt_app.processEvents()

            pat = editor._props._pending_npc.get("patrol", {})
            route = pat.get("route", [])
            self.assertGreaterEqual(len(route), 4)
            self.assertIn("n0", editor._canvas._patrol_overlays)

    def test_add_patrol_point_then_remove_overlay_reentrant(self) -> None:
        """重复 enable/disable patrol 触发 overlay 增删，验证不会触发 removeItem 崩溃。"""
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor_with_npc(Path(td) / "p")
            editor._on_item_selected("npc", "n0")

            for _ in range(3):
                editor._props._npc_patrol_enable.setChecked(True)
                self._qt_app.processEvents()
                editor._props._on_npc_patrol_add_point()
                editor._props._on_npc_patrol_add_point()
                self._qt_app.processEvents()
                editor._props._npc_patrol_enable.setChecked(False)
                self._qt_app.processEvents()

    def test_canvas_npc_selected_then_add_patrol_point(self) -> None:
        """更接近用户实操：画布上点中 NPC（gfx 也 selected）→ 启用 patrol → 加点。"""
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor_with_npc(Path(td) / "p")
            key = "npc:n0"
            it = editor._canvas._entity_items.get(key)
            self.assertIsNotNone(it, "npc graphics item missing after _load_scene")
            it.setSelected(True)
            editor._on_item_selected("npc", "n0")
            self._qt_app.processEvents()

            editor._props._npc_patrol_enable.setChecked(True)
            self._qt_app.processEvents()
            self.assertIn("n0", editor._canvas._patrol_overlays)

            patrol_item = editor._canvas._patrol_overlays["n0"]
            patrol_item.setSelected(True)
            self._qt_app.processEvents()

            for _ in range(5):
                editor._props._on_npc_patrol_add_point()
                self._qt_app.processEvents()

            self.assertGreaterEqual(
                len(editor._props._pending_npc.get("patrol", {}).get("route", [])), 5,
            )


if __name__ == "__main__":
    unittest.main()
