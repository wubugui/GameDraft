"""变换手柄与整组位移的验收。

整组位移这一族继承老画布的血债，逐条锁住：
- 位移对象是**模型层名册**，被过滤藏起来的成员同样要动（漏掉 = 半份移动的坏数据，
  而画布照新位置画、肉眼看不出来）；
- 局部坐标碰撞面**不许再平移一次**（那是"碰撞面漂两倍"）；
- 整数坐标必须保持整数表示（否则微移一次满屏 `.0`，黄金往返红）；
- 连续微移由**命令合并**收成一条撤销记录（老画布糊了个 400ms 定时器）。
"""
from __future__ import annotations

import math
import sys
import unittest

from PySide6.QtCore import QPointF, Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.editors.scene_v2.document import SceneDocument
from tools.editor.editors.scene_v2.renderer import SceneRenderer
from tools.editor.editors.scene_v2.tools_transform import (
    SCALE_MAX,
    SCALE_MIN,
    GroupMoveTool,
    TransformTool,
    group_member_refs,
    translate_group,
)

_LEFT = Qt.MouseButton.LeftButton
_NO_MOD = Qt.KeyboardModifier.NoModifier
_SHIFT = Qt.KeyboardModifier.ShiftModifier


class _FakeModel:
    def __init__(self, scene: dict) -> None:
        self.scenes = {"街": scene}
        self.dirty: list[tuple[str, str]] = []

    def mark_dirty(self, domain: str, key: str) -> None:
        self.dirty.append((domain, key))


def _scene() -> dict:
    return {
        "id": "街", "name": "街", "worldWidth": 800, "worldHeight": 600,
        "hotspots": [
            {"id": "h1", "type": "inspect", "x": 100, "y": 100, "group": "夜巡",
             "collisionPolygonLocal": True,
             "collisionPolygon": [{"x": -10, "y": -10}, {"x": 10, "y": -10},
                                  {"x": 10, "y": 10}]},
            # 被视图过滤藏起来的成员：整组位移**同样要动**
            {"id": "h_hidden", "type": "inspect", "x": 200, "y": 100,
             "group": "夜巡", "planes": ["yin"]},
            {"id": "h_free", "type": "inspect", "x": 500, "y": 500},
            # 真实场景里大量坐标是**多位小数**的 float（`城门口.json` 等）：
            # 纯水平位移不得把它的 y 截断成一位小数
            {"id": "h_float", "type": "inspect", "x": 1308.14, "y": 218.02,
             "group": "夜巡"},
        ],
        "npcs": [
            {"id": "n1", "name": "甲", "x": 300, "y": 300, "group": "夜巡",
             "patrol": {"route": [{"x": 300, "y": 300}, {"x": 400, "y": 300}]}},
        ],
        "zones": [
            {"id": "z1", "group": "夜巡",
             "polygon": [{"x": 600, "y": 100}, {"x": 700, "y": 100},
                         {"x": 700, "y": 200}]},
        ],
    }


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self.model = _FakeModel(_scene())
        self.doc = SceneDocument(self.model, "街")
        self.renderer = SceneRenderer(1.0)

    def tearDown(self) -> None:
        self.doc.deleteLater()
        QApplication.processEvents()

    def ent(self, kind: str, eid: str) -> dict:
        return self.doc.model_entity(EntityRef(kind, eid))


