"""新画布工具的**交互级**验收 —— 老画布完全没有这一层。

方案书 §5.4 点名："双击插点必须有交互级测试，这是老画布那条 high 级 bug 的直接
堵漏"。那条 bug（提示写着双击边线插点、实际怎么点都没反应）之所以长期没人发现，
正是因为画布的双击/右键路径**一个测试都没有**。

这里的用例全部从**工具接口**进（模拟真实手势序列），不是直接调内部函数。
"""
from __future__ import annotations

import sys
import unittest

from PySide6.QtCore import QPointF, Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.editors.scene_v2.document import SceneDocument
from tools.editor.editors.scene_v2.tools_builtin import (
    MoveTool,
    PolygonEditTool,
    SelectTool,
    pick_cycle,
)
from tools.editor.editors.scene_v2.view import SceneView

_NO_MOD = Qt.KeyboardModifier.NoModifier
_SHIFT = Qt.KeyboardModifier.ShiftModifier
_LEFT = Qt.MouseButton.LeftButton


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
            {"id": "h1", "type": "inspect", "x": 100, "y": 100, "interactionRange": 50},
            {"id": "h2", "type": "inspect", "x": 100, "y": 100, "interactionRange": 50},
            {"id": "h_poly", "type": "inspect", "x": 400, "y": 400,
             "collisionPolygonLocal": True,
             "collisionPolygon": [{"x": -50, "y": -50}, {"x": 50, "y": -50},
                                  {"x": 50, "y": 50}]},
        ],
        "npcs": [
            {"id": "n1", "name": "甲", "x": 300, "y": 200, "interactionRange": 50,
             "patrol": {"route": [{"x": 300, "y": 200}, {"x": 500, "y": 200}]}},
        ],
        "zones": [
            {"id": "z1", "polygon": [{"x": 600, "y": 100}, {"x": 700, "y": 100},
                                     {"x": 700, "y": 200}, {"x": 600, "y": 200}]},
        ],
    }


class _ToolTestBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self.model = _FakeModel(_scene())
        self.doc = SceneDocument(self.model, "街")
        self.view = SceneView(self.doc)
        self.view.resize(800, 600)
        self.view.renderer.set_view_scale(1.0)
        self.select = SelectTool(self.doc, self.view.renderer, self.view)
        self.move = MoveTool(self.doc, self.view.renderer, self.view)
        self.poly = PolygonEditTool(self.doc, self.view.renderer, self.view)
        for t in (self.select, self.move, self.poly):
            self.view.tools.register(t)

    def tearDown(self) -> None:
        self.view.deleteLater()
        self.doc.deleteLater()
        QApplication.processEvents()

    def press(self, tool, x, y, mods=_NO_MOD):
        return tool.mouse_pressed(QPointF(x, y), _LEFT, mods)

    def move_to(self, tool, x, y, mods=_NO_MOD):
        return tool.mouse_moved(QPointF(x, y), _LEFT, mods)

    def release(self, tool, x, y, mods=_NO_MOD):
        return tool.mouse_released(QPointF(x, y), _LEFT, mods)


