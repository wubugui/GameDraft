"""用于自定义拖放/起始拖动的列表与表格视图。"""
from __future__ import annotations

from PySide6.QtCore import QMimeData, Qt, QUrl, QByteArray
from PySide6.QtGui import QDrag, QMouseEvent
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QListView,
    QTableView,
    QTreeView,
    QWidget,
)

MIME_ASSETS = "application/x-gamedraft-assets"


def _build_mime_for_paths(paths: list[str], *, extra_urls: list[QUrl] | None = None) -> QMimeData:
    m = QMimeData()
    m.setData(MIME_ASSETS, QByteArray("\n".join(paths).encode("utf-8")))
    urls = [QUrl.fromLocalFile(p) for p in paths]
    if extra_urls:
        urls.extend(extra_urls)
    m.setUrls(urls)
    return m


def default_drop_action() -> bool:
    """若按住 Ctrl/Shift 为复制，否则为移动。返回 True=复制。"""
    m = QApplication.keyboardModifiers()
    return (m & Qt.KeyboardModifier.ControlModifier) != 0 or (m & Qt.KeyboardModifier.ShiftModifier) != 0


def _mods_from_event(e) -> "Qt.KeyboardModifier":
    """与 PySide6 兼容：keyboardModifiers 为 QFlags/枚举报表，不能 int() 强转。"""
    try:
        m = e.keyboardModifiers()  # type: ignore[union-attr]
    except (AttributeError, TypeError):
        m = 0
    if m:
        return m
    return QApplication.keyboardModifiers()


def _pick_drop_action_for_event(e, *, prefer_move: bool = True):
    """与 startDrag/资源管理器一致：未按修饰键时默认移动（同盘）。"""
    m = _mods_from_event(e)
    if (m & Qt.KeyboardModifier.ControlModifier) or (
        m & Qt.KeyboardModifier.ShiftModifier
    ):
        return Qt.DropAction.CopyAction
    if prefer_move:
        return Qt.DropAction.MoveAction
    return Qt.DropAction.CopyAction


def internal_drop_wants_copy(e) -> bool:
    """仓库内拖放：Ctrl/Shift 强制复制，否则以 dropAction（通常由 dragMove 设为移/拷）为准。"""
    m = _mods_from_event(e)
    if (m & Qt.KeyboardModifier.ControlModifier) or (
        m & Qt.KeyboardModifier.ShiftModifier
    ):
        return True
    da = e.dropAction()
    if da == Qt.DropAction.CopyAction:
        return True
    if da == Qt.DropAction.MoveAction:
        return False
    return False


