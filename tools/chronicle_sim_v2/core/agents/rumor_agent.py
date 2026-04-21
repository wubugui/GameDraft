"""Rumor Agent：从 GM 的 ``spread_agents`` 概率开传，图上概率走边，变异概率随轮次与剩余 LLM 配额单峰变化。"""
from __future__ import annotations

import random
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.agent_spec import load_agent_spec, render_user
from tools.chronicle_sim_v2.core.llm.cline_runner import run_agent_cline
from tools.chronicle_sim_v2.core.sim.run_manager import load_llm_config


def _rumor_config(llm_config: dict[str, Any]) -> dict[str, Any]:
    raw = llm_config.get("rumor_sim") if isinstance(llm_config, dict) else None
    return raw if isinstance(raw, dict) else {}


def _max_llm_per_event(llm_config: dict[str, Any]) -> int:
    cfg = _rumor_config(llm_config)
    v = cfg.get("max_llm_calls_per_event", 32)
    try:
        n = int(v)
    except (TypeError, ValueError):
        n = 32
    return max(0, min(n, 256))


def _max_rounds(llm_config: dict[str, Any]) -> int:
    cfg = _rumor_config(llm_config)
    v = cfg.get("max_propagation_rounds", 12)
    try:
        n = int(v)
    except (TypeError, ValueError):
        n = 12
    return max(1, min(n, 64))


def _p_start_spread(llm_config: dict[str, Any]) -> float:
    cfg = _rumor_config(llm_config)
    try:
        p = float(cfg.get("p_each_spreader_starts", 0.55))
    except (TypeError, ValueError):
        p = 0.55
    return max(0.05, min(0.95, p))


def _p_edge_follow(llm_config: dict[str, Any]) -> float:
    cfg = _rumor_config(llm_config)
    try:
        p = float(cfg.get("p_follow_edge", 0.38))
    except (TypeError, ValueError):
        p = 0.38
    return max(0.05, min(0.95, p))


def mutation_probability(remaining_llm: int, max_llm: int, round_idx: int, max_rounds: int) -> float:
    """单峰：轮次与剩余配额都处于中段时最高；任一端趋近 0。

    ``round_idx``、``max_rounds`` 为当前传播轮（从 1 计）与上限；``remaining_llm`` 为本事件剩余可走样调用次数。

    注意：剩余比例不得取到恰为 ``1.0``（否则 ``sin(pi*b)=0``，首跳永远无法触发走样）。
    因此轮次、剩余均用 ``/(上限+1)`` 映射到 ``(0,1)`` 内。
    """
    if max_llm <= 0 or remaining_llm <= 0 or max_rounds <= 0:
        return 0.0
    import math

    # 映射到 (0,1)，避免 sin(pi*1)=0 导致「满配额时变异概率恒为 0」的死锁
    t = min(1.0, max(0.001, round_idx / float(max_rounds + 1)))
    b = min(1.0, max(0.001, remaining_llm / float(max_llm + 1)))
    return float(math.sin(math.pi * t) * math.sin(math.pi * b))


def _snippet_for_agent(rec: dict[str, Any], agent_id: str) -> str:
    witnesses = rec.get("witness_accounts") or []
    if isinstance(witnesses, list):
        for w in witnesses:
            if isinstance(w, dict) and str(w.get("agent_id", "")).strip() == agent_id:
                return str(w.get("account_text", "") or "").strip()
    tj = rec.get("truth_json") or {}
    if isinstance(tj, dict):
        return str(tj.get("note", tj.get("what_happened", "")) or "").strip()
    return ""


async def _distort_one(
    pa: AgentLLMResources,
    run_dir: Path,
    snippet: str,
    hops: int,
    event_type_id: str,
) -> str:
    if not snippet.strip():
        return snippet
    spec = load_agent_spec("rumor")
    user_text = render_user(
        spec,
        {
            "hops": str(hops),
            "event_type_id": event_type_id,
            "snippet": snippet,
        },
    )
    try:
        res = await run_agent_cline(pa, run_dir, spec, user_text=user_text)
        text = (res.text or "").strip().strip('"').strip("「」").strip()
        if text:
            return text[:220]
    except Exception:
        pass
    return snippet[:80] + "……（传闻走样）"


async def run_rumor_spread(
    pa: AgentLLMResources,
    run_dir: Path,
    records: list[dict[str, Any]],
    week: int,
) -> list[dict[str, Any]]:
    from tools.chronicle_sim_v2.core.world.seed_reader import load_active_agent_ids_with_tier
    from tools.chronicle_sim_v2.core.world.social_graph import get_neighbors

    llm_cfg = load_llm_config(run_dir)
    max_llm = _max_llm_per_event(llm_cfg)
    max_rounds = _max_rounds(llm_cfg)
    p_start = _p_start_spread(llm_cfg)
    p_edge = _p_edge_follow(llm_cfg)

    active = load_active_agent_ids_with_tier(run_dir)
    holder_ids = {aid for aid, _ in active}

    all_rumors: list[dict[str, Any]] = []

    for rec in records:
        eid = rec.get("id", rec.get("type_id", ""))
        spreaders = rec.get("spread_agents") or []
        if not isinstance(spreaders, list) or not spreaders:
            continue

        starters: list[str] = []
        for s in spreaders:
            sid = str(s).strip()
            if sid and sid in holder_ids and random.random() < p_start:
                starters.append(sid)
        if not starters:
            starters = [str(spreaders[0]).strip()] if str(spreaders[0]).strip() in holder_ids else []
        if not starters:
            continue

        used_llm = 0
        text_state: dict[str, str] = {}
        for s in starters:
            text_state[s] = _snippet_for_agent(rec, s) or _snippet_for_agent(rec, str(spreaders[0]))

        visited_hearers: set[str] = set()
        frontier = [x for x in starters if x in holder_ids]

        for rnd in range(1, max_rounds + 1):
            # 仅当前沿为空时结束；``max_llm`` 只限制走样 LLM，不阻塞纯口头传播（``max_llm==0`` 时仍应能传谣）
            if not frontier:
                break
            next_frontier: list[str] = []
            random.shuffle(frontier)

            for u in frontier:
                if u not in holder_ids:
                    continue
                base_u = text_state.get(u, "")
                neighbors = get_neighbors(run_dir, u)
                random.shuffle(neighbors)

                for vid, _strength, _etype in neighbors:
                    v = str(vid).strip()
                    if not v or v == u or v not in holder_ids:
                        continue
                    if v in visited_hearers:
                        continue
                    if random.random() > p_edge:
                        continue

                    rem = max_llm - used_llm
                    p_mut = mutation_probability(rem, max_llm, rnd, max_rounds)
                    content = base_u
                    if rem > 0 and base_u.strip() and random.random() < p_mut:
                        content = await _distort_one(pa, run_dir, base_u, rnd, str(rec.get("type_id", "")))
                        used_llm += 1

                    all_rumors.append(
                        {
                            "originating_event_id": eid,
                            "week_emerged": week,
                            "teller_id": u,
                            "hearer_id": v,
                            "content": content,
                            "distortion_level": rnd,
                            "propagation_hop": rnd,
                            "rumor_llm_used": used_llm,
                        }
                    )
                    visited_hearers.add(v)
                    text_state[v] = content
                    next_frontier.append(v)

            frontier = list(dict.fromkeys(next_frontier))

    return all_rumors
