from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def _endpoint_label(endpoint: Any, owner_graph_id: str) -> str:
    if isinstance(endpoint, dict):
        graph_id = str(endpoint.get("graphId", "")).strip()
        state_id = str(endpoint.get("stateId", "")).strip()
        return f"{graph_id}.{state_id}" if graph_id or state_id else "<empty object endpoint>"
    state_id = str(endpoint or "").strip()
    return f"{owner_graph_id}.{state_id}" if state_id else "<empty endpoint>"


def _endpoint_parts(endpoint: Any, owner_graph_id: str) -> tuple[str, str]:
    if isinstance(endpoint, dict):
        return str(endpoint.get("graphId", "")).strip(), str(endpoint.get("stateId", "")).strip()
    return owner_graph_id, str(endpoint or "").strip()


def _iter_graphs(data: dict[str, Any]) -> list[tuple[str, str, dict[str, Any]]]:
    out: list[tuple[str, str, dict[str, Any]]] = []
    for ci, comp in enumerate(data.get("compositions", []) or []):
        if not isinstance(comp, dict):
            continue
        comp_id = str(comp.get("id", "")).strip() or f"composition[{ci}]"
        main = comp.get("mainGraph")
        if isinstance(main, dict):
            out.append((comp_id, f"compositions[{ci}].mainGraph", main))
        for ei, element in enumerate(comp.get("elements", []) or []):
            if not isinstance(element, dict):
                continue
            graph = element.get("graph")
            if isinstance(graph, dict):
                out.append((comp_id, f"compositions[{ci}].elements[{ei}].graph", graph))
    for gi, graph in enumerate(data.get("graphs", []) or []):
        if isinstance(graph, dict):
            out.append(("", f"graphs[{gi}]", graph))
    return out


def collect_cross_graph_endpoint_hints(data: dict[str, Any]) -> list[dict[str, Any]]:
    hints: list[dict[str, Any]] = []
    graph_states: dict[str, set[str]] = {}
    for _, _, graph in _iter_graphs(data):
        graph_id = str(graph.get("id", "")).strip()
        states = graph.get("states")
        if graph_id and isinstance(states, dict):
            graph_states[graph_id] = {str(state_id) for state_id in states.keys()}

    for comp_id, graph_path, graph in _iter_graphs(data):
        owner_graph_id = str(graph.get("id", "")).strip()
        if not owner_graph_id:
            continue
        for ti, transition in enumerate(graph.get("transitions", []) or []):
            if not isinstance(transition, dict):
                continue
            from_ep = transition.get("from")
            to_ep = transition.get("to")
            if not isinstance(from_ep, dict) and not isinstance(to_ep, dict):
                continue
            transition_id = str(transition.get("id", "")).strip()
            from_graph, from_state = _endpoint_parts(from_ep, owner_graph_id)
            to_graph, to_state = _endpoint_parts(to_ep, owner_graph_id)
            path = f"{graph_path}.transitions[{ti}]"
            signal = str(transition.get("signal", "")).strip()
            local_states = sorted(graph_states.get(owner_graph_id, set()))
            target_states = sorted(graph_states.get(to_graph, set()))
            hints.append({
                "code": "transition.crossGraphEndpoint.unsupported",
                "compositionId": comp_id,
                "path": path,
                "graphId": owner_graph_id,
                "transitionId": transition_id,
                "from": _endpoint_label(from_ep, owner_graph_id),
                "to": _endpoint_label(to_ep, owner_graph_id),
                "signal": signal,
                "suggestions": [
                    (
                        "Do not auto-convert this transition. Pick or create a local state in "
                        f"{owner_graph_id} for the source graph's own result; known local states: "
                        f"{', '.join(local_states) if local_states else '<none>'}."
                    ),
                    (
                        "Move the remote state change into the target graph as its own transition: "
                        f"{to_graph}.<source_state> -> {to_graph}.{to_state}; known target states: "
                        f"{', '.join(target_states) if target_states else '<none>'}."
                    ),
                    (
                        "Trigger that target transition with a lifecycle signal from the source graph, "
                        f"usually stateEntered:{owner_graph_id}:<chosen_local_result_state>. "
                        f"Preserve the original external signal on the source-side local transition when {owner_graph_id} should still change state."
                    ),
                    (
                        "If the source graph should not change state, remove this transition and add a target-graph "
                        f"transition that listens to the original signal: {signal or '<missing signal>'}."
                    ),
                ],
                "resolved": {
                    "fromGraphId": from_graph,
                    "fromStateId": from_state,
                    "toGraphId": to_graph,
                    "toStateId": to_state,
                },
            })
    return hints


