"""热区/任务等条件编辑：多行 flag 条件 + 结构化 ConditionExpr 树。

导出为 `ConditionExpr[]` 语义（组内 AND）。递归「表达式树」负责编辑
all/any/not 与 flag/quest/scenario/scenarioLine/narrative/plane 叶子（与运行时一致）。
原始 JSON 粘贴区只保留为专家兜底，不作为常规填写入口。
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QPushButton,
    QComboBox, QLabel, QFrame, QPlainTextEdit, QSizePolicy,
)
from PySide6.QtCore import Signal

from .flag_key_field import FlagKeyPickField
from .flag_value_edit import FlagValueEdit
from .condition_expr_tree import ConditionExprTreeRootWidget
from .collapsible_section import CollapsibleSection

if TYPE_CHECKING:
    from ..project_model import ProjectModel


class ConditionRow(QWidget):
    removed = Signal(object)
    changed = Signal()

    def __init__(
        self,
        data: dict | None = None,
        model: ProjectModel | None = None,
        scene_id: str | None = None,
        parent: QWidget | None = None,
    ):
        super().__init__(parent)
        self._model = model
        self._scene_id = scene_id
        # 原始条目快照：未改动时按原形状回写（显式 op:"=="/value:true 不丢、int 不漂 float）
        self._orig: dict | None = dict(data) if isinstance(data, dict) else None
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)

        self._val = FlagValueEdit(self, model.flag_registry if model else {})
        cur = (data.get("flag", "") if data else "")
        self._field = FlagKeyPickField(model, scene_id, str(cur) if cur else "", self)
        self._field.setMinimumWidth(96)
        self._field.valueChanged.connect(self._on_flag_key_changed)

        self.op_combo = QComboBox(self)
        self.op_combo.addItems(["==", "!=", ">", "<", ">=", "<="])
        if data and "op" in data:
            self.op_combo.setCurrentText(data["op"])
        self.op_combo.setMaximumWidth(56)

        init_v = data.get("value", True) if data else True
        self._val.set_flag_key(self._field.key())
        self._val.set_value(init_v)

        self.del_btn = QPushButton("\u2212", self)
        self.del_btn.setFixedWidth(24)
        self.del_btn.clicked.connect(lambda: self.removed.emit(self))

        lay.addWidget(self._field, stretch=1)
        lay.addWidget(self.op_combo)
        lay.addWidget(self._val)
        lay.addWidget(self.del_btn)

        self.op_combo.currentTextChanged.connect(self.changed)
        self._val.valueChanged.connect(self.changed)

    def _on_flag_key_changed(self) -> None:
        self._val.set_flag_key(self._field.key())
        self.changed.emit()

    def set_picker_context(self, model: ProjectModel | None, scene_id: str | None) -> None:
        self._model = model
        self._scene_id = scene_id
        self._field.set_context(model, scene_id)
        self._val.set_registry(model.flag_registry if model else {})
        self._val.set_flag_key(self._field.key())

    def current_flag(self) -> str:
        return self._field.key()

    def set_flag_key(self, key: str) -> None:
        self._field.set_key(key)

    def to_dict(self) -> dict:
        fk = self.current_flag()
        if not fk:
            return {}
        result: dict = {"flag": fk}
        op = self.op_combo.currentText()
        orig = self._orig if isinstance(self._orig, dict) else None
        same_flag = bool(orig) and orig.get("flag") == fk
        if op != "==":
            result["op"] = op
        elif same_flag and orig.get("op") == "==":
            result["op"] = "=="  # 原数据显式写了 op:"=="，保真不删键
        v = self._val.get_value()
        if (
            same_flag
            and "value" not in orig
            and v is True
            and op == (orig.get("op") or "==")
        ):
            return result  # 原本就无 value 键（缺省 true），保持缺省
        if isinstance(v, bool):
            if op == "==" and v is True and not (same_flag and "value" in orig):
                pass  # 新写的 ==true 维持省略习惯
            else:
                result["value"] = v
        else:
            # 不做 float() 强转：FlagValueEdit 原值保留（int 保 int、raw 保原类型）
            result["value"] = v
        return result


class ConditionEditor(QWidget):
    changed = Signal()

    def __init__(
        self,
        label: str = "Conditions",
        parent: QWidget | None = None,
        *,
        hint: str | None = None,
    ):
        super().__init__(parent)
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.MinimumExpanding)
        self._rows: list[ConditionRow] = []
        self._ctx_model: ProjectModel | None = None
        self._ctx_scene_id: str | None = None

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addWidget(QLabel(f"<b>{label}</b>"))
        if hint:
            hl = QLabel(hint)
            hl.setWordWrap(True)
            root.addWidget(hl)
        self._rows_layout = QVBoxLayout()
        self._rows_layout.setSpacing(2)
        root.addLayout(self._rows_layout)

        self._pattern_frame = QFrame()
        self._pattern_frame.setVisible(False)
        pr = QVBoxLayout(self._pattern_frame)
        pr.setContentsMargins(0, 4, 0, 0)
        _pat_lbl = QLabel("快速拼装")
        _pat_lbl.setToolTip("复杂请用每行「选择…」里「编辑登记表」")
        pr.addWidget(_pat_lbl)
        ph = QHBoxLayout()
        self._pat_combo = QComboBox()
        self._pat_combo.setMinimumWidth(96)
        self._id_combo = QComboBox()
        self._id_combo.setEditable(False)
        self._id_combo.setMinimumWidth(72)
        apply_btn = QPushButton("填入选中行 / 末行")
        apply_btn.setToolTip("优先填入当前焦点所在行的 flag；否则填入最后一行空 flag；否则追加一行")
        apply_btn.clicked.connect(self._apply_pattern_to_row)
        ph.addWidget(self._pat_combo, stretch=1)
        ph.addWidget(self._id_combo, stretch=1)
        ph.addWidget(apply_btn)
        pr.addLayout(ph)
        root.addWidget(self._pattern_frame)
        self._pat_combo.currentIndexChanged.connect(self._on_pattern_combo_changed)

        add_btn = QPushButton(f"+ {label}")
        add_btn.clicked.connect(self._add_empty)
        root.addWidget(add_btn)

        self._tree_root = ConditionExprTreeRootWidget(model_getter=self._get_model)
        self._tree_root.changed.connect(self.changed.emit)
        tree_head = QLabel("<b>表达式树</b>")
        tree_head.setToolTip("与上行 flag 条件组内 AND")
        root.addWidget(tree_head)
        root.addWidget(self._tree_root, stretch=1)

        # 专家兜底（原始 ConditionExpr 粘贴）几乎永远为空：默认折叠，避免长期占大片空白；
        # 说明收进折叠标题的 tooltip，不在界面堆解释文字。
        self._extra_json = QPlainTextEdit()
        self._extra_json.setPlaceholderText(
            "通常留空。仅临时兼容未来新增 ConditionExpr 形状。",
        )
        self._extra_json.setMinimumHeight(80)
        self._extra_json.setMaximumHeight(320)
        self._extra_json.textChanged.connect(self.changed.emit)
        self._extra_json.textChanged.connect(self._sync_expert_gate)
        expert = CollapsibleSection("专家兜底：原始 ConditionExpr（通常不用）", start_open=False)
        expert.set_header_tool_tip(
            "遇到未来新增条件类型且树暂未支持时可临时粘贴；"
            "单个对象或对象数组均可。与上方 flag 行语义为组内 AND。",
        )
        expert.add_body(self._extra_json)
        root.addWidget(expert)

    def _get_model(self) -> ProjectModel | None:
        return self._ctx_model

    def set_flag_pattern_context(self, model: ProjectModel | None, scene_id: str | None) -> None:
        self._ctx_model = model
        self._ctx_scene_id = scene_id
        for row in self._rows:
            row.set_picker_context(model, scene_id)
        self._pat_combo.blockSignals(True)
        self._pat_combo.clear()
        self._pat_combo.addItem("(选择模板…)", None)
        regs = (model.flag_registry.get("patterns") if model else None) or []
        for p in regs:
            if isinstance(p, dict) and p.get("id"):
                label = str(p["id"])
                pre = p.get("prefix", "")
                suf = p.get("suffix") or ""
                hint = f"{label}  ({pre}…{suf})" if suf else f"{label}  ({pre}…)"
                self._pat_combo.addItem(hint, p)
        self._pat_combo.blockSignals(False)
        has = model is not None and len(regs) > 0
        self._pattern_frame.setVisible(has)
        self._on_pattern_combo_changed(0)
        self._tree_root.set_model_refresh()

    def _on_pattern_combo_changed(self, _idx: int) -> None:
        self._id_combo.clear()
        data = self._pat_combo.currentData()
        if not data or not self._ctx_model:
            return
        from ..flag_registry import ids_for_registry_pattern_source
        src = data.get("idSource")
        ids = ids_for_registry_pattern_source(
            self._ctx_model, scene_id=self._ctx_scene_id, id_source=src,
        )
        self._id_combo.addItems(ids)

    def _focused_condition_row(self) -> ConditionRow | None:
        fw = self.window().focusWidget() if self.window() else None
        w = fw
        while w is not None:
            if isinstance(w, ConditionRow) and w in self._rows:
                return w
            w = w.parentWidget()
        return None

    def _apply_pattern_to_row(self) -> None:
        p = self._pat_combo.currentData()
        if not p or not self._ctx_model:
            return
        rid = self._id_combo.currentText().strip()
        if not rid:
            return
        pre = p.get("prefix", "")
        suf = p.get("suffix") or ""
        key = f"{pre}{rid}{suf}"
        target = self._focused_condition_row()
        if target is not None:
            target.set_flag_key(key)
            return
        for row in reversed(self._rows):
            if not row.current_flag():
                row.set_flag_key(key)
                return
        self._add_row({"flag": key, "value": True})
        self.changed.emit()

    def set_flags(self, *_args, **_kwargs) -> None:
        """Deprecated: no-op for old call sites."""

    @staticmethod
    def _is_flag_leaf(c: dict) -> bool:
        if not isinstance(c, dict) or c.get("flag") is None:
            return False
        return set(c.keys()) <= {"flag", "op", "value"}

    def set_data(self, conditions: list[dict]) -> None:
        import copy

        self._clear()
        # 原始数组快照：内容未被实际编辑时 to_list 逐字返回它，
        # 保住原始形状/顺序（不做 flag 行前置、不把多叶包成 {"all":[…]}）。
        self._orig_conditions = copy.deepcopy(list(conditions))
        rest: list[dict] = []
        for c in conditions:
            if isinstance(c, dict) and self._is_flag_leaf(c):
                self._add_row(c)
            elif isinstance(c, dict):
                rest.append(c)
        if rest:
            expr: object = rest[0] if len(rest) == 1 else {"all": rest}
            self._tree_root.set_expr(expr if isinstance(expr, dict) else None)
            # 程序性载入清空专家框：屏蔽 textChanged，避免载入即外发 changed 误标脏。
            self._extra_json.blockSignals(True)
            self._extra_json.clear()
            self._extra_json.blockSignals(False)
        else:
            self._tree_root.set_expr(None)
        self._sync_expert_gate()

    def _canonical_parts(self) -> tuple[list[dict], object]:
        flags = [d for d in (r.to_dict() for r in self._rows) if d.get("flag")]
        te = self._tree_root.get_expr()
        return flags, te

    def _matches_orig(self, flags_now: list[dict], tree_now: object) -> bool:
        orig = getattr(self, "_orig_conditions", None)
        if orig is None:
            return False
        if self._extra_json.toPlainText().strip():
            return False
        orig_flags = [c for c in orig if isinstance(c, dict) and self._is_flag_leaf(c)]
        orig_rest = [c for c in orig if isinstance(c, dict) and not self._is_flag_leaf(c)]
        if orig_rest:
            expected_tree: object = orig_rest[0] if len(orig_rest) == 1 else {"all": orig_rest}
        else:
            expected_tree = None
        return flags_now == orig_flags and tree_now == expected_tree

    def to_list(self) -> list[dict]:
        import copy

        flags_now, te = self._canonical_parts()
        if self._matches_orig(flags_now, te):
            return copy.deepcopy(self._orig_conditions)
        out: list[dict] = list(flags_now)
        if te is not None:
            out.append(te)
        raw = self._extra_json.toPlainText().strip()
        if not raw:
            return out
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            # 非法 JSON 不静默丢：保留在框里并标红（_sync_expert_gate），不进导出
            return out
        if isinstance(obj, list):
            for item in obj:
                if isinstance(item, dict):
                    out.append(item)
        elif isinstance(obj, dict):
            out.append(obj)
        return out

    def _sync_expert_gate(self) -> None:
        """专家兜底框状态：非法 JSON 标红提示；内容永不静默丢弃（树激活时也并入导出）。"""
        raw = self._extra_json.toPlainText().strip()
        bad = False
        if raw:
            try:
                json.loads(raw)
            except json.JSONDecodeError:
                bad = True
        self._extra_json.setStyleSheet(
            "QPlainTextEdit { border: 1px solid #c0392b; }" if bad else ""
        )
        self._extra_json.setToolTip(
            "JSON 无法解析——此内容不会进入导出，请修正。" if bad else "",
        )

    def _clear(self) -> None:
        self._orig_conditions = None
        self._tree_root.set_expr(None)
        self._extra_json.blockSignals(True)
        self._extra_json.clear()
        self._extra_json.blockSignals(False)
        for r in self._rows:
            for cb in r.findChildren(QComboBox):
                cb.hidePopup()
            self._rows_layout.removeWidget(r)
            r.deleteLater()
        self._rows.clear()
        # 禁止主动 processEvents / sendPostedEvents：
        # 会显式化 QComboBoxPrivateContainer 的生命周期，增加顶层弹窗闪烁风险。

    def _add_row(self, data: dict | None = None) -> None:
        # parent=self 避免 QWidget 构造时成为无 parent 的 top-level。
        row = ConditionRow(data, self._ctx_model, self._ctx_scene_id, parent=self)
        row.removed.connect(self._remove_row)
        row.changed.connect(self.changed)
        self._rows.append(row)
        self._rows_layout.addWidget(row)

    def _add_empty(self) -> None:
        self._add_row({"flag": "", "value": True})
        self.changed.emit()

    def _remove_row(self, row: ConditionRow) -> None:
        if row in self._rows:
            for cb in row.findChildren(QComboBox):
                cb.hidePopup()
            self._rows.remove(row)
            self._rows_layout.removeWidget(row)
            row.deleteLater()
            self.changed.emit()
