"""Audio configuration editor."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTabWidget, QListWidget,
    QFormLayout, QLineEdit, QPushButton, QLabel, QTableWidget,
    QTableWidgetItem, QHeaderView,
)
from PySide6.QtCore import Qt

from ..project_model import ProjectModel


class _AudioChannelTab(QWidget):
    def __init__(self, model: ProjectModel, channel: str, parent=None):
        super().__init__(parent)
        self._model = model
        self._channel = channel

        lay = QVBoxLayout(self)
        self._table = QTableWidget(0, 2)
        self._table.setHorizontalHeaderLabels(["id", "src"])
        self._table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        lay.addWidget(self._table)

        btns = QHBoxLayout()
        add_btn = QPushButton("+ Entry"); add_btn.clicked.connect(self._add)
        del_btn = QPushButton("- Entry"); del_btn.clicked.connect(self._delete)
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply)
        btns.addWidget(add_btn); btns.addWidget(del_btn); btns.addWidget(apply_btn)
        lay.addLayout(btns)
        self._refresh()

    def _refresh(self) -> None:
        entries = self._model.audio_config.get(self._channel, {})
        self._table.setRowCount(len(entries))
        for i, (aid, obj) in enumerate(entries.items()):
            self._table.setItem(i, 0, QTableWidgetItem(aid))
            self._table.setItem(i, 1, QTableWidgetItem(obj.get("src", "")))

    def _add(self) -> None:
        r = self._table.rowCount()
        self._table.insertRow(r)
        self._table.setItem(r, 0, QTableWidgetItem(""))
        self._table.setItem(r, 1, QTableWidgetItem(""))

    def _delete(self) -> None:
        r = self._table.currentRow()
        if r >= 0:
            self._table.removeRow(r)

    def _apply(self) -> None:
        ch: dict = {}
        for i in range(self._table.rowCount()):
            aid_item = self._table.item(i, 0)
            src_item = self._table.item(i, 1)
            if aid_item and aid_item.text().strip():
                ch[aid_item.text().strip()] = {"src": src_item.text() if src_item else ""}
        self._model.audio_config[self._channel] = ch
        self._model.mark_dirty("audio")


class AudioEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        lay = QVBoxLayout(self)
        tabs = QTabWidget()
        tabs.addTab(_AudioChannelTab(model, "bgm"), "BGM")
        tabs.addTab(_AudioChannelTab(model, "ambient"), "Ambient")
        tabs.addTab(_AudioChannelTab(model, "sfx"), "SFX")
        lay.addWidget(tabs)