class SelectToolTests(_ToolTestBase):
    def test_click_selects_the_entity_under_cursor(self) -> None:
        self.press(self.select, 300, 200)
        self.assertEqual(self.doc.selection, (EntityRef("npc", "n1"),))

    def test_click_on_empty_space_clears_selection(self) -> None:
        self.doc.set_selection([EntityRef("npc", "n1")])
        self.press(self.select, 10, 590)
        self.assertEqual(self.doc.selection, ())

    def test_shift_click_adds_to_selection(self) -> None:
        self.press(self.select, 300, 200)
        self.press(self.select, 600, 100, mods=_SHIFT)
        self.assertEqual(len(self.doc.selection), 2)

    def test_shift_click_on_selected_removes_it(self) -> None:
        self.press(self.select, 300, 200)
        self.press(self.select, 300, 200, mods=_SHIFT)
        self.assertEqual(self.doc.selection, ())

    def test_repeated_click_cycles_through_stacked_entities(self) -> None:
        """两个热点完全重叠：同一处重复点击必须在它们之间轮转。"""
        self.press(self.select, 100, 100)
        first = self.doc.selection
        self.press(self.select, 100, 100)
        second = self.doc.selection
        self.assertNotEqual(first, second, "重叠实体没有轮转，下面那个永远选不中")
        self.press(self.select, 100, 100)
        self.assertEqual(self.doc.selection, first, "轮转没有回到起点")

    def test_cycling_moves_no_z_values(self) -> None:
        """叠放轮转**一个 z 都不许动** —— 老画布靠抬 z 实现，代价是抢走别处的点击。"""
        before = {id(it): it.zValue() for it in self.view.entity_items()}
        self.press(self.select, 100, 100)
        self.press(self.select, 100, 100)
        after = {id(it): it.zValue() for it in self.view.entity_items()}
        self.assertEqual(before, after, "叠放轮转动了 z —— 会抢走覆盖物/手柄的点击")

    def test_pick_cycle_helper(self) -> None:
        self.assertIsNone(pick_cycle([], None))
        self.assertEqual(pick_cycle(["a", "b"], None), "a")
        self.assertEqual(pick_cycle(["a", "b"], "a"), "b")
        self.assertEqual(pick_cycle(["a", "b"], "b"), "a")
        self.assertEqual(pick_cycle(["a", "b"], "zzz"), "a")

    def test_rubber_band_selects_everything_inside(self) -> None:
        self.press(self.select, 50, 50)
        self.move_to(self.select, 750, 550)
        self.release(self.select, 750, 550)
        self.assertGreaterEqual(len(self.doc.selection), 4)

    def test_escape_cancels_the_rubber_band(self) -> None:
        self.press(self.select, 50, 50)
        self.move_to(self.select, 200, 200)
        self.assertTrue(self.select.cancel_gesture())
        self.assertIsNone(self.select.band_rect)


class MoveToolTests(_ToolTestBase):
    def test_drag_moves_the_selected_entity(self) -> None:
        ref = EntityRef("npc", "n1")
        self.doc.set_selection([ref])
        self.press(self.move, 300, 200)
        self.move_to(self.move, 340, 260)
        self.release(self.move, 340, 260)
        ent = self.doc.model_entity(ref)
        self.assertEqual((ent["x"], ent["y"]), (340.0, 260.0))

    def test_no_data_is_written_until_release(self) -> None:
        """**手势期间数据不许动** —— 这是"Esc 能干净退回"的结构性保证。"""
        ref = EntityRef("npc", "n1")
        self.doc.set_selection([ref])
        self.press(self.move, 300, 200)
        self.move_to(self.move, 400, 400)
        self.assertEqual(self.doc.model_entity(ref)["x"], 300,
                         "拖动过程中就把数据改了 —— Esc 将无法干净回退")
        self.assertEqual(self.doc.undo_stack.count(), 0)

    def test_escape_mid_drag_leaves_data_untouched(self) -> None:
        ref = EntityRef("npc", "n1")
        self.doc.set_selection([ref])
        self.press(self.move, 300, 200)
        self.move_to(self.move, 400, 400)
        self.assertTrue(self.move.cancel_gesture())
        self.assertEqual(self.doc.model_entity(ref)["x"], 300)
        self.assertEqual(self.doc.undo_stack.count(), 0)
        self.assertEqual(self.model.dirty, [], "取消的拖动把场景标脏了")

    def test_zero_displacement_click_does_not_dirty(self) -> None:
        """只是点一下：不入栈、不标脏、坐标表示不变。老画布为此手写三道闸。"""
        ref = EntityRef("npc", "n1")
        self.doc.set_selection([ref])
        self.press(self.move, 300, 200)
        self.release(self.move, 300, 200)
        self.assertEqual(self.doc.undo_stack.count(), 0)
        self.assertEqual(self.model.dirty, [])
        self.assertIsInstance(self.doc.model_entity(ref)["x"], int,
                              "零位移点击把整数坐标漂成了小数")

    def test_multi_select_moves_as_one_command(self) -> None:
        refs = [EntityRef("npc", "n1"), EntityRef("hotspot", "h1")]
        self.doc.set_selection(refs)
        self.press(self.move, 300, 200)
        self.move_to(self.move, 310, 210)
        self.release(self.move, 310, 210)
        self.assertEqual(self.doc.undo_stack.count(), 1,
                         "多选拖动应当是一条命令，否则撤销一次只退回一半")
        self.assertEqual(self.doc.model_entity(refs[0])["x"], 310.0)
        self.assertEqual(self.doc.model_entity(refs[1])["x"], 110.0)

    def test_undo_restores_every_member_of_a_multi_move(self) -> None:
        refs = [EntityRef("npc", "n1"), EntityRef("hotspot", "h1")]
        self.doc.set_selection(refs)
        self.press(self.move, 300, 200)
        self.move_to(self.move, 350, 250)
        self.release(self.move, 350, 250)
        self.doc.undo_stack.undo()
        self.assertEqual(self.doc.model_entity(refs[0])["x"], 300)
        self.assertEqual(self.doc.model_entity(refs[1])["x"], 100)


