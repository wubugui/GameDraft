"""A 类 NPC Agent：所有 A 类共享一个 model，但每个 NPC 独立 .run()，不共享对话上下文。"""
from __future__ import annotations

from pathlib import Path

from pydantic_ai import Agent

from tools.chronicle_sim_v2.core.agents.tools import npc_a_tools
from tools.chronicle_sim_v2.core.llm.pa_chat import PAChatResources, merged_settings


def build_npc_agent_a(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
) -> Agent:
    """创建一个 A 类 Agent 实例（model 可复用）。"""
    p = prompts_dir / "npc_tier_a.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是 Tier A NPC。"

    agent = Agent(
        model=pa.model,
        system_prompt=system,
        tools=npc_a_tools(run_dir),
        model_settings=merged_settings(pa),
    )
    return agent


async def run_npc_a_intent(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
    agent_id: str,
    week: int,
    context_text: str,
) -> dict:
    """生成 A 类 NPC 周意图。每次独立 .run()，上下文从零开始。"""
    agent = build_npc_agent_a(pa, prompts_dir, run_dir)
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
