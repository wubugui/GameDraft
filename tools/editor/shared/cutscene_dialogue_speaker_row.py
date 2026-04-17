"""过场 present:showDialogue 与 playScriptedDialogue 共用的 speaker 行（插入占位 + 可选 scriptedNpcId）。"""
from __future__ import annotations

from typing import Callable

from PySide6.QtWidgets import (
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMenu,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)
from PySide6.QtGui import QAction

from .id_ref_selector import IdRefSelector

_SPEAKER_INSERTS = (
    ("{{player}}", "玩家显示名"),
    ("{{npc}}", "默认 NPC（scriptedNpcId / 图对话 npcId）"),
)


def npc_items_for_dialogue_picker(model, scene_id: str | None) -> list[tuple[str, str]]:
    if model and scene_id:
        items = model.npc_ids_for_scene(scene_id)
        if items:
            return items
    return model.all_npc_ids_global() if model else []


class NpcIdPickDialog(QDialog):
    def __init__(self, model, scene_id: str | None, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("选择 NPC id")
        lay = QVBoxLayout(self)
        self._sel = IdRefSelector(self, allow_empty=False)
        self._sel.setMinimumWidth(220)
        items = npc_items_for_dialogue_picker(model, scene_id)
        self._sel.set_items(items if items else [("", "（无 NPC 数据）")])
        lay.addWidget(self._sel)
        box = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
        )
        box.accepted.connect(self.accept)
        box.rejected.connect(self.reject)
        lay.addWidget(box)

    def npc_id(self) -> str:
        return self._sel.current_id().strip()


def build_speaker_line_with_inserts(
    parent: QWidget,
    model,
    scene_id: str | None,
    *,
    initial_speaker: str,
    on_change: Callable[[], None],
) -> tuple[QHBoxLayout, QLineEdit]:
    """返回一行：speaker QLineEdit +「插入…」菜单。"""
    hdr = QHBoxLayout()
    hdr.addWidget(QLabel("speaker"), stretch=0)
    sp = QLineEdit(parent)
    sp.setPlaceholderText("留空=旁白；可插入 {{player}} / {{npc}}")
    sp.setText(initial_speaker)
    sp.textChanged.connect(lambda _t: on_change())

    def insert_tok(tok: str) -> None:
        sp.insert(tok)
        on_change()

    def pick_npc() -> None:
        dlg = NpcIdPickDialog(model, scene_id, parent)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        nid = dlg.npc_id()
        if nid:
            insert_tok(f"{{{{npc:{nid}}}}}")

    ins_btn = QPushButton("插入…", parent)
    ins_btn.setToolTip("在光标处插入运行时解析占位")
    menu = QMenu(ins_btn)
    for tok, desc in _SPEAKER_INSERTS:
        act = QAction(f"{tok}  — {desc}", menu)
        act.triggered.connect(lambda _checked=False, t=tok: insert_tok(t))
        menu.addAction(act)
    pick_act = QAction("选择 NPC → 插入 {{npc:id}}…", menu)
    pick_act.triggered.connect(pick_npc)
    menu.addAction(pick_act)
    ins_btn.setMenu(menu)

    hdr.addWidget(sp, stretch=1)
    hdr.addWidget(ins_btn)
    return hdr, sp


class CutsceneShowDialogueFields(QWidget):
    """showDialogue：scriptedNpcId + speaker + text。"""

    def __init__(
        self,
        model,
        scene_id: str | None,
        speaker: str,
        text: str,
        scripted_npc_id: str,
        parent: QWidget | None = None,
        *,
        on_change: Callable[[], None],
    ) -> None:
        super().__init__(parent)
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        form = QFormLayout()
        tip = QLabel("speaker 支持 {{player}} / {{npc}} / {{npc:id}}", self)
        tip.setToolTip("与 playScriptedDialogue 一致；{{npc}} 使用下方 scriptedNpcId 或图对话 npcId。")
        form.addRow(tip)
        self._snpc = IdRefSelector(self, allow_empty=True)
        self._snpc.setMinimumWidth(160)
        self._snpc.set_items(npc_items_for_dialogue_picker(model, scene_id))
        self._snpc.set_current(str(scripted_npc_id or ""))
        self._snpc.value_changed.connect(lambda _v: on_change())
        form.addRow("scriptedNpcId（{{npc}} 默认）", self._snpc)
        sh, self._speaker = build_speaker_line_with_inserts(
            self, model, scene_id, initial_speaker=str(speaker or ""), on_change=on_change,
        )
        form.addRow(sh)
        self._text = QTextEdit(self)
        self._text.setMaximumHeight(80)
        self._text.setPlainText(str(text or ""))
        self._text.textChanged.connect(on_change)
        form.addRow("text", self._text)
        root.addLayout(form)

    def to_step_dict(self) -> dict:
        d: dict = {
            "speaker": self._speaker.text().strip(),
            "text": self._text.toPlainText(),
        }
        sid = self._snpc.current_id().strip()
        if sid:
            d["scriptedNpcId"] = sid
        return d
