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
        self._refresh_reorder_buttons()
        self.changed.emit()

    def _move_row(self, rec: dict, delta: int) -> None:
        if rec not in self._rows:
            return
        i = self._rows.index(rec)
        j = i + delta
        if j < 0 or j >= len(self._rows):
            return
        self._rows[i], self._rows[j] = self._rows[j], self._rows[i]
        for r in self._rows:
            self._list_layout.removeWidget(r["box"])
        for r in self._rows:
            self._list_layout.addWidget(r["box"])
        self._refresh_reorder_buttons()
        self.changed.emit()

    def _refresh_reorder_buttons(self) -> None:
        n = len(self._rows)
        for i, r in enumerate(self._rows):
            r["btn_up"].setEnabled(i > 0)
            r["btn_down"].setEnabled(i < n - 1)

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
        up = QPushButton("\u2191")
        up.setFixedWidth(24)
        up.setToolTip("上移")
        dn = QPushButton("\u2193")
        dn.setFixedWidth(24)
        dn.setToolTip("下移")
        rm = QPushButton("\u2212")
        rm.setFixedWidth(24)
        rm.setToolTip("删除")
        hdr.addWidget(up)
        hdr.addWidget(dn)
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
        rec = {"box": box, "speaker": sp, "text": tx, "btn_up": up, "btn_down": dn}
        rm.clicked.connect(lambda: self._remove_row(rec))
        up.clicked.connect(lambda: self._move_row(rec, -1))
        dn.clicked.connect(lambda: self._move_row(rec, 1))
        self._rows.append(rec)
        self._list_layout.addWidget(box)
        self._refresh_reorder_buttons()

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
