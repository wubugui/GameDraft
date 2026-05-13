"""P2-8 social + rumor + belief 节点测试。"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.engine.context import ContextStore
from tools.chronicle_sim_v3.engine.node import NodeServices
from tools.chronicle_sim_v3.engine.registry import get_node_class, list_kinds
import tools.chronicle_sim_v3.nodes  # noqa: F401


def _cook(node_cls, ctx, inputs=None, params=None):
    inst = node_cls()
    return asyncio.run(inst.cook(ctx, inputs or {}, params or {}, NodeServices(), None))


_NEW_KINDS = {
    "social.neighbors", "social.bfs_reach", "social.shortest_path",
    "rumor.bfs_engine",
    "belief.decay", "belief.from_events", "belief.from_rumors",
    "belief.merge_truncate",
}


def test_all_kinds_registered() -> None:
    assert _NEW_KINDS.issubset(set(list_kinds()))


# ---------- social ----------


def test_social_neighbors_1hop(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("social.neighbors")
    edges = [{"a": "x", "b": "y", "w": 1}, {"a": "y", "b": "z", "w": 2}]
    out = _cook(cls, cs.read_view(),
                 inputs={"agent_id": "x", "edges": edges}, params={"hops": 1})
    ids = sorted(n["id"] for n in out.values["out"])
    assert ids == ["y"]


def test_social_neighbors_2hop(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("social.neighbors")
    edges = [{"a": "x", "b": "y"}, {"a": "y", "b": "z"}]
    out = _cook(cls, cs.read_view(),
                 inputs={"agent_id": "x", "edges": edges}, params={"hops": 2})
    ids = sorted(n["id"] for n in out.values["out"])
    assert ids == ["y", "z"]


def test_social_bfs_reach(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("social.bfs_reach")
    edges = [{"a": "x", "b": "y"}, {"a": "y", "b": "z"}]
    out = _cook(cls, cs.read_view(),
                 inputs={"start": "x", "edges": edges}, params={"max_hops": 2})
    assert "y" in out.values["out"]
    assert "z" in out.values["out"]
    assert out.values["out"]["y"]["hops"] == 1
    assert out.values["out"]["z"]["hops"] == 2


def test_social_shortest_path_simple(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("social.shortest_path")
    edges = [{"a": "x", "b": "y"}, {"a": "y", "b": "z"}]
    out = _cook(cls, cs.read_view(),
                 inputs={"a": "x", "b": "z", "edges": edges})
    assert out.values["out"] == ["x", "y", "z"]


def test_social_shortest_path_unreachable(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("social.shortest_path")
    out = _cook(cls, cs.read_view(),
                 inputs={"a": "x", "b": "z", "edges": [{"a": "x", "b": "y"}]})
    assert out.values["out"] == []


def test_social_shortest_path_self(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("social.shortest_path")
    out = _cook(cls, cs.read_view(),
                 inputs={"a": "x", "b": "x", "edges": []})
    assert out.values["out"] == ["x"]


def test_social_shortest_path_picks_lower_weight(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("social.shortest_path")
    edges = [
        {"a": "x", "b": "y", "w": 5},
        {"a": "x", "b": "m", "w": 1},
        {"a": "m", "b": "y", "w": 1},
    ]
    out = _cook(cls, cs.read_view(),
                 inputs={"a": "x", "b": "y", "edges": edges})
    assert out.values["out"] == ["x", "m", "y"]


# ---------- rumor ----------


def test_rumor_bfs_engine_basic(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("rumor.bfs_engine")
    events = [{"id": "e1", "related": ["a"]}]
    edges = [{"a": "a", "b": "b"}, {"a": "b", "b": "c"}]
    sim = {"max_hops": 2, "decay_per_hop": 0.8, "p_pass": 1.0, "seed_base": "t"}
    out = _cook(cls, cs.read_view(),
                 inputs={"events": events, "edges": edges,
                          "params": sim, "week": 1})
    rumors = out.values["rumors"]
    assert len(rumors) == 1
    aud = sorted([a["agent_id"] for a in rumors[0]["audience"]])
    assert "b" in aud and "c" in aud


def test_rumor_bfs_engine_p_pass_zero(tmp_path: Path) -> None:
    """p_pass=0 → 没有任何传播。"""
    cs = ContextStore(tmp_path)
    cls = get_node_class("rumor.bfs_engine")
    events = [{"id": "e1", "related": ["a"]}]
    edges = [{"a": "a", "b": "b"}]
    out = _cook(cls, cs.read_view(),
                 inputs={"events": events, "edges": edges,
                          "params": {"p_pass": 0.0, "seed_base": "x"},
                          "week": 1})
    assert out.values["rumors"] == []


def test_rumor_bfs_engine_deterministic(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("rumor.bfs_engine")
    events = [{"id": "e1", "related": ["a"]}]
    edges = [{"a": "a", "b": "b"}, {"a": "b", "b": "c"}, {"a": "c", "b": "d"}]
    sim = {"max_hops": 3, "p_pass": 0.6, "decay_per_hop": 0.7, "seed_base": "abc"}
    a = _cook(cls, cs.read_view(),
                inputs={"events": events, "edges": edges, "params": sim, "week": 5})
    b = _cook(cls, cs.read_view(),
                inputs={"events": events, "edges": edges, "params": sim, "week": 5})
    assert a.values == b.values


# ---------- belief ----------


def test_belief_decay(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("belief.decay")
    beliefs = [
        {"key": "a", "conf": 0.5},
        {"key": "b", "conf": 0.05},
    ]
    out = _cook(cls, cs.read_view(), inputs={"beliefs": beliefs},
                 params={"factor": 0.5, "threshold": 0.1})
    keys = [b["key"] for b in out.values["out"]]
    assert keys == ["a"]  # b 衰减到 0.025 < 0.1 被丢
    assert out.values["out"][0]["conf"] == 0.25


def test_belief_from_events(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("belief.from_events")
    events = [
        {"id": "e1", "actor": "a", "summary": "事件A"},
        {"id": "e2", "actor": "x", "witness": ["a"], "summary": "事件B"},
        {"id": "e3", "actor": "x"},
    ]
    out = _cook(cls, cs.read_view(),
                 inputs={"events": events, "agent_id": "a"})
    keys = sorted(b["key"] for b in out.values["out"])
    assert keys == ["e1", "e2"]


def test_belief_from_rumors(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("belief.from_rumors")
    rumors = [
        {"id": "r1", "source_event_id": "e1",
         "audience": [{"agent_id": "a", "hops": 1, "weight": 0.5}]},
        {"id": "r2", "source_event_id": "e2",
         "audience": [{"agent_id": "a", "hops": 3, "weight": 0.2}]},
    ]
    out = _cook(cls, cs.read_view(),
                 inputs={"rumors": rumors, "agent_id": "a"},
                 params={"conf_heard": 0.3, "conf_spread": 0.7})
    confs = [b["conf"] for b in out.values["out"]]
    assert 0.3 in confs and 0.7 in confs


def test_belief_merge_truncate(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("belief.merge_truncate")
    out = _cook(cls, cs.read_view(),
                 inputs={"lists": [
                     [{"key": "a", "conf": 0.3}, {"key": "b", "conf": 0.5}],
                     [{"key": "a", "conf": 0.8}, {"key": "c", "conf": 0.4}],
                 ]}, params={"top_k": 2})
    out_keys = [b["key"] for b in out.values["out"]]
    out_confs = [b["conf"] for b in out.values["out"]]
    assert out_keys == ["a", "b"]  # a=0.8(取max) > b=0.5 > c=0.4
    assert out_confs == [0.8, 0.5]
