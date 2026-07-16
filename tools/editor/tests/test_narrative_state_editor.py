from __future__ import annotations

import json
import unittest
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QMessageBox

from tools.editor import theme
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.editors.narrative_state_editor import (
    NarrativeStateEditor,
    NarrativeEditorBridge,
    WRAPPER_OWNER_CATALOG_KEYS,
    WRAPPER_OWNER_NAVIGATION,
    _VALID_WRAPPER_OWNER_TYPES,
    _placeholder_html,
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

    # --- 「整理分组」标签：编辑器专用，运行时永不加载，绝不进 narrative_graphs.json --- #
    def test_missing_narrative_categories_loads_empty_without_dirty(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            self.assertEqual(
                m.narrative_categories,
                {"schemaVersion": 1, "compositions": {}, "subgraphs": {}},
            )
            self.assertFalse(m.is_dirty)

    def test_bridge_save_categories_marks_dirty_and_normalizes(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            bridge = NarrativeEditorBridge(m)
            result = json.loads(bridge.saveCategories(json.dumps({
                "compositions": {"comp": " 主线 ", "gone": ""},
                "subgraphs": {"comp": {"el": "NPC"}, "emptyComp": {}},
            }, ensure_ascii=False)))
            self.assertTrue(result["ok"])
            self.assertTrue(m.is_dirty)
            # 归一：strip、丢空值、丢空内层
            self.assertEqual(result["categories"]["compositions"], {"comp": "主线"})
            self.assertEqual(result["categories"]["subgraphs"], {"comp": {"el": "NPC"}})
            # getCategories 返回归一后的当前注册表
            got = json.loads(bridge.getCategories())
            self.assertEqual(got["compositions"], {"comp": "主线"})
            self.assertEqual(got["subgraphs"], {"comp": {"el": "NPC"}})

    def test_save_all_writes_narrative_categories(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.narrative_categories = {
                "schemaVersion": 1,
                "compositions": {"comp": "主线"},
                "subgraphs": {"comp": {"el": "NPC"}},
            }
            m.mark_dirty("narrative_categories")
            m.save_all()
            path = root / "public" / "assets" / "data" / "narrative_categories.json"
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(data["compositions"]["comp"], "主线")
            self.assertEqual(data["subgraphs"]["comp"]["el"], "NPC")

    def test_save_all_categories_only_does_not_touch_narrative_graphs(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            ng_path = root / "public" / "assets" / "data" / "narrative_graphs.json"
            before = ng_path.read_text(encoding="utf-8") if ng_path.exists() else None
            m.narrative_categories = {
                "schemaVersion": 1,
                "compositions": {"comp": "主线"},
                "subgraphs": {},
            }
            m.mark_dirty("narrative_categories")
            m.save_all()
            after = ng_path.read_text(encoding="utf-8") if ng_path.exists() else None
            # 只脏分组时，narrative_graphs.json 分毫未动（分类绝不污染运行时数据）
            self.assertEqual(before, after)

    def test_narrative_categories_normalize_is_idempotent_and_sorted(self) -> None:
        from tools.editor.shared.narrative_categories import normalize_categories_file
        raw = {"compositions": {"b": "Y", "a": "X"}, "subgraphs": {"c": {"e2": "k", "e1": "m"}}}
        once = normalize_categories_file(raw)
        twice = normalize_categories_file(once)
        self.assertEqual(once, twice)
        self.assertEqual(list(once["compositions"].keys()), ["a", "b"])
        self.assertEqual(list(once["subgraphs"]["c"].keys()), ["e1", "e2"])

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
                                "onExitActions": [
                                    # setNarrativeState 是 DEBUG_ONLY、刻意不在 manifest：其缺 stateId
                                    # 由 stateCommand.target.missing 捕获（不再走通用 param.missing）。
                                    {"type": "setNarrativeState", "params": {"graphId": "flow:bad"}},
                                    # manifest 内 action 的真缺必填仍走 action.param.missing。
                                    {"type": "giveItem", "params": {}},
                                ],
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
        self.assertIn("action.param.missing", error_codes)  # giveItem 缺 id
        self.assertIn("stateCommand.target.missing", error_codes)  # setNarrativeState 缺 stateId

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
            # 借用真实的脏判断助手，让测试穿过 confirm_close → _web_editor_dirty_state
            # → _run_editor_js_result 的完整链路。
            _web_editor_dirty_state = NarrativeStateEditor._web_editor_dirty_state

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

    def test_confirm_close_asks_when_dirty_state_unknown(self) -> None:
        """脏态未知（JS 超时返回 None）时 fail-safe 当脏询问，不静默放行丢草稿（复核 P2）。"""
        class FakeEditor:
            _web_editor_dirty_state = NarrativeStateEditor._web_editor_dirty_state

            def __init__(self) -> None:
                self._view = object()

            def _run_editor_js_result(self, code: str, timeout_ms: int = 5000):  # noqa: ANN001
                return None  # 超时/取不到

        fake = FakeEditor()
        with patch(
            "tools.editor.editors.narrative_state_editor.QMessageBox.question",
            return_value=QMessageBox.StandardButton.Cancel,
        ) as q:
            # 未知按脏处理 → 弹询问 → Cancel → 返回 False（阻止关闭）
            self.assertFalse(NarrativeStateEditor.confirm_close(fake, None))  # type: ignore[arg-type]
        self.assertTrue(q.called, "脏态未知时应当弹确认，而非静默放行")

    def test_flush_fail_safe_when_editor_state_unreadable(self) -> None:
        """J 修复（对抗组 V3）：_read_editor_state 整体返回 None（JS 引擎彻底卡死，既非
        crashed 也无 lastDraft）时，flush_to_model 必须 fail-safe 返回 False + 留可读原因，
        绝不伪成功让 Save All 漏掉叙事草稿。"""
        class FakeEditor:
            flush_to_model = NarrativeStateEditor.flush_to_model
            pop_flush_error = NarrativeStateEditor.pop_flush_error

            def __init__(self) -> None:
                self._view = object()
                self._last_flush_error = None

            def _read_editor_state(self, *a, **k):  # noqa: ANN002, ANN003
                return None  # 整体读不到（JS 引擎卡死）

        fake = FakeEditor()
        self.assertFalse(fake.flush_to_model(for_save_all=True),
                         "state 完全读不到时必须返回 False，不能伪成功")
        reason = fake.pop_flush_error()
        self.assertTrue(reason, "fail-safe 须留下可读原因")
        self.assertIn("叙事", reason)

    def test_flush_allows_when_state_readable_but_empty(self) -> None:
        """不误伤：state 能读到（dict）但确实无内容/无草稿的合法路径仍 return True。"""
        class FakeEditor:
            flush_to_model = NarrativeStateEditor.flush_to_model

            def __init__(self) -> None:
                self._view = object()
                self._last_flush_error = None

            def _read_editor_state(self, *a, **k):  # noqa: ANN002, ANN003
                return {"hasApi": True}  # 已加载、能读到，但无 json 内容可 flush

        fake = FakeEditor()
        self.assertTrue(fake.flush_to_model(for_save_all=True),
                        "已加载但无内容的合法路径不应被 J 修复误伤")

    def test_validate_accepts_minimal_legal_action_forms(self) -> None:
        """P1-10：保持默认值的合法最小形态不得被兜底校验拦（此前 _PARAM_SCHEMAS 全项当必填）。"""
        # waitMs（全可选）、stopSceneAmbient（全可选）、giveItem（仅 id 必填，count/critical 可选）
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
                        "states": {
                            "a": {"id": "a"},
                            "b": {
                                "id": "b",
                                "onEnterActions": [
                                    {"type": "waitMs", "params": {}},
                                    {"type": "stopSceneAmbient", "params": {}},
                                    {"type": "giveItem", "params": {"id": "item_x"}},
                                    {"type": "showEmote", "params": {"target": "npc_a", "emote": "happy"}},
                                ],
                            },
                        },
                        "transitions": [{"id": "t", "from": "a", "to": "b", "signal": "go"}],
                    },
                    "elements": [],
                }
            ],
        })
        missing = [i for i in issues if i.get("code") == "action.param.missing"]
        self.assertEqual(missing, [], f"合法最小形态被误报缺参：{missing}")

    def test_validate_still_flags_true_missing_required(self) -> None:
        """真缺必填仍要拦：giveItem 缺 id、emitNarrativeSignal 缺 signal。"""
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
                        "states": {
                            "a": {"id": "a"},
                            "b": {
                                "id": "b",
                                "onEnterActions": [
                                    {"type": "giveItem", "params": {}},
                                    {"type": "emitNarrativeSignal", "params": {"signal": "  "}},
                                ],
                            },
                        },
                        "transitions": [{"id": "t", "from": "a", "to": "b", "signal": "go"}],
                    },
                    "elements": [],
                }
            ],
        })
        codes = [(i.get("code"), i.get("path")) for i in issues if i.get("code") == "action.param.missing"]
        self.assertTrue(any("giveItem" not in str(p) or "id" in str(p) for _, p in codes))
        self.assertTrue(len(codes) >= 2, f"应拦下 giveItem.id 与 emitNarrativeSignal.signal：{codes}")


