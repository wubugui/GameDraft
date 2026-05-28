from __future__ import annotations

import unittest

from tools.dialogue_graph_editor.graph_document_model import GraphDocumentModel


def sample_graph() -> dict:
    return {
        "schemaVersion": 1,
        "id": "g",
        "entry": "root",
        "nodes": {
            "root": {"type": "line", "next": "choice"},
            "choice": {
                "type": "choice",
                "options": [
                    {"text": "A", "next": "end_a"},
                    {"text": "B", "next": "end_b"},
                ],
            },
            "end_a": {"type": "end"},
            "end_b": {"type": "end"},
        },
    }


class GraphDocumentModelTests(unittest.TestCase):
    def test_data_and_nodes_return_snapshots(self) -> None:
        model = GraphDocumentModel()
        model.load(sample_graph())

        data = model.data
        nodes = model.nodes
        data["id"] = "mutated"
        nodes["root"]["next"] = "mutated"

        self.assertEqual(model.data["id"], "g")
        self.assertEqual(model.nodes["root"]["next"], "choice")
        self.assertFalse(model.is_dirty)

    def test_clear_incoming_to_emits_topology_and_marks_dirty(self) -> None:
        model = GraphDocumentModel()
        model.load(sample_graph())
        topology: list[str] = []
        dirty: list[bool] = []
        model.topology_changed.connect(topology.append)
        model.dirty_changed.connect(dirty.append)

        model.clear_incoming_to("end_b")

        self.assertEqual(topology, ["choice"])
        self.assertEqual(dirty, [True])
        self.assertTrue(model.is_dirty)
        self.assertEqual(model.nodes["choice"]["options"][1]["next"], "")

    def test_set_node_same_data_is_noop(self) -> None:
        model = GraphDocumentModel()
        model.load(sample_graph())
        changed: list[str] = []
        dirty: list[bool] = []
        model.node_changed.connect(changed.append)
        model.dirty_changed.connect(dirty.append)

        model.set_node("root", {"type": "line", "next": "choice"})

        self.assertEqual(changed, [])
        self.assertEqual(dirty, [])
        self.assertFalse(model.is_dirty)
        self.assertEqual(model.nodes["root"]["next"], "choice")

    def test_clear_incoming_to_noop_stays_clean(self) -> None:
        model = GraphDocumentModel()
        model.load(sample_graph())
        topology: list[str] = []
        dirty: list[bool] = []
        model.topology_changed.connect(topology.append)
        model.dirty_changed.connect(dirty.append)

        model.clear_incoming_to("missing")

        self.assertEqual(topology, [])
        self.assertEqual(dirty, [])
        self.assertFalse(model.is_dirty)

    def test_rename_node_emits_affected_signals(self) -> None:
        model = GraphDocumentModel()
        model.load(sample_graph())
        topology: list[str] = []
        meta: list[bool] = []
        dirty: list[bool] = []
        removed: list[str] = []
        added: list[str] = []
        model.topology_changed.connect(topology.append)
        model.meta_changed.connect(lambda: meta.append(True))
        model.dirty_changed.connect(dirty.append)
        model.node_removed.connect(removed.append)
        model.node_added.connect(added.append)

        err = model.rename_node("root", "start")

        self.assertIsNone(err)
        self.assertEqual(removed, ["root"])
        self.assertEqual(added, ["start"])
        self.assertEqual(topology, [])
        self.assertEqual(meta, [True])
        self.assertEqual(dirty, [True])
        self.assertEqual(model.data["entry"], "start")

    def test_rename_node_emits_topology_for_rewritten_refs(self) -> None:
        model = GraphDocumentModel()
        model.load(sample_graph())
        topology: list[str] = []
        model.topology_changed.connect(topology.append)

        err = model.rename_node("end_a", "done")

        self.assertIsNone(err)
        self.assertEqual(topology, ["choice"])
        self.assertEqual(model.nodes["choice"]["options"][0]["next"], "done")


if __name__ == "__main__":
    unittest.main()
