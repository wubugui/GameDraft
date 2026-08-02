"""场景一等分组的编辑器流程与旧数据往返护栏。"""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication, QDialog, QMessageBox

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.project_model import ProjectModel
from tools.editor.shared.reference_picker import ReferencePickerDialog
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.validator import validate


def _scene(*, explicit: bool) -> dict:
    sc = {
        "id": "sc_a",
        "name": "甲场景",
        "hotspots": [{
            "id": "h1", "type": "inspect", "label": "", "x": 20, "y": 20,
            "interactionRange": 50, "data": {"text": ""}, "group": "夜巡",
            "unknownMember": {"keep": True},
        }],
        "npcs": [{
            "id": "n1", "name": "甲", "x": 40, "y": 40,
            "interactionRange": 50, "group": "夜巡",
        }],
        "zones": [{
            "id": "z1", "group": "夜巡",
            "polygon": [{"x": 0, "y": 0}, {"x": 80, "y": 0}, {"x": 80, "y": 80}],
        }],
        "unknownScene": {"keep": 7},
    }
    if explicit:
        sc["entityGroups"] = [{
            "id": "夜巡", "label": "夜巡队",
            "conditions": [{"flag": "story.open", "equals": True}],
            "unknownGroup": {"keep": 9},
        }]
    return sc


class SceneGroupEntityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

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
        QApplication.processEvents()

    def _editor(self, root: Path, *, explicit: bool) -> tuple[SceneEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.scenes = {"sc_a": _scene(explicit=explicit)}
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._editors.append(ed)
        model._dirty.clear()
        model._dirty_scene_ids.clear()
        model._dirty_scenes_all = False
        ed._undo.clear()
        return ed, model

    @staticmethod
    def _tree_item(ed: SceneEditor, ref: tuple[str, str]):
        for item in ed._iter_entity_tree_items():
            data = item.data(0, Qt.ItemDataRole.UserRole)
            if data and tuple(data) == ref:
                return item
        raise AssertionError(f"tree ref missing: {ref}")

    def test_read_only_provider_and_open_keep_legacy_scene_byte_shape(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", explicit=False)
            before = copy.deepcopy(model.scenes["sc_a"])
            self.assertEqual(model.scene_group_ids_for_scene("sc_a"), [("夜巡", "夜巡")])
            self.assertEqual(model.all_scene_group_ids(), [("sc_a:夜巡", "夜巡 · sc_a")])
            self.assertNotIn("entityGroups", model.scenes["sc_a"])

            # 最外层入口：点实体树中的兼容组，只查看后走 Save All flush 钩子。
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            self.assertIs(ed._props._stack.currentWidget(), ed._props._group_panel)
            ed.flush_to_model()
            self.assertEqual(model.scenes["sc_a"], before)
            self.assertNotIn("entityGroups", model.scenes["sc_a"])
            self.assertFalse(model.is_dirty)

    def test_tree_edit_then_switch_materializes_and_renames_members_without_loss(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", explicit=False)
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            ed._props._grp_id.setText("夜巡甲")
            ed._props._grp_label.setText("夜巡甲队")

            # 最外层离开路径：切到 Zone，触发 commit-on-leave，而不是直接调提交函数。
            ed._entity_tree.clearSelection()
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("zone", "z1")))
            QApplication.processEvents()

            sc = model.scenes["sc_a"]
            self.assertEqual(sc["entityGroups"], [{"id": "夜巡甲", "label": "夜巡甲队"}])
            for coll in ("npcs", "hotspots", "zones"):
                self.assertEqual(sc[coll][0].get("group"), "夜巡甲")
            self.assertEqual(sc["hotspots"][0]["unknownMember"], {"keep": True})
            self.assertEqual(sc["unknownScene"], {"keep": 7})
            self.assertTrue(model.is_dirty)

    def test_explicit_group_edit_preserves_conditions_unknown_keys_and_member_order(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", explicit=True)
            before_member_ids = {
                coll: [row["id"] for row in model.scenes["sc_a"][coll]]
                for coll in ("npcs", "hotspots", "zones")
            }
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            ed._props._grp_label.setText("新显示名")
            ed._entity_tree.clearSelection()
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("npc", "n1")))
            QApplication.processEvents()

            group = model.scenes["sc_a"]["entityGroups"][0]
            self.assertEqual(group["label"], "新显示名")
            self.assertEqual(group["conditions"], [{"flag": "story.open", "equals": True}])
            self.assertEqual(group["unknownGroup"], {"keep": 9})
            for coll, ids in before_member_ids.items():
                self.assertEqual([row["id"] for row in model.scenes["sc_a"][coll]], ids)

    def test_delete_group_explicitly_clears_members_but_keeps_entities(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", explicit=True)
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            real = QMessageBox.question
            QMessageBox.question = staticmethod(lambda *args, **kwargs: QMessageBox.StandardButton.Yes)
            try:
                ed._delete_selected()
            finally:
                QMessageBox.question = real
            sc = model.scenes["sc_a"]
            self.assertEqual(sc["entityGroups"], [])
            for coll in ("npcs", "hotspots", "zones"):
                self.assertEqual(len(sc[coll]), 1)
                self.assertNotIn("group", sc[coll][0])
            self.assertEqual(sc["hotspots"][0]["unknownMember"], {"keep": True})

    def test_malformed_entity_groups_is_never_overwritten_by_legacy_group_edit(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", explicit=False)
            malformed = {"unexpected": [1, 2, 3]}
            model.scenes["sc_a"]["entityGroups"] = copy.deepcopy(malformed)
            ed._load_scene("sc_a")
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            ed._props._grp_label.setText("不得写入")
            real = QMessageBox.warning
            QMessageBox.warning = staticmethod(lambda *args, **kwargs: QMessageBox.StandardButton.Ok)
            try:
                ed._apply_props()
            finally:
                QMessageBox.warning = real
            self.assertEqual(model.scenes["sc_a"]["entityGroups"], malformed)
            self.assertTrue(ed._props.is_pending_dirty(), "拒绝提交后不得伪报成功/清掉 pending")

    def test_malformed_group_pending_blocks_close_instead_of_losing_draft(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", explicit=False)
            malformed = {"unexpected": [1, 2, 3]}
            model.scenes["sc_a"]["entityGroups"] = copy.deepcopy(malformed)
            ed._load_scene("sc_a")
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            ed._props._grp_label.setText("关闭也不能丢")
            real = QMessageBox.warning
            QMessageBox.warning = staticmethod(lambda *args, **kwargs: QMessageBox.StandardButton.Ok)
            try:
                self.assertFalse(ed.confirm_close(None))
            finally:
                QMessageBox.warning = real
            self.assertEqual(model.scenes["sc_a"]["entityGroups"], malformed)
            self.assertTrue(ed._props.is_pending_dirty())
            self.assertFalse(model.is_dirty, "提交被拒时不能伪标 model dirty")

    def test_malformed_group_pending_blocks_tree_navigation_and_restores_selection(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", explicit=False)
            malformed = {"unexpected": [1, 2, 3]}
            model.scenes["sc_a"]["entityGroups"] = copy.deepcopy(malformed)
            ed._load_scene("sc_a")
            group_item = self._tree_item(ed, ("group", "夜巡"))
            ed._entity_tree.setCurrentItem(group_item)
            QApplication.processEvents()
            ed._props._grp_label.setText("树切换也不能丢")

            real = QMessageBox.warning
            QMessageBox.warning = staticmethod(lambda *args, **kwargs: QMessageBox.StandardButton.Ok)
            try:
                ed._entity_tree.clearSelection()
                ed._entity_tree.setCurrentItem(self._tree_item(ed, ("zone", "z1")))
                QApplication.processEvents()
            finally:
                QMessageBox.warning = real

            self.assertIs(ed._props._stack.currentWidget(), ed._props._group_panel)
            self.assertEqual(ed._props._grp_label.text(), "树切换也不能丢")
            selected = {
                tuple(item.data(0, Qt.ItemDataRole.UserRole))
                for item in ed._entity_tree.selectedItems()
                if item.data(0, Qt.ItemDataRole.UserRole)
            }
            self.assertEqual(selected, {("group", "夜巡")})
            self.assertEqual(model.scenes["sc_a"]["entityGroups"], malformed)
            self.assertTrue(ed._props.is_pending_dirty())

    def test_malformed_group_pending_blocks_scene_navigation_and_restores_scene_row(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", explicit=False)
            model.scenes["sc_b"] = {
                "id": "sc_b", "name": "乙场景", "hotspots": [], "npcs": [], "zones": [],
            }
            malformed = {"unexpected": [1, 2, 3]}
            model.scenes["sc_a"]["entityGroups"] = copy.deepcopy(malformed)
            ed._refresh_scene_list()
            ed._load_scene("sc_a")
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            ed._props._grp_label.setText("场景切换也不能丢")

            target = next(
                ed._scene_list.item(i)
                for i in range(ed._scene_list.count())
                if ed._scene_list.item(i).data(Qt.ItemDataRole.UserRole) == "sc_b"
            )
            real = QMessageBox.warning
            QMessageBox.warning = staticmethod(lambda *args, **kwargs: QMessageBox.StandardButton.Ok)
            try:
                ed._scene_list.setCurrentItem(target)
                QApplication.processEvents()
            finally:
                QMessageBox.warning = real

            self.assertEqual(ed._current_scene_id, "sc_a")
            self.assertEqual(
                ed._scene_list.currentItem().data(Qt.ItemDataRole.UserRole), "sc_a",
            )
            self.assertEqual(ed._props._grp_label.text(), "场景切换也不能丢")
            self.assertTrue(ed._props.is_pending_dirty())

    def test_group_member_double_click_navigates_to_real_tree_entity(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p", explicit=True)
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            row = next(
                ed._props._grp_members.item(i)
                for i in range(ed._props._grp_members.count())
                if ed._props._grp_members.item(i).data(Qt.ItemDataRole.UserRole) == ("npc", "n1")
            )
            ed._props._grp_members.itemDoubleClicked.emit(row)
            QApplication.processEvents()
            selected = {
                tuple(item.data(0, Qt.ItemDataRole.UserRole))
                for item in ed._entity_tree.selectedItems()
                if item.data(0, Qt.ItemDataRole.UserRole)
            }
            self.assertEqual(selected, {("npc", "n1")})
            self.assertIs(ed._props._stack.currentWidget(), ed._props._npc_panel)

    def test_group_assignment_uses_searchable_dialog_outer_entry(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", explicit=True)
            model.scenes["sc_a"]["entityGroups"].append({"id": "岗哨", "label": "岗哨队"})
            ed._refresh_entity_tree()
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("npc", "n1")))
            QApplication.processEvents()
            seen: dict[str, object] = {}
            real_exec = ReferencePickerDialog.exec
            real_selected = ReferencePickerDialog.selected_value

            def fake_exec(dialog):
                seen["dialog"] = dialog
                dialog._filter.setText("岗哨")
                self.assertEqual(dialog._list.count(), 1)
                return QDialog.DialogCode.Accepted

            ReferencePickerDialog.exec = fake_exec
            ReferencePickerDialog.selected_value = lambda _dialog: "岗哨"
            try:
                ed._assign_group_to_selection()
            finally:
                ReferencePickerDialog.exec = real_exec
                ReferencePickerDialog.selected_value = real_selected
            self.assertIsInstance(seen.get("dialog"), ReferencePickerDialog)
            self.assertEqual(model.scenes["sc_a"]["npcs"][0]["group"], "岗哨")

    def test_group_rename_with_narrative_owner_reference_is_blocked_without_partial_write(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", explicit=True)
            model.narrative_graphs = {
                "schemaVersion": 2,
                "compositions": [{
                    "id": "c1",
                    "elements": [{
                        "kind": "wrapperGraph", "ownerType": "sceneGroup",
                        "ownerId": "sc_a:夜巡", "graph": {"id": "g1", "states": {}},
                    }],
                }],
            }
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            ed._props._grp_id.setText("新夜巡")
            warnings: list[str] = []
            real = QMessageBox.warning
            QMessageBox.warning = staticmethod(
                lambda _parent, _title, message, *args, **kwargs: warnings.append(str(message))
            )
            try:
                ed._entity_tree.clearSelection()
                ed._entity_tree.setCurrentItem(self._tree_item(ed, ("zone", "z1")))
                QApplication.processEvents()
            finally:
                QMessageBox.warning = real
            self.assertTrue(any("narrative ownerId=sc_a:夜巡" in msg for msg in warnings))
            self.assertEqual(model.scenes["sc_a"]["entityGroups"][0]["id"], "夜巡")
            self.assertEqual(ed._props._staging_group["id"], "新夜巡")
            self.assertTrue(ed._props.is_pending_dirty())

    def test_group_delete_with_same_scene_action_reference_is_blocked(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", explicit=True)
            model.scenes["sc_a"]["onEnter"] = [{
                "type": "setGroupEnabled", "params": {"group": "夜巡", "enabled": False},
            }]
            ed._load_scene("sc_a")
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            warnings: list[str] = []
            real_warning = QMessageBox.warning
            real_question = QMessageBox.question
            QMessageBox.warning = staticmethod(
                lambda _parent, _title, message, *args, **kwargs: warnings.append(str(message))
            )
            QMessageBox.question = staticmethod(
                lambda *args, **kwargs: self.fail("有入站引用时不应进入删除确认"),
            )
            try:
                ed._delete_selected()
            finally:
                QMessageBox.warning = real_warning
                QMessageBox.question = real_question
            self.assertTrue(any("setGroupEnabled.params.group=夜巡" in msg for msg in warnings))
            self.assertEqual(model.scenes["sc_a"]["entityGroups"][0]["id"], "夜巡")
            self.assertEqual(model.scenes["sc_a"]["npcs"][0]["group"], "夜巡")

    def test_validator_rejects_missing_scene_group_owner_id(self) -> None:
        with TemporaryDirectory() as td:
            _ed, model = self._editor(Path(td) / "p", explicit=True)
            model.narrative_graphs = {
                "schemaVersion": 2,
                "compositions": [{
                    "id": "c1",
                    "mainGraph": {"id": "main", "ownerType": "flow", "states": {}, "transitions": []},
                    "elements": [{
                        "kind": "wrapperGraph", "ownerType": "sceneGroup",
                        "ownerId": "sc_a:不存在", "graph": {
                            "id": "g1", "ownerType": "sceneGroup", "ownerId": "sc_a:不存在",
                            "states": {}, "transitions": [],
                        },
                    }],
                }],
            }
            messages = [issue.message for issue in validate(model)]
            self.assertTrue(any("sceneGroup ownerId 'sc_a:不存在' 不存在" in msg for msg in messages))


if __name__ == "__main__":
    unittest.main()
