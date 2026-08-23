"""命中判定与手势预览的回归 —— 第二轮对抗式复核钉下来的那批。

这一轮的教训写在最前面，因为它比任何一条用例都重要：

> **上一轮我的测试全绿，但测的是我自己的抽象，不是真实通路和真实数据形状。**

具体形状有三种，本文件逐条堵：

1. **绕过真实入口**：直接往内部状态里塞值，于是"面板控件根本没把编辑刷进
   staging"这一步整个没被走到。→ 本文件的手势一律从**工具接口**进。
2. **只有画面没有命中**：图元建出来了、看得见，但没有一条用例点过它。
   → 每条几何用例都要断言"点这里选中谁"。
3. **只有落地没有过程**：只断言松手后的数据，于是"拖动中画面纹丝不动"
   （预览通道压根没接）无人察觉。→ 本文件断言**手势中**的画面状态。
"""
from __future__ import annotations

import sys
import unittest

from PySide6.QtCore import QPointF, Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.editors.scene_v2.document import SceneDocument
from tools.editor.editors.scene_v2.sorting import assign_content_z
from tools.editor.editors.scene_v2.items import Z_CONTENT_HI
from tools.editor.editors.scene_v2.tools_builtin import (
    MoveTool,
    PolygonEditTool,
    SelectTool,
)
from tools.editor.editors.scene_v2.tools_transform import TransformTool
from tools.editor.editors.scene_v2.view import SceneView

_NO_MOD = Qt.KeyboardModifier.NoModifier
_LEFT = Qt.MouseButton.LeftButton
_RIGHT = Qt.MouseButton.RightButton
_SCENE = "命中街"


class _FakeModel:
    def __init__(self, scene: dict) -> None:
        self.scenes = {_SCENE: scene}
        self.dirty: list[tuple[str, str]] = []

    def mark_dirty(self, domain: str, key: str) -> None:
        self.dirty.append((domain, key))


def _scene() -> dict:
    """真实数据形状：Zone 是**斜边三角形**（AABB 一半在形外），
    热点带 `scale`（碰撞面因此不是纯平移），光曲线是 `{"points": [...]}` dict。"""
    return {
        "id": _SCENE, "name": _SCENE, "worldWidth": 900, "worldHeight": 700,
        # 首个控制点**紧挨着** z2 的一个角：真实场景里曲线与几何重叠很常见，
        # 也正是"光曲线抢走顶点拖动"那条 bug 的复现形状。
        "lightEnvCurve": {"points": [
            {"x": 101, "y": 101, "env": {"tint": "#ffffff"}},
            {"x": 400, "y": 500, "env": {"tint": "#000000"}},
        ]},
        "hotspots": [
            # 形内的小热点：z 与 Zone 相同（都在装饰层），面积远小于 Zone
            {"id": "h_in", "type": "inspect", "x": 650, "y": 140,
             "interactionRange": 50},
            # scale=2 的碰撞面：局部 → 世界不是纯平移
            {"id": "h_scaled", "type": "inspect", "x": 500, "y": 500, "scale": 2.0,
             "collisionPolygonLocal": True,
             "collisionPolygon": [{"x": -10, "y": -10}, {"x": 10, "y": -10},
                                  {"x": 0, "y": 10}]},
            # displayImage 存在但尺寸为 0：内容图元建不出来
            {"id": "h_broken", "type": "inspect", "x": 200, "y": 600,
             "displayImage": {"image": "", "worldWidth": 0, "worldHeight": 0}},
        ],
        "npcs": [],
        "zones": [
            # 斜边三角形：AABB 有一半在形外
            {"id": "z1", "polygon": [{"x": 600, "y": 100}, {"x": 800, "y": 100},
                                     {"x": 600, "y": 300}]},
            # 四边形：删一个顶点之后仍满足"多边形至少三点"
            {"id": "z2", "polygon": [{"x": 100, "y": 100}, {"x": 300, "y": 100},
                                     {"x": 300, "y": 300}, {"x": 100, "y": 300}]},
        ],
    }


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self.model = _FakeModel(_scene())
        self.doc = SceneDocument(self.model, _SCENE)
        self.view = SceneView(self.doc)
        self.view.resize(900, 700)
        self.view.renderer.set_view_scale(1.0)
        self.select = self.view.tools.register(
            SelectTool(self.doc, self.view.renderer, self.view))
        self.move = self.view.tools.register(
            MoveTool(self.doc, self.view.renderer, self.view))
        self.poly = self.view.tools.register(
            PolygonEditTool(self.doc, self.view.renderer, self.view))
        self.transform = self.view.tools.register(
            TransformTool(self.doc, self.view.renderer, self.view))

    def tearDown(self) -> None:
        self.view.deleteLater()
        self.doc.deleteLater()
        QApplication.processEvents()

    def ent(self, kind: str, eid: str) -> dict:
        return self.doc.model_entity(EntityRef(kind, eid))

    def press(self, tool, x, y, mods=_NO_MOD, button=_LEFT):
        return tool.mouse_pressed(QPointF(x, y), button, mods)

    def drag(self, tool, x0, y0, x1, y1, mods=_NO_MOD):
        tool.mouse_pressed(QPointF(x0, y0), _LEFT, mods)
        tool.mouse_moved(QPointF(x1, y1), _LEFT, mods)
        tool.mouse_released(QPointF(x1, y1), _LEFT, mods)


