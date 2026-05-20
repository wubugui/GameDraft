from __future__ import annotations

import unittest
from pathlib import Path

from tools.dialogue_graph_editor.graph_document import (
    default_node,
    extract_flow_edges,
    validate_graph,
    validate_graph_tiered,
)
from tools.dialogue_graph_editor.graph_mutations import (
    OUT_CONTEXT_STATE_DEFAULT,
    OUT_OWNER_STATE_DEFAULT,
    connect_output_to_target,
)


class OwnerContextNodeTests(unittest.TestCase):
    def test_default_owner_state_node(self) -> None:
        node = default_node("ownerState", {})
        self.assertEqual(node["type"], "ownerState")
        self.assertIn("cases", node)
        self.assertIn("defaultNext", node)

    def test_extract_flow_edges_owner_state(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "t",
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "ownerState",
                    "cases": [{"state": "a", "next": "line1"}],
                    "defaultNext": "line2",
                    "missingWrapperNext": "line3",
                },
                "line1": {"type": "end"},
                "line2": {"type": "end"},
                "line3": {"type": "end"},
            },
        }
        edges = extract_flow_edges(data["nodes"])
        targets = {e[1] for e in edges}
        self.assertEqual(targets, {"line1", "line2", "line3"})

    def test_connect_owner_state_ports(self) -> None:
        data = {
            "nodes": {
                "root": {
                    "type": "ownerState",
                    "cases": [{"state": "a", "next": ""}],
                    "defaultNext": "",
                },
                "n1": {"type": "end"},
            }
        }
        err = connect_output_to_target(data, "root", OUT_OWNER_STATE_DEFAULT, -1, "n1")
        self.assertIsNone(err)
        self.assertEqual(data["nodes"]["root"]["defaultNext"], "n1")

    def test_validate_owner_state_requires_default_next(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "t",
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "ownerState",
                    "cases": [],
                    "defaultNext": "",
                },
            },
        }
        issues = validate_graph(data)
        self.assertTrue(any("defaultNext" in x for x in issues))

    def test_context_state_default_node(self) -> None:
        node = default_node("contextState", {})
        self.assertEqual(node["type"], "contextState")
        self.assertIn("graphId", node)

    def test_connect_context_state_default(self) -> None:
        data = {
            "nodes": {
                "root": {
                    "type": "contextState",
                    "graphId": "flow_x",
                    "cases": [],
                    "defaultNext": "",
                },
                "n1": {"type": "end"},
            }
        }
        err = connect_output_to_target(data, "root", OUT_CONTEXT_STATE_DEFAULT, -1, "n1")
        self.assertIsNone(err)
        self.assertEqual(data["nodes"]["root"]["defaultNext"], "n1")

    def test_rejects_set_narrative_state_in_run_actions(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "t",
            "entry": "actions",
            "nodes": {
                "actions": {
                    "type": "runActions",
                    "actions": [{"type": "setNarrativeState", "params": {"graphId": "flow", "stateId": "a"}}],
                    "next": "end",
                },
                "end": {"type": "end"},
            },
        }
        errors, warnings = validate_graph_tiered(data)
        self.assertTrue(any("setNarrativeState" in e for e in errors))
        self.assertFalse(any("setNarrativeState" in w for w in warnings))

    def test_rejects_forbidden_context_graph_without_project(self) -> None:
        data = {
            "schemaVersion": 1,
            "id": "t",
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "contextState",
                    "graphId": "npc_ringboy",
                    "cases": [{"state": "before_event", "next": "end"}],
                    "defaultNext": "end",
                },
                "end": {"type": "end"},
            },
        }
        errors, _ = validate_graph_tiered(data, project_root=Path(__file__).resolve().parents[3])
        self.assertTrue(any("不允许读取" in e for e in errors))


if __name__ == "__main__":
    unittest.main()
