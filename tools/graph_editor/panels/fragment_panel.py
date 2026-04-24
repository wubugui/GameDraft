from PySide6.QtWidgets import QWidget, QVBoxLayout, QFormLayout, QLineEdit, QSpinBox
from PySide6.QtCore import Signal
from tools.editor.project_model import ProjectModel
from tools.editor.shared.rich_text_field import RichTextLineEdit, RichTextTextEdit

from ..model.node_types import NodeData


class FragmentPanel(QWidget):
    data_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._nd: NodeData | None = None
        self._pm = ProjectModel()
        layout = QVBoxLayout(self)
        form = QFormLayout()

        self.id_edit = QLineEdit()
        self.id_edit.setReadOnly(True)
        self.rule_id_edit = QLineEdit()
        self.rule_id_edit.setPlaceholderText("所属规矩ID")
        self.index_spin = QSpinBox()
        self.index_spin.setRange(0, 99)
        self.text_edit = RichTextTextEdit(self._pm)
        self.text_edit.setMaximumHeight(100)
        self.source_edit = RichTextLineEdit(self._pm)
        self.source_edit.setPlaceholderText("碎片来源描述")

        form.addRow("ID:", self.id_edit)
        form.addRow("Rule ID:", self.rule_id_edit)
        form.addRow("Index:", self.index_spin)
        form.addRow("Text:", self.text_edit)
        form.addRow("Source:", self.source_edit)
        layout.addLayout(form)
        layout.addStretch()

        self.rule_id_edit.textChanged.connect(self._mark_dirty)
        self.index_spin.valueChanged.connect(self._mark_dirty)
        self.text_edit.textChanged.connect(self._mark_dirty)
        self.source_edit.textChanged.connect(self._mark_dirty)

    def set_editor_model(self, pm: ProjectModel | None) -> None:
        if pm is None:
            return
        self._pm = pm
        self.text_edit.set_model(pm)
        self.source_edit.set_model(pm)

    def load_node(self, nd: NodeData):
        self._nd = nd
        d = nd.data
        self.id_edit.setText(d.get("id", ""))
        self.rule_id_edit.setText(d.get("ruleId", ""))
        self.index_spin.setValue(d.get("index", 0))
        self.text_edit.setPlainText(d.get("text", ""))
        self.source_edit.setText(d.get("source", ""))

    def _mark_dirty(self):
        if not self._nd:
            return
        d = self._nd.data
        d["ruleId"] = self.rule_id_edit.text()
        d["index"] = self.index_spin.value()
        d["text"] = self.text_edit.toPlainText()
        src = self.source_edit.text()
        if src:
            d["source"] = src
        elif "source" in d:
            del d["source"]
        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)