class ShapeHitTests(_Base):
    """命中按**真实形状**，不按包围盒。"""

    def test_click_inside_bounding_box_but_outside_triangle_misses_the_zone(self) -> None:
        """三角 Zone 的 AABB 右下角是空的 —— 点那里不该选中它。

        包围盒判定下这一片全是 Zone 的地盘，于是"点空白处却选中了一个大区域"，
        而且它会把叠在同一片的小实体一并压过去。
        """
        self.press(self.select, 790, 290)
        self.assertEqual(self.doc.selection, (),
                         "点在三角形之外却选中了 Zone —— 又在拿包围盒当形状")

    def test_click_inside_the_triangle_selects_the_zone(self) -> None:
        self.press(self.select, 620, 250)
        self.assertEqual(self.doc.selection, (EntityRef("zone", "z1"),))

    def test_small_handle_wins_over_the_big_zone_underneath(self) -> None:
        """同一落点、同一层 z：面积小的先被选中。

        装饰层图元的 z 是同一个常量，只按 z 排的话次序取决于图元账的迭代顺序 ——
        那是"上次谁被重建过"的副产物，同一处点两次可能选中不同实体。
        """
        self.press(self.select, 650, 140)
        self.assertEqual(self.doc.selection, (EntityRef("hotspot", "h_in"),),
                         "叠在 Zone 上的把手没能优先命中")

    def test_hit_order_is_stable_across_rebuilds(self) -> None:
        self.press(self.select, 650, 140)
        first = self.doc.selection
        self.view.rebuild_all()
        self.doc.clear_selection()
        self.press(self.select, 650, 140)
        self.assertEqual(self.doc.selection, first, "重建之后同一处点出了不同结果")


class ZoneBodyMoveTests(_Base):
    """Zone 没有 x/y，整体平移靠平移多边形。"""

    def test_dragging_a_selected_zone_translates_its_polygon(self) -> None:
        ref = EntityRef("zone", "z1")
        self.doc.set_selection([ref])
        self.drag(self.move, 620, 250, 640, 280)
        self.assertEqual(
            self.ent("zone", "z1")["polygon"][0], {"x": 620.0, "y": 130.0},
            "选中 Zone 拖拽毫无反应 —— 新画布把 Zone 变成了只能逐顶点挪")

    def test_zone_move_is_one_undo_step(self) -> None:
        self.doc.set_selection([EntityRef("zone", "z1")])
        self.drag(self.move, 620, 250, 640, 280)
        self.assertEqual(self.doc.undo_stack.count(), 1)
        self.doc.undo_stack.undo()
        self.assertEqual(self.ent("zone", "z1")["polygon"][0], {"x": 600, "y": 100})


class CollisionTransformTests(_Base):
    """碰撞面的画与写必须是同一对互逆变换。"""

    def test_canvas_applies_the_instance_transform(self) -> None:
        item = self.view.item_for(EntityRef("hotspot", "h_scaled"), "collision")
        self.assertIsNotNone(item, "前置条件：碰撞面图元应当存在")
        self.assertEqual(item.points()[0], (480.0, 480.0),
                         "画的时候漏掉了 scale —— 只做了 anchor + local")

    def test_dragging_a_vertex_round_trips_through_the_transform(self) -> None:
        """拖一个顶点到某处，松手后它必须**还在那处**。

        画用正变换、写用反变换，两者不互逆时顶点会在松手瞬间跳走，而且
        每拖一次偏得更远 —— 画面上完全看不出是"变换口径不一致"。
        """
        ref = EntityRef("hotspot", "h_scaled")
        self.doc.set_selection([ref])
        self.drag(self.poly, 480, 480, 460, 470)
        item = self.view.item_for(ref, "collision")
        self.assertEqual(item.points()[0], (460.0, 470.0),
                         "松手后顶点跳走了 —— 画与写的变换不互逆")
        self.assertEqual(self.ent("hotspot", "h_scaled")["collisionPolygon"][0],
                         {"x": -20.0, "y": -15.0})


