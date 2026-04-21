"""Month Historian Agent：将约4周的周总结合成为月志章节（Cline CLI）。"""
from __future__ import annotations

from pathlib import Path

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.agent_spec import load_agent_spec, render_user
from tools.chronicle_sim_v2.core.llm.cline_runner import run_agent_cline


async def run_month_summary(
    pa: AgentLLMResources,
    run_dir: Path,
    week_summaries: list[tuple[int, str]],
    month_num: int,
) -> str:
    spec = load_agent_spec("month_historian")
    summaries_text = "\n\n".join(f"第{w}周：\n{s}" for w, s in week_summaries)
    user_text = render_user(
        spec,
        {
            "month_num": str(month_num),
            "summaries_text": summaries_text,
        },
    )
    res = await run_agent_cline(pa, run_dir, spec, user_text=user_text)
    return res.text
