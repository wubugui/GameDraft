"""具体图元 —— 每种实体在画布上长什么样。

全部继承 `items.EntityItem`（不吃鼠标）。**它们只负责画**：几何从 Document 现取，
命中由工具决定。所以这里没有一行 `mousePressEvent`。
"""
from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QBrush, QColor, QPen, QPolygonF

from .changes import EntityRef
from .items import EntityItem
from .renderer import point_in_polygon, point_segment_distance_sq

__all__ = [
    "HANDLE_R_PX",
    "KIND_COLORS",
    "HandleItem",
    "PolygonItem",
    "PolylineItem",
]

#: 把手绘制半径（屏幕像素）。绘制与命中都按屏幕像素 —— 两者用同一口径，
#: 免得出现"看着能点、实际点不中"（老画布顶点就是这么点不中的）。
HANDLE_R_PX = 7.0

#: 各实体族的颜色。与老画布保持一致，免得策划换页要重新认颜色。
KIND_COLORS = {
    "hotspot": QColor(60, 140, 255, 190),
    "npc": QColor(180, 80, 220, 200),
    "zone": QColor(255, 200, 0, 90),
    "spawn": QColor(255, 255, 255, 215),
}
_SELECTED_PEN = QPen(QColor(255, 236, 120), 0)
_HOVER_PEN = QPen(QColor(255, 255, 255, 200), 0)


class _StateMixin:
    """选中/悬停态。由视图按 Document 的选择集刷，不是图元自己维护。"""

    def __init__(self, *a, **kw) -> None:
        super().__init__(*a, **kw)
        self._selected = False
        self._hovered = False

    def set_selected(self, on: bool) -> None:
        if self._selected != bool(on):
            self._selected = bool(on)
            self.update()

    def set_hovered(self, on: bool) -> None:
        if self._hovered != bool(on):
            self._hovered = bool(on)
            self.update()


class HandleItem(_StateMixin, EntityItem):
    """锚点把手（hotspot / npc / spawn 共用）。

    半径按**屏幕像素**恒定：用 `ItemIgnoresTransformations` 让子坐标系不跟着缩放，
    于是缩小视图后把手不会缩成一个点。老画布的把手是世界单位，缩到 0.2 倍就没了。
    """

    def __init__(self, ref: EntityRef, color: QColor | None = None) -> None:
        super().__init__(ref)
        self._color = color or KIND_COLORS.get(ref.kind, QColor(200, 200, 200, 200))
        self._radius_px = HANDLE_R_PX
        self._range_world = 0.0
        self._scale = 1.0
        self.setFlag(
            EntityItem.GraphicsItemFlag.ItemIgnoresTransformations, True)

    def set_view_scale(self, scale: float) -> None:
        """交互半径圈画在世界坐标里，需要知道缩放才能换算成本地像素。"""
        s = float(scale) if scale and scale > 1e-9 else 1e-9
        if s != self._scale:
            self.prepareGeometryChange()
            self._scale = s
            self.update()

    def set_interaction_range(self, world_radius: float) -> None:
        r = max(0.0, float(world_radius or 0.0))
        if r != self._range_world:
            self.prepareGeometryChange()
            self._range_world = r
            self.update()

    def _range_px(self) -> float:
        return self._range_world * self._scale

    def boundingRect(self) -> QRectF:
        r = max(self._radius_px, self._range_px()) + 2.0
        return QRectF(-r, -r, r * 2.0, r * 2.0)

    def paint(self, painter, option, widget=None) -> None:
        painter.setRenderHint(painter.RenderHint.Antialiasing, True)
        rp = self._range_px()
        if rp > self._radius_px:
            painter.setPen(QPen(QColor(255, 255, 255, 60), 0, Qt.PenStyle.DotLine))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawEllipse(QPointF(0, 0), rp, rp)
        painter.setBrush(QBrush(self._color))
        if self._selected:
            painter.setPen(_SELECTED_PEN)
        elif self._hovered:
            painter.setPen(_HOVER_PEN)
        else:
            painter.setPen(QPen(self._color.darker(150), 0))
        r = self._radius_px
        painter.drawEllipse(QPointF(0, 0), r, r)

    def pick_rect(self) -> QRectF:
        """把手的命中范围只算圆点本身，**不含交互半径圈** ——
        那个圈动辄上百世界单位，算进去会把下方的一切都吞掉。"""
        r = self._radius_px / self._scale
        return QRectF(self.pos().x() - r, self.pos().y() - r, r * 2.0, r * 2.0)


