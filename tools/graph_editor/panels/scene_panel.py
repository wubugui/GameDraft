from PySide6.QtWidgets import QWidget, QVBoxLayout, QFormLayout, QLineEdit, QSpinBox, QComboBox, QTextEdit
from PySide6.QtCore import Signal
from ..model.node_types import NodeData, NodeType
from .condition_editor import ConditionEditor


class ScenePanel(QWidget):
    data_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._nd: NodeData | None = None
        layout = QVBoxLayout(self)
        form = QFormLayout()

        self.id_edit = QLineEdit()
        self.id_edit.setReadOnly(True)
        self.name_edit = QLineEdit()
        self.w_spin = QSpinBox()
        self.w_spin.setRange(100, 10000)
        self.h_spin = QSpinBox()
        self.h_spin.setRange(100, 10000)

        form.addRow("ID:", self.id_edit)
        form.addRow("Name:", self.name_edit)
        form.addRow("Width:", self.w_spin)
        form.addRow("Height:", self.h_spin)
        layout.addLayout(form)
        layout.addStretch()

        self.name_edit.textChanged.connect(self._mark_dirty)
        self.w_spin.valueChanged.connect(self._mark_dirty)
        self.h_spin.valueChanged.connect(self._mark_dirty)

    def load_node(self, nd: NodeData):
        self._nd = nd
        d = nd.data
        self.id_edit.setText(d.get("id", ""))
        self.name_edit.setText(d.get("name", ""))
        self.w_spin.setValue(d.get("width", 800))
        self.h_spin.setValue(d.get("height", 600))

    def _mark_dirty(self):
        if not self._nd:
            return
        d = self._nd.data
        d["name"] = self.name_edit.text()
        d["width"] = self.w_spin.value()
        d["height"] = self.h_spin.value()
        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)


class HotspotPanel(QWidget):
    data_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._nd: NodeData | None = None
        layout = QVBoxLayout(self)
        form = QFormLayout()

        self.id_edit = QLineEdit()
        self.id_edit.setReadOnly(True)
        self.type_combo = QComboBox()
        self.type_combo.addItems(["inspect", "pickup", "transition", "encounter", "npc"])
        self.label_edit = QLineEdit()
        self.x_spin = QSpinBox()
        self.x_spin.setRange(0, 10000)
        self.y_spin = QSpinBox()
        self.y_spin.setRange(0, 10000)
        self.w_spin = QSpinBox()
        self.w_spin.setRange(1, 1000)
        self.h_spin = QSpinBox()
        self.h_spin.setRange(1, 1000)
        self.range_spin = QSpinBox()
        self.range_spin.setRange(1, 500)

        form.addRow("ID:", self.id_edit)
        form.addRow("Type:", self.type_combo)
        form.addRow("Label:", self.label_edit)
        form.addRow("X:", self.x_spin)
        form.addRow("Y:", self.y_spin)
        form.addRow("Width:", self.w_spin)
        form.addRow("Height:", self.h_spin)
        form.addRow("Range:", self.range_spin)
        layout.addLayout(form)

        self.cond_editor = ConditionEditor("Conditions")
        layout.addWidget(self.cond_editor)
        layout.addStretch()

        for w in (self.type_combo,):
            w.currentTextChanged.connect(self._mark_dirty)
        for w in (self.label_edit,):
            w.textChanged.connect(self._mark_dirty)
        for w in (self.x_spin, self.y_spin, self.w_spin, self.h_spin, self.range_spin):
            w.valueChanged.connect(self._mark_dirty)
        self.cond_editor.changed.connect(self._mark_dirty)

    def load_node(self, nd: NodeData):
        self._nd = nd
        d = nd.data
        self.id_edit.setText(d.get("id", ""))
        self.type_combo.setCurrentText(d.get("type", "inspect"))
        self.label_edit.setText(d.get("label", ""))
        self.x_spin.setValue(d.get("x", 0))
        self.y_spin.setValue(d.get("y", 0))
        self.w_spin.setValue(d.get("width", 40))
        self.h_spin.setValue(d.get("height", 40))
        self.range_spin.setValue(d.get("interactionRange", 80))
        self.cond_editor.set_data(d.get("conditions", []))

    def _mark_dirty(self):
        if not self._nd:
            return
        d = self._nd.data
        d["type"] = self.type_combo.currentText()
        d["label"] = self.label_edit.text()
        d["x"] = self.x_spin.value()
        d["y"] = self.y_spin.value()
        d["width"] = self.w_spin.value()
        d["height"] = self.h_spin.value()
        d["interactionRange"] = self.range_spin.value()
        conds = self.cond_editor.to_list()
        if conds:
            d["conditions"] = conds
        elif "conditions" in d:
            del d["conditions"]
        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)


class NpcPanel(QWidget):
    data_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._nd: NodeData | None = None
        layout = QVBoxLayout(self)
        form = QFormLayout()

        self.id_edit = QLineEdit()
        self.id_edit.setReadOnly(True)
        self.name_edit = QLineEdit()
        self.x_spin = QSpinBox()
        self.x_spin.setRange(0, 10000)
        self.y_spin = QSpinBox()
        self.y_spin.setRange(0, 10000)
        self.dlg_edit = QLineEdit()
        self.knot_edit = QLineEdit()
        self.range_spin = QSpinBox()
        self.range_spin.setRange(1, 500)

        form.addRow("ID:", self.id_edit)
        form.addRow("Name:", self.name_edit)
        form.addRow("X:", self.x_spin)
        form.addRow("Y:", self.y_spin)
        form.addRow("Dialogue File:", self.dlg_edit)
        form.addRow("Dialogue Knot:", self.knot_edit)
        form.addRow("Range:", self.range_spin)
        layout.addLayout(form)
        layout.addStretch()

        self.name_edit.textChanged.connect(self._mark_dirty)
        self.x_spin.valueChanged.connect(self._mark_dirty)
        self.y_spin.valueChanged.connect(self._mark_dirty)
        self.dlg_edit.textChanged.connect(self._mark_dirty)
        self.knot_edit.textChanged.connect(self._mark_dirty)
        self.range_spin.valueChanged.connect(self._mark_dirty)

    def load_node(self, nd: NodeData):
        self._nd = nd
        d = nd.data
        self.id_edit.setText(d.get("id", ""))
        self.name_edit.setText(d.get("name", ""))
        self.x_spin.setValue(d.get("x", 0))
        self.y_spin.setValue(d.get("y", 0))
        self.dlg_edit.setText(d.get("dialogueFile", ""))
        self.knot_edit.setText(d.get("dialogueKnot", ""))
        self.range_spin.setValue(d.get("interactionRange", 80))

    def _mark_dirty(self):
        if not self._nd:
            return
        d = self._nd.data
        d["name"] = self.name_edit.text()
        d["x"] = self.x_spin.value()
        d["y"] = self.y_spin.value()
        d["dialogueFile"] = self.dlg_edit.text()
        d["dialogueKnot"] = self.knot_edit.text()
        d["interactionRange"] = self.range_spin.value()
        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)
