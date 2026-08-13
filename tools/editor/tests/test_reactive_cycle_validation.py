"""反应式迁移读依赖成环的静态检测。

运行时对振荡只有事后兜底（NarrativeStateManager 的 drain.loop.guard：超步数就清空队列、
叙事停住）。这套检查把它提前到编排期。判据保守：**无环保证不振荡**，有环只是值得看一眼，
故一律 warning。只查 reactive 系迁移——signal 驱动的回路要追 emit→listen 链，且合法的
可重复内容天然成环。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.validator import validate


def _graph(gid: str, transitions: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": gid, "ownerType": "flow", "ownerId": gid,
        "initialState": "a",
        "states": {"a": {"id": "a"}, "b": {"id": "b"}},
        "transitions": transitions,
    }


def _reactive(tid: str, reads: list[str], trigger: str = "reactive") -> dict[str, Any]:
    """一条 reactive 迁移，条件读 reads 里每张图的状态。"""
    return {
        "id": tid, "from": "a", "to": "b", "signal": "", "trigger": trigger,
        "conditions": [{"all": [{"narrative": g, "state": "b"} for g in reads]}],
    }


def _signal_driven(tid: str, reads: list[str]) -> dict[str, Any]:
    """同样的读依赖，但要外部信号才动——不该被报。"""
    return {
        "id": tid, "from": "a", "to": "b", "signal": "some_signal",
        "conditions": [{"all": [{"narrative": g, "state": "b"} for g in reads]}],
    }


def _narr(*graphs: dict[str, Any]) -> dict[str, Any]:
    return {
        "schemaVersion": 2,
        "migrations": [],
        "compositions": [
            {"id": f"comp_{g['id']}", "mainGraph": g, "elements": []} for g in graphs
        ],
        "signals": [{"id": "some_signal"}],
    }


class TestReactiveCycleValidation(unittest.TestCase):
    def _warnings(self, narrative: dict[str, Any]) -> list[str]:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            dp = root / "public" / "assets" / "data"
            (dp / "narrative_graphs.json").write_text(
                json.dumps(narrative, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            model = ProjectModel()
            model.load_project(root)
            return [
                i.message for i in validate(model)
                if i.data_type == "narrative" and "反应式迁移" in i.message
            ]

    def test_no_cycle_is_silent(self) -> None:
        """A 读 B、B 不读任何人：链状，不报。"""
        narr = _narr(
            _graph("g_a", [_reactive("t1", ["g_b"])]),
            _graph("g_b", []),
        )
        self.assertEqual(self._warnings(narr), [])

    def test_two_graph_cycle_is_reported(self) -> None:
        """A 的 reactive 读 B、B 的 reactive 读 A —— 互相触发。"""
        narr = _narr(
            _graph("g_a", [_reactive("t1", ["g_b"])]),
            _graph("g_b", [_reactive("t2", ["g_a"])]),
        )
        msgs = self._warnings(narr)
        self.assertTrue(any("读依赖成环" in m for m in msgs), msgs)
        self.assertTrue(any("g_a" in m and "g_b" in m for m in msgs), msgs)

    def test_three_graph_cycle_is_reported(self) -> None:
        narr = _narr(
            _graph("g_a", [_reactive("t1", ["g_c"])]),
            _graph("g_b", [_reactive("t2", ["g_a"])]),
            _graph("g_c", [_reactive("t3", ["g_b"])]),
        )
        msgs = self._warnings(narr)
        self.assertTrue(any("读依赖成环" in m for m in msgs), msgs)
        self.assertTrue(
            any(all(g in m for g in ("g_a", "g_b", "g_c")) for m in msgs), msgs)

    def test_self_read_is_reported(self) -> None:
        """图的 reactive 条件读本图状态：迁移本身会改它，重评可能反复成立。"""
        narr = _narr(_graph("g_a", [_reactive("t1", ["g_a"])]))
        msgs = self._warnings(narr)
        self.assertTrue(any("本图自己的状态" in m for m in msgs), msgs)

    def test_signal_driven_cycle_is_not_reported(self) -> None:
        """同样的读依赖，但要外部信号才动 —— 不能自持，不报。"""
        narr = _narr(
            _graph("g_a", [_signal_driven("t1", ["g_b"])]),
            _graph("g_b", [_signal_driven("t2", ["g_a"])]),
        )
        self.assertEqual(self._warnings(narr), [])

    def test_reactive_all_and_any_variants_count(self) -> None:
        """reactiveAll / reactiveAny 与 reactive 同属自动重评面，一样要查。"""
        narr = _narr(
            _graph("g_a", [_reactive("t1", ["g_b"], trigger="reactiveAll")]),
            _graph("g_b", [_reactive("t2", ["g_a"], trigger="reactiveAny")]),
        )
        self.assertTrue(any("读依赖成环" in m for m in self._warnings(narr)))

    def test_dangling_reference_is_not_reported_here(self) -> None:
        """读了不存在的图：既有校验会点名，本检查不重复报，也不该因此成环。"""
        narr = _narr(_graph("g_a", [_reactive("t1", ["g_nowhere"])]))
        self.assertEqual(self._warnings(narr), [])

    def test_real_project_has_no_reactive_cycles(self) -> None:
        """真项目现状基线：出现新环时这条会红，逼作者当场确认是不是有意的。"""
        repo_root = Path(__file__).resolve().parents[3]
        model = ProjectModel()
        model.load_project(repo_root)
        msgs = [
            i.message for i in validate(model)
            if i.data_type == "narrative" and "反应式迁移" in i.message
        ]
        self.assertEqual(msgs, [], f"真项目出现反应式环：{msgs}")


if __name__ == "__main__":
    unittest.main()
