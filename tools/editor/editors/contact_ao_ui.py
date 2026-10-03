"""脚底接触 AO（胶囊 AO）的编辑控件（NPC 表单 / 场景的玩家那一块共用一个）。

作者面（制作人 2026-09-24 定）：勾「接触 AO」就有；**「方向 AO」缺省也勾着**（所有 NPC 与主角默认都开，
同日改口）；取消方向 AO 就只剩简单 AO；明暗、大小和方向 AO 的参数都能调。

- 明暗 / 大小有一档「场景值」（数值框拉到最小就是它）：不写字段，跟随场景光环境的
  `shadow.contact` / `contactSize`（光照曲线里还能按位置变）。框里直接显示此刻跟到的是多少。
- 其余参数框里显示的就是缺省值；**等于缺省就不写字段**，JSON 保持干净。
- 场景方向为自动 / 手动；角色方向为继承场景 / 自动 / 手动，未设置的角色继承场景。
  旧 dirSource 原样保值，明确切换新档才替换。

往返保真：载入时记住原值，没动过的数按原值写回（显示精度不会把 0.333 改成 0.33）；
`contactAo` 里不认识的键原样保留。
"""
from __future__ import annotations

import copy
import math
from typing import Callable

from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDoubleSpinBox, QGridLayout, QLabel, QWidget,
)

from ..shared import contact_ao as cao
from ..shared.form_layout import fit_width_cap

#: 明暗 / 大小数值框的「场景值」哨兵（= 最小值，显示成 specialValueText）。
_FOLLOW = -0.05

#: 可调参数：键 → (标签, 下限, 上限, 步长, 小数位, 缺省；None = 跟随场景)
_FIELDS: dict[str, tuple[str, float, float, float, int, float | None]] = {
    "darkness": ("明暗", 0.0, 1.0, 0.05, 2, None),
    "size": ("大小", 0.0, 10.0, 0.1, 2, None),
    "spread": ("晕开", 0.01, 3.0, 0.05, 2, cao.SPREAD_DEFAULT),
    "fadeInMs": ("淡入 ms", 0.0, cao.FADE_MS_MAX, 25.0, 0, cao.FADE_IN_MS_DEFAULT),
    "fadeOutMs": ("淡出 ms", 0.0, cao.FADE_MS_MAX, 25.0, 0, cao.FADE_OUT_MS_DEFAULT),
    "dirStrength": ("浓度", 0.0, 1.0, 0.05, 2, cao.DIR_STRENGTH_DEFAULT),
    "dirLength": ("拖尾", 0.01, 10.0, 0.1, 2, cao.DIR_LENGTH_DEFAULT),
    "dirConeDeg": ("锥角°", 1.0, 85.0, 1.0, 0, cao.DIR_CONE_DEG_DEFAULT),
}
_TIPS = {
    "darkness": "脚边最暗处的浓度 0~1。拉到最小 =「场景值」：跟随场景光环境的「接触」浓度（不写字段）。",
    "size": "胶囊半径 = 剪影贴地那一截（脚、鞋、衣摆）的半宽 × 它。拉到最小 =「场景值」：跟随场景光环境的「大小」。",
    "spread": "简单 AO 往外晕开多远：遮挡高度占身高的比例。越大晕得越开、越淡越宽。",
    "fadeInMs": f"切换到开启 AO 的动画时，接触与方向 AO 一起平滑恢复的时长。默认 {cao.FADE_IN_MS_DEFAULT} 毫秒；0 = 立即切换。",
    "fadeOutMs": f"切换到关闭 AO 的动画时，接触与方向 AO 一起平滑消失的时长。默认 {cao.FADE_OUT_MS_DEFAULT} 毫秒；0 = 立即切换。",
    "dirStrength": "方向 AO 的浓度 0~1（在明暗之上再乘）。",
    "dirLength": "方向 AO 沿影子方向拖多长就淡完（× 身高）。",
    "dirConeDeg": "方向 AO 的半影锥角。越大边越软、越糊；越小越像一道实影。",
}

_ABSENT = object()


