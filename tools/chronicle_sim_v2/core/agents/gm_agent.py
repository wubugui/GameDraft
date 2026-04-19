"""GM Agent：仲裁事件草稿为最终事件记录，包含真相、目击者、超自然度。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic_ai import Agent

from tools.chronicle_sim_v2.core.agents.tools import gm_tools
from tools.chronicle_sim_v2.core.llm.pa_chat import PAChatResources, merged_settings


def build_gm_agent(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
) -> Agent:
    p = prompts_dir / "gm_agent.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是 GM（上帝视角），仲裁事件草稿为最终记录。"

    agent = Agent(
        model=pa.model,
        system_prompt=system,
        tools=gm_tools(run_dir),
        model_settings=merged_settings(pa),
    )
    return agent


async def run_gm_arbitrate(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
    drafts: list[dict[str, Any]],
    world_context: str,
    week: int,
) -> list[dict[str, Any]]:
    """GM 仲裁事件草稿。"""
    agent = build_gm_agent(pa, prompts_dir, run_dir)
    drafts_json = __import__("json").dumps(drafts, ensure_ascii=False)
    user_prompt = (
        f"本周={week}\n\n"
        f"世界设定：\n{world_context}\n\n"
        f"事件草稿：\n{drafts_json}\n\n"
        "请以全知视角仲裁这些事件，生成包含真相、目击者账号、超自然度的最终记录。"
    )
    from tools.chronicle_sim_v2.core.llm.pa_run import run_agent_traced
    result = await run_agent_traced(pa, agent, user_prompt, model_settings=merged_settings(pa))
    from tools.chronicle_sim_v2.core.llm.json_extract import parse_json_array, parse_json_object
    data = result.output
    try:
        parsed = parse_json_array(data)
    except Exception:
        obj = parse_json_object(data)
        # Handle {"records": [...]} wrapper
        if isinstance(obj, dict) and "records" in obj:
            parsed = obj["records"]
        else:
            parsed = [obj]
    return parsed if isinstance(parsed, list) else [parsed]