class _PointsItem(_StateMixin, EntityItem):
    """折线/多边形的公共部分：点列 + 顶点手柄绘制。"""

    def __init__(self, ref: EntityRef, color: QColor, *, closed: bool) -> None:
        super().__init__(ref)
        self._pts: list[tuple[float, float]] = []
        self._color = color
        self._closed = closed
        self._scale = 1.0
        self._active_vertex: int | None = None

    @property
    def closed(self) -> bool:
        return self._closed

    def points(self) -> list[tuple[float, float]]:
        return list(self._pts)

    def set_points(self, pts) -> None:
        new = [(float(p["x"]), float(p["y"])) if isinstance(p, dict)
               else (float(p[0]), float(p[1])) for p in pts or []]
        if new != self._pts:
            self.prepareGeometryChange()
            self._pts = new
            self.update()

    def set_view_scale(self, scale: float) -> None:
        s = float(scale) if scale and scale > 1e-9 else 1e-9
        if s != self._scale:
            self.prepareGeometryChange()
            self._scale = s
            self.update()

    def set_active_vertex(self, index: int | None) -> None:
        if index != self._active_vertex:
            self._active_vertex = index
            self.update()

    def _handle_r_world(self) -> float:
        return HANDLE_R_PX / self._scale

    def boundingRect(self) -> QRectF:
        if not self._pts:
            return QRectF()
        xs = [p[0] for p in self._pts]
        ys = [p[1] for p in self._pts]
        pad = self._handle_r_world() + 2.0
        return QRectF(min(xs) - pad, min(ys) - pad,
                      max(xs) - min(xs) + pad * 2, max(ys) - min(ys) + pad * 2)

    def pick_contains(self, pos, tol: float = 0.0) -> bool:
        """按**真实形状**判定命中：顶点圈 → 边线带 → （闭合时）形内。

        缺省实现拿 AABB 比，对三角形/凹多边形/折线的误差见
        `EntityItem.pick_contains` 的说明。
        """
        pts = self._pts
        if not pts:
            return False
        px, py = pos.x(), pos.y()
        r = max(self._handle_r_world(), float(tol))
        r2 = r * r
        for x, y in pts:
            dx = x - px
            dy = y - py
            if dx * dx + dy * dy <= r2:
                return True
        n = len(pts)
        closed = self._closed and n >= 3
        span = n if closed else n - 1
        for i in range(max(0, span)):
            ax, ay = pts[i]
            bx, by = pts[(i + 1) % n]
            if point_segment_distance_sq(px, py, ax, ay, bx, by) <= r2:
                return True
        return closed and point_in_polygon(px, py, pts)

    def paint(self, painter, option, widget=None) -> None:
        if not self._pts:
            return
        painter.setRenderHint(painter.RenderHint.Antialiasing, True)
        poly = QPolygonF([QPointF(x, y) for x, y in self._pts])
        pen = _SELECTED_PEN if self._selected else QPen(self._color.darker(140), 0)
        painter.setPen(pen)
        if self._closed and len(self._pts) >= 3:
            painter.setBrush(QBrush(self._color))
            painter.drawPolygon(poly)
        else:
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawPolyline(poly)
        # 顶点手柄：只在选中时画，免得满屏都是点
        if not self._selected:
            return
        r = self._handle_r_world()
        for i, (x, y) in enumerate(self._pts):
            painter.setBrush(QBrush(
                QColor(255, 236, 120) if i == self._active_vertex
                else QColor(255, 255, 255, 220)))
            painter.setPen(QPen(QColor(40, 40, 40), 0))
            painter.drawEllipse(QPointF(x, y), r, r)


class PolygonItem(_PointsItem):
    """闭合多边形：Zone、碰撞面。"""

    def __init__(self, ref: EntityRef, color: QColor | None = None) -> None:
        super().__init__(ref, color or KIND_COLORS.get(ref.kind, QColor(255, 200, 0, 90)),
                         closed=True)


class PolylineItem(_PointsItem):
    """开放折线：巡逻路线、光环境曲线。**不是闭合的** —— 闭合边不存在，
    所以双击最后一点与第一点之间的空白不该插点。"""

    def __init__(self, ref: EntityRef, color: QColor | None = None) -> None:
        super().__init__(ref, color or QColor(0, 200, 220, 220), closed=False)
