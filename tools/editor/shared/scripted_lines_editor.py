"""Editor: list of { speaker, text } for playScriptedDialogue action."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QSizePolicy,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)
from PySide6.QtCore import Signal
from PySide6.QtGui import QFontMetrics

from .id_ref_selector import IdRefSelector


class ScriptedLinesEditor(QWidget):
    """多行台词：每行说话人 + 正文。"""

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
        lab.setToolTip("说话人从下拉选择常见角色名或场景 NPC；留空为旁白。")
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

    def _speaker_items(self, extra: str | None = None) -> list[tuple[str, str]]:
        items: list[tuple[str, str]] = [
            ("", "(留空=旁白)"),
            ("旁白", "旁白"),
            ("你", "你"),
        ]
        seen = {p[0] for p in items}
        if self._model:
            for n in self._model.all_npc_names():
                if n not in seen:
                    seen.add(n)
                    items.append((n, n))
            for nid, label in self._model.npc_ids_for_scene(self._scene_id):
                if nid and nid not in seen:
                    seen.add(nid)
                    items.append((nid, f"{nid} [{label}]"))
        ex = (extra or "").strip()
        if ex and ex not in seen:
            items.append((ex, ex))
        return items

    def _append_row(self, data: dict) -> None:
        box = QFrame()
        box.setFrameStyle(QFrame.Shape.StyledPanel)
        bl = QVBoxLayout(box)
        hdr = QHBoxLayout()
        hdr.addWidget(QLabel("speaker"), stretch=0)
        sp = IdRefSelector(box, allow_empty=True)
        sp.setMinimumWidth(120)
        cur_sp = str(data.get("speaker", "") or "")
        sp.set_items(self._speaker_items(cur_sp))
        sp.set_current(cur_sp)
        sp.value_changed.connect(lambda _v: self.changed.emit())
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
            spw = r["speaker"]
            speaker = spw.current_id().strip() if isinstance(spw, IdRefSelector) else ""
            out.append({
                "speaker": speaker,
                "text": t,
            })
        return out
