"""event 抽屉 — 事件域算子（5 个）。

约定：event 是 dict，含 actor/related/witness/truth 等字段；
visibility 由 actor∪related∪witness 决定（含 tier_b_group 展开占位）。
"""
from __future__ import annotations

from typing import Any

from tools.chronicle_sim_v3.engine.node import (
    NodeKindSpec,
    NodeOutput,
)
from tools.chronicle_sim_v3.engine.registry import register_node
from tools.chronicle_sim_v3.engine.types import PortSpec


def _actors_union(event: dict) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()

    def _add(v: Any) -> None:
        if isinstance(v, str) and v and v not in seen:
            seen.add(v)
            out.append(v)
        elif isinstance(v, list):
            for x in v:
                _add(x)

    _add(event.get("actor"))
    _add(event.get("actors"))
    _add(event.get("related"))
    _add(event.get("witness"))
    _add(event.get("witnesses"))
    # tier_b_group 展开：catalog 描述说明这一字段是 group_id；P3 才有真实分组数据，
    # 这里把 group_id 作为虚拟成员留住，下游 filter 时按需要忽略
    grp = event.get("tier_b_group")
    if grp:
        _add(f"group:{grp}" if isinstance(grp, str) else grp)
    return out


@register_node
class EventActorsUnion:
    spec = NodeKindSpec(
        kind="event.actors_union",
        category="event",
        title="event.actors_union",
        description="actor ∪ related ∪ witness 去重列表。",
        inputs=(PortSpec(name="event", type="Event"),),
        outputs=(PortSpec(name="out", type="List[AgentId]"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": _actors_union(inputs.get("event") or {})})


@register_node
class EventVisibleTo:
    spec = NodeKindSpec(
        kind="event.visible_to",
        category="event",
        title="event.visible_to",
        description=(
            "判断 agent_id 是否在 event 的可见性集合内（actor∪related∪witness）。"
        ),
        inputs=(
            PortSpec(name="event", type="Event"),
            PortSpec(name="agent_id", type="AgentId"),
        ),
        outputs=(PortSpec(name="out", type="Bool"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        event = inputs.get("event") or {}
        aid = str(inputs.get("agent_id", ""))
        if not aid:
            return NodeOutput(values={"out": False})
        return NodeOutput(values={"out": aid in set(_actors_union(event))})


@register_node
class EventFilterVisible:
    spec = NodeKindSpec(
        kind="event.filter_visible",
        category="event",
        title="event.filter_visible",
        description="批量过滤：仅保留 agent_id 可见的事件。",
        inputs=(
            PortSpec(name="events", type="EventList"),
            PortSpec(name="agent_id", type="AgentId"),
        ),
        outputs=(PortSpec(name="out", type="EventList"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        events = inputs.get("events") or []
        aid = str(inputs.get("agent_id", ""))
        if not aid:
            return NodeOutput(values={"out": []})
        out = [e for e in events if aid in set(_actors_union(e))]
        return NodeOutput(values={"out": out})


@register_node
class EventNormalizeForRumors:
    spec = NodeKindSpec(
        kind="event.normalize_for_rumors",
        category="event",
        title="event.normalize_for_rumors",
        description=(
            "为谣言传播计算 related/spread 字段；过滤非法 id（空串 / 'group:*' 占位）。"
            "返回新 dict（不修改原 event）。"
        ),
        inputs=(PortSpec(name="event", type="Event"),),
        outputs=(PortSpec(name="out", type="Event"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        e = dict(inputs.get("event") or {})
        actors = [a for a in _actors_union(e) if a and not a.startswith("group:")]
        e["related"] = actors
        e.setdefault("spread", {"hops": 0, "weight": 1.0})
        return NodeOutput(values={"out": e})


@register_node
class EventPublicDigestLine:
    spec = NodeKindSpec(
        kind="event.public_digest_line",
        category="event",
        title="event.public_digest_line",
        description=(
            "抽 event.truth.who_knows_what.公开 字段，存在则返回拼接的描述行；"
            "否则返回 null。用于公共周报草稿。"
        ),
        inputs=(PortSpec(name="event", type="Event"),),
        outputs=(PortSpec(name="out", type="Optional[Str]"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        event = inputs.get("event") or {}
        truth = event.get("truth") or {}
        kw = truth.get("who_knows_what") or {}
        public = kw.get("公开") or kw.get("public")
        if not public:
            return NodeOutput(values={"out": None})
        if isinstance(public, list):
            line = "；".join(str(x) for x in public)
        elif isinstance(public, dict):
            parts = [f"{k}: {v}" for k, v in sorted(public.items())]
            line = "；".join(parts)
        else:
            line = str(public)
        return NodeOutput(values={"out": line})
