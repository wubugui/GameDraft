"""Director Agent：从 NPC 意图生成事件草稿（Cline CLI）。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.agent_spec import load_agent_spec, render_user
from tools.chronicle_sim_v2.core.llm.cline_runner import run_agent_cline


async def run_director_drafts(
    pa: AgentLLMResources,
    run_dir: Path,
    intents: list[dict[str, Any]],
    event_types_text: str,
    week: int,
    pacing_mult: float = 1.0,
    event_selection_notes: str = "",
    world_bible_text: str = "",
) -> list[dict[str, Any]]:
    spec = load_agent_spec("director")
    user_text = render_user(
        spec,
        {
            "week": str(week),
            "pacing_mult": str(pacing_mult),
            "intents_json": json.dumps(intents, ensure_ascii=False),
            "event_types_text": event_types_text,
            "event_selection_notes": event_selection_notes or "（无）",
            "world_bible_text": world_bible_text or "（无世界种子 JSON，请仅依据意图谨慎发挥）",
        },
    )
    res = await run_agent_cline(pa, run_dir, spec, user_text=user_text)

    from tools.chronicle_sim_v2.core.llm.json_extract import parse_json_array, parse_json_object

    try:
        parsed = parse_json_array(res.text)
    except Exception:
        obj = parse_json_object(res.text)
        if isinstance(obj, dict) and "drafts" in obj:
            parsed = obj["drafts"]
        else:
            parsed = [obj]
    return parsed if isinstance(parsed, list) else [parsed]
