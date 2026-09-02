"""属性面板接线 —— 老面板一行不改，但 staging 不再是第二份真相。

方案书 §3.4「死法二」：如果只是把 staging 原样搬过来而没有唯一裁决函数，新架构会在
第一个"整组平移写错副本"上**原样复现老 bug**，然后所有人得出"换架构没用"的结论。

所以这里的头号断言是：**`write_target` 恒指向模型**。面板的 staging 降级成它自己的
输入缓冲，Document 永远不读它。
"""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityProperty, EntityRef
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.editors.scene_v2.commands import _MISSING
from tools.editor.editors.scene_v2.panel_bridge import diff_fields
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_SCENE = "面板街"


def _scene() -> dict:
    return {
        "id": _SCENE, "name": _SCENE, "worldWidth": 800, "worldHeight": 600,
        "hotspots": [
            {"id": "h1", "type": "inspect", "x": 100, "y": 120,
             "interactionRange": 50, "unknownKey": {"keep": 1}},
            {"id": "h2", "type": "inspect", "x": 300, "y": 320,
             "interactionRange": 50},
        ],
        "npcs": [{"id": "n1", "name": "甲", "x": 200, "y": 200,
                  "interactionRange": 50}],
        "zones": [],
    }


class DiffFieldsTests(unittest.TestCase):
    """staging 是实体的**完整投影**（面板 `load_*_props` 里是 `copy.deepcopy(ent)`），
    所以两个方向都要比：值不同要写，**键消失要删**。"""

    def test_only_changed_keys_are_returned(self) -> None:
        self.assertEqual(diff_fields({"x": 1, "y": 2}, {"x": 1, "y": 5}), {"y": 2})

    def test_key_missing_from_staging_is_a_deletion(self) -> None:
        """"取消勾选 / 清空下拉"是靠**键消失**表达的，必须变成删键。

        此前这里断言的是"没出现在 staging 的键原样保留" —— 那条断言的前提
        （staging 只含面板管的键）与真实面板不符：`load_hotspot_props` 里
        `st = copy.deepcopy(hs)`，staging 从一开始就是全量副本。按旧断言写，
        取消勾选永远存不下来。
        """
        got = diff_fields({"x": 1}, {"x": 1, "cutsceneOnly": True})
        self.assertEqual(got, {"cutsceneOnly": _MISSING})

    def test_new_key_is_written(self) -> None:
        self.assertEqual(diff_fields({"scale": 2.0}, {}), {"scale": 2.0})

    def test_int_float_representation_is_not_a_change(self) -> None:
        """`100` 与 `100.0` 在**本层**视为没变 —— 保住模型里的整数表示。

        与命令层刻意相反，理由是输入性质不同：命令层收的是工具主动写下的值，
        这里收的是穿过控件的投影（spinbox 一律吐 float，面板的 x/y 实时回写
        更是硬编码 `float(...)`）。按表示判定的话，用户只拖了 x，同一实体的 y
        也会被写成 `320.0`，一次提交污染一串整数坐标。
        """
        self.assertEqual(diff_fields({"x": 100.0}, {"x": 100}), {})
        self.assertEqual(diff_fields({"x": 101.0}, {"x": 100}), {"x": 101.0})

    def test_bool_and_int_are_not_confused(self) -> None:
        """Python 里 `True == 1`。不单独挡就会把"勾选变成 1"当成没变。"""
        self.assertEqual(diff_fields({"flag": 1}, {"flag": True}), {"flag": 1})
        self.assertEqual(diff_fields({"flag": True}, {"flag": 1}), {"flag": True})

    def test_no_change_returns_empty(self) -> None:
        self.assertEqual(diff_fields({"x": 100, "y": 120}, {"x": 100, "y": 120}), {})

    def test_nested_values_are_deep_copied(self) -> None:
        staged = {"patrol": {"route": [{"x": 1, "y": 2}]}}
        got = diff_fields(staged, {})
        got["patrol"]["route"][0]["x"] = 999
        self.assertEqual(staged["patrol"]["route"][0]["x"], 1,
                         "写回的值与面板 staging 共享了引用")


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

    def ent(self, kind: str, eid: str) -> dict:
        return self.page.document.model_entity(EntityRef(kind, eid))


