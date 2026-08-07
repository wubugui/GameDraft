"""表单数值读取的公共助手。

**0 是合法值**：`cfg.get("cooldownMs") or 20000` 会把 0 当成"没配"顶成缺省——那是改行为，
不是格式漂移。凡是从数据里往控件填数的地方都走这里，别再手写 `or`。
"""
from __future__ import annotations


def int_or(v, default: int) -> int:
    return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default


def float_or(v, default: float) -> float:
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default
