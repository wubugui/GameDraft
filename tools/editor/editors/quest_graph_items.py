"""Custom QGraphicsItem subclasses for the hierarchical quest graph."""
from __future__ import annotations

import math
from PySide6.QtWidgets import QGraphicsRectItem, QGraphicsPathItem, QGraphicsTextItem, QGraphicsItem
from PySide6.QtCore import Qt, QRectF, QPointF
from PySide6.QtGui import QPen, QBrush, QColor, QFont, QPainterPath


def format_conditions(conditions: list[dict]) -> str:
    if not conditions:
        return ""
    parts: list[str] = []
    for c in conditions:
        flag = c.get("flag", "")
        if not flag:
            continue
        op = c.get("op", "==")
        val = c.get("value", True)
        if op == "==" and val is True:
            parts.append(flag)
        else:
            parts.append(f"{flag} {op} {val}")
    return " AND ".join(parts) if parts else ""


_GROUP_COLORS = {"main": QColor(50, 80, 140), "side": QColor(40, 120, 80)}
_NODE_COLOR = QColor(60, 80, 140)
_IMPLICIT_EDGE_COLOR = QColor(120, 120, 140, 160)
_EXPLICIT_EDGE_COLOR = QColor(100, 160, 255)
_FONT = "Microsoft YaHei"


class QuestGroupItem(QGraphicsRectItem):
    def __init__(self, group_data: dict, quest_count: int, x: float = 0, y: float = 0):
        self.group_data = group_data
        gtype = group_data.get("type", "main")
        color = _GROUP_COLORS.get(gtype, _GROUP_COLORS["main"])

        name = group_data.get("name", group_data["id"])
        tag = "[M]" if gtype == "main" else "[S]"
        display = f"{tag} {name}"
        width = max(140, len(display) * 10 + 30)
        height = 50

        super().__init__(0, 0, width, height)
        self.setPos(x, y)
        self.setBrush(QBrush(color))
        self.setPen(QPen(color.lighter(130), 2))
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges, True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setZValue(1)

        self._title = QGraphicsTextItem(display, self)
        self._title.setDefaultTextColor(QColor("#FFFFFF"))
        self._title.setFont(QFont(_FONT, 10, QFont.Weight.Bold))
        tr = self._title.boundingRect()
        self._title.setPos((width - tr.width()) / 2, 4)

        sub = f"{quest_count} 个阶段"
        self._sub = QGraphicsTextItem(sub, self)
        self._sub.setDefaultTextColor(QColor(200, 200, 220))
        self._sub.setFont(QFont(_FONT, 8))
        sr = self._sub.boundingRect()
        self._sub.setPos((width - sr.width()) / 2, 28)

        self._edges: list = []

    def add_edge(self, edge: QuestEdgeItem) -> None:
        self._edges.append(edge)

    def center_pos(self) -> tuple[float, float]:
        r = self.rect()
        p = self.pos()
        return p.x() + r.width() / 2, p.y() + r.height() / 2

    def set_highlight(self, on: bool) -> None:
        color = _GROUP_COLORS.get(self.group_data.get("type", "main"), _GROUP_COLORS["main"])
        if on:
            self.setPen(QPen(QColor("#FFFFFF"), 3))
            self.setZValue(10)
        else:
            self.setPen(QPen(color.lighter(130), 2))
            self.setZValue(1)

    def itemChange(self, change, value):
        if change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged:
            for edge in self._edges:
                edge.update_path()
        return super().itemChange(change, value)


