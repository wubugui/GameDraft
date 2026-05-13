"""可搜索的节点 id 选择对话框（替换 QInputDialog.getItem）。"""
from __future__ import annotations

from PySide6.QtWidgets import (
    QDialog,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QDialogButtonBox,
)
from PySide6.QtCore import Qt


class NodePickerDialog(QDialog):
    def __init__(
        self,
        node_ids: list[str],
        *,
        type_by_id: dict[str, str] | None = None,
        title: str = "选择节点",
        initial: str = "",
        parent=None,
    ):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(480, 420)
        self.setModal(True)
        self._ids_sorted = sorted(node_ids, key=lambda x: (x.lower(), x))
        self._type_by_id = type_by_id or {}
        self._selected = (initial or "").strip()

        root = QVBoxLayout(self)
        root.addWidget(QLabel("筛选（id或类型）"))
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

    def _label_for(self, nid: str) -> str:
        t = self._type_by_id.get(nid, "")
        return f"{nid}  ({t})" if t else nid

    def _populate_list(self, filt: str) -> None:
        self._list.clear()
        q = filt.strip().lower()
        for nid in self._ids_sorted:
            label = self._label_for(nid)
            if q and q not in nid.lower() and q not in label.lower():
                continue
            item = QListWidgetItem(label)
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
