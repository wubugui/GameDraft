"""「归档」页：看归档、还原、删除，以及实测压缩率。"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QAbstractItemView, QHBoxLayout, QHeaderView, QLabel, QMessageBox, QPushButton,
    QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

from .archive import delete_path
from .builds import ArchiveEntry, human_bytes, scan_archives
from .tab_builds import open_in_explorer


class ArchiveTab(QWidget):
    """归档列表。还原走后台（解 550 MB 要几十秒），由主窗口接管。"""

    restore_requested = Signal(object)  # ArchiveEntry

    _COLS = ("名称", "时间", "档位", "归档体积", "原始体积", "压缩率", "验收")

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._root: Path | None = None
        self._rows: list[ArchiveEntry] = []

        refresh_btn = QPushButton("刷新")
        refresh_btn.clicked.connect(self.refresh)
        self._open_btn = QPushButton("打开所在目录")
        self._open_btn.clicked.connect(self._open_selected)
        self._restore_btn = QPushButton("还原成可跑的包")
        self._restore_btn.clicked.connect(self._restore_selected)
        self._del_btn = QPushButton("删除")
        self._del_btn.clicked.connect(self._delete_selected)

        top = QHBoxLayout()
        top.addWidget(self._restore_btn)
        top.addStretch(1)
        top.addWidget(self._open_btn)
        top.addWidget(self._del_btn)
        top.addWidget(refresh_btn)

        self._table = QTableWidget(0, len(self._COLS))
        self._table.setHorizontalHeaderLabels(self._COLS)
        self._table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self._table.verticalHeader().setVisible(False)
        self._table.itemSelectionChanged.connect(self._sync_buttons)

        self._summary = QLabel("")
        self._note = QLabel(
            "这个包 97% 是 PNG/MP3/OGG（已经是压缩格式），所以 7z 主要买到的是"
            "「一次构建一个文件」的管理便利，不是省空间。真要控占用，调「归档保留份数」。"
        )
        self._note.setWordWrap(True)
        self._note.setStyleSheet("color:#9a948a;")

        lay = QVBoxLayout(self)
        lay.addLayout(top)
        lay.addWidget(self._table, 1)
        lay.addWidget(self._summary)
        lay.addWidget(self._note)
        self._sync_buttons()

    def set_archive_root(self, root: Path | None) -> None:
        self._root = root
        self.refresh()

    def refresh(self) -> None:
        self._rows = scan_archives(self._root) if self._root else []
        self._table.setRowCount(len(self._rows))
        total = 0
        for r, a in enumerate(self._rows):
            total += a.archive_bytes
            when = f"{a.built_at:%Y-%m-%d %H:%M}" if a.built_at else "（无时间戳）"
            ratio = f"{a.ratio * 100:.0f}%" if a.ratio is not None else "—"
            cells = (
                a.name, when, a.target, human_bytes(a.archive_bytes),
                human_bytes(a.original_bytes) if a.original_bytes else "—",
                ratio, "已验收" if a.verified else "未验收",
            )
            for c, text in enumerate(cells):
                item = QTableWidgetItem(text)
                if c == 6 and not a.verified:
                    item.setForeground(Qt.GlobalColor.darkYellow)
                self._table.setItem(r, c, item)
        self._table.resizeColumnsToContents()
        self._table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        if self._root is None:
            self._summary.setText("还没设归档目录。")
        else:
            self._summary.setText(
                f"{len(self._rows)} 份归档，共 {human_bytes(total)}　·　{self._root}"
            )
        self._sync_buttons()

    def selected(self) -> ArchiveEntry | None:
        rows = self._table.selectionModel().selectedRows() if self._table.selectionModel() else []
        if not rows:
            return None
        idx = rows[0].row()
        return self._rows[idx] if 0 <= idx < len(self._rows) else None

    # ------------------------------------------------------------ 操作

    def _sync_buttons(self) -> None:
        has = self.selected() is not None
        for b in (self._open_btn, self._restore_btn, self._del_btn):
            b.setEnabled(has)

    def _open_selected(self) -> None:
        a = self.selected()
        if a:
            open_in_explorer(a.path.parent)

    def _restore_selected(self) -> None:
        a = self.selected()
        if a:
            self.restore_requested.emit(a)

    def _delete_selected(self) -> None:
        a = self.selected()
        if not a:
            return
        # 归档是留档的最后一份——删了就真没了
        if QMessageBox.question(
            self, "删除这份归档？",
            f"{a.name}\n{human_bytes(a.archive_bytes)}\n\n"
            "这是这次构建的最后一份留档，删掉不可撤销。",
        ) != QMessageBox.StandardButton.Yes:
            return
        ok, msg = delete_path(a.path)
        if not ok:
            QMessageBox.critical(self, "删不掉", msg)
        self.refresh()
