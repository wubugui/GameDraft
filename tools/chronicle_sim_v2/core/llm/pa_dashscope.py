"""百炼等 OpenAI 兼容网关的判定与请求侧约定（与旧 openai_compat 对齐）。"""
from __future__ import annotations


def is_dashscope_openai_compat_base(base_url: str) -> bool:
    u = (base_url or "").lower()
    return "dashscope" in u and "compatible" in u
