"""批量重命名：预览后执行。"""

from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QLineEdit,
    QPushButton,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from .file_ops import apply_batch_rename, plan_batch_rename, BatchRenameItem


class BatchRenameDialog(QDialog):
    def __init__(self, paths: list[str], parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._paths = list(paths)
        self.setWindowTitle("批量重命名")
        self.resize(700, 480)
        self._mode = QComboBox()
        self._mode.addItems(
            [
                "序号: 原名_0001（扩展名）",
                "查找替换: 在文件名中",
                "前缀",
                "后缀",
            ]
        )
        self._start = QSpinBox()
        self._start.setRange(1, 999999)
        self._start.setValue(1)
        self._find = QLineEdit()
        self._replace = QLineEdit()
        self._prefix = QLineEdit()
        self._suffix = QLineEdit()
        self._table = QTableWidget(0, 3)
        self._table.setHorizontalHeaderLabels(["原路径", "新文件名", "状态"])
        self._table.setAlternatingRowColors(True)
        self._preview_btn = QPushButton("预览")
        self._preview_btn.clicked.connect(self._do_preview)
        self._items: list[BatchRenameItem] = []
        b = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        b.accepted.connect(self._on_ok)
        b.rejected.connect(self.reject)
        f = QFormLayout()
        f.addRow("方式", self._mode)
        f.addRow("序号起始(仅序号)", self._start)
        f.addRow("查找", self._find)
        f.addRow("替换为", self._replace)
        f.addRow("前缀(仅前缀)", self._prefix)
        f.addRow("后缀(仅后缀,不含扩展名)", self._suffix)
        lay = QVBoxLayout(self)
        lay.addLayout(f)
        h = QHBoxLayout()
        h.addWidget(self._preview_btn)
        h.addStretch(1)
        lay.addLayout(h)
        lay.addWidget(self._table, 1)
        lay.addWidget(b)
        self._mode.currentIndexChanged.connect(self._toggle_fields)
        self._toggle_fields()

    def _toggle_fields(self) -> None:
        m = self._mode.currentIndex()
        self._start.setEnabled(m == 0)
        self._find.setEnabled(m == 1)
        self._replace.setEnabled(m == 1)
        self._prefix.setEnabled(m == 2)
        self._suffix.setEnabled(m == 3)

    def _map_mode(self) -> str:
        i = self._mode.currentIndex()
        return ["sequential", "replace", "prefix", "suffix"][i]

    def _do_preview(self) -> None:
        mode = self._map_mode()
        self._items = plan_batch_rename(
            self._paths,
            mode,  # type: ignore[arg-type]
            start_index=self._start.value(),
            find_text=self._find.text(),
            repl_text=self._replace.text(),
            prefix=self._prefix.text(),
            suffix=self._suffix.text(),
        )
        self._table.setRowCount(0)
        for it in self._items:
            r = self._table.rowCount()
            self._table.insertRow(r)
            self._table.setItem(r, 0, QTableWidgetItem(it.old_path))
            self._table.setItem(r, 1, QTableWidgetItem(it.new_name))
            st = "OK" if not it.is_invalid else (it.error or "无效")
            ti = QTableWidgetItem(st)
            if it.is_invalid:
                ti.setForeground(Qt.GlobalColor.red)
            self._table.setItem(r, 2, ti)
        self._table.resizeColumnsToContents()

    def _on_ok(self) -> None:
        if not self._items:
            self._do_preview()
        if not self._items:
            self.accept()
            return
        if any(x.is_invalid for x in self._items):
            from PySide6.QtWidgets import QMessageBox

            r = QMessageBox.question(
                self,
                "确认",
                "存在无效或重名行，将仅重命名有效行。继续？",
            )
            if r != QMessageBox.StandardButton.Yes:
                return
        self._result = apply_batch_rename(self._items)
        self.accept()

    @property
    def result(self):
        return getattr(self, "_result", None)
