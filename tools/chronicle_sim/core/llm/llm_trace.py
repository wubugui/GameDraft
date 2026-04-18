from __future__ import annotations

import asyncio
import json
import sys
from collections.abc import Callable
from datetime import datetime
from typing import Any

from tools.chronicle_sim.core.llm.adapter import LLMResponse

# 全进程唯一：所有 LLM 对话与嵌入 HTTP 调用必须串行，禁止并发。
_LLM_GATE = asyncio.Lock()

_trace_sink: Callable[[str], None] | None = None


def get_llm_gate() -> asyncio.Lock:
    return _LLM_GATE


def set_llm_trace_sink(fn: Callable[[str], None] | None) -> None:
    """由 GUI 注册（应通过 Qt 信号投递到主线程）；未注册时仅 stderr。"""
    global _trace_sink
    _trace_sink = fn


def _trunc(s: str, max_len: int = 24000) -> str:
    if len(s) <= max_len:
        return s
    return s[: max_len - 12] + "…(已截断)"


def emit_llm_trace(message: str) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] [ChronicleSim] [LLM] {message}"
    print(line, file=sys.stderr, flush=True)
    if _trace_sink is not None:
        try:
            _trace_sink(message)
        except Exception:
            pass


def _sanitize_call_kwargs(kwargs: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in kwargs.items():
        if k == "json_schema" and v:
            out[k] = True
        elif isinstance(v, (str, int, float, bool, type(None))):
            out[k] = v
        elif isinstance(v, dict) and k == "json_schema":
            out[k] = True
        else:
            out[k] = repr(v)[:500]
    return out


def format_chat_call_for_log(
    agent_id: str,
    messages: list[dict[str, str]],
    kwargs: dict[str, Any],
) -> str:
    payload = {
        "agent_id": agent_id,
        "messages": messages,
        "call_kwargs": _sanitize_call_kwargs(kwargs),
    }
    return _trunc(json.dumps(payload, ensure_ascii=False))


def format_chat_response_for_log(agent_id: str, resp: LLMResponse) -> str:
    usage = resp.usage
    finish_reason: str | None = None
    raw = resp.raw
    if isinstance(raw, dict):
        ch = raw.get("choices")
        if isinstance(ch, list) and ch and isinstance(ch[0], dict):
            fr = ch[0].get("finish_reason")
            finish_reason = fr if isinstance(fr, str) else None
    payload: dict[str, Any] = {
        "agent_id": agent_id,
        "finish_reason": finish_reason,
        "output_text": resp.text or "",
        "usage": usage,
    }
    return _trunc(json.dumps(payload, ensure_ascii=False))


def format_embed_call_for_log(texts: list[str]) -> str:
    def clip(t: str, n: int = 2000) -> str:
        u = t.replace("\n", "\\n")
        return u if len(u) <= n else u[:n] + "…"

    head = [clip(t) for t in texts[:2]]
    more = len(texts) - len(head)
    payload: dict[str, Any] = {
        "n": len(texts),
        "text_head": head,
        "more": max(0, more),
    }
    return _trunc(json.dumps(payload, ensure_ascii=False))


def format_embed_response_for_log(vectors: list[list[float]]) -> str:
    payload = {
        "n": len(vectors),
        "dims": [len(row) for row in vectors],
    }
    return json.dumps(payload, ensure_ascii=False)
