from __future__ import annotations

import os
import json
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from PIL import Image

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtGui import QCloseEvent
from PySide6.QtWidgets import QApplication, QComboBox, QScrollArea

from tools.editor.tests.test_production_workbench_asset_audit import _png_bytes
from tools.editor.tests.test_production_workbench_story_units import _write_story_unit_project
from tools.production_workbench.workbench_window import (
    AssetAuditThread,
    AssetCandidateListThread,
    AssetTaskSuggestionResult,
    AssetTaskSuggestionThread,
    CodexProbeThread,
    DailyCheckThread,
    WorkbenchWindow,
    SearchPickerDialog,
    _asset_items,
    _build_acceptance_draft,
    _fmt_point,
    _open_file_in_vscode,
    _planner_self_check_report,
    _planner_workflow_guide,
    _production_status_items,
    _resolve_scene_background_path,
    _script_status_items,
    _story_unit_source_items,
    _unit_type_items,
    _zone_items,
)
from tools.production_workbench.codex_probe import CodexProbeResult
from tools.production_workbench.daily_check import DailyCheckReport
from tools.production_workbench.story_acceptance import check_story_unit_acceptance_script
from tools.production_workbench.report_log import workbench_reports_root
from tools.production_workbench.story_units import load_story_unit_workspace
from tools.production_workbench.codex_asset_runner import CodexAssetRunResult, CodexEventSummary, asset_task_runs_root
from tools.production_workbench.runtime_command import enqueue_runtime_command
from tools.production_workbench.runtime_debug import runtime_debug_snapshot_path
from tools.editor.project_model import ProjectModel


def _wait_for_qt(condition, *, timeout_sec: float = 5.0) -> None:
    deadline = time.monotonic() + timeout_sec
    while time.monotonic() < deadline:
        QApplication.processEvents()
        if condition():
            return
        time.sleep(0.01)
    raise AssertionError("timed out waiting for Qt condition")


def _reload_story_tab(tab) -> None:
    tab.reload()
    _wait_for_qt(lambda: tab._story_thread is None)


