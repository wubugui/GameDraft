"""Editor: list of { speaker, text } for playScriptedDialogue action."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QFrame,
    QLabel,
    QPushButton,
    QSizePolicy,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)
from PySide6.QtCore import Signal
from PySide6.QtGui import QFontMetrics

from .cutscene_dialogue_speaker_row import build_speaker_line_with_inserts


class ScriptedLinesEditor(QWidget):
    """多行台词：每行说话人 + 正文；说话人可插入运行时解析占位。"""

    changed = Signal()

    def __init__(
        self,
        lines: list | None = None,
        parent: QWidget | None = None,
        *,
        model=None,
        scene_id: str | None = None,
    ):
        super().__init__(parent)
        self._model = model
        self._scene_id = scene_id
        self._rows: list[dict] = []
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        lab = QLabel("lines（至少一行）")
        lab.setToolTip(
            "说话人可手填或点「插入」写入 {{player}} / {{npc}} / {{npc:id}}；"
            "运行时解析为显示名。",
        )
        root.addWidget(lab)
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
        hdr, sp = build_speaker_line_with_inserts(
            box,
            self._model,
            self._scene_id,
            initial_speaker=str(data.get("speaker", "") or ""),
            on_change=self.changed.emit,
        )
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
        tx.textChanged.connect(self.changed.emit)
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
