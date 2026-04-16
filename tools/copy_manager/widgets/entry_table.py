"""Qt table model for TextEntry list."""
from __future__ import annotations

from PySide6.QtCore import QAbstractTableModel, QModelIndex, Qt

from tools.copy_manager.scanner.base import TextEntry


# Column definitions: (header, width)
COLUMNS = [
    ("原文", 300),
    ("文件", 180),
    ("字段", 160),
    ("分类", 80),
    ("状态", 80),
    ("备注", 150),
]


class EntryTableModel(QAbstractTableModel):
    """QAbstractTableModel backed by a list of TextEntry dicts."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._entries: list[dict] = []

    def set_entries(self, entries: list[dict]) -> None:
        self.beginResetModel()
        self._entries = entries
        self.endResetModel()

    def get_entry(self, row: int) -> dict | None:
        if 0 <= row < len(self._entries):
            return self._entries[row]
        return None

    def get_uid(self, row: int) -> str | None:
        e = self.get_entry(row)
        return e["uid"] if e else None

    def get_all_entries(self) -> list[dict]:
        return list(self._entries)

    def rowCount(self, parent: QModelIndex = QModelIndex()) -> int:
        return len(self._entries)

    def columnCount(self, parent: QModelIndex = QModelIndex()) -> int:
        return len(COLUMNS)

    def headerData(self, section, orientation, role=Qt.DisplayRole):
        if orientation == Qt.Horizontal and role == Qt.DisplayRole:
            return COLUMNS[section][0]
        return super().headerData(section, orientation, role)

    def data(self, index: QModelIndex, role=Qt.DisplayRole):
        if not index.isValid():
            return None
        row = index.row()
        col = index.column()
        entry = self._entries[row]

        if role == Qt.DisplayRole:
            return self._cell_text(entry, col)
        elif role == Qt.ToolTipRole:
            return self._cell_tooltip(entry, col)
        elif role == Qt.TextAlignmentRole:
            if col == 3:  # Category
                return Qt.AlignCenter
            if col == 4:  # Status
                return Qt.AlignCenter
        return None

    def _cell_text(self, entry: dict, col: int) -> str:
        if col == 0:  # Source text (truncated)
            text = entry.get("source_text", "")
            if len(text) > 80:
                return text[:77] + "..."
            return text
        elif col == 1:  # File path (basename)
            path = entry.get("file_path", "")
            parts = path.split("/")
            return parts[-1] if parts else path
        elif col == 2:  # Field path
            return entry.get("field_path", "")
        elif col == 3:  # Category
            cat = entry.get("category", "")
            from tools.copy_manager.constants import CATEGORY_LABELS
            return CATEGORY_LABELS.get(cat, cat)
        elif col == 4:  # Status
            return entry.get("status", "pending")
        elif col == 5:  # Notes (truncated)
            notes = entry.get("context_notes", "")
            if len(notes) > 50:
                return notes[:47] + "..."
            return notes
        return ""

    def _cell_tooltip(self, entry: dict, col: int) -> str:
        if col == 0:
            return entry.get("source_text", "")
        elif col == 1:
            return entry.get("file_path", "")
        elif col == 2:
            return entry.get("field_path", "")
        elif col == 5:
            return entry.get("context_notes", "")
        return ""

    def update_entry_field(self, row: int, field: str, value: str) -> None:
        """Update a field in an entry and emit dataChanged."""
        if 0 <= row < len(self._entries):
            self._entries[row][field] = value
            idx = self.index(row, 0)
            self.dataChanged.emit(idx, idx, [Qt.DisplayRole, Qt.ToolTipRole])
