from PySide6.QtWidgets import QWidget, QVBoxLayout, QLabel
from PySide6.QtCore import Qt
from ..model.node_types import NodeData
from ..model.graph_model import GameGraph


class FlagPanel(QWidget):
    """Read-only panel showing flag writers and readers."""

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        self._content = QLabel()
        self._content.setWordWrap(True)
        self._content.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        self._content.setStyleSheet("font-size: 13px; padding: 8px;")
        layout.addWidget(self._content)
        layout.addStretch()
        self._graph: GameGraph | None = None

    def set_graph(self, graph: GameGraph):
        self._graph = graph

    def load_node(self, nd: NodeData):
        if not self._graph:
            self._content.setText(f"<h3>Flag: {nd.id}</h3>")
            return

        writers = self._graph.flag_writers(nd.id)
        readers = self._graph.flag_readers(nd.id)

        lines = [f"<h3>Flag: {nd.id}</h3>"]
        lines.append(f"<b>Written by ({len(writers)}):</b><br>")
        if writers:
            for w in writers:
                wnd = self._graph.get_node(w)
                lines.append(f"  &bull; {wnd.label if wnd else w}<br>")
        else:
            lines.append("  <i>(none - read-only flag)</i><br>")

        lines.append(f"<br><b>Read by ({len(readers)}):</b><br>")
        if readers:
            for r in readers:
                rnd = self._graph.get_node(r)
                lines.append(f"  &bull; {rnd.label if rnd else r}<br>")
        else:
            lines.append("  <i>(none - write-only flag)</i><br>")

        if not writers and readers:
            lines.append("<br><span style='color:#EF4444;'><b>WARNING: This flag is read but never written!</b></span>")
        elif writers and not readers:
            lines.append("<br><span style='color:#F59E0B;'><b>NOTE: This flag is written but never read.</b></span>")

        self._content.setText("".join(lines))
