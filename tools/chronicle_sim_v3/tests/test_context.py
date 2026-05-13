"""ContextStore：read view + commit + slice hash 失效。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.engine.context import (
    ContextError,
    ContextStore,
    Mutation,
)
from tools.chronicle_sim_v3.engine.errors import ValidationError


def _seed(run_dir: Path) -> None:
    """造一个最小 Run 数据 fixture。"""
    (run_dir / "world").mkdir(parents=True, exist_ok=True)
    (run_dir / "world" / "setting.json").write_text(
        json.dumps({"era": "T1", "place": "City"}), encoding="utf-8"
    )
    (run_dir / "world" / "edges.json").write_text(
        json.dumps([{"a": "x", "b": "y", "w": 1}]), encoding="utf-8"
    )
    a_dir = run_dir / "world" / "agents"
    a_dir.mkdir(parents=True, exist_ok=True)
    (a_dir / "npc_guan.json").write_text(
        json.dumps({"id": "npc_guan", "life_status": "alive"}), encoding="utf-8"
    )
    (a_dir / "npc_liu.json").write_text(
        json.dumps({"id": "npc_liu", "life_status": "alive"}), encoding="utf-8"
    )
    ce = run_dir / "chronicle" / "week_003" / "events"
    ce.mkdir(parents=True, exist_ok=True)
    (ce / "e1.json").write_text(json.dumps({"id": "e1"}), encoding="utf-8")


def test_read_view_world_setting(tmp_path: Path) -> None:
    _seed(tmp_path)
    cs = ContextStore(tmp_path, run_id="run1")
    rv = cs.read_view(week=3)
    assert rv.world_setting()["era"] == "T1"


def test_read_view_world_agents_listing(tmp_path: Path) -> None:
    _seed(tmp_path)
    rv = ContextStore(tmp_path).read_view()
    agents = rv.world_agents()
    ids = sorted(a["id"] for a in agents)
    assert ids == ["npc_guan", "npc_liu"]


def test_read_view_world_agent_single(tmp_path: Path) -> None:
    _seed(tmp_path)
    rv = ContextStore(tmp_path).read_view()
    a = rv.world_agent("npc_guan")
    assert a is not None and a["life_status"] == "alive"
    assert rv.world_agent("missing") is None


def test_read_view_chronicle_events(tmp_path: Path) -> None:
    _seed(tmp_path)
    rv = ContextStore(tmp_path).read_view(week=3)
    events = rv.chronicle_events(3)
    assert [e["id"] for e in events] == ["e1"]


def test_read_view_returns_empty_for_absent(tmp_path: Path) -> None:
    rv = ContextStore(tmp_path).read_view()
    assert rv.world_setting() == {}
    assert rv.world_agents() == []
    assert rv.chronicle_events(99) == []
    assert rv.chronicle_summary(1) == ""
    assert rv.world_agent("nope") is None


def test_slice_hash_stable(tmp_path: Path) -> None:
    _seed(tmp_path)
    cs = ContextStore(tmp_path)
    h1 = cs.slice_hash("world.setting")
    h2 = cs.slice_hash("world.setting")
    assert h1 == h2


def test_slice_hash_changes_on_content(tmp_path: Path) -> None:
    _seed(tmp_path)
    cs = ContextStore(tmp_path)
    h1 = cs.slice_hash("world.setting")
    (tmp_path / "world" / "setting.json").write_text(
        json.dumps({"era": "T2"}), encoding="utf-8"
    )
    # 直接改盘但没失效缓存 → 仍命中旧 hash（这是设计）
    assert cs.slice_hash("world.setting") == h1
    # commit 一个 mutation 失效缓存
    cs.commit([Mutation(op="put_json", key="world.setting", payload={"era": "T3"})])
    h2 = cs.slice_hash("world.setting")
    assert h2 != h1


def test_slice_hash_combined_order_independent(tmp_path: Path) -> None:
    _seed(tmp_path)
    cs = ContextStore(tmp_path)
    a = cs.slice_hash_combined(["world.setting", "world.edges"])
    b = cs.slice_hash_combined(["world.edges", "world.setting"])
    assert a == b


def test_commit_put_json_writes_file(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cs.commit([Mutation(op="put_json", key="world.setting", payload={"era": "X"})])
    p = tmp_path / "world" / "setting.json"
    assert p.is_file()
    assert json.loads(p.read_text(encoding="utf-8"))["era"] == "X"


def test_commit_put_text_writes_md(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cs.commit([Mutation(op="put_text", key="chronicle.summary:week=1",
                         payload="第一周总结")])
    p = tmp_path / "chronicle" / "week_001" / "summary.md"
    assert p.read_text(encoding="utf-8") == "第一周总结"


def test_commit_put_json_listing_key_invalidates(tmp_path: Path) -> None:
    """新增一个 agent → world.agents 列表 hash 应变化。"""
    _seed(tmp_path)
    cs = ContextStore(tmp_path)
    h1 = cs.slice_hash("world.agents")
    cs.commit([Mutation(op="put_json", key="world.agent:npc_new",
                         payload={"id": "npc_new"})])
    # 列表型 hash 应失效 — 但要注意我们的实现：失效 base 同前缀的 listing
    # 所以重新读
    new = cs.read_view().world_agents()
    assert len(new) == 3
    h2 = cs.slice_hash("world.agents")
    assert h1 != h2


def test_commit_delete(tmp_path: Path) -> None:
    _seed(tmp_path)
    cs = ContextStore(tmp_path)
    cs.commit([Mutation(op="delete", key="world.agent:npc_guan")])
    p = tmp_path / "world" / "agents" / "npc_guan.json"
    assert not p.exists()


def test_commit_rename(tmp_path: Path) -> None:
    _seed(tmp_path)
    cs = ContextStore(tmp_path)
    cs.commit([Mutation(op="rename", key="world.agent:npc_guan",
                         new_key="world.agent:guan_v2")])
    assert (tmp_path / "world" / "agents" / "guan_v2.json").is_file()
    assert not (tmp_path / "world" / "agents" / "npc_guan.json").exists()


def test_commit_atomic_no_partial(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """中途失败不留 .tmp_ 文件。"""
    cs = ContextStore(tmp_path)
    import os

    real_replace = os.replace
    calls = {"n": 0}

    def boom(src, dst):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated")
        return real_replace(src, dst)

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(RuntimeError):
        cs.commit([Mutation(op="put_json", key="world.setting", payload={"a": 1})])
    leftovers = list((tmp_path / "world").glob(".tmp_*"))
    assert leftovers == []


def test_mutation_validation() -> None:
    with pytest.raises(ValidationError):
        Mutation(op="rename", key="world.setting")  # 缺 new_key
    with pytest.raises(ValidationError):
        Mutation(op="put_json", key="world.setting")  # 缺 payload


def test_value_cache_hit(tmp_path: Path) -> None:
    """同一 store 读两次同 key 不重读盘。"""
    _seed(tmp_path)
    cs = ContextStore(tmp_path)
    rv = cs.read_view()
    a = rv.world_setting()
    # 直接改盘
    (tmp_path / "world" / "setting.json").write_text(
        json.dumps({"era": "CHANGED"}), encoding="utf-8"
    )
    # 仍是旧值
    assert rv.world_setting() == a


def test_read_view_chronicle_weeks_list(tmp_path: Path) -> None:
    for n in (2, 4, 6):
        (tmp_path / "chronicle" / f"week_{n:03d}").mkdir(parents=True)
    rv = ContextStore(tmp_path).read_view()
    assert rv.chronicle_weeks_list() == [2, 4, 6]


def test_config_llm_loaded_as_yaml(tmp_path: Path) -> None:
    cfg = tmp_path / "config"
    cfg.mkdir()
    (cfg / "llm.yaml").write_text("schema: v3\nrouter: smart\n", encoding="utf-8")
    rv = ContextStore(tmp_path).read_view()
    cfg_data = rv.config_llm()
    assert cfg_data.get("router") == "smart"
