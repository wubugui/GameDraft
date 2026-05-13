"""eventtype 抽屉 — 事件类型抽样辅助（4 个）。

EventType 是 dict，含 id / name / pick_weight / period / cooldown_weeks / conditions（表达式列表）。
"""
from __future__ import annotations

from typing import Any

from tools.chronicle_sim_v3.engine.expr import evaluate, parse
from tools.chronicle_sim_v3.engine.node import (
    NodeBusinessError,
    NodeKindSpec,
    NodeOutput,
)
from tools.chronicle_sim_v3.engine.registry import register_node
from tools.chronicle_sim_v3.engine.types import PortSpec


def _eval_cond(expr_str: str, week: int, et: dict) -> bool:
    expr = parse(expr_str)
    scope = {
        "ctx": {"week": week},
        "nodes": {},
        "item": et,
        "params": {},
        "inputs": {"week": week, "et": et},
    }
    return bool(evaluate(expr, scope))


@register_node
class EventTypeConditionPass:
    spec = NodeKindSpec(
        kind="eventtype.condition_pass",
        category="eventtype",
        title="eventtype.condition_pass",
        description=(
            "评估 et.conditions（表达式列表）是否全部为真。空列表视为通过。"
        ),
        inputs=(
            PortSpec(name="et", type="EventType"),
            PortSpec(name="week", type="Week"),
        ),
        outputs=(PortSpec(name="out", type="Bool"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        et = inputs.get("et") or {}
        week = int(inputs.get("week", 0))
        conds = et.get("conditions") or []
        if not isinstance(conds, list):
            raise NodeBusinessError("et.conditions 必须是 list")
        for c in conds:
            if not _eval_cond(str(c), week, et):
                return NodeOutput(values={"out": False})
        return NodeOutput(values={"out": True})


@register_node
class EventTypeCooldownPass:
    spec = NodeKindSpec(
        kind="eventtype.cooldown_pass",
        category="eventtype",
        title="eventtype.cooldown_pass",
        description=(
            "查 chronicle.events:week=* 历史，最近一次出现 et.id 距 now > cooldown_weeks。"
            "无 cooldown 字段视为通过。"
        ),
        inputs=(
            PortSpec(name="et", type="EventType"),
            PortSpec(name="week", type="Week"),
        ),
        outputs=(PortSpec(name="out", type="Bool"),),
        reads=frozenset({"chronicle.weeks"}),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        et = inputs.get("et") or {}
        cd = int(et.get("cooldown_weeks", 0) or 0)
        if cd <= 0:
            return NodeOutput(values={"out": True})
        week_now = int(inputs.get("week", 0))
        et_id = str(et.get("id", ""))
        if not et_id:
            return NodeOutput(values={"out": True})
        weeks_known = ctx.chronicle_weeks_list()
        # 倒序找最近一次该 type 的出现
        for w in sorted(weeks_known, reverse=True):
            if w >= week_now:
                continue
            for ev in ctx.chronicle_events(w):
                if ev.get("type_id") == et_id or ev.get("event_type_id") == et_id:
                    return NodeOutput(values={"out": (week_now - w) > cd})
        return NodeOutput(values={"out": True})


@register_node
class EventTypeScore:
    spec = NodeKindSpec(
        kind="eventtype.score",
        category="eventtype",
        title="eventtype.score",
        description=(
            "score = pick_weight × pacing_multiplier × period_factor。"
            "period_factor: 当 et.period 给定且与 week % period == 0 → 1.5，否则 1.0。"
        ),
        inputs=(
            PortSpec(name="et", type="EventType"),
            PortSpec(name="week", type="Week"),
            PortSpec(name="pacing", type="Pacing"),
        ),
        outputs=(PortSpec(name="out", type="Float"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        et = inputs.get("et") or {}
        week = int(inputs.get("week", 0))
        pacing = inputs.get("pacing") or {}
        pick_w = float(et.get("pick_weight", 1.0) or 1.0)
        pacing_mul = float(pacing.get("multiplier", 1.0) or 1.0)
        period = et.get("period")
        period_factor = 1.0
        if period and isinstance(period, int) and period > 0 and (week % period == 0):
            period_factor = 1.5
        return NodeOutput(values={"out": pick_w * pacing_mul * period_factor})


@register_node
class EventTypeFormatForPrompt:
    spec = NodeKindSpec(
        kind="eventtype.format_for_prompt",
        category="eventtype",
        title="eventtype.format_for_prompt",
        description="把 EventType 列表格式化为 LLM 可读的清单文本。",
        inputs=(PortSpec(name="types", type="EventTypeList"),),
        outputs=(PortSpec(name="out", type="Str"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        types = inputs.get("types") or []
        lines: list[str] = []
        for et in types:
            name = et.get("name") or et.get("id") or "(unnamed)"
            desc = et.get("description") or et.get("summary") or ""
            tags = et.get("tags") or []
            tag_str = ("[" + ", ".join(tags) + "]") if tags else ""
            lines.append(f"- {name}{(' ' + tag_str) if tag_str else ''}: {desc}")
        return NodeOutput(values={"out": "\n".join(lines)})
