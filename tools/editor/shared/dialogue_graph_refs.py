"""Live, staging-aware dialogue-graph reference catalog for editor widgets."""
from __future__ import annotations

from pathlib import Path
from typing import Any


def _safe_graph_id(raw: object) -> str:
    gid = str(raw or "").strip()
    if not gid:
        return ""
    try:
        from .narrative_templates import _dialogue_id_error

        if _dialogue_id_error(gid):
            return ""
    except Exception:
        if gid in (".", "..") or "/" in gid or "\\" in gid:
            return ""
    return gid


def _pending_graph(model: Any, graph_id: str) -> dict | None:
    deleted = getattr(model, "pending_dialogue_graph_deletes", set())
    if graph_id in deleted:
        return None
    for attr in ("pending_dialogue_graph_edits", "pending_dialogue_stubs"):
        bag = getattr(model, attr, None)
        if not isinstance(bag, dict):
            continue
        graph = bag.get(graph_id)
        if isinstance(graph, dict):
            return graph
    return None


def dialogue_graph_ids(model: Any) -> list[str]:
    """Disk IDs plus safe named ProjectModel staging entries.

    Untitled editor drafts are intentionally absent: they have no stable target
    ID until their first successful save.
    """
    ids: set[str] = set()
    provider = getattr(model, "all_dialogue_graph_ids", None)
    if callable(provider):
        try:
            ids.update(gid for raw in (provider() or []) if (gid := _safe_graph_id(raw)))
        except Exception:
            pass
    for attr in ("pending_dialogue_stubs", "pending_dialogue_graph_edits"):
        bag = getattr(model, attr, None)
        if not isinstance(bag, dict):
            continue
        for raw, graph in bag.items():
            gid = _safe_graph_id(raw)
            if gid and isinstance(graph, dict):
                ids.add(gid)
    ids.difference_update(
        _safe_graph_id(raw)
        for raw in getattr(model, "pending_dialogue_graph_deletes", set())
        if _safe_graph_id(raw)
    )
    return sorted(ids, key=lambda value: (value.casefold(), value))


def _load_disk_graph(model: Any, graph_id: str) -> dict | None:
    dialogues_path = getattr(model, "dialogues_path", None)
    if dialogues_path is None:
        return None
    path = Path(dialogues_path) / "graphs" / f"{graph_id}.json"
    loader = getattr(model, "_load", None)
    if callable(loader):
        try:
            value = loader(path, {})
            return value if isinstance(value, dict) else None
        except Exception:
            return None
    return None


def dialogue_graph_document(model: Any, graph_id: str) -> dict | None:
    gid = _safe_graph_id(graph_id)
    if not gid:
        return None
    if gid in getattr(model, "pending_dialogue_graph_deletes", set()):
        return None
    return _pending_graph(model, gid) or _load_disk_graph(model, gid)


def dialogue_graph_node_ids(model: Any, graph_id: str) -> list[str]:
    graph = dialogue_graph_document(model, graph_id)
    if graph is not None:
        nodes = graph.get("nodes")
        if not isinstance(nodes, dict):
            return []
        return sorted(
            (str(node_id) for node_id in nodes.keys()),
            key=lambda value: (value.casefold(), value),
        )
    provider = getattr(model, "dialogue_graph_node_ids", None)
    if callable(provider):
        try:
            return [str(value) for value in (provider(graph_id) or [])]
        except Exception:
            return []
    return []


def dialogue_graph_reference_rows(model: Any) -> list[tuple[str, str, str]]:
    """Rows for ``ReferencePickerField``: ID, title, and searchable context."""
    ids = dialogue_graph_ids(model)
    staged_signature: list[tuple[str, str, int, str, str]] = []
    for attr in ("pending_dialogue_graph_edits", "pending_dialogue_stubs"):
        bag = getattr(model, attr, None)
        if not isinstance(bag, dict):
            continue
        for raw_id, graph in bag.items():
            gid = _safe_graph_id(raw_id)
            if not gid or not isinstance(graph, dict):
                continue
            meta = graph.get("meta") if isinstance(graph.get("meta"), dict) else {}
            staged_signature.append((
                attr,
                gid,
                id(graph),
                str(meta.get("title") or graph.get("title") or ""),
                str(meta.get("scenarioId") or ""),
            ))
    deleted_signature = tuple(sorted(
        str(raw).strip() for raw in getattr(model, "pending_dialogue_graph_deletes", set())
        if str(raw).strip()
    ))
    signature = (tuple(ids), tuple(sorted(staged_signature)), deleted_signature)
    cached = getattr(model, "_dialogue_reference_rows_cache", None)
    if isinstance(cached, tuple) and len(cached) == 2 and cached[0] == signature:
        return list(cached[1])

    out: list[tuple[str, str, str]] = []
    for gid in ids:
        graph = dialogue_graph_document(model, gid) or {}
        meta = graph.get("meta") if isinstance(graph.get("meta"), dict) else {}
        title = str(meta.get("title") or graph.get("title") or gid).strip() or gid
        scenario = str(meta.get("scenarioId") or "").strip()
        staged = _pending_graph(model, gid) is not None
        details: list[str] = []
        if scenario:
            details.append(f"Scenario: {scenario}")
        if staged:
            details.append("ProjectModel 暂存（尚未 Save All）")
        out.append((gid, title, " · ".join(details)))
    try:
        setattr(model, "_dialogue_reference_rows_cache", (signature, tuple(out)))
    except Exception:
        pass
    return out


def clear_dialogue_graph_reference_cache(model: Any) -> None:
    try:
        delattr(model, "_dialogue_reference_rows_cache")
    except (AttributeError, TypeError):
        pass
