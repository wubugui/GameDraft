"""Strings.json 树形编辑：分类下键值可为字符串（RichText+引用）、数字或布尔。"""
from __future__ import annotations

import math
from typing import Any

from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QTreeWidget,
    QTreeWidgetItem,
    QLineEdit,
    QPushButton,
    QLabel,
    QHeaderView,
    QSplitter,
    QAbstractItemView,
    QFormLayout,
    QInputDialog,
    QMessageBox,
    QComboBox,
    QStackedWidget,
    QCheckBox,
)
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QBrush

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.form_layout import compact_form
from ..shared.rich_text_field import RichTextTextEdit

_STRING_NODE_KIND = Qt.ItemDataRole.UserRole + 10
_LEAF_VTYPE = Qt.ItemDataRole.UserRole + 11
_LEAF_VPAYLOAD = Qt.ItemDataRole.UserRole + 12


def _preview(val: str, max_len: int = 72) -> str:
    v = val.replace("\n", " ")
    if len(v) <= max_len:
        return v
    return v[: max_len - 1] + "…"


def _json_leaf_pair(val: Any) -> tuple[str, Any]:
    if val is None:
        return "str", ""
    if isinstance(val, bool):
        return "bool", val
    if isinstance(val, (int, float)):
        return "number", val
    return "str", str(val)


def _format_number_edit(n: int | float) -> str:
    if isinstance(n, float) and n.is_integer():
        return str(int(n))
    return str(n)


class StringEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._syncing = False

        lay = QVBoxLayout(self)
        top = QHBoxLayout()
        self._search = QLineEdit()
        self._search.setPlaceholderText("Search keys / values...")
        self._search.setToolTip("按键名或值文本过滤树；命中节点会自动展开")
        self._search.textChanged.connect(self._filter)
        top.addWidget(self._search)
        cat_btn = QPushButton("新分类")
        cat_btn.setToolTip("在 strings.json 顶层新增一个分类（dict 节点）")
        cat_btn.clicked.connect(self._add_top_level_category)
        top.addWidget(cat_btn)
        key_btn = QPushButton("新键")
        key_btn.setToolTip("在当前选中的分类下新增一条键（默认字符串类型）")
        key_btn.clicked.connect(self._add_key_under_category)
        top.addWidget(key_btn)
        del_btn = QPushButton("删除")
        del_btn.setToolTip("删除当前选中的分类或键（Delete 键 / 右键菜单亦可）")
        del_btn.clicked.connect(self._delete_selected_node)
        top.addWidget(del_btn)
        apply_btn = QPushButton("Apply")
        apply_btn.setToolTip("把整棵字符串树提交回模型（校验通过后写入）")
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
        self._tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._tree.customContextMenuRequested.connect(self._show_tree_menu)
        self._tree.installEventFilter(self)
        split.addWidget(self._tree)

        detail = QWidget()
        dl = QVBoxLayout(detail)
        self._path_label = QLabel("")
        self._path_label.setStyleSheet("color:#888;font-size:12px;")
        dl.addWidget(self._path_label)
        form = compact_form(QFormLayout())
        self._key_edit = QLineEdit()
        self._key_edit.setMinimumWidth(240)
        self._key_edit.setPlaceholderText("选中树节点后可编辑键名（分类或叶子）")
        self._key_edit.textChanged.connect(self._on_key_edit_changed)
        form.addRow("Key", self._key_edit)
        type_row = QHBoxLayout()
        self._type_combo = QComboBox()
        for k, lab in [("str", "字符串"), ("number", "数字"), ("bool", "布尔")]:
            self._type_combo.addItem(lab, k)
        self._type_combo.setToolTip("JSON 叶子类型；数字/布尔在 [tag:string:…] 中会被格式化为文本参与展示。")
        self._type_combo.currentIndexChanged.connect(self._on_type_combo_changed)
        type_row.addWidget(QLabel("值类型"))
        type_row.addWidget(self._type_combo, 1)
        form.addRow(type_row)
        dl.addLayout(form)

        self._value_stack = QStackedWidget()
        self._value_edit = RichTextTextEdit(model)
        self._value_edit.setPlaceholderText("文案值；请用「插入引用」添加 [tag:…]，勿手打。")
        self._value_edit.textChanged.connect(self._on_value_str_changed)
        self._value_number = QLineEdit()
        self._value_number.setPlaceholderText("整数或小数，例如 42 / -1.5")
        self._value_number.textChanged.connect(self._on_value_number_changed)
        self._value_bool = QCheckBox("为真（JSON true）")
        self._value_bool.stateChanged.connect(self._on_value_bool_changed)
        self._value_stack.addWidget(self._value_edit)
        self._value_stack.addWidget(self._value_number)
        self._value_stack.addWidget(self._value_bool)
        dl.addWidget(self._value_stack, 1)

        split.addWidget(detail)
        split.setSizes([360, 320])
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

    @staticmethod
    def _parse_number_token(s: str) -> int | float:
        s2 = s.strip()
        if not s2:
            raise ValueError("empty")
        v = float(s2)
        if not math.isfinite(v):
            raise ValueError("non-finite")
        if "." in s2 or "e" in s2.lower():
            return int(v) if v.is_integer() else v
        return int(v)

    @staticmethod
    def _leaf_vtype(it: QTreeWidgetItem) -> str:
        t = it.data(0, _LEAF_VTYPE)
        return t if t in ("str", "number", "bool") else "str"

    @staticmethod
    def _leaf_payload(it: QTreeWidgetItem) -> Any:
        return it.data(0, _LEAF_VPAYLOAD)

    def _tree_preview_and_color(self, vtype: str, payload: Any) -> tuple[str, QBrush | None]:
        if vtype == "bool":
            s = "true" if payload else "false"
            return _preview(s), None
        if vtype == "number":
            s = _format_number_edit(payload) if isinstance(payload, (int, float)) else str(payload)
            return _preview(s), None
        s = str(payload) if payload is not None else ""
        pr = _preview(s)
        if "{" in s or "[tag:" in s:
            return pr, QColor(200, 180, 80)
        return pr, QBrush()

    def _set_leaf_typed(self, it: QTreeWidgetItem, vtype: str, payload: Any) -> None:
        it.setData(0, _LEAF_VTYPE, vtype)
        it.setData(0, _LEAF_VPAYLOAD, payload)
        txt, brush = self._tree_preview_and_color(vtype, payload)
        it.setText(1, txt)
        it.setForeground(1, brush if brush is not None else QBrush())

    def _leaf_filter_blob(self, it: QTreeWidgetItem) -> str:
        vt = self._leaf_vtype(it)
        p = self._leaf_payload(it)
        if vt == "bool":
            return ("true" if p else "false").lower()
        if vt == "number":
            return _format_number_edit(p).lower() if isinstance(p, (int, float)) else str(p).lower()
        return str(p).lower() if p is not None else ""

    def _sync_detail_widgets_from_leaf(self, it: QTreeWidgetItem) -> None:
        vt = self._leaf_vtype(it)
        payload = self._leaf_payload(it)
        idx = {"str": 0, "number": 1, "bool": 2}.get(vt, 0)
        self._type_combo.blockSignals(True)
        self._type_combo.setCurrentIndex(idx)
        self._type_combo.blockSignals(False)
        self._value_stack.setCurrentIndex(idx)
        self._value_edit.blockSignals(True)
        self._value_edit.setPlainText(str(payload) if vt == "str" and payload is not None else "")
        self._value_edit.blockSignals(False)
        self._value_number.blockSignals(True)
        if vt == "number" and isinstance(payload, (int, float)):
            self._value_number.setText(_format_number_edit(payload))
        else:
            self._value_number.setText("" if vt != "number" else "0")
        self._value_number.blockSignals(False)
        self._value_bool.blockSignals(True)
        self._value_bool.setChecked(bool(payload) if vt == "bool" else False)
        self._value_bool.blockSignals(False)

    def _convert_payload(self, vtype_from: str, vtype_to: str, payload: Any) -> Any:
        if vtype_from == vtype_to:
            return payload
        if vtype_to == "str":
            if vtype_from == "bool":
                return "true" if payload else "false"
            if vtype_from == "number":
                return _format_number_edit(payload) if isinstance(payload, (int, float)) else str(payload)
            return str(payload) if payload is not None else ""
        if vtype_to == "number":
            if vtype_from == "bool":
                return 1 if payload else 0
            s = str(payload).strip() if payload is not None else ""
            if not s:
                return 0
            try:
                return self._parse_number_token(s)
            except ValueError:
                return 0
        if vtype_to == "bool":
            if vtype_from == "number":
                return bool(payload)
            s = str(payload).strip().lower() if payload is not None else ""
            return s in ("1", "true", "yes", "y", "是", "on")
        return payload

    def _on_type_combo_changed(self, _i: int) -> None:
        if self._syncing:
            return
        it = self._tree.currentItem()
        if it is None or self._node_kind(it) != "leaf":
            return
        old_t = self._leaf_vtype(it)
        new_t = self._type_combo.currentData()
        if not isinstance(new_t, str):
            new_t = "str"
        if old_t == new_t:
            return
        payload = self._leaf_payload(it)
        if old_t == "str":
            payload = self._value_edit.toPlainText()
        elif old_t == "number":
            raw = self._value_number.text().strip()
            if raw:
                try:
                    payload = self._parse_number_token(raw)
                except ValueError:
                    payload = 0
            else:
                payload = 0
        elif old_t == "bool":
            payload = self._value_bool.isChecked()
        new_payload = self._convert_payload(old_t, new_t, payload)
        self._set_leaf_typed(it, new_t, new_payload)
        self._sync_detail_widgets_from_leaf(it)

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
        self._set_leaf_typed(leaf, "str", "")
        group.setExpanded(True)
        self._tree.setCurrentItem(leaf)
        self._tree.scrollToItem(leaf)
        self._filter(self._search.text().lower())

    def _delete_selected_node(self) -> None:
        it = self._tree.currentItem()
        if it is None:
            QMessageBox.information(self, "删除", "请先在树中选中要删除的分类或键。")
            return
        kind = self._node_kind(it)
        key = it.text(0).strip() or "?"
        if kind == "group" and it.childCount() > 0:
            what = f"分类「{key}」及其下 {it.childCount()} 条键"
        elif kind == "group":
            what = f"空分类「{key}」"
        else:
            what = f"键「{key}」"
        if not confirm.confirm_delete(self, what):
            return
        parent = it.parent()
        if parent is None:
            self._tree.takeTopLevelItem(self._tree.indexOfTopLevelItem(it))
        else:
            parent.removeChild(it)
        # 树是 strings 的真源，删除后 _is_dirty 比较即可检测；mark_dirty 让 Save All 立即感知。
        self._model.mark_dirty("strings")

    def _show_tree_menu(self, pos) -> None:
        from PySide6.QtWidgets import QMenu
        it = self._tree.itemAt(pos)
        if it is not None:
            self._tree.setCurrentItem(it)
        menu = QMenu(self._tree)
        cur = self._tree.currentItem()
        if cur is not None and self._node_kind(cur) == "group":
            menu.addAction("在此分类下新增键", self._add_key_under_category)
        menu.addAction("新增顶层分类", self._add_top_level_category)
        if cur is not None:
            menu.addSeparator()
            menu.addAction("删除此节点", self._delete_selected_node)
        menu.exec(self._tree.viewport().mapToGlobal(pos))

    def eventFilter(self, obj, event):  # type: ignore[override]
        from PySide6.QtGui import QKeyEvent
        if (
            obj is self._tree
            and isinstance(event, QKeyEvent)
            and event.type() == QKeyEvent.Type.KeyPress
            and event.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace)
        ):
            self._delete_selected_node()
            return True
        return super().eventFilter(obj, event)

    def _refresh(self) -> None:
        self._syncing = True
        try:
            self._tree.clear()
            self._populate(self._model.strings, self._tree.invisibleRootItem(), "")
            self._path_label.setText("")
            self._key_edit.clear()
            self._value_edit.setPlainText("")
            self._value_number.clear()
            self._value_bool.setChecked(False)
            self._key_edit.setEnabled(False)
            self._type_combo.setEnabled(False)
            self._value_stack.setEnabled(False)
            self._value_stack.setVisible(False)
            self._value_stack.setVisible(False)
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
                vtype, payload = _json_leaf_pair(val)
                self._set_leaf_typed(node, vtype, payload)

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
        if item.childCount() == 0 and self._node_kind(item) == "leaf":
            full_val = self._leaf_filter_blob(item)
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

    def _flush_current_leaf_from_ui_into_tree(self) -> bool:
        """提交当前选中叶子的输入到树；若数字格式非法返回 False。"""
        it = self._tree.currentItem()
        if it is None or self._node_kind(it) != "leaf":
            return True
        vt = self._leaf_vtype(it)
        if vt == "str":
            self._set_leaf_typed(it, "str", self._value_edit.toPlainText())
            return True
        if vt == "bool":
            self._set_leaf_typed(it, "bool", self._value_bool.isChecked())
            return True
        raw = self._value_number.text().strip()
        if not raw:
            self._set_leaf_typed(it, "number", 0)
            return True
        try:
            n = self._parse_number_token(raw)
        except ValueError:
            QMessageBox.warning(
                self,
                "Apply",
                f"键「{self._item_path(it)}」的数字无效，请修正后再保存。",
            )
            return False
        self._set_leaf_typed(it, "number", n)
        return True

    def _collect_tree(self) -> dict:
        """把整棵树收集成 strings 字典（不校验、不写模型）。脏判断与提交共用。"""
        result: dict = {}
        for i in range(self._tree.topLevelItemCount()):
            self._collect(self._tree.topLevelItem(i), result)
        return result

    def _is_dirty(self) -> bool:
        """树（值控件 live 写入，始终与 UI 同步）与模型是否有差异。"""
        try:
            return self._collect_tree() != (self._model.strings or {})
        except Exception:
            return True  # 结构异常时保守判脏，宁可提示也不丢

    def flush_to_model(self) -> bool:
        """Save All 钩子：未应用编辑在保存前提交；校验失败则中止保存。"""
        if not self._is_dirty():
            return True
        self._apply()
        # _apply 校验失败时不写盘；若仍判脏，说明被拦截，返回 False 让保存上报中止。
        return not self._is_dirty()

    def confirm_close(self, parent=None) -> bool:
        if not self._is_dirty():
            return True
        r = QMessageBox.question(
            self, "未应用的修改", "字符串表有未应用的修改。保存到模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            self._apply()
        else:
            # Discard：把整棵树回滚到模型当前值。否则关闭路径随后的统一 flush 会按
            # 树≠模型判脏，把刚被放弃的编辑重新提交（复核 P1-01）。
            self._refresh()
        return True

    def _apply(self) -> None:
        if not self._validate_tree_structure():
            return
        if not self._flush_current_leaf_from_ui_into_tree():
            return
        self._model.strings = self._collect_tree()
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
        vt = self._leaf_vtype(item)
        payload = self._leaf_payload(item)
        if vt == "str":
            target[key] = str(payload) if payload is not None else ""
        elif vt == "number":
            target[key] = payload if isinstance(payload, (int, float)) else 0
        else:
            target[key] = bool(payload)

    def _on_tree_selection(self, current: QTreeWidgetItem | None, _prev) -> None:
        self._syncing = True
        try:
            if current is None:
                self._path_label.setText("")
                self._key_edit.clear()
                self._value_edit.setPlainText("")
                self._value_number.clear()
                self._value_bool.setChecked(False)
                self._key_edit.setEnabled(False)
                self._type_combo.setEnabled(False)
                self._value_stack.setEnabled(False)
                self._value_stack.setVisible(False)
                return
            path = self._item_path(current)
            if self._node_kind(current) == "group":
                self._path_label.setText(f"strings.json → {path}（分类，可改键名；用「新键」添加条目）")
                self._key_edit.setEnabled(True)
                self._type_combo.setEnabled(False)
                self._value_stack.setEnabled(False)
                self._value_stack.setVisible(False)
                self._key_edit.blockSignals(True)
                self._key_edit.setText(current.text(0))
                self._key_edit.blockSignals(False)
                self._value_edit.setPlainText("")
                self._value_number.clear()
                self._value_bool.setChecked(False)
                return
            self._path_label.setText(f"strings.json → {path}")
            self._key_edit.setEnabled(True)
            self._type_combo.setEnabled(True)
            self._value_stack.setEnabled(True)
            self._value_stack.setVisible(True)
            self._key_edit.blockSignals(True)
            self._key_edit.setText(current.text(0))
            self._key_edit.blockSignals(False)
            self._sync_detail_widgets_from_leaf(current)
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

    def _on_value_str_changed(self) -> None:
        if self._syncing:
            return
        it = self._tree.currentItem()
        if it is None or self._node_kind(it) != "leaf":
            return
        if self._leaf_vtype(it) != "str":
            return
        self._set_leaf_typed(it, "str", self._value_edit.toPlainText())

    def _on_value_number_changed(self, _t: str) -> None:
        if self._syncing:
            return
        it = self._tree.currentItem()
        if it is None or self._node_kind(it) != "leaf":
            return
        if self._leaf_vtype(it) != "number":
            return
        raw = self._value_number.text().strip()
        if not raw:
            self._set_leaf_typed(it, "number", 0)
            return
        try:
            n = self._parse_number_token(raw)
        except ValueError:
            return
        self._set_leaf_typed(it, "number", n)

    def _on_value_bool_changed(self, _state: int) -> None:
        if self._syncing:
            return
        it = self._tree.currentItem()
        if it is None or self._node_kind(it) != "leaf":
            return
        if self._leaf_vtype(it) != "bool":
            return
        self._set_leaf_typed(it, "bool", self._value_bool.isChecked())
