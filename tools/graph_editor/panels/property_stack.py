from PySide6.QtWidgets import QStackedWidget, QWidget, QVBoxLayout, QLabel, QScrollArea, QPushButton
from PySide6.QtCore import Signal, Qt

from ..model.node_types import NodeData, NodeType
from ..model.graph_model import GameGraph
from .quest_panel import QuestPanel
from .encounter_panel import EncounterPanel
from .item_panel import ItemPanel
from .rule_panel import RulePanel
from .scene_panel import ScenePanel, HotspotPanel, NpcPanel
from .flag_panel import FlagPanel
from .dialogue_panel import DialoguePanel
from .fragment_panel import FragmentPanel
from .zone_panel import ZonePanel


class PropertyStack(QWidget):
    save_requested = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumWidth(300)
        self.setMaximumWidth(420)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)

        self._scroll = QScrollArea()
        self._scroll.setWidgetResizable(True)
        self._scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        layout.addWidget(self._scroll)

        self._stack = QStackedWidget()
        self._scroll.setWidget(self._stack)

        self._placeholder = QLabel("Select a node to view details")
        self._placeholder.setAlignment(Qt.AlignmentFlag.AlignTop)
        self._placeholder.setWordWrap(True)
        self._placeholder.setStyleSheet("padding: 16px; color: #888; font-size: 13px;")
        self._stack.addWidget(self._placeholder)

        self._quest = QuestPanel()
        self._encounter = EncounterPanel()
        self._item = ItemPanel()
        self._rule = RulePanel()
        self._scene = ScenePanel()
        self._hotspot = HotspotPanel()
        self._npc = NpcPanel()
        self._flag = FlagPanel()
        self._dialogue = DialoguePanel()
        self._fragment = FragmentPanel()
        self._zone = ZonePanel()

        self._panels = {
            NodeType.QUEST: self._quest,
            NodeType.ENCOUNTER: self._encounter,
            NodeType.ITEM: self._item,
            NodeType.RULE: self._rule,
            NodeType.FRAGMENT: self._fragment,
            NodeType.SCENE: self._scene,
            NodeType.HOTSPOT: self._hotspot,
            NodeType.NPC: self._npc,
            NodeType.FLAG: self._flag,
            NodeType.DIALOGUE_KNOT: self._dialogue,
            NodeType.ZONE: self._zone,
        }

        for panel in self._panels.values():
            self._stack.addWidget(panel)

        self._graph: GameGraph | None = None

    def set_graph(self, graph: GameGraph):
        self._graph = graph
        self._flag.set_graph(graph)

    def show_node(self, nd: NodeData):
        panel = self._panels.get(nd.node_type)
        if panel:
            panel.load_node(nd)
            self._stack.setCurrentWidget(panel)
        else:
            self._placeholder.setText(f"No panel for {nd.node_type.name}")
            self._stack.setCurrentWidget(self._placeholder)

    def clear_selection(self):
        self._placeholder.setText("Select a node to view details")
        self._stack.setCurrentWidget(self._placeholder)
