"""Editor: list of { speaker, text } for playScriptedDialogue action."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSizePolicy,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)
from PySide6.QtCore import Signal
from PySide6.QtGui import QFontMetrics


class ScriptedLinesEditor(QWidget):
    """多行台词：每行说话人 + 正文。"""

    changed = Signal()

    def __init__(self, lines: list | None = None, parent: QWidget | None = None):
        super().__init__(parent)
        self._rows: list[dict] = []
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(QLabel("lines（至少一行；说话人可空表示旁白键由运行时解析）"))
        self._list_layout = QVBoxLayout()
        root.addLayout(self._list_layout)
        btn_add = QPushButton("+ 一行台词")
        btn_add.clicked.connect(self._add_empty)
        root.addWidget(btn_add)
        raw = lines if isinstance(lines, list) else []
        if raw:
            for item in raw:
                if isinstance(item, dict):
                    self._append_row(item)
        if not self._rows:
            self._append_row({})

    def _add_empty(self) -> None:
        self._append_row({})
        self.changed.emit()

    def _remove_row(self, rec: dict) -> None:
        if rec in self._rows:
            self._rows.remove(rec)
        box = rec["box"]
        self._list_layout.removeWidget(box)
        box.deleteLater()
        if not self._rows:
            self._append_row({})
        self.changed.emit()

    def _append_row(self, data: dict) -> None:
        box = QFrame()
        box.setFrameStyle(QFrame.Shape.StyledPanel)
        bl = QVBoxLayout(box)
        hdr = QHBoxLayout()
        hdr.addWidget(QLabel("speaker"), stretch=0)
        sp = QLineEdit()
        sp.setPlaceholderText("留空=旁白（运行时）")
        sp.setText(str(data.get("speaker", "") or ""))
        sp.textChanged.connect(lambda _t: self.changed.emit())
        hdr.addWidget(sp, stretch=1)
        rm = QPushButton("\u2212")
        rm.setFixedWidth(24)
        hdr.addWidget(rm)
        bl.addLayout(hdr)
        bl.addWidget(QLabel("text"))
        tx = QTextEdit()
        fm = QFontMetrics(tx.font())
        lh = max(1, int(fm.lineSpacing()))
        tx.setFixedHeight(max(24, lh + 14))
        tx.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        tx.setPlainText(str(data.get("text", "") or ""))
        tx.textChanged.connect(lambda: self.changed.emit())
        bl.addWidget(tx)
        rec = {"box": box, "speaker": sp, "text": tx}
        rm.clicked.connect(lambda: self._remove_row(rec))
        self._rows.append(rec)
        self._list_layout.addWidget(box)

    def to_list(self) -> list[dict]:
        out: list[dict] = []
        for r in self._rows:
            t = r["text"].toPlainText()
            if not t:
                continue
            out.append({
                "speaker": r["speaker"].text().strip(),
                "text": t,
            })
        return out
