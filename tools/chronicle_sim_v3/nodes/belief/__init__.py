"""belief 抽屉 — 信念算子（4 个）。

belief 项约定：{key, conf(idence), source, week, ...}
"""
from __future__ import annotations

from typing import Any

from tools.chronicle_sim_v3.engine.node import (
    NodeKindSpec,
    NodeOutput,
    Param,
)
from tools.chronicle_sim_v3.engine.registry import register_node
from tools.chronicle_sim_v3.engine.types import PortSpec


@register_node
class BeliefDecay:
    spec = NodeKindSpec(
        kind="belief.decay",
        category="belief",
        title="belief.decay",
        description=(
            "把每条 belief.conf 乘 factor；conf < threshold 的项被丢弃。"
        ),
        inputs=(PortSpec(name="beliefs", type="BeliefList"),),
        outputs=(PortSpec(name="out", type="BeliefList"),),
        params=(
            Param(name="factor", type="float", required=False, default=0.92),
            Param(name="threshold", type="float", required=False, default=0.12),
        ),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        factor = float(params.get("factor", 0.92))
        thr = float(params.get("threshold", 0.12))
        beliefs = inputs.get("beliefs") or []
        out: list[dict] = []
        for b in beliefs:
            new_conf = float(b.get("conf", 0.0)) * factor
            if new_conf >= thr:
                nb = dict(b)
                nb["conf"] = round(new_conf, 4)
                out.append(nb)
        return NodeOutput(values={"out": out})


@register_node
class BeliefFromEvents:
    spec = NodeKindSpec(
        kind="belief.from_events",
        category="belief",
        title="belief.from_events",
        description=(
            "对 agent_id 参与的事件生成 belief（actor / related / witness 任一）。"
            "key = event.id；source = 'event'。"
        ),
        inputs=(
            PortSpec(name="events", type="EventList"),
            PortSpec(name="agent_id", type="AgentId"),
        ),
        outputs=(PortSpec(name="out", type="BeliefList"),),
        params=(
            Param(name="confidence", type="float", required=False, default=0.82),
        ),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        from tools.chronicle_sim_v3.nodes.event import _actors_union

        aid = str(inputs.get("agent_id", ""))
        conf = float(params.get("confidence", 0.82))
        events = inputs.get("events") or []
        out: list[dict] = []
        for ev in events:
            audience = set(_actors_union(ev))
            if aid in audience:
                out.append({
                    "key": ev.get("id"),
                    "conf": conf,
                    "source": "event",
                    "summary": ev.get("summary") or ev.get("name") or "",
                })
        return NodeOutput(values={"out": out})


@register_node
class BeliefFromRumors:
    spec = NodeKindSpec(
        kind="belief.from_rumors",
        category="belief",
        title="belief.from_rumors",
        description=(
            "把 rumor 中包含 agent_id 的项转 belief。conf_heard 用于"
            "首次听说，conf_spread 用于多次传播叠加（depth>=2）。"
        ),
        inputs=(
            PortSpec(name="rumors", type="RumorList"),
            PortSpec(name="agent_id", type="AgentId"),
        ),
        outputs=(PortSpec(name="out", type="BeliefList"),),
        params=(
            Param(name="conf_heard", type="float", required=False, default=0.38),
            Param(name="conf_spread", type="float", required=False, default=0.55),
        ),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        aid = str(inputs.get("agent_id", ""))
        conf_h = float(params.get("conf_heard", 0.38))
        conf_s = float(params.get("conf_spread", 0.55))
        out: list[dict] = []
        for r in inputs.get("rumors") or []:
            for a in r.get("audience") or []:
                if str(a.get("agent_id")) == aid:
                    hops = int(a.get("hops", 1))
                    out.append({
                        "key": f"rumor:{r.get('source_event_id') or r.get('id')}",
                        "conf": conf_s if hops >= 2 else conf_h,
                        "source": "rumor",
                        "weight": float(a.get("weight", 1.0)),
                    })
                    break
        return NodeOutput(values={"out": out})


@register_node
class BeliefMergeTruncate:
    spec = NodeKindSpec(
        kind="belief.merge_truncate",
        category="belief",
        title="belief.merge_truncate",
        description=(
            "合并多个 belief 列表，相同 key 取最大 conf；按 conf 降序，截前 top_k。"
        ),
        inputs=(PortSpec(name="lists", type="List[BeliefList]", multi=True),),
        outputs=(PortSpec(name="out", type="BeliefList"),),
        params=(
            Param(name="top_k", type="int", required=False, default=24),
        ),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        merged: dict[str, dict] = {}
        for sub in (inputs.get("lists") or []):
            if not isinstance(sub, list):
                continue
            for b in sub:
                key = str(b.get("key", ""))
                if not key:
                    continue
                cur = merged.get(key)
                if cur is None or float(b.get("conf", 0.0)) > float(cur.get("conf", 0.0)):
                    merged[key] = dict(b)
        out = sorted(
            merged.values(),
            key=lambda b: (-float(b.get("conf", 0.0)), str(b.get("key", ""))),
        )
        top_k = int(params.get("top_k", 24))
        if top_k > 0:
            out = out[:top_k]
        return NodeOutput(values={"out": out})
