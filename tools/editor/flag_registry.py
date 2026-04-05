"""Load flag_registry.json and validate flag keys (editor / CI)."""
from __future__ import annotations

from pathlib import Path
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from .project_model import ProjectModel


def flag_registry_path(assets_path: Path) -> Path:
    return assets_path / "data" / "flag_registry.json"


def load_flag_registry(path: Path) -> dict[str, Any]:
    default: dict[str, Any] = {
        "static": [],
        "patterns": [],
        "migrations": {},
        "runtime": {},
    }
    if not path.exists():
        return default
    try:
        from .file_io import read_json
        data = read_json(path)
        if isinstance(data, dict):
            for k, v in default.items():
                data.setdefault(k, v)
            return data
    except Exception:
        pass
    return default


def _extract_pattern_id(key: str, prefix: str, suffix: str | None) -> str | None:
    if not key.startswith(prefix):
        return None
    rest = key[len(prefix):]
    if suffix:
        if not rest.endswith(suffix):
            return None
        rest = rest[: -len(suffix)]
    return rest if rest else None


def _pattern_matches(key: str, prefix: str, suffix: str | None) -> bool:
    return _extract_pattern_id(key, prefix, suffix) is not None


def build_id_sets(model: ProjectModel) -> dict[str, set[str]]:
    rules = model.rules_data.get("rules", [])
    fragments = model.rules_data.get("fragments", [])
    lore_entries = model.archive_lore
    if isinstance(lore_entries, dict):
        lore_entries = lore_entries.get("entries", [])
    lore_ids = {e["id"] for e in lore_entries if isinstance(e, dict) and "id" in e}
    return {
        "rule": {r["id"] for r in rules if isinstance(r, dict) and "id" in r},
        "fragment": {f["id"] for f in fragments if isinstance(f, dict) and "id" in f},
        "quest": {q["id"] for q in model.quests if isinstance(q, dict) and "id" in q},
        "item": {it["id"] for it in model.items if isinstance(it, dict) and "id" in it},
        "encounter": {e["id"] for e in model.encounters if isinstance(e, dict) and "id" in e},
        "cutscene": {c["id"] for c in model.cutscenes if isinstance(c, dict) and "id" in c},
        "archive_character": {c["id"] for c in model.archive_characters if isinstance(c, dict) and "id" in c},
        "archive_lore": lore_ids,
        "archive_document": {d["id"] for d in model.archive_documents if isinstance(d, dict) and "id" in d},
        "archive_book": {b["id"] for b in model.archive_books if isinstance(b, dict) and "id" in b},
    }


def _all_hotspot_ids(model: ProjectModel) -> set[str]:
    out: set[str] = set()
    for sc in model.scenes.values():
        for hs in sc.get("hotspots", []) or []:
            hid = hs.get("id")
            if hid:
                out.add(str(hid))
    return out


def _hotspot_ids_in_scene(model: ProjectModel, scene_id: str) -> set[str]:
    sc = model.scenes.get(scene_id) or {}
    return {str(hs["id"]) for hs in (sc.get("hotspots") or []) if hs.get("id")}


def expand_registry_flag_keys(
    registry: dict[str, Any],
    model: ProjectModel,
    *,
    scene_id: str | None,
) -> list[str]:
    """All flag keys allowed by registry static + patterns expanded with current project ids.

    Used by editor pickers only; aligns with validate_flag_key (per-scene hotspot when applicable).
    """
    out: set[str] = set()
    for s in registry.get("static") or []:
        if isinstance(s, str) and s:
            out.add(s)
    ids = build_id_sets(model)
    all_hotspots = _all_hotspot_ids(model)

    for p in registry.get("patterns") or []:
        if not isinstance(p, dict):
            continue
        prefix = p.get("prefix") or ""
        suf = p.get("suffix")
        suffix = suf if suf else ""
        src = p.get("idSource")
        id_list: list[str] = []
        if src == "hotspot_in_scene":
            if scene_id and scene_id in model.scenes:
                id_list = sorted(_hotspot_ids_in_scene(model, scene_id))
            else:
                id_list = sorted(all_hotspots)
        elif src == "hotspot_any_scene":
            id_list = sorted(all_hotspots)
        elif src in ids:
            id_list = sorted(ids[src])
        elif not src:
            continue
        else:
            continue
        for rid in id_list:
            out.add(f"{prefix}{rid}{suffix}")
    return sorted(out)


def validate_flag_key(
    key: str,
    registry: dict[str, Any],
    model: ProjectModel,
    *,
    scene_id: str | None,
    severity: str = "warning",
) -> tuple[bool, str | None]:
    """Return (ok, message_if_bad)."""
    if not key or not isinstance(key, str):
        return False, "empty flag key"
    static: set[str] = set(registry.get("static") or [])
    if key in static:
        return True, None
    ids = build_id_sets(model)
    all_hotspots = _all_hotspot_ids(model)

    for p in registry.get("patterns") or []:
        if not isinstance(p, dict):
            continue
        prefix = p.get("prefix") or ""
        suffix = p.get("suffix")
        src = p.get("idSource")
        rid = _extract_pattern_id(key, prefix, suffix if suffix else None)
        if rid is None:
            continue
        if src == "hotspot_in_scene":
            if scene_id:
                if rid in _hotspot_ids_in_scene(model, scene_id):
                    return True, None
            elif rid in all_hotspots:
                return True, None
            return False, f"flag '{key}' hotspot id not in scene"
        if src == "hotspot_any_scene":
            if rid in all_hotspots:
                return True, None
            return False, f"flag '{key}' hotspot id not found in any scene"
        if src in ids:
            if rid in ids[src]:
                return True, None
            return False, f"flag '{key}' unknown {src} id '{rid}'"
        if src:
            return False, f"flag '{key}' unknown idSource '{src}' in registry"
    return False, f"flag '{key}' not in registry static/patterns ({severity})"


def validate_flag_key_loose(key: str, registry: dict[str, Any]) -> bool:
    """Match static or any pattern prefix/suffix without id check (Ink/global)."""
    if not key:
        return False
    if key in set(registry.get("static") or []):
        return True
    for p in registry.get("patterns") or []:
        if not isinstance(p, dict):
            continue
        pre = p.get("prefix") or ""
        suf = p.get("suffix")
        if _pattern_matches(key, pre, suf):
            return True
    return False
