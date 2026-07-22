"""透视缩放深度轴模型的编辑器 UI 流程探针。

覆盖：
- 画布深度轴端点**真实 QMouseEvent** 拖动 → 提交进 model（一条撤销命令）→ 撤销回滚；
- 参与透视的实体命中面**只读幽灵轮廓** = authored 多边形绕锚点 × f(脚底点)，关闭透视后消失；
- 面板 load / 零编辑 flush 保真 / 编辑反映 / 关闭删键 / 重开seed默认轴。

数学口径 parity 见 test_perspective_scale_parity.py。
"""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPoint, QPointF, Qt
from PySide6.QtWidgets import QApplication, QGraphicsPolygonItem

from tools.editor.editors.scene_editor import (
    SceneEditor,
    ScenePropertyPanel,
    _EditableZonePolygon,
)
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


def _vert_axis() -> dict:
    # 竖直轴：近端底部(y=200)大 → 远端顶部(y=0)小
    return {"near": {"x": 0, "y": 200, "scale": 1.0}, "far": {"x": 0, "y": 0, "scale": 0.5}}


class PerspAxisEditorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path, scene: dict) -> tuple[SceneEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.scenes = {scene["id"]: scene}
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene(scene["id"])
        return ed, model

    def _teardown(self, ed: SceneEditor) -> None:
        try:
            ed._scene_npc_anim_timer.stop()
            ed._patrol_overlay_refresh_timer.stop()
        except Exception:
            pass
        ed.deleteLater()
        QApplication.processEvents()

    def test_axis_endpoint_real_mouse_drag_commits_and_undoes(self) -> None:
        with TemporaryDirectory() as td:
            scene = {
                "id": "sc_ax", "name": "sc_ax",
                "worldWidth": 1000, "worldHeight": 1000,
                "spawnPoint": {"x": 500, "y": 900}, "hotspots": [], "npcs": [], "zones": [],
                "perspectiveScale": {
                    "near": {"x": 500, "y": 900, "scale": 1.0},
                    "far": {"x": 500, "y": 200, "scale": 0.4},
                },
            }
            ed, model = self._editor(Path(td) / "p", scene)
            try:
                ed.resize(1200, 800)
                ed.show()
                QApplication.processEvents()
                ed._canvas.fit_all()
                QApplication.processEvents()

                axis = ed._canvas._persp_axis_item
                self.assertIsNotNone(axis, "有 perspectiveScale 应在画布上有深度轴")
                model._dirty.clear()
                model._dirty_scene_ids.clear()
                model._dirty_scenes_all = False
                ed._undo.clear()

                vp = ed._canvas.viewport()
                # 把 near 端点（500,900）横拖 +200 → 轴变斜（near.x 变大）
                start_vp = ed._canvas.mapFromScene(QPointF(500.0, 900.0))
                end_vp = QPoint(start_vp.x() + 80, start_vp.y())
                from PySide6.QtTest import QTest
                QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=start_vp)
                QTest.mouseMove(vp, pos=QPoint((start_vp.x() + end_vp.x()) // 2, start_vp.y()))
                QTest.mouseMove(vp, pos=end_vp)
                QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=end_vp)
                QApplication.processEvents()

                near = model.scenes["sc_ax"]["perspectiveScale"]["near"]
                self.assertGreater(float(near["x"]), 500.0,
                                   f"真实拖 near 端点后 near.x 应增大，实得 {near!r}")
                self.assertAlmostEqual(float(near["y"]), 900.0, delta=1.0)
                self.assertTrue(ed._undo.stack.canUndo(), "拖轴应形成一条撤销命令")
                ed.editor_undo()
                near2 = model.scenes["sc_ax"]["perspectiveScale"]["near"]
                self.assertAlmostEqual(float(near2["x"]), 500.0, delta=0.5,
                                       msg=f"撤销应回 500，实得 {near2!r}")
            finally:
                self._teardown(ed)

    def test_collision_ghost_matches_runtime_hit_area(self) -> None:
        with TemporaryDirectory() as td:
            local_poly = [{"x": -20, "y": -10}, {"x": 20, "y": -10}, {"x": 0, "y": 10}]
            scene = {
                "id": "sc_g", "name": "sc_g",
                "worldWidth": 400, "worldHeight": 400,
                "spawnPoint": {"x": 200, "y": 380}, "npcs": [], "zones": [],
                "hotspots": [{
                    "id": "h1", "type": "inspect", "label": "",
                    "x": 100, "y": 100, "interactionRange": 50,
                    "perspectiveScaleEnabled": True,
                    "collisionPolygon": local_poly, "collisionPolygonLocal": True,
                    "data": {"text": "t"},
                }],
                "perspectiveScale": _vert_axis(),
            }
            ed, _model = self._editor(Path(td) / "p", scene)
            try:
                QApplication.processEvents()
                # 可编辑多边形按 authored 空间（锚点 + 局部点，不乘系数）
                editable = ed._canvas._entity_items.get("hotspot_collision:h1")
                self.assertIsInstance(editable, _EditableZonePolygon)
                for gp, lp in zip(editable.points_to_model(), local_poly):
                    self.assertAlmostEqual(gp["x"], 100 + lp["x"], places=3)
                    self.assertAlmostEqual(gp["y"], 100 + lp["y"], places=3)
                # 幽灵轮廓 = 锚点 + 局部点 × f(100,100)=0.75（竖直轴，t=0.5 → 1.0..0.5 插值）
                ghost = ed._canvas._entity_items.get("hotspot_collision_ghost:h1")
                self.assertIsInstance(ghost, QGraphicsPolygonItem, "参与透视应有幽灵轮廓")
                gpoly = ghost.polygon()
                for i, lp in enumerate(local_poly):
                    self.assertAlmostEqual(gpoly[i].x(), 100 + lp["x"] * 0.75, places=3)
                    self.assertAlmostEqual(gpoly[i].y(), 100 + lp["y"] * 0.75, places=3)
                # 关闭透视 → 幽灵消失，可编辑多边形仍在
                ed._props._sc_persp_enable.setChecked(False)
                QApplication.processEvents()
                self.assertIsNone(ed._canvas._entity_items.get("hotspot_collision_ghost:h1"))
                self.assertIsInstance(
                    ed._canvas._entity_items.get("hotspot_collision:h1"), _EditableZonePolygon)
            finally:
                self._teardown(ed)

    def test_panel_load_flush_roundtrip(self) -> None:
        with TemporaryDirectory() as td:
            write_minimal_loadable_project(Path(td) / "p")
            model = ProjectModel()
            model.load_project(Path(td) / "p")
            cfg = {
                "near": {"x": 100, "y": 300, "scale": 1.0},
                "far": {"x": 400, "y": 50, "scale": 0.4},
                "midStops": [{"pos": 0.5, "scale": 0.7}],
            }
            sc = {"id": "sc_p", "name": "sc_p", "worldWidth": 800, "worldHeight": 600,
                  "spawnPoint": {"x": 400, "y": 550}, "hotspots": [], "npcs": [], "zones": [],
                  "perspectiveScale": copy.deepcopy(cfg)}
            model.scenes["sc_p"] = sc
            orig = copy.deepcopy(sc["perspectiveScale"])
            panel = ScenePropertyPanel(model)
            panel.load_scene_props(sc)

            # 加载态
            self.assertTrue(panel._sc_persp_enable.isChecked())
            self.assertAlmostEqual(panel._sc_persp_near_scale.value(), 1.0, places=3)
            self.assertAlmostEqual(panel._sc_persp_far_scale.value(), 0.4, places=3)
            self.assertEqual(panel._sc_persp_table.rowCount(), 1)

            # 零编辑 flush：值不变
            st = panel._staging_scene
            panel._flush_scene_widgets_into(st)
            self.assertEqual(st["perspectiveScale"], orig)

            # 编辑近端缩放 → flush 反映
            panel._sc_persp_near_scale.setValue(0.8)
            panel._flush_scene_widgets_into(st)
            self.assertAlmostEqual(st["perspectiveScale"]["near"]["scale"], 0.8, places=3)
            self.assertEqual(st["perspectiveScale"]["far"], orig["far"])  # 未动端保持

            # 关闭 → 删键
            panel._sc_persp_enable.setChecked(False)
            panel._flush_scene_widgets_into(st)
            self.assertNotIn("perspectiveScale", st)

            # 重开 → 保留上次设定的轴（不重置，友好 UX）：near.x=100 / far.x=400 仍在
            panel._sc_persp_enable.setChecked(True)
            panel._flush_scene_widgets_into(st)
            new = st["perspectiveScale"]
            self.assertAlmostEqual(float(new["near"]["x"]), 100.0, places=3)
            self.assertAlmostEqual(float(new["far"]["x"]), 400.0, places=3)

    def test_reenable_from_scratch_seeds_vertical_axis(self) -> None:
        # 从未配过透视的场景启用 → seed 默认竖直轴（near/far 同 x）
        with TemporaryDirectory() as td:
            write_minimal_loadable_project(Path(td) / "p")
            model = ProjectModel()
            model.load_project(Path(td) / "p")
            sc = {"id": "sc_v", "name": "sc_v", "worldWidth": 800, "worldHeight": 600,
                  "spawnPoint": {"x": 400, "y": 550}, "hotspots": [], "npcs": [], "zones": []}
            model.scenes["sc_v"] = sc
            panel = ScenePropertyPanel(model)
            panel.load_scene_props(sc)
            self.assertFalse(panel._sc_persp_enable.isChecked())
            panel._sc_persp_enable.setChecked(True)
            st = panel._staging_scene
            panel._flush_scene_widgets_into(st)
            new = st["perspectiveScale"]
            self.assertAlmostEqual(float(new["near"]["x"]), float(new["far"]["x"]), places=3)
            self.assertGreater(float(new["near"]["y"]), float(new["far"]["y"]))  # 近端在下


if __name__ == "__main__":
    unittest.main()
