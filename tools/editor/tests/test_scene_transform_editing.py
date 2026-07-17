"""场景实例 transform（P3）编辑器流程探针。

护栏语义：
- scale/rotation 面板编辑 → Apply 落 dict；缺省值（1/0）不写键（哈希基线/字节往返）；
- gizmo 手势 = 一条撤销命令（按下捕获 before、release 提交），真实 QMouseEvent 验证；
- 碰撞多边形在变换态下往返（local→world→local）保持不变（编辑器逆变换与运行时正变换互逆）；
- 画布几何（世界点）与运行时 anchorCollisionPolygonToWorld 同口径。
"""
from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPoint, Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import (
    SceneEditor,
    _hotspot_collision_local_to_world,
    _hotspot_collision_world_to_local,
)
from tools.editor.project_model import ProjectModel
from tools.editor.shared.entity_transform_math import transform_local_vec
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


def _scene(sid: str) -> dict:
    return {
        "id": sid,
        "name": sid,
        "hotspots": [
            {"id": "h1", "type": "inspect", "label": "", "x": 50, "y": 50,
             "interactionRange": 50, "data": {"text": ""},
             "collisionPolygon": [{"x": -20.0, "y": -15.0}, {"x": 20.0, "y": -15.0},
                                   {"x": 0.0, "y": 10.0}],
             "collisionPolygonLocal": True},
        ],
        "npcs": [
            {"id": "npc1", "name": "甲", "x": 100, "y": 100, "interactionRange": 50},
        ],
        "zones": [],
        "spawnPoints": {},
    }


class SceneTransformEditingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

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
        self._editors.clear()
        QApplication.processEvents()

    def _editor(self, root: Path) -> tuple[SceneEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.scenes = {"sc_a": _scene("sc_a")}
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._editors.append(ed)
        model._dirty.clear()
        model._dirty_scene_ids.clear()
        model._dirty_scenes_all = False
        ed._undo.clear()
        return ed, model

    def _npc(self, model, nid):
        for n in model.scenes["sc_a"]["npcs"]:
            if n.get("id") == nid:
                return n
        raise AssertionError(nid)

    # ---- 数学互逆与口径 -----------------------------------------------------

    def test_transform_math_rotation(self) -> None:
        x, y = transform_local_vec(10.0, 0.0, 2.0, 90.0)
        self.assertAlmostEqual(x, 0.0, places=6)
        self.assertAlmostEqual(y, 20.0, places=6)

    def test_collision_roundtrip_under_transform(self) -> None:
        hs = {"x": 50, "y": 50, "scale": 2.0, "rotation": 37.0}
        local = [{"x": -20.0, "y": -15.0}, {"x": 20.0, "y": -15.0}, {"x": 0.0, "y": 10.0}]
        world = _hotspot_collision_local_to_world(hs, local)
        back = _hotspot_collision_world_to_local(hs, world)
        for p0, p1 in zip(local, back):
            self.assertAlmostEqual(p0["x"], p1["x"], delta=0.15)
            self.assertAlmostEqual(p0["y"], p1["y"], delta=0.15)

    # ---- 面板编辑 → Apply 落 dict（缺省不写键） ------------------------------

    def test_panel_transform_apply_and_default_omitted(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            ed._props._npc_scale.setValue(1.5)
            ed._props._npc_rot.setValue(30.0)
            ed._apply_props()
            n = self._npc(model, "npc1")
            self.assertEqual(n.get("scale"), 1.5)
            self.assertEqual(n.get("rotation"), 30.0)

            ed._props._npc_scale.setValue(1.0)
            ed._props._npc_rot.setValue(0.0)
            ed._apply_props()
            n = self._npc(model, "npc1")
            self.assertNotIn("scale", n, "缺省 scale=1 不得写键")
            self.assertNotIn("rotation", n, "缺省 rotation=0 不得写键")

    def test_panel_transform_apply_undoable(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            ed._props._npc_scale.setValue(2.0)
            ed._apply_props()
            self.assertEqual(self._npc(model, "npc1").get("scale"), 2.0)
            ed.editor_undo()
            self.assertNotIn("scale", self._npc(model, "npc1"),
                             "撤销 Apply 应回到无 scale 键状态")

    # ---- gizmo：程序路径 + 真实鼠标事件路径 ---------------------------------

    def test_gizmo_commit_writes_and_undoes_as_one_command(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            ed._try_select_canvas_item("npc", "npc1")
            ed._on_canvas_drag_press()  # 手势起点捕获 before
            ed._on_gizmo_transform_committed("npc", "npc1", 2.5, 45.0)
            n = self._npc(model, "npc1")
            self.assertEqual((n.get("scale"), n.get("rotation")), (2.5, 45.0))
            self.assertEqual(ed._undo.stack.count(), 1, "一次 gizmo 手势=一条命令")

            ed.editor_undo()
            n = self._npc(model, "npc1")
            self.assertNotIn("scale", n)
            self.assertNotIn("rotation", n)

    def test_gizmo_real_mouse_rotate_drag(self) -> None:
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed.resize(1200, 800)
            ed.show()
            QApplication.processEvents()
            ed._canvas.fit_all()
            QApplication.processEvents()

            item = ed._canvas._entity_items.get("npc:npc1")
            item.setSelected(True)
            QApplication.processEvents()
            gz = ed._canvas._transform_gizmo
            self.assertIsNotNone(gz, "单选 NPC 应显示 transform gizmo")
            self.assertTrue(gz.isVisible())

            # 旋转手柄（环顶）：按住沿环拖到右侧 ≈ +90°
            hp_local = gz._handle_pos("rotate")
            start_scene = gz.mapToScene(hp_local)
            start_vp = ed._canvas.mapFromScene(start_scene)
            # 目标：绕锚点转 90°（环顶 → 环右）
            end_scene = gz.mapToScene(gz._handle_pos("scale"))
            end_vp = ed._canvas.mapFromScene(end_scene)
            vp = ed._canvas.viewport()
            QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=start_vp)
            mid_vp = QPoint((start_vp.x() + end_vp.x()) // 2, (start_vp.y() + end_vp.y()) // 2)
            QTest.mouseMove(vp, pos=mid_vp)
            QTest.mouseMove(vp, pos=end_vp)
            QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=end_vp)
            QApplication.processEvents()

            n = self._npc(model, "npc1")
            rot = float(n.get("rotation", 0) or 0)
            self.assertTrue(60.0 <= rot <= 120.0,
                            f"真实拖动旋转手柄后 rotation 应≈90°，实得 {rot}")
            self.assertTrue(ed._undo.stack.canUndo())
            ed.editor_undo()
            self.assertNotIn("rotation", self._npc(model, "npc1"))


class SceneTransformGestureGuardTests(unittest.TestCase):
    """P5 审查修复的交互护栏：Esc 取消 gizmo（P1-C）/ 零变化不伪脏（P2-A）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

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
        self._editors.clear()
        QApplication.processEvents()

    def _editor(self, root: Path) -> tuple[SceneEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.scenes = {"sc_a": _scene("sc_a")}
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._editors.append(ed)
        model._dirty.clear()
        model._dirty_scene_ids.clear()
        model._dirty_scenes_all = False
        ed._undo.clear()
        return ed, model

    def test_gizmo_zero_change_click_no_dirty_no_command(self) -> None:
        """真实事件：按住手柄原地松开（零变化）→ 源头不发提交、不标脏、无命令。"""
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed.resize(1200, 800)
            ed.show()
            QApplication.processEvents()
            ed._canvas.fit_all()
            QApplication.processEvents()
            item = ed._canvas._entity_items.get("npc:npc1")
            item.setSelected(True)
            QApplication.processEvents()
            gz = ed._canvas._transform_gizmo
            self.assertIsNotNone(gz)
            hp_vp = ed._canvas.mapFromScene(gz.mapToScene(gz._handle_pos("rotate")))
            vp = ed._canvas.viewport()
            QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=hp_vp)
            QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=hp_vp)
            QApplication.processEvents()
            self.assertFalse(model.is_dirty, "零变化 gizmo 点击不得标脏（伪脏红线）")
            self.assertFalse(ed._undo.stack.canUndo(), "零变化不得产生命令")
            n = self._npc(model, "npc1")
            self.assertNotIn("rotation", n)
            self.assertNotIn("scale", n)

    def test_gizmo_esc_cancels_gesture_and_reverts_staging(self) -> None:
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed.resize(1200, 800)
            ed.show()
            QApplication.processEvents()
            ed._canvas.fit_all()
            QApplication.processEvents()
            item = ed._canvas._entity_items.get("npc:npc1")
            item.setSelected(True)
            QApplication.processEvents()
            gz = ed._canvas._transform_gizmo
            self.assertIsNotNone(gz)

            hp = gz.mapToScene(gz._handle_pos("rotate"))
            start_vp = ed._canvas.mapFromScene(hp)
            end_vp = ed._canvas.mapFromScene(gz.mapToScene(gz._handle_pos("scale")))
            vp = ed._canvas.viewport()
            QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=start_vp)
            QTest.mouseMove(vp, pos=end_vp)
            QApplication.processEvents()
            self.assertTrue(gz.gesture_active(), "拖动中手势应激活")
            # Esc 取消：手势复位、staging 回滚、release 被吞不提交
            QTest.keyPress(vp, Qt.Key.Key_Escape)
            QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=end_vp)
            QApplication.processEvents()

            self.assertFalse(gz.gesture_active())
            n = self._npc(model, "npc1")
            self.assertNotIn("rotation", n, "Esc 后旋转不得落模型")
            st = ed._props._staging_npc
            self.assertTrue(st is None or "rotation" not in st,
                            "Esc 后旋转不得残留 staging")
            self.assertFalse(model.is_dirty, "Esc 取消不得标脏")
            self.assertFalse(ed._undo.stack.canUndo(), "Esc 取消不得产生命令")

    def _npc(self, model, nid):
        for n in model.scenes["sc_a"]["npcs"]:
            if n.get("id") == nid:
                return n
        raise AssertionError(nid)


if __name__ == "__main__":
    unittest.main()
