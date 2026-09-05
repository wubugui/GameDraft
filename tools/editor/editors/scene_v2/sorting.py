"""内容层前后次序 —— 用运行时那条规则的镜像，不另立一套。

规则本体在 `shared/entity_sort_math.py`（`src/rendering/entitySortRule.ts` 的
Python 镜像，双侧 parity 测试钉死）。这里只做两件事：**收集参与排序的实体**、
**按名次派 z**。

为什么不直接搬运行时的 z：运行时档位偏移是 ±1e7，直接当 `zValue` 会盖穿全部装饰品。
名次映射既保住次序，又留在内容区间内。
"""
from __future__ import annotations

from ...shared.entity_sort_math import (
    entity_sort_z,
    hotspot_sort_band_of,
    npc_sort_band_of,
    sort_foot_y_of,
)
from ...shared.entity_transform_math import (
    entity_contact_point,
    entity_scale_of,
)
from ...shared.static_display_sprite import npc_content_facing_x
from .changes import EntityRef
from .items import Z_CONTENT_LO

__all__ = ["CONTENT_STEP", "content_sort_entries", "assign_content_z"]

#: 相邻名次的 z 间隔
CONTENT_STEP = 1.0


def content_sort_entries(document, view, *, probe=None):
    """收集内容图元并算排序键 → ``[(z, tie, item, ref_key), ...]``。

    `tie` 复刻运行时 `entityLayer` 的装配次序（玩家 → 热点按 JSON 序 → NPC 按
    JSON 序）。运行时平局靠 Pixi 稳定排序保持数组现序，编辑器只能用 JSON 数组序
    近似 —— 但它必须**稳定**，抖动会让画布闪烁。

    `probe` 是"玩家脚点"。编辑器里没有玩家，缺省 ``None`` —— 与运行时
    `hasPlayer` 为假同分支，遮挡多边形那一支不生效、回落静态档位。
    """
    out: list[tuple[float, int, object, str]] = []
    # 手势预览位移要算进脚底 y，否则拖动中的重排用的还是旧位置（等于没排）
    offsets = getattr(view, "preview_offsets", None)
    offsets = offsets() if callable(offsets) else {}
    for i, ref in enumerate(document.entity_refs("hotspot")):
        # **只认展示图图元，不回落到把手。** 回落会把"配了 displayImage 但图缺件/
        # 尺寸为 0"的热点的**把手**拖进内容区 —— 那个把手于是被派到内容层 z，
        # 沉到贴图底下点不着，而它本该恒在内容之上。
        item = view.item_for(ref, "display")
        ent = document.entity(ref)
        if item is None or not isinstance(ent, dict):
            continue
        di = ent.get("displayImage") if isinstance(ent.get("displayImage"), dict) else None
        if not di:
            continue          # 没展示图的热点不进内容区（运行时容器里也只有不可见 marker）
        try:
            ww = float(di.get("worldWidth", 0) or 0)
            hh = float(di.get("worldHeight", 0) or 0)
        except (TypeError, ValueError):
            ww = hh = 0.0
        texture_loaded = bool(getattr(item, "texture_loaded", True))
        # **脚底 quad 的尺寸要乘透视系数**，否则"谁挡谁"与运行时算出来不是一回事。
        # 触发条件窄（实体要同时有 rotation 且参与透视），正因为窄，撞上时最难归因：
        # 两个画布都不报错、结果不同。
        s = entity_scale_of(ent) * _pf(view, ent, "hotspot")
        foot = sort_foot_y_of(ent, ww * s, hh * s)
        dy = offsets.get(ref, (0.0, 0.0))[1]
        z = entity_sort_z(
            hotspot_sort_band_of(ent, texture_loaded),
            float(ent.get("y", 0) or 0) + dy,
            None if foot is None else foot + dy)
        out.append((z, 1_000 + i, item, ref.key))

    for i, ref in enumerate(document.entity_refs("npc")):
        item = view.item_for(ref, "sprite")
        ent = document.entity(ref)
        if item is None or not isinstance(ent, dict):
            continue
        size = getattr(item, "world_size", (0.0, 0.0))
        mirror = npc_content_facing_x(ent)
        # 透视系数在**接地点**处求（与运行时 _refreshDepthScale 同口径）：
        # 先在锚点采一次定位接地点、再在接地点采一次，一步收敛。
        # 缺省锚点时接地点恒等于锚点，第二次采样被跳过，逐位同改造前。
        pf = _pf(view, ent, "npc")
        cx, cy = entity_contact_point(ent, size[0], size[1], pf, mirror)
        if (cx, cy) != (float(ent.get("x", 0) or 0), float(ent.get("y", 0) or 0)):
            pf = _pf(view, ent, "npc", cx, cy)
        s = entity_scale_of(ent) * pf
        foot = sort_foot_y_of(ent, size[0] * s, size[1] * s, mirror)
        # NPC 的 collisionPolygon **不参与**遮挡带（运行时只有 Hotspot 写
        # entityOcclusionPolygon）；一视同仁会造出运行时根本不存在的层级翻转。
        dy = offsets.get(ref, (0.0, 0.0))[1]
        z = entity_sort_z(npc_sort_band_of(ent),
                          float(ent.get("y", 0) or 0) + dy,
                          None if foot is None else foot + dy)
        out.append((z, 2_000_000 + i, item, ref.key))

    return out


def _pf(view, ent: dict, kind: str,
        foot_x: float | None = None, foot_y: float | None = None) -> float:
    """透视系数。视图提供唯一出口；拿不到（脱离视图单测）时按 1。

    ``foot_x/foot_y`` = **接地点**（锚点非底中时与实体位置不同）。不传时
    连参数都不传给视图 —— 单测里的桩视图只认两个位参，多喂两个会被下面的
    ``except TypeError`` 吞成 1.0（"系数静默变成 1"是最难查的那类回归）。
    """
    getter = getattr(view, "perspective_factor", None)
    if not callable(getter):
        return 1.0
    try:
        if foot_x is None and foot_y is None:
            return float(getter(ent, kind))
        return float(getter(ent, kind, foot_x, foot_y))
    except (TypeError, ValueError):
        return 1.0


def assign_content_z(document, view, *, probe=None, cache: tuple | None = None):
    """按运行时规则给内容图元派 z。返回新的脏检查键（相同则未改动）。

    脏检查不是可选优化：巡逻预览开着时 NPC 的 y 每拍都在变，不比对就会每拍对
    全场 `setZValue`。键用**实体 ref**而不是 `id(item)` —— CPython 的 id 是内存
    地址、会被回收复用，图元换人后键"看着没变"，该重排的一趟被静默跳过。
    """
    entries = content_sort_entries(document, view, probe=probe)
    entries.sort(key=lambda e: (e[0], e[1]))
    key = tuple((tie, round(z, 4), ref_key) for z, tie, _item, ref_key in entries)
    if cache is not None and key == cache:
        return key
    for rank, (_z, _tie, item, _ref) in enumerate(entries):
        item.setZValue(Z_CONTENT_LO + rank * CONTENT_STEP)
    return key
