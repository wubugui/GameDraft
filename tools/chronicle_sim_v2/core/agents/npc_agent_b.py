"""B/C 类 NPC Agent（Cline CLI，TOML spec）。"""
from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.agent_spec import load_agent_spec, render_user
from tools.chronicle_sim_v2.core.llm.cline_runner import run_agent_cline
from tools.chronicle_sim_v2.core.llm.json_extract import LLMJSONError, parse_json_lenient
from tools.chronicle_sim_v2.core.llm.llm_trace import emit_llm_trace

_GROUP_AGENT_ID = "tier_b_group"


def _fold_bc_intent_list(items: list[Any], week: int) -> dict[str, Any]:
    """模型常见输出为 `[{...},...]`（每人一条）；编排器只需**一个**群体意图对象喂给 Director。"""
    lines: list[str] = []
    moods: list[str] = []
    targets: list[str] = []
    hints: list[str] = []
    for i, raw in enumerate(items):
        if not isinstance(raw, dict):
            continue
        aid = str(raw.get("agent_id") or f"agent_{i}").strip()
        it = str(raw.get("intent_text") or "").strip()
        if it:
            lines.append(f"{aid}：{it}")
        md = str(raw.get("mood_delta") or "").strip()
        if md:
            moods.append(md)
        for k in ("target_ids",):
            v = raw.get(k)
            if isinstance(v, list):
                for x in v:
                    s = str(x).strip() if x is not None else ""
                    if s:
                        targets.append(s)
        vh = raw.get("relationship_hints")
        if isinstance(vh, list):
            for x in vh:
                s = str(x).strip() if x is not None else ""
                if s:
                    hints.append(s)

    intent_text = "；".join(lines) if lines else "龙套各自谋生，本周无额外统一动向。"
    mood = "杂"
    if moods:
        mood = moods[0] if len(set(moods)) == 1 else "杂"

    return {
        "agent_id": _GROUP_AGENT_ID,
        "week": week,
        "mood_delta": mood,
        "intent_text": intent_text,
        "target_ids": list(dict.fromkeys(targets)),
        "relationship_hints": list(dict.fromkeys(hints)),
    }


async def run_npc_b_intent(
    pa: AgentLLMResources,
    run_dir: Path,
    b_npcs_text: str,
    week: int,
    *,
    log_callback: Callable[[str], None] | None = None,
) -> dict[str, Any]:
    spec = load_agent_spec("tier_b_npc")
    user_text = render_user(
        spec,
        {
            "b_npcs_text": b_npcs_text,
            "week": str(week),
        },
    )
    res = await run_agent_cline(pa, run_dir, spec, user_text=user_text)

    raw = res.text or ""

    def _emit(msg: str) -> None:
        if log_callback:
            log_callback(msg)
        else:
            emit_llm_trace(msg)

    try:
        val = parse_json_lenient(raw)
    except LLMJSONError as err:
        _emit("[tier_b_npc] JSON 解析失败，以下为模型原始输出全文：")
        _emit(raw if raw else "（空）")
        raise err

    if isinstance(val, list):
        out = _fold_bc_intent_list(val, week)
        _emit(
            f"[tier_b_npc] 模型返回长度为 {len(val)} 的 JSON 数组，已折叠为单一群体意图（{ _GROUP_AGENT_ID }）。"
        )
        return out

    if isinstance(val, dict):
        out = dict(val)
        out["agent_id"] = _GROUP_AGENT_ID
        return out

    bad = LLMJSONError(
        f"期望 JSON 对象或数组，得到 {type(val).__name__}",
        raw[:480],
        details="tier_b_npc：根须为 `{...}` 或 `[{...},…]`",
    )
    bad.raw_text = raw
    raise bad

