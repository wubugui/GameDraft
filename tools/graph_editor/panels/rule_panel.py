from PySide6.QtWidgets import QWidget, QVBoxLayout, QFormLayout, QLineEdit, QComboBox, QTextEdit, QSpinBox
from PySide6.QtCore import Signal
from ..model.node_types import NodeData


class RulePanel(QWidget):
    data_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._nd: NodeData | None = None
        layout = QVBoxLayout(self)
        form = QFormLayout()

        self.id_edit = QLineEdit()
        self.id_edit.setReadOnly(True)
        self.name_edit = QLineEdit()
        self.incomplete_name_edit = QLineEdit()
        self.incomplete_name_edit.setPlaceholderText("规矩未集齐时的显示名称")
        self.cat_combo = QComboBox()
        self.cat_combo.addItems(["ward", "taboo", "jargon", "streetwise"])
        self.desc_edit = QTextEdit()
        self.desc_edit.setMaximumHeight(80)
        self.source_edit = QLineEdit()
        self.src_type_combo = QComboBox()
        self.src_type_combo.addItems(["npc", "fragment", "experience"])
        self.verified_combo = QComboBox()
        self.verified_combo.addItems(["unverified", "effective", "questionable"])
        self.frag_count = QSpinBox()
        self.frag_count.setRange(0, 99)

        form.addRow("ID:", self.id_edit)
        form.addRow("Name:", self.name_edit)
        form.addRow("Incomplete Name:", self.incomplete_name_edit)
        form.addRow("Category:", self.cat_combo)
        form.addRow("Description:", self.desc_edit)
        form.addRow("Source:", self.source_edit)
        form.addRow("Source Type:", self.src_type_combo)
        form.addRow("Verified:", self.verified_combo)
        form.addRow("Fragment Count:", self.frag_count)
        layout.addLayout(form)
        layout.addStretch()

        for w in (self.name_edit, self.incomplete_name_edit, self.source_edit):
            w.textChanged.connect(self._mark_dirty)
        for c in (self.cat_combo, self.src_type_combo, self.verified_combo):
            c.currentTextChanged.connect(self._mark_dirty)
        self.desc_edit.textChanged.connect(self._mark_dirty)
        self.frag_count.valueChanged.connect(self._mark_dirty)

    def load_node(self, nd: NodeData):
        self._nd = nd
        d = nd.data
        self.id_edit.setText(d.get("id", ""))
        self.name_edit.setText(d.get("name", ""))
        self.incomplete_name_edit.setText(d.get("incompleteName", ""))
        self.cat_combo.setCurrentText(d.get("category", "ward"))
        self.desc_edit.setPlainText(d.get("description", ""))
        self.source_edit.setText(d.get("source", ""))
        self.src_type_combo.setCurrentText(d.get("sourceType", "npc"))
        self.verified_combo.setCurrentText(d.get("verified", "unverified"))
        self.frag_count.setValue(d.get("fragmentCount", 0))

    def _mark_dirty(self):
        if not self._nd:
            return
        d = self._nd.data
        d["name"] = self.name_edit.text()
        inc_name = self.incomplete_name_edit.text()
        if inc_name:
            d["incompleteName"] = inc_name
        elif "incompleteName" in d:
            del d["incompleteName"]
        d["category"] = self.cat_combo.currentText()
        d["description"] = self.desc_edit.toPlainText()
        d["source"] = self.source_edit.text()
        d["sourceType"] = self.src_type_combo.currentText()
        d["verified"] = self.verified_combo.currentText()
        d["fragmentCount"] = self.frag_count.value()
        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)
