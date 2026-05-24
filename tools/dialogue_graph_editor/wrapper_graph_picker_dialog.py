"""Searchable wrapperGraph picker for ownerState nodes."""
from __future__ import annotations

from typing import Any

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QHeaderView,
    QLabel,
    QLineEdit,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
)


class WrapperGraphPickerDialog(QDialog):
    def __init__(
        self,
        wrappers: list[dict[str, Any]],
        *,
        initial_id: str = "",
        title: str = "选择 wrapperGraph",
        parent=None,
    ):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(900, 520)
        self.setModal(True)
        self._wrappers = list(wrappers)
        self._selected = (initial_id or "").strip()

        root = QVBoxLayout(self)
        root.addWidget(QLabel("筛选（graphId / 实体 / 分类 / 编排 / 状态）"))
        self._filter = QLineEdit()
        self._filter.setPlaceholderText("输入以过滤 wrapperGraph…")
        self._filter.textChanged.connect(self._apply_filter)
        root.addWidget(self._filter)

        self._table = QTableWidget(0, 6)
        self._table.setHorizontalHeaderLabels(["graphId", "实体", "分类备注", "编排", "元素", "状态数"])
        self._table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self._table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        self._table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self._table.doubleClicked.connect(self._accept_current)
        header = self._table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(4, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(5, QHeaderView.ResizeMode.ResizeToContents)
        root.addWidget(self._table, 1)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self._accept_current)
        buttons.rejected.connect(self.reject)
        root.addWidget(buttons)

        self._populate("")
        if self._selected:
            self._select_graph_id(self._selected)

    def selected_id(self) -> str:
        return self._selected

    def _wrapper_text(self, wrapper: dict[str, Any]) -> str:
        parts = [
            str(wrapper.get("graphId", "") or ""),
            str(wrapper.get("ownerType", "") or ""),
            str(wrapper.get("ownerId", "") or ""),
            str(wrapper.get("category", "") or ""),
            str(wrapper.get("compositionId", "") or ""),
            str(wrapper.get("compositionLabel", "") or ""),
            str(wrapper.get("elementId", "") or ""),
            str(wrapper.get("elementLabel", "") or ""),
            " ".join(str(x) for x in (wrapper.get("stateIds") or [])),
        ]
        return " ".join(parts).lower()

    def _populate(self, query: str) -> None:
        q = query.strip().lower()
        rows = [w for w in self._wrappers if not q or q in self._wrapper_text(w)]
        rows.sort(key=lambda w: (
            str(w.get("ownerType", "") or "").lower(),
            str(w.get("ownerId", "") or "").lower(),
            str(w.get("category", "") or "").lower(),
            str(w.get("graphId", "") or "").lower(),
        ))
        self._table.setRowCount(0)
        for wrapper in rows:
            row = self._table.rowCount()
            self._table.insertRow(row)
            gid = str(wrapper.get("graphId", "") or "").strip()
            owner = f"{wrapper.get('ownerType', '')}:{wrapper.get('ownerId', '')}"
            comp = str(wrapper.get("compositionLabel", "") or wrapper.get("compositionId", "") or "")
            element = str(wrapper.get("elementLabel", "") or wrapper.get("elementId", "") or "")
            states = wrapper.get("stateIds") or []
            values = [
                gid,
                owner,
                str(wrapper.get("category", "") or ""),
                comp,
                element,
                str(len(states) if isinstance(states, list) else 0),
            ]
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                item.setData(Qt.ItemDataRole.UserRole, gid)
                if col == 0:
                    item.setToolTip("\n".join(str(x) for x in states) if isinstance(states, list) else "")
                self._table.setItem(row, col, item)
        if self._table.rowCount() == 1:
            self._table.selectRow(0)

    def _apply_filter(self, text: str) -> None:
        current = self._selected
        self._populate(text)
        if current:
            self._select_graph_id(current)

    def _select_graph_id(self, graph_id: str) -> None:
        for row in range(self._table.rowCount()):
            item = self._table.item(row, 0)
            if item and item.data(Qt.ItemDataRole.UserRole) == graph_id:
                self._table.selectRow(row)
                self._table.scrollToItem(item)
                return

    def _accept_current(self) -> None:
        row = self._table.currentRow()
        if row < 0:
            self.reject()
            return
        item = self._table.item(row, 0)
        gid = item.data(Qt.ItemDataRole.UserRole) if item is not None else ""
        if isinstance(gid, str) and gid.strip():
            self._selected = gid.strip()
            self.accept()
        else:
            self.reject()
