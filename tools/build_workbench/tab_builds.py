"""「构建」页：构建列表 + 立即构建 + 输出回显。"""
from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QAbstractItemView, QHBoxLayout, QHeaderView, QLabel, QMessageBox, QPushButton,
    QSplitter, QTableWidget, QTableWidgetItem, QVBoxLayout, QWidget,
)

from .archive import delete_path
from .builds import BuildEntry, human_bytes, scan_builds
from .console import BuildConsole


def open_in_explorer(path: Path) -> None:
    """在系统文件管理器里打开。跨平台，失败静默——这只是个便利按钮。"""
    try:
        if sys.platform == "win32":
            os.startfile(str(path))  # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(path)])
        else:
            subprocess.Popen(["xdg-open", str(path)])
    except OSError:
        pass


class BuildsTab(QWidget):
    """构建列表在上、输出在下。构建期间列表不刷新（避免把正在写的目录扫成半截）。"""

    build_requested = Signal()
    archive_requested = Signal()

    _COLS = ("名称", "时间", "档位", "体积", "验收", "文件数")

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._builds_root: Path | None = None
        self._rows: list[BuildEntry] = []

        self.build_btn = QPushButton("立即构建")
        self.build_btn.setToolTip("按当前工作区的内容出一个发行包（不拉代码）")
        self.build_btn.clicked.connect(self.build_requested)

        self.cancel_btn = QPushButton("中止")
        self.cancel_btn.setEnabled(False)

        self.archive_btn = QPushButton("按保留策略整理")
        self.archive_btn.setToolTip("把超出保留份数的旧构建压成 7z 归档")
        self.archive_btn.clicked.connect(self.archive_requested)

        refresh_btn = QPushButton("刷新")
        refresh_btn.clicked.connect(self.refresh)

        self._open_btn = QPushButton("打开目录")
        self._open_btn.clicked.connect(self._open_selected)
        self._run_btn = QPushButton("运行这个包")
        self._run_btn.clicked.connect(self._run_selected)
        self._del_btn = QPushButton("删除")
        self._del_btn.clicked.connect(self._delete_selected)

        top = QHBoxLayout()
        top.addWidget(self.build_btn)
        top.addWidget(self.cancel_btn)
        top.addWidget(self.archive_btn)
        top.addStretch(1)
        top.addWidget(self._open_btn)
        top.addWidget(self._run_btn)
        top.addWidget(self._del_btn)
        top.addWidget(refresh_btn)

        self._table = QTableWidget(0, len(self._COLS))
        self._table.setHorizontalHeaderLabels(self._COLS)
        self._table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self._table.verticalHeader().setVisible(False)
        self._table.horizontalHeader().setSectionResizeMode(
            0, QHeaderView.ResizeMode.Stretch,
        )
        self._table.itemSelectionChanged.connect(self._sync_buttons)

        self._summary = QLabel("")
        self.console = BuildConsole()

        upper = QWidget()
        up_lay = QVBoxLayout(upper)
        up_lay.setContentsMargins(0, 0, 0, 0)
        up_lay.addLayout(top)
        up_lay.addWidget(self._table, 1)
        up_lay.addWidget(self._summary)

        split = QSplitter(Qt.Orientation.Vertical)
        split.addWidget(upper)
        split.addWidget(self.console)
        split.setStretchFactor(0, 3)
        split.setStretchFactor(1, 2)

        lay = QVBoxLayout(self)
        lay.addWidget(split)
        self._sync_buttons()

    # ------------------------------------------------------------ 列表

    def set_builds_root(self, root: Path | None) -> None:
        self._builds_root = root
        self.refresh()

    def refresh(self) -> None:
        self._rows = scan_builds(self._builds_root) if self._builds_root else []
        self._table.setRowCount(len(self._rows))
        total = 0
        for r, b in enumerate(self._rows):
            total += b.disk_bytes
            when = f"{b.built_at:%Y-%m-%d %H:%M}" if b.built_at else "（无时间戳）"
            cells = (
                b.name, when, b.target, human_bytes(b.disk_bytes),
                "已验收" if b.verified else "未验收", str(b.file_count),
            )
            for c, text in enumerate(cells):
                item = QTableWidgetItem(text)
                if c == 4 and not b.verified:
                    item.setForeground(Qt.GlobalColor.darkYellow)
                self._table.setItem(r, c, item)
        self._table.resizeColumnsToContents()
        self._table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        if self._builds_root is None:
            self._summary.setText("还没设「构建根目录」——去「自动构建」页设一个。")
        else:
            self._summary.setText(
                f"{len(self._rows)} 份未压缩构建，共 {human_bytes(total)}　·　{self._builds_root}"
            )
        self._sync_buttons()

    def selected(self) -> BuildEntry | None:
        rows = self._table.selectionModel().selectedRows() if self._table.selectionModel() else []
        if not rows:
            return None
        idx = rows[0].row()
        return self._rows[idx] if 0 <= idx < len(self._rows) else None

    def set_running(self, running: bool) -> None:
        self.build_btn.setEnabled(not running)
        self.cancel_btn.setEnabled(running)
        self.archive_btn.setEnabled(not running)
        self.build_btn.setText("构建中…" if running else "立即构建")

    # ------------------------------------------------------------ 操作

    def _sync_buttons(self) -> None:
        has = self.selected() is not None
        for b in (self._open_btn, self._run_btn, self._del_btn):
            b.setEnabled(has)

    def _open_selected(self) -> None:
        b = self.selected()
        if b:
            open_in_explorer(b.path)

    def _run_selected(self) -> None:
        b = self.selected()
        if not b:
            return
        if not b.runnable_exe.is_file():
            QMessageBox.warning(self, "跑不了", f"这个包里没有 gamedraft.exe：\n{b.path}")
            return
        try:
            subprocess.Popen([str(b.runnable_exe)], cwd=str(b.path))
        except OSError as e:
            QMessageBox.critical(self, "起不来", str(e))

    def _delete_selected(self) -> None:
        b = self.selected()
        if not b:
            return
        # 删的是一份留档，不可撤销——问一次
        if QMessageBox.question(
            self, "删除这份构建？",
            f"{b.name}\n{human_bytes(b.disk_bytes)}\n\n"
            "整个目录会被删掉（含里面玩出来的存档），不可撤销。",
        ) != QMessageBox.StandardButton.Yes:
            return
        ok, msg = delete_path(b.path)
        self.console.append(("✓ " if ok else "✖ ") + msg)
        self.refresh()
