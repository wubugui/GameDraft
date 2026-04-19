"""Week Summarizer Agent：将本周事件总结为叙事文本。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic_ai import Agent

from tools.chronicle_sim_v2.core.agents.tools import summarizer_tools
from tools.chronicle_sim_v2.core.llm.pa_chat import PAChatResources, merged_settings


def build_summarizer_agent(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
) -> Agent:
    p = prompts_dir / "week_summarizer.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是周总结撰写者。"

    agent = Agent(
        model=pa.model,
        system_prompt=system,
        tools=summarizer_tools(run_dir),
        model_settings=merged_settings(pa),
    )
    return agent


async def run_week_summary(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
    events: list[dict[str, Any]],
    intents: list[dict[str, Any]],
    week: int,
) -> str:
    """撰写周总结。"""
    agent = build_summarizer_agent(pa, prompts_dir, run_dir)
    data = {
        "events": events,
        "intents": intents,
        "week": week,
    }
    import json
    user_prompt = f"以下是第 {week} 周的事件数据：\n{json.dumps(data, ensure_ascii=False)}\n\n请撰写一段3-8段的叙事总结。"
    from tools.chronicle_sim_v2.core.llm.pa_run import run_agent_traced
    result = await run_agent_traced(pa, agent, user_prompt, model_settings=merged_settings(pa))
    return result.output
