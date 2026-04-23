"""P2-9 tier + chroma 节点测试。"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.engine.context import ContextStore
from tools.chronicle_sim_v3.engine.chroma_stub import InMemoryChroma
from tools.chronicle_sim_v3.engine.node import NodeBusinessError, NodeServices
from tools.chronicle_sim_v3.engine.registry import get_node_class, list_kinds
from tools.chronicle_sim_v3.llm.service import LLMService
from tools.chronicle_sim_v3.providers.service import ProviderService
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run
import tools.chronicle_sim_v3.nodes  # noqa: F401


def _llm_for(run: Path) -> LLMService:
    ps = ProviderService(run)
    return LLMService(run, ps)


def _cook(node_cls, ctx, inputs=None, params=None, services=None):
    inst = node_cls()
    services = services or NodeServices()
    return asyncio.run(inst.cook(ctx, inputs or {}, params or {}, services, None))


_NEW_KINDS = {
    "tier.apply_pending", "tier.archive", "tier.restore",
    "chroma.upsert", "chroma.search",
    "chroma.rebuild_world", "chroma.rebuild_ideas",
}


def test_all_kinds_registered() -> None:
    assert _NEW_KINDS.issubset(set(list_kinds()))


# ---------- tier ----------


def test_tier_apply_pending_changes_tier(tmp_path: Path) -> None:
    a = tmp_path / "world" / "agents"
    a.mkdir(parents=True)
    (a / "g1.json").write_text(json.dumps({"id": "g1", "tier": "C", "pending_tier": "A"}))
    (a / "g2.json").write_text(json.dumps({"id": "g2", "tier": "B"}))
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("tier.apply_pending"), cs.read_view())
    cs.commit(out.mutations)
    assert len(out.values["changes"]) == 1
    assert out.values["changes"][0] == {"agent_id": "g1", "from": "C", "to": "A"}
    g1 = json.loads((a / "g1.json").read_text())
    assert g1["tier"] == "A"
    assert "pending_tier" not in g1


def test_tier_archive_marks_archived(tmp_path: Path) -> None:
    a = tmp_path / "world" / "agents"
    a.mkdir(parents=True)
    (a / "g1.json").write_text(json.dumps({"id": "g1", "tier": "S"}))
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("tier.archive"), cs.read_view(),
                 inputs={"agent_id": "g1"})
    cs.commit(out.mutations)
    g1 = json.loads((a / "g1.json").read_text())
    assert g1.get("archived") is True


def test_tier_restore_clears_archived(tmp_path: Path) -> None:
    a = tmp_path / "world" / "agents"
    a.mkdir(parents=True)
    (a / "g1.json").write_text(json.dumps({"id": "g1", "archived": True, "tier": "S"}))
    cs = ContextStore(tmp_path)
    out = _cook(get_node_class("tier.restore"), cs.read_view(),
                 inputs={"agent_id": "g1"})
    cs.commit(out.mutations)
    g1 = json.loads((a / "g1.json").read_text())
    assert "archived" not in g1


# ---------- chroma ----------


@pytest.mark.asyncio
async def test_chroma_upsert_then_search(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    svc = _llm_for(run)
    chroma = InMemoryChroma()
    services = NodeServices(_llm=svc, chroma=chroma)
    cs = ContextStore(run)

    inst = get_node_class("chroma.upsert")()
    n = await inst.cook(
        cs.read_view(),
        {"docs": [
            {"id": "d1", "text": "苹果 红色 水果", "metadata": {"k": "fruit"}},
            {"id": "d2", "text": "猫 动物 宠物", "metadata": {"k": "animal"}},
        ]},
        {"collection": "test"},
        services, None,
    )
    assert n.values["count"] == 2
    assert chroma.count("test") == 2

    inst2 = get_node_class("chroma.search")()
    out = await inst2.cook(
        cs.read_view(),
        {"query": "苹果"},
        {"collection": "test", "n_results": 2},
        services, None,
    )
    ids = [r["id"] for r in out.values["out"]]
    assert "d1" in ids
    await svc.aclose()


def test_chroma_requires_services(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("chroma.upsert")
    with pytest.raises(NodeBusinessError, match="chroma"):
        _cook(cls, cs.read_view(),
              inputs={"docs": []}, params={"collection": "x"},
              services=NodeServices(chroma=None))


@pytest.mark.asyncio
async def test_chroma_rebuild_world(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    a = run / "world" / "agents"
    a.mkdir(parents=True)
    (a / "g.json").write_text(json.dumps({"id": "g", "name": "甲"}))
    svc = _llm_for(run)
    chroma = InMemoryChroma()
    services = NodeServices(_llm=svc, chroma=chroma)
    cs = ContextStore(run)
    inst = get_node_class("chroma.rebuild_world")()
    out = await inst.cook(cs.read_view(), {}, {}, services, None)
    assert out.values["count"] == 1
    assert chroma.count("world") == 1
    await svc.aclose()
