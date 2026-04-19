"""Pydantic AI 调用：全进程串行门、stderr追踪、可选审计。

调试追踪：`llm_config_json.trace`（配置页「LLM」→「调试追踪」），随 run 保存，不读环境变量。
- full_messages_json：是否输出 [chat·out·new_messages] / [chat·out·all_messages] 大段 JSON。
- max_chars：单条 trace 字符串上限。
- full_user_prompt：是否在 [chat·in] 打印完整 user_prompt（仍受 max_chars 截断）。
"""
from __future__ import annotations

import json
from collections.abc import Sequence
from typing import Any

from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai.run import AgentRunResult
from pydantic_ai.settings import ModelSettings, merge_model_settings

from tools.chronicle_sim_v2.core.llm.audit_log import append_llm_audit
from tools.chronicle_sim_v2.core.llm.llm_trace import emit_llm_trace, get_llm_gate
from tools.chronicle_sim_v2.core.llm.pa_chat import PAChatResources


def _trace_max_chars(pa: PAChatResources) -> int:
    try:
        mc = int(pa.trace.get("max_chars", 800_000))
    except (TypeError, ValueError):
        mc = 800_000
    return max(4096, mc)


def _messages_json_trace_enabled(pa: PAChatResources) -> bool:
    return bool(pa.trace.get("full_messages_json", True))


def _full_user_prompt_trace_enabled(pa: PAChatResources) -> bool:
    return bool(pa.trace.get("full_user_prompt", False))


def _cap_trace_blob(pa: PAChatResources, s: str, label: str) -> str:
    cap = _trace_max_chars(pa)
    if len(s) <= cap:
        return s
    return s[: cap - 120] + f"…(已截断 {label}，原长 {len(s)}，可在配置 trace.max_chars 调高)"


def _emit_message_json_traces(pa: PAChatResources, result: AgentRunResult[Any]) -> None:
    """打印本轮 new_messages / 全量 all_messages 的 JSON（与 pydantic_ai 序列化一致，含 tool 参数、provider_details）。"""
    agent_id = pa.agent_id
    if not _messages_json_trace_enabled(pa):
        return
    try:
        nm = result.new_messages_json().decode("utf-8")
        emit_llm_trace(
            f"[chat·out·new_messages] agent_id={agent_id!r} len={len(nm)} json={_cap_trace_blob(pa, nm, 'new_messages')}"
        )
    except Exception as e:
        emit_llm_trace(f"[chat·out·new_messages] agent_id={agent_id!r} error={e!r}")
    try:
        am = result.all_messages_json().decode("utf-8")
        emit_llm_trace(
            f"[chat·out·all_messages] agent_id={agent_id!r} len={len(am)} json={_cap_trace_blob(pa, am, 'all_messages')}"
        )
    except Exception as e:
        emit_llm_trace(f"[chat·out·all_messages] agent_id={agent_id!r} error={e!r}")
    try:
        rid = getattr(result, "run_id", None)
        meta = getattr(result, "metadata", None)
        emit_llm_trace(
            f"[chat·out·meta] agent_id={agent_id!r} run_id={rid!r} metadata={meta!r}"
        )
    except Exception as e:
        emit_llm_trace(f"[chat·out·meta] agent_id={agent_id!r} error={e!r}")


def finish_reason_from_pa_result(result: AgentRunResult[Any]) -> str | None:
    for m in reversed(result.all_messages()):
        if isinstance(m, ModelResponse):
            fr = getattr(m, "finish_reason", None)
            if isinstance(fr, str):
                return fr
            pd = m.provider_details
            if isinstance(pd, dict):
                r = pd.get("finish_reason")
                if isinstance(r, str):
                    return r
    return None


def _usage_from_pa_result(result: AgentRunResult[Any]) -> dict[str, Any] | None:
    u = getattr(result, "usage", None)
    if u is None:
        return None
    try:
        return u.model_dump()
    except Exception:
        try:
            return dict(u)
        except Exception:
            return None


