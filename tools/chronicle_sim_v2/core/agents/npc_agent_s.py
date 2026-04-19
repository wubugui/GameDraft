"""S 类 NPC Agent：每个 NPC 独立实例，完整隔离。"""
from __future__ import annotations

from pathlib import Path

from pydantic_ai import Agent

from tools.chronicle_sim_v2.core.agents.tools import npc_s_tools
from tools.chronicle_sim_v2.core.llm.pa_chat import PAChatResources, merged_settings


def build_npc_agent_s(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
    agent_id: str,
    week: int,
) -> Agent:
    p = prompts_dir / "npc_tier_s.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是 Tier S NPC。"

    agent = Agent(
        model=pa.model,
        system_prompt=system,
        tools=npc_s_tools(run_dir, agent_id),
        model_settings=merged_settings(pa),
    )
    return agent


async def run_npc_s_intent(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
    agent_id: str,
    week: int,
    context_text: str,
) -> dict:
    """生成 S 类 NPC 周意图。"""
    agent = build_npc_agent_s(pa, prompts_dir, run_dir, agent_id, week)
    user_prompt = (
        f"角色id={agent_id}，本周={week}\n\n{context_text}"
    )
    from tools.chronicle_sim_v2.core.llm.pa_run import run_agent_traced
    result = await run_agent_traced(pa, agent, user_prompt, model_settings=merged_settings(pa))
    from tools.chronicle_sim_v2.core.llm.json_extract import parse_json_object
    data = parse_json_object(result.output)
    data.setdefault("agent_id", agent_id)
    data.setdefault("week", week)
    return data
