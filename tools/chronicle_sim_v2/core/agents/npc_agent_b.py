"""B/C 类 NPC Agent：所有龙套共用一个 Agent，统一描述群体行为。"""
from __future__ import annotations

from pathlib import Path

from pydantic_ai import Agent

from tools.chronicle_sim_v2.core.agents.tools import npc_b_tools
from tools.chronicle_sim_v2.core.llm.pa_chat import PAChatResources, merged_settings


def build_npc_agent_b(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
) -> Agent:
    p = prompts_dir / "npc_tier_b.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是 Tier B/C 龙套群演。"

    agent = Agent(
        model=pa.model,
        system_prompt=system,
        tools=npc_b_tools(run_dir),
        model_settings=merged_settings(pa),
    )
    return agent


async def run_npc_b_intent(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
    b_npcs_text: str,
    week: int,
) -> dict:
    """生成 B/C 类 NPC 群体意图。"""
    agent = build_npc_agent_b(pa, prompts_dir, run_dir)
    user_prompt = (
        f"以下是龙套角色列表：\n{b_npcs_text}\n\n"
        f"本周={week}。请描述这些龙套角色本周的群体动向。"
    )
    from tools.chronicle_sim_v2.core.llm.pa_run import run_agent_traced
    result = await run_agent_traced(pa, agent, user_prompt, model_settings=merged_settings(pa))
    from tools.chronicle_sim_v2.core.llm.json_extract import parse_json_object
    return parse_json_object(result.output)
