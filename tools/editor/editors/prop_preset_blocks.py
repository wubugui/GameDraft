"""挂件预设页的三个重块（自带光源 / 效果 / 状态表）的控件。

## 为什么单独一个模块

`prop_preset_editor.py` 原本只管"贴图 + 支点 + 缩放"三件事。手持光源（2026-09-12）
一次性给它加了四组语义完全不同的数据（`light` / `vfx` / `persistent` / `states`），
其中 `light` 这一块在**基础块**与**每个状态**里各出现一次 —— 同一份表单两个宿主，
写两遍必然发散（一边加了 `windAmp` 另一边没有，而且没人看得出来）。
所以控件住在这里，那一页只负责装配与主从列表。

## 权威源

字段语义一律以 `src/data/propPresets.ts` 为准（`PropLightDef` / `PropFlickerDef` /
`PropStateDef`）。**Python 侧是 TS 的投影，冲突以 TS 为准**，兜底校验不得比 TS 更严。

## 三态，而不是两态（这一块最容易做错）

`PropStateDef.light` 有**三**种合法形态，运行时语义各不相同
（`resolvePropAttach` 里那个 `'light' in st` 判断）：

| 数据 | 含义 |
|---|---|
| 不写 `light` 键 | 沿用基础块那盏灯 |
| `light: null` | **这个状态没有灯**（火把灭了） |
| `light: {...}` | 逐字段盖在基础块那盏上 |

做成勾选框（两态）就配不出中间那一档：策划只能在"沿用"和"自定义"之间选，
而"灭了"是火把这个特性的**主要用例**。`vfx` 同理（不写=沿用 / `[]`=没有效果 /
给列表=整体替换），`lit` 也同理（不写=沿用 / true / false）——运行时缺省非 false 的
可选 bool 一律走三态，照 `playNpcAnimation.loop` 的惯例。

## 往返保真

- 未改动的数值按磁盘原始表示回写（`preserve_numeric_repr` + 逐元素的 `offset`/`color`）；
- `QDoubleSpinBox` 会**量化**（`decimals` 截断），量化后数值已不相等、`preserve_numeric_repr`
  兜不住 ⇒ 另加**种子快照法**（样板 `anim_editor` / `light_follow_ui`）：载入时记下截断后的
  种子，保存时控件仍等于种子就回吐磁盘原字面值；
- 表单不认识的键**原样透传**（将来给 `PropLightDef` 加字段不会被吞掉）；
- 键序按磁盘原序，只有新增键才追加；
- **重块默认折叠且懒建**：没展开过的块 `dump()` 直接回吐载入时的深拷贝，
  一个字节都不经过 Qt 控件（既省控件数，也是往返保真最硬的一道）。
"""
from __future__ import annotations

import copy
from typing import Any, Callable

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..shared.collapsible_section import CollapsibleSection
from ..shared.form_layout import compact_form
from ..shared.id_ref_selector import IdRefSelector
from ..shared.num_fields import float_or
from ..shared.numeric_roundtrip import preserve_numeric_repr
from ..shared.widget_discard import discard_widget

#: `PropLightDef` 里表单管着的键。其余键一律原样透传。
LIGHT_KEYS = (
    "socket", "offset", "kelvin", "color", "intensity",
    "range", "softeningRadius", "castShadow", "flicker",
)
#: `PropStateDef` 里表单管着的键。其余键一律原样透传。
STATE_KEYS = (
    "label", "image", "images", "anchorX", "anchorY", "rotation", "scale",
    "lit", "light", "vfx",
)

#: 一盏新挂件灯的缺省值。与场景灯 `scene_lights.default_light` 同一把尺
#: （角色高 150 wu；作用半径 450 wu ≈ 3 个人高，发光体半径 10 wu ≈ 1/15 个人高），
#: 但**不含** kind/pos/enabled —— 那三项由运行时补（kind 恒 point、pos 每帧由挂点算）。
LIGHT_DEFAULTS: dict[str, float] = {
    "kelvin": 1900.0,      # 火光偏橙；场景灯缺省 2400 是灯笼/油灯
    "intensity": 2.0,
    "range": 300.0,
    "softeningRadius": 8.0,
}
#: 火焰闪烁的缺省。烛火 6–10 Hz（`PropFlickerDef.hz` 的注释原话）。
FLICKER_DEFAULTS: dict[str, float] = {"amp": 0.2, "hz": 8.0, "windAmp": 0.0}

#: 三态可选 bool 的档位（与 `attachToSocket.mirror/lit` 的三态惯例同形）。
TRISTATE_INHERIT = ""
TRISTATE_TRUE = "true"
TRISTATE_FALSE = "false"

#: 状态里 `light` 的三档（值是内部标记，不落盘）。
STATE_LIGHT_INHERIT = "inherit"
STATE_LIGHT_NONE = "none"
STATE_LIGHT_OWN = "own"

#: 状态里 `vfx` 的三档。
STATE_VFX_INHERIT = "inherit"
STATE_VFX_NONE = "none"
STATE_VFX_OWN = "own"


def num_repr_like(value: float, original: Any) -> Any:
    """数值相等就回吐原始表示（`0` 不漂成 `0.0`）。`preserve_numeric_repr` 的单值版。

    ⚠ 与 `light_follow_ui._num_repr_like` 是同一段逻辑的两份拷贝。两边宿主不同
    （那边是场景灯的 follow 块、这边是挂件灯），而这函数是三行纯函数、没有可漂移的
    清单语义；真要收拢应提到 shared，届时两处一起改（已记进 agent_docs inbox）。
    """
    if isinstance(original, bool) or not isinstance(original, (int, float)):
        return value
    return original if float(original) == float(value) else value


def reorder_like(out: dict, original: Any) -> dict:
    """按磁盘原序重排：原有键回原位置，新增键追加在后（numeric-roundtrip 契约 4）。"""
    if not isinstance(original, dict):
        return out
    ordered: dict = {}
    for k in original:
        if k in out:
            ordered[k] = out[k]
    for k in out:
        if k not in ordered:
            ordered[k] = out[k]
    return ordered


def tristate_rows(inherit_label: str, true_label: str, false_label: str) -> list[tuple[str, str]]:
    return [
        (inherit_label, TRISTATE_INHERIT),
        (true_label, TRISTATE_TRUE),
        (false_label, TRISTATE_FALSE),
    ]


def tristate_of(raw: object) -> str:
    """磁盘值 → 三态档位。非 bool（含缺键）一律当"沿用"。"""
    if raw is True:
        return TRISTATE_TRUE
    if raw is False:
        return TRISTATE_FALSE
    return TRISTATE_INHERIT


