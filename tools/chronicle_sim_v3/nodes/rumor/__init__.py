"""rumor 抽屉 — 谣言传播 BFS 引擎。

当前版本在原始 BFS 扩散骨架上补了几件关键事情：
- 对每个 event，从 `related` 起点开始扩散
- 沿 edges 传播；衰减 = decay_per_hop ** depth
- 每步走一次概率门控
- 过滤“传言原始来源回流给原始来源”的自回声
- 记录每个受众的重复暴露次数与来源多样性
- 当同一受众被多次触达或来源不一致时，打上 should_reflect，供 belief/反思层消费

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


def _event_originators(event: dict) -> list[str]:
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
    return out


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
            originators = set(_event_originators(ev) or starts)
            enqueued: set[str] = set(starts)
            traversed_edges: set[tuple[str, str]] = set()
            exposures: dict[str, dict[str, Any]] = {}
            seed = int.from_bytes(
                hashlib.sha256(f"{seed_base}|{week}|{ev_id}".encode("utf-8")).digest()[:8],
                "big",
            )
            rng = random.Random(seed)
            q: deque[tuple[str, int, float, str]] = deque(
                [(s, 0, 1.0, "_origin") for s in starts]
            )
            while q:
                cur, depth, w, heard_from = q.popleft()
                if depth >= max_hops:
                    continue
                for nb, ew in adj.get(cur, []):
                    edge_key = (cur, nb)
                    if edge_key in traversed_edges:
                        continue
                    traversed_edges.add(edge_key)
                    if rng.random() > p_pass:
                        continue
                    new_w = w * decay * max(0.0, ew if ew > 0 else 1.0)
                    if new_w <= 0:
                        continue
                    # 系统层过滤“自己放出去的传言直接当作外部新信息回到自己”。
                    if nb in originators and depth + 1 > 0:
                        continue
                    info = exposures.setdefault(nb, {
                        "agent_id": nb,
                        "hops": depth + 1,
                        "weight": round(new_w, 4),
                        "exposure_count": 0,
                        "source_ids": set(),
                    })
                    info["exposure_count"] += 1
                    info["hops"] = min(int(info.get("hops", depth + 1)), depth + 1)
                    info["weight"] = round(max(float(info.get("weight", 0.0)), new_w), 4)
                    if cur not in originators:
                        info["source_ids"].add(cur)
                    elif heard_from not in {"", "_origin"}:
                        info["source_ids"].add(heard_from)
                    if nb not in enqueued:
                        enqueued.add(nb)
                        q.append((nb, depth + 1, new_w, cur))
            if exposures:
                audience: list[dict] = []
                for info in exposures.values():
                    source_ids = sorted(info.pop("source_ids", set()))
                    exposure_count = int(info.get("exposure_count", 0))
                    audience.append({
                        **info,
                        "source_ids": source_ids,
                        "source_diversity": len(source_ids),
                        "repeated": exposure_count > 1,
                        "should_reflect": exposure_count > 1 or len(source_ids) > 1,
                    })
                audience.sort(key=lambda x: (x["hops"], x["agent_id"]))
                rumors.append({
                    "id": f"r_{ev_id}",
                    "source_event_id": ev_id,
                    "week": week,
                    "audience": audience,
                    "originators": sorted(originators),
                    "version": 1,
                })
        return NodeOutput(values={"rumors": rumors})
