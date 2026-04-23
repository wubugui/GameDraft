"""P2-3 data 抽屉补全节点测试。"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.engine.context import ContextStore
from tools.chronicle_sim_v3.engine.node import NodeBusinessError, NodeServices
from tools.chronicle_sim_v3.engine.registry import get_node_class, list_kinds
import tools.chronicle_sim_v3.nodes  # noqa: F401


def _cook(node_cls, ctx, inputs=None, params=None):
    inst = node_cls()
    return asyncio.run(inst.cook(ctx, inputs or {}, params or {}, NodeServices(), None))


_NEW_DATA_KINDS = {
    "pick.first", "pick.nth", "pick.where_one",
    "group.by", "partition.by", "fold",
    "take.tail", "flatten",
    "set.union", "set.diff",
    "dict.kvs",
}


def test_all_p2_data_kinds_registered() -> None:
    assert _NEW_DATA_KINDS.issubset(set(list_kinds()))


def test_pick_first(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("pick.first")
    assert _cook(cls, cs.read_view(), inputs={"list": [1, 2, 3]}).values["out"] == 1
    assert _cook(cls, cs.read_view(), inputs={"list": []},
                  params={"default": "X"}).values["out"] == "X"
    assert _cook(cls, cs.read_view(), inputs={"list": []}).values["out"] is None


def test_pick_nth(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("pick.nth")
    assert _cook(cls, cs.read_view(), inputs={"list": [1, 2, 3]},
                  params={"n": 2}).values["out"] == 3
    with pytest.raises(NodeBusinessError):
        _cook(cls, cs.read_view(), inputs={"list": [1, 2]}, params={"n": 5})


def test_pick_where_one(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("pick.where_one")
    out = _cook(cls, cs.read_view(),
                 inputs={"list": [{"v": 1}, {"v": 5}, {"v": 9}]},
                 params={"expr": "${item.v > 3}"})
    assert out.values["out"] == {"v": 5}
    none_out = _cook(cls, cs.read_view(),
                      inputs={"list": [{"v": 1}]},
                      params={"expr": "${item.v > 99}"})
    assert none_out.values["out"] is None


def test_group_by(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("group.by")
    out = _cook(cls, cs.read_view(),
                 inputs={"list": [{"k": "a", "v": 1}, {"k": "b", "v": 2}, {"k": "a", "v": 3}]},
                 params={"key_expr": "${item.k}"})
    grouped = out.values["out"]
    assert sorted(grouped.keys()) == ["a", "b"]
    assert [it["v"] for it in grouped["a"]] == [1, 3]


def test_partition_by_same_as_group_by(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("partition.by")
    out = _cook(cls, cs.read_view(),
                 inputs={"list": [{"k": "x"}, {"k": "y"}]},
                 params={"key_expr": "${item.k}"})
    assert sorted(out.values["out"].keys()) == ["x", "y"]


def test_fold_sum(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("fold")
    out = _cook(cls, cs.read_view(),
                 inputs={"list": [{"v": 1}, {"v": 2}, {"v": 3}], "init": 0},
                 params={"op_expr": "${inputs.acc + item.v}"})
    assert out.values["out"] == 6


def test_take_tail(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("take.tail")
    out = _cook(cls, cs.read_view(),
                 inputs={"list": [1, 2, 3, 4, 5]},
                 params={"n": 2})
    assert out.values["out"] == [4, 5]
    out0 = _cook(cls, cs.read_view(),
                  inputs={"list": [1, 2, 3]}, params={"n": 0})
    assert out0.values["out"] == []


def test_flatten(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("flatten")
    out = _cook(cls, cs.read_view(),
                 inputs={"list": [[1, 2], [3], [], [4, 5]]})
    assert out.values["out"] == [1, 2, 3, 4, 5]


def test_set_union_dedup(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("set.union")
    out = _cook(cls, cs.read_view(),
                 inputs={"a": [1, 2, 3], "b": [3, 4, 1]})
    assert out.values["out"] == [1, 2, 3, 4]


def test_set_diff(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("set.diff")
    out = _cook(cls, cs.read_view(),
                 inputs={"a": [1, 2, 3, 4], "b": [2, 4]})
    assert out.values["out"] == [1, 3]


def test_set_ops_with_dicts(tmp_path: Path) -> None:
    """dict 通过 canonical_json 哈希；同结构 dict 视为相等。"""
    cs = ContextStore(tmp_path)
    cls = get_node_class("set.union")
    out = _cook(cls, cs.read_view(),
                 inputs={"a": [{"v": 1}, {"v": 2}], "b": [{"v": 1}, {"v": 3}]})
    assert len(out.values["out"]) == 3


def test_dict_kvs(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("dict.kvs")
    out = _cook(cls, cs.read_view(), inputs={"d": {"b": 2, "a": 1, "c": 3}})
    assert out.values["keys"] == ["a", "b", "c"]
    assert out.values["values"] == [1, 2, 3]
