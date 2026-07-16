"""NPC / Hotspot persistent runtime-field schema for editor UI and validation.

The shared schema lives at ``public/assets/data/runtime_field_schema.json`` and is also
used by the TypeScript runtime. Keep Python behavior here limited to loading
that schema and validating values against it.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def _schema_path() -> Path:
    return Path(__file__).resolve().parents[3] / "public" / "assets" / "data" / "runtime_field_schema.json"


def _load_schema() -> dict[str, dict[str, dict[str, Any]]]:
    with _schema_path().open("r", encoding="utf-8") as f:
        raw = json.load(f)
    if not isinstance(raw, dict):
        raise ValueError("runtime_field_schema.json must contain an object")
    return raw


RUNTIME_ENTITY_FIELD_SCHEMAS: dict[str, dict[str, dict[str, Any]]] = _load_schema()


def entity_kind_choices() -> list[tuple[str, str]]:
    return [("NPC", "npc"), ("Hotspot", "hotspot")]


def field_choices(kind: str) -> list[tuple[str, str]]:
    schema = RUNTIME_ENTITY_FIELD_SCHEMAS.get(kind, {})
    return [(f"{name} ({meta.get('kind', '')})", name) for name, meta in schema.items()]


def field_meta(kind: str, field_name: str) -> dict[str, Any] | None:
    return RUNTIME_ENTITY_FIELD_SCHEMAS.get(kind, {}).get(field_name)


def is_valid_field(kind: str, field_name: str) -> bool:
    return field_name in RUNTIME_ENTITY_FIELD_SCHEMAS.get(kind, {})


def value_matches_field(kind: str, field_name: str, value: Any) -> bool:
    meta = field_meta(kind, field_name)
    if not meta:
        return False
    k = meta.get("kind")
    if value is None:
        return True
    if k == "string":
        return isinstance(value, str) and bool(value.strip())
    if k == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if k == "boolean":
        return isinstance(value, bool)
    if k == "object" and field_name == "displayImage":
        if not isinstance(value, dict):
            return False
        return (
            isinstance(value.get("image"), str)
            and bool(str(value.get("image")).strip())
            and isinstance(value.get("worldWidth"), (int, float))
            and not isinstance(value.get("worldWidth"), bool)
            and float(value.get("worldWidth")) > 0
            and isinstance(value.get("worldHeight"), (int, float))
            and not isinstance(value.get("worldHeight"), bool)
            and float(value.get("worldHeight")) > 0
        )
    return isinstance(value, dict)
