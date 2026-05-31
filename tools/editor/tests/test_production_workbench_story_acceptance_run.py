from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from tools.editor.tests.test_production_workbench_story_units import _write_story_unit_project
from tools.production_workbench.runtime_command import load_runtime_command_queue
from tools.production_workbench.runtime_debug import runtime_debug_snapshot_path
from tools.production_workbench.story_acceptance_commands import (
    build_acceptance_entry_runtime_commands,
    build_acceptance_save_load_runtime_commands,
    build_acceptance_setup_runtime_commands,
)
from tools.production_workbench.story_acceptance_run import (
    finish_story_acceptance_run,
    start_story_acceptance_run,
)
from tools.production_workbench.story_units import AcceptanceScript, load_story_unit_workspace


class ProductionWorkbenchStoryAcceptanceRunTests(TestCase):
    def test_start_run_clears_old_snapshot_and_builds_run_sheet(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            snapshot = runtime_debug_snapshot_path(root)
            snapshot.parent.mkdir(parents=True)
            snapshot.write_text("{}", encoding="utf-8")
            unit = load_story_unit_workspace(root).units[0]
            unit.record.entry = "进入集市"
            unit.record.acceptance_script = _script()

            sheet = start_story_acceptance_run(root, unit)

            self.assertTrue(sheet.snapshot_cleared)
            self.assertTrue(sheet.command_enqueued)
            self.assertEqual(sheet.command_count, 13)
            self.assertFalse(snapshot.exists())
            self.assertIn("剧情单元半自动验收运行单", sheet.text)
            self.assertIn("运行中浏览器命令: 已发送 13 条", sheet.text)
            self.assertIn("ringboy.met", sheet.text)
            self.assertIn("完成验收并对比", sheet.text)
            queue = load_runtime_command_queue(root)
            self.assertTrue(queue.ok)
            self.assertEqual([x["type"] for x in queue.commands], [
                "setFlag",
                "debugSetNarrativeState",
                "debugSetQuestStatus",
                "clearNarrativeTrace",
                "debugSwitchScene",
                "captureSnapshot",
                "debugStartDialogueGraph",
                "debugAdvanceDialogue",
                "debugChooseDialogueOption",
                "debugAdvanceDialogue",
                "debugSaveGame",
                "debugWait",
                "debugLoadGame",
            ])
            self.assertEqual(queue.commands[0]["key"], "ringboy_seen")
            self.assertFalse(queue.commands[0]["value"])
            self.assertEqual(queue.commands[1]["graphId"], "ringboy_flow")
            self.assertEqual(queue.commands[1]["stateId"], "intro")
            self.assertEqual(queue.commands[2]["questId"], "bridge_find_source")
            self.assertEqual(queue.commands[2]["status"], 0)
            self.assertEqual(queue.commands[4]["sceneId"], "test_scene")
            self.assertEqual(queue.commands[6]["graphId"], "ringboy")
            self.assertEqual(queue.commands[8]["text"], "帮忙")
            self.assertEqual(queue.commands[10]["slot"], 2)
            self.assertEqual(queue.commands[12]["slot"], 2)

    def test_start_run_reports_unparsed_setup_commands(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(
                start_entry="scene:test_scene",
                setup_flags=["???"],
                setup_narrative_states=["not-a-state-ref"],
                actions=["打开 dialogue:ringboy"],
                expected_signals=["ringboy.met"],
                save_load_check="人工确认。",
            )

            sheet = start_story_acceptance_run(root, unit)

            self.assertTrue(sheet.command_enqueued)
            self.assertEqual(sheet.command_count, 4)
            self.assertEqual(len(sheet.command_warnings), 2)
            self.assertIn("自动命令 warning", sheet.text)
            queue = load_runtime_command_queue(root)
            self.assertEqual([x["type"] for x in queue.commands], [
                "clearNarrativeTrace",
                "debugSwitchScene",
                "captureSnapshot",
                "debugStartDialogueGraph",
            ])

    def test_start_entry_is_converted_before_ready_snapshot(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(start_entry="scene:test_scene spawn:door")

            plan = build_acceptance_entry_runtime_commands(unit)

            self.assertEqual(plan.warnings, [])
            self.assertEqual(plan.commands[0]["type"], "debugSwitchScene")
            self.assertEqual(plan.commands[0]["sceneId"], "test_scene")
            self.assertEqual(plan.commands[0]["spawnPoint"], "door")

    def test_acceptance_setup_can_build_scenario_debug_commands(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(
                setup_scenarios=[
                    "line_a.intro done",
                    "line_b completed",
                    "line_c inactive",
                ],
            )

            plan = build_acceptance_setup_runtime_commands(unit)

            self.assertEqual(plan.warnings, [])
            self.assertEqual([x["type"] for x in plan.commands], [
                "debugSetScenarioPhase",
                "debugSetScenarioLineLifecycle",
                "debugResetScenarioProgress",
            ])
            self.assertEqual(plan.commands[0]["scenarioId"], "line_a")
            self.assertEqual(plan.commands[0]["phase"], "intro")
            self.assertEqual(plan.commands[0]["status"], "done")
            self.assertEqual(plan.commands[1]["state"], "completed")

    def test_acceptance_route_can_build_scene_signal_and_interaction_commands(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(
                actions=[
                    "scene:test_scene spawn:door",
                    "signal:ringboy.met",
                    "hotspot:poster",
                    "npc:npc_ringboy",
                ],
            )

            from tools.production_workbench.story_acceptance_commands import build_acceptance_route_runtime_commands

            plan = build_acceptance_route_runtime_commands(unit)

            self.assertEqual(plan.warnings, [])
            self.assertEqual([x["type"] for x in plan.commands], [
                "debugSwitchScene",
                "emitNarrativeSignal",
                "debugTriggerHotspot",
                "debugInteractNpc",
            ])
            self.assertEqual(plan.commands[0]["sceneId"], "test_scene")
            self.assertEqual(plan.commands[0]["spawnPoint"], "door")
            self.assertEqual(plan.commands[1]["signal"], "ringboy.met")
            self.assertEqual(plan.commands[2]["hotspotId"], "poster")
            self.assertEqual(plan.commands[3]["npcId"], "npc_ringboy")

    def test_acceptance_route_can_build_wait_and_player_movement_commands(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(
                actions=[
                    "等待500ms",
                    "click:10,20",
                    "drag:10,20 -> 30,40 duration:250ms",
                    "player:100,200 snap:false",
                    "moveTo x=120 y=240 speed:220 snapCamera:true",
                ],
            )

            from tools.production_workbench.story_acceptance_commands import build_acceptance_route_runtime_commands

            plan = build_acceptance_route_runtime_commands(unit)

            self.assertEqual(plan.warnings, [])
            self.assertEqual([x["type"] for x in plan.commands], [
                "debugWait",
                "debugClick",
                "debugDrag",
                "debugSetPlayerPosition",
                "debugMovePlayerTo",
            ])
            self.assertEqual(plan.commands[0]["durationMs"], 500)
            self.assertEqual(plan.commands[1]["x"], 10.0)
            self.assertEqual(plan.commands[1]["y"], 20.0)
            self.assertEqual(plan.commands[2]["fromX"], 10.0)
            self.assertEqual(plan.commands[2]["fromY"], 20.0)
            self.assertEqual(plan.commands[2]["toX"], 30.0)
            self.assertEqual(plan.commands[2]["toY"], 40.0)
            self.assertEqual(plan.commands[2]["durationMs"], 250)
            self.assertEqual(plan.commands[3]["x"], 100.0)
            self.assertEqual(plan.commands[3]["y"], 200.0)
            self.assertFalse(plan.commands[3]["snapCamera"])
            self.assertEqual(plan.commands[4]["x"], 120.0)
            self.assertEqual(plan.commands[4]["y"], 240.0)
            self.assertEqual(plan.commands[4]["speed"], 220.0)
            self.assertTrue(plan.commands[4]["snapCamera"])

    def test_acceptance_route_can_build_multi_segment_player_path(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(
                actions=[
                    "path:100,200 -> 120,240 -> 160,260 speed:220 waitBetween:250",
                ],
            )

            from tools.production_workbench.story_acceptance_commands import build_acceptance_route_runtime_commands

            plan = build_acceptance_route_runtime_commands(unit)

            self.assertEqual(plan.warnings, [])
            self.assertEqual([x["type"] for x in plan.commands], [
                "debugMovePlayerTo",
                "debugWait",
                "debugMovePlayerTo",
                "debugWait",
                "debugMovePlayerTo",
            ])
            move_commands = [x for x in plan.commands if x["type"] == "debugMovePlayerTo"]
            self.assertEqual([(x["x"], x["y"]) for x in move_commands], [
                (100.0, 200.0),
                (120.0, 240.0),
                (160.0, 260.0),
            ])
            self.assertEqual([x["snapCamera"] for x in move_commands], [False, False, True])
            self.assertEqual([x["durationMs"] for x in plan.commands if x["type"] == "debugWait"], [250, 250])
            self.assertTrue(all(x["speed"] == 220.0 for x in move_commands))

    def test_option_choice_preserves_picker_text_with_punctuation(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(
                option_choices=["option:要铁环。"],
            )

            from tools.production_workbench.story_acceptance_commands import build_acceptance_route_runtime_commands

            plan = build_acceptance_route_runtime_commands(unit)

            self.assertEqual(plan.warnings, [])
            self.assertEqual(plan.commands[0]["type"], "debugChooseDialogueOption")
            self.assertEqual(plan.commands[0]["text"], "要铁环。")

    def test_acceptance_save_load_can_build_runtime_commands(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = AcceptanceScript(
                save_load_check="保存读档后重进场景 slot:1 scene:test_scene",
            )

            plan = build_acceptance_save_load_runtime_commands(unit)

            self.assertEqual(plan.warnings, [])
            self.assertEqual([x["type"] for x in plan.commands], [
                "debugSaveGame",
                "debugWait",
                "debugLoadGame",
                "debugReloadScene",
            ])
            self.assertEqual(plan.commands[0]["slot"], 1)
            self.assertEqual(plan.commands[2]["slot"], 1)
            self.assertEqual(plan.commands[3]["sceneId"], "test_scene")

    def test_finish_run_compares_snapshot_and_returns_status(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = _script()
            _write_runtime_snapshot(root)

            finish = finish_story_acceptance_run(root, unit)

            self.assertEqual(finish.status, "通过")
            self.assertIn("自动对比通过", finish.note)
            self.assertIn("剧情单元验收运行结果", finish.text)

    def test_finish_run_marks_missing_snapshot_as_blocked(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            unit = load_story_unit_workspace(root).units[0]
            unit.record.acceptance_script = _script()

            finish = finish_story_acceptance_run(root, unit)

            self.assertEqual(finish.status, "阻塞")
            self.assertFalse(finish.compare.runtime_ok)


def _script() -> AcceptanceScript:
    return AcceptanceScript(
        start_entry="scene:test_scene",
        setup_flags=["ringboy_seen == false"],
        setup_quests=["bridge_find_source: inactive"],
        setup_narrative_states=["ringboy_flow.intro"],
        actions=["打开 dialogue:ringboy", "走完对话"],
        option_choices=["选择 option:帮忙"],
        expected_signals=["ringboy.met"],
        expected_narrative_states=["ringboy_flow.done"],
        expected_quest_changes=["bridge_find_source accepted"],
        save_load_check="保存读档后不重复触发。",
    )


def _write_runtime_snapshot(root: Path) -> None:
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
            "questState": {"bridge_find_source": 1},
            "scenarioState": {},
            "narrativeState": {
                "activeStates": {"ringboy_flow": "done"},
                "recentTrace": [{"type": "signal.received", "triggerKey": "ringboy.met"}],
                "recentTransitions": [],
                "recentIssues": [],
            },
            "runtimeCommands": {
                "lastResults": [
                    {"type": "debugSaveGame", "ok": True, "message": "saved"},
                    {"type": "debugLoadGame", "ok": True, "message": "loaded"},
                ],
            },
        },
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    import unittest

    unittest.main()
