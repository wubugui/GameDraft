"""NPC 是否「直接参与」某条 GM 事件：用于意图上下文，禁止全知读上周所有事件。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.world.seed_reader import read_agent


def event_directly_involves_agent(run_dir: Path, agent_id: str, ev: dict[str, Any]) -> bool:
    """若该 NPC 出现在事件的当事人/相关人/传播人/见证或 ``truth_json.actor_ids`` 中，则视为直接参与。

    ``tier_b_group`` 视为 B/C 类群体占位：任意当前 tier 为 B 或 C 的活跃 NPC 视为与该见证/当事人同列参与
    （否则仅写 ``tier_b_group`` 的事件无法进入任何具体 B/C 的上下文）。
    """
    if not agent_id or not isinstance(ev, dict):
        return False

    ids: set[str] = set()
    for key in ("actor_ids", "related_agents", "spread_agents"):
        raw = ev.get(key)
        if isinstance(raw, list):
            for x in raw:
                s = str(x).strip()
                if s:
                    ids.add(s)

    for w in ev.get("witness_accounts") or []:
        if isinstance(w, dict):
            s = str(w.get("agent_id", "")).strip()
            if s:
                ids.add(s)

    tj = ev.get("truth_json")
    if isinstance(tj, dict):
        ta = tj.get("actor_ids")
        if isinstance(ta, list):
            for x in ta:
                s = str(x).strip()
                if s:
                    ids.add(s)

    if agent_id in ids:
        return True

    if "tier_b_group" in ids:
        agent = read_agent(run_dir, agent_id) or {}
        tier = str(agent.get("current_tier", agent.get("tier", ""))).upper()
        if tier in ("B", "C"):
            return True

    return False


def filter_events_for_agent(run_dir: Path, agent_id: str, events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [e for e in events if isinstance(e, dict) and event_directly_involves_agent(run_dir, agent_id, e)]


def filter_events_for_any_agent(run_dir: Path, agent_ids: set[str], events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """去重：同一事件只出现一次（按 ``id`` 或回退到对象 id）。"""
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for e in events:
        if not isinstance(e, dict):
            continue
        if not any(event_directly_involves_agent(run_dir, aid, e) for aid in agent_ids):
            continue
        eid = str(e.get("id", "") or "").strip() or str(id(e))
        if eid in seen:
            continue
        seen.add(eid)
        out.append(e)
    return out
