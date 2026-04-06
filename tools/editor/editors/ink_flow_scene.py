"""QGraphicsScene for Ink dialogue flow visualization."""
from __future__ import annotations

import math
from collections import defaultdict

from PySide6.QtWidgets import (
    QGraphicsScene, QGraphicsRectItem, QGraphicsPathItem,
    QGraphicsTextItem, QGraphicsItem, QGraphicsView,
)
from PySide6.QtCore import Qt, Signal, QPointF
from PySide6.QtGui import QPen, QBrush, QColor, QFont, QPainterPath, QPainter, QTransform

from .ink_parser import InkFlowNode, InkFlowEdge, build_flow_graph

_FONT = "Microsoft YaHei"
_KNOT_COLOR = QColor(60, 110, 160)
_END_COLOR = QColor(140, 60, 60)
_EDGE_COLOR = QColor(100, 170, 240)


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------

def _hierarchical_layout(
    node_ids: list[str],
    edges: list[tuple[str, str]],
    h_spacing: float = 220,
    v_spacing: float = 100,
) -> dict[str, tuple[float, float]]:
    if not node_ids:
        return {}
    adj: dict[str, list[str]] = defaultdict(list)
    in_deg: dict[str, int] = {nid: 0 for nid in node_ids}
    id_set = set(node_ids)
    for src, dst in edges:
        if src in id_set and dst in id_set:
            adj[src].append(dst)
            in_deg[dst] = in_deg.get(dst, 0) + 1

    layers: dict[str, int] = {}
    queue = [nid for nid in node_ids if in_deg.get(nid, 0) == 0]
    if not queue:
        queue = [node_ids[0]]
    for nid in queue:
        if nid not in layers:
            layers[nid] = 0

    processed: set[str] = set()
    while queue:
        cur = queue.pop(0)
        if cur in processed:
            continue
        processed.add(cur)
        for nxt in adj.get(cur, []):
            layers[nxt] = max(layers.get(nxt, 0), layers[cur] + 1)
            if nxt not in processed:
                queue.append(nxt)

    for nid in node_ids:
        if nid not in layers:
            layers[nid] = 0

    level_nodes: dict[int, list[str]] = defaultdict(list)
    for nid, lev in layers.items():
        level_nodes[lev].append(nid)

    positions: dict[str, tuple[float, float]] = {}
    for lev, nodes in level_nodes.items():
        total_h = (len(nodes) - 1) * v_spacing
        start_y = -total_h / 2
        for i, nid in enumerate(nodes):
            positions[nid] = (lev * h_spacing, start_y + i * v_spacing)
    return positions


# ---------------------------------------------------------------------------
# Graphics items
# ---------------------------------------------------------------------------

class InkKnotItem(QGraphicsRectItem):
    def __init__(self, node: InkFlowNode, x: float = 0, y: float = 0):
        self.node_data = node
        color = _END_COLOR if node.node_type == "end" else _KNOT_COLOR
        width = max(120, len(node.label) * 11 + 30)
        height = 40

        super().__init__(0, 0, width, height)
        self.setPos(x, y)
        self.setBrush(QBrush(color))
        self.setPen(QPen(color.lighter(130), 2))
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges, True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setZValue(1)

        self._title = QGraphicsTextItem(node.label, self)
        self._title.setDefaultTextColor(QColor("#FFFFFF"))
        self._title.setFont(QFont(_FONT, 10, QFont.Weight.Bold))
        tr = self._title.boundingRect()
        self._title.setPos((width - tr.width()) / 2, (height - tr.height()) / 2)

        self._edges: list[InkEdgeItem] = []
        self._highlight = False

    def add_edge(self, edge: InkEdgeItem) -> None:
        self._edges.append(edge)

    def center_pos(self) -> tuple[float, float]:
        r = self.rect()
        p = self.pos()
        return p.x() + r.width() / 2, p.y() + r.height() / 2

    def set_highlight(self, on: bool) -> None:
        self._highlight = on
        color = _END_COLOR if self.node_data.node_type == "end" else _KNOT_COLOR
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


class InkEdgeItem(QGraphicsPathItem):
    def __init__(self, src: InkKnotItem, dst: InkKnotItem, label: str = ""):
        super().__init__()
        self.src_item = src
        self.dst_item = dst
        self.setPen(QPen(_EDGE_COLOR, 1.8))
        self.setZValue(0)

        self._label = QGraphicsTextItem(label, self)
        self._label.setDefaultTextColor(_EDGE_COLOR.lighter(140))
        self._label.setFont(QFont(_FONT, 7))

        src.add_edge(self)
        dst.add_edge(self)
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
        angle = (math.atan2(dy - cy2, dx - cx2)
                 if (dx != cx2 or dy != cy2) else math.atan2(dy - sy, dx - sx))
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
        if on:
            self.setPen(QPen(_EDGE_COLOR.lighter(150), 2.5))
            self.setZValue(5)
        else:
            self.setPen(QPen(_EDGE_COLOR, 1.8))
            self.setZValue(0)


# ---------------------------------------------------------------------------
# Scene
# ---------------------------------------------------------------------------

class InkFlowScene(QGraphicsScene):
    knot_clicked = Signal(str, int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._items: dict[str, InkKnotItem] = {}
        self._edges: list[InkEdgeItem] = []

    def populate(self, text: str) -> None:
        self.clear()
        self._items.clear()
        self._edges.clear()

        nodes, edges = build_flow_graph(text)
        if not nodes:
            return

        layout_edges = [(e.source_id, e.target_id) for e in edges]
        node_ids = [n.id for n in nodes]
        positions = _hierarchical_layout(node_ids, layout_edges)

        node_map: dict[str, InkFlowNode] = {n.id: n for n in nodes}
        for n in nodes:
            x, y = positions.get(n.id, (0, 0))
            item = InkKnotItem(n, x, y)
            self._items[n.id] = item
            self.addItem(item)

        for e in edges:
            src_item = self._items.get(e.source_id)
            dst_item = self._items.get(e.target_id)
            if src_item and dst_item:
                ei = InkEdgeItem(src_item, dst_item, e.label)
                self._edges.append(ei)
                self.addItem(ei)

    def highlight_knot(self, knot_name: str) -> None:
        for item in self._items.values():
            item.set_highlight(False)
        for edge in self._edges:
            edge.set_highlight(False)
        target = self._items.get(knot_name)
        if not target:
            return
        target.set_highlight(True)
        for ei in self._edges:
            sid = ei.src_item.node_data.id
            did = ei.dst_item.node_data.id
            if sid == knot_name or did == knot_name:
                ei.set_highlight(True)

    def mouseDoubleClickEvent(self, event) -> None:
        xform = self.views()[0].transform() if self.views() else QTransform()
        item = self.itemAt(event.scenePos(), xform)
        if isinstance(item, InkKnotItem):
            self.knot_clicked.emit(
                item.node_data.id, item.node_data.line_number,
            )
        elif isinstance(item, QGraphicsTextItem):
            parent = item.parentItem()
            if isinstance(parent, InkKnotItem):
                self.knot_clicked.emit(
                    parent.node_data.id, parent.node_data.line_number,
                )
        super().mouseDoubleClickEvent(event)


class InkFlowView(QGraphicsView):
    def __init__(self, scene: InkFlowScene, parent=None):
        super().__init__(scene, parent)
        self.setRenderHints(
            self.renderHints() | QPainter.RenderHint.Antialiasing
        )
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)

    def wheelEvent(self, event) -> None:
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self.scale(factor, factor)
