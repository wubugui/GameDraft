"""节点 cache：key 稳定 + 命中回放。"""
from __future__ import annotations

from pathlib import Path

import pytest

from tools.chronicle_sim_v3.engine.context import ContextStore, Mutation
from tools.chronicle_sim_v3.engine.node_cache import (
    NodeCacheStore,
    compute_cache_key,
    instantiate_reads,
    jsonable_to_mutation,
)
from tools.chronicle_sim_v3.engine.node import NodeKindSpec
from tools.chronicle_sim_v3.engine.types import PortSpec


_DUMMY_SPEC = NodeKindSpec(
    kind="test.dummy",
    category="t",
    title="t",
    description="t",
    inputs=(PortSpec(name="x", type="Any"),),
    outputs=(PortSpec(name="out", type="Any"),),
    version="1",
)


def test_instantiate_reads_inputs() -> None:
    keys = instantiate_reads(
        frozenset({"chronicle.events:week=${inputs.week}"}),
        inputs={"week": 3},
        params={},
        ctx_run_id="r",
        week=None,
    )
    assert keys == ["chronicle.events:week=3"]


def test_instantiate_reads_params_and_ctx_week() -> None:
    keys = instantiate_reads(
        frozenset({"chronicle.events:week=${ctx.week}", "world.agent:${params.aid}"}),
        inputs={},
        params={"aid": "npc_x"},
        ctx_run_id="r",
        week=7,
    )
    assert sorted(keys) == ["chronicle.events:week=7", "world.agent:npc_x"]


def test_compute_cache_key_stable(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    k1 = compute_cache_key(_DUMMY_SPEC, {"x": 1}, {}, [], cs)
    k2 = compute_cache_key(_DUMMY_SPEC, {"x": 1}, {}, [], cs)
    assert k1 == k2


def test_compute_cache_key_changes_on_inputs(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    k1 = compute_cache_key(_DUMMY_SPEC, {"x": 1}, {}, [], cs)
    k2 = compute_cache_key(_DUMMY_SPEC, {"x": 2}, {}, [], cs)
    assert k1 != k2


def test_compute_cache_key_changes_on_params(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    k1 = compute_cache_key(_DUMMY_SPEC, {}, {"p": 1}, [], cs)
    k2 = compute_cache_key(_DUMMY_SPEC, {}, {"p": 2}, [], cs)
    assert k1 != k2


def test_compute_cache_key_changes_on_version(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    spec_v2 = NodeKindSpec(
        kind="test.dummy", category="t", title="t", description="t",
        inputs=(), outputs=(PortSpec(name="o", type="Any"),), version="2",
    )
    k1 = compute_cache_key(_DUMMY_SPEC, {}, {}, [], cs)
    k2 = compute_cache_key(spec_v2, {}, {}, [], cs)
    assert k1 != k2


def test_compute_cache_key_changes_on_reads(tmp_path: Path) -> None:
    """改输入下游 miss：reads slice 变化 → key 变。"""
    cs = ContextStore(tmp_path)
    k1 = compute_cache_key(_DUMMY_SPEC, {}, {}, ["world.setting"], cs)
    cs.commit([Mutation(op="put_json", key="world.setting", payload={"v": 1})])
    cs2 = ContextStore(tmp_path)  # 新 store 强制重读
    k2 = compute_cache_key(_DUMMY_SPEC, {}, {}, ["world.setting"], cs2)
    assert k1 != k2


def test_store_and_lookup(tmp_path: Path) -> None:
    s = NodeCacheStore(tmp_path)
    key = "abc" * 21 + "0"  # 64-char-ish
    muts = [Mutation(op="put_json", key="world.setting", payload={"v": 1})]
    s.store(key, _DUMMY_SPEC, {"out": 42}, muts, {"inputs": "i", "params": "p"})
    e = s.lookup(key)
    assert e is not None
    assert e["values"] == {"out": 42}
    assert e["mutations"][0]["op"] == "put_json"


def test_lookup_returns_none_when_missing(tmp_path: Path) -> None:
    s = NodeCacheStore(tmp_path)
    assert s.lookup("nonexistent" * 5) is None


def test_jsonable_to_mutation_roundtrip() -> None:
    m1 = Mutation(op="put_json", key="world.setting", payload={"v": 1})
    j = {
        "op": "put_json", "key": "world.setting",
        "payload": {"v": 1}, "payload_path": None, "new_key": None,
    }
    m2 = jsonable_to_mutation(j)
    assert m2 == m1


def test_clear(tmp_path: Path) -> None:
    s = NodeCacheStore(tmp_path)
    s.store("k1" * 16, _DUMMY_SPEC, {}, [], {})
    s.store("k2" * 16, _DUMMY_SPEC, {}, [], {})
    assert s.stats()["count"] == 2
    n = s.clear()
    assert n == 2
    assert s.stats()["count"] == 0
