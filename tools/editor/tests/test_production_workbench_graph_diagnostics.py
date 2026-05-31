from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase

from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.production_workbench.graph_diagnostics import (
    build_graph_diagnostics,
    format_graph_diagnostics_report,
)
from tools.production_workbench.runtime_debug import runtime_debug_snapshot_path


def _write_graph_diagnostic_project(root: Path) -> None:
    write_minimal_loadable_project(root)
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
                        "graphId": "flow",
                        "cases": [{"state": "a", "next": "act"}],
                        "defaultNext": "act",
                    },
                    "act": {
                        "type": "runActions",
                        "actions": [
                            {
                                "type": "setFlag",
                                "params": {
                                    "key": "ringboy_seen",
                                    "value": True,
                                },
                            },
                            {
                                "type": "emitNarrativeSignal",
                                "params": {
                                    "sourceType": "dialogue",
                                    "sourceId": "ringboy",
                                    "signal": "met",
                                },
                            },
                            {
                                "type": "setNarrativeState",
                                "params": {"graphId": "flow", "stateId": "b"},
                            },
                        ],
                        "next": "end",
                    },
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
        "signals": [{"id": "met", "label": "met"}],
        "compositions": [
            {
                "id": "comp",
                "label": "测试单元",
                "mainGraph": {
                    "id": "flow",
                    "ownerType": "flow",
                    "ownerId": "comp",
                    "initialState": "a",
                    "states": {"a": {"id": "a"}, "b": {"id": "b"}},
                    "transitions": [
                        {
                            "id": "t",
                            "from": "a",
                            "to": "b",
                            "signal": "met",
                            "conditions": [{"flag": "ringboy_seen", "value": True}],
                        }
                    ],
                },
                "elements": [
                    {"id": "dlg", "kind": "dialogueBlackbox", "refId": "ringboy"},
                    {
                        "id": "quest",
                        "kind": "wrapperGraph",
                        "ownerType": "quest",
                        "ownerId": "q_bridge",
                        "meta": {"commands": ["flow.b"]},
                        "graph": {
                            "id": "q_bridge_graph",
                            "ownerType": "quest",
                            "ownerId": "q_bridge",
                            "initialState": "inactive",
                            "states": {"inactive": {"id": "inactive"}},
                            "transitions": [],
                        },
                    },
                ],
            }
        ],
    }
    (root / "public" / "assets" / "data" / "narrative_graphs.json").write_text(
        json.dumps(narrative, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


class ProductionWorkbenchGraphDiagnosticsTests(TestCase):
    def test_graph_diagnostics_reports_edges_and_state_write_risks(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_graph_diagnostic_project(root)

            report = build_graph_diagnostics(root)
            text = format_graph_diagnostics_report(report)

            self.assertEqual(len(report.compositions), 1)
            comp = report.compositions[0]
            self.assertEqual(comp.composition_id, "comp")
            self.assertGreaterEqual(len(comp.trigger_edges), 1)
            self.assertGreaterEqual(len(comp.read_edges), 1)
            self.assertGreaterEqual(len(comp.state_command_edges), 1)
            self.assertIn("q_bridge", comp.quests)
            self.assertIn("Signal flow", text)
            self.assertIn("State read", text)
            self.assertIn("Flag / Action read-write", text)
            self.assertIn("flag-read", text)
            self.assertIn("flag-write", text)
            self.assertIn("Dialogue route explain", text)
            self.assertIn("entry=root", text)
            self.assertIn("State direct write", text)
            self.assertIn("Owner boundary", text)
            self.assertTrue(any("跨 owner" in item for item in comp.owner_boundary_warnings))
            self.assertIn("[风险]", text)

    def test_graph_diagnostics_can_format_single_composition(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_graph_diagnostic_project(root)

            report = build_graph_diagnostics(root)
            text = format_graph_diagnostics_report(report, composition_id="comp")

            self.assertIn("测试单元 (comp)", text)
            self.assertNotIn("没有可诊断", text)

    def test_graph_diagnostics_includes_runtime_trace_timeline_when_snapshot_exists(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            _write_graph_diagnostic_project(root)
            snapshot_path = runtime_debug_snapshot_path(root)
            snapshot_path.parent.mkdir(parents=True, exist_ok=True)
            snapshot_path.write_text(
                json.dumps(
                    {
                        "ok": True,
                        "capturedAt": "2026-05-31T12:00:00+08:00",
                        "source": "test",
                        "snapshot": {
                            "reason": "test-trace",
                            "narrativeState": {
                                "recentTrace": [
                                    {
                                        "seq": 1,
                                        "type": "transition.applied",
                                        "graphId": "flow",
                                        "transitionId": "t",
                                        "from": "a",
                                        "to": "b",
                                        "triggerKey": "met",
                                    }
                                ]
                            },
                            "runtimeCommands": {
                                "lastResults": [
                                    {"type": "debugLoadGame", "ok": True, "message": "loaded"}
                                ]
                            },
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )

            report = build_graph_diagnostics(root)
            text = format_graph_diagnostics_report(report)

            self.assertIn("Runtime trace timeline", text)
            self.assertIn("transition.applied flow.t", text)
            self.assertIn("Runtime command results", text)
            self.assertIn("debugLoadGame", text)
