"""Editor: list of { speaker, text } for playScriptedDialogue action."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMenu,
    QPushButton,
    QSizePolicy,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)
from PySide6.QtCore import Signal
from PySide6.QtGui import QAction, QFontMetrics

from .id_ref_selector import IdRefSelector

_SPEAKER_INSERTS = (
    ("{{player}}", "玩家显示名"),
    ("{{npc}}", "默认 NPC（scriptedNpcId / 图对话 npcId）"),
)


class _NpcPickDialog(QDialog):
    def __init__(self, model, scene_id: str | None, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("选择 NPC id")
        lay = QVBoxLayout(self)
        self._sel = IdRefSelector(self, allow_empty=False)
        self._sel.setMinimumWidth(220)
        if model:
            items = model.npc_ids_for_scene(scene_id)
            self._sel.set_items(items if items else [("", "（当前场景无 NPC）")])
        lay.addWidget(self._sel)
        box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
        )
        box.accepted.connect(self.accept)
        box.rejected.connect(self.reject)
        lay.addWidget(box)

    def npc_id(self) -> str:
        return self._sel.current_id().strip()


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

    def _insert_into_line_edit(self, le: QLineEdit, token: str) -> None:
        le.insert(token)
        self.changed.emit()

    def _pick_npc_and_insert(self, le: QLineEdit) -> None:
        dlg = _NpcPickDialog(self._model, self._scene_id, self)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        nid = dlg.npc_id()
        if nid:
            self._insert_into_line_edit(le, f"{{{{npc:{nid}}}}}")

    def _append_row(self, data: dict) -> None:
        box = QFrame()
        box.setFrameStyle(QFrame.Shape.StyledPanel)
        bl = QVBoxLayout(box)
        hdr = QHBoxLayout()
        hdr.addWidget(QLabel("speaker"), stretch=0)
        sp = QLineEdit()
        sp.setPlaceholderText("留空=旁白；可插入 {{player}} / {{npc}}")
        sp.setText(str(data.get("speaker", "") or ""))
        sp.textChanged.connect(lambda _t: self.changed.emit())
        hdr.addWidget(sp, stretch=1)

        ins_btn = QPushButton("插入…")
        ins_btn.setToolTip("在光标处插入运行时解析占位")
        menu = QMenu(ins_btn)
        for tok, desc in _SPEAKER_INSERTS:
            act = QAction(f"{tok}  — {desc}", menu)
            act.triggered.connect(lambda _c=False, t=tok, le=sp: self._insert_into_line_edit(le, t))
            menu.addAction(act)
        pick_act = QAction("选择 NPC → 插入 {{npc:id}}…", menu)
        pick_act.triggered.connect(lambda le=sp: self._pick_npc_and_insert(le))
        menu.addAction(pick_act)
        ins_btn.setMenu(menu)
        hdr.addWidget(ins_btn)

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
