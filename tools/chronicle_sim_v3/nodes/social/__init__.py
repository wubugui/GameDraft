"""social 抽屉 — 社交图算子（3 个）。

edges 项约定：{a, b, w(eight)?, type?}；视为无向；无权时按 w=1 处理。
"""
from __future__ import annotations

import heapq
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


def _build_adj(edges: list[dict]) -> dict[str, list[tuple[str, float, str]]]:
    """无向邻接表。返回 dict[node, list[(neighbor, weight, type)]]"""
    adj: dict[str, list[tuple[str, float, str]]] = defaultdict(list)
    for e in edges or []:
        a = str(e.get("a") or e.get("from") or "")
        b = str(e.get("b") or e.get("to") or "")
        if not a or not b:
            continue
        w = float(e.get("w", e.get("weight", 1.0)) or 1.0)
        t = str(e.get("type", ""))
        adj[a].append((b, w, t))
        adj[b].append((a, w, t))
    return adj


@register_node
class SocialNeighbors:
    spec = NodeKindSpec(
        kind="social.neighbors",
        category="social",
        title="social.neighbors",
        description=(
            "返回与 agent_id 在 hops 跳内可达的邻居 [{id, w, type, hops}]。"
            "BFS；每条边只走一次最短路径权重保留首次出现。"
        ),
        inputs=(
            PortSpec(name="agent_id", type="AgentId"),
            PortSpec(name="edges", type="EdgeList"),
        ),
        outputs=(PortSpec(name="out", type="List[Json]"),),
        params=(Param(name="hops", type="int", required=False, default=1),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        aid = str(inputs.get("agent_id", ""))
        edges = inputs.get("edges") or []
        hops = max(0, int(params.get("hops", 1)))
        if not aid:
            return NodeOutput(values={"out": []})
        adj = _build_adj(edges)
        # BFS
        seen: dict[str, dict] = {aid: {"hops": 0}}
        q: deque[tuple[str, int]] = deque([(aid, 0)])
        out: list[dict] = []
        while q:
            cur, depth = q.popleft()
            if depth >= hops:
                continue
            for nb, w, t in adj.get(cur, []):
                if nb in seen:
                    continue
                seen[nb] = {"hops": depth + 1}
                out.append({"id": nb, "w": w, "type": t, "hops": depth + 1})
                q.append((nb, depth + 1))
        return NodeOutput(values={"out": out})


@register_node
class SocialBfsReach:
    spec = NodeKindSpec(
        kind="social.bfs_reach",
        category="social",
        title="social.bfs_reach",
        description=(
            "从 start 出发 BFS，返回 {target: {hops, path}}（不含 start）。"
        ),
        inputs=(
            PortSpec(name="start", type="AgentId"),
            PortSpec(name="edges", type="EdgeList"),
        ),
        outputs=(PortSpec(name="out", type="Dict[Str, Json]"),),
        params=(Param(name="max_hops", type="int", required=False, default=2),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        start = str(inputs.get("start", ""))
        edges = inputs.get("edges") or []
        max_hops = max(0, int(params.get("max_hops", 2)))
        if not start:
            return NodeOutput(values={"out": {}})
        adj = _build_adj(edges)
        out: dict[str, dict] = {}
        parents: dict[str, str] = {start: ""}
        q: deque[tuple[str, int]] = deque([(start, 0)])
        while q:
            cur, depth = q.popleft()
            if depth >= max_hops:
                continue
            for nb, _, _ in adj.get(cur, []):
                if nb in parents:
                    continue
                parents[nb] = cur
                # 还原路径
                path: list[str] = []
                node = nb
                while node:
                    path.append(node)
                    node = parents[node]
                    if node == start:
                        path.append(start)
                        break
                path.reverse()
                out[nb] = {"hops": depth + 1, "path": path}
                q.append((nb, depth + 1))
        return NodeOutput(values={"out": out})


@register_node
class SocialShortestPath:
    spec = NodeKindSpec(
        kind="social.shortest_path",
        category="social",
        title="social.shortest_path",
        description=(
            "Dijkstra：最短带权路径（边权 w 越小越优先）。"
            "无路径返回空列表。"
        ),
        inputs=(
            PortSpec(name="a", type="AgentId"),
            PortSpec(name="b", type="AgentId"),
            PortSpec(name="edges", type="EdgeList"),
        ),
        outputs=(PortSpec(name="out", type="Path"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        src = str(inputs.get("a", ""))
        dst = str(inputs.get("b", ""))
        edges = inputs.get("edges") or []
        if not src or not dst:
            return NodeOutput(values={"out": []})
        if src == dst:
            return NodeOutput(values={"out": [src]})
        adj = _build_adj(edges)
        dist: dict[str, float] = {src: 0.0}
        prev: dict[str, str] = {}
        pq: list[tuple[float, str]] = [(0.0, src)]
        while pq:
            d, cur = heapq.heappop(pq)
            if cur == dst:
                break
            if d > dist.get(cur, float("inf")):
                continue
            for nb, w, _ in adj.get(cur, []):
                nd = d + max(0.0, w)
                if nd < dist.get(nb, float("inf")):
                    dist[nb] = nd
                    prev[nb] = cur
                    heapq.heappush(pq, (nd, nb))
        if dst not in prev and dst != src:
            return NodeOutput(values={"out": []})
        # 回溯
        path: list[str] = [dst]
        node = dst
        while node in prev:
            node = prev[node]
            path.append(node)
        path.reverse()
        return NodeOutput(values={"out": path})
