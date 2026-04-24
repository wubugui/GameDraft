"""Strings.json tree key-value editor with search; values use RichText (插入引用)."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTreeWidget, QTreeWidgetItem,
    QLineEdit, QPushButton, QLabel, QHeaderView, QSplitter, QAbstractItemView,
    QFormLayout,
)
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QBrush

from ..project_model import ProjectModel
from ..shared.rich_text_field import RichTextTextEdit


def _preview(val: str, max_len: int = 72) -> str:
    v = val.replace("\n", " ")
    if len(v) <= max_len:
        return v
    return v[: max_len - 1] + "…"


class StringEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._syncing = False

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

        split = QSplitter(Qt.Orientation.Vertical)
        self._tree = QTreeWidget()
        self._tree.setColumnCount(2)
        self._tree.setHeaderLabels(["Key", "Value（预览）"])
        self._tree.header().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self._tree.setAlternatingRowColors(True)
        self._tree.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self._tree.currentItemChanged.connect(self._on_tree_selection)
        split.addWidget(self._tree)

        detail = QWidget()
        dl = QVBoxLayout(detail)
        self._path_label = QLabel("")
        self._path_label.setStyleSheet("color:#888;font-size:12px;")
        dl.addWidget(self._path_label)
        form = QFormLayout()
        self._key_edit = QLineEdit()
        self._key_edit.setPlaceholderText("选中叶子节点后可改键名")
        self._key_edit.textChanged.connect(self._on_key_edit_changed)
        form.addRow("Key", self._key_edit)
        dl.addLayout(form)
        self._value_edit = RichTextTextEdit(model)
        self._value_edit.setPlaceholderText("文案值；请用右侧「插入引用」添加 [tag:…]，勿手打。")
        self._value_edit.textChanged.connect(self._on_value_edit_changed)
        dl.addWidget(self._value_edit, 1)
        split.addWidget(detail)
        split.setSizes([340, 280])
        lay.addWidget(split, 1)

        self._refresh()

    @staticmethod
    def _leaf_full_value(it: QTreeWidgetItem) -> str:
        d = it.data(1, Qt.ItemDataRole.UserRole)
        if isinstance(d, str):
            return d
        return it.text(1)

    @staticmethod
    def _set_leaf_full_value(it: QTreeWidgetItem, s: str) -> None:
        it.setData(1, Qt.ItemDataRole.UserRole, s)
        it.setText(1, _preview(s))
        if "{" in s or "[tag:" in s:
            it.setForeground(1, QColor(200, 180, 80))
        else:
            it.setForeground(1, QBrush())

    def _refresh(self) -> None:
        self._syncing = True
        try:
            self._tree.clear()
            self._populate(self._model.strings, self._tree.invisibleRootItem(), "")
            self._path_label.setText("")
            self._key_edit.clear()
            self._value_edit.setPlainText("")
            self._key_edit.setEnabled(False)
            self._value_edit.setEnabled(False)
        finally:
            self._syncing = False

    def _populate(self, data: dict, parent: QTreeWidgetItem, prefix: str) -> None:
        for key, val in data.items():
            path = f"{prefix}.{key}" if prefix else key
            if isinstance(val, dict):
                node = QTreeWidgetItem(parent, [key, ""])
                node.setFlags(node.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self._populate(val, node, path)
            else:
                node = QTreeWidgetItem(parent, [key, ""])
                node.setFlags(node.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self._set_leaf_full_value(node, str(val))

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
        full_val = ""
        if item.childCount() == 0:
            full_val = self._leaf_full_value(item).lower()
        match = (
            text in item.text(0).lower()
            or text in item.text(1).lower()
            or text in full_val
        )
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
            target[key] = self._leaf_full_value(item)

    def _on_tree_selection(self, current: QTreeWidgetItem | None, _prev) -> None:
        self._syncing = True
        try:
            if current is None or current.childCount() > 0:
                self._path_label.setText("")
                self._key_edit.clear()
                self._value_edit.setPlainText("")
                self._key_edit.setEnabled(False)
                self._value_edit.setEnabled(False)
                return
            path = self._item_path(current)
            self._path_label.setText(f"strings.json → {path}")
            self._key_edit.setEnabled(True)
            self._value_edit.setEnabled(True)
            self._key_edit.blockSignals(True)
            self._key_edit.setText(current.text(0))
            self._key_edit.blockSignals(False)
            self._value_edit.setPlainText(self._leaf_full_value(current))
        finally:
            self._syncing = False

    def _item_path(self, it: QTreeWidgetItem) -> str:
        parts: list[str] = []
        cur: QTreeWidgetItem | None = it
        while cur is not None:
            parts.append(cur.text(0))
            cur = cur.parent()
        return ".".join(reversed(parts))

    def _on_key_edit_changed(self, _t: str) -> None:
        if self._syncing:
            return
        it = self._tree.currentItem()
        if it is None or it.childCount() > 0:
            return
        it.setText(0, self._key_edit.text())

    def _on_value_edit_changed(self) -> None:
        if self._syncing:
            return
        it = self._tree.currentItem()
        if it is None or it.childCount() > 0:
            return
        self._set_leaf_full_value(it, self._value_edit.toPlainText())
