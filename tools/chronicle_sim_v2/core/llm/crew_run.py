"""CrewAI 调用：全进程串行门、stderr 追踪、可选审计；kickoff 外层隔离环境变量。"""
from __future__ import annotations

import json
from typing import Any

from crewai import Crew
from crewai.crews.crew_output import CrewOutput

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.audit_log import append_llm_audit
from tools.chronicle_sim_v2.core.llm.env_isolate import isolated_llm_env
from tools.chronicle_sim_v2.core.llm.llm_trace import emit_llm_trace, get_llm_gate


def _trace_max_chars(res: AgentLLMResources) -> int:
    try:
        mc = int(res.trace.get("max_chars", 800_000))
    except (TypeError, ValueError):
        mc = 800_000
    return max(4096, mc)


def _cap_trace_blob(res: AgentLLMResources, s: str, label: str) -> str:
    cap = _trace_max_chars(res)
    if len(s) <= cap:
        return s
    return s[: cap - 120] + f"…(已截断 {label}，原长 {len(s)}，可在配置 trace.max_chars 调高)"


def crew_output_text(out: CrewOutput) -> str:
    """从 CrewOutput 取人类可读最终文本。"""
    if out.raw and str(out.raw).strip():
        return str(out.raw)
    if out.tasks_output:
        last = out.tasks_output[-1]
        raw = getattr(last, "raw", None) or getattr(last, "output", None)
        if raw:
            return str(raw)
    return str(out)


def _trace_out_payload(res: AgentLLMResources, out: CrewOutput) -> str:
    agent_id = res.agent_id
    text = crew_output_text(out)
    cap = min(24000, _trace_max_chars(res))
    usage = None
    tu = getattr(out, "token_usage", None)
    if tu is not None:
        try:
            usage = tu.model_dump() if hasattr(tu, "model_dump") else (tu if isinstance(tu, dict) else str(tu))
        except Exception:
            usage = str(tu)
    payload: dict[str, Any] = {
        "agent_id": agent_id,
        "output_preview": text[:cap],
        "output_len": len(text),
        "usage": usage,
    }
    s = json.dumps(payload, ensure_ascii=False)
    if len(s) > cap:
        return s[: cap - 24] + "…(已截断)"
    return s


def _trace_in_payload(res: AgentLLMResources, user_preview: str) -> str:
    agent_id = res.agent_id
    if bool(res.trace.get("full_user_prompt", False)):
        up = _cap_trace_blob(res, user_preview, "user_prompt")
    else:
        up = user_preview[:12000] + ("…" if len(user_preview) > 12000 else "")
    payload = {
        "agent_id": agent_id,
        "user_prompt_preview": up,
        "user_prompt_chars": len(user_preview),
    }
    return json.dumps(payload, ensure_ascii=False)


def _audit_messages_fallback(user_prompt: str, system_hint: str | None) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    if system_hint:
        rows.append({"role": "system", "content": system_hint[:12000]})
    rows.append({"role": "user", "content": user_prompt[:12000]})
    return rows


async def run_crew_traced(
    res: AgentLLMResources,
    crew: Crew,
    *,
    trace_user_preview: str,
    audit_system_hint: str | None = None,
) -> CrewOutput:
    """执行 crew.kickoff_async，带门控、trace、可选审计；隔离常见 LLM 环境变量。"""
    async with get_llm_gate():
        emit_llm_trace(f"[chat·in] {_trace_in_payload(res, trace_user_preview)}")
        with isolated_llm_env():
            out = await crew.kickoff_async()
        emit_llm_trace(f"[chat·out] {_trace_out_payload(res, out)}")
        if bool(res.trace.get("full_messages_json", True)):
            try:
                blob = json.dumps(
                    {"raw": out.raw, "tasks": [t.model_dump() for t in out.tasks_output]},
                    ensure_ascii=False,
                    default=str,
                )
                emit_llm_trace(
                    f"[crew·tasks] agent_id={res.agent_id!r} len={len(blob)} json={_cap_trace_blob(res, blob, 'crew_tasks')}"
                )
            except Exception as e:
                emit_llm_trace(f"[crew·tasks] agent_id={res.agent_id!r} error={e!r}")
    if res.audit_run_dir is not None:
        text = crew_output_text(out)
        append_llm_audit(
            res.audit_run_dir,
            res.agent_id,
            messages=_audit_messages_fallback(trace_user_preview, audit_system_hint),
            response_text=text,
            raw=None,
        )
    return out


def format_chat_turns_for_task(turns: list[dict[str, str]]) -> str:
    """将 GUI 多轮 {role,content} 列表拼成单一上下文字符串（用于 Task description）。"""
    lines: list[str] = []
    for m in turns:
        role = (m.get("role") or "").strip()
        c = m.get("content") or ""
        if role == "user":
            lines.append(f"【用户】\n{c}")
        elif role == "assistant":
            lines.append(f"【助手】\n{c}")
        else:
            lines.append(f"【{role}】\n{c}")
    return "\n\n".join(lines)
