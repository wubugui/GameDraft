"""透视缩放数学镜像的跨语言 parity 锁。

`tools/editor/shared/entity_transform_math.py::perspective_scale_at` ↔
`src/utils/perspectiveScale.ts::perspectiveScaleAt` 是手工镜像——本文件与
`src/utils/perspectiveScale.test.ts` 钉死**同一组黄金数值**，任一侧漂移即红
（norms 第 8 条：手工镜像必配语义级 parity）。

新增/修改用例时必须同步改两个文件（黄金常量一字不差）。

另含参与判定（entity_participates_perspective / entity_perspective_factor）的
契约锁：npc 缺省参与、renderRaw 缺省不参与、hotspot 缺省不参与——与运行时
Npc.setPerspectiveScale / Hotspot.setPerspectiveScale 的判定同口径。
"""
from __future__ import annotations

import math
import unittest

from tools.editor.shared.entity_transform_math import (
    entity_participates_perspective,
    entity_perspective_factor,
    perspective_scale_at,
    perspective_valid_rulers,
)

TWO = {"rulers": [{"y": 100, "scale": 0.5}, {"y": 500, "scale": 1.0}]}
TWO_UNSORTED = {"rulers": [{"y": 500, "scale": 1.0}, {"y": 100, "scale": 0.5}]}
THREE = {"rulers": [{"y": 0, "scale": 0.2}, {"y": 100, "scale": 0.4}, {"y": 300, "scale": 1.0}]}
WITH_INVALID = {
    "rulers": [
        {"y": float("nan"), "scale": 1},
        {"y": 100, "scale": 0.5},
        {"y": 0, "scale": 0},
        {"y": 500, "scale": 2.0},
    ],
}
DUP_Y = {"rulers": [{"y": 100, "scale": 0.5}, {"y": 100, "scale": 0.8}, {"y": 200, "scale": 1.0}]}
TINY = {"rulers": [{"y": 0, "scale": 0.001}, {"y": 100, "scale": 0.001}]}

# (cfg, foot_y) -> 期望系数（黄金常量，与 TS 侧完全一致）
GOLDEN_SCALE_AT = [
    (None, 300, 1.0),
    ({"rulers": [{"y": 100, "scale": 0.5}]}, 100, 1.0),
    (TWO, 100, 0.5),
    (TWO, 500, 1.0),
    (TWO, 300, 0.75),
    (TWO, 0, 0.5),
    (TWO, 600, 1.0),
    (TWO_UNSORTED, 300, 0.75),
    (THREE, 50, 0.3),
    (THREE, 200, 0.7),
    (WITH_INVALID, 300, 1.25),
    (DUP_Y, 100, 0.5),
    (DUP_Y, 150, 0.9),
    (TINY, 50, 0.01),
    (TWO, float("nan"), 1.0),
]


