from PySide6.QtWidgets import QGraphicsRectItem, QGraphicsTextItem, QGraphicsItem
from PySide6.QtCore import Qt, QRectF
from PySide6.QtGui import QBrush, QPen, QColor, QFont

from ..model.node_types import NodeData, NodeType, NODE_COLORS


_TYPE_SHORT = {
    NodeType.FLAG: "F",
    NodeType.QUEST: "Q",
    NodeType.ENCOUNTER: "E",
    NodeType.DIALOGUE_KNOT: "D",
    NodeType.SCENE: "S",
    NodeType.HOTSPOT: "H",
    NodeType.NPC: "N",
    NodeType.RULE: "R",
    NodeType.FRAGMENT: "Fr",
    NodeType.ITEM: "I",
    NodeType.QUEST_GROUP: "G",
    NodeType.ZONE: "Z",
}


class NodeItem(QGraphicsRectItem):
    """Visual representation of a graph node."""

    def __init__(self, nd: NodeData, x: float = 0, y: float = 0):
        self.nd = nd
        self._selected = False

        color = QColor(NODE_COLORS.get(nd.node_type, "#888888"))
        width = max(100, len(nd.label) * 8 + 40)
        height = 36

        super().__init__(0, 0, width, height)
        self.setPos(x, y)
        self.setBrush(QBrush(color))
        self.setPen(QPen(color.darker(120), 1.5))
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges, True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setZValue(1)

        prefix = _TYPE_SHORT.get(nd.node_type, "?")
        display = f"[{prefix}] {nd.label}"
        if len(display) > 28:
            display = display[:25] + "..."

        self._label = QGraphicsTextItem(display, self)
        self._label.setDefaultTextColor(QColor("#FFFFFF"))
        font = QFont("Microsoft YaHei", 9)
        self._label.setFont(font)
        lrect = self._label.boundingRect()
        self._label.setPos(
            (width - lrect.width()) / 2,
            (height - lrect.height()) / 2,
        )

        if nd.node_type == NodeType.DIALOGUE_KNOT:
            tags_text = self._build_dialogue_tags(nd)
            if tags_text:
                self._tags_label = QGraphicsTextItem(tags_text, self)
                self._tags_label.setDefaultTextColor(QColor("#AAAAAA"))
                tag_font = QFont("Microsoft YaHei", 7)
                self._tags_label.setFont(tag_font)
                trect = self._tags_label.boundingRect()

                new_width = max(width, trect.width() + 10)
                new_height = height + trect.height() + 2
                self.setRect(0, 0, new_width, new_height)
                self._label.setPos(
                    (new_width - lrect.width()) / 2,
                    2,
                )
                self._tags_label.setPos(4, height)

        self._edges: list = []

    @staticmethod
    def _build_dialogue_tags(nd: NodeData) -> str:
        parts = []
        for tag in nd.data.get("action_tags", []):
            parts.append(f"act:{tag}")
        for flag in nd.data.get("getflags", []):
            parts.append(f"read:{flag}")
        if not parts:
            return ""
        return "  ".join(parts[:4])

    def add_edge(self, edge):
        self._edges.append(edge)

    def set_highlight(self, on: bool):
        color = QColor(NODE_COLORS.get(self.nd.node_type, "#888888"))
        if on:
            self.setPen(QPen(QColor("#FFFFFF"), 3))
            self.setZValue(10)
        else:
            self.setPen(QPen(color.darker(120), 1.5))
            self.setZValue(1)

    def set_dimmed(self, dimmed: bool):
        self.setOpacity(0.15 if dimmed else 1.0)

    def center_pos(self):
        r = self.rect()
        p = self.pos()
        return p.x() + r.width() / 2, p.y() + r.height() / 2

    def itemChange(self, change, value):
        if change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged:
            for edge in self._edges:
                edge.update_path()
        return super().itemChange(change, value)
