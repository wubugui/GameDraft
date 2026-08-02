"""Outermost UI/data-safety probes for dialogue-graph reference picking."""
from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QPushButton

from tools.editor.project_model import ProjectModel
from tools.editor.editors.scene_editor import ScenePropertyPanel
from tools.editor.shared.action_editor import ActionEditor, FilterableTypeCombo
from tools.editor.shared.dialogue_graph_refs import (
    dialogue_graph_ids,
    dialogue_graph_node_ids,
)
from tools.editor.shared.reference_picker import (
    ReferencePickerDialog,
    ReferencePickerField,
)


_PROJECT_ROOT = Path(__file__).resolve().parents[3]


class _CatalogModel:
    def __init__(self) -> None:
        self.pending_dialogue_stubs = {
            "staged_new": {
                "id": "staged_new",
                "meta": {"title": "暂存新图"},
                "nodes": {"start": {}, "done": {}},
            },
            "../unsafe": {"id": "unsafe", "nodes": {}},
            "": {"id": "unnamed", "nodes": {}},
        }
        self.pending_dialogue_graph_edits = {
            "disk_graph": {"id": "disk_graph", "nodes": {"edited_entry": {}}},
        }

    def all_dialogue_graph_ids(self) -> list[str]:
        return ["disk_graph"]


class DialogueCatalogSafetyTests(unittest.TestCase):
    def test_named_staging_is_visible_but_unsafe_or_unnamed_is_not(self) -> None:
        model = _CatalogModel()
        self.assertEqual(dialogue_graph_ids(model), ["disk_graph", "staged_new"])

    def test_pending_document_is_node_source_of_truth(self) -> None:
        model = _CatalogModel()
        self.assertEqual(dialogue_graph_node_ids(model, "disk_graph"), ["edited_entry"])
        self.assertEqual(dialogue_graph_node_ids(model, "staged_new"), ["done", "start"])


class ReferencePickerOutermostTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def test_missing_value_is_preserved_and_picker_accepts_real_user_events(self) -> None:
        rows = [("alpha", "Alpha"), ("beta", "Beta target")]
        field = ReferencePickerField(lambda: rows, title="选择测试引用")
        field.set_value("dangling_old")
        self.assertEqual(field.current_value(), "dangling_old")
        self.assertIn("[缺失]", field._line.text())

        dialog = ReferencePickerDialog(rows, current="dangling_old")
        dialog.show()
        QApplication.processEvents()
        QTest.keyClicks(dialog._filter, "beta")
        self.assertEqual(dialog._list.count(), 1)
        item = dialog._list.item(0)
        rect = dialog._list.visualItemRect(item)
        QTest.mouseClick(
            dialog._list.viewport(),
            Qt.MouseButton.LeftButton,
            pos=rect.center(),
        )
        QTest.mouseClick(dialog._ok_button, Qt.MouseButton.LeftButton)
        self.assertEqual(dialog.result(), dialog.DialogCode.Accepted)
        self.assertEqual(dialog.selected_value(), "beta")
        dialog.deleteLater()
        field.deleteLater()

    def test_programmatic_refresh_does_not_emit_or_clear(self) -> None:
        rows: list[tuple[str, str]] = []
        field = ReferencePickerField(lambda: rows)
        field.set_value("later")
        seen: list[str] = []
        field.value_changed.connect(seen.append)
        rows.append(("later", "Later graph"))
        field.refresh_display()
        self.assertEqual(field.current_value(), "later")
        self.assertEqual(field._line.text(), "Later graph  [later]")
        self.assertEqual(seen, [])
        field.deleteLater()

    def test_search_dialog_clear_is_explicit_and_returns_empty(self) -> None:
        dialog = ReferencePickerDialog(
            [("alpha", "Alpha")],
            current="alpha",
            allow_empty=True,
        )
        dialog.show()
        QApplication.processEvents()
        clear = next(
            button for button in dialog.findChildren(QPushButton)
            if button.text() == "清空"
        )
        QTest.mouseClick(clear, Qt.MouseButton.LeftButton)
        self.assertEqual(dialog.result(), dialog.DialogCode.Accepted)
        self.assertEqual(dialog.selected_value(), "")
        dialog.deleteLater()

    def test_open_namespace_has_explicit_define_flow(self) -> None:
        field = ReferencePickerField(
            lambda: [],
            allow_custom=True,
            title="定义系统归属",
        )
        seen: list[str] = []
        field.value_changed.connect(seen.append)
        with patch(
            "tools.editor.shared.reference_picker.QInputDialog.getText",
            return_value=("system_weather", True),
        ):
            field._define_value()
        self.assertEqual(field.current_value(), "system_weather")
        self.assertEqual(seen, ["system_weather"])
        self.assertIn("[自定义]", field._line.text())
        field.deleteLater()


class StartDialogueGraphPickerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._model = ProjectModel()
        cls._model.load_project(_PROJECT_ROOT)

    def test_dangling_and_unknown_legacy_values_roundtrip_exactly(self) -> None:
        action = {
            "type": "startDialogueGraph",
            "params": {
                "graphId": "missing_graph",
                "entry": "missing_entry",
                "npcId": "missing_npc",
                "ownerType": "future_owner_kind",
                "ownerId": "future_owner_id",
                "dimBackground": True,
                "futureOwnerExtension": {"mode": "keep"},
            },
        }
        editor = ActionEditor("test")
        editor.set_project_context(self._model, "missing_scene")
        editor.set_data([action])
        row = editor._rows[0]
        self.assertIsInstance(row._param_widgets["graphId"], ReferencePickerField)
        self.assertIsInstance(row._param_widgets["entry"], ReferencePickerField)
        self.assertIsInstance(row._param_widgets["npcId"], ReferencePickerField)
        self.assertIsInstance(row._param_widgets["ownerType"], FilterableTypeCombo)
        self.assertIsInstance(row._param_widgets["ownerId"], ReferencePickerField)
        self.assertEqual(editor.to_list(), [action])
        editor.deleteLater()

    def test_new_named_staging_graph_appears_without_rebuilding_action_row(self) -> None:
        editor = ActionEditor("test")
        editor.set_project_context(self._model, None)
        editor.set_data([{"type": "startDialogueGraph", "params": {"graphId": ""}}])
        row = editor._rows[0]
        picker = row._param_widgets["graphId"]
        self.assertIsInstance(picker, ReferencePickerField)
        marker = "__test_staged_dialogue_picker__"
        self.assertNotIn(marker, {value for value, _label, _detail in picker._safe_rows()})
        self._model.pending_dialogue_stubs[marker] = {
            "id": marker,
            "entry": "start",
            "nodes": {"start": {}},
        }
        try:
            self.assertIn(marker, {value for value, _label, _detail in picker._safe_rows()})
        finally:
            self._model.pending_dialogue_stubs.pop(marker, None)
            editor.deleteLater()

    def test_system_owner_has_explicit_id_definition_flow(self) -> None:
        editor = ActionEditor("test")
        editor.set_project_context(self._model, None)
        editor.set_data([{
            "type": "startDialogueGraph",
            "params": {"graphId": "missing_graph", "ownerType": "system"},
        }])
        row = editor._rows[0]
        owner = row._param_widgets["ownerId"]
        self.assertIsInstance(owner, ReferencePickerField)
        self.assertTrue(owner._allow_custom)
        self.assertFalse(owner._define.isHidden())
        label = row._params_layout.labelForField(owner)
        self.assertIsNotNone(label)
        self.assertIn("必填", label.text())
        self.assertIn("不会从 npcId", owner.toolTip())
        editor.deleteLater()

    def test_scene_group_owner_is_selectable_from_project_catalog(self) -> None:
        sid = "__dialogue_owner_group_scene__"
        self._model.scenes[sid] = {
            "id": sid,
            "entityGroups": [{"id": "guards", "label": "官差组"}],
        }
        try:
            editor = ActionEditor("test")
            editor.set_project_context(self._model, sid)
            editor.set_data([{
                "type": "startDialogueGraph",
                "params": {
                    "graphId": "missing_graph",
                    "ownerType": "sceneGroup",
                    "ownerId": f"{sid}:guards",
                },
            }])
            row = editor._rows[0]
            owner_type = row._param_widgets["ownerType"]
            owner_id = row._param_widgets["ownerId"]
            self.assertEqual(owner_type.committed_type(), "sceneGroup")
            self.assertIsInstance(owner_id, ReferencePickerField)
            self.assertIn(
                f"{sid}:guards",
                {value for value, _label, _detail in owner_id._safe_rows()},
            )
            self.assertEqual(editor.to_list()[0]["params"]["ownerId"], f"{sid}:guards")
            editor.deleteLater()
        finally:
            self._model.scenes.pop(sid, None)


class SceneDialogueReferenceRoundtripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._model = ProjectModel()
        cls._model.load_project(_PROJECT_ROOT)
        cls._scene_id = cls._model.all_scene_ids()[0]

    def test_npc_dangling_graph_and_entry_are_preserved(self) -> None:
        panel = ScenePropertyPanel(self._model)
        panel._editing_scene_id = self._scene_id
        npc = {
            "id": "picker_test_npc",
            "name": "测试",
            "x": 1,
            "y": 2,
            "dialogueGraphId": "missing_graph",
            "dialogueGraphEntry": "missing_entry",
        }
        panel.load_npc_props(npc)
        self.assertIsInstance(panel._npc_dialogue_graph, ReferencePickerField)
        self.assertIsInstance(panel._npc_dialogue_graph_entry, ReferencePickerField)
        out = panel.save_npc_props()
        self.assertEqual(out["dialogueGraphId"], "missing_graph")
        self.assertEqual(out["dialogueGraphEntry"], "missing_entry")
        panel.deleteLater()

    def test_inspect_dangling_graph_entry_and_unknown_data_survive(self) -> None:
        panel = ScenePropertyPanel(self._model)
        panel._editing_scene_id = self._scene_id
        hotspot = {
            "id": "picker_test_hotspot",
            "type": "inspect",
            "label": "测试",
            "x": 1,
            "y": 2,
            "data": {
                "graphId": "missing_graph",
                "entry": "missing_entry",
                "futureInspectExtension": {"mode": "keep"},
            },
        }
        panel.load_hotspot_props(hotspot)
        self.assertIsInstance(panel._hs_inspect_graph_combo, ReferencePickerField)
        self.assertIsInstance(panel._hs_inspect_entry, ReferencePickerField)
        out = panel.save_hotspot_props()
        self.assertEqual(out["data"]["graphId"], "missing_graph")
        self.assertEqual(out["data"]["entry"], "missing_entry")
        self.assertEqual(
            out["data"]["futureInspectExtension"], {"mode": "keep"},
        )
        panel.deleteLater()


if __name__ == "__main__":
    unittest.main()
