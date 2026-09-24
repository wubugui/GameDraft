"""`setBreathingParams.params` 的专用编辑器：一行一个参数（参数名 → 数值），可增删。

参数名、中文名、分组、量程、步长、单位、说明全部**现读** ``src/data/breathingParams.json``
（运行时 / 呼吸工作台 / 本表单共用的唯一真相源，见 :mod:`.breathing_params`），这里不抄第二份。

往返保真（编辑器规范不变量 1 / 6）：

* 行序 = 磁盘键序；新加的行排在末尾。
* 数值没动过（键没换、控件值仍等于载入时的种子）⇒ **按磁盘原值回吐**（int 不漂 float、
  多出控件小数位的精度不被截掉）——数值往返保真卡「种子快照法」。
* 盘上越界的值**不夹**：控件量程临时放宽到能装下它，标黄提示，校验器报 warning（运行时会夹）。
* 表里不认识的键、不是数的值：整行只读保值展示、原样写回，可以删、也可以换成一个认识的参数；
  ``params`` 整个不是对象（坏数据）时也原样保留，给一个「清空，改成参数表」的显式出口。
"""
from __future__ import annotations

import json
import math
from copy import deepcopy
from pathlib import Path
from typing import Callable

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QDoubleSpinBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMenu,
    QPushButton,
    QSizePolicy,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from .. import theme as _theme
from .breathing_params import (
    BreathingParamDef,
    BreathingParamGroup,
    load_breathing_param_groups,
    step_decimals,
)
from .widget_discard import discard_widget

#: 磁盘上根本没有 ``params`` 键 / 这一行是新加的（与「值为 null」区分）
ABSENT = object()


def _is_num(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))


def _value_decimals(v: float) -> int:
    """一个数在十进制下要几位小数才显示得全（上限 6；科学计数一律给 6）。"""
    s = repr(float(v))
    if "e" in s or "E" in s:
        return 6
    frac = s.split(".")[1] if "." in s else ""
    frac = frac.rstrip("0")
    return min(6, len(frac))


def _fmt(v: float) -> str:
    return f"{v:g}"


