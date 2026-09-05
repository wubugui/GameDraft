"""实体前后次序规则的编辑器侧镜像 —— 运行时 ``src/rendering/entitySortRule.ts`` 的对照实现。

## 为什么需要这一份

场景画布此前用一张**写死的固定层表**决定前后（NPC 精灵恒 z=-10、热点展示图恒 z=-4），
而运行时是「三档 × 档内按脚底 y」实时排序。两者算的根本不是一回事，后果是
**编辑器里 NPC 永远被热点贴图压住**，策划照着画布排前后关系等于白排 —— 这是
「编辑器骗人」里最贵的一类：看着对、跑起来不对，而且没有任何东西会报错。

## 镜像了哪些 TS

| 本文件 | 运行时权威源 |
|---|---|
| :func:`entity_sort_z` / :func:`resolve_entity_sort_band` | ``src/rendering/entitySortRule.ts`` |
| :func:`point_polygon_vertical_side` / :func:`is_valid_zone_polygon` | ``src/utils/zoneGeometry.ts`` |
| :func:`anchor_collision_polygon_to_world` | ``src/utils/hotspotCollision.ts`` |
| :func:`hotspot_sort_band_of` | ``src/entities/Hotspot.ts`` ``_syncEntitySortBand`` |
| :func:`npc_sort_band_of` | ``src/entities/Npc.ts`` ``applySpriteSortBand`` |
| ``quad_ground_y_around_foot``（在 entity_transform_math） | ``src/utils/entityTransform.ts`` |

norms 第 8 条：手工镜像必配语义级 parity。护栏是
``tools/editor/tests/test_entity_sort_parity.py`` ↔ ``src/rendering/entitySortRule.test.ts``，
两侧钉死**同一组黄金用例**，改一处必改两处。

## 三条最容易抄错的地方（都被 parity 用例锁住）

1. :func:`point_polygon_vertical_side` 返回 ``None``（参照点 x 落在多边形水平跨度之外）时
   **保留静态档位、不覆盖** —— 既不是 front 也不是 back。写成 ``else`` 分支即错。
2. **只有热点**带遮挡多边形。NPC 的 ``collisionPolygon`` 完全不参与遮挡带
   （全仓 grep 确认 ``entityOcclusionPolygon`` 只在 ``Hotspot.ts`` 出现）。
   一视同仁会造出运行时根本不存在的层级翻转。
3. 热点档位额外要求**贴图真的加载成功**（运行时 ``displaySprite !== null``；
   编辑器即"pixmap 读出来了、没画成紫色缺件框"），NPC 侧**不要求**精灵装载。
   这个不对称很容易被顺手抹平。
"""
from __future__ import annotations

import math
from typing import Literal, Sequence

from .entity_transform_math import (
    entity_contact_offset,
    entity_rotation_deg_of,
    entity_scale_of,
    quad_ground_y_around_foot,
    transform_local_vec,
)

__all__ = [
    "ENTITY_SORT_BAND",
    "SortBand",
    "VerticalSide",
    "is_valid_zone_polygon",
    "point_polygon_vertical_side",
    "anchor_collision_polygon_to_world",
    "hotspot_collision_polygon_to_world",
    "resolve_entity_sort_band",
    "entity_sort_z",
    "hotspot_sort_band_of",
    "npc_sort_band_of",
    "sort_foot_y_of",
]

#: 档位偏移。远大于任何场景世界高度，保证 back / 无档 / front 三个区间不重叠。
#: 与 ``entitySortRule.ts`` 的 ``ENTITY_SORT_BAND`` 一字不差。
ENTITY_SORT_BAND = 10_000_000

SortBand = Literal["back", "front"]
VerticalSide = Literal["above", "below", "inside"]

Point = dict  # {"x": float, "y": float}


# ---------------------------------------------------------------------------
# zoneGeometry.ts 镜像
# ---------------------------------------------------------------------------

def is_valid_zone_polygon(polygon: object) -> bool:
    """镜像 TS ``isValidZonePolygon``：≥3 点且每点 x/y 都是有限数。

    TS 侧用 ``typeof p.x !== 'number'`` 拒绝非数字；Python 侧对应拒绝 ``bool``
    与非 ``int/float``（``bool`` 是 ``int`` 子类，不拦会让 ``True`` 被当成 1）。
    """
    if not isinstance(polygon, (list, tuple)) or len(polygon) < 3:
        return False
    for p in polygon:
        if not isinstance(p, dict):
            return False
        for key in ("x", "y"):
            v = p.get(key)
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                return False
            if not math.isfinite(float(v)):
                return False
    return True


