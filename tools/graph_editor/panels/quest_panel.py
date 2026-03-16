from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton,
)
from PySide6.QtCore import Signal
from ..model.node_types import NodeData
from .condition_editor import ConditionEditor
from .action_editor import ActionEditor


class QuestPanel(QWidget):
    data_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._nd: NodeData | None = None
        layout = QVBoxLayout(self)

        form = QFormLayout()
        self.id_edit = QLineEdit()
        self.id_edit.setReadOnly(True)
        self.type_combo = QComboBox()
        self.type_combo.addItems(["main", "side"])
        self.title_edit = QLineEdit()
        self.desc_edit = QTextEdit()
        self.desc_edit.setMaximumHeight(80)
        self.next_edit = QLineEdit()
        self.next_edit.setPlaceholderText("nextQuestId (optional)")

        form.addRow("ID:", self.id_edit)
        form.addRow("Type:", self.type_combo)
        form.addRow("Title:", self.title_edit)
        form.addRow("Description:", self.desc_edit)
        form.addRow("Next Quest:", self.next_edit)
        layout.addLayout(form)

        self.precond_editor = ConditionEditor("Preconditions")
        layout.addWidget(self.precond_editor)

        self.complete_editor = ConditionEditor("Completion Conditions")
        layout.addWidget(self.complete_editor)

        self.rewards_editor = ActionEditor("Rewards")
        layout.addWidget(self.rewards_editor)

        layout.addStretch()

        for w in (self.type_combo, self.title_edit, self.next_edit):
            if hasattr(w, 'textChanged'):
                w.textChanged.connect(self._mark_dirty)
            if hasattr(w, 'currentTextChanged'):
                w.currentTextChanged.connect(self._mark_dirty)
        self.desc_edit.textChanged.connect(self._mark_dirty)
        self.precond_editor.changed.connect(self._mark_dirty)
        self.complete_editor.changed.connect(self._mark_dirty)
        self.rewards_editor.changed.connect(self._mark_dirty)

    def load_node(self, nd: NodeData):
        self._nd = nd
        d = nd.data
        self.id_edit.setText(d.get("id", ""))
        self.type_combo.setCurrentText(d.get("type", "main"))
        self.title_edit.setText(d.get("title", ""))
        self.desc_edit.setPlainText(d.get("description", ""))
        self.next_edit.setText(d.get("nextQuestId", ""))
        self.precond_editor.set_data(d.get("preconditions", []))
        self.complete_editor.set_data(d.get("completionConditions", []))
        self.rewards_editor.set_data(d.get("rewards", []))

    def _mark_dirty(self):
        if not self._nd:
            return
        d = self._nd.data
        d["type"] = self.type_combo.currentText()
        d["title"] = self.title_edit.text()
        d["description"] = self.desc_edit.toPlainText()
        nq = self.next_edit.text().strip()
        if nq:
            d["nextQuestId"] = nq
        elif "nextQuestId" in d:
            del d["nextQuestId"]
        d["preconditions"] = self.precond_editor.to_list()
        d["completionConditions"] = self.complete_editor.to_list()
        d["rewards"] = self.rewards_editor.to_list()
        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)
