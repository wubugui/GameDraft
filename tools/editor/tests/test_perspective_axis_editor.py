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



class PerspCameraFollowEditorTests(unittest.TestCase):
    """相机跟随透视（需求清单 A3.5）的作者面流程探针。

    最要紧的一条：**没开这个开关时输出与开此功能之前逐字节一致**——
    制作人 2026-09-20 的硬要求。其余覆盖逐段开关的往返、画布分段呈现与取景框游标。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def _panel(self, root: Path, cfg: dict) -> tuple[ScenePropertyPanel, dict]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        sc = {"id": "sc_cf", "name": "sc_cf", "worldWidth": 2048, "worldHeight": 1152,
              "camera": {"zoom": 0.68, "pixelsPerUnit": 1.0},
              "spawnPoint": {"x": 1000, "y": 1000}, "hotspots": [], "npcs": [], "zones": [],
              "perspectiveScale": copy.deepcopy(cfg)}
        model.scenes["sc_cf"] = sc
        panel = ScenePropertyPanel(model)
        panel.load_scene_props(sc)
        return panel, sc

    def test_no_follow_key_stays_byte_identical(self) -> None:
        """不开相机跟随：加载 → 零编辑 flush → 输出与磁盘 dict 完全相等，不冒出 cameraFollow。"""
        cfg = {
            "near": {"x": 100, "y": 900, "scale": 1.69},
            "far": {"x": 900, "y": 100, "scale": 0.25},
            "midStops": [{"pos": 0.9, "scale": 0.4}],
        }
        with TemporaryDirectory() as td:
            panel, sc = self._panel(Path(td) / "p", cfg)
            orig = copy.deepcopy(sc["perspectiveScale"])
            self.assertFalse(panel._sc_persp_cam.isChecked())
            # 面板本身没 show()，isVisible 恒 False；判的是「有没有被显式藏起来」
            self.assertTrue(panel._sc_persp_cam_box.isHidden(), "没勾时子块该收起")
            st = panel._staging_scene
            panel._flush_scene_widgets_into(st)
            self.assertEqual(st["perspectiveScale"], orig)
            self.assertNotIn("cameraFollow", st["perspectiveScale"])
            for m in st["perspectiveScale"]["midStops"]:
                self.assertNotIn("cameraFollow", m)

    def test_toggle_on_writes_defaults_off_deletes_key(self) -> None:
        cfg = {"near": {"x": 0, "y": 900, "scale": 2.0},
               "far": {"x": 0, "y": 100, "scale": 0.5},
               "midStops": [{"pos": 0.5, "scale": 1.0}]}
        with TemporaryDirectory() as td:
            panel, _sc = self._panel(Path(td) / "p", cfg)
            st = panel._staging_scene
            panel._sc_persp_cam.setChecked(True)
            panel._flush_scene_widgets_into(st)
            # 缺省值一个都不落键（缺省 = firstSegment true / refPos 0 / 上限 1.5）
            self.assertEqual(st["perspectiveScale"]["cameraFollow"], {})
            self.assertFalse(panel._sc_persp_cam_box.isHidden(), "勾上后子块该露出来")
            # 改成非缺省 → 落键
            panel._sc_persp_cam_first.setChecked(False)
            panel._sc_persp_cam_ref.setValue(0.25)
            panel._sc_persp_cam_max.setValue(2.5)
            panel._flush_scene_widgets_into(st)
            self.assertEqual(
                st["perspectiveScale"]["cameraFollow"],
                {"firstSegment": False, "refPos": 0.25, "maxZoomRatio": 2.5})
            # 关掉 → 删键（运行时据此整条不跑）
            panel._sc_persp_cam.setChecked(False)
            panel._flush_scene_widgets_into(st)
            self.assertNotIn("cameraFollow", st["perspectiveScale"])

    def test_segment_checkbox_writes_per_stop_flag(self) -> None:
        cfg = {"near": {"x": 0, "y": 900, "scale": 2.0},
               "far": {"x": 0, "y": 100, "scale": 0.5},
               "midStops": [{"pos": 0.5, "scale": 1.0}]}
        with TemporaryDirectory() as td:
            panel, _sc = self._panel(Path(td) / "p", cfg)
            st = panel._staging_scene
            panel._sc_persp_cam.setChecked(True)
            row_chk = panel._sc_persp_table.item(0, 2)
            self.assertIsNotNone(row_chk, "开了跟随后中途点行应有「本段跟随」勾")
            self.assertEqual(row_chk.checkState(), Qt.CheckState.Checked)
            row_chk.setCheckState(Qt.CheckState.Unchecked)
            QApplication.processEvents()
            panel._flush_scene_widgets_into(st)
            self.assertIs(st["perspectiveScale"]["midStops"][0]["cameraFollow"], False)
            # 勾回来 → 键删掉（缺省 true 不写）
            panel._sc_persp_table.item(0, 2).setCheckState(Qt.CheckState.Checked)
            QApplication.processEvents()
            panel._flush_scene_widgets_into(st)
            self.assertNotIn("cameraFollow", st["perspectiveScale"]["midStops"][0])

    def test_cumulative_ratio_column_and_warning(self) -> None:
        """累计 × 列与汇总行是作者判断「背景会糊到什么程度」的唯一读数。"""
        cfg = {"near": {"x": 0, "y": 900, "scale": 2.0},
               "far": {"x": 0, "y": 100, "scale": 0.5},
               "midStops": [{"pos": 0.5, "scale": 1.0}]}
        with TemporaryDirectory() as td:
            panel, _sc = self._panel(Path(td) / "p", cfg)
            panel._sc_persp_cam.setChecked(True)
            QApplication.processEvents()
            # midStops[0] 起那一段走完 = 4.00（整轴 f近/f远 = 2.0/0.5）
            self.assertEqual(panel._sc_persp_table.item(0, 3).text(), "4.00")
            info = panel._sc_persp_cam_info.text()
            self.assertIn("4.00", info)
            self.assertIn("撞上限", info, f"缺省上限 1.5 下该报超限，实得：{info}")
            # 上限调到 5 → 不再报超限
            panel._sc_persp_cam_max.setValue(5.0)
            QApplication.processEvents()
            self.assertNotIn("撞上限", panel._sc_persp_cam_info.text())

    def test_loading_a_scene_keeps_the_axis_on_canvas(self) -> None:
        """装场景时往 camera.zoom/ppu/worldScale 灌值**不得**把刚建好的深度轴擦掉。

        2026-09-20 实测踩到：取景框预览要跟着 camera.zoom 走，于是把那三个 spinbox 也接到了
        透视预览上；load_scene_props 灌值时透视面板还没填好，预览算出 None，
        画布当场把轴删了——静默，且只在有背景图的真实场景里看得见。
        """
        with TemporaryDirectory() as td:
            scene = {
                "id": "sc_keep", "name": "sc_keep",
                "worldWidth": 1000, "worldHeight": 1000,
                "camera": {"zoom": 1.4, "pixelsPerUnit": 1.0},
                "worldScale": 1.0,
                "spawnPoint": {"x": 500, "y": 900}, "hotspots": [], "npcs": [], "zones": [],
                "perspectiveScale": {
                    "near": {"x": 500, "y": 900, "scale": 1.0},
                    "far": {"x": 500, "y": 200, "scale": 0.5},
                },
            }
            write_minimal_loadable_project(Path(td) / "p")
            model = ProjectModel()
            model.load_project(Path(td) / "p")
            model.scenes = {scene["id"]: scene}
            ed = SceneEditor(model)
            ed._refresh_scene_list()
            ed._load_scene(scene["id"])
            try:
                QApplication.processEvents()
                self.assertIsNotNone(ed._canvas._persp_axis_item,
                                     "装完场景画布上必须还有深度轴")
                self.assertIsNotNone(ed._canvas._persp_cfg)
                # 换一个场景再换回来，同样不能丢
                ed._load_scene(scene["id"])
                QApplication.processEvents()
                self.assertIsNotNone(ed._canvas._persp_axis_item, "重进场景后深度轴仍须在")
                # 作者真的去改 camera.zoom 时，轴要还在、取景框上下文要跟着更新
                ed._props._sc_zoom.setValue(2.2)
                QApplication.processEvents()
                self.assertIsNotNone(ed._canvas._persp_axis_item, "改 camera.zoom 后深度轴仍须在")
                self.assertAlmostEqual(
                    float(ed._canvas._persp_cam_ctx["zoom"]), 2.2, places=3)
            finally:
                try:
                    ed._scene_npc_anim_timer.stop()
                    ed._patrol_overlay_refresh_timer.stop()
                except Exception:
                    pass
                ed.deleteLater()
                QApplication.processEvents()

    def test_canvas_shows_segments_and_probe_drag_is_readonly(self) -> None:
        with TemporaryDirectory() as td:
            scene = {
                "id": "sc_cfx", "name": "sc_cfx",
                "worldWidth": 1000, "worldHeight": 1000,
                "camera": {"zoom": 1.0, "pixelsPerUnit": 1.0},
                "spawnPoint": {"x": 500, "y": 900}, "hotspots": [], "npcs": [], "zones": [],
                "perspectiveScale": {
                    "near": {"x": 500, "y": 900, "scale": 1.0},
                    "far": {"x": 500, "y": 200, "scale": 0.5},
                    "midStops": [{"pos": 0.5, "scale": 0.8, "cameraFollow": False}],
                    "cameraFollow": {"maxZoomRatio": 3.0},
                },
            }
            write_minimal_loadable_project(Path(td) / "p")
            model = ProjectModel()
            model.load_project(Path(td) / "p")
            model.scenes = {scene["id"]: scene}
            ed = SceneEditor(model)
            ed._refresh_scene_list()
            ed._load_scene(scene["id"])
            try:
                ed.resize(1200, 800)
                ed.show()
                QApplication.processEvents()
                ed._canvas.fit_all()
                QApplication.processEvents()
                axis = ed._canvas._persp_axis_item
                self.assertIsNotNone(axis)
                self.assertIsNotNone(axis.follow_info, "开了 cameraFollow 画布应按段呈现")
                segs = axis.follow_info["segments"]
                self.assertEqual([s["follow"] for s in segs], [True, False])
                # 取景框要用的相机参数已喂到画布（否则只画得出轴、画不出框）
                self.assertIsInstance(ed._canvas._persp_cam_ctx, dict)
                self.assertIsNotNone(axis._probe_view_rect(), "应能算出取景框矩形")
                # paint() 里 Qt 调用签名写错不会让测试变红（PySide 把画期异常打到 stderr 就吞了），
                # 所以**直接调一次**：分段染色 / 累计倍数 / 取景框 / 游标全走一遍，有错就抛。
                from PySide6.QtGui import QImage, QPainter
                img = QImage(64, 64, QImage.Format.Format_ARGB32)
                pnt = QPainter(img)
                try:
                    axis.paint(pnt, None, None)
                finally:
                    pnt.end()

                model._dirty.clear()
                model._dirty_scene_ids.clear()
                model._dirty_scenes_all = False
                ed._undo.clear()
                before = copy.deepcopy(model.scenes["sc_cfx"]["perspectiveScale"])
                vp = ed._canvas.viewport()
                probe_scene = axis._point_at(axis.probe_pos)
                start_vp = ed._canvas.mapFromScene(probe_scene)
                end_vp = QPoint(start_vp.x(), start_vp.y() - 60)
                from PySide6.QtTest import QTest
                QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=start_vp)
                QTest.mouseMove(vp, pos=end_vp)
                QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=end_vp)
                QApplication.processEvents()
                # 游标是纯观察工具：位置变了，但数据一个字节没动、没有撤销项
                self.assertNotAlmostEqual(axis.probe_pos, 0.5, places=3,
                                          msg="拖游标应改变取景位置")
                self.assertEqual(model.scenes["sc_cfx"]["perspectiveScale"], before)
                self.assertFalse(ed._undo.stack.canUndo(), "拖取景框游标不该进撤销栈")
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