class _ParamRow(QWidget):
    """一行：参数名按钮（点开是按分组列的参数菜单）+ 数值格（或只读原值）+ 删除。"""

    changed = Signal()

    def __init__(self, owner: "BreathingParamsField", key: str, raw_value: object) -> None:
        super().__init__(owner)
        self._owner = owner
        self.key = key
        self._orig_key = key
        self._orig_value = raw_value          # ABSENT = 新加的行
        self._raw_value = raw_value           # 只读档展示 / 回吐的值
        self._numeric = False
        self._seed: float | None = None

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        self.key_btn = QToolButton(self)
        self.key_btn.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self.key_btn.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)
        self.key_btn.setMaximumWidth(280)
        menu = QMenu(self.key_btn)
        menu.setToolTipsVisible(True)
        menu.aboutToShow.connect(lambda m=menu: owner.fill_key_menu(m, current=self.key, on_pick=self.set_key))
        self.key_btn.setMenu(menu)
        lay.addWidget(self.key_btn, 1)

        self.spin = QDoubleSpinBox(self)
        self.spin.setMaximumWidth(140)
        self.spin.setKeyboardTracking(False)
        lay.addWidget(self.spin)
        self.raw_edit = QLineEdit(self)
        self.raw_edit.setReadOnly(True)
        self.raw_edit.setMaximumWidth(220)
        lay.addWidget(self.raw_edit)

        self.remove_btn = QPushButton("−", self)
        self.remove_btn.setFixedWidth(28)
        self.remove_btn.setToolTip("删掉这一行（这条动作就不改这个参数了）")
        self.remove_btn.clicked.connect(lambda: owner.remove_row(self))
        lay.addWidget(self.remove_btn)

        d = owner.param_def(key)
        if d is not None and (raw_value is ABSENT or _is_num(raw_value)):
            self._enter_numeric(d, float(raw_value) if raw_value is not ABSENT else d.default)
        else:
            self._enter_raw()
        self.spin.valueChanged.connect(self._on_spin_changed)

    # ------------------------------------------------------------------ 显示档

    def is_numeric(self) -> bool:
        return self._numeric

    def _enter_numeric(self, d: BreathingParamDef, value: float) -> None:
        self._numeric = True
        self.spin.blockSignals(True)
        try:
            # 盘上越界的值不夹：量程临时放宽到能装下它（夹了就是静默改数据，校验器那条 warning 也跟着消失）
            self.spin.setDecimals(max(step_decimals(d.step), _value_decimals(value)))
            self.spin.setRange(min(d.min, value), max(d.max, value))
            self.spin.setSingleStep(d.step)
            self.spin.setSuffix(f" {d.unit}" if d.unit else "")
            self.spin.setValue(value)
        finally:
            self.spin.blockSignals(False)
        self._seed = self.spin.value()
        self.spin.show()
        self.raw_edit.hide()
        self.key_btn.setText(d.label)
        self.key_btn.setToolTip(
            f"{d.group_title} · {d.label}（{d.key}）" + (f"\n{d.hint}" if d.hint else "")
            + "\n点开换成别的参数（按分组列出，已在表里的不能重复选）。"
        )
        self._refresh_range_hint()

    def _enter_raw(self) -> None:
        self._numeric = False
        self._seed = None
        self.spin.hide()
        self.raw_edit.show()
        known = self._owner.param_def(self.key) is not None
        try:
            shown = json.dumps(self._raw_value, ensure_ascii=False)
        except (TypeError, ValueError):
            shown = repr(self._raw_value)
        self.raw_edit.setText(shown)
        self.raw_edit.setCursorPosition(0)
        if known:
            d = self._owner.param_def(self.key)
            self.key_btn.setText(f"{d.label}（值不是数）")
            why = "值不是数（运行时丢掉这一项、控制台警告一行；校验器报错）。"
        else:
            self.key_btn.setText(f"未知参数 {self.key}")
            why = "参数表 src/data/breathingParams.json 里没有这个键（运行时丢掉这一项；校验器报错）。"
        tip = (f"{self.key}：{why}\n原值已保留、原样写回，不会被改写。\n"
               "可以删掉这一行，或点参数名换成一个认识的参数。")
        self.key_btn.setToolTip(tip)
        self.raw_edit.setToolTip(tip)
        self.raw_edit.setStyleSheet(_theme.semantic_text_css("warn"))

    def _refresh_range_hint(self) -> None:
        d = self._owner.param_def(self.key)
        if d is None or not self._numeric:
            return
        v = self.spin.value()
        base = (f"{d.label}（{d.key}）：{d.hint}\n" if d.hint else f"{d.label}（{d.key}）\n")
        base += f"范围 {_fmt(d.min)}–{_fmt(d.max)}{d.unit}，步长 {_fmt(d.step)}，参数表缺省 {_fmt(d.default)}{d.unit}"
        if v < d.min or v > d.max:
            self.spin.setStyleSheet(_theme.semantic_text_css("warn"))
            self.spin.setToolTip(base + f"\n⚠ 当前值超出范围：运行时会夹到 {_fmt(d.min)}–{_fmt(d.max)}（校验器报 warning）。")
        else:
            self.spin.setStyleSheet("")
            self.spin.setToolTip(base)

    # ------------------------------------------------------------------ 用户动作

    def _on_spin_changed(self, _v: float) -> None:
        self._refresh_range_hint()
        self.changed.emit()

    def set_key(self, new_key: str) -> None:
        """换成另一个参数（菜单里点的那一下）。当前是个数就保留这个数，否则取参数表缺省。"""
        d = self._owner.param_def(new_key)
        if d is None or new_key == self.key:
            return
        if self._numeric:
            keep: float | None = self.spin.value()
        else:
            keep = float(self._raw_value) if _is_num(self._raw_value) else None
        self.key = new_key
        self._enter_numeric(d, keep if keep is not None else d.default)
        self.changed.emit()

    # ------------------------------------------------------------------ 取值

    def key_value(self) -> tuple[str, object]:
        if not self._numeric:
            return self.key, deepcopy(self._raw_value)
        cur = self.spin.value()
        if (
            self.key == self._orig_key
            and self._orig_value is not ABSENT
            and _is_num(self._orig_value)
            and self._seed is not None
            and cur == self._seed
        ):
            return self.key, self._orig_value  # 没动过：磁盘原表示（1 不漂 1.0、精度不截）
        v = round(cur, self.spin.decimals())
        return self.key, int(v) if float(v).is_integer() else v


