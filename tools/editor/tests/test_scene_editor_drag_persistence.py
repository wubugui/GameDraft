"""场景编辑器画布编辑「数据零丢失」安全网。

回归点（审查确认的高危丢数据簇）：
- 画布拖拽实体/出生点/多边形不调用 mark_dirty → 关闭/切项目只看 is_dirty，静默丢弃。
- 切场景 / 切实体不提交未应用的 staging → 上一处拖拽被无声丢弃、实体弹回旧位。

这些测试在修复前应为红：它们断言的是「任意画布编辑都不会因为切换/关闭而丢失」。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QRectF
from PySide6.QtGui import QColor, QFontMetricsF
from PySide6.QtWidgets import QApplication

from tools.editor import theme
from tools.editor.editors.scene_editor import (
    SceneEditor,
    _EditableZonePolygon,
    _LightCurvePolyline,
    _NpcPatrolPolyline,
)
from tools.editor.shared.fonts import MONO_FONT_FAMILY
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


def _scene(sid: str) -> dict:
    return {
        "id": sid,
        "name": sid,
        "hotspots": [
            {"id": "h1", "type": "inspect", "label": "", "x": 50, "y": 50,
             "interactionRange": 50, "data": {"text": ""}},
        ],
        "npcs": [
            {"id": "npc1", "name": "甲", "x": 100, "y": 100, "interactionRange": 50},
            {"id": "npc2", "name": "乙", "x": 200, "y": 200, "interactionRange": 50},
        ],
        "zones": [
            {"id": "z1", "polygon": [{"x": 10, "y": 10}, {"x": 60, "y": 10},
                                      {"x": 60, "y": 60}, {"x": 10, "y": 60}]},
        ],
        "spawnPoints": {"door": {"x": 5, "y": 5}},
    }


class SceneEditorDragPersistenceTests(unittest.TestCase):
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
        model.scenes = {"sc_a": _scene("sc_a"), "sc_b": _scene("sc_b")}
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._editors.append(ed)
        # 干净起点：load 期的迁移可能标脏，这里清掉，专测「编辑导致脏」。
        model._dirty.clear()
        model._dirty_scene_ids.clear()
        model._dirty_scenes_all = False
        return ed, model

    def _npc(self, model, sid, nid):
        for n in model.scenes[sid]["npcs"]:
            if n.get("id") == nid:
                return n
        raise AssertionError(f"npc {nid} not found in {sid}")

    # ---- 拖拽必须标脏（否则关闭/切项目静默丢弃） ----------------------------
    def test_npc_drag_marks_model_dirty(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            ed._on_item_moved("npc", "npc1", 333.0, 444.0)
            self.assertTrue(
                model.is_dirty,
                "拖拽 NPC 后模型必须为 dirty，否则关闭/切项目时无保存提示，编辑被静默丢弃",
            )

    def test_hotspot_drag_marks_model_dirty(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("hotspot", "h1")
            ed._on_item_moved("hotspot", "h1", 321.0, 123.0)
            self.assertTrue(model.is_dirty)

    def test_spawn_drag_marks_model_dirty(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_moved("spawn", "door", 77.0, 88.0)
            self.assertTrue(model.is_dirty)

    # ---- 切场景不丢拖拽（commit-on-leave） --------------------------------
    def test_npc_drag_survives_scene_switch(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            ed._on_item_moved("npc", "npc1", 333.0, 444.0)
            ed._load_scene("sc_b")   # 切走，不点 Apply
            n = self._npc(model, "sc_a", "npc1")
            self.assertEqual((n["x"], n["y"]), (333.0, 444.0),
                             "切场景必须提交未应用的拖拽，不能弹回旧位")

    def test_hotspot_drag_survives_scene_switch(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("hotspot", "h1")
            ed._on_item_moved("hotspot", "h1", 321.0, 123.0)
            ed._load_scene("sc_b")
            hs = next(h for h in model.scenes["sc_a"]["hotspots"] if h["id"] == "h1")
            self.assertEqual((hs["x"], hs["y"]), (321.0, 123.0))

    def test_spawn_drag_survives_scene_switch(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_moved("spawn", "door", 77.0, 88.0)
            ed._load_scene("sc_b")
            self.assertEqual(model.scenes["sc_a"]["spawnPoints"]["door"], {"x": 77.0, "y": 88.0})

    # ---- 切实体不丢拖拽 --------------------------------------------------
    def test_npc_drag_survives_entity_switch(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            ed._on_item_moved("npc", "npc1", 333.0, 444.0)
            ed._on_item_selected("npc", "npc2")   # 切到另一个实体，不点 Apply
            n = self._npc(model, "sc_a", "npc1")
            self.assertEqual((n["x"], n["y"]), (333.0, 444.0),
                             "切实体必须提交上一个实体的拖拽，不能丢弃")

    # ---- 关闭门控：拖后必须能被 is_dirty 感知 ----------------------------
    def test_close_gate_sees_dirty_after_drag(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            ed._on_item_moved("npc", "npc1", 333.0, 444.0)
            # 主窗口关闭/切项目门控读 model.is_dirty 决定是否弹保存提示
            self.assertTrue(model.is_dirty)

    # ---- 面板改名（裸 QLineEdit，HIGH-8）：标 pending + confirm_close 落库 --
    def test_panel_rename_sets_pending_dirty(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            ed._props._npc_name.setText("改名后")
            self.assertTrue(ed._props.is_pending_dirty(),
                            "面板改名必须点亮未应用提示（否则切换/关闭静默丢失）")

    def test_add_entity_then_switch_commits_new_entity(self) -> None:
        # 新增实体后改名再切走：commit-on-leave 必须把新实体落进模型，不丢、不损坏既有实体。
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            before_ids = [n["id"] for n in model.scenes["sc_a"]["npcs"]]
            ed._add_npc_at(300.0, 300.0)  # 追加新 NPC 并选中
            sc = model.scenes["sc_a"]
            self.assertEqual(len(sc["npcs"]), len(before_ids) + 1)
            new = sc["npcs"][-1]
            ed._on_item_selected("npc", new["id"])
            ed._props._npc_name.setText("新来的")
            ed._load_scene("sc_b")  # 切走，不点 Apply
            ed._load_scene("sc_a")
            names = {n["id"]: n.get("name") for n in model.scenes["sc_a"]["npcs"]}
            self.assertEqual(names.get(new["id"]), "新来的", "新增实体的改名切走后不得丢失")
            # 既有实体未被损坏
            self.assertEqual(self._npc(model, "sc_a", "npc1")["x"], 100)

    def test_confirm_close_commits_pending_panel_edit(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            ed._props._npc_name.setText("改名后")
            # 关闭/切项目门控会调 confirm_close：未应用编辑须提交进模型并标脏
            ok = ed.confirm_close(None)
            self.assertTrue(ok)
            self.assertTrue(model.is_dirty)
            self.assertEqual(self._npc(model, "sc_a", "npc1")["name"], "改名后")

    # ---- 纯点选/零位移不写坐标、不标脏、不 int→float 漂移（审查 P1-09） ------
    def test_item_moved_unchanged_value_is_noop(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            model._dirty.clear(); model._dirty_scene_ids.clear()
            model._dirty_scenes_all = False
            # npc1 原坐标是 int 100/100；以相同值回调（模拟画布点选/微抖归位）
            ed._on_item_moved("npc", "npc1", 100.0, 100.0)
            n = self._npc(model, "sc_a", "npc1")
            self.assertFalse(
                model.is_dirty, "零位移不得标脏（点一下看属性不应触发保存提示）")
            self.assertIsInstance(n["x"], int, "零位移不得把 int 坐标漂成 float")
            self.assertIsInstance(n["y"], int)

    def test_item_moved_real_move_preserves_unchanged_axis_int(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("npc", "npc1")
            # 只动 x 到非整值；y 未变应保持 int 100（不无脑 float 化）
            ed._on_item_moved("npc", "npc1", 150.5, 100.0)
            self.assertTrue(model.is_dirty)
            ed._commit_pending_scene_edits()  # staging → 模型
            n = self._npc(model, "sc_a", "npc1")
            self.assertEqual(n["x"], 150.5)
            self.assertIsInstance(n["y"], int, "未改动的 y 轴应保留原始 int 表示")

    def test_scaled_overlay_text_stays_inside_graphics_bounds(self) -> None:
        original_theme = theme.current_theme_id()
        original_font = theme.current_font_px()
        try:
            theme.apply_application_theme(self._qt_app, theme.THEME_MODERN, theme.MAX_FONT_PX)
            secondary_metrics = QFontMetricsF(theme.make_editor_font(
                theme.FONT_ROLE_CANVAS_SECONDARY,
                family=MONO_FONT_FAMILY,
            ))

            zone = _EditableZonePolygon(
                object(),  # type: ignore[arg-type]
                [(0, 0), (60, 0), (60, 60), (0, 60)],
                QColor(60, 120, 180),
                "long_zone_identifier",
            )
            zone_label = QRectF(
                3,
                12 - secondary_metrics.ascent(),
                secondary_metrics.horizontalAdvance(zone.entity_id),
                secondary_metrics.height(),
            )
            self.assertTrue(zone.boundingRect().contains(zone_label))

            patrol_points = [(float(i * 10), 0.0) for i in range(11)]
            patrol = _NpcPatrolPolyline(object(), "npc", patrol_points)  # type: ignore[arg-type]
            hrad = patrol.HANDLE_WORLD_R * 0.38
            patrol_label = QRectF(
                100 + hrad + 2,
                4 - secondary_metrics.ascent(),
                secondary_metrics.horizontalAdvance("10"),
                secondary_metrics.height(),
            )
            self.assertTrue(patrol.boundingRect().contains(patrol_label))

            light = _LightCurvePolyline(object(), [{"x": 0, "y": 0, "env": {}}])  # type: ignore[arg-type]
            micro_metrics = QFontMetricsF(theme.make_editor_font(
                theme.FONT_ROLE_CANVAS_MICRO,
                family=MONO_FONT_FAMILY,
            ))
            self.assertGreaterEqual(
                light.boundingRect().right(),
                micro_metrics.horizontalAdvance("az360 el90 I9.99 dk1.00"),
            )
        finally:
            theme.apply_application_theme(self._qt_app, original_theme, original_font)


if __name__ == "__main__":
    unittest.main()
