"""Single-node form editor for DialogueGraphNodeDef."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Callable, Optional

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QFormLayout, QLabel, QLineEdit,
    QPlainTextEdit, QComboBox, QTableWidget, QTableWidgetItem, QPushButton,
    QHeaderView, QMessageBox, QCheckBox, QGroupBox,
    QSizePolicy, QSpinBox, QDoubleSpinBox, QStackedWidget, QToolButton, QDialog,
    QStyle, QApplication,
)
from PySide6.QtCore import Qt, QSize, QEventLoop, QEvent
from PySide6.QtGui import QFontMetrics

from tools.editor.shared.condition_expr_tree import ConditionExprTreeRootWidget
from tools.editor.shared.action_editor import (
    _hide_combo_popups_under,
    _dismiss_active_popup_stack,
    _hide_active_application_popups,
    _purge_qcombobox_private_containers,
    _protected_combobox_popup_widget_ids,
    FilterableTypeCombo,
)

from .editor_asset_catalog import load_rule_id_name_pairs
from .node_picker_dialog import NodePickerDialog
from .npc_picker_dialog import NpcPickerDialog


SpeakerKinds = ("player", "npc", "literal", "sceneNpc")

# 与 GraphDialogueManager.resolveSpeaker（sceneNpc）约定一致
PROMPT_LINE_SCENE_NPC_CONTEXT_TOKEN = "@contextNpc"

# 兼容旧调用签名；高度不再按 min_lines 放大（避免在表单/滚动区里被撑成大片空白）
_PLAIN_MIN_LINES = 4


def _plain_text_edit(*, placeholder: str = "", min_lines: int = _PLAIN_MIN_LINES) -> QPlainTextEdit:
    _ = min_lines  # 调用处仍传 min_lines；高度固定为单行级，不再随该参数增高
    w = QPlainTextEdit()
    if placeholder:
        w.setPlaceholderText(placeholder)
    fm = QFontMetrics(w.font())
    lh = max(1, int(fm.lineSpacing()))
    # 单行级高度：长文靠框内滚动，禁止随布局在竖向被拉成「大块空框」
    h = max(24, lh + 14)
    w.setFixedHeight(h)
    w.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
    w.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
    w.setLineWrapMode(QPlainTextEdit.LineWrapMode.WidgetWidth)
    return w


def _form_wrap_rows(fl: QFormLayout) -> None:
    fl.setRowWrapPolicy(QFormLayout.RowWrapPolicy.WrapAllRows)
    fl.setHorizontalSpacing(8)
    fl.setVerticalSpacing(6)


def _compact_row_nav_buttons(
    parent: QWidget,
    *,
    tip_before: str,
    tip_after: str,
    tip_up: str,
    tip_down: str,
    tip_del: str,
    side: int = 24,
) -> tuple[QToolButton, QToolButton, QToolButton, QToolButton, QToolButton]:
    """前插/后插/上移/下移/删除：小图标按钮，含义见 tooltip。"""
    st = parent.style()
    iz = QSize(max(12, side - 8), max(12, side - 8))
    del_pix = getattr(
        QStyle.StandardPixmap,
        "SP_TrashIcon",
        QStyle.StandardPixmap.SP_DialogCancelButton,
    )

    def mk(pix: QStyle.StandardPixmap, tip: str) -> QToolButton:
        b = QToolButton(parent)
        b.setIcon(st.standardIcon(pix))
        b.setIconSize(iz)
        b.setFixedSize(side, side)
        b.setToolTip(tip)
        b.setAutoRaise(True)
        b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        return b

    return (
        mk(QStyle.StandardPixmap.SP_ArrowLeft, tip_before),
        mk(QStyle.StandardPixmap.SP_ArrowRight, tip_after),
        mk(QStyle.StandardPixmap.SP_ArrowUp, tip_up),
        mk(QStyle.StandardPixmap.SP_ArrowDown, tip_down),
        mk(del_pix, tip_del),
    )


def _speaker_to_ui(sp: dict[str, Any]) -> tuple[str, str]:
    k = sp.get("kind", "player")
    if k == "literal":
        return "literal", str(sp.get("name", ""))
    if k == "sceneNpc":
        return "sceneNpc", str(sp.get("npcId", ""))
    return k if k in ("player", "npc") else "player", ""


def _ui_to_speaker(kind: str, extra: str) -> dict[str, Any]:
    if kind == "literal":
        return {"kind": "literal", "name": extra or "旁白"}
    if kind == "sceneNpc":
        return {"kind": "sceneNpc", "npcId": extra or "npc"}
    if kind == "npc":
        return {"kind": "npc"}
    return {"kind": "player"}


class NodeInspector(QWidget):
    """Emits content_changed when user edits."""

    def __init__(
        self,
        list_node_ids: Callable[[], list[str]],
        *,
        project_root: Path,
        project_model_getter: Optional[Callable[[], Any]] = None,
        node_types_getter: Optional[Callable[[], dict[str, str]]] = None,
        parent=None,
    ):
        super().__init__(parent)
        self._list_node_ids = list_node_ids
        self._project_root = project_root
        self._project_model_getter = project_model_getter
        self._node_types_getter = node_types_getter
        self._node_id = ""
        self._suppress_change_emit = False
        self._topology_refs: dict[str, Any] = {}
        self._body_valid = False
        self._assign_editor_group: Callable[[str, str], None] | None = None
        self._create_editor_group: Callable[[], str | None] | None = None
        self._editor_group_geometry_mode = False
        self._root_layout = QVBoxLayout(self)

        self._type_label = QLabel()
        self._type_label.setWordWrap(True)
        self._type_label.setTextFormat(Qt.TextFormat.RichText)
        self._root_layout.addWidget(self._type_label)

        self._body = QWidget()
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        self._root_layout.addWidget(self._body, 0)
        # 多余纵向空间落在底部，避免把表单区纵向压扁导致控件重叠
        self._root_layout.addStretch(1)

        self._clear_body()

    def _clear_body(self) -> None:
        """切换节点类型时整页重建表单；必须拆掉嵌套的 QFormLayout，否则 takeAt 拿不到子布局里的 QLabel，旧标签会残留在 _body 上叠在新控件上。"""
        self._body_valid = False
        self._topology_refs = {}
        old_body = self._body
        # 先收起所有 QComboBox 弹出层再销毁，避免 Windows 上短暂出现独立小窗抢焦点（与 ActionEditor._clear 一致）
        _hide_combo_popups_under(old_body)
        _dismiss_active_popup_stack()
        self._body = QWidget()
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        idx = self._root_layout.indexOf(old_body)
        if idx < 0:
            idx = 1
        self._root_layout.removeWidget(old_body)
        self._root_layout.insertWidget(idx, self._body)
        old_body.deleteLater()
        QApplication.processEvents(QEventLoop.ProcessEventsFlag.ExcludeUserInputEvents)
        QApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        _purge_qcombobox_private_containers()

    def _emit_changed(self):
        # Parent connects to slot that reads get_node()
        if self._suppress_change_emit:
            return
        if hasattr(self, "_change_cb") and self._change_cb:
            self._change_cb()

    def set_change_callback(self, cb):
        self._change_cb = cb

    def set_editor_group_callbacks(
        self,
        assign: Callable[[str, str], None] | None,
        create_group: Callable[[], str | None] | None,
    ) -> None:
        """assign(node_id, group_id_or_empty)；create_group 返回新分组 id 或 None（仅编辑器）。"""
        self._assign_editor_group = assign
        self._create_editor_group = create_group

    def set_editor_group_geometry_mode(self, on: bool) -> None:
        """为 True 时：分组仅由画布分组框几何决定，本面板只读展示。"""
        self._editor_group_geometry_mode = bool(on)

    def set_node(
        self,
        node_id: str,
        data: dict[str, Any],
        *,
        editor_groups: dict[str, dict[str, Any]] | None = None,
        editor_group_for_node: str | None = None,
    ):
        self._suppress_change_emit = True
        try:
            self._node_id = node_id
            self._clear_body()
            t = data.get("type", "?")
            self._type_label.setText(f"节点 id：<b>{node_id}</b>　　类型：<b>{t}</b>")

            if node_id and self._assign_editor_group:
                self._insert_editor_group_row(node_id, editor_groups or {}, editor_group_for_node or "")

            if t == "line":
                self._build_line(data)
            elif t == "runActions":
                self._build_run_actions(data)
            elif t == "choice":
                self._build_choice(data)
            elif t == "switch":
                self._build_switch(data)
            elif t == "end":
                self._body_layout.addWidget(QLabel("结束节点，无额外字段。"))
                self._getter = lambda: {"type": "end"}
            else:
                self._body_layout.addWidget(QLabel(f"未知类型 {t!r}，请用「原始 JSON」在后续版本编辑。"))
                snap = copy.deepcopy(data)
                self._getter = lambda s=snap: copy.deepcopy(s)
        finally:
            self._body_valid = True
            self._suppress_change_emit = False
            _hide_combo_popups_under(self._body)
            _hide_active_application_popups()
            QApplication.processEvents(QEventLoop.ProcessEventsFlag.ExcludeUserInputEvents)
            QApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
            _prot = _protected_combobox_popup_widget_ids(self._body)
            _purge_qcombobox_private_containers(protected_ids=_prot)
            _mw = self.window()
            if _mw is not None:
                _mw.raise_()
                _mw.activateWindow()

    def get_node(self) -> dict[str, Any]:
        """Return current node dict from form state."""
        if not self._body_valid:
            return {"type": "end"}
        getter = getattr(self, "_getter", None)
        if getter:
            return getter()
        return {"type": "end"}

    def update_topology_from_data(self, node_data: dict[str, Any]) -> None:
        """Update connection fields from fresh data without rebuilding the entire form.

        Called when the canvas modifies a connection (next / options[].next / cases[].next /
        defaultNext) so the inspector's QLineEdit widgets reflect the new target without
        losing other in-progress edits.
        """
        refs = self._topology_refs
        if not refs:
            return
        self._suppress_change_emit = True
        try:
            t = refs.get("type")
            if t in ("line", "runActions"):
                ne = refs.get("next_edit")
                if isinstance(ne, QLineEdit):
                    ne.setText(str(node_data.get("next", "")))
            elif t == "choice":
                opts = node_data.get("options") or []
                rows = refs.get("option_rows") or []
                for i, row in enumerate(rows):
                    if i < len(opts) and isinstance(opts[i], dict):
                        nx = row.get("nx")
                        if isinstance(nx, QLineEdit):
                            nx.setText(str(opts[i].get("next", "")))
            elif t == "switch":
                cases = node_data.get("cases") or []
                rows = refs.get("case_rows") or []
                for i, row in enumerate(rows):
                    if i < len(cases) and isinstance(cases[i], dict):
                        nx = row.get("next_edit")
                        if isinstance(nx, QLineEdit):
                            nx.setText(str(cases[i].get("next", "")))
                dn = refs.get("default_next")
                if isinstance(dn, QLineEdit):
                    dn.setText(str(node_data.get("defaultNext", "")))
        finally:
            self._suppress_change_emit = False

    def _insert_editor_group_row(
        self,
        node_id: str,
        group_defs: dict[str, dict[str, Any]],
        current_gid: str,
    ) -> None:
        if self._editor_group_geometry_mode:
            row_w = QWidget()
            h = QHBoxLayout(row_w)
            h.setContentsMargins(0, 0, 0, 0)
            h.addWidget(QLabel("编辑器分组"))
            if current_gid:
                g = group_defs.get(current_gid) or {}
                label = str(g.get("name") or current_gid)
                sub = QLabel(f"{label}（由画布分组框自动判定，拖入/拖出框即可）")
            else:
                sub = QLabel("（无，节点中心不在任一分组框内）")
            sub.setWordWrap(True)
            h.addWidget(sub, 1)
            self._body_layout.addWidget(row_w)
            return
        row_w = QWidget()
        h = QHBoxLayout(row_w)
        h.setContentsMargins(0, 0, 0, 0)
        h.addWidget(QLabel("编辑器分组"))
        cb = QComboBox()
        cb.addItem("(无)", "")
        for gid in sorted(group_defs.keys(), key=lambda x: (x.lower(), x)):
            g = group_defs.get(gid) or {}
            label = str(g.get("name") or gid)
            cb.addItem(label, gid)
        cb.addItem("新建分组…", "__new__")
        ix = cb.findData(current_gid)
        cb.setCurrentIndex(max(0, ix))

        def on_change(_i: int) -> None:
            if self._suppress_change_emit:
                return
            d = cb.currentData()
            if d == "__new__":
                cb.blockSignals(True)
                cb.setCurrentIndex(max(0, cb.findData(current_gid)))
                cb.blockSignals(False)
                if self._create_editor_group:
                    new_id = self._create_editor_group()
                    if new_id and self._assign_editor_group:
                        self._assign_editor_group(node_id, new_id)
                return
            if self._assign_editor_group:
                self._assign_editor_group(node_id, str(d) if d else "")

        cb.currentIndexChanged.connect(on_change)
        h.addWidget(cb, 1)
        self._body_layout.addWidget(row_w)

    # --- line ---
    def _build_line(self, data: dict[str, Any]):
        lines_raw = data.get("lines")
        use_multi = isinstance(lines_raw, list) and len(lines_raw) > 0
        cb_multi = QCheckBox("多拍连续对白（每句点击继续；存为 lines 数组）")
        cb_multi.setChecked(use_multi)

        beats_wrap = QWidget()
        beats_v = QVBoxLayout(beats_wrap)
        beats_v.setContentsMargins(0, 0, 0, 0)
        rows_wrap = QWidget()
        rows_layout = QVBoxLayout(rows_wrap)
        rows_layout.setContentsMargins(0, 0, 0, 0)
        rows_layout.setSpacing(4)
        beat_rows: list[dict[str, Any]] = []

        def refresh_beat_nav_buttons() -> None:
            n = len(beat_rows)
            for i, r in enumerate(beat_rows):
                r["btn_up"].setEnabled(i > 0)
                r["btn_down"].setEnabled(i < n - 1)

        def refresh_beat_fold_policy() -> None:
            single = len(beat_rows) <= 1
            for r in beat_rows:
                t = r.get("toggle")
                c = r.get("content")
                if t is None or c is None:
                    continue
                if single:
                    t.setVisible(False)
                    r["collapsed"] = False
                    c.setVisible(True)
                    t.setArrowType(Qt.ArrowType.DownArrow)
                else:
                    t.setVisible(True)
                    r["collapsed"] = True
                    c.setVisible(False)
                    t.setArrowType(Qt.ArrowType.RightArrow)

        def rebuild_beats_rows_layout() -> None:
            while rows_layout.count():
                it = rows_layout.takeAt(0)
                w = it.widget()
                if w is not None:
                    w.setParent(None)
            for r in beat_rows:
                rows_layout.addWidget(r["outer"])

        def make_beat_block(beat: dict[str, Any] | None) -> dict[str, Any]:
            row: dict[str, Any] = {"collapsed": True}
            outer = QWidget()
            ov = QVBoxLayout(outer)
            ov.setContentsMargins(0, 0, 0, 0)
            ov.setSpacing(4)

            header = QHBoxLayout()
            toggle = QToolButton()
            toggle.setAutoRaise(True)
            toggle.setArrowType(Qt.ArrowType.RightArrow)
            toggle.setToolTip("折叠 / 展开本句详细表单")
            summary = QLabel()
            summary.setWordWrap(False)
            summary.setStyleSheet("color: #ccc;")

            btn_ins_before, btn_ins_after, btn_up, btn_down, btn_del = (
                _compact_row_nav_buttons(
                    outer,
                    tip_before="在此句之前插入空白一句",
                    tip_after="在此句之后插入空白一句",
                    tip_up="整条句子上移",
                    tip_down="整条句子下移",
                    tip_del="删除此句（至少保留一句）",
                )
            )

            header.addWidget(toggle)
            header.addWidget(summary, 1)
            header.addWidget(btn_ins_before)
            header.addWidget(btn_ins_after)
            header.addWidget(btn_up)
            header.addWidget(btn_down)
            header.addWidget(btn_del)

            content = QWidget()
            o_fl = QFormLayout(content)
            _form_wrap_rows(o_fl)

            spb = (beat or {}).get("speaker") if isinstance(beat, dict) else None
            if not isinstance(spb, dict):
                spb = {"kind": "player"}
            bk, bex = _speaker_to_ui(spb)
            kcb = QComboBox()
            for sk in SpeakerKinds:
                kcb.addItem(sk, sk)
            kcb.setCurrentIndex(max(0, kcb.findData(bk)))
            exed = QLineEdit(bex)
            tx_plain = _plain_text_edit(placeholder="本句对白正文", min_lines=2)
            tx_plain.setPlainText(
                str((beat or {}).get("text", "") if isinstance(beat, dict) else "")
            )
            tked = QLineEdit(
                str((beat or {}).get("textKey", "") if isinstance(beat, dict) else "")
            )
            tked.setPlaceholderText("可选：strings 键")

            def update_summary() -> None:
                kk = kcb.currentData()
                sk = str(kk) if kk is not None else ""
                tx = tx_plain.toPlainText().strip().replace("\n", " ")
                if len(tx) > 36:
                    tx = tx[:33] + "…"
                if not tx:
                    tx = "—"
                summary.setText(f"{sk}  ·  {tx}")

            def upd_ex() -> None:
                kk = kcb.currentData()
                exed.setVisible(kk in ("literal", "sceneNpc"))

            kcb.currentIndexChanged.connect(
                lambda _i: (upd_ex(), update_summary(), self._emit_changed())
            )
            exed.textChanged.connect(self._emit_changed)
            tx_plain.textChanged.connect(self._emit_changed)
            tked.textChanged.connect(self._emit_changed)
            upd_ex()

            o_fl.addRow("说话人 kind", kcb)
            o_fl.addRow("名字 / npcId", exed)
            o_fl.addRow("text", tx_plain)
            o_fl.addRow("textKey（可选）", tked)

            def flip_collapse() -> None:
                row["collapsed"] = not row["collapsed"]
                content.setVisible(not row["collapsed"])
                toggle.setArrowType(
                    Qt.ArrowType.RightArrow if row["collapsed"] else Qt.ArrowType.DownArrow
                )

            toggle.clicked.connect(flip_collapse)
            tx_plain.textChanged.connect(update_summary)
            update_summary()

            def row_index() -> int:
                return beat_rows.index(row)

            def do_insert_before() -> None:
                insert_blank_beat_at(row_index())

            def do_insert_after() -> None:
                insert_blank_beat_at(row_index() + 1)

            def do_move_up() -> None:
                i = row_index()
                if i <= 0:
                    return
                beat_rows[i - 1], beat_rows[i] = beat_rows[i], beat_rows[i - 1]
                rebuild_beats_rows_layout()
                refresh_beat_nav_buttons()
                self._emit_changed()

            def do_move_down() -> None:
                i = row_index()
                if i < 0 or i >= len(beat_rows) - 1:
                    return
                beat_rows[i + 1], beat_rows[i] = beat_rows[i], beat_rows[i + 1]
                rebuild_beats_rows_layout()
                refresh_beat_nav_buttons()
                self._emit_changed()

            def do_delete() -> None:
                if len(beat_rows) <= 1:
                    QMessageBox.information(self, "多拍对白", "至少保留一句台词。")
                    return
                i = row_index()
                beat_rows.pop(i)
                rows_layout.removeWidget(outer)
                outer.deleteLater()
                refresh_beat_nav_buttons()
                refresh_beat_fold_policy()
                self._emit_changed()

            btn_ins_before.clicked.connect(do_insert_before)
            btn_ins_after.clicked.connect(do_insert_after)
            btn_up.clicked.connect(do_move_up)
            btn_down.clicked.connect(do_move_down)
            btn_del.clicked.connect(do_delete)

            ov.addLayout(header)
            ov.addWidget(content)
            content.setVisible(False)

            row.update(
                {
                    "outer": outer,
                    "toggle": toggle,
                    "content": content,
                    "kcb": kcb,
                    "exed": exed,
                    "tx_plain": tx_plain,
                    "tked": tked,
                    "btn_up": btn_up,
                    "btn_down": btn_down,
                }
            )
            return row

        def insert_blank_beat_at(pos: int) -> None:
            nb = make_beat_block(
                {"speaker": {"kind": "player"}, "text": "", "textKey": ""}
            )
            pos = max(0, min(pos, len(beat_rows)))
            beat_rows.insert(pos, nb)
            rebuild_beats_rows_layout()
            refresh_beat_nav_buttons()
            refresh_beat_fold_policy()
            self._emit_changed()

        if use_multi:
            for b in lines_raw:
                if isinstance(b, dict):
                    beat_rows.append(make_beat_block(b))
        else:
            beat_rows.append(
                make_beat_block(
                    {
                        "speaker": data.get("speaker") or {"kind": "player"},
                        "text": data.get("text", ""),
                        "textKey": data.get("textKey", ""),
                    }
                )
            )
        rebuild_beats_rows_layout()
        refresh_beat_nav_buttons()
        refresh_beat_fold_policy()

        bbar = QHBoxLayout()
        b_add_end = QPushButton("在末尾添加一句")
        b_add_end.setToolTip("在列表最后追加一条空白句")

        def do_add_end_beat() -> None:
            insert_blank_beat_at(len(beat_rows))

        b_add_end.clicked.connect(do_add_end_beat)
        bbar.addWidget(b_add_end)

        beats_v.addWidget(rows_wrap)
        beats_v.addLayout(bbar)

        sp = data.get("speaker") or {"kind": "player"}
        if not isinstance(sp, dict):
            sp = {"kind": "player"}
        kind, extra = _speaker_to_ui(sp)

        kind_cb = QComboBox()
        for k in SpeakerKinds:
            kind_cb.addItem(k, k)
        idx = kind_cb.findData(kind)
        kind_cb.setCurrentIndex(max(0, idx))
        extra_edit = QLineEdit(extra)
        text_edit = _plain_text_edit(placeholder="对白正文")
        text_edit.setPlainText(str(data.get("text", "")))
        text_key = QLineEdit(str(data.get("textKey", "")))
        text_key.setPlaceholderText("可选：strings 键")
        legacy_wrap = QWidget()
        leg_l = QFormLayout(legacy_wrap)
        _form_wrap_rows(leg_l)
        leg_l.addRow("说话人 kind", kind_cb)
        leg_l.addRow("名字 / npcId", extra_edit)
        leg_l.addRow("text", text_edit)
        leg_l.addRow("textKey（可选）", text_key)

        def upd_extra_label():
            k = kind_cb.currentData()
            extra_edit.setVisible(k in ("literal", "sceneNpc"))
            extra_edit.setPlaceholderText("显示名" if k == "literal" else "npcId")

        kind_cb.currentIndexChanged.connect(lambda _: (upd_extra_label(), self._emit_changed()))
        for w in (extra_edit, text_edit, text_key):
            if isinstance(w, QPlainTextEdit):
                w.textChanged.connect(self._emit_changed)
            else:
                w.textChanged.connect(self._emit_changed)
        upd_extra_label()

        next_edit = QLineEdit(str(data.get("next", "")))
        next_edit.setPlaceholderText("下一节点 id")
        pick = QPushButton("选…")
        pick.clicked.connect(lambda: self._pick_target(next_edit))
        next_edit.textChanged.connect(self._emit_changed)

        def toggle_multi():
            on = cb_multi.isChecked()
            legacy_wrap.setVisible(not on)
            beats_wrap.setVisible(on)
            self._emit_changed()

        cb_multi.toggled.connect(lambda _c: toggle_multi())
        toggle_multi()

        row_n = QHBoxLayout()
        row_n.addWidget(next_edit)
        row_n.addWidget(pick)
        fln = QFormLayout()
        _form_wrap_rows(fln)
        fln.addRow("next", row_n)

        self._body_layout.addWidget(cb_multi)
        self._body_layout.addWidget(legacy_wrap)
        self._body_layout.addWidget(beats_wrap)
        self._body_layout.addLayout(fln)
        self._topology_refs = {"type": "line", "next_edit": next_edit}

        def collect_beats() -> list[dict[str, Any]]:
            out_beats: list[dict[str, Any]] = []
            for r in beat_rows:
                kcb = r["kcb"]
                exed = r["exed"]
                tx_plain = r["tx_plain"]
                tked = r["tked"]
                if (
                    not isinstance(kcb, QComboBox)
                    or not isinstance(exed, QLineEdit)
                    or not isinstance(tx_plain, QPlainTextEdit)
                    or not isinstance(tked, QLineEdit)
                ):
                    continue
                kk = kcb.currentData()
                ex = exed.text().strip()
                b = {"speaker": _ui_to_speaker(kk, ex)}
                tx = tx_plain.toPlainText().strip()
                if tx:
                    b["text"] = tx
                tk = tked.text().strip()
                if tk:
                    b["textKey"] = tk
                out_beats.append(b)
            return out_beats

        def getter():
            nxt = next_edit.text().strip()
            if cb_multi.isChecked():
                beats = collect_beats()
                if not beats:
                    raise ValueError("多拍模式至少保留一句台词")
                first = beats[0]
                out: dict[str, Any] = {
                    "type": "line",
                    "speaker": first["speaker"],
                    "next": nxt,
                    "lines": beats,
                }
                if first.get("text") is not None:
                    out["text"] = first.get("text", "")
                if first.get("textKey"):
                    out["textKey"] = first["textKey"]
                return out
            k = kind_cb.currentData()
            ex = extra_edit.text().strip()
            out = {
                "type": "line",
                "speaker": _ui_to_speaker(k, ex),
                "next": nxt,
            }
            tx = text_edit.toPlainText()
            if tx.strip():
                out["text"] = tx
            tk = text_key.text().strip()
            if tk:
                out["textKey"] = tk
            return out

        self._getter = getter

    # --- runActions ---
    def _build_run_actions(self, data: dict[str, Any]):
        from tools.editor.shared.action_editor import ActionEditor

        acts = data.get("actions")
        if not isinstance(acts, list):
            acts = []
        next_edit = QLineEdit(str(data.get("next", "")))
        pick = QPushButton("选…")
        pick.clicked.connect(lambda: self._pick_target(next_edit))
        next_edit.textChanged.connect(self._emit_changed)

        fl = QFormLayout()
        _form_wrap_rows(fl)
        row = QHBoxLayout()
        row.addWidget(next_edit)
        row.addWidget(pick)
        fl.addRow("next", row)
        self._body_layout.addLayout(fl)

        pm = self._project_model_getter() if self._project_model_getter else None
        ae = ActionEditor("动作（与主编辑器 Action列表同源）", self, show_reorder_buttons=True)
        ae.set_project_context(pm, None)
        to_load: list[dict[str, Any]] = []
        if acts:
            for a in acts:
                if isinstance(a, dict):
                    to_load.append(a)
        if not to_load:
            to_load = [{"type": "setFlag", "params": {"key": "", "value": True}}]
        ae.set_data(to_load)
        ae.changed.connect(self._emit_changed)
        self._body_layout.addWidget(ae)
        self._topology_refs = {"type": "runActions", "next_edit": next_edit}

        def getter():
            return {
                "type": "runActions",
                "actions": ae.to_list(),
                "next": next_edit.text().strip(),
            }

        self._getter = getter

    @staticmethod
    def _set_combo_current_data(cb: QComboBox, value: str) -> None:
        val = (value or "").strip()
        idx = cb.findData(val)
        if idx >= 0:
            cb.setCurrentIndex(idx)
        elif val:
            cb.insertItem(1, f"{val}（资源扫描未收录，请核对或补全数据后重选）", val)
            cb.setCurrentIndex(1)
        else:
            cb.setCurrentIndex(0)

    @staticmethod
    def _make_cost_coins_spin(on_change) -> QSpinBox:
        sp = QSpinBox()
        sp.setRange(-1, 9_999_999)
        sp.setSingleStep(1)
        sp.setSpecialValueText("无（不校验铜钱）")
        sp.setValue(-1)
        sp.setToolTip(
            "运行时与 flagStore 中的 coins 比较；仅当玩家持有不少于该数额时才可选。"
            "选「无」不写 costCoins 字段。"
        )
        sp.valueChanged.connect(on_change)
        return sp

    @staticmethod
    def _set_cost_coins_spin(sp: QSpinBox, raw_val: object) -> None:
        if raw_val is None or raw_val == "":
            sp.setValue(-1)
            return
        try:
            n = int(raw_val)
        except (TypeError, ValueError):
            sp.setValue(-1)
            return
        if n < 0:
            sp.setValue(-1)
        else:
            sp.setValue(min(n, sp.maximum()))

    # --- choice ---
    def _build_choice(self, data: dict[str, Any]):
        # promptLine optional
        pl = data.get("promptLine")
        has_pl = isinstance(pl, dict) and bool(pl)
        cb_pl = QCheckBox("有 promptLine（选项前多播一行）")
        cb_pl.setChecked(bool(has_pl))

        sp = (pl or {}).get("speaker") if has_pl else {"kind": "player"}
        if not isinstance(sp, dict):
            sp = {"kind": "player"}
        kind, extra = _speaker_to_ui(sp)
        pl_kind = QComboBox()
        for k in SpeakerKinds:
            pl_kind.addItem(k, k)
        pl_kind.setCurrentIndex(max(0, pl_kind.findData(kind)))
        pl_extra_stack = QStackedWidget()
        pl_extra_line = QLineEdit()
        pl_npc_wrap = QWidget()
        pl_npc_lo = QHBoxLayout(pl_npc_wrap)
        pl_npc_lo.setContentsMargins(0, 0, 0, 0)
        pl_npc_edit = QLineEdit()
        pl_npc_edit.setPlaceholderText("手输 npcId或点「选…」在对话框中搜索")
        pl_npc_edit.setToolTip(
            "可手输任意 npcId。\n"
            f"点「选…」打开可搜索列表（含「{PROMPT_LINE_SCENE_NPC_CONTEXT_TOKEN}」=进入图时传入的 npcId）。"
        )
        pl_npc_btn = QPushButton("选…")
        pl_npc_btn.setToolTip("打开可搜索的 NPC 列表")
        pl_npc_lo.addWidget(pl_npc_edit, 1)
        pl_npc_lo.addWidget(pl_npc_btn)
        if kind == "literal":
            pl_extra_line.setText(extra)
        elif kind == "sceneNpc":
            pl_npc_edit.setText(extra)
        pl_extra_stack.addWidget(pl_extra_line)
        pl_extra_stack.addWidget(pl_npc_wrap)
        if kind == "literal":
            pl_extra_stack.setCurrentWidget(pl_extra_line)
        else:
            pl_extra_stack.setCurrentWidget(pl_npc_wrap)

        def _pl_npc_entries() -> list[tuple[str, str]]:
            ent: list[tuple[str, str]] = [
                (
                    PROMPT_LINE_SCENE_NPC_CONTEXT_TOKEN,
                    "当前对话 NPC（进入图时的 npcId）",
                )
            ]
            pm_pl = self._project_model_getter() if self._project_model_getter else None
            if pm_pl:
                ent.extend(pm_pl.all_npc_ids_global())
            return ent

        def _open_pl_npc_picker() -> None:
            dlg = NpcPickerDialog(
                _pl_npc_entries(),
                title="选择 promptLine · sceneNpc",
                initial_id=pl_npc_edit.text().strip(),
                parent=self,
            )
            if dlg.exec() == QDialog.DialogCode.Accepted:
                pl_npc_edit.setText(dlg.selected_id())
                self._emit_changed()

        pl_npc_btn.clicked.connect(_open_pl_npc_picker)
        pl_extra_lbl = QLabel()
        pl_text = _plain_text_edit(placeholder="选项前多播一行对白")
        pl_text.setPlainText(str((pl or {}).get("text", "")))

        prompt_box = QGroupBox("promptLine")
        pfl = QFormLayout()
        _form_wrap_rows(pfl)
        pfl.addRow("kind", pl_kind)
        pfl.addRow(pl_extra_lbl, pl_extra_stack)
        pfl.addRow("text", pl_text)
        prompt_box.setLayout(pfl)
        prompt_box.setVisible(has_pl)

        def pl_refresh_extra_row(_i: int = -1) -> None:
            del _i
            kk = pl_kind.currentData()
            if kk == "literal":
                pl_extra_lbl.setText("显示名（literal）")
                pl_extra_stack.setCurrentWidget(pl_extra_line)
                pl_extra_stack.setVisible(True)
            elif kk == "sceneNpc":
                pl_extra_lbl.setText("npcId（sceneNpc）")
                pl_extra_stack.setCurrentWidget(pl_npc_wrap)
                pl_extra_stack.setVisible(True)
            else:
                pl_extra_stack.setVisible(False)

        pl_refresh_extra_row()

        def toggle_pl():
            prompt_box.setVisible(cb_pl.isChecked())
            self._emit_changed()

        cb_pl.toggled.connect(toggle_pl)
        pl_kind.currentIndexChanged.connect(
            lambda _i: (pl_refresh_extra_row(_i), self._emit_changed())
        )
        pl_extra_line.textChanged.connect(self._emit_changed)
        pl_npc_edit.textChanged.connect(self._emit_changed)
        pl_text.textChanged.connect(self._emit_changed)

        self._body_layout.addWidget(cb_pl)
        self._body_layout.addWidget(prompt_box)

        opts = data.get("options")
        if not isinstance(opts, list):
            opts = []
        rows_wrap = QWidget()
        rows_layout = QVBoxLayout(rows_wrap)
        rows_layout.setContentsMargins(0, 0, 0, 0)
        option_rows: list[dict[str, Any]] = []
        rule_pairs = load_rule_id_name_pairs(self._project_root)

        def refresh_choice_nav_buttons() -> None:
            n = len(option_rows)
            for i, r in enumerate(option_rows):
                r["btn_up"].setEnabled(i > 0)
                r["btn_down"].setEnabled(i < n - 1)

        def refresh_choice_fold_policy() -> None:
            single = len(option_rows) <= 1
            for r in option_rows:
                t = r.get("toggle")
                c = r.get("content")
                if t is None or c is None:
                    continue
                if single:
                    t.setVisible(False)
                    r["collapsed"] = False
                    c.setVisible(True)
                    t.setArrowType(Qt.ArrowType.DownArrow)
                else:
                    t.setVisible(True)
                    r["collapsed"] = True
                    c.setVisible(False)
                    t.setArrowType(Qt.ArrowType.RightArrow)

        def rebuild_choice_rows_layout() -> None:
            while rows_layout.count():
                it = rows_layout.takeAt(0)
                w = it.widget()
                if w is not None:
                    w.setParent(None)
            for r in option_rows:
                rows_layout.addWidget(r["outer"])

        def make_option_block(od: dict[str, Any]) -> dict[str, Any]:
            row: dict[str, Any] = {"collapsed": True}
            outer = QWidget()
            ov = QVBoxLayout(outer)
            ov.setContentsMargins(0, 0, 0, 0)
            ov.setSpacing(4)

            header = QHBoxLayout()
            toggle = QToolButton()
            toggle.setAutoRaise(True)
            toggle.setArrowType(Qt.ArrowType.RightArrow)
            toggle.setToolTip("折叠 / 展开本条详细表单")
            summary = QLabel()
            summary.setWordWrap(False)
            summary.setStyleSheet("color: #ccc;")

            btn_ins_before, btn_ins_after, btn_up, btn_down, btn_del = (
                _compact_row_nav_buttons(
                    outer,
                    tip_before="在此选项之前插入一条空白选项",
                    tip_after="在此选项之后插入一条空白选项",
                    tip_up="整条选项上移",
                    tip_down="整条选项下移",
                    tip_del="删除此选项（至少保留一项）",
                )
            )

            header.addWidget(toggle)
            header.addWidget(summary, 1)
            header.addWidget(btn_ins_before)
            header.addWidget(btn_ins_after)
            header.addWidget(btn_up)
            header.addWidget(btn_down)
            header.addWidget(btn_del)

            content = QWidget()
            o_fl = QFormLayout(content)
            _form_wrap_rows(o_fl)
            id_e = QLineEdit(str(od.get("id", "")))
            text_e = _plain_text_edit(placeholder="玩家看到的选项文字", min_lines=2)
            text_e.setPlainText(str(od.get("text", "")))
            nx = QLineEdit(str(od.get("next", "")))
            pick = QPushButton("选…")
            pick.clicked.connect(lambda _c=False, le=nx: self._pick_target(le))
            nx_lo = QHBoxLayout()
            nx_lo.addWidget(nx, 1)
            nx_lo.addWidget(pick)

            rf_wrap = QWidget()
            rf_lo = QHBoxLayout(rf_wrap)
            rf_lo.setContentsMargins(0, 0, 0, 0)
            rf_edit = QLineEdit(str(od.get("requireFlag", "") or ""))
            rf_edit.setReadOnly(True)
            rf_edit.setPlaceholderText(
                "（无）点「选择…」打开登记表（与主编辑器 Flag 选择器相同）"
            )
            rf_edit.setToolTip("仅当 flagStore 中该键为真时选项可选；须从登记表选取以保证键名一致。")
            rf_pick = QPushButton("选择…")
            rf_clear = QPushButton("清除")

            def do_pick_rf() -> None:
                getter = self._project_model_getter
                pm = getter() if getter else None
                if pm is None:
                    QMessageBox.warning(
                        self,
                        "requireFlag",
                        "无法加载工程 ProjectModel。\n"
                        "请从游戏工程根目录启动图对话编辑器（与 public/assets 同级），并确保可导入 tools.editor。\n"
                        "框内仍会显示 JSON 里已有的键（只读）。",
                    )
                    return
                from tools.editor.shared.flag_picker_dialog import FlagPickerDialog
                from tools.editor.flag_registry import registry_value_type_for_key

                dlg = FlagPickerDialog(pm, None, rf_edit.text().strip(), self)
                if dlg.exec() != QDialog.DialogCode.Accepted:
                    return
                k = dlg.selected_key().strip()
                rf_edit.setText(k)
                if k:
                    reg_type = registry_value_type_for_key(k, pm.flag_registry)
                    if reg_type is not None and reg_type != "bool":
                        QMessageBox.warning(
                            self,
                            "requireFlag 类型提示",
                            f"登记表中「{k}」的值类型为「{reg_type}」；"
                            "本选项仅按布尔真值判断 flagStore 是否满足。\n\n"
                            "请确认设计意图；仅提示，不阻止保存。",
                        )
                self._emit_changed()

            def do_clear_rf() -> None:
                if rf_edit.text():
                    rf_edit.setText("")
                    self._emit_changed()

            rf_pick.clicked.connect(do_pick_rf)
            rf_clear.clicked.connect(do_clear_rf)
            rf_lo.addWidget(rf_edit, 1)
            rf_lo.addWidget(rf_pick)
            rf_lo.addWidget(rf_clear)

            cost_sp = self._make_cost_coins_spin(self._emit_changed)
            self._set_cost_coins_spin(cost_sp, od.get("costCoins"))

            from tools.editor.shared.action_editor import FilterableTypeCombo

            rh_entries: list[tuple[str, str]] = [
                ("(无：不标规矩样式)", ""),
            ]
            for rid, rname in rule_pairs:
                rh_entries.append((f"{rname}（{rid}）", rid))
            rh_cb = FilterableTypeCombo(rh_entries, self)
            rh_cb.setToolTip(
                "对话 UI 上「规矩」标签与配色；与 requireFlag 是否满足无关。\n"
                "若下方「灰显点击提示」留空，锁定时会用 strings 中 choiceNeedRule 并结合该规矩名称生成说明。"
            )
            rh_cb.set_committed_type(str(od.get("ruleHintId", "") or ""))
            rh_cb.typeCommitted.connect(lambda _t: self._emit_changed())

            hint_plain = _plain_text_edit(
                placeholder="可选。选项灰显时玩家点击后弹出此处全文；留空则由游戏按规矩名/铜钱等自动生成。",
                min_lines=2,
            )
            hint_plain.setPlainText(str(od.get("disabledClickHint", "") or ""))
            hint_plain.textChanged.connect(self._emit_changed)

            o_fl.addRow("选项 id", id_e)
            o_fl.addRow("选项文案", text_e)
            wnx = QWidget()
            wnx.setLayout(nx_lo)
            o_fl.addRow("连线至 next", wnx)
            o_fl.addRow("前提标志 requireFlag", rf_wrap)
            o_fl.addRow("花费铜钱 costCoins", cost_sp)
            o_fl.addRow("关联规矩 ruleHintId", rh_cb)
            o_fl.addRow("灰显时点击提示 disabledClickHint", hint_plain)

            req_g = QGroupBox(
                "可选：requireCondition（ConditionExpr；与 requireFlag 同时存在则均须满足）",
            )
            rg_l = QVBoxLayout(req_g)

            def _pm_get() -> Any:
                return self._project_model_getter() if self._project_model_getter else None

            req_tree = ConditionExprTreeRootWidget(model_getter=_pm_get)
            rc0 = od.get("requireCondition")
            if isinstance(rc0, dict):
                req_tree.set_expr(rc0)
            else:
                req_tree.set_expr(None)
            req_tree.changed.connect(self._emit_changed)
            rg_l.addWidget(req_tree)
            o_fl.addRow(req_g)

            def update_summary() -> None:
                oid = id_e.text().strip() or "(未填 id)"
                tx = text_e.toPlainText().strip().replace("\n", " ")
                if len(tx) > 36:
                    tx = tx[:33] + "…"
                if not tx:
                    tx = "—"
                summary.setText(f"{oid}  ·  {tx}")

            def flip_collapse() -> None:
                row["collapsed"] = not row["collapsed"]
                content.setVisible(not row["collapsed"])
                toggle.setArrowType(
                    Qt.ArrowType.RightArrow if row["collapsed"] else Qt.ArrowType.DownArrow
                )

            toggle.clicked.connect(flip_collapse)
            id_e.textChanged.connect(update_summary)
            text_e.textChanged.connect(update_summary)
            id_e.textChanged.connect(self._emit_changed)
            nx.textChanged.connect(self._emit_changed)
            text_e.textChanged.connect(self._emit_changed)
            update_summary()

            def row_index() -> int:
                return option_rows.index(row)

            def do_insert_before() -> None:
                insert_blank_option_at(row_index())

            def do_insert_after() -> None:
                insert_blank_option_at(row_index() + 1)

            def do_move_up() -> None:
                i = row_index()
                if i <= 0:
                    return
                option_rows[i - 1], option_rows[i] = option_rows[i], option_rows[i - 1]
                rebuild_choice_rows_layout()
                refresh_choice_nav_buttons()
                self._emit_changed()

            def do_move_down() -> None:
                i = row_index()
                if i < 0 or i >= len(option_rows) - 1:
                    return
                option_rows[i + 1], option_rows[i] = option_rows[i], option_rows[i + 1]
                rebuild_choice_rows_layout()
                refresh_choice_nav_buttons()
                self._emit_changed()

            def do_delete() -> None:
                if len(option_rows) <= 1:
                    QMessageBox.information(self, "选项", "至少保留一个选项。")
                    return
                i = row_index()
                option_rows.pop(i)
                rows_layout.removeWidget(outer)
                outer.deleteLater()
                refresh_choice_nav_buttons()
                refresh_choice_fold_policy()
                self._emit_changed()

            btn_ins_before.clicked.connect(do_insert_before)
            btn_ins_after.clicked.connect(do_insert_after)
            btn_up.clicked.connect(do_move_up)
            btn_down.clicked.connect(do_move_down)
            btn_del.clicked.connect(do_delete)

            ov.addLayout(header)
            ov.addWidget(content)
            content.setVisible(False)

            row.update(
                {
                    "outer": outer,
                    "toggle": toggle,
                    "content": content,
                    "id_e": id_e,
                    "text_e": text_e,
                    "nx": nx,
                    "rf_edit": rf_edit,
                    "req_tree": req_tree,
                    "cost_sp": cost_sp,
                    "rh_cb": rh_cb,
                    "hint_plain": hint_plain,
                    "btn_up": btn_up,
                    "btn_down": btn_down,
                }
            )
            return row

        def insert_blank_option_at(pos: int) -> None:
            blank = {"id": "", "text": "", "next": ""}
            nb = make_option_block(blank)
            pos = max(0, min(pos, len(option_rows)))
            option_rows.insert(pos, nb)
            rebuild_choice_rows_layout()
            refresh_choice_nav_buttons()
            refresh_choice_fold_policy()
            self._emit_changed()

        if opts:
            for od in opts:
                if isinstance(od, dict):
                    option_rows.append(make_option_block(od))
        else:
            option_rows.append(
                make_option_block({"id": "a", "text": "选项甲", "next": ""})
            )
        rebuild_choice_rows_layout()
        refresh_choice_nav_buttons()
        refresh_choice_fold_policy()

        obar = QHBoxLayout()
        b_add = QPushButton("在末尾添加选项")
        b_add.setToolTip("在列表最后追加一条空白选项")

        def do_add_end() -> None:
            insert_blank_option_at(len(option_rows))

        b_add.clicked.connect(do_add_end)
        obar.addWidget(b_add)

        self._body_layout.addWidget(
            QLabel(
                "选项：requireFlag 登记表；requireCondition 为 ConditionExpr；"
                "ruleHintId 规矩样式；disabledClickHint 灰显点击全文提示。"
            )
        )
        self._body_layout.addWidget(rows_wrap)
        self._body_layout.addLayout(obar)

        def getter():
            options: list[dict[str, Any]] = []
            for idx_r, r in enumerate(option_rows):
                oid = r["id_e"].text().strip()
                if not oid:
                    raise ValueError(f"选项 {idx_r + 1} 未填 id，请补全后再保存")
                out_opt: dict[str, Any] = {
                    "id": oid,
                    "text": r["text_e"].toPlainText(),
                    "next": r["nx"].text().strip(),
                }
                rf_s = r["rf_edit"].text().strip()
                if rf_s:
                    out_opt["requireFlag"] = rf_s
                rcx = r["req_tree"].get_expr()
                if rcx is not None:
                    out_opt["requireCondition"] = rcx
                if r["cost_sp"].value() >= 0:
                    out_opt["costCoins"] = r["cost_sp"].value()
                rh_val = r["rh_cb"].committed_type()
                if isinstance(rh_val, str) and rh_val.strip():
                    out_opt["ruleHintId"] = rh_val.strip()
                hint_s = r["hint_plain"].toPlainText().strip()
                if hint_s:
                    out_opt["disabledClickHint"] = hint_s
                options.append(out_opt)
            out: dict[str, Any] = {"type": "choice", "options": options}
            if cb_pl.isChecked():
                k = pl_kind.currentData()
                if k == "literal":
                    ex = pl_extra_line.text().strip()
                elif k == "sceneNpc":
                    ex = pl_npc_edit.text().strip()
                else:
                    ex = ""
                out["promptLine"] = {
                    "speaker": _ui_to_speaker(k, ex),
                    "text": pl_text.toPlainText(),
                }
            return out

        self._getter = getter
        self._topology_refs = {"type": "choice", "option_rows": option_rows}

    # --- switch ---
    def _build_switch(self, data: dict[str, Any]):
        cases_raw = data.get("cases")
        if not isinstance(cases_raw, list):
            cases_raw = []

        pm_switch = self._project_model_getter() if self._project_model_getter else None

        dn = QLineEdit(str(data.get("defaultNext", "")))
        pickd = QPushButton("选…")
        pickd.clicked.connect(lambda: self._pick_target(dn))
        dn.textChanged.connect(self._emit_changed)
        fl = QFormLayout()
        _form_wrap_rows(fl)
        rowd = QHBoxLayout()
        rowd.addWidget(dn)
        rowd.addWidget(pickd)
        fl.addRow("defaultNext", rowd)
        self._body_layout.addLayout(fl)
        self._body_layout.addWidget(
            QLabel(
                "分支：自上而下命中第一条。"
                "每条可选用「多条条件 AND」或「单条 ConditionExpr（JSON，与运行时 evaluateConditionExpr 一致）」；"
                "后者保存时写入 condition字段并优先于 conditions。",
            ),
        )

        cases_wrap = QWidget()
        cases_outer = QVBoxLayout(cases_wrap)
        cases_outer.setContentsMargins(0, 0, 0, 0)
        cases_outer.setSpacing(4)
        switch_case_rows: list[dict[str, Any]] = []

        def refresh_case_nav() -> None:
            n = len(switch_case_rows)
            for i, c in enumerate(switch_case_rows):
                c["btn_up"].setEnabled(i > 0)
                c["btn_down"].setEnabled(i < n - 1)

        def refresh_case_fold_policy() -> None:
            single = len(switch_case_rows) <= 1
            for c in switch_case_rows:
                t = c.get("toggle")
                ct = c.get("content")
                if t is None or ct is None:
                    continue
                if single:
                    t.setVisible(False)
                    c["collapsed"] = False
                    ct.setVisible(True)
                    t.setArrowType(Qt.ArrowType.DownArrow)
                else:
                    t.setVisible(True)
                    c["collapsed"] = True
                    ct.setVisible(False)
                    t.setArrowType(Qt.ArrowType.RightArrow)

        def rebuild_cases_layout() -> None:
            while cases_outer.count():
                it = cases_outer.takeAt(0)
                w = it.widget()
                if w is not None:
                    w.setParent(None)
            for c in switch_case_rows:
                cases_outer.addWidget(c["outer"])

        def make_case_block(case: dict[str, Any] | None) -> dict[str, Any]:
            case_rec: dict[str, Any] = {"collapsed": True}
            outer = QWidget()
            ov = QVBoxLayout(outer)
            ov.setContentsMargins(0, 0, 0, 0)
            ov.setSpacing(4)

            header = QHBoxLayout()
            toggle = QToolButton()
            toggle.setAutoRaise(True)
            toggle.setArrowType(Qt.ArrowType.RightArrow)
            toggle.setToolTip("折叠 / 展开本分支")
            summary = QLabel()
            summary.setWordWrap(False)
            summary.setStyleSheet("color: #ccc;")
            btn_ins_before, btn_ins_after, btn_up, btn_down, btn_del = (
                _compact_row_nav_buttons(
                    outer,
                    tip_before="在此分支之前插入空分支",
                    tip_after="在此分支之后插入空分支",
                    tip_up="整条分支上移",
                    tip_down="整条分支下移",
                    tip_del="删除本分支（至少保留一个分支）",
                )
            )
            header.addWidget(toggle)
            header.addWidget(summary, 1)
            header.addWidget(btn_ins_before)
            header.addWidget(btn_ins_after)
            header.addWidget(btn_up)
            header.addWidget(btn_down)
            header.addWidget(btn_del)

            content = QWidget()
            cv = QVBoxLayout(content)
            cv.setContentsMargins(0, 0, 0, 0)
            nx = QLineEdit(str((case or {}).get("next", "")))
            pk = QPushButton("选…")
            pk.clicked.connect(lambda: self._pick_target(nx))
            nx.textChanged.connect(self._emit_changed)
            hr = QHBoxLayout()
            hr.addWidget(QLabel("next"))
            hr.addWidget(nx, 1)
            hr.addWidget(pk)
            cv.addLayout(hr)

            case_mode = QComboBox()
            case_mode.addItem("多条条件（AND）", "and")
            case_mode.addItem("ConditionExpr（JSON）", "expr")
            cm_row = QHBoxLayout()
            cm_row.addWidget(QLabel("本分支条件"))
            cm_row.addWidget(case_mode, 1)
            cv.addLayout(cm_row)

            expr_edit = QPlainTextEdit()
            expr_edit.setPlaceholderText(
                '{"all":[...]} / {"scenario":"...","phase":"...","status":"done"} 等',
            )
            expr_edit.setMinimumHeight(60)
            expr_edit.setSizePolicy(
                QSizePolicy.Policy.Expanding,
                QSizePolicy.Policy.Minimum,
            )
            expr_edit.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
            expr_edit.textChanged.connect(self._emit_changed)
            cv.addWidget(expr_edit)

            btn_and_to_json = QPushButton("将当前 AND 条件导出为 JSON 并切换到 ConditionExpr")
            cv.addWidget(btn_and_to_json)

            cond_rows_layout = QVBoxLayout()
            cond_rows_layout.setSpacing(4)
            cond_rows_wrap = QWidget()
            cond_rows_wrap.setLayout(cond_rows_layout)
            cond_rows: list[dict[str, Any]] = []

            def refresh_cond_nav() -> None:
                m = len(cond_rows)
                for i, cr in enumerate(cond_rows):
                    cr["btn_up"].setEnabled(i > 0)
                    cr["btn_down"].setEnabled(i < m - 1)

            def rebuild_cond_layout() -> None:
                while cond_rows_layout.count():
                    it = cond_rows_layout.takeAt(0)
                    w = it.widget()
                    if w is not None:
                        w.setParent(None)
                for cr in cond_rows:
                    cond_rows_layout.addWidget(cr["outer"])

            def refresh_cond_fold_policy() -> None:
                single_c = len(cond_rows) <= 1
                for cr in cond_rows:
                    t = cr.get("toggle")
                    b = cr.get("body")
                    if t is None or b is None:
                        continue
                    if single_c:
                        t.setVisible(False)
                        cr["collapsed"] = False
                        b.setVisible(True)
                        t.setArrowType(Qt.ArrowType.DownArrow)
                    else:
                        t.setVisible(True)
                        cr["collapsed"] = True
                        b.setVisible(False)
                        t.setArrowType(Qt.ArrowType.RightArrow)

            def make_cond_block(cd: dict[str, Any] | None) -> dict[str, Any]:
                crow: dict[str, Any] = {"collapsed": True}
                cow = QWidget()
                col = QVBoxLayout(cow)
                col.setContentsMargins(0, 0, 0, 0)
                col.setSpacing(4)
                ch = QHBoxLayout()
                ctog = QToolButton()
                ctog.setAutoRaise(True)
                ctog.setArrowType(Qt.ArrowType.RightArrow)
                ctog.setToolTip("折叠 / 展开本条件")
                csum = QLabel()
                csum.setWordWrap(False)
                csum.setStyleSheet("color: #aaa;")
                c_before, c_after, c_up, c_down, c_del = _compact_row_nav_buttons(
                    cow,
                    tip_before="在此条件之前插入一条条件",
                    tip_after="在此条件之后插入一条条件",
                    tip_up="本条条件上移",
                    tip_down="本条条件下移",
                    tip_del="删除本条件（本分支至少保留一条）",
                    side=22,
                )
                ch.addWidget(ctog)
                ch.addWidget(csum, 1)
                ch.addWidget(c_before)
                ch.addWidget(c_after)
                ch.addWidget(c_up)
                ch.addWidget(c_down)
                ch.addWidget(c_del)

                body = QWidget()
                h = QHBoxLayout(body)
                h.setContentsMargins(0, 0, 0, 0)
                mode = QComboBox()
                mode.addItem("标志 flag", "flag")
                mode.addItem("任务 quest", "quest")
                mode.addItem("scenario", "scenario")
                op_cb = QComboBox()
                for o in ("==", "!=", ">", "<", ">=", "<="):
                    op_cb.addItem(o, o)
                qid_e = QLineEdit()
                st_cb = QComboBox()
                for s in ("Inactive", "Active", "Completed"):
                    st_cb.addItem(s, s)
                flag_w = QWidget()
                fh = QHBoxLayout(flag_w)
                fh.setContentsMargins(0, 0, 0, 0)
                fh.addWidget(QLabel("flag"))
                if pm_switch is not None:
                    from tools.editor.shared.flag_key_field import FlagKeyPickField

                    flag_ctrl = FlagKeyPickField(pm_switch, None, "", body)

                    def _get_flag() -> str:
                        return flag_ctrl.key()

                    def _set_flag(s: str) -> None:
                        flag_ctrl.set_key(s)
                else:
                    flag_ctrl = QLineEdit()
                    flag_ctrl.setPlaceholderText(
                        "无法加载 ProjectModel 时可直接输入 flag 键"
                    )
                    flag_ctrl.textChanged.connect(self._emit_changed)

                    def _get_flag() -> str:
                        return flag_ctrl.text().strip()

                    def _set_flag(s: str) -> None:
                        flag_ctrl.setText(s)

                fh.addWidget(flag_ctrl, 1)
                fh.addWidget(op_cb)
                val_kind = QComboBox()
                val_kind.addItem("布尔", "bool")
                val_kind.addItem("整数", "int")
                val_kind.addItem("小数", "float")
                val_kind.addItem("文本", "str")
                val_stack = QStackedWidget()
                val_bool = QComboBox()
                val_bool.addItem("false", False)
                val_bool.addItem("true", True)
                val_int = QSpinBox()
                val_int.setRange(-2_147_483_648, 2_147_483_647)
                val_float = QDoubleSpinBox()
                val_float.setRange(-1e12, 1e12)
                val_float.setDecimals(8)
                val_str = QLineEdit()
                val_stack.addWidget(val_bool)
                val_stack.addWidget(val_int)
                val_stack.addWidget(val_float)
                val_stack.addWidget(val_str)
                fh.addWidget(QLabel("值"))
                fh.addWidget(val_kind)
                fh.addWidget(val_stack, 1)

                quest_w = QWidget()
                qh = QHBoxLayout(quest_w)
                qh.setContentsMargins(0, 0, 0, 0)
                qh.addWidget(QLabel("questId"))
                qh.addWidget(qid_e, 1)
                qh.addWidget(QLabel("状态"))
                qh.addWidget(st_cb)

                scenario_w = QWidget()
                sc_form = QFormLayout(scenario_w)
                sc_form.setContentsMargins(0, 0, 0, 0)
                scen_entries: list[tuple[str, str]] = []
                if pm_switch is not None:
                    scen_entries = [(s, s) for s in pm_switch.scenario_ids_ordered()]
                if not scen_entries:
                    scen_entries = [("(无 scenarios.json 数据)", "")]
                scen_id_combo = FilterableTypeCombo(scen_entries, body)
                phase_combo = QComboBox()
                phase_combo.setEditable(True)
                scen_status = QComboBox()
                scen_status.setEditable(True)
                for s in ("pending", "active", "done", "locked"):
                    scen_status.addItem(s)
                scen_outcome = QLineEdit()
                scen_outcome.setPlaceholderText("可选，与 scenario phase 的 outcome 比较")

                def resolved_scenario_id() -> str:
                    """FilterableTypeCombo 在点选/输入过程中 lineEdit 与 committed_type 可能短暂不同步。"""
                    cmt = scen_id_combo.committed_type().strip()
                    if cmt:
                        return cmt
                    le = scen_id_combo.lineEdit()
                    return le.text().strip() if le is not None else ""

                def refill_scen_phases() -> None:
                    sid = resolved_scenario_id()
                    phs = (
                        pm_switch.phases_for_scenario(sid)
                        if pm_switch and sid
                        else []
                    )
                    phase_combo.blockSignals(True)
                    phase_combo.clear()
                    for p in phs:
                        phase_combo.addItem(p)
                    phase_combo.blockSignals(False)

                scen_id_combo.typeCommitted.connect(
                    lambda _t: (refill_scen_phases(), update_csum(), self._emit_changed()),
                )
                _sce_le = scen_id_combo.lineEdit()
                if _sce_le is not None:
                    _sce_le.editingFinished.connect(
                        lambda: (refill_scen_phases(), update_csum(), self._emit_changed()),
                    )
                for wsig in (phase_combo, scen_status, scen_outcome):
                    if isinstance(wsig, QComboBox):
                        wsig.currentTextChanged.connect(
                            lambda _t: (update_csum(), self._emit_changed()),
                        )
                    else:
                        wsig.textChanged.connect(
                            lambda _t: (update_csum(), self._emit_changed()),
                        )
                sc_form.addRow("scenarioId", scen_id_combo)
                sc_form.addRow("phase", phase_combo)
                sc_form.addRow("status", scen_status)
                sc_form.addRow("outcome", scen_outcome)

                h.addWidget(mode)
                h.addWidget(flag_w, 1)
                h.addWidget(quest_w, 1)
                h.addWidget(scenario_w, 1)

                def _apply_val_kind(which: str) -> None:
                    idx = {"bool": 0, "int": 1, "float": 2, "str": 3}.get(which, 0)
                    val_stack.setCurrentIndex(idx)

                def _set_value_py(v: object) -> None:
                    val_kind.blockSignals(True)
                    try:
                        if isinstance(v, bool):
                            val_kind.setCurrentIndex(0)
                            val_bool.setCurrentIndex(1 if v else 0)
                            _apply_val_kind("bool")
                        elif type(v) is int:
                            val_kind.setCurrentIndex(1)
                            val_int.setValue(int(v))
                            _apply_val_kind("int")
                        elif isinstance(v, float):
                            val_kind.setCurrentIndex(2)
                            val_float.setValue(float(v))
                            _apply_val_kind("float")
                        else:
                            val_kind.setCurrentIndex(3)
                            val_str.setText("" if v is None else str(v))
                            _apply_val_kind("str")
                    finally:
                        val_kind.blockSignals(False)

                def upd_mode() -> None:
                    m = mode.currentData()
                    flag_w.setVisible(m == "flag")
                    quest_w.setVisible(m == "quest")
                    scenario_w.setVisible(m == "scenario")
                    if m == "scenario":
                        refill_scen_phases()

                def update_csum() -> None:
                    if mode.currentData() == "scenario":
                        sid_disp = resolved_scenario_id() or "…"
                        csum.setText(
                            f"scen {sid_disp} · "
                            f"{phase_combo.currentText().strip() or '…'} · "
                            f"{scen_status.currentText().strip() or '…'}",
                        )
                        return
                    if mode.currentData() == "quest":
                        csum.setText(
                            f"quest {qid_e.text().strip() or '…'} · {st_cb.currentText()}"
                        )
                        return
                    flg = _get_flag() or "…"
                    op = str(op_cb.currentData() or "==")
                    kd = val_kind.currentData()
                    if kd == "bool":
                        vv = val_bool.currentData()
                    elif kd == "int":
                        vv = val_int.value()
                    elif kd == "float":
                        vv = val_float.value()
                    else:
                        vv = val_str.text().strip() or "…"
                    csum.setText(f"flag {flg} {op} {vv!s}")

                raw_c = cd if isinstance(cd, dict) else {"flag": "", "op": "=="}
                if isinstance(raw_c.get("scenario"), str):
                    mode.setCurrentIndex(2)
                    sid0 = str(raw_c.get("scenario", "")).strip()
                    if sid0:
                        scen_id_combo.set_committed_type(sid0)
                    refill_scen_phases()
                    ph0 = str(raw_c.get("phase", "")).strip()
                    if ph0:
                        ix = phase_combo.findText(ph0)
                        if ix >= 0:
                            phase_combo.setCurrentIndex(ix)
                        else:
                            phase_combo.setEditText(ph0)
                    st0 = str(raw_c.get("status", "pending")).strip() or "pending"
                    ix2 = scen_status.findText(st0)
                    if ix2 >= 0:
                        scen_status.setCurrentIndex(ix2)
                    else:
                        scen_status.setEditText(st0)
                    o0 = raw_c.get("outcome")
                    scen_outcome.setText("" if o0 is None else str(o0))
                elif isinstance(raw_c.get("quest"), str):
                    mode.setCurrentIndex(1)
                    qid_e.setText(str(raw_c.get("quest", "")))
                    qs = str(raw_c.get("questStatus") or raw_c.get("status") or "Active")
                    ix = st_cb.findData(qs)
                    st_cb.setCurrentIndex(max(0, ix))
                else:
                    mode.setCurrentIndex(0)
                    _set_flag(str(raw_c.get("flag", "")))
                    op = str(raw_c.get("op") or "==")
                    ix = op_cb.findData(op)
                    op_cb.setCurrentIndex(max(0, ix))
                    if "value" in raw_c:
                        _set_value_py(raw_c.get("value"))
                    else:
                        _set_value_py(True)

                mode.currentIndexChanged.connect(
                    lambda _i: (upd_mode(), update_csum(), self._emit_changed())
                )
                val_kind.currentIndexChanged.connect(
                    lambda _i: (
                        _apply_val_kind(str(val_kind.currentData())),
                        update_csum(),
                        self._emit_changed(),
                    )
                )
                for ww in (flag_ctrl, qid_e, val_str):
                    if isinstance(ww, QLineEdit):
                        ww.textChanged.connect(
                            lambda _t: (update_csum(), self._emit_changed())
                        )
                if pm_switch is not None:
                    flag_ctrl.valueChanged.connect(
                        lambda: (update_csum(), self._emit_changed())
                    )
                op_cb.currentIndexChanged.connect(
                    lambda _i: (update_csum(), self._emit_changed())
                )
                st_cb.currentIndexChanged.connect(
                    lambda _i: (update_csum(), self._emit_changed())
                )
                val_bool.currentIndexChanged.connect(
                    lambda _i: (update_csum(), self._emit_changed())
                )
                val_int.valueChanged.connect(
                    lambda _v: (update_csum(), self._emit_changed())
                )
                val_float.valueChanged.connect(
                    lambda _v: (update_csum(), self._emit_changed())
                )
                upd_mode()
                update_csum()

                def flip_c() -> None:
                    crow["collapsed"] = not crow["collapsed"]
                    body.setVisible(not crow["collapsed"])
                    ctog.setArrowType(
                        Qt.ArrowType.RightArrow
                        if crow["collapsed"]
                        else Qt.ArrowType.DownArrow
                    )

                ctog.clicked.connect(flip_c)

                def cond_row_index() -> int:
                    return cond_rows.index(crow)

                c_before.clicked.connect(lambda: insert_cond_at(cond_row_index()))
                c_after.clicked.connect(lambda: insert_cond_at(cond_row_index() + 1))

                def do_c_up() -> None:
                    i = cond_row_index()
                    if i <= 0:
                        return
                    cond_rows[i - 1], cond_rows[i] = cond_rows[i], cond_rows[i - 1]
                    rebuild_cond_layout()
                    refresh_cond_nav()
                    self._emit_changed()

                def do_c_down() -> None:
                    i = cond_row_index()
                    if i < 0 or i >= len(cond_rows) - 1:
                        return
                    cond_rows[i + 1], cond_rows[i] = cond_rows[i], cond_rows[i + 1]
                    rebuild_cond_layout()
                    refresh_cond_nav()
                    self._emit_changed()

                def do_c_del() -> None:
                    if len(cond_rows) <= 1:
                        QMessageBox.information(
                            self, "switch 条件", "每个分支至少保留一条条件。"
                        )
                        return
                    i = cond_row_index()
                    cond_rows.pop(i)
                    cond_rows_layout.removeWidget(cow)
                    cow.deleteLater()
                    refresh_cond_nav()
                    refresh_cond_fold_policy()
                    update_case_summary()
                    self._emit_changed()

                c_up.clicked.connect(do_c_up)
                c_down.clicked.connect(do_c_down)
                c_del.clicked.connect(do_c_del)

                def serialize() -> dict[str, Any]:
                    if mode.currentData() == "scenario":
                        out_s: dict[str, Any] = {
                            "scenario": resolved_scenario_id(),
                            "phase": phase_combo.currentText().strip(),
                            "status": scen_status.currentText().strip(),
                        }
                        oo = scen_outcome.text().strip()
                        if oo:
                            out_s["outcome"] = oo
                        return out_s
                    if mode.currentData() == "quest":
                        return {
                            "quest": qid_e.text().strip(),
                            "questStatus": st_cb.currentData(),
                        }
                    outf: dict[str, Any] = {
                        "flag": _get_flag(),
                        "op": op_cb.currentData() or "==",
                    }
                    kd = val_kind.currentData()
                    if kd == "bool":
                        outf["value"] = val_bool.currentData()
                    elif kd == "int":
                        outf["value"] = val_int.value()
                    elif kd == "float":
                        outf["value"] = float(val_float.value())
                    else:
                        s = val_str.text().strip()
                        if s:
                            outf["value"] = s
                    return outf

                col.addLayout(ch)
                col.addWidget(body)
                body.setVisible(False)
                crow.update(
                    {
                        "outer": cow,
                        "toggle": ctog,
                        "body": body,
                        "serialize": serialize,
                        "btn_up": c_up,
                        "btn_down": c_down,
                    }
                )
                return crow

            def update_case_summary() -> None:
                nn = nx.text().strip() or "（未填 next）"
                if case_mode.currentData() == "expr":
                    summary.setText(f"{nn}  ·  ConditionExpr")
                else:
                    summary.setText(f"{nn}  ·  {len(cond_rows)} 条条件")

            def insert_cond_at(pos: int, data_d: dict[str, Any] | None = None) -> None:
                nb = make_cond_block(
                    data_d
                    if isinstance(data_d, dict)
                    else {"flag": "", "op": "==", "value": True}
                )
                pos = max(0, min(pos, len(cond_rows)))
                cond_rows.insert(pos, nb)
                rebuild_cond_layout()
                refresh_cond_nav()
                refresh_cond_fold_policy()
                update_case_summary()
                self._emit_changed()

            cond_expr_init = (
                (case or {}).get("condition") if isinstance(case, dict) else None
            )
            conds_init = (
                (case or {}).get("conditions") if isinstance(case, dict) else None
            )
            if isinstance(conds_init, list) and conds_init:
                for c in conds_init:
                    if isinstance(c, dict):
                        insert_cond_at(len(cond_rows), c)
            elif not (isinstance(cond_expr_init, dict) and cond_expr_init):
                insert_cond_at(
                    len(cond_rows),
                    {"flag": "some_flag", "op": "==", "value": True},
                )

            nx.textChanged.connect(lambda _t: (update_case_summary(), self._emit_changed()))

            b_cond_end = QPushButton("在末尾添加条件")
            b_cond_end.clicked.connect(lambda: insert_cond_at(len(cond_rows)))
            and_block = QWidget()
            and_lay = QVBoxLayout(and_block)
            and_lay.setContentsMargins(0, 0, 0, 0)
            and_lay.addWidget(QLabel("条件（AND，全部满足）"))
            and_lay.addWidget(cond_rows_wrap)
            and_lay.addWidget(b_cond_end)
            cv.addWidget(and_block)

            def _sync_case_mode_ui() -> None:
                ex = case_mode.currentData() == "expr"
                and_block.setVisible(not ex)
                btn_and_to_json.setVisible(not ex)

            def on_case_mode_changed(_i: int = 0) -> None:
                _sync_case_mode_ui()
                update_case_summary()
                self._emit_changed()

            case_mode.currentIndexChanged.connect(on_case_mode_changed)

            def on_export_and() -> None:
                conds_part = [r["serialize"]() for r in cond_rows]
                wrap: dict[str, Any] = {"all": conds_part} if conds_part else {}
                expr_edit.setPlainText(
                    json.dumps(wrap, ensure_ascii=False, indent=2),
                )
                case_mode.setCurrentIndex(1)
                _sync_case_mode_ui()
                update_case_summary()
                self._emit_changed()

            btn_and_to_json.clicked.connect(on_export_and)

            if isinstance(cond_expr_init, dict) and cond_expr_init:
                case_mode.setCurrentIndex(1)
                try:
                    expr_edit.setPlainText(
                        json.dumps(cond_expr_init, ensure_ascii=False, indent=2),
                    )
                except (TypeError, ValueError):
                    expr_edit.setPlainText("{}")

            _sync_case_mode_ui()

            def flip_case() -> None:
                case_rec["collapsed"] = not case_rec["collapsed"]
                content.setVisible(not case_rec["collapsed"])
                toggle.setArrowType(
                    Qt.ArrowType.RightArrow
                    if case_rec["collapsed"]
                    else Qt.ArrowType.DownArrow
                )

            toggle.clicked.connect(flip_case)
            update_case_summary()

            def case_index() -> int:
                return switch_case_rows.index(case_rec)

            def insert_case_at(pos: int, data_c: dict[str, Any] | None = None) -> None:
                nb = make_case_block(
                    data_c
                    if isinstance(data_c, dict)
                    else {"next": "", "conditions": [{"flag": "", "op": "==", "value": True}]}
                )
                pos = max(0, min(pos, len(switch_case_rows)))
                switch_case_rows.insert(pos, nb)
                rebuild_cases_layout()
                refresh_case_nav()
                refresh_case_fold_policy()
                self._emit_changed()

            btn_ins_before.clicked.connect(lambda: insert_case_at(case_index()))
            btn_ins_after.clicked.connect(lambda: insert_case_at(case_index() + 1))

            def do_case_up() -> None:
                i = case_index()
                if i <= 0:
                    return
                switch_case_rows[i - 1], switch_case_rows[i] = (
                    switch_case_rows[i],
                    switch_case_rows[i - 1],
                )
                rebuild_cases_layout()
                refresh_case_nav()
                self._emit_changed()

            def do_case_down() -> None:
                i = case_index()
                if i < 0 or i >= len(switch_case_rows) - 1:
                    return
                switch_case_rows[i + 1], switch_case_rows[i] = (
                    switch_case_rows[i],
                    switch_case_rows[i + 1],
                )
                rebuild_cases_layout()
                refresh_case_nav()
                self._emit_changed()

            def do_case_del() -> None:
                if len(switch_case_rows) <= 1:
                    QMessageBox.information(self, "switch", "至少保留一个分支。")
                    return
                i = case_index()
                switch_case_rows.pop(i)
                cases_outer.removeWidget(outer)
                outer.deleteLater()
                refresh_case_nav()
                refresh_case_fold_policy()
                self._emit_changed()

            btn_up.clicked.connect(do_case_up)
            btn_down.clicked.connect(do_case_down)
            btn_del.clicked.connect(do_case_del)

            ov.addLayout(header)
            ov.addWidget(content)
            content.setVisible(False)
            case_rec.update(
                {
                    "outer": outer,
                    "toggle": toggle,
                    "content": content,
                    "next_edit": nx,
                    "cond_rows": cond_rows,
                    "case_mode": case_mode,
                    "expr_edit": expr_edit,
                    "btn_up": btn_up,
                    "btn_down": btn_down,
                }
            )
            return case_rec

        if cases_raw:
            for c in cases_raw:
                if isinstance(c, dict):
                    switch_case_rows.append(make_case_block(c))
        else:
            switch_case_rows.append(
                make_case_block(
                    {
                        "next": "",
                        "conditions": [
                            {"flag": "some_flag", "op": "==", "value": True}
                        ],
                    }
                )
            )
        rebuild_cases_layout()
        refresh_case_nav()
        refresh_case_fold_policy()

        cbar = QHBoxLayout()
        bc_add = QPushButton("在末尾添加分支")

        def do_add_case_end() -> None:
            switch_case_rows.append(
                make_case_block(
                    {
                        "next": "",
                        "conditions": [{"flag": "", "op": "==", "value": True}],
                    }
                )
            )
            rebuild_cases_layout()
            refresh_case_nav()
            refresh_case_fold_policy()
            self._emit_changed()

        bc_add.clicked.connect(do_add_case_end)
        cbar.addWidget(bc_add)
        self._body_layout.addWidget(cases_wrap)
        self._body_layout.addLayout(cbar)

        self._topology_refs = {"type": "switch", "case_rows": switch_case_rows, "default_next": dn}

        def getter():
            cs: list[dict[str, Any]] = []
            for cb in switch_case_rows:
                next_s = cb["next_edit"].text().strip()
                cm = cb["case_mode"]
                if cm.currentData() == "expr":
                    raw = cb["expr_edit"].toPlainText().strip()
                    if raw:
                        try:
                            obj = json.loads(raw)
                        except json.JSONDecodeError as e:
                            QMessageBox.warning(
                                self,
                                "switch",
                                f"分支 next={next_s or '?'} 的 ConditionExpr非合法 JSON：{e}",
                            )
                            obj = None
                        if isinstance(obj, dict) and obj:
                            cs.append({"next": next_s, "condition": obj})
                            continue
                    cs.append({"next": next_s, "conditions": []})
                else:
                    conds = [r["serialize"]() for r in cb["cond_rows"]]
                    cs.append({"next": next_s, "conditions": conds})
            return {"type": "switch", "cases": cs, "defaultNext": dn.text().strip()}

        self._getter = getter

    def _pick_target(self, line_edit: QLineEdit):
        ids = self._list_node_ids()
        if not ids:
            QMessageBox.information(self, "选择 next", "图中还没有节点 id。")
            return
        types = self._node_types_getter() if self._node_types_getter else None
        dlg = NodePickerDialog(
            ids,
            type_by_id=types,
            title="选择目标节点",
            initial=line_edit.text().strip(),
            parent=self,
        )
        if dlg.exec() == QDialog.DialogCode.Accepted:
            line_edit.setText(dlg.selected_id())
