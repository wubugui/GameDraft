"""rumor 抽屉 — 谣言传播 BFS 引擎（1 个，是大头）。

核心算法：
- 对每个 event，从其 `related`（即可见性集合，已由 event.normalize_for_rumors 处理）
  作为 BFS 起点
- 沿 edges 传播；衰减 = decay_per_hop ** depth
- 每步走一次 random.bernoulli(p_pass)；不通过则停止该方向
- 收集所有触达节点为该 event 的 rumor 受众；输出每条 rumor

mutation 子图（params.mutation）暂不实装：null = 不做走样
"""
from __future__ import annotations

import hashlib
import random
from collections import defaultdict, deque
from typing import Any

from tools.chronicle_sim_v3.engine.node import (
    NodeBusinessError,
    NodeKindSpec,
    NodeOutput,
    Param,
)
from tools.chronicle_sim_v3.engine.registry import register_node
from tools.chronicle_sim_v3.engine.types import PortSpec


def _build_adj(edges: list[dict]) -> dict[str, list[tuple[str, float]]]:
    adj: dict[str, list[tuple[str, float]]] = defaultdict(list)
    for e in edges or []:
        a = str(e.get("a") or e.get("from") or "")
        b = str(e.get("b") or e.get("to") or "")
        if not a or not b:
            continue
        w = float(e.get("w", e.get("weight", 1.0)) or 1.0)
        adj[a].append((b, w))
        adj[b].append((a, w))
    return adj


@register_node
class RumorBfsEngine:
    spec = NodeKindSpec(
        kind="rumor.bfs_engine",
        category="rumor",
        title="rumor.bfs_engine",
        description=(
            "BFS 概率传播：对每个 event 从 related 起点扩散；"
            "params 含 max_hops / decay_per_hop / p_pass / seed_base。"
            "mutation 子图（走样回调）暂不实装：null = 不做走样。"
        ),
        inputs=(
            PortSpec(name="events", type="EventList"),
            PortSpec(name="edges", type="EdgeList"),
            PortSpec(name="params", type="Json"),
            PortSpec(name="week", type="Week"),
        ),
        outputs=(PortSpec(name="rumors", type="RumorList"),),
        params=(
            Param(name="mutation", type="subgraph_ref", required=False, default=None,
                  doc="走样子图引用；null = 不做走样"),
        ),
        version="1",
        cacheable=True,
        deterministic=True,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        events = inputs.get("events") or []
        edges = inputs.get("edges") or []
        sim_params = inputs.get("params") or {}
        week = int(inputs.get("week", 0))
        max_hops = int(sim_params.get("max_hops", 3))
        decay = float(sim_params.get("decay_per_hop", 0.6))
        p_pass = float(sim_params.get("p_pass", 0.7))
        seed_base = str(sim_params.get("seed_base", "rumor"))

        if not (0.0 <= p_pass <= 1.0):
            raise NodeBusinessError(f"p_pass ∈ [0,1]，得到 {p_pass}")

        adj = _build_adj(edges)
        rumors: list[dict] = []
        for ev in events:
            ev_id = str(ev.get("id", ""))
            starts = ev.get("related") or []
            if not isinstance(starts, list):
                continue
            seen: set[str] = set(starts)
            audience: list[dict] = []
            seed = int.from_bytes(
                hashlib.sha256(f"{seed_base}|{week}|{ev_id}".encode("utf-8")).digest()[:8],
                "big",
            )
            rng = random.Random(seed)
            q: deque[tuple[str, int, float]] = deque(
                [(s, 0, 1.0) for s in starts]
            )
            while q:
                cur, depth, w = q.popleft()
                if depth >= max_hops:
                    continue
                for nb, ew in adj.get(cur, []):
                    if nb in seen:
                        continue
                    if rng.random() > p_pass:
                        continue
                    new_w = w * decay * max(0.0, ew if ew > 0 else 1.0)
                    if new_w <= 0:
                        continue
                    seen.add(nb)
                    audience.append({"agent_id": nb, "hops": depth + 1, "weight": round(new_w, 4)})
                    q.append((nb, depth + 1, new_w))
            if audience:
                rumors.append({
                    "id": f"r_{ev_id}",
                    "source_event_id": ev_id,
                    "week": week,
                    "audience": audience,
                    "version": 1,
                })
        return NodeOutput(values={"rumors": rumors})
