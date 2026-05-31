from __future__ import annotations

import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from tools.dialogue_graph_editor.editor_widget import (
    _graph_preconditions_for_editor,
    _split_graph_preconditions_for_editor,
)
from tools.editor.shared.condition_editor import ConditionEditor


class FakeProjectModel:
    flag_registry: dict = {}

    def scenario_ids_ordered(self) -> list[str]:
        return ["scenario_a", "line_a"]

    def phases_for_scenario(self, scenario_id: str) -> list[str]:
        return ["phase_a"] if scenario_id == "scenario_a" else []


class ConditionEditorStructuredTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def test_dialogue_graph_preconditions_feed_structured_condition_editor(self) -> None:
        raw = [
            {"flag": "has_ring", "op": "!=", "value": False},
            {"quest": "q_bridge", "questStatus": "Active"},
            {"scenario": "scenario_a", "phase": "phase_a", "status": "done"},
            {"scenarioLine": "line_a", "lineStatus": "active"},
        ]

        editor = ConditionEditor("preconditions")
        editor.set_flag_pattern_context(FakeProjectModel(), None)
        editor.set_data(_graph_preconditions_for_editor(raw))

        self.assertEqual(
            editor.to_list(),
            [
                {"flag": "has_ring", "op": "!=", "value": False},
                {
                    "all": [
                        {"quest": "q_bridge", "questStatus": "Active"},
                        {"scenario": "scenario_a", "phase": "phase_a", "status": "done"},
                        {"scenarioLine": "line_a", "lineStatus": "active"},
                    ],
                },
            ],
        )

    def test_single_dict_precondition_is_preserved_as_structured_input(self) -> None:
        raw = {"quest": "q_bridge", "questStatus": "Completed"}

        editor = ConditionEditor("preconditions")
        editor.set_flag_pattern_context(FakeProjectModel(), None)
        editor.set_data(_graph_preconditions_for_editor(raw))

        self.assertEqual(editor.to_list(), [raw])

    def test_unknown_legacy_precondition_shapes_are_split_for_preservation(self) -> None:
        editable, unknown = _split_graph_preconditions_for_editor([
            {"flag": "has_ring"},
            "legacy-weird-shape",
            7,
        ])

        self.assertEqual(editable, [{"flag": "has_ring"}])
        self.assertEqual(unknown, ["legacy-weird-shape", 7])


if __name__ == "__main__":
    unittest.main()
