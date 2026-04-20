"""B/C 类 NPC Agent：所有龙套共用一个 Agent，统一描述群体行为。"""
from __future__ import annotations

from pathlib import Path

from tools.chronicle_sim_v2.core.agents.tools import npc_b_tools
from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.crew_factory import make_single_agent_crew
from tools.chronicle_sim_v2.core.llm.crew_run import crew_output_text, run_crew_traced


async def run_npc_b_intent(
    pa: AgentLLMResources,
    prompts_dir: Path,
    run_dir: Path,
    b_npcs_text: str,
    week: int,
) -> dict:
    """生成 B/C 类 NPC 群体意图。"""
    p = prompts_dir / "npc_tier_b.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是 Tier B/C 龙套群演。"
    user_prompt = (
        f"以下是龙套角色列表：\n{b_npcs_text}\n\n"
        f"本周={week}。请描述这些龙套角色本周的群体动向。"
    )
    crew = make_single_agent_crew(
        pa,
        role="Tier_B_C_NPC",
        goal="输出本周群体意图 JSON。",
        backstory=system,
        tools=npc_b_tools(run_dir),
        task_description=user_prompt,
        expected_output="JSON 对象。",
        max_iter=30,
    )
    out = await run_crew_traced(pa, crew, trace_user_preview=user_prompt, audit_system_hint=system[:8000])
    from tools.chronicle_sim_v2.core.llm.json_extract import parse_json_object

    return parse_json_object(crew_output_text(out))
