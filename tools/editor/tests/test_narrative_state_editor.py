from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.editors.narrative_state_editor import (
    NarrativeEditorBridge,
    derive_projection,
    validate_narrative_graphs,
)


class TestNarrativeStateEditor(unittest.TestCase):
    def test_missing_narrative_graphs_loads_empty_without_dirty(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            self.assertEqual(m.narrative_graphs, {"schemaVersion": 2, "compositions": []})
            self.assertFalse(m.is_dirty)

    def test_save_all_writes_narrative_graphs_when_dirty(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.narrative_graphs = {
                "schemaVersion": 2,
                "compositions": [
                    {
                        "id": "comp",
                        "mainGraph": {
                            "id": "g",
                            "ownerType": "flow",
                            "initialState": "a",
                            "states": {"a": {"id": "a"}},
                            "transitions": [],
                        },
                        "elements": [],
                    },
                ],
            }
            m.mark_dirty("narrative_graphs")
            m.save_all()
            path = root / "public" / "assets" / "data" / "narrative_graphs.json"
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(data["compositions"][0]["mainGraph"]["id"], "g")

    def test_bridge_save_marks_narrative_graphs_dirty(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            bridge = NarrativeEditorBridge(m)
            result = bridge.saveData(json.dumps({
                "schemaVersion": 2,
                "compositions": [
                    {
                        "id": "comp",
                        "mainGraph": {
                            "id": "flow",
                            "ownerType": "flow",
                            "initialState": "initial",
                            "states": {"initial": {"id": "initial"}},
                            "transitions": [],
                        },
                        "elements": [],
                    }
                ],
            }))
            self.assertIn("saved", result)
            self.assertTrue(m.is_dirty)
            self.assertEqual(m.narrative_composition_ids_ordered(), ["comp"])

    def test_projection_derives_real_trigger_edges_from_actions(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            graphs_dir = root / "public" / "assets" / "dialogues" / "graphs"
            graphs_dir.mkdir(parents=True, exist_ok=True)
            (graphs_dir / "d.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "id": "d",
                        "entry": "a",
                        "nodes": {
                            "a": {
                                "type": "runActions",
                                "actions": [
                                    {
                                        "type": "emitNarrativeSignal",
                                        "params": {
                                            "sourceType": "dialogue",
                                            "sourceId": "dock_board",
                                            "signal": "board_read_done",
                                        },
                                    },
                                ],
                                "next": "end",
                            },
                            "end": {"type": "end"},
                        },
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            m = ProjectModel()
            m.load_project(root)
            m.narrative_graphs = {
                "schemaVersion": 2,
                "compositions": [
                    {
                        "id": "comp",
                        "mainGraph": {
                            "id": "flow",
                            "ownerType": "flow",
                            "initialState": "a",
                            "states": {"a": {"id": "a"}, "b": {"id": "b"}},
                            "transitions": [
                                {
                                    "id": "t",
                                    "from": "a",
                                    "to": "b",
                                    "signal": "external:dialogue:dock_board:board_read_done",
                                },
                            ],
                        },
                        "elements": [
                            {
                                "id": "dialogue_d",
                                "kind": "dialogueBlackbox",
                                "label": "d",
                                "refId": "d",
                                "meta": {
                                    "emits": ["external:dialogue:dock_board:board_read_done"],
                                },
                            },
                        ],
                    },
                ],
            }
            projection = derive_projection(m.narrative_graphs, m)
            self.assertTrue(any(
                e["source"] == "element:dialogue_d"
                and e["target"] == "transition-anchor:flow:t"
                and e["compositionId"] == "comp"
                and e["graphId"] == "flow"
                and e["transitionId"] == "t"
                and "flow.t" in e["detail"]
                for e in projection["triggerEdges"]
            ))

    def test_projection_derives_state_command_edges_from_actions(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            graphs_dir = root / "public" / "assets" / "dialogues" / "graphs"
            graphs_dir.mkdir(parents=True, exist_ok=True)
            (graphs_dir / "d.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "id": "d",
                        "entry": "a",
                        "nodes": {
                            "a": {
                                "type": "runActions",
                                "actions": [
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
                ),
                encoding="utf-8",
            )
            m = ProjectModel()
            m.load_project(root)
            m.narrative_graphs = {
                "schemaVersion": 2,
                "compositions": [
                    {
                        "id": "comp",
                        "mainGraph": {
                            "id": "flow",
                            "ownerType": "flow",
                            "initialState": "a",
                            "states": {"a": {"id": "a"}, "b": {"id": "b"}},
                            "transitions": [],
                        },
                        "elements": [
                            {
                                "id": "dialogue_d",
                                "kind": "dialogueBlackbox",
                                "label": "d",
                                "refId": "d",
                            },
                        ],
                    },
                ],
            }
            projection = derive_projection(m.narrative_graphs, m)
            self.assertTrue(any(
                e["source"] == "element:dialogue_d"
                and e["target"] == "state:b"
                and e["label"] == "flow.b"
                for e in projection["stateCommandEdges"]
            ))

    def test_validate_blocks_missing_transition_target_and_signal(self) -> None:
        issues = validate_narrative_graphs({
            "schemaVersion": 2,
            "compositions": [
                {
                    "id": "comp",
                    "mainGraph": {
                        "id": "flow",
                        "ownerType": "flow",
                        "initialState": "a",
                        "states": {"a": {"id": "a"}},
                        "transitions": [{"id": "t", "from": "a", "to": "b", "signal": ""}],
                    },
                    "elements": [],
                },
            ],
        })
        codes = {issue["code"] for issue in issues if issue["severity"] == "error"}
        self.assertIn("transition.to.missing", codes)
        self.assertIn("transition.signal.empty", codes)

    def test_validate_blocks_external_edge_to_scenario_internal_state(self) -> None:
        issues = validate_narrative_graphs({
            "schemaVersion": 2,
            "compositions": [
                {
                    "id": "comp",
                    "mainGraph": {
                        "id": "flow",
                        "ownerType": "flow",
                        "initialState": "a",
                        "states": {"a": {"id": "a"}},
                        "transitions": [
                            {
                                "id": "bad",
                                "from": "a",
                                "to": {"graphId": "scenario", "stateId": "middle"},
                                "signal": "external:system:test:go",
                            }
                        ],
                    },
                    "elements": [
                        {
                            "id": "sc",
                            "kind": "scenarioSubgraph",
                            "ownerType": "scenario",
                            "ownerId": "s",
                            "refId": "s",
                            "graph": {
                                "id": "scenario",
                                "ownerType": "scenario",
                                "initialState": "inactive",
                                "entryState": "entry",
                                "exitStates": ["exit"],
                                "states": {
                                    "inactive": {"id": "inactive"},
                                    "entry": {"id": "entry"},
                                    "middle": {"id": "middle"},
                                    "exit": {"id": "exit"},
                                },
                                "transitions": [],
                            },
                        }
                    ],
                },
            ],
        })
        codes = {issue["code"] for issue in issues if issue["severity"] == "error"}
        self.assertIn("scenario.boundary.entry", codes)

    def test_runtime_snapshot_reports_missing_game_window(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            bridge = NarrativeEditorBridge(m)
            result = json.loads(bridge.getRuntimeSnapshot())
            self.assertFalse(result["ok"])
            self.assertIn("Game window", result["reason"])


if __name__ == "__main__":
    unittest.main()
