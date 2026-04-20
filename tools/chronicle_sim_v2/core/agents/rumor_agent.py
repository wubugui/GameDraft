"""Rumor Agent：通过社交图传播谣言，使用 LLM 改写失真内容。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.crew_factory import make_single_agent_crew
from tools.chronicle_sim_v2.core.llm.crew_run import crew_output_text, run_crew_traced


async def _distort_snippet(
    pa: AgentLLMResources,
    prompts_dir: Path,
    snippet: str,
    hops: int,
    event_type_id: str,
) -> str:
    """用 LLM 改写失真谣言。"""
    if not snippet.strip():
        return snippet
    p = prompts_dir / "rumor_agent.md"
    rules = p.read_text(encoding="utf-8") if p.is_file() else ""
    user = (
        f"【传闻改写任务】传播跳数={hops}，事件类型={event_type_id}\n"
        f"原句：{snippet}\n"
        "改写成一条简短中文街头传闻（不超过90字）：允许省略、添油加醋、细节对不上号；"
        "保留一点可追查的线索；禁止全知叙事与「我亲眼」式口吻。\n"
        "只输出改写后的那一句话，不要引号或解释。"
    )
    backstory = rules[:3000] if rules else "你是流言转述者。"
    try:
        crew = make_single_agent_crew(
            pa,
            role="流言转述者",
            goal="只输出一句改写后的传闻。",
            backstory=backstory,
            tools=[],
            task_description=user,
            expected_output="一句中文传闻。",
            max_iter=8,
            llm_overrides={"temperature": 0.85},
        )
        out = await run_crew_traced(pa, crew, trace_user_preview=user, audit_system_hint=backstory[:3000])
        text = (crew_output_text(out) or "").strip().strip('"').strip("「」").strip()
        if text:
            return text[:220]
    except Exception:
        pass
    return snippet[:80] + "……（传闻走样）"


async def run_rumor_spread(
    pa: AgentLLMResources,
    prompts_dir: Path,
    run_dir: Path,
    records: list[dict[str, Any]],
    week: int,
) -> list[dict[str, Any]]:
    """传播谣言：对每个事件的每个目击者，向社交图邻居传播失真版本。"""
    from tools.chronicle_sim_v2.core.world.social_graph import propagation_targets
    from tools.chronicle_sim_v2.core.world.seed_reader import load_active_agent_ids_with_tier

    active = load_active_agent_ids_with_tier(run_dir)
    holder_ids = {aid for aid, _ in active}

    all_rumors = []
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
                    twisted = await _distort_snippet(pa, prompts_dir, snippet, hops, event_type)
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
