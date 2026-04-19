"""Month Historian Agent：将约4周的周总结合成为月志章节。"""
from __future__ import annotations

from pathlib import Path

from pydantic_ai import Agent

from tools.chronicle_sim_v2.core.llm.pa_chat import PAChatResources, merged_settings


def build_historian_agent(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
) -> Agent:
    p = prompts_dir / "month_historian.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是月志编纂者，将周总结合成为章节。"

    agent = Agent(
        model=pa.model,
        system_prompt=system,
    )
    return agent


async def run_month_summary(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
    week_summaries: list[tuple[int, str]],
    month_num: int,
) -> str:
    """合成月志。"""
    agent = build_historian_agent(pa, prompts_dir, run_dir)
    summaries_text = "\n\n".join(
        f"第{w}周：\n{s}" for w, s in week_summaries
    )
    user_prompt = (
        f"以下是第 {month_num} 月（约4周）的周总结：\n\n{summaries_text}\n\n"
        "请将其合成为一章月志，保持事实不变，增加叙事连贯性。"
    )
    from tools.chronicle_sim_v2.core.llm.pa_run import run_agent_traced
    result = await run_agent_traced(pa, agent, user_prompt, model_settings=merged_settings(pa))
    return result.output
