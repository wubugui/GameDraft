"""共享条件编辑器(ConditionEditor → ConditionExprTreeRootWidget)往返保真回归。

历史缺陷:scenario / scenarioLine 叶子在 set_data→to_list 往返中被静默丢弃——
- scenario 的 phase 为空时整条被丢(`to_dict` 旧逻辑 `if not sid or not ph: return {}`);
- scenarioLine / scenario 指向已删/未知 id 时被重映射到空「（选择）」项再丢弃。
quest / narrative 早已用「未知 id 追加到下拉」的方式保留,本测试把 scenario /
scenarioLine 对齐到同一保真契约,并对 quest / narrative / flag 做回归护栏。

凡是「读进来再导出」与原值不一致,就是数据丢失,违反编辑器格式保真铁律。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.shared.condition_editor import ConditionEditor
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_SCENARIO_ID = "码头水鬼"
_PHASE_ID = "看板初读"


class ConditionExprRoundtripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        # 注入已知的 scenario / quest / narrative / flag,使「真实 id」分支可被填充;
        # 「悬空 id」分支则有意不在这些清单里,以验证保留未知值。
        m.scenarios_catalog = {
            "scenarios": [
                {"id": _SCENARIO_ID, "phases": {_PHASE_ID: {}, "真相揭示": {}}},
            ]
        }
        m.quests = [{"id": "q_intro", "title": "序章"}]
        m.narrative_graphs = {
            "compositions": [
                {
                    "mainGraph": {
                        "id": "ng_main",
                        "label": "主线",
                        "states": {"st_intro": {"label": "开场"}},
                    }
                },
                {
                    "mainGraph": {
                        "id": "ng_job",
                        "label": "淹尸活",
                        "run": {"repeatable": True, "resumable": True},
                        "initialState": "initial",
                        "entryState": "initial",
                        "exitStates": ["delivered"],
                        "states": {
                            "initial": {"label": "未接"},
                            "delivered": {"label": "已交付"},
                        },
                    }
                },
            ]
        }
        m.flag_registry = {
            "static": [{"key": "sys_demo_count", "valueType": "float"}],
            "patterns": [],
            "migrations": {},
            "runtime": {},
        }
        return m

    def _roundtrip(self, m: ProjectModel, conditions: list[dict]) -> list[dict]:
        ed = ConditionEditor()
        ed.set_flag_pattern_context(m, None)
        ed.set_data(conditions)
        try:
            return ed.to_list()
        finally:
            ed.deleteLater()

    def _assert_roundtrip(self, m: ProjectModel, condition: dict) -> None:
        out = self._roundtrip(m, [condition])
        self.assertEqual(
            out, [condition],
            f"条件往返必须保真,期望 {[condition]!r} 实得 {out!r}",
        )

    # ---- scenario ----------------------------------------------------------

    def test_scenario_with_phase_roundtrips(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            self._assert_roundtrip(
                m, {"scenario": _SCENARIO_ID, "phase": _PHASE_ID, "status": "done"},
            )

    def test_scenario_empty_phase_preserved(self) -> None:
        """空 phase 的 scenario 条件以前被整条丢弃;现在须保留 phase:''。"""
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            self._assert_roundtrip(
                m, {"scenario": _SCENARIO_ID, "phase": "", "status": "done"},
            )

    def test_scenario_dangling_id_preserved(self) -> None:
        """指向已删/未知 scenario 的条件须原样保留(不被重映射到空再丢)。"""
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            self._assert_roundtrip(
                m, {"scenario": "已删场景", "phase": "某阶段", "status": "active"},
            )

    # ---- narrativeCount（活计结算计数叶，S2 收尾新增控件） ------------------

    def test_narrative_count_full_roundtrips(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            self._assert_roundtrip(
                m, {"narrativeCount": "ng_job", "exitState": "delivered", "op": ">=", "value": 1},
            )

    def test_narrative_count_without_exit_state_roundtrips(self) -> None:
        """无 exitState = 全部出口合计：往返不得凭空补出 exitState 键。"""
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            self._assert_roundtrip(
                m, {"narrativeCount": "ng_job", "op": "==", "value": 3},
            )

    def test_narrative_count_without_op_preserved_verbatim(self) -> None:
        """缺省 op（运行时默认 >=）的既有数据：UI 未编辑时逐字返回，不补 op 键。"""
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            self._assert_roundtrip(
                m, {"narrativeCount": "ng_job", "value": 2},
            )

    def test_narrative_count_dangling_graph_preserved(self) -> None:
        """指向已删/改名活计图的条件须原样保留（追加「（数据）」项，不静默丢）。"""
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            self._assert_roundtrip(
                m, {"narrativeCount": "ghost_job", "exitState": "done", "op": ">", "value": 5},
            )

    # ---- scenarioLine ------------------------------------------------------

    def test_scenario_line_real_roundtrips(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            self._assert_roundtrip(
                m, {"scenarioLine": _SCENARIO_ID, "lineStatus": "active"},
            )

    def test_scenario_line_dangling_id_preserved(self) -> None:
        """指向未知 scenario 的 scenarioLine 条件须原样保留。"""
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            self._assert_roundtrip(
                m, {"scenarioLine": "ghost_line", "lineStatus": "completed"},
            )

    # ---- quest / narrative (回归护栏:本就保留未知 id) ----------------------

    def test_quest_roundtrips(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            self._assert_roundtrip(m, {"quest": "q_intro", "questStatus": "Active"})

    def test_quest_dangling_id_preserved(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            self._assert_roundtrip(m, {"quest": "q_gone", "questStatus": "Completed"})

    def test_narrative_roundtrips(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            self._assert_roundtrip(m, {"narrative": "ng_main", "state": "st_intro"})

    # ---- flag (回归护栏:已登记 / 未登记键均须保真) -------------------------

    def test_flag_registered_value_roundtrips(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            self._assert_roundtrip(
                m, {"flag": "sys_demo_count", "op": ">=", "value": 3.0},
            )

    def test_flag_unregistered_value_roundtrips(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            self._assert_roundtrip(
                m, {"flag": "sys_unregistered_xyz", "value": False},
            )


if __name__ == "__main__":
    unittest.main()