class LightCurvePriorityTests(_Base):
    """光曲线不得抢走选中实体的顶点拖动。"""

    def test_selected_entity_vertex_wins_over_the_scene_light_curve(self) -> None:
        """z2 的角在 (100,100)，曲线控制点在 (101,101) —— 两者都在命中半径内。

        选中 z2 之后拖那个角，动的必须是 z2。
        """
        ref = EntityRef("zone", "z2")
        self.doc.set_selection([ref])
        self.drag(self.poly, 100, 100, 150, 150)
        self.assertEqual(self.ent("zone", "z2")["polygon"][0], {"x": 150.0, "y": 150.0},
                         "拖的是 Zone 的角，动的却是打光曲线")
        self.assertEqual(self.doc.scene()["lightEnvCurve"]["points"][0]["x"], 101,
                         "打光曲线被顺手改脏了")

    def test_light_curve_is_still_editable_without_any_selection(self) -> None:
        """降优先级不等于取消 —— 没选中任何实体时曲线仍然可编辑。"""
        self.doc.clear_selection()
        self.drag(self.poly, 101, 101, 150, 150)
        pts = self.doc.scene()["lightEnvCurve"]["points"]
        self.assertEqual((pts[0]["x"], pts[0]["y"]), (150.0, 150.0))
        self.assertEqual(pts[0]["env"], {"tint": "#ffffff"},
                         "关键帧的 env 被写丢了")


class RightClickDeleteVertexTests(_Base):
    """右键删顶点必须有真实通路 —— 视图只把按键转给 `mouse_pressed`。"""

    def test_right_click_on_a_vertex_deletes_it(self) -> None:
        ref = EntityRef("zone", "z2")
        self.doc.set_selection([ref])
        handled = self.press(self.poly, 300, 100, button=_RIGHT)
        self.assertTrue(handled, "右键根本没被工具接住 —— 状态栏提示是空头支票")
        self.assertEqual(len(self.ent("zone", "z2")["polygon"]), 3)

    def test_right_click_refuses_to_go_below_the_minimum(self) -> None:
        self.doc.set_selection([EntityRef("zone", "z1")])
        self.press(self.poly, 600, 100, button=_RIGHT)
        self.assertEqual(len(self.ent("zone", "z1")["polygon"]), 3,
                         "把多边形删成了两个点")


class ContentZFallbackTests(_Base):
    """没有内容图元的热点不得混进内容层 z。"""

    def test_broken_display_image_keeps_the_handle_above_content(self) -> None:
        assign_content_z(self.doc, self.view)
        handle = self.view.item_for(EntityRef("hotspot", "h_broken"), "handle")
        self.assertGreater(
            handle.zValue(), Z_CONTENT_HI,
            "把手被派进了内容层 —— 它会沉到贴图底下，点不着")


