"""Load flag_registry.json and validate flag keys (editor / CI)."""
from __future__ import annotations

from pathlib import Path
from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    from .project_model import ProjectModel


def flag_registry_path(assets_path: Path) -> Path:
    return assets_path / "data" / "flag_registry.json"


def normalize_registry_value_type(raw: object) -> str:
    """Registry stores 'bool' | 'float' | 'string'. Legacy 'int' == 'float'; 'str' == 'string'."""
    if raw == "float" or raw == "int":
        return "float"
    if raw == "string" or raw == "str":
        return "string"
    return "bool"


def _migrate_flag_registry_in_place(data: dict[str, Any]) -> None:
    """Normalize static to [{key, valueType}, ...]. Strips legacy staticValueTypes / parallel staticTypes map."""
    data.pop("staticValueTypes", None)
    raw = data.get("static")
    parallel = data.pop("staticTypes", None)
    parallel_types = parallel if isinstance(parallel, dict) else {}

    if not isinstance(raw, list):
        data["static"] = []
        return

    norm: list[dict[str, str]] = []
    for e in raw:
        if isinstance(e, str):
            k = e.strip()
            if not k:
                continue
            vt = normalize_registry_value_type(parallel_types.get(k, "bool"))
            norm.append({"key": k, "valueType": vt})
        elif isinstance(e, dict):
            k = str(e.get("key", "")).strip()
            if not k:
                continue
            vt_raw = e.get("valueType")
            if vt_raw is None and k in parallel_types:
                vt_raw = parallel_types[k]
            vt = normalize_registry_value_type(vt_raw)
            norm.append({"key": k, "valueType": vt})
    data["static"] = norm


def static_key_set(registry: dict[str, Any]) -> set[str]:
    out: set[str] = set()
    for e in registry.get("static") or []:
        if isinstance(e, dict):
            k = e.get("key")
            if isinstance(k, str) and k:
                out.add(k)
        elif isinstance(e, str) and e:
            out.add(e)
    return out


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
                if k not in data:
                    data[k] = v
            _migrate_flag_registry_in_place(data)
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


def _book_page_entry_ids(model: ProjectModel) -> set[str]:
    out: set[str] = set()
    for b in model.archive_books:
        if not isinstance(b, dict):
            continue
        for pg in b.get("pages") or []:
            if not isinstance(pg, dict):
                continue
            for ent in pg.get("entries") or []:
                if isinstance(ent, dict) and ent.get("id"):
                    out.add(str(ent["id"]))
    return out


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
        "archive_book_entry": _book_page_entry_ids(model),
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


def ids_for_registry_pattern_source(
    model: ProjectModel,
    *,
    scene_id: str | None,
    id_source: str | None,
) -> list[str]:
    """ID list for one registry pattern idSource (editor UI + expand)."""
    if not id_source:
        return []
    ids_map = build_id_sets(model)
    all_hotspots = _all_hotspot_ids(model)
    if id_source == "hotspot_in_scene":
        if scene_id and scene_id in model.scenes:
            return sorted(_hotspot_ids_in_scene(model, scene_id))
        return sorted(all_hotspots)
    if id_source == "hotspot_any_scene":
        return sorted(all_hotspots)
    if id_source in ids_map:
        return sorted(ids_map[id_source])
    return []


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
    for e in registry.get("static") or []:
        if isinstance(e, dict):
            k = e.get("key")
            if isinstance(k, str) and k:
                out.add(k)
        elif isinstance(e, str) and e:
            out.add(e)
    for p in registry.get("patterns") or []:
        if not isinstance(p, dict):
            continue
        prefix = p.get("prefix") or ""
        suf = p.get("suffix")
        suffix = suf if suf else ""
        src = p.get("idSource")
        id_list = ids_for_registry_pattern_source(model, scene_id=scene_id, id_source=src)
        if not id_list and src:
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
    static = static_key_set(registry)
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


def registry_value_type_for_key(key: str, registry: dict[str, Any] | None) -> str | None:
    """若 key 命中 static 或某条 pattern，返回规范化后的 'bool'|'float'|'string'；否则 None。"""
    if not key or not isinstance(key, str):
        return None
    r = registry or {}
    for e in r.get("static") or []:
        if isinstance(e, dict) and e.get("key") == key:
            return normalize_registry_value_type(e.get("valueType"))
    for p in r.get("patterns") or []:
        if not isinstance(p, dict):
            continue
        prefix = p.get("prefix") or ""
        suf = p.get("suffix")
        suffix = suf if suf else None
        if _extract_pattern_id(key, prefix, suffix) is None:
            continue
        return normalize_registry_value_type(p.get("valueType"))
    return None


def flag_value_type_for_key(key: str, registry: dict[str, Any] | None) -> str:
    """Return 'bool' | 'float' | 'string' for editor FlagValueEdit（未登记则默认 bool）。"""
    return registry_value_type_for_key(key, registry) or "bool"


def flag_registry_static_format_issues(registry: dict[str, Any]) -> list[str]:
    """Validate static[] entries: unique keys, required valueType."""
    issues: list[str] = []
    seen: set[str] = set()
    for i, e in enumerate(registry.get("static") or []):
        if isinstance(e, str):
            issues.append(f"static[{i}] 仍为旧格式字符串，请保存登记表以迁移")
            continue
        if not isinstance(e, dict):
            issues.append(f"static[{i}] 不是对象")
            continue
        k = e.get("key")
        if not isinstance(k, str) or not k.strip():
            issues.append(f"static[{i}] 缺少 key")
            continue
        k = k.strip()
        if k in seen:
            issues.append(f"static 重复 key: {k!r}")
        seen.add(k)
        vt = e.get("valueType")
        if vt not in ("bool", "float", "int", "string", "str"):
            issues.append(f"static {k!r} 的 valueType 无效或缺失")
    return issues


def validate_flag_key_loose(key: str, registry: dict[str, Any]) -> bool:
    """Match static or any pattern prefix/suffix without id check (Ink/global)."""
    if not key:
        return False
    if key in static_key_set(registry):
        return True
    for p in registry.get("patterns") or []:
        if not isinstance(p, dict):
            continue
        pre = p.get("prefix") or ""
        suf = p.get("suffix")
        if _pattern_matches(key, pre, suf):
            return True
    return False