class AssetQListView(QListView):
    """可发起 Asset MIME 的网格/列表；双击仍由主窗口转交。"""

    def __init__(self, host, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._host = host
        self.setSelectionMode(
            QAbstractItemView.SelectionMode.ExtendedSelection
        )
        self.setDragDropMode(
            QAbstractItemView.DragDropMode.DragDrop
        )
        # 同盘资源管理器式：默认“移动”，Ctrl/拖放为复制
        self.setDefaultDropAction(Qt.DropAction.MoveAction)
        self.setAcceptDrops(True)
        self.setDropIndicatorShown(True)
        self.setDragEnabled(True)

    def dragEnterEvent(self, e) -> None:  # noqa: N802, ANN001
        if e.mimeData().hasFormat(
            MIME_ASSETS
        ) or e.mimeData().hasUrls():
            e.setDropAction(
                _pick_drop_action_for_event(e, prefer_move=True)
            )
            e.accept()
        else:
            e.ignore()

    def dragMoveEvent(self, e) -> None:  # noqa: N802, ANN001
        if e.mimeData().hasFormat(
            MIME_ASSETS
        ) or e.mimeData().hasUrls():
            e.setDropAction(
                _pick_drop_action_for_event(e, prefer_move=True)
            )
            e.accept()
        else:
            e.ignore()

    def dropEvent(self, e) -> None:  # noqa: N802, ANN001
        self._host._handle_list_drop(e)  # noqa: SLF001

    def startDrag(
        self, supportedActions: Qt.DropActions
    ) -> None:  # noqa: N802, ARG002
        paths = self._host._selected_paths()  # noqa: SLF001
        if not paths:
            return
        m = _build_mime_for_paths(paths)
        drag = QDrag(self)
        drag.setMimeData(m)
        copy = default_drop_action()
        dft = (
            Qt.DropAction.CopyAction
            if copy
            else Qt.DropAction.MoveAction
        )
        actions = (
            Qt.DropAction.CopyAction | Qt.DropAction.MoveAction
        )
        drag.exec_(actions, dft)

    def mousePressEvent(
        self, e: QMouseEvent
    ) -> None:  # noqa: N802, ARG002
        super().mousePressEvent(e)


class AssetQTableView(QTableView):
    def __init__(self, host, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._host = host
        self.setSelectionMode(
            QAbstractItemView.SelectionMode.ExtendedSelection
        )
        self.setSelectionBehavior(
            QAbstractItemView.SelectionBehavior.SelectRows
        )
        self.setDragDropMode(
            QAbstractItemView.DragDropMode.DragDrop
        )
        self.setDefaultDropAction(Qt.DropAction.MoveAction)
        self.setAcceptDrops(True)
        self.setDropIndicatorShown(True)
        self.setDragEnabled(True)
        self.verticalHeader().setDefaultSectionSize(24)

    def dragEnterEvent(self, e) -> None:  # noqa: N802, ANN001
        if e.mimeData().hasFormat(
            MIME_ASSETS
        ) or e.mimeData().hasUrls():
            e.setDropAction(
                _pick_drop_action_for_event(e, prefer_move=True)
            )
            e.accept()
        else:
            e.ignore()

    def dragMoveEvent(self, e) -> None:  # noqa: N802, ANN001
        if e.mimeData().hasFormat(
            MIME_ASSETS
        ) or e.mimeData().hasUrls():
            e.setDropAction(
                _pick_drop_action_for_event(e, prefer_move=True)
            )
            e.accept()
        else:
            e.ignore()

    def dropEvent(self, e) -> None:  # noqa: N802, ANN001
        self._host._handle_list_drop(e)  # noqa: SLF001

    def startDrag(
        self, supportedActions: Qt.DropActions
    ) -> None:  # noqa: N802, ARG002
        paths = self._host._selected_paths()  # noqa: SLF001
        if not paths:
            return
        m = _build_mime_for_paths(paths)
        drag = QDrag(self)
        drag.setMimeData(m)
        copy = default_drop_action()
        dft = (
            Qt.DropAction.CopyAction
            if copy
            else Qt.DropAction.MoveAction
        )
        actions = (
            Qt.DropAction.CopyAction | Qt.DropAction.MoveAction
        )
        drag.exec_(actions, dft)


class AssetTreeView(QTreeView):
    """在目录树上接收拖放，目标为文件夹。"""

    def __init__(self, host, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._host = host
        self.setAcceptDrops(True)
        self.setDropIndicatorShown(True)
        self.setDragDropMode(
            QAbstractItemView.DragDropMode.DragDrop
        )
        self.setDefaultDropAction(Qt.DropAction.MoveAction)
        self.setDragEnabled(True)

    def dragEnterEvent(self, e) -> None:  # noqa: N802, ANN001
        if e.mimeData().hasFormat(
            MIME_ASSETS
        ) or e.mimeData().hasUrls():
            e.setDropAction(
                _pick_drop_action_for_event(e, prefer_move=True)
            )
            e.accept()
        else:
            e.ignore()

    def dragMoveEvent(self, e) -> None:  # noqa: N802, ANN001
        if e.mimeData().hasFormat(
            MIME_ASSETS
        ) or e.mimeData().hasUrls():
            e.setDropAction(
                _pick_drop_action_for_event(e, prefer_move=True)
            )
            e.accept()
        else:
            e.ignore()

    def dropEvent(self, e) -> None:  # noqa: N802, ANN001
        p = e.position().toPoint()
        idx = self.indexAt(p)
        self._host._handle_tree_drop(idx, e)  # noqa: SLF001


def parse_asset_mime(data: QMimeData) -> list[str] | None:
    if not data.hasFormat(MIME_ASSETS):
        return None
    raw = bytes(data.data(MIME_ASSETS))
    s = raw.decode("utf-8", errors="replace")
    if not s.strip():
        return None
    return [x for x in s.splitlines() if x.strip()]
