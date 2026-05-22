"""Dialogue graph output port contract shared by canvas rendering and mutations."""
from __future__ import annotations

from dataclasses import dataclass

OUT_NEXT = "next"
OUT_CHOICE = "choice_opt"
OUT_SWITCH_CASE = "switch_case"
OUT_SWITCH_DEFAULT = "switch_default"
OUT_OWNER_STATE_CASE = "owner_state_case"
OUT_OWNER_STATE_DEFAULT = "owner_state_default"
OUT_OWNER_STATE_MISSING = "owner_state_missing"
OUT_CONTEXT_STATE_CASE = "context_state_case"
OUT_CONTEXT_STATE_DEFAULT = "context_state_default"

PN_NEXT = "p_next"
PN_SWITCH_DEFAULT = "p_sd"
PN_OWNER_STATE_DEFAULT = "p_od"
PN_OWNER_STATE_MISSING = "p_om"
PN_CONTEXT_STATE_DEFAULT = "p_xd"


@dataclass(frozen=True)
class IndexedPortFamily:
    kind: str
    prefix: str

    def name(self, index: int) -> str:
        return f"{self.prefix}{index}"

    def parse_index(self, port_name: str) -> int | None:
        if not port_name.startswith(self.prefix):
            return None
        suffix = port_name[len(self.prefix) :]
        if not suffix.isdigit():
            return None
        return int(suffix)


CHOICE_PORTS = IndexedPortFamily(OUT_CHOICE, "p_c")
SWITCH_CASE_PORTS = IndexedPortFamily(OUT_SWITCH_CASE, "p_s")
OWNER_STATE_CASE_PORTS = IndexedPortFamily(OUT_OWNER_STATE_CASE, "p_o")
CONTEXT_STATE_CASE_PORTS = IndexedPortFamily(OUT_CONTEXT_STATE_CASE, "p_x")

FIXED_PORT_SPECS: dict[str, tuple[str, int]] = {
    PN_NEXT: (OUT_NEXT, 0),
    PN_SWITCH_DEFAULT: (OUT_SWITCH_DEFAULT, -1),
    PN_OWNER_STATE_DEFAULT: (OUT_OWNER_STATE_DEFAULT, -1),
    PN_OWNER_STATE_MISSING: (OUT_OWNER_STATE_MISSING, -2),
    PN_CONTEXT_STATE_DEFAULT: (OUT_CONTEXT_STATE_DEFAULT, -1),
}

FIXED_SPEC_PORTS: dict[tuple[str, int], str] = {
    spec: port_name for port_name, spec in FIXED_PORT_SPECS.items()
}

INDEXED_PORTS_BY_KIND: dict[str, IndexedPortFamily] = {
    family.kind: family
    for family in (
        CHOICE_PORTS,
        SWITCH_CASE_PORTS,
        OWNER_STATE_CASE_PORTS,
        CONTEXT_STATE_CASE_PORTS,
    )
}


def pn_choice(index: int) -> str:
    return CHOICE_PORTS.name(index)


def pn_switch_case(index: int) -> str:
    return SWITCH_CASE_PORTS.name(index)


def pn_owner_state_case(index: int) -> str:
    return OWNER_STATE_CASE_PORTS.name(index)


def pn_context_state_case(index: int) -> str:
    return CONTEXT_STATE_CASE_PORTS.name(index)


def port_name_for_spec(kind: str, index: int) -> str | None:
    fixed = FIXED_SPEC_PORTS.get((kind, index))
    if fixed is not None:
        return fixed
    family = INDEXED_PORTS_BY_KIND.get(kind)
    if family is None or index < 0:
        return None
    return family.name(index)


def parse_dialogue_out_port(port_name: str) -> tuple[str, int] | None:
    fixed = FIXED_PORT_SPECS.get(port_name)
    if fixed is not None:
        return fixed
    for family in INDEXED_PORTS_BY_KIND.values():
        index = family.parse_index(port_name)
        if index is not None:
            return family.kind, index
    return None
