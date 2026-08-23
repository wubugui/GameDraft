"""坐标与形状 —— 画什么、点得到什么，是**两件事**。

镜像 Tiled 的 `maprenderer.h`，它同时声明 ``shape()`` 与 ``interactionShape()``。
这个分离堵掉老画布两个至今没修的 bug：

- **"提示写着双击边线插点，实际怎么点都没反应"**（巡逻折线、光曲线两处）。
  根因是 ``shape()`` 一个函数既管画又管点，而这两个需求互斥：为了不挡住下方实体，
  ``shape()`` 被收窄成"仅顶点"，于是边线根本收不到双击。
- **"大场景缩放后顶点只有 3 像素，按不中"**。老画布的顶点手柄是**世界单位**
  写死的（`HANDLE_WORLD_R = 14`），fit 到 0.2 倍就剩 3 像素。分组框那一族已经
  改成按屏幕像素定尺，顶点没跟上。

所以这里的铁律是：**命中尺寸一律屏幕像素**，由 `view_scale` 换算回世界单位。
"""
from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF
from PySide6.QtGui import QPainterPath, QPolygonF

__all__ = [
    "HANDLE_PICK_PX",
    "EDGE_PICK_PX",
    "MIN_PICK_PX",
    "SceneRenderer",
]

#: 顶点手柄的命中半径（**屏幕像素**）。取值参考老画布分组框那一族已经验证过的
#: 9px 命中带，略放宽到 10 —— 顶点是精细操作，宁可好点一点。
HANDLE_PICK_PX = 10.0

#: 边线（多边形边、折线段）的命中带宽（屏幕像素）。双击插点靠它。
EDGE_PICK_PX = 6.0

#: 任何可点元素的最小命中尺寸（屏幕像素）。缩得再小也要留住这么多。
MIN_PICK_PX = 8.0


class SceneRenderer:
    """世界坐标 ↔ 屏幕像素的换算，以及"命中形状"的构造。

    刻意**不持有 Qt 视图**：只吃一个 `view_scale`（世界单位 → 屏幕像素的倍率）。
    这样它零 Qt 依赖之外还能脱离 QGraphicsView 单测，命中尺寸的回归可以直接
    断数值，不必造一个真视口。
    """

    def __init__(self, view_scale: float = 1.0) -> None:
        self._scale = 1.0
        self.set_view_scale(view_scale)

    # ---- 缩放 --------------------------------------------------------------

    def set_view_scale(self, scale: float) -> None:
        """视图缩放变了就更新。命中尺寸全部由它换算，改一处即可全局跟上。"""
        try:
            s = float(scale)
        except (TypeError, ValueError):
            s = 1.0
        # 钳到正数：fitInView 在极端场景下会给出 0 或极小值，除零会让命中带炸成无穷
        self._scale = s if s > 1e-9 else 1e-9

    @property
    def view_scale(self) -> float:
        return self._scale

    def px_to_world(self, pixels: float) -> float:
        """屏幕像素 → 世界单位。**命中尺寸唯一的换算出口。**"""
        return float(pixels) / self._scale

    def world_to_px(self, world: float) -> float:
        return float(world) * self._scale

    # ---- 命中形状 ----------------------------------------------------------

    def handle_radius_world(self) -> float:
        """顶点/把手的命中半径（世界单位，随缩放变化）。"""
        return self.px_to_world(HANDLE_PICK_PX)

    def edge_width_world(self) -> float:
        """边线命中带的半宽（世界单位）。"""
        return self.px_to_world(EDGE_PICK_PX)

    def handle_rect(self, center: QPointF) -> QRectF:
        r = self.handle_radius_world()
        return QRectF(center.x() - r, center.y() - r, r * 2.0, r * 2.0)

    def vertex_hit_index(
        self, points: list[QPointF] | list[tuple[float, float]], at: QPointF,
    ) -> int | None:
        """落点命中了哪个顶点；没有返回 ``None``。半径按屏幕像素恒定。"""
        r = self.handle_radius_world()
        r2 = r * r
        best: tuple[float, int] | None = None
        for i, p in enumerate(points):
            px, py = (p.x(), p.y()) if isinstance(p, QPointF) else (p[0], p[1])
            dx = px - at.x()
            dy = py - at.y()
            d2 = dx * dx + dy * dy
            if d2 <= r2 and (best is None or d2 < best[0]):
                best = (d2, i)
        return None if best is None else best[1]

    def edge_hit_index(
        self,
        points: list[QPointF] | list[tuple[float, float]],
        at: QPointF,
        *,
        closed: bool,
    ) -> int | None:
        """落点命中了哪条边（返回边的起点下标）；没有返回 ``None``。

        **双击插点靠它。** 老画布没有这个函数，插点提示因此长期是空头支票。
        """
        pts = [(p.x(), p.y()) if isinstance(p, QPointF) else (float(p[0]), float(p[1]))
               for p in points]
        n = len(pts)
        if n < 2:
            return None
        w = self.edge_width_world()
        limit = w * w
        span = n if closed else n - 1
        best: tuple[float, int] | None = None
        for i in range(span):
            ax, ay = pts[i]
            bx, by = pts[(i + 1) % n]
            d2 = _point_segment_distance_sq(at.x(), at.y(), ax, ay, bx, by)
            if d2 <= limit and (best is None or d2 < best[0]):
                best = (d2, i)
        return None if best is None else best[1]

    def stroked_path(
        self, points: list[tuple[float, float]], *, closed: bool,
    ) -> QPainterPath:
        """把折线/多边形边描成一条有宽度的命中路径（宽度按屏幕像素恒定）。"""
        path = QPainterPath()
        if len(points) < 2:
            return path
        poly = QPolygonF([QPointF(x, y) for x, y in points])
        if closed:
            path.addPolygon(poly)
            path.closeSubpath()
        else:
            path.moveTo(poly[0])
            for i in range(1, len(poly)):
                path.lineTo(poly[i])
        return path

    def inflate_for_picking(self, rect: QRectF) -> QRectF:
        """把包围盒撑到至少 :data:`MIN_PICK_PX` 见方（世界单位换算）。

        细长或极小的图元（一条水平线、一个 2×2 的贴图）否则几乎点不中。
        """
        need = self.px_to_world(MIN_PICK_PX)
        dw = max(0.0, need - rect.width()) / 2.0
        dh = max(0.0, need - rect.height()) / 2.0
        return rect.adjusted(-dw, -dh, dw, dh)


def _point_segment_distance_sq(
    px: float, py: float, ax: float, ay: float, bx: float, by: float,
) -> float:
    """点到线段的距离平方。退化线段（两端重合）按点距处理。"""
    vx = bx - ax
    vy = by - ay
    len2 = vx * vx + vy * vy
    if len2 <= 1e-18:
        dx = px - ax
        dy = py - ay
        return dx * dx + dy * dy
    t = ((px - ax) * vx + (py - ay) * vy) / len2
    t = 0.0 if t < 0.0 else (1.0 if t > 1.0 else t)
    cx = ax + t * vx
    cy = ay + t * vy
    dx = px - cx
    dy = py - cy
    return dx * dx + dy * dy
