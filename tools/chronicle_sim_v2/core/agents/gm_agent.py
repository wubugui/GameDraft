"""GM Agent：仲裁事件草稿为最终事件记录（Cline CLI）。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.agent_spec import load_agent_spec, render_user
from tools.chronicle_sim_v2.core.llm.cline_runner import run_agent_cline


async def run_gm_arbitrate(
    pa: AgentLLMResources,
    run_dir: Path,
    drafts: list[dict[str, Any]],
    world_context: str,
    week: int,
) -> list[dict[str, Any]]:
    spec = load_agent_spec("gm")
    user_text = render_user(
        spec,
        {
            "week": str(week),
            "world_context": world_context,
            "drafts_json": json.dumps(drafts, ensure_ascii=False),
        },
    )
    res = await run_agent_cline(pa, run_dir, spec, user_text=user_text)

    from tools.chronicle_sim_v2.core.llm.json_extract import parse_json_array, parse_json_object

    try:
        parsed = parse_json_array(res.text)
    except Exception:
        obj = parse_json_object(res.text)
        if isinstance(obj, dict) and "records" in obj:
            parsed = obj["records"]
        else:
            parsed = [obj]
    return parsed if isinstance(parsed, list) else [parsed]
