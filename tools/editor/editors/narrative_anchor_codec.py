"""Shared projection anchor id codec for the narrative editor."""
from __future__ import annotations

from urllib.parse import quote, unquote


TRANSITION_ANCHOR_PREFIX = "transition-anchor"


def _encode_part(value: object) -> str:
    return quote(str(value or "").strip(), safe="")


def _decode_part(value: str) -> str:
    try:
        return unquote(value)
    except Exception:
        return value


def transition_anchor_id(graph_id: str, transition_id: str) -> str:
    return f"{TRANSITION_ANCHOR_PREFIX}:{_encode_part(graph_id)}:{_encode_part(transition_id)}"


def parse_transition_anchor_id(anchor_id: str) -> tuple[str, str] | None:
    prefix, sep, rest = str(anchor_id or "").partition(":")
    if prefix != TRANSITION_ANCHOR_PREFIX or not sep:
        return None
    graph_raw, sep, transition_raw = rest.partition(":")
    if not sep:
        return None
    return _decode_part(graph_raw), _decode_part(transition_raw)