class GesturePreviewTests(_Base):
    """手势**过程中**画面要跟着走，且数据一个字节都不能改。"""

    def test_drag_preview_moves_the_item_without_touching_data(self) -> None:
        ref = EntityRef("hotspot", "h_in")
        self.doc.set_selection([ref])
        self.view.tools.select(self.move)
        self.move.mouse_pressed(QPointF(650, 140), _LEFT, _NO_MOD)
        self.move.mouse_moved(QPointF(700, 190), _LEFT, _NO_MOD)
        self.view.refresh_gesture_preview()
        item = self.view.item_for(ref, "handle")
        self.assertEqual((item.pos().x(), item.pos().y()), (700.0, 190.0),
                         "拖动中画面纹丝不动 —— 预览通道没接")
        self.assertEqual((self.ent("hotspot", "h_in")["x"],
                          self.ent("hotspot", "h_in")["y"]), (650, 140),
                         "手势中就把数据改了 —— 违反'松手才落地'")

    def test_release_clears_the_preview_offset(self) -> None:
        ref = EntityRef("hotspot", "h_in")
        self.doc.set_selection([ref])
        self.view.tools.select(self.move)
        self.move.mouse_pressed(QPointF(650, 140), _LEFT, _NO_MOD)
        self.move.mouse_moved(QPointF(700, 190), _LEFT, _NO_MOD)
        self.view.refresh_gesture_preview()
        self.move.mouse_released(QPointF(700, 190), _LEFT, _NO_MOD)
        self.view.refresh_gesture_preview()
        item = self.view.item_for(ref, "handle")
        self.assertEqual(item.preview_offset, (0.0, 0.0))
        self.assertEqual((item.pos().x(), item.pos().y()), (700.0, 190.0),
                         "松手后画面应当由真实数据决定，且与预览位置重合")

    def test_cancelled_gesture_restores_the_picture(self) -> None:
        ref = EntityRef("hotspot", "h_in")
        self.doc.set_selection([ref])
        self.view.tools.select(self.move)
        self.move.mouse_pressed(QPointF(650, 140), _LEFT, _NO_MOD)
        self.move.mouse_moved(QPointF(700, 190), _LEFT, _NO_MOD)
        self.view.refresh_gesture_preview()
        self.move.cancel_gesture()
        self.view.refresh_gesture_preview()
        item = self.view.item_for(ref, "handle")
        self.assertEqual((item.pos().x(), item.pos().y()), (650.0, 140.0))

    def test_sync_during_a_gesture_does_not_wipe_the_preview(self) -> None:
        """手势中来了一次别的变更同步 —— 预览不能被冲掉。

        位置拆成"数据位 + 预览位移"就是为了这个：`_sync_*` 只写前者。
        """
        ref = EntityRef("hotspot", "h_in")
        self.doc.set_selection([ref])
        self.view.tools.select(self.move)
        self.move.mouse_pressed(QPointF(650, 140), _LEFT, _NO_MOD)
        self.move.mouse_moved(QPointF(700, 190), _LEFT, _NO_MOD)
        self.view.refresh_gesture_preview()
        self.view.rebuild_all()
        self.view.refresh_gesture_preview()
        item = self.view.item_for(ref, "handle")
        self.assertEqual((item.pos().x(), item.pos().y()), (700.0, 190.0))

    def test_rubber_band_is_drawn_while_dragging_empty_space(self) -> None:
        self.view.tools.select(self.select)
        self.select.mouse_pressed(QPointF(20, 660), _LEFT, _NO_MOD)
        self.select.mouse_moved(QPointF(300, 690), _LEFT, _NO_MOD)
        self.view.refresh_gesture_preview()
        self.assertTrue(self.view.rubber_band.isVisible(),
                        "框选矩形没画出来 —— 用户看不见自己在框什么")
        self.select.mouse_released(QPointF(300, 690), _LEFT, _NO_MOD)
        self.view.refresh_gesture_preview()
        self.assertFalse(self.view.rubber_band.isVisible())


class TransformGizmoTests(_Base):
    """缩放/旋转手柄要真的画出来，且与命中同源。"""

    def test_gizmo_appears_for_a_single_selection(self) -> None:
        self.view.tools.select(self.transform)
        self.doc.set_selection([EntityRef("hotspot", "h_in")])
        self.view.refresh_gesture_preview()
        self.assertTrue(self.view.transform_gizmo.isVisible(),
                        "变换工具没有任何可见手柄 —— 用户无从下手")

    def test_gizmo_hides_when_the_tool_changes(self) -> None:
        self.view.tools.select(self.transform)
        self.doc.set_selection([EntityRef("hotspot", "h_in")])
        self.view.refresh_gesture_preview()
        self.view.tools.select(self.select)
        self.assertFalse(self.view.transform_gizmo.isVisible(),
                         "切走变换工具后手柄还留在画面上，点它却没人接管")

    def test_gizmo_follows_the_preview_rotation(self) -> None:
        """转动过程中手柄要跟着手转，否则没有"转到哪了"的反馈。"""
        ref = EntityRef("hotspot", "h_in")
        self.view.tools.select(self.transform)
        self.doc.set_selection([ref])
        handles = self.transform.handle_positions(ref)
        rot = handles["rotate"]
        self.transform.mouse_pressed(rot, _LEFT, _NO_MOD)
        anchor = QPointF(650, 140)
        self.transform.mouse_moved(
            QPointF(anchor.x(), anchor.y() + 70), _LEFT, _NO_MOD)
        moved = self.transform.gizmo_positions()["rotate"]
        self.assertNotEqual((round(moved.x(), 3), round(moved.y(), 3)),
                            (round(rot.x(), 3), round(rot.y(), 3)),
                            "手柄没跟着预览角度走")
        self.assertEqual(self.ent("hotspot", "h_in").get("rotation"), None,
                         "手势中就把 rotation 写进了数据")


