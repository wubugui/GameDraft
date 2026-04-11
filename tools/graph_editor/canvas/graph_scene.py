from collections import defaultdict

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
    node_moved = Signal(str, float, float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._node_items: dict[str, NodeItem] = {}
        self._edge_items: list[EdgeItem] = []
        self._current_highlight: str | None = None
        self._hidden_types: set[NodeType] = set()
        self._highlight_full_component = False
        self._isolate_highlight = False
        self._last_highlight_ids: set[str] = set()

    def populate(
        self,
        graph: GameGraph,
        layout: str = "spring",
        saved_positions: dict[str, tuple[float, float]] | None = None,
        force_layout: bool = False,
    ):
        self.clear()
        self._node_items.clear()
        self._edge_items.clear()
        self._current_highlight = None
        self._last_highlight_ids.clear()

        if layout == "hierarchical":
            computed = hierarchical_layout(graph)
        else:
            computed = spring_layout(graph)

        for nd in graph.all_nodes():
            if (
                not force_layout
                and saved_positions
                and nd.id in saved_positions
            ):
                x, y = saved_positions[nd.id]
            else:
                x, y = computed.get(nd.id, (0.0, 0.0))
            item = NodeItem(nd, x, y, position_changed_cb=self._emit_node_moved)
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

        self._apply_visibility()

    def dump_positions(self) -> dict[str, tuple[float, float]]:
        return {
            nid: (item.pos().x(), item.pos().y())
            for nid, item in self._node_items.items()
        }

    def _emit_node_moved(self, node_id: str, x: float, y: float):
        self.node_moved.emit(node_id, x, y)

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
            self._last_highlight_ids.clear()
            self._apply_visibility()
            self.node_deselected.emit()
            return

        target = self._node_items.get(node_id)
        if not target:
            self._last_highlight_ids.clear()
            self._apply_visibility()
            return

        self._current_highlight = node_id

        if self._highlight_full_component:
            connected = self._connected_component(node_id)
        else:
            connected = {node_id}
            for ei in self._edge_items:
                if (
                    ei.src_item.nd.id == node_id
                    or ei.dst_item.nd.id == node_id
                ):
                    connected.add(ei.src_item.nd.id)
                    connected.add(ei.dst_item.nd.id)

        self._last_highlight_ids = set(connected)

        if self._highlight_full_component:
            for ei in self._edge_items:
                u, v = ei.src_item.nd.id, ei.dst_item.nd.id
                if u in connected and v in connected:
                    ei.set_highlight(True)
                    ei.set_dimmed(False)
                else:
                    ei.set_highlight(False)
                    ei.set_dimmed(True)
        else:
            for ei in self._edge_items:
                u, v = ei.src_item.nd.id, ei.dst_item.nd.id
                if u == node_id or v == node_id:
                    ei.set_highlight(True)
                    ei.set_dimmed(False)
                else:
                    ei.set_highlight(False)
                    ei.set_dimmed(True)

        for nid, ni in self._node_items.items():
            if nid in connected:
                ni.set_highlight(nid == node_id)
                ni.set_dimmed(False)
            else:
                ni.set_highlight(False)
                ni.set_dimmed(True)

        self._apply_visibility()
        self.node_selected.emit(node_id)

    def _connected_component(self, start_id: str) -> set[str]:
        adj: dict[str, set[str]] = defaultdict(set)
        for ei in self._edge_items:
            u = ei.src_item.nd.id
            v = ei.dst_item.nd.id
            adj[u].add(v)
            adj[v].add(u)
        seen: set[str] = {start_id}
        stack = [start_id]
        while stack:
            n = stack.pop()
            for m in adj.get(n, ()):
                if m not in seen:
                    seen.add(m)
                    stack.append(m)
        return seen

    def set_highlight_full_component(self, on: bool):
        self._highlight_full_component = on
        if self._current_highlight:
            self.highlight_node(self._current_highlight)

    def set_isolate_highlight(self, on: bool):
        self._isolate_highlight = on
        self._apply_visibility()

    def set_type_filter(self, hidden_types: set[NodeType]):
        self._hidden_types = hidden_types
        self._apply_visibility()

    def _apply_visibility(self):
        for nid, ni in self._node_items.items():
            type_ok = ni.nd.node_type not in self._hidden_types
            iso_ok = True
            if self._isolate_highlight and self._last_highlight_ids:
                iso_ok = nid in self._last_highlight_ids
            ni.setVisible(type_ok and iso_ok)

        for ei in self._edge_items:
            src_vis = ei.src_item.isVisible()
            dst_vis = ei.dst_item.isVisible()
            ei.setVisible(src_vis and dst_vis)

    def get_node_item(self, node_id: str) -> NodeItem | None:
        return self._node_items.get(node_id)
