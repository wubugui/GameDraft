"""Shop definition editor."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QPushButton, QSpinBox, QLabel, QTableWidget,
    QTableWidgetItem, QHeaderView, QMessageBox,
)
from PySide6.QtCore import Qt

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.id_ref_selector import IdRefSelector
from ..shared.rich_text_field import RichTextLineEdit
from ..shared.form_layout import compact_form


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
        self._search = QLineEdit()
        self._search.setPlaceholderText("搜索…")
        self._search.setClearButtonEnabled(True)
        self._search.setToolTip("按 id / 名称过滤商店列表（仅隐藏不匹配行，不改数据）")
        self._search.textChanged.connect(self._on_search_changed)
        ll.addWidget(self._search)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)
        self._empty_hint = QLabel("暂无商店，点击「+ Shop」新增")
        self._empty_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._empty_hint.setWordWrap(True)
        self._empty_hint.setStyleSheet("color: gray;")
        self._empty_hint.setVisible(False)
        ll.addWidget(self._empty_hint)

        right = QWidget()
        rl = QVBoxLayout(right)
        f = compact_form(QFormLayout())
        self._s_id = QLineEdit(); f.addRow("id", self._s_id)
        self._s_name = RichTextLineEdit(self._model); f.addRow("name", self._s_name)
        rl.addLayout(f)
        rl.addWidget(QLabel("<b>Items</b>"))
        self._table = QTableWidget(0, 2)
        self._table.setHorizontalHeaderLabels(["itemId", "price"])
        header = self._table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        self._table.verticalHeader().setDefaultSectionSize(26)
        self._table.setMinimumHeight(100)
        rl.addWidget(self._table)
        item_btns = QHBoxLayout()
        add_item = QPushButton("+ Item"); add_item.clicked.connect(self._add_item)
        del_item = QPushButton("− Item"); del_item.clicked.connect(self._del_item)
        move_up = QPushButton("Move Up"); move_up.clicked.connect(self._move_up)
        move_down = QPushButton("Move Down"); move_down.clicked.connect(self._move_down)
        item_btns.addWidget(add_item); item_btns.addWidget(del_item)
        item_btns.addWidget(move_up); item_btns.addWidget(move_down)
        rl.addLayout(item_btns)
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply)
        rl.addWidget(apply_btn)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([220, 500])
        root.addWidget(splitter)
        self._refresh()

    def reload_refs_from_model(self) -> None:
        """切页激活时重拉物品下拉候选(别处新增的 item),保留各行当前选中值。"""
        for i in range(self._table.rowCount()):
            w = self._table.cellWidget(i, 0)
            if isinstance(w, IdRefSelector):
                w.set_items(self._model.all_item_ids())

    def _make_item_pick(self, item_id: str) -> IdRefSelector:
        w = IdRefSelector(self, allow_empty=False, editable=False, click_opens_popup=True)
        w.setMinimumWidth(200)
        w.set_items(self._model.all_item_ids())
        w.set_current(item_id or "")
        return w

    def _make_price_spin(self, value: int) -> QSpinBox:
        sp = QSpinBox()
        sp.setRange(0, 999999)
        sp.setValue(int(value or 0))
        return sp

    def _price_at(self, row: int) -> int:
        w = self._table.cellWidget(row, 1)
        return int(w.value()) if isinstance(w, QSpinBox) else 0

    def _on_search_changed(self, text: str) -> None:
        q = text.strip().lower()
        for i in range(self._list.count()):
            it = self._list.item(i)
            it.setHidden(bool(q) and q not in it.text().lower())

    def _update_empty_hint(self) -> None:
        self._empty_hint.setVisible(self._list.count() == 0)

    def _refresh(self) -> None:
        self._list.clear()
        for s in self._model.shops:
            self._list.addItem(f"{s.get('id', '?')}  [{s.get('name', '')}]")
        self._on_search_changed(self._search.text())
        self._update_empty_hint()

    def select_by_id(self, shop_id: str, _scene_id: str = "") -> bool:
        """全局搜索/跳转落点：按商店 id 选中（行序与 model.shops 一致）。"""
        for i, s in enumerate(self._model.shops):
            if s.get("id") == shop_id:
                if self._search.text():
                    self._search.clear()  # 目标行可能被过滤隐藏
                self._list.setCurrentRow(i)
                return True
        return False

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.shops):
            return
        # commit-on-leave：切到别的商店前提交上一项未应用编辑，避免静默丢弃。
        if 0 <= self._current_idx < len(self._model.shops) and self._current_idx != row \
                and self._is_dirty():
            self._apply()
        self._current_idx = row
        s = self._model.shops[row]
        self._s_id.setText(s.get("id", ""))
        self._s_name.setText(s.get("name", ""))
        items = s.get("items", [])
        self._table.setRowCount(len(items))
        for i, si in enumerate(items):
            self._table.setCellWidget(i, 0, self._make_item_pick(si.get("itemId", "")))
            self._table.setCellWidget(i, 1, self._make_price_spin(int(si.get("price", 0) or 0)))

    def _add_item(self) -> None:
        r = self._table.rowCount()
        self._table.insertRow(r)
        self._table.setCellWidget(r, 0, self._make_item_pick(""))
        self._table.setCellWidget(r, 1, self._make_price_spin(0))

    def _del_item(self) -> None:
        r = self._table.currentRow()
        if r >= 0:
            self._table.removeRow(r)

    def _read_rows(self) -> list[tuple[str, str]]:
        """Read current table rows into (itemId, price_text) tuples.

        Uses the same value extraction as _apply (cellWidget current_id +
        price item text) but preserves raw strings so the table can be
        rebuilt losslessly.
        """
        rows: list[tuple[str, str]] = []
        for i in range(self._table.rowCount()):
            iid_w = self._table.cellWidget(i, 0)
            iid = iid_w.current_id() if isinstance(iid_w, IdRefSelector) else ""
            rows.append((iid, str(self._price_at(i))))
        return rows

    def _repopulate(self, rows: list[tuple[str, str]]) -> None:
        """Rebuild the items table from a list of (itemId, price_text)."""
        self._table.setRowCount(len(rows))
        for i, (iid, price_text) in enumerate(rows):
            self._table.setCellWidget(i, 0, self._make_item_pick(iid))
            try:
                _pv = int(price_text)
            except (TypeError, ValueError):
                _pv = 0
            self._table.setCellWidget(i, 1, self._make_price_spin(_pv))

    def _move_row(self, delta: int) -> None:
        r = self._table.currentRow()
        target = r + delta
        if r < 0 or target < 0 or target >= self._table.rowCount():
            return
        rows = self._read_rows()
        rows[r], rows[target] = rows[target], rows[r]
        self._repopulate(rows)
        self._table.setCurrentCell(target, 0)

    def _move_up(self) -> None:
        self._move_row(-1)

    def _move_down(self) -> None:
        self._move_row(1)

    def _shop_items_from_ui(self) -> list[dict]:
        """从表格读出 items（与 _apply 同一套提取逻辑，供脏判断与提交共用）。"""
        items: list[dict] = []
        for i in range(self._table.rowCount()):
            iid_w = self._table.cellWidget(i, 0)
            if isinstance(iid_w, IdRefSelector):
                raw_id = iid_w.current_id().strip()
                if not raw_id:
                    continue
                items.append({"itemId": raw_id, "price": self._price_at(i)})
        return items

    def _is_dirty(self) -> bool:
        if self._current_idx < 0 or self._current_idx >= len(self._model.shops):
            return False
        s = self._model.shops[self._current_idx]
        if self._s_id.text().strip() != s.get("id", ""):
            return True
        if self._s_name.text() != s.get("name", ""):
            return True
        if self._shop_items_from_ui() != (s.get("items") or []):
            return True
        return False

    def flush_to_model(self) -> bool:
        """Save All 钩子：未应用编辑在保存前提交，避免静默丢弃。"""
        if self._current_idx >= 0 and self._is_dirty():
            self._apply()
        return True

    def confirm_close(self, parent: QWidget | None = None) -> bool:
        if self._current_idx < 0 or not self._is_dirty():
            return True
        r = QMessageBox.question(
            self, "未应用的修改", "当前商店有未应用的修改。保存到模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            self._apply()
        else:
            # Discard：把表单回滚到模型当前值。否则关闭路径随后的统一 flush 会按
            # UI≠模型判脏，把刚被放弃的编辑重新提交（复核 P1-01）。
            self._on_select(self._current_idx)
        return True

    def _apply(self) -> None:
        if self._current_idx < 0:
            return
        s = self._model.shops[self._current_idx]
        s["id"] = self._s_id.text().strip()
        s["name"] = self._s_name.text()
        s["items"] = self._shop_items_from_ui()
        self._model.mark_dirty("shop")
        row = self._current_idx
        lw = self._list.item(row)
        if lw is not None:
            lw.setText(f"{s.get('id', '?')}  [{s.get('name', '')}]")

    def _add(self) -> None:
        taken = {str(s.get("id", "")) for s in self._model.shops}
        n = 0
        while f"shop_{n}" in taken:
            n += 1
        self._model.shops.append({"id": f"shop_{n}", "name": "", "items": []})
        self._model.mark_dirty("shop")
        self._refresh()

    def _delete(self) -> None:
        if self._current_idx >= 0:
            s = self._model.shops[self._current_idx]
            if not confirm.confirm_delete(self, f"商店「{s.get('id', '')}」及其整张商品表"):
                return
            self._model.shops.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("shop")
            self._refresh()
