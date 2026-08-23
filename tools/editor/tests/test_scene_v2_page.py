"""新画布页的装配与**主窗口鸭子协议钩子**。

`mainwindow-editor-hooks` 机制卡的原话：**缺钩子不报错、静默漏网**。
所以这里逐个钩子上锁，而不是"能构造出来就算过"。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPointF, Qt
from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityProperty, EntityRef
from tools.editor.editors.scene_v2.commands import build_change_fields_command
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.project_model import ProjectModel
from tools.editor.shared.scene_view_filters import ViewAxes
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_SCENE = "新画布街"


def _scene() -> dict:
    return {
        "id": _SCENE, "name": _SCENE, "worldWidth": 800, "worldHeight": 600,
        "hotspots": [
            {"id": "h1", "type": "inspect", "x": 100, "y": 100},
            {"id": "h_yin", "type": "inspect", "x": 200, "y": 100, "planes": ["yin"]},
        ],
        "npcs": [
            {"id": "n1", "name": "甲", "x": 300, "y": 300},
            {"id": "n_night", "name": "更夫", "x": 400, "y": 300, "phases": ["夜"]},
        ],
        "zones": [{"id": "z1", "polygon": [{"x": 600, "y": 100},
                                           {"x": 700, "y": 100},
                                           {"x": 700, "y": 200}]}],
        # 出生点：**结构件**，不带 planes/phases，也不受三条视图轴管辖
        "spawnPoint": {"x": 50, "y": 500},
        "spawnPoints": {"north": {"x": 700, "y": 50}},
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


class PageAssemblyTests(_Base):
    def test_scene_loads_with_document_and_view(self) -> None:
        self.assertEqual(self.page.current_scene_id, _SCENE)
        self.assertIsNotNone(self.page.document)
        self.assertIsNotNone(self.page.view)

    def test_every_tool_is_registered_and_one_is_active(self) -> None:
        ids = {t.tool_id for t in self.page.view.tools.tools}
        # `group_move` **刻意不进工具栏**：它没有 mouse_pressed，切过去画布装死。
        # 整组拖动在 `group_box` 里（点框选中、再拖就是整组走）。
        self.assertTrue(
            {"select", "move", "polygon", "transform", "group_box",
             "create_hotspot", "create_npc", "create_zone"} <= ids,
            f"少了工具：{ids}")
        self.assertNotIn("group_move", ids, "死按钮又回到工具栏上了")
        self.assertIsNotNone(self.page.view.tools.current)

    def test_toolbar_checkstate_follows_the_active_tool(self) -> None:
        """勾选态必须互斥且跟着当前工具走 —— v2 里"现在是哪个工具"决定了按下
        鼠标会发生什么，对不上时用户无从判断自己在哪个模式。"""
        checked = [tid for tid, act in self.page._tool_actions.items()
                   if act.isChecked()]
        self.assertEqual(checked, ["select"], f"启动时勾选态不对：{checked}")
        self.page.view.tools.select(self.page.polygon_tool)
        checked = [tid for tid, act in self.page._tool_actions.items()
                   if act.isChecked()]
        self.assertEqual(checked, ["polygon"], f"切工具后勾选态不对：{checked}")

    def test_create_tools_say_what_they_create(self) -> None:
        names = {t.tool_id: t.display_name for t in self.page.view.tools.tools
                 if t.tool_id.startswith("create")}
        self.assertEqual(len(set(names.values())), 3,
                         f"三个新建工具重名，只能靠试点来挑：{names}")

    def test_items_exist_for_loaded_entities(self) -> None:
        self.assertIsNotNone(
            self.page.view.item_for(EntityRef("hotspot", "h1"), "handle"))
        self.assertIsNotNone(
            self.page.view.item_for(EntityRef("zone", "z1"), "polygon"))

    def test_switching_scene_rebuilds(self) -> None:
        self.model.scenes["另一条街"] = dict(_scene(), id="另一条街", name="另一条街")
        self.page.refresh_scene_list()
        self.assertTrue(self.page.load_scene("另一条街"))
        self.assertEqual(self.page.current_scene_id, "另一条街")

    def test_loading_an_unknown_scene_is_refused(self) -> None:
        self.assertFalse(self.page.load_scene("不存在"))


class BackgroundTests(_Base):
    """背景走与老画布、坐标点选器**同一个**解析出口（只认 background.png）。"""

    def test_background_item_exists(self) -> None:
        self.assertIsNotNone(self.page.view._background)

    def test_missing_background_shows_a_note_not_a_blank(self) -> None:
        """对着纯色空画布盲点坐标时，策划分不清"没有背景"和"加载失败"。"""
        self.assertTrue(self.page.view._background._note,
                        "没有背景时应当给一句占位说明")

    def test_world_size_drives_the_background_rect(self) -> None:
        rect = self.page.view._background.boundingRect()
        self.assertEqual((rect.width(), rect.height()), (800.0, 600.0))

    def test_wrong_filename_is_refused_like_the_old_canvas(self) -> None:
        """文件名不是 background.png 一律拒绝 —— 否则会显示一张游戏不加载的图。"""
        sc = self.model.scenes[_SCENE]
        sc["backgrounds"] = [{"image": "别的名字.png"}]
        self.page._refresh_background()
        self.assertIsNone(self.page.view._background._pix)
        self.assertIn("background.png", self.page.view._background._note)


class ViewAxesWiringTests(_Base):
    def test_plane_axis_hides_non_members(self) -> None:
        self.page.set_view_axes(ViewAxes(plane_id="yang"))
        hidden = self.page.view.items_of(EntityRef("hotspot", "h_yin"))
        self.assertTrue(hidden and all(not i.isVisible() for i in hidden))
        shown = self.page.view.items_of(EntityRef("hotspot", "h1"))
        self.assertTrue(shown and all(i.isVisible() for i in shown))

    def test_phase_axis_uses_the_kind_fork(self) -> None:
        """未写 phases 的 NPC 夜里不在街上；热点照常在。"""
        self.page.set_view_axes(
            ViewAxes(phase_id="夜", npc_default_phases=("辰", "午")))
        npc = self.page.view.items_of(EntityRef("npc", "n1"))
        self.assertTrue(npc and all(not i.isVisible() for i in npc))
        hs = self.page.view.items_of(EntityRef("hotspot", "h1"))
        self.assertTrue(hs and all(i.isVisible() for i in hs))
        night = self.page.view.items_of(EntityRef("npc", "n_night"))
        self.assertTrue(night and all(i.isVisible() for i in night))

    def test_spawn_points_survive_an_exclusive_plane_view(self) -> None:
        """出生点在**独立世界型**位面视图下必须照样在。

        它没有 `planes` 键，若与实体走同一条判定就会落进"缺省实体在 exclusive
        位面里不存在"那一支 —— 一切到梦境位面，出生点全体消失、没法编辑。
        老画布靠"没登记过的实体不施加显隐"避开，新画布得把这条闸写明。
        """
        self.page.set_view_axes(ViewAxes(plane_id="dream", plane_exclusive=True))
        for name in ("default", "north"):
            items = self.page.view.items_of(EntityRef("spawn", name))
            self.assertTrue(items, f"前置条件：出生点 {name} 应当有图元")
            self.assertTrue(all(i.isVisible() for i in items),
                            f"出生点 {name} 被位面轴藏掉了")

    def test_exclusive_plane_still_hides_default_entities(self) -> None:
        """反向锁：放行出生点不等于把 exclusive 语义整个放掉。"""
        self.page.set_view_axes(ViewAxes(plane_id="dream", plane_exclusive=True))
        items = self.page.view.items_of(EntityRef("hotspot", "h1"))
        self.assertTrue(items and all(not i.isVisible() for i in items))

    def test_clearing_axes_shows_everything(self) -> None:
        self.page.set_view_axes(ViewAxes(plane_id="yang"))
        self.page.set_view_axes(ViewAxes())
        for ref in (EntityRef("hotspot", "h_yin"), EntityRef("npc", "n1")):
            self.assertTrue(all(i.isVisible() for i in self.page.view.items_of(ref)))

    def test_filter_survives_a_scene_reload(self) -> None:
        """切场景/重载后必须按当前轴重新套用 —— 否则过滤静默失效，
        画布显示的是"全部"，而策划以为那就是该时段的样子。"""
        self.page.set_view_axes(ViewAxes(plane_id="yang"))
        self.page.load_scene(_SCENE)
        hidden = self.page.view.items_of(EntityRef("hotspot", "h_yin"))
        self.assertTrue(hidden and all(not i.isVisible() for i in hidden))


class ReloadChurnTests(_Base):
    """主窗口每次切页都调 `reload_from_model()` —— 它必须只装载**一次**。"""

    def test_reload_does_not_rebuild_when_the_scene_object_is_unchanged(self) -> None:
        """场景 dict 还是同一个对象时，重投影不该重建 Document/View。

        重建的代价是**视口位置与撤销历史一起没** —— 而主窗口每次切页都会调
        `reload_from_model`：逐个摆位时每查一次别的页就丢一次现场。
        """
        calls: list[str] = []
        real = self.page.load_scene
        self.page.load_scene = lambda sid, _r=real, _c=calls: (_c.append(sid), _r(sid))[1]
        doc_before = self.page.document
        try:
            self.page.reload_from_model()
        finally:
            del self.page.load_scene
        self.assertEqual(calls, [], f"同一份场景还被重新装载了：{calls}")
        self.assertIs(self.page.document, doc_before, "Document 被换掉了")

    def test_reload_keeps_the_undo_history(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        self.page.document.push(build_change_fields_command(
            self.page.document, [ref], [{"x": 321}],
            EntityProperty.POSITION, "移动"))
        self.assertEqual(self.page.document.undo_stack.count(), 1)
        self.page.reload_from_model()
        self.assertEqual(self.page.document.undo_stack.count(), 1,
                         "切页把撤销历史清掉了 —— 误操作再也退不回去")
        self.page.editor_undo()
        self.assertEqual(
            self.page.document.model_entity(ref)["x"], 100)

    def test_reload_rebuilds_when_the_scene_object_was_replaced(self) -> None:
        """别的编辑器**换掉了场景 dict 对象**（Task 编排/导入）时必须重建。"""
        doc_before = self.page.document
        self.model.scenes[_SCENE] = dict(self.model.scenes[_SCENE])
        self.page.reload_from_model()
        self.assertIsNot(self.page.document, doc_before,
                         "场景域被替换了却还在用旧 Document")

    def test_reload_keeps_the_document_usable(self) -> None:
        self.page.document.set_selection([EntityRef("hotspot", "h1")])
        self.page.reload_from_model()
        self.assertEqual(self.page.current_scene_id, _SCENE)
        self.assertEqual(self.page.document.selection, (EntityRef("hotspot", "h1"),),
                         "重投影把选择丢了")

    def test_refresh_scene_list_highlights_the_current_scene(self) -> None:
        self.page.refresh_scene_list()
        item = self.page._scene_list.currentItem()
        self.assertIsNotNone(item, "清单没有高亮当前场景")
        self.assertEqual(item.data(Qt.ItemDataRole.UserRole), _SCENE)


class DuckProtocolHookTests(_Base):
    """五个钩子逐个上锁 —— 缺钩子不报错、静默漏网。"""

    def test_all_five_hooks_exist_and_are_callable(self) -> None:
        for name in ("flush_to_model", "commit_pending_on_leave", "confirm_close",
                     "reload_from_model", "editor_undo"):
            self.assertTrue(callable(getattr(self.page, name, None)),
                            f"缺少鸭子协议钩子 {name} —— 主窗口会把本页当缺钩子锁死")

    def test_flush_and_commit_report_success(self) -> None:
        """本页没有 staging 层，不存在"未应用"状态，故恒为 True。"""
        self.assertTrue(self.page.flush_to_model())
        self.assertTrue(self.page.commit_pending_on_leave())
        self.assertTrue(self.page.confirm_close())

    def test_editor_undo_drives_the_document_stack(self) -> None:
        ref = EntityRef("npc", "n1")
        self.page.document.set_selection([ref])
        self.page.duplicate_selected()
        self.assertEqual(len(self.model.scenes[_SCENE]["npcs"]), 3)
        self.page.editor_undo()
        self.assertEqual(len(self.model.scenes[_SCENE]["npcs"]), 2)

    def test_editor_redo_replays(self) -> None:
        self.page.document.set_selection([EntityRef("npc", "n1")])
        self.page.duplicate_selected()
        self.page.editor_undo()
        self.page.editor_redo()
        self.assertEqual(len(self.model.scenes[_SCENE]["npcs"]), 3)

    def test_reload_from_model_keeps_the_selection(self) -> None:
        """不保住选择的话，Task 编排替换场景后看着像"我编辑的东西没了"。"""
        ref = EntityRef("npc", "n1")
        self.page.document.set_selection([ref])
        self.page.reload_from_model()
        self.assertIn(ref, self.page.document.selection)

    def test_reload_drops_a_selection_that_no_longer_exists(self) -> None:
        ref = EntityRef("npc", "n1")
        self.page.document.set_selection([ref])
        sc = self.model.scenes[_SCENE]
        sc["npcs"] = [n for n in sc["npcs"] if n["id"] != "n1"]
        self.page.reload_from_model()
        self.assertNotIn(ref, self.page.document.selection)


class EditActionsTests(_Base):
    def test_delete_selected(self) -> None:
        self.page.document.set_selection([EntityRef("hotspot", "h1")])
        self.assertTrue(self.page.delete_selected())
        self.assertEqual([h["id"] for h in self.model.scenes[_SCENE]["hotspots"]],
                         ["h_yin"])

    def test_delete_removes_the_items_too(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        self.page.delete_selected()
        self.assertEqual(self.page.view.items_of(ref), [],
                         "实体删了、图元还留在画布上")

    def test_select_entity_for_cross_page_navigation(self) -> None:
        self.assertTrue(self.page.select_entity("npc", "n1"))
        self.assertEqual(self.page.document.selection, (EntityRef("npc", "n1"),))

    def test_select_missing_entity_reports_failure(self) -> None:
        self.assertFalse(self.page.select_entity("npc", "查无此人"))

    def test_undo_restores_deleted_items_on_canvas(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        self.page.delete_selected()
        self.page.editor_undo()
        self.assertNotEqual(self.page.view.items_of(ref), [],
                            "撤销删除后画布上没有把图元建回来")


class ScenePageRegistryIntegrationTests(_Base):
    """新页必须被场景页登记处认出来 —— 否则主窗口的提交/刷新会漏掉它。"""

    def test_registry_now_lists_the_new_page(self) -> None:
        from tools.editor import scene_page_registry as reg
        self.assertIn(SceneEditorV2, reg.scene_page_types())

    def test_navigation_target_still_points_at_exactly_one_page(self) -> None:
        from tools.editor import scene_page_registry as reg
        self.assertEqual(len(reg.navigation_scene_page_types()), 1)


if __name__ == "__main__":
    unittest.main()
