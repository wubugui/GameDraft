"""scenarios.json 中 requires 布尔式：叶子为 phase 名（语义为该 phase 已为 done），支持数组(与)、{all}/{any}/{not}。"""
from __future__ import annotations

from typing import Any


def collect_requires_phase_leaves(expr: Any, *, into: set[str] | None = None) -> set[str]:
    """收集表达式中所有出现的 phase 名字符串（含 not 内）。"""
    if into is None:
        into = set()
    if expr is None:
        return into
    if isinstance(expr, str):
        s = expr.strip()
        if s:
            into.add(s)
        return into
    if isinstance(expr, list):
        for x in expr:
            collect_requires_phase_leaves(x, into=into)
        return into
    if isinstance(expr, dict):
        for k, v in expr.items():
            if k in ("all", "any") and isinstance(v, list):
                for x in v:
                    collect_requires_phase_leaves(x, into=into)
            elif k == "not":
                collect_requires_phase_leaves(v, into=into)
        return into
    return into


def validate_requires_expr(
    expr: Any,
    *,
    pset: set[str],
    where: str,
) -> str | None:
    """结构合法且所有叶子 phase 属于 pset；否则返回错误文案。"""
    if expr is None:
        return None
    if isinstance(expr, str):
        s = expr.strip()
        if not s:
            return f"{where}：requires 不允许空字符串叶子"
        if s not in pset:
            return f"{where}：requires 引用未知 phase {s!r}"
        return None
    if isinstance(expr, list):
        for i, x in enumerate(expr):
            err = validate_requires_expr(x, pset=pset, where=f"{where}[{i}]")
            if err:
                return err
        return None
    if isinstance(expr, dict):
        allowed = frozenset({"all", "any", "not"})
        bad = set(expr.keys()) - allowed
        if bad:
            return f"{where}：requires 对象含非法键 {sorted(bad)!r}"
        present = [k for k in expr if k in allowed]
        if len(present) != 1:
            return f"{where}：requires 对象须恰好含一个键 all、any 或 not"
        op = present[0]
        if op in ("all", "any"):
            v = expr.get(op)
            if not isinstance(v, list):
                return f"{where}：{op!r} 的值须为数组"
            for i, x in enumerate(v):
                err = validate_requires_expr(x, pset=pset, where=f"{where}.{op}[{i}]")
                if err:
                    return err
            return None
        v = expr.get("not")
        return validate_requires_expr(v, pset=pset, where=f"{where}.not")
    return f"{where}：requires 不支持类型 {type(expr).__name__}"


def flatten_and_of_phase_strings(expr: Any) -> list[str] | None:
    """若为纯「与」链（字符串数组或仅嵌套 all），返回须先 done 的 phase 列表；否则 None（不做环检测）。"""
    if isinstance(expr, str):
        s = expr.strip()
        return [s] if s else []
    if isinstance(expr, list):
        acc: list[str] = []
        for x in expr:
            sub = flatten_and_of_phase_strings(x)
            if sub is None:
                return None
            acc.extend(sub)
        return acc
    if isinstance(expr, dict):
        if set(expr.keys()) != {"all"}:
            return None
        v = expr.get("all")
        if not isinstance(v, list):
            return None
        acc = []
        for x in v:
            sub = flatten_and_of_phase_strings(x)
            if sub is None:
                return None
            acc.extend(sub)
        return acc
    return None
