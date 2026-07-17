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
    QStyle,
)
from PySide6.QtCore import Qt, QSize
from PySide6.QtGui import QFontMetrics, QPixmap

from tools.editor.shared.condition_expr_tree import ConditionExprTreeRootWidget
from tools.editor.shared.action_editor import (
    _hide_combo_popups_under,
    FilterableTypeCombo,
)

from tools.editor.shared.portrait_catalog import (
    PORTRAIT_EMOTIONS_FALLBACK as _PORTRAIT_EMOTIONS_FALLBACK,
    graph_context_portrait_slug,
    load_portrait_emotions,
    load_portrait_sets,
    npc_portrait_slug_index,
    player_default_portrait_slug,
    portrait_image_path,
)
from tools.editor.shared.portrait_ref_field import PortraitRefField
from .editor_asset_catalog import load_rule_id_name_pairs
from .node_picker_dialog import NodePickerDialog
from .npc_picker_dialog import NpcPickerDialog


SpeakerKinds = ("player", "npc", "literal", "sceneNpc")

# 与 GraphDialogueManager.resolveSpeaker（sceneNpc）约定一致
PROMPT_LINE_SCENE_NPC_CONTEXT_TOKEN = "@contextNpc"

# line / choice 等共用；默认 4 行可视高度（图对话 line 节点正文）
_PLAIN_MIN_LINES = 4


def _plain_text_edit(
    *,
    placeholder: str = "",
    min_lines: int = _PLAIN_MIN_LINES,
    parent: QWidget | None = None,
) -> QPlainTextEdit:
    w = QPlainTextEdit(parent)
    if placeholder:
        w.setPlaceholderText(placeholder)
    fm = QFontMetrics(w.font())
    lh = max(1, int(fm.lineSpacing()))
    lines = max(1, int(min_lines))
    # 约 lines 行起步高度；用 min/max 区间而非 setFixedHeight，便于随内容/窗口伸缩
    w.setMinimumHeight(max(32, lh * lines + 18))
    w.setMaximumHeight(max(120, lh * (lines + 6) + 18))
    w.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
    w.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
    w.setLineWrapMode(QPlainTextEdit.LineWrapMode.WidgetWidth)
    return w


def _form_wrap_rows(fl: QFormLayout) -> None:
    fl.setRowWrapPolicy(QFormLayout.RowWrapPolicy.WrapAllRows)
    fl.setHorizontalSpacing(8)
    fl.setVerticalSpacing(6)


