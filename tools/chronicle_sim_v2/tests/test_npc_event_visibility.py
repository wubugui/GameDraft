"""npc_event_visibility：NPC 只能看到亲身参与的事件。"""
from __future__ import annotations

from tools.chronicle_sim_v2.core.sim.npc_event_visibility import (
    event_directly_involves_agent,
    filter_events_for_agent,
    filter_events_for_any_agent,
)
from tools.chronicle_sim_v2.core.world.fs import write_json


def test_actor_ids_involved(tmp_path) -> None:
    ev = {"id": "e1", "actor_ids": ["npc_a_01", "npc_s_02"]}
    assert event_directly_involves_agent(tmp_path, "npc_a_01", ev) is True
    assert event_directly_involves_agent(tmp_path, "npc_b_01", ev) is False


def test_witness_accounts_involved(tmp_path) -> None:
    ev = {
        "id": "e2",
        "witness_accounts": [{"agent_id": "npc_a_03", "account_text": "x", "supernatural_hint": ""}],
    }
    assert event_directly_involves_agent(tmp_path, "npc_a_03", ev) is True


def test_tier_b_group_matches_bc_agent(tmp_path) -> None:
    write_json(
        tmp_path,
        "world/agents/npc_b_01.json",
        {"id": "npc_b_01", "name": "b1", "current_tier": "B", "life_status": "alive"},
    )
    ev = {
        "id": "e3",
        "witness_accounts": [{"agent_id": "tier_b_group", "account_text": "脚帮所见", "supernatural_hint": ""}],
    }
    assert event_directly_involves_agent(tmp_path, "npc_b_01", ev) is True
    write_json(
        tmp_path,
        "world/agents/npc_a_01.json",
        {"id": "npc_a_01", "name": "a1", "current_tier": "A", "life_status": "alive"},
    )
    assert event_directly_involves_agent(tmp_path, "npc_a_01", ev) is False


def test_filter_events_for_any_agent_dedup(tmp_path) -> None:
    ev_same = {"id": "dup", "actor_ids": ["npc_b_01"]}
    write_json(
        tmp_path,
        "world/agents/npc_b_01.json",
        {"id": "npc_b_01", "current_tier": "B", "life_status": "alive"},
    )
    write_json(
        tmp_path,
        "world/agents/npc_b_02.json",
        {"id": "npc_b_02", "current_tier": "B", "life_status": "alive"},
    )
    out = filter_events_for_any_agent(tmp_path, {"npc_b_01", "npc_b_02"}, [ev_same, ev_same])
    assert len(out) == 1


def test_filter_events_for_agent(tmp_path) -> None:
    e1 = {"id": "a", "actor_ids": ["npc_x"]}
    e2 = {"id": "b", "actor_ids": ["npc_y"]}
    assert filter_events_for_agent(tmp_path, "npc_x", [e1, e2]) == [e1]