class PolygonEditToolTests(_ToolTestBase):
    ZONE = EntityRef("zone", "z1")

    def test_drag_vertex_moves_it(self) -> None:
        self.doc.set_selection([self.ZONE])
        self.assertTrue(self.press(self.poly, 600, 100))
        self.move_to(self.poly, 580, 90)
        self.release(self.poly, 580, 90)
        pts = self.doc.model_entity(self.ZONE)["polygon"]
        self.assertEqual((pts[0]["x"], pts[0]["y"]), (580.0, 90.0))

    def test_vertex_drag_is_one_undoable_command(self) -> None:
        self.doc.set_selection([self.ZONE])
        self.press(self.poly, 600, 100)
        self.move_to(self.poly, 580, 90)
        self.release(self.poly, 580, 90)
        self.assertEqual(self.doc.undo_stack.count(), 1)
        self.doc.undo_stack.undo()
        self.assertEqual(self.doc.model_entity(self.ZONE)["polygon"][0]["x"], 600)

    def test_escape_mid_vertex_drag_restores_shape(self) -> None:
        self.doc.set_selection([self.ZONE])
        self.press(self.poly, 600, 100)
        self.move_to(self.poly, 300, 300)
        self.assertTrue(self.poly.cancel_gesture())
        self.assertEqual(self.doc.model_entity(self.ZONE)["polygon"][0]["x"], 600)
        self.assertEqual(self.doc.undo_stack.count(), 0)

    # ---- 双击插点：老画布那条 high 级 bug 的直接堵漏 ----------------------

    def test_double_click_on_an_edge_inserts_a_vertex(self) -> None:
        """**这条在老画布里是死的**：提示写了、代码没接、没有测试。"""
        self.doc.set_selection([self.ZONE])
        before = len(self.doc.model_entity(self.ZONE)["polygon"])
        handled = self.poly.mouse_double_clicked(QPointF(650, 100), _LEFT, _NO_MOD)
        self.assertTrue(handled, "双击边线没有被工具处理 —— 插点又变成空头支票了")
        after = self.doc.model_entity(self.ZONE)["polygon"]
        self.assertEqual(len(after), before + 1)
        self.assertEqual((after[1]["x"], after[1]["y"]), (650.0, 100.0),
                         "插入的顶点应当落在被双击的那条边上")

    def test_double_click_inside_the_polygon_inserts_nothing(self) -> None:
        self.doc.set_selection([self.ZONE])
        before = len(self.doc.model_entity(self.ZONE)["polygon"])
        self.poly.mouse_double_clicked(QPointF(650, 150), _LEFT, _NO_MOD)
        self.assertEqual(len(self.doc.model_entity(self.ZONE)["polygon"]), before,
                         "多边形内部双击不该插点")

    def test_insert_is_undoable(self) -> None:
        self.doc.set_selection([self.ZONE])
        self.poly.mouse_double_clicked(QPointF(650, 100), _LEFT, _NO_MOD)
        self.assertEqual(self.doc.undo_stack.count(), 1)
        self.doc.undo_stack.undo()
        self.assertEqual(len(self.doc.model_entity(self.ZONE)["polygon"]), 4)

    def test_double_click_works_on_an_open_polyline(self) -> None:
        """巡逻路线是**开放**折线，边线插点同样要能用。"""
        ref = EntityRef("npc", "n1")
        self.doc.set_selection([ref])
        handled = self.poly.mouse_double_clicked(QPointF(400, 200), _LEFT, _NO_MOD)
        self.assertTrue(handled)
        route = self.doc.model_entity(ref)["patrol"]["route"]
        self.assertEqual(len(route), 3)
        self.assertEqual((route[1]["x"], route[1]["y"]), (400.0, 200.0))

    def test_open_polyline_has_no_closing_edge(self) -> None:
        """开放折线的首尾之间没有边，那儿双击不该插点。"""
        ref = EntityRef("npc", "n1")
        self.doc.set_selection([ref])
        # (400, 100) 在首尾连线之外、也不在实际路线上
        self.poly.mouse_double_clicked(QPointF(400, 100), _LEFT, _NO_MOD)
        self.assertEqual(len(self.doc.model_entity(ref)["patrol"]["route"]), 2)

    # ---- 右键删顶点 --------------------------------------------------------

    def test_right_click_deletes_a_vertex(self) -> None:
        self.doc.set_selection([self.ZONE])
        self.assertTrue(self.poly.delete_vertex_at(QPointF(600, 100)))
        self.assertEqual(len(self.doc.model_entity(self.ZONE)["polygon"]), 3)

    def test_cannot_delete_below_three_vertices(self) -> None:
        self.doc.set_selection([self.ZONE])
        self.poly.delete_vertex_at(QPointF(600, 100))
        self.assertFalse(self.poly.delete_vertex_at(QPointF(700, 100)),
                         "多边形被删到少于 3 点 —— 那不再是多边形")
        self.assertEqual(len(self.doc.model_entity(self.ZONE)["polygon"]), 3)

    # ---- 碰撞面：局部坐标写回 ---------------------------------------------

    def test_collision_polygon_writes_back_in_local_space(self) -> None:
        """碰撞面画在世界坐标、存的是局部坐标 —— 写回必须减锚点。

        写错的后果是静默错位：画面看着对、命中面偏了。
        """
        ref = EntityRef("hotspot", "h_poly")
        self.doc.set_selection([ref])
        # 锚点 (400,400)，首个顶点局部 (-50,-50) → 世界 (350,350)
        self.assertTrue(self.press(self.poly, 350, 350))
        self.move_to(self.poly, 340, 340)
        self.release(self.poly, 340, 340)
        poly = self.doc.model_entity(ref)["collisionPolygon"]
        self.assertEqual((poly[0]["x"], poly[0]["y"]), (-60.0, -60.0),
                         "碰撞面写回时没有减锚点 —— 存成世界坐标会静默错位")
        self.assertIs(self.doc.model_entity(ref)["collisionPolygonLocal"], True)


