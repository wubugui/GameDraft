#!/usr/bin/env python3
"""Audit every potential route in the shared dialogue graph corpus."""

from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
GRAPH_DIR = REPO / "public/assets/dialogues/graphs"
PUBLIC_ASSETS = REPO / "public/assets"
REPORT = REPO / "godot_port/compatibility/dialogue-graph-audit.json"
NODE_TYPES = {"choice", "contextState", "end", "line", "ownerState", "runActions", "switch"}
IMMEDIATE_TYPES = {"contextState", "ownerState", "runActions", "switch"}


def walk(value: object):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def outgoing(node: dict) -> list[str]:
    kind = node.get("type")
    if kind in {"line", "runActions"}:
        values = [node.get("next")]
    elif kind == "choice":
        values = [option.get("next") for option in node.get("options", []) if isinstance(option, dict)]
    elif kind in {"switch", "contextState", "ownerState"}:
        values = [case.get("next") for case in node.get("cases", []) if isinstance(case, dict)]
        values.append(node.get("defaultNext"))
        if kind == "ownerState":
            values.append(node.get("missingWrapperNext"))
    else:
        values = []
    return [value.strip() for value in values if isinstance(value, str) and value.strip()]


def collect_external_entries(graph_ids: set[str]) -> tuple[dict[str, set[str]], list[dict]]:
    refs: dict[str, set[str]] = defaultdict(set)
    missing: list[dict] = []
    for path in PUBLIC_ASSETS.rglob("*.json"):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        for item in walk(raw):
            graph_id = None
            entry = ""
            if isinstance(item.get("dialogueGraphId"), str):
                graph_id = item["dialogueGraphId"].strip()
                entry = item.get("dialogueGraphEntry", "")
            elif item.get("type") == "startDialogueGraph" and isinstance(item.get("params"), dict):
                graph_id = str(item["params"].get("graphId", "")).strip()
                entry = item["params"].get("entry", "")
            elif isinstance(item.get("graphId"), str) and item["graphId"].strip() in graph_ids:
                graph_id = item["graphId"].strip()
                entry = item.get("entry", "")
            if not graph_id:
                continue
            if graph_id not in graph_ids:
                missing.append({"source": str(path.relative_to(REPO)), "graphId": graph_id})
                continue
            refs[graph_id].add(entry.strip() if isinstance(entry, str) else "")
    return refs, missing


def audit() -> dict:
    graphs = {}
    issues: list[dict] = []
    node_counts: Counter[str] = Counter()
    action_counts: Counter[str] = Counter()
    for path in sorted(GRAPH_DIR.glob("*.json")):
        raw = json.loads(path.read_text(encoding="utf-8"))
        graph_id = path.stem
        if raw.get("id") != graph_id:
            issues.append({"kind": "graph_id_mismatch", "graphId": graph_id, "jsonId": raw.get("id")})
        graphs[graph_id] = raw
    refs, missing_graph_refs = collect_external_entries(set(graphs))
    issues.extend({"kind": "missing_graph_reference", **item} for item in missing_graph_refs)
    reached_total = 0
    external_entry_count = 0
    for graph_id, raw in graphs.items():
        nodes = raw.get("nodes")
        entry = raw.get("entry")
        if not isinstance(nodes, dict) or not isinstance(entry, str) or entry not in nodes:
            issues.append({"kind": "invalid_entry", "graphId": graph_id, "entry": entry})
            continue
        edges: dict[str, list[str]] = {}
        for node_id, node in nodes.items():
            if not isinstance(node, dict) or node.get("type") not in NODE_TYPES:
                issues.append({"kind": "unknown_node", "graphId": graph_id, "nodeId": node_id, "type": node.get("type") if isinstance(node, dict) else None})
                continue
            node_counts[node["type"]] += 1
            edges[node_id] = outgoing(node)
            for target in edges[node_id]:
                if target not in nodes:
                    issues.append({"kind": "missing_next", "graphId": graph_id, "nodeId": node_id, "target": target})
            if node["type"] == "runActions":
                for action in node.get("actions", []):
                    if isinstance(action, dict) and isinstance(action.get("type"), str):
                        action_counts[action["type"].strip()] += 1
        seeds = {entry}
        for external_entry in refs.get(graph_id, set()):
            if not external_entry:
                continue
            external_entry_count += 1
            if external_entry not in nodes:
                issues.append({"kind": "missing_external_entry", "graphId": graph_id, "entry": external_entry})
            else:
                seeds.add(external_entry)
        reached: set[str] = set()
        pending = list(seeds)
        while pending:
            node_id = pending.pop()
            if node_id in reached or node_id not in nodes:
                continue
            reached.add(node_id)
            pending.extend(edges.get(node_id, []))
        reached_total += len(reached)
        for node_id in sorted(set(nodes) - reached):
            issues.append({"kind": "unreachable_node", "graphId": graph_id, "nodeId": node_id})
        # Immediate routing/action nodes may not form a cycle without a line,
        # choice or end boundary; such a component would spin in one drain.
        visiting: list[str] = []
        colors: dict[str, int] = {}

        def visit(node_id: str) -> None:
            colors[node_id] = 1
            visiting.append(node_id)
            for target in edges.get(node_id, []):
                if target not in nodes or nodes[target].get("type") not in IMMEDIATE_TYPES:
                    continue
                if colors.get(target) == 1:
                    issues.append({"kind": "immediate_route_cycle", "graphId": graph_id, "route": visiting[visiting.index(target):] + [target]})
                elif not colors.get(target):
                    visit(target)
            visiting.pop()
            colors[node_id] = 2

        for node_id, node in nodes.items():
            if node.get("type") in IMMEDIATE_TYPES and not colors.get(node_id):
                visit(node_id)
    return {
        "schemaVersion": 1,
        "graphCount": len(graphs),
        "nodeCount": sum(node_counts.values()),
        "reachedNodeCount": reached_total,
        "nodeTypes": dict(sorted(node_counts.items())),
        "externalEntryCount": external_entry_count,
        "runActionTypes": dict(sorted(action_counts.items())),
        "issueCount": len(issues),
        "issues": issues,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write-report", action="store_true")
    args = parser.parse_args()
    report = audit()
    if args.write_report:
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {REPORT.relative_to(REPO)}")
    if report["issueCount"]:
        print(json.dumps(report["issues"][:20], ensure_ascii=False, indent=2))
        return 1
    print(f"Dialogue graph route audit: PASS ({report['graphCount']} graphs, {report['reachedNodeCount']}/{report['nodeCount']} nodes, {report['externalEntryCount']} external entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
