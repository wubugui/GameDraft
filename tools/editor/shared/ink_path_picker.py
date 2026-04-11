"""Ink dialogue path: line edit + dialog to pick from project dialogues."""
from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel


def _normalize_ink_path(raw: str) -> str:
    s = (raw or "").strip()
    if not s:
        return ""
    if s.startswith("/assets/dialogues/"):
        return s if s.endswith(".ink") else s.replace(".ink.json", ".ink")
    if "/" not in s and "\\" not in s:
        name = s if s.endswith(".ink") else f"{s}.ink"
        return f"/assets/dialogues/{name}"
    return s


class InkPathPickRow(QWidget):
    """Runtime ink path (/assets/dialogues/*.ink) with a chooser dialog."""

    changed = Signal()

    def __init__(self, model: ProjectModel | None, initial: str, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self._edit = QLineEdit(_normalize_ink_path(initial))
        self._edit.setPlaceholderText("/assets/dialogues/xxx.ink")
        self._edit.textChanged.connect(lambda _t: self.changed.emit())
        btn = QPushButton("选择 Ink…")
        btn.setToolTip("从列表中选择对话文件")
        btn.clicked.connect(self._on_pick)
        lay.addWidget(self._edit, stretch=1)
        lay.addWidget(btn)

    def _on_pick(self) -> None:
        dlg = QDialog(self)
        dlg.setWindowTitle("选择 Ink 对话")
        dlg.resize(520, 420)
        root = QVBoxLayout(dlg)
        root.addWidget(QLabel("筛选："))
        search = QLineEdit()
        search.setPlaceholderText("文件名…")
        root.addWidget(search)
        lst = QListWidget()
        root.addWidget(lst, stretch=1)

        choices: list[tuple[str, str]] = []
        if self._model:
            choices = self._model.dialogue_asset_path_choices()

        def refill(q: str) -> None:
            lst.clear()
            qlow = q.strip().lower()
            for path, basename in choices:
                if qlow and qlow not in path.lower() and qlow not in basename.lower():
                    continue
                it = QListWidgetItem(f"{basename}\n{path}")
                it.setData(Qt.ItemDataRole.UserRole, path)
                lst.addItem(it)

        refill("")
        search.textChanged.connect(refill)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
        )
        buttons.accepted.connect(dlg.accept)
        buttons.rejected.connect(dlg.reject)
        root.addWidget(buttons)

        if dlg.exec() == QDialog.DialogCode.Accepted:
            it = lst.currentItem()
            if it is not None:
                path = str(it.data(Qt.ItemDataRole.UserRole) or "")
                if path:
                    self._edit.setText(path)
                    self.changed.emit()

    def path(self) -> str:
        return _normalize_ink_path(self._edit.text())

    def set_path(self, p: str) -> None:
        self._edit.blockSignals(True)
        self._edit.setText(_normalize_ink_path(p))
        self._edit.blockSignals(False)
