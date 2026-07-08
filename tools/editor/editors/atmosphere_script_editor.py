"""糖画转盘『旋转氛围脚本』指令编辑器：RPGMaker-event 式可嵌套指令列表。

每条指令一行（op + 参数；引用类字段一律下拉选择器，不手打）；`chance` /
`when_near_sector` 这类分支指令在其下方缩进挂 `then` / `else` 子列表（同款控件递归）。
产出的 step 结构与运行时 ``sugarWheelAtmosphere`` 完全一致：
``{op, role?, pool?|text?, durationMs?, slot?, sec?, p?, sectorId?, degBuffer?, then?, else?, ...}``，
故数据格式不变、运行不受影响。表格之外的未知字段按身份保留（前向兼容）。
"""
from __future__ import annotations

from typing import Any, Callable

from PySide6.QtCore import Qt, Signal
from ..shared import confirm
from PySide6.QtWidgets import (
    QAbstractSpinBox,
    QComboBox,
    QDoubleSpinBox,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

_OPS = ["say", "pick", "wait", "chance", "when_near_sector"]
_OP_LABELS = {
    "say": "say · 说话",
    "pick": "pick · 抽句入槽",
    "wait": "wait · 等待",
    "chance": "chance · 概率分支",
    "when_near_sector": "when_near · 邻近扇区分支",
}
_BRANCH_OPS = {"chance", "when_near_sector"}
# 行内控件直接承载的字段；其余（then/else 由子编辑器管）+ 未知字段按身份保留。
_MANAGED_KEYS = frozenset({
    "op", "role", "text", "pool", "durationMs", "slot",
    "sec", "p", "sectorId", "degBuffer", "then", "else",
})

RolesGetter = Callable[[], list[tuple[str, str]]]
NamesGetter = Callable[[], list[str]]


def _num_out(v: float) -> Any:
    """整数值写成 int（degBuffer 20 不写成 20.0），其余保留 float。"""
    f = float(v)
    return int(f) if f == int(f) else f


def _dspin(lo: float, hi: float, val: float, decimals: int) -> QDoubleSpinBox:
    w = QDoubleSpinBox()
    w.setRange(lo, hi)
    w.setDecimals(decimals)
    w.setValue(val)
    w.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)
    w.setMaximumWidth(90)
    return w


