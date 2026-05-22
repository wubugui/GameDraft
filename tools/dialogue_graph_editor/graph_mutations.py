"""Shared dialogue graph JSON mutation helpers."""
from __future__ import annotations

from typing import Any

from .dialogue_topology import iter_output_slots, output_slot_for_spec


def connect_output_to_target(
    data: dict[str, Any],
    src_id: str,
    kind: str,
    index: int,
    dst_id: str,
) -> str | None:
    """Connect one output slot to a target node id."""
    if src_id == dst_id:
        return "cannot connect node to itself"
    nodes = data.get("nodes") or {}
    if src_id not in nodes:
        return "source node does not exist"
    raw = nodes[src_id]
    if not isinstance(raw, dict):
        return "invalid source node data"

    slot = output_slot_for_spec(raw, kind, index)
    if slot is None:
        return "invalid output port"
    slot.set_target(dst_id)
    return None


def clear_output(data: dict[str, Any], src_id: str, kind: str, index: int) -> str | None:
    """Clear one output slot target."""
    nodes = data.get("nodes") or {}
    if src_id not in nodes:
        return "node does not exist"
    raw = nodes[src_id]
    if not isinstance(raw, dict):
        return "invalid node data"

    slot = output_slot_for_spec(raw, kind, index)
    if slot is None:
        return "invalid output port"
    slot.clear_target()
    return None


def collect_incoming_refs(data: dict[str, Any], target_id: str) -> list[tuple[str, str, int, str]]:
    """List output slots that currently point to target_id."""
    out: list[tuple[str, str, int, str]] = []
    nodes = data.get("nodes") or {}
    for nid, raw in nodes.items():
        if not isinstance(raw, dict):
            continue
        for slot in iter_output_slots(raw):
            if slot.target == target_id:
                out.append((nid, slot.kind, slot.index, slot.label))
    return out


def rename_node_id(data: dict[str, Any], old_id: str, new_id: str) -> str | None:
    """Rename a node id and update all output-slot references plus entry."""
    nodes = data.get("nodes") or {}
    if old_id not in nodes:
        return "node to rename was not found"
    if new_id != old_id and new_id in nodes:
        return f"target id already exists: {new_id!r}"
    if old_id == new_id:
        return None
    blob = nodes.pop(old_id)
    nodes[new_id] = blob

    if str(data.get("entry", "") or "") == old_id:
        data["entry"] = new_id

    for raw in list(nodes.values()):
        if not isinstance(raw, dict):
            continue
        for slot in iter_output_slots(raw):
            if slot.target == old_id:
                slot.set_target(new_id)
    return None


def clear_incoming_to_node(data: dict[str, Any], target_id: str) -> None:
    """将所有指向 target_id 的出口清空。"""
    for src_id, kind, idx, _ in collect_incoming_refs(data, target_id):
        clear_output(data, src_id, kind, idx)
