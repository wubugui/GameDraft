"""Qt tree model for grouped TextEntry list — 3 levels: Category → Group → Entry."""
from __future__ import annotations

from PySide6.QtCore import QAbstractItemModel, QModelIndex, Qt
from PySide6.QtGui import QFont

from tools.copy_manager.constants import CATEGORY_LABELS


class TreeItem:
    """Base node in the tree."""

    def __init__(self, parent=None):
        self._parent = parent
        self._children: list[TreeItem] = []

    def parent(self) -> "TreeItem | None":
        return self._parent

    def child(self, row: int) -> "TreeItem":
        return self._children[row]

    def children(self) -> list["TreeItem"]:
        return list(self._children)

    def child_count(self) -> int:
        return len(self._children)

    def child_index(self, item: "TreeItem") -> int:
        return self._children.index(item)

    def add_child(self, item: "TreeItem") -> None:
        item._parent = self
        self._children.append(item)

    def row(self) -> int:
        if self._parent:
            return self._parent.child_index(self)
        return 0

    @property
    def column_count(self) -> int:
        return 5

    def data(self, col: int, role: Qt.ItemDataRole) -> str | int | None:
        raise NotImplementedError


class CategoryItem(TreeItem):
    """Top-level category node (e.g. "Quest", "Dialogue", "Archive")."""

    def __init__(self, category: str, label: str, parent=None):
        super().__init__(parent)
        self.category = category
        self.label = label
        self._entry_count = 0

    def data(self, col: int, role: Qt.ItemDataRole) -> str | int | None:
        if role == Qt.DisplayRole:
            if col == 0:
                count = self._count_entries()
                return f"{self.label} ({count})"
            elif col == 1:
                return f"{self._count_entries()} 条"
        elif role == Qt.FontRole:
            font = QFont()
            font.setBold(True)
            font.setPointSize(11)
            return font
        return None

    def _count_entries(self) -> int:
        total = 0
        for child in self._children:
            if isinstance(child, GroupItem):
                total += child.child_count()
        return total


class GroupItem(TreeItem):
    """Mid-level group node (e.g. "opening_01", "first_visit", "wang_grandpa")."""

    def __init__(self, group_id: str, group_label: str, parent=None):
        super().__init__(parent)
        self.group_id = group_id
        self.group_label = group_label

    def add_entry(self, entry: dict) -> "EntryItem":
        item = EntryItem(entry, self)
        self.add_child(item)
        return item

    def data(self, col: int, role: Qt.ItemDataRole) -> str | int | None:
        if role == Qt.DisplayRole:
            if col == 0:
                label = self.group_label or self.group_id
                count = self.child_count()
                return f"{label} ({count})"
            elif col == 1:
                return f"{self.child_count()} 条"
        elif role == Qt.FontRole:
            font = QFont()
            font.setBold(True)
            return font
        return None


class EntryItem(TreeItem):
    """Leaf node representing a single text entry."""

    def __init__(self, entry: dict, parent=None):
        super().__init__(parent)
        self._entry = entry

    def data(self, col: int, role: Qt.ItemDataRole) -> str | int | None:
        if role == Qt.DisplayRole:
            return self._cell_text(col)
        elif role == Qt.ToolTipRole:
            return self._cell_tooltip(col)
        elif role == Qt.TextAlignmentRole:
            if col == 2:  # Category
                return Qt.AlignCenter
            if col == 3:  # Status
                return Qt.AlignCenter
        return None

    def _cell_text(self, col: int) -> str:
        if col == 0:  # Source text (truncated)
            text = self._entry.get("source_text", "")
            if len(text) > 80:
                return text[:77] + "..."
            return text
        elif col == 1:  # Field label
            return self._entry.get("field_label", "") or self._entry.get("field_path", "")
        elif col == 2:  # Category
            cat = self._entry.get("category", "")
            return CATEGORY_LABELS.get(cat, cat)
        elif col == 3:  # Status
            return self._entry.get("status", "pending")
        elif col == 4:  # Notes (truncated)
            notes = self._entry.get("context_notes", "")
            if len(notes) > 50:
                return notes[:47] + "..."
            return notes
        return ""

    def _cell_tooltip(self, col: int) -> str:
        if col == 0:
            return self._entry.get("source_text", "")
        elif col == 1:
            return self._entry.get("field_path", "")
        elif col == 4:
            return self._entry.get("context_notes", "")
        return ""


