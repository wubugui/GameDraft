"""Generic ID-reference dropdown (id + display-name pairs).

数据安全契约（勿退化）：
- 当前值不在候选清单时**必须保值展示**，绝不能静默替换成第一项或清空——
  非 editable 模式追加一条「id  [缺失]」孤儿项；editable 模式保留行编辑原文本。
- 空值且 allow_empty=False 时选中「（未选择）」占位（current_id() 返回 ""），
  不得默认指向第一个真实候选。
- 程序性 set_current/set_items 不发 value_changed；editable 手打文本经
  textEdited 发 value_changed（调用方以此置 pending-dirty）。
"""
from __future__ import annotations

from PySide6.QtWidgets import QComboBox, QWidget
from PySide6.QtCore import Signal, QEvent, QTimer

_MISSING_SUFFIX = "  [缺失]"
_PLACEHOLDER_TEXT = "（未选择）"


class IdRefSelector(QComboBox):
    """A combo-box that shows id + display-name pairs."""
    value_changed = Signal(str)

    def __init__(
        self,
        parent: QWidget | None = None,
        allow_empty: bool = True,
        click_opens_popup: bool = False,
        editable: bool = False,
    ):
        super().__init__(parent)
        self.setEditable(editable)
        self.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        self._allow_empty = allow_empty
        self._click_opens_popup = bool(click_opens_popup)
        self._ids: list[str] = []
        # 孤儿/占位行索引（最多各一条；set_items 重建后由 set_current 按需重加）
        self._orphan_row: int | None = None
        self._placeholder_row: int | None = None
        self.currentIndexChanged.connect(self._on_index)
        if editable:
            le = self.lineEdit()
            if le is not None:
                # 仅用户键入触发（程序性 setText 不发），供调用方置 pending-dirty
                le.textEdited.connect(self._on_text_edited)
        if self._click_opens_popup:
            if editable:
                le = self.lineEdit()
                if le is not None:
                    le.installEventFilter(self)
            else:
                self.installEventFilter(self)

    # ---- population --------------------------------------------------------

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
        uncommitted = self._uncommitted_text()
        if (
            cached == normalized
            and self._orphan_row is None
            and self._placeholder_row is None
            and self.count() == (len(normalized) + (1 if self._allow_empty else 0))
        ):
            self.blockSignals(True)
            try:
                if uncommitted is None:
                    self.set_current(cur_id)
                # editable 手打中的未提交文本：保持原样，不得抹掉
            finally:
                self.blockSignals(False)
            maybe_stamp(_clk, f"skipped n={len(normalized)}")
            return

        self._items_normalized_cache = normalized
        self.blockSignals(True)
        try:
            self.clear()
            self._ids.clear()
            self._orphan_row = None
            self._placeholder_row = None
            if self._allow_empty:
                self.addItem("(none)")
                self._ids.append("")
            for rid, name in normalized:
                self.addItem(f"{rid}  [{name}]")
                self._ids.append(rid)
            if uncommitted is not None:
                le = self.lineEdit()
                if le is not None:
                    le.setText(uncommitted)
            else:
                self.set_current(cur_id)
        finally:
            self.blockSignals(False)
        maybe_stamp(_clk, f"rebuilt n={len(normalized)}")

    def _uncommitted_text(self) -> str | None:
        """editable 模式下用户手打、尚未对应任何候选项的文本（无则 None）。"""
        if not self.isEditable():
            return None
        le = self.lineEdit()
        if le is None:
            return None
        text = le.text()
        stripped = text.strip()
        if not stripped or stripped == "(none)" or stripped == _PLACEHOLDER_TEXT:
            return None
        idx = self.currentIndex()
        if 0 <= idx < self.count() and text == self.itemText(idx):
            return None  # 与当前项一致 = 非手打中
        return text

    # ---- current value -----------------------------------------------------

    def set_current(self, item_id: str) -> None:
        """程序性切换当前 id，不触发 value_changed（避免载入 UI 时误标工程 dirty）。

        未知非空 id 保值：非 editable 加「缺失」孤儿项；editable 保留原文本。
        空 id 且 allow_empty=False：选中「（未选择）」占位，绝不落到第一项。
        """
        item_id = "" if item_id is None else str(item_id)
        self.blockSignals(True)
        try:
            self._drop_extra_row_if_mismatch(item_id)
            if item_id in self._ids:
                self.setCurrentIndex(self._ids.index(item_id))
                if self.isEditable():
                    le = self.lineEdit()
                    if le is not None:
                        le.setText(self.itemText(self.currentIndex()))
            elif not item_id:
                if self._allow_empty:
                    self.setCurrentIndex(0)
                else:
                    self._select_placeholder()
            else:
                if self.isEditable():
                    le = self.lineEdit()
                    if le is not None:
                        le.setText(item_id)
                else:
                    self._select_orphan(item_id)
        finally:
            self.blockSignals(False)

    def _drop_extra_row_if_mismatch(self, wanted: str) -> None:
        """孤儿/占位行最多各一条：目标值变化时先移除旧行。"""
        row = self._orphan_row
        if row is not None and (wanted != self._ids[row]):
            self.removeItem(row)
            self._ids.pop(row)
            self._orphan_row = None
            if self._placeholder_row is not None and self._placeholder_row > row:
                self._placeholder_row -= 1
        row = self._placeholder_row
        if row is not None and wanted:
            self.removeItem(row)
            self._ids.pop(row)
            self._placeholder_row = None
            if self._orphan_row is not None and self._orphan_row > row:
                self._orphan_row -= 1

    def _select_orphan(self, item_id: str) -> None:
        if self._orphan_row is None:
            self.addItem(f"{item_id}{_MISSING_SUFFIX}")
            self._ids.append(item_id)
            self._orphan_row = len(self._ids) - 1
            it = self.model().item(self._orphan_row) if hasattr(self.model(), "item") else None
            if it is not None:
                it.setToolTip("引用的目标不存在（已保留原值，不会被改写）。")
        self.setCurrentIndex(self._orphan_row)

    def _select_placeholder(self) -> None:
        if self._placeholder_row is None:
            self.insertItem(0, _PLACEHOLDER_TEXT)
            self._ids.insert(0, "")
            self._placeholder_row = 0
            if self._orphan_row is not None:
                self._orphan_row += 1
        self.setCurrentIndex(self._placeholder_row)

    def current_id(self) -> str:
        idx = self.currentIndex()
        le = self.lineEdit()
        if self.isEditable() and le is not None:
            text = le.text().strip()
            if not text or text == "(none)" or text == _PLACEHOLDER_TEXT:
                return ""
            if 0 <= idx < self.count() and text != self.itemText(idx):
                if "  [" in text:
                    return text.split("  [", 1)[0].strip()
                return text
        if 0 <= idx < len(self._ids):
            return self._ids[idx]
        if self.isEditable() and le is not None:
            text = le.text().strip()
            if not text or text == "(none)" or text == _PLACEHOLDER_TEXT:
                return ""
            if "  [" in text:
                return text.split("  [", 1)[0].strip()
            return text
        return ""

    def _on_index(self, _idx: int) -> None:
        self.value_changed.emit(self.current_id())

    def _on_text_edited(self, _text: str) -> None:
        self.value_changed.emit(self.current_id())

    def eventFilter(self, obj, event):  # noqa: ANN001
        if (
            self._click_opens_popup
            and event.type() == QEvent.Type.MouseButtonPress
        ):
            ok = (self.isEditable() and obj is self.lineEdit()) or (
                not self.isEditable() and obj is self
            )
            if ok:
                QTimer.singleShot(0, self.showPopup)
        return super().eventFilter(obj, event)
