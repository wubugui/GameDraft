from __future__ import annotations

import copy
import sys
import unittest
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication, QMessageBox

from tools.task_orchestration_editor.editor import TaskOrchestrationEditor
from tools.task_orchestration_editor.compiler import CompileError, apply_compilation_plan, build_event_plan
from tools.task_orchestration_editor.tests.test_compiler import _project
from tools.task_orchestration_editor.tests.test_compiler import _spec
from tools.task_orchestration_editor.window import TaskOrchestrationWindow
from tools.editor.tests.qt_teardown import destroy_leftover_qt_widgets


class TestTaskOrchestrationGui(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def tearDown(self) -> None:
        # These tests live outside tools/editor/tests, so that suite's autouse
        # DeferredDelete fixture is not inherited.  Explicitly destroy web
        # editor pages or QtWebEngine may crash the process during profile exit.
        destroy_leftover_qt_widgets()

    def test_editor_constructs_and_reads_native_composition(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            editor = TaskOrchestrationEditor(model)
            self.assertEqual(editor._current_composition_id, "event_flow")
            self.assertEqual(editor._flow_id.text(), "event_flow")
            self.assertEqual(editor._graph_id.text(), "flow_event")
            self.assertEqual(editor._states.topLevelItemCount(), 2)
            editor.deleteLater()
            QApplication.processEvents()

    def test_standalone_window_does_not_require_main_window_registration(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            window = TaskOrchestrationWindow(model)
            self.assertIs(window.model, model)
            self.assertIsInstance(window.editor, TaskOrchestrationEditor)
            self.assertEqual(window._workspace_tabs.count(), 2)
            self.assertEqual(window._workspace_tabs.tabText(1), "场景实体布置")
            window.deleteLater()
            QApplication.processEvents()

    def test_standalone_task_apply_rebases_open_scene_projection(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            window = TaskOrchestrationWindow(model)
            try:
                scene = window._scene_editor
                scene._refresh_scene_list()
                scene._load_scene("sc_a")
                scene.select_zone_by_id("zone_event", "sc_a")
                editor = window.editor
                editor._new_event()
                editor._event_scene.set_value("sc_a")
                editor._refresh_visible_entities()
                editor._event_entity.set_value("zone_event")
                editor._event_dialogue.set_value("source_dialogue")
                editor._apply_event()

                self.assertIs(
                    scene._props._source_zone,
                    model.scenes["sc_a"]["zones"][0],
                )
                scene._props._zn_poly_table.item(0, 1).setText("9.0")
                QApplication.processEvents()
                self.assertTrue(scene.flush_to_model())
                self.assertEqual(
                    model.scenes["sc_a"]["zones"][0]["polygon"][0]["x"],
                    9.0,
                )
            finally:
                window.deleteLater()
                QApplication.processEvents()

    def test_standalone_scene_rebase_failure_locks_save_close_and_reload(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            window = TaskOrchestrationWindow(model)
            try:
                editor = window.editor
                editor._new_event()
                editor._event_scene.set_value("sc_a")
                editor._refresh_visible_entities()
                editor._event_entity.set_value("zone_event")
                editor._event_dialogue.set_value("source_dialogue")
                with patch.object(
                    window._scene_editor,
                    "reload_from_model",
                    side_effect=RuntimeError("injected standalone rebase failure"),
                ), patch("tools.task_orchestration_editor.window.QMessageBox.critical"):
                    editor._apply_event()

                self.assertTrue(window._stale_projection_reason)
                self.assertFalse(window._scene_editor.isEnabled())
                with patch("tools.task_orchestration_editor.window.QMessageBox.critical"):
                    self.assertFalse(window.save_all())
                    self.assertFalse(window.reload_project())
                    self.assertFalse(window._confirm_discard_or_save("关闭"))
            finally:
                window._stale_projection_reason = ""
                window.deleteLater()
                QApplication.processEvents()

    def test_compiled_documents_open_in_regular_editors(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = _project(root)
            apply_compilation_plan(model, build_event_plan(model, _spec()))
            model.save_all()

            from tools.editor.project_model import ProjectModel
            from tools.editor.editors.dialogue_graph_editor_tab import DialogueGraphEditorTab
            from tools.editor.editors.narrative_state_editor import NarrativeStateEditor
            from tools.editor.editors.quest_editor import QuestEditor
            from tools.editor.editors.scene_editor import SceneEditor

            reopened = ProjectModel()
            reopened.load_project(root)
            widgets = [
                SceneEditor(reopened),
                DialogueGraphEditorTab(reopened),
                NarrativeStateEditor(reopened),
                QuestEditor(reopened),
            ]
            widgets[1].open_graph_by_id("event_flow_dialogue")
            self.assertFalse(reopened.is_dirty)
            for widget in widgets:
                widget.deleteLater()
            QApplication.processEvents()

    def test_regular_scene_editor_edits_compiled_scene_without_losing_unknown_fields(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = _project(root)
            apply_compilation_plan(model, build_event_plan(model, _spec()))
            model.save_all()

            from tools.editor.project_model import ProjectModel
            from tools.editor.editors.scene_editor import SceneEditor

            reopened = ProjectModel()
            reopened.load_project(root)
            editor = SceneEditor(reopened)
            try:
                editor._refresh_scene_list()
                editor._load_scene("sc_a")
                editor.select_zone_by_id("zone_event", "sc_a")
                QApplication.processEvents()
                self.assertIs(editor._props._stack.currentWidget(), editor._props._zone_panel)
                editor._props._zn_poly_table.item(0, 1).setText("1.5")
                QApplication.processEvents()
                self.assertTrue(editor.flush_to_model())
                reopened.save_all()
            finally:
                editor.close()
                editor.deleteLater()
                QApplication.processEvents()

            final = ProjectModel()
            final.load_project(root)
            zone = final.scenes["sc_a"]["zones"][0]
            self.assertEqual(zone["unknownZoneKey"], {"keep": True})
            self.assertEqual(zone["polygon"][0]["x"], 1.5)
            self.assertTrue(any(
                row.get("narrative") == "scenario_event_flow__t_event_done"
                for row in zone["conditions"]
            ))
            self.assertTrue(any(row.get("type") == "startDialogueGraph" for row in zone["onEnter"]))

    def test_pending_dialogue_stub_collision_is_blocked_before_save(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            model = _project(root)
            apply_compilation_plan(model, build_event_plan(model, _spec()))
            target = root / "public/assets/dialogues/graphs/event_flow_dialogue.json"
            target.write_text("{}\n", encoding="utf-8")
            window = TaskOrchestrationWindow(model)
            try:
                conflicts = window._pending_dialogue_stub_conflicts()
                self.assertEqual(conflicts, ["public/assets/dialogues/graphs/event_flow_dialogue.json"])
                with patch(
                    "tools.task_orchestration_editor.window.QMessageBox.critical",
                ) as critical:
                    self.assertFalse(window.save_all())
                    critical.assert_called()
                self.assertTrue(model.is_dirty)
            finally:
                window.deleteLater()
                QApplication.processEvents()

    def test_load_anomaly_locks_save(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            window = TaskOrchestrationWindow(model)
            try:
                window._unsafe_load_anomalies = ["bad json"]
                with patch("tools.task_orchestration_editor.window.QMessageBox.critical"):
                    self.assertFalse(window.save_all())
            finally:
                window._unsafe_load_anomalies = []
                window.deleteLater()
                QApplication.processEvents()

    def test_event_draft_survives_map_layout_roundtrip(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            window = TaskOrchestrationWindow(model)
            editor = window.editor
            try:
                editor._new_event()
                editor._event_scene.set_value("sc_a")
                editor._refresh_visible_entities()
                editor._event_entity.set_value("zone_event")
                editor._event_dialogue.set_value("source_dialogue")
                editor._flow_description.setText("不应影响事件草稿")
                first_visible = editor._visible_entities.topLevelItem(0)
                first_visible_key = first_visible.data(0, Qt.ItemDataRole.UserRole)
                first_visible.setCheckState(0, Qt.CheckState.Checked)
                before = {
                    "transition": editor._event_transition_id.text(),
                    "from": editor._event_from.current_id(),
                    "to": editor._event_to.current_id(),
                    "signal": editor._event_signal.text(),
                    "scenario": editor._event_scenario_graph.text(),
                    "scene": editor._event_scene.current_value(),
                    "entity": editor._event_entity.current_value(),
                    "dialogue": editor._event_dialogue.current_value(),
                    "copy": editor._dialogue_copy_id.text(),
                }
                self.assertTrue(editor._event_form_pending)

                QTest.mouseClick(editor._edit_on_map_button, Qt.MouseButton.LeftButton)
                QApplication.processEvents()
                self.assertIs(window._workspace_tabs.currentWidget(), window._scene_editor)
                self.assertEqual(window._scene_editor._current_scene_id, "sc_a")

                window._workspace_tabs.setCurrentWidget(editor)
                QApplication.processEvents()
                after = {
                    "transition": editor._event_transition_id.text(),
                    "from": editor._event_from.current_id(),
                    "to": editor._event_to.current_id(),
                    "signal": editor._event_signal.text(),
                    "scenario": editor._event_scenario_graph.text(),
                    "scene": editor._event_scene.current_value(),
                    "entity": editor._event_entity.current_value(),
                    "dialogue": editor._event_dialogue.current_value(),
                    "copy": editor._dialogue_copy_id.text(),
                }
                self.assertEqual(after, before)
                self.assertTrue(editor._event_form_pending)
                checked = {
                    editor._visible_entities.topLevelItem(index).data(0, Qt.ItemDataRole.UserRole)
                    for index in range(editor._visible_entities.topLevelItemCount())
                    if editor._visible_entities.topLevelItem(index).checkState(0) == Qt.CheckState.Checked
                }
                self.assertIn(first_visible_key, checked)
            finally:
                window.deleteLater()
                QApplication.processEvents()

    def test_switching_flow_cannot_silently_discard_event_draft(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            model.narrative_graphs["compositions"].append({
                "id": "other_flow",
                "mainGraph": {
                    "id": "flow_other",
                    "ownerType": "flow",
                    "initialState": "initial",
                    "states": {"initial": {"id": "initial"}},
                    "transitions": [],
                },
                "elements": [],
            })
            editor = TaskOrchestrationEditor(model)
            try:
                editor._new_event()
                draft_transition = editor._event_transition_id.text()
                with patch(
                    "tools.task_orchestration_editor.editor.QMessageBox.question",
                    return_value=QMessageBox.StandardButton.Cancel,
                ):
                    editor._flows.setCurrentRow(1)
                self.assertEqual(editor._current_composition_id, "event_flow")
                self.assertEqual(editor._flows.currentRow(), 0)
                self.assertEqual(editor._event_transition_id.text(), draft_transition)
                self.assertTrue(editor._event_form_pending)

                with patch(
                    "tools.task_orchestration_editor.editor.QMessageBox.question",
                    return_value=QMessageBox.StandardButton.Discard,
                ):
                    editor._flows.setCurrentRow(1)
                self.assertEqual(editor._current_composition_id, "other_flow")
                self.assertFalse(editor._event_form_pending)
            finally:
                editor.deleteLater()
                QApplication.processEvents()

    def test_main_window_reload_hook_preserves_event_draft(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            editor = TaskOrchestrationEditor(model)
            try:
                editor._new_event()
                editor._event_transition_id.setText("draft_transition")
                editor.reload_refs_from_model()
                self.assertTrue(editor._event_form_pending)
                self.assertEqual(editor._event_transition_id.text(), "draft_transition")
            finally:
                editor.deleteLater()
                QApplication.processEvents()

    def test_save_all_flush_with_flow_and_event_drafts_has_no_partial_side_effect(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            editor = TaskOrchestrationEditor(model)
            try:
                before = copy.deepcopy(model.narrative_graphs)
                editor._flow_label.setText("只在表单里的新名字")
                editor._mark_flow_text_pending()
                editor._new_event()
                self.assertTrue(editor._flow_text_pending)
                self.assertTrue(editor._event_form_pending)
                with self.assertRaises(CompileError):
                    editor.flush_to_model(for_save_all=True)
                self.assertEqual(model.narrative_graphs, before)
                self.assertTrue(editor._flow_text_pending)
                self.assertTrue(editor._event_form_pending)
            finally:
                editor.deleteLater()
                QApplication.processEvents()

    def test_confirm_close_cancel_preserves_draft_and_discard_neutralizes_it(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            editor = TaskOrchestrationEditor(model)
            try:
                editor._new_event()
                editor._event_transition_id.setText("draft_transition")
                with patch(
                    "tools.task_orchestration_editor.editor.QMessageBox.question",
                    return_value=QMessageBox.StandardButton.Cancel,
                ):
                    self.assertFalse(editor.confirm_close())
                self.assertTrue(editor._event_form_pending)
                self.assertEqual(editor._event_transition_id.text(), "draft_transition")

                with patch(
                    "tools.task_orchestration_editor.editor.QMessageBox.question",
                    return_value=QMessageBox.StandardButton.Discard,
                ):
                    self.assertTrue(editor.confirm_close())
                self.assertFalse(editor.has_pending_changes())
                self.assertEqual(editor._event_transition_id.text(), "")
            finally:
                editor.deleteLater()
                QApplication.processEvents()

    def test_external_prerequisite_roundtrips_through_gui_and_recompiles_idempotently(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            model.narrative_graphs["compositions"].append({
                "id": "mainline",
                "mainGraph": {
                    "id": "flow_mainline",
                    "ownerType": "flow",
                    "initialState": "chapter_1",
                    "states": {
                        "chapter_1": {"id": "chapter_1"},
                        "chapter_2": {"id": "chapter_2"},
                    },
                    "transitions": [],
                },
                "elements": [],
            })
            spec = _spec(
                prerequisite_graph_id="flow_mainline",
                prerequisite_state_id="chapter_2",
            )
            apply_compilation_plan(model, build_event_plan(model, spec))
            editor = TaskOrchestrationEditor(model)
            try:
                transition_item = editor._transitions.topLevelItem(0)
                editor._transitions.setCurrentItem(transition_item)
                editor._open_selected_event()
                self.assertFalse(editor._event_gate_follows.isChecked())
                self.assertEqual(editor._event_gate_graph.current_value(), "flow_mainline")
                self.assertEqual(editor._event_gate_state.current_id(), "chapter_2")
                self.assertEqual(editor._event_signal.text(), spec.signal_id)
                replay = build_event_plan(model, editor._event_spec())
                self.assertFalse(replay.changed)
            finally:
                editor.deleteLater()
                QApplication.processEvents()

    def test_same_main_prerequisite_is_locked_to_event_from_state(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            editor = TaskOrchestrationEditor(model)
            try:
                editor._new_event()
                editor._event_gate_follows.setChecked(False)
                editor._event_gate_graph.set_value("flow_event")
                editor._sync_prerequisite_controls()
                self.assertFalse(editor._event_gate_state.isEnabled())
                self.assertEqual(editor._event_gate_state.current_id(), editor._event_from.current_id())
            finally:
                editor.deleteLater()
                QApplication.processEvents()

    def test_destructive_actions_do_not_bypass_pending_event_form(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            apply_compilation_plan(model, build_event_plan(model, _spec()))
            editor = TaskOrchestrationEditor(model)
            try:
                item = editor._transitions.topLevelItem(0)
                editor._transitions.setCurrentItem(item)
                editor._event_form_pending = True
                with patch(
                    "tools.task_orchestration_editor.editor.QMessageBox.question",
                    return_value=QMessageBox.StandardButton.Cancel,
                ), patch("tools.task_orchestration_editor.editor.delete_event_spine") as delete:
                    editor._delete_transition()
                    delete.assert_not_called()

                editor._refresh_bindings()
                binding_item = next(
                    editor._bindings.topLevelItem(index)
                    for index in range(editor._bindings.topLevelItemCount())
                    if editor._bindings.topLevelItem(index).text(0) != "事件子图"
                )
                editor._bindings.setCurrentItem(binding_item)
                editor._event_form_pending = True
                with patch(
                    "tools.task_orchestration_editor.editor.QMessageBox.question",
                    return_value=QMessageBox.StandardButton.Cancel,
                ), patch("tools.task_orchestration_editor.editor.remove_event_binding") as remove:
                    editor._remove_selected_binding()
                    remove.assert_not_called()
            finally:
                editor.deleteLater()
                QApplication.processEvents()

    def test_reload_flushes_scene_staging_before_discard_prompt(self) -> None:
        with TemporaryDirectory() as td:
            model = _project(Path(td) / "p")
            window = TaskOrchestrationWindow(model)
            try:
                scene_editor = window._scene_editor
                scene_editor._refresh_scene_list()
                scene_editor._load_scene("sc_a")
                scene_editor.select_zone_by_id("zone_event", "sc_a")
                QApplication.processEvents()
                scene_editor._props._zn_poly_table.item(0, 1).setText("4.0")
                QApplication.processEvents()
                self.assertTrue(scene_editor._props.is_pending_dirty())
                with patch(
                    "tools.task_orchestration_editor.window.QMessageBox.question",
                    return_value=QMessageBox.StandardButton.Cancel,
                ):
                    self.assertFalse(window.reload_project())
                self.assertEqual(model.scenes["sc_a"]["zones"][0]["polygon"][0]["x"], 4.0)
                self.assertTrue(model.is_dirty)
            finally:
                window.deleteLater()
                QApplication.processEvents()


if __name__ == "__main__":
    unittest.main()
