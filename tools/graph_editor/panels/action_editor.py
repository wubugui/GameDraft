"""Reusable widget for editing an ActionDef[] array."""
import json
import sys
from pathlib import Path

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLineEdit, QLabel,
)
from PySide6.QtCore import Signal

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
from tools.editor.shared.action_editor import FilterableTypeCombo, ACTION_TYPES


class ActionRow(QWidget):
    removed = Signal(object)
    changed = Signal()

    def __init__(self, data: dict | None = None, parent=None):
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        self.type_combo = FilterableTypeCombo.from_flat_strings(ACTION_TYPES)
        if data:
            self.type_combo.set_committed_type(data.get("type", "setFlag"))

        self.params_edit = QLineEdit()
        self.params_edit.setPlaceholderText('{"key":"value"}')
        if data and "params" in data:
            self.params_edit.setText(json.dumps(data["params"], ensure_ascii=False))

        self.del_btn = QPushButton("X")
        self.del_btn.setMaximumWidth(28)
        self.del_btn.clicked.connect(lambda: self.removed.emit(self))

        layout.addWidget(self.type_combo)
        layout.addWidget(self.params_edit, stretch=1)
        layout.addWidget(self.del_btn)

        self.type_combo.typeCommitted.connect(self.changed.emit)
        self.params_edit.textChanged.connect(self.changed.emit)

    def to_dict(self) -> dict:
        try:
            params = json.loads(self.params_edit.text())
        except (json.JSONDecodeError, ValueError):
            params = {}
        return {"type": self.type_combo.committed_type(), "params": params}


class ActionEditor(QWidget):
    changed = Signal()

    def __init__(self, label: str = "Actions", parent=None):
        super().__init__(parent)
        self._rows: list[ActionRow] = []
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(QLabel(f"<b>{label}</b>"))
        self._rows_layout = QVBoxLayout()
        layout.addLayout(self._rows_layout)
        add_btn = QPushButton(f"+ Add Action")
        add_btn.clicked.connect(self._add_empty_row)
        layout.addWidget(add_btn)

    def set_data(self, actions: list[dict]):
        for r in self._rows:
            self._rows_layout.removeWidget(r)
            r.deleteLater()
        self._rows.clear()
        for act in actions:
            self._add_row(act)

    def _add_row(self, data: dict | None = None):
        row = ActionRow(data)
        row.removed.connect(self._remove_row)
        row.changed.connect(self.changed.emit)
        self._rows.append(row)
        self._rows_layout.addWidget(row)

    def _add_empty_row(self):
        self._add_row({"type": "setFlag", "params": {}})
        self.changed.emit()

    def _remove_row(self, row):
        if row in self._rows:
            self._rows.remove(row)
            self._rows_layout.removeWidget(row)
            row.deleteLater()
            self.changed.emit()

    def to_list(self) -> list[dict]:
        return [r.to_dict() for r in self._rows]
