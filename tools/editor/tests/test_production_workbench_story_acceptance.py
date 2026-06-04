from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from tools.editor.tests.test_production_workbench_story_units import _write_story_unit_project
from tools.production_workbench.runtime_debug import runtime_debug_snapshot_path
from tools.production_workbench.story_acceptance import (
    check_story_unit_acceptance_script,
    compare_story_unit_acceptance_to_runtime_snapshot,
    format_acceptance_check_report,
    format_acceptance_runtime_compare_report,
)
from tools.production_workbench.story_units import AcceptanceScript, load_story_unit_workspace


class ProductionWorkbenchStoryAcceptanceTests(TestCase):
    def test_acceptance_checker_validates_references(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            ws = load_story_unit_workspace(root)
            unit = ws.units[0]
            unit.record.entry = "进入集市巷"
            unit.record.acceptance_script = AcceptanceScript(
                start_entry="scene:test_scene 进入 zone:market_lane",
                setup_flags=["ringboy_seen == false"],
                setup_quests=["bridge_find_source: inactive"],
                setup_narrative_states=["ringboy_flow.intro"],
                actions=["打开 dialogue:ringboy", "推进到 option"],
                option_choices=["选择 option:帮忙"],
                expected_signals=["ringboy.met"],
                expected_narrative_states=["ringboy_flow.done"],
                expected_quest_changes=["bridge_find_source accepted"],
                save_load_check="保存读档后不重复触发。",
            )

            report = check_story_unit_acceptance_script(root, unit)
            text = format_acceptance_check_report(report)

            self.assertTrue(report.ok, text)
            self.assertIn("state:ringboy_flow.done", report.checked_items)
            self.assertIn("signal:ringboy.met", report.checked_items)
            self.assertIn("dialogue:ringboy", report.checked_items)
            self.assertIn("剧情单元验收脚本检查: 通过", text)

    def test_acceptance_checker_reports_missing_references(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(
                start_entry="入口",
                actions=["打开 dialogue:missing_dialogue"],
                expected_signals=["missing.signal"],
                expected_narrative_states=["missing_graph.done"],
                expected_quest_changes=["missing_quest accepted"],
                save_load_check="复查",
            )

            report = check_story_unit_acceptance_script(root, unit)

            self.assertFalse(report.ok)
            codes = {issue.code for issue in report.issues}
            self.assertIn("acceptance.dialogue.missing", codes)
            self.assertIn("acceptance.signal.missing", codes)
            self.assertIn("acceptance.graph.missing", codes)
            self.assertIn("acceptance.quest.missing", codes)

    def test_acceptance_checker_reports_required_missing_fields(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]

            report = check_story_unit_acceptance_script(root, unit)

            self.assertFalse(report.ok)
            self.assertTrue(any(issue.code == "acceptance.required" for issue in report.issues))

    def test_acceptance_checker_validates_scenario_phase_references(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            _write_json(
                root / "public" / "assets" / "data" / "scenarios.json",
                {
                    "scenarios": [
                        {
                            "id": "line_a",
                            "phases": {
                                "intro": {"status": "pending"},
                                "done": {"status": "pending"},
                            },
                        }
                    ]
                },
            )
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(
                start_entry="scene:test_scene",
                setup_scenarios=["line_a.intro done"],
                expected_scenario_changes=["scenario=line_a phase=done active"],
                actions=["dialogue:ringboy"],
                expected_signals=["ringboy.met"],
                save_load_check="manual",
            )

            report = check_story_unit_acceptance_script(root, unit)

            self.assertTrue(report.ok, format_acceptance_check_report(report))
            self.assertIn("scenario:line_a.intro", report.checked_items)
            self.assertIn("scenario:line_a.done", report.checked_items)

    def test_acceptance_checker_accepts_dynamic_registry_flags(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            _write_json(
                root / "public" / "assets" / "data" / "archive" / "characters.json",
                [{"id": "storyteller_zhang", "name": "storyteller"}],
            )
            _write_json(
                root / "public" / "assets" / "data" / "flag_registry.json",
                {
                    "static": [],
                    "patterns": [
                        {
                            "id": "archive_character",
                            "prefix": "archive_character_",
                            "idSource": "archive_character",
                            "valueType": "bool",
                        }
                    ],
                    "migrations": {},
                    "runtime": {},
                },
            )
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(
                start_entry="scene:test_scene",
                setup_flags=["archive_character_storyteller_zhang = false"],
                actions=["dialogue:ringboy"],
                expected_signals=["ringboy.met"],
                save_load_check="manual",
            )

            report = check_story_unit_acceptance_script(root, unit)

            self.assertTrue(report.ok, format_acceptance_check_report(report))
            self.assertFalse(any(issue.code == "acceptance.flag.unknown" for issue in report.issues))

    def test_runtime_compare_matches_latest_snapshot(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(
                start_entry="scene:test_scene",
                actions=["打开 dialogue:ringboy"],
                expected_signals=["ringboy.met"],
                expected_narrative_states=["ringboy_flow.done"],
                expected_quest_changes=["bridge_find_source accepted"],
                expected_scenario_changes=["line_a active"],
                save_load_check="保存读档后仍正确。",
            )
            _write_runtime_snapshot(
                root,
                active_states={"ringboy_flow": "done"},
                trace=[
                    {"type": "signal.received", "triggerKey": "ringboy.met"},
                    {"type": "transition.applied", "graphId": "ringboy_flow", "from": "intro", "to": "done"},
                ],
                quest_state={"bridge_find_source": 1},
                scenario_state={"lineLifecycle": {"line_a": "active"}},
                runtime_commands=[
                    {"type": "debugSaveGame", "ok": True, "message": "saved"},
                    {"type": "debugLoadGame", "ok": True, "message": "loaded"},
                ],
            )

            report = compare_story_unit_acceptance_to_runtime_snapshot(root, unit)
            text = format_acceptance_runtime_compare_report(report)

            self.assertTrue(report.ok, text)
            self.assertEqual(report.pass_count, 5)
            self.assertEqual(report.manual_count, 0)
            self.assertIn("剧情单元运行时验收对比: 通过", text)

    def test_runtime_compare_save_load_can_remain_manual_when_marked_manual(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(
                expected_signals=["ringboy.met"],
                save_load_check="人工确认保存读档后美术表现。",
            )
            _write_runtime_snapshot(
                root,
                active_states={},
                trace=[{"type": "signal.received", "triggerKey": "ringboy.met"}],
                quest_state={},
                scenario_state={},
            )

            report = compare_story_unit_acceptance_to_runtime_snapshot(root, unit)

            self.assertTrue(report.ok, format_acceptance_runtime_compare_report(report))
            self.assertEqual(report.manual_count, 1)

    def test_runtime_compare_reports_missing_expected_outcomes(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(
                start_entry="scene:test_scene",
                actions=["打开 dialogue:ringboy"],
                expected_signals=["ringboy.met"],
                expected_narrative_states=["ringboy_flow.done"],
                expected_quest_changes=["bridge_find_source completed"],
            )
            _write_runtime_snapshot(
                root,
                active_states={"ringboy_flow": "intro"},
                trace=[{"type": "signal.received", "triggerKey": "other.signal"}],
                quest_state={"bridge_find_source": 1},
                scenario_state={},
            )

            report = compare_story_unit_acceptance_to_runtime_snapshot(root, unit)

            self.assertFalse(report.ok)
            self.assertGreaterEqual(report.fail_count, 3)

    def test_runtime_compare_reports_missing_snapshot(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]

            report = compare_story_unit_acceptance_to_runtime_snapshot(root, unit)

            self.assertFalse(report.ok)
            self.assertFalse(report.runtime_ok)
            self.assertEqual(report.fail_count, 1)
            self.assertIn("runtime_debug_snapshot.json", str(report.snapshot_path))

    def test_runtime_compare_does_not_confuse_inactive_with_active(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(
                start_entry="scene:test_scene",
                actions=["打开 dialogue:ringboy"],
                expected_quest_changes=["bridge_find_source inactive"],
                expected_scenario_changes=["line_a inactive"],
            )
            _write_runtime_snapshot(
                root,
                active_states={},
                trace=[],
                quest_state={},
                scenario_state={"scenarios": {"line_a": {"phase_1": {"status": "pending"}}}},
            )

            report = compare_story_unit_acceptance_to_runtime_snapshot(root, unit)

            self.assertTrue(report.ok, format_acceptance_runtime_compare_report(report))
            self.assertEqual(report.pass_count, 2)

def _write_runtime_snapshot(
    root: Path,
    *,
    active_states: dict[str, str],
    trace: list[dict[str, object]],
    quest_state: dict[str, object],
    scenario_state: dict[str, object],
    runtime_commands: list[dict[str, object]] | None = None,
) -> None:
    path = runtime_debug_snapshot_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "ok": True,
        "capturedAt": "2026-05-31T12:00:00+08:00",
        "source": "test",
        "snapshot": {
            "reason": "test",
            "currentSceneId": "test_scene",
            "gameState": "Dialogue",
            "questState": quest_state,
            "scenarioState": scenario_state,
            "narrativeState": {
                "activeStates": active_states,
                "recentTrace": trace,
                "recentTransitions": [],
                "recentIssues": [],
            },
            "runtimeCommands": {
                "lastResults": runtime_commands or [],
            },
        },
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    import unittest

    unittest.main()
