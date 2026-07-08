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
    """文件不存在 → 空默认表（新工程合法）；文件存在但损坏 → **必须抛错**。
    旧实现吞掉解析异常静默回落空表：用户在 Flags 页做任一编辑并 Save All，
    就会用近空结构覆写原登记表（审查 P1-31）。现在损坏文件让 load_project
    失败并整体回滚，用户先修文件再开工程。"""
    default: dict[str, Any] = {
        "static": [],
        "patterns": [],
        "migrations": {},
        "runtime": {},
    }
    if not path.exists():
        return default
    from .file_io import read_json
    try:
        data = read_json(path)
    except Exception as e:
        raise ValueError(f"flag_registry.json 无法读取/解析（修复后再打开工程）：{e}") from e
    if not isinstance(data, dict):
        raise ValueError("flag_registry.json 根必须是对象（修复后再打开工程）")
    for k, v in default.items():
        if k not in data:
            data[k] = v
    _migrate_flag_registry_in_place(data)
    return data


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

    # 按前缀长度降序：最长（最具体）前缀优先，且任一匹配 pattern 通过即接受——
    # 否则 `archive_book_` 会先匹配并吞掉合法的 `archive_book_entry_xxx`（rid 被切成
    # `entry_xxx` 去比对书籍 id → 误报 unknown archive_book id，审查 P2-34）。
    matched: list[tuple[int, dict, str]] = []
    for p in registry.get("patterns") or []:
        if not isinstance(p, dict):
            continue
        prefix = p.get("prefix") or ""
        suffix = p.get("suffix")
        rid0 = _extract_pattern_id(key, prefix, suffix if suffix else None)
        if rid0 is None:
            continue
        matched.append((len(str(prefix)), p, rid0))
    matched.sort(key=lambda t: t[0], reverse=True)
    last_fail: str | None = None
    for _plen, p, rid in matched:
        src = p.get("idSource")
        if src == "hotspot_in_scene":
            if scene_id and rid in _hotspot_ids_in_scene(model, scene_id):
                return True, None
            if not scene_id and rid in all_hotspots:
                return True, None
            last_fail = f"flag '{key}' hotspot id not in scene"
        elif src == "hotspot_any_scene":
            if rid in all_hotspots:
                return True, None
            last_fail = f"flag '{key}' hotspot id not found in any scene"
        elif src in ids:
            if rid in ids[src]:
                return True, None
            last_fail = f"flag '{key}' unknown {src} id '{rid}'"
        elif src:
            last_fail = f"flag '{key}' unknown idSource '{src}' in registry"
    if last_fail is not None:
        return False, last_fail
    return False, f"flag '{key}' not in registry static/patterns ({severity})"


def _scenario_expose_value_type_error(vt: str | None, val: object) -> str | None:
    """值与登记表 valueType 不一致时返回错误片段，否则 None。"""
    if isinstance(val, (dict, list)):
        return f"值不能为对象或数组，当前为 {type(val).__name__}"
    if vt == "string":
        if isinstance(val, str):
            return None
        return f"在登记表中为 string，值须为 JSON 字符串，当前为 {type(val).__name__}"
    if vt == "float":
        if isinstance(val, bool):
            return "在登记表中为数值，值不能为 JSON 布尔（与数字混淆）"
        if isinstance(val, (int, float)):
            return None
        return f"在登记表中为数值，值须为 JSON 数字，当前为 {type(val).__name__}"
    if isinstance(val, bool):
        return None
    return f"在登记表中为 bool，值须为 JSON true/false，当前为 {type(val).__name__}"


def scenario_exposes_flag_errors(
    exposes: object,
    registry: dict[str, Any],
    model: "ProjectModel",
    *,
    scenario_id: str,
) -> str | None:
    """若 exposes 键不在登记表或值的 JSON 类型与 valueType 不符，返回错误文案；否则 None。"""
    if not isinstance(exposes, dict) or not exposes:
        return None
    if not registry:
        return None
    sid = str(scenario_id).strip()
    for fk, fv in exposes.items():
        key = str(fk).strip()
        if not key:
            return f"{sid!r} 的 exposes 中存在空的 flag 键名"
        ok, msg = validate_flag_key(key, registry, model, scene_id=None, severity="error")
        if not ok and msg:
            return f"{sid!r} 的 exposes：{msg}"
        vt = registry_value_type_for_key(key, registry)
        verr = _scenario_expose_value_type_error(vt, fv)
        if verr:
            return f"{sid!r} 的 exposes 中 flag {key!r} {verr}"
    return None


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
    """Match static or any pattern prefix/suffix without id check（全局）。"""
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
