"""NPC / Hotspot 可存档运行时字段的编辑器镜像。

运行时权威在 `src/data/EntityRuntimeFieldSchema.ts`；这里保持同名字段与 picker，
让 Python 编辑器和 validator 不需要执行 TS 也能构建 UI 与校验手改 JSON。
"""

from __future__ import annotations

from typing import Any


RUNTIME_ENTITY_FIELD_SCHEMAS: dict[str, dict[str, dict[str, str]]] = {
    "npc": {
        "x": {"kind": "number", "picker": "plain", "apply": "position", "label": "x"},
        "y": {"kind": "number", "picker": "plain", "apply": "position", "label": "y"},
        "enabled": {"kind": "boolean", "picker": "plain", "apply": "visibility", "label": "enabled"},
        "animFile": {
            "kind": "string",
            "picker": "animationManifest",
            "apply": "reloadAnimation",
            "label": "animFile",
        },
        "initialAnimState": {
            "kind": "string",
            "picker": "animationState",
            "apply": "reloadAnimation",
            "label": "initialAnimState",
        },
        "animState": {
            "kind": "string",
            "picker": "animationState",
            "apply": "playAnimation",
            "label": "animState",
        },
        "patrolDisabled": {"kind": "boolean", "picker": "plain", "apply": "patrol", "label": "patrolDisabled"},
    },
    "hotspot": {
        "x": {"kind": "number", "picker": "plain", "apply": "position", "label": "x"},
        "y": {"kind": "number", "picker": "plain", "apply": "position", "label": "y"},
        "enabled": {"kind": "boolean", "picker": "plain", "apply": "visibility", "label": "enabled"},
        "displayImage": {
            "kind": "object",
            "picker": "hotspotDisplayImage",
            "apply": "reloadHotspotDisplayImage",
            "label": "displayImage",
        },
    },
}


def entity_kind_choices() -> list[tuple[str, str]]:
    return [("NPC", "npc"), ("Hotspot", "hotspot")]


def field_choices(kind: str) -> list[tuple[str, str]]:
    schema = RUNTIME_ENTITY_FIELD_SCHEMAS.get(kind, {})
    return [(f"{name} ({meta.get('kind', '')})", name) for name, meta in schema.items()]


def field_meta(kind: str, field_name: str) -> dict[str, str] | None:
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
