"""覆盖物（分组框 / 透视轴 / 橡皮筋）与实体树的验收。

覆盖物的命中由**工具用显式几何判定**，不靠 Qt 按 z 派发 —— 所以"组框把实体的
点击吞掉""轴线横贯全场挡住一切"这两类问题没有发生的余地。本文件逐条锁住。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPointF, Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.editors.scene_v2.overlays import (
    GroupBoxItem,
    PerspectiveAxisItem,
    RubberBandItem,
)
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.editors.scene_v2.tools_overlays import group_bounds
from tools.editor.project_model import ProjectModel
from tools.editor.shared.scene_view_filters import ViewAxes
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_SCENE = "覆盖物街"
_LEFT = Qt.MouseButton.LeftButton
_NO_MOD = Qt.KeyboardModifier.NoModifier


def _scene() -> dict:
    return {
        "id": _SCENE, "name": _SCENE, "worldWidth": 800, "worldHeight": 600,
        "perspectiveScale": {"near": {"x": 100, "y": 500, "scale": 1.2},
                             "far": {"x": 100, "y": 100, "scale": 0.6}},
        "entityGroups": [{"id": "夜巡", "label": "夜巡队"}],
        "hotspots": [
            {"id": "h1", "type": "inspect", "x": 200, "y": 200, "group": "夜巡"},
            {"id": "h_hidden", "type": "inspect", "x": 400, "y": 300,
             "group": "夜巡", "planes": ["yin"]},
        ],
        "npcs": [], "zones": [],
    }


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        self.model = ProjectModel()
        self.model.load_project(root)
        self.model.scenes[_SCENE] = _scene()
        self.page = SceneEditorV2(self.model)
        self.page.load_scene(_SCENE)

    def tearDown(self) -> None:
        self.page.deleteLater()
        QApplication.processEvents()
        self._tmp.cleanup()


class GroupBoxTests(_Base):
    def test_box_is_created_for_each_group(self) -> None:
        self.assertIn("夜巡", self.page.view.group_boxes)

    def test_bounds_include_filtered_out_members(self) -> None:
        """包围盒从模型层名册算 —— 被藏起来的成员照样算进去。

        不然框会随着切视图忽大忽小，而成员其实一个没少。
        """
        before = group_bounds(self.page.document, "夜巡")
        self.page.set_view_axes(ViewAxes(plane_id="yang"))
        self.page.refresh_group_boxes()
        after = group_bounds(self.page.document, "夜巡")
        self.assertEqual(before, after)

    def test_bounds_cover_every_member_not_just_the_last(self) -> None:
        """点实体的矩形是零尺寸，`QRectF.united` 会把它当 null 丢掉 ——
        直接对全部点取 min/max，否则一组点实体的包围盒会塌成最后一个成员。

        框还要**向外留白**（`GROUP_BOX_PAD`）：贴着成员画的话框线正好压在最外侧
        成员脚下，看起来没框住，而且框边的命中带会吃掉那几个成员的点击。
        """
        from tools.editor.editors.scene_v2.tools_overlays import GROUP_BOX_PAD

        rect = group_bounds(self.page.document, "夜巡")
        self.assertIsNotNone(rect)
        pad = GROUP_BOX_PAD
        self.assertEqual((rect.left(), rect.top()), (200.0 - pad, 200.0 - pad))
        self.assertEqual((rect.right(), rect.bottom()), (400.0 + pad, 300.0 + pad))
        self.assertGreater(pad, 0.0, "没有留白 = 框线压在成员身上")

    def test_single_member_group_still_has_a_visible_box(self) -> None:
        """单成员（甚至零尺寸）的组也要有看得见、点得中的框。

        零尺寸矩形会让 `paint` 直接早退 —— 那个组在画布上既看不见也选不中，
        整组位移/微移全部够不到，用户会以为分组丢了。
        """
        sc = self.page.document.scene()
        for ent in sc.get("hotspots") or []:
            ent.pop("group", None)
        for ent in sc.get("npcs") or []:
            ent.pop("group", None)
        for ent in sc.get("zones") or []:
            ent.pop("group", None)
        (sc.get("hotspots") or [{}])[0]["group"] = "夜巡"
        rect = group_bounds(self.page.document, "夜巡")
        self.assertIsNotNone(rect, "单成员组算不出包围盒")
        self.assertGreater(rect.width(), 0.0, "单成员组的框是零尺寸 —— 画不出来")
        self.assertGreater(rect.height(), 0.0)

    def test_edge_hits_but_interior_passes_through(self) -> None:
        """只有边线带算命中 —— 否则大框会把里面的一切都吞掉。"""
        box = self.page.view.group_boxes["夜巡"]
        centre = box._rect.center()
        self.assertFalse(box.hit_edge(centre), "框内空白不该算命中")
        left_edge = QPointF(box._rect.left(), centre.y())
        self.assertTrue(box.hit_edge(left_edge), "边线上应当算命中")

    def test_pick_band_cannot_swallow_the_whole_box(self) -> None:
        """缩到极远时 `屏幕像素/scale` 会算出荒唐的世界宽度（实测 0.04 倍下
        9px → 225 世界单位），命中带把整个框连同周围一大片全吞掉。"""
        box = self.page.view.group_boxes["夜巡"]
        box.set_view_scale(0.01)
        shortest = min(box._rect.width(), box._rect.height())
        self.assertLessEqual(box._pad(), shortest / 4.0 + 1e-9)
        self.assertFalse(box.hit_edge(box._rect.center()),
                         "极远缩放下框心被命中带吞掉了")

    def test_first_click_selects_without_moving(self) -> None:
        """两段式：没选中的组，边线按下只选中不拖。

        否则用户想从那儿起手拉橡皮筋框选，实际把整组悄悄挪走了。
        """
        tool = self.page.group_box_tool
        box = self.page.view.group_boxes["夜巡"]
        edge = QPointF(box._rect.left(), box._rect.center().y())
        self.assertTrue(tool.mouse_pressed(edge, _LEFT, _NO_MOD))
        self.assertEqual(tool.selected_gid, "夜巡")
        tool.mouse_moved(QPointF(edge.x() + 100, edge.y()), _LEFT, _NO_MOD)
        tool.mouse_released(QPointF(edge.x() + 100, edge.y()), _LEFT, _NO_MOD)
        self.assertEqual(self.model.scenes[_SCENE]["hotspots"][0]["x"], 200,
                         "第一次点边线就把整组挪走了")

    def test_second_drag_moves_the_group(self) -> None:
        tool = self.page.group_box_tool
        box = self.page.view.group_boxes["夜巡"]
        edge = QPointF(box._rect.left(), box._rect.center().y())
        tool.mouse_pressed(edge, _LEFT, _NO_MOD)          # 选中
        tool.mouse_pressed(edge, _LEFT, _NO_MOD)          # 再按 = 开始拖
        tool.mouse_moved(QPointF(edge.x() + 50, edge.y() + 30), _LEFT, _NO_MOD)
        tool.mouse_released(QPointF(edge.x() + 50, edge.y() + 30), _LEFT, _NO_MOD)
        self.assertEqual(self.model.scenes[_SCENE]["hotspots"][0]["x"], 250)

    def test_hidden_member_moves_with_the_group(self) -> None:
        self.page.set_view_axes(ViewAxes(plane_id="yang"))
        tool = self.page.group_box_tool
        tool.select_group("夜巡")
        tool.nudge(10, 0, mergeable=False)
        self.assertEqual(self.model.scenes[_SCENE]["hotspots"][1]["x"], 410,
                         "被过滤藏起来的成员没跟着动 —— 半份移动的坏数据")

    def test_nudges_merge_into_one_command(self) -> None:
        tool = self.page.group_box_tool
        tool.select_group("夜巡")
        tool.nudge(1, 0, mergeable=False)
        for _ in range(5):
            tool.nudge(1, 0, mergeable=True)
        self.assertEqual(self.page.document.undo_stack.count(), 1)

    def test_box_is_removed_when_the_group_disappears(self) -> None:
        self.model.scenes[_SCENE]["entityGroups"] = []
        self.page.refresh_group_boxes()
        self.assertNotIn("夜巡", self.page.view.group_boxes)

    def test_selection_survives_a_refresh(self) -> None:
        """组的选中态不在 Qt 选择系统里，整批重建会把它丢掉、且回不来。"""
        tool = self.page.group_box_tool
        tool.select_group("夜巡")
        self.page.refresh_group_boxes()
        self.assertIs(self.page.view.group_boxes["夜巡"], tool._boxes["夜巡"])


class PerspectiveAxisTests(_Base):
    def test_axis_is_shown_from_scene_config(self) -> None:
        axis = self.page.view.perspective_axis
        self.assertTrue(axis.isVisible())
        self.assertEqual((axis.near.x(), axis.near.y()), (100.0, 500.0))

    def test_only_endpoints_are_hittable(self) -> None:
        """轴线本身穿透 —— 一条横贯全场的线不该挡住下面的实体。"""
        axis = self.page.view.perspective_axis
        self.assertEqual(axis.hit_endpoint(QPointF(100, 500)), "near")
        self.assertEqual(axis.hit_endpoint(QPointF(100, 100)), "far")
        self.assertIsNone(axis.hit_endpoint(QPointF(100, 300)),
                          "轴线中段不该算命中")

    def test_endpoint_radius_cannot_cover_the_midpoint(self) -> None:
        """不封顶的话，极远缩放时两个端点的命中圈会重叠、中段也算命中，
        于是一条横贯全场的线把下面的实体全挡住。"""
        axis = self.page.view.perspective_axis
        axis.set_view_scale(0.005)
        length = 400.0     # near(100,500) → far(100,100)
        self.assertLessEqual(axis._r(), length / 4.0 + 1e-9)
        self.assertIsNone(axis.hit_endpoint(QPointF(100, 300)))

    def test_dragging_an_endpoint_is_undoable(self) -> None:
        tool = self.page.persp_tool
        self.assertTrue(tool.mouse_pressed(QPointF(100, 500), _LEFT, _NO_MOD))
        tool.mouse_moved(QPointF(150, 520), _LEFT, _NO_MOD)
        tool.mouse_released(QPointF(150, 520), _LEFT, _NO_MOD)
        cfg = self.model.scenes[_SCENE]["perspectiveScale"]
        self.assertEqual((cfg["near"]["x"], cfg["near"]["y"]), (150.0, 520.0))
        self.page.editor_undo()
        cfg = self.model.scenes[_SCENE]["perspectiveScale"]
        self.assertEqual((cfg["near"]["x"], cfg["near"]["y"]), (100, 500))

    def test_drag_preserves_the_other_endpoint_and_scales(self) -> None:
        tool = self.page.persp_tool
        tool.mouse_pressed(QPointF(100, 500), _LEFT, _NO_MOD)
        tool.mouse_released(QPointF(150, 520), _LEFT, _NO_MOD)
        cfg = self.model.scenes[_SCENE]["perspectiveScale"]
        self.assertEqual(cfg["far"], {"x": 100, "y": 100, "scale": 0.6})
        self.assertEqual(cfg["near"]["scale"], 1.2, "拖端点不该弄丢该端的 scale")

    def test_no_data_written_until_release(self) -> None:
        tool = self.page.persp_tool
        tool.mouse_pressed(QPointF(100, 500), _LEFT, _NO_MOD)
        tool.mouse_moved(QPointF(150, 520), _LEFT, _NO_MOD)
        cfg = self.model.scenes[_SCENE]["perspectiveScale"]
        self.assertEqual(cfg["near"]["x"], 100)

    def test_escape_writes_nothing(self) -> None:
        tool = self.page.persp_tool
        tool.mouse_pressed(QPointF(100, 500), _LEFT, _NO_MOD)
        tool.mouse_moved(QPointF(150, 520), _LEFT, _NO_MOD)
        self.assertTrue(tool.cancel_gesture())
        self.assertEqual(self.page.document.undo_stack.count(), 0)

    def test_scene_without_config_hides_the_axis(self) -> None:
        self.model.scenes[_SCENE].pop("perspectiveScale")
        self.page.refresh_perspective_axis()
        self.assertFalse(self.page.view.perspective_axis.isVisible())


class LightCurveTests(_Base):
    """光环境曲线：场景级点列，走与实体几何**同一套**编辑与撤销。"""

    def setUp(self) -> None:
        super().setUp()
        self.model.scenes[_SCENE]["lightEnvCurve"] = [
            {"x": 100, "y": 100, "env": {"toneStrength": 0.4}},
            {"x": 300, "y": 100, "env": {"toneStrength": 0.8}},
        ]
        self.page.load_scene(_SCENE)
        self.scene_ref = EntityRef("scene", _SCENE)

    def curve(self) -> list:
        return self.model.scenes[_SCENE]["lightEnvCurve"]

    def test_curve_item_exists(self) -> None:
        self.assertIsNotNone(self.page.view.item_for(self.scene_ref, "lightcurve"))

    def test_editable_without_selecting_any_entity(self) -> None:
        """光曲线不属于任何实体，不该要求"先选中某个实体"才能编辑。"""
        self.page.document.clear_selection()
        tool = self.page.polygon_tool
        self.assertTrue(tool.mouse_pressed(QPointF(100, 100), _LEFT, _NO_MOD))
        tool.mouse_moved(QPointF(120, 130), _LEFT, _NO_MOD)
        tool.mouse_released(QPointF(120, 130), _LEFT, _NO_MOD)
        self.assertEqual((self.curve()[0]["x"], self.curve()[0]["y"]), (120.0, 130.0))

    def test_dragging_keeps_the_env_payload(self) -> None:
        """**每个控制点都驮着一份完整 env 关键帧** —— 只写 x/y 会把它整份丢掉，
        而画面要下一次打光才看得出来，属于最难查的静默数据丢失。"""
        tool = self.page.polygon_tool
        tool.mouse_pressed(QPointF(100, 100), _LEFT, _NO_MOD)
        tool.mouse_released(QPointF(120, 130), _LEFT, _NO_MOD)
        self.assertEqual(self.curve()[0]["env"], {"toneStrength": 0.4})
        self.assertEqual(self.curve()[1]["env"], {"toneStrength": 0.8})

    def test_insert_inherits_env_from_a_neighbour(self) -> None:
        """新插入的控制点继承相邻点的 env，而不是留空 —— 留空会让那一段没光。"""
        tool = self.page.polygon_tool
        self.assertTrue(
            tool.mouse_double_clicked(QPointF(200, 100), _LEFT, _NO_MOD))
        self.assertEqual(len(self.curve()), 3)
        self.assertIn("env", self.curve()[1])

    def test_edit_is_undoable(self) -> None:
        tool = self.page.polygon_tool
        tool.mouse_pressed(QPointF(100, 100), _LEFT, _NO_MOD)
        tool.mouse_released(QPointF(120, 130), _LEFT, _NO_MOD)
        self.page.editor_undo()
        self.assertEqual((self.curve()[0]["x"], self.curve()[0]["y"]), (100, 100))
        self.assertEqual(self.curve()[0]["env"], {"toneStrength": 0.4})

    def test_open_polyline_semantics(self) -> None:
        """光曲线是**开放**折线，首尾之间没有边。"""
        item = self.page.view.item_for(self.scene_ref, "lightcurve")
        self.assertFalse(item.closed)

    def test_scene_without_a_curve_has_no_item(self) -> None:
        self.model.scenes[_SCENE].pop("lightEnvCurve")
        self.page.load_scene(_SCENE)
        self.assertIsNone(
            self.page.view.item_for(EntityRef("scene", _SCENE), "lightcurve"))


class OverlaysAreNotHitCandidatesTests(_Base):
    """覆盖物**永不进命中白名单** —— 结构性保证，不靠逐个 isinstance 排除。"""

    def test_select_tool_ignores_overlays(self) -> None:
        tool = self.page.select_tool
        items = [self.page.view.perspective_axis,
                 self.page.view.rubber_band,
                 *self.page.view.group_boxes.values(),
                 *self.page.view.entity_items()]
        hits = tool.entities_at(QPointF(200, 200), items)
        for h in hits:
            self.assertNotIsInstance(h, (GroupBoxItem, PerspectiveAxisItem,
                                         RubberBandItem))


class EntityTreeTests(_Base):
    def test_tree_lists_every_entity(self) -> None:
        labels = []
        root = self.page._tree.invisibleRootItem()
        for i in range(root.childCount()):
            top = root.child(i)
            for j in range(top.childCount()):
                labels.append(top.child(j).text(0))
        self.assertIn("h1", labels)
        self.assertIn("h_hidden", labels)

    def test_selecting_in_the_tree_selects_on_canvas(self) -> None:
        root = self.page._tree.invisibleRootItem()
        node = root.child(0).child(0)
        node.setSelected(True)
        self.page._on_tree_selection_changed()
        self.assertEqual(self.page.document.selection, (EntityRef("hotspot", "h1"),))

    def test_canvas_selection_reflects_in_the_tree(self) -> None:
        self.page.document.set_selection([EntityRef("hotspot", "h_hidden")])
        root = self.page._tree.invisibleRootItem()
        node = root.child(0).child(1)
        self.assertTrue(node.isSelected())

    def test_tree_updates_after_delete(self) -> None:
        self.page.document.set_selection([EntityRef("hotspot", "h1")])
        self.page.delete_selected()
        labels = []
        root = self.page._tree.invisibleRootItem()
        for i in range(root.childCount()):
            top = root.child(i)
            for j in range(top.childCount()):
                labels.append(top.child(j).text(0))
        self.assertNotIn("h1", labels)


if __name__ == "__main__":
    unittest.main()
