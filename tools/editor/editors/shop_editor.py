"""Shop definition editor."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QPushButton, QSpinBox, QLabel, QTableWidget,
    QTableWidgetItem, QHeaderView,
)
from PySide6.QtCore import Qt

from ..project_model import ProjectModel
from ..shared.id_ref_selector import IdRefSelector
from ..shared.rich_text_field import RichTextLineEdit


class ShopEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx = -1

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Shop"); btn_add.clicked.connect(self._add)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)

        right = QWidget()
        rl = QVBoxLayout(right)
        f = QFormLayout()
        self._s_id = QLineEdit(); f.addRow("id", self._s_id)
        self._s_name = RichTextLineEdit(self._model); f.addRow("name", self._s_name)
        rl.addLayout(f)
        rl.addWidget(QLabel("<b>Items</b>"))
        self._table = QTableWidget(0, 2)
        self._table.setHorizontalHeaderLabels(["itemId", "price"])
        self._table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self._table.verticalHeader().setDefaultSectionSize(34)
        rl.addWidget(self._table)
        item_btns = QHBoxLayout()
        add_item = QPushButton("+ Item"); add_item.clicked.connect(self._add_item)
        del_item = QPushButton("- Item"); del_item.clicked.connect(self._del_item)
        item_btns.addWidget(add_item); item_btns.addWidget(del_item)
        rl.addLayout(item_btns)
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply)
        rl.addWidget(apply_btn)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([220, 500])
        root.addWidget(splitter)
        self._refresh()

    def _make_item_pick(self, item_id: str) -> IdRefSelector:
        w = IdRefSelector(self, allow_empty=False)
        w.setMinimumWidth(200)
        w.set_items(self._model.all_item_ids())
        w.set_current(item_id or "")
        return w

    def _refresh(self) -> None:
        self._list.clear()
        for s in self._model.shops:
            self._list.addItem(f"{s.get('id', '?')}  [{s.get('name', '')}]")

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.shops):
            return
        self._current_idx = row
        s = self._model.shops[row]
        self._s_id.setText(s.get("id", ""))
        self._s_name.setText(s.get("name", ""))
        items = s.get("items", [])
        self._table.setRowCount(len(items))
        for i, si in enumerate(items):
            self._table.setCellWidget(i, 0, self._make_item_pick(si.get("itemId", "")))
            self._table.setItem(i, 1, QTableWidgetItem(str(si.get("price", 0))))

    def _add_item(self) -> None:
        r = self._table.rowCount()
        self._table.insertRow(r)
        self._table.setCellWidget(r, 0, self._make_item_pick(""))
        self._table.setItem(r, 1, QTableWidgetItem("0"))

    def _del_item(self) -> None:
        r = self._table.currentRow()
        if r >= 0:
            self._table.removeRow(r)

    def _apply(self) -> None:
        if self._current_idx < 0:
            return
        s = self._model.shops[self._current_idx]
        s["id"] = self._s_id.text().strip()
        s["name"] = self._s_name.text()
        items = []
        for i in range(self._table.rowCount()):
            iid_w = self._table.cellWidget(i, 0)
            price = self._table.item(i, 1)
            if isinstance(iid_w, IdRefSelector):
                raw_id = iid_w.current_id().strip()
                if not raw_id:
                    continue
                si: dict = {"itemId": raw_id}
                try:
                    si["price"] = int(price.text()) if price else 0
                except ValueError:
                    si["price"] = 0
                items.append(si)
        s["items"] = items
        self._model.mark_dirty("shop")
        self._refresh()

    def _add(self) -> None:
        self._model.shops.append({"id": f"shop_{len(self._model.shops)}", "name": "", "items": []})
        self._model.mark_dirty("shop")
        self._refresh()

    def _delete(self) -> None:
        if self._current_idx >= 0:
            self._model.shops.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("shop")
            self._refresh()
