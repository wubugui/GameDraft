from __future__ import annotations

import json
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.production_workbench.daily_check import run_daily_check
from tools.production_workbench.story_units import (
    AcceptanceScript,
    Blocker,
    acceptance_script_issues,
    load_story_unit_workspace,
    save_story_unit_workspace,
    story_unit_completeness_issues,
    story_unit_report,
    story_units_path,
)


def _write_story_unit_project(root: Path) -> None:
    write_minimal_loadable_project(root)
    (root / "public" / "assets" / "data" / "quests.json").write_text(
        json.dumps(
            [
                {
                    "id": "bridge_find_source",
                    "title": "找水源",
                    "preconditions": [],
                    "completionConditions": [],
                }
            ],
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    graphs_dir = root / "public" / "assets" / "dialogues" / "graphs"
    graphs_dir.mkdir(parents=True, exist_ok=True)
    (graphs_dir / "ringboy.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "id": "ringboy",
                "entry": "root",
                "nodes": {
                    "root": {
                        "type": "contextState",
                        "graphId": "ringboy_flow",
                        "cases": [{"state": "intro", "next": "line"}],
                        "defaultNext": "line",
                    },
                    "line": {"type": "line", "text": "hi", "next": "end"},
                    "end": {"type": "end"},
                },
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    narrative = {
        "schemaVersion": 3,
        "signals": [{"id": "ringboy.met", "label": "ringboy met"}],
        "compositions": [
            {
                "id": "unit_ringboy_intro",
                "label": "戒指男孩初遇",
                "description": "支线入口小情景",
                "mainGraph": {
                    "id": "ringboy_flow",
                    "ownerType": "flow",
                    "initialState": "intro",
                    "states": {
                        "intro": {"id": "intro", "label": "初遇"},
                        "done": {"id": "done", "label": "结束"},
                    },
                    "transitions": [
                        {
                            "id": "meet",
                            "from": "intro",
                            "to": "done",
                            "signal": "ringboy.met",
                        }
                    ],
                },
                "elements": [
                    {
                        "id": "dialogue_ringboy",
                        "kind": "dialogueBlackbox",
                        "refId": "ringboy",
                        "meta": {"emits": ["ringboy.met"]},
                    },
                    {
                        "id": "quest_bridge",
                        "kind": "wrapperGraph",
                        "ownerType": "quest",
                        "ownerId": "bridge_find_source",
                        "graph": {
                            "id": "quest_bridge_flow",
                            "ownerType": "quest",
                            "ownerId": "bridge_find_source",
                            "initialState": "inactive",
                            "states": {"inactive": {"id": "inactive"}},
                            "transitions": [],
                        },
                    },
                    {
                        "id": "zone_market",
                        "kind": "zoneBlackbox",
                        "refId": "market_lane",
                    },
                ],
            }
        ],
    }
    (root / "public" / "assets" / "data" / "narrative_graphs.json").write_text(
        json.dumps(narrative, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


class ProductionWorkbenchStoryUnitTests(TestCase):
    def test_workspace_derives_story_units_from_narrative_compositions(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)

            ws = load_story_unit_workspace(root)

            self.assertEqual(len(ws.units), 1)
            unit = ws.units[0]
            self.assertEqual(unit.record.composition_id, "unit_ringboy_intro")
            self.assertEqual(unit.record.display_name, "戒指男孩初遇")
            self.assertEqual(unit.summary.main_graph_id, "ringboy_flow")
            self.assertIn("ringboy_flow", unit.summary.graph_ids)
            self.assertIn("quest_bridge_flow", unit.summary.graph_ids)
            self.assertIn("ringboy", unit.summary.dialogues)
            self.assertIn("bridge_find_source", unit.summary.quests)
            self.assertIn("market_lane", unit.summary.zones)
            self.assertIn("ringboy.met", unit.summary.signals)
            self.assertEqual(story_unit_completeness_issues(unit), ["缺入口", "缺出口", "缺验收"])

    def test_story_unit_tracking_persists_without_touching_runtime_json(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            runtime_path = root / "public" / "assets" / "data" / "narrative_graphs.json"
            before = runtime_path.read_text(encoding="utf-8")

            ws = load_story_unit_workspace(root)
            unit = ws.units[0]
            unit.record.unit_type = "支线"
            unit.record.production_status = "制作中"
            unit.record.entry = "玩家第一次进入集市巷"
            unit.record.exit = "对话结束并发出 ringboy.met"
            unit.record.acceptance = "触发后主图进入 done"
            unit.record.blockers = [Blocker(text="缺戒指道具图")]
            saved = save_story_unit_workspace(ws)

            self.assertEqual(saved, story_units_path(root))
            self.assertEqual(runtime_path.read_text(encoding="utf-8"), before)
            payload = json.loads(saved.read_text(encoding="utf-8"))
            rec = payload["units"]["unit_ringboy_intro"]
            self.assertEqual(rec["productionStatus"], "制作中")
            self.assertEqual(rec["entry"], "玩家第一次进入集市巷")
            self.assertEqual(rec["blockers"][0]["text"], "缺戒指道具图")

            ws2 = load_story_unit_workspace(root)
            self.assertEqual(ws2.units[0].record.exit, "对话结束并发出 ringboy.met")

    def test_acceptance_script_persists_and_gates_ready_status(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)
            runtime_path = root / "public" / "assets" / "data" / "narrative_graphs.json"
            before = runtime_path.read_text(encoding="utf-8")

            ws = load_story_unit_workspace(root)
            unit = ws.units[0]
            unit.record.production_status = "待验收"
            self.assertIn("验收脚本缺执行步骤", story_unit_completeness_issues(unit))

            unit.record.entry = "进入集市巷找到戒指男孩"
            unit.record.exit = "ringboy_flow.done"
            unit.record.acceptance = "发出 ringboy.met 后支线进入结束状态"
            unit.record.acceptance_script = AcceptanceScript(
                start_entry="从 test_scene.market_lane 进入",
                setup_flags=["ringboy_seen == false"],
                setup_quests=["bridge_find_source: inactive"],
                setup_narrative_states=["ringboy_flow.intro"],
                actions=["打开 dialogue:ringboy", "走完第一段对话"],
                option_choices=["选择：帮他找铁环"],
                expected_signals=["ringboy.met"],
                expected_narrative_states=["ringboy_flow.done"],
                expected_quest_changes=["bridge_find_source accepted"],
                save_load_check="保存读档后仍停留在 ringboy_flow.done，NPC 不重复触发初遇。",
                last_run_status="通过",
            )
            save_story_unit_workspace(ws)

            self.assertEqual(runtime_path.read_text(encoding="utf-8"), before)
            loaded = load_story_unit_workspace(root).units[0]
            self.assertEqual(loaded.record.acceptance_script.expected_signals, ["ringboy.met"])
            self.assertEqual(acceptance_script_issues(loaded), [])
            report = story_unit_report(loaded)
            self.assertIn("验收脚本", report)
            self.assertIn("ringboy_flow.done", report)

    def test_daily_check_reports_incomplete_story_unit_as_warning(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)

            report = run_daily_check(root)

            self.assertTrue(any(issue.area == "story-unit" for issue in report.issues))
            self.assertGreaterEqual(report.warning_count, 1)

    def test_daily_check_can_include_toolchain_command_failures(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_story_unit_project(root)

            with patch(
                "tools.production_workbench.daily_check._daily_toolchain_commands",
                return_value=[
                    ("fake pass", ["fake-pass"], 1),
                    ("fake gate", ["fake"], 1),
                ],
            ), patch(
                "tools.production_workbench.daily_check._run_command",
                side_effect=[
                    subprocess.CompletedProcess(["fake-pass"], 0, "ok", ""),
                    subprocess.CompletedProcess(["fake"], 2, "stdout line", "stderr line"),
                ],
            ):
                report = run_daily_check(root, run_toolchain_checks=True)

            self.assertIn("fake pass", report.passed_checks)
            self.assertTrue(any(
                issue.area == "toolchain" and "fake gate" in issue.message
                for issue in report.issues
            ))
