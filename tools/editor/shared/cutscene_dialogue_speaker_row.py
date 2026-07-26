"""过场 present:showDialogue 与 playScriptedDialogue 共用的 speaker 行（插入占位 + 可选 scriptedNpcId）。"""
from __future__ import annotations

import re
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
from PySide6.QtCore import Qt
from PySide6.QtGui import QAction

from .id_ref_selector import IdRefSelector
from .rich_text_field import RichTextLineEdit
from .form_layout import compact_form
from .portrait_ref_field import PortraitRefField
from .bubble_anchor_field import (
    BubbleAnchorActor,
    BubbleAnchorPickField,
    actor_for_emote_target,
)
from .collapsible_section import CollapsibleSection

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


#: 运行时保留实体 id：`player` 恒指主角（与 Game.resolveActor / scriptedDialogueSpeaker 同口径）。
PLAYER_ENTITY_ID = "player"


def scripted_speaker_items(model, scene_id: str | None) -> list[tuple[str, str]]:
    """「说话 NPC」（scriptedNpcId）候选：主角恒在首位 + 场景/全工程 NPC。

    主角不是场景 NPC、任何场景的 NPC 表里都没有它，但脚本台词的说话人常常就是主角；
    运行时把 `player` 当保留 id 处理——speaker 里的 {{npc}} 出玩家显示名、「跟随说话人」
    的立绘取主角当前装扮立绘集、「…」气泡锚到主角。
    """
    items = list(npc_items_for_dialogue_picker(model, scene_id))
    if any(str(i[0]) == PLAYER_ENTITY_ID for i in items):
        return items
    return [(PLAYER_ENTITY_ID, "玩家（主角）")] + items


#: speaker 恰好是「一个占位、别无他物」时的形态——下拉与文本框据此双向同步。
_SOLE_PLACEHOLDER_RE = re.compile(r"^\{\{\s*(player|npc)\s*(?::\s*([^}]*?)\s*)?\}\}$")


def speaker_placeholder_entity(text: str) -> str:
    """speaker 整体就是一个占位时返回它指的实体 id；混排文本/字面名/空 → 空串。"""
    m = _SOLE_PLACEHOLDER_RE.match(str(text or "").strip())
    if not m:
        return ""
    kind, ident = m.group(1), (m.group(2) or "").strip()
    if kind == "player":
        return PLAYER_ENTITY_ID
    return ident if ident and ident != "@context" else ""


def speaker_text_for_entity(entity_id: str) -> str:
    """下拉选中的实体 → 写进 speaker 的占位；选空 = 清空（运行时跟说话人走）。"""
    eid = str(entity_id or "").strip()
    if not eid:
        return ""
    return "{{player}}" if eid == PLAYER_ENTITY_ID else f"{{{{npc:{eid}}}}}"


