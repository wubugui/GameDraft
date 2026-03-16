import math
from PySide6.QtWidgets import QGraphicsPathItem, QGraphicsTextItem
from PySide6.QtCore import QPointF
from PySide6.QtGui import QPen, QColor, QPainterPath, QFont

from ..model.edge_types import EdgeType, EDGE_COLORS, EDGE_LABELS
from .node_item import NodeItem


class EdgeItem(QGraphicsPathItem):
    """Visual representation of a directed edge between two nodes."""

    def __init__(self, src_item: NodeItem, dst_item: NodeItem, edge_type: EdgeType):
        super().__init__()
        self.src_item = src_item
        self.dst_item = dst_item
        self.edge_type = edge_type

        color = QColor(EDGE_COLORS.get(edge_type, "#888888"))
        pen = QPen(color, 1.5)

        if edge_type in (EdgeType.CONTAINS, EdgeType.TRANSITIONS):
            pen.setWidthF(1.0)

        self.setPen(pen)
        self.setZValue(0)

        label_text = EDGE_LABELS.get(edge_type, "")
        self._label = QGraphicsTextItem(label_text, self)
        self._label.setDefaultTextColor(color.lighter(140))
        label_font = QFont("Microsoft YaHei", 7)
        self._label.setFont(label_font)

        src_item.add_edge(self)
        dst_item.add_edge(self)
        self.update_path()

    def update_path(self):
        sx, sy = self.src_item.center_pos()
        dx, dy = self.dst_item.center_pos()

        path = QPainterPath()
        path.moveTo(sx, sy)

        mid_x = (sx + dx) / 2
        mid_y = (sy + dy) / 2

        if abs(dx - sx) > abs(dy - sy):
            cx1, cy1 = mid_x, sy
            cx2, cy2 = mid_x, dy
        else:
            cx1, cy1 = sx, mid_y
            cx2, cy2 = dx, mid_y

        path.cubicTo(cx1, cy1, cx2, cy2, dx, dy)

        # Compute a point on the bezier at t=0.5 for label position
        t = 0.5
        bx = (1-t)**3*sx + 3*(1-t)**2*t*cx1 + 3*(1-t)*t**2*cx2 + t**3*dx
        by = (1-t)**3*sy + 3*(1-t)**2*t*cy1 + 3*(1-t)*t**2*cy2 + t**3*dy

        lr = self._label.boundingRect()
        self._label.setPos(bx - lr.width() / 2, by - lr.height() - 2)

        arrow_size = 8
        angle = math.atan2(dy - sy, dx - sx)
        p1 = QPointF(
            dx - arrow_size * math.cos(angle - math.pi / 6),
            dy - arrow_size * math.sin(angle - math.pi / 6),
        )
        p2 = QPointF(
            dx - arrow_size * math.cos(angle + math.pi / 6),
            dy - arrow_size * math.sin(angle + math.pi / 6),
        )
        path.moveTo(dx, dy)
        path.lineTo(p1)
        path.moveTo(dx, dy)
        path.lineTo(p2)

        self.setPath(path)

    def set_highlight(self, on: bool):
        color = QColor(EDGE_COLORS.get(self.edge_type, "#888888"))
        if on:
            self.setPen(QPen(color.lighter(150), 2.5))
            self._label.setDefaultTextColor(QColor("#FFFFFF"))
            self.setZValue(5)
        else:
            self.setPen(QPen(color, 1.5))
            self._label.setDefaultTextColor(color.lighter(140))
            self.setZValue(0)

    def set_dimmed(self, dimmed: bool):
        self.setOpacity(0.08 if dimmed else 1.0)
