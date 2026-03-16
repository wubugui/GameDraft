from PySide6.QtWidgets import QWidget, QVBoxLayout, QFormLayout, QLineEdit, QSpinBox, QTextEdit, QLabel
from PySide6.QtCore import Signal
from ..model.node_types import NodeData
from .condition_editor import ConditionEditor
from .action_editor import ActionEditor


class ZonePanel(QWidget):
    data_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._nd: NodeData | None = None
        layout = QVBoxLayout(self)
        form = QFormLayout()

        self.id_edit = QLineEdit()
        self.id_edit.setReadOnly(True)
        self.x_spin = QSpinBox()
        self.x_spin.setRange(0, 10000)
        self.y_spin = QSpinBox()
        self.y_spin.setRange(0, 10000)
        self.w_spin = QSpinBox()
        self.w_spin.setRange(1, 10000)
        self.h_spin = QSpinBox()
        self.h_spin.setRange(1, 10000)

        form.addRow("ID:", self.id_edit)
        form.addRow("X:", self.x_spin)
        form.addRow("Y:", self.y_spin)
        form.addRow("Width:", self.w_spin)
        form.addRow("Height:", self.h_spin)
        layout.addLayout(form)

        self.cond_editor = ConditionEditor("Conditions")
        layout.addWidget(self.cond_editor)

        self.enter_editor = ActionEditor("onEnter Actions")
        layout.addWidget(self.enter_editor)

        self.exit_editor = ActionEditor("onExit Actions")
        layout.addWidget(self.exit_editor)

        lbl = QLabel("Rule Slots:")
        lbl.setStyleSheet("font-weight: bold; margin-top: 8px;")
        layout.addWidget(lbl)

        self.slots_text = QTextEdit()
        self.slots_text.setMaximumHeight(120)
        self.slots_text.setReadOnly(True)
        self.slots_text.setStyleSheet("font-size: 12px; color: #ccc; background: #1e1e2e;")
        layout.addWidget(self.slots_text)

        layout.addStretch()

        for w in (self.x_spin, self.y_spin, self.w_spin, self.h_spin):
            w.valueChanged.connect(self._mark_dirty)
        self.cond_editor.changed.connect(self._mark_dirty)
        self.enter_editor.changed.connect(self._mark_dirty)
        self.exit_editor.changed.connect(self._mark_dirty)

    def load_node(self, nd: NodeData):
        self._nd = nd
        d = nd.data
        self.id_edit.setText(d.get("id", ""))
        self.x_spin.setValue(d.get("x", 0))
        self.y_spin.setValue(d.get("y", 0))
        self.w_spin.setValue(d.get("width", 100))
        self.h_spin.setValue(d.get("height", 100))
        self.cond_editor.set_data(d.get("conditions", []))
        self.enter_editor.set_data(d.get("onEnter", []))
        self.exit_editor.set_data(d.get("onExit", []))

        slots = d.get("ruleSlots", [])
        lines = []
        for s in slots:
            rid = s.get("ruleId", "?")
            txt = s.get("resultText", "")[:40]
            lines.append(f"  {rid}: {txt}...")
        self.slots_text.setPlainText("\n".join(lines) if lines else "(none)")

    def _mark_dirty(self):
        if not self._nd:
            return
        d = self._nd.data
        d["x"] = self.x_spin.value()
        d["y"] = self.y_spin.value()
        d["width"] = self.w_spin.value()
        d["height"] = self.h_spin.value()
        conds = self.cond_editor.to_list()
        if conds:
            d["conditions"] = conds
        elif "conditions" in d:
            del d["conditions"]
        enter = self.enter_editor.to_list()
        if enter:
            d["onEnter"] = enter
        elif "onEnter" in d:
            del d["onEnter"]
        exit_acts = self.exit_editor.to_list()
        if exit_acts:
            d["onExit"] = exit_acts
        elif "onExit" in d:
            del d["onExit"]
        self._nd.dirty = True
        self.data_changed.emit(self._nd.id)
