"""新画布骨架的视图/工具层验收。

这一层要堵的是老画布**至今没修**的两个 bug，以及本轮我自己踩过的一个：

1. **"提示写着双击边线插点，实际怎么点都没反应"**（巡逻折线、光曲线两处）——
   根因是 `shape()` 一个函数既管画又管点，为了不挡住下方实体被收窄成"仅顶点"，
   于是边线收不到双击。这里 `edge_hit_index` 是独立函数，双击是基类一等接口。
2. **"大场景缩放后顶点只有 3 像素按不中"** —— 命中尺寸必须按**屏幕像素**恒定。
3. **覆盖物抢走点击** —— 命中白名单只认 `EntityItem`，覆盖物结构上不可能参与。
"""
from __future__ import annotations

import sys
import unittest

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.editors.scene_v2.items import (
    Z_CONTENT_HI,
    Z_DECOR_BASE,
    Z_OVERLAY,
    EntityItem,
    OverlayItem,
)
from tools.editor.editors.scene_v2.renderer import (
    EDGE_PICK_PX,
    HANDLE_PICK_PX,
    SceneRenderer,
)
from tools.editor.editors.scene_v2.tools import AbstractTool, ToolManager


class _Item(EntityItem):
    def __init__(self, ref: EntityRef, z: float = Z_DECOR_BASE) -> None:
        super().__init__(ref)
        self.setZValue(z)

    def boundingRect(self) -> QRectF:
        return QRectF(-5, -5, 10, 10)

    def paint(self, painter, option, widget=None) -> None:  # pragma: no cover
        pass


class _Overlay(OverlayItem):
    def boundingRect(self) -> QRectF:
        return QRectF(-50, -50, 100, 100)

    def paint(self, painter, option, widget=None) -> None:  # pragma: no cover
        pass


class HitSizeIsScreenPixelsTests(unittest.TestCase):
    """命中尺寸必须按屏幕像素恒定 —— 缩小视图后不许跟着缩没。"""

    def test_handle_radius_grows_in_world_units_as_you_zoom_out(self) -> None:
        r = SceneRenderer(1.0)
        at_1x = r.handle_radius_world()
        r.set_view_scale(0.2)          # 缩到 0.2 倍（fit 一个大场景就是这个量级）
        at_02x = r.handle_radius_world()
        self.assertAlmostEqual(at_1x, HANDLE_PICK_PX)
        self.assertAlmostEqual(at_02x, HANDLE_PICK_PX / 0.2)
        self.assertGreater(at_02x, at_1x,
                           "缩小视图后顶点的世界命中半径没变大 = 屏幕上按不中了")

    def test_vertex_hit_uses_screen_radius(self) -> None:
        pts = [(0.0, 0.0), (100.0, 0.0)]
        r = SceneRenderer(1.0)
        # 1 倍下，离顶点 30 世界单位 = 30 像素，超出 10px 命中半径
        self.assertIsNone(r.vertex_hit_index(pts, QPointF(30, 0)))
        # 缩到 0.2 倍，同样 30 世界单位只有 6 像素，应当命中
        r.set_view_scale(0.2)
        self.assertEqual(r.vertex_hit_index(pts, QPointF(30, 0)), 0)

    def test_vertex_hit_picks_the_nearest(self) -> None:
        r = SceneRenderer(1.0)
        pts = [(0.0, 0.0), (8.0, 0.0)]
        self.assertEqual(r.vertex_hit_index(pts, QPointF(7.0, 0.0)), 1)

    def test_zero_scale_does_not_explode(self) -> None:
        """fitInView 在极端场景下会给 0；除零会让命中带炸成无穷、满屏皆可点。"""
        r = SceneRenderer(0.0)
        self.assertGreater(r.view_scale, 0.0)
        self.assertTrue(r.handle_radius_world() < float("inf"))

    def test_tiny_items_are_inflated_for_picking(self) -> None:
        r = SceneRenderer(1.0)
        tiny = QRectF(0, 0, 1, 1)
        got = r.inflate_for_picking(tiny)
        self.assertGreaterEqual(got.width(), 8.0)
        self.assertGreaterEqual(got.height(), 8.0)
        self.assertAlmostEqual(got.center().x(), tiny.center().x(), places=6)


