"""只读展示 #RRGGBB +「颜色…」取色，禁止手输 hex 的通用控件。

从 water_minigame_editor 上移到 shared 供各编辑器复用（颜色字段一律用取色器，
不让用户手打 hex）。`title` 控制取色对话框标题。
"""
from __future__ import annotations

from PySide6.QtCore import Signal
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QColorDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QWidget,
)


class HexColorPickRow(QWidget):
    """只读展示 #RRGGBB +「颜色…」取色，禁止手输 hex。"""

    changed = Signal()

    def __init__(
        self,
        initial: str = "#1b2f42",
        parent: QWidget | None = None,
        *,
        title: str = "选择颜色",
    ) -> None:
        super().__init__(parent)
        self._title = title
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self._swatch = QLabel()
        self._swatch.setFixedSize(32, 22)
        self._disp = QLineEdit()
        self._disp.setReadOnly(True)
        btn = QPushButton("颜色…")
        btn.clicked.connect(self._pick)
        lay.addWidget(self._swatch)
        lay.addWidget(self._disp, stretch=1)
        lay.addWidget(btn)
        self.set_hex(initial)

    def hex(self) -> str:
        return self._disp.text().strip()

    def set_hex(self, hx: str) -> None:
        s = (hx or "").strip()
        if not s.startswith("#"):
            s = f"#{s}"
        c = QColor(s)
        if not c.isValid():
            c = QColor("#1b2f42")
        self._disp.blockSignals(True)
        self._disp.setText(c.name().lower())
        self._disp.blockSignals(False)
        self._apply_swatch(c)

    def _apply_swatch(self, c: QColor) -> None:
        self._swatch.setStyleSheet(f"background-color: {c.name()}; border: 1px solid #777;")

    def _pick(self) -> None:
        cur = QColor(self.hex())
        if not cur.isValid():
            cur = QColor("#1b2f42")
        picked = QColorDialog.getColor(cur, self, self._title)
        if picked.isValid():
            self.set_hex(picked.name())
            self.changed.emit()
