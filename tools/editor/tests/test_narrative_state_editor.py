from __future__ import annotations

import json
import unittest
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QMessageBox

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.editors.narrative_state_editor import (
    NarrativeStateEditor,
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

    def test_bridge_save_rejects_invalid_narrative_graphs(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            bridge = NarrativeEditorBridge(m)
            before = m.narrative_graphs
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
                            "transitions": [{"id": "draft", "from": "initial", "to": "missing", "signal": ""}],
                        },
                        "elements": [],
                    }
                ],
            }))
            self.assertIn("save blocked", result)
            self.assertEqual(m.narrative_graphs, before)
            self.assertFalse(m.is_dirty)

    def test_save_all_rejects_invalid_narrative_graphs(self) -> None:
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
                            "id": "flow",
                            "ownerType": "flow",
                            "initialState": "initial",
                            "states": {"initial": {"id": "initial"}},
                            "transitions": [{"id": "draft", "from": "initial", "to": "missing", "signal": ""}],
                        },
                        "elements": [],
                    }
                ],
            }
            m.mark_dirty("narrative_graphs")
            with self.assertRaises(ValueError):
                m.save_all()

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
            self.assertEqual(projection["schemaVersion"], 1)
            self.assertTrue(any(
                e["source"] == "element:dialogue_d"
                and e["target"] == "transition-anchor:flow:t"
                and e["compositionId"] == "comp"
                and e["graphId"] == "flow"
                and e["transitionId"] == "t"
                and e.get("label") == "external:dialogue:dock_board:board_read_done"
                and "flow.t" in e["detail"]
                for e in projection["triggerEdges"]
            ))
            self.assertIn("warnings", projection)

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

    def test_projection_derives_owner_state_read_edges(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
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
                                "type": "ownerState",
                                "cases": [{"state": "before", "next": "line"}],
                                "defaultNext": "line",
                            },
                            "line": {
                                "type": "line",
                                "speaker": {"kind": "npc"},
                                "text": "hi",
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
            m.scenes = {
                "scene": {
                    "npcs": [
                        {
                            "id": "npc_ringboy",
                            "dialogueGraphId": "ringboy",
                        }
                    ]
                }
            }
            m.narrative_graphs = {
                "schemaVersion": 2,
                "compositions": [
                    {
                        "id": "comp",
                        "mainGraph": {
                            "id": "flow",
                            "ownerType": "flow",
                            "initialState": "a",
                            "states": {"a": {"id": "a"}},
                            "transitions": [],
                        },
                        "elements": [
                            {
                                "id": "wrapper_npc",
                                "kind": "wrapperGraph",
                                "ownerType": "npc",
                                "ownerId": "npc_ringboy",
                                "graph": {
                                    "id": "npc_ringboy",
                                    "ownerType": "npc",
                                    "ownerId": "npc_ringboy",
                                    "initialState": "before",
                                    "states": {"before": {"id": "before"}},
                                    "transitions": [],
                                },
                            },
                            {
                                "id": "dialogue_ringboy",
                                "kind": "dialogueBlackbox",
                                "refId": "ringboy",
                            },
                        ],
                    }
                ],
            }
            projection = derive_projection(m.narrative_graphs, m)
            self.assertTrue(any(
                e["source"] == "element:wrapper_npc"
                and e["target"] == "element:dialogue_ringboy"
                and e["kind"] == "read"
                and e["graphId"] == "npc_ringboy"
                and e.get("label") == "npc_ringboy.activeState"
                for e in projection["readEdges"]
            ))

    def test_projection_derives_context_state_read_edges(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            graphs_dir = root / "public" / "assets" / "dialogues" / "graphs"
            graphs_dir.mkdir(parents=True, exist_ok=True)
            (graphs_dir / "ctx_dialogue.json").write_text(
                json.dumps(
                    {
                        "schemaVersion": 1,
                        "id": "ctx_dialogue",
                        "entry": "root",
                        "nodes": {
                            "root": {
                                "type": "contextState",
                                "graphId": "flow",
                                "cases": [{"state": "a", "next": "line"}],
                                "defaultNext": "line",
                            },
                            "line": {
                                "type": "line",
                                "speaker": {"kind": "npc"},
                                "text": "hi",
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
                            "states": {"a": {"id": "a"}},
                            "transitions": [],
                        },
                        "elements": [
                            {
                                "id": "dialogue_ctx",
                                "kind": "dialogueBlackbox",
                                "refId": "ctx_dialogue",
                            },
                        ],
                    }
                ],
            }
            projection = derive_projection(m.narrative_graphs, m)
            self.assertTrue(any(
                e["source"] == "graph:flow"
                and e["target"] == "element:dialogue_ctx"
                and e["kind"] == "read"
                and e["graphId"] == "flow"
                for e in projection["readEdges"]
            ))

    def test_projection_visitor_emits_fan_in_warnings_and_explicit_commands(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.water_minigames_instances["mg"] = {
                "actions": [
                    {
                        "type": "emitNarrativeSignal",
                        "params": {"sourceType": "minigame", "sourceId": "mg", "signal": "won"},
                    }
                ]
            }
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
                                {"id": "t", "from": "a", "to": "b", "signal": "external:minigame:mg:won"},
                            ],
                        },
                        "elements": [
                            {"id": "mg_a", "kind": "minigameBlackbox", "refId": "mg", "meta": {"commands": ["flow.b"]}},
                            {"id": "mg_b", "kind": "minigameBlackbox", "refId": "mg"},
                        ],
                    },
                ],
            }
            projection = derive_projection(m.narrative_graphs, m)
            fan_in_sources = {
                e["source"]
                for e in projection["triggerEdges"]
                if e["target"] == "transition-anchor:flow:t"
            }
            self.assertEqual(fan_in_sources, {"element:mg_a", "element:mg_b"})
            self.assertTrue(any(w["code"] == "projection.source.ambiguous" for w in projection["warnings"]))
            self.assertTrue(any(
                e["source"] == "element:mg_a" and e["target"] == "state:b"
                for e in projection["stateCommandEdges"]
            ))

    def test_validate_reports_unbound_wrapper_and_duplicate_owner_as_errors(self) -> None:
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
                        "transitions": [],
                    },
                    "elements": [
                        {
                            "id": "wrapper_a",
                            "kind": "wrapperGraph",
                            "ownerType": "npc",
                            "ownerId": "",
                            "graph": {
                                "id": "npc_a",
                                "ownerType": "npc",
                                "ownerId": "",
                                "initialState": "idle",
                                "states": {"idle": {"id": "idle"}},
                                "transitions": [],
                            },
                        },
                        {
                            "id": "wrapper_b",
                            "kind": "wrapperGraph",
                            "ownerType": "npc",
                            "ownerId": "npc_ringboy",
                            "graph": {
                                "id": "npc_b",
                                "ownerType": "npc",
                                "ownerId": "npc_ringboy",
                                "initialState": "idle",
                                "states": {"idle": {"id": "idle"}},
                                "transitions": [],
                            },
                        },
                        {
                            "id": "wrapper_c",
                            "kind": "wrapperGraph",
                            "ownerType": "npc",
                            "ownerId": "npc_ringboy",
                            "graph": {
                                "id": "npc_c",
                                "ownerType": "npc",
                                "ownerId": "npc_ringboy",
                                "initialState": "idle",
                                "states": {"idle": {"id": "idle"}},
                                "transitions": [],
                            },
                        },
                    ],
                },
            ],
        })
        error_codes = {issue["code"] for issue in issues if issue["severity"] == "error"}
        self.assertIn("wrapper.unbound", error_codes)
        self.assertIn("owner.wrapper.duplicate", error_codes)

    def test_validate_reports_set_narrative_state_in_graph_actions_as_error(self) -> None:
        issues = validate_narrative_graphs({
            "schemaVersion": 2,
            "compositions": [
                {
                    "id": "comp",
                    "mainGraph": {
                        "id": "flow",
                        "ownerType": "flow",
                        "initialState": "a",
                        "states": {
                            "a": {
                                "id": "a",
                                "onEnterActions": [
                                    {"type": "setNarrativeState", "params": {"graphId": "flow", "stateId": "a"}},
                                ],
                            },
                        },
                        "transitions": [],
                    },
                    "elements": [],
                },
            ],
        })
        error_codes = {issue["code"] for issue in issues if issue["severity"] == "error"}
        self.assertIn("stateCommand.unsafeInContent", error_codes)

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

    def test_validate_blocks_anchor_delimiters_and_bad_actions(self) -> None:
        issues = validate_narrative_graphs({
            "schemaVersion": 2,
            "compositions": [
                {
                    "id": "comp",
                    "mainGraph": {
                        "id": "flow:bad",
                        "ownerType": "flow",
                        "initialState": "a",
                        "states": {
                            "a": {
                                "id": "a",
                                "onExitActions": [{"type": "setNarrativeState", "params": {"graphId": "flow:bad"}}],
                            },
                        },
                        "transitions": [{"id": "t:bad", "from": "a", "to": "a", "signal": "external:system:test:go"}],
                    },
                    "elements": [],
                },
            ],
        })
        error_codes = {issue["code"] for issue in issues if issue["severity"] == "error"}
        self.assertIn("graph.id.delimiter", error_codes)
        self.assertIn("transition.id.delimiter", error_codes)
        self.assertIn("action.param.missing", error_codes)

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
        self.assertIn("transition.crossGraphEndpoint.unsupported", codes)

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

    def test_confirm_close_dirty_save_flushes_model(self) -> None:
        class FakeEditor:
            def __init__(self) -> None:
                self._view = object()
                self.flushed = False

            def _run_editor_js_result(self, code: str, timeout_ms: int = 5000):  # noqa: ANN001
                if "isDirty" in code:
                    return True
                return True

            def flush_to_model(self) -> bool:
                self.flushed = True
                return True

        fake = FakeEditor()
        with patch(
            "tools.editor.editors.narrative_state_editor.QMessageBox.question",
            return_value=QMessageBox.StandardButton.Save,
        ):
            self.assertTrue(NarrativeStateEditor.confirm_close(fake, None))  # type: ignore[arg-type]
        self.assertTrue(fake.flushed)


if __name__ == "__main__":
    unittest.main()
