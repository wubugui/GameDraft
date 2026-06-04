from __future__ import annotations

import json
import os
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QSize, Qt
from PySide6.QtWidgets import QApplication, QDockWidget, QMainWindow, QSizePolicy, QSplitter

from tools.editor.tests.test_production_workbench_story_units import _write_story_unit_project
from tools.production_workbench.console import (
    CONSOLE_LINE_HEIGHT,
    SEVERITY_COLORS,
    WorkbenchConsoleDock,
    WorkbenchConsoleWidget,
    console_context_log_dir,
)
from tools.production_workbench.workbench_window import WorkbenchWindow


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


class ProductionWorkbenchConsoleTests(TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def test_console_filters_severity_text_and_searches_visible_entries(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            console = WorkbenchConsoleWidget(root, "story-unit", title="剧情单元")

            console.append("story ready", severity="info")
            console.append("warning: missing quest", severity="warning")
            console.append("error: missing signal", severity="error")
            console.append("debug trace hidden", severity="debug")

            self.assertIn("story ready", console.toPlainText())
            self.assertIn("debug trace hidden", console.toPlainText())

            console.set_severity_enabled("info", False)
            console.set_severity_enabled("debug", False)
            console.set_filter_text("missing")

            visible = console.visible_entries()
            self.assertEqual([entry.severity for entry in visible], ["warning", "error"])
            self.assertNotIn("story ready", console.toPlainText())
            self.assertNotIn("debug trace hidden", console.toPlainText())

            console.search_edit.setText("signal")
            self.assertTrue(console.search_next())
            self.assertEqual(console.output.textCursor().selectedText(), "signal")

            console.search_edit.setText("does-not-exist")
            self.assertFalse(console.search_next())

            console.set_filter_text("")
            console.set_severity_enabled("info", True)
            console.search_edit.setText("missing")
            self.assertTrue(console.search_next())
            first_position = console.output.textCursor().selectionStart()
            self.assertTrue(console.search_next())
            self.assertNotEqual(first_position, console.output.textCursor().selectionStart())

    def test_console_renders_distinct_severity_labels_and_colors(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            console = WorkbenchConsoleWidget(root, "severity-demo", title="Severity")

            console.append("plain info", severity="info")
            console.append("careful warning", severity="warning")
            console.append("hard error", severity="error")

            html = console.rendered_html()
            self.assertIn("[INFO]", console.output.toPlainText())
            self.assertIn("[WARNING]", console.output.toPlainText())
            self.assertIn("[ERROR]", console.output.toPlainText())
            self.assertEqual(SEVERITY_COLORS["info"], "")
            self.assertNotIn("#2563eb", html)
            self.assertIn(SEVERITY_COLORS["warning"], html)
            self.assertIn(SEVERITY_COLORS["error"], html)
            self.assertIn(f"line-height: {CONSOLE_LINE_HEIGHT}", html)

    def test_console_text_area_allows_free_substring_selection_and_copy(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            console = WorkbenchConsoleWidget(root, "selection-demo", title="Selection")

            console.append("alpha beta gamma", severity="info")
            cursor = console.output.document().find("beta")
            console.output.setTextCursor(cursor)
            console.output.copy()

            self.assertEqual(console.output.textCursor().selectedText(), "beta")
            self.assertEqual(QApplication.clipboard().text(), "beta")

    def test_console_dock_is_floatable_dockable_and_resizable(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = QMainWindow()
            dock = WorkbenchConsoleDock(root, "dock-demo", "Dock Demo", window)
            window.addDockWidget(Qt.DockWidgetArea.BottomDockWidgetArea, dock)

            features = dock.features()
            self.assertTrue(features & QDockWidget.DockWidgetFeature.DockWidgetFloatable)
            self.assertTrue(features & QDockWidget.DockWidgetFeature.DockWidgetMovable)
            self.assertTrue(features & QDockWidget.DockWidgetFeature.DockWidgetClosable)
            self.assertTrue(dock.allowedAreas() & Qt.DockWidgetArea.BottomDockWidgetArea)

            self.assertEqual(dock.minimumSize(), QSize(0, 0))
            self.assertEqual(dock.minimumSizeHint(), QSize(0, 0))
            self.assertEqual(dock.console.minimumSizeHint(), QSize(0, 0))

            dock.setFloating(True)
            dock.resize(120, 80)
            QApplication.processEvents()

            self.assertTrue(dock.isFloating())
            self.assertLessEqual(dock.width(), 180)
            self.assertLessEqual(dock.height(), 120)
            self.assertEqual(dock.console.sizePolicy().horizontalPolicy(), QSizePolicy.Policy.Expanding)

    def test_multiple_console_instances_write_separate_context_logs(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            story = WorkbenchConsoleWidget(root, "story/unit", title="Story")
            asset = WorkbenchConsoleWidget(root, "asset/tasks", title="Asset")

            story.set_context_info("unit_ringboy_intro")
            story.append("story-only message", severity="info", info=story.context_info)
            asset.append("asset-only message", severity="error", info="task_asset_ring")

            story_dir = console_context_log_dir(root, "story/unit")
            asset_dir = console_context_log_dir(root, "asset/tasks")
            self.assertTrue(story_dir.is_dir())
            self.assertTrue(asset_dir.is_dir())
            self.assertNotEqual(story_dir, asset_dir)

            story_payloads = [
                json.loads(line)
                for path in story_dir.glob("*.jsonl")
                for line in path.read_text(encoding="utf-8").splitlines()
            ]
            asset_payloads = [
                json.loads(line)
                for path in asset_dir.glob("*.jsonl")
                for line in path.read_text(encoding="utf-8").splitlines()
            ]

            self.assertTrue(any(payload["message"] == "story-only message" for payload in story_payloads))
            self.assertTrue(any(payload["message"] == "asset-only message" for payload in asset_payloads))
            self.assertTrue(any(payload["info"] == "unit_ringboy_intro" for payload in story_payloads))
            self.assertTrue(any(payload["info"] == "task_asset_ring" for payload in asset_payloads))
            self.assertFalse(any(payload["message"] == "asset-only message" for payload in story_payloads))
            self.assertFalse(any(payload["message"] == "story-only message" for payload in asset_payloads))

    def test_plain_text_reports_are_split_classified_and_filterable(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            console = WorkbenchConsoleWidget(root, "plain-report", title="Plain Report")

            console.setPlainText(
                "\n".join(
                    [
                        "每日检查: 通过",
                        "warning: 贴图格式不一致",
                        "ERROR: 找不到剧情入口",
                        "",
                        "报告已自动保存: somewhere",
                    ]
                )
            )

            self.assertEqual(len(console.entries()), 4)
            self.assertEqual([entry.severity for entry in console.entries()], ["info", "warning", "error", "info"])

            console.set_severity_enabled("info", False)
            self.assertNotIn("每日检查", console.toPlainText())
            self.assertIn("贴图格式", console.toPlainText())
            self.assertIn("找不到剧情入口", console.toPlainText())

            console.set_filter_text("不存在")
            self.assertEqual(console.visible_entries(), [])
            self.assertFalse(console.search_next())

            console.clear()
            self.assertEqual(len(console.entries()), 0)
            self.assertEqual(console.toPlainText(), "")

    def test_story_summary_report_uses_dock_console_without_overwriting_guide(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            tab = window.story_tab
            _reload_story_tab(tab)

            dock = window.console_dock("story-unit", "剧情单元摘要 / 检查报告")
            self.assertIs(tab.summary, dock.console)
            self.assertTrue(dock.features() & QDockWidget.DockWidgetFeature.DockWidgetFloatable)

            tab.show_planner_workflow_guide()
            guide_text = tab._workflow_guide_dialog.output.toPlainText()
            tab.show_planner_self_check()

            self.assertIn("当前单元自检", tab.summary.toPlainText())
            self.assertEqual(guide_text, tab._workflow_guide_dialog.output.toPlainText())

            tab.summary.set_filter_text("剧情入口")
            self.assertIn("剧情入口", tab.summary.toPlainText())

    def test_all_output_tabs_are_backed_by_contextual_console_docks(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)

            expected = [
                (window.story_tab, window.story_tab.summary, "story-unit"),
                (window.daily_tab, window.daily_tab.output, "daily-check"),
                (window.graph_tab, window.graph_tab.output, "graph-diagnostics"),
                (window.runtime_debug_tab, window.runtime_debug_tab.output, "runtime-debug"),
                (window.asset_tab, window.asset_tab.output, "asset-audit"),
                (window.asset_candidate_tab, window.asset_candidate_tab.output, "asset-candidates"),
                (window.image_tab, window.image_tab.output, "image-tools"),
                (window.animation_sheet_tab, window.animation_sheet_tab.output, "animation-sheet"),
                (window.asset_task_tab, window.asset_task_tab.prompt, "asset-task"),
                (window.codex_tab, window.codex_tab.output, "codex-probe"),
            ]

            for tab, console, context_id in expected:
                self.assertIsInstance(console, WorkbenchConsoleWidget, context_id)
                self.assertEqual(console.context_id, context_id)
                self.assertIn(tab, window._tab_console_docks)
                self.assertTrue(any(dock.console is console for dock in window._tab_console_docks[tab]))

            inline_docks = [
                window.daily_tab.output_dock,
                window.graph_tab.output_dock,
                window.runtime_debug_tab.output_dock,
                window.asset_tab.output_dock,
                window.asset_candidate_tab.output_dock,
                window.image_tab.output_dock,
                window.animation_sheet_tab.output_dock,
                window.asset_task_tab.prompt_dock,
                window.codex_tab.output_dock,
            ]
            for dock in inline_docks:
                self.assertTrue(dock.property("inlineConsole"))

            window.tabs.setCurrentWidget(window.graph_tab)
            QApplication.processEvents()
            self.assertTrue(window.graph_tab.output_dock.isHidden())
            self.assertTrue(window.daily_tab.output_dock.isHidden())

            window.story_tab.summary_dock.setFloating(True)
            window.story_tab.summary_dock.show()
            window.tabs.setCurrentWidget(window.asset_tab)
            QApplication.processEvents()

            self.assertFalse(window.story_tab.summary_dock.isHidden())
            self.assertTrue(window.asset_tab.output_dock.isHidden())
            self.assertTrue(window.graph_tab.output_dock.isHidden())
            _wait_for_qt(lambda: window.story_tab._story_thread is None)
            window.close()

    def test_inline_console_composite_tabs_are_resizable_splitters(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)

            consoles = [
                window.asset_candidate_tab.output,
                window.image_tab.output,
                window.animation_sheet_tab.output,
                window.asset_task_tab.prompt,
            ]
            for console in consoles:
                splitter = console.parent()
                self.assertIsInstance(splitter, QSplitter)
                self.assertGreaterEqual(splitter.count(), 2)
                self.assertFalse(splitter.isCollapsible(0))
                self.assertFalse(splitter.isCollapsible(1))

            _wait_for_qt(lambda: window.story_tab._story_thread is None)
            window.close()

    def test_runtime_debug_tab_keeps_hint_compact_and_embeds_console(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)

            tab = window.runtime_debug_tab
            self.assertEqual(tab.hint.sizePolicy().verticalPolicy(), QSizePolicy.Policy.Fixed)
            self.assertLessEqual(tab.hint.maximumHeight(), 40)
            self.assertEqual(tab.output.sizePolicy().verticalPolicy(), QSizePolicy.Policy.Expanding)
            self.assertGreaterEqual(tab.output.minimumHeight(), tab._MIN_OUTPUT_HEIGHT)
            self.assertTrue(tab.output_dock.property("inlineConsole"))
            self.assertEqual(tab.visual_tabs.currentIndex(), 0)
            self.assertGreaterEqual(tab.visual_tabs.indexOf(tab.command_page), 0)
            self.assertIs(tab.command_box.parent(), tab.command_splitter)
            self.assertEqual(tab.command_splitter.orientation(), Qt.Orientation.Vertical)

            window.tabs.setCurrentWidget(tab)
            window.show()
            QApplication.processEvents()
            tab.ensure_output_space()
            self.assertGreater(tab.output.height(), tab.hint.height() * 6)
            self.assertTrue(tab.output_dock.isHidden())

            _wait_for_qt(lambda: window.story_tab._story_thread is None)
            window.close()

    def test_tab_console_instances_keep_content_and_filters_isolated_on_switch(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            window = WorkbenchWindow(root)
            _wait_for_qt(lambda: window.story_tab._story_thread is None)

            consoles = [
                window.daily_tab.output,
                window.graph_tab.output,
                window.asset_tab.output,
                window.asset_task_tab.prompt,
            ]
            self.assertEqual(len({id(console) for console in consoles}), len(consoles))

            window.daily_tab.output.setPlainText("daily-only message\nwarning: daily warning")
            window.graph_tab.output.setPlainText("graph-only message\nerror: graph error")
            window.asset_tab.output.setPlainText("asset-only message")
            window.asset_task_tab.prompt.setPlainText("task-only prompt")

            window.daily_tab.output.set_filter_text("daily-only")

            window.tabs.setCurrentWidget(window.daily_tab)
            QApplication.processEvents()
            self.assertTrue(window.daily_tab.output_dock.isHidden())
            self.assertIn("daily-only message", window.daily_tab.output.toPlainText())
            self.assertNotIn("graph-only message", window.daily_tab.output.toPlainText())

            window.tabs.setCurrentWidget(window.graph_tab)
            QApplication.processEvents()
            self.assertTrue(window.daily_tab.output_dock.isHidden())
            self.assertTrue(window.graph_tab.output_dock.isHidden())
            self.assertIn("graph-only message", window.graph_tab.output.toPlainText())
            self.assertIn("graph error", window.graph_tab.output.toPlainText())
            self.assertEqual(window.graph_tab.output.filter_edit.text(), "")
            self.assertNotIn("daily-only message", window.graph_tab.output.toPlainText())

            window.tabs.setCurrentWidget(window.asset_tab)
            QApplication.processEvents()
            self.assertTrue(window.graph_tab.output_dock.isHidden())
            self.assertTrue(window.asset_tab.output_dock.isHidden())
            self.assertEqual(window.asset_tab.output.toPlainText(), "asset-only message")

            window.tabs.setCurrentWidget(window.asset_task_tab)
            QApplication.processEvents()
            self.assertTrue(window.asset_tab.output_dock.isHidden())
            self.assertTrue(window.asset_task_tab.prompt_dock.isHidden())
            self.assertEqual(window.asset_task_tab.prompt.toPlainText(), "task-only prompt")
            self.assertEqual(window.daily_tab.output.filter_edit.text(), "daily-only")
            window.close()
