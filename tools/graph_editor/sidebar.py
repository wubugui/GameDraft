from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QLineEdit,
    QTreeWidget,
    QTreeWidgetItem,
)
from PySide6.QtCore import Signal

from .model.graph_model import GameGraph
from .model.node_types import NodeType, NODE_LABELS


class Sidebar(QWidget):
    node_activated = Signal(str)
    dialogue_file_selected = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        self._search = QLineEdit()
        self._search.setPlaceholderText("搜索实体（子串匹配）…")
        self._search.textChanged.connect(self._on_search_changed)

        self._tree = QTreeWidget()
        self._tree.setHeaderLabels(["Entities"])
        self._tree.setMinimumWidth(200)
        self._tree.setMaximumWidth(280)
        self._tree.itemDoubleClicked.connect(self._on_double_click)

        layout.addWidget(self._search)
        layout.addWidget(self._tree, 1)

    def populate(self, graph: GameGraph):
        self._tree.clear()
        type_order = [
            NodeType.SCENE, NodeType.NPC, NodeType.QUEST_GROUP, NodeType.QUEST,
            NodeType.ENCOUNTER,
            NodeType.RULE, NodeType.FRAGMENT, NodeType.ITEM, NodeType.FLAG,
            NodeType.DIALOGUE_KNOT, NodeType.HOTSPOT,
        ]

        quest_group_items: dict[str, QTreeWidgetItem] = {}

        for nt in type_order:
            nodes = graph.nodes_by_type(nt)
            if not nodes:
                continue

            if nt == NodeType.DIALOGUE_KNOT:
                group = QTreeWidgetItem(self._tree, [f"{NODE_LABELS[nt]} ({len(nodes)})"])
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

            elif nt == NodeType.QUEST_GROUP:
                group = QTreeWidgetItem(self._tree, [f"{NODE_LABELS[nt]} ({len(nodes)})"])
                group.setExpanded(True)
                for nd in sorted(nodes, key=lambda n: n.label):
                    child = QTreeWidgetItem(group, [nd.label])
                    child.setData(0, 0x0100, nd.id)
                    gid = nd.data.get("id", nd.id.replace("qgroup:", ""))
                    quest_group_items[gid] = child

            elif nt == NodeType.QUEST:
                quest_nodes = sorted(nodes, key=lambda n: n.label)
                grouped: dict[str, list] = {}
                ungrouped: list = []
                for nd in quest_nodes:
                    grp = nd.data.get("group", "")
                    if grp and grp in quest_group_items:
                        grouped.setdefault(grp, []).append(nd)
                    else:
                        ungrouped.append(nd)

                for grp_id, grp_quests in grouped.items():
                    parent = quest_group_items[grp_id]
                    old_text = parent.text(0)
                    parent.setText(0, f"{old_text} [{len(grp_quests)}]")
                    for nd in grp_quests:
                        child = QTreeWidgetItem(parent, [nd.label])
                        child.setData(0, 0x0100, nd.id)

                if ungrouped:
                    group = QTreeWidgetItem(self._tree, [f"Quest [ungrouped] ({len(ungrouped)})"])
                    group.setExpanded(True)
                    for nd in ungrouped:
                        child = QTreeWidgetItem(group, [nd.label])
                        child.setData(0, 0x0100, nd.id)

            else:
                group = QTreeWidgetItem(self._tree, [f"{NODE_LABELS[nt]} ({len(nodes)})"])
                group.setExpanded(True)
                for nd in sorted(nodes, key=lambda n: n.label):
                    child = QTreeWidgetItem(group, [nd.label])
                    child.setData(0, 0x0100, nd.id)

        self._apply_search_filter()

    def _on_search_changed(self, _text: str):
        self._apply_search_filter()

    def _apply_search_filter(self):
        q = self._search.text().strip().lower()
        root = self._tree.invisibleRootItem()
        for i in range(root.childCount()):
            self._filter_branch(root.child(i), q)

    def _filter_branch(self, item: QTreeWidgetItem, q: str) -> bool:
        if not q:
            item.setHidden(False)
            for i in range(item.childCount()):
                self._filter_branch(item.child(i), q)
            return True

        text_l = item.text(0).lower()
        self_match = q in text_l
        any_child_visible = False
        for i in range(item.childCount()):
            if self._filter_branch(item.child(i), q):
                any_child_visible = True

        visible = self_match or any_child_visible
        item.setHidden(not visible)
        if any_child_visible and q:
            item.setExpanded(True)
        return visible

    def _on_double_click(self, item: QTreeWidgetItem, column: int):
        nid = item.data(0, 0x0100)
        if not nid:
            return
        if nid.startswith("__dlgfile__:"):
            fname = nid.replace("__dlgfile__:", "")
            self.dialogue_file_selected.emit(fname)
        else:
            self.node_activated.emit(nid)