def _build_suggested_transitions(hint: dict[str, Any]) -> list[dict[str, Any]]:
    resolved = hint.get("resolved") if isinstance(hint.get("resolved"), dict) else {}
    from_graph = str(resolved.get("fromGraphId", "")).strip()
    from_state = str(resolved.get("fromStateId", "")).strip()
    to_graph = str(resolved.get("toGraphId", "")).strip()
    to_state = str(resolved.get("toStateId", "")).strip()
    signal = str(hint.get("signal", "")).strip()
    owner_graph = str(hint.get("graphId", "")).strip()
    transition_id = str(hint.get("transitionId", "")).strip()
    out: list[dict[str, Any]] = []
    if from_graph == owner_graph and from_state and to_graph and to_state and from_graph != to_graph:
        out.append({
            "confidence": "medium",
            "action": "add_target_transition",
            "graphId": to_graph,
            "from": "<current_or_entry>",
            "to": to_state,
            "signal": f"stateEntered:{owner_graph}:{from_state}",
            "note": "Create in target graph; pick source state that matches runtime context.",
        })
    if signal and to_graph and to_state:
        out.append({
            "confidence": "high",
            "action": "add_target_transition",
            "graphId": to_graph,
            "from": "<current_or_entry>",
            "to": to_state,
            "signal": signal,
            "note": "If source graph should not change, remove legacy edge and use this on target graph.",
        })
    if from_graph == owner_graph and from_state and to_state and from_graph == to_graph:
        out.append({
            "confidence": "high",
            "action": "normalize_local_transition",
            "graphId": owner_graph,
            "from": from_state,
            "to": to_state,
            "signal": signal,
            "transitionId": transition_id,
        })
    return out


def build_patch_document(path: Path, data: dict[str, Any]) -> dict[str, Any]:
    hints = collect_cross_graph_endpoint_hints(data)
    for hint in hints:
        hint["suggestedTransitions"] = _build_suggested_transitions(hint)
    return {
        "schemaVersion": 1,
        "sourcePath": str(path),
        "count": len(hints),
        "hints": hints,
    }


def apply_patch_file(path: Path, patch_path: Path, *, dry_run: bool = False) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    patch = json.loads(patch_path.read_text(encoding="utf-8"))
    hints = patch.get("hints") if isinstance(patch, dict) else []
    applied: list[str] = []
    skipped: list[str] = []
    if not isinstance(hints, list):
        raise SystemExit(f"{patch_path}: hints must be an array")

    graph_by_id: dict[str, dict[str, Any]] = {}
    for _, graph_path, graph in _iter_graphs(data):
        gid = str(graph.get("id", "")).strip()
        if gid:
            graph_by_id[gid] = graph

    for hint in hints:
        if not isinstance(hint, dict):
            continue
        for suggestion in hint.get("suggestedTransitions") or []:
            if not isinstance(suggestion, dict):
                continue
            if suggestion.get("action") != "normalize_local_transition":
                skipped.append(f"{hint.get('graphId')}.{hint.get('transitionId')}: {suggestion.get('action')}")
                continue
            if suggestion.get("confidence") != "high":
                skipped.append(f"{hint.get('graphId')}.{hint.get('transitionId')}: confidence not high")
                continue
            graph_id = str(suggestion.get("graphId", "")).strip()
            graph = graph_by_id.get(graph_id)
            if not graph:
                skipped.append(f"missing graph {graph_id}")
                continue
            from_state = str(suggestion.get("from", "")).strip()
            to_state = str(suggestion.get("to", "")).strip()
            states = graph.get("states") if isinstance(graph.get("states"), dict) else {}
            if from_state not in states or to_state not in states:
                skipped.append(f"{graph_id}: states missing for {from_state}->{to_state}")
                continue
            tid = str(suggestion.get("transitionId", "")).strip()
            updated = False
            for transition in graph.get("transitions", []) or []:
                if isinstance(transition, dict) and str(transition.get("id", "")).strip() == tid:
                    transition["from"] = from_state
                    transition["to"] = to_state
                    updated = True
                    break
            if not updated:
                skipped.append(f"{graph_id}.{tid}: transition not found")
                continue
            applied.append(f"{graph_id}.{tid}: normalized to local {from_state}->{to_state}")
    if applied and not dry_run:
        path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"applied": applied, "skipped": skipped, "dryRun": dry_run}


def _print_text(hints: list[dict[str, Any]]) -> None:
    if not hints:
        print("No legacy cross-graph transition endpoints found.")
        return
    print(f"Found {len(hints)} legacy cross-graph transition endpoint(s).")
    for index, hint in enumerate(hints, 1):
        print()
        print(f"{index}. {hint['graphId']}.{hint['transitionId']} at {hint['path']}")
        print(f"   {hint['from']} -> {hint['to']}")
        print(f"   signal: {hint['signal'] or '<missing>'}")
        for suggestion in hint["suggestions"]:
            print(f"   - {suggestion}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Report legacy narrative transitions whose from/to endpoints point across graph boundaries.",
    )
    parser.add_argument(
        "path",
        nargs="?",
        default="public/assets/data/narrative_graphs.json",
        help="Path to narrative_graphs.json",
    )
    parser.add_argument("--format", choices=("text", "json", "patch"), default="text")
    parser.add_argument("--fail-on-find", action="store_true", help="Exit with code 2 when legacy endpoints are found.")
    parser.add_argument("--apply", metavar="PATCH_JSON", help="Apply high-confidence normalize_local_transition entries from patch file.")
    parser.add_argument("--dry-run", action="store_true", help="With --apply, only report what would change.")
    args = parser.parse_args(argv)

    path = Path(args.path)
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise SystemExit(f"{path}: root must be a JSON object")

    if args.apply:
        result = apply_patch_file(path, Path(args.apply), dry_run=args.dry_run)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    hints = collect_cross_graph_endpoint_hints(data)
    if args.format == "patch":
        print(json.dumps(build_patch_document(path, data), ensure_ascii=False, indent=2))
    elif args.format == "json":
        print(json.dumps({"path": str(path), "count": len(hints), "hints": hints}, ensure_ascii=False, indent=2))
    else:
        _print_text(hints)
    return 2 if args.fail_on_find and hints else 0


if __name__ == "__main__":
    raise SystemExit(main())
