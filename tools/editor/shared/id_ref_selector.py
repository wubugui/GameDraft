"""Generic ID-reference dropdown with search filtering."""
from __future__ import annotations

from PySide6.QtWidgets import QComboBox, QWidget
from PySide6.QtCore import Signal, QEvent, QTimer


class IdRefSelector(QComboBox):
    """A searchable combo-box that shows id + display-name pairs."""
    value_changed = Signal(str)

    def __init__(
        self,
        parent: QWidget | None = None,
        allow_empty: bool = True,
        click_opens_popup: bool = False,
        editable: bool = True,
    ):
        super().__init__(parent)
        self.setEditable(editable)
        self.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        self._allow_empty = allow_empty
        self._click_opens_popup = click_opens_popup and editable
        self._ids: list[str] = []
        self.currentIndexChanged.connect(self._on_index)
        if self._click_opens_popup:
            le = self.lineEdit()
            if le is not None:
                le.installEventFilter(self)

    def set_items(self, items: list[tuple[str, str]] | list[str]) -> None:
        """Populate with (id, display_name) pairs or plain id strings."""
        from ..editor_perf import PerfClock, maybe_stamp, perf_log_enabled

        _clk = PerfClock(label="IdRefSelector.set_items") if perf_log_enabled() else None
        normalized: tuple[tuple[str, str], ...] = ()
        pairs: list[tuple[str, str]] = []
        for it in items:
            if isinstance(it, tuple):
                rid = str(it[0])
                nm = str(it[1]) if len(it) > 1 else rid
                pairs.append((rid, nm))
            else:
                s = str(it)
                pairs.append((s, s))
        normalized = tuple(pairs)
        cached = getattr(self, "_items_normalized_cache", None)
        cur_id = self.current_id()
        if cached == normalized and self.count() == (
            len(normalized) + (1 if self._allow_empty else 0)
        ):
            self.blockSignals(True)
            try:
                self.set_current(cur_id)
            finally:
                self.blockSignals(False)
            maybe_stamp(_clk, f"skipped n={len(normalized)}")
            return

        self._items_normalized_cache = normalized
        self.blockSignals(True)
        self.clear()
        self._ids.clear()
        if self._allow_empty:
            self.addItem("(none)")
            self._ids.append("")
        for rid, name in normalized:
            self.addItem(f"{rid}  [{name}]")
            self._ids.append(rid)
        self.blockSignals(False)
        self.set_current(cur_id)
        maybe_stamp(_clk, f"rebuilt n={len(normalized)}")

    def set_current(self, item_id: str) -> None:
        if item_id in self._ids:
            self.setCurrentIndex(self._ids.index(item_id))
        elif self._allow_empty:
            self.setCurrentIndex(0)

    def current_id(self) -> str:
        idx = self.currentIndex()
        le = self.lineEdit()
        if self.isEditable() and le is not None:
            text = le.text().strip()
            if (
                text
                and 0 <= idx < self.count()
                and text != self.itemText(idx)
            ):
                if "  [" in text:
                    return text.split("  [", 1)[0].strip()
                return text
        if 0 <= idx < len(self._ids):
            return self._ids[idx]
        if self.isEditable() and le is not None:
            text = le.text().strip()
            if not text or text == "(none)":
                return ""
            if "  [" in text:
                return text.split("  [", 1)[0].strip()
            return text
        return ""

    def _on_index(self, _idx: int) -> None:
        self.value_changed.emit(self.current_id())

    def eventFilter(self, obj, event):  # noqa: ANN001
        if (
            self._click_opens_popup
            and obj is self.lineEdit()
            and event.type() == QEvent.Type.MouseButtonPress
        ):
            QTimer.singleShot(0, self.showPopup)
        return super().eventFilter(obj, event)
