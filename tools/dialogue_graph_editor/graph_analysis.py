"""图对话静态分析（不可达、死路等），仅编辑器。"""
from __future__ import annotations

from collections import defaultdict, deque
from typing import Any

from .graph_document import extract_flow_edges


def analyze_node_tags(data: dict[str, Any]) -> dict[str, str]:
    """node_id -> 'warn'（不可达或无出边非 end）。"""
    nodes = data.get("nodes") or {}
    entry = str(data.get("entry", "") or "")
    edges = extract_flow_edges(nodes)
    out_adj: dict[str, list[str]] = defaultdict(list)
    for s, d, _ in edges:
        if d in nodes:
            out_adj[s].append(d)

    reachable: set[str] = set()
    if entry in nodes:
        dq = deque([entry])
        reachable.add(entry)
        while dq:
            u = dq.popleft()
            for v in out_adj.get(u, ()):
                if v in nodes and v not in reachable:
                    reachable.add(v)
                    dq.append(v)

    tags: dict[str, str] = {}
    for nid in nodes:
        if nid not in reachable:
            tags[nid] = "warn"

    for nid, raw in nodes.items():
        if not isinstance(raw, dict):
            continue
        if raw.get("type") == "end":
            continue
        if not out_adj.get(nid):
            tags[nid] = "warn"

    return tags
