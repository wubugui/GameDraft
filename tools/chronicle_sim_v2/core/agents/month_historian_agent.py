"""Month Historian Agent：将约4周的周总结合成为月志章节。"""
from __future__ import annotations

from pathlib import Path

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.crew_factory import make_single_agent_crew
from tools.chronicle_sim_v2.core.llm.crew_run import crew_output_text, run_crew_traced


async def run_month_summary(
    pa: AgentLLMResources,
    prompts_dir: Path,
    run_dir: Path,
    week_summaries: list[tuple[int, str]],
    month_num: int,
) -> str:
    """合成月志。"""
    _ = run_dir
    p = prompts_dir / "month_historian.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是月志编纂者，将周总结合成为章节。"
    summaries_text = "\n\n".join(
        f"第{w}周：\n{s}" for w, s in week_summaries
    )
    user_prompt = (
        f"以下是第 {month_num} 月（约4周）的周总结：\n\n{summaries_text}\n\n"
        "请将其合成为一章月志，保持事实不变，增加叙事连贯性。"
    )
    crew = make_single_agent_crew(
        pa,
        role="月志编纂者",
        goal="合成一章月志正文。",
        backstory=system,
        tools=[],
        task_description=user_prompt,
        expected_output="月志章节正文。",
        max_iter=20,
    )
    out = await run_crew_traced(pa, crew, trace_user_preview=user_prompt, audit_system_hint=system[:8000])
    return crew_output_text(out)