class ContactAoDirectionEditor(QWidget):
    """共用场景自动/手动与角色继承/自动/手动；未编辑的旧字段完整保值。"""

    def __init__(self, on_changed: Callable[[], None] | None = None,
                 parent: QWidget | None = None, *, allow_inherit: bool = False) -> None:
        super().__init__(parent)
        self._on_changed = on_changed
        self._allow_inherit = allow_inherit
        self._loading = False
        self._changed = False
        self._edited_numbers: set[str] = set()
        self._orig: object = _ABSENT
        self._legacy: object = _ABSENT
        grid = QGridLayout(self)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(6)
        self._mode = QComboBox(self)
        self._mode.setToolTip("角色未单独设置时继承场景。自动沿用间接光与实体灯计算；手动只改变 AO 拖尾，不改变实际光照。")
        self._mode.currentIndexChanged.connect(self._mode_changed)
        grid.addWidget(QLabel("方向", self), 0, 0)
        grid.addWidget(self._mode, 0, 1, 1, 3)
        self._spins: dict[str, QDoubleSpinBox] = {}
        for key, title, default, col in (
            ("azimuthDeg", "拖尾方向°", cao.AZIMUTH_DEG_DEFAULT, 0),
            ("elevationDeg", "仰角°", cao.ELEVATION_DEG_DEFAULT, 2),
        ):
            sb = QDoubleSpinBox(self)
            sb.setRange(*cao.DIRECTION_PARAM_RANGES[key])
            sb.setDecimals(1)
            sb.setSingleStep(1)
            sb.setValue(default)
            sb.setToolTip("AO 拖尾在画面上的方向：0° 右、90° 下、180° 左、270° 上。" if key == "azimuthDeg" else "AO 来光仰角；越高，拖尾越短。与真实灯光无关。")
            sb.valueChanged.connect(lambda _v, k=key: self._number_changed(k))
            grid.addWidget(QLabel(title, self), 1, col)
            grid.addWidget(sb, 1, col + 1)
            fit_width_cap(sb, 90)
            self._spins[key] = sb
        grid.setColumnStretch(4, 1)
        self.load(None)

    def _sync_enabled(self) -> None:
        manual = self._mode.currentData() == "manual"
        for sb in self._spins.values():
            sb.setEnabled(manual)

    def _emit(self) -> None:
        if not self._loading:
            self._changed = True
            if self._on_changed:
                self._on_changed()

    def _mode_changed(self, *_args: object) -> None:
        self._sync_enabled()
        self._emit()

    def _number_changed(self, key: str) -> None:
        if not self._loading:
            self._edited_numbers.add(key)
        self._emit()

    def load(self, value: object, legacy_source: object = _ABSENT) -> None:
        self._loading = True
        try:
            self._orig = copy.deepcopy(value) if value is not None else _ABSENT
            self._legacy = legacy_source
            self._mode.clear()
            if self._allow_inherit:
                self._mode.addItem("继承场景", "inherit")
            self._mode.addItem("自动计算", "auto")
            self._mode.addItem("手动方向", "manual")
            d = value if isinstance(value, dict) else {}
            mode = d.get("mode", "inherit" if self._allow_inherit else "auto")
            if not d and legacy_source is not _ABSENT:
                mode = legacy_source
                label = cao.DIR_SOURCE_LABELS.get(mode) if isinstance(mode, str) else None
                self._mode.addItem(f"旧设置：{label}" if label else f"（未知：{mode!r}）", mode)
            index = self._mode.findData(mode)
            if index < 0:
                self._mode.addItem(f"（未知：{mode!r}）", mode)
                index = self._mode.count() - 1
            self._mode.setCurrentIndex(index)
            for key, default in (("azimuthDeg", cao.AZIMUTH_DEG_DEFAULT), ("elevationDeg", cao.ELEVATION_DEG_DEFAULT)):
                v = d.get(key, default)
                valid = isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                self._spins[key].setValue(float(v) if valid else default)
            self._sync_enabled()
            self._changed = False
            self._edited_numbers.clear()
        finally:
            self._loading = False

    def writeback(self, out: dict, key: str, legacy_key: str | None = None) -> None:
        if not self._changed:
            if self._orig is _ABSENT:
                out.pop(key, None)
            else:
                out[key] = copy.deepcopy(self._orig)
            if legacy_key and self._legacy is not _ABSENT:
                out[legacy_key] = copy.deepcopy(self._legacy)
            return
        mode = self._mode.currentData()
        if mode == "inherit":
            out.pop(key, None)
            if legacy_key:
                out.pop(legacy_key, None)
            return
        if mode not in cao.DIRECTION_MODES:
            # 旧设置只在载入时出现；改回来仍保留原值。
            if legacy_key:
                out.pop(key, None)
                out[legacy_key] = copy.deepcopy(mode)
            return
        direction = copy.deepcopy(self._orig) if isinstance(self._orig, dict) else {}
        direction["mode"] = mode
        for field, sb in self._spins.items():
            if field in self._edited_numbers or (mode == "manual" and field not in direction):
                direction[field] = sb.value()
        out[key] = direction
        if legacy_key:
            out.pop(legacy_key, None)