class _AtmosStepRow(QFrame):
    """一条指令：op 下拉 + 参数（引用类用选择器）+ 行控制；分支 op 下挂 then/else 子编辑器。"""

    changed = Signal()
    move_up = Signal(object)
    move_down = Signal(object)
    insert_after = Signal(object)
    delete_me = Signal(object)

    def __init__(
        self,
        step: dict,
        *,
        roles_getter: RolesGetter | None,
        sectors_getter: NamesGetter | None,
        pools_getter: NamesGetter | None,
        depth: int,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._roles_getter = roles_getter
        self._sectors_getter = sectors_getter
        self._pools_getter = pools_getter
        self._depth = depth
        self._orig = dict(step) if isinstance(step, dict) else {}
        self._loading = True
        self._then_ed: AtmosphereScriptEditor | None = None
        self._else_ed: AtmosphereScriptEditor | None = None
        # 当前 op 的参数控件（每次 rebuild 重建）
        self._role: QComboBox | None = None
        self._pooltext: QComboBox | None = None
        self._dur: QDoubleSpinBox | None = None
        self._slot: QLineEdit | None = None
        self._sec: QDoubleSpinBox | None = None
        self._p: QDoubleSpinBox | None = None
        self._sector: QComboBox | None = None
        self._deg: QDoubleSpinBox | None = None

        self.setFrameShape(QFrame.Shape.StyledPanel)
        root = QVBoxLayout(self)
        root.setContentsMargins(4, 2, 4, 2)
        root.setSpacing(2)

        head = QHBoxLayout()
        head.setSpacing(4)
        self._op = QComboBox()
        for op in _OPS:
            self._op.addItem(_OP_LABELS[op], op)
        cur_op = str(self._orig.get("op") or "say")
        oi = self._op.findData(cur_op)
        if oi < 0:
            self._op.addItem(f"(未知) {cur_op}", cur_op)
            oi = self._op.count() - 1
        self._op.setCurrentIndex(oi)
        self._op.setMaximumWidth(170)
        self._op.currentIndexChanged.connect(self._on_op_changed)
        head.addWidget(self._op)

        self._params = QWidget()
        self._params_lay = QHBoxLayout(self._params)
        self._params_lay.setContentsMargins(0, 0, 0, 0)
        self._params_lay.setSpacing(4)
        head.addWidget(self._params, 1)

        for txt, tip, sig in (
            ("↑", "上移", self.move_up),
            ("↓", "下移", self.move_down),
            ("＋", "在下方插入一条", self.insert_after),
            ("✕", "删除本条", self.delete_me),
        ):
            b = QPushButton(txt)
            b.setMaximumWidth(26)
            b.setToolTip(tip)
            b.clicked.connect(lambda _c=False, s=sig: s.emit(self))
            head.addWidget(b)
        root.addLayout(head)

        self._branch = QWidget()
        self._branch_lay = QVBoxLayout(self._branch)
        self._branch_lay.setContentsMargins(20, 0, 0, 0)
        self._branch_lay.setSpacing(2)
        root.addWidget(self._branch)

        self._rebuild_params(cur_op)
        self._last_op = cur_op
        # 行级基线：to_step 时序列化结果与"载入后立即序列化"相同（=未实际编辑）
        # → 逐字返回原 dict（未知字段不挪键序、缺省键不注入、数值不规整）。
        self._initial_step = self._serialize_for_op(cur_op)
        self._loading = False

    # ── helpers ──
    def _current_op(self) -> str:
        d = self._op.currentData()
        return str(d) if d is not None else "say"

    def _emit_changed(self) -> None:
        if not self._loading:
            self.changed.emit()

    def _on_op_changed(self, _i: int) -> None:
        new_op = self._current_op()
        old_op = getattr(self, "_last_op", str(self._orig.get("op") or "say"))
        if not self._loading and new_op != old_op:
            # 切走前序列化当前参数回 _orig：切回旧 op 时本会话编辑还在（审查 P3-6）
            self._orig = self._serialize_for_op(old_op)
        self._last_op = new_op
        self._loading = True
        try:
            self._rebuild_params(new_op)
            self._initial_step = self._serialize_for_op(new_op)
        finally:
            self._loading = False
        self._emit_changed()

    def _clear_layout(self, lay) -> None:  # noqa: ANN001
        while lay.count():
            it = lay.takeAt(0)
            w = it.widget()
            if w is not None:
                w.setParent(None)
                w.deleteLater()

    def _make_role_combo(self, current: str) -> QComboBox:
        cb = QComboBox()
        rows = self._roles_getter() if self._roles_getter else [("（选角色）", "")]
        for disp, rid in rows:
            cb.addItem(disp, rid)
        cur = (current or "").strip()
        i = cb.findData(cur)
        if i < 0:
            if cur:
                cb.addItem(f"(数据中) {cur}", cur)
                i = cb.count() - 1
            else:
                i = 0
        cb.setCurrentIndex(i)
        cb.setMaximumWidth(150)
        return cb

    def _make_sector_combo(self, current: str) -> QComboBox:
        cb = QComboBox()
        cb.addItem("", None)
        for sid in (self._sectors_getter() if self._sectors_getter else []):
            cb.addItem(sid, sid)
        cur = (current or "").strip()
        if cur:
            i = cb.findData(cur)
            if i < 0:
                cb.addItem(f"(数据中) {cur}", cur)
                i = cb.count() - 1
            cb.setCurrentIndex(i)
        cb.setMaximumWidth(150)
        return cb

    def _make_pooltext_combo(self, pool: str, text: str) -> QComboBox:
        """「〔池〕xxx」=引用文案池随机抽；自由输入=固定台词。读回靠文本是否等于某〔池〕项判定。"""
        cb = QComboBox()
        cb.setEditable(True)
        cb.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        cb.addItem("", None)
        for pn in (self._pools_getter() if self._pools_getter else []):
            cb.addItem(f"〔池〕{pn}", pn)
        pool = (pool or "").strip()
        if text:
            # 运行时 text 优先于 pool：并存时显示 text（pool 经 orig 透传保留）
            cb.setCurrentText(text)
        elif pool:
            i = cb.findData(pool)
            if i < 0:
                cb.addItem(f"〔池〕{pool}", pool)
                i = cb.count() - 1
            cb.setCurrentIndex(i)
        else:
            cb.setCurrentIndex(0)
        return cb

    def _pooltext_value(self) -> tuple[str, str]:
        cb = self._pooltext
        if cb is None:
            return ("", "")
        cur = cb.currentText().strip()
        for ii in range(cb.count()):
            data = cb.itemData(ii)
            if data and cb.itemText(ii) == cur:
                return (str(data), "")
        return ("", cur)

    def _make_sub_editor(self, title: str, data: Any) -> "AtmosphereScriptEditor":
        ed = AtmosphereScriptEditor(
            title=title,
            roles_getter=self._roles_getter,
            sectors_getter=self._sectors_getter,
            pools_getter=self._pools_getter,
            depth=self._depth + 1,
        )
        ed.set_data(data if isinstance(data, list) else [])
        ed.changed.connect(self._emit_changed)
        return ed

    def _rebuild_params(self, op: str) -> None:
        self._clear_layout(self._params_lay)
        self._clear_layout(self._branch_lay)
        self._then_ed = None
        self._else_ed = None
        self._role = self._pooltext = self._slot = None
        self._dur = self._sec = self._p = self._sector = self._deg = None
        d = self._orig

        if op == "say":
            self._role = self._make_role_combo(str(d.get("role") or ""))
            self._pooltext = self._make_pooltext_combo(str(d.get("pool") or ""), str(d.get("text") or ""))
            self._pooltext.setToolTip("选「〔池〕xxx」=从该池随机抽一句；直接打字=说这句固定台词")
            self._dur = _dspin(0, 120000, float(d.get("durationMs") or 0), 0)
            self._dur.setToolTip("气泡停留毫秒；0 = 用实例默认 speechDurationMs")
            self._slot = QLineEdit(str(d.get("slot") or ""))
            self._slot.setPlaceholderText("slot")
            self._slot.setToolTip("槽位名（选填）：无台词/池时说 pick 抽进该槽的句子（缺省 _line）")
            self._slot.setMaximumWidth(90)
            self._params_lay.addWidget(QLabel("角色"))
            self._params_lay.addWidget(self._role)
            self._params_lay.addWidget(self._pooltext, 1)
            self._params_lay.addWidget(self._slot)
            self._params_lay.addWidget(QLabel("ms"))
            self._params_lay.addWidget(self._dur)
            self._role.currentTextChanged.connect(self._emit_changed)
            self._pooltext.currentTextChanged.connect(self._emit_changed)
            self._slot.textChanged.connect(self._emit_changed)
            self._dur.valueChanged.connect(self._emit_changed)
        elif op == "pick":
            self._pooltext = self._make_pooltext_combo(str(d.get("pool") or ""), "")
            self._pooltext.setToolTip("从该文案池随机抽一句存入槽位，供后续 say 引用")
            self._slot = QLineEdit(str(d.get("slot") or ""))
            self._slot.setPlaceholderText("槽位名（默认 _line）")
            self._slot.setMaximumWidth(160)
            self._params_lay.addWidget(QLabel("池"))
            self._params_lay.addWidget(self._pooltext, 1)
            self._params_lay.addWidget(QLabel("slot"))
            self._params_lay.addWidget(self._slot)
            self._pooltext.currentTextChanged.connect(self._emit_changed)
            self._slot.textChanged.connect(self._emit_changed)
        elif op == "wait":
            self._sec = _dspin(0, 600, float(d.get("sec") or 0), 2)
            self._params_lay.addWidget(QLabel("秒"))
            self._params_lay.addWidget(self._sec)
            self._params_lay.addStretch(1)
            self._sec.valueChanged.connect(self._emit_changed)
        elif op == "chance":
            self._p = _dspin(0, 1, float(d.get("p") if d.get("p") is not None else 0.0), 2)
            self._p.setToolTip("命中概率 0–1，命中走 then，否则走 else；缺省/0 = 从不命中（与运行时一致）")
            self._params_lay.addWidget(QLabel("概率 p"))
            self._params_lay.addWidget(self._p)
            self._params_lay.addStretch(1)
            self._p.valueChanged.connect(self._emit_changed)
            self._build_branches(d)
        elif op == "when_near_sector":
            self._sector = self._make_sector_combo(str(d.get("sectorId") or ""))
            self._deg = _dspin(0, 180, float(d.get("degBuffer") if d.get("degBuffer") is not None else 15), 1)
            self._deg.setToolTip("指针在该扇区中心 ± 此度数内算命中")
            self._params_lay.addWidget(QLabel("扇区"))
            self._params_lay.addWidget(self._sector)
            self._params_lay.addWidget(QLabel("±度"))
            self._params_lay.addWidget(self._deg)
            self._params_lay.addStretch(1)
            self._sector.currentTextChanged.connect(self._emit_changed)
            self._deg.valueChanged.connect(self._emit_changed)
            self._build_branches(d)
        else:
            note = QLabel(f"未知指令「{op}」——原样保留，不在此编辑")
            note.setStyleSheet("color:#c97;")
            self._params_lay.addWidget(note)
            self._params_lay.addStretch(1)

    def _build_branches(self, d: dict) -> None:
        self._then_ed = self._make_sub_editor("then ↳ 命中后顺序执行", d.get("then"))
        self._branch_lay.addWidget(self._then_ed)
        self._else_holder = QWidget()
        self._else_holder_lay = QVBoxLayout(self._else_holder)
        self._else_holder_lay.setContentsMargins(0, 0, 0, 0)
        self._else_holder_lay.setSpacing(2)
        self._branch_lay.addWidget(self._else_holder)
        has_else = isinstance(d.get("else"), list) and len(d.get("else")) > 0
        self._set_else(has_else, d.get("else") if has_else else None)

    def _set_else(self, on: bool, data: Any) -> None:
        self._clear_layout(self._else_holder_lay)
        if on:
            self._else_ed = self._make_sub_editor("else ↳ 不命中时执行（留空=无）", data or [])
            self._else_holder_lay.addWidget(self._else_ed)
        else:
            self._else_ed = None
            add = QPushButton("+ else 分支")
            add.setMaximumWidth(110)
            add.setToolTip("添加「不命中」分支")
            add.clicked.connect(lambda _c=False: (self._set_else(True, []), self._emit_changed()))
            self._else_holder_lay.addWidget(add, 0, Qt.AlignmentFlag.AlignLeft)

    # ── serialize ──
    def _keep_or_num(self, key: str, v: float) -> Any:
        """未改动数值按原始表示回写（float 1.0 不被规整成 1）。"""
        ov = self._orig.get(key)
        if (
            isinstance(ov, (int, float))
            and not isinstance(ov, bool)
            and float(ov) == float(v)
        ):
            return ov
        return _num_out(v)

    def to_step(self) -> dict:
        op = self._current_op()
        cur = self._serialize_for_op(op)
        # 行级 verbatim：序列化结果与载入基线一致（未实际编辑）→ 逐字返回原 dict，
        # 未知字段不挪键序、缺省键不注入（审查 P3-6）。
        if (
            self._orig
            and cur == getattr(self, "_initial_step", None)
            and str(self._orig.get("op") or "say") == op
        ):
            return dict(self._orig)
        return cur

    def _serialize_for_op(self, op: str) -> dict:
        step: dict[str, Any] = {"op": op}
        op_unchanged = str(self._orig.get("op") or "say") == op
        if op not in _OPS:
            # 未知 op：整行透传（含 then/else/text 等 managed 键——UI 本就不可编辑它）
            out = dict(self._orig)
            out["op"] = op
            return out
        if op == "say":
            role = self._role.currentData() if self._role else None
            if role:
                step["role"] = str(role)
            pool, text = self._pooltext_value()
            if pool:
                step["pool"] = pool
            elif text:
                step["text"] = text
                if op_unchanged and "pool" in self._orig:
                    step["pool"] = self._orig["pool"]  # 运行时 text 优先，pool 保真透传
            slot = self._slot.text().strip() if self._slot else ""
            if slot:
                step["slot"] = slot
            dur = int(round(self._dur.value())) if self._dur else 0
            if dur > 0:
                step["durationMs"] = dur
        elif op == "pick":
            pool, text = self._pooltext_value()
            name = pool or text
            if name:
                step["pool"] = name
            slot = self._slot.text().strip() if self._slot else ""
            if slot:
                step["slot"] = slot
        elif op == "wait":
            v = float(self._sec.value()) if self._sec else 0.0
            if (op_unchanged and "sec" in self._orig) or v != 0:
                step["sec"] = self._keep_or_num("sec", v)
        elif op == "chance":
            v = float(self._p.value()) if self._p else 0.0
            # 缺省不注入：p 缺省=0（从不命中）与运行时一致（审查 P3-6 行为差）
            if (op_unchanged and "p" in self._orig) or v != 0:
                step["p"] = self._keep_or_num("p", v)
            self._write_branches(step)
        elif op == "when_near_sector":
            sid = self._sector.currentData() if self._sector else None
            if sid:
                step["sectorId"] = str(sid)
            v = float(self._deg.value()) if self._deg else 0.0
            if (op_unchanged and "degBuffer" in self._orig) or v != 15:
                step["degBuffer"] = self._keep_or_num("degBuffer", v)
            self._write_branches(step)
        # 保留表格外的未知字段（仅当 op 未变）：前向兼容，绝不静默丢
        if op_unchanged:
            for k, v in self._orig.items():
                if k not in _MANAGED_KEYS and k not in step:
                    step[k] = v
        return step

    def _write_branches(self, step: dict) -> None:
        th = self._then_ed.to_list() if self._then_ed else []
        if th:
            step["then"] = th
        el = self._else_ed.to_list() if self._else_ed else []
        if el:
            step["else"] = el


class AtmosphereScriptEditor(QWidget):
    """一段氛围脚本（某阶段或某分支）的指令列表。可递归嵌套。"""

    changed = Signal()

    def __init__(
        self,
        *,
        title: str = "",
        roles_getter: RolesGetter | None = None,
        sectors_getter: NamesGetter | None = None,
        pools_getter: NamesGetter | None = None,
        depth: int = 0,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._roles_getter = roles_getter
        self._sectors_getter = sectors_getter
        self._pools_getter = pools_getter
        self._depth = depth
        self._rows: list[_AtmosStepRow] = []
        self._loading = False

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(3)
        if title:
            lab = QLabel(title)
            lab.setStyleSheet("color:#8aa; font-size:11px;")
            root.addWidget(lab)
        self._rows_lay = QVBoxLayout()
        self._rows_lay.setSpacing(3)
        root.addLayout(self._rows_lay)
        self._empty = QLabel("（空——点下方 + 指令 添加）")
        self._empty.setStyleSheet("color:#777; font-size:11px;")
        root.addWidget(self._empty)
        self._btn_add = QPushButton("+ 指令")
        self._btn_add.setMaximumWidth(90)
        self._btn_add.clicked.connect(lambda: self._add_step())
        root.addWidget(self._btn_add, 0, Qt.AlignmentFlag.AlignLeft)

    # ── public API（与 ActionEditor 一致的契约）──
    def set_data(self, steps: Any) -> None:
        self._loading = True
        try:
            self._clear()
            for s in (steps if isinstance(steps, list) else []):
                self._append_row(s if isinstance(s, dict) else {})
        finally:
            self._loading = False
        self._update_empty()

    def to_list(self) -> list[dict]:
        return [r.to_step() for r in self._rows]

    def refresh_choices(self) -> None:
        """文案池 / 角色 / 扇区候选变化后，按当前数据重建（刷新所有下拉），不丢内容。"""
        self.set_data(self.to_list())

    # ── internals ──
    def _clear(self) -> None:
        for r in self._rows:
            self._rows_lay.removeWidget(r)
            r.setParent(None)
            r.deleteLater()
        self._rows.clear()

    def _append_row(self, step: dict, at: int | None = None) -> _AtmosStepRow:
        row = _AtmosStepRow(
            step,
            roles_getter=self._roles_getter,
            sectors_getter=self._sectors_getter,
            pools_getter=self._pools_getter,
            depth=self._depth,
        )
        row.changed.connect(self._on_changed)
        row.move_up.connect(lambda r: self._move(r, -1))
        row.move_down.connect(lambda r: self._move(r, 1))
        row.insert_after.connect(self._insert_after)
        row.delete_me.connect(self._delete_row)
        if at is None or at >= len(self._rows):
            self._rows.append(row)
        else:
            self._rows.insert(at, row)
        self._relayout()
        return row

    def _relayout(self) -> None:
        for r in self._rows:
            self._rows_lay.removeWidget(r)
        for r in self._rows:
            self._rows_lay.addWidget(r)

    def _add_step(self, at: int | None = None) -> None:
        if self._loading:
            return
        self._append_row({"op": "say"}, at)
        self._update_empty()
        self._on_changed()

    def _insert_after(self, row: _AtmosStepRow) -> None:
        try:
            i = self._rows.index(row)
        except ValueError:
            return
        self._add_step(at=i + 1)

    def _delete_row(self, row: _AtmosStepRow) -> None:
        if row not in self._rows:
            return
        # 分支指令携带整棵 then/else 子树：删除前确认（普通行直删，轻操作不打断）
        if row._current_op() in _BRANCH_OPS:
            has_children = bool(
                (row._then_ed and row._then_ed.to_list())
                or (row._else_ed and row._else_ed.to_list())
            )
            if has_children and not confirm.confirm_delete(
                self, "该分支指令及其整棵 then/else 子树",
            ):
                return
        try:
            self._rows.remove(row)
        except ValueError:
            return
        self._rows_lay.removeWidget(row)
        row.setParent(None)
        row.deleteLater()
        self._update_empty()
        self._on_changed()

    def _move(self, row: _AtmosStepRow, direction: int) -> None:
        try:
            i = self._rows.index(row)
        except ValueError:
            return
        j = i + direction
        if j < 0 or j >= len(self._rows):
            return
        self._rows[i], self._rows[j] = self._rows[j], self._rows[i]
        self._relayout()
        self._on_changed()

    def _on_changed(self) -> None:
        if not self._loading:
            self.changed.emit()

    def _update_empty(self) -> None:
        self._empty.setVisible(not self._rows)
