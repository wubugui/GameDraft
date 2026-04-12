"""Load/save/validate dialogue graph JSON (matches `src/data/types.ts` DialogueGraphFile)."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


def graphs_dir(project_root: Path) -> Path:
    return project_root / "public" / "assets" / "dialogues" / "graphs"


def list_graph_files(project_root: Path) -> list[Path]:
    d = graphs_dir(project_root)
    if not d.is_dir():
        return []
    return sorted([p for p in d.glob("*.json") if p.is_file()], key=lambda p: p.name.lower())


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def save_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2)
    with path.open("w", encoding="utf-8", newline="\n") as f:
        f.write(text)
        if not text.endswith("\n"):
            f.write("\n")


def validate_graph(data: dict[str, Any]) -> list[str]:
    issues: list[str] = []
    nodes: dict[str, Any] = data.get("nodes") or {}
    if not isinstance(nodes, dict):
        return ["nodes 必须是对象"]

    if not str(data.get("id", "")).strip():
        issues.append("缺少顶层 id（建议与文件名一致）")

    entry = data.get("entry", "")
    if entry and entry not in nodes:
        issues.append(f"入口 entry 指向不存在的节点: {entry!r}")

    for nid, raw in nodes.items():
        if not isinstance(raw, dict):
            issues.append(f"节点 {nid!r} 不是对象")
            continue
        t = raw.get("type")
        if t not in ("line", "runActions", "choice", "switch", "end"):
            issues.append(f"节点 {nid!r} 未知 type: {t!r}")

        if t == "line":
            nx = raw.get("next", "")
            if nx and nx not in nodes:
                issues.append(f"节点 {nid}: next 指向不存在: {nx!r}")
        elif t == "runActions":
            nx = raw.get("next", "")
            if nx and nx not in nodes:
                issues.append(f"节点 {nid}: next 指向不存在: {nx!r}")
            acts = raw.get("actions")
            if not isinstance(acts, list):
                issues.append(f"节点 {nid}: runActions.actions 应为数组")
        elif t == "choice":
            opts = raw.get("options")
            if not isinstance(opts, list) or len(opts) == 0:
                issues.append(f"节点 {nid}: choice 至少需要一个选项")
            else:
                for i, opt in enumerate(opts):
                    if not isinstance(opt, dict):
                        issues.append(f"节点 {nid} 选项 {i} 不是对象")
                        continue
                    on = opt.get("next", "")
                    if on and on not in nodes:
                        issues.append(f"节点 {nid} 选项 {i} next 指向不存在: {on!r}")
        elif t == "switch":
            for i, c in enumerate(raw.get("cases") or []):
                if not isinstance(c, dict):
                    issues.append(f"节点 {nid} case {i} 不是对象")
                    continue
                cn = c.get("next", "")
                if cn and cn not in nodes:
                    issues.append(f"节点 {nid} case {i} next 指向不存在: {cn!r}")
            dn = raw.get("defaultNext", "")
            if dn and dn not in nodes:
                issues.append(f"节点 {nid}: defaultNext 指向不存在: {dn!r}")
        elif t == "end":
            pass

    return issues


_SAFE_ID_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def suggest_next_id(nodes: dict[str, Any], prefix: str = "n") -> str:
    max_n = 0
    for k in nodes:
        m = re.match(r"^" + re.escape(prefix) + r"_(\d+)$", k)
        if m:
            max_n = max(max_n, int(m.group(1)))
    return f"{prefix}_{max_n + 1}"


def default_node(node_type: str, nodes: dict[str, Any]) -> dict[str, Any]:
    """Create a new node dict for the given type."""
    placeholder_next = next(iter(nodes), "") if nodes else ""

    if node_type == "line":
        return {
            "type": "line",
            "speaker": {"kind": "player"},
            "text": "",
            "next": placeholder_next,
        }
    if node_type == "runActions":
        return {"type": "runActions", "actions": [], "next": placeholder_next}
    if node_type == "choice":
        return {
            "type": "choice",
            "options": [
                {"id": "a", "text": "选项甲", "next": placeholder_next},
            ],
        }
    if node_type == "switch":
        return {
            "type": "switch",
            "cases": [],
            "defaultNext": placeholder_next,
        }
    if node_type == "end":
        return {"type": "end"}
    raise ValueError(node_type)