class EdgeHitEnablesInsertVertexTests(unittest.TestCase):
    """边线命中 —— "双击插点"能不能做到，全看有没有这个函数。"""

    SQUARE = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0)]

    def test_point_on_an_edge_hits_that_edge(self) -> None:
        r = SceneRenderer(1.0)
        self.assertEqual(r.edge_hit_index(self.SQUARE, QPointF(50, 0), closed=True), 0)
        self.assertEqual(r.edge_hit_index(self.SQUARE, QPointF(100, 50), closed=True), 1)

    def test_point_far_from_every_edge_misses(self) -> None:
        r = SceneRenderer(1.0)
        self.assertIsNone(r.edge_hit_index(self.SQUARE, QPointF(50, 50), closed=True),
                          "多边形内部不该算命中边（那会让内部双击也插点）")

    def test_closing_edge_only_exists_when_closed(self) -> None:
        r = SceneRenderer(1.0)
        on_closing = QPointF(0, 50)
        self.assertEqual(r.edge_hit_index(self.SQUARE, on_closing, closed=True), 3)
        self.assertIsNone(
            r.edge_hit_index(self.SQUARE, on_closing, closed=False),
            "开放折线不该有闭合边 —— 巡逻路线是开放的")

    def test_edge_band_is_screen_pixels(self) -> None:
        r = SceneRenderer(1.0)
        off = QPointF(50, EDGE_PICK_PX + 2)
        self.assertIsNone(r.edge_hit_index(self.SQUARE, off, closed=True))
        r.set_view_scale(0.2)
        self.assertEqual(r.edge_hit_index(self.SQUARE, off, closed=True), 0,
                         "缩小后边线命中带没跟着变宽")

    def test_degenerate_polyline_is_safe(self) -> None:
        r = SceneRenderer(1.0)
        self.assertIsNone(r.edge_hit_index([], QPointF(0, 0), closed=False))
        self.assertIsNone(r.edge_hit_index([(1.0, 1.0)], QPointF(1, 1), closed=False))
        # 两端重合的退化线段不许除零
        self.assertEqual(
            r.edge_hit_index([(0.0, 0.0), (0.0, 0.0)], QPointF(0, 0), closed=False), 0)


class ItemsDoNotEatMouseTests(unittest.TestCase):
    """图元被动 —— 命中归工具，z 回归纯显示属性。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def test_entity_items_accept_no_mouse_buttons(self) -> None:
        it = _Item(EntityRef("hotspot", "h1"))
        self.assertEqual(it.acceptedMouseButtons(), Qt.MouseButton.NoButton,
                         "图元又开始吃鼠标了 —— 命中会退回按 z 派发，覆盖物会抢点击")

    def test_entity_items_are_not_qt_selectable_or_movable(self) -> None:
        it = _Item(EntityRef("hotspot", "h1"))
        self.assertFalse(it.flags() & type(it).GraphicsItemFlag.ItemIsSelectable)
        self.assertFalse(it.flags() & type(it).GraphicsItemFlag.ItemIsMovable)

    def test_overlays_sit_above_decor_and_content(self) -> None:
        self.assertGreater(Z_OVERLAY, Z_DECOR_BASE)
        self.assertGreater(Z_DECOR_BASE, Z_CONTENT_HI)


class ToolHitWhitelistTests(unittest.TestCase):
    """命中白名单：只认 `EntityItem`。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self.tool = AbstractTool(document=None, renderer=SceneRenderer(1.0))

    def test_overlay_is_never_a_hit(self) -> None:
        ent = _Item(EntityRef("hotspot", "h1"))
        overlay = _Overlay()
        hits = self.tool.entities_at(QPointF(0, 0), [overlay, ent])
        self.assertEqual([h.ref for h in hits], [ent.ref],
                         "覆盖物混进了命中结果 —— 它会抢走本该属于实体的点击")

    def test_hidden_and_disabled_items_are_skipped(self) -> None:
        visible = _Item(EntityRef("hotspot", "h1"))
        hidden = _Item(EntityRef("hotspot", "h2"))
        hidden.setVisible(False)
        disabled = _Item(EntityRef("hotspot", "h3"))
        disabled.setEnabled(False)
        hits = self.tool.entities_at(QPointF(0, 0), [hidden, disabled, visible])
        self.assertEqual([h.ref.id for h in hits], ["h1"])

    def test_hits_are_sorted_top_first(self) -> None:
        low = _Item(EntityRef("hotspot", "low"), z=Z_DECOR_BASE)
        high = _Item(EntityRef("hotspot", "high"), z=Z_DECOR_BASE + 10)
        hits = self.tool.entities_at(QPointF(0, 0), [low, high])
        self.assertEqual([h.ref.id for h in hits], ["high", "low"])


class ToolManagerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self.mgr = ToolManager()
        self.log: list[str] = []

        class _T(AbstractTool):
            def __init__(inner, tid: str) -> None:
                super().__init__(document=None, renderer=SceneRenderer(1.0))
                inner.tool_id = tid
                inner.cancelled = 0

            def on_activated(inner) -> None:
                self.log.append(f"on:{inner.tool_id}")

            def on_deactivated(inner) -> None:
                self.log.append(f"off:{inner.tool_id}")

            def cancel_gesture(inner) -> bool:
                inner.cancelled += 1
                return True

        self.a = self.mgr.register(_T("a"))
        self.b = self.mgr.register(_T("b"))

    def test_exactly_one_tool_is_active(self) -> None:
        self.mgr.select("a")
        self.assertTrue(self.a.is_active)
        self.mgr.select("b")
        self.assertFalse(self.a.is_active)
        self.assertTrue(self.b.is_active)

    def test_old_tool_is_deactivated_before_the_new_one_activates(self) -> None:
        """顺序不可颠倒：反过来会让旧工具的取消手势在新工具已接管输入之后才跑。"""
        self.mgr.select("a")
        self.log.clear()
        self.mgr.select("b")
        self.assertEqual(self.log, ["off:a", "on:b"])

    def test_switching_tools_cancels_the_in_flight_gesture(self) -> None:
        self.mgr.select("a")
        self.mgr.select("b")
        self.assertEqual(self.a.cancelled, 1, "切工具没有中止旧工具进行中的手势")

    def test_selecting_the_same_tool_is_a_noop(self) -> None:
        self.mgr.select("a")
        self.log.clear()
        self.mgr.select("a")
        self.assertEqual(self.log, [])

    def test_unknown_tool_id_raises(self) -> None:
        with self.assertRaises(KeyError):
            self.mgr.select("nope")

    def test_input_is_forwarded_to_the_current_tool_only(self) -> None:
        seen: list[str] = []

        class _Rec(AbstractTool):
            tool_id = "rec"

            def mouse_double_clicked(inner, pos, button, modifiers) -> bool:
                seen.append("dbl")
                return True

        rec = self.mgr.register(_Rec(document=None, renderer=SceneRenderer(1.0)))
        self.mgr.select(rec)
        self.assertTrue(self.mgr.mouse_double_clicked(
            QPointF(0, 0), Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))
        self.assertEqual(seen, ["dbl"])

    def test_double_click_is_a_first_class_interface(self) -> None:
        """双击必须在基类接口里 —— 老画布把它写进提示却没接线，长期没人发现。"""
        self.assertTrue(hasattr(AbstractTool, "mouse_double_clicked"))
        self.assertTrue(hasattr(ToolManager, "mouse_double_clicked"))

    def test_escape_routes_to_cancel_gesture(self) -> None:
        self.mgr.select("a")
        self.assertTrue(self.mgr.key_pressed(
            Qt.Key.Key_Escape, Qt.KeyboardModifier.NoModifier))
        self.assertEqual(self.a.cancelled, 1)

    def test_no_current_tool_swallows_nothing(self) -> None:
        self.assertFalse(self.mgr.mouse_pressed(
            QPointF(0, 0), Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier))


if __name__ == "__main__":
    unittest.main()
