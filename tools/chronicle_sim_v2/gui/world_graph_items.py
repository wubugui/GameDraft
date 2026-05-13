"""世界关系图图元：QGraphicsObject 节点 + QGraphicsItem 边（与谣言图同模式，样式按实体类型区分）。"""
from __future__ import annotations

import math
from collections.abc import Callable
from typing import Any

from PySide6.QtCore import QLineF, QPointF, QRectF, Qt
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QFontMetricsF,
    QPainter,
    QPainterPath,
    QPainterPathStroker,
    QPen,
    QPolygonF,
)
from PySide6.QtWidgets import (
    QGraphicsItem,
    QGraphicsObject,
    QStyleOptionGraphicsItem,
    QWidget,
)

_NODE_STYLES: dict[str, tuple[str, str, str]] = {
    "agent": ("#2b6cb0", "#ebf8ff", "#1a365d"),
    "faction": ("#c05621", "#fffaf0", "#7b3410"),
    "location": ("#2f855a", "#f0fff4", "#1c4532"),
    "other": ("#4a5568", "#edf2f7", "#2d3748"),
}


class WorldGraphNode(QGraphicsObject):
    def __init__(
        self,
        node_id: str,
        kind: str,
        label: str,
        tooltip: str,
        radius: float = 28.0,
    ) -> None:
        super().__init__()
        self._node_id = node_id
        self._kind = kind if kind in _NODE_STYLES else "other"
        self._label = label
        self._tooltip = tooltip
        self._r = radius
        self._edges: list[WorldGraphEdge] = []
        self.setFlag(QGraphicsObject.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsObject.GraphicsItemFlag.ItemSendsGeometryChanges, True)
        self.setCacheMode(QGraphicsItem.CacheMode.DeviceCoordinateCache)
        self.setZValue(2.0)
        self.setToolTip(tooltip)
        self.setAcceptHoverEvents(True)

    def add_edge(self, e: "WorldGraphEdge") -> None:
        if e not in self._edges:
            self._edges.append(e)

    def boundingRect(self) -> QRectF:  # type: ignore[override]
        m = 2.0
        return QRectF(-m, -m, 2 * self._r + 2 * m, 2 * self._r + 2 * m)

    def itemChange(  # type: ignore[override]
        self, change: QGraphicsObject.GraphicsItemChange, value: Any
    ) -> Any:
        if change == QGraphicsObject.GraphicsItemChange.ItemPositionHasChanged and self.scene():
            for e in self._edges:
                e.adjust()
        return super().itemChange(change, value)

    def paint(
        self,
        painter: QPainter,
        _option: QStyleOptionGraphicsItem,
        _widget: QWidget | None = None,
    ) -> None:
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        r = self._r
        border, fill, tcol = _NODE_STYLES.get(self._kind, _NODE_STYLES["other"])
        painter.setPen(QPen(QColor(border), 2.5))
        painter.setBrush(QBrush(QColor(fill)))
        painter.drawEllipse(QRectF(0, 0, 2 * r, 2 * r))
        f = QFont("Microsoft YaHei", 9)
        f.setWeight(QFont.Weight.DemiBold)
        painter.setFont(f)
        painter.setPen(QColor(tcol))
        fm = QFontMetricsF(f)
        tw = fm.horizontalAdvance(self._label)
        th = fm.height()
        painter.drawText(
            QPointF(r - tw / 2, r + th / 4 - 1),
            self._label,
        )


