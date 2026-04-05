"""Reusable Condition[] editor with flag auto-complete."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton, QLineEdit,
    QComboBox, QLabel, QCompleter,
)
from PySide6.QtCore import Signal, Qt


class ConditionRow(QWidget):
    removed = Signal(object)
    changed = Signal()

    def __init__(self, data: dict | None = None, flags: list[str] | None = None,
                 parent: QWidget | None = None):
        super().__init__(parent)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)

        self.flag_edit = QLineEdit(data.get("flag", "") if data else "")
        self.flag_edit.setPlaceholderText("flag")
        self.flag_edit.setMinimumWidth(140)
        if flags:
            comp = QCompleter(sorted(flags))
            comp.setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
            comp.setFilterMode(Qt.MatchFlag.MatchContains)
            self.flag_edit.setCompleter(comp)

        self.op_combo = QComboBox()
        self.op_combo.addItems(["==", "!=", ">", "<", ">=", "<="])
        if data and "op" in data:
            self.op_combo.setCurrentText(data["op"])
        self.op_combo.setMaximumWidth(56)

        self.val_edit = QLineEdit(str(data.get("value", "true")) if data else "true")
        self.val_edit.setMaximumWidth(80)

        self.del_btn = QPushButton("\u2212")
        self.del_btn.setFixedWidth(24)
        self.del_btn.clicked.connect(lambda: self.removed.emit(self))

        lay.addWidget(self.flag_edit, stretch=1)
        lay.addWidget(self.op_combo)
        lay.addWidget(self.val_edit)
        lay.addWidget(self.del_btn)

        self.flag_edit.textChanged.connect(self.changed)
        self.op_combo.currentTextChanged.connect(self.changed)
        self.val_edit.textChanged.connect(self.changed)

    def to_dict(self) -> dict:
        result: dict = {"flag": self.flag_edit.text().strip()}
        op = self.op_combo.currentText()
        if op != "==":
            result["op"] = op
        raw = self.val_edit.text().strip()
        if raw == "true":
            pass
        elif raw == "false":
            result["value"] = False
        else:
            try:
                result["value"] = int(raw)
            except ValueError:
                try:
                    result["value"] = float(raw)
                except ValueError:
                    result["value"] = raw
        return result


class ConditionEditor(QWidget):
    changed = Signal()

    def __init__(self, label: str = "Conditions", parent: QWidget | None = None):
        super().__init__(parent)
        self._rows: list[ConditionRow] = []
        self._flags: list[str] = []

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(QLabel(f"<b>{label}</b>"))
        self._rows_layout = QVBoxLayout()
        self._rows_layout.setSpacing(2)
        root.addLayout(self._rows_layout)
        add_btn = QPushButton(f"+ {label}")
        add_btn.clicked.connect(self._add_empty)
        root.addWidget(add_btn)

    def set_flags(self, flags: list[str]) -> None:
        self._flags = flags

    def set_data(self, conditions: list[dict]) -> None:
        self._clear()
        for c in conditions:
            self._add_row(c)

    def to_list(self) -> list[dict]:
        return [r.to_dict() for r in self._rows if r.to_dict().get("flag")]

    def _clear(self) -> None:
        for r in self._rows:
            self._rows_layout.removeWidget(r)
            r.deleteLater()
        self._rows.clear()

    def _add_row(self, data: dict | None = None) -> None:
        row = ConditionRow(data, self._flags)
        row.removed.connect(self._remove_row)
        row.changed.connect(self.changed)
        self._rows.append(row)
        self._rows_layout.addWidget(row)

    def _add_empty(self) -> None:
        self._add_row({"flag": "", "value": True})
        self.changed.emit()

    def _remove_row(self, row: ConditionRow) -> None:
        if row in self._rows:
            self._rows.remove(row)
            self._rows_layout.removeWidget(row)
            row.deleteLater()
            self.changed.emit()
