"""持久化图对话流程图节点坐标（与游戏 JSON 分离，仅编辑器使用）。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def layout_file_path(project_root: Path) -> Path:
    return project_root / "editor_data" / "dialogue_flow_layout.json"


def load_layout_map(project_root: Path) -> dict[str, Any]:
    p = layout_file_path(project_root)
    if not p.is_file():
        return {}
    try:
        with p.open("r", encoding="utf-8") as f:
            raw = json.load(f)
        return raw if isinstance(raw, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def save_layout_map(project_root: Path, data: dict[str, Any]) -> None:
    p = layout_file_path(project_root)
    p.parent.mkdir(parents=True, exist_ok=True)
    with p.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def graph_layout_key(graph_json_path: Path) -> str:
    """用文件名作键，避免绝对路径分叉。"""
    return graph_json_path.name


def _parse_xy_map(raw: Any) -> dict[str, tuple[float, float]]:
    out: dict[str, tuple[float, float]] = {}
    if not isinstance(raw, dict):
        return out
    for nid, xy in raw.items():
        if isinstance(xy, (list, tuple)) and len(xy) >= 2:
            try:
                out[str(nid)] = (float(xy[0]), float(xy[1]))
            except (TypeError, ValueError):
                continue
    return out


def _normalize_groups(raw: Any) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    if not isinstance(raw, dict):
        return out
    for gid, g in raw.items():
        if isinstance(g, dict):
            out[str(gid)] = dict(g)
    return out


def _normalize_node_groups(raw: Any) -> dict[str, str]:
    out: dict[str, str] = {}
    if not isinstance(raw, dict):
        return out
    for nid, gid in raw.items():
        if gid is not None and str(gid).strip():
            out[str(nid)] = str(gid).strip()
    return out


def _normalize_group_frames(raw: Any) -> dict[str, dict[str, float]]:
    out: dict[str, dict[str, float]] = {}
    if not isinstance(raw, dict):
        return out
    for gid, fr in raw.items():
        if not isinstance(fr, dict):
            continue
        try:
            out[str(gid)] = {
                "x": float(fr.get("x", 0.0)),
                "y": float(fr.get("y", 0.0)),
                "width": float(fr.get("width", 160.0)),
                "height": float(fr.get("height", 120.0)),
            }
        except (TypeError, ValueError):
            continue
    return out


def load_positions_for_graph(project_root: Path, graph_json_path: Path) -> dict[str, tuple[float, float]]:
    root = load_layout_map(project_root)
    key = graph_layout_key(graph_json_path)
    block = root.get(key)
    if not isinstance(block, dict):
        return {}
    if "nodes" in block:
        return _parse_xy_map(block.get("nodes"))
    # 旧格式：整表即节点坐标
    if "ghosts" in block:
        return _parse_xy_map({k: v for k, v in block.items() if k != "ghosts"})
    return _parse_xy_map(block)


def load_ghost_positions_for_graph(
    project_root: Path, graph_json_path: Path
) -> dict[str, tuple[float, float]]:
    root = load_layout_map(project_root)
    key = graph_layout_key(graph_json_path)
    block = root.get(key)
    if not isinstance(block, dict):
        return {}
    return _parse_xy_map(block.get("ghosts"))


def load_editor_groups_for_graph(
    project_root: Path, graph_json_path: Path
) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    """仅编辑器：分组定义与节点所属分组（不写 graphs/*.json）。"""
    root = load_layout_map(project_root)
    key = graph_layout_key(graph_json_path)
    block = root.get(key)
    if not isinstance(block, dict):
        return {}, {}
    return _normalize_groups(block.get("groups")), _normalize_node_groups(block.get("nodeGroups"))


def load_group_frames_for_graph(
    project_root: Path, graph_json_path: Path
) -> dict[str, dict[str, float]]:
    """画布分组框几何（x,y,width,height），与 groups 中的 id 对应。"""
    root = load_layout_map(project_root)
    key = graph_layout_key(graph_json_path)
    block = root.get(key)
    if not isinstance(block, dict):
        return {}
    return _normalize_group_frames(block.get("groupFrames"))


def write_positions_for_graph(
    project_root: Path,
    graph_json_path: Path,
    positions: dict[str, tuple[float, float]],
    *,
    ghost_positions: dict[str, tuple[float, float]] | None = None,
    editor_groups: dict[str, dict[str, Any]] | None = None,
    editor_node_groups: dict[str, str] | None = None,
    group_frames: dict[str, dict[str, Any]] | None = None,
) -> None:
    root = load_layout_map(project_root)
    key = graph_layout_key(graph_json_path)
    prev = root.get(key)
    preserved_groups: dict[str, dict[str, Any]] = {}
    preserved_ng: dict[str, str] = {}
    preserved_frames: dict[str, dict[str, float]] = {}
    if isinstance(prev, dict):
        preserved_groups = _normalize_groups(prev.get("groups"))
        preserved_ng = _normalize_node_groups(prev.get("nodeGroups"))
        preserved_frames = _normalize_group_frames(prev.get("groupFrames"))

    groups_out = (
        {k: dict(v) for k, v in editor_groups.items()} if editor_groups is not None else preserved_groups
    )
    node_groups_out = (
        dict(editor_node_groups) if editor_node_groups is not None else preserved_ng
    )
    frames_src = group_frames if group_frames is not None else preserved_frames
    frames_out: dict[str, dict[str, float]] = {}
    for gid, fr in frames_src.items():
        if not isinstance(fr, dict):
            continue
        try:
            frames_out[str(gid)] = {
                "x": round(float(fr.get("x", 0.0)), 2),
                "y": round(float(fr.get("y", 0.0)), 2),
                "width": round(float(fr.get("width", 0.0)), 2),
                "height": round(float(fr.get("height", 0.0)), 2),
            }
        except (TypeError, ValueError):
            continue

    node_obj = {nid: [round(x, 2), round(y, 2)] for nid, (x, y) in sorted(positions.items())}
    block: dict[str, Any] = {
        "nodes": node_obj,
        "groups": groups_out,
        "nodeGroups": node_groups_out,
        "groupFrames": frames_out,
    }
    if ghost_positions:
        block["ghosts"] = {
            gid: [round(x, 2), round(y, 2)] for gid, (x, y) in sorted(ghost_positions.items())
        }
    root[key] = block
    save_layout_map(project_root, root)


def remove_layout_entry_for_graph(project_root: Path, graph_json_path: Path) -> None:
    """从 dialogue_flow_layout.json 中移除该图对应的布局/分组块（图 JSON 删除时调用）。"""
    root = load_layout_map(project_root)
    key = graph_layout_key(graph_json_path)
    if key not in root:
        return
    del root[key]
    save_layout_map(project_root, root)


def migrate_layout_map_key(project_root: Path, old_graph_path: Path, new_graph_path: Path) -> None:
    """首次将草稿保存为真实 graphs/*.json 时，把 editor_data 中草稿键下的布局/分组迁到正式文件名键。"""
    ok = graph_layout_key(old_graph_path)
    nk = graph_layout_key(new_graph_path)
    if ok == nk:
        return
    root = load_layout_map(project_root)
    if ok not in root:
        return
    root[nk] = root.pop(ok)
    save_layout_map(project_root, root)