def _trace_out_payload(pa: PAChatResources, result: AgentRunResult[Any]) -> str:
    agent_id = pa.agent_id
    fr = finish_reason_from_pa_result(result)
    out_text: str
    try:
        out_text = json.dumps(result.output, ensure_ascii=False)
    except (TypeError, ValueError):
        out_text = str(result.output)
    out_tool = getattr(result, "_output_tool_name", None)
    cap = min(24000, _trace_max_chars(pa))
    payload: dict[str, Any] = {
        "agent_id": agent_id,
        "finish_reason": fr,
        "output_tool_name": out_tool,
        "output_preview": out_text[:cap],
        "output_len": len(out_text),
        "usage": _usage_from_pa_result(result),
        "run_id": getattr(result, "run_id", None),
    }
    s = json.dumps(payload, ensure_ascii=False)
    if len(s) > cap:
        return s[: cap - 24] + "…(已截断)"
    return s


def _trace_in_payload(
    pa: PAChatResources,
    user_prompt: str,
    *,
    model_settings: ModelSettings | None,
    has_history: bool,
) -> str:
    agent_id = pa.agent_id
    ms = model_settings or {}
    safe_ms: dict[str, Any] = {}
    for k, v in ms.items():
        if k == "extra_body" and v is not None:
            safe_ms[k] = repr(v)[:500]
        elif isinstance(v, (str, int, float, bool, type(None))):
            safe_ms[k] = v
        else:
            safe_ms[k] = repr(v)[:300]
    if _full_user_prompt_trace_enabled(pa):
        up = _cap_trace_blob(pa, user_prompt, "user_prompt")
    else:
        up = user_prompt[:12000] + ("…" if len(user_prompt) > 12000 else "")
    payload = {
        "agent_id": agent_id,
        "user_prompt_preview": up,
        "user_prompt_chars": len(user_prompt),
        "model_settings": safe_ms,
        "has_message_history": has_history,
    }
    return json.dumps(payload, ensure_ascii=False)


def _raw_like_from_pa_result(result: AgentRunResult[Any]) -> dict[str, Any] | None:
    for m in reversed(result.all_messages()):
        if isinstance(m, ModelResponse) and m.provider_details:
            return dict(m.provider_details)
    return None


def _audit_messages_fallback(user_prompt: str, system_hint: str | None) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    if system_hint:
        rows.append({"role": "system", "content": system_hint[:12000]})
    rows.append({"role": "user", "content": user_prompt[:12000]})
    return rows


def dict_chat_to_message_history(history: list[dict[str, str]]) -> list[ModelMessage]:
    out: list[ModelMessage] = []
    for m in history:
        role = (m.get("role") or "").strip()
        c = m.get("content") or ""
        if role == "user":
            out.append(ModelRequest(parts=[UserPromptPart(c)]))
        elif role == "assistant":
            out.append(ModelResponse(parts=[TextPart(c)]))
    return out


async def run_agent_traced(
    pa: PAChatResources,
    agent: Agent[Any, Any],
    user_prompt: str,
    *,
    message_history: Sequence[ModelMessage] | None = None,
    model_settings: ModelSettings | None = None,
    deps: Any = None,
    audit_system_hint: str | None = None,
    **run_kw: Any,
) -> AgentRunResult[Any]:
    merged = merge_model_settings(pa.default_model_settings, model_settings)
    async with get_llm_gate():
        emit_llm_trace(
            f"[chat·in] {_trace_in_payload(pa, user_prompt, model_settings=merged, has_history=bool(message_history))}"
        )
        result = await agent.run(
            user_prompt,
            message_history=list(message_history) if message_history is not None else None,
            model_settings=merged,
            deps=deps,
            **run_kw,
        )
        emit_llm_trace(f"[chat·out] {_trace_out_payload(pa, result)}")
        _emit_message_json_traces(pa, result)
    if pa.audit_run_dir is not None:
        append_llm_audit(
            pa.audit_run_dir,
            pa.agent_id,
            messages=_audit_messages_fallback(user_prompt, audit_system_hint),
            response_text=str(result.output),
            raw=_raw_like_from_pa_result(result),
        )
    return result
