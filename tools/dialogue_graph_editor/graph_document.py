"""Load/save/validate dialogue graph JSON (matches `src/data/types.ts` DialogueGraphFile)."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from .graph_mutations import (
    OUT_CHOICE,
    OUT_NEXT,
    OUT_SWITCH_CASE,
    OUT_SWITCH_DEFAULT,
)


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
    """先写入同目录 .tmp，再 replace 目标文件，避免写入中断导致原 JSON 截断损坏。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if not text.endswith("\n"):
        text += "\n"
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    try:
        with tmp_path.open("w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    except OSError:
        try:
            if tmp_path.is_file():
                tmp_path.unlink()
        except OSError:
            pass
        raise
    try:
        tmp_path.replace(path)
    except OSError:
        # 已完整写入 .tmp；replace 失败时保留临时文件便于手工恢复，原 path 未被覆盖
        raise


def extract_flow_edges(nodes: dict[str, Any]) -> list[tuple[str, str, str]]:
    """有向边 (源节点 id, 目标节点 id, 连线标签)。仅用于编辑器画布，与校验逻辑一致。"""
    edges: list[tuple[str, str, str]] = []
    for nid, raw in nodes.items():
        if not isinstance(raw, dict):
            continue
        t = raw.get("type")
        if t in ("line", "runActions"):
            nx = str(raw.get("next", "") or "")
            if nx:
                edges.append((nid, nx, "next"))
        elif t == "choice":
            for i, opt in enumerate(raw.get("options") or []):
                if not isinstance(opt, dict):
                    continue
                nxt = str(opt.get("next", "") or "")
                if not nxt:
                    continue
                label = str(opt.get("text") or opt.get("id") or f"[{i}]")
                if len(label) > 26:
                    label = label[:23] + "…"
                edges.append((nid, nxt, label))
        elif t == "switch":
            for i, c in enumerate(raw.get("cases") or []):
                if not isinstance(c, dict):
                    continue
                nxt = str(c.get("next", "") or "")
                if nxt:
                    edges.append((nid, nxt, f"case{i}"))
            dn = str(raw.get("defaultNext", "") or "")
            if dn:
                edges.append((nid, dn, "else"))
    return edges


def extract_flow_edges_detailed(
    nodes: dict[str, Any],
) -> list[tuple[str, str, str, str, int]]:
    """(源, 目标, 标签, out_kind, index)；index 对 default 为 -1。"""
    edges: list[tuple[str, str, str, str, int]] = []
    for nid, raw in nodes.items():
        if not isinstance(raw, dict):
            continue
        t = raw.get("type")
        if t in ("line", "runActions"):
            nx = str(raw.get("next", "") or "")
            if nx:
                edges.append((nid, nx, "next", OUT_NEXT, 0))
        elif t == "choice":
            for i, opt in enumerate(raw.get("options") or []):
                if not isinstance(opt, dict):
                    continue
                nxt = str(opt.get("next", "") or "")
                if not nxt:
                    continue
                label = str(opt.get("text") or opt.get("id") or f"[{i}]")
                if len(label) > 26:
                    label = label[:23] + "…"
                edges.append((nid, nxt, label, OUT_CHOICE, i))
        elif t == "switch":
            for i, c in enumerate(raw.get("cases") or []):
                if not isinstance(c, dict):
                    continue
                nxt = str(c.get("next", "") or "")
                if nxt:
                    edges.append((nid, nxt, f"case{i}", OUT_SWITCH_CASE, i))
            dn = str(raw.get("defaultNext", "") or "")
            if dn:
                edges.append((nid, dn, "else", OUT_SWITCH_DEFAULT, -1))
    return edges


def auto_layout_node_positions(
    nodes: dict[str, Any],
    entry: str,
    *,
    x_spacing: float = 260.0,
    y_spacing: float = 120.0,
    avoid_rects: list[tuple[float, float, float, float]] | None = None,
) -> dict[str, tuple[float, float]]:
    """按拓扑 BFS 分层：X=层号（沿流程从左到右），Y=同层内分支上下错开。

    旧实现把「层」画在 Y 轴、每层仅横向展开，线性图会变成整列竖条；现改为常见流程图阅读方向。
    从 entry 做 BFS；不可从 entry 到达的节点放到最右侧一列（仍按 id 纵向排列）。
    若无合法 entry，则从所有入度为 0 的节点多源 BFS。
    """
    from collections import defaultdict, deque

    if not nodes:
        return {}

    edges = extract_flow_edges(nodes)
    out_adj: dict[str, list[str]] = defaultdict(list)
    in_deg: dict[str, int] = defaultdict(int)
    for s, d, _ in edges:
        if s in nodes and d in nodes:
            out_adj[s].append(d)
            in_deg[d] += 1
    for nid in nodes:
        in_deg.setdefault(nid, 0)

    roots = [n for n in nodes if in_deg.get(n, 0) == 0]
    seeds: list[str] = []
    ent = str(entry or "").strip()
    if ent in nodes:
        seeds = [ent]
    elif roots:
        seeds = sorted(roots, key=lambda x: (x.lower(), x))
    else:
        seeds = [sorted(nodes.keys(), key=lambda x: (x.lower(), x))[0]]

    dist: dict[str, int] = {}
    dq = deque()
    for s in seeds:
        if s in nodes and s not in dist:
            dist[s] = 0
            dq.append(s)
    while dq:
        u = dq.popleft()
        for v in out_adj.get(u, ()):
            if v in nodes and v not in dist:
                dist[v] = dist[u] + 1
                dq.append(v)

    max_d = max(dist.values(), default=0)
    orphan_x = max_d + 2
    layers: dict[int, list[str]] = defaultdict(list)
    for nid in nodes:
        d = dist[nid] if nid in dist else orphan_x
        layers[d].append(nid)

    pos: dict[str, tuple[float, float]] = {}
    for layer_key in sorted(layers.keys()):
        row = sorted(layers[layer_key], key=lambda x: (x.lower(), x))
        for i, nid in enumerate(row):
            pos[nid] = (float(layer_key) * x_spacing, float(i) * y_spacing)
    if avoid_rects:
        from .editor_group_geometry import nudge_node_positions_avoid_rects

        nudge_node_positions_avoid_rects(pos, nodes, avoid_rects)
    return pos


def _validate_line_beats(nid: str, raw: dict[str, Any], errors: list[str]) -> None:
    lines = raw.get("lines")
    if lines is None:
        return
    if not isinstance(lines, list):
        errors.append(f"节点 {nid}: line.lines 必须是数组")
        return
    if len(lines) == 0:
        errors.append(f"节点 {nid}: line.lines 至少含一条台词")
        return
    for i, beat in enumerate(lines):
        if not isinstance(beat, dict):
            errors.append(f"节点 {nid} lines[{i}] 不是对象")
            continue
        sp = beat.get("speaker")
        if not isinstance(sp, dict):
            errors.append(f"节点 {nid} lines[{i}] 缺少 speaker 对象")


def validate_graph_tiered(data: dict[str, Any]) -> tuple[list[str], list[str]]:
    """(errors, warnings)：errors 阻止保存；warnings 可提示后仍保存。"""
    errors: list[str] = []
    warnings: list[str] = []
    nodes: dict[str, Any] = data.get("nodes") or {}
    if not isinstance(nodes, dict):
        return (["nodes 必须是对象"], [])

    if not str(data.get("id", "")).strip():
        warnings.append("缺少顶层 id（建议与文件名一致）")

    entry = data.get("entry", "")
    if entry and entry not in nodes:
        errors.append(f"入口 entry 指向不存在的节点: {entry!r}")

    for nid, raw in nodes.items():
        if not isinstance(raw, dict):
            errors.append(f"节点 {nid!r} 不是对象")
            continue
        t = raw.get("type")
        if t not in ("line", "runActions", "choice", "switch", "end"):
            errors.append(f"节点 {nid!r} 未知 type: {t!r}")

        if t == "line":
            nx = raw.get("next", "")
            if nx and nx not in nodes:
                errors.append(f"节点 {nid}: next 指向不存在: {nx!r}")
            _validate_line_beats(nid, raw, errors)
        elif t == "runActions":
            nx = raw.get("next", "")
            if nx and nx not in nodes:
                errors.append(f"节点 {nid}: next 指向不存在: {nx!r}")
            acts = raw.get("actions")
            if not isinstance(acts, list):
                errors.append(f"节点 {nid}: runActions.actions 应为数组")
        elif t == "choice":
            opts = raw.get("options")
            if not isinstance(opts, list) or len(opts) == 0:
                errors.append(f"节点 {nid}: choice 至少需要一个选项")
            else:
                seen_opt: set[str] = set()
                for i, opt in enumerate(opts):
                    if not isinstance(opt, dict):
                        errors.append(f"节点 {nid} 选项 {i} 不是对象")
                        continue
                    on = opt.get("next", "")
                    if on and on not in nodes:
                        errors.append(f"节点 {nid} 选项 {i} next 指向不存在: {on!r}")
                    oid = str(opt.get("id", "") or "")
                    if oid and oid in seen_opt:
                        warnings.append(f"节点 {nid}: 选项 id 重复 {oid!r}")
                    if oid:
                        seen_opt.add(oid)
        elif t == "switch":
            cases = raw.get("cases") or []
            if isinstance(cases, list) and len(cases) == 0:
                warnings.append(f"节点 {nid}: switch 无分支 cases，将始终走 defaultNext")
            for i, c in enumerate(cases):
                if not isinstance(c, dict):
                    errors.append(f"节点 {nid} case {i} 不是对象")
                    continue
                cn = c.get("next", "")
                if cn and cn not in nodes:
                    errors.append(f"节点 {nid} case {i} next 指向不存在: {cn!r}")
            dn = raw.get("defaultNext", "")
            if dn and dn not in nodes:
                errors.append(f"节点 {nid}: defaultNext 指向不存在: {dn!r}")
        elif t == "end":
            pass

    return (errors, warnings)


def validate_graph(data: dict[str, Any]) -> list[str]:
    e, w = validate_graph_tiered(data)
    return e + w


def node_search_haystack(nid: str, raw: Any) -> str:
    """用于搜索：节点 id + 可读文本（小写匹配在调用方）。"""
    parts: list[str] = [nid]
    if not isinstance(raw, dict):
        return " ".join(parts)
    t = raw.get("type")
    if t == "line":
        parts.append(str(raw.get("text", "") or ""))
        parts.append(str(raw.get("textKey", "") or ""))
        lines = raw.get("lines")
        if isinstance(lines, list):
            for beat in lines:
                if isinstance(beat, dict):
                    parts.append(str(beat.get("text", "") or ""))
                    parts.append(str(beat.get("textKey", "") or ""))
    elif t == "choice":
        pl = raw.get("promptLine")
        if isinstance(pl, dict):
            parts.append(str(pl.get("text", "") or ""))
        for opt in raw.get("options") or []:
            if isinstance(opt, dict):
                parts.append(str(opt.get("text", "") or ""))
                parts.append(str(opt.get("id", "") or ""))
                parts.append(str(opt.get("requireFlag", "") or ""))
                parts.append(str(opt.get("ruleHintId", "") or ""))
                parts.append(str(opt.get("disabledClickHint", "") or ""))
    elif t == "runActions":
        try:
            parts.append(json.dumps(raw.get("actions"), ensure_ascii=False))
        except (TypeError, ValueError):
            parts.append(str(raw.get("actions")))
    elif t == "switch":
        for c in raw.get("cases") or []:
            if isinstance(c, dict):
                parts.append(str(c.get("next", "") or ""))
                try:
                    parts.append(json.dumps(c.get("condition"), ensure_ascii=False))
                except (TypeError, ValueError):
                    pass
                try:
                    parts.append(json.dumps(c.get("conditions"), ensure_ascii=False))
                except (TypeError, ValueError):
                    pass
        parts.append(str(raw.get("defaultNext", "") or ""))
    return " ".join(parts)


def node_summary(nid: str, raw: Any, max_text: int = 30) -> str:
    """节点的一行人类可读摘要，用于列表和画布显示。"""
    _ = nid
    if not isinstance(raw, dict):
        return ""
    t = raw.get("type")
    if t == "line":
        lines = raw.get("lines")
        if isinstance(lines, list) and lines and isinstance(lines[0], dict):
            beat = lines[0]
        else:
            beat = raw
        sp = beat.get("speaker") or {}
        kind = sp.get("kind", "?") if isinstance(sp, dict) else "?"
        if kind == "literal" and isinstance(sp, dict):
            kind_label = sp.get("name") or "旁白"
        else:
            kind_label = {
                "player": "玩家",
                "npc": "NPC",
                "literal": "旁白",
                "sceneNpc": "场景NPC",
            }.get(kind, kind)
        tx = str(beat.get("text", "") or "").replace("\n", " ").strip()
        if len(tx) > max_text:
            tx = tx[: max_text - 1] + "..."
        return f'{kind_label}: "{tx}"' if tx else str(kind_label)
    if t == "choice":
        opts = raw.get("options") or []
        n = len(opts) if isinstance(opts, list) else 0
        first = ""
        pl = raw.get("promptLine")
        if isinstance(pl, dict):
            prompt_txt = str(pl.get("text", "") or "").strip()
            if prompt_txt:
                first = prompt_txt
                if len(first) > 20:
                    first = first[:19] + "..."
        if not first and n and isinstance(opts[0], dict):
            first = str(opts[0].get("text", "") or "").strip()
            if len(first) > 20:
                first = first[:19] + "..."
        return f"{n}个选项: {first}" if first else f"{n}个选项"
    if t == "runActions":
        acts = raw.get("actions") or []
        if not isinstance(acts, list):
            acts = []
        n = len(acts)
        if n == 1 and isinstance(acts[0], dict):
            atype = str(acts[0].get("type", "?"))
            param_hint = _action_param_hint(acts[0])
            return f"{atype}: {param_hint}" if param_hint else atype
        types = [str(a.get("type", "?")) for a in acts[:2] if isinstance(a, dict)]
        suffix = "..." if n > 2 else ""
        return f"{n}动作: {', '.join(types)}{suffix}" if types else f"{n}动作"
    if t == "switch":
        cases = raw.get("cases") or []
        if not isinstance(cases, list):
            cases = []
        n = len(cases)
        hint = _switch_case_hint(cases[0]) if n and isinstance(cases[0], dict) else ""
        suffix = "..." if n > 1 else ""
        return f"{n}分支: {hint}{suffix}" if hint else f"{n}分支"
    if t == "end":
        return "结束"
    return ""


def _action_param_hint(action: dict) -> str:
    """从单条 ActionDef 中提取最有辨识度的参数值作为摘要后缀。"""
    p = action.get("params")
    if not isinstance(p, dict):
        return ""
    for key in (
        "key",
        "flag",
        "amount",
        "target",
        "scenarioId",
        "documentId",
        "itemId",
        "questId",
        "text",
    ):
        v = p.get(key)
        if v is not None and str(v).strip():
            s = str(v).strip()
            return s[:20] + "..." if len(s) > 20 else s
    return ""


def _switch_case_hint(case: dict) -> str:
    """从 switch 的第一个 case 提取条件关键字。"""
    conds = case.get("conditions")
    if isinstance(conds, list) and conds and isinstance(conds[0], dict):
        c0 = conds[0]
        if "flag" in c0:
            f = str(c0.get("flag", "")).strip()
            if not f:
                return "flag?"
            return f"flag {f[:18]}..." if len(f) > 18 else f"flag {f}"
        if "scenario" in c0:
            s = str(c0.get("scenario", "")).strip()
            ph = str(c0.get("phase", "")).strip()
            label = f"{s}/{ph}" if ph else s
            return label[:22] + "..." if len(label) > 22 else label
        if "quest" in c0:
            return f"quest {str(c0.get('quest', '')).strip()}"
        if "questId" in c0:
            qid = str(c0.get("questId", "")).strip()
            return f"quest {qid}" if qid else "quest?"
    cond = case.get("condition")
    if isinstance(cond, dict) and cond:
        if any(k in cond for k in ("any", "all", "not")):
            return "条件表达式"
        if "flag" in cond:
            f = str(cond.get("flag", "")).strip()
            return f"flag {f[:18]}..." if len(f) > 18 else f"flag {f}" if f else "flag?"
        if "scenario" in cond:
            s = str(cond.get("scenario", "")).strip()
            ph = str(cond.get("phase", "")).strip()
            label = f"{s}/{ph}" if ph else s
            return label[:22] + "..." if len(label) > 22 else label
        return "条件表达式"
    return ""


_SAFE_ID_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def suggest_next_id(nodes: dict[str, Any], prefix: str = "n") -> str:
    max_n = 0
    for k in nodes:
        m = re.match(r"^" + re.escape(prefix) + r"_(\d+)$", k)
        if m:
            max_n = max(max_n, int(m.group(1)))
    return f"{prefix}_{max_n + 1}"


def default_node(node_type: str, nodes: dict[str, Any]) -> dict[str, Any]:
    """Create a new node dict for the given type. 新建默认不连接任何 next，由策划手动连线。"""
    _ = nodes

    if node_type == "line":
        return {
            "type": "line",
            "speaker": {"kind": "player"},
            "text": "",
            "next": "",
        }
    if node_type == "runActions":
        return {"type": "runActions", "actions": [], "next": ""}
    if node_type == "choice":
        return {
            "type": "choice",
            "options": [
                {"id": "a", "text": "选项甲", "next": ""},
            ],
        }
    if node_type == "switch":
        return {
            "type": "switch",
            "cases": [],
            "defaultNext": "",
        }
    if node_type == "end":
        return {"type": "end"}
    raise ValueError(node_type)