class PerspectiveScaleParityTests(unittest.TestCase):
    def test_scale_at_golden(self) -> None:
        for cfg, foot_y, want in GOLDEN_SCALE_AT:
            got = perspective_scale_at(cfg, foot_y)
            self.assertAlmostEqual(got, want, places=6, msg=f"cfg={cfg!r} y={foot_y!r}")

    def test_valid_rulers_filter(self) -> None:
        self.assertEqual(perspective_valid_rulers(None), [])
        self.assertEqual(perspective_valid_rulers({"rulers": "x"}), [])
        self.assertEqual(
            perspective_valid_rulers(WITH_INVALID),
            [(100, 0.5), (500, 2.0)],
        )
        # 布尔不是数值（与 TS typeof number 同口径）
        self.assertEqual(
            perspective_valid_rulers({"rulers": [{"y": True, "scale": 1}]}), [])

    def test_participation_contract(self) -> None:
        # npc：缺省参与；renderRaw 缺省不参与；显式字段优先（运行时 Npc.setPerspectiveScale 同口径）
        self.assertTrue(entity_participates_perspective({}, "npc"))
        self.assertFalse(entity_participates_perspective({"renderRaw": True}, "npc"))
        self.assertTrue(entity_participates_perspective(
            {"renderRaw": True, "perspectiveScaleEnabled": True}, "npc"))
        self.assertFalse(entity_participates_perspective(
            {"perspectiveScaleEnabled": False}, "npc"))
        # hotspot：缺省不参与；显式 True 才参与（运行时 Hotspot.setPerspectiveScale 同口径）
        self.assertFalse(entity_participates_perspective({}, "hotspot"))
        self.assertTrue(entity_participates_perspective(
            {"perspectiveScaleEnabled": True}, "hotspot"))

    def test_entity_factor(self) -> None:
        npc = {"y": 300}
        self.assertAlmostEqual(entity_perspective_factor(TWO, npc, "npc"), 0.75, places=6)
        # foot_y 覆盖（巡逻瞬时位置）
        self.assertAlmostEqual(
            entity_perspective_factor(TWO, npc, "npc", 100), 0.5, places=6)
        # 不参与 → 恒 1
        self.assertEqual(entity_perspective_factor(TWO, {"y": 300}, "hotspot"), 1.0)
        # y 非法 → 1
        self.assertEqual(entity_perspective_factor(TWO, {"y": "x"}, "npc"), 1.0)
        self.assertTrue(math.isfinite(entity_perspective_factor(None, npc, "npc")))


