"""Generic ID-reference dropdown with search filtering."""
from __future__ import annotations

from PySide6.QtWidgets import QComboBox, QWidget
from PySide6.QtCore import Signal


class IdRefSelector(QComboBox):
    """A searchable combo-box that shows id + display-name pairs."""
    value_changed = Signal(str)

    def __init__(self, parent: QWidget | None = None, allow_empty: bool = True):
        super().__init__(parent)
        self.setEditable(True)
        self.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        self._allow_empty = allow_empty
        self._ids: list[str] = []
        self.currentIndexChanged.connect(self._on_index)

    def set_items(self, items: list[tuple[str, str]] | list[str]) -> None:
        """Populate with (id, display_name) pairs or plain id strings."""
        current = self.current_id()
        self.blockSignals(True)
        self.clear()
        self._ids.clear()
        if self._allow_empty:
            self.addItem("(none)")
            self._ids.append("")
        for it in items:
            if isinstance(it, tuple):
                rid, name = it
                self.addItem(f"{rid}  [{name}]")
            else:
                rid = it
                self.addItem(rid)
            self._ids.append(rid)
        self.blockSignals(False)
        self.set_current(current)

    def set_current(self, item_id: str) -> None:
        if item_id in self._ids:
            self.setCurrentIndex(self._ids.index(item_id))
        elif self._allow_empty:
            self.setCurrentIndex(0)

    def current_id(self) -> str:
        idx = self.currentIndex()
        if 0 <= idx < len(self._ids):
            return self._ids[idx]
        return ""

    def _on_index(self, _idx: int) -> None:
        self.value_changed.emit(self.current_id())
