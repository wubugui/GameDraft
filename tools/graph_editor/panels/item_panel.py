from PySide6.QtWidgets import QWidget, QVBoxLayout, QFormLayout, QLineEdit, QComboBox, QTextEdit, QSpinBox
from PySide6.QtCore import Signal
from ..model.node_types import NodeData


class ItemPanel(QWidget):
    data_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._nd: NodeData | None = None
        layout = QVBoxLayout(self)
        form = QFormLayout()

        self.id_edit = QLineEdit()
        self.id_edit.setReadOnly(True)
        self.name_edit = QLineEdit()
        self.type_combo = QComboBox()
        self.type_combo.addItems(["consumable", "key"])
        self.desc_edit = QTextEdit()
        self.desc_edit.setMaximumHeight(80)
        self.price_edit = QSpinBox()
        self.price_edit.setRange(0, 9999)
        self.stack_edit = QSpinBox()
        self.stack_edit.setRange(1, 999)

        form.addRow("ID:", self.id_edit)
        form.addRow("Name:", self.name_edit)
        form.addRow("Type:", self.type_combo)
        form.addRow("Description:", self.desc_edit)
        form.addRow("Buy Price:", self.price_edit)
        form.addRow("Max Stack:", self.stack_edit)
        layout.addLayout(form)
        layout.addStretch()

        self.name_edit.textChanged.connect(self._mark_dirty)
        self.type_combo.currentTextChanged.connect(self._mark_dirty)
        self.desc_edit.textChanged.connect(self._mark_dirty)
        self.price_edit.valueChanged.connect(self._mark_dirty)
        self.stack_edit.valueChanged.connect(self._mark_dirty)

    def load_node(self, nd: NodeData):
        self._nd = nd
        d = nd.data
        self.id_edit.setText(d.get("id", ""))
        self.name_edit.setText(d.get("name", ""))
        self.type_combo.setCurrentText(d.get("type", "consumable"))
        self.desc_edit.setPlainText(d.get("description", ""))
        self.price_edit.setValue(d.get("buyPrice", 0))
        self.stack_edit.setValue(d.get("maxStack", 99))

    def _mark_dirty(self):
        if not self._nd:
            return
        d = self._nd.data
        d["name"] = self.name_edit.text()
        d["type"] = self.type_combo.currentText()
        d["description"] = self.desc_edit.toPlainText()
        bp = self.price_edit.value()
        if bp > 0:
            d["buyPrice"] = bp
        elif "buyPrice" in d:
            del d["buyPrice"]
        d["maxStack"] = self.stack_edit.value()
        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)
