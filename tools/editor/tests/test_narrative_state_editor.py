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
    WRAPPER_OWNER_CATALOG_KEYS,
    WRAPPER_OWNER_NAVIGATION,
    _VALID_WRAPPER_OWNER_TYPES,
    authoring_catalog,
    derive_projection,
    validate_narrative_graphs,
    web_build_staleness,
)
from tools.editor.shared.action_editor import ACTION_TYPES, CONTENT_ACTION_TYPES


class TestNarrativeStateEditor(unittest.TestCase):
    def test_set_narrative_state_is_schema_known_but_hidden_from_content_picker(self) -> None:
        self.assertIn("setNarrativeState", ACTION_TYPES)
        self.assertNotIn("setNarrativeState", CONTENT_ACTION_TYPES)

    def test_wrapper_owner_registry_covers_valid_types(self) -> None:
        self.assertEqual(
            set(WRAPPER_OWNER_CATALOG_KEYS) | {"system"},
            _VALID_WRAPPER_OWNER_TYPES,
        )
        self.assertEqual(set(WRAPPER_OWNER_NAVIGATION), set(WRAPPER_OWNER_CATALOG_KEYS))

    def test_authoring_catalog_exposes_registered_owner_lists(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            catalog = authoring_catalog(m)
            for owner_type, catalog_key in WRAPPER_OWNER_CATALOG_KEYS.items():
                self.assertIn(catalog_key, catalog, owner_type)
                self.assertIsInstance(catalog[catalog_key], list, owner_type)

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

    def test_state_active_plane_survives_normalize_and_save(self) -> None:
        """位面点名字段 activePlane：经 _normalize_file + saveData 往返不丢不漂。

        narrative_graphs 不在 canvas 黄金往返快照内（save 路径带 normalize），
        该字段的往返契约由本探针专门守护。
        """
        from tools.editor.editors.narrative_state_editor import _normalize_file
        payload = {
            "schemaVersion": 3,
            "signals": [{"id": "go"}],
            "compositions": [
                {
                    "id": "comp",
                    "mainGraph": {
                        "id": "flow",
                        "ownerType": "flow",
                        "initialState": "initial",
                        "states": {
                            "initial": {"id": "initial"},
                            "carrying": {"id": "carrying", "activePlane": "背尸"},
                        },
                        "transitions": [
                            {"id": "t1", "from": "initial", "to": "carrying", "signal": "go"},
                        ],
                    },
                    "elements": [],
                }
            ],
        }
        normalized = _normalize_file(payload)
        self.assertEqual(
            normalized["compositions"][0]["mainGraph"]["states"]["carrying"].get("activePlane"),
            "背尸",
        )
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            bridge = NarrativeEditorBridge(m)
            result = bridge.saveData(json.dumps(payload, ensure_ascii=False))
            self.assertIn("saved", result)
            saved_state = (
                m.narrative_graphs["compositions"][0]["mainGraph"]["states"]["carrying"]
            )
            self.assertEqual(saved_state.get("activePlane"), "背尸")

    def test_authoring_catalog_exposes_plane_ids(self) -> None:
        """planeIds 目录：planes.json 缺失容错为空列表；有数据时按 id 列出。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            self.assertEqual(authoring_catalog(m)["planeIds"], [])
            m.planes = [{"id": "normal", "label": "常态"}, {"id": "背尸"}]
            self.assertEqual(authoring_catalog(m)["planeIds"], ["normal", "背尸"])

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

    def test_validate_rejects_missing_narrative_condition_state(self) -> None:
        issues = validate_narrative_graphs({
            "schemaVersion": 3,
            "signals": [{"id": "go"}],
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
                                "signal": "go",
                                "conditions": [{"narrative": "flow", "state": "missing"}],
                            }
                        ],
                    },
                    "elements": [],
                }
            ],
        })
        self.assertTrue(any(i.get("code") == "condition.narrative.stateMissing" for i in issues))

    def test_validate_accepts_relative_narrative_condition_tokens(self) -> None:
        # @owner / @scene 在运行时解析：TS 权威校验器与运行时都接受，Python 兜底不得更严
        # （否则合法条件会在 saveData / save_all 被拦下）。
        for token in ("@owner", "@scene"):
            issues = validate_narrative_graphs({
                "schemaVersion": 3,
                "signals": [{"id": "go"}],
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
                                    "signal": "go",
                                    "conditions": [{"narrative": token, "state": "active"}],
                                }
                            ],
                        },
                        "elements": [],
                    }
                ],
            })
            narrative_errors = [
                i for i in issues
                if str(i.get("code", "")).startswith("condition.narrative")
                or i.get("code") == "condition.shape"
            ]
            self.assertEqual(
                narrative_errors, [],
                f"{token} 相对 token 不应触发 narrative/shape 校验错误：{narrative_errors}",
            )

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
                "schemaVersion": 3,
                "signals": [{"id": "won", "label": "won"}],
                "compositions": [
                    {
                        "id": "comp",
                        "mainGraph": {
                            "id": "flow",
                            "ownerType": "flow",
                            "initialState": "a",
                            "states": {"a": {"id": "a"}, "b": {"id": "b"}},
                            "transitions": [
                                {"id": "t", "from": "a", "to": "b", "signal": "won"},
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

    def test_validate_reports_unbound_wrapper_as_error_and_duplicate_owner_as_warning(self) -> None:
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
        warning_codes = {issue["code"] for issue in issues if issue["severity"] == "warning"}
        self.assertIn("wrapper.unbound", error_codes)
        self.assertIn("owner.wrapper.multi", warning_codes)
        wrapper_issue = next(issue for issue in issues if issue["code"] == "wrapper.unbound")
        self.assertEqual(
            wrapper_issue.get("target"),
            {"kind": "element", "compositionId": "comp", "elementId": "wrapper_a"},
        )

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
        command_issue = next(issue for issue in issues if issue["code"] == "stateCommand.unsafeInContent")
        self.assertEqual(
            command_issue.get("target"),
            {"kind": "state", "compositionId": "comp", "graphId": "flow", "stateId": "a", "field": "onEnterActions"},
        )

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
        error_codes = {issue["code"] for issue in issues if issue["severity"] == "error"}
        warning_codes = {issue["code"] for issue in issues if issue["severity"] == "warning"}
        self.assertIn("transition.to.missing", error_codes)
        self.assertIn("transition.signal.draft", warning_codes)
        signal_issue = next(issue for issue in issues if issue["code"] == "transition.signal.draft")
        self.assertEqual(
            signal_issue.get("target"),
            {"kind": "transition", "compositionId": "comp", "graphId": "flow", "transitionId": "t", "field": "signal"},
        )

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


class TestWebBuildStaleness(unittest.TestCase):
    """网页构建过期检测：源码比 dist 新 ⇒ 编辑器在跑旧产物，须显眼提示。"""

    def _make_web_dir(self, root: Path, *, dist_first: bool) -> Path:
        import os
        wd = root / "narrative_editor_web"
        (wd / "dist").mkdir(parents=True)
        (wd / "src").mkdir(parents=True)
        idx = wd / "dist" / "index.html"
        srcf = wd / "src" / "App.tsx"
        if dist_first:
            idx.write_text("<html>", encoding="utf-8")
            os.utime(idx, (1000, 1000))
            srcf.write_text("x", encoding="utf-8")
            os.utime(srcf, (2000, 2000))  # src 更新 → 过期
        else:
            srcf.write_text("x", encoding="utf-8")
            os.utime(srcf, (1000, 1000))
            idx.write_text("<html>", encoding="utf-8")
            os.utime(idx, (2000, 2000))  # dist 更新 → 不过期
        return wd

    def test_stale_when_source_newer_than_dist(self) -> None:
        with TemporaryDirectory() as td:
            wd = self._make_web_dir(Path(td), dist_first=True)
            stale, msg = web_build_staleness(wd)
            self.assertTrue(stale)
            self.assertIn("比已构建", msg)

    def test_fresh_when_dist_newer(self) -> None:
        with TemporaryDirectory() as td:
            wd = self._make_web_dir(Path(td), dist_first=False)
            stale, _ = web_build_staleness(wd)
            self.assertFalse(stale)

    def test_stale_when_dist_missing(self) -> None:
        with TemporaryDirectory() as td:
            wd = Path(td) / "narrative_editor_web"
            (wd / "src").mkdir(parents=True)
            stale, msg = web_build_staleness(wd)
            self.assertTrue(stale)
            self.assertIn("尚未构建", msg)

    def test_dev_server_never_stale(self) -> None:
        from tools.editor.editors.narrative_state_editor import NARRATIVE_EDITOR_DEV_URL_ENV
        with TemporaryDirectory() as td:
            wd = self._make_web_dir(Path(td), dist_first=True)  # 本应过期
            with patch.dict("os.environ", {NARRATIVE_EDITOR_DEV_URL_ENV: "http://localhost:5173"}):
                stale, _ = web_build_staleness(wd)
            self.assertFalse(stale)  # dev server 读源码，不打扰


class TestLoadedPageStalenessBanner(unittest.TestCase):
    """已加载页面落后于磁盘 dist（外部/终端重建过但本页没刷新）时，横幅提示「刷新页面」。"""

    @classmethod
    def setUpClass(cls) -> None:
        from PySide6.QtWidgets import QApplication
        cls._qt_app = QApplication.instance() or QApplication([])

    def _editor(self):
        from tools.editor.editors.narrative_state_editor import NarrativeStateEditor
        td = TemporaryDirectory()
        self.addCleanup(td.cleanup)
        root = Path(td.name) / "p"
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        return NarrativeStateEditor(m)

    def test_banner_prompts_reload_when_page_behind_disk(self) -> None:
        N = "tools.editor.editors.narrative_state_editor"
        ed = self._editor()
        if ed._view is None:
            self.skipTest("无 QtWebEngine")
        ed._loaded_dist_mtime = 1000.0
        # dist 比已加载页面新，且 dist 不比 src 旧（case A 不触发）
        with patch(f"{N}.web_build_staleness", return_value=(False, "")), \
                patch(f"{N}._current_dist_mtime", return_value=2000.0):
            ed._refresh_staleness_banner()
        self.assertFalse(ed._staleness_banner.isHidden())  # 横幅显示
        self.assertFalse(ed._reload_btn.isHidden())        # 刷新按钮显示
        self.assertTrue(ed._rebuild_btn.isHidden())        # 重建按钮隐藏

    def test_banner_hidden_when_page_matches_disk(self) -> None:
        N = "tools.editor.editors.narrative_state_editor"
        ed = self._editor()
        if ed._view is None:
            self.skipTest("无 QtWebEngine")
        ed._loaded_dist_mtime = 2000.0
        with patch(f"{N}.web_build_staleness", return_value=(False, "")), \
                patch(f"{N}._current_dist_mtime", return_value=2000.0):
            ed._refresh_staleness_banner()
        self.assertTrue(ed._staleness_banner.isHidden())


if __name__ == "__main__":
    unittest.main()