# Top-level category order
_CATEGORY_ORDER = [
    "quest", "rule", "item", "encounter", "scenario", "shop", "map",
    "archive", "dialogue", "cutscene", "ui",
]


class EntryTreeModel(QAbstractItemModel):
    """QAbstractItemModel for QTreeView: Category → Group → Entry."""

    COLUMNS = ["原文", "字段", "分类", "状态", "备注"]

    def __init__(self, parent=None):
        super().__init__(parent)
        self._root = TreeItem()
        self._flat_entries: list[dict] = []

    def set_entries(self, entries: list[dict]) -> None:
        self.beginResetModel()
        self._root = TreeItem()
        self._flat_entries = entries
        self._build_tree(entries)
        self.endResetModel()

    def _build_tree(self, entries: list[dict]) -> None:
        # First group by (category, group_id)
        cats: dict[str, tuple[str, dict[str, tuple[str, list[dict]]]]] = {}
        cat_order: list[str] = []

        for entry in entries:
            category = entry.get("category", "ui")
            cat_label = CATEGORY_LABELS.get(category, category)
            gid = entry.get("group_id", "")
            glabel = entry.get("group_label", "")

            # Fallback for old entries missing group_id
            if not gid:
                gid, glabel = self._derive_group_info(entry)

            if category not in cats:
                cats[category] = (cat_label, {})
                cat_order.append(category)

            groups = cats[category][1]
            if gid not in groups:
                groups[gid] = (glabel, [])
            groups[gid][1].append(entry)

        # Build tree: sort categories by predefined order, then by label
        sorted_cats = sorted(
            cat_order,
            key=lambda c: _CATEGORY_ORDER.index(c) if c in _CATEGORY_ORDER else 999,
        )

        for category in sorted_cats:
            cat_label, groups = cats[category]
            cat_item = CategoryItem(category, cat_label, self._root)
            self._root.add_child(cat_item)

            for gid in groups:
                glabel, items = groups[gid]
                group_item = GroupItem(gid, glabel, cat_item)
                cat_item.add_child(group_item)
                for entry in items:
                    group_item.add_entry(entry)

    @staticmethod
    def _derive_group_info(entry: dict) -> tuple[str, str]:
        """Derive group_id and group_label from uid for old entries without group fields."""
        import re

        uid = entry.get("uid", "")
        parts = uid.split(":", 2)
        if len(parts) < 3:
            ft = entry.get("file_type", "ungrouped")
            return ft, ft

        ft_prefix = parts[0]
        uid_fp = parts[2]

        first_id = None
        m = re.search(r"\[([^\]]+)\]", uid_fp)
        if m:
            first_id = m.group(1)

        if ft_prefix.startswith("json_"):
            cat = ft_prefix.replace("json_", "")
            if first_id:
                if uid_fp.startswith("archive.characters"):
                    return f"archive[{first_id}]", first_id
                return f"{cat}[{first_id}]", first_id
        elif ft_prefix.startswith("ink_"):
            if uid_fp.startswith("knot:"):
                knot_name = uid_fp.split(",")[0].split(":", 1)[1].strip() if ":" in uid_fp else "root"
                return f"ink:{knot_name}", knot_name
        elif ft_prefix.startswith("cutscenes"):
            if uid_fp.startswith("cutscenes["):
                m2 = re.match(r"^cutscenes\[([^\]]+)\]", uid_fp)
                if m2:
                    return f"cutscenes[{m2.group(1)}]", m2.group(1)

        if uid_fp.startswith("strings."):
            cat_parts = uid_fp.split(".")
            if len(cat_parts) >= 2:
                cat = cat_parts[1]
                return f"strings.{cat}", cat

        gid = ft_prefix.replace("json_", "").replace("ink_", "").replace("cutscenes_", "")
        return gid or "ungrouped", gid or "ungrouped"

    def index(self, row: int, col: int, parent: QModelIndex = QModelIndex()) -> QModelIndex:
        if not self.hasIndex(row, col, parent):
            return QModelIndex()
        parent_item = parent.internalPointer() if parent.isValid() else self._root
        child = parent_item.child(row)
        if child:
            return self.createIndex(row, col, child)
        return QModelIndex()

    def parent(self, index: QModelIndex) -> QModelIndex:
        if not index.isValid():
            return QModelIndex()
        child_item = index.internalPointer()
        parent_item = child_item.parent()
        if parent_item is None or parent_item is self._root:
            return QModelIndex()
        return self.createIndex(parent_item.row(), 0, parent_item)

    def rowCount(self, parent: QModelIndex = QModelIndex()) -> int:
        if parent.column() > 0:
            return 0
        parent_item = parent.internalPointer() if parent.isValid() else self._root
        return parent_item.child_count()

    def columnCount(self, parent: QModelIndex = QModelIndex()) -> int:
        return self._root.column_count

    def headerData(self, section, orientation, role=Qt.DisplayRole):
        if orientation == Qt.Horizontal and role == Qt.DisplayRole:
            return self.COLUMNS[section]
        return super().headerData(section, orientation, role)

    def data(self, index: QModelIndex, role=Qt.ItemDataRole):
        if not index.isValid():
            return None
        item = index.internalPointer()
        return item.data(index.column(), role)

    # --- Convenience methods ---

    def get_entry(self, index: QModelIndex) -> dict | None:
        """Get the entry dict for a model index.
        For EntryItem → returns the entry.
        For GroupItem → returns first child entry.
        For CategoryItem → returns first entry from first group.
        """
        if not index.isValid():
            return None
        item = index.internalPointer()
        if isinstance(item, EntryItem):
            return item._entry
        if isinstance(item, GroupItem):
            for child in item.children():
                if isinstance(child, EntryItem):
                    return child._entry
        if isinstance(item, CategoryItem):
            for group in item.children():
                if isinstance(group, GroupItem):
                    for child in group.children():
                        if isinstance(child, EntryItem):
                            return child._entry
        return None

    def get_flat_index(self, index: QModelIndex) -> int:
        """Get the flat list index for an EntryItem. Returns -1 if not found."""
        entry = self.get_entry(index)
        if entry:
            uid = entry.get("uid")
            for i, e in enumerate(self._flat_entries):
                if e.get("uid") == uid:
                    return i
        return -1

    def update_entry_field(self, index: QModelIndex, field: str, value: str) -> None:
        """Update a field in the entry and emit dataChanged."""
        if not index.isValid():
            return
        item = index.internalPointer()
        if isinstance(item, EntryItem):
            item._entry[field] = value
            left = self.index(item.row(), 0, self.parent(index))
            right = self.index(item.row(), self.column_count - 1, self.parent(index))
            self.dataChanged.emit(left, right, [Qt.DisplayRole, Qt.ToolTipRole])

    def get_all_entries(self) -> list[dict]:
        return list(self._flat_entries)

    def get_selected_entry(self, selected_indexes: list) -> dict | None:
        """Get the entry dict from selected indexes."""
        for idx in selected_indexes:
            if idx.column() == 0:
                item = idx.internalPointer()
                if isinstance(item, EntryItem):
                    return item._entry
                elif isinstance(item, GroupItem):
                    if item.children():
                        first = item.children()[0]
                        if isinstance(first, EntryItem):
                            return first._entry
        return None
