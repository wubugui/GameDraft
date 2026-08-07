"""Live, staging-aware dialogue-graph reference catalog for editor widgets."""
from __future__ import annotations

from pathlib import Path
from typing import Any


def _safe_graph_id(raw: object) -> str:
    gid = str(raw or "").strip()
    if not gid:
        return ""
    try:
        from .narrative_templates import _dialogue_id_error

        if _dialogue_id_error(gid):
            return ""
    except Exception:
        if gid in (".", "..") or "/" in gid or "\\" in gid:
            return ""
    return gid


def _pending_graph(model: Any, graph_id: str) -> dict | None:
    deleted = getattr(model, "pending_dialogue_graph_deletes", set())
    if graph_id in deleted:
        return None
    for attr in ("pending_dialogue_graph_edits", "pending_dialogue_stubs"):
        bag = getattr(model, attr, None)
        if not isinstance(bag, dict):
            continue
        graph = bag.get(graph_id)
        if isinstance(graph, dict):
            return graph
    return None


def dialogue_graph_ids(model: Any) -> list[str]:
    """Disk IDs plus safe named ProjectModel staging entries.

    Untitled editor drafts are intentionally absent: they have no stable target
    ID until their first successful save.
    """
    ids: set[str] = set()
    provider = getattr(model, "all_dialogue_graph_ids", None)
    if callable(provider):
        try:
            ids.update(gid for raw in (provider() or []) if (gid := _safe_graph_id(raw)))
        except Exception:
            pass
    for attr in ("pending_dialogue_stubs", "pending_dialogue_graph_edits"):
        bag = getattr(model, attr, None)
        if not isinstance(bag, dict):
            continue
        for raw, graph in bag.items():
            gid = _safe_graph_id(raw)
            if gid and isinstance(graph, dict):
                ids.add(gid)
    ids.difference_update(
        _safe_graph_id(raw)
        for raw in getattr(model, "pending_dialogue_graph_deletes", set())
        if _safe_graph_id(raw)
    )
    return sorted(ids, key=lambda value: (value.casefold(), value))


def _load_disk_graph(model: Any, graph_id: str) -> dict | None:
    dialogues_path = getattr(model, "dialogues_path", None)
    if dialogues_path is None:
        return None
    path = Path(dialogues_path) / "graphs" / f"{graph_id}.json"
    loader = getattr(model, "_load", None)
    if callable(loader):
        try:
            value = loader(path, {})
            return value if isinstance(value, dict) else None
        except Exception:
            return None
    return None


def dialogue_graph_document(model: Any, graph_id: str) -> dict | None:
    gid = _safe_graph_id(graph_id)
    if not gid:
        return None
    if gid in getattr(model, "pending_dialogue_graph_deletes", set()):
        return None
    return _pending_graph(model, gid) or _load_disk_graph(model, gid)


def dialogue_graph_node_ids(model: Any, graph_id: str) -> list[str]:
    graph = dialogue_graph_document(model, graph_id)
    if graph is not None:
        nodes = graph.get("nodes")
        if not isinstance(nodes, dict):
            return []
        return sorted(
            (str(node_id) for node_id in nodes.keys()),
            key=lambda value: (value.casefold(), value),
        )
    provider = getattr(model, "dialogue_graph_node_ids", None)
    if callable(provider):
        try:
            return [str(value) for value in (provider(graph_id) or [])]
        except Exception:
            return []
    return []