class QuestNodeItem(QGraphicsRectItem):
    def __init__(self, quest_data: dict, x: float = 0, y: float = 0):
        self.quest_data = quest_data

        qid = quest_data.get("id", "?")
        title = quest_data.get("title", "")
        display_id = qid if len(qid) <= 20 else qid[:17] + "..."
        display_title = title if len(title) <= 16 else title[:13] + "..."
        width = max(130, max(len(display_id), len(display_title)) * 9 + 20)
        height = 44

        color = _NODE_COLOR
        super().__init__(0, 0, width, height)
        self.setPos(x, y)
        self.setBrush(QBrush(color))
        self.setPen(QPen(color.darker(120), 1.5))
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges, True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setZValue(1)

        self._id_text = QGraphicsTextItem(f"[Q] {display_id}", self)
        self._id_text.setDefaultTextColor(QColor("#FFFFFF"))
        self._id_text.setFont(QFont(_FONT, 9))
        ir = self._id_text.boundingRect()
        self._id_text.setPos((width - ir.width()) / 2, 2)

        self._title_text = QGraphicsTextItem(display_title, self)
        self._title_text.setDefaultTextColor(QColor(200, 210, 230))
        self._title_text.setFont(QFont(_FONT, 8))
        tr2 = self._title_text.boundingRect()
        self._title_text.setPos((width - tr2.width()) / 2, 22)

        self._edges: list = []

    def add_edge(self, edge: QuestEdgeItem) -> None:
        self._edges.append(edge)

    def center_pos(self) -> tuple[float, float]:
        r = self.rect()
        p = self.pos()
        return p.x() + r.width() / 2, p.y() + r.height() / 2

    def set_highlight(self, on: bool) -> None:
        if on:
            self.setPen(QPen(QColor("#FFFFFF"), 3))
            self.setZValue(10)
        else:
            self.setPen(QPen(_NODE_COLOR.darker(120), 1.5))
            self.setZValue(1)

    def itemChange(self, change, value):
        if change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged:
            for edge in self._edges:
                edge.update_path()
        return super().itemChange(change, value)


class QuestEdgeItem(QGraphicsPathItem):
    def __init__(
        self,
        src_item: QuestGroupItem | QuestNodeItem,
        dst_item: QuestGroupItem | QuestNodeItem,
        conditions: list[dict] | None = None,
        implicit: bool = False,
        bypass: bool = False,
    ):
        super().__init__()
        self.src_item = src_item
        self.dst_item = dst_item
        self.conditions = conditions or []
        self.implicit = implicit
        self.bypass = bypass

        color = _IMPLICIT_EDGE_COLOR if implicit else _EXPLICIT_EDGE_COLOR
        pen = QPen(color, 1.8)
        if implicit:
            pen.setStyle(Qt.PenStyle.DashLine)
            pen.setWidthF(1.2)
        self.setPen(pen)
        self.setZValue(0)

        label = format_conditions(self.conditions)
        if bypass and not implicit:
            label = f"{label} [bypass]" if label else "[bypass]"
        if implicit and not label:
            label = "(precond)"
        self._label = QGraphicsTextItem(label, self)
        self._label.setDefaultTextColor(color.lighter(140) if not implicit else QColor(160, 160, 180))
        self._label.setFont(QFont(_FONT, 7))

        src_item.add_edge(self)
        dst_item.add_edge(self)
        self.update_path()

    def update_path(self) -> None:
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

        t = 0.5
        bx = (1-t)**3*sx + 3*(1-t)**2*t*cx1 + 3*(1-t)*t**2*cx2 + t**3*dx
        by = (1-t)**3*sy + 3*(1-t)**2*t*cy1 + 3*(1-t)*t**2*cy2 + t**3*dy

        lr = self._label.boundingRect()
        self._label.setPos(bx - lr.width() / 2, by - lr.height() - 2)

        arrow_size = 8
        angle = math.atan2(dy - cy2, dx - cx2) if (dx != cx2 or dy != cy2) else math.atan2(dy - sy, dx - sx)
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

    def set_highlight(self, on: bool) -> None:
        color = _IMPLICIT_EDGE_COLOR if self.implicit else _EXPLICIT_EDGE_COLOR
        if on:
            self.setPen(QPen(color.lighter(150), 2.5))
            self.setZValue(5)
        else:
            pen = QPen(color, 1.8)
            if self.implicit:
                pen.setStyle(Qt.PenStyle.DashLine)
                pen.setWidthF(1.2)
            self.setPen(pen)
            self.setZValue(0)
