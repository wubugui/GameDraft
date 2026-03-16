from PySide6.QtWidgets import QTreeWidget, QTreeWidgetItem
from PySide6.QtCore import Signal
from pathlib import Path

from .model.graph_model import GameGraph
from .model.node_types import NodeType, NODE_LABELS


class Sidebar(QTreeWidget):
    node_activated = Signal(str)
    dialogue_file_selected = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setHeaderLabels(["Entities"])
        self.setMinimumWidth(200)
        self.setMaximumWidth(280)
        self.itemDoubleClicked.connect(self._on_double_click)

    def populate(self, graph: GameGraph):
        self.clear()
        type_order = [
            NodeType.SCENE, NodeType.NPC, NodeType.QUEST, NodeType.ENCOUNTER,
            NodeType.RULE, NodeType.FRAGMENT, NodeType.ITEM, NodeType.FLAG,
            NodeType.DIALOGUE_KNOT, NodeType.HOTSPOT,
        ]

        for nt in type_order:
            nodes = graph.nodes_by_type(nt)
            if not nodes:
                continue

            if nt == NodeType.DIALOGUE_KNOT:
                group = QTreeWidgetItem(self, [f"{NODE_LABELS[nt]} ({len(nodes)})"])
                group.setExpanded(True)

                files: dict[str, list] = {}
                for nd in nodes:
                    fname = nd.data.get("file", "unknown")
                    files.setdefault(fname, []).append(nd)

                for fname in sorted(files.keys()):
                    file_item = QTreeWidgetItem(group, [f"{fname}.ink"])
                    file_item.setData(0, 0x0100, f"__dlgfile__:{fname}")
                    for nd in sorted(files[fname], key=lambda n: n.data.get("start_line", 0)):
                        child = QTreeWidgetItem(file_item, [nd.label])
                        child.setData(0, 0x0100, nd.id)
            else:
                group = QTreeWidgetItem(self, [f"{NODE_LABELS[nt]} ({len(nodes)})"])
                group.setExpanded(True)
                for nd in sorted(nodes, key=lambda n: n.label):
                    child = QTreeWidgetItem(group, [nd.label])
                    child.setData(0, 0x0100, nd.id)

    def _on_double_click(self, item: QTreeWidgetItem, column: int):
        nid = item.data(0, 0x0100)
        if not nid:
            return
        if nid.startswith("__dlgfile__:"):
            fname = nid.replace("__dlgfile__:", "")
            self.dialogue_file_selected.emit(fname)
        else:
            self.node_activated.emit(nid)
