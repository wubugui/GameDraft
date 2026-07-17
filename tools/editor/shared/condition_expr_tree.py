"""递归 ConditionExpr 树形编辑器（all / any / not / flag / quest / scenario / scenarioLine / narrative / plane）。"""
from __future__ import annotations

import copy
import json
from typing import Any, Callable

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QFormLayout,
    QCheckBox,
    QComboBox,
    QPushButton,
    QLineEdit,
    QLabel,
    QMessageBox,
    QScrollArea,
    QSizePolicy,
    QSpinBox,
)

from .flag_key_field import FlagKeyPickField
from .flag_value_edit import FlagValueEdit
from .id_ref_selector import IdRefSelector
from .rich_text_field import RichTextLineEdit
from .form_layout import compact_form

# 与 narrative_data_editors /运行时一致
_SCENARIO_STATUSES = ("pending", "active", "done", "locked")
_QUEST_STATUSES = ("Inactive", "Active", "Completed")


def _render_outcome_text(oc: object) -> str:
    """与 set_dict 展示 outcome 的渲染保持一致（用于"文本未改动"判定）。"""
    if isinstance(oc, str):
        return oc
    try:
        return json.dumps(oc, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(oc)
_SCENARIO_LINE_STATUSES = ("inactive", "active", "completed")
_MAX_DEPTH = 32
# 单个 flag 节点约 ~120px；旧值 640 会让常见的一节点条件凭空占掉大片空白。
# 设一个紧凑的下限，内容更多时由滚动条接管（直到 MAX）。
_CONDITION_EXPR_TREE_SCROLL_MIN_HEIGHT = 180
_CONDITION_EXPR_TREE_SCROLL_MAX_HEIGHT = 2400


def _is_flag_atom(d: dict[str, Any]) -> bool:
    if "flag" not in d:
        return False
    return set(d.keys()) <= {"flag", "op", "value"}


class ConditionExprNodeEditor(QWidget):
    """单节点：可表示组合子或叶子。"""

    changed = Signal()

    def __init__(
        self,
        depth: int,
        model_getter: Callable[[], Any],
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._depth = depth
        self._model_getter = model_getter
        self._child_editors: list[ConditionExprNodeEditor] = []
        self._not_child: ConditionExprNodeEditor | None = None
        # 程序性载入期间抑制 changed（契约：set_dict 是程序性 set，不得外发编辑信号误标脏）。
        self._loading = False
        # 当前生效的节点类型（用于换类型时按"旧类型 + 旧控件"判断子树是否非空，据此弹确认）。
        self._active_kind = "flag"

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 2, 0, 2)

        head = QHBoxLayout()
        self._kind = QComboBox()
        for lab, val in (
            ("全部满足 (all)", "all"),
            ("任一满足 (any)", "any"),
            ("否定 (not)", "not"),
            ("Flag 条件", "flag"),
            ("任务状态", "quest"),
            ("Scenario 阶段", "scenario"),
            ("Scenario 线（生命周期）", "scenarioLine"),
            ("叙事状态", "narrative"),
            ("活计计数 (做过几单)", "narrativeCount"),
            ("激活位面", "plane"),
        ):
            self._kind.addItem(lab, val)
        self._kind.currentIndexChanged.connect(self._on_kind_changed)
        head.addWidget(QLabel("类型"), 0)
        head.addWidget(self._kind, 1)
        if depth > 0:
            self._btn_remove = QPushButton("移除此节点")
            self._btn_remove.clicked.connect(lambda: self._request_remove())
            head.addWidget(self._btn_remove)
        root.addLayout(head)

        self._body = QVBoxLayout()
        root.addLayout(self._body)

        self._container_all_any: QWidget | None = None
        self._lay_all_any: QVBoxLayout | None = None
        self._flag_wrap: QWidget | None = None
        self._quest_wrap: QWidget | None = None
        self._sc_wrap: QWidget | None = None
        self._sl_wrap: QWidget | None = None
        self._not_wrap: QWidget | None = None
        self._not_empty_hint: QLabel | None = None

        self._flag_field: FlagKeyPickField | None = None
        self._flag_op: QComboBox | None = None
        self._flag_val_mode: QComboBox | None = None
        self._flag_val_reg: FlagValueEdit | None = None
        self._flag_free_value: QWidget | None = None
        self._q_id: QLineEdit | None = None
        self._q_st: QComboBox | None = None
        self._sc_id: QComboBox | None = None
        self._sc_ph: QComboBox | None = None
        self._sc_st: QComboBox | None = None
        self._sc_out: QLineEdit | None = None
        self._sl_id: QComboBox | None = None
        self._sl_st: QComboBox | None = None
        self._nv_wrap: QWidget | None = None
        self._nv_graph: QComboBox | None = None
        self._nv_state: QComboBox | None = None
        self._nv_reached: QCheckBox | None = None
        self._nc_wrap: QWidget | None = None
        self._nc_graph: QComboBox | None = None
        self._nc_exit: QComboBox | None = None
        self._nc_op: QComboBox | None = None
        self._nc_value: QSpinBox | None = None
        self._pl_wrap: QWidget | None = None
        self._pl_id: IdRefSelector | None = None

        self._remove_callback: Callable[[ConditionExprNodeEditor], None] | None = None

        self._kind.blockSignals(True)
        self._kind.setCurrentIndex(3)
        self._kind.blockSignals(False)
        self._rebuild_body("flag")

    def _emit_changed(self) -> None:
        """统一出口：程序性载入（set_dict）期间不外发 changed，避免误标工程脏。"""
        if not self._loading:
            self.changed.emit()

    def _refresh_not_empty_hint(self) -> None:
        """not 节点：内层未配置时亮红字（恒假警告），配置后隐藏。"""
        hint = self._not_empty_hint
        if hint is None:
            return
        empty = not (self._not_child and self._not_child._has_content())
        hint.setVisible(empty)

    def set_remove_callback(self, cb: Callable[[ConditionExprNodeEditor], None]) -> None:
        self._remove_callback = cb

    def _request_remove(self) -> None:
        if self._remove_callback:
            self._remove_callback(self)

    def _model(self) -> Any:
        return self._model_getter()

    def _has_content(self, kind: str | None = None) -> bool:
        """当前节点子树是否已配置（用现存控件按 kind 判断）；换类型/删节点确认据此。"""
        k = kind if kind is not None else self._active_kind

        def _combo_has(cb: QComboBox | None) -> bool:
            if cb is None:
                return False
            d = cb.currentData()
            return isinstance(d, str) and bool(d.strip())

        if k in ("all", "any"):
            return any(c._has_content() for c in self._child_editors)
        if k == "not":
            return bool(self._not_child and self._not_child._has_content())
        if k == "flag":
            return bool(self._flag_field and self._flag_field.key().strip())
        if k == "quest":
            return bool(self._q_id and self._q_id.current_id().strip())
        if k == "scenario":
            return _combo_has(self._sc_id)
        if k == "scenarioLine":
            return _combo_has(self._sl_id)
        if k == "narrative":
            return _combo_has(self._nv_graph)
        if k == "narrativeCount":
            return _combo_has(self._nc_graph)
        if k == "plane":
            return bool(self._pl_id and self._pl_id.current_id().strip())
        return False

    def _confirm_destructive_discard(self, action_label: str) -> bool:
        """子树非空时的破坏性操作确认；默认 No（不执行）。测试可 monkeypatch。"""
        if not self._has_content():
            return True
        ret = QMessageBox.question(
            self,
            action_label,
            f"{action_label}将丢弃此节点下已配置的条件（不可撤销）。确定？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        return ret == QMessageBox.StandardButton.Yes

    def _on_kind_changed(self) -> None:
        k = self._kind.currentData()
        if not isinstance(k, str):
            return
        prev = self._active_kind
        if prev and k != prev and self._has_content(prev):
            if not self._confirm_destructive_discard("切换条件类型"):
                # 用户放弃：还原下拉到原类型，保留原控件与配置
                idx = self._kind.findData(prev)
                if idx >= 0:
                    self._kind.blockSignals(True)
                    self._kind.setCurrentIndex(idx)
                    self._kind.blockSignals(False)
                return
        self._rebuild_body(k)
        self._emit_changed()

    def _clear_body(self) -> None:
        while self._body.count():
            it = self._body.takeAt(0)
            w = it.widget()
            if w is not None:
                w.setParent(None)
                w.deleteLater()
        self._container_all_any = None
        self._lay_all_any = None
        self._flag_wrap = None
        self._quest_wrap = None
        self._sc_wrap = None
        self._sl_wrap = None
        self._not_wrap = None
        self._not_empty_hint = None
        self._child_editors.clear()
        self._not_child = None
        self._flag_field = None
        self._flag_op = None
        self._flag_val_mode = None
        self._flag_val_reg = None
        self._flag_free_value = None
        self._q_id = None
        self._q_st = None
        self._sc_id = None
        self._sc_ph = None
        self._sc_st = None
        self._sc_out = None
        self._sl_id = None
        self._sl_st = None
        self._nv_wrap = None
        self._nv_graph = None
        self._nv_state = None
        self._nv_reached = None
        self._nc_wrap = None
        self._nc_graph = None
        self._nc_exit = None
        self._nc_op = None
        self._nc_value = None
        self._pl_wrap = None
        self._pl_id = None

    def _rebuild_body(self, kind: str) -> None:
        self._active_kind = kind
        self._clear_body()
        if kind in ("all", "any"):
            wrap = QWidget()
            vl = QVBoxLayout(wrap)
            vl.setContentsMargins(8, 4, 0, 4)
            self._container_all_any = wrap
            self._lay_all_any = vl
            btn = QPushButton("+ 添加子条件")
            if self._depth >= _MAX_DEPTH - 1:
                btn.setEnabled(False)
                btn.setToolTip(f"嵌套深度上限 {_MAX_DEPTH}")
            btn.clicked.connect(self._add_child)
            vl.addWidget(btn)
            self._body.addWidget(wrap)
        elif kind == "not":
            nw = QWidget()
            nl = QVBoxLayout(nw)
            nl.setContentsMargins(8, 4, 0, 4)
            self._not_wrap = nw
            # 裸 not（内层未配置）导出 {"not":{"all":[]}} = 恒假，挂条件上"永远不出现"极难排查：
            # 行内红字提示（validator 侧另由数据组补）。
            self._not_empty_hint = QLabel("not 未配置内层 = 恒为假（该条件永不满足）")
            self._not_empty_hint.setWordWrap(True)
            self._not_empty_hint.setStyleSheet("color:#c0392b;")
            nl.addWidget(self._not_empty_hint)
            if self._depth >= _MAX_DEPTH - 1:
                tip = QLabel(f"嵌套已达上限（{_MAX_DEPTH}），无法添加 not 子节点")
                tip.setWordWrap(True)
                nl.addWidget(tip)
            else:
                ch = ConditionExprNodeEditor(self._depth + 1, self._model_getter, nw)
                ch.set_remove_callback(None)
                ch.changed.connect(self._emit_changed)
                ch.changed.connect(self._refresh_not_empty_hint)
                self._not_child = ch
                nl.addWidget(ch)
            self._body.addWidget(nw)
            self._refresh_not_empty_hint()
        elif kind == "flag":
            fw = QWidget()
            main = QVBoxLayout(fw)
            main.setContentsMargins(0, 0, 0, 0)
            row1 = QHBoxLayout()
            row1.setContentsMargins(0, 0, 0, 0)
            m = self._model()
            reg = m.flag_registry if m else {}
            self._flag_field = FlagKeyPickField(m, None, "", fw)
            self._flag_field.setMinimumWidth(100)
            self._flag_field.valueChanged.connect(self._on_flag_field_value_changed)
            self._flag_op = QComboBox()
            self._flag_op.addItems(["==", "!=", ">", "<", ">=", "<="])
            self._flag_op.currentTextChanged.connect(lambda _t: self._emit_changed())
            self._flag_val_mode = QComboBox()
            self._flag_val_mode.addItem("值：按登记表", "registry")
            self._flag_val_mode.addItem("值：字符串/引用", "string_ref")
            self._flag_val_mode.currentIndexChanged.connect(self._on_flag_val_mode_changed)
            row1.addWidget(self._flag_field, stretch=1)
            row1.addWidget(self._flag_op)
            row1.addWidget(self._flag_val_mode)
            main.addLayout(row1)
            self._flag_val_reg = FlagValueEdit(fw, reg)
            self._flag_val_reg.valueChanged.connect(self._emit_changed)
            pm = self._model()
            if pm is not None:
                free = RichTextLineEdit(pm, fw)
                free.setPlaceholderText(
                    "与 Flag 比较：true/数字，或 [tag:…]（运行时 resolve 后再比较）",
                )
                free.textChanged.connect(lambda _s: self._emit_changed())
                self._flag_free_value = free
            else:
                fe = QLineEdit(fw)
                fe.setPlaceholderText("纯文本；载入工程后可插入 [tag:…]")
                fe.textChanged.connect(lambda _s: self._emit_changed())
                self._flag_free_value = fe
            main.addWidget(self._flag_val_reg)
            main.addWidget(self._flag_free_value)
            self._flag_wrap = fw
            self._body.addWidget(fw)
            if self._flag_val_reg and self._flag_field:
                self._flag_val_reg.set_flag_key(self._flag_field.key())
            self._sync_flag_value_widgets_visibility()
        elif kind == "quest":
            qw = QWidget()
            qf = compact_form(QFormLayout(qw))
            self._q_id = IdRefSelector(allow_empty=True, editable=False, click_opens_popup=True)
            _qm = self._model()
            # 候选排除 repeatable（无状态机，quest 叶指向它=校验 error）
            if _qm is not None and hasattr(_qm, "quest_status_target_ids"):
                self._q_id.set_items(list(_qm.quest_status_target_ids()))
            elif _qm is not None and hasattr(_qm, "all_quest_ids"):
                self._q_id.set_items(list(_qm.all_quest_ids()))
            self._q_id.value_changed.connect(lambda *_: self._emit_changed())
            self._q_st = QComboBox()
            for qs in _QUEST_STATUSES:
                self._q_st.addItem(qs, qs)
            self._q_st.currentIndexChanged.connect(lambda _i: self._emit_changed())
            qf.addRow("quest", self._q_id)
            qf.addRow("questStatus", self._q_st)
            self._quest_wrap = qw
            self._body.addWidget(qw)
        elif kind == "scenario":
            sw = QWidget()
            sf = compact_form(QFormLayout(sw))
            self._sc_id = QComboBox()
            self._sc_id.setEditable(False)
            self._sc_id.currentIndexChanged.connect(self._on_scenario_combo)
            self._sc_ph = QComboBox()
            self._sc_ph.setEditable(False)
            self._sc_ph.currentIndexChanged.connect(lambda _i: self._emit_changed())
            self._sc_st = QComboBox()
            for s in _SCENARIO_STATUSES:
                self._sc_st.addItem(s, s)
            self._sc_st.currentIndexChanged.connect(lambda _i: self._emit_changed())
            self._sc_out = QLineEdit()
            self._sc_out.setPlaceholderText("可选 outcome（JSON 或字面量）")
            self._sc_out.textChanged.connect(lambda: self._emit_changed())
            sf.addRow("scenario", self._sc_id)
            sf.addRow("phase", self._sc_ph)
            sf.addRow("status", self._sc_st)
            sf.addRow("outcome（可选）", self._sc_out)
            self._sc_wrap = sw
            self._body.addWidget(sw)
            self._fill_scenario_combos()
        elif kind == "scenarioLine":
            lw = QWidget()
            lf = compact_form(QFormLayout(lw))
            self._sl_id = QComboBox()
            self._sl_id.setEditable(False)
            self._sl_id.currentIndexChanged.connect(lambda _i: self._emit_changed())
            self._sl_st = QComboBox()
            for s in _SCENARIO_LINE_STATUSES:
                self._sl_st.addItem(s, s)
            self._sl_st.currentIndexChanged.connect(lambda _i: self._emit_changed())
            lf.addRow("scenarioLine", self._sl_id)
            lf.addRow("lineStatus", self._sl_st)
            self._sl_wrap = lw
            self._body.addWidget(lw)
            self._fill_scenario_line_combo()
        elif kind == "narrative":
            nw = QWidget()
            nf = compact_form(QFormLayout(nw))
            self._nv_graph = QComboBox()
            self._nv_graph.setEditable(False)
            self._nv_graph.currentIndexChanged.connect(self._on_narrative_graph_combo)
            self._nv_state = QComboBox()
            self._nv_state.setEditable(False)
            self._nv_state.currentIndexChanged.connect(lambda _i: self._emit_changed())
            self._nv_reached = QCheckBox("曾到达过（含当前；用于「X 之后」类门控）")
            self._nv_reached.stateChanged.connect(lambda _s: self._emit_changed())
            nf.addRow("叙事图", self._nv_graph)
            nf.addRow("状态", self._nv_state)
            nf.addRow("", self._nv_reached)
            self._nv_wrap = nw
            self._body.addWidget(nw)
            self._fill_narrative_combos()
        elif kind == "narrativeCount":
            cw = QWidget()
            cf = compact_form(QFormLayout(cw))
            self._nc_graph = QComboBox()
            self._nc_graph.setEditable(False)
            self._nc_graph.setToolTip(
                "活计图（声明了 run 的叙事图）。计数=该活计历史累计结算次数，跨轮持久、入存档。"
            )
            self._nc_graph.currentIndexChanged.connect(self._on_narrative_count_graph_combo)
            self._nc_exit = QComboBox()
            self._nc_exit.setEditable(False)
            self._nc_exit.setToolTip("按哪个出口计数；「全部出口合计」= 不区分交付/失败等出口")
            self._nc_exit.currentIndexChanged.connect(lambda _i: self._emit_changed())
            self._nc_op = QComboBox()
            for _op in (">=", "==", "!=", ">", "<", "<="):
                self._nc_op.addItem(_op, _op)
            self._nc_op.currentIndexChanged.connect(lambda _i: self._emit_changed())
            self._nc_value = QSpinBox()
            self._nc_value.setRange(0, 9999)
            self._nc_value.setValue(1)
            self._nc_value.valueChanged.connect(lambda _v: self._emit_changed())
            cf.addRow("活计图", self._nc_graph)
            cf.addRow("出口", self._nc_exit)
            row = QHBoxLayout()
            row.addWidget(self._nc_op, 0)
            row.addWidget(self._nc_value, 0)
            row.addStretch(1)
            cf.addRow("结算次数", row)
            self._nc_wrap = cw
            self._body.addWidget(cw)
            self._fill_narrative_count_combos()
        elif kind == "plane":
            pw = QWidget()
            pf = compact_form(QFormLayout(pw))
            self._pl_id = IdRefSelector(allow_empty=True, editable=False, click_opens_popup=True)
            self._pl_id.setToolTip(
                "当前激活位面 === 该 id（含 activatePlane 手动覆盖压过叙事点名后的结果）。"
                "「非 normal」写法：否定(not) + 本叶子选 normal。列表来自 planes.json。",
            )
            _pm = self._model()
            if _pm is not None and hasattr(_pm, "all_plane_ids"):
                self._pl_id.set_items(list(_pm.all_plane_ids()))
            self._pl_id.value_changed.connect(lambda *_: self._emit_changed())
            pf.addRow("plane", self._pl_id)
            self._pl_wrap = pw
            self._body.addWidget(pw)

    def _narrative_graph_entries(self) -> list[tuple[str, str, dict[str, Any]]]:
        """(显示名, graphId, graph dict)：主图 + wrapper 子图，与 narrative_graphs.json 一致。"""
        m = self._model()
        data = getattr(m, "narrative_graphs", None) if m else None
        out: list[tuple[str, str, dict[str, Any]]] = []
        if not isinstance(data, dict):
            return out
        for comp in data.get("compositions") or []:
            if not isinstance(comp, dict):
                continue
            main = comp.get("mainGraph")
            if isinstance(main, dict) and main.get("id"):
                label = str(main.get("label") or comp.get("label") or main["id"])
                out.append((f"{label} ({main['id']})", str(main["id"]), main))
            for el in comp.get("elements") or []:
                if not isinstance(el, dict) or el.get("kind") != "wrapperGraph":
                    continue
                g = el.get("graph")
                if isinstance(g, dict) and g.get("id"):
                    label = str(el.get("label") or g.get("label") or g["id"])
                    out.append((f"{label} ({g['id']})", str(g["id"]), g))
        return out

    def _fill_narrative_combos(self) -> None:
        if not self._nv_graph:
            return
        self._nv_graph.blockSignals(True)
        self._nv_graph.clear()
        self._nv_graph.addItem("（选择）", "")
        for label, gid, _g in self._narrative_graph_entries():
            self._nv_graph.addItem(label, gid)
        self._nv_graph.blockSignals(False)
        self._fill_narrative_state_combo()

    def _on_narrative_graph_combo(self, _i: int) -> None:
        self._fill_narrative_state_combo()
        self._emit_changed()

    def _fill_narrative_count_combos(self) -> None:
        if not self._nc_graph:
            return
        self._nc_graph.blockSignals(True)
        self._nc_graph.clear()
        self._nc_graph.addItem("（选择活计图）", "")
        for label, gid, g in self._narrative_graph_entries():
            if isinstance(g.get("run"), dict):
                self._nc_graph.addItem(label, gid)
        self._nc_graph.blockSignals(False)
        self._fill_narrative_count_exit_combo()

    def _on_narrative_count_graph_combo(self, _i: int) -> None:
        self._fill_narrative_count_exit_combo()
        self._emit_changed()

    def _fill_narrative_count_exit_combo(self) -> None:
        if not self._nc_exit or not self._nc_graph:
            return
        gid = self._nc_graph.currentData()
        gid = gid.strip() if isinstance(gid, str) else ""
        self._nc_exit.blockSignals(True)
        self._nc_exit.clear()
        self._nc_exit.addItem("（全部出口合计）", "")
        if gid:
            for _label, g_id, g in self._narrative_graph_entries():
                if g_id != gid:
                    continue
                states = g.get("states") or {}
                for sid in (g.get("exitStates") or []):
                    sid = str(sid)
                    st = states.get(sid)
                    lab = str((st or {}).get("label") or sid) if isinstance(st, dict) else sid
                    self._nc_exit.addItem(f"{lab} ({sid})" if lab != sid else sid, sid)
                break
        self._nc_exit.blockSignals(False)

    def _fill_narrative_state_combo(self) -> None:
        if not self._nv_state or not self._nv_graph:
            return
        gid = self._nv_graph.currentData()
        gid = gid.strip() if isinstance(gid, str) else ""
        self._nv_state.blockSignals(True)
        self._nv_state.clear()
        self._nv_state.addItem("（选择）", "")
        if gid:
            for _label, g_id, g in self._narrative_graph_entries():
                if g_id != gid:
                    continue
                for sid, st in (g.get("states") or {}).items():
                    lab = str((st or {}).get("label") or sid) if isinstance(st, dict) else str(sid)
                    self._nv_state.addItem(f"{lab} ({sid})" if lab != sid else str(sid), str(sid))
                break
        self._nv_state.blockSignals(False)

    def _fill_scenario_combos(self) -> None:
        if not self._sc_id or not self._sc_ph:
            return
        m = self._model()
        # 刷新保值：clear 前记住当前 scenario，重建后还原；未知值以「（数据）」注入保留，
        # 绝不静默清成「（选择）」——否则一次清单刷新即静默丢掉整条 scenario 条件。
        cur = self._sc_id.currentData()
        cur = cur.strip() if isinstance(cur, str) else ""
        self._sc_id.blockSignals(True)
        self._sc_id.clear()
        self._sc_id.addItem("（选择）", "")
        if m:
            for sid in m.scenario_ids_ordered():
                self._sc_id.addItem(sid, sid)
        if cur:
            idx = self._sc_id.findData(cur)
            if idx < 0:
                self._sc_id.addItem(f"（数据）{cur}", cur)
                idx = self._sc_id.count() - 1
            self._sc_id.setCurrentIndex(idx)
        self._sc_id.blockSignals(False)
        self._fill_phase_combo()

    def _on_scenario_combo(self, _i: int) -> None:
        self._fill_phase_combo()
        self._emit_changed()

    def _fill_phase_combo(self) -> None:
        if not self._sc_ph or not self._sc_id:
            return
        m = self._model()
        sid = self._sc_id.currentData()
        sid = sid.strip() if isinstance(sid, str) else ""
        # 刷新保值：记住当前 phase，重建后还原；未知值以「（数据）」注入保留。
        cur_ph = self._sc_ph.currentData()
        cur_ph = cur_ph.strip() if isinstance(cur_ph, str) else ""
        self._sc_ph.blockSignals(True)
        self._sc_ph.clear()
        self._sc_ph.addItem("（选择）", "")
        if m and sid:
            for ph in m.phases_for_scenario(sid):
                self._sc_ph.addItem(ph, ph)
        if cur_ph:
            idx = self._sc_ph.findData(cur_ph)
            if idx < 0:
                self._sc_ph.addItem(f"（数据）{cur_ph}", cur_ph)
                idx = self._sc_ph.count() - 1
            self._sc_ph.setCurrentIndex(idx)
        self._sc_ph.blockSignals(False)

    def _fill_scenario_line_combo(self) -> None:
        if not self._sl_id:
            return
        m = self._model()
        cur = self._sl_id.currentData()
        cur = cur.strip() if isinstance(cur, str) else ""
        self._sl_id.blockSignals(True)
        self._sl_id.clear()
        self._sl_id.addItem("（选择）", "")
        if m:
            for sid in m.scenario_ids_ordered():
                self._sl_id.addItem(sid, sid)
        self._sl_id.blockSignals(False)
        if cur:
            idx = self._sl_id.findData(cur)
            if idx >= 0:
                self._sl_id.blockSignals(True)
                self._sl_id.setCurrentIndex(idx)
                self._sl_id.blockSignals(False)

    def refresh_scenario_dropdowns(self) -> None:
        if self._sc_id:
            self._fill_scenario_combos()
        if self._sl_id:
            self._fill_scenario_line_combo()
        for c in self._child_editors:
            c.refresh_scenario_dropdowns()
        if self._not_child:
            self._not_child.refresh_scenario_dropdowns()

    def _on_flag_field_value_changed(self) -> None:
        if self._flag_val_reg and self._flag_field:
            self._flag_val_reg.set_flag_key(self._flag_field.key())
        self._emit_changed()

    def _on_flag_val_mode_changed(self, _i: int = 0) -> None:
        self._sync_flag_value_widgets_visibility()
        self._emit_changed()

    def _sync_flag_value_widgets_visibility(self) -> None:
        if not self._flag_val_mode or not self._flag_val_reg or self._flag_free_value is None:
            return
        is_ref = self._flag_val_mode.currentData() == "string_ref"
        self._flag_val_reg.setVisible(not is_ref)
        self._flag_free_value.setVisible(is_ref)

    def _flag_free_text(self) -> str:
        w = self._flag_free_value
        if w is None:
            return ""
        if isinstance(w, RichTextLineEdit):
            return w.text()
        if isinstance(w, QLineEdit):
            return w.text()
        return ""

    def _add_child(self) -> None:
        if self._depth >= _MAX_DEPTH - 1 or not self._lay_all_any:
            return
        ch = ConditionExprNodeEditor(self._depth + 1, self._model_getter)
        ch.set_remove_callback(self._remove_child)
        ch.changed.connect(self._emit_changed)
        self._child_editors.append(ch)
        self._lay_all_any.addWidget(ch)
        self._emit_changed()

    def _remove_child(self, editor: ConditionExprNodeEditor) -> None:
        if editor in self._child_editors:
            # 子树非空时先确认，避免误删整棵已配置子条件（不可撤销）。
            if not editor._confirm_destructive_discard("移除此节点"):
                return
            self._child_editors.remove(editor)
            editor.setParent(None)
            editor.deleteLater()
            self._emit_changed()

    def set_dict(self, data: dict[str, Any] | None) -> None:
        """程序性载入：全程抑制 changed（契约——载入 UI 不得外发编辑信号误标工程脏）。"""
        prev = self._loading
        self._loading = True
        try:
            self._set_dict_impl(data)
        finally:
            self._loading = prev
        # 载入完成后同步一次 not 恒假提示（此期间被抑制的可视状态需要落定）
        self._refresh_not_empty_hint()

    def _set_dict_impl(self, data: dict[str, Any] | None) -> None:
        # 原始形状快照：UI 未实际编辑时 to_dict 逐字返回原 dict
        #（不注入 questStatus/lineStatus/phase/status 默认键、不丢 reached:false、
        #  不把旧 "status" 键名改写成 "questStatus"、保留未知附加键）。
        self._orig_data: dict[str, Any] | None = None
        self._orig_canonical: dict[str, Any] | None = None
        if not isinstance(data, dict):
            self._kind.blockSignals(True)
            self._kind.setCurrentIndex(3)
            self._kind.blockSignals(False)
            self._rebuild_body("flag")
            return
        self._kind.blockSignals(True)
        if "all" in data and isinstance(data["all"], list):
            self._kind.setCurrentIndex(0)
        elif "any" in data and isinstance(data["any"], list):
            self._kind.setCurrentIndex(1)
        elif "not" in data and isinstance(data["not"], dict):
            self._kind.setCurrentIndex(2)
        elif _is_flag_atom(data):
            self._kind.setCurrentIndex(3)
        elif isinstance(data.get("quest"), str) and str(data.get("quest", "")).strip():
            self._kind.setCurrentIndex(4)
        elif isinstance(data.get("scenarioLine"), str) and str(data.get("scenarioLine", "")).strip():
            self._kind.setCurrentIndex(6)
        elif isinstance(data.get("scenario"), str) and str(data.get("scenario", "")).strip():
            self._kind.setCurrentIndex(5)
        elif isinstance(data.get("narrative"), str) and str(data.get("narrative", "")).strip():
            self._kind.setCurrentIndex(7)
        elif isinstance(data.get("narrativeCount"), str) and str(data.get("narrativeCount", "")).strip():
            self._kind.setCurrentIndex(self._kind.findData("narrativeCount"))
        elif isinstance(data.get("plane"), str) and str(data.get("plane", "")).strip():
            self._kind.setCurrentIndex(self._kind.findData("plane"))
        else:
            self._kind.setCurrentIndex(3)
        k = self._kind.currentData()
        self._kind.blockSignals(False)
        assert isinstance(k, str)
        self._rebuild_body(k)

        if k == "all" or k == "any":
            key = "all" if k == "all" else "any"
            for item in data.get(key) or []:
                if isinstance(item, dict):
                    self._add_child()
                    self._child_editors[-1].set_dict(item)
        elif k == "not":
            inner = data.get("not")
            if isinstance(inner, dict) and self._not_child:
                self._not_child.set_dict(inner)
        elif k == "flag" and self._flag_field and self._flag_op and self._flag_val_reg and self._flag_val_mode and self._flag_free_value is not None:
            # 程序性载入：静默设值，不发 valueChanged（_loading 亦已兜底，双重保险）。
            self._flag_field.set_key_silent(str(data.get("flag", "")))
            self._flag_val_reg.set_flag_key(self._flag_field.key())
            op = str(data.get("op", "=="))
            iop = self._flag_op.findText(op)
            self._flag_op.setCurrentIndex(max(0, iop))
            v = data.get("value", True)
            if isinstance(v, str):
                ir = self._flag_val_mode.findData("string_ref")
                self._flag_val_mode.blockSignals(True)
                self._flag_val_mode.setCurrentIndex(ir if ir >= 0 else 1)
                self._flag_val_mode.blockSignals(False)
                self._sync_flag_value_widgets_visibility()
                if isinstance(self._flag_free_value, RichTextLineEdit):
                    self._flag_free_value.setText(v)
                else:
                    self._flag_free_value.setText(v)
            else:
                ir0 = self._flag_val_mode.findData("registry")
                self._flag_val_mode.blockSignals(True)
                self._flag_val_mode.setCurrentIndex(ir0 if ir0 >= 0 else 0)
                self._flag_val_mode.blockSignals(False)
                self._sync_flag_value_widgets_visibility()
                self._flag_val_reg.set_value(v)
        elif k == "quest" and self._q_id and self._q_st:
            _qid = str(data.get("quest", ""))
            _qm = self._model()
            if _qm is not None and hasattr(_qm, "quest_status_target_ids"):
                _items = list(_qm.quest_status_target_ids())
            elif _qm is not None and hasattr(_qm, "all_quest_ids"):
                _items = list(_qm.all_quest_ids())
            else:
                _items = []
            _ids = [i[0] if isinstance(i, (list, tuple)) else i for i in _items]
            if _qid and _qid not in _ids:
                _items.append((_qid, _qid))  # 保留指向已删/未知任务的既有值,不静默丢失
            self._q_id.set_items(_items)
            self._q_id.set_current(_qid)
            qs = str(data.get("questStatus", data.get("status", "Completed")))
            iqs = self._q_st.findData(qs)
            if iqs < 0:
                iqs = self._q_st.findText(qs)
            self._q_st.setCurrentIndex(iqs if iqs >= 0 else 2)
        elif k == "scenarioLine" and self._sl_id and self._sl_st:
            self._fill_scenario_line_combo()
            slid = str(data.get("scenarioLine", "")).strip()
            idx = self._sl_id.findData(slid)
            if idx < 0 and slid:
                # 保留指向已删/未知 scenario 的既有值，不静默丢失（与 quest/narrative 一致）
                self._sl_id.addItem(f"（数据）{slid}", slid)
                idx = self._sl_id.count() - 1
            self._sl_id.setCurrentIndex(idx if idx >= 0 else 0)
            lst = str(data.get("lineStatus", "inactive")).strip()
            i2 = self._sl_st.findData(lst)
            if i2 < 0:
                self._sl_st.addItem(f"（数据）{lst}", lst)
                i2 = self._sl_st.count() - 1
            self._sl_st.setCurrentIndex(i2)
        elif k == "scenario" and self._sc_id and self._sc_ph and self._sc_st and self._sc_out:
            self._fill_scenario_combos()
            sc = str(data.get("scenario", "")).strip()
            idx = self._sc_id.findData(sc)
            if idx < 0 and sc:
                # 保留指向已删/未知 scenario 的既有值，不静默丢失（与 quest/narrative 一致）
                self._sc_id.addItem(f"（数据）{sc}", sc)
                idx = self._sc_id.count() - 1
            self._sc_id.setCurrentIndex(idx if idx >= 0 else 0)
            self._fill_phase_combo()
            ph = str(data.get("phase", "")).strip()
            idx2 = self._sc_ph.findData(ph)
            if idx2 < 0 and ph:
                # 已删/未知 phase 同样保留，避免静默改写
                self._sc_ph.addItem(f"（数据）{ph}", ph)
                idx2 = self._sc_ph.count() - 1
            self._sc_ph.setCurrentIndex(idx2 if idx2 >= 0 else 0)
            st = str(data.get("status", "done"))
            idx3 = self._sc_st.findData(st)
            if idx3 < 0:
                self._sc_st.addItem(f"（数据）{st}", st)
                idx3 = self._sc_st.count() - 1
            self._sc_st.setCurrentIndex(idx3)
            oc = data.get("outcome")
            if oc is None:
                self._sc_out.clear()
            elif isinstance(oc, (str, int, float, bool)):
                self._sc_out.setText(str(oc) if isinstance(oc, str) else json.dumps(oc, ensure_ascii=False))
            else:
                try:
                    self._sc_out.setText(json.dumps(oc, ensure_ascii=False))
                except (TypeError, ValueError):
                    self._sc_out.setText(str(oc))
        elif k == "narrative" and self._nv_graph and self._nv_state and self._nv_reached:
            gid = str(data.get("narrative", "")).strip()
            idx = self._nv_graph.findData(gid)
            if idx < 0 and gid:
                self._nv_graph.addItem(f"（数据）{gid}", gid)
                idx = self._nv_graph.count() - 1
            self._nv_graph.blockSignals(True)
            self._nv_graph.setCurrentIndex(max(0, idx))
            self._nv_graph.blockSignals(False)
            self._fill_narrative_state_combo()
            sid = str(data.get("state", "")).strip()
            i2 = self._nv_state.findData(sid)
            if i2 < 0 and sid:
                self._nv_state.addItem(f"（数据）{sid}", sid)
                i2 = self._nv_state.count() - 1
            self._nv_state.blockSignals(True)
            self._nv_state.setCurrentIndex(max(0, i2))
            self._nv_state.blockSignals(False)
            self._nv_reached.setChecked(data.get("reached") is True)
        elif k == "narrativeCount" and self._nc_graph and self._nc_exit and self._nc_op and self._nc_value:
            gid = str(data.get("narrativeCount", "")).strip()
            idx = self._nc_graph.findData(gid)
            if idx < 0 and gid:
                self._nc_graph.addItem(f"（数据）{gid}", gid)  # 指向已删/改名活计的既有值不静默丢
                idx = self._nc_graph.count() - 1
            self._nc_graph.blockSignals(True)
            self._nc_graph.setCurrentIndex(max(0, idx))
            self._nc_graph.blockSignals(False)
            self._fill_narrative_count_exit_combo()
            exit_id = str(data.get("exitState", "")).strip()
            i2 = self._nc_exit.findData(exit_id)
            if i2 < 0 and exit_id:
                self._nc_exit.addItem(f"（数据）{exit_id}", exit_id)
                i2 = self._nc_exit.count() - 1
            self._nc_exit.blockSignals(True)
            self._nc_exit.setCurrentIndex(max(0, i2))
            self._nc_exit.blockSignals(False)
            op = str(data.get("op", ">="))
            iop = self._nc_op.findData(op)
            self._nc_op.blockSignals(True)
            self._nc_op.setCurrentIndex(max(0, iop))
            self._nc_op.blockSignals(False)
            v = data.get("value")
            self._nc_value.blockSignals(True)
            self._nc_value.setValue(int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 1)
            self._nc_value.blockSignals(False)
        elif k == "plane" and self._pl_id:
            pid = str(data.get("plane", "")).strip()
            _pm = self._model()
            _items = (
                list(_pm.all_plane_ids())
                if (_pm is not None and hasattr(_pm, "all_plane_ids"))
                else []
            )
            _ids = [i[0] if isinstance(i, (list, tuple)) else i for i in _items]
            if pid and pid not in _ids:
                _items.append((pid, pid))  # 保留指向已删/未知位面的既有值，不静默丢失
            self._pl_id.set_items(_items)
            self._pl_id.set_current(pid)
        # 记录原始 dict 与"载入后立即序列化"的规范化基线：
        # to_dict 时若规范化输出仍等于基线（= UI 无实际编辑），逐字返回原 dict。
        self._orig_data = copy.deepcopy(data)
        self._orig_canonical = self._to_dict_canonical()

    def to_dict(self) -> dict[str, Any]:
        cur = self._to_dict_canonical()
        orig = getattr(self, "_orig_data", None)
        if orig is not None and cur == getattr(self, "_orig_canonical", None):
            return copy.deepcopy(orig)
        return cur

    def _to_dict_canonical(self) -> dict[str, Any]:
        k = self._kind.currentData()
        if not isinstance(k, str):
            return {}
        if k == "all":
            items = [c.to_dict() for c in self._child_editors if c.to_dict()]
            return {"all": items}
        if k == "any":
            items = [c.to_dict() for c in self._child_editors if c.to_dict()]
            return {"any": items}
        if k == "not":
            if self._not_child:
                inner = self._not_child.to_dict()
                if inner:
                    return {"not": inner}
            return {"not": {"all": []}}
        if k == "flag" and self._flag_field and self._flag_op and self._flag_val_reg and self._flag_val_mode and self._flag_free_value is not None:
            fk = self._flag_field.key().strip()
            if not fk:
                return {}
            result: dict[str, Any] = {"flag": fk}
            op = self._flag_op.currentText()
            if op != "==":
                result["op"] = op
            mode = self._flag_val_mode.currentData()
            if mode == "string_ref":
                result["value"] = self._flag_free_text()
            else:
                v = self._flag_val_reg.get_value()
                if isinstance(v, bool):
                    if op == "==" and v is True:
                        pass
                    else:
                        result["value"] = v
                else:
                    # 不做 float() 强转：FlagValueEdit 原值保留（int 保 int、raw 保原类型）
                    result["value"] = v
            return result
        if k == "quest" and self._q_id and self._q_st:
            qid = self._q_id.current_id().strip()
            if not qid:
                return {}
            qs = self._q_st.currentData()
            return {"quest": qid, "questStatus": str(qs) if qs is not None else "Completed"}
        if k == "scenarioLine" and self._sl_id and self._sl_st:
            slid = self._sl_id.currentData()
            slid = slid.strip() if isinstance(slid, str) else ""
            st_d = self._sl_st.currentData()
            st = str(st_d) if st_d is not None else self._sl_st.currentText()
            if not slid:
                return {}
            return {"scenarioLine": slid, "lineStatus": st}
        if k == "scenario" and self._sc_id and self._sc_ph and self._sc_st and self._sc_out:
            sid = self._sc_id.currentData()
            sid = sid.strip() if isinstance(sid, str) else ""
            phd = self._sc_ph.currentData()
            ph = phd.strip() if isinstance(phd, str) else ""
            st_d = self._sc_st.currentData()
            st = str(st_d) if st_d is not None else self._sc_st.currentText()
            if not sid:
                return {}
            # phase 允许为空（运行时 isScenarioLeaf / validator 接受 phase:''）：
            # 保留该值而非把整条 scenario 条件静默丢弃。
            out: dict[str, Any] = {"scenario": sid, "phase": ph, "status": st}
            ot = self._sc_out.text().strip()
            if ot:
                orig = getattr(self, "_orig_data", None)
                orig_oc = orig.get("outcome") if isinstance(orig, dict) else None
                if (
                    isinstance(orig, dict)
                    and "outcome" in orig
                    and _render_outcome_text(orig_oc) == ot
                ):
                    # 文本未改动：按原始类型回写（字符串 "true" 不漂成 bool）
                    out["outcome"] = copy.deepcopy(orig_oc)
                else:
                    try:
                        out["outcome"] = json.loads(ot)
                    except json.JSONDecodeError:
                        if ot.lower() in ("true", "false"):
                            out["outcome"] = ot.lower() == "true"
                        else:
                            out["outcome"] = ot
            return out
        if k == "narrative" and self._nv_graph and self._nv_state and self._nv_reached:
            gid = self._nv_graph.currentData()
            gid = gid.strip() if isinstance(gid, str) else ""
            sid = self._nv_state.currentData()
            sid = sid.strip() if isinstance(sid, str) else ""
            if not gid or not sid:
                return {}
            leaf: dict[str, Any] = {"narrative": gid, "state": sid}
            if self._nv_reached.isChecked():
                leaf["reached"] = True
            return leaf
        if k == "narrativeCount" and self._nc_graph and self._nc_exit and self._nc_op and self._nc_value:
            gid = self._nc_graph.currentData()
            gid = gid.strip() if isinstance(gid, str) else ""
            if not gid:
                return {}
            leaf: dict[str, Any] = {"narrativeCount": gid}
            exit_id = self._nc_exit.currentData()
            exit_id = exit_id.strip() if isinstance(exit_id, str) else ""
            if exit_id:
                leaf["exitState"] = exit_id
            op_d = self._nc_op.currentData()
            leaf["op"] = str(op_d) if op_d is not None else ">="
            leaf["value"] = int(self._nc_value.value())
            return leaf
        if k == "plane" and self._pl_id:
            pid = self._pl_id.current_id().strip()
            if not pid:
                return {}
            return {"plane": pid}
        return {}


class ConditionExprTreeRootWidget(QWidget):
    """根容器：对外 set_expr / get_expr；changed 在子树变更时发出。"""

    changed = Signal()

    def __init__(
        self,
        parent: QWidget | None = None,
        *,
        model_getter: Callable[[], Any],
    ) -> None:
        super().__init__(parent)
        self._model_getter = model_getter
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Expanding,
        )
        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setMinimumHeight(_CONDITION_EXPR_TREE_SCROLL_MIN_HEIGHT)
        scroll.setMaximumHeight(_CONDITION_EXPR_TREE_SCROLL_MAX_HEIGHT)
        scroll.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Expanding,
        )
        host = QWidget(scroll)
        hl = QVBoxLayout(host)
        self._root = ConditionExprNodeEditor(0, model_getter, host)
        self._root.set_remove_callback(None)
        self._root.changed.connect(self.changed.emit)
        hl.addWidget(self._root)
        hl.addStretch()
        scroll.setWidget(host)
        # 说明改入 tooltip，不在界面长期堆大段文字（没人会逐字读）。
        scroll.setToolTip(
            "与运行时 evaluateConditionExpr 一致；嵌套最深 32 层。"
            "根节点可为任意类型；留空必填项（flag / scenario / scenarioLine / quest）导出时省略该分支。",
        )
        lay.addWidget(scroll, stretch=1)

    def set_model_refresh(self) -> None:
        """清单（scenarios 等）变更后刷新 scenario 下拉。"""
        self._root.refresh_scenario_dropdowns()

    def set_expr(self, expr: dict[str, Any] | None) -> None:
        if expr is None:
            self._root.set_dict({"flag": ""})
            return
        self._root.set_dict(expr)

    def get_expr(self) -> dict[str, Any] | None:
        d = self._root.to_dict()
        if not d:
            return None
        if _is_flag_atom(d) and not str(d.get("flag", "")).strip():
            return None
        if isinstance(d.get("scenario"), str) and not str(d.get("scenario", "")).strip():
            return None
        if isinstance(d.get("scenarioLine"), str) and not str(d.get("scenarioLine", "")).strip():
            return None
        return d
