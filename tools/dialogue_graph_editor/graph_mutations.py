"""集中修改图对话 JSON 拓扑（next / choice / switch），供画布与 Inspector 共用。"""
from __future__ import annotations

from typing import Any

OUT_NEXT = "next"
OUT_CHOICE = "choice_opt"
OUT_SWITCH_CASE = "switch_case"
OUT_SWITCH_DEFAULT = "switch_default"


def connect_output_to_target(
    data: dict[str, Any],
    src_id: str,
    kind: str,
    index: int,
    dst_id: str,
) -> str | None:
    """成功返回 None，否则返回错误说明。"""
    if src_id == dst_id:
        return "不能连接到自身"
    nodes = data.get("nodes") or {}
    if src_id not in nodes:
        return "源节点不存在"
    # 目标允许不在 nodes 中（缺失 id，由幽灵节点表示；校验会提示）
    raw = nodes[src_id]
    if not isinstance(raw, dict):
        return "源节点数据无效"
    t = raw.get("type")

    if kind == OUT_NEXT:
        if t not in ("line", "runActions"):
            return "该节点没有单一 next 出口"
        raw["next"] = dst_id
        return None

    if kind == OUT_CHOICE:
        if t != "choice":
            return "不是 choice 节点"
        opts = raw.get("options")
        if not isinstance(opts, list) or index < 0 or index >= len(opts):
            return "选项索引无效"
        opt = opts[index]
        if not isinstance(opt, dict):
            return "选项数据损坏"
        opt["next"] = dst_id
        return None

    if kind == OUT_SWITCH_CASE:
        if t != "switch":
            return "不是 switch 节点"
        cases = raw.get("cases")
        if not isinstance(cases, list) or index < 0 or index >= len(cases):
            return "case 索引无效"
        c = cases[index]
        if not isinstance(c, dict):
            return "case 数据损坏"
        c["next"] = dst_id
        return None

    if kind == OUT_SWITCH_DEFAULT:
        if t != "switch":
            return "不是 switch 节点"
        raw["defaultNext"] = dst_id
        return None

    return "未知连接类型"


def clear_output(data: dict[str, Any], src_id: str, kind: str, index: int) -> str | None:
    """清空该出口的 next 目标（空字符串）。"""
    nodes = data.get("nodes") or {}
    if src_id not in nodes:
        return "节点不存在"
    raw = nodes[src_id]
    if not isinstance(raw, dict):
        return "节点数据无效"
    t = raw.get("type")

    if kind == OUT_NEXT:
        if t in ("line", "runActions"):
            raw["next"] = ""
            return None
        return "类型不匹配"

    if kind == OUT_CHOICE:
        if t != "choice":
            return "类型不匹配"
        opts = raw.get("options")
        if not isinstance(opts, list) or index < 0 or index >= len(opts):
            return "选项索引无效"
        if isinstance(opts[index], dict):
            opts[index]["next"] = ""
        return None

    if kind == OUT_SWITCH_CASE:
        if t != "switch":
            return "类型不匹配"
        cases = raw.get("cases")
        if not isinstance(cases, list) or index < 0 or index >= len(cases):
            return "case 索引无效"
        if isinstance(cases[index], dict):
            cases[index]["next"] = ""
        return None

    if kind == OUT_SWITCH_DEFAULT:
        if t != "switch":
            return "类型不匹配"
        raw["defaultNext"] = ""
        return None

    return "未知连接类型"


def collect_incoming_refs(data: dict[str, Any], target_id: str) -> list[tuple[str, str, int, str]]:
    """列出所有指向 target_id 的引用：(源节点 id, kind, index, 人类可读标签)。"""
    out: list[tuple[str, str, int, str]] = []
    nodes = data.get("nodes") or {}
    for nid, raw in nodes.items():
        if not isinstance(raw, dict):
            continue
        t = raw.get("type")
        if t in ("line", "runActions"):
            if str(raw.get("next", "") or "") == target_id:
                out.append((nid, OUT_NEXT, 0, "next"))
        elif t == "choice":
            for i, opt in enumerate(raw.get("options") or []):
                if isinstance(opt, dict) and str(opt.get("next", "") or "") == target_id:
                    lab = str(opt.get("text") or opt.get("id") or f"opt{i}")
                    out.append((nid, OUT_CHOICE, i, lab))
        elif t == "switch":
            for i, c in enumerate(raw.get("cases") or []):
                if isinstance(c, dict) and str(c.get("next", "") or "") == target_id:
                    out.append((nid, OUT_SWITCH_CASE, i, f"case{i}"))
            if str(raw.get("defaultNext", "") or "") == target_id:
                out.append((nid, OUT_SWITCH_DEFAULT, -1, "else"))
    return out


def rename_node_id(data: dict[str, Any], old_id: str, new_id: str) -> str | None:
    """重命名节点并更新所有引用与 entry。new_id 已存在则失败。"""
    nodes = data.get("nodes") or {}
    if old_id not in nodes:
        return "找不到要重命名的节点"
    if new_id != old_id and new_id in nodes:
        return f"目标 id已存在：{new_id!r}"
    if old_id == new_id:
        return None
    blob = nodes.pop(old_id)
    nodes[new_id] = blob

    if str(data.get("entry", "") or "") == old_id:
        data["entry"] = new_id

    for nid, raw in list(nodes.items()):
        if not isinstance(raw, dict):
            continue
        t = raw.get("type")
        if t in ("line", "runActions"):
            if str(raw.get("next", "") or "") == old_id:
                raw["next"] = new_id
        elif t == "choice":
            for opt in raw.get("options") or []:
                if isinstance(opt, dict) and str(opt.get("next", "") or "") == old_id:
                    opt["next"] = new_id
        elif t == "switch":
            for c in raw.get("cases") or []:
                if isinstance(c, dict) and str(c.get("next", "") or "") == old_id:
                    c["next"] = new_id
            if str(raw.get("defaultNext", "") or "") == old_id:
                raw["defaultNext"] = new_id
    return None


def clear_incoming_to_node(data: dict[str, Any], target_id: str) -> None:
    """将所有指向 target_id 的出口清空。"""
    for src_id, kind, idx, _ in collect_incoming_refs(data, target_id):
        clear_output(data, src_id, kind, idx)