class SelectionShortcutTests(_Base):
    """Delete / Ctrl+D / 方向键 —— 这几条此前**一个调用点都没有**。

    `delete_selected` / `duplicate_selected` 是公开方法却没人调，状态栏还写着
    "方向键微移"。它们作用在"当前选择"上，不属于任何一个工具，所以接在基类：
    换个工具就删不了东西是不该发生的。
    """

    def key(self, tool, key, mods=_NO_MOD):
        return tool.key_pressed(key, mods)

    def test_delete_removes_the_selection(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "h_in")])
        self.assertTrue(self.key(self.select, Qt.Key.Key_Delete))
        self.assertIsNone(self.doc.model_entity(EntityRef("hotspot", "h_in")))

    def test_delete_works_from_any_tool(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "h_in")])
        self.assertTrue(self.key(self.poly, Qt.Key.Key_Delete))
        self.assertIsNone(self.doc.model_entity(EntityRef("hotspot", "h_in")))

    def test_delete_is_undoable(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "h_in")])
        self.key(self.select, Qt.Key.Key_Delete)
        self.doc.undo_stack.undo()
        self.assertIsNotNone(self.doc.model_entity(EntityRef("hotspot", "h_in")))

    def test_ctrl_d_duplicates(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "h_in")])
        self.assertTrue(self.key(self.select, Qt.Key.Key_D,
                                 Qt.KeyboardModifier.ControlModifier))
        ids = [r.id for r in self.doc.entity_refs("hotspot")]
        self.assertEqual(len(ids), 4, f"复制没发生：{ids}")

    def test_plain_d_does_not_duplicate(self) -> None:
        """没按 Ctrl 的 D 是普通输入，不该动数据。"""
        self.doc.set_selection([EntityRef("hotspot", "h_in")])
        self.assertFalse(self.key(self.select, Qt.Key.Key_D))
        self.assertEqual(len(self.doc.entity_refs("hotspot")), 3)

    def test_arrow_key_nudges_by_one_unit(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "h_in")])
        self.assertTrue(self.key(self.select, Qt.Key.Key_Right))
        self.assertEqual(self.ent("hotspot", "h_in")["x"], 651)

    def test_shift_arrow_nudges_further(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "h_in")])
        self.key(self.select, Qt.Key.Key_Down, Qt.KeyboardModifier.ShiftModifier)
        self.assertEqual(self.ent("hotspot", "h_in")["y"], 150)

    def test_nudge_moves_a_zone_body_too(self) -> None:
        """Zone 没有 x/y —— 微移必须与拖动走同一条平移规则。"""
        self.doc.set_selection([EntityRef("zone", "z1")])
        self.key(self.select, Qt.Key.Key_Right)
        self.assertEqual(self.ent("zone", "z1")["polygon"][0], {"x": 601, "y": 100})

    def test_repeated_nudges_collapse_into_one_undo_step(self) -> None:
        self.doc.set_selection([EntityRef("hotspot", "h_in")])
        for _ in range(5):
            self.key(self.select, Qt.Key.Key_Right)
        self.assertEqual(self.doc.undo_stack.count(), 1)
        self.doc.undo_stack.undo()
        self.assertEqual(self.ent("hotspot", "h_in")["x"], 650,
                         "合并后的撤销必须一次回到微移起点")

    def test_changing_selection_starts_a_new_nudge_command(self) -> None:
        """挪 A、改选 B、再挪 B：撤销一次不该把 A 也退回去。"""
        self.doc.set_selection([EntityRef("hotspot", "h_in")])
        self.key(self.select, Qt.Key.Key_Right)
        self.doc.set_selection([EntityRef("hotspot", "h_broken")])
        self.key(self.select, Qt.Key.Key_Right)
        self.assertEqual(self.doc.undo_stack.count(), 2)

    def test_nudge_with_empty_selection_is_a_noop(self) -> None:
        self.doc.clear_selection()
        self.assertFalse(self.key(self.select, Qt.Key.Key_Right))
        self.assertEqual(self.doc.undo_stack.count(), 0)

    def test_view_can_receive_key_events_at_all(self) -> None:
        """没有焦点策略的话上面全部白搭：`QGraphicsView` 默认不接受点击取焦，
        键盘事件一个也到不了 `keyPressEvent`。"""
        self.assertNotEqual(self.view.focusPolicy(), Qt.FocusPolicy.NoFocus)


if __name__ == "__main__":
    unittest.main()