def point_polygon_vertical_side(
    polygon: Sequence[Point], px: float, py: float,
) -> VerticalSide | None:
    """镜像 TS ``pointPolygonVerticalSide``：**竖直扫描线**，不是点在多边形内。

    在 ``px`` 处作一条竖线，收集它与各边的交点 y，得到 [yMin, yMax]：

    - ``py < yMin`` → ``"above"``（参照点比这块面更远）
    - ``py > yMax`` → ``"below"``（参照点比这块面更近）
    - 其余 → ``"inside"``
    - 一条边都没交到（``px`` 在多边形水平跨度之外）→ ``None``

    ``None`` 是**有语义的第四态**：调用方必须"保留静态档位"，不得当成 above/below。
    """
    n = len(polygon)
    if n < 3:
        return None
    y_min = math.inf
    y_max = -math.inf
    hit_count = 0
    j = n - 1
    for i in range(n):
        xi = float(polygon[i].get("x", 0))
        xj = float(polygon[j].get("x", 0))
        # 与 TS 完全一致的含端点判定（<=，共享顶点会被重复命中，两侧同样重复）
        if (xi <= px <= xj) or (xj <= px <= xi):
            dx = xj - xi
            t = 0.5 if abs(dx) < 1e-12 else (px - xi) / dx
            if t < 0 or t > 1:
                j = i
                continue
            yi = float(polygon[i].get("y", 0))
            yj = float(polygon[j].get("y", 0))
            y_hit = yi + t * (yj - yi)
            if y_hit < y_min:
                y_min = y_hit
            if y_hit > y_max:
                y_max = y_hit
            hit_count += 1
        j = i
    if hit_count == 0:
        return None
    if py < y_min:
        return "above"
    if py > y_max:
        return "below"
    return "inside"


# ---------------------------------------------------------------------------
# hotspotCollision.ts 镜像
# ---------------------------------------------------------------------------

def anchor_collision_polygon_to_world(
    anchor_x: float, anchor_y: float, d: dict, extra_scale: float = 1.0,
) -> list[Point] | None:
    """镜像 TS ``anchorCollisionPolygonToWorld``：authored 多边形 → 世界坐标。

    ``collisionPolygonLocal is True`` 时 authored 点是相对锚点的局部坐标，否则是旧数据
    的世界坐标。两种都在**求值时**绕锚点施加实例 transform 与 ``extra_scale``（透视系数）。

    ⚠ 判遮挡带必须用**乘过透视系数**的这一份，不是画布上 authored 空间的可编辑多边形。
    """
    poly = d.get("collisionPolygon")
    if not is_valid_zone_polygon(poly):
        return None
    es = extra_scale if (math.isfinite(extra_scale) and extra_scale > 0) else 1.0
    s = entity_scale_of(d)
    rot = entity_rotation_deg_of(d)
    has_xform = s != 1 or rot != 0
    transformed = has_xform or es != 1
    if d.get("collisionPolygonLocal") is not True:
        if not transformed:
            return [{"x": float(p["x"]), "y": float(p["y"])} for p in poly]
        out: list[Point] = []
        for p in poly:
            vx, vy = transform_local_vec(
                float(p["x"]) - anchor_x, float(p["y"]) - anchor_y, s, rot)
            out.append({"x": anchor_x + vx * es, "y": anchor_y + vy * es})
        return out
    if not transformed:
        return [{"x": float(p["x"]) + anchor_x, "y": float(p["y"]) + anchor_y} for p in poly]
    out = []
    for p in poly:
        vx, vy = transform_local_vec(float(p["x"]), float(p["y"]), s, rot)
        out.append({"x": anchor_x + vx * es, "y": anchor_y + vy * es})
    return out


def hotspot_collision_polygon_to_world(
    d: dict, extra_scale: float = 1.0,
) -> list[Point] | None:
    """镜像 TS ``hotspotCollisionPolygonToWorld``：锚点取热点自身 x/y。"""
    return anchor_collision_polygon_to_world(
        float(d.get("x", 0)), float(d.get("y", 0)), d, extra_scale)


# ---------------------------------------------------------------------------
# entitySortRule.ts 镜像
# ---------------------------------------------------------------------------

def resolve_entity_sort_band(
    band: SortBand | None,
    occlusion_polygon: Sequence[Point] | None,
    player_foot: tuple[float, float] | None,
) -> SortBand | None:
    """镜像 TS ``resolveEntitySortBand``：动态遮挡带优先于静态档位。

    ``side is None``（参照点 x 在多边形水平跨度之外）时**保留静态档位、不覆盖**。
    """
    if player_foot is not None and occlusion_polygon and len(occlusion_polygon) >= 3:
        side = point_polygon_vertical_side(
            occlusion_polygon, player_foot[0], player_foot[1])
        if side == "below":
            return "back"
        if side in ("above", "inside"):
            return "front"
        # side is None → 落到下面 return band，不覆盖
    return band