class TestNarrativeAppearance(unittest.TestCase):
    def test_host_font_tokens_update_css_without_touching_model(self) -> None:
        class FakePage:
            scripts: list[str] = []

            def runJavaScript(self, script: str) -> None:
                self.scripts.append(script)

        class FakeView:
            _page = FakePage()

            def page(self) -> FakePage:
                return self._page

        class FakeModel:
            dirty_calls = 0

            def mark_dirty(self, _bucket: str) -> None:
                self.dirty_calls += 1

        class FakeEditor:
            _view = FakeView()
            _model = FakeModel()

        editor = FakeEditor()
        tokens = {"--editor-host-font-delta": "7px", "--editor-host-font-12": "19px"}
        with patch.object(theme, "web_font_css_tokens", return_value=tokens):
            NarrativeStateEditor._apply_web_font_tokens(editor)  # type: ignore[arg-type]
        script = editor._view._page.scripts[-1]
        self.assertIn("--editor-host-font-delta", script)
        self.assertIn("--editor-host-font-12", script)
        self.assertEqual(editor._model.dirty_calls, 0)

    def test_placeholder_font_comes_from_host_css_variable(self) -> None:
        page = _placeholder_html("<not built>")
        expected = theme.css_font_px(theme.FONT_ROLE_PROMINENT, theme.DEFAULT_FONT_PX)
        self.assertIn(f"var(--editor-host-font-prominent,{expected})", page)
        self.assertIn("&lt;not built&gt;", page)

    def test_web_font_tokens_add_global_delta_without_page_zoom(self) -> None:
        large = theme.web_font_css_tokens(theme.MAX_FONT_PX)
        small = theme.web_font_css_tokens(theme.MIN_FONT_PX)
        self.assertEqual(large["--editor-host-font-delta"], "7px")
        self.assertEqual(large["--editor-host-font-12"], "19px")
        self.assertEqual(small["--editor-host-font-delta"], "-4px")
        self.assertEqual(small["--editor-host-font-9"], "7px")


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


