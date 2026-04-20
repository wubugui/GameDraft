"""GM Agent：仲裁事件草稿为最终事件记录，包含真相、目击者、超自然度。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.agents.tools import gm_tools
from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.crew_factory import make_single_agent_crew
from tools.chronicle_sim_v2.core.llm.crew_run import crew_output_text, run_crew_traced


async def run_gm_arbitrate(
    pa: AgentLLMResources,
    prompts_dir: Path,
    run_dir: Path,
    drafts: list[dict[str, Any]],
    world_context: str,
    week: int,
) -> list[dict[str, Any]]:
    """GM 仲裁事件草稿。"""
    p = prompts_dir / "gm_agent.md"
    system = p.read_text(encoding="utf-8") if p.is_file() else "你是 GM（上帝视角），仲裁事件草稿为最终记录。"
    drafts_json = __import__("json").dumps(drafts, ensure_ascii=False)
    user_prompt = (
        f"本周={week}\n\n"
        f"世界设定：\n{world_context}\n\n"
        f"事件草稿：\n{drafts_json}\n\n"
        "请以全知视角仲裁这些事件，生成包含真相、目击者账号、超自然度的最终记录。"
    )
    crew = make_single_agent_crew(
        pa,
        role="GM",
        goal="输出符合提示格式的 JSON 事件最终记录。",
        backstory=system,
        tools=gm_tools(run_dir),
        task_description=user_prompt,
        expected_output="JSON 数组或包含 records 的对象。",
        max_iter=40,
    )
    out = await run_crew_traced(pa, crew, trace_user_preview=user_prompt, audit_system_hint=system[:8000])
    data = crew_output_text(out)
    from tools.chronicle_sim_v2.core.llm.json_extract import parse_json_array, parse_json_object

    try:
        parsed = parse_json_array(data)
    except Exception:
        obj = parse_json_object(data)
        if isinstance(obj, dict) and "records" in obj:
            parsed = obj["records"]
        else:
            parsed = [obj]
    return parsed if isinstance(parsed, list) else [parsed]