def entity_sort_z(
    band: SortBand | None,
    y: float,
    sort_foot_y: float | None = None,
    occlusion_polygon: Sequence[Point] | None = None,
    player_foot: tuple[float, float] | None = None,
) -> float:
    """镜像 TS ``entitySortZ``：单个实体的排序键。档内按脚底 y 升序，z 越大越靠前。

    ``sort_foot_y`` 走 TS 的 ``??`` 语义 —— **0 是有效值**，只有 ``None`` 才回落 ``y``。
    """
    resolved = resolve_entity_sort_band(band, occlusion_polygon, player_foot)
    foot_y = y if sort_foot_y is None else sort_foot_y
    if resolved == "back":
        return -ENTITY_SORT_BAND + foot_y
    if resolved == "front":
        return ENTITY_SORT_BAND + foot_y
    return foot_y


# ---------------------------------------------------------------------------
# 实体 → 排序输入的派生（镜像 Hotspot.ts / Npc.ts）
# ---------------------------------------------------------------------------

def _band_of(raw: object) -> SortBand | None:
    v = str(raw or "").strip().lower()
    return v if v in ("back", "front") else None  # type: ignore[return-value]


def hotspot_sort_band_of(hs: dict, texture_loaded: bool) -> SortBand | None:
    """镜像 ``Hotspot._syncEntitySortBand``。**五个条件全满足才有档位**：

    展示图贴图真的加载成功 且 ``image`` 非空 且 ``worldWidth > 0`` 且
    ``worldHeight > 0`` 且 ``spriteSort ∈ {back, front}``。

    ``texture_loaded`` 对应运行时的 ``displaySprite !== null``：编辑器里即
    "读盘拿到了 pixmap"，画成紫色缺件框时应传 ``False``（那时运行时也没有档位）。
    """
    di = hs.get("displayImage")
    if not isinstance(di, dict):
        return None
    if not texture_loaded:
        return None
    if not str(di.get("image", "") or "").strip():
        return None
    try:
        ww = float(di.get("worldWidth", 0) or 0)
        hh = float(di.get("worldHeight", 0) or 0)
    except (TypeError, ValueError):
        return None
    if ww <= 0 or hh <= 0:
        return None
    return _band_of(di.get("spriteSort"))


def npc_sort_band_of(npc: dict) -> SortBand | None:
    """镜像 ``Npc.applySpriteSortBand``：只看 ``def.spriteSort``。

    **不要求精灵已装载** —— 与热点侧刻意不对称，别顺手抹平。
    """
    return _band_of(npc.get("spriteSort"))


def sort_foot_y_of(
    d: dict, eff_w: float, eff_h: float, mirror_x: float = 1.0,
) -> float | None:
    """镜像 ``_syncSortFootY``：**锚点非底中**或**带旋转**时才有接地线，否则 ``None``。

    两种偏移**叠加**，一次合成：相对接地点，quad 恒是「底中锚、宽 eff_w、高 eff_h」，
    所以接地线 = ``quad_ground_y_around_foot(接地点 y, eff_w, eff_h, φ)``。
    无旋转时该函数是恒等，结果就是接地点 y；缺省锚点且无旋转时偏移与旋转都为 0，
    返回 ``None`` 回落锚点 y —— 这正是改造前的唯一分支。

    ``eff_w/eff_h`` 传**有效尺寸**（已含实例 scale 与透视系数）。``eff_h <= 0``
    （热点无展示图 / NPC 动画包缺件，运行时 ``getWorldSize()`` 为 0）同样回落 ``None``：
    此时锚点偏移也退化成 0，与运行时 ``quadGroundYAroundFoot(y, 0, 0, φ) == y`` 同值。

    ``mirror_x`` 是实体的左右镜像符号（运行时住在外层容器 ``scale.x`` 上）；只有
    **横向偏心锚 + 旋转**才用得到它，缺省锚点时无影响。
    """
    rot = entity_rotation_deg_of(d)
    if eff_h <= 0:
        return None
    _ox, oy = entity_contact_offset(d, eff_w, eff_h, mirror_x)
    if rot == 0 and _ox == 0 and oy == 0:
        return None
    return quad_ground_y_around_foot(
        float(d.get("y", 0)) + oy, eff_w, eff_h, math.radians(rot))
