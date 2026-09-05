"""dev 跳转表（dev_narrative_warps.json）的悬垂引用要被 validate 报出来。

这张表只有游戏 dev 菜单消费，场景 / 图 / 状态改名后它不会跟着改；此前零校验，
点进去只会在 enterNarrativeWarp 的收尾汇总里看到"没到位"。
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.validator import validate

_GRAPHS = {
    "schemaVersion": 2,
    "compositions": [{
        "id": "comp_main",
        "mainGraph": {"id": "flow_main", "states": {"initial": {}, "s02": {}}, "transitions": []},
        "elements": [{"id": "el_听书",
                      "graph": {"id": "scenario_听书", "states": {"listening": {}}, "transitions": []}}],
    }],
}


def _warp_issues(warps: list[dict]) -> list[str]:
    with TemporaryDirectory() as td:
        root = Path(td) / "p"
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.narrative_graphs = _GRAPHS
        model.dev_narrative_warps = warps
        return [f"{i.item_id}: {i.message}" for i in validate(model)
                if i.data_type == "devNarrativeWarps"]


class DevNarrativeWarpsValidationTests(unittest.TestCase):
    def test_well_formed_table_is_clean(self) -> None:
        self.assertEqual(_warp_issues([
            {"id": "听书", "label": "1", "scene": "sc_a",
             "flowGraph": "flow_main", "flowState": "s02",
             "set": [{"graph": "scenario_听书", "state": "listening"}]},
            {"id": "只有场景", "label": "2", "scene": "sc_b"},
        ]), [])

    def test_dangling_scene(self) -> None:
        msgs = _warp_issues([{"id": "w", "scene": "已改名的场景"}])
        self.assertTrue(any("已改名的场景" in m and "不存在" in m for m in msgs), msgs)

    def test_dangling_flow_state_and_graph(self) -> None:
        msgs = _warp_issues([
            {"id": "a", "scene": "sc_a", "flowGraph": "flow_main", "flowState": "没有这个状态"},
            {"id": "b", "scene": "sc_a", "set": [{"graph": "scenario_没有", "state": "x"}]},
        ])
        self.assertTrue(any(m.startswith("a:") and "没有这个状态" in m for m in msgs), msgs)
        self.assertTrue(any(m.startswith("b:") and "scenario_没有" in m for m in msgs), msgs)

    def test_missing_pieces(self) -> None:
        msgs = _warp_issues([
            {"id": "", "scene": "sc_a"},
            {"id": "dup", "scene": "sc_a"},
            {"id": "dup", "scene": "sc_a"},
            {"id": "noscene"},
            {"id": "half", "scene": "sc_a", "set": [{"graph": "flow_main"}, "junk"]},
        ])
        joined = "\n".join(msgs)
        for needle in ("缺少非空 id", "重复", "缺少 scene", "需要非空 graph 与 state", "须为对象"):
            self.assertIn(needle, joined)
