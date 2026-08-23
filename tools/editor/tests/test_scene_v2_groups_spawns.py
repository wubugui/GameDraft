"""分组与出生点在新画布上要**能编辑**，不只是能看。

回归清单里这一族的共性是"看得见、够不着"：分组框画出来了但选不中、点不开属性；
出生点在树里和画布上都在，却改不了名、建不了、删不掉。用户只能切回老画布。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPointF, Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.editors.scene_v2.groups import (
    all_group_ids,
    assign_group,
    create_group,
    delete_group,
)
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.editors.scene_v2.tools_structure import (
    create_spawn,
    delete_selected,
    delete_spawn,
)
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_NO_MOD = Qt.KeyboardModifier.NoModifier
_LEFT = Qt.MouseButton.LeftButton
_SCENE = "分组街"


def _scene() -> dict:
    return {
        "id": _SCENE, "name": _SCENE, "worldWidth": 900, "worldHeight": 700,
        "hotspots": [
            {"id": "h1", "type": "inspect", "x": 200, "y": 200, "group": "g1"},
            {"id": "h2", "type": "inspect", "x": 400, "y": 300, "group": "g1"},
            {"id": "h_free", "type": "inspect", "x": 700, "y": 600},
        ],
        "npcs": [], "zones": [],
        "entityGroups": [{"id": "g1", "label": "一组",
                          "conditions": [{"flag": "x"}]}],
        "spawnPoint": {"x": 50, "y": 650},
        "spawnPoints": {"north": {"x": 800, "y": 50}},
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
        self.doc = self.page.document
        self.view = self.page.view
        self.view.resize(900, 700)
        self.view.resetTransform()
        self.view.renderer.set_view_scale(1.0)

    def tearDown(self) -> None:
        self.page.deleteLater()
        QApplication.processEvents()
        self._tmp.cleanup()

    def scene(self) -> dict:
        return self.model.scenes[_SCENE]


class GroupIsAnEditableThingTests(_Base):
    """组的 id / label / 整组显影条件都是**数据**，不该只有画布上那个框。"""

    def test_selecting_a_group_loads_the_group_panel(self) -> None:
        self.page.group_box_tool.select_group("g1")
        loaded = self.page._bridge._loaded
        self.assertIsNotNone(loaded, "选中分组后面板没有落点")
        self.assertEqual((loaded.kind, loaded.id), ("group", "g1"))

    def test_group_row_is_reachable_as_an_entity(self) -> None:
        ent = self.doc.model_entity(EntityRef("group", "g1"))
        self.assertIsInstance(ent, dict)
        self.assertEqual(ent.get("label"), "一组")
        self.assertEqual(ent.get("conditions"), [{"flag": "x"}],
                         "整组显影条件读不到")

    def test_create_group_is_undoable(self) -> None:
        gid = create_group(self.doc, "g2", "二组")
        self.assertEqual(gid, "g2")
        self.assertIn("g2", all_group_ids(self.doc))
        self.page.editor_undo()
        self.assertNotIn("g2", all_group_ids(self.doc))

    def test_delete_group_also_clears_member_references(self) -> None:
        """删组要**同一条命令**里清掉成员的 group 键。

        分两条的话撤销会撤出"组没了但成员还挂着它"这种半份状态 ——
        那正好是兼容标签组的形态，画布上会凭空冒出一个没人认领的组。
        """
        self.assertTrue(delete_group(self.doc, "g1"))
        self.assertNotIn("g1", all_group_ids(self.doc))
        self.assertNotIn("group", self.scene()["hotspots"][0])
        self.page.editor_undo()
        self.assertIn("g1", all_group_ids(self.doc))
        self.assertEqual(self.scene()["hotspots"][0].get("group"), "g1")

    def test_assign_and_unassign(self) -> None:
        assign_group(self.doc, [EntityRef("hotspot", "h_free")], "g1")
        self.assertEqual(self.scene()["hotspots"][2].get("group"), "g1")
        assign_group(self.doc, [EntityRef("hotspot", "h_free")], "")
        self.assertNotIn("group", self.scene()["hotspots"][2],
                         "移出分组该删键，不该写空串"
                         "（空串会让它变成'属于一个叫空串的组'）")

    def test_tag_only_group_is_listed(self) -> None:
        """只在成员身上出现的兼容标签组也要进名录。"""
        self.scene()["hotspots"][2]["group"] = "标签组"
        self.assertIn("标签组", all_group_ids(self.doc))

    def test_tree_can_show_groups(self) -> None:
        self.page._tree_mode.setCurrentIndex(1)
        labels = []
        for i in range(self.page._tree.topLevelItemCount()):
            labels.append(self.page._tree.topLevelItem(i).text(0))
        self.assertTrue(any("g1" in t for t in labels),
                        f"按分组视图里没有分组节点：{labels}")

    def test_tree_filter_narrows_the_list(self) -> None:
        self.page._tree_filter.setText("h_free")
        found = []
        for i in range(self.page._tree.topLevelItemCount()):
            top = self.page._tree.topLevelItem(i)
            for j in range(top.childCount()):
                found.append(top.child(j).text(0))
        self.assertEqual(found, ["h_free"], f"过滤没生效：{found}")


class SpawnIsEditableTests(_Base):
    """出生点看得见、拖得动，也必须建得了、删得掉、改得了名。"""

    def test_selecting_a_spawn_loads_the_spawn_panel(self) -> None:
        self.doc.set_selection([EntityRef("spawn", "north")])
        loaded = self.page._bridge._loaded
        self.assertIsNotNone(loaded, "选中出生点后面板没有落点")
        self.assertEqual(loaded.kind, "spawn")

    def test_create_named_spawn(self) -> None:
        self.assertTrue(create_spawn(self.doc, "south", 100, 200))
        self.assertIn("south", self.scene()["spawnPoints"])
        self.page.editor_undo()
        self.assertNotIn("south", self.scene()["spawnPoints"])

    def test_delete_named_spawn(self) -> None:
        self.assertTrue(delete_spawn(self.doc, "north"))
        self.assertNotIn("north", self.scene().get("spawnPoints") or {})

    def test_default_spawn_cannot_be_deleted(self) -> None:
        """场景没有落点会直接坏掉 —— 默认出生点必须挡住。"""
        notes = []
        self.doc.notice.connect(notes.append)
        self.assertFalse(delete_spawn(self.doc, "default"))
        self.assertIn("x", str(self.scene()["spawnPoint"]))
        self.assertTrue(notes, "挡住了但一句话都没说")

    def test_delete_key_removes_a_selected_spawn(self) -> None:
        """Delete 键对出生点也要有效 —— 此前它落进空集合、按了毫无反应。"""
        self.doc.set_selection([EntityRef("spawn", "north")])
        self.assertTrue(delete_selected(self.doc))
        self.assertNotIn("north", self.scene().get("spawnPoints") or {})


class PanelButtonsAreWiredTests(_Base):
    """面板上那一排按钮不许是死的。"""

    def test_delete_button_signal_is_connected(self) -> None:
        """面板底部的「从场景删除」此前点了什么都不发生。"""
        self.doc.set_selection([EntityRef("hotspot", "h_free")])
        self.page._props.delete_current_entity_requested.emit()
        ids = [h["id"] for h in self.scene()["hotspots"]]
        self.assertNotIn("h_free", ids, "「从场景删除」是个死按钮")

    def test_group_delete_is_reachable_from_the_tree(self) -> None:
        """删组的入口在**树的右键菜单**（面板本身没有这个信号）。

        树没有右键菜单、快捷键又只挂在画布上时，"在左树里选中再删"这条最常用的
        路径整个不通 —— 而 v2 起初正是这样。
        """
        self.assertEqual(
            self.page._tree.contextMenuPolicy(),
            Qt.ContextMenuPolicy.CustomContextMenu,
            "实体树没有右键菜单")
        self.doc.set_selection([EntityRef("group", "g1")])
        self.page._on_group_delete("g1")
        self.assertNotIn("g1", all_group_ids(self.doc))

    def test_group_select_members_signal_is_connected(self) -> None:
        self.page._props.group_select_members_requested.emit("g1")
        self.assertEqual(
            {r.id for r in self.doc.selection}, {"h1", "h2"},
            "「选中本组全部成员」没接线")

    def test_group_translate_signal_is_connected(self) -> None:
        """分组面板的「应用位移」与画布拖组框走同一条写入通道。"""
        self.page._props.group_translate_requested.emit("g1", 10.0, 5.0)
        self.assertEqual(self.scene()["hotspots"][0]["x"], 210)
        self.assertEqual(self.scene()["hotspots"][0]["y"], 205)


class LightPlacementTests(_Base):
    """「在画布上定位选中的灯」——摆灯唯一顺手的入口。

    灯位是 3D 伪世界坐标，面板表单里**没有 x/y 输入框**：`pos` 只能靠
    "画布点一下取地面深度"得到。这条链路断掉时，新加的灯永远停在场景中心的
    缺省位置，作者没有任何办法把它挪走。
    """

    def test_mode_signal_is_connected(self) -> None:
        self.page._props.light_place_mode_changed.emit(True)
        self.assertTrue(self.page.light_place_tool.active_mode,
                        "面板的定位开关按下去了，画布这边没进模式")
        self.page._props.light_place_mode_changed.emit(False)
        self.assertFalse(self.page.light_place_tool.active_mode)

    def test_click_is_forwarded_to_the_panel_while_placing(self) -> None:
        got = []
        self.page._props.place_selected_light_at = (
            lambda x, y: (got.append((x, y)), True)[1])
        self.page._props.light_place_mode_changed.emit(True)
        self.page.select_tool.mouse_pressed(QPointF(321, 654), _LEFT, _NO_MOD)
        self.assertEqual(got, [(321.0, 654.0)], "点击没有转给面板去落灯")

    def test_click_is_not_swallowed_when_not_placing(self) -> None:
        """没开定位模式时，点击照常是点选 —— 不许把画布吃掉。"""
        got = []
        self.page._props.place_selected_light_at = (
            lambda x, y: (got.append((x, y)), True)[1])
        self.page.select_tool.mouse_pressed(QPointF(200, 200), _LEFT, _NO_MOD)
        self.assertEqual(got, [])
        self.assertEqual(self.doc.selection, (EntityRef("hotspot", "h1"),))


if __name__ == "__main__":
    unittest.main()
