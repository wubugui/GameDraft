from PySide6.QtWidgets import QToolBar, QComboBox, QLabel, QCheckBox, QPushButton
from PySide6.QtCore import Signal

from .model.node_types import NodeType, NODE_LABELS


class Toolbar(QToolBar):
    view_changed = Signal(str)
    save_requested = Signal()
    refresh_requested = Signal()
    layout_requested = Signal()
    filter_changed = Signal(set)
    full_component_changed = Signal(bool)
    isolate_highlight_changed = Signal(bool)

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
        self._save_action.setEnabled(False)
        self._save_action.setToolTip("暂不可用：编辑器当前为只读模式")
        self._save_action.triggered.connect(self.save_requested.emit)

        self._refresh_action = self.addAction("Refresh")
        self._refresh_action.triggered.connect(self.refresh_requested.emit)

        self._layout_action = self.addAction("Auto Layout")
        self._layout_action.triggered.connect(self.layout_requested.emit)

        self.addSeparator()
        self._component_cb = QCheckBox("连通子图高亮")
        self._component_cb.setToolTip(
            "勾选：高亮当前视图中与选中节点同一连通分量的全部节点与边；"
            "不勾选：仅高亮直接相连的节点与边"
        )
        self._component_cb.stateChanged.connect(self._emit_full_component)
        self.addWidget(self._component_cb)

        self._isolate_btn = QPushButton("仅显示高亮子图")
        self._isolate_btn.setCheckable(True)
        self._isolate_btn.setToolTip(
            "开启后隐藏未处于高亮集合的节点（需先选中节点）；再次点击恢复显示"
        )
        self._isolate_btn.clicked.connect(self._emit_isolate)
        self.addWidget(self._isolate_btn)

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

    def _emit_full_component(self, _state: int):
        self.full_component_changed.emit(self._component_cb.isChecked())

    def _emit_isolate(self):
        self.isolate_highlight_changed.emit(self._isolate_btn.isChecked())

    def get_hidden_types(self) -> set[NodeType]:
        hidden: set[NodeType] = set()
        for nt, cb in self._checkboxes.items():
            if not cb.isChecked():
                hidden.add(nt)
        return hidden

    def is_full_component_highlight(self) -> bool:
        return self._component_cb.isChecked()

    def is_isolate_highlight(self) -> bool:
        return self._isolate_btn.isChecked()

    def current_view(self) -> str:
        return self._view_combo.currentText()
