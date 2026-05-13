"""从项目资源中收集策划可选项：对话选项的 requireFlag、ruleHintId 等。"""
from __future__ import annotations

import json
import re
from pathlib import Path


def _walk_collect_flags(obj: object, acc: set[str]) -> None:
    """从图对话 JSON 等结构化数据中收集 flag 键名。"""
    if isinstance(obj, dict):
        t = obj.get("type")
        if t in ("setFlag", "appendFlag"):
            p = obj.get("params")
            if isinstance(p, dict):
                k = p.get("key")
                if isinstance(k, str) and k.strip():
                    acc.add(k.strip())
        rf = obj.get("requireFlag")
        if isinstance(rf, str) and rf.strip():
            acc.add(rf.strip())
        flg = obj.get("flag")
        if isinstance(flg, str) and flg.strip() and "op" in obj:
            acc.add(flg.strip())
        for v in obj.values():
            _walk_collect_flags(v, acc)
    elif isinstance(obj, list):
        for it in obj:
            _walk_collect_flags(it, acc)


# scenes / data 等大量 JSON 用轻量扫描（与结构化 walk 互补）
_LOOSE_FLAG_RE = re.compile(
    r'"(?:requireFlag|flag)"\s*:\s*"([^"]+)"',
)


def collect_flag_key_suggestions(project_root: Path) -> list[str]:
    """汇总「可能作为 flagStore键」的字符串，供 requireFlag 下拉框使用。

    来源：graphs内结构化遍历；其余 assets 下 json 中 requireFlag / 条件 flag 字段的文本扫描。
    """
    keys: set[str] = set()
    graphs = project_root / "public" / "assets" / "dialogues" / "graphs"
    if graphs.is_dir():
        for p in graphs.glob("*.json"):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                continue
            _walk_collect_flags(data, keys)

    assets = project_root / "public" / "assets"
    graphs_resolved = graphs.resolve() if graphs.is_dir() else None
    if assets.is_dir():
        for p in assets.rglob("*.json"):
            if graphs_resolved is not None:
                try:
                    p.resolve().relative_to(graphs_resolved)
                except ValueError:
                    pass
                else:
                    continue
            try:
                text = p.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            keys.update(m.group(1).strip() for m in _LOOSE_FLAG_RE.finditer(text) if m.group(1).strip())

    return sorted(keys, key=lambda x: (x.lower(), x))


def load_rule_id_name_pairs(project_root: Path) -> list[tuple[str, str]]:
    """读取 rules.json 中规矩 id与展示名，供 ruleHintId 下拉（与 RulesManager.getRuleDef 一致）。"""
    p = project_root / "public" / "assets" / "data" / "rules.json"
    if not p.is_file():
        return []
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeDecodeError):
        return []
    rules = raw.get("rules")
    out: list[tuple[str, str]] = []
    if isinstance(rules, list):
        for r in rules:
            if isinstance(r, dict) and isinstance(r.get("id"), str):
                rid = r["id"].strip()
                if not rid:
                    continue
                name = str(r.get("name") or "").strip() or rid
                out.append((rid, name))
    return sorted(out, key=lambda x: (x[1].lower(), x[0].lower()))
