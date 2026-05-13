"""可搜索的 NPC id 选择对话框（避免下拉过长列表）。"""
from __future__ import annotations

from PySide6.QtWidgets import (
    QDialog,
    QVBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QDialogButtonBox,
)
from PySide6.QtCore import Qt


class NpcPickerDialog(QDialog):
    """entries: (npc_id, 说明/显示名)；支持筛选 id 与说明。"""

    def __init__(
        self,
        entries: list[tuple[str, str]],
        *,
        title: str = "选择 NPC",
        initial_id: str = "",
        parent=None,
    ):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(520, 440)
        self.setModal(True)
        self._entries = list(entries)
        self._selected = (initial_id or "").strip()

        root = QVBoxLayout(self)
        root.addWidget(QLabel("筛选（npc id或显示名）"))
        self._filter = QLineEdit()
        self._filter.setPlaceholderText("输入以过滤…")
        self._filter.textChanged.connect(self._apply_filter)
        root.addWidget(self._filter)

        self._list = QListWidget()
        self._list.itemDoubleClicked.connect(self._accept_current)
        root.addWidget(self._list, 1)

        bb = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        bb.accepted.connect(self._accept_current)
        bb.rejected.connect(self.reject)
        root.addWidget(bb)

        self._populate_list("")
        if self._selected:
            for i in range(self._list.count()):
                it = self._list.item(i)
                if it and it.data(Qt.ItemDataRole.UserRole) == self._selected:
                    self._list.setCurrentRow(i)
                    break

    def selected_id(self) -> str:
        return self._selected

    @staticmethod
    def _row_label(nid: str, desc: str) -> str:
        d = (desc or "").strip()
        return f"{nid}  [{d}]" if d else nid

    def _populate_list(self, filt: str) -> None:
        self._list.clear()
        q = filt.strip().lower()
        for nid, desc in self._entries:
            if q and q not in nid.lower() and q not in desc.lower():
                continue
            item = QListWidgetItem(self._row_label(nid, desc))
            item.setData(Qt.ItemDataRole.UserRole, nid)
            self._list.addItem(item)

    def _apply_filter(self, text: str) -> None:
        self._populate_list(text)
        if self._list.count() == 1:
            self._list.setCurrentRow(0)

    def _accept_current(self) -> None:
        it = self._list.currentItem()
        if it is None:
            self.reject()
            return
        nid = it.data(Qt.ItemDataRole.UserRole)
        if isinstance(nid, str) and nid:
            self._selected = nid
            self.accept()
        else:
            self.reject()
