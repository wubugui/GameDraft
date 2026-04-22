"""谣言图：QGraphicsObject 节点 + QGraphicsItem 边（参见 Qt for Python external_networkx 示例）。"""
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


class RumorGraphNode(QGraphicsObject):
    def __init__(
        self,
        agent_id: str,
        label: str,
        tooltip: str,
        radius: float = 28.0,
    ) -> None:
        super().__init__()
        self._agent_id = agent_id
        self._label = label
        self._tooltip = tooltip
        self._r = radius
        self._edges: list[RumorGraphEdge] = []
        self._chain = False
        self.setFlag(QGraphicsObject.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsObject.GraphicsItemFlag.ItemSendsGeometryChanges, True)
        self.setCacheMode(QGraphicsItem.CacheMode.DeviceCoordinateCache)
        self.setZValue(2.0)
        self.setToolTip(tooltip)
        self.setAcceptHoverEvents(True)

    def add_edge(self, e: "RumorGraphEdge") -> None:
        if e not in self._edges:
            self._edges.append(e)

    def set_chain_highlighted(self, on: bool) -> None:
        if self._chain != on:
            self._chain = on
            self.update()

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

    def center_scene(self) -> QPointF:
        c = self.boundingRect().center()
        return self.mapToScene(c)

    def paint(
        self,
        painter: QPainter,
        _option: QStyleOptionGraphicsItem,
        _widget: QWidget | None = None,
    ) -> None:
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        r = self._r
        if self._chain:
            painter.setPen(QPen(QColor("#b7791f"), 3.0))
            painter.setBrush(QBrush(QColor("#fffff0")))
        else:
            painter.setPen(QPen(QColor("#2b6cb0"), 2.5))
            painter.setBrush(QBrush(QColor("#ebf8ff")))
        painter.drawEllipse(QRectF(0, 0, 2 * r, 2 * r))
        f = QFont("Microsoft YaHei", 10)
        f.setWeight(QFont.Weight.DemiBold)
        painter.setFont(f)
        painter.setPen(QColor("#1a365d"))
        fm = QFontMetricsF(f)
        tw = fm.horizontalAdvance(self._label)
        th = fm.height()
        painter.drawText(
            QPointF(r - tw / 2, r + th / 4 - 1),
            self._label,
        )


class RumorGraphEdge(QGraphicsItem):
    def __init__(
        self,
        source: RumorGraphNode,
        dest: RumorGraphNode,
        *,
        row_index: int,
        distorted: bool,
        offset_index: int,
        content_tip: str,
        on_click: Callable[[int], None] | None = None,
    ) -> None:
        super().__init__()
        self._from = source
        self._to = dest
        self._row_index = row_index
        self._distorted = distorted
        self._off_i = offset_index
        self._r = source._r
        self._on_click = on_click
        self.setZValue(0.0)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)
        self.setAcceptHoverEvents(True)
        self._pen_w = 2.8 if distorted else 2.2
        self._base_color = QColor("#276749" if distorted else "#4a5568")
        self.setToolTip(content_tip)
        self._line = QLineF()
        self._arrow = QPolygonF()
        self._selected = False
        self._hover = False
        self.adjust()

    def row_index(self) -> int:
        return self._row_index

    def set_highlighted(self, on: bool) -> None:
        if self._selected != on:
            self._selected = on
            self.update()

    def type(self) -> int:  # type: ignore[override]
        return QGraphicsItem.UserType + 1

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
        self.prepareGeometryChange()
        self.update()

    def boundingRect(self) -> QRectF:  # type: ignore[override]
        p = QPainterPath()
        p.moveTo(self._line.p1())
        p.lineTo(self._line.p2())
        p.addPolygon(self._arrow)
        return p.boundingRect().adjusted(-8, -8, 8, 8)

    def shape(self) -> QPainterPath:  # type: ignore[override]
        core = QPainterPath()
        core.moveTo(self._line.p1())
        core.lineTo(self._line.p2())
        stroker = QPainterPathStroker()
        stroker.setWidth(14.0)
        return stroker.createStroke(core)

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
            c = QColor("#1a4d2e" if self._distorted else "#2d3748")
            w = w + 2.0
        elif self._hover:
            w = w + 0.5
        painter.setPen(QPen(c, w, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
        painter.drawLine(self._line)
        painter.setBrush(QBrush(c))
        painter.setPen(QPen(Qt.PenStyle.NoPen))
        painter.drawPolygon(self._arrow)

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
            self._on_click(self._row_index)
            event.accept()
            return
        super().mousePressEvent(event)
