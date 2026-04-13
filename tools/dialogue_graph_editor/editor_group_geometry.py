"""编辑器分组框几何：与画布矩形同步 nodeGroups，自动布局避让。"""
from __future__ import annotations

from collections import defaultdict
from typing import Any

# 与 auto_layout 中节点占位同量级，用于中心点是否在框内的粗算
_EST_NODE_W = 220.0
_EST_NODE_H = 95.0


def frame_node_name(gid: str) -> str:
    return f"__editor_grp_{gid}"


def parse_frame_gid(node_name: str) -> str | None:
    p = "__editor_grp_"
    if node_name.startswith(p):
        return node_name[len(p) :]
    return None


def migrate_legacy_frames_from_assignments(
    positions: dict[str, tuple[float, float]],
    node_to_group: dict[str, str],
    editor_groups: dict[str, dict[str, Any]],
    *,
    padding: float = 44.0,
) -> dict[str, dict[str, float]]:
    """旧数据仅有 groups + nodeGroups 时，按成员节点外包矩形生成初始分组框。"""
    by_gid: dict[str, list[tuple[float, float]]] = defaultdict(list)
    for nid, gid in node_to_group.items():
        if gid not in editor_groups:
            continue
        xy = positions.get(nid)
        if xy is None:
            continue
        by_gid[gid].append((float(xy[0]), float(xy[1])))
    out: dict[str, dict[str, float]] = {}
    for gid, pts in by_gid.items():
        if not pts:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        minx = min(xs)
        miny = min(ys)
        maxx = max(xs) + _EST_NODE_W
        maxy = max(ys) + _EST_NODE_H
        out[gid] = {
            "x": minx - padding,
            "y": miny - padding,
            "width": maxx - minx + padding * 2,
            "height": maxy - miny + padding * 2,
        }
    return out


def _center_in_rect(
    cx: float, cy: float, rx: float, ry: float, rw: float, rh: float
) -> bool:
    return rx <= cx <= rx + rw and ry <= cy <= ry + rh


def sync_node_to_group_from_layout_positions(
    *,
    positions: dict[str, tuple[float, float]],
    nodes_dict: dict[str, Any],
    group_frames: dict[str, dict[str, Any]],
    node_to_group: dict[str, str],
) -> bool:
    """无画布时：用 layout 里的节点左上角 + 估计宽高推算中心，与 groupFrames 对齐。"""
    centers: dict[str, tuple[float, float]] = {}
    for nid in nodes_dict:
        xy = positions.get(nid)
        if xy is None:
            continue
        centers[nid] = (
            float(xy[0]) + _EST_NODE_W * 0.5,
            float(xy[1]) + _EST_NODE_H * 0.5,
        )
    return sync_node_to_group_from_frames(
        nodes_dict=nodes_dict,
        group_frames=group_frames,
        node_to_group=node_to_group,
        node_center_scene=centers,
    )


def sync_node_to_group_from_frames(
    *,
    nodes_dict: dict[str, Any],
    group_frames: dict[str, dict[str, Any]],
    node_to_group: dict[str, str],
    node_center_scene: dict[str, tuple[float, float]],
) -> bool:
    """根据节点中心点是否落在分组框内更新 node_to_group。多框重叠时取面积最小者。"""
    rects: list[tuple[str, float, float, float, float, float]] = []
    for gid, fr in group_frames.items():
        if not isinstance(fr, dict):
            continue
        try:
            x = float(fr.get("x", 0.0))
            y = float(fr.get("y", 0.0))
            w = float(fr.get("width", 120.0))
            h = float(fr.get("height", 120.0))
        except (TypeError, ValueError):
            continue
        if w < 1 or h < 1:
            continue
        area = w * h
        rects.append((gid, x, y, w, h, area))

    changed = False
    for nid in list(nodes_dict.keys()):
        if nid not in node_center_scene:
            continue
        cx, cy = node_center_scene[nid]
        inside = [t for t in rects if _center_in_rect(cx, cy, t[1], t[2], t[3], t[4])]
        if not inside:
            if nid in node_to_group:
                del node_to_group[nid]
                changed = True
            continue
        best = min(inside, key=lambda t: t[5])
        gid_pick = best[0]
        if node_to_group.get(nid) != gid_pick:
            node_to_group[nid] = gid_pick
            changed = True
    return changed


def avoid_rects_list(group_frames: dict[str, dict[str, Any]]) -> list[tuple[float, float, float, float]]:
    out: list[tuple[float, float, float, float]] = []
    for fr in group_frames.values():
        if not isinstance(fr, dict):
            continue
        try:
            out.append(
                (
                    float(fr.get("x", 0.0)),
                    float(fr.get("y", 0.0)),
                    float(fr.get("width", 0.0)),
                    float(fr.get("height", 0.0)),
                )
            )
        except (TypeError, ValueError):
            continue
    return [r for r in out if r[2] >= 8 and r[3] >= 8]


def nudge_node_positions_avoid_rects(
    positions: dict[str, tuple[float, float]],
    nodes_dict: dict[str, Any],
    rects: list[tuple[float, float, float, float]],
    *,
    est_w: float = _EST_NODE_W,
    est_h: float = _EST_NODE_H,
    margin: float = 16.0,
    step: float = 36.0,
    max_iter: int = 5000,
) -> bool:
    """将节点中心点移出所有分组框外（竖直向下试探），用于自动布局后。"""
    if not rects or not nodes_dict:
        return False
    expanded = [
        (rx - margin, ry - margin, rw + margin * 2, rh + margin * 2)
        for rx, ry, rw, rh in rects
    ]
    changed = False
    for nid in nodes_dict:
        if nid not in positions:
            continue
        x, y = positions[nid]
        cx = float(x) + est_w * 0.5
        cy = float(y) + est_h * 0.5
        nudge = 0
        while nudge < max_iter and any(
            _center_in_rect(cx, cy + nudge, rx, ry, rw, rh) for rx, ry, rw, rh in expanded
        ):
            nudge += step
        if nudge > 0:
            positions[nid] = (float(x), float(y) + nudge)
            changed = True
    return changed
