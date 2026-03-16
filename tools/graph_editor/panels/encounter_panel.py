from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QFormLayout, QLineEdit, QTextEdit, QLabel,
    QScrollArea, QGroupBox, QComboBox, QPushButton,
)
from PySide6.QtCore import Signal
import json
from ..model.node_types import NodeData
from .condition_editor import ConditionEditor
from .action_editor import ActionEditor


class EncounterPanel(QWidget):
    data_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._nd: NodeData | None = None
        layout = QVBoxLayout(self)

        form = QFormLayout()
        self.id_edit = QLineEdit()
        self.id_edit.setReadOnly(True)
        self.narrative_edit = QTextEdit()
        self.narrative_edit.setMaximumHeight(100)
        form.addRow("ID:", self.id_edit)
        form.addRow("Narrative:", self.narrative_edit)
        layout.addLayout(form)

        layout.addWidget(QLabel("<b>Options</b>"))
        self._options_layout = QVBoxLayout()
        layout.addLayout(self._options_layout)

        layout.addStretch()
        self.narrative_edit.textChanged.connect(self._mark_dirty)

    def load_node(self, nd: NodeData):
        self._nd = nd
        d = nd.data
        self.id_edit.setText(d.get("id", ""))
        self.narrative_edit.setPlainText(d.get("narrative", ""))

        while self._options_layout.count():
            item = self._options_layout.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

        for i, opt in enumerate(d.get("options", [])):
            group = QGroupBox(f"Option {i + 1}")
            gl = QFormLayout(group)
            text_edit = QLineEdit(opt.get("text", ""))
            type_combo = QComboBox()
            type_combo.addItems(["general", "rule", "special"])
            type_combo.setCurrentText(opt.get("type", "general"))
            required_rule_edit = QLineEdit(opt.get("requiredRuleId", ""))
            required_rule_edit.setPlaceholderText("关联规矩ID (可选)")
            result_edit = QTextEdit(opt.get("resultText", ""))
            result_edit.setMaximumHeight(60)

            gl.addRow("Text:", text_edit)
            gl.addRow("Type:", type_combo)
            gl.addRow("Required Rule:", required_rule_edit)
            gl.addRow("Result Text:", result_edit)

            text_edit.textChanged.connect(self._mark_dirty)
            type_combo.currentTextChanged.connect(self._mark_dirty)
            required_rule_edit.textChanged.connect(self._mark_dirty)
            result_edit.textChanged.connect(self._mark_dirty)

            group.setProperty("opt_index", i)
            group.setProperty("text_edit", text_edit)
            group.setProperty("type_combo", type_combo)
            group.setProperty("required_rule_edit", required_rule_edit)
            group.setProperty("result_edit", result_edit)

            self._options_layout.addWidget(group)

    def _mark_dirty(self):
        if not self._nd:
            return
        d = self._nd.data
        d["narrative"] = self.narrative_edit.toPlainText()

        for i in range(self._options_layout.count()):
            item = self._options_layout.itemAt(i)
            if not item or not item.widget():
                continue
            group = item.widget()
            idx = group.property("opt_index")
            if idx is not None and idx < len(d.get("options", [])):
                opt = d["options"][idx]
                te = group.property("text_edit")
                tc = group.property("type_combo")
                rr = group.property("required_rule_edit")
                re = group.property("result_edit")
                if te:
                    opt["text"] = te.text()
                if tc:
                    opt["type"] = tc.currentText()
                if rr:
                    rule_val = rr.text()
                    if rule_val:
                        opt["requiredRuleId"] = rule_val
                    elif "requiredRuleId" in opt:
                        del opt["requiredRuleId"]
                if re:
                    opt["resultText"] = re.toPlainText()

        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)