class BreathingParamsField(QWidget):
    """`params` 整个对象的编辑器。``value()`` 返回要写进 JSON 的值。"""

    changed = Signal()

    def __init__(
        self,
        raw: object = ABSENT,
        parent: QWidget | None = None,
        *,
        project_root: Path | None = None,
    ) -> None:
        super().__init__(parent)
        self._groups: list[BreathingParamGroup] = load_breathing_param_groups(project_root)
        self._defs: dict[str, BreathingParamDef] = {p.key: p for g in self._groups for p in g.params}
        self._rows: list[_ParamRow] = []
        # 盘上 params 不是对象（坏数据）：原样保留，直到用户显式「改成参数表」
        self._raw_nondict: object = ABSENT
        if raw is not ABSENT and not isinstance(raw, dict):
            self._raw_nondict = deepcopy(raw)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)

        self._bad_box = QWidget(self)
        bl = QHBoxLayout(self._bad_box)
        bl.setContentsMargins(0, 0, 0, 0)
        try:
            shown = json.dumps(self._raw_nondict, ensure_ascii=False) if self._raw_nondict is not ABSENT else ""
        except (TypeError, ValueError):
            shown = repr(self._raw_nondict)
        self._bad_label = QLabel(
            f"⚠ params 不是「参数名 → 数值」的对象：{shown}\n运行时整条动作跳过；原值已保留、原样写回。",
            self._bad_box,
        )
        self._bad_label.setWordWrap(True)
        self._bad_label.setStyleSheet(_theme.semantic_text_css("warn"))
        bl.addWidget(self._bad_label, 1)
        self._to_table_btn = QPushButton("清空，改成参数表", self._bad_box)
        self._to_table_btn.clicked.connect(self._switch_to_table)
        bl.addWidget(self._to_table_btn)
        lay.addWidget(self._bad_box)

        self._rows_box = QVBoxLayout()
        self._rows_box.setSpacing(2)
        lay.addLayout(self._rows_box)

        bar = QHBoxLayout()
        bar.setContentsMargins(0, 0, 0, 0)
        self.add_btn = QToolButton(self)
        self.add_btn.setText("+ 参数…")
        self.add_btn.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self.add_btn.setToolTip("按分组选一个要改的参数（名字与呼吸工作台一致）；已在表里的不能重复加。")
        add_menu = QMenu(self.add_btn)
        add_menu.setToolTipsVisible(True)
        add_menu.aboutToShow.connect(lambda m=add_menu: self.fill_key_menu(m, current=None, on_pick=self.add_param))
        self.add_btn.setMenu(add_menu)
        bar.addWidget(self.add_btn)
        self._empty_hint = QLabel("（一个参数都没列 = 这条动作什么都不改）", self)
        self._empty_hint.setStyleSheet(_theme.semantic_text_css("faint"))
        bar.addWidget(self._empty_hint)
        bar.addStretch(1)
        lay.addLayout(bar)

        if isinstance(raw, dict):
            for k, v in raw.items():
                self._append_row(str(k), v)
        if not self._groups:
            self.add_btn.setEnabled(False)
            self.add_btn.setToolTip("读不到参数表 src/data/breathingParams.json：只能保值展示已有的行。")
        self._sync_mode_widgets()

    # ------------------------------------------------------------------ 参数表

    def param_def(self, key: str) -> BreathingParamDef | None:
        return self._defs.get(key)

    def groups(self) -> list[BreathingParamGroup]:
        return list(self._groups)

    def rows(self) -> list[_ParamRow]:
        return list(self._rows)

    def fill_key_menu(self, menu: QMenu, *, current: str | None, on_pick: Callable[[str], None]) -> None:
        """把参数菜单按分组填好（每次弹出前现填：哪些键已被别的行占用会变）。"""
        menu.clear()
        used = {r.key for r in self._rows} - ({current} if current else set())
        for g in self._groups:
            if not g.params:
                continue
            head = menu.addAction(g.title + (f"（{g.note}）" if g.note else ""))
            head.setEnabled(False)
            f = head.font()
            f.setBold(True)
            head.setFont(f)
            for p in g.params:
                text = "　" + p.label + (f"（{p.unit}）" if p.unit else "")
                act = menu.addAction(text)
                act.setData(p.key)
                act.setToolTip(
                    (f"{p.hint}\n" if p.hint else "")
                    + f"键 {p.key} · 范围 {_fmt(p.min)}–{_fmt(p.max)}{p.unit} · 参数表缺省 {_fmt(p.default)}{p.unit}"
                )
                if p.key == current:
                    act.setCheckable(True)
                    act.setChecked(True)
                elif p.key in used:
                    act.setEnabled(False)
                    act.setText(text + "　· 已在表里")
                act.triggered.connect(lambda _c=False, k=p.key: on_pick(k))

    # ------------------------------------------------------------------ 增删

    def _append_row(self, key: str, raw_value: object) -> _ParamRow:
        row = _ParamRow(self, key, raw_value)
        row.changed.connect(self.changed)
        self._rows.append(row)
        self._rows_box.addWidget(row)
        row.show()   # 动态加行要显式 show，否则同一回合的行高按零行算（编辑器规范·布局纪律）
        return row

    def add_param(self, key: str) -> None:
        if self._raw_nondict is not ABSENT or key not in self._defs or any(r.key == key for r in self._rows):
            return
        self._append_row(key, ABSENT)
        self._sync_mode_widgets()
        self._relayout()
        self.changed.emit()

    def remove_row(self, row: _ParamRow) -> None:
        if row not in self._rows:
            return
        self._rows.remove(row)
        self._rows_box.removeWidget(row)
        discard_widget(row)
        self._sync_mode_widgets()
        self._relayout()
        self.changed.emit()

    def _switch_to_table(self) -> None:
        if self._raw_nondict is ABSENT:
            return
        self._raw_nondict = ABSENT
        self._sync_mode_widgets()
        self._relayout()
        self.changed.emit()

    def _sync_mode_widgets(self) -> None:
        bad = self._raw_nondict is not ABSENT
        self._bad_box.setVisible(bad)
        self.add_btn.setVisible(not bad)
        self._empty_hint.setVisible(not bad and not self._rows)

    def _relayout(self) -> None:
        """增删行后自内向外逐层刷新几何（中间层不 invalidate，外层行高会冻在旧 sizeHint）。"""
        self._rows_box.invalidate()
        w: QWidget | None = self
        while w is not None:
            lay = w.layout()
            if lay is not None:
                lay.invalidate()
            w.updateGeometry()
            if w.isWindow():
                break
            w = w.parentWidget()

    # ------------------------------------------------------------------ 取值

    def value(self) -> object:
        """要写进 JSON 的 ``params``：坏数据原样；否则按行序拼成对象。"""
        if self._raw_nondict is not ABSENT:
            return deepcopy(self._raw_nondict)
        out: dict = {}
        for r in self._rows:
            k, v = r.key_value()
            if k not in out:
                out[k] = v
        return out
