"""Dialogue graph JSON topology helpers.

This module is the single place that knows how node JSON fields map to
connectable output slots. Canvas edge extraction and graph mutations both use
these slots, so adding a node output no longer requires updating several
parallel switch statements.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable

from .dialogue_ports import (
    OUT_CHOICE,
    OUT_CONTEXT_STATE_CASE,
    OUT_CONTEXT_STATE_DEFAULT,
    OUT_NEXT,
    OUT_OWNER_STATE_CASE,
    OUT_OWNER_STATE_DEFAULT,
    OUT_OWNER_STATE_MISSING,
    OUT_SWITCH_CASE,
    OUT_SWITCH_DEFAULT,
)


@dataclass
class DialogueOutputSlot:
    kind: str
    index: int
    label: str
    owner: dict[str, Any]
    field: str

    @property
    def target(self) -> str:
        return str(self.owner.get(self.field, "") or "")

    def set_target(self, target: str) -> None:
        self.owner[self.field] = target

    def clear_target(self) -> None:
        self.owner[self.field] = ""


@dataclass(frozen=True)
class FixedOutputSpec:
    kind: str
    index: int
    label: str
    field: str

    def slot(self, raw: dict[str, Any]) -> DialogueOutputSlot:
        return DialogueOutputSlot(self.kind, self.index, self.label, raw, self.field)


@dataclass(frozen=True)
class ListOutputSpec:
    kind: str
    collection_field: str
    target_field: str = "next"
    label_fields: tuple[str, ...] = ()
    fallback_label: str = "{index}"

    def slots(self, raw: dict[str, Any]) -> Iterable[DialogueOutputSlot]:
        collection = raw.get(self.collection_field)
        if not isinstance(collection, list):
            return
        for index, item in enumerate(collection):
            if not isinstance(item, dict):
                continue
            yield DialogueOutputSlot(
                self.kind,
                index,
                _short_label(self._label_for(item, index)),
                item,
                self.target_field,
            )

    def _label_for(self, item: dict[str, Any], index: int) -> str:
        for field in self.label_fields:
            label = str(item.get(field) or "").strip()
            if label:
                return label
        return self.fallback_label.format(index=index)


@dataclass(frozen=True)
class NodeOutputTopology:
    list_outputs: tuple[ListOutputSpec, ...] = ()
    fixed_outputs: tuple[FixedOutputSpec, ...] = ()

    def slots(self, raw: dict[str, Any]) -> Iterable[DialogueOutputSlot]:
        for spec in self.list_outputs:
            yield from spec.slots(raw)
        for spec in self.fixed_outputs:
            yield spec.slot(raw)


def _short_label(value: str) -> str:
    return value[:23] + "..." if len(value) > 26 else value


LINEAR_TOPOLOGY = NodeOutputTopology(
    fixed_outputs=(FixedOutputSpec(OUT_NEXT, 0, "next", "next"),),
)

TOPOLOGY_BY_NODE_TYPE: dict[str, NodeOutputTopology] = {
    "line": LINEAR_TOPOLOGY,
    "runActions": LINEAR_TOPOLOGY,
    "choice": NodeOutputTopology(
        list_outputs=(
            ListOutputSpec(
                OUT_CHOICE,
                "options",
                label_fields=("text", "id"),
                fallback_label="[{index}]",
            ),
        ),
    ),
    "switch": NodeOutputTopology(
        list_outputs=(
            ListOutputSpec(
                OUT_SWITCH_CASE,
                "cases",
                fallback_label="case{index}",
            ),
        ),
        fixed_outputs=(
            FixedOutputSpec(OUT_SWITCH_DEFAULT, -1, "else", "defaultNext"),
        ),
    ),
    "ownerState": NodeOutputTopology(
        list_outputs=(
            ListOutputSpec(
                OUT_OWNER_STATE_CASE,
                "cases",
                label_fields=("state",),
                fallback_label="state{index}",
            ),
        ),
        fixed_outputs=(
            FixedOutputSpec(OUT_OWNER_STATE_DEFAULT, -1, "default", "defaultNext"),
            FixedOutputSpec(OUT_OWNER_STATE_MISSING, -2, "missingWrapper", "missingWrapperNext"),
        ),
    ),
    "contextState": NodeOutputTopology(
        list_outputs=(
            ListOutputSpec(
                OUT_CONTEXT_STATE_CASE,
                "cases",
                label_fields=("state",),
                fallback_label="state{index}",
            ),
        ),
        fixed_outputs=(
            FixedOutputSpec(OUT_CONTEXT_STATE_DEFAULT, -1, "default", "defaultNext"),
        ),
    ),
}


def iter_output_slots(raw: dict[str, Any]) -> Iterable[DialogueOutputSlot]:
    topology = TOPOLOGY_BY_NODE_TYPE.get(str(raw.get("type") or ""))
    if topology is None:
        return ()
    return topology.slots(raw)


def output_slot_for_spec(raw: dict[str, Any], kind: str, index: int) -> DialogueOutputSlot | None:
    for slot in iter_output_slots(raw):
        if slot.kind == kind and slot.index == index:
            return slot
    return None
