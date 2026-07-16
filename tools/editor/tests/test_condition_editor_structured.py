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

        # 数据零丢失契约：内容未被实际编辑时，to_list 逐字返回原始数组
        # （不做 flag 行前置、不把多叶包成 {"all":[…]} 的形状重排）。
        self.assertEqual(editor.to_list(), raw)

    def test_editing_a_row_switches_to_canonical_shape_without_losing_leaves(self) -> None:
        raw = [
            {"quest": "q_bridge", "questStatus": "Active"},
            {"flag": "has_ring", "op": "!=", "value": False},
            {"scenarioLine": "line_a", "lineStatus": "active"},
        ]
        editor = ConditionEditor("preconditions")
        editor.set_flag_pattern_context(FakeProjectModel(), None)
        editor.set_data(_graph_preconditions_for_editor(raw))
        # 实际编辑（改 flag 行的 op）后走规范化输出：flag 行在前、其余叶子保留
        editor._rows[0].op_combo.setCurrentText("==")
        out = editor.to_list()
        self.assertEqual(out[0], {"flag": "has_ring", "value": False})
        rest = out[1]
        self.assertEqual(
            rest,
            {"all": [
                {"quest": "q_bridge", "questStatus": "Active"},
                {"scenarioLine": "line_a", "lineStatus": "active"},
            ]},
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