class TristateBoolCombo(QComboBox):
    """运行时缺省非 false 的可选 bool 的三态下拉（禁用勾选框：中性态 = false，配不出 false）。

    档位很短（三档），按选择器铁律"只有很短的枚举才允许下拉"—— 这里用下拉是合规的。
    磁盘上出现第四种值（字符串 "0" 之类）时注入一行 `(数据) …` 保值展示，不静默顶替。
    """

    def __init__(self, rows: list[tuple[str, str]], parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._rows = list(rows)
        for label, value in self._rows:
            self.addItem(label, value)
        self.setMaximumWidth(240)

    def set_value(self, raw: object) -> None:
        want = tristate_of(raw)
        if raw is not None and not isinstance(raw, bool):
            # 保值展示：磁盘上是别的类型（"true" / 1 / …），原值一个字节不动
            keep = str(raw)
            idx = self.findData(keep)
            if idx < 0:
                self.addItem(f"(数据) {keep}", keep)
                idx = self.count() - 1
            self.setCurrentIndex(idx)
            return
        idx = self.findData(want)
        self.setCurrentIndex(idx if idx >= 0 else 0)

    def value(self) -> object:
        """返回落盘值：`None` = 不写这个键。"""
        d = self.currentData()
        if d == TRISTATE_TRUE:
            return True
        if d == TRISTATE_FALSE:
            return False
        if isinstance(d, str) and d not in (TRISTATE_INHERIT,):
            return d  # 保值透传的原始值
        return None


class OptionalNumField(QWidget):
    """可选数值：勾选框决定"写不写这个键"，不写 = 沿用上一层/运行时缺省。

    为什么不用"等于缺省就不写"：那会把磁盘上显式写着 `rotation: 0` 的条目一打开就抹掉
    （违反"打开→不动→保存 输出与磁盘等价"）。显式的开关让"没配"与"配成缺省值"分得开。
    """

    changed = Signal()

    def __init__(
        self, lo: float, hi: float, step: float, decimals: int,
        *, seed: float = 0.0, parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._seed_default = seed
        self._quant_seed: float | None = None
        self._original: Any = None
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        self._on = QCheckBox("覆盖", self)
        self._on.setToolTip("不勾 = 不写这个键（沿用基础块 / 运行时缺省）。")
        self._on.toggled.connect(self._on_toggled)
        lay.addWidget(self._on)
        self._spin = QDoubleSpinBox(self)
        self._spin.setRange(lo, hi)
        self._spin.setSingleStep(step)
        self._spin.setDecimals(decimals)
        self._spin.setMaximumWidth(96)
        self._spin.valueChanged.connect(lambda _v: self.changed.emit())
        lay.addWidget(self._spin)
        lay.addStretch(1)
        self._spin.setEnabled(False)

    def _on_toggled(self, on: bool) -> None:
        self._spin.setEnabled(on)
        self.changed.emit()

    def set_tool_tip(self, text: str) -> None:
        self.setToolTip(text)
        self._spin.setToolTip(text)

    def set_value(self, raw: Any) -> None:
        self._original = raw
        has = isinstance(raw, (int, float)) and not isinstance(raw, bool)
        self._on.setChecked(has)
        self._spin.setEnabled(has)
        self._spin.setValue(float_or(raw, self._seed_default))
        # 种子必须在 setValue **之后**取（记的是控件量化后的那个值）
        self._quant_seed = self._spin.value()

    def value(self) -> Any:
        """返回落盘值：`None` = 不写这个键；数值按磁盘原表示回吐（未动过时）。"""
        if not self._on.isChecked():
            return None
        v = self._spin.value()
        if (self._quant_seed is not None and v == self._quant_seed
                and isinstance(self._original, (int, float))
                and not isinstance(self._original, bool)):
            return self._original
        return round(v, 4)


class VfxIdListField(QWidget):
    """效果资产 id 列表（`public/assets/data/vfx/<id>.json`，id == 文件名）。

    **禁裸 QLineEdit**（选择器铁律）：每行是一个 `IdRefSelector`，点一下开可搜索弹窗
    （候选可以上百条，跨文件引用一律弹窗，见 decisions/2026-07-11）。候选取自
    `ProjectModel.all_vfx_effect_ids()` —— 与 `playVfx.effect` 同一个 id-provider，
    不自建清单。悬垂 id 由 IdRefSelector 保值展示（标「缺失」），不静默清空。

    顺序在这份数据里**不承载语义**（运行时整串一起放），所以按 list_affordances
    只给增删、不给上下移。
    """

    changed = Signal()

    def __init__(self, model: Any, initial: object, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._rows: list[IdRefSelector] = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self._rows_layout = QVBoxLayout()
        self._rows_layout.setSpacing(2)
        lay.addLayout(self._rows_layout)
        add = QPushButton("+ 效果")
        add.setMaximumWidth(120)
        add.setToolTip("挂一个效果资产（火焰、火星…）。候选来自 assets/data/vfx/*.json。")
        add.clicked.connect(lambda: self._add("", quiet=False))
        lay.addWidget(add)
        self.set_ids(initial)

    def _items(self) -> list[tuple[str, str]]:
        fn = getattr(self._model, "all_vfx_effect_ids", None)
        if not callable(fn):
            return []
        try:
            return list(fn() or [])
        except Exception:  # noqa: BLE001 —— 候选取不到只是少了下拉，不能反噬面板
            return []

    def _add(self, value: str, *, quiet: bool) -> None:
        row_w = QWidget(self)
        rl = QHBoxLayout(row_w)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.setSpacing(4)
        sel = IdRefSelector(row_w, allow_empty=True, editable=False, click_opens_popup=True)
        sel.setMinimumWidth(200)
        sel.setMaximumWidth(320)
        sel.set_items(self._items())
        sel.set_current(value)
        sel.value_changed.connect(lambda _v: self.changed.emit())
        rl.addWidget(sel, 1)
        rm = QPushButton("−", row_w)
        rm.setMaximumWidth(28)
        rm.clicked.connect(lambda: self._remove(sel))
        rl.addWidget(rm)
        rl.addStretch(0)
        self._rows.append(sel)
        self._rows_layout.addWidget(row_w)
        # ⚠ addWidget 之后子控件仍是 isHidden()，隐藏项被布局整个跳过（行高按"零行"算）
        row_w.show()
        if not quiet:
            self.changed.emit()

    def _remove(self, sel: IdRefSelector) -> None:
        if sel not in self._rows:
            return
        self._rows.remove(sel)
        host = sel.parentWidget()
        if host is not None:
            self._rows_layout.removeWidget(host)
            discard_widget(host)
        self.changed.emit()

    def set_ids(self, raw: object) -> None:
        for sel in list(self._rows):
            host = sel.parentWidget()
            self._rows.remove(sel)
            if host is not None:
                self._rows_layout.removeWidget(host)
                discard_widget(host)
        for item in (raw if isinstance(raw, list) else []):
            if isinstance(item, str) and item.strip():
                self._add(item.strip(), quiet=True)

    def reload_refs(self) -> None:
        """跨面板刷新：别处新增效果资产后重拉候选（当前值保值）。"""
        items = self._items()
        for sel in self._rows:
            cur = sel.current_id()
            sel.set_items(items)
            sel.set_current(cur)

    def to_list(self) -> list[str]:
        out: list[str] = []
        for sel in self._rows:
            v = sel.current_id().strip()
            if v:
                out.append(v)
        return out


class PropLightForm(QWidget):
    """一盏挂件灯（`PropLightDef`）的表单。**不含**"有没有这盏灯"的开关——那由宿主决定。

    字段语义与 `LightDef` 同名项逐字相同（单位 wu）；少的那几项由运行时补：
    `kind` 恒 `point`、`pos` 每帧由挂点算、`enabled` 由状态给。
    """

    changed = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._loading = False
        self._original: dict | None = None
        self._socket_items: list[tuple[str, str]] = []
        # 种子快照（控件量化后的值）。控件仍等于种子 = 用户没动过 ⇒ 回吐磁盘原字面值。
        self._intensity_seed: float | None = None
        self._amp_seed: float | None = None
        self._hz_seed: float | None = None
        self._color_seeds: list[float] = []
        self._offset_seeds: list[float] = []
        form = compact_form(QFormLayout(self))

        # 挂点是引用字段（动画包 sockets.json 的键）⇒ 禁裸 QLineEdit。候选由宿主喂
        # （`set_socket_items`）；取不到候选时仍可手打（editable=True 保值，名字跨包通用）。
        self._socket = IdRefSelector(self, allow_empty=True, editable=True, click_opens_popup=True)
        self._socket.setMaximumWidth(220)
        self._socket.setToolTip(
            "灯挂在哪个挂点（火头 `torch_tip` 而不是手心）。\n"
            "留空 = 用挂载这次那个挂点。\n"
            "⚠ 挂点当前帧没标注 ⇒ 这一帧灯不发光（与挂件一起隐）。")
        self._socket.value_changed.connect(self._emit)
        form.addRow("灯挂点", self._socket)

        self._intensity = QDoubleSpinBox(self)
        self._intensity.setRange(0.0, 10000.0)
        self._intensity.setDecimals(4)
        self._intensity.setSingleStep(0.1)
        self._intensity.setMaximumWidth(96)
        self._intensity.setToolTip(
            "亮度。**必须 > 0** —— 运行时 `parsePropLight` 把 intensity ≤ 0 的灯整盏丢掉\n"
            "（零强度的灯只白占一个灯槽，而灯槽是 24 个的硬上限）。\n"
            f"缺省 {LIGHT_DEFAULTS['intensity']}；场景灯的油灯档是 2.5，可拿来比。")
        self._intensity.valueChanged.connect(self._emit)
        form.addRow("亮度", self._intensity)

        self._kelvin = OptionalNumField(0.0, 40000.0, 100.0, 2,
                                        seed=LIGHT_DEFAULTS["kelvin"], parent=self)
        self._kelvin.set_tool_tip(
            "色温（K）。火光 1700–2000、油灯 2400、日光 5500。\n"
            "与下面的 RGB 二选一：都给时运行时按 LightDef 的口径处理，别同时配。")
        self._kelvin.changed.connect(self._emit)
        form.addRow("色温 K", self._kelvin)

        col_row = QWidget(self)
        cl = QHBoxLayout(col_row)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.setSpacing(4)
        self._color_on = QCheckBox("用 RGB", col_row)
        self._color_on.setToolTip("勾上才写 `color`（与色温二选一）。不勾 = 不写这个键。")
        self._color_on.toggled.connect(self._on_color_toggled)
        cl.addWidget(self._color_on)
        self._color: list[QDoubleSpinBox] = []
        for ch in ("r", "g", "b"):
            lbl = QLabel(ch, col_row)
            cl.addWidget(lbl)
            sb = QDoubleSpinBox(col_row)
            sb.setRange(0.0, 100.0)
            sb.setDecimals(4)
            sb.setSingleStep(0.05)
            sb.setMaximumWidth(80)
            sb.setEnabled(False)
            sb.valueChanged.connect(self._emit)
            cl.addWidget(sb)
            self._color.append(sb)
        cl.addStretch(1)
        col_row.setToolTip("线性 RGB（不是 0–255）。与色温二选一。")
        form.addRow("颜色", col_row)

        self._range = OptionalNumField(0.0, 100000.0, 10.0, 4,
                                       seed=LIGHT_DEFAULTS["range"], parent=self)
        self._range.set_tool_tip(
            "作用半径（**wu**，与 NPC 坐标同一把尺）。尺度锚：角色高 150 wu，\n"
            f"火把大约 {LIGHT_DEFAULTS['range']:.0f} wu（两个人高）。不写 = 运行时缺省。")
        self._range.changed.connect(self._emit)
        form.addRow("半径 wu", self._range)

        self._soft = OptionalNumField(0.0, 10000.0, 1.0, 4,
                                      seed=LIGHT_DEFAULTS["softeningRadius"], parent=self)
        self._soft.set_tool_tip(
            "发光体**半径**（wu）：火头本身有多大，决定影子边缘多软。\n"
            f"缺省 {LIGHT_DEFAULTS['softeningRadius']:.0f} wu（火苗）。不写 = 运行时缺省。")
        self._soft.changed.connect(self._emit)
        form.addRow("软化半径 wu", self._soft)

        off_row = QWidget(self)
        ol = QHBoxLayout(off_row)
        ol.setContentsMargins(0, 0, 0, 0)
        ol.setSpacing(4)
        self._offset_on = QCheckBox("覆盖", off_row)
        self._offset_on.setToolTip("不勾 = 不写 `offset`（= [0,0,0]）。")
        self._offset_on.toggled.connect(self._on_offset_toggled)
        ol.addWidget(self._offset_on)
        self._offset: list[QDoubleSpinBox] = []
        self._offset_seeds: list[float] = []
        for axis in ("x", "y", "z"):
            lbl = QLabel(axis, off_row)
            ol.addWidget(lbl)
            sb = QDoubleSpinBox(off_row)
            sb.setRange(-20000.0, 20000.0)
            sb.setDecimals(3)
            sb.setSingleStep(5.0)
            sb.setMaximumWidth(88)
            sb.setEnabled(False)
            sb.valueChanged.connect(self._emit)
            ol.addWidget(sb)
            self._offset.append(sb)
        ol.addStretch(1)
        off_row.setToolTip(
            "世界空间偏移（**wu**），加在挂点解出来的位置上。\n"
            "尺度锚：角色高 150 wu。三个 0 = 不偏。")
        form.addRow("偏移 wu", off_row)

        self._cast = TristateBoolCombo(tristate_rows(
            "（缺省：不投影）", "投影（每帧重解线扫，先量帧时）", "不投影"), self)
        self._cast.setToolTip(
            "跟随灯每帧都在动，开了投影 = 每帧重解线扫前缀。**先量帧时再开**。\n"
            "缺省（不写键）= 不投影。")
        self._cast.currentIndexChanged.connect(self._emit)
        form.addRow("投影", self._cast)

        flk_row = QWidget(self)
        fl = QVBoxLayout(flk_row)
        fl.setContentsMargins(0, 0, 0, 0)
        fl.setSpacing(2)
        self._flicker_on = QCheckBox("火焰闪烁", flk_row)
        self._flicker_on.setToolTip(
            "勾上才写 `flicker`。amp/hz **必须同时 > 0** —— 运行时 `parsePropLight`\n"
            "只要有一个缺或 ≤0 就把整个 flicker 丢掉（灯不闪，而作者以为配了）。\n"
            "一个信号同时驱动灯的强度与发射率，不会出现「灯在闪、火苗不动」。")
        self._flicker_on.toggled.connect(self._on_flicker_toggled)
        fl.addWidget(self._flicker_on)
        self._flicker_fields = QWidget(flk_row)
        ff = compact_form(QFormLayout(self._flicker_fields))
        self._amp = QDoubleSpinBox(self._flicker_fields)
        self._amp.setRange(0.0, 100.0)
        self._amp.setDecimals(4)
        self._amp.setSingleStep(0.05)
        self._amp.setMaximumWidth(88)
        self._amp.setToolTip("相对波动幅度（0.2 = ±20% 上下）。必须 > 0。")
        self._amp.valueChanged.connect(self._emit)
        ff.addRow("幅度", self._amp)
        self._hz = QDoubleSpinBox(self._flicker_fields)
        self._hz.setRange(0.0, 1000.0)
        self._hz.setDecimals(4)
        self._hz.setSingleStep(0.5)
        self._hz.setMaximumWidth(88)
        self._hz.setToolTip("波动频率（Hz）。烛火 6–10。必须 > 0。")
        self._hz.valueChanged.connect(self._emit)
        ff.addRow("频率 Hz", self._hz)
        self._wind = OptionalNumField(0.0, 100.0, 0.1, 4,
                                      seed=0.5, parent=self._flicker_fields)
        self._wind.set_tool_tip(
            "风把幅度推高多少：`amp_eff = amp × (1 + windAmp × u/u_ref)`。\n"
            "不写 = 0 = 不吃风（室内灯笼）。")
        self._wind.changed.connect(self._emit)
        ff.addRow("吃风", self._wind)
        fl.addWidget(self._flicker_fields)
        self._flicker_fields.setEnabled(False)
        form.addRow("闪烁", flk_row)

        self._note = QLabel("", self)
        self._note.setWordWrap(True)
        form.addRow("", self._note)

    # ---------------------------------------------------------------- 内部
    def _emit(self, *_a: object) -> None:
        if self._loading:
            return
        self._refresh_note()
        self.changed.emit()

    def _on_color_toggled(self, on: bool) -> None:
        for sb in self._color:
            sb.setEnabled(on)
        self._emit()

    def _on_offset_toggled(self, on: bool) -> None:
        for sb in self._offset:
            sb.setEnabled(on)
        self._emit()

    def _on_flicker_toggled(self, on: bool) -> None:
        self._flicker_fields.setEnabled(on)
        if on and self._loading is False:
            # 勾上而两个值还是 0 = 运行时会把整块丢掉；给一组"看得见"的缺省
            if self._amp.value() <= 0:
                self._amp.setValue(FLICKER_DEFAULTS["amp"])
            if self._hz.value() <= 0:
                self._hz.setValue(FLICKER_DEFAULTS["hz"])
        self._emit()

    def _refresh_note(self) -> None:
        bad: list[str] = []
        if self._intensity.value() <= 0:
            bad.append("亮度 ≤ 0 ⇒ 运行时把这盏灯整盏丢掉（不亮，也不报错）。")
        if self._flicker_on.isChecked() and (self._amp.value() <= 0 or self._hz.value() <= 0):
            bad.append("闪烁的幅度与频率必须同时 > 0，否则整块 flicker 被丢掉（灯不闪）。")
        if self._color_on.isChecked() and self._kelvin.value() is not None:
            bad.append("色温与 RGB 同时配了 —— 只留一个。")
        self._note.setText("　".join(bad))
        self._note.setStyleSheet("color:#c66;" if bad else "color:#888;")

    # ---------------------------------------------------------------- 外部
    def set_socket_items(self, items: list[tuple[str, str]]) -> None:
        """喂挂点候选（宿主按"这个挂件挂在谁身上"解析）。当前值保值。"""
        self._socket_items = list(items)
        cur = self._socket.current_id()
        was = self._loading
        self._loading = True
        try:
            self._socket.set_items(self._socket_items)
            self._socket.set_current(cur)
        finally:
            self._loading = was

    def set_data(self, light: object) -> None:
        """从数据载入（`None` / 非 dict = 按一盏全新的灯填缺省）。"""
        d = light if isinstance(light, dict) else None
        self._original = copy.deepcopy(d) if d is not None else None
        was = self._loading
        self._loading = True
        try:
            self._socket.set_items(self._socket_items)
            self._socket.set_current(str((d or {}).get("socket") or ""))
            self._intensity.setValue(
                float_or((d or {}).get("intensity"), LIGHT_DEFAULTS["intensity"]))
            self._intensity_seed = self._intensity.value()
            self._kelvin.set_value((d or {}).get("kelvin"))
            col = (d or {}).get("color")
            has_col = isinstance(col, list) and len(col) >= 3
            self._color_on.setChecked(has_col)
            for i, sb in enumerate(self._color):
                sb.setEnabled(has_col)
                sb.setValue(float_or(col[i] if has_col else None, 1.0))
            self._color_seeds = [sb.value() for sb in self._color]
            self._range.set_value((d or {}).get("range"))
            self._soft.set_value((d or {}).get("softeningRadius"))
            off = (d or {}).get("offset")
            has_off = isinstance(off, list) and len(off) >= 3
            self._offset_on.setChecked(has_off)
            for i, sb in enumerate(self._offset):
                sb.setEnabled(has_off)
                sb.setValue(float_or(off[i] if has_off else None, 0.0))
            self._offset_seeds = [sb.value() for sb in self._offset]
            self._cast.set_value((d or {}).get("castShadow"))
            flk = (d or {}).get("flicker")
            has_flk = isinstance(flk, dict)
            self._flicker_on.setChecked(has_flk)
            self._flicker_fields.setEnabled(has_flk)
            self._amp.setValue(float_or((flk or {}).get("amp"), FLICKER_DEFAULTS["amp"]))
            self._hz.setValue(float_or((flk or {}).get("hz"), FLICKER_DEFAULTS["hz"]))
            self._amp_seed = self._amp.value()
            self._hz_seed = self._hz.value()
            self._wind.set_value((flk or {}).get("windAmp"))
        finally:
            self._loading = was
        self._refresh_note()

    def dump(self) -> dict:
        """产出一盏灯。`intensity` 恒写（TS 里它是唯一必填项）。"""
        orig = self._original if isinstance(self._original, dict) else None
        out: dict[str, Any] = {}
        # 表单不认识的键原样透传（将来给 PropLightDef 加字段不会被吞掉）
        for k, v in (orig or {}).items():
            if k not in LIGHT_KEYS:
                out[k] = copy.deepcopy(v)
        sock = self._socket.current_id().strip()
        if sock:
            out["socket"] = sock
        if self._offset_on.isChecked():
            orig_off = (orig or {}).get("offset")
            orig_off = orig_off if isinstance(orig_off, list) else []
            out["offset"] = [
                _seeded(sb.value(),
                        self._offset_seeds[i] if i < len(self._offset_seeds) else None,
                        orig_off[i] if i < len(orig_off) else None)
                for i, sb in enumerate(self._offset)
            ]
        kel = self._kelvin.value()
        if kel is not None:
            out["kelvin"] = kel
        if self._color_on.isChecked():
            orig_col = (orig or {}).get("color")
            orig_col = orig_col if isinstance(orig_col, list) else []
            out["color"] = [
                _seeded(sb.value(),
                        self._color_seeds[i] if i < len(self._color_seeds) else None,
                        orig_col[i] if i < len(orig_col) else None)
                for i, sb in enumerate(self._color)
            ]
        out["intensity"] = _seeded(self._intensity.value(), self._intensity_seed,
                                   (orig or {}).get("intensity"))
        rng = self._range.value()
        if rng is not None:
            out["range"] = rng
        soft = self._soft.value()
        if soft is not None:
            out["softeningRadius"] = soft
        cast = self._cast.value()
        if cast is not None:
            out["castShadow"] = cast
        if self._flicker_on.isChecked():
            o_flk = (orig or {}).get("flicker")
            o_flk = o_flk if isinstance(o_flk, dict) else None
            flk: dict[str, Any] = {}
            for k, v in (o_flk or {}).items():
                if k not in ("amp", "hz", "windAmp"):
                    flk[k] = copy.deepcopy(v)
            flk["amp"] = _seeded(self._amp.value(), self._amp_seed, (o_flk or {}).get("amp"))
            flk["hz"] = _seeded(self._hz.value(), self._hz_seed, (o_flk or {}).get("hz"))
            wind = self._wind.value()
            if wind is not None:
                flk["windAmp"] = wind
            preserve_numeric_repr(flk, o_flk)
            out["flicker"] = reorder_like(flk, o_flk)
        preserve_numeric_repr(out, orig)
        for key in ("offset", "color"):
            o_list = (orig or {}).get(key)
            if key in out and isinstance(o_list, list):
                out[key] = [num_repr_like(v, o_list[i] if i < len(o_list) else None)
                            for i, v in enumerate(out[key])]
        return reorder_like(out, orig)


def _seeded(value: float, seed: float | None, original: Any) -> Any:
    """控件没动过（仍等于种子）且磁盘原值是数 ⇒ 回吐原字面值；否则用控件值。"""
    if (seed is not None and value == seed
            and isinstance(original, (int, float)) and not isinstance(original, bool)):
        return original
    return round(value, 4)


class PropLightBlock(QWidget):
    """基础块的「自带光源」：默认折叠 + 懒建 + 一个"有没有这盏灯"的开关。

    没展开过 ⇒ `dump()` 原样回吐载入时的深拷贝（一个字节都不经过 Qt 控件）。
    """

    changed = Signal()

    def __init__(self, on_changed: Callable[[], None] | None = None,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._on_changed = on_changed
        self._loading = False
        self._built = False
        self._pending: dict | None = None
        self._socket_items: list[tuple[str, str]] = []
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self._section = CollapsibleSection("自带光源（没有）", start_open=False)
        self._section.set_header_tool_tip(
            "这个挂件自己带一盏灯：挂上就有、卸下就没，每帧跟着挂点走（火把、灯笼）。\n"
            "⚠ 与场景灯的「跟随实体」不是一回事——那是「场景里本来就有、但会动」的灯。\n"
            "灭了的那一档不在这里配，在下面的「状态表」里给某个状态写「没有灯」。")
        self._section.expanded_changed.connect(self._on_expanded)
        self._body = QWidget()
        bl = QVBoxLayout(self._body)
        bl.setContentsMargins(0, 0, 0, 0)
        bl.setSpacing(4)
        self._body_layout = bl
        self._section.add_body(self._body)
        outer.addWidget(self._section)

    def _on_expanded(self, on: bool) -> None:
        if on:
            self.ensure_built()

    def ensure_built(self) -> None:
        if self._built:
            return
        self._built = True
        self._loading = True
        try:
            self._on = QCheckBox("这个挂件自带一盏灯", self._body)
            self._on.setToolTip("勾掉 = **不写 `light` 键**（不是 null、不是 {}）。")
            self._on.toggled.connect(self._on_enable_toggled)
            self._body_layout.addWidget(self._on)
            self._form = PropLightForm(self._body)
            self._form.changed.connect(self._emit)
            self._body_layout.addWidget(self._form)
        finally:
            self._loading = False
        self._body.show()
        _relayout_up(self._body, self)
        self._fill()

    def _emit(self, *_a: object) -> None:
        if self._loading:
            return
        self._refresh_title()
        self.changed.emit()
        if self._on_changed:
            self._on_changed()

    def _on_enable_toggled(self, *_a: object) -> None:
        if self._built:
            self._form.setEnabled(self._on.isChecked())
        self._emit()

    def _refresh_title(self) -> None:
        d = self.dump()
        if not isinstance(d, dict):
            self._section.set_title("自带光源（没有）")
            return
        bits = []
        if d.get("kelvin") is not None:
            bits.append(f"{float_or(d.get('kelvin'), 0):.0f}K")
        bits.append(f"亮度 {float_or(d.get('intensity'), 0):.2f}")
        if isinstance(d.get("flicker"), dict):
            bits.append("会闪")
        self._section.set_title("自带光源：" + "　".join(bits))

    def _fill(self) -> None:
        if not self._built:
            return
        was = self._loading
        self._loading = True
        try:
            has = isinstance(self._pending, dict)
            self._on.setChecked(has)
            self._form.setEnabled(has)
            self._form.set_socket_items(self._socket_items)
            self._form.set_data(self._pending)
        finally:
            self._loading = was
        self._refresh_title()

    # ---------------------------------------------------------------- 外部
    def set_socket_items(self, items: list[tuple[str, str]]) -> None:
        self._socket_items = list(items)
        if self._built:
            self._form.set_socket_items(self._socket_items)

    def set_data(self, light: object) -> None:
        """`None` / 非 dict = 这个挂件没有自带灯。配了灯就当场建控件并展开。"""
        self._pending = copy.deepcopy(light) if isinstance(light, dict) else None
        if self._pending is not None:
            self.ensure_built()
            self._section.set_expanded(True)
        if self._built:
            self._fill()
        self._refresh_title()

    def dump(self) -> dict | None:
        """`None` = **不写 `light` 键**。没展开过 ⇒ 原样回吐载入值。"""
        if not self._built:
            return copy.deepcopy(self._pending)
        if not self._on.isChecked():
            return None
        return self._form.dump()


class PropStateLightField(QWidget):
    """状态里的 `light`：**三态**（沿用基础块 / 这个状态没有灯 / 这个状态自己一盏）。

    做成勾选框就配不出中间那一档，而"灭了的火把"正是这个特性的主要用例。
    """

    changed = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._loading = False
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self._mode = QComboBox(self)
        self._mode.addItem("沿用基础块那盏（不写 light 键）", STATE_LIGHT_INHERIT)
        self._mode.addItem("这个状态没有灯（light: null，火把灭了）", STATE_LIGHT_NONE)
        self._mode.addItem("这个状态自己一盏（逐字段盖在基础块上）", STATE_LIGHT_OWN)
        self._mode.setMaximumWidth(330)
        self._mode.setToolTip(
            "三档，运行时语义各不相同：\n"
            "· 不写 light 键 = 沿用基础块那盏；\n"
            "· light: null  = **这个状态没有灯**（火把灭了）；\n"
            "· light: {...} = 逐字段盖在基础块那盏上（只写要变的那几项）。")
        self._mode.currentIndexChanged.connect(self._on_mode_changed)
        lay.addWidget(self._mode)
        self._form = PropLightForm(self)
        self._form.changed.connect(self._emit)
        self._form.setVisible(False)
        lay.addWidget(self._form)

    def _emit(self, *_a: object) -> None:
        if self._loading:
            return
        self.changed.emit()

    def _on_mode_changed(self, *_a: object) -> None:
        self._form.setVisible(self._mode.currentData() == STATE_LIGHT_OWN)
        _relayout_up(self._form, self)
        self._emit()

    def set_socket_items(self, items: list[tuple[str, str]]) -> None:
        self._form.set_socket_items(items)

    def set_data(self, state: dict | None) -> None:
        """按 `'light' in state` 判三档（`null` 与"没写"绝不能混）。"""
        was = self._loading
        self._loading = True
        try:
            raw = (state or {})
            if "light" not in raw:
                mode = STATE_LIGHT_INHERIT
                light = None
            elif raw.get("light") is None:
                mode = STATE_LIGHT_NONE
                light = None
            else:
                mode = STATE_LIGHT_OWN
                light = raw.get("light")
            idx = self._mode.findData(mode)
            self._mode.setCurrentIndex(idx if idx >= 0 else 0)
            self._form.setVisible(mode == STATE_LIGHT_OWN)
            self._form.set_data(light)
        finally:
            self._loading = was

    def write_into(self, out: dict) -> None:
        """按档位写键。沿用档 = **什么都不写**（不是写 null）。"""
        mode = self._mode.currentData()
        if mode == STATE_LIGHT_NONE:
            out["light"] = None
        elif mode == STATE_LIGHT_OWN:
            out["light"] = self._form.dump()


class PropStateVfxField(QWidget):
    """状态里的 `vfx`：**三态**（沿用基础块 / 这个状态没有效果 / 指定一串）。

    运行时是**整体替换**而不是并上去（`resolvePropAttach` 的 `st?.vfx ?? preset?.vfx`），
    所以"空数组"是有意义的值（这个状态什么效果都不放），与"没写"不同。
    """

    changed = Signal()

    def __init__(self, model: Any, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._loading = False
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self._mode = QComboBox(self)
        self._mode.addItem("沿用基础块那串（不写 vfx 键）", STATE_VFX_INHERIT)
        self._mode.addItem("这个状态没有效果（vfx: []）", STATE_VFX_NONE)
        self._mode.addItem("这个状态自己一串（整体替换）", STATE_VFX_OWN)
        self._mode.setMaximumWidth(330)
        self._mode.setToolTip(
            "三档：不写 = 沿用基础块那串；空数组 = 这个状态什么都不放（灭了的火把）；\n"
            "给一串 = **整体替换**基础块那串（不是并上去）。")
        self._mode.currentIndexChanged.connect(self._on_mode_changed)
        lay.addWidget(self._mode)
        self._list = VfxIdListField(model, [], self)
        self._list.changed.connect(self._emit)
        self._list.setVisible(False)
        lay.addWidget(self._list)

    def _emit(self, *_a: object) -> None:
        if self._loading:
            return
        self.changed.emit()

    def _on_mode_changed(self, *_a: object) -> None:
        self._list.setVisible(self._mode.currentData() == STATE_VFX_OWN)
        _relayout_up(self._list, self)
        self._emit()

    def reload_refs(self) -> None:
        self._list.reload_refs()

    def set_data(self, state: dict | None) -> None:
        was = self._loading
        self._loading = True
        try:
            raw = (state or {})
            if "vfx" not in raw:
                mode = STATE_VFX_INHERIT
                ids: list = []
            else:
                v = raw.get("vfx")
                ids = [x for x in v if isinstance(x, str) and x.strip()] if isinstance(v, list) else []
                mode = STATE_VFX_OWN if ids else STATE_VFX_NONE
            idx = self._mode.findData(mode)
            self._mode.setCurrentIndex(idx if idx >= 0 else 0)
            self._list.setVisible(mode == STATE_VFX_OWN)
            self._list.set_ids(ids)
        finally:
            self._loading = was

    def write_into(self, out: dict) -> None:
        mode = self._mode.currentData()
        if mode == STATE_VFX_NONE:
            out["vfx"] = []
        elif mode == STATE_VFX_OWN:
            out["vfx"] = self._list.to_list()


class PropStatesEditor(QWidget):
    """状态表（`PropPresetDef.states` + `defaultState`）的**嵌套主从列表**。

    左列状态名、右侧那个状态的表单。状态名是"定义自身新 id"——选择器铁律的明文例外，
    所以走裸输入框（`QInputDialog`）是合法的。

    ## 键序有语义

    `resolvePropStateName` 在没有 `defaultState` 时取 `states` 的**第一个键**，
    所以顺序是数据的一部分 ⇒ 按 list_affordances 必须给上移/下移，且往返必须保序。

    ## commit-on-leave

    切状态之前先把当前表单提交回暂存（editor-data-sync-paradigm 契约 3）。
    不提交就是"编辑完直接点下一个状态，刚填的东西静默消失"——这条是那张卡里
    点名的惯性破口（"切条目"正是清脏的离开路径之一）。
    """

    changed = Signal()

    def __init__(self, model: Any, on_changed: Callable[[], None] | None = None,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._on_changed = on_changed
        self._loading = False
        self._built = False
        #: 暂存：状态名 → 状态 dict（键序 = 落盘顺序）。未展开时它就是磁盘原值的深拷贝。
        self._states: dict[str, dict] = {}
        #: 磁盘上不是 dict 的条目（显式原样透传标记，见 set_data）
        self._bad: dict[str, Any] = {}
        self._raw_order: list[str] = []
        self._default_state: str = ""
        self._current: str = ""
        self._socket_items: list[tuple[str, str]] = []

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self._section = CollapsibleSection("状态表（没有状态）", start_open=False)
        self._section.set_header_tool_tip(
            "一支火把有好几副样子：点着 / 护火 / 残炭 / 灭。\n"
            "每个状态**覆盖**基础块的贴图 / 灯 / 效果，只写要变的那几项；\n"
            "动作 `setPropState` 只切状态名，渐变与闪烁由运行时算。\n"
            "⚠ 不写 defaultState 时，挂上用的是这里的**第一个**状态（所以顺序有意义）。")
        self._section.expanded_changed.connect(self._on_expanded)
        self._body = QWidget()
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        self._body_layout.setSpacing(4)
        self._section.add_body(self._body)
        outer.addWidget(self._section)

    # ---------------------------------------------------------------- 懒建
    def _on_expanded(self, on: bool) -> None:
        if on:
            self.ensure_built()

    def ensure_built(self) -> None:
        if self._built:
            return
        self._built = True
        self._loading = True
        try:
            self._build_body()
        finally:
            self._loading = False
        self._body.show()
        _relayout_up(self._body, self)
        self._refresh_list(keep=self._current)

    def _build_body(self) -> None:
        from PySide6.QtWidgets import QLineEdit  # 局部导入：只有这一处用得上

        top = QWidget(self._body)
        tf = compact_form(QFormLayout(top))
        self._default_combo = QComboBox(top)
        self._default_combo.setMaximumWidth(240)
        self._default_combo.setToolTip(
            "挂上时的初始状态名。不选 = 取状态表的第一个键。\n"
            "⚠ 填了一个**不存在**的状态名，运行时 `resolvePropStateName` 返回空串，"
            "调用方据此报警而不是静默挑一个（校验器会报 error）。")
        self._default_combo.currentIndexChanged.connect(self._on_default_changed)
        tf.addRow("初始状态", self._default_combo)
        self._body_layout.addWidget(top)

        split = QWidget(self._body)
        sl = QHBoxLayout(split)
        sl.setContentsMargins(0, 0, 0, 0)
        sl.setSpacing(6)

        left = QWidget(split)
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        ll.setSpacing(2)
        self._list = QListWidget(left)
        self._list.setMaximumWidth(150)
        self._list.setMinimumHeight(120)
        self._list.currentTextChanged.connect(self._on_select)
        ll.addWidget(self._list)
        btn_row = QWidget(left)
        bl = QHBoxLayout(btn_row)
        bl.setContentsMargins(0, 0, 0, 0)
        bl.setSpacing(2)
        for text, tip, slot in (
            ("＋", "新建一个状态（自己起名，本预设内唯一）", self._on_new),
            ("改名", "改状态名；全工程 setPropState 的引用不会自动跟随，改完自己查一遍", self._on_rename),
            ("−", "删除这个状态", self._on_delete),
            ("↑", "上移（不写 defaultState 时第一个就是初始状态）", lambda: self._move(-1)),
            ("↓", "下移", lambda: self._move(1)),
        ):
            b = QPushButton(text, btn_row)
            b.setToolTip(tip)
            b.setMaximumWidth(44)
            b.clicked.connect(slot)
            bl.addWidget(b)
        ll.addWidget(btn_row)
        left.setMaximumWidth(160)
        sl.addWidget(left)

        self._detail = QWidget(split)
        df = compact_form(QFormLayout(self._detail))
        self._st_name = QLabel("", self._detail)
        df.addRow("状态名", self._st_name)
        self._st_label = QLineEdit(self._detail)
        self._st_label.setMaximumWidth(220)
        self._st_label.setPlaceholderText("如：点着")
        self._st_label.setToolTip("只给编辑器列表看的人类名字，运行时不用（留空不写键）。")
        self._st_label.textChanged.connect(self._emit_field)
        df.addRow("显示名", self._st_label)
        from ..shared.image_path_picker import CutsceneImagePathRow
        from ..shared.socket_image_list import SocketImageListField
        self._st_image = CutsceneImagePathRow(
            self._model, "", self._detail, external_copy_subdir="props",
            external_copy_hint="项目外图片会复制到 resources/runtime/images/props/",
        )
        self._st_image.setToolTip("这个状态的单张贴图。留空 = 沿用基础块那张。")
        self._st_image.changed.connect(self._emit_field)
        df.addRow("贴图", self._st_image)
        self._st_images = SocketImageListField(self._model, [], self._detail)
        self._st_images.setToolTip(
            "这个状态的多帧贴图（挂点标注里的 frame 选第几张）。空 = 沿用基础块。")
        self._st_images.changed.connect(self._emit_field)
        df.addRow("帧贴图", self._st_images)

        self._st_nums: dict[str, OptionalNumField] = {}
        for key, label, lo, hi, step, dec, seed, tip in (
            ("anchorX", "支点 x", 0.0, 1.0, 0.01, 4, 0.5,
             "覆盖基础块的支点 x（0..1，贴图内归一化）。不勾 = 沿用基础块。"),
            ("anchorY", "支点 y", 0.0, 1.0, 0.01, 4, 0.5,
             "覆盖基础块的支点 y。不勾 = 沿用基础块。"),
            ("rotation", "自转", -360.0, 360.0, 1.0, 4, 0.0,
             "覆盖基础块的自转（度）。不勾 = 沿用基础块。"),
            ("scale", "缩放", 0.0, 1000.0, 0.05, 4, 1.0,
             "覆盖基础块的缩放。⚠ ≤0 会被运行时当没填。不勾 = 沿用基础块。"),
        ):
            f = OptionalNumField(lo, hi, step, dec, seed=seed, parent=self._detail)
            f.set_tool_tip(tip)
            f.changed.connect(self._emit_field)
            self._st_nums[key] = f
            df.addRow(label, f)

        self._st_lit = TristateBoolCombo(tristate_rows(
            "（沿用基础块）", "吃场景光照", "不吃光（自发光，如火苗）"), self._detail)
        self._st_lit.setToolTip(
            "运行时缺省是「吃光」，所以「不设」必须与「设成 false」分得开 ⇒ 三态。\n"
            "不设 = 不写 lit 键（沿用基础块 / 运行时缺省）。")
        self._st_lit.currentIndexChanged.connect(self._emit_field)
        df.addRow("光照", self._st_lit)

        self._st_light = PropStateLightField(self._detail)
        self._st_light.changed.connect(self._emit_field)
        df.addRow("灯", self._st_light)

        self._st_vfx = PropStateVfxField(self._model, self._detail)
        self._st_vfx.changed.connect(self._emit_field)
        df.addRow("效果", self._st_vfx)

        sl.addWidget(self._detail, 1)
        self._body_layout.addWidget(split)

    # ---------------------------------------------------------------- 内部
    def _emit(self) -> None:
        if self._loading:
            return
        self._refresh_title()
        self.changed.emit()
        if self._on_changed:
            self._on_changed()

    def _emit_field(self, *_a: object) -> None:
        """表单里改了东西：先落回暂存，再对外标脏。"""
        if self._loading:
            return
        self._commit_current()
        self._emit()

    def _refresh_title(self) -> None:
        n = len(self._states)
        if n == 0:
            self._section.set_title("状态表（没有状态）")
            return
        first = next(iter(self._states), "")
        init = self._default_state or first
        self._section.set_title(f"状态表：{n} 个状态，初始「{init}」")

    def _commit_current(self) -> None:
        """把右侧表单写回暂存（commit-on-leave 与 flush 共用这一条）。"""
        if not self._built or not self._current:
            return
        orig = self._states.get(self._current)
        orig = orig if isinstance(orig, dict) else None
        out: dict[str, Any] = {}
        # 表单不认识的键原样透传（将来给 PropStateDef 加字段不会被吞掉）
        for k, v in (orig or {}).items():
            if k not in STATE_KEYS:
                out[k] = copy.deepcopy(v)
        label = self._st_label.text().strip()
        if label:
            out["label"] = label
        img = self._st_image.path().strip()
        if img:
            out["image"] = img
        imgs = self._st_images.to_list()
        if imgs:
            out["images"] = imgs
        for key, field in self._st_nums.items():
            v = field.value()
            if v is not None:
                out[key] = v
        lit = self._st_lit.value()
        if lit is not None:
            out["lit"] = lit
        self._st_light.write_into(out)
        self._st_vfx.write_into(out)
        preserve_numeric_repr(out, orig)
        self._states[self._current] = reorder_like(out, orig)

    def _refresh_list(self, keep: str = "") -> None:
        if not self._built:
            return
        was = self._loading
        self._loading = True
        try:
            self._list.clear()
            for name in self._states:
                self._list.addItem(str(name))
            self._refresh_default_combo()
        finally:
            self._loading = was
        want = keep if keep in self._states else ""
        if want:
            items = self._list.findItems(want, self._list_match())
            if items:
                self._list.setCurrentItem(items[0])
                return
        if self._list.count() > 0:
            self._list.setCurrentRow(0)
        else:
            self._current = ""
            self._fill_detail()
        self._refresh_title()

    @staticmethod
    def _list_match():
        from PySide6.QtCore import Qt
        return Qt.MatchFlag.MatchExactly

    def _refresh_default_combo(self) -> None:
        cur = self._default_state
        self._default_combo.clear()
        self._default_combo.addItem("（取第一个状态）", "")
        for name in self._states:
            self._default_combo.addItem(str(name), str(name))
        idx = self._default_combo.findData(cur)
        if idx < 0 and cur:
            # 悬垂 defaultState：保值展示（标出来），绝不静默清空或顶替成第一项
            self._default_combo.addItem(f"{cur}  ⚠ 状态表里没有这个状态", cur)
            idx = self._default_combo.count() - 1
        self._default_combo.setCurrentIndex(idx if idx >= 0 else 0)

    def _on_default_changed(self, *_a: object) -> None:
        if self._loading:
            return
        self._default_state = str(self._default_combo.currentData() or "")
        self._emit()

    def _on_select(self, name: str) -> None:
        if self._loading:
            return
        # commit-on-leave：切走之前先把上一条落回暂存
        self._commit_current()
        self._current = str(name or "")
        self._fill_detail()

    def _fill_detail(self) -> None:
        if not self._built:
            return
        st = self._states.get(self._current)
        st = st if isinstance(st, dict) else {}
        was = self._loading
        self._loading = True
        try:
            self._st_name.setText(self._current or "（无选中）")
            self._detail.setEnabled(bool(self._current))
            self._st_label.setText(str(st.get("label", "") or ""))
            self._st_label.setCursorPosition(0)
            self._st_image.set_path(str(st.get("image", "") or ""))
            imgs = st.get("images")
            self._st_images.set_paths(imgs if isinstance(imgs, list) else [])
            for key, field in self._st_nums.items():
                field.set_value(st.get(key))
            self._st_lit.set_value(st.get("lit") if "lit" in st else None)
            self._st_light.set_socket_items(self._socket_items)
            self._st_light.set_data(st)
            self._st_vfx.set_data(st)
        finally:
            self._loading = was

    def _on_new(self) -> None:
        from PySide6.QtWidgets import QInputDialog, QMessageBox
        # 状态名是"定义自身新 id"——选择器铁律的明文例外，裸输入框在此合法
        name, ok = QInputDialog.getText(self, "新建状态", "状态名（如 lit / guard / ember / out）：")
        key = (name or "").strip()
        if not ok or not key:
            return
        if key in self._states:
            QMessageBox.warning(self, "状态表", f"状态「{key}」已存在。")
            return
        self._commit_current()
        self._states[key] = {}
        self._current = key
        self._refresh_list(keep=key)
        self._emit()

    def _on_rename(self) -> None:
        from PySide6.QtWidgets import QInputDialog, QMessageBox
        old = self._current
        if not old:
            return
        name, ok = QInputDialog.getText(self, "改名", "新状态名：", text=old)
        key = (name or "").strip()
        if not ok or not key or key == old:
            return
        if key in self._states:
            QMessageBox.warning(self, "状态表", f"状态「{key}」已存在。")
            return
        self._commit_current()
        # 保持键序：改名不该把条目挪到末尾
        self._states = {(key if k == old else k): v for k, v in self._states.items()}
        if self._default_state == old:
            self._default_state = key
        self._current = key
        self._refresh_list(keep=key)
        self._emit()

    def _on_delete(self) -> None:
        from PySide6.QtWidgets import QMessageBox
        key = self._current
        if not key:
            return
        msg = f"删除状态「{key}」？"
        if self._default_state == key:
            msg += "\n\n它是初始状态；删掉之后初始状态会回到「取第一个状态」。"
        if QMessageBox.question(self, "状态表", msg) != QMessageBox.StandardButton.Yes:
            return
        self._states.pop(key, None)
        if self._default_state == key:
            self._default_state = ""
        self._current = ""
        self._refresh_list()
        self._emit()

    def _move(self, delta: int) -> None:
        key = self._current
        if not key or key not in self._states:
            return
        self._commit_current()
        names = list(self._states)
        i = names.index(key)
        j = i + delta
        if j < 0 or j >= len(names):
            return
        names[i], names[j] = names[j], names[i]
        self._states = {n: self._states[n] for n in names}
        self._refresh_list(keep=key)
        self._emit()

    # ---------------------------------------------------------------- 外部
    def set_socket_items(self, items: list[tuple[str, str]]) -> None:
        self._socket_items = list(items)
        if self._built:
            self._st_light.set_socket_items(self._socket_items)

    def reload_refs(self) -> None:
        if self._built:
            self._st_vfx.reload_refs()

    def set_data(self, states: object, default_state: object) -> None:
        """从预设载入。配了状态表就当场建控件并展开（折着看不见等于没接进来）。"""
        src = states if isinstance(states, dict) else {}
        self._states = {str(k): copy.deepcopy(v) for k, v in src.items()
                        if isinstance(v, dict)}
        # 坏元素（`states` 里塞了个 null / 数组）：**显式**标成原样透传，绝不当成一行正常
        # 数据往表单里读（读表时去取一个并不存在的控件会抛，主窗兜底把整页记进跳过集，
        # 于是这一页的全部编辑静默不落盘——shared-widget-value-fidelity 契约 5）。
        self._bad = {str(k): copy.deepcopy(v) for k, v in src.items()
                     if not isinstance(v, dict)}
        self._raw_order = [str(k) for k in src]
        self._default_state = str(default_state or "").strip()
        self._current = ""
        if self._states or self._default_state:
            self.ensure_built()
            self._section.set_expanded(True)
        if self._built:
            self._refresh_list()
        self._refresh_title()

    def state_names(self) -> list[str]:
        """当前状态名（暂存顺序；试挂预览的状态下拉用）。"""
        return list(self._states)

    def state_data(self, name: str) -> dict:
        """一个状态的**当前暂存值**（含右侧表单里还没落回的那一条）。"""
        if self._built and name and name == self._current:
            self._commit_current()
        st = self._states.get(str(name or ""))
        return dict(st) if isinstance(st, dict) else {}

    def dump(self) -> tuple[dict | None, str]:
        """`(states 或 None, defaultState)`。`None` = **不写 `states` 键**。

        没展开过 ⇒ 原样回吐载入时的深拷贝（一个字节都不经过 Qt 控件）。
        """
        if self._built:
            self._commit_current()
        if not self._bad:
            out: dict[str, Any] = {k: copy.deepcopy(v) for k, v in self._states.items()}
            return (out or None), self._default_state
        # 有坏元素时按**磁盘原序**重建（坏元素没有列表行，上下移动动不到它，
        # 拿当前顺序拼会把它挤到末尾 = 往返改字节）。新增的状态追加在后。
        out = {}
        for k in self._raw_order:
            if k in self._bad:
                out[k] = copy.deepcopy(self._bad[k])
            elif k in self._states:
                out[k] = copy.deepcopy(self._states[k])
        for k, v in self._states.items():
            if k not in out:
                out[k] = copy.deepcopy(v)
        return (out or None), self._default_state


def _relayout_up(start: QWidget, stop: QWidget) -> None:
    """自内向外逐层刷新几何。

    中间层不 invalidate，外层行高就冻在旧 sizeHint —— 症状是整行被压成一条缝，
    而 model 层测试与构造冒烟全绿也照样漏（见 editor-change-verification-gate「布局塌陷」）。
    """
    w: QWidget | None = start
    while w is not None:
        lay = w.layout()
        if lay is not None:
            lay.invalidate()
            lay.activate()
        w.updateGeometry()
        if w is stop:
            break
        w = w.parentWidget()
