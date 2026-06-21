"""列表重排(写有序 JSON 数组)正确性 + 不损坏数据。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.paper_craft_editor import PaperCraftEditor
from tools.editor.editors.quest_editor import _NextQuestsEditor
from tools.editor.editors.water_minigame_editor import WaterMinigameEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class ListReorderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        return m

    def test_paper_order_reorder_swaps(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.paper_craft_index = [{"id": "pc", "file": "pc.json"}]
            m.paper_craft_instances = {"pc": {"id": "pc", "orders": [{"id": "o0"}, {"id": "o1"}, {"id": "o2"}]}}
            ed = PaperCraftEditor(m)
            ed.reload()  # 数据是在构造后注入的，重新载入实例主列表
            ed.instance_list.setCurrentRow(0)
            ed.order_combo.setCurrentIndex(0)
            ed._move_orders(1)
            self.assertEqual([o["id"] for o in m.paper_craft_instances["pc"]["orders"]], ["o1", "o0", "o2"])

    def test_water_entity_reorder_preserves_actions(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.water_minigames_index = [{"id": "wm", "file": "wm.json"}]
            m.water_minigames_instances = {"wm": {"id": "wm", "bounds": {"w": 100, "h": 100}, "entities": [
                {"id": "e0", "onPick": [{"type": "A"}], "onPullSuccess": [], "onPullFail": []},
                {"id": "e1", "onPick": [{"type": "B"}], "onPullSuccess": [], "onPullFail": []},
            ]}}
            ed = WaterMinigameEditor(m)
            ed._inst_list_w.setCurrentRow(0)
            ed._on_canvas_entity_selected(0)
            ed._move_entity_down()
            ents = m.water_minigames_instances["wm"]["entities"]
            self.assertEqual([e["id"] for e in ents], ["e1", "e0"], "实体重排应交换顺序")
            # 动作必须跟随各自实体,不串台
            self.assertEqual([a["type"] for a in ents[0]["onPick"]], ["B"])
            self.assertEqual([a["type"] for a in ents[1]["onPick"]], ["A"])

    def test_nextquests_edge_reorder_preserves_per_edge_data(self) -> None:
        """nextQuests 是有序边数组；重排须让每条边的条件/跳过随各自边移动，
        且不引入超出编辑器既有 set_data→to_list 归一化之外的任何改动。"""
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.quests = [{"id": "qA", "title": ""}, {"id": "qB", "title": ""},
                        {"id": "qC", "title": ""}]
            ed = _NextQuestsEditor(m)
            edges = [
                {"questId": "qA", "conditions": [{"flag": "f1"}]},
                {"questId": "qB", "conditions": [], "bypassPreconditions": True},
                {"questId": "qC", "conditions": []},
            ]
            ed.set_data(edges)
            baseline = ed.to_list()  # 编辑器归一化后的真值
            expected = [baseline[1], baseline[0], baseline[2]]  # 把第0条下移一位
            ed._move_edge(ed._row_widgets[0]["frame"], 1)
            out = ed.to_list()
            self.assertEqual([e["questId"] for e in out], ["qB", "qA", "qC"])
            self.assertEqual(out, expected,
                             "重排结果应等于基线 to_list 的元素交换，无额外改动")


if __name__ == "__main__":
    unittest.main()
