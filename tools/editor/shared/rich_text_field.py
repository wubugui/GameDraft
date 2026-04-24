"""Rich text widgets with insert-[tag:…] dialog (策划勿手打引用)."""
from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QStackedWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel
from .ref_validator import scan_refs
from .tag_catalog import TagCatalog, TagItem


_KIND_LABELS = [
    ("string", "strings.json"),
    ("flag", "Flag"),
    ("item", "道具"),
    ("npc", "NPC"),
    ("player", "玩家"),
    ("quest", "任务"),
    ("rule", "规矩"),
    ("scene", "场景"),
]


class InsertRefDialog(QDialog):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("插入项目引用")
        self.setMinimumWidth(520)
        self.setMinimumHeight(420)
        self._model = model
        self._catalog = TagCatalog(model)
        self._marker = ""

        root = QVBoxLayout(self)
        kind_row = QHBoxLayout()
        kind_row.addWidget(QLabel("类型"))
        self._kind = QComboBox()
        for k, lab in _KIND_LABELS:
            self._kind.addItem(lab, k)
        kind_row.addWidget(self._kind, 1)
        root.addLayout(kind_row)

        self._filter = QLineEdit()
        self._filter.setPlaceholderText("筛选 id / 名称…")
        root.addWidget(self._filter)

        self._stack = QStackedWidget()
        self._lists: dict[str, QListWidget] = {}
        for k, _lab in _KIND_LABELS:
            lw = QListWidget()
            lw.itemDoubleClicked.connect(self._accept_current)
            self._lists[k] = lw
            self._stack.addWidget(lw)
        root.addWidget(self._stack, 1)

        preview = QLabel("")
        preview.setWordWrap(True)
        preview.setStyleSheet("color: #666;")
        self._preview = preview
        root.addWidget(preview)

        bb = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
        )
        bb.accepted.connect(self._on_ok)
        bb.rejected.connect(self.reject)
        root.addWidget(bb)

        self._kind.currentIndexChanged.connect(self._on_kind_changed)
        self._filter.textChanged.connect(self._refresh_list)
        self._on_kind_changed(0)

    def marker(self) -> str:
        return self._marker

    def _on_kind_changed(self, idx: int) -> None:
        k = self._kind.itemData(idx)
        if isinstance(k, str):
            self._stack.setCurrentWidget(self._lists[k])
        self._refresh_list()

    def _refresh_list(self) -> None:
        idx = self._kind.currentIndex()
        k = str(self._kind.itemData(idx) or "string")
        lw = self._lists[k]
        lw.clear()
        q = self._filter.text().strip().lower()
        items = self._catalog.list_by_kind(k)
        if q:
            items = [it for it in items if q in f"{it.ref_id} {it.label} {it.hint}".lower()]
        for it in items:
            lw.addItem(QListWidgetItem(f"{it.label}  [{it.ref_id}]"))
            lw.item(lw.count() - 1).setData(Qt.ItemDataRole.UserRole, it)
        self._preview.setText("")

    def _current_item(self) -> TagItem | None:
        idx = self._kind.currentIndex()
        k = str(self._kind.itemData(idx) or "string")
        lw = self._lists[k]
        row = lw.currentRow()
        if row < 0:
            return None
        it = lw.item(row)
        if not it:
            return None
        data = it.data(Qt.ItemDataRole.UserRole)
        return data if isinstance(data, TagItem) else None

    def _accept_current(self) -> None:
        self._on_ok()

    def _on_ok(self) -> None:
        item = self._current_item()
        if item is None:
            QMessageBox.warning(self, "插入引用", "请选择一项")
            return
        self._marker = self._catalog.marker_for(item)
        if not self._marker:
            QMessageBox.warning(self, "插入引用", "无法生成标记")
            return
        self.accept()


def _format_errs(errs: list[str]) -> str:
    if not errs:
        return "（引用校验通过）"
    return "问题:\n" + "\n".join(errs[:5])


class RichTextTextEdit(QWidget):
    """QTextEdit + 插入引用；API 兼容 toPlainText / setPlainText / textChanged。"""

    textChanged = Signal()

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        row = QHBoxLayout()
        self._edit = QTextEdit()
        self._edit.textChanged.connect(self.textChanged.emit)
        row.addWidget(self._edit, 1)
        btn = QPushButton("插入\n引用")
        btn.setMaximumWidth(56)
        btn.clicked.connect(self._insert_ref)
        row.addWidget(btn)
        lay.addLayout(row)
        self._hint = QLabel("")
        self._hint.setWordWrap(True)
        self._hint.setStyleSheet("font-size:11px;color:#888;")
        lay.addWidget(self._hint)
        self._edit.textChanged.connect(self._update_hint)

    def set_model(self, model: ProjectModel) -> None:
        """切换工程模型（图编辑器 PropertyStack 在载入工程后注入）。"""
        self._model = model
        self._update_hint()

    def core_text_edit(self) -> QTextEdit:
        """供插入图片等需直接操作 QTextCursor 的逻辑使用。"""
        return self._edit

    def _update_hint(self) -> None:
        t = self._edit.toPlainText()
        errs = scan_refs(t, "预览", self._model)
        self._hint.setText(_format_errs(errs))

    def _insert_ref(self) -> None:
        dlg = InsertRefDialog(self._model, self)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        m = dlg.marker()
        if not m:
            return
        self._edit.textCursor().insertText(m)
        self._update_hint()

    def toPlainText(self) -> str:
        return self._edit.toPlainText()

    def setPlainText(self, text: str) -> None:
        self._edit.setPlainText(text)

    def setMaximumHeight(self, maxh: int) -> None:
        self._edit.setMaximumHeight(maxh)

    def setPlaceholderText(self, text: str) -> None:
        self._edit.setPlaceholderText(text)

    def clear(self) -> None:
        self._edit.clear()


class RichTextLineEdit(QWidget):
    """QLineEdit + 插入引用。"""

    textChanged = Signal(str)

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self._edit = QLineEdit()
        self._edit.textChanged.connect(self.textChanged.emit)
        btn = QPushButton("引用")
        btn.setMaximumWidth(44)
        btn.clicked.connect(self._insert_ref)
        lay.addWidget(self._edit, 1)
        lay.addWidget(btn)

    def set_model(self, model: ProjectModel) -> None:
        self._model = model

    def _insert_ref(self) -> None:
        dlg = InsertRefDialog(self._model, self)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        m = dlg.marker()
        if not m:
            return
        self._edit.insert(m)

    def text(self) -> str:
        return self._edit.text()

    def setText(self, text: str) -> None:
        self._edit.setText(text)

    def setPlaceholderText(self, text: str) -> None:
        self._edit.setPlaceholderText(text)

    def clear(self) -> None:
        self._edit.clear()
