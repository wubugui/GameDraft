"""Strings.json tree key-value editor with search; values use RichText (插入引用)."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QTreeWidget, QTreeWidgetItem,
    QLineEdit, QPushButton, QLabel, QHeaderView, QSplitter, QAbstractItemView,
    QFormLayout, QInputDialog, QMessageBox,
)
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QBrush

from ..project_model import ProjectModel
from ..shared.rich_text_field import RichTextTextEdit

# 区分 dict 分类节点与字符串叶节点（空分类 childCount==0 仍为 group）
_STRING_NODE_KIND = Qt.ItemDataRole.UserRole + 10


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
        cat_btn = QPushButton("新分类")
        cat_btn.setToolTip("在 strings.json 顶层新增一个分类（dict 节点）")
        cat_btn.clicked.connect(self._add_top_level_category)
        top.addWidget(cat_btn)
        key_btn = QPushButton("新键")
        key_btn.setToolTip("在当前选中的分类下新增一条字符串键（可选中空分类或叶子条目的上一级）")
        key_btn.clicked.connect(self._add_key_under_category)
        top.addWidget(key_btn)
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
        self._key_edit.setPlaceholderText("选中树节点后可编辑键名（分类或叶子）")
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
    def _node_kind(it: QTreeWidgetItem) -> str:
        raw = it.data(0, _STRING_NODE_KIND)
        if raw in ("group", "leaf"):
            return raw
        return "group" if it.childCount() > 0 else "leaf"

    @staticmethod
    def _set_node_kind(it: QTreeWidgetItem, kind: str) -> None:
        it.setData(0, _STRING_NODE_KIND, kind)

    def _add_top_level_category(self) -> None:
        name, ok = QInputDialog.getText(
            self,
            "新分类",
            "顶层分类名（将作为 strings.json 的一级键）：",
        )
        if not ok:
            return
        key = (name or "").strip()
        if not key:
            QMessageBox.warning(self, "新分类", "分类名不能为空。")
            return
        if self._top_level_key_exists(key):
            QMessageBox.warning(self, "新分类", f"已存在顶层键 {key!r}，请换名。")
            return
        node = QTreeWidgetItem(self._tree, [key, ""])
        node.setFlags(node.flags() & ~Qt.ItemFlag.ItemIsEditable)
        self._set_node_kind(node, "group")
        self._tree.setCurrentItem(node)
        self._tree.scrollToItem(node)
        self._filter(self._search.text().lower())

    def _top_level_key_exists(self, key: str) -> bool:
        k = key.strip()
        for i in range(self._tree.topLevelItemCount()):
            if self._tree.topLevelItem(i).text(0).strip() == k:
                return True
        return False

    def _resolve_target_group(self) -> QTreeWidgetItem | None:
        it = self._tree.currentItem()
        if it is None:
            QMessageBox.information(self, "新键", "请先在树中选一个分类（或其下的键）。")
            return None
        if self._node_kind(it) == "group":
            return it
        par = it.parent()
        if par is None:
            return None
        return par

    def _unique_key_among_siblings(self, parent: QTreeWidgetItem, base: str) -> str:
        labels = {
            parent.child(j).text(0).strip()
            for j in range(parent.childCount())
        }
        cand = base
        n = 2
        while cand in labels:
            cand = f"{base}_{n}"
            n += 1
        return cand

    def _add_key_under_category(self) -> None:
        group = self._resolve_target_group()
        if group is None:
            QMessageBox.information(
                self,
                "新键",
                "无法确定分类：请选中一个分类节点，或其下的某条键。",
            )
            return
        key = self._unique_key_among_siblings(group, "new_key")
        leaf = QTreeWidgetItem(group, [key, ""])
        leaf.setFlags(leaf.flags() & ~Qt.ItemFlag.ItemIsEditable)
        self._set_node_kind(leaf, "leaf")
        self._set_leaf_full_value(leaf, "")
        group.setExpanded(True)
        self._tree.setCurrentItem(leaf)
        self._tree.scrollToItem(leaf)
        self._filter(self._search.text().lower())

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
                self._set_node_kind(node, "group")
                self._populate(val, node, path)
            else:
                node = QTreeWidgetItem(parent, [key, ""])
                node.setFlags(node.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self._set_node_kind(node, "leaf")
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
        if not self._validate_tree_structure():
            return
        result: dict = {}
        for i in range(self._tree.topLevelItemCount()):
            self._collect(self._tree.topLevelItem(i), result)
        self._model.strings = result
        self._model.mark_dirty("strings")

    def _validate_tree_structure(self) -> bool:
        seen_top: set[str] = set()
        for i in range(self._tree.topLevelItemCount()):
            it = self._tree.topLevelItem(i)
            k = it.text(0).strip()
            if not k:
                QMessageBox.warning(self, "Apply", "存在空的顶层键名，请修正。")
                return False
            if k in seen_top:
                QMessageBox.warning(self, "Apply", f"顶层重复键名 {k!r}，请修正。")
                return False
            seen_top.add(k)
            kind = self._node_kind(it)
            if kind == "group":
                if not self._validate_group_children(it, k):
                    return False
            elif kind == "leaf":
                continue
            else:
                QMessageBox.warning(self, "Apply", f"节点 {k!r} 类型不明，请刷新重载。")
                return False
        return True

    def _validate_group_children(self, group: QTreeWidgetItem, path: str) -> bool:
        seen: set[str] = set()
        for j in range(group.childCount()):
            ch = group.child(j)
            ck = ch.text(0).strip()
            if not ck:
                QMessageBox.warning(self, "Apply", f"{path} 下存在空键名，请修正。")
                return False
            if ck in seen:
                QMessageBox.warning(
                    self,
                    "Apply",
                    f"{path} 下重复键名 {ck!r}，请修正。",
                )
                return False
            seen.add(ck)
            kind = self._node_kind(ch)
            if kind == "group":
                if not self._validate_group_children(ch, f"{path}.{ck}"):
                    return False
            elif kind != "leaf":
                QMessageBox.warning(
                    self,
                    "Apply",
                    f"{path}.{ck} 节点类型异常，请删除后重建或重新载入工程。",
                )
                return False
        return True

    def _collect(self, item: QTreeWidgetItem, target: dict) -> None:
        key = item.text(0).strip()
        if self._node_kind(item) == "group":
            sub: dict = {}
            for j in range(item.childCount()):
                self._collect(item.child(j), sub)
            target[key] = sub
            return
        target[key] = self._leaf_full_value(item)

    def _on_tree_selection(self, current: QTreeWidgetItem | None, _prev) -> None:
        self._syncing = True
        try:
            if current is None:
                self._path_label.setText("")
                self._key_edit.clear()
                self._value_edit.setPlainText("")
                self._key_edit.setEnabled(False)
                self._value_edit.setEnabled(False)
                return
            path = self._item_path(current)
            if self._node_kind(current) == "group":
                self._path_label.setText(f"strings.json → {path}（分类，可改键名；用「新键」添加条目）")
                self._key_edit.setEnabled(True)
                self._value_edit.setEnabled(False)
                self._key_edit.blockSignals(True)
                self._key_edit.setText(current.text(0))
                self._key_edit.blockSignals(False)
                self._value_edit.setPlainText("")
                return
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
        if it is None:
            return
        it.setText(0, self._key_edit.text())

    def _on_value_edit_changed(self) -> None:
        if self._syncing:
            return
        it = self._tree.currentItem()
        if it is None or self._node_kind(it) != "leaf":
            return
        self._set_leaf_full_value(it, self._value_edit.toPlainText())
