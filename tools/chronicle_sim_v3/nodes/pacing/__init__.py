"""pacing 抽屉 — 1 个节点。"""
from __future__ import annotations

from tools.chronicle_sim_v3.engine.node import (
    NodeKindSpec,
    NodeOutput,
)
from tools.chronicle_sim_v3.engine.registry import register_node
from tools.chronicle_sim_v3.engine.types import PortSpec


@register_node
class PacingMultiplier:
    spec = NodeKindSpec(
        kind="pacing.multiplier",
        category="pacing",
        title="pacing.multiplier",
        description=(
            "按 (week, pacing) 计算节奏倍率。pacing.weeks_window=[a,b] 内 → multiplier；"
            "否则 1.0。pacing 缺字段 → 1.0。"
        ),
        inputs=(
            PortSpec(name="week", type="Week"),
            PortSpec(name="pacing", type="Pacing"),
        ),
        outputs=(PortSpec(name="out", type="Float"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        week = int(inputs.get("week", 0))
        pacing = inputs.get("pacing") or {}
        # 简单语义：若 pacing.windows = [{from, to, multiplier}, ...]，落入哪个窗口取哪个
        windows = pacing.get("windows") or []
        for w in windows:
            try:
                lo = int(w.get("from", 0))
                hi = int(w.get("to", 0))
                if lo <= week <= hi:
                    return NodeOutput(values={"out": float(w.get("multiplier", 1.0))})
            except (TypeError, ValueError):
                continue
        return NodeOutput(values={"out": float(pacing.get("multiplier", 1.0) or 1.0)})
