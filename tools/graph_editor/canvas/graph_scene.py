from PySide6.QtWidgets import QGraphicsScene
from PySide6.QtCore import Signal

from ..model.graph_model import GameGraph
from ..model.node_types import NodeType
from ..model.edge_types import EdgeType
from .node_item import NodeItem
from .edge_item import EdgeItem
from .layout_engine import spring_layout, hierarchical_layout


class GraphScene(QGraphicsScene):
    node_selected = Signal(str)
    node_deselected = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._node_items: dict[str, NodeItem] = {}
        self._edge_items: list[EdgeItem] = []
        self._current_highlight: str | None = None
        self._hidden_types: set[NodeType] = set()

    def populate(self, graph: GameGraph, layout: str = "spring"):
        self.clear()
        self._node_items.clear()
        self._edge_items.clear()
        self._current_highlight = None

        if layout == "hierarchical":
            positions = hierarchical_layout(graph)
        else:
            positions = spring_layout(graph)

        for nd in graph.all_nodes():
            x, y = positions.get(nd.id, (0, 0))
            item = NodeItem(nd, x, y)
            self._node_items[nd.id] = item
            self.addItem(item)

        for u, v, d in graph.all_edges():
            src = self._node_items.get(u)
            dst = self._node_items.get(v)
            if src and dst:
                et = d.get("edge_type", EdgeType.CONTAINS)
                edge = EdgeItem(src, dst, et)
                self._edge_items.append(edge)
                self.addItem(edge)

        self._apply_type_filter()

    def highlight_node(self, node_id: str | None):
        if self._current_highlight:
            old = self._node_items.get(self._current_highlight)
            if old:
                old.set_highlight(False)
            for ei in self._edge_items:
                ei.set_highlight(False)
            for ni in self._node_items.values():
                ni.set_dimmed(False)
            for ei in self._edge_items:
                ei.set_dimmed(False)
            self._current_highlight = None

        if node_id is None:
            self.node_deselected.emit()
            return

        self._current_highlight = node_id
        target = self._node_items.get(node_id)
        if not target:
            return

        connected = set()
        connected.add(node_id)

        for ei in self._edge_items:
            if ei.src_item.nd.id == node_id or ei.dst_item.nd.id == node_id:
                ei.set_highlight(True)
                connected.add(ei.src_item.nd.id)
                connected.add(ei.dst_item.nd.id)
            else:
                ei.set_dimmed(True)

        for nid, ni in self._node_items.items():
            if nid in connected:
                ni.set_highlight(nid == node_id)
                ni.set_dimmed(False)
            else:
                ni.set_dimmed(True)

        self.node_selected.emit(node_id)

    def set_type_filter(self, hidden_types: set[NodeType]):
        self._hidden_types = hidden_types
        self._apply_type_filter()

    def _apply_type_filter(self):
        for nid, ni in self._node_items.items():
            visible = ni.nd.node_type not in self._hidden_types
            ni.setVisible(visible)

        for ei in self._edge_items:
            src_vis = ei.src_item.isVisible()
            dst_vis = ei.dst_item.isVisible()
            ei.setVisible(src_vis and dst_vis)

    def get_node_item(self, node_id: str) -> NodeItem | None:
        return self._node_items.get(node_id)
