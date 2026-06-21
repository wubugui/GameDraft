"""water_minigame 实体列表总览(M19)：列表↔画布选择双向同步、经列表重排、
重排后各实体动作数组跟随本体(不串台)、apply/flush 后未触动实体与输入深相等。

只验证「实体的 VIEW + 同步」，绝不改 entities 数组的数据形状或画布↔模型回写映射。
"""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtWidgets import QApplication

from tools.editor.editors.water_minigame_editor import WaterMinigameEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


def _act(t: str) -> dict:
    # ActionEditor 往返会把 action 规范化为 {type, params}；输入即用规范形，
    # 这样「选中实体(加载到 ActionEditor)再写回」是无损 round-trip，
    # deep-equal 校验才真正测「重排/浏览不损坏数据」而非规范化噪声。
    return {"type": t, "params": {}}


def _make_entities() -> list[dict]:
    return [
        {
            "id": "e0",
            "category": "grass",
            "sprite": "",
            "depth": 0.5,
            "pos": {"x": 10, "y": 20},
            "onPick": [_act("A0")],
            "onPullSuccess": [_act("S0")],
            "onPullFail": [_act("F0")],
        },
        {
            "id": "e1",
            "category": "floating",
            "sprite": "",
            "depth": 0.6,
            "pos": {"x": 30, "y": 40},
            "onPick": [_act("A1")],
            "onPullSuccess": [_act("S1")],
            "onPullFail": [_act("F1")],
        },
        {
            "id": "e2",
            "category": "sunken",
            "sprite": "",
            "depth": 0.7,
            "pos": {"x": 50, "y": 60},
            "onPick": [_act("A2")],
            "onPullSuccess": [_act("S2")],
            "onPullFail": [_act("F2")],
        },
    ]


class WaterEntityListTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list[WaterMinigameEditor] = []
        p = patch("tools.editor.shared.confirm.confirm_delete", return_value=True)
        p.start()
        self.addCleanup(p.stop)

    def tearDown(self) -> None:
        for ed in self._editors:
            ed.deleteLater()
        self._editors.clear()
        QApplication.processEvents()

    def _editor(self, root: Path) -> tuple[WaterMinigameEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.water_minigames_index = [{"id": "wm1", "file": "wm1.json"}]
        model.water_minigames_instances = {
            "wm1": {
                "id": "wm1",
                "bounds": {"width": 720, "height": 480},
                "entities": _make_entities(),
            }
        }
        ed = WaterMinigameEditor(model)
        ed._inst_list_w.setCurrentRow(0)
        self._editors.append(ed)
        return ed, model

    def _ents(self, model: ProjectModel) -> list[dict]:
        return model.water_minigames_instances["wm1"]["entities"]

    def _list_ids(self, ed: WaterMinigameEditor) -> list[str]:
        # 列表项文本格式 "id  [category]"；取 id 前缀。
        out: list[str] = []
        for i in range(ed._ent_list_w.count()):
            txt = ed._ent_list_w.item(i).text()
            out.append(txt.split("  [", 1)[0])
        return out

    # ---- 列表↔画布选择双向同步 -------------------------------------------

    def test_list_mirrors_entities_order(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            self.assertEqual(self._list_ids(ed), ["e0", "e1", "e2"])
            self.assertEqual([e["id"] for e in self._ents(model)], ["e0", "e1", "e2"])

    def test_canvas_selection_syncs_to_list(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            # 模拟画布点选第 2 行
            ed._on_canvas_entity_selected(2)
            self.assertEqual(ed._ent_list_w.currentRow(), 2)
            self.assertEqual(ed._selected_ent_row, 2)

    def test_list_selection_syncs_to_canvas(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            # 经列表选中第 1 行 -> 内部选中行/当前实体随之
            ed._ent_list_w.setCurrentRow(1)
            self.assertEqual(ed._selected_ent_row, 1)
            self.assertIs(ed._cur_ent, self._ents(model)[1])

    # ---- 经列表重排 + 动作跟随本体 ---------------------------------------

    def test_reorder_via_list_moves_actions_with_entity(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            # 选中列表里的 e0(行0)，下移；走既有 _move_entity_down(复用既有重排)
            ed._ent_list_w.setCurrentRow(0)
            ed._move_entity_down()

            ents = self._ents(model)
            # (a) entities 数组顺序与列表一致
            self.assertEqual([e["id"] for e in ents], ["e1", "e0", "e2"])
            self.assertEqual(self._list_ids(ed), ["e1", "e0", "e2"])
            # (b) 各实体动作数组跟随本体，无串台
            by_id = {e["id"]: e for e in ents}
            self.assertEqual([a["type"] for a in by_id["e0"]["onPick"]], ["A0"])
            self.assertEqual([a["type"] for a in by_id["e0"]["onPullSuccess"]], ["S0"])
            self.assertEqual([a["type"] for a in by_id["e0"]["onPullFail"]], ["F0"])
            self.assertEqual([a["type"] for a in by_id["e1"]["onPick"]], ["A1"])
            self.assertEqual([a["type"] for a in by_id["e1"]["onPullSuccess"]], ["S1"])
            self.assertEqual([a["type"] for a in by_id["e1"]["onPullFail"]], ["F1"])
            self.assertEqual([a["type"] for a in by_id["e2"]["onPick"]], ["A2"])

    # ---- apply/flush 后未触动实体与输入深相等 ----------------------------

    def test_flush_leaves_untouched_entities_deep_equal(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            golden = copy.deepcopy(_make_entities())

            # 选中每个实体走一遍(模拟用户浏览)，再 reorder，再 flush_to_model。
            for r in range(3):
                ed._ent_list_w.setCurrentRow(r)
            ed._ent_list_w.setCurrentRow(2)
            ed._move_entity_up()  # e2 上移 -> e0,e2,e1
            ed.flush_to_model()

            ents = self._ents(model)
            self.assertEqual([e["id"] for e in ents], ["e0", "e2", "e1"])

            golden_by_id = {e["id"]: e for e in golden}
            for e in ents:
                # 仅浏览/重排，绝不改字段：每个实体仍与初始输入深相等。
                self.assertEqual(
                    e, golden_by_id[e["id"]], f"实体 {e['id']!r} 在浏览/重排后被意外改动",
                )


if __name__ == "__main__":
    unittest.main()
