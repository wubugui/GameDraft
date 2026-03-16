"""Reusable widget for editing a Condition[] array."""
from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLineEdit, QComboBox, QLabel,
)
from PySide6.QtCore import Signal


class ConditionRow(QWidget):
    removed = Signal(object)
    changed = Signal()

    def __init__(self, data: dict | None = None, parent=None):
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        self.flag_edit = QLineEdit(data.get("flag", "") if data else "")
        self.flag_edit.setPlaceholderText("flag key")
        self.flag_edit.setMinimumWidth(120)

        self.op_combo = QComboBox()
        self.op_combo.addItems(["==", "!=", ">", "<", ">=", "<="])
        if data and "op" in data:
            self.op_combo.setCurrentText(data["op"])

        self.val_edit = QLineEdit(str(data.get("value", "true")) if data else "true")
        self.val_edit.setMaximumWidth(80)

        self.del_btn = QPushButton("X")
        self.del_btn.setMaximumWidth(28)
        self.del_btn.clicked.connect(lambda: self.removed.emit(self))

        layout.addWidget(self.flag_edit)
        layout.addWidget(self.op_combo)
        layout.addWidget(self.val_edit)
        layout.addWidget(self.del_btn)

        self.flag_edit.textChanged.connect(self.changed.emit)
        self.op_combo.currentTextChanged.connect(self.changed.emit)
        self.val_edit.textChanged.connect(self.changed.emit)

    def to_dict(self) -> dict:
        result = {"flag": self.flag_edit.text().strip()}
        op = self.op_combo.currentText()
        if op != "==":
            result["op"] = op
        val_text = self.val_edit.text().strip()
        if val_text == "true":
            pass
        elif val_text == "false":
            result["value"] = False
        else:
            try:
                result["value"] = int(val_text)
            except ValueError:
                try:
                    result["value"] = float(val_text)
                except ValueError:
                    result["value"] = val_text
        return result


class ConditionEditor(QWidget):
    changed = Signal()

    def __init__(self, label: str = "Conditions", parent=None):
        super().__init__(parent)
        self._rows: list[ConditionRow] = []
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.addWidget(QLabel(f"<b>{label}</b>"))
        self._rows_layout = QVBoxLayout()
        layout.addLayout(self._rows_layout)
        add_btn = QPushButton(f"+ Add Condition")
        add_btn.clicked.connect(self._add_empty_row)
        layout.addWidget(add_btn)

    def set_data(self, conditions: list[dict]):
        for r in self._rows:
            self._rows_layout.removeWidget(r)
            r.deleteLater()
        self._rows.clear()
        for cond in conditions:
            self._add_row(cond)

    def _add_row(self, data: dict | None = None):
        row = ConditionRow(data)
        row.removed.connect(self._remove_row)
        row.changed.connect(self.changed.emit)
        self._rows.append(row)
        self._rows_layout.addWidget(row)

    def _add_empty_row(self):
        self._add_row({"flag": "", "value": True})
        self.changed.emit()

    def _remove_row(self, row):
        if row in self._rows:
            self._rows.remove(row)
            self._rows_layout.removeWidget(row)
            row.deleteLater()
            self.changed.emit()

    def to_list(self) -> list[dict]:
        return [r.to_dict() for r in self._rows if r.to_dict().get("flag")]
