"""Main-window integration contract for the native task orchestration page."""
from __future__ import annotations

import copy
import json
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("GAMEDRAFT_EDITOR_NO_LSP", "1")

from PySide6.QtWidgets import QApplication, QMessageBox

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.main_window import MainWindow
from tools.editor.tests.qt_teardown import destroy_leftover_qt_widgets
from tools.task_orchestration_editor.editor import TaskOrchestrationEditor
from tools.task_orchestration_editor.tests.test_compiler import _project


class TestTaskOrchestrationMainIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def tearDown(self) -> None:
        destroy_leftover_qt_widgets()

    def _loaded_window(self, root: Path) -> MainWindow:
        _project(root)
        return self._window_for_existing_root(root)

    @staticmethod
    def _window_for_existing_root(root: Path, *, anomalies: list[str] | None = None) -> MainWindow:
        window = MainWindow()
        window._model.load_project(root)
        if anomalies is not None:
            window._model.load_anomalies = list(anomalies)
        window._populate_tabs()
        return window

    @staticmethod
    def _configure_zone_dialogue_event(task: TaskOrchestrationEditor, *, quest_id: str = "") -> None:
        task._new_event()
        task._event_scene.set_value("sc_a")
        task._refresh_visible_entities()
        task._event_entity.set_value("zone_event")
        task._event_dialogue.set_value("source_dialogue")
        task._quest.set_value(quest_id)

    def test_page_uses_main_model_scene_page_and_navigation(self) -> None:
        with TemporaryDirectory() as td:
            window = self._loaded_window(Path(td) / "p")
            task_index = window._editor_labels.index("任务编排")
            scene_index = window._editor_labels.index("Scene")
            task = window._editor_instances[task_index]
            scene = window._editor_instances[scene_index]

            self.assertIsInstance(task, TaskOrchestrationEditor)
            self.assertIsInstance(scene, SceneEditor)
            self.assertIs(task._model, window._model)
            self.assertIs(scene._model, window._model)
            self.assertEqual(window._stack.count(), len(window._editor_instances) + 1)

            window._show_stack_page(scene_index)
            scene.select_zone_by_id("zone_event", "sc_a")
            QApplication.processEvents()
            scene._props._zn_poly_table.item(0, 1).setText("4.0")
            QApplication.processEvents()
            self.assertTrue(scene._props.is_pending_dirty())

            window._nav_tree.setCurrentItem(window._stack_index_to_item[task_index])
            QApplication.processEvents()
            self.assertEqual(window._stack.currentIndex(), task_index)
            self.assertEqual(
                window._model.scenes["sc_a"]["zones"][0]["polygon"][0]["x"],
                4.0,
            )

            task._new_event()
            task._event_transition_id.setText("draft_survives_map")
            with patch.object(window, "navigate_to_scene_entity") as navigate:
                task.scene_layout_requested.emit("sc_a", "zone", "zone_event")
                navigate.assert_called_once_with("zone", "zone_event", "sc_a")
            task.scene_layout_requested.emit("sc_a", "zone", "zone_event")
            QApplication.processEvents()
            self.assertEqual(window._stack.currentIndex(), scene_index)
            self.assertEqual(scene._current_scene_id, "sc_a")
            self.assertEqual(scene._props._source_zone["id"], "zone_event")

            window._show_stack_page(task_index)
            QApplication.processEvents()
            self.assertEqual(task._event_transition_id.text(), "draft_survives_map")
            self.assertTrue(task._event_form_pending)

    def test_invalid_scene_staging_refuses_task_page_activation(self) -> None:
        with TemporaryDirectory() as td:
            window = self._loaded_window(Path(td) / "p")
            task_index = window._editor_labels.index("任务编排")
            scene_index = window._editor_labels.index("Scene")
            scene = window._editor_instances[scene_index]
            window._show_stack_page(scene_index)

            with patch.object(scene, "flush_to_model", return_value=False), patch.object(
                QMessageBox, "warning",
            ) as warning:
                window._nav_tree.setCurrentItem(window._stack_index_to_item[task_index])
                QApplication.processEvents()

            self.assertEqual(window._stack.currentIndex(), scene_index)
            self.assertIs(
                window._nav_tree.currentItem(),
                window._stack_index_to_item[scene_index],
            )
            warning.assert_called_once()
            self.assertIn("修改仍保留", str(warning.call_args))

    def test_main_save_does_not_partially_apply_flow_when_event_draft_pending(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            window = self._loaded_window(root)
            task = window._editor_instances[window._editor_labels.index("任务编排")]
            graph_path = root / "public/assets/data/narrative_graphs.json"
            disk_before = graph_path.read_bytes()
            model_before = copy.deepcopy(window._model.narrative_graphs)

            task._flow_label.setText("只在表单里的新名字")
            task._mark_flow_text_pending()
            task._new_event()
            with patch.object(QMessageBox, "warning") as warning:
                self.assertTrue(window._save_all())

            self.assertEqual(window._model.narrative_graphs, model_before)
            self.assertEqual(graph_path.read_bytes(), disk_before)
            self.assertTrue(task._flow_text_pending)
            self.assertTrue(task._event_form_pending)
            self.assertIn("任务编排", str(warning.call_args))

    def test_apply_rollback_keeps_open_scene_projection_attached(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            window = self._loaded_window(root)
            scene_index = window._editor_labels.index("Scene")
            task_index = window._editor_labels.index("任务编排")
            scene = window._editor_instances[scene_index]
            task = window._editor_instances[task_index]
            window._show_stack_page(scene_index)
            scene.select_zone_by_id("zone_event", "sc_a")
            original_scenes = window._model.scenes
            original_zone = scene._props._source_zone
            self.assertIs(original_zone, window._model.scenes["sc_a"]["zones"][0])
            window._show_stack_page(task_index)
            self._configure_zone_dialogue_event(task)
            real_mark_dirty = window._model.mark_dirty
            calls = 0

            def fail_third_bucket(data_type: str, item_id: str = "") -> None:
                nonlocal calls
                calls += 1
                real_mark_dirty(data_type, item_id)
                if calls == 3:
                    raise RuntimeError("injected apply failure")

            with patch.object(
                window._model,
                "mark_dirty",
                side_effect=fail_third_bucket,
            ), patch.object(QMessageBox, "warning"):
                task._apply_event()

            self.assertIs(window._model.scenes, original_scenes)
            self.assertIs(scene._props._source_zone, original_zone)
            self.assertIs(original_zone, window._model.scenes["sc_a"]["zones"][0])
            window._show_stack_page(scene_index)
            scene._props._zn_poly_table.item(0, 1).setText("7.0")
            QApplication.processEvents()
            self.assertTrue(scene.flush_to_model())
            self.assertEqual(
                window._model.scenes["sc_a"]["zones"][0]["polygon"][0]["x"],
                7.0,
            )

    def test_single_domain_failure_then_discard_cannot_leave_hidden_model_change(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            window = self._loaded_window(root)
            task = window._editor_instances[window._editor_labels.index("任务编排")]
            narrative_path = root / "public/assets/data/narrative_graphs.json"
            disk_before = narrative_path.read_bytes()
            original_narrative = window._model.narrative_graphs
            original_label = original_narrative["compositions"][0].get("label")
            task._flow_label.setText("reported-failed-label")
            task._mark_flow_text_pending()

            def fail_narrative(data_type: str, item_id: str = "") -> None:
                if data_type == "narrative_graphs":
                    raise RuntimeError("injected single-domain failure")
                window._model.mark_dirty(data_type, item_id)

            with patch.object(
                window._model,
                "mark_dirty",
                side_effect=fail_narrative,
            ), patch.object(QMessageBox, "warning"):
                task._apply_flow_text()

            self.assertIs(window._model.narrative_graphs, original_narrative)
            self.assertEqual(
                window._model.narrative_graphs["compositions"][0].get("label"),
                original_label,
            )
            self.assertTrue(task._flow_text_pending)
            self.assertFalse(window._model.is_dirty)

            with patch(
                "tools.task_orchestration_editor.editor.QMessageBox.question",
                return_value=QMessageBox.StandardButton.Discard,
            ):
                self.assertTrue(task.confirm_close(window))
            self.assertFalse(task.has_pending_changes())
            window._model.scenes["sc_a"]["label"] = "其它正常修改"
            window._model.mark_dirty("scene", "sc_a")
            self.assertTrue(window._save_all())
            self.assertEqual(narrative_path.read_bytes(), disk_before)
            self.assertEqual(
                window._model.narrative_graphs["compositions"][0].get("label"),
                original_label,
            )

    def test_post_apply_ui_failure_rebases_old_pages_before_save(self) -> None:
        from tools.editor.editors.quest_editor import QuestEditor
        from tools.editor.project_model import ProjectModel

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _project(root)
            quest_path = root / "public/assets/data/quests.json"
            quest_path.write_text(json.dumps([{
                "id": "q1",
                "group": "",
                "type": "main",
                "title": "旧标题",
                "description": "",
                "preconditions": [],
                "completionConditions": [],
                "acceptActions": [],
                "rewards": [],
                "nextQuests": [],
            }], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            window = self._window_for_existing_root(root)
            quest_editor = next(
                editor for editor in window._editor_instances if isinstance(editor, QuestEditor)
            )
            task_index = window._editor_labels.index("任务编排")
            task = window._editor_instances[task_index]
            self.assertTrue(quest_editor.select_by_id("q1"))
            window._show_stack_page(task_index)
            self._configure_zone_dialogue_event(task, quest_id="q1")

            with patch.object(
                task,
                "_refresh_states",
                side_effect=RuntimeError("injected post-apply UI failure"),
            ), patch.object(QMessageBox, "critical"):
                task._apply_event()

            self.assertFalse(task.isEnabled())
            self.assertFalse(task._event_form_pending)
            self.assertEqual(window._stale_editor_locks, {})
            self.assertFalse(quest_editor._is_dirty())
            self.assertTrue(window._save_all())
            reopened = ProjectModel()
            reopened.load_project(root)
            quest = next(row for row in reopened.quests if row.get("id") == "q1")
            self.assertTrue(any(
                row.get("narrative") == "flow_event"
                for row in quest["completionConditions"]
            ))
            self.assertTrue(any(
                row.get("id") == "t_done"
                for row in reopened.narrative_graphs["compositions"][0]["mainGraph"]["transitions"]
            ))

    def test_main_scene_selection_rebases_to_live_entity_after_task_apply(self) -> None:
        with TemporaryDirectory() as td:
            window = self._loaded_window(Path(td) / "p")
            scene_index = window._editor_labels.index("Scene")
            task_index = window._editor_labels.index("任务编排")
            scene = window._editor_instances[scene_index]
            task = window._editor_instances[task_index]
            window._show_stack_page(scene_index)
            scene.select_zone_by_id("zone_event", "sc_a")
            window._show_stack_page(task_index)
            self._configure_zone_dialogue_event(task)
            task._apply_event()

            self.assertIs(
                scene._props._source_zone,
                window._model.scenes["sc_a"]["zones"][0],
            )
            scene._props._zn_poly_table.item(0, 1).setText("8.0")
            QApplication.processEvents()
            self.assertTrue(scene.flush_to_model())
            self.assertEqual(
                window._model.scenes["sc_a"]["zones"][0]["polygon"][0]["x"],
                8.0,
            )

    def test_native_rebase_publish_failure_locks_old_pages_and_all_save_paths(self) -> None:
        from tools.editor.editors.quest_editor import QuestEditor

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _project(root)
            quest_path = root / "public/assets/data/quests.json"
            quest_path.write_text(json.dumps([{
                "id": "q1",
                "group": "",
                "type": "main",
                "title": "旧标题",
                "description": "",
                "preconditions": [],
                "completionConditions": [],
                "acceptActions": [],
                "rewards": [],
                "nextQuests": [],
            }], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            disk_before = quest_path.read_bytes()
            window = self._window_for_existing_root(root)
            quest_editor = next(
                editor for editor in window._editor_instances if isinstance(editor, QuestEditor)
            )
            task = window._editor_instances[window._editor_labels.index("任务编排")]
            window._show_stack_page(window._editor_labels.index("任务编排"))
            self._configure_zone_dialogue_event(task, quest_id="q1")

            with patch.object(
                task,
                "_emit_native_domains_changed",
                side_effect=RuntimeError("injected publish failure"),
            ), patch.object(QMessageBox, "critical"):
                task._apply_event()

            quest = next(row for row in window._model.quests if row.get("id") == "q1")
            self.assertTrue(any(
                row.get("narrative") == "flow_event"
                for row in quest["completionConditions"]
            ))
            self.assertFalse(task.isEnabled())
            self.assertFalse(quest_editor.isEnabled())
            self.assertIn("quest", task.native_publish_failure_domains())
            self.assertIn(id(quest_editor), window._stale_editor_locks)
            with patch.object(window._model, "save_all") as save, patch.object(
                QMessageBox,
                "critical",
            ):
                self.assertFalse(window._save_all())
                self.assertFalse(window._confirm_can_replace_project())
                self.assertEqual(window._flush_editors_to_model(), (False, []))
            save.assert_not_called()
            self.assertEqual(quest_path.read_bytes(), disk_before)

    def test_external_overwrite_confirmation_refreshes_commit_baseline(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            window = self._loaded_window(root)
            task = window._editor_instances[window._editor_labels.index("任务编排")]
            path = root / "public/assets/data/narrative_graphs.json"
            external_doc = json.loads(path.read_text(encoding="utf-8"))
            external_doc["externalMarker"] = "first"
            path.write_text(
                json.dumps(external_doc, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            task._flow_label.setText("任务保存版本")
            task._mark_flow_text_pending()

            with patch.object(
                QMessageBox,
                "question",
                return_value=QMessageBox.StandardButton.Yes,
            ):
                self.assertTrue(window._save_all())

            saved = json.loads(path.read_text(encoding="utf-8"))
            self.assertNotIn("externalMarker", saved)
            self.assertEqual(saved["compositions"][0]["label"], "任务保存版本")

    def test_second_external_write_after_confirmation_is_preserved_and_blocks_save(self) -> None:
        from tools.editor.file_io import StagedJsonWriter

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            window = self._loaded_window(root)
            task = window._editor_instances[window._editor_labels.index("任务编排")]
            path = root / "public/assets/data/narrative_graphs.json"
            first = json.loads(path.read_text(encoding="utf-8"))
            first["externalMarker"] = "first"
            path.write_text(
                json.dumps(first, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            second = copy.deepcopy(first)
            second["externalMarker"] = "second-after-confirm"
            second_bytes = (
                json.dumps(second, ensure_ascii=False, indent=2) + "\n"
            ).encode("utf-8")
            task._flow_label.setText("不能覆盖第二次外改")
            task._mark_flow_text_pending()
            real_commit = StagedJsonWriter.commit

            def collide_at_commit(writer: StagedJsonWriter) -> None:
                path.write_bytes(second_bytes)
                real_commit(writer)

            with patch.object(
                QMessageBox,
                "question",
                return_value=QMessageBox.StandardButton.Yes,
            ), patch.object(QMessageBox, "critical"), patch(
                "tools.editor.file_io.StagedJsonWriter.commit",
                new=collide_at_commit,
            ):
                self.assertFalse(window._save_all())

            self.assertEqual(path.read_bytes(), second_bytes)
            self.assertTrue(window._model.is_dirty)

    def test_failed_old_page_rebase_locks_save_close_and_project_replace(self) -> None:
        from tools.editor.editors.quest_editor import QuestEditor

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _project(root)
            quest_path = root / "public/assets/data/quests.json"
            quest_path.write_text(json.dumps([{
                "id": "q1",
                "group": "",
                "type": "main",
                "title": "旧标题",
                "description": "",
                "preconditions": [],
                "completionConditions": [],
                "acceptActions": [],
                "rewards": [],
                "nextQuests": [],
            }], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            disk_before = quest_path.read_bytes()
            window = self._window_for_existing_root(root)
            quest_editor = next(
                editor for editor in window._editor_instances if isinstance(editor, QuestEditor)
            )
            task_index = window._editor_labels.index("任务编排")
            task = window._editor_instances[task_index]
            self.assertTrue(quest_editor.select_by_id("q1"))
            window._show_stack_page(task_index)
            self._configure_zone_dialogue_event(task, quest_id="q1")

            with patch.object(
                quest_editor,
                "reload_from_model",
                side_effect=RuntimeError("injected rebase failure"),
            ), patch.object(QMessageBox, "critical"):
                task._apply_event()

            quest = next(row for row in window._model.quests if row.get("id") == "q1")
            self.assertTrue(any(
                row.get("narrative") == "flow_event"
                for row in quest["completionConditions"]
            ))
            self.assertFalse(quest_editor.isEnabled())
            self.assertIn(id(quest_editor), window._stale_editor_locks)

            with patch.object(window._model, "save_all") as save, patch.object(
                QMessageBox, "critical",
            ):
                self.assertFalse(window._save_all())
                self.assertFalse(window._confirm_can_replace_project())
                self.assertEqual(window._flush_editors_to_model(), (False, []))
            save.assert_not_called()
            self.assertEqual(quest_path.read_bytes(), disk_before)
            quest = next(row for row in window._model.quests if row.get("id") == "q1")
            self.assertTrue(any(
                row.get("narrative") == "flow_event"
                for row in quest["completionConditions"]
            ))

    def test_load_anomaly_locks_task_compile_and_task_owned_save(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _project(root)
            window = self._window_for_existing_root(
                root,
                anomalies=["narrative_graphs.json: 一条记录被降级忽略"],
            )
            task = window._editor_instances[window._editor_labels.index("任务编排")]
            self.assertFalse(task.isEnabled())
            before = copy.deepcopy(window._model.narrative_graphs)
            with patch(
                "tools.task_orchestration_editor.editor.build_event_plan",
            ) as build, patch.object(QMessageBox, "critical"):
                task._apply_event()
            build.assert_not_called()
            self.assertEqual(window._model.narrative_graphs, before)

            window._model.narrative_graphs = copy.deepcopy(before)
            window._model.narrative_graphs["_unsafe_probe"] = True
            window._model.mark_dirty("narrative_graphs")
            task._mutated_native_domains.add("narrative_graphs")
            disk_path = root / "public/assets/data/narrative_graphs.json"
            disk_before = disk_path.read_bytes()
            with patch.object(window._model, "save_all") as save, patch.object(
                QMessageBox, "critical",
            ):
                self.assertFalse(window._save_all())
            save.assert_not_called()
            self.assertEqual(disk_path.read_bytes(), disk_before)
            self.assertTrue(window._model.is_dirty)

    def test_applied_event_is_visible_in_old_editors_and_saved_by_main_window(self) -> None:
        from tools.editor.editors.dialogue_graph_editor_tab import DialogueGraphEditorTab

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            window = self._loaded_window(root)
            task_index = window._editor_labels.index("任务编排")
            task = window._editor_instances[task_index]
            dialogue = next(
                editor for editor in window._editor_instances
                if isinstance(editor, DialogueGraphEditorTab)
            )
            window._show_stack_page(task_index)
            self._configure_zone_dialogue_event(task)
            task._apply_event()
            self.assertFalse(task._event_form_pending)
            tree_labels = [item.text(0) for item in dialogue._panel._walk_file_tree_items()]
            self.assertIn("event_flow__t_done__dialogue.json", tree_labels)
            dialogue.open_graph_by_id("event_flow__t_done__dialogue")
            self.assertEqual(dialogue._panel.current_path().stem, "event_flow__t_done__dialogue")

            self.assertTrue(window._save_all())
            self.assertTrue(
                (root / "public/assets/dialogues/graphs/event_flow__t_done__dialogue.json").is_file()
            )
            from tools.editor.project_model import ProjectModel
            from tools.editor.editors.narrative_state_editor import NarrativeStateEditor
            from tools.editor.editors.quest_editor import QuestEditor

            reopened = ProjectModel()
            reopened.load_project(root)
            old_editors = [SceneEditor(reopened), NarrativeStateEditor(reopened), QuestEditor(reopened)]
            try:
                self.assertTrue(any(
                    row.get("id") == "t_done"
                    for row in reopened.narrative_graphs["compositions"][0]["mainGraph"]["transitions"]
                ))
                self.assertTrue(any(
                    action.get("type") == "startDialogueGraph"
                    for action in reopened.scenes["sc_a"]["zones"][0]["onEnter"]
                ))
            finally:
                for editor in old_editors:
                    editor.deleteLater()
                QApplication.processEvents()

    def test_quest_page_rebases_after_task_apply_and_preserves_task_condition(self) -> None:
        from tools.editor.editors.quest_editor import QuestEditor

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _project(root)
            quest_path = root / "public/assets/data/quests.json"
            quest_path.write_text(json.dumps([{
                "id": "q1",
                "group": "",
                "type": "main",
                "title": "旧标题",
                "description": "",
                "preconditions": [],
                "completionConditions": [],
                "acceptActions": [],
                "rewards": [],
                "nextQuests": [],
            }], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            window = self._window_for_existing_root(root)
            quest_editor = next(
                editor for editor in window._editor_instances if isinstance(editor, QuestEditor)
            )
            task_index = window._editor_labels.index("任务编排")
            task = window._editor_instances[task_index]
            self.assertTrue(quest_editor.select_by_id("q1"))
            window._show_stack_page(task_index)
            self._configure_zone_dialogue_event(task, quest_id="q1")
            task._apply_event()

            quest = next(row for row in window._model.quests if row.get("id") == "q1")
            self.assertTrue(any(row.get("narrative") == "flow_event" for row in quest["completionConditions"]))
            quest_editor._q_title.setText("改过标题")
            self.assertTrue(quest_editor._apply_quest())
            quest = next(row for row in window._model.quests if row.get("id") == "q1")
            self.assertEqual(quest["title"], "改过标题")
            self.assertTrue(any(row.get("narrative") == "flow_event" for row in quest["completionConditions"]))

    def test_dirty_dialogue_cancel_refuses_task_navigation_without_disk_write(self) -> None:
        from tools.editor.editors.dialogue_graph_editor_tab import DialogueGraphEditorTab

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            window = self._loaded_window(root)
            task_index = window._editor_labels.index("任务编排")
            dialogue_index = next(
                index for index, editor in enumerate(window._editor_instances)
                if isinstance(editor, DialogueGraphEditorTab)
            )
            dialogue = window._editor_instances[dialogue_index]
            source = root / "public/assets/dialogues/graphs/source_dialogue.json"
            before = source.read_bytes()
            dialogue.open_graph_by_id("source_dialogue")
            dialogue._panel._mark_dirty()
            self.assertTrue(dialogue.is_dirty_now())
            window._show_stack_page(dialogue_index)

            with patch.object(
                QMessageBox,
                "question",
                return_value=QMessageBox.StandardButton.Cancel,
            ), patch.object(QMessageBox, "warning"):
                window._nav_tree.setCurrentItem(window._stack_index_to_item[task_index])
                QApplication.processEvents()

            self.assertEqual(window._stack.currentIndex(), dialogue_index)
            self.assertTrue(dialogue.is_dirty_now())
            self.assertEqual(source.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
