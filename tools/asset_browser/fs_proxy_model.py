"""项目资源树/列表的过滤：隐藏工具目录，并在当前「列表根」下做名称筛选。"""
from __future__ import annotations

from PySide6.QtCore import QSortFilterProxyModel, QModelIndex
from PySide6.QtWidgets import QFileSystemModel


class ProjectFileFilterModel(QSortFilterProxyModel):
    """隐藏工程噪音目录；名称筛选仅作用于「当前浏览文件夹」的直接子项。"""

    _DIR_BLOCKLIST = frozenset(
        {
            ".git",
            "node_modules",
            "__pycache__",
            ".vite",
            ".cursor",
            "dist",
            "build",
            "coverage",
        }
    )

    def __init__(self) -> None:
        super().__init__()
        self._name_filter = ""  # 子串即可，不区分大小写
        self._list_parent: QModelIndex = QModelIndex()  # source: 正在列表中浏览的目录

    def set_list_parent(self, list_parent: QModelIndex) -> None:
        self._list_parent = list_parent
        self.invalidateFilter()

    def set_name_filter(self, text: str) -> None:
        self._name_filter = (text or "").strip().casefold()
        self.invalidateFilter()

    def filterAcceptsRow(self, source_row: int, source_parent: QModelIndex) -> bool:  # noqa: N802
        sm = self.sourceModel()
        if not isinstance(sm, QFileSystemModel):
            return True
        idx = sm.index(source_row, 0, source_parent)
        if not idx.isValid():
            return True
        name = sm.fileName(idx)
        if sm.isDir(idx) and name in self._DIR_BLOCKLIST:
            return False
        if not self._name_filter:
            return True
        if not self._list_parent.isValid():
            return True
        if source_parent == self._list_parent:
            return self._name_filter in name.casefold()
        return True
