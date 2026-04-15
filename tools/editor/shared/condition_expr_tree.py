"""递归 ConditionExpr 树形编辑器（all / any / not / flag / quest / scenario）。"""
from __future__ import annotations

import json
from typing import Any, Callable

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QFormLayout,
    QComboBox,
    QPushButton,
    QLineEdit,
    QLabel,
    QScrollArea,
)

from .flag_key_field import FlagKeyPickField
from .flag_value_edit import FlagValueEdit

# 与 narrative_data_editors /运行时一致
_SCENARIO_STATUSES = ("pending", "active", "done", "locked")
_QUEST_STATUSES = ("Inactive", "Active", "Completed")
_MAX_DEPTH = 32


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
        self._not_wrap: QWidget | None = None

        self._flag_field: FlagKeyPickField | None = None
        self._flag_op: QComboBox | None = None
        self._flag_val: FlagValueEdit | None = None
        self._q_id: QLineEdit | None = None
        self._q_st: QComboBox | None = None
        self._sc_id: QComboBox | None = None
        self._sc_ph: QComboBox | None = None
        self._sc_st: QComboBox | None = None
        self._sc_out: QLineEdit | None = None

        self._remove_callback: Callable[[ConditionExprNodeEditor], None] | None = None

        self._kind.blockSignals(True)
        self._kind.setCurrentIndex(3)
        self._kind.blockSignals(False)
        self._rebuild_body("flag")

    def set_remove_callback(self, cb: Callable[[ConditionExprNodeEditor], None]) -> None:
        self._remove_callback = cb

    def _request_remove(self) -> None:
        if self._remove_callback:
            self._remove_callback(self)

    def _model(self) -> Any:
        return self._model_getter()

    def _on_kind_changed(self) -> None:
        k = self._kind.currentData()
        if isinstance(k, str):
            self._rebuild_body(k)
        self.changed.emit()

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
        self._not_wrap = None
        self._child_editors.clear()
        self._not_child = None
        self._flag_field = None
        self._flag_op = None
        self._flag_val = None
        self._q_id = None
        self._q_st = None
        self._sc_id = None
        self._sc_ph = None
        self._sc_st = None
        self._sc_out = None

    def _rebuild_body(self, kind: str) -> None:
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
            if self._depth >= _MAX_DEPTH - 1:
                tip = QLabel(f"嵌套已达上限（{_MAX_DEPTH}），无法添加 not 子节点")
                tip.setWordWrap(True)
                nl.addWidget(tip)
            else:
                ch = ConditionExprNodeEditor(self._depth + 1, self._model_getter, nw)
                ch.set_remove_callback(None)
                ch.changed.connect(self.changed.emit)
                self._not_child = ch
                nl.addWidget(ch)
            self._body.addWidget(nw)
        elif kind == "flag":
            fw = QWidget()
            fl = QHBoxLayout(fw)
            fl.setContentsMargins(0, 0, 0, 0)
            m = self._model()
            reg = m.flag_registry if m else {}
            self._flag_field = FlagKeyPickField(m, None, "", fw)
            self._flag_field.setMinimumWidth(100)
            self._flag_field.valueChanged.connect(self.changed.emit)
            self._flag_op = QComboBox()
            self._flag_op.addItems(["==", "!=", ">", "<", ">=", "<="])
            self._flag_op.currentTextChanged.connect(lambda _t: self.changed.emit())
            self._flag_val = FlagValueEdit(fw, reg)
            self._flag_val.valueChanged.connect(self.changed.emit)
            fl.addWidget(self._flag_field, stretch=1)
            fl.addWidget(self._flag_op)
            fl.addWidget(self._flag_val)
            self._flag_wrap = fw
            self._body.addWidget(fw)
        elif kind == "quest":
            qw = QWidget()
            qf = QFormLayout(qw)
            self._q_id = QLineEdit()
            self._q_id.setPlaceholderText("quest id")
            self._q_id.textChanged.connect(lambda: self.changed.emit())
            self._q_st = QComboBox()
            for qs in _QUEST_STATUSES:
                self._q_st.addItem(qs, qs)
            self._q_st.currentIndexChanged.connect(lambda _i: self.changed.emit())
            qf.addRow("quest", self._q_id)
            qf.addRow("questStatus", self._q_st)
            self._quest_wrap = qw
            self._body.addWidget(qw)
        elif kind == "scenario":
            sw = QWidget()
            sf = QFormLayout(sw)
            self._sc_id = QComboBox()
            self._sc_id.setEditable(False)
            self._sc_id.currentIndexChanged.connect(self._on_scenario_combo)
            self._sc_ph = QComboBox()
            self._sc_ph.setEditable(False)
            self._sc_ph.currentIndexChanged.connect(lambda _i: self.changed.emit())
            self._sc_st = QComboBox()
            for s in _SCENARIO_STATUSES:
                self._sc_st.addItem(s, s)
            self._sc_st.currentIndexChanged.connect(lambda _i: self.changed.emit())
            self._sc_out = QLineEdit()
            self._sc_out.setPlaceholderText("可选 outcome（JSON 或字面量）")
            self._sc_out.textChanged.connect(lambda: self.changed.emit())
            sf.addRow("scenario", self._sc_id)
            sf.addRow("phase", self._sc_ph)
            sf.addRow("status", self._sc_st)
            sf.addRow("outcome（可选）", self._sc_out)
            self._sc_wrap = sw
            self._body.addWidget(sw)
            self._fill_scenario_combos()

    def _fill_scenario_combos(self) -> None:
        if not self._sc_id or not self._sc_ph:
            return
        m = self._model()
        self._sc_id.blockSignals(True)
        self._sc_id.clear()
        self._sc_id.addItem("（选择）", "")
        if m:
            for sid in m.scenario_ids_ordered():
                self._sc_id.addItem(sid, sid)
        self._sc_id.blockSignals(False)
        self._fill_phase_combo()

    def _on_scenario_combo(self, _i: int) -> None:
        self._fill_phase_combo()
        self.changed.emit()

    def _fill_phase_combo(self) -> None:
        if not self._sc_ph or not self._sc_id:
            return
        m = self._model()
        sid = self._sc_id.currentData()
        sid = sid.strip() if isinstance(sid, str) else ""
        self._sc_ph.blockSignals(True)
        self._sc_ph.clear()
        self._sc_ph.addItem("（选择）", "")
        if m and sid:
            for ph in m.phases_for_scenario(sid):
                self._sc_ph.addItem(ph, ph)
        self._sc_ph.blockSignals(False)

    def refresh_scenario_dropdowns(self) -> None:
        if self._sc_id:
            self._fill_scenario_combos()
        for c in self._child_editors:
            c.refresh_scenario_dropdowns()
        if self._not_child:
            self._not_child.refresh_scenario_dropdowns()

    def _add_child(self) -> None:
        if self._depth >= _MAX_DEPTH - 1 or not self._lay_all_any:
            return
        ch = ConditionExprNodeEditor(self._depth + 1, self._model_getter)
        ch.set_remove_callback(self._remove_child)
        ch.changed.connect(self.changed.emit)
        self._child_editors.append(ch)
        self._lay_all_any.addWidget(ch)
        self.changed.emit()

    def _remove_child(self, editor: ConditionExprNodeEditor) -> None:
        if editor in self._child_editors:
            self._child_editors.remove(editor)
            editor.setParent(None)
            editor.deleteLater()
            self.changed.emit()

    def set_dict(self, data: dict[str, Any] | None) -> None:
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
        elif isinstance(data.get("scenario"), str) and str(data.get("scenario", "")).strip():
            self._kind.setCurrentIndex(5)
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
        elif k == "flag" and self._flag_field and self._flag_op and self._flag_val:
            self._flag_field.set_key(str(data.get("flag", "")))
            self._flag_val.set_flag_key(self._flag_field.key())
            op = str(data.get("op", "=="))
            iop = self._flag_op.findText(op)
            self._flag_op.setCurrentIndex(max(0, iop))
            self._flag_val.set_value(data.get("value", True))
        elif k == "quest" and self._q_id and self._q_st:
            self._q_id.setText(str(data.get("quest", "")))
            qs = str(data.get("questStatus", data.get("status", "Completed")))
            iqs = self._q_st.findData(qs)
            if iqs < 0:
                iqs = self._q_st.findText(qs)
            self._q_st.setCurrentIndex(iqs if iqs >= 0 else 2)
        elif k == "scenario" and self._sc_id and self._sc_ph and self._sc_st and self._sc_out:
            self._fill_scenario_combos()
            sc = str(data.get("scenario", "")).strip()
            idx = self._sc_id.findData(sc)
            self._sc_id.setCurrentIndex(idx if idx >= 0 else 0)
            self._fill_phase_combo()
            ph = str(data.get("phase", "")).strip()
            idx2 = self._sc_ph.findData(ph)
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

    def to_dict(self) -> dict[str, Any]:
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
        if k == "flag" and self._flag_field and self._flag_op and self._flag_val:
            fk = self._flag_field.key().strip()
            if not fk:
                return {}
            result: dict[str, Any] = {"flag": fk}
            op = self._flag_op.currentText()
            if op != "==":
                result["op"] = op
            v = self._flag_val.get_value()
            if isinstance(v, bool):
                if op == "==" and v is True:
                    pass
                else:
                    result["value"] = v
            elif isinstance(v, str):
                result["value"] = v
            else:
                result["value"] = float(v)
            return result
        if k == "quest" and self._q_id and self._q_st:
            qid = self._q_id.text().strip()
            if not qid:
                return {}
            qs = self._q_st.currentData()
            return {"quest": qid, "questStatus": str(qs) if qs is not None else "Completed"}
        if k == "scenario" and self._sc_id and self._sc_ph and self._sc_st and self._sc_out:
            sid = self._sc_id.currentData()
            sid = sid.strip() if isinstance(sid, str) else ""
            phd = self._sc_ph.currentData()
            ph = phd.strip() if isinstance(phd, str) else ""
            st_d = self._sc_st.currentData()
            st = str(st_d) if st_d is not None else self._sc_st.currentText()
            if not sid or not ph:
                return {}
            out: dict[str, Any] = {"scenario": sid, "phase": ph, "status": st}
            ot = self._sc_out.text().strip()
            if ot:
                try:
                    out["outcome"] = json.loads(ot)
                except json.JSONDecodeError:
                    if ot.lower() in ("true", "false"):
                        out["outcome"] = ot.lower() == "true"
                    else:
                        out["outcome"] = ot
            return out
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
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        scroll.setMaximumHeight(420)
        host = QWidget()
        hl = QVBoxLayout(host)
        self._root = ConditionExprNodeEditor(0, model_getter, host)
        self._root.set_remove_callback(None)
        self._root.changed.connect(self.changed.emit)
        hl.addWidget(self._root)
        hl.addStretch()
        scroll.setWidget(host)
        lay.addWidget(scroll)
        tip = QLabel(
            "与运行时 evaluateConditionExpr 一致；嵌套最深32 层。"
            "根节点可为任意类型；留空 flag / scenario / quest 必填项则导出时省略该分支逻辑（见 get_expr）。"
        )
        tip.setWordWrap(True)
        lay.addWidget(tip)

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
        return d
