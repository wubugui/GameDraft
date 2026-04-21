"""Week Summarizer Agent：将本周事件总结为叙事文本（Cline CLI）。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.agent_spec import load_agent_spec, render_user
from tools.chronicle_sim_v2.core.llm.cline_runner import run_agent_cline


async def run_week_summary(
    pa: AgentLLMResources,
    run_dir: Path,
    events: list[dict[str, Any]],
    intents: list[dict[str, Any]],
    week: int,
) -> str:
    spec = load_agent_spec("week_summarizer")
    data = {"events": events, "intents": intents, "week": week}
    user_text = render_user(
        spec,
        {
            "week": str(week),
            "data_json": json.dumps(data, ensure_ascii=False),
        },
    )
    res = await run_agent_cline(pa, run_dir, spec, user_text=user_text)
    return res.text
