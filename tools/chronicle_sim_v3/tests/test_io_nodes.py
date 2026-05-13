"""P2-1 io 抽屉补全节点测试。"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.engine.context import ContextStore
from tools.chronicle_sim_v3.engine.node import NodeBusinessError, NodeServices
from tools.chronicle_sim_v3.engine.registry import get_node_class, list_kinds
import tools.chronicle_sim_v3.nodes  # noqa: F401


def _cook(node_cls, ctx, inputs=None, params=None):
    inst = node_cls()
    return asyncio.run(inst.cook(ctx, inputs or {}, params or {}, NodeServices(), None))


_NEW_IO_KINDS = {
    # read.world.* 新增
    "read.world.pillars", "read.world.anchors", "read.world.agent",
    "read.world.factions", "read.world.locations", "read.world.edges",
    "read.world.bible_text",
    # read.chronicle.* 新增
    "read.chronicle.intents", "read.chronicle.intent",
    "read.chronicle.drafts", "read.chronicle.rumors",
    "read.chronicle.summary", "read.chronicle.observation",
    "read.chronicle.public_digest", "read.chronicle.beliefs",
    "read.chronicle.intent_outcome", "read.chronicle.weeks",
    "read.chronicle.month",
    # read.config.* / read.ideas.*
    "read.config.event_types", "read.config.pacing", "read.config.rumor_sim",
    "read.ideas.list", "read.ideas.body",
    # write.* 全套
    "write.world.agent", "write.world.edges",
    "write.chronicle.intent", "write.chronicle.draft",
    "write.chronicle.event", "write.chronicle.rumors",
    "write.chronicle.summary", "write.chronicle.observation",
    "write.chronicle.public_digest", "write.chronicle.belief",
    "write.chronicle.intent_outcome", "write.chronicle.month",
}


def test_all_p2_io_kinds_registered() -> None:
    registered = set(list_kinds())
    missing = _NEW_IO_KINDS - registered
    assert not missing, f"未注册：{missing}"


def _seed_world(rd: Path) -> None:
    (rd / "world").mkdir(parents=True, exist_ok=True)
    (rd / "world" / "setting.json").write_text(json.dumps({"era": "T1"}))
    (rd / "world" / "pillars.json").write_text(json.dumps([{"id": "p1"}]))
    (rd / "world" / "edges.json").write_text(json.dumps([{"a": "x", "b": "y"}]))
    a = rd / "world" / "agents"
    a.mkdir(parents=True)
    (a / "g.json").write_text(json.dumps({"id": "g", "life_status": "alive"}))


def test_read_world_agent(tmp_path: Path) -> None:
    _seed_world(tmp_path)
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("read.world.agent"), cs.read_view(),
                params={"agent_id": "g"})
    assert out.values["out"]["id"] == "g"


def test_read_world_agent_missing(tmp_path: Path) -> None:
    _seed_world(tmp_path)
    cs = ContextStore(tmp_path)
    with pytest.raises(NodeBusinessError):
        _cook(get_node_class("read.world.agent"), cs.read_view(),
              params={"agent_id": "nope"})


def test_read_world_edges(tmp_path: Path) -> None:
    _seed_world(tmp_path)
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("read.world.edges"), cs.read_view())
    assert out.values["out"] == [{"a": "x", "b": "y"}]


def test_read_world_bible_text(tmp_path: Path) -> None:
    _seed_world(tmp_path)
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("read.world.bible_text"), cs.read_view())
    assert "世界设定" in out.values["out"]
    assert "支柱" in out.values["out"]


def test_read_chronicle_summary(tmp_path: Path) -> None:
    d = tmp_path / "chronicle" / "week_001"
    d.mkdir(parents=True)
    (d / "summary.md").write_text("第1周内容", encoding="utf-8")
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("read.chronicle.summary"), cs.read_view(),
                inputs={"week": 1})
    assert out.values["out"] == "第1周内容"


def test_read_chronicle_intent_missing(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    with pytest.raises(NodeBusinessError):
        _cook(get_node_class("read.chronicle.intent"), cs.read_view(),
              inputs={"week": 1, "agent_id": "x"})


def test_read_chronicle_weeks(tmp_path: Path) -> None:
    for n in (1, 3, 5):
        (tmp_path / "chronicle" / f"week_{n:03d}").mkdir(parents=True)
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("read.chronicle.weeks"), cs.read_view())
    assert out.values["out"] == [1, 3, 5]


def test_read_ideas_list(tmp_path: Path) -> None:
    (tmp_path / "ideas").mkdir()
    (tmp_path / "ideas" / "manifest.json").write_text(
        json.dumps([{"id": "i1", "title": "A"}])
    )
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("read.ideas.list"), cs.read_view())
    assert out.values["out"][0]["id"] == "i1"


def test_read_ideas_body(tmp_path: Path) -> None:
    (tmp_path / "ideas").mkdir()
    (tmp_path / "ideas" / "i1.md").write_text("# 灵感", encoding="utf-8")
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("read.ideas.body"), cs.read_view(),
                params={"idea_id": "i1"})
    assert out.values["out"] == "# 灵感"


def test_write_world_agent_produces_mutation(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("write.world.agent"), cs.read_view(),
                inputs={"agent": {"id": "n1", "life_status": "alive"}})
    assert len(out.mutations) == 1
    m = out.mutations[0]
    assert m.op == "put_json"
    assert m.key == "world.agent:n1"
    assert out.values["key"] == "world.agent:n1"


def test_write_world_agent_commits_through_store(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("write.world.agent"), cs.read_view(),
                inputs={"agent": {"id": "n1", "life_status": "alive"}})
    cs.commit(out.mutations)
    p = tmp_path / "world" / "agents" / "n1.json"
    assert p.is_file()
    assert json.loads(p.read_text(encoding="utf-8"))["id"] == "n1"


def test_write_chronicle_summary_text(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("write.chronicle.summary"), cs.read_view(),
                inputs={"week": 3, "text": "总结正文"})
    cs.commit(out.mutations)
    p = tmp_path / "chronicle" / "week_003" / "summary.md"
    assert p.read_text(encoding="utf-8") == "总结正文"


def test_write_chronicle_belief_per_agent(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("write.chronicle.belief"), cs.read_view(),
                inputs={"week": 2, "agent_id": "g1",
                         "beliefs": [{"key": "x", "v": 0.5}]})
    cs.commit(out.mutations)
    p = tmp_path / "chronicle" / "week_002" / "beliefs" / "g1.json"
    assert json.loads(p.read_text(encoding="utf-8"))[0]["key"] == "x"


def test_write_chronicle_month_uses_param_n(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("write.chronicle.month"), cs.read_view(),
                inputs={"text": "第二月"}, params={"n": 2})
    cs.commit(out.mutations)
    p = tmp_path / "chronicle" / "month_02.md"
    assert p.read_text(encoding="utf-8") == "第二月"


def test_write_nodes_are_not_cacheable() -> None:
    for k in _NEW_IO_KINDS:
        if k.startswith("write."):
            assert get_node_class(k).spec.cacheable is False, k


def test_read_config_pacing_default(tmp_path: Path) -> None:
    """没有 pacing.yaml 时 fallback 到空 dict（仅校验不抛错）。"""
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("read.config.pacing"), cs.read_view())
    assert isinstance(out.values["out"], dict)
