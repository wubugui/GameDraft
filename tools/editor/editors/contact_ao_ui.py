"""脚底接触 AO（胶囊 AO）的编辑控件（NPC 表单 / 场景的玩家那一块共用一个）。

作者面（制作人 2026-09-24 定）：勾「接触 AO」就有；**「方向 AO」缺省也勾着**（所有 NPC 与主角默认都开，
同日改口）；取消方向 AO 就只剩简单 AO；明暗、大小和方向 AO 的参数都能调。

- 明暗 / 大小有一档「场景值」（数值框拉到最小就是它）：不写字段，跟随场景光环境的
  `shadow.contact` / `contactSize`（光照曲线里还能按位置变）。框里直接显示此刻跟到的是多少。
- 其余参数框里显示的就是缺省值；**等于缺省就不写字段**，JSON 保持干净。
- 方向 AO 的方向来源是一个下拉（制作人 2026-09-24：是个选项；缺省「ao 方向本来就和间接光强度要一致」）：
  按光照 / 跟阴影绑定（上面「阴影绑定」绑的灯或虚拟灯）/ 场景主光。缺省那档不写字段。

往返保真：载入时记住原值，没动过的数按原值写回（显示精度不会把 0.333 改成 0.33）；
`contactAo` 里不认识的键原样保留。
"""
from __future__ import annotations

import copy
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
    "dirStrength": ("浓度", 0.0, 1.0, 0.05, 2, cao.DIR_STRENGTH_DEFAULT),
    "dirLength": ("拖尾", 0.01, 10.0, 0.1, 2, cao.DIR_LENGTH_DEFAULT),
    "dirConeDeg": ("锥角°", 1.0, 85.0, 1.0, 0, cao.DIR_CONE_DEG_DEFAULT),
}
_TIPS = {
    "darkness": "脚边最暗处的浓度 0~1。拉到最小 =「场景值」：跟随场景光环境的「接触」浓度（不写字段）。",
    "size": "胶囊半径 = 剪影贴地那一截（脚、鞋、衣摆）的半宽 × 它。拉到最小 =「场景值」：跟随场景光环境的「大小」。",
    "spread": "简单 AO 往外晕开多远：遮挡高度占身高的比例。越大晕得越开、越淡越宽。",
    "dirStrength": "方向 AO 的浓度 0~1（在明暗之上再乘）。",
    "dirLength": "方向 AO 沿影子方向拖多长就淡完（× 身高）。",
    "dirConeDeg": "方向 AO 的半影锥角。越大边越软、越糊；越小越像一道实影。",
}


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

        self._directional = QCheckBox("方向 AO", self)
        self._directional.setToolTip(
            "缺省开：再加沿光方向的锥形软影（胶囊体 AO 的方向部分）。取消就只剩简单 AO。\n"
            "光从哪来见下面的「方向」（缺省按光照：跟角色身上的光一致）。"
        )
        self._directional.stateChanged.connect(self._on_toggle)
        grid.addWidget(self._directional, 3, 0, 1, 4)
        self._add_spin(grid, "dirStrength", 4, 0)
        self._add_spin(grid, "dirLength", 4, 2)
        self._add_spin(grid, "dirConeDeg", 5, 0)
        # 方向来源：很短的枚举，用下拉（选择器铁律允许）
        self._dir_source = QComboBox(self)
        for key in cao.DIR_SOURCES:
            self._dir_source.addItem(cao.DIR_SOURCE_LABELS[key], key)
        self._dir_source.setToolTip(
            "方向 AO 往哪边拖：\n"
            "· 按光照（缺省）：跟角色身上的光一致。间接光（原画烘出的环境光，角色被照亮用的同一份）一路，\n"
            "  每盏亮着的灯（含手持火把）各一路，各投各的影、按各自照到脚下地面的量分浓淡：\n"
            "  离得远的灯照得少、影子自然淡；两盏灯就是两道影；四面一样亮时间接光那路是脚下一团\n"
            "· 跟阴影绑定：上面「阴影绑定」绑的灯 / 虚拟灯；没绑就用场景主光\n"
            "· 场景主光：场景光环境 / 光照曲线里的主光方向"
        )
        self._dir_source.currentIndexChanged.connect(self._emit)
        dir_lab = QLabel("方向", self)
        dir_lab.setToolTip(self._dir_source.toolTip())
        grid.addWidget(dir_lab, 5, 2)
        grid.addWidget(self._dir_source, 5, 3)
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
        for k in ("darkness", "size", "spread"):
            self._spins[k].setEnabled(on)
        dir_on = on and self._directional.isChecked()
        for k in ("dirStrength", "dirLength", "dirConeDeg"):
            self._spins[k].setEnabled(dir_on)
        self._dir_source.setEnabled(dir_on)

    @staticmethod
    def _keep(orig: object, v: float, dec: int) -> float | int:
        """没动过就按原值写回（显示精度不改数据）；动过了按显示精度取整。"""
        if isinstance(orig, (int, float)) and not isinstance(orig, bool):
            if round(float(orig), dec) == round(v, dec):
                return orig
        return round(v, dec) if dec > 0 else int(round(v))

    def _load_dir_source(self, value: object) -> None:
        """选中数据里的方向来源；不认识的值**保值展示**（加一项「未知：…」），不悄悄换成缺省。"""
        # 先删掉上次载入加的「未知」项
        for i in range(self._dir_source.count() - 1, len(cao.DIR_SOURCES) - 1, -1):
            self._dir_source.removeItem(i)
        i = self._dir_source.findData(value)
        if i < 0:
            self._dir_source.addItem(f"（未知：{value!r}）", value)
            i = self._dir_source.count() - 1
        self._dir_source.setCurrentIndex(i)

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
        for key in ("spread", "dirStrength", "dirLength", "dirConeDeg"):
            fit_width_cap(self._spins[key], 76)

    def load(self, value: object) -> None:
        self._loading = True
        try:
            d = value if isinstance(value, dict) else {}
            self._orig = copy.deepcopy(d)
            self._enabled.setChecked(d.get("enabled", True) is not False)
            dv = d.get("directional")
            self._directional.setChecked(dv if isinstance(dv, bool) else cao.DIRECTIONAL_DEFAULT)
            self._load_dir_source(d.get("dirSource", cao.DIR_SOURCE_DEFAULT))
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
        src = self._dir_source.currentData()
        if src == cao.DIR_SOURCE_DEFAULT and "dirSource" not in self._orig:
            out.pop("dirSource", None)
        else:
            out["dirSource"] = src
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
