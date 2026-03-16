from PySide6.QtWidgets import QToolBar, QComboBox, QLabel, QCheckBox, QWidget, QHBoxLayout
from PySide6.QtCore import Signal

from .model.node_types import NodeType, NODE_LABELS


class Toolbar(QToolBar):
    view_changed = Signal(str)
    save_requested = Signal()
    refresh_requested = Signal()
    layout_requested = Signal()
    filter_changed = Signal(set)

    def __init__(self, parent=None):
        super().__init__("Main Toolbar", parent)
        self.setMovable(False)

        self.addWidget(QLabel("  View: "))
        self._view_combo = QComboBox()
        self._view_combo.addItems(["Full Graph", "Quests", "Encounters", "Dialogue"])
        self._view_combo.currentTextChanged.connect(self.view_changed.emit)
        self.addWidget(self._view_combo)

        self.addSeparator()

        self._save_action = self.addAction("Save All")
        self._save_action.triggered.connect(self.save_requested.emit)

        self._refresh_action = self.addAction("Refresh")
        self._refresh_action.triggered.connect(self.refresh_requested.emit)

        self._layout_action = self.addAction("Auto Layout")
        self._layout_action.triggered.connect(self.layout_requested.emit)

        self.addSeparator()
        self.addWidget(QLabel("  Filter: "))

        self._checkboxes: dict[NodeType, QCheckBox] = {}
        filter_types = [
            NodeType.FLAG, NodeType.QUEST, NodeType.ENCOUNTER,
            NodeType.SCENE, NodeType.HOTSPOT, NodeType.NPC,
            NodeType.RULE, NodeType.ITEM, NodeType.DIALOGUE_KNOT,
        ]

        for nt in filter_types:
            cb = QCheckBox(NODE_LABELS[nt])
            cb.setChecked(True)
            cb.stateChanged.connect(self._on_filter_change)
            self._checkboxes[nt] = cb
            self.addWidget(cb)

    def _on_filter_change(self):
        hidden = set()
        for nt, cb in self._checkboxes.items():
            if not cb.isChecked():
                hidden.add(nt)
        self.filter_changed.emit(hidden)

    def current_view(self) -> str:
        return self._view_combo.currentText()