class PerspRulerDragFlowTests(unittest.TestCase):
    """流程探针门：画布透视基准线拖拽从**真实 QMouseEvent** 入口验证
    （拖线 → persp_ruler_committed → 面板表格 → 统一提交入模型，一条撤销命令）。"""

    @classmethod
    def setUpClass(cls) -> None:
        import sys

        from PySide6.QtWidgets import QApplication

        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_collision_ghost_outline_matches_runtime_hit_area(self) -> None:
        """参与透视的实体：可编辑多边形保持 authored 空间；另有只读幽灵轮廓
        = authored 多边形绕锚点 × f(y)（与运行时 anchorCollisionPolygonToWorld
        extraScale 同口径）；关闭场景透视后幽灵消失。"""
        from pathlib import Path
        from tempfile import TemporaryDirectory

        from PySide6.QtWidgets import QApplication, QGraphicsPolygonItem

        from tools.editor.editors.scene_editor import SceneEditor, _EditableZonePolygon
        from tools.editor.project_model import ProjectModel
        from tools.editor.tests.save_test_utils import write_minimal_loadable_project

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            local_poly = [{"x": -20, "y": -10}, {"x": 20, "y": -10}, {"x": 0, "y": 10}]
            model.scenes = {
                "sc_g": {
                    "id": "sc_g", "name": "sc_g",
                    "worldWidth": 1000, "worldHeight": 1000,
                    "spawnPoint": {"x": 500, "y": 900},
                    "npcs": [], "zones": [],
                    "hotspots": [{
                        "id": "h1", "type": "inspect", "label": "",
                        "x": 100, "y": 200, "interactionRange": 50,
                        "perspectiveScaleEnabled": True,
                        "collisionPolygon": local_poly,
                        "collisionPolygonLocal": True,
                        "data": {"text": "t"},
                    }],
                    "perspectiveScale": {
                        "rulers": [{"y": 200, "scale": 0.5}, {"y": 800, "scale": 1.0}],
                    },
                },
            }
            ed = SceneEditor(model)
            try:
                ed._refresh_scene_list()
                ed._load_scene("sc_g")
                QApplication.processEvents()

                editable = ed._canvas._entity_items.get("hotspot_collision:h1")
                self.assertIsInstance(editable, _EditableZonePolygon)
                got_pts = editable.points_to_model()
                # authored 空间：世界点 = 锚点 + 局部点（不乘透视系数）
                for gp, lp in zip(got_pts, local_poly):
                    self.assertAlmostEqual(gp["x"], 100 + lp["x"], places=3)
                    self.assertAlmostEqual(gp["y"], 200 + lp["y"], places=3)

                ghost = ed._canvas._entity_items.get("hotspot_collision_ghost:h1")
                self.assertIsInstance(ghost, QGraphicsPolygonItem, "参与透视应有命中面幽灵轮廓")
                gpoly = ghost.polygon()
                # f(200)=0.5：幽灵 = 锚点 + 局部点 × 0.5
                for i, lp in enumerate(local_poly):
                    self.assertAlmostEqual(gpoly[i].x(), 100 + lp["x"] * 0.5, places=3)
                    self.assertAlmostEqual(gpoly[i].y(), 200 + lp["y"] * 0.5, places=3)

                # 关闭场景透视（面板启用勾选）→ 幽灵消失、可编辑多边形仍在
                ed._props._sc_persp_enable.setChecked(False)
                QApplication.processEvents()
                self.assertIsNone(
                    ed._canvas._entity_items.get("hotspot_collision_ghost:h1"),
                    "关闭透视后幽灵应移除")
                self.assertIsInstance(
                    ed._canvas._entity_items.get("hotspot_collision:h1"),
                    _EditableZonePolygon)
            finally:
                try:
                    ed._scene_npc_anim_timer.stop()
                    ed._patrol_overlay_refresh_timer.stop()
                except Exception:
                    pass
                ed.deleteLater()
                QApplication.processEvents()

    def test_ruler_real_mouse_drag_commits_and_undoes(self) -> None:
        from pathlib import Path
        from tempfile import TemporaryDirectory

        from PySide6.QtCore import QPoint, QPointF, Qt
        from PySide6.QtTest import QTest
        from PySide6.QtWidgets import QApplication

        from tools.editor.editors.scene_editor import SceneEditor
        from tools.editor.project_model import ProjectModel
        from tools.editor.tests.save_test_utils import write_minimal_loadable_project

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            model.scenes = {
                "sc_p": {
                    "id": "sc_p", "name": "sc_p",
                    "worldWidth": 1000, "worldHeight": 1000,
                    "hotspots": [], "npcs": [], "zones": [],
                    "spawnPoint": {"x": 500, "y": 900},
                    "perspectiveScale": {
                        "rulers": [{"y": 200, "scale": 0.5}, {"y": 800, "scale": 1.0}],
                    },
                },
            }
            ed = SceneEditor(model)
            try:
                ed._refresh_scene_list()
                ed._load_scene("sc_p")
                ed.resize(1200, 800)
                ed.show()
                QApplication.processEvents()
                ed._canvas.fit_all()
                QApplication.processEvents()

                lines = ed._canvas._persp_ruler_items
                self.assertEqual(len(lines), 2, "两条基准线应上画布")
                model._dirty.clear()
                model._dirty_scene_ids.clear()
                model._dirty_scenes_all = False
                ed._undo.clear()

                vp = ed._canvas.viewport()
                start_vp = ed._canvas.mapFromScene(QPointF(500.0, 200.0))
                end_vp = QPoint(start_vp.x(), start_vp.y() + 40)
                QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=start_vp)
                mid_vp = QPoint(start_vp.x(), (start_vp.y() + end_vp.y()) // 2)
                QTest.mouseMove(vp, pos=mid_vp)
                QTest.mouseMove(vp, pos=end_vp)
                QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=end_vp)
                QApplication.processEvents()

                got = model.scenes["sc_p"]["perspectiveScale"]["rulers"][0]["y"]
                self.assertGreater(float(got), 200.0,
                                   f"真实拖动基准线后 y 应增大，实得 {got!r}")
                self.assertTrue(ed._undo.stack.canUndo(), "拖线应形成一条撤销命令")
                ed.editor_undo()
                got_undo = model.scenes["sc_p"]["perspectiveScale"]["rulers"][0]["y"]
                self.assertEqual(float(got_undo), 200.0, f"撤销应回 200，实得 {got_undo!r}")
            finally:
                try:
                    ed._scene_npc_anim_timer.stop()
                    ed._patrol_overlay_refresh_timer.stop()
                except Exception:
                    pass
                ed.deleteLater()
                QApplication.processEvents()


if __name__ == "__main__":
    unittest.main()
