from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from tools.dialogue_graph_editor.graph_document import (
    default_node,
    extract_flow_edges,
    extract_flow_edges_detailed,
    validate_graph,
    validate_graph_tiered,
)
from tools.dialogue_graph_editor.dialogue_ports import (
    OUT_CHOICE,
    OUT_CONTEXT_STATE_CASE,
    OUT_CONTEXT_STATE_DEFAULT,
    OUT_NEXT,
    OUT_OWNER_STATE_CASE,
    OUT_OWNER_STATE_DEFAULT,
    OUT_OWNER_STATE_MISSING,
    OUT_SWITCH_CASE,
    OUT_SWITCH_DEFAULT,
    port_name_for_spec,
)
from tools.dialogue_graph_editor.graph_mutations import (
    clear_output,
    collect_incoming_refs,
    connect_output_to_target,
    rename_node_id,
)
from tools.dialogue_graph_editor.dialogue_topology import TOPOLOGY_BY_NODE_TYPE
from tools.dialogue_graph_editor.flow_oden_controller import DialogueFlowOdenController
from tools.dialogue_graph_editor.node_inspector import NodeInspector
from tools.dialogue_graph_editor.oden_dialogue_nodes import (
    DialogueFlowNode,
    PN_CONTEXT_STATE_DEFAULT,
    PN_NEXT,
    PN_OWNER_STATE_DEFAULT,
    PN_OWNER_STATE_MISSING,
    PN_SWITCH_DEFAULT,
    parse_dialogue_out_port,
    pn_context_state_case,
    pn_choice,
    pn_owner_state_case,
    pn_switch_case,
)


class OwnerContextNodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

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

    def test_connect_clear_and_rename_owner_state_ports(self) -> None:
        data = {
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "ownerState",
                    "cases": [{"state": "a", "next": ""}],
                    "defaultNext": "",
                    "missingWrapperNext": "",
                },
                "hit": {"type": "end"},
                "fallback": {"type": "end"},
                "missing": {"type": "end"},
            },
        }

        self.assertIsNone(connect_output_to_target(data, "root", OUT_OWNER_STATE_CASE, 0, "hit"))
        self.assertIsNone(connect_output_to_target(data, "root", OUT_OWNER_STATE_DEFAULT, -1, "fallback"))
        self.assertIsNone(connect_output_to_target(data, "root", OUT_OWNER_STATE_MISSING, -2, "missing"))
        self.assertEqual(data["nodes"]["root"]["cases"][0]["next"], "hit")
        self.assertEqual(data["nodes"]["root"]["defaultNext"], "fallback")
        self.assertEqual(data["nodes"]["root"]["missingWrapperNext"], "missing")

        self.assertIsNone(rename_node_id(data, "hit", "hit_renamed"))
        self.assertEqual(data["nodes"]["root"]["cases"][0]["next"], "hit_renamed")
        self.assertIsNone(clear_output(data, "root", OUT_OWNER_STATE_CASE, 0))
        self.assertEqual(data["nodes"]["root"]["cases"][0]["next"], "")

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

    def test_connect_clear_and_rename_context_state_ports(self) -> None:
        data = {
            "entry": "root",
            "nodes": {
                "root": {
                    "type": "contextState",
                    "graphId": "flow_x",
                    "cases": [{"state": "ready", "next": ""}],
                    "defaultNext": "",
                },
                "hit": {"type": "end"},
                "fallback": {"type": "end"},
            },
        }

        self.assertIsNone(connect_output_to_target(data, "root", OUT_CONTEXT_STATE_CASE, 0, "hit"))
        self.assertIsNone(connect_output_to_target(data, "root", OUT_CONTEXT_STATE_DEFAULT, -1, "fallback"))
        self.assertEqual(data["nodes"]["root"]["cases"][0]["next"], "hit")
        self.assertEqual(data["nodes"]["root"]["defaultNext"], "fallback")

        self.assertIsNone(rename_node_id(data, "fallback", "fallback_renamed"))
        self.assertEqual(data["nodes"]["root"]["defaultNext"], "fallback_renamed")
        self.assertIsNone(clear_output(data, "root", OUT_CONTEXT_STATE_DEFAULT, -1))
        self.assertEqual(data["nodes"]["root"]["defaultNext"], "")

    def test_oden_output_port_mapping_supports_owner_and_context_state(self) -> None:
        owner = DialogueFlowNode()
        owner.apply_dialogue_shape(
            {
                "type": "ownerState",
                "cases": [{"state": "a", "next": "hit"}],
                "defaultNext": "fallback",
                "missingWrapperNext": "missing",
            },
            is_entry=False,
            diag_tag=None,
        )
        self.assertIsNotNone(DialogueFlowOdenController._output_port_for_spec(owner, OUT_OWNER_STATE_CASE, 0))
        self.assertIsNotNone(DialogueFlowOdenController._output_port_for_spec(owner, OUT_OWNER_STATE_DEFAULT, -1))
        self.assertIsNotNone(DialogueFlowOdenController._output_port_for_spec(owner, OUT_OWNER_STATE_MISSING, -2))

        context = DialogueFlowNode()
        context.apply_dialogue_shape(
            {
                "type": "contextState",
                "graphId": "flow",
                "cases": [{"state": "ready", "next": "hit"}],
                "defaultNext": "fallback",
            },
            is_entry=False,
            diag_tag=None,
        )
        self.assertIsNotNone(DialogueFlowOdenController._output_port_for_spec(context, OUT_CONTEXT_STATE_CASE, 0))
        self.assertIsNotNone(DialogueFlowOdenController._output_port_for_spec(context, OUT_CONTEXT_STATE_DEFAULT, -1))

    def test_parse_owner_and_context_state_ports(self) -> None:
        self.assertEqual(parse_dialogue_out_port(pn_owner_state_case(0)), (OUT_OWNER_STATE_CASE, 0))
        self.assertEqual(parse_dialogue_out_port(PN_OWNER_STATE_DEFAULT), (OUT_OWNER_STATE_DEFAULT, -1))
        self.assertEqual(parse_dialogue_out_port(PN_OWNER_STATE_MISSING), (OUT_OWNER_STATE_MISSING, -2))
        self.assertEqual(parse_dialogue_out_port(pn_context_state_case(0)), (OUT_CONTEXT_STATE_CASE, 0))
        self.assertEqual(parse_dialogue_out_port(pn_context_state_case(12)), (OUT_CONTEXT_STATE_CASE, 12))
        self.assertEqual(parse_dialogue_out_port(PN_CONTEXT_STATE_DEFAULT), (OUT_CONTEXT_STATE_DEFAULT, -1))

    def test_all_dialogue_output_ports_round_trip_between_names_and_specs(self) -> None:
        samples = [
            (PN_NEXT, OUT_NEXT, 0),
            (pn_choice(0), OUT_CHOICE, 0),
            (pn_choice(12), OUT_CHOICE, 12),
            (pn_switch_case(0), OUT_SWITCH_CASE, 0),
            (pn_switch_case(12), OUT_SWITCH_CASE, 12),
            (PN_SWITCH_DEFAULT, OUT_SWITCH_DEFAULT, -1),
            (pn_owner_state_case(0), OUT_OWNER_STATE_CASE, 0),
            (pn_owner_state_case(12), OUT_OWNER_STATE_CASE, 12),
            (PN_OWNER_STATE_DEFAULT, OUT_OWNER_STATE_DEFAULT, -1),
            (PN_OWNER_STATE_MISSING, OUT_OWNER_STATE_MISSING, -2),
            (pn_context_state_case(0), OUT_CONTEXT_STATE_CASE, 0),
            (pn_context_state_case(12), OUT_CONTEXT_STATE_CASE, 12),
            (PN_CONTEXT_STATE_DEFAULT, OUT_CONTEXT_STATE_DEFAULT, -1),
        ]
        for port_name, kind, index in samples:
            with self.subTest(port_name=port_name):
                self.assertEqual(parse_dialogue_out_port(port_name), (kind, index))
                self.assertEqual(port_name_for_spec(kind, index), port_name)

    def test_topology_registry_feeds_edges_and_mutations_for_all_outputs(self) -> None:
        self.assertTrue({"line", "runActions", "choice", "switch", "ownerState", "contextState"}.issubset(TOPOLOGY_BY_NODE_TYPE))

        data = {
            "entry": "line",
            "nodes": {
                "line": {"type": "line", "speaker": {"kind": "player"}, "text": "", "next": "target"},
                "actions": {"type": "runActions", "actions": [], "next": "target"},
                "choice": {
                    "type": "choice",
                    "options": [{"id": "a", "text": "A", "next": "target"}],
                },
                "switch": {
                    "type": "switch",
                    "cases": [{"conditions": [], "next": "target"}],
                    "defaultNext": "target",
                },
                "owner": {
                    "type": "ownerState",
                    "cases": [{"state": "ready", "next": "target"}],
                    "defaultNext": "target",
                    "missingWrapperNext": "target",
                },
                "context": {
                    "type": "contextState",
                    "graphId": "flow",
                    "cases": [{"state": "done", "next": "target"}],
                    "defaultNext": "target",
                },
                "target": {"type": "end"},
            },
        }

        specs = {(src, kind, index) for src, _dst, _label, kind, index in extract_flow_edges_detailed(data["nodes"])}
        self.assertEqual(
            specs,
            {
                ("line", OUT_NEXT, 0),
                ("actions", OUT_NEXT, 0),
                ("choice", OUT_CHOICE, 0),
                ("switch", OUT_SWITCH_CASE, 0),
                ("switch", OUT_SWITCH_DEFAULT, -1),
                ("owner", OUT_OWNER_STATE_CASE, 0),
                ("owner", OUT_OWNER_STATE_DEFAULT, -1),
                ("owner", OUT_OWNER_STATE_MISSING, -2),
                ("context", OUT_CONTEXT_STATE_CASE, 0),
                ("context", OUT_CONTEXT_STATE_DEFAULT, -1),
            },
        )
        self.assertEqual(len(collect_incoming_refs(data, "target")), len(specs))

        self.assertIsNone(rename_node_id(data, "target", "renamed"))
        self.assertFalse(any(dst == "target" for _src, dst, _label in extract_flow_edges(data["nodes"])))
        self.assertEqual(len(collect_incoming_refs(data, "renamed")), len(specs))

    def test_oden_output_port_mapping_supports_all_dialogue_node_outputs(self) -> None:
        shapes = [
            ({"type": "line", "speaker": {"kind": "player"}, "text": "", "next": "end"}, [(OUT_NEXT, 0)]),
            ({"type": "runActions", "actions": [], "next": "end"}, [(OUT_NEXT, 0)]),
            (
                {
                    "type": "choice",
                    "options": [{"id": "a", "text": "A", "next": "end"}, {"id": "b", "text": "B", "next": "end"}],
                },
                [(OUT_CHOICE, 0), (OUT_CHOICE, 1)],
            ),
            (
                {
                    "type": "switch",
                    "cases": [{"conditions": [], "next": "hit"}, {"conditions": [], "next": "miss"}],
                    "defaultNext": "fallback",
                },
                [(OUT_SWITCH_CASE, 0), (OUT_SWITCH_CASE, 1), (OUT_SWITCH_DEFAULT, -1)],
            ),
            (
                {
                    "type": "ownerState",
                    "cases": [{"state": "a", "next": "hit"}, {"state": "b", "next": "miss"}],
                    "defaultNext": "fallback",
                    "missingWrapperNext": "missing",
                },
                [
                    (OUT_OWNER_STATE_CASE, 0),
                    (OUT_OWNER_STATE_CASE, 1),
                    (OUT_OWNER_STATE_DEFAULT, -1),
                    (OUT_OWNER_STATE_MISSING, -2),
                ],
            ),
            (
                {
                    "type": "contextState",
                    "graphId": "flow",
                    "cases": [{"state": "ready", "next": "hit"}, {"state": "done", "next": "miss"}],
                    "defaultNext": "fallback",
                },
                [(OUT_CONTEXT_STATE_CASE, 0), (OUT_CONTEXT_STATE_CASE, 1), (OUT_CONTEXT_STATE_DEFAULT, -1)],
            ),
        ]
        for raw, expected_specs in shapes:
            with self.subTest(node_type=raw["type"]):
                node = DialogueFlowNode()
                node.apply_dialogue_shape(raw, is_entry=False, diag_tag=None)
                for kind, index in expected_specs:
                    self.assertIsNotNone(DialogueFlowOdenController._output_port_for_spec(node, kind, index))

    def test_context_state_inspector_graph_change_does_not_use_deleted_combo(self) -> None:
        root = Path(__file__).resolve().parents[3]
        changes = 0
        inspector = NodeInspector(lambda: ["root", "hit", "fallback"], project_root=root)

        def mark_changed() -> None:
            nonlocal changes
            changes += 1
            inspector.get_node()

        inspector.set_change_callback(mark_changed)

        with patch("tools.editor.shared.narrative_catalog.list_context_readable_graphs") as list_graphs, \
             patch("tools.editor.shared.narrative_catalog.graph_states") as graph_states, \
             patch("tools.editor.shared.narrative_catalog.is_context_graph_allowed") as is_allowed:
            list_graphs.return_value = [
                {"graphId": "flow_a", "label": "Flow A"},
                {"graphId": "flow_b", "label": "Flow B"},
            ]
            graph_states.side_effect = lambda _root, gid: {
                "flow_a": ["ready"],
                "flow_b": ["done"],
            }.get(gid, [])
            is_allowed.return_value = True

            inspector.set_node(
                "root",
                {
                    "type": "contextState",
                    "graphId": "flow_a",
                    "cases": [{"state": "ready", "next": "hit"}],
                    "defaultNext": "fallback",
                },
            )
            refs = inspector._topology_refs
            gid_cb = refs["graph_id_edit"]
            gid_cb.setCurrentText("flow_b")

            node = inspector.get_node()
            self.assertEqual(node["type"], "contextState")
            self.assertEqual(node["graphId"], "flow_b")
            self.assertGreaterEqual(changes, 1)

        inspector.deleteLater()

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
