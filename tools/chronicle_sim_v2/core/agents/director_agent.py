"""Director Agent：从 NPC 意图生成事件草稿。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from pydantic_ai import Agent

from tools.chronicle_sim_v2.core.agents.tools import director_tools
from tools.chronicle_sim_v2.core.llm.pa_chat import PAChatResources, merged_settings


def build_director_agent(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
) -> Agent:
    p = prompts_dir / "chronicle_director.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是编年史导演，根据角色意图生成事件草稿。"

    agent = Agent(
        model=pa.model,
        system_prompt=system,
        tools=director_tools(run_dir),
        model_settings=merged_settings(pa),
    )
    return agent


async def run_director_drafts(
    pa: PAChatResources,
    prompts_dir: Path,
    run_dir: Path,
    intents: list[dict[str, Any]],
    event_types_text: str,
    week: int,
    pacing_mult: float = 1.0,
) -> list[dict[str, Any]]:
    """Director 生成事件草稿。"""
    agent = build_director_agent(pa, prompts_dir, run_dir)
    intents_json = __import__("json").dumps(intents, ensure_ascii=False)
    user_prompt = (
        f"本周={week}，节奏系数={pacing_mult}\n\n"
        f"角色意图：\n{intents_json}\n\n"
        f"可用事件类型：\n{event_types_text}\n\n"
        "请根据以上信息生成本周事件草稿。"
    )
    from tools.chronicle_sim_v2.core.llm.pa_run import run_agent_traced
    result = await run_agent_traced(pa, agent, user_prompt, model_settings=merged_settings(pa))
    from tools.chronicle_sim_v2.core.llm.json_extract import parse_json_array, parse_json_object
    data = result.output
    try:
        parsed = parse_json_array(data)
    except Exception:
        obj = parse_json_object(data)
        # Handle {"drafts": [...]} wrapper
        if isinstance(obj, dict) and "drafts" in obj:
            parsed = obj["drafts"]
        else:
            parsed = [obj]
    return parsed if isinstance(parsed, list) else [parsed]
