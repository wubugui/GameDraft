"""LIKE 模式中转义 % 与 _，避免用户输入被当作通配符。"""
from __future__ import annotations


def escape_like_pattern(s: str, escape: str = "\\") -> str:
    if len(escape) != 1:
        raise ValueError("escape 必须为单字符")
    e = escape
    out: list[str] = []
    for c in s:
        if c in ("%", "_") or c == e:
            out.append(e)
        out.append(c)
    return "".join(out)