class NpcIdPickDialog(QDialog):
    def __init__(self, model, scene_id: str | None, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("选择 NPC id")
        lay = QVBoxLayout(self)
        self._sel = IdRefSelector(self, allow_empty=False, editable=False, click_opens_popup=True)
        self._sel.setMinimumWidth(160)
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
    rich_refs: bool = False,
    with_speaker_picker: bool = False,
) -> tuple[QHBoxLayout, QLineEdit | RichTextLineEdit]:
    """返回一行：[可选「说话人」下拉] + speaker（QLineEdit 或 RichTextLineEdit）+「插入占位…」菜单。

    rich_refs=True 且 model 非空时使用 RichTextLineEdit，可与正文一致插入 [tag:…]。
    with_speaker_picker=True 时在最左侧挂一个说话人下拉——选一下就把 speaker 写成对应占位，
    是填说话人的最快路径；给本身没有 scriptedNpcId 字段的逐行台词用（showDialogue 已有独立下拉）。
    """
    hdr = QHBoxLayout()
    hdr.setAlignment(Qt.AlignmentFlag.AlignTop)
    hdr.addWidget(QLabel("speaker"), stretch=0)

    use_rich = bool(rich_refs and model)

    hint = "留空=跟说话人走（说话人也没选才是旁白）；点「引用」插入 [tag:…]；或右侧菜单插入占位"
    if use_rich:
        sp = RichTextLineEdit(model, parent)
        sp.setPlaceholderText(hint)
        sp.setText(initial_speaker)

        def insert_tok(tok: str) -> None:
            sp.insert(tok)
            on_change()

        sp.textChanged.connect(lambda *_: on_change())
    else:
        sp_plain = QLineEdit(parent)
        sp_plain.setPlaceholderText("留空=跟说话人走（都没设才是旁白）；可插入 {{player}} / {{npc}}")
        sp_plain.setText(initial_speaker)
        sp_plain.textChanged.connect(lambda *_: on_change())
        sp = sp_plain

        def insert_tok(tok: str) -> None:
            sp_plain.insert(tok)
            on_change()

    if with_speaker_picker:
        picker = IdRefSelector(parent, allow_empty=True, editable=False, click_opens_popup=True)
        picker.setMinimumWidth(130)
        picker.set_items(scripted_speaker_items(model, scene_id))
        picker.set_current(speaker_placeholder_entity(initial_speaker))
        picker.setToolTip(
            "这句谁说的。选一下即把 speaker 写成对应占位（主角→{{player}}、NPC→{{npc:id}}）；\n"
            "显示名、立绘（跟随说话人）、头顶「…」气泡、左右分边全按它走。\n"
            "留空 = 跟本动作的说话人走；两者都没设才是旁白。",
        )

        def _on_pick(_v=None) -> None:
            sp.setText(speaker_text_for_entity(picker.current_id()))
            on_change()

        picker.value_changed.connect(_on_pick)

        def _sync_picker(*_args) -> None:
            """手打/插入占位后回填下拉；混排文本时归到「（空）」，不去猜。"""
            want = speaker_placeholder_entity(sp.text())
            if want == picker.current_id().strip():
                return
            picker.blockSignals(True)
            picker.set_current(want)
            picker.blockSignals(False)

        sp.textChanged.connect(_sync_picker)
        hdr.addWidget(picker, stretch=0)

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
        portrait: dict | None = None,
        bubble_anchor_y: object = None,
        bubble_scale: object = None,
    ) -> None:
        super().__init__(parent)
        self._model = model
        self._scene_id = scene_id
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        form = compact_form(QFormLayout())
        tip = QLabel("speaker：留空即用下方说话人的名字；要改写显示名才填", self)
        tip.setToolTip(
            "最省的写法是只选下方「说话人」、speaker 留空——显示名自动取该实体的名字"
            "（主角随当前主角走）。\n"
            "只有需要盖掉显示名时才填（如匿名的「???」）。speaker 与说话人都没设才是旁白。\n"
            "与 playScriptedDialogue 一致；有工程时单行「引用」与 resolveText 一致。",
        )
        form.addRow(tip)
        self._snpc = IdRefSelector(self, allow_empty=True, editable=False, click_opens_popup=True)
        self._snpc.setMinimumWidth(140)
        self._snpc.set_items(scripted_speaker_items(model, scene_id))
        self._snpc.set_current(str(scripted_npc_id or ""))
        self._snpc.value_changed.connect(lambda _v: on_change())
        self._snpc.setToolTip(
            "本行的说话人实体——填了它这行就齐了：speaker 留空时显示名取它的名字；"
            "立绘选「跟随说话人」时按它的装扮配置取立绘集；说话时头顶「…」锚到它；"
            "左右分边也按它（主角在右并高亮名牌）。主角选「玩家（主角）」。",
        )
        form.addRow("scriptedNpcId（说话人实体）", self._snpc)
        sh, self._speaker = build_speaker_line_with_inserts(
            self,
            model,
            scene_id,
            initial_speaker=str(speaker or ""),
            on_change=on_change,
            rich_refs=bool(model),
        )
        form.addRow(sh)
        self._text = QTextEdit(self)
        self._text.setMinimumHeight(56)
        self._text.setMaximumHeight(160)
        self._text.setPlainText(str(text or ""))
        self._text.textChanged.connect(on_change)
        form.addRow("text", self._text)
        # 立绘：与 playScriptedDialogue 行共用同一个三态选择器（无 / 跟随说话人 / 指定立绘集 + 表情）。
        # 运行时仅过场内的 present:showDialogue 消费它；不触及过场外的 playScriptedDialogue 路径。
        proot = getattr(model, "project_path", None) if model else None
        self._portrait = PortraitRefField(proot, portrait if isinstance(portrait, dict) else None)
        self._portrait.changed.connect(lambda: on_change())
        form.addRow(self._portrait)

        # 说话气泡位置/大小（可选）：与图对话 line 节点、showEmote 同一个控件同一套阶梯。
        # 过场里 present:showDialogue 的「…」气泡以前完全没有可编排字段（opts 恒 undefined）。
        self._bubble = BubbleAnchorPickField(
            self,
            model,
            bubble_anchor_y,
            self._bubble_actor,
            committed_scale=bubble_scale,
        )
        self._bubble.changed.connect(lambda: on_change())
        self._snpc.value_changed.connect(lambda _v: self._bubble.refresh_actor())
        self._bubble_sec = CollapsibleSection("说话气泡位置/大小（可选）", start_open=False, parent=self)
        self._bubble_sec.set_header_tool_tip(
            "过场里这句话时，说话人头顶那个「…」气泡挂多高、多大。\n"
            "默认继承——位置按说话人当前帧内容自动贴头顶，大小按全局 emoteBubbleScale。\n"
            "只有个别情况（举着道具挡住、这句要特别大）才勾覆盖。",
        )
        self._bubble_sec.add_body(self._bubble)
        form.addRow(self._bubble_sec)
        if bubble_anchor_y is not None or bubble_scale is not None:
            self._bubble_sec.set_expanded(True)
        root.addLayout(form)

    def _bubble_actor(self) -> BubbleAnchorActor:
        """预览对象 = scriptedNpcId 指的实体（过场的「当前场景」即 targetScene）。"""
        sid = self._snpc.current_id().strip()
        if not sid:
            return BubbleAnchorActor(hint="先选 scriptedNpcId（说话人实体）才能预览气泡")
        return actor_for_emote_target(self._model, self._scene_id, sid)

    def refresh_scene_scope(self, scene_id: str | None) -> None:
        """过场 targetScene 变更时，把 scriptedNpcId 说话人候选重限定到该场景（保留当前选择）。
        与 showSubtitle 表情锚点、各 action NPC 下拉一致——过场的「当前场景」即 targetScene。"""
        cur = self._snpc.current_id().strip()
        self._scene_id = scene_id
        self._snpc.set_items(scripted_speaker_items(self._model, scene_id))
        self._snpc.set_current(cur)
        self._bubble.refresh_actor()

    def to_step_dict(self) -> dict:
        # speaker 留空不落键：与 scriptedNpcId 同待遇，且「无此键」与「空串」在运行时同义
        # （都走「跟说话人走」）——写空串只会让数据多一行噪声、让往返对不上。
        d: dict = {"text": self._text.toPlainText()}
        spk = self._speaker.text().strip()
        if spk:
            d["speaker"] = spk
        sid = self._snpc.current_id().strip()
        if sid:
            d["scriptedNpcId"] = sid
        por = self._portrait.to_ref()
        if por:
            d["portrait"] = por
        bay = self._bubble.value()
        if bay is not None:
            d["bubbleAnchorY"] = bay
        bsc = self._bubble.scale_value()
        if bsc is not None:
            d["bubbleScale"] = bsc
        return d