class WriteTargetAlwaysModelTests(_Base):
    """**本文件的头号断言。**"""

    def test_write_target_is_the_model_even_while_the_panel_is_editing(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])   # 面板已载入该实体
        target = self.page.document.write_target(ref)
        self.assertIs(target, self.ent("hotspot", "h1"),
                      "write_target 指向了面板 staging —— 两层真相原地复活")

    def test_document_reports_nothing_as_staged(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        self.assertFalse(self.page.document.is_staged(ref))

    def test_canvas_drag_writes_the_model_while_panel_has_it_open(self) -> None:
        """选中一个实体（面板已打开它）再拖动 —— 坐标必须落到模型，
        否则面板下一次 Apply 会用它的旧深拷贝把这次拖动整份盖掉。"""
        from PySide6.QtCore import QPointF, Qt
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        tool = self.page.move_tool
        tool.mouse_pressed(QPointF(100, 120), Qt.MouseButton.LeftButton,
                           Qt.KeyboardModifier.NoModifier)
        tool.mouse_moved(QPointF(150, 170), Qt.MouseButton.LeftButton,
                         Qt.KeyboardModifier.NoModifier)
        tool.mouse_released(QPointF(150, 170), Qt.MouseButton.LeftButton,
                            Qt.KeyboardModifier.NoModifier)
        self.assertEqual((self.ent("hotspot", "h1")["x"],
                          self.ent("hotspot", "h1")["y"]), (150.0, 170.0))


class RealWidgetCommitTests(_Base):
    """**从真实控件进**，不往 staging 里塞值。

    上一轮这里全绿却完全没测到真实通路：老面板的控件只调 `_emit_props_changed()`
    （标脏 + 发信号），staging 是靠 `flush_active_panel_widgets_to_staging()` 才刷新的，
    而当时的用例直接写 `_staging_hotspot`，恰好把那一步跳过去了。
    """

    def test_editing_a_spinbox_reaches_the_model(self) -> None:
        ref = EntityRef("hotspot", "h2")
        self.page.document.set_selection([ref])
        self.page._props._hs_x.setValue(301.0)
        self.page._bridge.commit_panel_edits()
        self.assertEqual(self.ent("hotspot", "h2")["x"], 301.0,
                         "控件里的编辑压根没进模型")

    def test_editing_x_does_not_float_ify_the_untouched_y(self) -> None:
        """只改 x，同一实体的 y 必须**保持整数表示**。

        面板的 x/y 实时回写是硬编码 `float(...)`，两个键一起写；若比对按
        int/float 表示判定，一次提交就会把没碰过的 y 写成 `320.0`。真实场景里
        成串的整数坐标会被逐个污染，黄金往返当场红。
        """
        ref = EntityRef("hotspot", "h2")
        self.page.document.set_selection([ref])
        before_y = self.ent("hotspot", "h2")["y"]
        self.assertIsInstance(before_y, int, "前置条件：y 在数据里是整数")
        self.page._props._hs_x.setValue(301.0)
        self.page._bridge.commit_panel_edits()
        after_y = self.ent("hotspot", "h2")["y"]
        self.assertEqual(after_y, before_y)
        self.assertIsInstance(after_y, int,
                              "没碰过的 y 被写成了浮点 —— 数值表示被污染")

    def test_selecting_an_entity_alone_changes_nothing(self) -> None:
        """光是**选中**不该改数据、不该进撤销栈。

        老面板的 `_write_*_widgets_to_dict` 会把它管的每个键都刷一遍：空文本框
        写成 `""`、空表写成 `{}`。若把这些当成改动，点一下实体就给它加上
        `label: ""` / `data: {}` —— 本仓约定"缺省不落键"，黄金往返当场红，
        而且撤销栈平白多一格、场景被标脏，用户什么都没干。
        """
        ref = EntityRef("hotspot", "h2")
        before = copy.deepcopy(self.ent("hotspot", "h2"))
        self.page.document.set_selection([ref])
        self.assertEqual(self.ent("hotspot", "h2"), before,
                         "光是选中就把面板缺省值写进了数据")
        self.assertEqual(self.page.document.undo_stack.count(), 0)

    def test_commit_without_any_widget_change_pushes_nothing(self) -> None:
        """光是选中（面板载入 + flush 一遍控件）不该产生任何命令。"""
        self.page.document.set_selection([EntityRef("hotspot", "h2")])
        self.assertFalse(self.page._bridge.commit_panel_edits())
        self.assertEqual(self.page.document.undo_stack.count(), 0)


class PanelEditsBecomeCommandsTests(_Base):
    def test_panel_edit_lands_in_the_model_as_a_command(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        self.assertIsNotNone(self.page._props._staging_hotspot,
                             "前置条件：面板应当已载入该实体")
        # **从控件进。** 直接写 staging 会被 `flush_active_panel_widgets_to_staging`
        # 用控件值原样盖掉 —— 那才是真实通路，绕过它等于什么都没测。
        self.page._props._hs_range.setValue(88)
        self.page._bridge.commit_panel_edits()
        self.assertEqual(self.ent("hotspot", "h1")["interactionRange"], 88)
        self.assertEqual(self.page.document.undo_stack.count(), 1)

    def test_panel_edit_is_undoable(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        self.page._props._hs_range.setValue(88)
        self.page._bridge.commit_panel_edits()
        self.page.editor_undo()
        self.assertEqual(self.ent("hotspot", "h1")["interactionRange"], 50)

    def test_no_change_pushes_nothing(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        self.assertFalse(self.page._bridge.commit_panel_edits())
        self.assertEqual(self.page.document.undo_stack.count(), 0)

    def test_unmanaged_keys_survive_a_panel_edit(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        self.page._props._hs_range.setValue(77)
        self.page._bridge.commit_panel_edits()
        self.assertEqual(self.ent("hotspot", "h1").get("unknownKey"), {"keep": 1},
                         "面板提交把未受管字段弄丢了 —— 黄金往返会红")

    def test_consecutive_edits_merge_into_one_command(self) -> None:
        """连续编辑（拖数值框）收成一条撤销记录。"""
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        for v in (60, 70, 80):
            self.page._props._hs_range.setValue(v)
            self.page._bridge.commit_panel_edits()
        self.assertEqual(self.page.document.undo_stack.count(), 1)
        self.page.editor_undo()
        self.assertEqual(self.ent("hotspot", "h1")["interactionRange"], 50,
                         "合并后的撤销必须一次回到编辑起点")

    def test_switching_entity_starts_a_new_command(self) -> None:
        a, b = EntityRef("hotspot", "h1"), EntityRef("hotspot", "h2")
        self.page.document.set_selection([a])
        self.page._props._hs_range.setValue(60)
        self.page._bridge.commit_panel_edits()
        self.page.document.set_selection([b])
        self.page._props._hs_range.setValue(90)
        self.page._bridge.commit_panel_edits()
        self.assertEqual(self.page.document.undo_stack.count(), 2,
                         "两个实体的编辑被并成一条 —— 撤销会把两个都退回去")

    def test_property_mask_is_specific_not_all(self) -> None:
        """改一个无关字段不该触发全量重建（重建要读盘，最贵）。"""
        from tools.editor.editors.scene_v2.panel_bridge import _properties_for
        self.assertEqual(_properties_for({"x": 1}), EntityProperty.POSITION)
        self.assertEqual(_properties_for({"spriteSort": "back"}), EntityProperty.SORT)
        self.assertNotEqual(_properties_for({"interactionRange": 10}),
                            EntityProperty.ALL)


class SelectionDrivesThePanelTests(_Base):
    def test_selecting_loads_the_entity_into_the_panel(self) -> None:
        self.page.document.set_selection([EntityRef("npc", "n1")])
        self.assertIsNotNone(self.page._props._staging_npc)
        self.assertEqual(self.page._props._staging_npc["id"], "n1")

    def test_multi_selection_does_not_load_a_single_entity(self) -> None:
        self.page.document.set_selection(
            [EntityRef("hotspot", "h1"), EntityRef("hotspot", "h2")])
        self.assertFalse(self.page._bridge.commit_panel_edits(),
                         "多选时不该把编辑当成某一个实体的")

    def test_panel_loads_a_deep_copy_not_the_model_dict(self) -> None:
        """面板拿的是深拷贝 —— 它直接改模型的话，撤销基线会被编辑本身污染。"""
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        self.assertIsNot(self.page._props._staging_hotspot,
                         self.ent("hotspot", "h1"))


class IdChangeFollowsTheLedgerTests(_Base):
    """改 id = 换身份。图元账按 `kind:id` 建键，命令必须把**旧新两个 ref** 都发出去。

    此前只发旧 ref：视图对它查不到就拆图元，新 id 没人建 —— 在面板里改完 id，
    画布上那个实体当场消失（数据是对的），要切页重投影才回来；撤销更糟，按旧 id
    找不到人，一个字节都不写。
    """

    def _tree_refs(self) -> set[tuple[str, str]]:
        from PySide6.QtCore import Qt
        from PySide6.QtWidgets import QTreeWidgetItemIterator
        out: set[tuple[str, str]] = set()
        it = QTreeWidgetItemIterator(self.page._tree)
        while it.value():
            data = it.value().data(0, Qt.ItemDataRole.UserRole)
            if data is not None:
                out.add(tuple(data))
            it += 1
        return out

    def _ids(self) -> list[str]:
        return [h["id"] for h in self.model.scenes[_SCENE]["hotspots"]]

    def _type_id(self, text: str) -> None:
        """老面板的 id 框：`textChanged` → `changed` → 桥提交。与用户敲键同一条路。"""
        self.page._props._hs_id.setText(text)

    def test_renaming_moves_the_canvas_item_to_the_new_id(self) -> None:
        old, new = EntityRef("hotspot", "h1"), EntityRef("hotspot", "h1_new")
        self.page.document.set_selection([old])
        self._type_id("h1_new")
        self.assertEqual(self._ids(), ["h1_new", "h2"])
        self.assertEqual(self.page.view.items_of(old), [], "旧 id 的图元还留在画布上")
        item = self.page.view.item_for(new, "handle")
        self.assertIsNotNone(item, "新 id 的图元没建出来 —— 改完 id 实体从画布上消失")
        self.assertTrue(item._selected, "新图元没带上选中态")
        self.assertEqual(self.page.document.selection, (new,))
        self.assertIn(("hotspot", "h1_new"), self._tree_refs(), "实体树没跟上新 id")
        self.assertNotIn(("hotspot", "h1"), self._tree_refs(), "实体树还列着旧 id")

    def test_undo_of_a_rename_restores_id_item_and_selection(self) -> None:
        old, new = EntityRef("hotspot", "h1"), EntityRef("hotspot", "h1_new")
        self.page.document.set_selection([old])
        self._type_id("h1_new")
        self.page.editor_undo()
        self.assertEqual(self._ids(), ["h1", "h2"], "撤销改 id 什么都没做（按旧 id 找不到人）")
        self.assertEqual(self.page.view.items_of(new), [])
        self.assertIsNotNone(self.page.view.item_for(old, "handle"))
        self.assertEqual(self.page.document.selection, (old,), "撤销后选择集还指着新 id")
        self.assertIn(("hotspot", "h1"), self._tree_refs())
        self.page.editor_redo()
        self.assertEqual(self._ids(), ["h1_new", "h2"])
        self.assertIsNotNone(self.page.view.item_for(new, "handle"))

    def test_typing_an_id_is_one_undo_step(self) -> None:
        """逐字敲 id 要并成一条撤销记录 —— 每一键的命令是对着上一键的新 id 构造的。"""
        self.page.document.set_selection([EntityRef("hotspot", "h1")])
        for text in ("h1_a", "h1_ab", "h1_abc"):
            self._type_id(text)
        self.assertEqual(self._ids(), ["h1_abc", "h2"])
        self.assertEqual(self.page.document.undo_stack.count(), 1,
                         "逐字敲 id 变成了一键一条撤销记录")
        self.page.editor_undo()
        self.assertEqual(self._ids(), ["h1", "h2"])
        self.assertIsNotNone(self.page.view.item_for(EntityRef("hotspot", "h1"), "handle"))
        self.assertEqual(self.page.view.items_of(EntityRef("hotspot", "h1_abc")), [])


class NoStagingLayerMeansNoCommitPatchesTests(_Base):
    """没有第二层真相，那三条补丁就没有存在的理由。"""

    def test_leave_and_close_hooks_are_unconditionally_fine(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        self.page._props._hs_range.setValue(66)
        self.page._bridge.commit_panel_edits()
        # 编辑已经在模型里了，所以离开/关闭不需要"先提交"
        self.assertTrue(self.page.commit_pending_on_leave())
        self.assertTrue(self.page.confirm_close())
        self.assertTrue(self.page.flush_to_model())
        self.assertEqual(self.ent("hotspot", "h1")["interactionRange"], 66)

    def test_edit_survives_a_scene_switch_without_an_explicit_apply(self) -> None:
        """老画布的"不点应用直接切走就丢编辑"在这里不可能发生。"""
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        self.page._props._hs_range.setValue(99)
        self.page._bridge.commit_panel_edits()
        self.model.scenes["别的街"] = dict(_scene(), id="别的街", name="别的街")
        self.page.refresh_scene_list()
        self.page.load_scene("别的街")
        self.page.load_scene(_SCENE)
        self.assertEqual(self.ent("hotspot", "h1")["interactionRange"], 99)


if __name__ == "__main__":
    unittest.main()