class TestReview20260717Regressions(unittest.TestCase):
    """2026-07-17 审查修复回归（artifact/Reviews/叙事状态机全面审查-2026-07-17.md P-F1/F2/F4/F5/F6）。"""

    @staticmethod
    def _file_with_transition(conditions=None, states=None, transitions=None, elements=None):
        return {
            "schemaVersion": 3,
            "signals": [{"id": "go", "label": "go"}],
            "compositions": [
                {
                    "id": "comp",
                    "mainGraph": {
                        "id": "flow",
                        "ownerType": "flow",
                        "initialState": "a",
                        "states": states or {"a": {"id": "a"}, "b": {"id": "b"}},
                        "transitions": transitions if transitions is not None else [
                            {"id": "t", "from": "a", "to": "b", "signal": "go",
                             **({"conditions": conditions} if conditions else {})},
                        ],
                    },
                    "elements": elements or [],
                }
            ],
        }

    def _bridge(self, td: str) -> tuple[NarrativeEditorBridge, ProjectModel]:
        root = Path(td) / "p"
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        return NarrativeEditorBridge(m), m

    def test_bridge_save_accepts_plane_condition_leaf(self) -> None:
        """P-F1：plane 是第 6 类合法条件叶子，Python 兜底不得拦（曾拦=比 TS 严红线再犯）。"""
        with TemporaryDirectory() as td:
            bridge, m = self._bridge(td)
            result = bridge.saveData(json.dumps(self._file_with_transition(conditions=[{"plane": "yin"}])))
            self.assertEqual(result, "saved to ProjectModel")
            self.assertTrue(m.is_dirty)

    def test_bridge_save_accepts_bare_quest_scenario_leaves(self) -> None:
        """P-F1 同族：quest/scenario/scenarioLine 缺伴随字段时 TS 静默容忍，Python 不得报 error。"""
        with TemporaryDirectory() as td:
            bridge, _ = self._bridge(td)
            result = bridge.saveData(json.dumps(self._file_with_transition(conditions=[
                {"quest": "q1"},
                {"scenario": "s1", "phase": "p"},
                {"scenarioLine": "l1"},
            ])))
            self.assertEqual(result, "saved to ProjectModel")

    def test_normalize_never_auto_marks_broadcast_and_validation_reports(self) -> None:
        """P-F2：normalize 不代写 broadcastOnEnter（2026-07-16 拍板对齐 web 侧）；
        监听未广播状态 = state.broadcast.missing error 拦保存，而不是被静默"修好"。"""
        data = {
            "schemaVersion": 3,
            "signals": [],
            "compositions": [
                {
                    "id": "comp",
                    "mainGraph": {
                        "id": "M",
                        "ownerType": "flow",
                        "initialState": "m0",
                        "states": {"m0": {"id": "m0"}, "m1": {"id": "m1"}},
                        "transitions": [{"id": "t", "from": "m0", "to": "m1", "signal": "state:W:w1"}],
                    },
                    "elements": [
                        {
                            "id": "el_w",
                            "kind": "wrapperGraph",
                            "ownerType": "npc",
                            "ownerId": "npc_1",
                            "graph": {
                                "id": "W",
                                "ownerType": "npc",
                                "ownerId": "npc_1",
                                "initialState": "w0",
                                "states": {"w0": {"id": "w0"}, "w1": {"id": "w1"}},
                                "transitions": [{"id": "t", "from": "w0", "to": "w1", "signal": "go_w"}],
                            },
                        }
                    ],
                }
            ],
        }
        from tools.editor.editors.narrative_state_editor import _normalize_file

        normalized = _normalize_file(data)
        w_states = normalized["compositions"][0]["elements"][0]["graph"]["states"]
        self.assertNotIn("broadcastOnEnter", w_states["w1"])  # normalize 绝不代写
        issues = validate_narrative_graphs(normalized)
        self.assertTrue(any(i.get("code") == "state.broadcast.missing" and i.get("severity") == "error" for i in issues))
        with TemporaryDirectory() as td:
            bridge, m = self._bridge(td)
            before = m.narrative_graphs
            result = bridge.saveData(json.dumps(data))
            self.assertIn("save blocked", result)
            self.assertEqual(m.narrative_graphs, before)

    def test_save_templates_rejects_duplicate_ids_instead_of_silent_drop(self) -> None:
        """P-F5：重复模板 id 必须被 template.id.duplicate 拦下，不得归一去重后静默丢第二份还返回 ok。"""
        with TemporaryDirectory() as td:
            bridge, m = self._bridge(td)
            tpl = {
                "id": "tpl_a",
                "label": "A",
                "params": [{"name": "taskId", "label": "任务", "kind": "identifier"}],
                "composition": {"id": "flow_{{taskId}}", "mainGraph": {"id": "flow_{{taskId}}", "ownerType": "flow", "initialState": "a", "states": {"a": {"id": "a"}}, "transitions": []}, "elements": []},
            }
            result = json.loads(bridge.saveTemplates(json.dumps({"templates": [tpl, dict(tpl)]})))
            self.assertFalse(result.get("ok"))
            self.assertIn("重复", str(result.get("reason", "")))
            self.assertFalse(m.is_dirty)

    def test_bridge_save_survives_garbage_schema_version(self) -> None:
        """P-F6：垃圾 schemaVersion 不得让 Qt slot 抛异常返回空串（网页会把空串当保存成功）。"""
        with TemporaryDirectory() as td:
            bridge, _ = self._bridge(td)
            payload = self._file_with_transition()
            payload["schemaVersion"] = "abc"
            result = bridge.saveData(json.dumps(payload))
            self.assertTrue(result)  # 绝不空串
            self.assertNotEqual(result.strip(), "")

    def test_bridge_save_rejects_unknown_active_plane_and_accepts_known(self) -> None:
        """P-F4：activePlane 引用不存在位面 = error 拦保存（与 TS state.activePlane.unknown 对齐）。"""
        with TemporaryDirectory() as td:
            bridge, m = self._bridge(td)
            m.planes = [{"id": "normal"}, {"id": "yin"}]
            bad = self._file_with_transition(states={"a": {"id": "a"}, "b": {"id": "b", "activePlane": "nope"}})
            result = bridge.saveData(json.dumps(bad))
            self.assertIn("save blocked", result)
            good = self._file_with_transition(states={"a": {"id": "a"}, "b": {"id": "b", "activePlane": "yin"}})
            self.assertEqual(bridge.saveData(json.dumps(good)), "saved to ProjectModel")

    def test_active_plane_shape_error_matches_ts(self) -> None:
        """P-F4：activePlane 非空字符串形状检查（state.activePlane.invalid，文件本地即查）。"""
        bad = self._file_with_transition(states={"a": {"id": "a"}, "b": {"id": "b", "activePlane": "  "}})
        issues = validate_narrative_graphs(bad)
        self.assertTrue(any(i.get("code") == "state.activePlane.invalid" and i.get("severity") == "error" for i in issues))

    def test_scenario_subgraph_missing_graph_is_not_python_error(self) -> None:
        """P-F8 对齐：scenarioSubgraph 缺 graph TS 无 issue，Python 兜底不得报 error。"""
        data = self._file_with_transition(elements=[
            {"id": "el_s", "kind": "scenarioSubgraph", "refId": "sc_1"},
        ])
        issues = validate_narrative_graphs(data)
        self.assertFalse(any(i.get("code") == "element.graph.missing" for i in issues))

    def test_reserved_prefix_emit_action_is_error(self) -> None:
        """W5：emitNarrativeSignal 参数用 state:/__draft__ 保留前缀 = error 拦保存（伪造派生广播）。"""
        data = self._file_with_transition(states={
            "a": {"id": "a"},
            "b": {"id": "b", "onEnterActions": [
                {"type": "emitNarrativeSignal", "params": {"signal": "state:flow:b"}},
            ]},
        })
        issues = validate_narrative_graphs(data)
        self.assertTrue(any(i.get("code") == "action.signal.reserved" and i.get("severity") == "error" for i in issues))

    def test_wrapper_empty_owner_type_no_phantom_warning(self) -> None:
        """P-F9 对齐：wrapper ownerType 为空时 TS 跳过，Python 不得报幻影 warning。"""
        data = self._file_with_transition(elements=[
            {
                "id": "el_w", "kind": "wrapperGraph", "ownerId": "npc_1",
                "graph": {"id": "W2", "ownerType": "npc", "ownerId": "npc_1", "initialState": "w0",
                          "states": {"w0": {"id": "w0"}}, "transitions": []},
            },
        ])
        issues = validate_narrative_graphs(data)
        self.assertFalse(any(i.get("code") == "wrapper.ownerType.unsupported" for i in issues))


if __name__ == "__main__":
    unittest.main()
