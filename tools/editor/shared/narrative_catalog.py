"""叙事图与对话图编排的共享查询（编辑器用）。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from tools.editor.shared.project_paths import ProjectPaths

_ENTITY_WRAPPER_OWNER_TYPES = frozenset({"npc", "hotspot", "zone", "quest"})
_CONTEXT_READABLE_OWNER_TYPES = frozenset({"flow", "scenario"})
_FORBIDDEN_CONTEXT_OWNER_TYPES = frozenset({"npc", "hotspot", "zone", "quest", "dialogue"})


def _display_ref(name: str, item_id: str) -> str:
    name = str(name or "").strip()
    item_id = str(item_id or "").strip()
    return f"{name} ({item_id})" if name and name != item_id else item_id


def _graph_name(graph: dict[str, Any], fallback: str = "") -> str:
    return str(graph.get("label") or fallback or graph.get("id") or "").strip()


def load_narrative_graphs(project_root: Path) -> dict[str, Any] | None:
    path = ProjectPaths(project_root).data_dir / "narrative_graphs.json"
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def dialogue_owner_refs_from_scenes(scenes: dict[str, Any]) -> dict[str, list[dict[str, str]]]:
    out: dict[str, list[dict[str, str]]] = {}
    seen: set[tuple[str, str, str, str]] = set()

    def add(dialogue_id: str, owner_type: str, owner_id: str, detail: str) -> None:
        dialogue_id = str(dialogue_id or "").strip()
        owner_type = str(owner_type or "").strip()
        owner_id = str(owner_id or "").strip()
        if not dialogue_id or not owner_type or not owner_id:
            return
        key = (dialogue_id, owner_type, owner_id, detail)
        if key in seen:
            return
        seen.add(key)
        out.setdefault(dialogue_id, []).append({
            "ownerType": owner_type,
            "ownerId": owner_id,
            "detail": detail,
        })

    for scene_id, scene in scenes.items():
        if not isinstance(scene, dict):
            continue
        for npc in scene.get("npcs", []) or []:
            if not isinstance(npc, dict):
                continue
            dialogue_id = str(npc.get("dialogueGraphId", "")).strip()
            npc_id = str(npc.get("id", "")).strip()
            if dialogue_id and npc_id:
                add(dialogue_id, "npc", npc_id, f"npc:{scene_id}:{npc_id}")
                add(dialogue_id, "npc", f"{scene_id}:{npc_id}", f"npc:{scene_id}:{npc_id}")
        for hotspot in scene.get("hotspots", []) or []:
            if not isinstance(hotspot, dict):
                continue
            data = hotspot.get("data") if isinstance(hotspot.get("data"), dict) else {}
            dialogue_id = str(data.get("graphId", "")).strip()
            hotspot_id = str(hotspot.get("id", "")).strip()
            if dialogue_id and hotspot_id:
                add(dialogue_id, "hotspot", hotspot_id, f"hotspot:{scene_id}:{hotspot_id}")
                add(dialogue_id, "hotspot", f"{scene_id}:{hotspot_id}", f"hotspot:{scene_id}:{hotspot_id}")
    return out


def dialogue_owner_refs(model: Any) -> dict[str, list[dict[str, str]]]:
    scenes = getattr(model, "scenes", None)
    if isinstance(scenes, dict):
        return dialogue_owner_refs_from_scenes(scenes)
    return {}


def _owner_state_wrapper_matches(
    narrative_data: dict[str, Any],
    owner_refs: list[dict[str, str]],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for comp in narrative_data.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        comp_id = str(comp.get("id", "")).strip()
        main_graph = comp.get("mainGraph") if isinstance(comp.get("mainGraph"), dict) else {}
        comp_label = _graph_name(main_graph, comp_id)
        for element in comp.get("elements", []) or []:
            if not isinstance(element, dict) or str(element.get("kind", "")).strip() != "wrapperGraph":
                continue
            graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
            graph_id = str(graph.get("id", "")).strip()
            if not graph_id:
                continue
            owner_type = str(element.get("ownerType") or graph.get("ownerType") or "").strip()
            owner_id = str(element.get("ownerId") or graph.get("ownerId") or "").strip()
            if not owner_type or not owner_id:
                continue
            states_raw = graph.get("states")
            state_ids = sorted(states_raw.keys()) if isinstance(states_raw, dict) else []
            category = str(graph.get("category", "") or "").strip()
            element_id = str(element.get("id", "")).strip()
            element_label = str(element.get("label", "")).strip()
            graph_label = _graph_name(graph, element_label or graph_id)
            for ref in owner_refs:
                if owner_type != ref.get("ownerType") or owner_id != ref.get("ownerId"):
                    continue
                key = (graph_id, owner_type, owner_id)
                if key in seen:
                    continue
                seen.add(key)
                out.append({
                    "graphId": graph_id,
                    "label": _display_ref(graph_label, graph_id),
                    "graphLabel": graph_label,
                    "ownerType": owner_type,
                    "ownerId": owner_id,
                    "stateIds": state_ids,
                    "category": category,
                    "compositionId": comp_id,
                    "compositionLabel": comp_label,
                    "elementId": element_id,
                    "elementLabel": element_label,
                })
    return out


def resolve_owner_wrapper_states(
    project_root: Path,
    model: Any,
    dialogue_graph_id: str,
) -> dict[str, Any]:
    """返回 { stateIds, wrappers, ambiguous, message } 供 OwnerStateNode Inspector 使用。"""
    dialogue_graph_id = str(dialogue_graph_id or "").strip()
    narrative = load_narrative_graphs(project_root)
    if not narrative:
        return {
            "stateIds": [],
            "wrappers": [],
            "ambiguous": False,
            "message": "未找到 narrative_graphs.json",
        }
    refs = dialogue_owner_refs(model).get(dialogue_graph_id, [])
    if not refs:
        return {
            "stateIds": [],
            "wrappers": [],
            "ambiguous": False,
            "message": "未找到引用该对话图的 NPC/Hotspot",
        }
    matches = _owner_state_wrapper_matches(narrative, refs)
    if not matches:
        return {
            "stateIds": [],
            "wrappers": [],
            "ambiguous": False,
            "message": "未找到匹配的 wrapper graph，请先在叙事编辑器绑定 owner",
        }
    if len(matches) > 1:
        merged: list[str] = []
        for m in matches:
            for sid in m["stateIds"]:
                if sid not in merged:
                    merged.append(sid)
        return {
            "stateIds": merged,
            "wrappers": matches,
            "ambiguous": True,
            "message": f"多个 wrapper 可能适用（{len(matches)} 个），state 列表为并集",
        }
    return {
        "stateIds": list(matches[0]["stateIds"]),
        "wrappers": matches,
        "ambiguous": False,
        "message": f"wrapper {matches[0].get('label') or matches[0]['graphId']} ({matches[0]['ownerType']}:{matches[0]['ownerId']})",
    }


def list_context_readable_graphs(project_root: Path) -> list[dict[str, str]]:
    """flow/scenario 类图，供 ContextStateNode graphId 下拉。"""
    narrative = load_narrative_graphs(project_root)
    if not narrative:
        return []
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for comp in narrative.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict):
            gid = str(main.get("id", "")).strip()
            otype = str(main.get("ownerType", "")).strip()
            if gid and gid not in seen and otype in _CONTEXT_READABLE_OWNER_TYPES:
                seen.add(gid)
                label = _display_ref(_graph_name(main, gid), gid)
                out.append({"graphId": gid, "label": f"{label} (main/{otype})"})
        for element in comp.get("elements", []) or []:
            if not isinstance(element, dict):
                continue
            kind = str(element.get("kind", "")).strip()
            graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
            gid = str(graph.get("id", "")).strip()
            if not gid or gid in seen:
                continue
            otype = str(element.get("ownerType") or graph.get("ownerType") or "").strip()
            if kind == "scenarioSubgraph" or otype == "scenario":
                seen.add(gid)
                out.append({"graphId": gid, "label": f"{_display_ref(_graph_name(graph, str(element.get('label', '') or gid)), gid)} (scenario)"})
            elif otype == "flow":
                seen.add(gid)
                out.append({"graphId": gid, "label": f"{_display_ref(_graph_name(graph, gid), gid)} (flow)"})
    return out


def graph_states(project_root: Path, graph_id: str) -> list[str]:
    narrative = load_narrative_graphs(project_root)
    if not narrative:
        return []
    graph_id = str(graph_id or "").strip()
    for comp in narrative.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict) and str(main.get("id", "")).strip() == graph_id:
            states = main.get("states")
            return sorted(states.keys()) if isinstance(states, dict) else []
        for element in comp.get("elements", []) or []:
            if not isinstance(element, dict):
                continue
            graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
            if str(graph.get("id", "")).strip() == graph_id:
                states = graph.get("states")
                return sorted(states.keys()) if isinstance(states, dict) else []
    for graph in narrative.get("graphs", []) or []:
        if isinstance(graph, dict) and str(graph.get("id", "")).strip() == graph_id:
            states = graph.get("states")
            return sorted(states.keys()) if isinstance(states, dict) else []
    return []


def graph_info(project_root: Path, graph_id: str) -> dict[str, Any] | None:
    narrative = load_narrative_graphs(project_root)
    if not narrative:
        return None
    graph_id = str(graph_id or "").strip()
    if not graph_id:
        return None
    for comp in narrative.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        comp_id = str(comp.get("id", "")).strip()
        main = comp.get("mainGraph")
        if isinstance(main, dict) and str(main.get("id", "")).strip() == graph_id:
            states = main.get("states")
            return {
                "graphId": graph_id,
                "label": _display_ref(_graph_name(main, graph_id), graph_id),
                "kind": "mainGraph",
                "ownerType": str(main.get("ownerType", "")).strip(),
                "ownerId": str(main.get("ownerId", "")).strip(),
                "stateIds": sorted(states.keys()) if isinstance(states, dict) else [],
                "compositionId": comp_id,
            }
        for element in comp.get("elements", []) or []:
            if not isinstance(element, dict):
                continue
            graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
            if str(graph.get("id", "")).strip() != graph_id:
                continue
            states = graph.get("states")
            return {
                "graphId": graph_id,
                "label": _display_ref(_graph_name(graph, str(element.get("label", "") or graph_id)), graph_id),
                "kind": str(element.get("kind", "")).strip(),
                "ownerType": str(element.get("ownerType") or graph.get("ownerType") or "").strip(),
                "ownerId": str(element.get("ownerId") or graph.get("ownerId") or "").strip(),
                "stateIds": sorted(states.keys()) if isinstance(states, dict) else [],
                "compositionId": comp_id,
                "elementId": str(element.get("id", "")).strip(),
            }
    for graph in narrative.get("graphs", []) or []:
        if isinstance(graph, dict) and str(graph.get("id", "")).strip() == graph_id:
            states = graph.get("states")
            return {
                "graphId": graph_id,
                "label": _display_ref(_graph_name(graph, graph_id), graph_id),
                "kind": "legacyGraph",
                "ownerType": str(graph.get("ownerType", "")).strip(),
                "ownerId": str(graph.get("ownerId", "")).strip(),
                "stateIds": sorted(states.keys()) if isinstance(states, dict) else [],
            }
    return None


def is_context_graph_allowed(project_root: Path, graph_id: str) -> bool:
    narrative = load_narrative_graphs(project_root)
    if not narrative:
        return False
    graph_id = str(graph_id or "").strip()
    for comp in narrative.get("compositions", []) or []:
        if not isinstance(comp, dict):
            continue
        main = comp.get("mainGraph")
        if isinstance(main, dict) and str(main.get("id", "")).strip() == graph_id:
            otype = str(main.get("ownerType", "")).strip()
            return otype in _CONTEXT_READABLE_OWNER_TYPES
        for element in comp.get("elements", []) or []:
            if not isinstance(element, dict):
                continue
            graph = element.get("graph") if isinstance(element.get("graph"), dict) else {}
            if str(graph.get("id", "")).strip() != graph_id:
                continue
            otype = str(element.get("ownerType") or graph.get("ownerType") or "").strip()
            kind = str(element.get("kind", "")).strip()
            if otype in _FORBIDDEN_CONTEXT_OWNER_TYPES:
                return False
            return kind == "scenarioSubgraph" or otype in _CONTEXT_READABLE_OWNER_TYPES
    return False
