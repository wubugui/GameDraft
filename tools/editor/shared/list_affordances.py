"""列表/树/表的纯视图易用性原语：搜索过滤 + 右键删除 + Delete 键删除。

约定（重要）：
- 搜索框只对已有行 `setHidden`，绝不增删/重排/修改任何数据。
- 右键菜单与 Delete 键一律转调编辑器既有的删除处理函数（不引入新删除路径），
  既有删除函数自身负责确认弹窗（`confirm.confirm_delete`）。

与 `archive_editor.py` / `anim_editor.py` 中的同名局部 helper 行为一致，此处抽到 shared
供其余编辑器复用，避免各文件再各写一份。
"""
from __future__ import annotations

from PySide6.QtCore import QEvent, QObject, Qt
from PySide6.QtWidgets import (
    QAbstractItemView,
    QLineEdit,
    QListWidget,
    QMenu,
    QTableWidget,
    QTreeWidget,
    QWidget,
)


def make_list_search_box(
    list_widget: QListWidget,
    *,
    placeholder: str = "搜索…",
    tooltip: str = "按文本过滤下方列表（仅隐藏不匹配项，不改动数据）。",
) -> QLineEdit:
    """列表上方的纯视图搜索框：按文本逐项 setHidden，不增删/不重排/不改数据。"""
    box = QLineEdit()
    box.setPlaceholderText(placeholder)
    box.setClearButtonEnabled(True)
    box.setToolTip(tooltip)

    def _filter(text: str) -> None:
        q = text.strip().lower()
        for i in range(list_widget.count()):
            it = list_widget.item(i)
            if it is None:
                continue
            it.setHidden(bool(q) and q not in it.text().lower())

    box.textChanged.connect(_filter)
    return box


def make_table_search_box(
    table: QTableWidget,
    *,
    columns: tuple[int, ...] | None = None,
    placeholder: str = "搜索…",
    tooltip: str = "按文本过滤下方行（仅隐藏不匹配项，不改动数据）。",
) -> QLineEdit:
    """表格上方的纯视图搜索框：按文本逐行 setRowHidden，不增删/不重排/不改数据。

    `columns` 指定参与匹配的列（默认仅第 0 列，通常是 id）。匹配只看 item 文本，
    单元格为 cell-widget 的列因取不到文本而被忽略，这正是我们要的（只按 id 过滤）。
    """
    cols = columns if columns is not None else (0,)
    box = QLineEdit()
    box.setPlaceholderText(placeholder)
    box.setClearButtonEnabled(True)
    box.setToolTip(tooltip)

    def _filter(text: str) -> None:
        q = text.strip().lower()
        for r in range(table.rowCount()):
            if not q:
                table.setRowHidden(r, False)
                continue
            hit = False
            for c in cols:
                it = table.item(r, c)
                if it is not None and q in it.text().lower():
                    hit = True
                    break
            table.setRowHidden(r, not hit)

    box.textChanged.connect(_filter)
    return box


class _DeleteKeyFilter(QObject):
    """按 Delete/Backspace 键时调用既有的删除处理函数（不引入新删除逻辑）。"""

    def __init__(self, delete_handler, parent: QWidget | None = None):
        super().__init__(parent)
        self._delete_handler = delete_handler

    def eventFilter(self, obj, event):  # noqa: N802 (Qt signature)
        if event.type() == QEvent.Type.KeyPress and event.key() in (
            Qt.Key.Key_Delete,
            Qt.Key.Key_Backspace,
        ):
            self._delete_handler()
            return True
        return super().eventFilter(obj, event)


def wire_list_affordances(
    view: QAbstractItemView,
    delete_handler,
    *,
    delete_label: str = "删除",
) -> None:
    """给主列表/树加右键菜单 + Delete 键删除，全部转调既有删除处理函数。

    `view` 为 QListWidget / QTreeWidget；删除函数自带确认弹窗，本函数不重复确认。
    """
    view.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)

    def _has_selection() -> bool:
        if isinstance(view, QTreeWidget):
            return view.currentItem() is not None
        if isinstance(view, QListWidget):
            return view.currentRow() >= 0
        return view.currentIndex().isValid()

    def _ctx_menu(pos) -> None:
        if not _has_selection():
            return
        menu = QMenu(view)
        menu.addAction(delete_label, delete_handler)
        menu.exec(view.viewport().mapToGlobal(pos))

    view.customContextMenuRequested.connect(_ctx_menu)
    flt = _DeleteKeyFilter(delete_handler, view)
    view.installEventFilter(flt)
    # 保留引用，避免事件过滤器被 GC 回收
    view._delete_key_filter = flt  # type: ignore[attr-defined]
