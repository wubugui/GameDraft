"""Rumor Agent：通过社交图传播谣言，使用 Cline 改写失真内容。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.agent_spec import load_agent_spec, render_user
from tools.chronicle_sim_v2.core.llm.cline_runner import run_agent_cline


async def _distort_snippet(
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
    from tools.chronicle_sim_v2.core.world.social_graph import propagation_targets

    active = load_active_agent_ids_with_tier(run_dir)
    holder_ids = {aid for aid, _ in active}

    all_rumors: list[dict[str, Any]] = []
    for rec in records:
        eid = rec.get("id", rec.get("type_id", ""))
        witnesses = rec.get("witness_accounts") or []
        seeds = [w.get("agent_id", "") for w in witnesses]

        for start in seeds:
            if not start:
                continue
            targets = propagation_targets(run_dir, start, depth=2, holder_ids=holder_ids)

            snippet = ""
            for w in witnesses:
                if w.get("agent_id") == start:
                    snippet = w.get("account_text", "")
                    break
            if not snippet and witnesses:
                snippet = witnesses[0].get("account_text", "")
            if not snippet:
                snippet = str(rec.get("truth_json", {}).get("note", ""))

            event_type = rec.get("type_id", "")

            for target_id, hops in targets:
                if target_id == start or target_id not in holder_ids:
                    continue
                distortion = min(3, hops)
                if distortion > 1 and snippet:
                    twisted = await _distort_snippet(pa, run_dir, snippet, hops, event_type)
                else:
                    twisted = snippet

                all_rumors.append({
                    "originating_event_id": eid,
                    "week_emerged": week,
                    "teller_id": start,
                    "hearer_id": target_id,
                    "content": twisted,
                    "distortion_level": distortion,
                    "propagation_hop": hops,
                })

    return all_rumors
