"""Search and filter bar widget."""
from __future__ import annotations

from PySide6.QtCore import QSortFilterProxyModel, Qt, QTimer, Signal
from PySide6.QtWidgets import QComboBox, QHBoxLayout, QLineEdit, QWidget

from tools.copy_manager.constants import CATEGORY_LABELS, STATUSES


class SearchFilterBar(QWidget):
    """Search input + category/status filter dropdowns."""

    text_changed = Signal(str)
    category_changed = Signal(str)
    status_changed = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(4, 4, 4, 4)
        layout.setSpacing(8)

        # Search input
        self.search_input = QLineEdit()
        self.search_input.setPlaceholderText("搜索原文、文件、字段、标签、备注...")
        self.search_input.textChanged.connect(self._on_search)
        layout.addWidget(self.search_input, stretch=3)

        # Category filter
        self.category_combo = QComboBox()
        self.category_combo.addItem("全部", "all")
        for key, label in sorted(CATEGORY_LABELS.items()):
            self.category_combo.addItem(label, key)
        self.category_combo.currentIndexChanged.connect(self._on_category)
        layout.addWidget(self.category_combo, stretch=1)

        # Status filter
        self.status_combo = QComboBox()
        self.status_combo.addItem("全部状态", "all")
        for s in STATUSES:
            self.status_combo.addItem(s, s)
        self.status_combo.currentIndexChanged.connect(self._on_status)
        layout.addWidget(self.status_combo, stretch=1)

        self._search_timer = QTimer()
        self._search_timer.setSingleShot(True)
        self._search_timer.setInterval(200)
        self._search_timer.timeout.connect(lambda: self.text_changed.emit(self.search_input.text()))

    def _on_search(self) -> None:
        self._search_timer.start()

    def _on_category(self) -> None:
        cat = self.category_combo.currentData()
        self.category_changed.emit(cat)

    def _on_status(self) -> None:
        status = self.status_combo.currentData()
        self.status_changed.emit(status)


class EntryFilterProxyModel(QSortFilterProxyModel):
    """Multi-field proxy filter for the entry table."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._filter_text = ""
        self._filter_category = "all"
        self._filter_status = "all"

    def set_filter_text(self, text: str) -> None:
        self._filter_text = text.lower()
        self.invalidateFilter()

    def set_filter_category(self, category: str) -> None:
        self._filter_category = category
        self.invalidateFilter()

    def set_filter_status(self, status: str) -> None:
        self._filter_status = status
        self.invalidateFilter()

    def filterAcceptsRow(self, source_row, source_parent):
        model = self.sourceModel()
        entry = model.get_entry(source_row)
        if not entry:
            return False

        # Status filter
        if self._filter_status != "all":
            if entry.get("status") != self._filter_status:
                return False

        # Category filter
        if self._filter_category != "all":
            if entry.get("category") != self._filter_category:
                return False

        # Text filter: search across source_text, file_path, field_path, tags, context_notes
        if self._filter_text:
            searchable = " ".join([
                entry.get("source_text", ""),
                entry.get("file_path", ""),
                entry.get("field_path", ""),
                " ".join(entry.get("tags", [])),
                entry.get("context_notes", ""),
            ]).lower()
            if self._filter_text not in searchable:
                return False

        return True
