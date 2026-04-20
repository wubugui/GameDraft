"""Week Summarizer Agent：将本周事件总结为叙事文本。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.agents.tools import summarizer_tools
from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.crew_factory import make_single_agent_crew
from tools.chronicle_sim_v2.core.llm.crew_run import crew_output_text, run_crew_traced


async def run_week_summary(
    pa: AgentLLMResources,
    prompts_dir: Path,
    run_dir: Path,
    events: list[dict[str, Any]],
    intents: list[dict[str, Any]],
    week: int,
) -> str:
    """撰写周总结。"""
    p = prompts_dir / "week_summarizer.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是周总结撰写者。"
    data = {
        "events": events,
        "intents": intents,
        "week": week,
    }
    user_prompt = f"以下是第 {week} 周的事件数据：\n{json.dumps(data, ensure_ascii=False)}\n\n请撰写一段3-8段的叙事总结。"
    crew = make_single_agent_crew(
        pa,
        role="周总结撰写者",
        goal="撰写叙事周总结。",
        backstory=system,
        tools=summarizer_tools(run_dir),
        task_description=user_prompt,
        expected_output="3-8 段叙事中文文本。",
        max_iter=30,
    )
    out = await run_crew_traced(pa, crew, trace_user_preview=user_prompt, audit_system_hint=system[:8000])
    return crew_output_text(out)
