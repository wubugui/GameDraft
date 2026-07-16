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
from .portrait_ref_field import PortraitRefField
from .rich_text_field import RichTextTextEdit


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
            "说话人：有工程时可点单行「引用」插入 [tag:…]，或菜单插入 {{player}} / {{npc}} / {{npc:id}}；"
            "正文点「插入引用」；运行时均在台词展示前经 resolveText。",
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
            rich_refs=bool(self._model),
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
        bl.addWidget(QLabel("text（可插入项目引用 [tag:…]）"))
        m = self._model
        if m:
            tx_wrap = RichTextTextEdit(m)
            tx = tx_wrap.core_text_edit()
            tx.setPlainText(str(data.get("text", "") or ""))
            tx_wrap.textChanged.connect(self.changed.emit)
        else:
            tx_wrap = QTextEdit()
            fm = QFontMetrics(tx_wrap.font())
            lh = max(1, int(fm.lineSpacing()))
            tx_wrap.setFixedHeight(max(24, lh + 14))
            tx_wrap.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
            tx_wrap.setPlainText(str(data.get("text", "") or ""))
            tx_wrap.textChanged.connect(self.changed.emit)
            tx = tx_wrap
        tx.setMinimumHeight(48)
        tx.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.MinimumExpanding)
        bl.addWidget(tx_wrap)
        proot = getattr(m, "project_path", None) if m else None
        portrait = PortraitRefField(proot, data.get("portrait") if isinstance(data, dict) else None)
        portrait.changed.connect(self.changed.emit)
        bl.addWidget(portrait)
        rec = {"box": box, "speaker": sp, "text": tx, "portrait": portrait, "btn_up": up, "btn_down": dn}
        rm.clicked.connect(lambda: self._remove_row(rec))
        up.clicked.connect(lambda: self._move_row(rec, -1))
        dn.clicked.connect(lambda: self._move_row(rec, 1))
        self._rows.append(rec)
        self._list_layout.addWidget(box)
        self._refresh_reorder_buttons()

    def set_model(self, model) -> None:
        """载入工程后替换 model（仅影响后续新增行；既有行保持原控件）。"""
        self._model = model

    def to_list(self) -> list[dict]:
        out: list[dict] = []
        for r in self._rows:
            te = r["text"]
            t = te.toPlainText() if hasattr(te, "toPlainText") else ""
            spw = r["speaker"]
            sp_txt = spw.text().strip() if hasattr(spw, "text") else ""
            por = r["portrait"].to_ref()
            # 空正文行：过去无条件静默丢弃，会连带丢掉已配好的 speaker / 立绘（审查 P3）。
            # 只丢「三项全空」的纯空行；已配 speaker 或立绘的空文本行保留，避免默默吃掉编辑。
            if not t and not sp_txt and not por:
                continue
            rec: dict = {
                "speaker": sp_txt,
                "text": t,
            }
            if por:
                rec["portrait"] = por
            out.append(rec)
        return out
