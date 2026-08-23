"""属性面板接线 —— 老面板一行不改，但 staging 不再是第二份真相。

方案书 §3.4「死法二」：如果只是把 staging 原样搬过来而没有唯一裁决函数，新架构会在
第一个"整组平移写错副本"上**原样复现老 bug**，然后所有人得出"换架构没用"的结论。

所以这里的头号断言是：**`write_target` 恒指向模型**。面板的 staging 降级成它自己的
输入缓冲，Document 永远不读它。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityProperty, EntityRef
from tools.editor.editors.scene_v2.page import SceneEditorV2
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
    """比对只看 staging 出现过的键 —— 未受管字段必须原样留在模型里。"""

    def test_only_changed_keys_are_returned(self) -> None:
        self.assertEqual(diff_fields({"x": 1, "y": 2}, {"x": 1, "y": 5}), {"y": 2})

    def test_unmanaged_keys_are_never_touched(self) -> None:
        got = diff_fields({"x": 1}, {"x": 1, "unknownKey": {"keep": 1}})
        self.assertEqual(got, {}, "面板没碰的键被当成变更写回去了")

    def test_new_key_is_written(self) -> None:
        self.assertEqual(diff_fields({"scale": 2.0}, {}), {"scale": 2.0})

    def test_int_float_representation_counts_as_a_change(self) -> None:
        """数值往返保真：未改动的数值键必须按原始表示回写。"""
        self.assertEqual(diff_fields({"x": 100.0}, {"x": 100}), {"x": 100.0})

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


class PanelEditsBecomeCommandsTests(_Base):
    def test_panel_edit_lands_in_the_model_as_a_command(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        staged = self.page._props._staging_hotspot
        self.assertIsNotNone(staged, "前置条件：面板应当已载入该实体")
        staged["interactionRange"] = 88
        self.page._bridge.commit_panel_edits()
        self.assertEqual(self.ent("hotspot", "h1")["interactionRange"], 88)
        self.assertEqual(self.page.document.undo_stack.count(), 1)

    def test_panel_edit_is_undoable(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        self.page._props._staging_hotspot["interactionRange"] = 88
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
        self.page._props._staging_hotspot["interactionRange"] = 77
        self.page._bridge.commit_panel_edits()
        self.assertEqual(self.ent("hotspot", "h1").get("unknownKey"), {"keep": 1},
                         "面板提交把未受管字段弄丢了 —— 黄金往返会红")

    def test_consecutive_edits_merge_into_one_command(self) -> None:
        """连续编辑（拖数值框）收成一条撤销记录。"""
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        for v in (60, 70, 80):
            self.page._props._staging_hotspot["interactionRange"] = v
            self.page._bridge.commit_panel_edits()
        self.assertEqual(self.page.document.undo_stack.count(), 1)
        self.page.editor_undo()
        self.assertEqual(self.ent("hotspot", "h1")["interactionRange"], 50,
                         "合并后的撤销必须一次回到编辑起点")

    def test_switching_entity_starts_a_new_command(self) -> None:
        a, b = EntityRef("hotspot", "h1"), EntityRef("hotspot", "h2")
        self.page.document.set_selection([a])
        self.page._props._staging_hotspot["interactionRange"] = 60
        self.page._bridge.commit_panel_edits()
        self.page.document.set_selection([b])
        self.page._props._staging_hotspot["interactionRange"] = 90
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


class NoStagingLayerMeansNoCommitPatchesTests(_Base):
    """没有第二层真相，那三条补丁就没有存在的理由。"""

    def test_leave_and_close_hooks_are_unconditionally_fine(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.page.document.set_selection([ref])
        self.page._props._staging_hotspot["interactionRange"] = 66
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
        self.page._props._staging_hotspot["interactionRange"] = 99
        self.page._bridge.commit_panel_edits()
        self.model.scenes["别的街"] = dict(_scene(), id="别的街", name="别的街")
        self.page.refresh_scene_list()
        self.page.load_scene("别的街")
        self.page.load_scene(_SCENE)
        self.assertEqual(self.ent("hotspot", "h1")["interactionRange"], 99)


if __name__ == "__main__":
    unittest.main()