class ContactAoEditor(QWidget):
    """一份 `contactAo` 的编辑器。`on_changed` 由调用方接到自己的脏标记上。

    用法::

        w = ContactAoEditor(on_changed=self._emit_props_changed)
        form.addRow("脚底 AO", w)
        ...
        w.set_scene_defaults(darkness=0.75, size=1.0)   # 「场景值」那一档显示的值
        w.load(npc_def.get("contactAo"))
        ...
        d = w.dump()                                     # None = 不写这个字段
    """

    def __init__(self, on_changed: Callable[[], None] | None = None,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._on_changed = on_changed
        self._loading = False
        self._orig: dict = {}
        self._spins: dict[str, QDoubleSpinBox] = {}

        # 两列网格：窄的属性面板里也放得下（三列排开要 500+ px，会顶出侧栏）
        grid = QGridLayout(self)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(6)
        grid.setVerticalSpacing(3)

        self._enabled = QCheckBox("接触 AO", self)
        self._enabled.setToolTip(
            "缺省开：脚下画一圈接触阴影，让角色坐进地面。与投影无关。\n"
            "只勾这个 = 简单 AO（无方向的近场遮蔽）。只有悬空的东西才需要关。"
        )
        self._enabled.stateChanged.connect(self._on_toggle)
        grid.addWidget(self._enabled, 0, 0, 1, 4)
        self._add_spin(grid, "darkness", 1, 0)
        self._add_spin(grid, "size", 1, 2)
        self._add_spin(grid, "spread", 2, 0)
        self._add_spin(grid, "fadeInMs", 3, 0)
        self._add_spin(grid, "fadeOutMs", 3, 2)

        self._directional = QCheckBox("方向 AO", self)
        self._directional.setToolTip(
            "缺省开：再加沿光方向的锥形软影（胶囊体 AO 的方向部分）。取消就只剩简单 AO。\n"
            "光从哪来见下面的「方向」（缺省继承场景；场景缺省自动计算）。"
        )
        self._directional.stateChanged.connect(self._on_toggle)
        grid.addWidget(self._directional, 4, 0, 1, 4)
        self._add_spin(grid, "dirStrength", 5, 0)
        self._add_spin(grid, "dirLength", 5, 2)
        self._add_spin(grid, "dirConeDeg", 6, 0)
        self._direction = ContactAoDirectionEditor(self._emit, self, allow_inherit=True)
        self._dir_source = self._direction._mode
        grid.addWidget(self._direction, 7, 0, 1, 4)
        grid.setColumnStretch(4, 1)

        self.set_scene_defaults(None, None)
        self.load(None)

    # ------------------------------------------------------------------ 内部
    def _add_spin(self, grid: QGridLayout, key: str, row: int, col: int) -> None:
        label, lo, hi, step, dec, default = _FIELDS[key]
        sb = QDoubleSpinBox(self)
        sb.setRange(_FOLLOW if default is None else lo, hi)
        sb.setSingleStep(step)
        sb.setDecimals(dec)
        sb.setToolTip(_TIPS[key])
        sb.valueChanged.connect(self._emit)
        lab = QLabel(label, self)
        lab.setToolTip(_TIPS[key])
        grid.addWidget(lab, row, col)
        grid.addWidget(sb, row, col + 1)
        self._spins[key] = sb

    def _emit(self, *_a: object) -> None:
        if self._loading:
            return
        if self._on_changed:
            self._on_changed()

    def _on_toggle(self, *_a: object) -> None:
        self._apply_enabled()
        self._emit()

    def _apply_enabled(self) -> None:
        on = self._enabled.isChecked()
        self._directional.setEnabled(on)
        for k in ("darkness", "size", "spread", "fadeInMs", "fadeOutMs"):
            self._spins[k].setEnabled(on)
        dir_on = on and self._directional.isChecked()
        for k in ("dirStrength", "dirLength", "dirConeDeg"):
            self._spins[k].setEnabled(dir_on)
        self._direction.setEnabled(dir_on)

    @staticmethod
    def _keep(orig: object, v: float, dec: int) -> float | int:
        """没动过就按原值写回（显示精度不改数据）；动过了按显示精度取整。"""
        if isinstance(orig, (int, float)) and not isinstance(orig, bool):
            if round(float(orig), dec) == round(v, dec):
                return orig
        return round(v, dec) if dec > 0 else int(round(v))

    # ------------------------------------------------------------------ 公开
    def set_scene_defaults(self, darkness: float | None, size: float | None, note: str = "") -> None:
        """「场景值」那一档显示的值（场景光环境此刻的接触浓度 / 大小）。None = 不知道，只写「场景值」。"""
        for key, val in (("darkness", darkness), ("size", size)):
            sb = self._spins[key]
            # 显示要短：数值框按自己的建议宽度排，「跟随场景 0.75」这种长串首字会被裁（离屏截图实测）
            if note:
                txt = f"场景值（{note}）"
            else:
                txt = "场景值" if val is None else f"场景值 {val:g}"
            sb.setSpecialValueText(txt)
            sb.ensurePolished()
            fit_width_cap(sb, sb.fontMetrics().horizontalAdvance(txt) + 48)
        for key in ("spread", "dirStrength", "dirLength", "dirConeDeg", "fadeInMs", "fadeOutMs"):
            fit_width_cap(self._spins[key], 76)

    def load(self, value: object) -> None:
        self._loading = True
        try:
            d = value if isinstance(value, dict) else {}
            self._orig = copy.deepcopy(d)
            self._enabled.setChecked(d.get("enabled", True) is not False)
            dv = d.get("directional")
            self._directional.setChecked(dv if isinstance(dv, bool) else cao.DIRECTIONAL_DEFAULT)
            self._direction.load(d.get("direction"), d.get("dirSource", _ABSENT))
            for key, (_l, lo, hi, _s, _d, default) in _FIELDS.items():
                v = d.get(key)
                num = isinstance(v, (int, float)) and not isinstance(v, bool)
                if default is None:
                    self._spins[key].setValue(float(v) if num else _FOLLOW)
                else:
                    self._spins[key].setValue(float(v) if num else float(default))
            self._apply_enabled()
        finally:
            self._loading = False

    def dump(self) -> dict | None:
        """写回值。`None` = 不写 `contactAo` 字段（开、方向 AO 开、全部缺省）。"""
        out = copy.deepcopy(self._orig)
        if self._enabled.isChecked():
            out.pop("enabled", None)
        else:
            out["enabled"] = False
        on = self._directional.isChecked()
        if on == cao.DIRECTIONAL_DEFAULT and "directional" not in self._orig:
            out.pop("directional", None)          # 等于缺省且原来没写：不写
        else:
            out["directional"] = on
        self._direction.writeback(out, "direction", "dirSource")
        for key, (_l, _lo, _hi, _s, dec, default) in _FIELDS.items():
            v = self._spins[key].value()
            if default is None:
                if v <= _FOLLOW + 1e-9:
                    out.pop(key, None)
                else:
                    out[key] = self._keep(self._orig.get(key), v, dec)
            elif round(v, dec) == round(float(default), dec) and key not in self._orig:
                out.pop(key, None)          # 等于缺省且原来没写：不写
            else:
                # 原来显式写了（哪怕等于缺省也不替作者删）或改成了非缺省值
                out[key] = self._keep(self._orig.get(key), v, dec)
        return out or None