def _help_marker(text: str, parent: QWidget | None = None) -> QLabel:
    """紧凑的「ⓘ 说明」标记：把大段说明收进 tooltip，避免常驻界面占高（与布局铁律一致）。"""
    lbl = QLabel("ⓘ 说明", parent)
    lbl.setStyleSheet("color: #888;")
    lbl.setToolTip(text)
    lbl.setCursor(Qt.CursorShape.WhatsThisCursor)
    return lbl


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
        dialogue_graph_id_getter: Optional[Callable[[], str]] = None,
        parent=None,
    ):
        super().__init__(parent)
        self._list_node_ids = list_node_ids
        self._project_root = project_root
        self._project_model_getter = project_model_getter
        self._node_types_getter = node_types_getter
        self._dialogue_graph_id_getter = dialogue_graph_id_getter
        self._node_id = ""
        self._suppress_change_emit = False
        self._topology_refs: dict[str, Any] = {}
        self._body_valid = False
        self._assign_editor_group: Callable[[str, str], None] | None = None
        self._create_editor_group: Callable[[], str | None] | None = None
        self._editor_group_geometry_mode = False
        self._root_layout = QVBoxLayout(self)

        self._type_label = QLabel(self)
        self._type_label.setWordWrap(True)
        self._type_label.setTextFormat(Qt.TextFormat.RichText)
        self._root_layout.addWidget(self._type_label)

        # parent=self 从构造的第一刻起就在 inspector 子树内，避免短暂 orphan top-level。
        self._body = QWidget(self)
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
        # 只收起所有 QComboBox 公开弹出层（调公开 hidePopup）；
        # 禁止主动处理 QComboBoxPrivateContainer 或强制 processEvents —— 按 Qt 官方建议忽略这类内部 top-level。
        _hide_combo_popups_under(old_body)
        self._body = QWidget(self)
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        idx = self._root_layout.indexOf(old_body)
        if idx < 0:
            idx = 1
        self._root_layout.removeWidget(old_body)
        self._root_layout.insertWidget(idx, self._body)
        old_body.deleteLater()

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
        # 按 Qt 官方推荐，用 setUpdatesEnabled(False/True) 包住 mass rebuild，
        # 避免一次点击里多个 QComboBox popup 创建/销毁造成小顶层窗闪烁。
        _win = self.window()
        if _win is not None:
            _win.setUpdatesEnabled(False)
        self._suppress_change_emit = True
        try:
            self._node_id = node_id
            self._clear_body()
            # 畸形节点值（agent 误写成字符串/列表等非对象）：过去 data.get 直接崩（审查 P2-③）。
            # 降级为只读展示 + 原样透传：getter 返回原值，不被改写、round-trip 无损。
            if not isinstance(data, dict):
                self._type_label.setText(
                    f"节点 id：<b>{node_id}</b>　　类型：<b>畸形（非对象）</b>"
                )
                self._body_layout.addWidget(
                    QLabel(
                        f"该节点的值不是对象（实际为 {type(data).__name__}），无法用表单编辑。\n"
                        "校验面板会将其列为错误；请在数据文件中修正为合法节点对象。",
                        self._body,
                    )
                )
                snap = copy.deepcopy(data)
                self._getter = lambda s=snap: copy.deepcopy(s)
                return
            t = data.get("type", "?")
            self._type_label.setText(f"节点 id：<b>{node_id}</b>　　类型：<b>{t}</b>")

            # 几何模式只读展示所属分组（画布分组框决定），无需 assign 回调；
            # 非几何模式才需要 assign 回调驱动可编辑下拉。
            if node_id and (self._editor_group_geometry_mode or self._assign_editor_group):
                self._insert_editor_group_row(node_id, editor_groups or {}, editor_group_for_node or "")

            if t == "line":
                self._build_line(data)
            elif t == "runActions":
                self._build_run_actions(data)
            elif t == "choice":
                self._build_choice(data)
            elif t == "switch":
                self._build_switch(data)
            elif t == "ownerState":
                self._build_owner_state(data)
            elif t == "contextState":
                self._build_context_state(data)
            elif t == "end":
                self._body_layout.addWidget(QLabel("结束节点，无额外字段。", self._body))
                self._getter = lambda: {"type": "end"}
            else:
                self._body_layout.addWidget(
                    QLabel(
                        f"未知类型 {t!r}，请用「原始 JSON」在后续版本编辑。",
                        self._body,
                    )
                )
                snap = copy.deepcopy(data)
                self._getter = lambda s=snap: copy.deepcopy(s)
        finally:
            self._body_valid = True
            self._suppress_change_emit = False
            _hide_combo_popups_under(self._body)
            if _win is not None:
                _win.setUpdatesEnabled(True)
                # raise_/activateWindow 保留做最终兜底（不造成闪烁，仅可能抢焦点）；如后续发现多余可去掉。
                _win.raise_()
                _win.activateWindow()

    def get_node(self) -> dict[str, Any]:
        """Return current node dict from form state."""
        if not self._body_valid:
            return {"type": "end"}
        getter = getattr(self, "_getter", None)
        if getter:
            return getter()
        return {"type": "end"}

    def current_node_id(self) -> str:
        """当前正在编辑的节点 id（宿主用此判断「哪个节点在编辑」，勿再读私有 _node_id）。"""
        return self._node_id

    def is_form_valid(self) -> bool:
        """表单是否已构建完成且处于有效状态。"""
        return self._body_valid

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
            elif t in ("ownerState", "contextState"):
                cases = node_data.get("cases") or []
                rows = refs.get("case_rows") or []
                for i, row in enumerate(rows):
                    if i < len(cases) and isinstance(cases[i], dict):
                        nx = row.get("next_edit")
                        if isinstance(nx, QLineEdit):
                            nx.setText(str(cases[i].get("next", "")))
                        st = row.get("state_edit")
                        if isinstance(st, QComboBox):
                            st.setCurrentText(str(cases[i].get("state", "")))
                dn = refs.get("default_next")
                if isinstance(dn, QLineEdit):
                    dn.setText(str(node_data.get("defaultNext", "")))
                mn = refs.get("missing_next")
                if isinstance(mn, QLineEdit):
                    mn.setText(str(node_data.get("missingWrapperNext", "")))
                gid = refs.get("graph_id_edit")
                if isinstance(gid, QComboBox):
                    gid.setCurrentText(str(node_data.get("graphId", "")))
                wid = refs.get("wrapper_graph_id_edit")
                if isinstance(wid, QComboBox):
                    wid.setCurrentText(str(node_data.get("wrapperGraphId", "")))
                elif isinstance(wid, QLineEdit):
                    wid.setText(str(node_data.get("wrapperGraphId", "")))
        finally:
            self._suppress_change_emit = False

    def _insert_editor_group_row(
        self,
        node_id: str,
        group_defs: dict[str, dict[str, Any]],
        current_gid: str,
    ) -> None:
        if self._editor_group_geometry_mode:
            row_w = QWidget(self._body)
            h = QHBoxLayout(row_w)
            h.setContentsMargins(0, 0, 0, 0)
            h.addWidget(QLabel("编辑器分组", row_w))
            if current_gid:
                g = group_defs.get(current_gid) or {}
                label = str(g.get("name") or current_gid)
                sub = QLabel(f"{label}（由画布分组框自动判定，拖入/拖出框即可）", row_w)
            else:
                sub = QLabel("（无，节点中心不在任一分组框内）", row_w)
            sub.setWordWrap(True)
            h.addWidget(sub, 1)
            self._body_layout.addWidget(row_w)
            return
        row_w = QWidget(self._body)
        h = QHBoxLayout(row_w)
        h.setContentsMargins(0, 0, 0, 0)
        h.addWidget(QLabel("编辑器分组", row_w))
        cb = QComboBox(row_w)
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

    # --- 玩家可见文本：优先富文本（可插 [tag:…]/[img:…]）；无 ProjectModel 时退回纯文本框 ---
    def _pm_for_rich(self):
        return self._project_model_getter() if self._project_model_getter else None

    def _make_player_textedit(
        self, initial: str, placeholder: str, *, min_lines: int = 4, parent: QWidget | None = None
    ):
        """多行玩家可见文本。返回控件统一支持 toPlainText/setPlainText/textChanged。"""
        host = parent if parent is not None else self._body
        pm = self._pm_for_rich()
        if pm is not None:
            from tools.editor.shared.rich_text_field import RichTextTextEdit

            w = RichTextTextEdit(pm, host)
            w.setPlainText(initial or "")
            if placeholder:
                w.setPlaceholderText(placeholder)
            fm = QFontMetrics(w.font())
            lh = max(1, int(fm.lineSpacing()))
            ln = max(1, int(min_lines))
            w.setMinimumHeight(max(48, lh * ln + 22))
            w.setMaximumHeight(max(140, lh * (ln + 6) + 22))
            return w
        w = _plain_text_edit(placeholder=placeholder, min_lines=min_lines, parent=host)
        w.setPlainText(initial or "")
        return w

    def _npc_entries_for_picker(self) -> list[tuple[str, str]]:
        pm = self._project_model_getter() if self._project_model_getter else None
        ent: list[tuple[str, str]] = []
        if pm:
            try:
                ent.extend(pm.all_npc_ids_global())
            except Exception:
                pass
        return ent

    def _make_id_pick_button(
        self,
        line_edit: QLineEdit,
        entries_getter: Callable[[], list[tuple[str, str]]],
        *,
        title: str,
        tip: str,
    ) -> QPushButton:
        """给承载某类引用 id 的 QLineEdit 配「选…」按钮，打开可搜索列表（保留自由输入，零丢失）。"""
        btn = QPushButton("选…", line_edit.parentWidget() or self._body)
        btn.setToolTip(tip)

        def _open() -> None:
            dlg = NpcPickerDialog(
                entries_getter(),
                title=title,
                initial_id=line_edit.text().strip(),
                parent=self,
            )
            if dlg.exec() == QDialog.DialogCode.Accepted:
                line_edit.setText(dlg.selected_id())
                self._emit_changed()

        btn.clicked.connect(_open)
        return btn

    def _make_npc_pick_button(self, line_edit: QLineEdit, title: str) -> QPushButton:
        """给一个承载 npcId 的 QLineEdit 配「选…」按钮，打开可搜索 NPC 列表。"""
        return self._make_id_pick_button(
            line_edit,
            self._npc_entries_for_picker,
            title=title,
            tip="打开可搜索的 NPC 列表（sceneNpc 说话人的 npcId）",
        )

    def _quest_entries_for_picker(self) -> list[tuple[str, str]]:
        pm = self._project_model_getter() if self._project_model_getter else None
        if not pm:
            return []
        try:
            # quest 叶目标排除 repeatable（无状态机，指向它=校验 error）
            if hasattr(pm, "quest_status_target_ids"):
                return list(pm.quest_status_target_ids())
            return list(pm.all_quest_ids())
        except Exception:
            return []

    def _narrative_graph_entries_for_picker(self) -> list[tuple[str, str]]:
        """switch narrative 叶子的图 id 候选：已知叙事图 + 运行时相对 token。"""
        entries: list[tuple[str, str]] = [
            ("@owner", "@owner（运行时所属实体）"),
            ("@scene", "@scene（运行时所在场景）"),
        ]
        pm = self._project_model_getter() if self._project_model_getter else None
        if pm:
            try:
                for gid in pm.narrative_graph_ids_ordered():
                    gid = str(gid).strip()
                    if gid:
                        entries.append((gid, gid))
            except Exception:
                pass
        return entries

    def _known_narrative_graph_ids(self) -> set[str]:
        pm = self._project_model_getter() if self._project_model_getter else None
        if not pm:
            return set()
        try:
            return {str(g).strip() for g in pm.narrative_graph_ids_ordered() if str(g).strip()}
        except Exception:
            return set()

    def _install_target_validation(self, edit: QLineEdit) -> None:
        """给承载「指向节点 id」的输入框加实时存在性校验：非空且不在当前图节点集
        则标红并提示，消除「打错字→静默悬空边」。纯视觉，不影响序列化（往返零变化）。"""

        def _validate(_t: str = "") -> None:
            tid = edit.text().strip()
            if tid and tid not in set(self._list_node_ids()):
                edit.setStyleSheet("QLineEdit { border: 1px solid #d9534f; }")
                edit.setToolTip(f"指向不存在的节点 id：{tid!r}（笔误，或目标尚未创建）")
            else:
                edit.setStyleSheet("")
                if edit.toolTip().startswith("指向不存在的节点"):
                    edit.setToolTip("")

        edit.textChanged.connect(_validate)
        _validate()

    def _install_narrative_id_validation(self, edit: QLineEdit) -> None:
        """switch narrative 叶子的图 id：非空、非 @token、且不在已知叙事图集则标红提示。"""

        def _validate(_t: str = "") -> None:
            gid = edit.text().strip()
            if gid and not gid.startswith("@") and gid not in self._known_narrative_graph_ids():
                edit.setStyleSheet("QLineEdit { border: 1px solid #d9534f; }")
                edit.setToolTip(f"未知叙事图 id：{gid!r}（应为 wrapper/scenario 图 id 或 @owner/@scene）")
            else:
                edit.setStyleSheet("")
                if edit.toolTip().startswith("未知叙事图"):
                    edit.setToolTip("")

        edit.textChanged.connect(_validate)
        _validate()

    # --- line ---
    def _build_line(self, data: dict[str, Any]):
        lines_raw = data.get("lines")
        use_multi = isinstance(lines_raw, list) and len(lines_raw) > 0
        cb_multi = QCheckBox("多拍连续对白（每句点击继续；存为 lines 数组）", self._body)
        cb_multi.setChecked(use_multi)

        beats_wrap = QWidget(self._body)
        beats_v = QVBoxLayout(beats_wrap)
        beats_v.setContentsMargins(0, 0, 0, 0)
        rows_wrap = QWidget(beats_wrap)
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
            outer = QWidget(rows_wrap)
            ov = QVBoxLayout(outer)
            ov.setContentsMargins(0, 0, 0, 0)
            ov.setSpacing(4)

            header = QHBoxLayout()
            toggle = QToolButton(outer)
            toggle.setAutoRaise(True)
            toggle.setArrowType(Qt.ArrowType.RightArrow)
            toggle.setToolTip("折叠 / 展开本句详细表单")
            summary = QLabel(outer)
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

            content = QWidget(outer)
            o_fl = QFormLayout(content)
            _form_wrap_rows(o_fl)

            spb = (beat or {}).get("speaker") if isinstance(beat, dict) else None
            if not isinstance(spb, dict):
                spb = {"kind": "player"}
            bk, bex = _speaker_to_ui(spb)
            kcb = QComboBox(content)
            for sk in SpeakerKinds:
                kcb.addItem(sk, sk)
            kcb.setCurrentIndex(max(0, kcb.findData(bk)))
            exed = QLineEdit(bex, content)
            exed_npc_btn = self._make_npc_pick_button(exed, "选择说话人 · sceneNpc")
            exed_row = QWidget(content)
            exed_row_lo = QHBoxLayout(exed_row)
            exed_row_lo.setContentsMargins(0, 0, 0, 0)
            exed_row_lo.addWidget(exed, 1)
            exed_row_lo.addWidget(exed_npc_btn)
            tx_plain = self._make_player_textedit(
                str((beat or {}).get("text", "") if isinstance(beat, dict) else ""),
                "本句对白正文",
                min_lines=4,
                parent=content,
            )
            tked = QLineEdit(
                str((beat or {}).get("textKey", "") if isinstance(beat, dict) else ""),
                content,
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
                exed_row.setVisible(kk in ("literal", "sceneNpc"))
                exed_npc_btn.setVisible(kk == "sceneNpc")  # 仅 sceneNpc 是 npcId 引用
                exed.setPlaceholderText("显示名" if kk == "literal" else "npcId")

            kcb.currentIndexChanged.connect(
                lambda _i: (upd_ex(), update_summary(), self._emit_changed())
            )
            exed.textChanged.connect(self._emit_changed)
            tx_plain.textChanged.connect(self._emit_changed)
            tked.textChanged.connect(self._emit_changed)
            upd_ex()

            o_fl.addRow("说话人 kind", kcb)
            o_fl.addRow("名字 / npcId", exed_row)
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
                    # 拍级头像无 UI（节点级选择器作各拍默认），但既有数据必须随行保真回写
                    "portrait": copy.deepcopy((beat or {}).get("portrait"))
                    if isinstance(beat, dict)
                    else None,
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
        b_add_end = QPushButton("在末尾添加一句", self._body)
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

        legacy_wrap = QWidget(self._body)
        kind_cb = QComboBox(legacy_wrap)
        for k in SpeakerKinds:
            kind_cb.addItem(k, k)
        idx = kind_cb.findData(kind)
        kind_cb.setCurrentIndex(max(0, idx))
        extra_edit = QLineEdit(extra, legacy_wrap)
        extra_npc_btn = self._make_npc_pick_button(extra_edit, "选择说话人 · sceneNpc")
        extra_row = QWidget(legacy_wrap)
        extra_row_lo = QHBoxLayout(extra_row)
        extra_row_lo.setContentsMargins(0, 0, 0, 0)
        extra_row_lo.addWidget(extra_edit, 1)
        extra_row_lo.addWidget(extra_npc_btn)
        text_edit = self._make_player_textedit(
            str(data.get("text", "")), "对白正文", min_lines=4, parent=legacy_wrap
        )
        text_key = QLineEdit(str(data.get("textKey", "")), legacy_wrap)
        text_key.setPlaceholderText("可选：strings 键")
        leg_l = QFormLayout(legacy_wrap)
        _form_wrap_rows(leg_l)
        leg_l.addRow("说话人 kind", kind_cb)
        leg_l.addRow("名字 / npcId", extra_row)
        leg_l.addRow("text", text_edit)
        leg_l.addRow("textKey（可选）", text_key)

        def upd_extra_label():
            k = kind_cb.currentData()
            extra_row.setVisible(k in ("literal", "sceneNpc"))
            extra_npc_btn.setVisible(k == "sceneNpc")  # 仅 sceneNpc 才是 npcId 引用
            extra_edit.setPlaceholderText("显示名" if k == "literal" else "npcId")

        kind_cb.currentIndexChanged.connect(lambda _: (upd_extra_label(), self._emit_changed()))
        for w in (extra_edit, text_edit, text_key):
            w.textChanged.connect(self._emit_changed)
        upd_extra_label()

        next_edit = QLineEdit(str(data.get("next", "")), self._body)
        next_edit.setPlaceholderText("下一节点 id")
        pick = QPushButton("选…", self._body)
        pick.clicked.connect(lambda: self._pick_target(next_edit))
        next_edit.textChanged.connect(self._emit_changed)
        self._install_target_validation(next_edit)

        def toggle_multi():
            on = cb_multi.isChecked()
            legacy_wrap.setVisible(not on)
            beats_wrap.setVisible(on)
            self._emit_changed()

        def on_multi_toggled(checked: bool) -> None:
            # 取消多拍会丢弃已录入的多句台词：有多于一句时先确认（审查 P3-3）
            if not checked and len(beat_rows) > 1:
                r = QMessageBox.question(
                    self, "多拍对白",
                    f"取消多拍将只保留首句、丢弃其余 {len(beat_rows) - 1} 句台词。继续？",
                    QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
                    QMessageBox.StandardButton.Cancel,
                )
                if r != QMessageBox.StandardButton.Ok:
                    cb_multi.blockSignals(True)
                    cb_multi.setChecked(True)
                    cb_multi.blockSignals(False)
                    return
            toggle_multi()

        cb_multi.toggled.connect(on_multi_toggled)
        toggle_multi()

        # —— 节点级头像（可选）：写 node.portrait；多拍模式下作各拍默认（拍级自带的覆盖之）。
        # 立绘集三态：（无头像）/ 跟随说话NPC（只写 emotion，运行时按 NPC.portraitSlug 解析）/ 显式集。
        FOLLOW_NPC = "@npc"
        POR_RAW = "@raw"  # 畸形 portrait（缺 emotion 等）走只读透传，不自动补首表情（审查 P3）
        por0 = data.get("portrait")
        por0 = por0 if isinstance(por0, dict) else None
        por_slug0 = str(por0.get("slug") or "").strip() if por0 else ""
        por_emo0 = str(por0.get("emotion") or "").strip() if por0 else ""
        # 数据里是 dict 但缺 emotion（表单表达不了）：原样透传，不吃键、不补值。
        por_raw_passthrough: dict[str, Any] | None = (
            copy.deepcopy(por0) if (por0 is not None and not por_emo0) else None
        )
        if por0 is not None and por_emo0 and not por_slug0:
            por_slug0 = FOLLOW_NPC  # 数据里 emotion-only = 跟随说话NPC

        por_wrap = QWidget(self._body)
        por_lo = QHBoxLayout(por_wrap)
        por_lo.setContentsMargins(0, 0, 0, 0)
        slug_cb = QComboBox(por_wrap)
        slug_cb.addItem("（无头像）", "")
        slug_cb.addItem("跟随说话人", FOLLOW_NPC)
        for s in load_portrait_sets(self._project_root):
            slug_cb.addItem(s, s)
        if por_raw_passthrough is not None:
            _raw_lbl = por_slug0 if por_slug0 else "…"
            slug_cb.addItem(f"(数据) {_raw_lbl}", POR_RAW)
            slug_cb.setCurrentIndex(slug_cb.findData(POR_RAW))
        else:
            if por_slug0 and slug_cb.findData(por_slug0) < 0:
                # 数据里带了未知立绘集：保留可见可选，不静默清掉
                slug_cb.addItem(f"{por_slug0}（缺集）", por_slug0)
            slug_cb.setCurrentIndex(max(0, slug_cb.findData(por_slug0)))
        slug_cb.setToolTip(
            "立绘集（resources/runtime/images/dialogue_portraits/<slug>/）\n"
            "「跟随说话人」= 只存表情，运行时按说话人当前生效的装扮配置解析：\n"
            "  npc/sceneNpc → 该 NPC 配置的 portraitSlug（共享图自动跟人换脸）；\n"
            "  player → 主角当前装扮配置（game_config.playerAvatar / setPlayerAvatar 切换）。\n"
            "literal 说话人解析不到、不显头像。多拍模式下作各拍默认头像。"
        )
        emo_cb = QComboBox(por_wrap)
        emo_cb.setToolTip("表情；运行时按 <slug>_<emotion>.png 加载")
        por_preview = QLabel(por_wrap)
        por_preview.setFixedHeight(72)
        por_preview.setMinimumWidth(72)

        def _por_follow_resolved_slug() -> str:
            """「跟随说话人」在编辑器里的预览解析（尽力而为，解析不到不拦截）。"""
            k = kind_cb.currentData()
            if k == "player":
                return player_default_portrait_slug(self._project_root)
            if k == "sceneNpc":
                nid = extra_edit.text().strip()
                if nid and nid != "@contextNpc":
                    return npc_portrait_slug_index(self._project_root).get(nid, "")
            gid = (
                self._dialogue_graph_id_getter() if self._dialogue_graph_id_getter else ""
            )
            return graph_context_portrait_slug(self._project_root, gid or "")

        def _por_effective_slug() -> str:
            slug = str(slug_cb.currentData() or "")
            return _por_follow_resolved_slug() if slug == FOLLOW_NPC else slug

        def _por_refresh_emotions() -> None:
            picked = str(slug_cb.currentData() or "")
            eff = _por_effective_slug()
            want = str(emo_cb.currentData() or "") or por_emo0
            emo_cb.blockSignals(True)
            emo_cb.clear()
            if not picked or picked == POR_RAW:
                # 无头像 / 畸形透传：表情不可选，不自动补首表情（透传保原值）。
                emo_cb.setEnabled(False)
            else:
                emo_cb.setEnabled(True)
                pairs = (
                    load_portrait_emotions(self._project_root, eff)
                    if eff
                    else list(_PORTRAIT_EMOTIONS_FALLBACK)
                )
                for emo, label in pairs:
                    emo_cb.addItem(label, emo)
                if want and emo_cb.findData(want) < 0:
                    emo_cb.addItem(f"{want}（缺图）", want)
                idx = emo_cb.findData(want)
                emo_cb.setCurrentIndex(idx if idx >= 0 else 0)
            emo_cb.blockSignals(False)

        def _por_refresh_preview() -> None:
            picked = str(slug_cb.currentData() or "")
            eff = _por_effective_slug()
            emo = str(emo_cb.currentData() or "")
            if picked == POR_RAW:
                por_preview.setStyleSheet("color: #999;")
                por_preview.setText("(数据) 透传")
                por_preview.setToolTip(
                    "该头像数据缺 emotion 等字段、表单无法编辑，已原样保留。\n"
                    "改选立绘集即可切回正常编辑。"
                )
                return
            if not picked or not emo:
                por_preview.clear()
                por_preview.setToolTip("")
                return
            if not eff:
                # 跟随NPC但当前上下文解析不到：运行时按实际挂载 NPC 解析，编辑器仅提示
                por_preview.setStyleSheet("color: #999;")
                por_preview.setText("运行时按NPC解析")
                por_preview.setToolTip("说话 NPC 的 portraitSlug 在场景里配置")
                return
            p = portrait_image_path(self._project_root, eff, emo)
            por_preview.setToolTip(str(p))
            if p.is_file():
                pm = QPixmap(str(p))
                por_preview.setStyleSheet("")
                por_preview.setPixmap(
                    pm.scaledToHeight(72, Qt.TransformationMode.SmoothTransformation)
                )
            else:
                por_preview.setStyleSheet("color: #e66;")
                por_preview.setText("缺图")

        slug_cb.currentIndexChanged.connect(
            lambda _i: (_por_refresh_emotions(), _por_refresh_preview(), self._emit_changed())
        )
        emo_cb.currentIndexChanged.connect(
            lambda _i: (_por_refresh_preview(), self._emit_changed())
        )
        # 说话人变化会影响「跟随NPC」的解析结果：跟随模式下联动刷新（不触发 changed，纯预览）
        kind_cb.currentIndexChanged.connect(
            lambda _i: (
                (_por_refresh_emotions(), _por_refresh_preview())
                if str(slug_cb.currentData() or "") == FOLLOW_NPC
                else None
            )
        )
        extra_edit.textChanged.connect(
            lambda _t: (
                (_por_refresh_emotions(), _por_refresh_preview())
                if str(slug_cb.currentData() or "") == FOLLOW_NPC
                else None
            )
        )
        _por_refresh_emotions()
        _por_refresh_preview()

        por_lo.addWidget(slug_cb, 2)
        por_lo.addWidget(emo_cb, 1)
        por_lo.addWidget(por_preview)
        por_lo.addStretch(1)
        flp = QFormLayout()
        _form_wrap_rows(flp)
        flp.addRow("头像（可选）", por_wrap)

        def collect_portrait() -> dict[str, Any] | None:
            slug = str(slug_cb.currentData() or "").strip()
            if slug == POR_RAW:
                # 畸形形状原样透传（不吃键、不补首表情，审查 P3）
                return copy.deepcopy(por_raw_passthrough) if por_raw_passthrough is not None else None
            emo = str(emo_cb.currentData() or "").strip()
            if not slug or not emo:
                return None
            if slug == FOLLOW_NPC:
                return {"emotion": emo}
            return {"slug": slug, "emotion": emo}

        row_n = QHBoxLayout()
        row_n.addWidget(next_edit)
        row_n.addWidget(pick)
        fln = QFormLayout()
        _form_wrap_rows(fln)
        fln.addRow("next", row_n)

        self._body_layout.addWidget(cb_multi)
        self._body_layout.addWidget(legacy_wrap)
        self._body_layout.addWidget(beats_wrap)
        self._body_layout.addLayout(flp)
        self._body_layout.addLayout(fln)
        self._topology_refs = {"type": "line", "next_edit": next_edit}

        def collect_beats() -> list[dict[str, Any]]:
            out_beats: list[dict[str, Any]] = []
            for r in beat_rows:
                kcb = r["kcb"]
                exed = r["exed"]
                tx_plain = r["tx_plain"]
                tked = r["tked"]
                # tx_plain 可能是 RichTextTextEdit（富文本）或 QPlainTextEdit（无 pm 退回），
                # 二者都提供 toPlainText；用 duck-type 判断，避免误跳过整拍导致丢词。
                if (
                    not isinstance(kcb, QComboBox)
                    or not isinstance(exed, QLineEdit)
                    or not hasattr(tx_plain, "toPlainText")
                    or not isinstance(tked, QLineEdit)
                ):
                    continue
                kk = kcb.currentData()
                ex = exed.text().strip()
                b = {"speaker": _ui_to_speaker(kk, ex)}
                b["text"] = tx_plain.toPlainText()
                tk = tked.text().strip()
                if tk:
                    b["textKey"] = tk
                if r.get("portrait") is not None:
                    b["portrait"] = copy.deepcopy(r["portrait"])
                out_beats.append(b)
            return out_beats

        # 多拍模式下，顶层 speaker/text/textKey 只是 lines[0] 的镜像（运行时取 lines[0]）。
        # 为「数据零改写」，原文件若已带这些顶层字段则原样保留，不用 lines[0] 覆盖。
        _orig_has_text = "text" in data
        _orig_text = data.get("text")
        _orig_has_text_key = "textKey" in data
        _orig_text_key = data.get("textKey")
        _orig_has_speaker = "speaker" in data
        _orig_speaker = copy.deepcopy(data.get("speaker"))

        def getter():
            nxt = next_edit.text().strip()
            if cb_multi.isChecked():
                beats = collect_beats()
                if not beats:
                    raise ValueError("多拍模式至少保留一句台词")
                first = beats[0]
                out: dict[str, Any] = {
                    "type": "line",
                    "speaker": copy.deepcopy(_orig_speaker) if _orig_has_speaker else first["speaker"],
                    "next": nxt,
                    "lines": beats,
                }
                if _orig_has_text:
                    out["text"] = _orig_text
                else:
                    out["text"] = first.get("text", "")
                if _orig_has_text_key:
                    out["textKey"] = _orig_text_key
                # 原本无顶层 textKey 就不注入：beat0 的 textKey 属于 lines[0]，
                # 运行时取 lines[0]，不镜像到顶层（否则往返平白多出一个 textKey 键）。
                por = collect_portrait()
                if por is not None:
                    out["portrait"] = por
                return out
            k = kind_cb.currentData()
            ex = extra_edit.text().strip()
            out = {
                "type": "line",
                "speaker": _ui_to_speaker(k, ex),
                "next": nxt,
            }
            out["text"] = text_edit.toPlainText()
            tk = text_key.text().strip()
            if tk:
                out["textKey"] = tk
            por = collect_portrait()
            if por is not None:
                out["portrait"] = por
            return out

        self._getter = getter

    # --- runActions ---
    def _build_run_actions(self, data: dict[str, Any]):
        from tools.editor.shared.action_editor import ActionEditor

        acts = data.get("actions")
        if not isinstance(acts, list):
            acts = []
        next_edit = QLineEdit(str(data.get("next", "")), self._body)
        pick = QPushButton("选…", self._body)
        pick.clicked.connect(lambda: self._pick_target(next_edit))
        next_edit.textChanged.connect(self._emit_changed)
        self._install_target_validation(next_edit)

        fl = QFormLayout()
        _form_wrap_rows(fl)
        row = QHBoxLayout()
        row.addWidget(next_edit)
        row.addWidget(pick)
        fl.addRow("next", row)
        self._body_layout.addLayout(fl)

        pm = self._project_model_getter() if self._project_model_getter else None
        # parent=self._body：让 ae 的 parent 链一开始就落在 inspector 的可见子树内；
        # 先 addWidget 再 set_data，避免 row 构造时父 widget 还未挂到布局里短暂成为 orphan。
        ae = ActionEditor(
            "动作（与主编辑器 Action列表同源）",
            self._body,
            show_reorder_buttons=True,
        )
        ae.set_project_context(pm, None)
        self._body_layout.addWidget(ae)
        to_load: list[dict[str, Any]] = []
        if acts:
            for a in acts:
                if isinstance(a, dict):
                    to_load.append(a)
        # 不再为空 actions 注入占位 setFlag——否则「空 runActions」打开即被改写成 1 条动作。
        # 空列表交给 ActionEditor 展示「+ 添加」入口，getter 原样回写 []。
        ae.set_data(to_load)
        ae.changed.connect(self._emit_changed)
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
    def _make_cost_coins_spin(on_change, parent: QWidget | None = None) -> QSpinBox:
        sp = QSpinBox(parent)
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
        cb_pl = QCheckBox("有 promptLine（选项前多播一行）", self._body)
        cb_pl.setChecked(bool(has_pl))
        prompt_box = QGroupBox("promptLine", self._body)

        sp = (pl or {}).get("speaker") if has_pl else {"kind": "player"}
        if not isinstance(sp, dict):
            sp = {"kind": "player"}
        kind, extra = _speaker_to_ui(sp)
        pl_kind = QComboBox(prompt_box)
        for k in SpeakerKinds:
            pl_kind.addItem(k, k)
        pl_kind.setCurrentIndex(max(0, pl_kind.findData(kind)))
        pl_extra_stack = QStackedWidget(prompt_box)
        pl_extra_line = QLineEdit(prompt_box)
        pl_npc_wrap = QWidget(prompt_box)
        pl_npc_lo = QHBoxLayout(pl_npc_wrap)
        pl_npc_lo.setContentsMargins(0, 0, 0, 0)
        pl_npc_edit = QLineEdit(pl_npc_wrap)
        pl_npc_edit.setPlaceholderText("手输 npcId或点「选…」在对话框中搜索")
        pl_npc_edit.setToolTip(
            "可手输任意 npcId。\n"
            f"点「选…」打开可搜索列表（含「{PROMPT_LINE_SCENE_NPC_CONTEXT_TOKEN}」=进入图时传入的 npcId）。"
        )
        pl_npc_btn = QPushButton("选…", pl_npc_wrap)
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
        pl_extra_lbl = QLabel(prompt_box)
        pl_text = self._make_player_textedit(
            str((pl or {}).get("text", "")), "选项前多播一行对白", min_lines=2, parent=prompt_box
        )
        pl_text_key = QLineEdit(str((pl or {}).get("textKey", "") or ""), prompt_box)
        pl_text_key.setPlaceholderText("可选：strings 键")
        pl_text_key.textChanged.connect(self._emit_changed)
        pl_portrait = PortraitRefField(self._project_root, (pl or {}).get("portrait"), prompt_box)
        pl_portrait.changed.connect(self._emit_changed)

        pfl = QFormLayout()
        _form_wrap_rows(pfl)
        pfl.addRow("kind", pl_kind)
        pfl.addRow(pl_extra_lbl, pl_extra_stack)
        pfl.addRow("text", pl_text)
        pfl.addRow("textKey（可选）", pl_text_key)
        pfl.addRow("立绘（可选）", pl_portrait)
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
        rows_wrap = QWidget(self._body)
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
            outer = QWidget(rows_wrap)
            ov = QVBoxLayout(outer)
            ov.setContentsMargins(0, 0, 0, 0)
            ov.setSpacing(4)

            header = QHBoxLayout()
            toggle = QToolButton(outer)
            toggle.setAutoRaise(True)
            toggle.setArrowType(Qt.ArrowType.RightArrow)
            toggle.setToolTip("折叠 / 展开本条详细表单")
            summary = QLabel(outer)
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

            content = QWidget(outer)
            o_fl = QFormLayout(content)
            _form_wrap_rows(o_fl)
            id_e = QLineEdit(str(od.get("id", "")), content)
            text_e = self._make_player_textedit(
                str(od.get("text", "")), "玩家看到的选项文字", min_lines=2, parent=content
            )
            nx = QLineEdit(str(od.get("next", "")), content)
            pick = QPushButton("选…", content)
            pick.clicked.connect(lambda _c=False, le=nx: self._pick_target(le))
            self._install_target_validation(nx)
            nx_lo = QHBoxLayout()
            nx_lo.addWidget(nx, 1)
            nx_lo.addWidget(pick)

            rf_wrap = QWidget(content)
            rf_lo = QHBoxLayout(rf_wrap)
            rf_lo.setContentsMargins(0, 0, 0, 0)
            rf_edit = QLineEdit(str(od.get("requireFlag", "") or ""), rf_wrap)
            rf_edit.setReadOnly(True)
            rf_edit.setPlaceholderText(
                "（无）点「选择…」打开登记表（与主编辑器 Flag 选择器相同）"
            )
            rf_edit.setToolTip("仅当 flagStore 中该键为真时选项可选；须从登记表选取以保证键名一致。")
            rf_pick = QPushButton("选择…", rf_wrap)
            rf_clear = QPushButton("清除", rf_wrap)

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

            cost_sp = self._make_cost_coins_spin(self._emit_changed, content)
            self._set_cost_coins_spin(cost_sp, od.get("costCoins"))

            from tools.editor.shared.action_editor import FilterableTypeCombo

            rh_entries: list[tuple[str, str]] = [
                ("(无：不标规矩样式)", ""),
            ]
            for rid, rname in rule_pairs:
                rh_entries.append((f"{rname}（{rid}）", rid))
            # select_only=True：不让 editable 模式在构造时触发 QComboBoxPrivateContainer 顶层闪烁。
            rh_cb = FilterableTypeCombo(rh_entries, content, select_only=True)
            rh_cb.setToolTip(
                "对话 UI 上「规矩」标签与配色；与 requireFlag 是否满足无关。\n"
                "若下方「灰显点击提示」留空，锁定时会用 strings 中 choiceNeedRule 并结合该规矩名称生成说明。"
            )
            rh_cb.set_committed_type(str(od.get("ruleHintId", "") or ""))
            rh_cb.typeCommitted.connect(lambda _t: self._emit_changed())

            hint_plain = self._make_player_textedit(
                str(od.get("disabledClickHint", "") or ""),
                "可选。选项灰显时玩家点击后弹出此处全文；留空则由游戏按规矩名/铜钱等自动生成。",
                min_lines=2,
                parent=content,
            )
            hint_plain.textChanged.connect(self._emit_changed)

            o_fl.addRow("选项 id", id_e)
            o_fl.addRow("选项文案", text_e)
            wnx = QWidget(content)
            wnx.setLayout(nx_lo)
            o_fl.addRow("连线至 next", wnx)
            o_fl.addRow("前提标志 requireFlag", rf_wrap)
            o_fl.addRow("花费铜钱 costCoins", cost_sp)
            o_fl.addRow("关联规矩 ruleHintId", rh_cb)
            o_fl.addRow("灰显时点击提示 disabledClickHint", hint_plain)

            req_g = QGroupBox(
                "可选：requireCondition（ConditionExpr；与 requireFlag 同时存在则均须满足）",
                content,
            )
            rg_l = QVBoxLayout(req_g)

            def _pm_get() -> Any:
                return self._project_model_getter() if self._project_model_getter else None

            req_tree = ConditionExprTreeRootWidget(req_g, model_getter=_pm_get)
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
        b_add = QPushButton("在末尾添加选项", self._body)
        b_add.setToolTip("在列表最后追加一条空白选项")

        def do_add_end() -> None:
            insert_blank_option_at(len(option_rows))

        b_add.clicked.connect(do_add_end)
        obar.addWidget(b_add)

        self._body_layout.addWidget(
            _help_marker(
                "选项：requireFlag 登记表；requireCondition 为 ConditionExpr；"
                "ruleHintId 规矩样式；disabledClickHint 灰显点击全文提示。",
                self._body,
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
                hint_s = r["hint_plain"].toPlainText()
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
                pl_out: dict[str, Any] = {
                    "speaker": _ui_to_speaker(k, ex),
                    "text": pl_text.toPlainText(),
                }
                pl_tk = pl_text_key.text().strip()
                if pl_tk:
                    pl_out["textKey"] = pl_tk
                pl_por = pl_portrait.to_ref()
                if pl_por:
                    pl_out["portrait"] = pl_por
                out["promptLine"] = pl_out
            return out

        self._getter = getter
        self._topology_refs = {"type": "choice", "option_rows": option_rows}

    # --- switch ---
    def _build_switch(self, data: dict[str, Any]):
        cases_raw = data.get("cases")
        if not isinstance(cases_raw, list):
            cases_raw = []

        pm_switch = self._project_model_getter() if self._project_model_getter else None

        dn = QLineEdit(str(data.get("defaultNext", "")), self._body)
        pickd = QPushButton("选…", self._body)
        pickd.clicked.connect(lambda: self._pick_target(dn))
        dn.textChanged.connect(self._emit_changed)
        self._install_target_validation(dn)
        fl = QFormLayout()
        _form_wrap_rows(fl)
        rowd = QHBoxLayout()
        rowd.addWidget(dn)
        rowd.addWidget(pickd)
        fl.addRow("defaultNext", rowd)
        self._body_layout.addLayout(fl)
        self._body_layout.addWidget(
            _help_marker(
                "分支：自上而下命中第一条。"
                "每条可选用「多条条件 AND」或「单条结构化 ConditionExpr（与运行时 evaluateConditionExpr 一致）」；"
                "后者保存时写入 condition字段并优先于 conditions。",
                self._body,
            ),
        )

        cases_wrap = QWidget(self._body)
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
            # 原本是否带 conditions 键（含空数组）——getter 据此保真回写，不注入 conditions:[]。
            _orig_conditions_present = isinstance(case, dict) and "conditions" in case
            outer = QWidget(cases_wrap)
            ov = QVBoxLayout(outer)
            ov.setContentsMargins(0, 0, 0, 0)
            ov.setSpacing(4)

            header = QHBoxLayout()
            toggle = QToolButton(outer)
            toggle.setAutoRaise(True)
            toggle.setArrowType(Qt.ArrowType.RightArrow)
            toggle.setToolTip("折叠 / 展开本分支")
            summary = QLabel(outer)
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

            content = QWidget(outer)
            cv = QVBoxLayout(content)
            cv.setContentsMargins(0, 0, 0, 0)
            nx = QLineEdit(str((case or {}).get("next", "")), content)
            pk = QPushButton("选…", content)
            pk.clicked.connect(lambda: self._pick_target(nx))
            nx.textChanged.connect(self._emit_changed)
            self._install_target_validation(nx)
            hr = QHBoxLayout()
            hr.addWidget(QLabel("next", content))
            hr.addWidget(nx, 1)
            hr.addWidget(pk)
            cv.addLayout(hr)

            case_mode = QComboBox(content)
            case_mode.addItem("多条条件（AND）", "and")
            case_mode.addItem("ConditionExpr（结构化）", "expr")
            cm_row = QHBoxLayout()
            cm_row.addWidget(QLabel("本分支条件", content))
            cm_row.addWidget(case_mode, 1)
            cv.addLayout(cm_row)

            def _pm_get() -> Any:
                return self._project_model_getter() if self._project_model_getter else None

            expr_tree = ConditionExprTreeRootWidget(content, model_getter=_pm_get)
            expr_tree.changed.connect(self._emit_changed)
            cv.addWidget(expr_tree)

            btn_and_to_json = QPushButton(
                "将当前 AND 条件转成结构化 ConditionExpr", content
            )
            cv.addWidget(btn_and_to_json)

            cond_rows_layout = QVBoxLayout()
            cond_rows_layout.setSpacing(4)
            cond_rows_wrap = QWidget(content)
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
                return self._build_switch_and_cond_row(
                    cd,
                    pm_switch=pm_switch,
                    cond_rows=cond_rows,
                    cond_rows_wrap=cond_rows_wrap,
                    insert_cond_at=insert_cond_at,
                    rebuild_cond_layout=rebuild_cond_layout,
                    refresh_cond_nav=refresh_cond_nav,
                    refresh_cond_fold_policy=refresh_cond_fold_policy,
                    update_case_summary=update_case_summary,
                )

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
            # 原本 conditions:[] / 既无 conditions 也无 condition：保持空 AND 列表，
            # 不再注入 some_flag 占位（新建分支的起始占位由 insert/add 路径显式给出）。
            # getter 依 _orig_conditions_present 决定是否回写空 conditions 数组，保真零丢失。

            nx.textChanged.connect(lambda _t: (update_case_summary(), self._emit_changed()))

            b_cond_end = QPushButton("在末尾添加条件", content)
            b_cond_end.clicked.connect(lambda: insert_cond_at(len(cond_rows)))
            and_block = QWidget(content)
            and_lay = QVBoxLayout(and_block)
            and_lay.setContentsMargins(0, 0, 0, 0)
            and_lay.addWidget(QLabel("条件（AND，全部满足）", and_block))
            and_lay.addWidget(cond_rows_wrap)
            and_lay.addWidget(b_cond_end)
            cv.addWidget(and_block)

            def _sync_case_mode_ui() -> None:
                ex = case_mode.currentData() == "expr"
                expr_tree.setVisible(ex)
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
                expr_tree.set_expr(wrap)
                case_mode.setCurrentIndex(1)
                _sync_case_mode_ui()
                update_case_summary()
                self._emit_changed()

            btn_and_to_json.clicked.connect(on_export_and)

            if isinstance(cond_expr_init, dict) and cond_expr_init:
                case_mode.setCurrentIndex(1)
                expr_tree.set_expr(cond_expr_init)
            else:
                expr_tree.set_expr(None)

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
                    "expr_tree": expr_tree,
                    "btn_up": btn_up,
                    "btn_down": btn_down,
                    "orig_conditions_present": _orig_conditions_present,
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
        bc_add = QPushButton("在末尾添加分支", self._body)

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
                case_out: dict[str, Any] = {"next": next_s}
                if cb["case_mode"].currentData() == "expr":
                    obj = cb["expr_tree"].get_expr()
                    if isinstance(obj, dict) and obj:
                        case_out["condition"] = obj
                    elif cb.get("orig_conditions_present"):
                        case_out["conditions"] = []
                    # 否则：原本无 conditions 键（裸 next / 仅 condition 被清空）→ 不注入
                else:
                    conds = [r["serialize"]() for r in cb["cond_rows"]]
                    if conds:
                        case_out["conditions"] = conds
                    elif cb.get("orig_conditions_present"):
                        case_out["conditions"] = []
                    # 否则裸 next，不注入 conditions:[]
                cs.append(case_out)
            return {"type": "switch", "cases": cs, "defaultNext": dn.text().strip()}

        self._getter = getter

    def _build_switch_and_cond_row(
        self,
        cd: dict[str, Any] | None,
        *,
        pm_switch: Any,
        cond_rows: list[dict[str, Any]],
        cond_rows_wrap: QWidget,
        insert_cond_at: Callable[..., None],
        rebuild_cond_layout: Callable[[], None],
        refresh_cond_nav: Callable[[], None],
        refresh_cond_fold_policy: Callable[[], None],
        update_case_summary: Callable[[], None],
    ) -> dict[str, Any]:
        """switch 分支「多条条件 AND」列表里的单条叶子编辑器。

        原为 _build_switch → make_case_block → make_cond_block 三层嵌套闭包；抽成方法后
        其对外依赖（本分支的条件行列表与刷新回调、ProjectModel）以参数显式传入，
        _build_switch 的体量与嵌套深度显著下降。返回该条件行的 record（含 serialize）。
        """
        crow: dict[str, Any] = {"collapsed": True}
        cow = QWidget(cond_rows_wrap)
        col = QVBoxLayout(cow)
        col.setContentsMargins(0, 0, 0, 0)
        col.setSpacing(4)
        ch = QHBoxLayout()
        ctog = QToolButton(cow)
        ctog.setAutoRaise(True)
        ctog.setArrowType(Qt.ArrowType.RightArrow)
        ctog.setToolTip("折叠 / 展开本条件")
        csum = QLabel(cow)
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

        body = QWidget(cow)
        h = QHBoxLayout(body)
        h.setContentsMargins(0, 0, 0, 0)
        # 不能在结构化模式表达的叶子（scenarioLine / not / all / any / 未知形）
        # 原样保留，不被改写；需编辑时切到本分支的「结构化」模式。
        raw_passthrough: dict[str, Any] = {"v": None}
        _had_op = isinstance(cd, dict) and "op" in cd
        # 记录原子原本带哪些可选键，序列化时忠实还原、不注入不丢弃（零丢失往返）：
        _had_value = isinstance(cd, dict) and "value" in cd
        _had_quest_status = (
            isinstance(cd, dict)
            and isinstance(cd.get("quest"), str)
            and ("questStatus" in cd or "status" in cd)
        )
        # 载入时 quest 状态的默认显示值（无 status 键时回退 Active）；序列化时用它区分
        # "用户主动改了状态下拉"与"从未动过"——前者必须写出，否则改了下拉却被静默丢弃
        #（审查 P1-40：_had_quest_status 是构建期常量，保真"不注入"矫枉过正到主动编辑）。
        _quest_status_loaded = {"v": "Active"}
        mode = QComboBox(body)
        mode.addItem("标志 flag", "flag")
        mode.addItem("任务 quest", "quest")
        mode.addItem("scenario", "scenario")
        mode.addItem("叙事 narrative", "narrative")
        op_cb = QComboBox(body)
        for o in ("==", "!=", ">", "<", ">=", "<="):
            op_cb.addItem(o, o)
        qid_e = QLineEdit(body)
        st_cb = QComboBox(body)
        for s in ("Inactive", "Active", "Completed"):
            st_cb.addItem(s, s)
        flag_w = QWidget(body)
        fh = QHBoxLayout(flag_w)
        fh.setContentsMargins(0, 0, 0, 0)
        fh.addWidget(QLabel("flag", flag_w))
        if pm_switch is not None:
            from tools.editor.shared.flag_key_field import FlagKeyPickField

            flag_ctrl = FlagKeyPickField(pm_switch, None, "", body)

            def _get_flag() -> str:
                return flag_ctrl.key()

            def _set_flag(s: str) -> None:
                flag_ctrl.set_key(s)
        else:
            flag_ctrl = QLineEdit(body)
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
        val_kind = QComboBox(body)
        val_kind.addItem("布尔", "bool")
        val_kind.addItem("整数", "int")
        val_kind.addItem("小数", "float")
        val_kind.addItem("文本", "str")
        val_stack = QStackedWidget(body)
        val_bool = QComboBox(body)
        val_bool.addItem("false", False)
        val_bool.addItem("true", True)
        val_int = QSpinBox(body)
        val_int.setRange(-2_147_483_648, 2_147_483_647)
        val_float = QDoubleSpinBox(body)
        val_float.setRange(-1e12, 1e12)
        val_float.setDecimals(8)
        val_str = QLineEdit(body)
        val_stack.addWidget(val_bool)
        val_stack.addWidget(val_int)
        val_stack.addWidget(val_float)
        val_stack.addWidget(val_str)
        fh.addWidget(QLabel("值", flag_w))
        fh.addWidget(val_kind)
        fh.addWidget(val_stack, 1)

        quest_w = QWidget(body)
        qh = QHBoxLayout(quest_w)
        qh.setContentsMargins(0, 0, 0, 0)
        qh.addWidget(QLabel("questId", quest_w))
        qh.addWidget(qid_e, 1)
        qh.addWidget(
            self._make_id_pick_button(
                qid_e,
                self._quest_entries_for_picker,
                title="选择 quest",
                tip="打开可搜索的任务列表",
            )
        )
        qh.addWidget(QLabel("状态", quest_w))
        qh.addWidget(st_cb)

        scenario_w = QWidget(body)
        sc_form = QFormLayout(scenario_w)
        sc_form.setContentsMargins(0, 0, 0, 0)
        scen_ids: list[str] = []
        if pm_switch is not None:
            scen_ids = list(pm_switch.scenario_ids_ordered())
        # 直接用不可编辑 QComboBox + 固定 placeholder；规避 editable combobox
        # activated -> clear/addItem 路径引发的原生崩溃。
        scen_id_combo = QComboBox(scenario_w)
        scen_id_combo.setEditable(False)
        scen_id_combo.addItem("(未选)", "")
        for sid in scen_ids:
            scen_id_combo.addItem(sid, sid)
        if not scen_ids:
            scen_id_combo.addItem("(无 scenarios.json 数据)", "")
            scen_id_combo.setEnabled(False)
        phase_combo = QComboBox(scenario_w)
        phase_combo.setEditable(False)
        scen_status = QComboBox(scenario_w)
        scen_status.setEditable(False)
        for s in ("pending", "active", "done", "locked"):
            scen_status.addItem(s, s)
        scen_outcome = QLineEdit(scenario_w)
        scen_outcome.setPlaceholderText("可选，与 scenario phase 的 outcome 比较")

        def resolved_scenario_id() -> str:
            dv = scen_id_combo.currentData()
            return str(dv).strip() if isinstance(dv, str) else ""

        def refill_scen_phases() -> None:
            sid = resolved_scenario_id()
            phs = (
                pm_switch.phases_for_scenario(sid)
                if pm_switch and sid
                else []
            )
            # 用 currentData 记录真实 phase 值（旧实现用 currentText，对「(缺失) p1」
            # 展示项 text≠data → findData 落空 → phase 被静默清空写 phase:""，审查 P1-41）
            cur = phase_combo.currentData()
            cur = str(cur).strip() if isinstance(cur, str) else ""
            phase_combo.blockSignals(True)
            phase_combo.clear()
            phase_combo.addItem("(未选)", "")
            for p in phs:
                phase_combo.addItem(p, p)
            if cur:
                ix = phase_combo.findData(cur)
                if ix < 0:
                    # 清单外 phase 保值（改名/删除/跨 scenario）：加「(缺失)」项而非丢弃
                    phase_combo.addItem(f"(缺失) {cur}", cur)
                    ix = phase_combo.count() - 1
                phase_combo.setCurrentIndex(ix)
            phase_combo.blockSignals(False)

        scen_id_combo.currentIndexChanged.connect(
            lambda _i: (refill_scen_phases(), update_csum(), self._emit_changed()),
        )
        for wsig in (phase_combo, scen_status):
            wsig.currentIndexChanged.connect(
                lambda _i: (update_csum(), self._emit_changed()),
            )
        scen_outcome.textChanged.connect(
            lambda _t: (update_csum(), self._emit_changed()),
        )
        sc_form.addRow("scenarioId", scen_id_combo)
        sc_form.addRow("phase", phase_combo)
        sc_form.addRow("status", scen_status)
        sc_form.addRow("outcome", scen_outcome)

        narrative_w = QWidget(body)
        nh = QHBoxLayout(narrative_w)
        nh.setContentsMargins(0, 0, 0, 0)
        nh.addWidget(QLabel("narrative", narrative_w))
        narr_id_e = QLineEdit(narrative_w)
        narr_id_e.setPlaceholderText("wrapper/scenario 图 id 或 @owner/@scene")
        nh.addWidget(narr_id_e, 1)
        nh.addWidget(
            self._make_id_pick_button(
                narr_id_e,
                self._narrative_graph_entries_for_picker,
                title="选择叙事图",
                tip="wrapper/scenario 叙事图 id，或 @owner/@scene 相对 token",
            )
        )
        self._install_narrative_id_validation(narr_id_e)
        nh.addWidget(QLabel("state", narrative_w))
        narr_state_e = QLineEdit(narrative_w)
        nh.addWidget(narr_state_e, 1)

        def _narr_state_entries() -> list[tuple[str, str]]:
            gid = narr_id_e.text().strip()
            pmx = self._project_model_getter() if self._project_model_getter else None
            if not gid or gid.startswith("@") or pmx is None or pmx.project_path is None:
                return []
            try:
                from tools.editor.shared.narrative_catalog import graph_states

                return [
                    (str(s), str(s))
                    for s in graph_states(pmx.project_path, gid)
                    if str(s).strip()
                ]
            except Exception:
                return []

        nh.addWidget(
            self._make_id_pick_button(
                narr_state_e,
                _narr_state_entries,
                title="选择状态",
                tip="按上方选定的叙事图列出其状态 id",
            )
        )
        narr_reached = QCheckBox("到达过(reached)", narrative_w)
        narr_reached.setToolTip("勾选=到达过该状态（含曾经）；不勾=仅当前处于该状态")
        nh.addWidget(narr_reached)

        # 复杂/未支持条件的原样只读展示
        raw_w = QWidget(body)
        rh = QHBoxLayout(raw_w)
        rh.setContentsMargins(0, 0, 0, 0)
        raw_lbl = QLabel(raw_w)
        raw_lbl.setWordWrap(True)
        raw_lbl.setStyleSheet("color: #ccc;")
        raw_lbl.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        raw_lbl.setToolTip(
            "scenarioLine / not / 嵌套 等结构化叶子原样保留，不会被改写；"
            "需要编辑请把本分支切到「结构化」模式。"
        )
        rh.addWidget(raw_lbl, 1)

        h.addWidget(mode)
        h.addWidget(flag_w, 1)
        h.addWidget(quest_w, 1)
        h.addWidget(scenario_w, 1)
        h.addWidget(narrative_w, 1)
        h.addWidget(raw_w, 1)

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
            if raw_passthrough["v"] is not None:
                mode.setVisible(False)
                flag_w.setVisible(False)
                quest_w.setVisible(False)
                scenario_w.setVisible(False)
                narrative_w.setVisible(False)
                raw_w.setVisible(True)
                return
            mode.setVisible(True)
            raw_w.setVisible(False)
            m = mode.currentData()
            flag_w.setVisible(m == "flag")
            quest_w.setVisible(m == "quest")
            scenario_w.setVisible(m == "scenario")
            narrative_w.setVisible(m == "narrative")
            if m == "scenario":
                refill_scen_phases()

        def update_csum() -> None:
            if raw_passthrough["v"] is not None:
                try:
                    compact = json.dumps(raw_passthrough["v"], ensure_ascii=False)
                except (TypeError, ValueError):
                    compact = str(raw_passthrough["v"])
                if len(compact) > 48:
                    compact = compact[:47] + "…"
                csum.setText(f"复杂条件（只读）: {compact}")
                return
            if mode.currentData() == "narrative":
                nid = narr_id_e.text().strip() or "…"
                nst = narr_state_e.text().strip() or "…"
                suffix = " · reached" if narr_reached.isChecked() else ""
                csum.setText(f"narrative {nid} · {nst}{suffix}")
                return
            if mode.currentData() == "scenario":
                sid_disp = resolved_scenario_id() or "…"
                ph_d = phase_combo.currentData()
                ph_s = str(ph_d).strip() if isinstance(ph_d, str) and ph_d else "…"
                st_d = scen_status.currentData()
                st_s = str(st_d).strip() if isinstance(st_d, str) and st_d else "…"
                csum.setText(f"scen {sid_disp} · {ph_s} · {st_s}")
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
            scen_id_combo.blockSignals(True)
            try:
                ix0 = scen_id_combo.findData(sid0) if sid0 else 0
                if ix0 < 0:
                    scen_id_combo.addItem(f"(缺失) {sid0}", sid0)
                    ix0 = scen_id_combo.count() - 1
                scen_id_combo.setCurrentIndex(ix0)
            finally:
                scen_id_combo.blockSignals(False)
            refill_scen_phases()
            ph0 = str(raw_c.get("phase", "")).strip()
            if ph0:
                ix = phase_combo.findData(ph0)
                if ix < 0:
                    phase_combo.addItem(f"(缺失) {ph0}", ph0)
                    ix = phase_combo.count() - 1
                phase_combo.setCurrentIndex(ix)
            st0 = str(raw_c.get("status", "pending")).strip() or "pending"
            ix2 = scen_status.findData(st0)
            if ix2 < 0:
                scen_status.addItem(f"(非枚举) {st0}", st0)
                ix2 = scen_status.count() - 1
            scen_status.setCurrentIndex(ix2)
            o0 = raw_c.get("outcome")
            scen_outcome.setText("" if o0 is None else str(o0))
        elif isinstance(raw_c.get("quest"), str):
            mode.setCurrentIndex(1)
            qid_e.setText(str(raw_c.get("quest", "")))
            qs = str(raw_c.get("questStatus") or raw_c.get("status") or "Active")
            ix = st_cb.findData(qs)
            st_cb.setCurrentIndex(max(0, ix))
            _quest_status_loaded["v"] = st_cb.currentData() or "Active"
        elif isinstance(raw_c.get("narrative"), str):
            mode.setCurrentIndex(mode.findData("narrative"))
            narr_id_e.setText(str(raw_c.get("narrative", "")))
            narr_state_e.setText(str(raw_c.get("state", "")))
            narr_reached.setChecked(raw_c.get("reached") is True)
        elif (
            any(k in raw_c for k in ("scenarioLine", "plane", "not", "all", "any"))
            or "flag" not in raw_c
        ):
            # 结构化/未识别叶子无法逐行表达：整条原样保留（只读），编辑请切「结构化」。
            # plane/scenarioLine 为后加条件叶(2026-07-13 修:此前 plane 落进下面的
            # flag 兜底被改写成 {"flag":""},打开即吃数据);任何未来新叶同样从这里
            # 透传——只有真正带 "flag" 键的原子才进 flag 编辑分支。
            raw_passthrough["v"] = copy.deepcopy(raw_c)
            try:
                raw_lbl.setText(json.dumps(raw_c, ensure_ascii=False, indent=2))
            except (TypeError, ValueError):
                raw_lbl.setText(str(raw_c))
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
        # quest 原本可能用 status 或 questStatus 作为键名，序列化时保持原样
        _quest_status_key = "status" if (
            "status" in raw_c and "questStatus" not in raw_c
        ) else "questStatus"

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
        for ww in (flag_ctrl, qid_e, val_str, narr_id_e, narr_state_e):
            if isinstance(ww, QLineEdit):
                ww.textChanged.connect(
                    lambda _t: (update_csum(), self._emit_changed())
                )
        narr_reached.toggled.connect(
            lambda _b: (update_csum(), self._emit_changed())
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
            if raw_passthrough["v"] is not None:
                return copy.deepcopy(raw_passthrough["v"])
            if mode.currentData() == "scenario":
                ph_d = phase_combo.currentData()
                st_d = scen_status.currentData()
                out_s: dict[str, Any] = {
                    "scenario": resolved_scenario_id(),
                    "phase": str(ph_d).strip() if isinstance(ph_d, str) else "",
                    "status": str(st_d).strip() if isinstance(st_d, str) else "",
                }
                oo = scen_outcome.text().strip()
                if oo:
                    out_s["outcome"] = oo
                return out_s
            if mode.currentData() == "quest":
                out_q: dict[str, Any] = {"quest": qid_e.text().strip()}
                # 原本带 status/questStatus → 忠实写回；原本没有但用户把下拉从载入默认
                # 改走了 → 也写出（主动编辑不丢）；从未动过 → 保持缺省不注入。
                if _had_quest_status or st_cb.currentData() != _quest_status_loaded["v"]:
                    out_q[_quest_status_key] = st_cb.currentData()
                return out_q
            if mode.currentData() == "narrative":
                out_n: dict[str, Any] = {
                    "narrative": narr_id_e.text().strip(),
                    "state": narr_state_e.text().strip(),
                }
                if narr_reached.isChecked():
                    out_n["reached"] = True
                return out_n
            outf: dict[str, Any] = {"flag": _get_flag()}
            op = op_cb.currentData() or "=="
            # 仅在原子原本带 op、或 op 非默认时才写出，避免给 {flag,value} 注入多余 op
            if op != "==" or _had_op:
                outf["op"] = op
            kd = val_kind.currentData()
            if kd == "bool":
                outf["value"] = val_bool.currentData()
            elif kd == "int":
                outf["value"] = val_int.value()
            elif kd == "float":
                outf["value"] = float(val_float.value())
            else:
                s = val_str.text().strip()
                # 原本带 value（即便空串）就忠实写回，不因 falsy 丢键。
                if s or _had_value:
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

    def _owner_wrapper_state_options(self) -> dict[str, Any]:
        from tools.editor.shared.narrative_catalog import resolve_owner_wrapper_states

        dialogue_id = ""
        if self._dialogue_graph_id_getter:
            dialogue_id = str(self._dialogue_graph_id_getter() or "").strip()
        model = self._project_model_getter() if self._project_model_getter else None
        if not dialogue_id or model is None:
            return {"stateIds": [], "ambiguous": False, "message": "无法解析对话图 id 或工程模型"}
        return resolve_owner_wrapper_states(self._project_root, model, dialogue_id)

    def _make_state_branch_rows(
        self,
        data: dict[str, Any],
        *,
        state_options: list[str],
        include_missing: bool,
    ) -> tuple[list[dict[str, Any]], QLineEdit, QLineEdit | None, Callable[[], dict[str, Any]]]:
        """构建 ownerState/contextState 的 cases UI，返回 (case_rows, default_next, missing_next, getter_factory)。"""
        cases_wrap = QWidget(self._body)
        cases_outer = QVBoxLayout(cases_wrap)
        cases_outer.setContentsMargins(0, 0, 0, 0)
        case_rows: list[dict[str, Any]] = []

        def rebuild_cases_layout() -> None:
            while cases_outer.count():
                it = cases_outer.takeAt(0)
                w = it.widget()
                if w is not None:
                    w.setParent(None)
            for c in case_rows:
                cases_outer.addWidget(c["outer"])
            cases_outer.addWidget(btn_add)

        def refresh_state_nav() -> None:
            n = len(case_rows)
            for i, c in enumerate(case_rows):
                c["btn_up"].setEnabled(i > 0)
                c["btn_down"].setEnabled(i < n - 1)

        def make_case_block(
            case: dict[str, Any] | None, *, orig_present: bool = False
        ) -> dict[str, Any]:
            outer = QWidget(cases_wrap)
            lay = QVBoxLayout(outer)
            row = QHBoxLayout()
            state_cb = QComboBox(outer)
            state_cb.setEditable(True)
            state_cb.addItem("")
            for sid in state_options:
                if sid and state_cb.findText(sid) < 0:
                    state_cb.addItem(sid)
            state_cb.setCurrentText(str((case or {}).get("state", "") or ""))
            row.addWidget(QLabel("state", outer))
            row.addWidget(state_cb, 1)
            nx = QLineEdit(str((case or {}).get("next", "")), outer)
            btn = QPushButton("next…", outer)
            btn.clicked.connect(lambda _c=False, le=nx: self._pick_target(le))
            self._install_target_validation(nx)
            row.addWidget(nx, 1)
            row.addWidget(btn)
            b_before, b_after, b_up, b_down, b_del = _compact_row_nav_buttons(
                outer,
                tip_before="在此分支之前插入空分支",
                tip_after="在此分支之后插入空分支",
                tip_up="本分支上移",
                tip_down="本分支下移",
                tip_del="删除本分支（至少保留一个）",
            )
            row.addWidget(b_before)
            row.addWidget(b_after)
            row.addWidget(b_up)
            row.addWidget(b_down)
            row.addWidget(b_del)
            lay.addLayout(row)

            rec = {
                "outer": outer,
                "state_edit": state_cb,
                "next_edit": nx,
                "btn_up": b_up,
                "btn_down": b_down,
                "orig_present": orig_present,
            }

            def row_index() -> int:
                return case_rows.index(rec)

            def do_del() -> None:
                if len(case_rows) <= 1:
                    QMessageBox.information(self, "分支", "至少保留一个 state 分支。")
                    return
                case_rows.remove(rec)
                outer.deleteLater()
                rebuild_cases_layout()
                refresh_state_nav()
                self._emit_changed()

            def insert_at(pos: int) -> None:
                nb = make_case_block({"state": "", "next": ""})
                pos = max(0, min(pos, len(case_rows)))
                case_rows.insert(pos, nb)
                rebuild_cases_layout()
                refresh_state_nav()
                self._emit_changed()

            def do_up() -> None:
                i = row_index()
                if i <= 0:
                    return
                case_rows[i - 1], case_rows[i] = case_rows[i], case_rows[i - 1]
                rebuild_cases_layout()
                refresh_state_nav()
                self._emit_changed()

            def do_down() -> None:
                i = row_index()
                if i < 0 or i >= len(case_rows) - 1:
                    return
                case_rows[i + 1], case_rows[i] = case_rows[i], case_rows[i + 1]
                rebuild_cases_layout()
                refresh_state_nav()
                self._emit_changed()

            b_before.clicked.connect(lambda: insert_at(row_index()))
            b_after.clicked.connect(lambda: insert_at(row_index() + 1))
            b_up.clicked.connect(do_up)
            b_down.clicked.connect(do_down)
            b_del.clicked.connect(do_del)
            state_cb.currentTextChanged.connect(lambda _t: self._emit_changed())
            nx.textChanged.connect(lambda _t: self._emit_changed())
            return rec

        cases_raw = data.get("cases")
        if not isinstance(cases_raw, list):
            cases_raw = []
        if cases_raw:
            for c in cases_raw:
                if isinstance(c, dict):
                    case_rows.append(make_case_block(c, orig_present=True))
        else:
            case_rows.append(make_case_block({"state": "", "next": ""}))
        btn_add = QPushButton("添加 state 分支", cases_wrap)
        def do_add() -> None:
            case_rows.append(make_case_block({"state": "", "next": ""}))
            rebuild_cases_layout()
            refresh_state_nav()
            self._emit_changed()

        btn_add.clicked.connect(do_add)
        rebuild_cases_layout()
        refresh_state_nav()
        self._body_layout.addWidget(cases_wrap)

        dn = QLineEdit(str(data.get("defaultNext", "") or ""), self._body)
        row_dn = QHBoxLayout()
        row_dn.addWidget(QLabel("defaultNext", self._body))
        row_dn.addWidget(dn, 1)
        btn_dn = QPushButton("选择…", self._body)
        btn_dn.clicked.connect(lambda: self._pick_target(dn))
        row_dn.addWidget(btn_dn)
        self._body_layout.addLayout(row_dn)
        self._install_target_validation(dn)

        missing_next: QLineEdit | None = None
        if include_missing:
            missing_next = QLineEdit(str(data.get("missingWrapperNext", "") or ""), self._body)
            row_mn = QHBoxLayout()
            row_mn.addWidget(QLabel("missingWrapperNext", self._body))
            row_mn.addWidget(missing_next, 1)
            btn_mn = QPushButton("选择…", self._body)
            btn_mn.clicked.connect(lambda: self._pick_target(missing_next))
            row_mn.addWidget(btn_mn)
            self._body_layout.addLayout(row_mn)
            missing_next.textChanged.connect(lambda _t: self._emit_changed())
            self._install_target_validation(missing_next)
        dn.textChanged.connect(lambda _t: self._emit_changed())

        def build_getter(node_type: str, graph_id: str = "") -> Callable[[], dict[str, Any]]:
            def getter() -> dict[str, Any]:
                cs = []
                for cb in case_rows:
                    st = cb["state_edit"].currentText().strip()
                    nx_v = cb["next_edit"].text().strip()
                    # 原本就存在的分支即使 state/next 都空也忠实保留（零丢失往返）；
                    # 仅丢弃「新加但从未填写」的空行，避免持久化误加的空分支。
                    if st or nx_v or cb.get("orig_present"):
                        cs.append({"state": st, "next": nx_v})
                out: dict[str, Any] = {
                    "type": node_type,
                    "cases": cs,
                    "defaultNext": dn.text().strip(),
                }
                if include_missing and missing_next is not None:
                    out["missingWrapperNext"] = missing_next.text().strip()
                if graph_id:
                    out["graphId"] = graph_id
                return out

            return getter

        return case_rows, dn, missing_next, build_getter

    def _build_owner_state(self, data: dict[str, Any]) -> None:
        info = self._owner_wrapper_state_options()
        self._body_layout.addWidget(
            _help_marker(
                "数据源：当前对话所属实体的 wrapper 状态（运行时 ownerType/ownerId）。\n"
                f"{info.get('message', '')}",
                self._body,
            )
        )
        if info.get("ambiguous"):
            warn = QLabel("警告：多个 NPC/Hotspot 共用本对话图，state 列表为并集，运行时按当前交互实体解析。", self._body)
            warn.setWordWrap(True)
            warn.setStyleSheet("color: #b45309;")
            self._body_layout.addWidget(warn)

        wrappers = [w for w in (info.get("wrappers") or []) if isinstance(w, dict)]
        wrapper_map: dict[str, dict[str, Any]] = {}
        wrapper_order: list[str] = []
        for wrapper in wrappers:
            gid = str(wrapper.get("graphId", "") or "").strip()
            if not gid or gid in wrapper_map:
                continue
            wrapper_map[gid] = wrapper
            wrapper_order.append(gid)

        selected_wrapper_id = str(data.get("wrapperGraphId", "") or "").strip()
        if not selected_wrapper_id and len(wrapper_order) == 1:
            selected_wrapper_id = wrapper_order[0]

        row_wid = QHBoxLayout()
        row_wid.addWidget(QLabel("wrapperGraphId", self._body))
        wrapper_edit = QLineEdit(selected_wrapper_id, self._body)
        wrapper_edit.setPlaceholderText("选择或输入 wrapper graphId")
        row_wid.addWidget(wrapper_edit, 1)
        btn_pick_wrapper = QPushButton("选择 wrapper…", self._body)
        row_wid.addWidget(btn_pick_wrapper)
        self._body_layout.addLayout(row_wid)

        wrapper_detail = QLabel(self._body)
        wrapper_detail.setWordWrap(True)
        wrapper_detail.setStyleSheet("color: #9fb0bf;")
        self._body_layout.addWidget(wrapper_detail)

        def _current_wrapper_graph_id() -> str:
            return wrapper_edit.text().strip()

        def _wrapper_detail_text(gid: str) -> str:
            wrapper = wrapper_map.get(gid)
            if not wrapper:
                return "未选择 wrapperGraph；多 wrapper 实体下运行时会走 missingWrapperNext/defaultNext。"
            owner_type = str(wrapper.get("ownerType", "") or "").strip()
            owner_id = str(wrapper.get("ownerId", "") or "").strip()
            category = str(wrapper.get("category", "") or "").strip()
            comp = str(wrapper.get("compositionLabel", "") or wrapper.get("compositionId", "") or "").strip()
            element = str(wrapper.get("elementId", "") or "").strip()
            states = [str(x) for x in (wrapper.get("stateIds") or []) if str(x).strip()]
            parts = [
                f"实体：{owner_type}:{owner_id}" if owner_type or owner_id else "",
                f"分类：{category}" if category else "分类：未填写",
                f"编排：{comp}" if comp else "",
                f"元素：{element}" if element else "",
                f"状态：{', '.join(states)}" if states else "状态：无",
            ]
            return "　".join(part for part in parts if part)

        def _refresh_wrapper_detail() -> None:
            wrapper_detail.setText(_wrapper_detail_text(_current_wrapper_graph_id()))

        def _state_ids_for_wrapper(gid: str) -> list[str]:
            g = str(gid or "").strip()
            if g:
                hit = wrapper_map.get(g)
                if isinstance(hit, dict):
                    return [str(x) for x in (hit.get("stateIds") or []) if str(x).strip()]
            return [str(x) for x in (info.get("stateIds") or []) if str(x).strip()]

        state_ids = _state_ids_for_wrapper(selected_wrapper_id)
        btn_refresh = QPushButton("刷新 wrapper 状态列表", self._body)
        self._body_layout.addWidget(btn_refresh)

        case_rows, dn, missing_next, build_getter = self._make_state_branch_rows(
            data,
            state_options=state_ids,
            include_missing=True,
        )

        def _apply_state_options(ids: list[str]) -> None:
            for row in case_rows:
                cb = row.get("state_edit")
                if not isinstance(cb, QComboBox):
                    continue
                cur = cb.currentText()
                cb.blockSignals(True)
                try:
                    cb.clear()
                    cb.addItem("")
                    for sid in ids:
                        cb.addItem(sid)
                    cb.setCurrentText(cur)
                finally:
                    cb.blockSignals(False)

        def _node_snapshot() -> Any:
            try:
                return self._getter() if self._getter else None
            except Exception:
                return None

        def refresh_states() -> None:
            nonlocal info
            # 「刷新 wrapper 状态列表」只是重新查目录、重填下拉选项，本身不改动已编辑数据。
            # 用序列化快照前后比对，唯有实质变化才标脏，杜绝点一下刷新就变「未保存」。
            _before = _node_snapshot()
            refreshed = self._owner_wrapper_state_options()
            info = refreshed
            wrappers2 = [w for w in (refreshed.get("wrappers") or []) if isinstance(w, dict)]
            new_map: dict[str, dict[str, Any]] = {}
            new_order: list[str] = []
            for wrapper in wrappers2:
                gid = str(wrapper.get("graphId", "") or "").strip()
                if not gid or gid in new_map:
                    continue
                new_map[gid] = wrapper
                new_order.append(gid)

            cur_gid = _current_wrapper_graph_id()
            wrapper_map.clear()
            wrapper_map.update(new_map)
            wrapper_order.clear()
            wrapper_order.extend(new_order)
            wrapper_edit.setText(cur_gid)

            ids = _state_ids_for_wrapper(_current_wrapper_graph_id())
            _apply_state_options(ids)
            _refresh_wrapper_detail()
            if _node_snapshot() != _before:
                self._emit_changed()

        def on_wrapper_changed(_t: str = "") -> None:
            ids = _state_ids_for_wrapper(_current_wrapper_graph_id())
            _apply_state_options(ids)
            _refresh_wrapper_detail()
            self._emit_changed()

        def pick_wrapper() -> None:
            from .wrapper_graph_picker_dialog import WrapperGraphPickerDialog

            dlg = WrapperGraphPickerDialog(
                [wrapper_map[gid] for gid in wrapper_order if gid in wrapper_map],
                initial_id=_current_wrapper_graph_id(),
                parent=self,
            )
            if dlg.exec() != QDialog.DialogCode.Accepted:
                return
            wrapper_edit.setText(dlg.selected_id())

        wrapper_edit.textChanged.connect(on_wrapper_changed)
        btn_pick_wrapper.clicked.connect(pick_wrapper)
        btn_refresh.clicked.connect(refresh_states)
        _refresh_wrapper_detail()
        self._topology_refs = {
            "type": "ownerState",
            "case_rows": case_rows,
            "default_next": dn,
            "missing_next": missing_next,
            "wrapper_graph_id_edit": wrapper_edit,
        }

        def getter() -> dict[str, Any]:
            base = build_getter("ownerState")()
            base["wrapperGraphId"] = _current_wrapper_graph_id()
            return base

        self._getter = getter

    def _build_context_state(self, data: dict[str, Any]) -> None:
        from tools.editor.shared.narrative_catalog import (
            graph_states,
            is_context_graph_allowed,
            list_context_readable_graphs,
        )

        hint = _help_marker(
            "读取显式声明的上层 flow/scenario 叙事图状态（不可选择 npc/hotspot wrapper）。",
            self._body,
        )
        self._body_layout.addWidget(hint)

        graphs = list_context_readable_graphs(self._project_root)
        graph_ids = {
            str(g.get("graphId", "") or "").strip()
            for g in graphs
            if str(g.get("graphId", "") or "").strip()
        }
        gid_cb = QComboBox(self._body)
        gid_cb.setEditable(True)
        gid_cb.addItem("")
        # 相对 token：运行时按当前 owner/场景解析（@owner=当前对话 owner 主 wrapper，@scene=本场景 wrapper）
        gid_cb.addItem("@owner（当前 owner 的主 wrapper）", "@owner")
        gid_cb.addItem("@scene（本场景 wrapper）", "@scene")
        for g in graphs:
            gid = str(g.get("graphId", "") or "")
            gid_cb.addItem(str(g.get("label", "") or gid), gid)
        saved_gid = str(data.get("graphId", "") or "")
        idx = gid_cb.findData(saved_gid)
        if idx >= 0:
            gid_cb.setCurrentIndex(idx)
        else:
            gid_cb.setCurrentText(saved_gid)
        row_gid = QHBoxLayout()
        row_gid.addWidget(QLabel("graphId", self._body))
        row_gid.addWidget(gid_cb, 1)
        self._body_layout.addLayout(row_gid)

        def _current_graph_id() -> str:
            text = gid_cb.currentText().strip()
            data_value = gid_cb.currentData()
            data_id = str(data_value).strip() if data_value is not None else ""
            current_index = gid_cb.currentIndex()
            current_label = gid_cb.itemText(current_index).strip() if current_index >= 0 else ""
            if text and text in graph_ids:
                return text
            if text and current_index >= 0 and text == current_label and data_id:
                return data_id
            if text:
                for idx in range(gid_cb.count()):
                    if gid_cb.itemText(idx).strip() == text:
                        item_data = gid_cb.itemData(idx)
                        item_id = str(item_data).strip() if item_data is not None else ""
                        return item_id or text
                return text
            return data_id

        state_options = graph_states(self._project_root, _current_graph_id())

        case_rows, dn, _missing, build_getter = self._make_state_branch_rows(
            data,
            state_options=state_options,
            include_missing=False,
        )

        def on_graph_changed(_t: str = "") -> None:
            gid = _current_graph_id()
            ids = graph_states(self._project_root, gid)
            for row in case_rows:
                cb = row.get("state_edit")
                if not isinstance(cb, QComboBox):
                    continue
                cur = cb.currentText()
                cb.blockSignals(True)
                try:
                    cb.clear()
                    cb.addItem("")
                    for sid in ids:
                        cb.addItem(sid)
                    cb.setCurrentText(cur)
                finally:
                    cb.blockSignals(False)
            if gid and not gid.startswith("@") and not is_context_graph_allowed(self._project_root, gid):
                hint.setStyleSheet("color: #c62828;")
            else:
                hint.setStyleSheet("color: #888;")
            self._emit_changed()

        gid_cb.currentTextChanged.connect(on_graph_changed)

        self._topology_refs = {
            "type": "contextState",
            "case_rows": case_rows,
            "default_next": dn,
            "graph_id_edit": gid_cb,
        }

        def getter() -> dict[str, Any]:
            gid = _current_graph_id()
            base = build_getter("contextState", gid)()
            return base

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
