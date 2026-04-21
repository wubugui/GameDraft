"""谣言：变异概率、事件规整、传播（stub 不走真实 Cline）。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.chronicle_sim_v2.core.agents.event_normalize import normalize_event_for_rumors
from tools.chronicle_sim_v2.core.agents.rumor_agent import mutation_probability
from tools.chronicle_sim_v2.core.world.fs import write_json


def test_mutation_probability_ends_lower_than_middle() -> None:
    max_llm, max_r = 20, 10
    mid_r = max_r // 2
    p_low_r = mutation_probability(max_llm, max_llm, 1, max_r)
    p_mid_r = mutation_probability(max_llm, max_llm, mid_r, max_r)
    p_high_r = mutation_probability(max_llm, max_llm, max_r, max_r)
    assert p_mid_r >= p_low_r
    assert p_mid_r >= p_high_r

    p_low_b = mutation_probability(1, max_llm, mid_r, max_r)
    p_mid_b = mutation_probability(max_llm // 2, max_llm, mid_r, max_r)
    p_high_b = mutation_probability(max_llm, max_llm, mid_r, max_r)
    assert p_mid_b >= p_low_b
    assert p_mid_b >= p_high_b


def test_normalize_spread_subset_related(tmp_path: Path) -> None:
    for aid in ("a1", "a2", "x9"):
        write_json(
            tmp_path,
            f"world/agents/{aid}.json",
            {"id": aid, "name": aid, "current_tier": "B", "life_status": "alive"},
        )
    rec = {
        "witness_accounts": [
            {"agent_id": "a1", "account_text": "口供1", "supernatural_hint": ""},
            {"agent_id": "a2", "account_text": "口供2", "supernatural_hint": ""},
        ],
        "actor_ids": ["a1"],
        "spread_agents": ["a1", "x9"],
    }
    normalize_event_for_rumors(tmp_path, rec)
    assert "a1" in rec["related_agents"] and "a2" in rec["related_agents"]
    assert rec["spread_agents"] == ["a1"]


def test_run_rumor_spread_stub_minimal(tmp_path: Path) -> None:
    import asyncio

    (tmp_path / "config").mkdir(parents=True, exist_ok=True)
    (tmp_path / "config" / "llm_config.json").write_text(
        json.dumps(
            {
                "default": {"kind": "stub"},
                "rumor_sim": {
                    "p_follow_edge": 1.0,
                    "p_each_spreader_starts": 1.0,
                    "max_llm_calls_per_event": 8,
                    "max_propagation_rounds": 6,
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    from tools.chronicle_sim_v2.core.agents.rumor_agent import run_rumor_spread
    from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
    from tools.chronicle_sim_v2.core.llm.provider_profile import ProviderProfile
    from tools.chronicle_sim_v2.core.llm.stub_llm import build_chronicle_stub_llm

    for aid in ("s1", "b1", "b2"):
        write_json(
            tmp_path,
            f"world/agents/{aid}.json",
            {"id": aid, "name": aid, "current_tier": "S" if aid == "s1" else "B", "life_status": "alive"},
        )
    write_json(
        tmp_path,
        "world/relationships/graph.json",
        [
            {"from_agent_id": "s1", "to_agent_id": "b1", "strength": 0.9, "edge_type": "x"},
            {"from_agent_id": "b1", "to_agent_id": "b2", "strength": 0.8, "edge_type": "x"},
        ],
    )
    rec = {
        "id": "evt1",
        "type_id": "t",
        "witness_accounts": [{"agent_id": "s1", "account_text": "源头说法", "supernatural_hint": ""}],
        "actor_ids": ["s1"],
        "related_agents": ["s1"],
        "spread_agents": ["s1"],
    }
    normalize_event_for_rumors(tmp_path, rec)

    pa = AgentLLMResources(
        agent_id="rumor",
        profile=ProviderProfile(kind="stub"),
        llm=build_chronicle_stub_llm(),
        default_extra={},
        audit_run_dir=None,
    )

    async def _go():
        return await run_rumor_spread(pa, tmp_path, [rec], week=1)

    rumors = asyncio.run(_go())
    assert isinstance(rumors, list)