class ViewLedgerTests(_ToolTestBase):
    """视图的一本账 + 显隐是同步的最后一行。"""

    def test_items_are_built_for_every_known_part(self) -> None:
        self.assertIsNotNone(self.view.item_for(EntityRef("npc", "n1"), "handle"))
        self.assertIsNotNone(self.view.item_for(EntityRef("npc", "n1"), "patrol"))
        self.assertIsNotNone(self.view.item_for(EntityRef("zone", "z1"), "polygon"))
        self.assertIsNotNone(
            self.view.item_for(EntityRef("hotspot", "h_poly"), "collision"))

    def test_entity_without_polygon_gets_no_polygon_item(self) -> None:
        """没有多边形 = 不该有图元（不是"藏起来"，是不存在）。"""
        self.assertIsNone(self.view.item_for(EntityRef("hotspot", "h1"), "collision"))

    def test_presence_filter_hides_every_part(self) -> None:
        """过滤必须落到**每一个** part 上 —— 老画布漏了精灵那一层。"""
        ref = EntityRef("npc", "n1")
        self.view.set_presence_filter(lambda r, ent: r != ref)
        for item in self.view.items_of(ref):
            self.assertFalse(item.isVisible(), "有 part 没跟着藏")
        other = self.view.items_of(EntityRef("zone", "z1"))
        self.assertTrue(all(i.isVisible() for i in other))

    def test_presence_survives_a_resync(self) -> None:
        """被过滤的实体，重新同步一次后**仍然**是藏的。

        这是"重建丢显隐"那一族的直接堵漏：显隐是 `_sync_entity` 的最后一行，
        不是一个可以忘记调用的独立步骤。
        """
        ref = EntityRef("npc", "n1")
        self.view.set_presence_filter(lambda r, ent: r != ref)
        self.view._sync_entity(ref)
        for item in self.view.items_of(ref):
            self.assertFalse(item.isVisible(), "重新同步后过滤结论被冲掉了")

    def test_removed_entity_drops_all_its_items(self) -> None:
        ref = EntityRef("npc", "n1")
        self.doc.about_to_remove([ref])
        sc = self.doc.scene()
        sc["npcs"] = [n for n in sc["npcs"] if n["id"] != "n1"]
        self.doc.removed([ref])
        self.assertEqual(self.view.items_of(ref), [])

    def test_selection_marks_items(self) -> None:
        ref = EntityRef("zone", "z1")
        self.doc.set_selection([ref])
        item = self.view.item_for(ref, "polygon")
        self.assertTrue(item._selected)


if __name__ == "__main__":
    unittest.main()
