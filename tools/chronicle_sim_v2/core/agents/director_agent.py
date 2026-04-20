"""Director Agent：从 NPC 意图生成事件草稿。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.agents.tools import director_tools
from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.crew_factory import make_single_agent_crew
from tools.chronicle_sim_v2.core.llm.crew_run import crew_output_text, run_crew_traced


async def run_director_drafts(
    pa: AgentLLMResources,
    prompts_dir: Path,
    run_dir: Path,
    intents: list[dict[str, Any]],
    event_types_text: str,
    week: int,
    pacing_mult: float = 1.0,
) -> list[dict[str, Any]]:
    """Director 生成事件草稿。"""
    p = prompts_dir / "chronicle_director.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是编年史导演，根据角色意图生成事件草稿。"
    intents_json = __import__("json").dumps(intents, ensure_ascii=False)
    user_prompt = (
        f"本周={week}，节奏系数={pacing_mult}\n\n"
        f"角色意图：\n{intents_json}\n\n"
        f"可用事件类型：\n{event_types_text}\n\n"
        "请根据以上信息生成本周事件草稿。"
    )
    crew = make_single_agent_crew(
        pa,
        role="编年史导演",
        goal="根据意图与事件类型生成本周事件草稿 JSON。",
        backstory=system,
        tools=director_tools(run_dir),
        task_description=user_prompt,
        expected_output="JSON 数组或包含 drafts 的对象。",
        max_iter=40,
    )
    out = await run_crew_traced(pa, crew, trace_user_preview=user_prompt, audit_system_hint=system[:8000])
    data = crew_output_text(out)
    from tools.chronicle_sim_v2.core.llm.json_extract import parse_json_array, parse_json_object

    try:
        parsed = parse_json_array(data)
    except Exception:
        obj = parse_json_object(data)
        if isinstance(obj, dict) and "drafts" in obj:
            parsed = obj["drafts"]
        else:
            parsed = [obj]
    return parsed if isinstance(parsed, list) else [parsed]