class ProductionWorkbenchStoryUnitGuiTests(TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def test_acceptance_step_table_edits_generated_script_lines(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            tab = window.story_tab
            _reload_story_tab(tab)

            tab.edit_script_actions.setPlainText("dialogue:ringboy\nadvance")
            tab.edit_script_options.setPlainText("option:ask")
            tab.edit_script_expected_signals.setPlainText("ringboy.met")
            tab.refresh_acceptance_steps_table()

            self.assertEqual(tab.acceptance_steps_table.rowCount(), 4)
            self.assertEqual(
                [tab.acceptance_steps_table.item(i, 2).text() for i in range(4)],
                ["dialogue:ringboy", "advance", "option:ask", "ringboy.met"],
            )

            tab.acceptance_steps_table.selectRow(1)
            tab.move_selected_acceptance_step_up()
            self.assertEqual(tab.edit_script_actions.toPlainText().splitlines()[0], "advance")

            tab.delete_selected_acceptance_step()
            self.assertNotIn("advance", tab.edit_script_actions.toPlainText().splitlines())

    def test_spatial_and_asset_picker_sources_are_available(self) -> None:
        root = Path.cwd()
        window = WorkbenchWindow(root)
        tab = window.story_tab
        model = tab._load_picker_model()
        scene = model.scenes["teahouse"]

        background = _resolve_scene_background_path(root, "teahouse", scene)

        self.assertIsNotNone(background)
        self.assertTrue(background.is_file() if background else False)
        self.assertTrue(_asset_items(root))
        self.assertIsInstance(_zone_items(model), list)
        self.assertEqual(_fmt_point(10.0, 20.5), "10,20.5")

    def test_asset_picker_uses_fast_file_index_not_deep_audit(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            prop = root / "public" / "resources" / "runtime" / "images" / "props"
            prop.mkdir(parents=True)
            (prop / "ring.png").write_bytes(b"not a real image")

            with patch("tools.production_workbench.workbench_window.audit_asset_specs", side_effect=AssertionError("deep scan")):
                items = _asset_items(root)

            self.assertEqual(len(items), 1)
            self.assertEqual(items[0]["value"], "public/resources/runtime/images/props/ring.png")
            self.assertIn("category: prop", items[0]["detail"])

    def test_story_status_fields_use_picker_backed_line_edits(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            tab = window.story_tab
            _reload_story_tab(tab)

            self.assertTrue(tab.edit_type.isReadOnly())
            self.assertTrue(tab.edit_status.isReadOnly())
            self.assertTrue(tab.edit_script_status.isReadOnly())
            self.assertTrue(_unit_type_items())
            self.assertTrue(_production_status_items())
            self.assertTrue(_script_status_items())

            tab.edit_type.setText("支线")
            tab.edit_status.setText("制作中")
            tab.edit_script_status.setText("未跑")
            tab._save_current_fields()
            unit = tab._current_unit()

            self.assertIsNotNone(unit)
            self.assertEqual(unit.record.unit_type, "支线")
            self.assertEqual(unit.record.production_status, "制作中")
            self.assertEqual(unit.record.acceptance_script.last_run_status, "未跑")

    def test_generate_acceptance_draft_from_story_summary(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            tab = window.story_tab
            _reload_story_tab(tab)
            unit = tab._current_unit()
            self.assertIsNotNone(unit)

            draft = _build_acceptance_draft(unit)

            self.assertEqual(draft["startEntry"], "dialogue:ringboy")
            self.assertEqual(draft["actions"], ["走完对话"])
            self.assertEqual(draft["expectedSignals"], ["ringboy.met"])
            self.assertEqual(draft["expectedStates"], ["ringboy_flow.done"])
            self.assertEqual(draft["expectedQuests"], ["bridge_find_source active"])

            tab.generate_acceptance_draft()
            unit = tab._current_unit()
            self.assertEqual(unit.record.acceptance_script.start_entry, "dialogue:ringboy")
            report = check_story_unit_acceptance_script(root, unit)
            self.assertTrue(report.ok, [issue.message for issue in report.issues])

    def test_planner_self_check_reports_next_action(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            tab = window.story_tab
            _reload_story_tab(tab)
            unit = tab._current_unit()

            empty_report = _planner_self_check_report(root, unit)

            self.assertIn("剧情入口", empty_report)
            self.assertIn("还没有验收路线", empty_report)

            tab.edit_type.setText("支线")
            tab.edit_status.setText("制作中")
            tab.edit_entry.setPlainText("玩家进入集市巷")
            tab.edit_exit.setPlainText("ringboy_flow.done")
            tab.edit_acceptance.setPlainText("发出 ringboy.met")
            tab.generate_acceptance_draft()
            unit = tab._current_unit()

            ready_report = _planner_self_check_report(root, unit)

            self.assertIn("脚本检查", ready_report)
            self.assertIn("通过", ready_report)
            self.assertIn("待验收", ready_report)

    def test_planner_workflow_guide_is_actionable_by_current_state(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            tab = window.story_tab
            _reload_story_tab(tab)
            unit = tab._current_unit()

            empty_guide = _planner_workflow_guide(root, unit)

            self.assertIn("照着做", empty_guide)
            self.assertIn("剧情入口", empty_guide)
            self.assertIn("生成验收草稿", empty_guide)

            tab.edit_type.setText("支线")
            tab.edit_status.setText("制作中")
            tab.edit_entry.setPlainText("玩家进入集市巷")
            tab.edit_exit.setPlainText("ringboy_flow.done")
            tab.edit_acceptance.setPlainText("发出 ringboy.met")
            tab.generate_acceptance_draft()
            unit = tab._current_unit()

            ready_guide = _planner_workflow_guide(root, unit)

            self.assertIn("待验收", ready_guide)

            tab.edit_status.setText("待验收")
            tab._save_current_fields()
            unit = tab._current_unit()

            acceptance_guide = _planner_workflow_guide(root, unit)

            self.assertIn("npm run dev", acceptance_guide)
            self.assertIn("2. 发送到游戏运行", acceptance_guide)

    def test_planner_workbench_uses_search_picker_fields_not_combo_boxes(self) -> None:
        root = Path.cwd()
        window = WorkbenchWindow(root)

        self.assertEqual(window.findChildren(QComboBox), [])
        self.assertTrue(window.graph_tab.edit_composition.isReadOnly())
        self.assertTrue(window.asset_candidate_tab.edit_review.isReadOnly())
        self.assertTrue(window.asset_candidate_tab.edit_post_format.isReadOnly())
        self.assertTrue(window.image_tab.edit_format.isReadOnly())
        self.assertTrue(window.asset_task_tab.edit_category.isReadOnly())
        self.assertTrue(window.asset_task_tab.edit_operation.isReadOnly())
        self.assertTrue(window.asset_task_tab.edit_transparent.isReadOnly())

    def test_search_picker_filters_and_accepts_current_row(self) -> None:
        picker = SearchPickerDialog(
            "选择",
            [
                {"value": "ringboy", "label": "戒指男孩", "detail": "dialogue npc", "keywords": "码头"},
                {"value": "bridge", "label": "断桥", "detail": "quest", "keywords": "河边"},
            ],
        )

        picker.search.setText("男孩 dialogue")
        self.assertEqual(picker.list.count(), 1)

        picker.search.returnPressed.emit()

        self.assertIsNotNone(picker.selected)
        self.assertEqual(picker.selected["value"], "ringboy")

    def test_story_unit_project_switch_does_not_load_synchronously(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)

            with patch("tools.production_workbench.workbench_window.load_story_unit_workspace", side_effect=AssertionError("sync story")):
                window = WorkbenchWindow(root)

            self.assertIsNone(window.story_tab.workspace)
            self.assertIn("准备加载剧情单元", window.story_tab.summary.toPlainText())

    def test_story_unit_loading_disables_current_unit_actions(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)

            def slow_load(project_root: Path):
                time.sleep(0.05)
                return load_story_unit_workspace(project_root)

            with patch("tools.production_workbench.workbench_window.load_story_unit_workspace", side_effect=slow_load):
                window = WorkbenchWindow(root)
                tab = window.story_tab

                tab.reload()

                self.assertFalse(tab.btn_refresh.isEnabled())
                for button in tab._story_action_buttons():
                    self.assertFalse(button.isEnabled(), button.text())

                _wait_for_qt(lambda: tab._story_thread is None)

            self.assertTrue(tab.btn_refresh.isEnabled())
            for button in tab._story_action_buttons():
                self.assertTrue(button.isEnabled(), button.text())

    def test_workbench_close_is_blocked_while_background_job_runs(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)

            def slow_load(project_root: Path):
                time.sleep(0.05)
                return load_story_unit_workspace(project_root)

            with patch("tools.production_workbench.workbench_window.load_story_unit_workspace", side_effect=slow_load):
                window = WorkbenchWindow(root)
                tab = window.story_tab
                tab.reload()

                event = QCloseEvent()
                with patch("tools.production_workbench.workbench_window.QMessageBox.information", return_value=None) as info:
                    window.closeEvent(event)

                self.assertFalse(event.isAccepted())
                self.assertTrue(info.called)
                _wait_for_qt(lambda: tab._story_thread is None)

            event = QCloseEvent()
            window.closeEvent(event)
            self.assertTrue(event.isAccepted())

    def test_project_switch_is_blocked_while_background_job_runs(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)

            def slow_load(project_root: Path):
                time.sleep(0.05)
                return load_story_unit_workspace(project_root)

            with patch("tools.production_workbench.workbench_window.load_story_unit_workspace", side_effect=slow_load):
                window = WorkbenchWindow(root)
                tab = window.story_tab
                tab.reload()

                with patch(
                    "tools.production_workbench.workbench_window.QFileDialog.getExistingDirectory",
                    side_effect=AssertionError("project picker should not open while a job is running"),
                ), patch("tools.production_workbench.workbench_window.QMessageBox.information", return_value=None) as info:
                    window._pick_project()

                self.assertTrue(info.called)
                _wait_for_qt(lambda: tab._story_thread is None)

    def test_story_unit_picker_model_is_cached_until_refresh(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            tab = window.story_tab
            calls: list[Path] = []
            original = ProjectModel.load_project

            def counted_load(model: ProjectModel, project_root: Path) -> None:
                calls.append(Path(project_root))
                original(model, project_root)

            with patch("tools.production_workbench.workbench_window.ProjectModel.load_project", new=counted_load):
                first = tab._load_picker_model()
                second = tab._load_picker_model()
                tab._invalidate_picker_model()
                third = tab._load_picker_model()

            self.assertIs(first, second)
            self.assertIsNot(second, third)
            self.assertEqual(len(calls), 2)

    def test_busy_toolbar_rows_are_scrollable(self) -> None:
        root = Path.cwd()
        window = WorkbenchWindow(root)

        toolbars = window.findChildren(QScrollArea, "workbenchScrollableToolbar")

        self.assertGreaterEqual(len(toolbars), 6)
        for toolbar in toolbars:
            self.assertFalse(toolbar.verticalScrollBar().isVisible())
            self.assertIsNotNone(toolbar.widget())

    def test_open_reports_folder_creates_and_opens_report_root(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)

            with patch("tools.production_workbench.workbench_window.QDesktopServices.openUrl", return_value=True) as open_url:
                window.open_reports_folder()

            report_root = workbench_reports_root(root)
            self.assertTrue(report_root.is_dir())
            self.assertTrue(open_url.called)
            self.assertEqual(Path(open_url.call_args.args[0].toLocalFile()), report_root)

    def test_story_unit_source_items_include_runtime_source_files(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            tab = window.story_tab
            _reload_story_tab(tab)
            unit = tab._current_unit()
            self.assertIsNotNone(unit)
            with patch("tools.production_workbench.workbench_window.QMessageBox.information", return_value=None):
                tab.save()
            unit.record.acceptance_script.start_entry = "scene:sc_a spawn:door"
            unit.record.acceptance_script.actions = ["npc:npc_guard", "hotspot:well"]
            (root / "public" / "assets" / "scenes" / "sc_b.json").write_text(
                """
{
  "id": "sc_b",
  "name": "B",
  "npcs": [{"id": "npc_guard"}],
  "hotspots": [{"id": "well"}],
  "zones": [{"id": "market_lane"}],
  "spawnPoints": {}
}
""".strip()
                + "\n",
                encoding="utf-8",
            )

            items = _story_unit_source_items(root, unit)
            paths = {Path(item["path"]).name for item in items if isinstance(item.get("path"), Path)}

            self.assertIn("story_units.json", paths)
            self.assertIn("narrative_graphs.json", paths)
            self.assertIn("ringboy.json", paths)
            self.assertIn("sc_a.json", paths)
            self.assertIn("sc_b.json", paths)

    def test_open_current_sources_uses_picker_and_desktop_open(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            tab = window.story_tab
            _reload_story_tab(tab)

            items = _story_unit_source_items(root, tab._current_unit())
            selected = next(item for item in items if Path(item["path"]).name == "narrative_graphs.json")
            with patch("tools.production_workbench.workbench_window._pick_item_dialog", return_value=selected), patch(
                "tools.production_workbench.workbench_window.shutil.which",
                return_value=None,
            ), patch(
                "tools.production_workbench.workbench_window.QDesktopServices.openUrl",
                return_value=True,
            ) as open_url:
                tab.open_current_sources()

            self.assertTrue(open_url.called)
            self.assertEqual(Path(open_url.call_args.args[0].toLocalFile()), selected["path"])

    def test_graph_diagnostics_can_open_selected_composition_sources(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            graph_tab = window.graph_tab
            graph_tab.reload()
            _wait_for_qt(lambda: graph_tab._graph_thread is None)
            graph_tab.edit_composition.setText("unit_ringboy_intro")
            graph_tab.edit_composition.setProperty("pickerValue", "unit_ringboy_intro")
            unit = load_story_unit_workspace(root).by_id()["unit_ringboy_intro"]
            selected = next(
                item
                for item in _story_unit_source_items(root, unit)
                if Path(item["path"]).name == "narrative_graphs.json"
            )

            with patch("tools.production_workbench.workbench_window._pick_item_dialog", return_value=selected), patch(
                "tools.production_workbench.workbench_window.shutil.which",
                return_value=None,
            ), patch(
                "tools.production_workbench.workbench_window.QDesktopServices.openUrl",
                return_value=True,
            ) as open_url:
                graph_tab.open_sources()

            self.assertTrue(open_url.called)
            self.assertEqual(Path(open_url.call_args.args[0].toLocalFile()), selected["path"])

    def test_diagnostic_refresh_buttons_save_reports(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            report_root = workbench_reports_root(root)

            self.assertFalse(report_root.exists())

            window.graph_tab.refresh()
            window.runtime_debug_tab.refresh()
            window.asset_tab.refresh()
            _wait_for_qt(lambda: window.graph_tab._graph_thread is None)
            _wait_for_qt(lambda: window.asset_tab._asset_thread is None)

            report_names = {path.name for path in report_root.glob("*.txt")}
            self.assertTrue(any("graph-diagnostics" in name for name in report_names), report_names)
            self.assertTrue(any("runtime-debug-snapshot" in name for name in report_names), report_names)
            self.assertTrue(any("asset-audit" in name for name in report_names), report_names)

    def test_graph_diagnostics_project_switch_does_not_build_synchronously(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)

            with patch("tools.production_workbench.workbench_window.build_graph_diagnostics", side_effect=AssertionError("sync graph")):
                window = WorkbenchWindow(root)

            self.assertIsNone(window.graph_tab.report)
            self.assertIn("刷新 Graph 诊断", window.graph_tab.output.toPlainText())

    def test_asset_candidate_tab_can_open_candidate_file_and_run_dir(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            image = root / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
            image.parent.mkdir(parents=True)
            Image.new("RGBA", (16, 16), (10, 20, 30, 255)).save(image)
            run_dir = asset_task_runs_root(root) / "20260531-120000-asset-ring"
            run_dir.mkdir(parents=True)
            (run_dir / "summary.json").write_text(
                json.dumps(
                    {
                        "taskId": "asset-ring",
                        "eventSummary": {"savedPaths": ["public/resources/runtime/images/props/ring.png"]},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            window = WorkbenchWindow(root)
            tab = window.asset_candidate_tab
            tab.reload()
            _wait_for_qt(lambda: tab._candidate_thread is None)
            self.assertIn("报告已自动保存", tab.output.toPlainText())
            tab.table.selectRow(0)

            with patch("tools.production_workbench.workbench_window.QDesktopServices.openUrl", return_value=True) as open_url:
                tab.open_selected_candidate_file()
                tab.open_selected_run_dir()

            opened = [Path(call.args[0].toLocalFile()) for call in open_url.call_args_list]
            self.assertEqual(opened, [image.resolve(), run_dir.resolve()])

            tab.score_candidates()
            self.assertIn("素材候选交付评分", tab.output.toPlainText())
            self.assertIn("报告已自动保存", tab.output.toPlainText())
            tab.batch_create_redraw_tasks()
            self.assertIn("素材候选批量重抽任务", tab.output.toPlainText())
            tab.table.selectRow(0)
            tab.save_current_review("keep")
            _wait_for_qt(lambda: tab._candidate_thread is None)
            tab.batch_postprocess_candidates()
            _wait_for_qt(lambda: tab._postprocess_thread is None)

            self.assertTrue((image.parent / "ring_ready.png").is_file())
            self.assertTrue(tab.btn_batch_postprocess.isEnabled())
            self.assertIn("素材候选批量后处理", tab.output.toPlainText())
            report_names = {path.name for path in workbench_reports_root(root).glob("*.txt")}
            self.assertTrue(any("asset-candidates" in name for name in report_names), report_names)
            self.assertTrue(any("asset-candidate-score" in name for name in report_names), report_names)
            self.assertTrue(any("asset-candidate-redraw" in name for name in report_names), report_names)
            self.assertTrue(any("asset-candidate-postprocess" in name for name in report_names), report_names)

    def test_asset_candidate_tab_project_switch_does_not_load_candidates_synchronously(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)

            with patch("tools.production_workbench.workbench_window.list_asset_candidates", side_effect=AssertionError("sync candidates")):
                window = WorkbenchWindow(root)

            self.assertIsNone(window.asset_candidate_tab.report)
            self.assertIn("刷新候选", window.asset_candidate_tab.output.toPlainText())

    def test_asset_task_tab_path_buttons_fill_task_fields(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            output_dir = root / "public" / "resources" / "runtime" / "images" / "props"
            output_dir.mkdir(parents=True)
            target = output_dir / "new_ring.png"
            reference = output_dir / "old_ring.png"
            reference.write_bytes(_png_bytes(16, 16))
            window = WorkbenchWindow(root)
            tab = window.asset_task_tab

            with patch("tools.production_workbench.workbench_window.QFileDialog.getSaveFileName", return_value=(str(target), "")):
                tab.pick_target_file()
            with patch("tools.production_workbench.workbench_window.QFileDialog.getExistingDirectory", return_value=str(output_dir)):
                tab.pick_output_dir()
            ref_item = next(item for item in _asset_items(root) if item["value"].endswith("old_ring.png"))
            with patch("tools.production_workbench.workbench_window._pick_item_dialog", return_value=ref_item):
                tab.add_reference_asset()

            self.assertEqual(tab.edit_target.text(), "public/resources/runtime/images/props/new_ring.png")
            self.assertEqual(tab.edit_output_dir.text(), "public/resources/runtime/images/props")
            self.assertIn("old_ring.png", tab.edit_refs.toPlainText())
            self.assertIn("new_ring.png", tab.prompt.toPlainText())

    def test_asset_task_tab_project_switch_does_not_scan_assets_synchronously(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)

            with patch("tools.production_workbench.workbench_window.audit_asset_specs", side_effect=AssertionError("sync scan")):
                window = WorkbenchWindow(root)

            self.assertEqual(window.asset_task_tab.edit_category.property("pickerValue"), "illustration")
            self.assertIn("public/resources/runtime/images/illustrations", window.asset_task_tab.edit_output_dir.text())

    def test_asset_task_tab_saves_suggestion_and_codex_reports(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            tab = window.asset_task_tab

            tab._on_suggestion_failed(
                AssetTaskSuggestionResult(
                    project_root=root,
                    category="prop",
                    message="scan boom",
                )
            )
            tab._on_codex_task_failed("codex boom")
            tab._on_codex_task_completed(
                CodexAssetRunResult(
                    ok=True,
                    task_id="task_1",
                    started_at="2026-05-31T00-00-00",
                    ended_at="2026-05-31T00-00-01",
                    exit_code=0,
                    command=["codex"],
                    run_dir=root,
                    prompt_path=root / "prompt.md",
                    stdout_path=root / "stdout.jsonl",
                    stderr_path=root / "stderr.txt",
                    events_path=root / "events.jsonl",
                    summary_path=root / "summary.json",
                    last_message_path=root / "last-message.md",
                    event_summary=CodexEventSummary(
                        saved_paths=["public/resources/runtime/images/props/ring.png"],
                        token_usage=[{"inputTokens": 1, "outputTokens": 2, "totalTokens": 3}],
                    ),
                    message="ok",
                )
            )

            report_names = {path.name for path in workbench_reports_root(root).glob("*.txt")}
            self.assertTrue(any("asset-task-suggestion-failed" in name for name in report_names), report_names)
            self.assertTrue(any("asset-task-codex-failed" in name for name in report_names), report_names)
            self.assertTrue(any("asset-task-codex-run" in name for name in report_names), report_names)
            self.assertIn("报告已自动保存", tab.prompt.toPlainText())

    def test_asset_candidate_review_failure_is_saved(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            image = root / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
            image.parent.mkdir(parents=True)
            Image.new("RGBA", (16, 16), (10, 20, 30, 255)).save(image)
            run_dir = asset_task_runs_root(root) / "20260531-120000-asset-ring"
            run_dir.mkdir(parents=True)
            (run_dir / "summary.json").write_text(
                json.dumps(
                    {
                        "taskId": "asset-ring",
                        "eventSummary": {"savedPaths": ["public/resources/runtime/images/props/ring.png"]},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            window = WorkbenchWindow(root)
            tab = window.asset_candidate_tab
            tab.reload()
            _wait_for_qt(lambda: tab._candidate_thread is None)
            tab.table.selectRow(0)

            with patch("tools.production_workbench.workbench_window.save_candidate_review", side_effect=RuntimeError("review boom")):
                tab.save_current_review("keep")

            report_paths = list(workbench_reports_root(root).glob("*asset-candidate-review-failed*.txt"))
            self.assertEqual(len(report_paths), 1)
            self.assertIn("review boom", report_paths[0].read_text(encoding="utf-8"))
            self.assertIn("报告已自动保存", tab.output.toPlainText())

    def test_image_tool_save_runs_in_background_and_updates_output(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            source = root / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
            source.parent.mkdir(parents=True, exist_ok=True)
            Image.new("RGBA", (32, 24), (20, 40, 60, 255)).save(source)
            window = WorkbenchWindow(root)
            tab = window.image_tab
            tab.edit_source.setText("public/resources/runtime/images/props/ring.png")
            tab.edit_output.setText("public/resources/runtime/images/props/ring_small.png")
            tab.spin_resize_w.setValue(16)

            tab.save_image()
            _wait_for_qt(lambda: tab._image_thread is None)

            output = root / "public" / "resources" / "runtime" / "images" / "props" / "ring_small.png"
            self.assertTrue(output.is_file())
            self.assertTrue(tab.btn_save.isEnabled())
            self.assertIn("图片处理完成", tab.output.toPlainText())
            self.assertIn("报告已自动保存", tab.output.toPlainText())
            self.assertTrue(any("image-edit" in path.name for path in workbench_reports_root(root).glob("*.txt")))

    def test_image_tool_saves_preview_and_parameter_failure_reports(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            tab = window.image_tab

            tab.edit_source.setText("public/resources/runtime/images/props/missing.png")
            tab.load_preview()
            tab.edit_source.clear()
            tab.edit_output.clear()
            tab.save_image()

            report_names = {path.name for path in workbench_reports_root(root).glob("*.txt")}
            self.assertTrue(any("image-preview-failed" in name for name in report_names), report_names)
            self.assertTrue(any("image-edit-params-failed" in name for name in report_names), report_names)
            self.assertIn("报告已自动保存", tab.output.toPlainText())

    def test_animation_sheet_split_and_compose_run_in_background(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            sheet = root / "public" / "resources" / "runtime" / "animation" / "hero_sheet.png"
            sheet.parent.mkdir(parents=True, exist_ok=True)
            image = Image.new("RGBA", (32, 16), (0, 0, 0, 0))
            image.paste((255, 0, 0, 255), (0, 0, 16, 16))
            image.paste((0, 255, 0, 255), (16, 0, 32, 16))
            image.save(sheet)
            window = WorkbenchWindow(root)
            tab = window.animation_sheet_tab
            tab.edit_sheet_source.setText("public/resources/runtime/animation/hero_sheet.png")
            tab.spin_sheet_frame_count.setValue(2)
            tab.spin_sheet_columns.setValue(2)
            tab.edit_split_output_dir.setText("public/resources/runtime/animation/frames")
            tab.edit_split_prefix.setText("hero")

            tab.inspect_sheet()
            self.assertIn("动画 Sheet 检查", tab.output.toPlainText())
            self.assertIn("报告已自动保存", tab.output.toPlainText())

            tab.split_sheet()
            _wait_for_qt(lambda: tab._animation_thread is None)

            frame_dir = root / "public" / "resources" / "runtime" / "animation" / "frames"
            self.assertTrue((frame_dir / "hero_001.png").is_file())
            self.assertTrue((frame_dir / "hero_002.png").is_file())
            self.assertTrue(tab.btn_split_sheet.isEnabled())
            self.assertIn("动画 Sheet 拆帧完成", tab.output.toPlainText())
            self.assertIn("报告已自动保存", tab.output.toPlainText())

            tab.edit_compose_output.setText("public/resources/runtime/animation/hero_rebuilt.png")
            tab.spin_compose_count.setValue(2)
            tab.spin_compose_columns.setValue(2)
            tab.compose_sheet()
            _wait_for_qt(lambda: tab._animation_thread is None)

            self.assertTrue((root / "public" / "resources" / "runtime" / "animation" / "hero_rebuilt.png").is_file())
            self.assertTrue(tab.btn_compose_sheet.isEnabled())
            self.assertIn("动画 Sheet 合成完成", tab.output.toPlainText())
            report_names = {path.name for path in workbench_reports_root(root).glob("*.txt")}
            self.assertTrue(any("animation-sheet-inspect" in name for name in report_names), report_names)
            self.assertTrue(any("animation-sheet-split" in name for name in report_names), report_names)
            self.assertTrue(any("animation-sheet-compose" in name for name in report_names), report_names)

    def test_open_file_in_vscode_prefers_code_cli(self) -> None:
        with TemporaryDirectory() as td:
            path = Path(td) / "source.json"
            path.write_text("{}", encoding="utf-8")

            with patch("tools.production_workbench.workbench_window.shutil.which", return_value="code"), patch(
                "tools.production_workbench.workbench_window.subprocess.Popen",
            ) as popen:
                opened = _open_file_in_vscode(path)

            self.assertTrue(opened)
            self.assertEqual(popen.call_args.args[0], ["code", str(path)])

    def test_daily_check_thread_reports_progress_and_result(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            report = DailyCheckReport(project_root=root, ok=True, passed_checks=["smoke"])
            progress_messages: list[str] = []
            completed_reports: list[DailyCheckReport] = []
            failed_messages: list[str] = []

            def fake_daily_check(project_root: Path, *, progress=None, run_toolchain_checks: bool = False):
                self.assertEqual(project_root, root)
                self.assertTrue(run_toolchain_checks)
                if progress:
                    progress("检查 step")
                return report

            with patch("tools.production_workbench.workbench_window.run_daily_check", side_effect=fake_daily_check):
                thread = DailyCheckThread(root)
                thread.progress.connect(progress_messages.append)
                thread.completed.connect(completed_reports.append)
                thread.failed.connect(failed_messages.append)
                thread.run()

            self.assertEqual(progress_messages, ["检查 step"])
            self.assertEqual(completed_reports, [report])
            self.assertEqual(failed_messages, [])

    def test_daily_check_tab_saves_failed_run_report(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)

            window.daily_tab._on_daily_failed("boom")

            report_paths = list(workbench_reports_root(root).glob("*daily-check-failed*.txt"))
            self.assertEqual(len(report_paths), 1)
            self.assertIn("boom", report_paths[0].read_text(encoding="utf-8"))
            self.assertIn("报告已自动保存", window.daily_tab.output.toPlainText())

    def test_runtime_debug_tab_saves_queue_and_clear_reports(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            tab = window.runtime_debug_tab
            snapshot = runtime_debug_snapshot_path(root)
            snapshot.parent.mkdir(parents=True, exist_ok=True)
            snapshot.write_text("{}", encoding="utf-8")
            enqueue_runtime_command(root, "captureSnapshot", reason="test")

            tab.show_command_queue()
            tab.clear_command_queue()
            tab.clear_snapshot()

            report_names = {path.name for path in workbench_reports_root(root).glob("*.txt")}
            self.assertTrue(any("runtime-command-queue" in name for name in report_names))
            self.assertTrue(any("runtime-command-queue-clear" in name for name in report_names))
            self.assertTrue(any("runtime-debug-clear-snapshot" in name for name in report_names))
            self.assertIn("报告已自动保存", tab.output.toPlainText())

    def test_story_acceptance_failures_are_saved_and_copied(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            tab = window.story_tab
            _reload_story_tab(tab)

            with patch(
                "tools.production_workbench.workbench_window.check_story_unit_acceptance_script",
                side_effect=RuntimeError("check boom"),
            ):
                tab.check_acceptance_script()
            with patch(
                "tools.production_workbench.workbench_window.start_story_acceptance_run",
                side_effect=RuntimeError("start boom"),
            ):
                tab.start_acceptance_run()
            with patch(
                "tools.production_workbench.workbench_window.compare_story_unit_acceptance_to_runtime_snapshot",
                side_effect=RuntimeError("compare boom"),
            ):
                tab.compare_acceptance_runtime()
            with patch(
                "tools.production_workbench.workbench_window.finish_story_acceptance_run",
                side_effect=RuntimeError("finish boom"),
            ):
                tab.finish_acceptance_run()

            names = {path.name for path in workbench_reports_root(root).glob("*.txt")}
            self.assertTrue(any("story-acceptance-check-failed" in name for name in names))
            self.assertTrue(any("story-acceptance-start-failed" in name for name in names))
            self.assertTrue(any("story-acceptance-runtime-failed" in name for name in names))
            self.assertTrue(any("story-acceptance-finish-failed" in name for name in names))
            self.assertIn("报告已自动保存", tab.summary.toPlainText())
            self.assertIn("finish boom", QApplication.clipboard().text())

    def test_asset_audit_thread_reports_result_without_blocking_tab_logic(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            prop = root / "public" / "resources" / "runtime" / "images" / "props"
            prop.mkdir(parents=True)
            (prop / "ring.png").write_bytes(_png_bytes(16, 16))
            completed_results = []
            failed_results = []

            thread = AssetAuditThread(root, "audit", save_report=True)
            thread.completed.connect(completed_results.append)
            thread.failed.connect(failed_results.append)
            thread.run()

            self.assertEqual(failed_results, [])
            self.assertEqual(len(completed_results), 1)
            self.assertEqual(completed_results[0].operation, "audit")
            self.assertTrue(completed_results[0].save_report)
            self.assertEqual(len(completed_results[0].payload.images), 1)

    def test_asset_candidate_list_thread_reports_result(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            image = root / "public" / "resources" / "runtime" / "images" / "props" / "ring.png"
            image.parent.mkdir(parents=True)
            image.write_bytes(_png_bytes(16, 16))
            run_dir = asset_task_runs_root(root) / "20260531-120000-asset-ring"
            run_dir.mkdir(parents=True)
            (run_dir / "summary.json").write_text(
                json.dumps(
                    {
                        "taskId": "asset-ring",
                        "eventSummary": {"savedPaths": ["public/resources/runtime/images/props/ring.png"]},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            completed_results = []
            failed_results = []

            thread = AssetCandidateListThread(root, "candidate")
            thread.completed.connect(completed_results.append)
            thread.failed.connect(failed_results.append)
            thread.run()

            self.assertEqual(failed_results, [])
            self.assertEqual(len(completed_results), 1)
            self.assertEqual(len(completed_results[0].report.candidates), 1)

    def test_asset_task_suggestion_thread_builds_defaults_from_asset_audit(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            prop = root / "public" / "resources" / "runtime" / "images" / "props"
            prop.mkdir(parents=True)
            (prop / "ring.png").write_bytes(_png_bytes(32, 24))
            completed_results = []
            failed_results = []

            thread = AssetTaskSuggestionThread(root, "prop")
            thread.completed.connect(completed_results.append)
            thread.failed.connect(failed_results.append)
            thread.run()

            self.assertEqual(failed_results, [])
            self.assertEqual(len(completed_results), 1)
            self.assertEqual(completed_results[0].category, "prop")
            self.assertEqual(completed_results[0].defaults["width"], 32)
            self.assertEqual(completed_results[0].defaults["height"], 24)
            self.assertIn("ring.png", "\n".join(completed_results[0].defaults["referencePaths"]))

    def test_codex_probe_thread_reports_result(self) -> None:
        result = CodexProbeResult(executable="codex", ok=True)
        completed_results = []
        failed_messages = []

        with patch("tools.production_workbench.workbench_window.probe_codex", return_value=result):
            thread = CodexProbeThread()
            thread.completed.connect(completed_results.append)
            thread.failed.connect(failed_messages.append)
            thread.run()

        self.assertEqual(completed_results, [result])
        self.assertEqual(failed_messages, [])

    def test_codex_probe_tab_saves_failed_probe_report(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)

            window.codex_tab._on_probe_failed("boom")

            report_paths = list(workbench_reports_root(root).glob("*codex-probe-failed*.txt"))
            self.assertEqual(len(report_paths), 1)
            self.assertIn("boom", report_paths[0].read_text(encoding="utf-8"))
            self.assertIn("报告已自动保存", window.codex_tab.output.toPlainText())