class TransformToolTests(_Base):
    def setUp(self) -> None:
        super().setUp()
        self.tool = TransformTool(self.doc, self.renderer)
        self.ref = EntityRef("hotspot", "h1")
        self.doc.set_selection([self.ref])

    def test_handles_sit_at_a_constant_screen_distance(self) -> None:
        """手柄环按**屏幕像素**定距 —— 缩小视图后仍抓得住。"""
        at_1x = self.tool.handle_positions(self.ref)["rotate"]
        d1 = math.hypot(at_1x.x() - 100, at_1x.y() - 100)
        self.renderer.set_view_scale(0.25)
        at_025x = self.tool.handle_positions(self.ref)["rotate"]
        d2 = math.hypot(at_025x.x() - 100, at_025x.y() - 100)
        self.assertAlmostEqual(d1 * 4, d2, places=6)

    def test_drag_rotate_handle_writes_rotation(self) -> None:
        h = self.tool.handle_positions(self.ref)["rotate"]
        self.assertTrue(self.tool.mouse_pressed(h, _LEFT, _NO_MOD))
        self.tool.mouse_moved(QPointF(100, 170), _LEFT, _NO_MOD)   # 转到正下方 ≈90°
        self.tool.mouse_released(QPointF(100, 170), _LEFT, _NO_MOD)
        self.assertAlmostEqual(self.ent("hotspot", "h1")["rotation"], 90.0, places=3)

    def test_shift_snaps_rotation_to_15_degrees(self) -> None:
        h = self.tool.handle_positions(self.ref)["rotate"]
        self.tool.mouse_pressed(h, _LEFT, _NO_MOD)
        self.tool.mouse_moved(QPointF(100, 168), _LEFT, _SHIFT)
        self.tool.mouse_released(QPointF(100, 168), _LEFT, _SHIFT)
        self.assertEqual(self.ent("hotspot", "h1")["rotation"] % 15.0, 0.0)

    def test_drag_scale_handle_writes_scale(self) -> None:
        h = self.tool.handle_positions(self.ref)["scale"]
        self.tool.mouse_pressed(h, _LEFT, _NO_MOD)
        far = QPointF(100, 100 + (h.y() - 100) * 2.0)
        self.tool.mouse_moved(far, _LEFT, _NO_MOD)
        self.tool.mouse_released(far, _LEFT, _NO_MOD)
        self.assertAlmostEqual(self.ent("hotspot", "h1")["scale"], 2.0, places=3)

    def test_scale_is_clamped(self) -> None:
        h = self.tool.handle_positions(self.ref)["scale"]
        self.tool.mouse_pressed(h, _LEFT, _NO_MOD)
        self.tool.mouse_moved(QPointF(100, 100 + 100000), _LEFT, _NO_MOD)
        self.assertLessEqual(self.tool.preview[0], SCALE_MAX)
        self.tool.mouse_moved(QPointF(100, 100.0001), _LEFT, _NO_MOD)
        self.assertGreaterEqual(self.tool.preview[0], SCALE_MIN)

    def test_no_data_written_until_release(self) -> None:
        h = self.tool.handle_positions(self.ref)["rotate"]
        self.tool.mouse_pressed(h, _LEFT, _NO_MOD)
        self.tool.mouse_moved(QPointF(100, 170), _LEFT, _NO_MOD)
        self.assertNotIn("rotation", self.ent("hotspot", "h1"))

    def test_escape_leaves_no_trace(self) -> None:
        h = self.tool.handle_positions(self.ref)["rotate"]
        self.tool.mouse_pressed(h, _LEFT, _NO_MOD)
        self.tool.mouse_moved(QPointF(100, 170), _LEFT, _NO_MOD)
        self.assertTrue(self.tool.cancel_gesture())
        self.assertNotIn("rotation", self.ent("hotspot", "h1"))
        self.assertEqual(self.doc.undo_stack.count(), 0)

    def test_returning_to_default_removes_the_key(self) -> None:
        """回到缺省值要**删键**，不是写 `scale: 1` —— 后者污染 JSON。"""
        self.ent("hotspot", "h1")["scale"] = 2.0
        h = self.tool.handle_positions(self.ref)["scale"]
        self.tool.mouse_pressed(h, _LEFT, _NO_MOD)
        self.tool.mouse_moved(h, _LEFT, _NO_MOD)     # 不动 = 回到 start_scale=2？
        # 直接构造"回到 1.0"的释放
        self.tool._preview = (1.0, 0.0)
        self.tool.mouse_released(h, _LEFT, _NO_MOD)
        self.assertNotIn("scale", self.ent("hotspot", "h1"))

    def test_press_away_from_handles_is_ignored(self) -> None:
        self.assertFalse(self.tool.mouse_pressed(QPointF(400, 400), _LEFT, _NO_MOD))

    def test_multi_selection_disables_the_gizmo(self) -> None:
        self.doc.set_selection([self.ref, EntityRef("hotspot", "h_free")])
        h = QPointF(170, 100)
        self.assertFalse(self.tool.mouse_pressed(h, _LEFT, _NO_MOD))


