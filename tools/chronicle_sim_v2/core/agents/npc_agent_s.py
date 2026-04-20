"""S 类 NPC Agent：每个 NPC 独立实例，完整隔离。"""
from __future__ import annotations

from pathlib import Path

from tools.chronicle_sim_v2.core.agents.tools import npc_s_tools
from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.crew_factory import make_single_agent_crew
from tools.chronicle_sim_v2.core.llm.crew_run import crew_output_text, run_crew_traced


async def run_npc_s_intent(
    pa: AgentLLMResources,
    prompts_dir: Path,
    run_dir: Path,
    agent_id: str,
    week: int,
    context_text: str,
) -> dict:
    """生成 S 类 NPC 周意图。"""
    p = prompts_dir / "npc_tier_s.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是 Tier S NPC。"
    user_prompt = f"角色id={agent_id}，本周={week}\n\n{context_text}"
    crew = make_single_agent_crew(
        pa,
        role="Tier_S_NPC",
        goal="输出本周意图 JSON。",
        backstory=system,
        tools=npc_s_tools(run_dir, agent_id),
        task_description=user_prompt,
        expected_output="含 agent_id、week、intent 等字段的 JSON。",
        max_iter=35,
    )
    out = await run_crew_traced(pa, crew, trace_user_preview=user_prompt, audit_system_hint=system[:8000])
    from tools.chronicle_sim_v2.core.llm.json_extract import parse_json_object

    data = parse_json_object(crew_output_text(out))
    data.setdefault("agent_id", agent_id)
    data.setdefault("week", week)
    return data
