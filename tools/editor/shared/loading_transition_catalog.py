"""Read the runtime's loading-transition catalogue without mirroring its IDs."""
from __future__ import annotations

import json
from pathlib import Path


def loading_transition_choices() -> list[tuple[str, str]]:
    """Return ``(id, label)`` rows in the authored catalogue order."""
    path = Path(__file__).resolve().parents[3] / "src" / "data" / "loadingTransitions.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or not raw:
        raise ValueError("loadingTransitions.json must contain a non-empty object")
    rows: list[tuple[str, str]] = []
    for kind, definition in raw.items():
        if not isinstance(kind, str) or not kind or not isinstance(definition, dict):
            raise ValueError(f"Invalid loading transition definition: {kind!r}")
        label = definition.get("label")
        if not isinstance(label, str) or not label.strip():
            raise ValueError(f"Loading transition {kind!r} must have a label")
        rows.append((kind, label))
    return rows