class GroupMoveTests(_Base):
    def test_members_come_from_the_model_roster(self) -> None:
        refs = group_member_refs(self.doc, "夜巡")
        ids = {r.id for r in refs}
        self.assertEqual(ids, {"h1", "h_hidden", "h_float", "n1", "z1"})
        self.assertNotIn("h_free", ids)

    def test_hidden_member_moves_too(self) -> None:
        """被过滤藏起来的成员**同样要动** —— 漏掉就是半份移动的坏数据。"""
        translate_group(self.doc, "夜巡", 50, 40)
        hidden = self.ent("hotspot", "h_hidden")
        self.assertEqual((hidden["x"], hidden["y"]), (250, 140))

    def test_zone_polygon_moves(self) -> None:
        translate_group(self.doc, "夜巡", 50, 40)
        poly = self.ent("zone", "z1")["polygon"]
        self.assertEqual((poly[0]["x"], poly[0]["y"]), (650, 140))

    def test_patrol_route_moves(self) -> None:
        translate_group(self.doc, "夜巡", 50, 40)
        route = self.ent("npc", "n1")["patrol"]["route"]
        self.assertEqual((route[0]["x"], route[0]["y"]), (350, 340))

    def test_local_collision_polygon_is_not_translated_again(self) -> None:
        """局部碰撞面挂在锚点上自动跟随；再平移一次 = 漂两倍。"""
        translate_group(self.doc, "夜巡", 50, 40)
        poly = self.ent("hotspot", "h1")["collisionPolygon"]
        self.assertEqual([(p["x"], p["y"]) for p in poly],
                         [(-10, -10), (10, -10), (10, 10)])

    def test_non_member_is_untouched(self) -> None:
        translate_group(self.doc, "夜巡", 50, 40)
        self.assertEqual(self.ent("hotspot", "h_free")["x"], 500)

    def test_integer_coordinates_stay_integers(self) -> None:
        """微移一次就把整数漂成小数 = 黄金往返红 + diff 满屏 `.0`。"""
        translate_group(self.doc, "夜巡", 1, 0)
        self.assertIsInstance(self.ent("hotspot", "h1")["x"], int)

    def test_horizontal_move_leaves_the_untouched_axis_byte_identical(self) -> None:
        """只横移时，每个成员的 y 必须**一个字节都不变**。

        整组位移对每个成员的 x 与 y 是**无条件同时**写入的，dy 为 0 时若仍走
        `round(v, 1)`，全组的 y 会被静默截断（218.02 → 218.0）。真实场景里
        几百个 float 坐标会被一次水平拖动顺手改脏，而画面上完全看不出来。
        """
        translate_group(self.doc, "夜巡", 1, 0)
        self.assertEqual(self.ent("hotspot", "h_float")["y"], 218.02,
                         "没动的那一维被截断了")
        # 真动了的那一维照常取一位小数（本仓坐标精度约定）
        self.assertEqual(self.ent("hotspot", "h_float")["x"], 1309.1)

    def test_vertical_move_leaves_x_byte_identical(self) -> None:
        translate_group(self.doc, "夜巡", 0, 1)
        self.assertEqual(self.ent("hotspot", "h_float")["x"], 1308.14)

    def test_diagonal_move_still_rounds_both(self) -> None:
        """两维都真的动了就照常取一位小数 —— 放行零位移不等于取消取整。"""
        translate_group(self.doc, "夜巡", 0.55, 0.55)
        self.assertEqual(self.ent("hotspot", "h_float")["x"], 1308.7)
        self.assertEqual(self.ent("hotspot", "h_float")["y"], 218.6)

    def test_whole_group_move_is_one_command(self) -> None:
        translate_group(self.doc, "夜巡", 50, 40)
        self.assertEqual(self.doc.undo_stack.count(), 1)
        self.doc.undo_stack.undo()
        self.assertEqual(self.ent("hotspot", "h1")["x"], 100)
        self.assertEqual(self.ent("hotspot", "h_hidden")["x"], 200)
        self.assertEqual(self.ent("zone", "z1")["polygon"][0]["x"], 600)

    def test_zero_delta_does_nothing(self) -> None:
        self.assertFalse(translate_group(self.doc, "夜巡", 0, 0))
        self.assertEqual(self.doc.undo_stack.count(), 0)
        self.assertEqual(self.model.dirty, [])

    def test_unknown_group_is_a_noop(self) -> None:
        self.assertFalse(translate_group(self.doc, "不存在", 10, 10))

    def test_repeated_nudges_collapse_into_one_command(self) -> None:
        """连续方向键微移 = 一条撤销记录。老画布为此糊了 400ms 定时器。"""
        tool = GroupMoveTool(self.doc, self.renderer)
        tool.nudge("夜巡", 1, 0, mergeable=False)
        for _ in range(9):
            tool.nudge("夜巡", 1, 0, mergeable=True)
        self.assertEqual(self.doc.undo_stack.count(), 1,
                         "连续微移产生了多条撤销记录")
        self.assertEqual(self.ent("hotspot", "h1")["x"], 110)
        self.doc.undo_stack.undo()
        self.assertEqual(self.ent("hotspot", "h1")["x"], 100,
                         "合并后的撤销必须一次回到起点")

    def test_drag_writes_on_release_only(self) -> None:
        tool = GroupMoveTool(self.doc, self.renderer)
        self.assertTrue(tool.begin("夜巡", QPointF(0, 0)))
        tool.mouse_moved(QPointF(30, 20), _LEFT, _NO_MOD)
        self.assertEqual(self.ent("hotspot", "h1")["x"], 100, "拖动中就写了数据")
        tool.mouse_released(QPointF(30, 20), _LEFT, _NO_MOD)
        self.assertEqual(self.ent("hotspot", "h1")["x"], 130)

    def test_escape_mid_group_drag_writes_nothing(self) -> None:
        tool = GroupMoveTool(self.doc, self.renderer)
        tool.begin("夜巡", QPointF(0, 0))
        tool.mouse_moved(QPointF(300, 200), _LEFT, _NO_MOD)
        self.assertTrue(tool.cancel_gesture())
        self.assertEqual(self.ent("hotspot", "h1")["x"], 100)
        self.assertEqual(self.doc.undo_stack.count(), 0)


if __name__ == "__main__":
    unittest.main()
