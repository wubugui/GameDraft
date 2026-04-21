"""S 类 NPC Agent（Cline CLI，TOML spec）。"""
from __future__ import annotations

from pathlib import Path

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.agent_spec import load_agent_spec, render_user
from tools.chronicle_sim_v2.core.llm.cline_runner import run_agent_cline


async def run_npc_s_intent(
    pa: AgentLLMResources,
    run_dir: Path,
    agent_id: str,
    week: int,
    context_text: str,
) -> dict:
    spec = load_agent_spec("tier_s_npc")
    user_text = render_user(
        spec,
        {
            "agent_id": agent_id,
            "week": str(week),
            "context_text": context_text,
        },
    )
    res = await run_agent_cline(pa, run_dir, spec, user_text=user_text)

    from tools.chronicle_sim_v2.core.llm.json_extract import parse_json_object

    data = parse_json_object(res.text)
    data.setdefault("agent_id", agent_id)
    data.setdefault("week", week)
    return data
