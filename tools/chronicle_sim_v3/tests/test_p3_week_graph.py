"""P3-4 week.yaml + range.yaml 端到端（stub LLM 路径）。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.agents.service import AgentService
from tools.chronicle_sim_v3.engine.engine import Engine
from tools.chronicle_sim_v3.engine.graph import GraphLoader
from tools.chronicle_sim_v3.llm.service import LLMService
from tools.chronicle_sim_v3.providers.service import ProviderService
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run
import tools.chronicle_sim_v3.nodes  # noqa: F401


def _wire_engine(eng: Engine, run: Path) -> None:
    ps = ProviderService(run)
    llm = LLMService(run, ps, spec_search_root=run)
    agents = AgentService(
        run, ps, llm_service=llm,
        chroma=eng.services.chroma, spec_search_root=run,
    )
    eng.services.spec_search_root = run
    eng.services._llm = llm
    eng.services.agents = agents


async def _close_engine(eng: Engine) -> None:
    if eng.services.agents:
        await eng.services.agents.aclose()
    if eng.services._llm:
        await eng.services._llm.aclose()


_GRAPHS = Path(__file__).resolve().parents[1] / "data" / "graphs"


def _seed_full_world(rd: Path) -> None:
    (rd / "world").mkdir(parents=True, exist_ok=True)
    (rd / "world" / "setting.json").write_text(json.dumps({
        "era": "民国", "region": "川渝", "tone": "市井",
    }))
    (rd / "world" / "pillars.json").write_text(json.dumps([
        {"id": "p1", "name": "码头江湖"},
    ]))
    (rd / "world" / "edges.json").write_text(json.dumps([
        {"a": "npc_a", "b": "npc_b", "w": 1.0},
    ]))
    a = rd / "world" / "agents"
    a.mkdir(parents=True)
    (a / "npc_a.json").write_text(json.dumps({"id": "npc_a", "tier": "S", "life_status": "alive"}))
    (a / "npc_b.json").write_text(json.dumps({"id": "npc_b", "tier": "A", "life_status": "alive"}))
    (a / "npc_c.json").write_text(json.dumps({"id": "npc_c", "tier": "B", "life_status": "alive"}))
    (a / "npc_d.json").write_text(json.dumps({"id": "npc_d", "tier": "S", "life_status": "dead"}))


def test_week_yaml_validates() -> None:
    spec = GraphLoader().load(_GRAPHS / "week.yaml")
    errs = GraphLoader().validate(spec)
    assert errs == [], errs


def test_range_yaml_validates() -> None:
    spec = GraphLoader().load(_GRAPHS / "range.yaml")
    errs = GraphLoader().validate(spec)
    assert errs == [], errs


@pytest.mark.asyncio
async def test_week_yaml_e2e_stub(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    _seed_full_world(run)
    spec = GraphLoader().load(_GRAPHS / "week.yaml")
    eng = Engine(run)
    _wire_engine(eng, run)
    res = await eng.run(spec, inputs={"week": 1}, cook_id="w1")
    assert res.status == "completed", f"failed_nodes={res.failed_nodes}"
    # 关键产出
    assert res.outputs["intents_count"] == 2  # 1 S + 1 A alive
    assert isinstance(res.outputs["summary"], str)
    assert res.outputs["summary"]
    # 周末 summary 已落盘
    p = run / "chronicle" / "week_001" / "summary.md"
    assert p.is_file()
    await _close_engine(eng)


@pytest.mark.asyncio
async def test_week_yaml_cache_replay(tmp_path: Path) -> None:
    """二次跑 week.yaml 大部分确定性节点应命中缓存。"""
    run = make_stub_run(tmp_path)
    _seed_full_world(run)
    spec = GraphLoader().load(_GRAPHS / "week.yaml")
    eng = Engine(run)
    _wire_engine(eng, run)
    await eng.run(spec, inputs={"week": 1}, cook_id="w1")
    eng2 = Engine(run)
    _wire_engine(eng2, run)
    await eng2.run(spec, inputs={"week": 1}, cook_id="w2")
    # 至少 agents / alive / by_tier / event_types / pacing 这些纯算法节点命中
    hit_files = list((run / "cooks" / "w2").rglob("cache_hit.txt"))
    hit_nodes = {p.parent.name for p in hit_files}
    assert "agents" in hit_nodes
    assert "alive" in hit_nodes
    assert "by_tier" in hit_nodes
    await _close_engine(eng)
    await _close_engine(eng2)
