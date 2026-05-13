"""httpx 客户端参数：本软件从不使用系统/环境代理，仅在 llm_config['http']['proxy'] 配置应用内代理。"""
from __future__ import annotations

from typing import Any

import httpx


def _chat_timeout(read_write_sec: float) -> httpx.Timeout:
    """读/写使用用户配置的「对话等待」上限；连接与连接池取较短上限，避免长时间卡在握手。"""
    rw = float(read_write_sec)
    cap = min(30.0, rw)
    return httpx.Timeout(connect=cap, read=rw, write=rw, pool=cap)


def httpx_async_client_kwargs(llm_config: dict[str, Any] | None) -> dict[str, Any]:
    """供 AsyncClient(**kwargs)；trust_env 恒为 False。timeout 为 granular Timeout，避免慢推理时 read 先触发120s 总限。"""
    timeout_sec = 300.0
    out: dict[str, Any] = {"trust_env": False}
    if not llm_config:
        out["timeout"] = _chat_timeout(timeout_sec)
        return out
    h = llm_config.get("http")
    if isinstance(h, dict):
        p = h.get("proxy")
        if isinstance(p, str) and p.strip():
            out["proxy"] = p.strip()
        raw_t = h.get("chat_timeout_sec")
        if raw_t is not None:
            try:
                timeout_sec = float(raw_t)
            except (TypeError, ValueError):
                pass
    if timeout_sec > 0:
        out["timeout"] = _chat_timeout(timeout_sec)
    return out
