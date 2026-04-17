"""图对话静态分析（不可达、死路等），仅编辑器。"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

from .graph_document import extract_flow_edges, nodes_reachable_from_entry


def analyze_node_tags(data: dict[str, Any]) -> dict[str, str]:
    """node_id -> 'warn'（不可达或无出边非 end）。"""
    nodes = data.get("nodes") or {}
    entry = str(data.get("entry", "") or "")
    edges = extract_flow_edges(nodes)
    out_adj: dict[str, list[str]] = defaultdict(list)
    for s, d, _ in edges:
        if d in nodes:
            out_adj[s].append(d)

    reachable = nodes_reachable_from_entry(nodes, entry)

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


def extract_narrative_refs(data: dict[str, Any]) -> dict[str, Any]:
    """图内引用的 scenarioId（meta + 条件叶子）及嵌套 graphId（runActions 等），供编辑器分析。"""
    scenario_ids: set[str] = set()
    graph_ids: set[str] = set()
    meta = data.get("meta")
    if isinstance(meta, dict):
        ms = str(meta.get("scenarioId") or "").strip()
        if ms:
            scenario_ids.add(ms)

    def walk_expr(expr: Any) -> None:
        if not isinstance(expr, dict):
            return
        if "all" in expr and isinstance(expr["all"], list):
            for x in expr["all"]:
                walk_expr(x)
            return
        if "any" in expr and isinstance(expr["any"], list):
            for x in expr["any"]:
                walk_expr(x)
            return
        if "not" in expr:
            walk_expr(expr.get("not"))
            return
        sc = expr.get("scenario")
        if isinstance(sc, str) and sc.strip():
            scenario_ids.add(sc.strip())

    pre = data.get("preconditions")
    if isinstance(pre, list):
        for p in pre:
            walk_expr(p)

    nodes = data.get("nodes")
    if isinstance(nodes, dict):
        for _nid, raw in nodes.items():
            if not isinstance(raw, dict):
                continue
            if raw.get("type") == "switch":
                for case in raw.get("cases") or []:
                    if not isinstance(case, dict):
                        continue
                    c = case.get("condition")
                    if c is not None:
                        walk_expr(c)
                    for atom in case.get("conditions") or []:
                        walk_expr(atom)
            if raw.get("type") == "choice":
                for opt in raw.get("options") or []:
                    if isinstance(opt, dict) and opt.get("requireCondition") is not None:
                        walk_expr(opt.get("requireCondition"))
            if raw.get("type") == "runActions":
                for act in raw.get("actions") or []:
                    if not isinstance(act, dict):
                        continue
                    if act.get("type") == "startDialogueGraph":
                        p = act.get("params") or {}
                        gid = str(p.get("graphId") or "").strip()
                        if gid:
                            graph_ids.add(gid)

    return {
        "scenarioIds": sorted(scenario_ids),
        "graphIds": sorted(graph_ids),
    }
