"""Strings.json tree key-value editor with search."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTreeWidget, QTreeWidgetItem,
    QLineEdit, QPushButton, QLabel, QHeaderView,
)
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor

from ..project_model import ProjectModel


class StringEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model

        lay = QVBoxLayout(self)
        top = QHBoxLayout()
        self._search = QLineEdit()
        self._search.setPlaceholderText("Search keys / values...")
        self._search.textChanged.connect(self._filter)
        top.addWidget(self._search)
        apply_btn = QPushButton("Apply")
        apply_btn.clicked.connect(self._apply)
        top.addWidget(apply_btn)
        lay.addLayout(top)

        self._tree = QTreeWidget()
        self._tree.setColumnCount(2)
        self._tree.setHeaderLabels(["Key", "Value"])
        self._tree.header().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self._tree.setAlternatingRowColors(True)
        lay.addWidget(self._tree)
        self._refresh()

    def _refresh(self) -> None:
        self._tree.clear()
        self._populate(self._model.strings, self._tree.invisibleRootItem(), "")

    def _populate(self, data: dict, parent: QTreeWidgetItem, prefix: str) -> None:
        for key, val in data.items():
            path = f"{prefix}.{key}" if prefix else key
            if isinstance(val, dict):
                node = QTreeWidgetItem(parent, [key, ""])
                node.setFlags(node.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self._populate(val, node, path)
            else:
                node = QTreeWidgetItem(parent, [key, str(val)])
                node.setFlags(node.flags() | Qt.ItemFlag.ItemIsEditable)
                if "{" in str(val):
                    node.setForeground(1, QColor(200, 180, 80))

    def _filter(self, text: str) -> None:
        text = text.lower()
        for i in range(self._tree.topLevelItemCount()):
            self._filter_item(self._tree.topLevelItem(i), text)

    def _filter_item(self, item: QTreeWidgetItem, text: str) -> bool:
        if not text:
            item.setHidden(False)
            for j in range(item.childCount()):
                self._filter_item(item.child(j), text)
            return True
        match = text in item.text(0).lower() or text in item.text(1).lower()
        child_match = False
        for j in range(item.childCount()):
            if self._filter_item(item.child(j), text):
                child_match = True
        visible = match or child_match
        item.setHidden(not visible)
        if visible:
            item.setExpanded(True)
        return visible

    def _apply(self) -> None:
        result: dict = {}
        for i in range(self._tree.topLevelItemCount()):
            self._collect(self._tree.topLevelItem(i), result)
        self._model.strings = result
        self._model.mark_dirty("strings")

    def _collect(self, item: QTreeWidgetItem, target: dict) -> None:
        key = item.text(0)
        if item.childCount() > 0:
            sub: dict = {}
            for j in range(item.childCount()):
                self._collect(item.child(j), sub)
            target[key] = sub
        else:
            target[key] = item.text(1)