class WorldGraphEdge(QGraphicsItem):
    def __init__(
        self,
        source: WorldGraphNode,
        dest: WorldGraphNode,
        *,
        edge_index: int,
        strength: float,
        rel_type: str,
        content_tip: str,
        on_click: Callable[[int], None] | None = None,
        offset_index: int = 0,
    ) -> None:
        super().__init__()
        self._from = source
        self._to = dest
        self._edge_index = edge_index
        self._strength = max(0.0, min(1.0, float(strength)))
        self._rel_type = (rel_type or "").strip()
        self._r = source._r
        self._on_click = on_click
        self._off_i = offset_index
        self.setZValue(0.0)
        self.setAcceptHoverEvents(True)
        w = 1.3 + self._strength * 2.2
        self._pen_w = w
        self._base_color = QColor("#2c5282")
        self.setToolTip(content_tip)
        self._line = QLineF()
        self._arrow = QPolygonF()
        self._label_bg = QRectF()
        self._selected = False
        self._hover = False
        self.adjust()

    def set_highlighted(self, on: bool) -> None:
        if self._selected != on:
            self._selected = on
            self.update()

    def edge_index(self) -> int:
        return self._edge_index

    def _parallel_offset(self) -> float:
        return float(self._off_i) * 7.0

    def adjust(self) -> None:
        c1 = self._from.mapToScene(QPointF(self._r, self._r))
        c2 = self._to.mapToScene(QPointF(self._r, self._r))
        dx, dy = c2.x() - c1.x(), c2.y() - c1.y()
        dist = math.hypot(dx, dy) or 1e-6
        px, py = -dy / dist, dx / dist
        off = self._parallel_offset()
        c1a = QPointF(c1.x() + px * off, c1.y() + py * off)
        c2a = QPointF(c2.x() + px * off, c2.y() + py * off)
        r = self._r
        dx2, dy2 = c2a.x() - c1a.x(), c2a.y() - c1a.y()
        d2 = math.hypot(dx2, dy2) or 1e-6
        ux, uy = dx2 / d2, dy2 / d2
        s1 = QPointF(c1a.x() + ux * r, c1a.y() + uy * r)
        s2 = QPointF(c2a.x() - ux * r, c2a.y() - uy * r)
        self._line = QLineF(s1, s2)
        alen, aw = 14.0, 9.0
        tx, ty = s2.x(), s2.y()
        bx, by = tx - ux * alen, ty - uy * alen
        perpx, perpy = -uy, ux
        self._arrow = QPolygonF(
            [
                QPointF(tx, ty),
                QPointF(bx + perpx * aw * 0.5, by + perpy * aw * 0.5),
                QPointF(bx - perpx * aw * 0.5, by - perpy * aw * 0.5),
            ]
        )
        mpx = 0.5 * (s1.x() + s2.x())
        mpy = 0.5 * (s1.y() + s2.y())
        tlab = self._rel_type if self._rel_type else "（无类型）"
        if len(tlab) > 16:
            tlab = tlab[:15] + "…"
        st_str = f"{self._strength:.2f}".rstrip("0").rstrip(".")
        line_rt = tlab
        line_st = f"强度 {st_str}"
        fnt = QFont("Microsoft YaHei", 8)
        fnt.setWeight(QFont.Weight.Medium)
        fm = QFontMetricsF(fnt)
        tw = max(fm.horizontalAdvance(line_rt), fm.horizontalAdvance(line_st)) + 8.0
        th = fm.height() * 2.0 + 4.0
        ox = mpx + px * 20.0 - tw * 0.5
        oy = mpy + py * 20.0 - th * 0.5
        self._label_bg = QRectF(ox, oy, tw, th)
        self.prepareGeometryChange()
        self.update()

    def _draw_edge_label(self, painter: QPainter) -> None:
        if self._label_bg.width() < 0.5 or self._label_bg.height() < 0.5:
            return
        tlab = self._rel_type if self._rel_type else "（无类型）"
        if len(tlab) > 16:
            tlab = tlab[:15] + "…"
        st_s = f"{self._strength:.2f}".rstrip("0").rstrip(".")
        line_st = f"强度 {st_s}"
        fnt = QFont("Microsoft YaHei", 8)
        fnt.setWeight(QFont.Weight.Medium)
        painter.setFont(fnt)
        fm = QFontMetricsF(fnt)
        bgc = QColor(255, 255, 255, 228)
        if self._selected:
            bgc = QColor(230, 244, 255, 245)
        painter.setPen(QPen(QColor("#a0aec0"), 0.6))
        painter.setBrush(QBrush(bgc))
        painter.drawRoundedRect(self._label_bg, 3, 3)
        x0 = self._label_bg.left() + 4.0
        top = self._label_bg.top() + 3.0
        l1b = top + fm.ascent()
        painter.setPen(QColor("#1a365d") if not self._selected else QColor("#0c1f3c"))
        painter.drawText(QPointF(x0, l1b), tlab)
        l2b = l1b + fm.height() + 1.0
        painter.setPen(QColor("#4a5568"))
        painter.drawText(QPointF(x0, l2b), line_st)

    def boundingRect(self) -> QRectF:  # type: ignore[override]
        p = QPainterPath()
        p.moveTo(self._line.p1())
        p.lineTo(self._line.p2())
        p.addPolygon(self._arrow)
        br = p.boundingRect().adjusted(-8, -8, 8, 8)
        br = br.united(self._label_bg)
        return br

    def shape(self) -> QPainterPath:  # type: ignore[override]
        core = QPainterPath()
        core.moveTo(self._line.p1())
        core.lineTo(self._line.p2())
        stroker = QPainterPathStroker()
        stroker.setWidth(14.0)
        hit = stroker.createStroke(core)
        hit.addRect(self._label_bg)
        return hit

    def paint(
        self,
        painter: QPainter,
        _option: QStyleOptionGraphicsItem,
        _widget: QWidget | None = None,
    ) -> None:
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        c = self._base_color
        w = self._pen_w
        if self._selected:
            c = QColor("#1a365d")
            w = w + 1.8
        elif self._hover:
            w = w + 0.4
        painter.setPen(QPen(c, w, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
        painter.drawLine(self._line)
        painter.setBrush(QBrush(c))
        painter.setPen(QPen(Qt.PenStyle.NoPen))
        painter.drawPolygon(self._arrow)
        self._draw_edge_label(painter)

    def hoverEnterEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        self._hover = True
        self.update()
        super().hoverEnterEvent(event)

    def hoverLeaveEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        self._hover = False
        self.update()
        super().hoverLeaveEvent(event)

    def mousePressEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        if event.button() == Qt.MouseButton.LeftButton and self._on_click is not None:
            self._on_click(self._edge_index)
            event.accept()
            return
        super().mousePressEvent(event)
