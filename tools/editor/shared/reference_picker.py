"""Reusable, value-safe reference picker backed by a searchable dialog.

Large/cross-file reference sets must not use a combo box.  This module keeps
the committed value in a read-only field and only queries the provider when
the user opens the standalone picker, so newly-created targets are immediately
visible without rebuilding the containing form.
"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from typing import TypeAlias

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QAbstractItemView,
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QInputDialog,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QSizePolicy,
    QVBoxLayout,
    QWidget,
)

from .dialog_geometry import remember_dialog_geometry


ReferenceRow: TypeAlias = str | tuple[str, str] | tuple[str, str, str]
ReferenceProvider: TypeAlias = Callable[[], Iterable[ReferenceRow]]
_VALUE_ROLE = Qt.ItemDataRole.UserRole


def _normalize_rows(rows: Iterable[ReferenceRow]) -> list[tuple[str, str, str]]:
    """Return unique ``(value, label, detail)`` rows, preserving input order."""
    out: list[tuple[str, str, str]] = []
    seen: set[str] = set()
    for row in rows:
        if isinstance(row, tuple):
            value = str(row[0] if len(row) > 0 else "").strip()
            label = str(row[1] if len(row) > 1 else value).strip()
            detail = str(row[2] if len(row) > 2 else "").strip()
        else:
            value = str(row).strip()
            label = value
            detail = ""
        if not value or value in seen:
            continue
        seen.add(value)
        out.append((value, label or value, detail))
    return out


class ReferencePickerDialog(QDialog):
    """Standalone contains-search picker for arbitrary string references."""

    def __init__(
        self,
        rows: Iterable[ReferenceRow],
        *,
        current: str = "",
        title: str = "选择引用",
        parent: QWidget | None = None,
        geometry_key: str = "reference_picker",
        allow_empty: bool = False,
    ) -> None:
        super().__init__(parent)
        self.setWindowTitle(title)
        self.setMinimumSize(520, 340)
        self.resize(760, 560)
        self._rows = _normalize_rows(rows)
        self._current = str(current or "").strip()
        self._selected = ""

        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        self._filter = QLineEdit(self)
        self._filter.setPlaceholderText("筛选名称 / ID / 说明…")
        self._filter.setClearButtonEnabled(True)
        self._filter.textChanged.connect(self._apply_filter)
        root.addWidget(self._filter)

        self._list = QListWidget(self)
        self._list.setAlternatingRowColors(True)
        self._list.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._list.itemDoubleClicked.connect(lambda _item: self._accept_current())
        root.addWidget(self._list, 1)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=self,
        )
        if allow_empty:
            clear_button = buttons.addButton(
                "清空",
                QDialogButtonBox.ButtonRole.ResetRole,
            )
            clear_button.setToolTip("清除当前引用并关闭选择窗口")
            clear_button.clicked.connect(self._clear_and_accept)
        buttons.accepted.connect(self._accept_current)
        buttons.rejected.connect(self.reject)
        root.addWidget(buttons)
        self._ok_button = buttons.button(QDialogButtonBox.StandardButton.Ok)

        remember_dialog_geometry(self, geometry_key)
        self._apply_filter("")
        self._filter.setFocus()

    def selected_value(self) -> str:
        return self._selected

    def _apply_filter(self, text: str) -> None:
        query = str(text or "").strip().casefold()
        self._list.clear()
        for value, label, detail in self._rows:
            haystack = "\n".join((value, label, detail)).casefold()
            if query and query not in haystack:
                continue
            display = value if label == value else f"{label}  [{value}]"
            if detail:
                display += f"\n{detail}"
            item = QListWidgetItem(display)
            item.setData(_VALUE_ROLE, value)
            if detail:
                item.setToolTip(detail)
            self._list.addItem(item)
            if value == self._current:
                self._list.setCurrentItem(item)
        if self._list.currentItem() is None and self._list.count() > 0:
            self._list.setCurrentRow(0)
        self._ok_button.setEnabled(self._list.count() > 0)

    def _accept_current(self) -> None:
        item = self._list.currentItem()
        if item is None:
            return
        self._selected = str(item.data(_VALUE_ROLE) or "")
        self.accept()

    def _clear_and_accept(self) -> None:
        self._selected = ""
        self.accept()


class ReferencePickerField(QWidget):
    """Read-only committed reference with a live searchable picker.

    Programmatic ``set_value`` and ``refresh_display`` never emit
    ``value_changed``.  If the current value is absent from the provider it is
    shown as missing but returned verbatim by ``current_value``.
    """

    value_changed = Signal(str)

    def __init__(
        self,
        provider: ReferenceProvider | None = None,
        parent: QWidget | None = None,
        *,
        allow_empty: bool = True,
        title: str = "选择引用",
        geometry_key: str = "reference_picker",
        allow_custom: bool = False,
        custom_prompt: str = "定义新的引用 ID：",
    ) -> None:
        super().__init__(parent)
        self._provider: ReferenceProvider = provider or (lambda: [])
        self._allow_empty = bool(allow_empty)
        self._title = title
        self._geometry_key = geometry_key
        self._allow_custom = bool(allow_custom)
        self._custom_prompt = custom_prompt
        self._value = ""

        layout = QHBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(4)
        self._line = QLineEdit(self)
        self._line.setReadOnly(True)
        self._line.setSizePolicy(
            QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred,
        )
        self._choose = QPushButton("选择…", self)
        self._choose.setToolTip("打开独立的可搜索引用选择窗口")
        self._choose.clicked.connect(self._open_picker)
        self._define = QPushButton("定义…", self)
        self._define.setToolTip("为开放命名空间显式定义一个新的引用 ID")
        self._define.clicked.connect(self._define_value)
        self._define.setVisible(self._allow_custom)
        self._clear = QPushButton("清空", self)
        self._clear.setToolTip("清除当前引用")
        self._clear.clicked.connect(self.clear_value)
        self._clear.setVisible(self._allow_empty)
        layout.addWidget(self._line, 1)
        layout.addWidget(self._choose)
        layout.addWidget(self._define)
        layout.addWidget(self._clear)
        self.refresh_display()

    def set_provider(self, provider: ReferenceProvider | None) -> None:
        self._provider = provider or (lambda: [])
        self.refresh_display()

    def set_custom_allowed(self, allowed: bool) -> None:
        """Toggle the explicit ID-definition flow for open namespaces."""
        self._allow_custom = bool(allowed)
        self._define.setVisible(self._allow_custom)
        self.refresh_display()

    def set_value(self, value: str | None) -> None:
        self._value = str(value or "").strip()
        self.refresh_display()

    def current_value(self) -> str:
        return self._value

    def clear_value(self) -> None:
        if not self._allow_empty or not self._value:
            return
        self._value = ""
        self.refresh_display()
        self.value_changed.emit("")

    def refresh_display(self) -> None:
        rows = self._safe_rows()
        by_value = {value: (label, detail) for value, label, detail in rows}
        if not self._value:
            self._line.setText("（未选择）")
            self._line.setToolTip("当前未设置引用")
        elif self._value in by_value:
            label, detail = by_value[self._value]
            self._line.setText(
                self._value if label == self._value else f"{label}  [{self._value}]",
            )
            self._line.setToolTip(detail or self._value)
        elif self._allow_custom:
            self._line.setText(f"{self._value}  [自定义]")
            self._line.setToolTip(
                "开放命名空间中的显式自定义 ID；该值会按原样保存。",
            )
        else:
            self._line.setText(f"{self._value}  [缺失]")
            self._line.setToolTip(
                "引用目标当前不在候选目录中；原值已保留，不会被自动改写。",
            )
        self._clear.setEnabled(bool(self._value))

    def _safe_rows(self) -> list[tuple[str, str, str]]:
        try:
            return _normalize_rows(self._provider() or [])
        except Exception:
            # Provider failure is fail-safe: keep the committed value visible as
            # missing and offer no potentially incorrect replacement choices.
            return []

    def _open_picker(self) -> None:
        dialog = ReferencePickerDialog(
            self._safe_rows(),
            current=self._value,
            title=self._title,
            parent=self,
            geometry_key=self._geometry_key,
        )
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        value = dialog.selected_value()
        if not value or value == self._value:
            return
        self._value = value
        self.refresh_display()
        self.value_changed.emit(value)

    def _define_value(self) -> None:
        if not self._allow_custom:
            return
        value, ok = QInputDialog.getText(
            self,
            self._title,
            self._custom_prompt,
            text=self._value,
        )
        if not ok:
            return
        committed = str(value or "").strip()
        if not committed or committed == self._value:
            return
        self._value = committed
        self.refresh_display()
        self.value_changed.emit(committed)