def dialogue_graph_reference_rows(model: Any) -> list[tuple[str, str, str]]:
    """Rows for ``ReferencePickerField``: ID, title, and searchable context."""
    ids = dialogue_graph_ids(model)
    staged_signature: list[tuple[str, str, int, str, str]] = []
    for attr in ("pending_dialogue_graph_edits", "pending_dialogue_stubs"):
        bag = getattr(model, attr, None)
        if not isinstance(bag, dict):
            continue
        for raw_id, graph in bag.items():
            gid = _safe_graph_id(raw_id)
            if not gid or not isinstance(graph, dict):
                continue
            meta = graph.get("meta") if isinstance(graph.get("meta"), dict) else {}
            staged_signature.append((
                attr,
                gid,
                id(graph),
                str(meta.get("title") or graph.get("title") or ""),
                str(meta.get("scenarioId") or ""),
            ))
    deleted_signature = tuple(sorted(
        str(raw).strip() for raw in getattr(model, "pending_dialogue_graph_deletes", set())
        if str(raw).strip()
    ))
    signature = (tuple(ids), tuple(sorted(staged_signature)), deleted_signature)
    cached = getattr(model, "_dialogue_reference_rows_cache", None)
    if isinstance(cached, tuple) and len(cached) == 2 and cached[0] == signature:
        return list(cached[1])

    out: list[tuple[str, str, str]] = []
    for gid in ids:
        graph = dialogue_graph_document(model, gid) or {}
        meta = graph.get("meta") if isinstance(graph.get("meta"), dict) else {}
        title = str(meta.get("title") or graph.get("title") or gid).strip() or gid
        scenario = str(meta.get("scenarioId") or "").strip()
        staged = _pending_graph(model, gid) is not None
        details: list[str] = []
        if scenario:
            details.append(f"Scenario: {scenario}")
        if staged:
            details.append("ProjectModel 暂存（尚未 Save All）")
        out.append((gid, title, " · ".join(details)))
    try:
        setattr(model, "_dialogue_reference_rows_cache", (signature, tuple(out)))
    except Exception:
        pass
    return out


def clear_dialogue_graph_reference_cache(model: Any) -> None:
    try:
        delattr(model, "_dialogue_reference_rows_cache")
    except (AttributeError, TypeError):
        pass


DIALOGUE_GRAPH_OPEN_TOOLTIP = "切到「图对话」页并打开这张图（当前页的编辑保持不变）"




def open_dialogue_graph_from_widget(widget: Any, graph_id: str) -> bool:
    """正向跳转：从任何引用了 graphId 的字段跳到「图对话」页并打开那张图。

    主窗早就有 ``navigate_to_dialogue_graph``（全局搜索、Action 注册表「跳转到来源」、
    图对话页「被引用」树都在用），但**引用侧字段一个入口都没接**——选完一张图对话想去看/改，
    只能自己回导航树找。这里做统一转接：沿 parent 链找到实现了该方法的宿主窗口。

    找不到宿主（独立小工具、离屏测试）返回 False，绝不抛——跳转是锦上添花，不能因为
    没有宿主就把编辑器打挂。
    """
    # 在模态弹窗里点 ↗ 也放行（叙事状态机的 actions 弹窗是常规用法）。曾评估过"先关弹窗
    # 再跳"的拦法，逐条查证后否掉：①离开页的 commit-on-leave 只有场景编辑器实现，而场景页
    # 的所有 graphId ↗ 与 ActionEditor 都是内联控件、没有一个在模态里，组合不可达；
    # ②图对话页的「未保存」询问会叠在最上层、可交互，落盘只在用户显式点保存后发生；
    # ③引用刷新那条真危险的路已由 reference_rebuild_is_safe_now 在模态时整轮让路。
    # 剩下的"背后切了页"正是按钮 tooltip 承诺的行为——拦住反而挡了正常干活。
    gid = str(graph_id or "").strip()
    if not gid:
        return False
    node = widget
    seen: set[int] = set()
    while node is not None and id(node) not in seen:
        seen.add(id(node))
        navigate = getattr(node, "navigate_to_dialogue_graph", None)
        if callable(navigate):
            try:
                navigate(gid)
                return True
            except Exception as exc:  # noqa: BLE001 — 跳转失败不得打断编辑
                print(f"[dialogue-nav] 跳转到图对话 {gid!r} 失败: {exc!r}", flush=True)
                return False
        parent = getattr(node, "parentWidget", None)
        node = parent() if callable(parent) else None
    return False
