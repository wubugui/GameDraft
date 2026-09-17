"""挂件预设页的重块（火焰 / 自带光源 / 效果 / 状态表）的控件。

2026-09-15 燃烧物契约加了「火焰」块（基础块 `firePoint` / `flame` / `burn`，`PropFireBlock`）
与状态表里的起火点覆盖 / burn / 进入时动作 `onEnterActions`（复用物件用途同款 `ActionEditor`）。
这几项的"没动过就回吐磁盘原值"一律走各字段的 `is_untouched()`：运行时自己清洗坏值，
编辑器不替它"修"数据；`ActionEditor` 会 materialize 空参数，所以进入动作走种子快照。

## 为什么单独一个模块

`prop_preset_editor.py` 原本只管"贴图 + 支点 + 缩放"三件事。手持光源（2026-09-12）
一次性给它加了四组语义完全不同的数据（`light` / 自带效果 / `persistent` / `states`；
自带效果 2026-09-15 契约 v3 起是粒子挂载 `particles`，取代旧 `vfx`），
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
而"灭了"是火把这个特性的**主要用例**。`particles` 是两态但同一个道理（不写=沿用 /
写了=整体替换，`[]`=没有粒子），`lit` 是三态（不写=沿用 / true / false）——运行时缺省非 false 的
可选 bool 一律走三态，照 `playNpcAnimation.loop` 的惯例。

## 往返保真

- 未改动的数值按磁盘原始表示回写（`preserve_numeric_repr` + 逐元素的 `offset`/`color`）；
- `QDoubleSpinBox` 会**量化**（`decimals` 截断），量化后数值已不相等、`preserve_numeric_repr`
  兜不住 ⇒ 另加**种子快照法**（样板 `anim_editor` / `light_follow_ui`）：载入时记下截断后的
  种子，保存时控件仍等于种子就回吐磁盘原字面值；
- 表单不认识的键**原样透传**（将来给 `PropLightDef` 加字段不会被吞掉）；
- `flicker` 两种写法（2026-09-15）：物理 `{kind: flame|ember, diameter, puffAmp?}` / 正弦 `{amp, hz, windAmp?}`，
  由「种类」下拉切；闪烁那一片控件整块没动过 ⇒ 原样回吐磁盘那块（坏值、残留键不改），
  动过 ⇒ 只写当前种类读的键（切种类 = 删掉另一种的键），flicker 里表单不认识的键照样透传；
- 键序按磁盘原序，只有新增键才追加；
- **重块默认折叠且懒建**：没展开过的块 `dump()` 直接回吐载入时的深拷贝，
  一个字节都不经过 Qt 控件（既省控件数，也是往返保真最硬的一道）。

## 风吹灭 / 玩家操作（2026-09-15）

- `blowout`（`PropBlowoutDef`）：基础块一块「风吹灭」（`PropBlowoutBlock`，不勾 = 不写键 = 吹不灭）；
  状态里是**三态**（`PropStateBlowoutField`：沿用基础块 / `null` 这个状态吹不灭 / 自己的一块整块替换）——
  与 `light` 同一个道理，做成两态就配不出"这个状态吹不灭"。两处共用一个表单 `PropBlowoutForm`，
  越线动作 `onEmberActions` / `onOutActions` 与状态进入动作同款 `ActionEditor` + 种子快照。
  风吹灭表单里的「挡风复燃回到」`recoverState`：残炭里挡住风、火势回到残炭线上方时复燃回哪个状态（不写 = lit）。
- `playerControl`：只在基础块（`PropPlayerControlBlock`，写了对象 = 玩家能用 T / V 操作）；
  「快灭提示线」`hintBelow` 0..1（火势掉到这以下火边出快灭符号，残炭时一直出；0 = 不提示；不写 = 0.8）。
- 两块里的状态名下拉（`OptionalStateNameCombo`）候选 = 这个预设自己的状态名，悬垂名字保值展示。

## 能点火（2026-09-16，燃烧系统 A3.8）

- `igniter`（`PropIgniterDef`）：基础块「能点火」（`PropIgniterBlock`，勾 = 写对象，`{}` 全用缺省；不勾 = 不写键 = 点不了），
  可选火焰长度 `flameLength`（厘米，只管引燃判定够得着多远）；状态里三态（`PropStateIgniterField`：沿用基础块 /
  `null` 这个状态点不了 / 自己的一块整块替换），与 `blowout` 同构，两处共用表单 `PropIgniterForm`。
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
    QLineEdit,
    QListWidget,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..shared.collapsible_section import CollapsibleSection
from ..shared.form_layout import compact_form, compact_icon_button, fit_width_cap
from ..shared.id_ref_selector import IdRefSelector
from ..shared.num_fields import float_or
from ..shared.numeric_roundtrip import preserve_numeric_repr
from ..shared.widget_discard import discard_widget

#: `PropLightDef` 里表单管着的键。其余键一律原样透传。
LIGHT_KEYS = (
    "socket", "offset", "kelvin", "color", "intensity",
    "range", "softeningRadius", "castShadow", "flicker",
)
#: 一支火把最多挂几块效果（TS `propPresets.ts::PROP_EFFECTS_MAX`）。**不在这里拦**，只提示 +
#: 校验器报 error —— 拦下来就配不出"先删一块再换一块"，而保值优先于纠错。
PROP_EFFECTS_MAX_HINT = 2

#: `PropStateDef` 里表单管着的键。其余键一律原样透传。
STATE_KEYS = (
    "label", "image", "images", "anchorX", "anchorY", "rotation", "scale",
    "lit", "light", "particles", "firePoint", "burn", "windShelter", "onEnterActions", "blowout", "igniter",
)

#: 挡风比例的说明（基础块与状态两处共用一份，写两遍必然发散）
WIND_SHELTER_TIP = (
    "挡风比例 0..1：帧动画火苗倾斜的气流，**以及这个状态全部粒子挂载吃的场景风**，都乘 (1 − 挡风)。\n"
    "**护火**就是它——侧身、手拢着，火苗吃到的风少了、立起来了（0.8 = 挡掉八成风）。\n"
    "⚠ **不改灯**的数值：正弦闪烁（灯笼）对风多敏感仍由「自带光源 → 闪烁 → 吃风」管，不吃挡风；\n"
    "但**物理闪烁**（明火 / 炭火）读的气流是挡过风的——护火 ⇒ 明火灯亮回来、炭火灯没那么旺。\n"
)
#: 燃烧强度的说明（基础块与状态两处共用一份）
BURN_TIP = (
    "燃烧强度 0..1：帧动画火苗的高度，**以及这个状态全部粒子挂载**的发射率与新生粒子大小（burn^0.4，闪烁再让它一胀一缩）。\n"
    "0 = 火苗不画、粒子不再发（在飞的自然烧完）。setPropState 的 fadeMs 让它与灯强度同一个钟渐变。\n"
    "用法：**复用点着那团火、只是烧得弱**的状态才调它（护火 = 同一个火焰效果 × 0.75）；\n"
    "自己挂了专门效果的状态（残炭、熄灭那口烟）burn 留缺省 1——那种状态写 0 = 它自己的效果一个粒子都不发。\n"
    "⚠ **不改灯**：灯的亮度在「自带光源」/ 状态的「灯」里配。\n"
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
#: 物理闪烁的缺省：火把头直径 10 cm；明火"喘"的幅度不写 = 运行时缺省 0.1（`PropFlickerPhysicalDef`）
FLICKER_PHYSICAL_DEFAULTS: dict[str, float] = {"diameter": 0.1, "puffAmp": 0.1}

#: 闪烁「种类」下拉的档位。物理两档的值就是落盘的 `kind`；
#: 正弦 = **不写 `kind`**（老写法）；RAW = 磁盘上 `kind` 是运行时不认的值，保值展示（不落盘的标记）。
FLICKER_KIND_FLAME = "flame"
FLICKER_KIND_EMBER = "ember"
FLICKER_KIND_SINE = "sine"
FLICKER_KIND_RAW = "__raw__"
FLICKER_PHYSICAL_KINDS = (FLICKER_KIND_FLAME, FLICKER_KIND_EMBER)
#: `flicker` 对象里表单管着的键（两种写法合起来）。其余键原样透传。
#: 切种类 = 写上这一种的键、删掉另一种的键（运行时写了 kind 就不读 amp/hz/windAmp）。
FLICKER_FORM_KEYS = ("kind", "diameter", "puffAmp", "amp", "hz", "windAmp")
#: 「种类」下拉的说明
FLICKER_KIND_TIP = (
    "闪烁怎么算（运行时 `parsePropLight` 按 kind 分两种写法）：\n"
    "· 明火（物理）：自己按 f = 1.5/√D「喘」（10 cm ≈ 4.7 Hz，慢长快塌），风速压过 √(gD) 喘就被压住；\n"
    "  风把火吹短 ⇒ 亮度 ∝ 风速^−0.21，跟着阵风起落。填的亮度是无风时的：风大火暗，护火（挡风）亮回来。\n"
    "· 炭火（物理）：不喘，风一吹更亮（强制对流传质）。\n"
    "· 正弦（老写法）：自己填幅度 / 频率 / 吃风。\n"
    "气流 = 火把处的场景风 − 人走动，× (1 − 挡风)。\n"
    "切种类 = 写上这一种的键、删掉另一种的键（kind/diameter/puffAmp ↔ amp/hz/windAmp）。\n"
    "⚠ 灯笼（正弦）是逐项调过的，别改它的种类。"
)


def flicker_problems(flk: object) -> list[str]:
    """一块 `flicker` 运行时会被怎么静默处理（给表单底下那行红字；口径同 `parsePropLight`）。"""
    from ..shared.prop_preview import ABSENT, js_number

    if not isinstance(flk, dict):
        return []
    if flk.get("kind") in FLICKER_PHYSICAL_KINDS:
        d = js_number(flk.get("diameter", ABSENT))
        if d is None or d <= 0:
            return ["燃烧面直径必须 > 0，否则整块 flicker 被丢掉（灯不闪）。"]
        return []
    bad: list[str] = []
    if "kind" in flk:
        bad.append(f"闪烁种类 {flk.get('kind')!r} 运行时不认，按正弦老写法解析。")
    amp = js_number(flk.get("amp", ABSENT))
    hz = js_number(flk.get("hz", ABSENT))
    if amp is None or hz is None or amp <= 0 or hz <= 0:
        bad.append("闪烁的幅度与频率必须同时 > 0，否则整块 flicker 被丢掉（灯不闪）。")
    return bad

#: 三态可选 bool 的档位（与 `attachToSocket.mirror/lit` 的三态惯例同形）。
TRISTATE_INHERIT = ""
TRISTATE_TRUE = "true"
TRISTATE_FALSE = "false"

#: 状态里 `light` 的三档（值是内部标记，不落盘）。
STATE_LIGHT_INHERIT = "inherit"
STATE_LIGHT_NONE = "none"
STATE_LIGHT_OWN = "own"

#: 状态里 `particles` 的两档（值是内部标记，不落盘）。
STATE_PARTICLES_INHERIT = "inherit"
STATE_PARTICLES_OWN = "own"

#: 「不写这个键」的哨兵（⚠ 不能深拷贝：deepcopy(object()) 造出新对象，`is _MISSING` 就认不出来）
_MISSING = object()

#: 粒子挂载的说明（基础块与状态两处共用一份）
PARTICLES_TIP = (
    "粒子挂载：把粒子效果（火焰、火星、余烟…）挂在贴图上的点（杆头、杆腰都行），\n"
    "跟着挂件的支点 / 自转 / 缩放 / 镜像走。挂点不写 = 起火点，再没有 = 挂点本身。\n"
    "「燃烧 burn」乘在这个状态**全部**粒子挂载的发射率与新生粒子大小（burn^0.4）上，\n"
    "「挡风」让它们吃场景风打折——自带专门效果的状态（残炭、熄灭那口烟）burn 留缺省 1。\n"
    "效果资产本身在粒子工作台里做；火焰的声音住在效果资产自己的 sound.loop 里。\n"
)


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
        # 上限不许低于「最长那一项画得下的宽度」：三态的第一项常常是一整句
        #（「沿用缺省（不写 = true：只能走）」），钉死 240 就把后半句切没了。
        fit_width_cap(self, 240)

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
        check_label: str = "覆盖",
        check_tip: str = "不勾 = 不写这个键（沿用基础块 / 运行时缺省）。",
    ) -> None:
        super().__init__(parent)
        self._seed_default = seed
        self._quant_seed: float | None = None
        self._original: Any = None
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        self._on = QCheckBox(check_label, self)
        self._on.setToolTip(check_tip)
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
        self._seed_checked = has

    def is_untouched(self) -> bool:
        """控件仍停在载入时的样子（勾选与数值都没变）。

        宿主据此把**磁盘原值**原样回吐——包括 `value()` 表达不了的形态
        （键存在但值是 `"1"` / `null` 这类坏值：不勾 = 不写键，会把它抹掉）。
        """
        return (self._on.isChecked() == getattr(self, "_seed_checked", False)
                and self._spin.value() == self._quant_seed)

    def state(self) -> tuple[bool, float]:
        """控件此刻的样子（勾没勾、数值），给宿主拍"整块没动过"的快照用。"""
        return (self._on.isChecked(), self._spin.value())

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


class OptionalIntField(QWidget):
    """可选整数（火苗图集的列数 / 帧数）：勾选框决定写不写键，写出来**恒为 int**。

    `OptionalNumField` 走 QDoubleSpinBox，改过的值会落成 `12.0`——列数、帧数是整数语义，
    落成浮点既是格式噪音，也会让运行时 trunc 前后的口径在人眼里对不上。
    """

    changed = Signal()

    def __init__(self, lo: int, hi: int, *, seed: int = 1, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        from PySide6.QtWidgets import QSpinBox

        self._seed_default = seed
        self._original: Any = None
        self._seed_state: tuple[bool, int] = (False, seed)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        self._on = QCheckBox("写", self)
        self._on.setToolTip("不勾 = 不写这个键（走运行时缺省）。")
        self._on.toggled.connect(self._on_toggled)
        lay.addWidget(self._on)
        self._spin = QSpinBox(self)
        self._spin.setRange(lo, hi)
        self._spin.setMaximumWidth(80)
        self._spin.setEnabled(False)
        self._spin.valueChanged.connect(lambda _v: self.changed.emit())
        lay.addWidget(self._spin)
        lay.addStretch(1)

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
        try:
            self._spin.setValue(int(raw) if has else self._seed_default)
        except (OverflowError, ValueError):
            self._spin.setValue(self._seed_default)
        self._seed_state = (has, self._spin.value())

    def is_untouched(self) -> bool:
        return (self._on.isChecked(), self._spin.value()) == self._seed_state

    def value(self) -> Any:
        """`None` = 不写键；没动过且磁盘原值是数 ⇒ 回吐原字面值（`12.5` 不被截成 `12`）。"""
        if not self._on.isChecked():
            return None
        if self.is_untouched() and isinstance(self._original, (int, float)) \
                and not isinstance(self._original, bool):
            return self._original
        return int(self._spin.value())


class OptionalPointField(QWidget):
    """可选的归一化点 `[x, y]`（起火点）：勾选框决定写不写键。

    值域 0..1（贴图归一化，左上原点，与支点同口径）。磁盘上写着越界值 / 多余元素时，
    没动过就原样回吐（运行时自己会夹，编辑器不替它"修"数据）。
    """

    changed = Signal()

    def __init__(
        self, *, check_label: str = "覆盖", seed: tuple[float, float] = (0.5, 0.5),
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._seed_default = seed
        self._original: Any = None
        self._seed_state: tuple[bool, float, float] = (False, seed[0], seed[1])
        self._quiet = False
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(4)
        self._on = QCheckBox(check_label, self)
        self._on.toggled.connect(self._on_toggled)
        lay.addWidget(self._on)
        self._spins: list[QDoubleSpinBox] = []
        for axis in ("x", "y"):
            lay.addWidget(QLabel(axis, self))
            sb = QDoubleSpinBox(self)
            sb.setRange(0.0, 1.0)
            sb.setDecimals(4)
            sb.setSingleStep(0.01)
            sb.setMaximumWidth(80)
            sb.setEnabled(False)
            sb.valueChanged.connect(self._emit)
            lay.addWidget(sb)
            self._spins.append(sb)
        lay.addStretch(1)

    def _emit(self, *_a: object) -> None:
        if not self._quiet:
            self.changed.emit()

    def _on_toggled(self, on: bool) -> None:
        for sb in self._spins:
            sb.setEnabled(on)
        self._emit()

    def set_tool_tip(self, text: str) -> None:
        self.setToolTip(text)
        for sb in self._spins:
            sb.setToolTip(text)

    def set_value(self, raw: Any) -> None:
        from ..shared.prop_preview import parse_fire_point

        self._original = copy.deepcopy(raw)
        pt = parse_fire_point(raw)
        has = pt is not None
        self._quiet = True
        try:
            self._on.setChecked(has)
            for i, sb in enumerate(self._spins):
                sb.setEnabled(has)
                sb.setValue(pt[i] if has else self._seed_default[i])
        finally:
            self._quiet = False
        self._seed_state = (has, self._spins[0].value(), self._spins[1].value())

    def set_point(self, x: float, y: float) -> None:
        """程序化设点（试挂预览上点选）：勾上并写值，只发一次 `changed`。"""
        self._quiet = True
        try:
            self._on.setChecked(True)
            self._spins[0].setValue(float(x))
            self._spins[1].setValue(float(y))
        finally:
            self._quiet = False
        self.changed.emit()

    def is_checked(self) -> bool:
        return self._on.isChecked()

    def point(self) -> tuple[float, float] | None:
        if not self._on.isChecked():
            return None
        return (self._spins[0].value(), self._spins[1].value())

    def is_untouched(self) -> bool:
        return (self._on.isChecked(), self._spins[0].value(), self._spins[1].value()) == self._seed_state

    def value(self) -> Any:
        """`None` = 不写键；没动过 ⇒ 磁盘原值（深拷贝）；动过 ⇒ `[x, y]`（元素按原表示回吐）。"""
        if not self._on.isChecked():
            return None
        if self.is_untouched() and isinstance(self._original, list):
            return copy.deepcopy(self._original)
        orig = self._original if isinstance(self._original, list) else []
        return [
            num_repr_like(round(sb.value(), 4), orig[i] if i < len(orig) else None)
            for i, sb in enumerate(self._spins)
        ]


class ParticleMountListField(QWidget):
    """粒子挂载列表 `[{effect, point?}]`（契约 v3，取代旧 `vfx` 效果 id 列表）。基础块与状态表单共用这一个控件。

    每行 = 效果选择器（`IdRefSelector`，点一下开可搜索弹窗；候选 = `ProjectModel.all_vfx_effect_ids()`，
    与 `playVfx.effect` 同一个 id-provider，**禁裸 QLineEdit**）+ 挂点 x/y（不勾 = 不写 `point`，
    落到起火点 → 挂点本身）+「点选」（在试挂预览上点这一条的挂点）+ 上移 / 下移 / 删。

    ## 往返
    - 每行记着磁盘上那条原对象：不认识的键原样透传、键序按原序；
    - 效果 / 挂点**没动过就回吐原值**（含 `point` 写坏了的形态——运行时自己当没写，编辑器不替它修）；
    - 磁盘上不是对象的坏条目（运行时丢掉）显式成一行只读「(数据) …」原样透传，只能删；
    - 顺序**有意义**（多个效果按序起播、同层叠放），所以给上移 / 下移。
    """

    changed = Signal()
    #: 请求在试挂预览上点选第 i 条的挂点
    pick_requested = Signal(int)

    def __init__(self, model: Any, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        #: 每行：{"kind": "mount"|"bad", "host": 行控件, "orig": 磁盘原值, "sel", "point", "seed_effect"}
        self._rows: list[dict[str, Any]] = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self._rows_layout = QVBoxLayout()
        self._rows_layout.setSpacing(2)
        lay.addLayout(self._rows_layout)
        add = QPushButton("+ 粒子挂载")
        add.setMaximumWidth(140)
        add.setToolTip("挂一个粒子效果（火焰、火星、余烟…）到贴图上的一个点。候选来自 assets/data/vfx/*.json。")
        add.clicked.connect(self._on_add)
        lay.addWidget(add)
        self._empty = QLabel("（没有粒子挂载）", self)
        self._empty.setStyleSheet("color:#888;")
        lay.addWidget(self._empty)

    # ---------------------------------------------------------------- 内部
    def _items(self) -> list[tuple[str, str]]:
        fn = getattr(self._model, "all_vfx_effect_ids", None)
        if not callable(fn):
            return []
        try:
            return list(fn() or [])
        except Exception:  # noqa: BLE001 —— 候选取不到只是少了下拉，不能反噬面板
            return []

    def _on_add(self) -> None:
        self._add_row({}, quiet=False)

    def _add_row(self, raw: Any, *, quiet: bool) -> None:
        host = QWidget(self)
        rl = QHBoxLayout(host)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.setSpacing(4)
        row: dict[str, Any] = {"host": host, "orig": copy.deepcopy(raw)}
        if isinstance(raw, dict):
            row["kind"] = "mount"
            sel = IdRefSelector(host, allow_empty=True, editable=False, click_opens_popup=True)
            sel.setMinimumWidth(160)
            sel.setMaximumWidth(260)
            sel.setToolTip("挂哪个粒子效果（效果资产 id）。空着运行时丢掉这一条。")
            sel.set_items(self._items())
            eff = raw.get("effect")
            sel.set_current(eff.strip() if isinstance(eff, str) else "")
            sel.value_changed.connect(lambda _v: self.changed.emit())
            row["sel"] = sel
            row["seed_effect"] = sel.current_id()
            rl.addWidget(sel, 1)
            pt = OptionalPointField(check_label="挂点", seed=(0.5, 0.1), parent=host)
            pt.set_tool_tip(
                "这个效果挂在贴图上的哪一点（归一化 0..1，左上原点，与支点同口径）。\n"
                "不勾 = 不写 point：落到起火点，再没有就是挂点本身。跟着挂件的支点 / 自转 / 缩放 / 镜像走。")
            pt.set_value(raw.get("point"))
            pt.changed.connect(self.changed.emit)
            row["point"] = pt
            rl.addWidget(pt)
            pick = QPushButton("点选", host)
            pick.setMaximumWidth(48)
            pick.setToolTip("在右侧试挂预览上点这一条的挂点（点完自动勾上「挂点」）。")
            pick.clicked.connect(lambda _c=False, h=host: self._request_pick(h))
            rl.addWidget(pick)
        else:
            row["kind"] = "bad"
            lab = QLabel(f"(数据) {raw!r} —— 不是 {{effect, point}} 对象，运行时丢掉；原样保留", host)
            lab.setStyleSheet("color:#c66;")
            rl.addWidget(lab, 1)
        for text, tip, delta in (("↑", "上移（效果按顺序起播）", -1), ("↓", "下移", 1)):
            b = QPushButton(text, host)
            b.setMaximumWidth(28)
            b.setToolTip(tip)
            b.clicked.connect(lambda _c=False, h=host, d=delta: self._move(h, d))
            rl.addWidget(b)
        rm = QPushButton("−", host)
        rm.setMaximumWidth(28)
        rm.setToolTip("删掉这一条粒子挂载")
        rm.clicked.connect(lambda _c=False, h=host: self._remove(h))
        rl.addWidget(rm)
        self._rows.append(row)
        self._rows_layout.addWidget(host)
        # ⚠ addWidget 之后子控件仍是 isHidden()，隐藏项被布局整个跳过（行高按"零行"算）
        host.show()
        self._sync_empty()
        if not quiet:
            _relayout_up(host, self)
            self.changed.emit()

    def _index_of(self, host: QWidget) -> int:
        for i, r in enumerate(self._rows):
            if r["host"] is host:
                return i
        return -1

    def _request_pick(self, host: QWidget) -> None:
        i = self._index_of(host)
        if i >= 0:
            self.pick_requested.emit(i)

    def _remove(self, host: QWidget) -> None:
        i = self._index_of(host)
        if i < 0:
            return
        row = self._rows.pop(i)
        self._rows_layout.removeWidget(row["host"])
        discard_widget(row["host"])
        self._sync_empty()
        self.changed.emit()

    def _move(self, host: QWidget, delta: int) -> None:
        i = self._index_of(host)
        j = i + delta
        if i < 0 or j < 0 or j >= len(self._rows):
            return
        self._rows[i], self._rows[j] = self._rows[j], self._rows[i]
        self._rows_layout.removeWidget(host)
        self._rows_layout.insertWidget(j, host)
        host.show()
        self.changed.emit()

    def _sync_empty(self) -> None:
        self._empty.setVisible(not self._rows)

    # ---------------------------------------------------------------- 外部
    def set_mounts(self, raw: object) -> None:
        """载入（不发 `changed`）。非数组 = 空列表（宿主自己决定键写不写）。"""
        for row in list(self._rows):
            self._rows_layout.removeWidget(row["host"])
            discard_widget(row["host"])
        self._rows.clear()
        for item in raw if isinstance(raw, list) else []:
            self._add_row(item, quiet=True)
        self._sync_empty()

    def reload_refs(self) -> None:
        """跨面板刷新：粒子工作台新建了效果资产，候选要看得见（当前值保值）。"""
        items = self._items()
        for row in self._rows:
            sel = row.get("sel")
            if sel is not None:
                cur = sel.current_id()
                sel.set_items(items)
                sel.set_current(cur)

    def count(self) -> int:
        return len(self._rows)

    def set_point(self, index: int, x: float, y: float) -> None:
        """试挂预览上点选：写第 index 条的挂点（勾上，发一次 `changed`）。"""
        if 0 <= index < len(self._rows) and self._rows[index].get("point") is not None:
            self._rows[index]["point"].set_point(round(float(x), 4), round(float(y), 4))

    def to_list(self) -> list[Any]:
        out: list[Any] = []
        for row in self._rows:
            orig = row["orig"]
            if row["kind"] == "bad":
                out.append(copy.deepcopy(orig))
                continue
            o = orig if isinstance(orig, dict) else {}
            item: dict[str, Any] = {k: copy.deepcopy(v) for k, v in o.items() if k not in ("effect", "point")}
            eff = row["sel"].current_id().strip()
            if eff == row["seed_effect"] and "effect" in o:
                item["effect"] = copy.deepcopy(o["effect"])
            else:
                item["effect"] = eff
            pt: OptionalPointField = row["point"]
            if pt.is_untouched():
                if "point" in o:
                    item["point"] = copy.deepcopy(o["point"])
            else:
                v = pt.value()
                if v is not None:
                    item["point"] = v
            out.append(reorder_like(item, o))
        return out


class PropParticlesBlock(QWidget):
    """基础块的「粒子挂载」：默认折叠 + 懒建；没展开过 ⇒ `dump()` 原样回吐磁盘上的 `particles`。

    `dump()` 返回 `_MISSING` = 不写 `particles` 键（没写过又没加任何一条）。磁盘上显式写着 `[]`
    的要原样保住（"等于空就删"会改字节）。
    """

    changed = Signal()
    pick_requested = Signal(int)

    def __init__(self, model: Any, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._built = False
        self._loading = False
        self._pending: Any = _MISSING
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self._section = CollapsibleSection("粒子挂载（没有）", start_open=False)
        self._section.set_header_tool_tip(PARTICLES_TIP)
        self._section.expanded_changed.connect(lambda on: self.ensure_built() if on else None)
        self._body = QWidget()
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        self._body_layout.setSpacing(4)
        self._section.add_body(self._body)
        outer.addWidget(self._section)

    def ensure_built(self) -> None:
        if self._built:
            return
        self._built = True
        self._list = ParticleMountListField(self._model, self._body)
        self._list.setToolTip(PARTICLES_TIP)
        self._list.changed.connect(self._emit)
        self._list.pick_requested.connect(self.pick_requested.emit)
        self._body_layout.addWidget(self._list)
        self._body.show()
        self._fill()
        _relayout_up(self._body, self)

    def _emit(self) -> None:
        if self._loading:
            return
        self._refresh_title()
        self.changed.emit()

    def _fill(self) -> None:
        if not self._built:
            return
        was = self._loading
        self._loading = True
        try:
            self._list.set_mounts(self._pending if isinstance(self._pending, list) else [])
        finally:
            self._loading = was
        self._refresh_title()

    def _refresh_title(self) -> None:
        d = self.dump()
        if d is _MISSING:
            self._section.set_title("粒子挂载（没有）")
            return
        from ..shared.prop_preview import parse_particles

        mounts = parse_particles(d)
        if not isinstance(d, list):
            self._section.set_title("粒子挂载：（写坏了，运行时当空）")
        elif not mounts:
            self._section.set_title("粒子挂载：（空）")
        else:
            self._section.set_title("粒子挂载：" + "、".join(m.effect for m in mounts))

    def set_data(self, entry: object) -> None:
        src = entry if isinstance(entry, dict) else {}
        self._pending = copy.deepcopy(src["particles"]) if "particles" in src else _MISSING
        if self._pending is not _MISSING:
            self.ensure_built()
            self._section.set_expanded(True)
        if self._built:
            self._fill()
        self._refresh_title()

    def reload_refs(self) -> None:
        if self._built:
            self._list.reload_refs()

    def set_point(self, index: int, x: float, y: float) -> None:
        if self._built:
            self._list.set_point(index, x, y)

    def dump(self) -> Any:
        """`_MISSING` = 不写 `particles` 键。没展开过 ⇒ 原样回吐载入值。"""
        if not self._built:
            return self._pending if self._pending is _MISSING else copy.deepcopy(self._pending)
        cur = self._list.to_list()
        if self._pending is _MISSING and not cur:
            return _MISSING
        if not isinstance(self._pending, list) and self._pending is not _MISSING and not cur:
            return copy.deepcopy(self._pending)     # 坏形态（非数组）没动过：原样保住
        return cur


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
            f"缺省 {LIGHT_DEFAULTS['intensity']}；与同场景普通点光灯的强度含义相同。")
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
            "勾上才写 `flicker`。一个信号同时驱动灯的强度与火苗大小，不会出现「灯在闪、火苗不动」。\n"
            "物理两种要燃烧面直径 > 0，正弦要幅度 / 频率**同时 > 0** —— 缺了运行时 `parsePropLight`\n"
            "就把整个 flicker 丢掉（灯不闪，而作者以为配了）。\n"
            "状态里的灯：不勾 = 沿用基础块的闪烁；勾了 = 整块替换（不逐项合并）。")
        self._flicker_on.toggled.connect(self._on_flicker_toggled)
        fl.addWidget(self._flicker_on)
        self._flicker_fields = QWidget(flk_row)
        ff = compact_form(QFormLayout(self._flicker_fields))
        self._flicker_form = ff
        # 种类只有三档（+ 磁盘上的怪值保值展示一档）⇒ 短枚举，下拉合规（选择器铁律）
        self._flk_kind = QComboBox(self._flicker_fields)
        self._flk_kind.setMaximumWidth(200)
        self._flk_kind.setToolTip(FLICKER_KIND_TIP)
        self._flk_raw_kind: Any = None
        self._fill_kind_items(None)
        self._flk_kind.currentIndexChanged.connect(self._on_flicker_kind_changed)
        ff.addRow("种类", self._flk_kind)
        self._diameter = QDoubleSpinBox(self._flicker_fields)
        self._diameter.setRange(0.01, 1.0)
        self._diameter.setDecimals(3)
        self._diameter.setSingleStep(0.01)
        self._diameter.setMaximumWidth(88)
        self._diameter.setValue(FLICKER_PHYSICAL_DEFAULTS["diameter"])
        self._diameter.setToolTip(
            "燃烧面直径（**米**）：火把头、炭堆的直径。10 cm 的火把头 ⇒ 喘 ≈ 4.7 Hz。\n"
            "频率与对风的反应都从它推出来。必须 > 0，否则整块 flicker 被丢掉（灯不闪）。")
        self._diameter.valueChanged.connect(self._emit)
        ff.addRow("燃烧面直径 m", self._diameter)
        self._puff = OptionalNumField(
            0.0, 1.0, 0.01, 2, seed=FLICKER_PHYSICAL_DEFAULTS["puffAmp"],
            parent=self._flicker_fields, check_label="写",
            check_tip="不勾 = 不写 `puffAmp` = 运行时缺省 0.1。")
        self._puff.set_tool_tip(
            "明火「喘」在光输出上的相对幅度（半峰，0..1）。不写 = 0.1。\n"
            "炭火不喘、不读这个量。")
        self._puff.changed.connect(self._emit)
        ff.addRow("喘的幅度", self._puff)
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
        self._diameter_seed: float | None = self._diameter.value()
        #: 载入时闪烁那一片控件的样子；此刻仍一样 = 整块没动过 ⇒ 原样回吐磁盘上那块 flicker
        self._flicker_seed: tuple = ()
        self._sync_flicker_rows()
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

    def _fill_kind_items(self, flk: dict | None) -> None:
        """按磁盘上那块 flicker 重建「种类」下拉并选中（调用方负责 `_loading`）。

        没有 flicker = 新配的一块 ⇒ 明火（火把的写法）；有 flicker 没写 kind = 正弦老写法；
        kind 是运行时不认的值 ⇒ 注入一行 `(数据) …` 保值展示，不静默顶替成哪一种。
        """
        combo = self._flk_kind
        combo.blockSignals(True)
        try:
            combo.clear()
            combo.addItem("明火（物理）", FLICKER_KIND_FLAME)
            combo.addItem("炭火（物理）", FLICKER_KIND_EMBER)
            combo.addItem("正弦（老写法）", FLICKER_KIND_SINE)
            self._flk_raw_kind = None
            if not isinstance(flk, dict):
                want = FLICKER_KIND_FLAME
            elif "kind" not in flk:
                want = FLICKER_KIND_SINE
            elif flk.get("kind") in FLICKER_PHYSICAL_KINDS:
                want = str(flk.get("kind"))
            else:
                self._flk_raw_kind = copy.deepcopy(flk.get("kind"))
                combo.addItem(f"(数据) kind={flk.get('kind')!r}（运行时不认，按正弦算）",
                              FLICKER_KIND_RAW)
                want = FLICKER_KIND_RAW
            combo.setCurrentIndex(max(0, combo.findData(want)))
        finally:
            combo.blockSignals(False)

    def _sync_flicker_rows(self) -> None:
        """按种类显隐：物理 = 直径（明火再加喘的幅度）；正弦 / 不认的 kind = 幅度 / 频率 / 吃风。"""
        kind = self._flk_kind.currentData()
        physical = kind in FLICKER_PHYSICAL_KINDS
        ff = self._flicker_form
        ff.setRowVisible(self._diameter, physical)
        ff.setRowVisible(self._puff, kind == FLICKER_KIND_FLAME)
        for w in (self._amp, self._hz, self._wind):
            ff.setRowVisible(w, not physical)
        _relayout_up(self._flicker_fields, self)

    def _on_flicker_kind_changed(self, *_a: object) -> None:
        self._sync_flicker_rows()
        self._emit()

    def _flicker_snapshot(self) -> tuple:
        return (
            self._flicker_on.isChecked(), self._flk_kind.currentData(),
            self._diameter.value(), self._puff.state(),
            self._amp.value(), self._hz.value(), self._wind.state(),
        )

    def _dump_flicker(self, o_flk: dict | None) -> dict:
        """按当前种类产出一块 flicker。整块没动过 ⇒ 原样回吐磁盘那块（坏值、残留键一个字节不改）。"""
        if o_flk is not None and self._flicker_snapshot() == self._flicker_seed:
            return copy.deepcopy(o_flk)
        o = o_flk or {}
        flk: dict[str, Any] = {k: copy.deepcopy(v) for k, v in o.items() if k not in FLICKER_FORM_KEYS}
        kind = self._flk_kind.currentData()
        if kind in FLICKER_PHYSICAL_KINDS:
            flk["kind"] = kind
            if self._diameter.value() == self._diameter_seed and "diameter" in o:
                flk["diameter"] = copy.deepcopy(o["diameter"])
            else:
                flk["diameter"] = round(self._diameter.value(), 4)
            if kind == FLICKER_KIND_FLAME:
                if self._puff.is_untouched() and "puffAmp" in o:
                    flk["puffAmp"] = copy.deepcopy(o["puffAmp"])
                else:
                    puff = self._puff.value()
                    if puff is not None:
                        flk["puffAmp"] = puff
        else:
            if kind == FLICKER_KIND_RAW:
                flk["kind"] = copy.deepcopy(self._flk_raw_kind)
            flk["amp"] = _seeded(self._amp.value(), self._amp_seed, o.get("amp"))
            flk["hz"] = _seeded(self._hz.value(), self._hz_seed, o.get("hz"))
            if self._wind.is_untouched() and "windAmp" in o:
                flk["windAmp"] = copy.deepcopy(o["windAmp"])
            else:
                wind = self._wind.value()
                if wind is not None:
                    flk["windAmp"] = wind
        preserve_numeric_repr(flk, o_flk)
        return reorder_like(flk, o_flk)

    def _refresh_note(self) -> None:
        bad: list[str] = []
        if self._intensity.value() <= 0:
            bad.append("亮度 ≤ 0 ⇒ 运行时把这盏灯整盏丢掉（不亮，也不报错）。")
        if self._flicker_on.isChecked():
            o_flk = (self._original or {}).get("flicker")
            bad.extend(flicker_problems(
                self._dump_flicker(o_flk if isinstance(o_flk, dict) else None)))
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
            f = flk if has_flk else {}
            self._flicker_on.setChecked(has_flk)
            self._flicker_fields.setEnabled(has_flk)
            self._fill_kind_items(flk if has_flk else None)
            self._diameter.setValue(
                float_or(f.get("diameter"), FLICKER_PHYSICAL_DEFAULTS["diameter"]))
            self._diameter_seed = self._diameter.value()
            self._puff.set_value(f.get("puffAmp"))
            self._amp.setValue(float_or(f.get("amp"), FLICKER_DEFAULTS["amp"]))
            self._hz.setValue(float_or(f.get("hz"), FLICKER_DEFAULTS["hz"]))
            self._amp_seed = self._amp.value()
            self._hz_seed = self._hz.value()
            self._wind.set_value(f.get("windAmp"))
            self._flicker_seed = self._flicker_snapshot()
            self._sync_flicker_rows()
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
            out["flicker"] = self._dump_flicker(o_flk if isinstance(o_flk, dict) else None)
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
            bits.append({FLICKER_KIND_FLAME: "明火闪烁", FLICKER_KIND_EMBER: "炭火闪烁"}.get(
                d["flicker"].get("kind"), "会闪"))
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


#: 基础块里「火焰」块管着的键（`firePoint` / `flame` / `burn` / `windShelter`）。
FIRE_KEYS = ("firePoint", "flame", "burn", "windShelter")
#: `flame` 对象里表单管着的键。其余键原样透传。
FLAME_KEYS = ("image", "cols", "frames", "fps", "height")
#: 新配一团火苗时的缺省（三把火图集：588×612、12 列、64 帧；满火一格 ≈ 30 wu，角色高 150 wu）
FLAME_DEFAULTS: dict[str, Any] = {
    "image": "/resources/runtime/images/ui/three_fires_sheet.png",
    "cols": 12, "frames": 64, "fps": 24.0, "height": 30.0,
}


class PropFireBlock(QWidget):
    """基础块的「火焰」：起火点 `firePoint` + 看得见的火苗 `flame` + 燃烧强度 `burn`。

    默认折叠 + 懒建（布局纪律）：没展开过 ⇒ `dump()` 原样回吐磁盘上这三个键
    （一个字节都不经过 Qt 控件）。配了其中任何一个就当场建控件并展开。

    **往返**：每个子字段"没动过"就回吐磁盘原值（含越界 / 坏形态 / `null`——运行时自己
    会清洗，编辑器不替它修数据）；动过才按控件值写，int 不漂 float。
    `flame` 对象里不认识的键原样透传、键序按磁盘原序。
    """

    changed = Signal()

    def __init__(self, model: Any, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._loading = False
        self._built = False
        #: 载入时这三个键里**存在**的那几个（深拷贝）
        self._pending: dict[str, Any] = {}
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self._section = CollapsibleSection("火焰（没有）", start_open=False)
        self._section.set_header_tool_tip(
            "燃烧物（火把 / 篾条…）的火：\n"
            "· 起火点：贴图上火从哪一点出——灯位、自带效果锚点、火苗底部都从这里出；不写 = 从挂点本身出；\n"
            "· 火苗：共用的帧动画图集，画面竖直向上、不跟燃烧物转、不吃光（灯笼不写：纸罩住了火）；\n"
            "· burn：燃烧强度 0..1，火苗高度 = 满火高度 × burn × 闪烁。状态里可以各自覆盖 burn 与起火点。")
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
        self._fill()

    def _build_body(self) -> None:
        from ..shared.image_path_picker import CutsceneImagePathRow

        top = QWidget(self._body)
        form = compact_form(QFormLayout(top))
        self._fire_point = OptionalPointField(check_label="写", seed=(0.5, 0.1), parent=top)
        self._fire_point.set_tool_tip(
            "起火点（贴图归一化 0..1，左上原点，与支点同口径）。\n"
            "灯位、自带效果锚点、火苗底部都从这一点出；不写 = 从挂点本身出（与灯笼一样）。\n"
            "也可以打开右侧试挂预览的「点选起火点」，在图上点 / 拖。")
        self._fire_point.changed.connect(self._emit)
        form.addRow("起火点", self._fire_point)
        self._burn = OptionalNumField(0.0, 1.0, 0.05, 3, seed=1.0, parent=top)
        self._burn.set_tool_tip(BURN_TIP + "基础块不写 = 1（满火）；状态里写了就用状态的。")
        self._burn.changed.connect(self._emit)
        form.addRow("燃烧 burn", self._burn)
        self._wind_shelter = OptionalNumField(0.0, 1.0, 0.05, 3, seed=0.0, parent=top)
        self._wind_shelter.set_tool_tip(
            WIND_SHELTER_TIP + "基础块不写 = 0（不挡风）；状态里写了就用状态的（护火状态单独给）。")
        self._wind_shelter.changed.connect(self._emit)
        form.addRow("挡风", self._wind_shelter)
        self._body_layout.addWidget(top)

        self._flame_on = QCheckBox("这个挂件有看得见的火苗", self._body)
        self._flame_on.setToolTip(
            "勾掉 = **不写 `flame` 键**（灯笼：纸罩住了火，只有灯）。\n"
            "火苗图集只在基础块定义；状态换不了图集（要换就是另一个挂件预设）。")
        self._flame_on.toggled.connect(self._on_flame_toggled)
        self._body_layout.addWidget(self._flame_on)

        self._flame_fields = QWidget(self._body)
        ff = compact_form(QFormLayout(self._flame_fields))
        self._flame_image = CutsceneImagePathRow(
            self._model, "", self._flame_fields, external_copy_subdir="props",
            external_copy_hint="项目外图片会复制到 resources/runtime/images/props/",
        )
        self._flame_image.setToolTip(
            "火苗帧动画图集（按行优先排帧）。**必填**——空着运行时整块作废，火苗不画。\n"
            f"共用的三把火图：{FLAME_DEFAULTS['image']}")
        self._flame_image.changed.connect(self._emit)
        ff.addRow("火苗图集", self._flame_image)
        self._cols = OptionalIntField(1, 999, seed=int(FLAME_DEFAULTS["cols"]), parent=self._flame_fields)
        self._cols.set_tool_tip("图集列数。不写 = 1。格宽 = 图宽 / 列数。")
        self._cols.changed.connect(self._emit)
        ff.addRow("列数", self._cols)
        self._frames = OptionalIntField(1, 9999, seed=int(FLAME_DEFAULTS["frames"]), parent=self._flame_fields)
        self._frames.set_tool_tip("帧数（按行优先排）。不写 = 列数。行数 = ceil(帧数 / 列数)。")
        self._frames.changed.connect(self._emit)
        ff.addRow("帧数", self._frames)
        self._fps = OptionalNumField(0.0, 240.0, 1.0, 2, seed=float(FLAME_DEFAULTS["fps"]),
                                     parent=self._flame_fields)
        self._fps.set_tool_tip("帧率。不写 = 24。≤0 运行时也按 24。")
        self._fps.changed.connect(self._emit)
        ff.addRow("帧率", self._fps)
        self._height = QDoubleSpinBox(self._flame_fields)
        self._height.setRange(0.0, 10000.0)
        self._height.setDecimals(3)
        self._height.setSingleStep(1.0)
        self._height.setMaximumWidth(96)
        self._height.setToolTip(
            "满火（burn=1）时一格帧的高度，**wu**（深度系数 1 处；角色高 ≈150 wu）。**必须 > 0**——\n"
            "≤0 运行时整块作废、火苗不画。与挂件 scale 无关：换大一号的火把杆不会把火放大。")
        self._height.valueChanged.connect(self._emit)
        ff.addRow("满火高度 wu", self._height)
        self._body_layout.addWidget(self._flame_fields)

        self._note = QLabel("", self._body)
        self._note.setWordWrap(True)
        self._body_layout.addWidget(self._note)

    # ---------------------------------------------------------------- 内部
    def _emit(self, *_a: object) -> None:
        if self._loading:
            return
        self._refresh_title()
        self._refresh_note()
        self.changed.emit()

    def _on_flame_toggled(self, on: bool) -> None:
        self._flame_fields.setEnabled(on)
        if on and not self._loading:
            # 勾上而图集 / 高度还是空的 = 运行时整块作废；给一组"看得见"的缺省（三把火）
            if not self._flame_image.path():
                self._flame_image.set_path(str(FLAME_DEFAULTS["image"]))
            if self._height.value() <= 0:
                self._height.setValue(float(FLAME_DEFAULTS["height"]))
            if self._flame_image.path() == FLAME_DEFAULTS["image"]:
                # 共用的三把火图是 12 列 64 帧；列数不写 = 1 ⇒ 整张图集当一帧画，一样"看不见火"
                for field in (self._cols, self._frames):
                    if not field._on.isChecked():
                        field._on.setChecked(True)
        self._emit()

    def _fill(self) -> None:
        if not self._built:
            return
        was = self._loading
        self._loading = True
        try:
            p = self._pending
            self._fire_point.set_value(p.get("firePoint"))
            self._burn.set_value(p.get("burn"))
            self._wind_shelter.set_value(p.get("windShelter"))
            raw_flame = p.get("flame")
            flame = raw_flame if isinstance(raw_flame, dict) else {}
            has = isinstance(raw_flame, dict)
            self._flame_on.setChecked(has)
            self._flame_fields.setEnabled(has)
            img = flame.get("image")
            self._flame_image.set_path(img if isinstance(img, str) else "")
            self._cols.set_value(flame.get("cols"))
            self._frames.set_value(flame.get("frames"))
            self._fps.set_value(flame.get("fps"))
            self._height.setValue(float_or(flame.get("height"), 0.0))
            self._seed = {
                "flame_on": has,
                "image": self._flame_image.path(),
                "height": self._height.value(),
            }
        finally:
            self._loading = was
        self._refresh_title()
        self._refresh_note()

    def _flame_untouched(self) -> bool:
        s = self._seed
        return (self._flame_on.isChecked() == s["flame_on"]
                and self._flame_image.path() == s["image"]
                and self._height.value() == s["height"]
                and self._cols.is_untouched() and self._frames.is_untouched()
                and self._fps.is_untouched())

    def _flame_dump(self) -> Any:
        """`_MISSING` = 不写 `flame` 键。"""
        orig = self._pending.get("flame", _MISSING)
        if self._flame_untouched():
            # ⚠ 哨兵不能深拷贝：deepcopy(object()) 造出一个新对象，`is _MISSING` 就再也认不出来
            return orig if orig is _MISSING else copy.deepcopy(orig)
        if not self._flame_on.isChecked():
            return _MISSING
        o = orig if isinstance(orig, dict) else {}
        out: dict[str, Any] = {k: copy.deepcopy(v) for k, v in o.items() if k not in FLAME_KEYS}
        if self._flame_image.path() == self._seed["image"] and "image" in o:
            out["image"] = copy.deepcopy(o["image"])
        else:
            out["image"] = self._flame_image.path()
        for key, field in (("cols", self._cols), ("frames", self._frames), ("fps", self._fps)):
            if field.is_untouched() and key in o:
                out[key] = copy.deepcopy(o[key])
                continue
            v = field.value()
            if v is not None:
                out[key] = v
        out["height"] = _seeded(self._height.value(), self._seed["height"], o.get("height"))
        preserve_numeric_repr(out, o)
        return reorder_like(out, o)

    def _refresh_title(self) -> None:
        d = self.dump()
        if not d:
            self._section.set_title("火焰（没有）")
            return
        from ..shared.prop_preview import ABSENT, parse_burn, parse_fire_point, parse_flame

        bits: list[str] = []
        fp = parse_fire_point(d.get("firePoint"))
        if fp is not None:
            bits.append(f"起火点 ({fp[0]:.2f}, {fp[1]:.2f})")
        fl = parse_flame(d.get("flame"))
        if fl is not None:
            bits.append(f"火苗 {fl.height:g} wu")
        elif "flame" in d:
            bits.append("火苗（坏，不画）")
        b = parse_burn(d.get("burn", ABSENT))   # 没写 ≠ null（null 运行时是 0）
        if b is not None:
            bits.append(f"burn {b:g}")
        ws = parse_burn(d.get("windShelter", ABSENT))
        if ws is not None:
            bits.append(f"挡风 {ws:g}")
        self._section.set_title("火焰：" + ("　".join(bits) if bits else "（键在但读不出）"))

    def _refresh_note(self) -> None:
        if not self._built:
            return
        bad: list[str] = []
        if self._flame_on.isChecked():
            if not self._flame_image.path():
                bad.append("火苗图集空着 ⇒ 运行时整块作废，火苗不画。")
            if self._height.value() <= 0:
                bad.append("满火高度 ≤ 0 ⇒ 运行时整块作废，火苗不画。")
        self._note.setText("　".join(bad))
        self._note.setStyleSheet("color:#c66;" if bad else "color:#888;")

    # ---------------------------------------------------------------- 外部
    def set_data(self, entry: object) -> None:
        """从一条预设载入（只取 `firePoint` / `flame` / `burn` 三个键）。"""
        src = entry if isinstance(entry, dict) else {}
        self._pending = {k: copy.deepcopy(src[k]) for k in FIRE_KEYS if k in src}
        if self._pending:
            self.ensure_built()
            self._section.set_expanded(True)
        if self._built:
            self._fill()
        self._refresh_title()

    def set_fire_point(self, x: float, y: float) -> None:
        """试挂预览上点选：写基础块的起火点（勾上并展开，所见即所得）。"""
        self.ensure_built()
        self._section.set_expanded(True)
        self._fire_point.set_point(round(float(x), 4), round(float(y), 4))

    def dump(self) -> dict[str, Any]:
        """要写的键 → 值（不在结果里的键 = 不写）。没展开过 ⇒ 原样回吐载入值。"""
        if not self._built:
            return {k: copy.deepcopy(v) for k, v in self._pending.items()}
        out: dict[str, Any] = {}
        for key, field in (("firePoint", self._fire_point), ("burn", self._burn),
                           ("windShelter", self._wind_shelter)):
            if field.is_untouched():
                if key in self._pending:
                    out[key] = copy.deepcopy(self._pending[key])
                continue
            v = field.value()
            if v is not None:
                out[key] = v
        flame = self._flame_dump()
        if flame is not _MISSING:
            out["flame"] = flame
        return out


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


class PropStateParticlesField(QWidget):
    """状态里的 `particles`：**两态**（沿用基础块那一串 / 这个状态自己的列表，可以为空）。

    运行时是**整体替换**而不是并上去：状态写了 `particles` 键（哪怕是空数组）就只用状态的，
    没写键才沿用基础块。空数组 = 这个状态没有粒子（火把灭了）。
    """

    changed = Signal()
    pick_requested = Signal(int)

    def __init__(self, model: Any, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._loading = False
        self._orig: Any = _MISSING
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self._mode = QComboBox(self)
        self._mode.addItem("沿用基础块那一串（不写 particles 键）", STATE_PARTICLES_INHERIT)
        self._mode.addItem("这个状态自己的列表（整体替换；空 = 没有粒子）", STATE_PARTICLES_OWN)
        self._mode.setMaximumWidth(360)
        self._mode.setToolTip(
            "两档：不写 = 沿用基础块那一串；写了 = **整体替换**基础块那一串（不是并上去），\n"
            "列表可以是空的（这个状态一个粒子都不挂，灭了的火把）。\n" + PARTICLES_TIP)
        self._mode.currentIndexChanged.connect(self._on_mode_changed)
        lay.addWidget(self._mode)
        self._list = ParticleMountListField(model, self)
        self._list.changed.connect(self._emit)
        self._list.pick_requested.connect(self.pick_requested.emit)
        self._list.setVisible(False)
        lay.addWidget(self._list)

    def _emit(self, *_a: object) -> None:
        if self._loading:
            return
        self.changed.emit()

    def _on_mode_changed(self, *_a: object) -> None:
        self._list.setVisible(self._mode.currentData() == STATE_PARTICLES_OWN)
        _relayout_up(self._list, self)
        self._emit()

    def reload_refs(self) -> None:
        self._list.reload_refs()

    def set_data(self, state: dict | None) -> None:
        """按 `'particles' in state` 判两档（空数组与"没写"绝不能混）。"""
        was = self._loading
        self._loading = True
        try:
            raw = state or {}
            self._orig = copy.deepcopy(raw["particles"]) if "particles" in raw else _MISSING
            own = "particles" in raw
            idx = self._mode.findData(STATE_PARTICLES_OWN if own else STATE_PARTICLES_INHERIT)
            self._mode.setCurrentIndex(idx if idx >= 0 else 0)
            self._list.setVisible(own)
            self._list.set_mounts(raw.get("particles") if own else [])
            self._seed = (own, self._list.to_list())
        finally:
            self._loading = was

    def is_own(self) -> bool:
        return self._mode.currentData() == STATE_PARTICLES_OWN

    def set_point(self, index: int, x: float, y: float) -> None:
        self._list.set_point(index, x, y)

    def write_into(self, out: dict) -> None:
        """按档位写键。沿用档 = **什么都不写**；自己档 = 写列表（没动过的坏形态原样保住）。"""
        if not self.is_own():
            return
        cur = self._list.to_list()
        if (self._orig is not _MISSING and not isinstance(self._orig, list)
                and (True, cur) == self._seed):
            out["particles"] = copy.deepcopy(self._orig)
            return
        out["particles"] = cur


#: `PropBlowoutDef` 里表单管着的键。其余键原样透传。
BLOWOUT_KEYS = (
    "windSpeed", "drainSeconds", "recoverSeconds", "emberBelow", "emberState", "outState", "recoverState",
    "auto", "fadeMs", "onEmberActions", "onOutActions",
)
#: 风吹灭块三个必填量 → (表单标签, 新配一块时的缺省)。缺省与现网火把一致（吹熄 8 m/s、掉 4 s、回 3 s）
BLOWOUT_REQUIRED: tuple[tuple[str, str, float], ...] = (
    ("windSpeed", "吹熄风速 m/s", 8.0),
    ("drainSeconds", "掉速 s", 4.0),
    ("recoverSeconds", "回速 s", 3.0),
)
#: 残炭线勾上「写」时的种子（现网火把 0.35）
BLOWOUT_EMBER_BELOW_SEED = 0.35
#: 自动切状态用的渐变缺省（`PROP_BLOWOUT_DEFAULT_FADE_MS`）
BLOWOUT_FADE_MS_DEFAULT = 500
#: 风吹灭的说明（基础块与状态两处共用一份）
BLOWOUT_TIP = (
    "风吹灭：挂着的火有一个火势 0..1。\n"
    "火把处的气流（场景风 − 人走动，已算挡风）超过吹熄风速火势就掉、风越猛掉得越快；低于就慢慢回。\n"
    "火势乘在火苗大小与灯亮度上——眼看火要灭是看得见的。\n"
    "掉过残炭线切残炭状态、掉到底切灭状态（勾着「自动切状态」时），再执行越线动作\n"
    "（要推剧情就在越线动作里放 emitNarrativeSignal 发叙事信号）。\n"
    "残炭里挡住风（护火 / 风停）、火势回到残炭线上方一截 ⇒ 自动复燃回「挡风复燃回到」那个状态（不写 = lit）。\n"
    "物理只往下、不点火；lockPropState 锁定不灭 = 只回不掉；setPropState 永远优先。\n"
    "不写这一块 = 永远吹不灭（灯笼、演出道具火）。\n"
)

#: 玩家操作块 `playerControl` 里表单管着的键。其余键原样透传。
PLAYER_CONTROL_KEYS = ("litState", "guardState", "outState", "extinguishFadeMs", "igniteFadeMs",
                       "hintBelow", "guardBlocksRun")
#: 快灭提示线缺省（`PROP_CONTROL_DEFAULTS.hintBelow`）
PLAYER_CONTROL_HINT_BELOW_DEFAULT = 0.8
#: 「护着火只能走不能跑」缺省（`PROP_CONTROL_DEFAULTS.guardBlocksRun`）
PLAYER_CONTROL_GUARD_BLOCKS_RUN_DEFAULT = True
#: 「护着火只能走不能跑」的说明
PLAYER_CONTROL_GUARD_RUN_TIP = (
    "护着火的时候只能走不能跑（玩法清单 A3.7）。\n"
    f"不写 = 缺省 {str(PLAYER_CONTROL_GUARD_BLOCKS_RUN_DEFAULT).lower()}（制作人 2026-09-16：侧身把火拢住还撒腿狂奔不像话，\n"
    "而且这是护火省燃料的代价——不然一路按着护火键最划算：按住 Q 每秒确实省燃料，\n"
    "但同样一段路要多走时间，一段路烧掉的燃料并没省；只有站着扛一阵风时护火才是纯赚）。\n"
    "⚠ 运行时只认 `true` / `false` 两个布尔，别的值当没写、按缺省。"
)
#: 快灭提示线的说明
PLAYER_CONTROL_HINT_TIP = (
    "快灭提示线 0..1：火势掉到这以下火边出快灭符号，残炭时一直出；0 = 不提示。\n"
    f"不写 = {PLAYER_CONTROL_HINT_BELOW_DEFAULT:g}。锁定不灭、灭了、演出 / 对话里不出；只对写了「风吹灭」的挂件有意义。"
)
#: 玩家操作块的说明
PLAYER_CONTROL_TIP = (
    "玩家操作：写了这一块 = 玩家能用键操作手上这件挂件——T 点火 / 熄灭，按住 Q 护火。\n"
    "按键切到哪几个状态写在这里（不写 = 缺省 lit / guarding / out），渐变不写走缺省。\n"
    "火势掉到「快灭提示线」以下，火边出快灭符号（残炭时一直出）。\n"
    "锁：lockPropState 锁定不灭 = T 熄不灭；点不燃 = T 点不着。setPropState 永远优先。\n"
    "不写这一块 = 玩家不能操作（灯笼、演出道具）。\n"
)

#: 状态名下拉里「不写这个键」那一行的标记（不落盘）
_STATE_NAME_NOT_WRITTEN = "\x00not-written"
#: 状态名下拉里「磁盘上是非字符串的怪值」那一行的标记（不落盘，原值原样回吐）
_STATE_NAME_RAW = "\x00raw"


class OptionalStateNameCombo(QComboBox):
    """可选的状态名（风吹灭的残炭 / 灭状态、玩家操作切到的状态）：候选 = 这个挂件预设自己的状态名。

    状态名很短（点着 / 护火 / 残炭 / 灭几个），按选择器铁律"很短的枚举才允许下拉"用下拉合规。
    第一行「不写 = 缺省名」= 不写键（运行时空串也当没写）。磁盘上的悬垂名字 / 非字符串怪值**保值展示**，
    没动过就原样回吐（norms 不变量 6）。
    """

    changed = Signal()

    def __init__(self, default_name: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._default = default_name
        self._names: list[str] = []
        self._raw: Any = _MISSING
        self._seed: object = _STATE_NAME_NOT_WRITTEN
        self._quiet = False
        self.setMaximumWidth(240)
        self.setSizeAdjustPolicy(QComboBox.SizeAdjustPolicy.AdjustToContents)
        self.currentIndexChanged.connect(self._on_index_changed)
        self._rebuild(_STATE_NAME_NOT_WRITTEN)

    def _on_index_changed(self, *_a: object) -> None:
        if not self._quiet:
            self.changed.emit()

    def _rebuild(self, want: object) -> None:
        self._quiet = True
        try:
            self.clear()
            self.addItem(f"（不写 = {self._default}）", _STATE_NAME_NOT_WRITTEN)
            for n in self._names:
                self.addItem(n, n)
            if want == _STATE_NAME_RAW:
                self.addItem(f"(数据) {self._raw!r}", _STATE_NAME_RAW)
            elif isinstance(want, str) and want != _STATE_NAME_NOT_WRITTEN and want not in self._names:
                self.addItem(f"{want}  ⚠ 状态表里没有", want)
            idx = self.findData(want)
            self.setCurrentIndex(idx if idx >= 0 else 0)
        finally:
            self._quiet = False

    def set_state_names(self, names: list[str]) -> None:
        """换候选（状态表增删改名之后）；当前选择保值，不发 `changed`。"""
        self._names = [str(n) for n in names]
        self._rebuild(self.currentData())

    def set_value(self, raw: Any) -> None:
        """载入磁盘值（`_MISSING` = 没有这个键）。"""
        self._raw = copy.deepcopy(raw) if raw is not _MISSING else _MISSING
        if raw is _MISSING or (isinstance(raw, str) and not raw.strip()):
            want: object = _STATE_NAME_NOT_WRITTEN
        elif isinstance(raw, str):
            want = raw
        else:
            want = _STATE_NAME_RAW
        self._rebuild(want)
        self._seed = self.currentData()

    def is_untouched(self) -> bool:
        return self.currentData() == self._seed

    def value(self) -> Any:
        """落盘值：`_MISSING` = 不写键；没动过 ⇒ 磁盘原值（含空串 / 怪值）。"""
        if self.is_untouched():
            return self._raw if self._raw is _MISSING else copy.deepcopy(self._raw)
        d = self.currentData()
        if d == _STATE_NAME_NOT_WRITTEN:
            return _MISSING
        if d == _STATE_NAME_RAW:
            return copy.deepcopy(self._raw)
        return str(d)


class PropBlowoutForm(QWidget):
    """一块 `blowout`（风吹灭）的表单。基础块（`PropBlowoutBlock`）与状态（`PropStateBlowoutField`）共用这一个。

    ## 往返
    - 整块一个控件都没动过 ⇒ `dump()` 原样回吐载入值（坏形态、不认识的键、键序，一个字节不改）；
    - 动过 ⇒ 每个字段各自"没动过回吐磁盘原值"，不认识的键透传、键序按磁盘原序；
    - `fresh`（新配一块）⇒ 三个必填量按缺省写出来。
    越线动作走 `ActionEditor` 的种子快照（它会 materialize 空参数，没动过必须回吐原值）。
    """

    changed = Signal()

    def __init__(self, model: Any, *, in_state: bool, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        from ..shared.action_editor import ActionEditor

        self._model = model
        self._in_state = in_state
        self._loading = False
        self._orig: Any = _MISSING
        self._fresh = False
        self._num_seeds: dict[str, float] = {}
        self._act_seeds: dict[str, list] = {}
        self._auto_seed = True

        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        top = QWidget(self)
        form = compact_form(QFormLayout(top))
        self._req: dict[str, QDoubleSpinBox] = {}
        tips = {
            "windSpeed": "吹熄风速（m/s）：火把处气流（场景风 − 人走动，已算挡风）超过它火势就往下掉。\n"
                         "风灯难灭给大、篾条好灭给小。**必须 > 0**。",
            "drainSeconds": "掉速：气流是吹熄风速**两倍**时，火势从满掉到底要几秒（风越猛掉得越快）。**必须 > 0**。",
            "recoverSeconds": "回速：无风时火势从底回满要几秒（有风但没超吹熄风速时回得慢些）。**必须 > 0**。",
        }
        miss = "三个必填量少一个 ⇒ " + ("运行时当这块没写、沿用基础块。" if in_state else "运行时整块丢掉 = 吹不灭。")
        for key, label, _default in BLOWOUT_REQUIRED:
            sb = QDoubleSpinBox(top)
            sb.setRange(0.0, 3600.0 if key != "windSpeed" else 200.0)
            sb.setDecimals(2)
            sb.setSingleStep(0.5)
            sb.setMaximumWidth(96)
            sb.setToolTip(tips[key] + "\n" + miss)
            sb.valueChanged.connect(self._emit)
            form.addRow(label, sb)
            self._req[key] = sb
        self._ember_below = OptionalNumField(
            0.0, 1.0, 0.05, 3, seed=BLOWOUT_EMBER_BELOW_SEED, parent=top, check_label="写",
            check_tip="不勾 = 不写：没有残炭这一步，火势到底直接灭。")
        self._ember_below.set_tool_tip(
            "残炭线 0..1：火势掉过这条线切残炭状态（再执行「掉到残炭时」的动作）。\n"
            "不写 = 没有残炭这一步，掉到底直接灭。")
        self._ember_below.changed.connect(self._emit)
        form.addRow("残炭线", self._ember_below)
        self._ember_state = OptionalStateNameCombo("ember", top)
        self._ember_state.setToolTip(
            "掉过残炭线切到哪个状态（这个挂件预设 states 里的键）。不写 = ember。\n"
            "预设里没有这个状态 ⇒ 运行时 log 一行、不切，只执行越线动作（校验器报 warning）。")
        self._ember_state.changed.connect(self._emit)
        form.addRow("残炭状态", self._ember_state)
        self._recover_state = OptionalStateNameCombo("lit", top)
        self._recover_state.setToolTip(
            "残炭里挡住风（护火 / 风停）、火势回到残炭线上方一截时，自动复燃回哪个状态。不写 = lit。\n"
            "没写残炭线 / 不勾「越线自动切状态」时不生效。\n"
            "预设里没有这个状态 ⇒ 运行时不复燃（校验器报 warning）。")
        self._recover_state.changed.connect(self._emit)
        form.addRow("挡风复燃回到", self._recover_state)
        self._out_state = OptionalStateNameCombo("out", top)
        self._out_state.setToolTip(
            "火势到底切到哪个状态。不写 = out。已经在这个状态里就不再算火势（灭了不会再被吹）。\n"
            "预设里没有这个状态 ⇒ 运行时 log 一行、不切，只执行越线动作（校验器报 warning）。")
        self._out_state.changed.connect(self._emit)
        form.addRow("灭状态", self._out_state)
        self._auto = QCheckBox("越线自动切状态", top)
        self._auto.setToolTip(
            "勾着（缺省，不写键）= 越线时自动切到残炭 / 灭状态，再执行越线动作。\n"
            "不勾（写 auto: false）= 只执行越线动作、不切状态——切不切、走什么分支交给叙事状态机（动作里发信号）。")
        self._auto.toggled.connect(self._emit)
        form.addRow("自动", self._auto)
        self._fade = OptionalIntField(0, 600000, seed=BLOWOUT_FADE_MS_DEFAULT, parent=top)
        self._fade.set_tool_tip(
            f"自动切状态用的渐变（毫秒，灯强度与燃烧强度同一个钟）。不写 = {BLOWOUT_FADE_MS_DEFAULT}。")
        self._fade.changed.connect(self._emit)
        form.addRow("渐变 ms", self._fade)
        lay.addWidget(top)

        self._acts: dict[str, ActionEditor] = {}
        for key, label, tip in (
            ("onEmberActions", "掉到残炭时",
             "火势掉过残炭线时执行（在自动切状态之后）。没写残炭线就永远不执行。"),
            ("onOutActions", "被风吹灭时",
             "火势掉到底时执行（在自动切状态之后）。"),
        ):
            ed = ActionEditor(label, self)
            ed.setToolTip(
                tip + "\n要推剧情就在这里放 emitNarrativeSignal 发叙事信号（引擎不写死信号名）。\n"
                "顶层的 playPropVfx 不写 target / socket = 这件挂件自己；嵌在 runActions 等容器里的要写全。")
            ed.set_project_context(model, None)
            ed.changed.connect(self._emit)
            lay.addWidget(ed)
            self._acts[key] = ed
        self._hint = QLabel(
            "越线动作里可用 playPropVfx 在这件挂件上播效果（target / socket 留空 = 这件挂件），"
            "可用 emitNarrativeSignal 推剧情", self)
        self._hint.setWordWrap(True)
        lay.addWidget(self._hint)
        self._note = QLabel("", self)
        self._note.setWordWrap(True)
        lay.addWidget(self._note)
        self.set_data(None, fresh=True)

    # ---------------------------------------------------------------- 内部
    def _emit(self, *_a: object) -> None:
        if self._loading:
            return
        self._refresh_note()
        self.changed.emit()

    def _refresh_note(self) -> None:
        bad: list[str] = []
        if self._orig is not _MISSING and self._orig is not None and not isinstance(self._orig, dict) \
                and self.is_untouched() and not self._fresh:
            bad.append("这块不是对象 ⇒ " + ("运行时当没写、沿用基础块。" if self._in_state else "运行时丢掉 = 吹不灭。"))
        elif any(sb.value() <= 0 for sb in self._req.values()):
            bad.append("吹熄风速 / 掉速 / 回速 都必须 > 0，少一个 ⇒ "
                       + ("运行时当这块没写、沿用基础块。" if self._in_state else "运行时整块丢掉 = 吹不灭。"))
        self._note.setText("　".join(bad))
        self._note.setStyleSheet("color:#c66;" if bad else "color:#888;")

    # ---------------------------------------------------------------- 外部
    def set_data(self, raw: Any, *, fresh: bool = False) -> None:
        """载入一块（`_MISSING` / `None` / 非对象都行）。`fresh` = 新配一块：三个必填量按缺省显示并写出来。"""
        from ..shared.prop_preview import ABSENT, js_number

        was = self._loading
        self._loading = True
        try:
            self._fresh = fresh
            self._orig = _MISSING if raw is _MISSING else copy.deepcopy(raw)
            o = raw if isinstance(raw, dict) and not fresh else {}
            for key, _label, default in BLOWOUT_REQUIRED:
                sb = self._req[key]
                if fresh:
                    sb.setValue(default)
                else:
                    n = js_number(o.get(key, ABSENT))
                    sb.setValue(n if n is not None and n > 0 else 0.0)
                self._num_seeds[key] = sb.value()
            self._ember_below.set_value(o.get("emberBelow"))
            self._ember_state.set_value(o.get("emberState", _MISSING))
            self._out_state.set_value(o.get("outState", _MISSING))
            self._recover_state.set_value(o.get("recoverState", _MISSING))
            self._auto.setChecked(o.get("auto") is not False)
            self._auto_seed = self._auto.isChecked()
            self._fade.set_value(o.get("fadeMs"))
            for key, ed in self._acts.items():
                acts = o.get(key)
                ed.set_data([a for a in acts if isinstance(a, dict)] if isinstance(acts, list) else [])
                self._act_seeds[key] = ed.to_list()
        finally:
            self._loading = was
        self._refresh_note()

    def set_state_names(self, names: list[str]) -> None:
        self._ember_state.set_state_names(names)
        self._out_state.set_state_names(names)
        self._recover_state.set_state_names(names)

    def reload_refs(self) -> None:
        for ed in self._acts.values():
            ed.reload_refs_from_model()

    def is_fresh(self) -> bool:
        return self._fresh

    def is_untouched(self) -> bool:
        return (all(self._req[k].value() == self._num_seeds.get(k) for k in self._req)
                and self._ember_below.is_untouched()
                and self._ember_state.is_untouched() and self._out_state.is_untouched()
                and self._recover_state.is_untouched()
                and self._auto.isChecked() == self._auto_seed
                and self._fade.is_untouched()
                and all(ed.to_list() == self._act_seeds.get(k) for k, ed in self._acts.items()))

    def dump(self) -> Any:
        """这一块的落盘值。整块没动过（且不是新配的）⇒ 原样回吐载入值。"""
        if not self._fresh and self.is_untouched():
            return self._orig if self._orig is _MISSING else copy.deepcopy(self._orig)
        o = self._orig if isinstance(self._orig, dict) and not self._fresh else {}
        out: dict[str, Any] = {k: copy.deepcopy(v) for k, v in o.items() if k not in BLOWOUT_KEYS}
        for key, _label, _default in BLOWOUT_REQUIRED:
            v = self._req[key].value()
            if v == self._num_seeds.get(key):
                if key in o:
                    out[key] = copy.deepcopy(o[key])
                    continue
                if not self._fresh:
                    continue      # 磁盘上本来就缺：没动过就别凭空编一个 0
            r = round(v, 4)
            # 风速 / 秒数多是整数（现网 8 / 4 / 3）：整数值落成 int，别给新配的块写出 8.0
            out[key] = num_repr_like(int(r) if float(r).is_integer() else r, o.get(key))
        if self._ember_below.is_untouched():
            if "emberBelow" in o:
                out["emberBelow"] = copy.deepcopy(o["emberBelow"])
        else:
            eb = self._ember_below.value()
            if eb is not None:
                out["emberBelow"] = eb
        for key, combo in (("emberState", self._ember_state), ("outState", self._out_state),
                           ("recoverState", self._recover_state)):
            v = combo.value()
            if v is not _MISSING:
                out[key] = v
        if self._auto.isChecked() == self._auto_seed:
            if "auto" in o:
                out["auto"] = copy.deepcopy(o["auto"])
        elif not self._auto.isChecked():
            out["auto"] = False
        if self._fade.is_untouched():
            if "fadeMs" in o:
                out["fadeMs"] = copy.deepcopy(o["fadeMs"])
        else:
            fm = self._fade.value()
            if fm is not None:
                out["fadeMs"] = fm
        for key, ed in self._acts.items():
            acts = ed.to_list()
            if acts == self._act_seeds.get(key):
                if key in o:
                    out[key] = copy.deepcopy(o[key])
            elif acts or key in o:
                out[key] = acts
        preserve_numeric_repr(out, o)
        return reorder_like(out, o)


class PropBlowoutBlock(QWidget):
    """基础块的「风吹灭」：默认折叠 + 懒建 + 「风能吹灭」开关（不勾 = 不写 `blowout` 键）。

    没展开过 ⇒ `dump()` 原样回吐载入值（一个字节都不经过 Qt 控件）。配了这一块就当场建控件并展开。
    """

    changed = Signal()

    def __init__(self, model: Any, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._loading = False
        self._built = False
        self._pending: Any = _MISSING
        self._names: list[str] = []
        self._on_seed = False
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self._section = CollapsibleSection("风吹灭（不写 = 吹不灭）", start_open=False)
        self._section.set_header_tool_tip(BLOWOUT_TIP + "状态里可以单独写「这个状态吹不灭」或自己的一块（在状态表里）。")
        self._section.expanded_changed.connect(self._on_expanded)
        self._body = QWidget()
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        self._body_layout.setSpacing(4)
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
            self._on = QCheckBox("风能吹灭", self._body)
            self._on.setToolTip("勾掉 = **不写 `blowout` 键** = 永远吹不灭（灯笼、演出道具火）。\n" + BLOWOUT_TIP)
            self._on.toggled.connect(self._on_enable_toggled)
            self._body_layout.addWidget(self._on)
            self._form = PropBlowoutForm(self._model, in_state=False, parent=self._body)
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

    def _on_enable_toggled(self, on: bool) -> None:
        if self._loading:
            return
        self._form.setEnabled(on)
        if on and not isinstance(self._pending, dict) and not self._form.is_fresh():
            # 从"没有 / 坏形态"勾上 = 新配一块：给一组能吹灭的缺省
            was = self._loading
            self._loading = True
            try:
                self._form.set_data(self._pending, fresh=True)
            finally:
                self._loading = was
        self._emit()

    def _fill(self) -> None:
        if not self._built:
            return
        was = self._loading
        self._loading = True
        try:
            has = isinstance(self._pending, dict)
            self._on.setChecked(has)
            self._on_seed = has
            self._form.setEnabled(has)
            self._form.set_state_names(self._names)
            self._form.set_data(self._pending)
        finally:
            self._loading = was
        self._refresh_title()

    def _refresh_title(self) -> None:
        from ..shared.prop_preview import ABSENT, js_number

        d = self.dump()
        if not isinstance(d, dict):
            self._section.set_title("风吹灭（不写 = 吹不灭）" if d is _MISSING else "风吹灭：（坏，吹不灭）")
            return
        nums = [js_number(d.get(k, ABSENT)) for k, _l, _d in BLOWOUT_REQUIRED]
        if any(n is None or n <= 0 for n in nums):
            self._section.set_title("风吹灭：（缺必填量，吹不灭）")
            return
        bits = [f"吹熄 {nums[0]:g} m/s", f"掉 {nums[1]:g} s", f"回 {nums[2]:g} s"]
        eb = js_number(d.get("emberBelow", ABSENT))
        if eb is not None:
            bits.append(f"残炭线 {eb:g}")
        if d.get("auto") is False:
            bits.append("只执行动作")
        self._section.set_title("风吹灭：" + "　".join(bits))

    # ---------------------------------------------------------------- 外部
    def set_data(self, entry: object) -> None:
        """从一条预设载入（只取 `blowout` 键）。"""
        src = entry if isinstance(entry, dict) else {}
        self._pending = copy.deepcopy(src["blowout"]) if "blowout" in src else _MISSING
        if self._pending is not _MISSING:
            self.ensure_built()
            self._section.set_expanded(True)
        if self._built:
            self._fill()
        self._refresh_title()

    def set_state_names(self, names: list[str]) -> None:
        self._names = [str(n) for n in names]
        if self._built:
            self._form.set_state_names(self._names)

    def reload_refs(self) -> None:
        if self._built:
            self._form.reload_refs()

    def dump(self) -> Any:
        """`_MISSING` = 不写 `blowout` 键。没展开过 / 什么都没动 ⇒ 原样回吐载入值。"""
        if not self._built:
            return self._pending if self._pending is _MISSING else copy.deepcopy(self._pending)
        on = self._on.isChecked()
        if on == self._on_seed and not self._form.is_fresh() and self._form.is_untouched():
            return self._pending if self._pending is _MISSING else copy.deepcopy(self._pending)
        if not on:
            return _MISSING
        return self._form.dump()


#: 状态里 `blowout` 的三档（值是内部标记，不落盘）。
STATE_BLOWOUT_INHERIT = "inherit"
STATE_BLOWOUT_NONE = "none"
STATE_BLOWOUT_OWN = "own"


class PropStateBlowoutField(QWidget):
    """状态里的 `blowout`：**三态**（沿用基础块 / 这个状态吹不灭 `null` / 这个状态自己的一块，整块替换）。"""

    changed = Signal()

    def __init__(self, model: Any, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._loading = False
        self._mode_seed = STATE_BLOWOUT_INHERIT
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self._mode = QComboBox(self)
        self._mode.addItem("沿用基础块（不写 blowout 键）", STATE_BLOWOUT_INHERIT)
        self._mode.addItem("这个状态吹不灭（blowout: null）", STATE_BLOWOUT_NONE)
        self._mode.addItem("这个状态自己的（整块替换基础块那份）", STATE_BLOWOUT_OWN)
        self._mode.setMaximumWidth(330)
        self._mode.setToolTip(
            "三档，运行时语义各不相同：\n"
            "· 不写 blowout 键 = 沿用基础块那份（基础块也没写 = 吹不灭）；\n"
            "· blowout: null = **这个状态风吹不灭**（护火、演出里要稳住的那几拍）；\n"
            "· blowout: {...} = 整块替换基础块那份（不逐项合并，必填量要写全）。\n"
            "⚠ 灭状态（out）已经不再算火势，什么都不用写。\n" + BLOWOUT_TIP)
        self._mode.currentIndexChanged.connect(self._on_mode_changed)
        lay.addWidget(self._mode)
        self._form = PropBlowoutForm(model, in_state=True, parent=self)
        self._form.changed.connect(self._emit)
        self._form.setVisible(False)
        lay.addWidget(self._form)

    def _emit(self, *_a: object) -> None:
        if self._loading:
            return
        self.changed.emit()

    def _on_mode_changed(self, *_a: object) -> None:
        self._form.setVisible(self._mode.currentData() == STATE_BLOWOUT_OWN)
        _relayout_up(self._form, self)
        self._emit()

    def set_state_names(self, names: list[str]) -> None:
        self._form.set_state_names(names)

    def reload_refs(self) -> None:
        self._form.reload_refs()

    def set_data(self, state: dict | None) -> None:
        """按 `'blowout' in state` 判三档（`null` 与"没写"绝不能混）。"""
        was = self._loading
        self._loading = True
        try:
            raw = state or {}
            if "blowout" not in raw:
                mode = STATE_BLOWOUT_INHERIT
                self._form.set_data(None, fresh=True)
            elif raw.get("blowout") is None:
                mode = STATE_BLOWOUT_NONE
                self._form.set_data(None, fresh=True)
            else:
                mode = STATE_BLOWOUT_OWN
                self._form.set_data(raw.get("blowout"))
            idx = self._mode.findData(mode)
            self._mode.setCurrentIndex(idx if idx >= 0 else 0)
            self._mode_seed = mode
            self._form.setVisible(mode == STATE_BLOWOUT_OWN)
        finally:
            self._loading = was

    def mode(self) -> str:
        return str(self._mode.currentData())

    def write_into(self, out: dict) -> None:
        """按档位写键。沿用档 = **什么都不写**（不是写 null）。"""
        mode = self._mode.currentData()
        if mode == STATE_BLOWOUT_NONE:
            out["blowout"] = None
        elif mode == STATE_BLOWOUT_OWN:
            out["blowout"] = self._form.dump()


class PropPlayerControlBlock(QWidget):
    """基础块的「玩家操作」`playerControl`：默认折叠 + 懒建 + 「玩家可操作」开关（不勾 = 不写键）。

    写了对象（哪怕 `{}`）= 玩家能用键操作：T 点火 / 熄灭，按住 Q 护火。切到的状态名不写 = 缺省
    （lit / guarding / out），两个渐变不写走缺省。没展开过 / 什么都没动 ⇒ 原样回吐载入值。
    """

    changed = Signal()

    #: (键, 表单标签, 缺省状态名, 说明)
    _STATE_ROWS: tuple[tuple[str, str, str, str], ...] = (
        ("litState", "点火切到", "lit", "玩家按 T 点火切到哪个状态。不写 = lit。"),
        ("guardState", "护火切到", "guarding", "玩家按住 Q 护火切到哪个状态（松开回点着）。不写 = guarding。"),
        ("outState", "熄灭切到", "out", "玩家按 T 熄灭切到哪个状态。不写 = out。"),
    )
    #: (键, 表单标签, 缺省毫秒, 说明)
    _FADE_ROWS: tuple[tuple[str, str, int, str], ...] = (
        ("extinguishFadeMs", "熄灭渐变 ms", 400, "按 T 熄灭时灯强度 / 燃烧强度的渐变。不写 = 400。"),
        ("igniteFadeMs", "点火渐变 ms", 250, "按 T 点火时的渐变。不写 = 250。"),
    )

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._loading = False
        self._built = False
        self._pending: Any = _MISSING
        self._names: list[str] = []
        self._on_seed = False
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self._section = CollapsibleSection("玩家操作（不写 = 玩家不能操作）", start_open=False)
        self._section.set_header_tool_tip(PLAYER_CONTROL_TIP)
        self._section.expanded_changed.connect(self._on_expanded)
        self._body = QWidget()
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        self._body_layout.setSpacing(4)
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
            self._on = QCheckBox("玩家可操作（T 点火/熄灭，按住 Q 护火）", self._body)
            self._on.setToolTip("勾掉 = **不写 `playerControl` 键** = 玩家不能操作这件挂件。\n" + PLAYER_CONTROL_TIP)
            self._on.toggled.connect(self._on_enable_toggled)
            self._body_layout.addWidget(self._on)
            self._fields = QWidget(self._body)
            form = compact_form(QFormLayout(self._fields))
            self._states: dict[str, OptionalStateNameCombo] = {}
            for key, label, default, tip in self._STATE_ROWS:
                combo = OptionalStateNameCombo(default, self._fields)
                combo.setToolTip(tip + "\n预设里没有这个状态 ⇒ 玩家按下去切不过去（校验器报 warning）。")
                combo.changed.connect(self._emit)
                form.addRow(label, combo)
                self._states[key] = combo
            self._fades: dict[str, OptionalIntField] = {}
            for key, label, default, tip in self._FADE_ROWS:
                field = OptionalIntField(0, 600000, seed=default, parent=self._fields)
                field.set_tool_tip(tip)
                field.changed.connect(self._emit)
                form.addRow(label, field)
                self._fades[key] = field
            self._hint_below = OptionalNumField(
                0.0, 1.0, 0.05, 3, seed=PLAYER_CONTROL_HINT_BELOW_DEFAULT, parent=self._fields,
                check_label="写",
                check_tip=f"不勾 = 不写：按缺省 {PLAYER_CONTROL_HINT_BELOW_DEFAULT:g}。")
            self._hint_below.set_tool_tip(PLAYER_CONTROL_HINT_TIP)
            self._hint_below.changed.connect(self._emit)
            form.addRow("快灭提示线", self._hint_below)
            # 三态而非勾选框：运行时缺省是 true，勾选框的中性态是 false ⇒ 两态就配不出"沿用缺省"
            #（照 playNpcAnimation.loop 的惯例，与本模块 `lit` 同一个道理）
            self._guard_run = TristateBoolCombo(
                tristate_rows(
                    f"沿用缺省（不写 = {str(PLAYER_CONTROL_GUARD_BLOCKS_RUN_DEFAULT).lower()}：只能走）",
                    "只能走（true）", "照样能跑（false）"),
                self._fields)
            self._guard_run.setToolTip(PLAYER_CONTROL_GUARD_RUN_TIP)
            self._guard_run.currentIndexChanged.connect(self._emit)
            form.addRow("护火时能跑吗", self._guard_run)
            self._body_layout.addWidget(self._fields)
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

    def _on_enable_toggled(self, on: bool) -> None:
        if self._loading:
            return
        self._fields.setEnabled(on)
        self._emit()

    def _fill(self) -> None:
        if not self._built:
            return
        was = self._loading
        self._loading = True
        try:
            has = isinstance(self._pending, dict)
            o = self._pending if has else {}
            self._on.setChecked(has)
            self._on_seed = has
            self._fields.setEnabled(has)
            for key, combo in self._states.items():
                combo.set_state_names(self._names)
                combo.set_value(o.get(key, _MISSING))
            for key, field in self._fades.items():
                field.set_value(o.get(key))
            self._hint_below.set_value(o.get("hintBelow"))
            self._guard_run.set_value(o.get("guardBlocksRun"))
            self._guard_seed = self._guard_run.currentIndex()
        finally:
            self._loading = was
        self._refresh_title()

    def _untouched(self) -> bool:
        return (self._on.isChecked() == self._on_seed
                and all(c.is_untouched() for c in self._states.values())
                and all(f.is_untouched() for f in self._fades.values())
                and self._hint_below.is_untouched()
                and self._guard_run.currentIndex() == getattr(self, "_guard_seed", 0))

    def _refresh_title(self) -> None:
        d = self.dump()
        if d is _MISSING:
            self._section.set_title("玩家操作（不写 = 玩家不能操作）")
        elif not isinstance(d, dict):
            self._section.set_title("玩家操作：（坏，玩家不能操作）")
        else:
            names = [str(d.get(k)).strip() if isinstance(d.get(k), str) and d.get(k).strip() else dflt
                     for k, _l, dflt, _t in self._STATE_ROWS]
            self._section.set_title("玩家操作：T 点火→" + names[0] + " / 熄灭→" + names[2]
                                    + "，按住 Q→" + names[1])

    # ---------------------------------------------------------------- 外部
    def set_data(self, entry: object) -> None:
        """从一条预设载入（只取 `playerControl` 键）。"""
        src = entry if isinstance(entry, dict) else {}
        self._pending = copy.deepcopy(src["playerControl"]) if "playerControl" in src else _MISSING
        if self._pending is not _MISSING:
            self.ensure_built()
            self._section.set_expanded(True)
        if self._built:
            self._fill()
        self._refresh_title()

    def set_state_names(self, names: list[str]) -> None:
        self._names = [str(n) for n in names]
        if self._built:
            for combo in self._states.values():
                combo.set_state_names(self._names)

    def dump(self) -> Any:
        """`_MISSING` = 不写 `playerControl` 键。"""
        if not self._built or self._untouched():
            return self._pending if self._pending is _MISSING else copy.deepcopy(self._pending)
        if not self._on.isChecked():
            return _MISSING
        o = self._pending if isinstance(self._pending, dict) else {}
        out: dict[str, Any] = {k: copy.deepcopy(v) for k, v in o.items() if k not in PLAYER_CONTROL_KEYS}
        for key, combo in self._states.items():
            v = combo.value()
            if v is not _MISSING:
                out[key] = v
        for key, field in self._fades.items():
            if field.is_untouched():
                if key in o:
                    out[key] = copy.deepcopy(o[key])
                continue
            v = field.value()
            if v is not None:
                out[key] = v
        if self._hint_below.is_untouched():
            if "hintBelow" in o:
                out["hintBelow"] = copy.deepcopy(o["hintBelow"])
        else:
            hb = self._hint_below.value()
            if hb is not None:
                out["hintBelow"] = hb
        if self._guard_run.currentIndex() == getattr(self, "_guard_seed", 0):
            if "guardBlocksRun" in o:
                out["guardBlocksRun"] = copy.deepcopy(o["guardBlocksRun"])
        else:
            gb = self._guard_run.value()
            if gb is not None:
                out["guardBlocksRun"] = gb
        return reorder_like(out, o)


#: `PropIgniterDef` 里表单管着的键。其余键原样透传。
IGNITER_KEYS = ("flameLength",)
#: 火头火焰长度缺省（厘米，`PROP_IGNITER_DEFAULT_FLAME_CM`）
IGNITER_FLAME_CM_DEFAULT = 20
#: 能点火的说明（基础块与状态两处共用一份）
IGNITER_TIP = (
    "能点火：写了这一块、并且**此刻燃着**（当前状态有灯、灯强度 > 0），\n"
    "玩家就能拿它去点地图上的可燃物（点火表演），燃着的火头也会引燃碰到的可燃粒子（纸钱）。\n"
    "状态里可以单独写「这个状态点不了」（igniter: null）或自己的一块（整块替换）。\n"
    "不写这一块 = 点不了别的东西。\n"
)
#: 火焰长度的说明
IGNITER_FLAME_TIP = (
    "火头火焰长度（厘米）：从起火点沿火焰轴伸出去多远算「碰到」——**只管引燃判定够得着多远**，\n"
    "不管火苗画多大（那是粒子挂载 / 火焰块的事）。\n"
    f"不写 = {IGNITER_FLAME_CM_DEFAULT} cm；写了但不是 > 0 的数 ⇒ 运行时当没写（用缺省）。"
)


class PropIgniterForm(QWidget):
    """一块 `igniter`（能点火）的表单。基础块（`PropIgniterBlock`）与状态（`PropStateIgniterField`）共用这一个。

    ## 往返
    - 整块没动过（且不是新配的）⇒ `dump()` 原样回吐载入值（坏形态、不认识的键、键序，一个字节不改）；
    - 动过 ⇒ `flameLength` 没动过回吐磁盘原值（含 `-5` / `"20"` 这类怪值），不认识的键透传、键序按磁盘原序；
    - 改过的火焰长度是整数就落 int（`25` 不写成 `25.0`）；
    - `fresh`（新配一块）⇒ 只写 `{}`（全用缺省）。
    """

    changed = Signal()

    def __init__(self, *, in_state: bool, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._in_state = in_state
        self._loading = False
        self._orig: Any = _MISSING
        self._fresh = False
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        top = QWidget(self)
        form = compact_form(QFormLayout(top))
        self._flame = OptionalNumField(
            0.5, 500.0, 1.0, 1, seed=float(IGNITER_FLAME_CM_DEFAULT), parent=top, check_label="写",
            check_tip=f"不勾 = 不写 flameLength：按缺省 {IGNITER_FLAME_CM_DEFAULT} cm。")
        self._flame.set_tool_tip(IGNITER_FLAME_TIP)
        self._flame.changed.connect(self._emit)
        form.addRow("火焰长度 cm", self._flame)
        lay.addWidget(top)
        self._note = QLabel("", self)
        self._note.setWordWrap(True)
        lay.addWidget(self._note)
        self.set_data(None, fresh=True)

    def _emit(self, *_a: object) -> None:
        if self._loading:
            return
        self._refresh_note()
        self.changed.emit()

    def _refresh_note(self) -> None:
        from ..shared.prop_preview import ABSENT, js_number

        bad: list[str] = []
        d = self.dump()
        if d is not _MISSING and not isinstance(d, dict):
            bad.append("这块不是对象 ⇒ " + ("运行时当没写、沿用基础块。" if self._in_state else "运行时丢掉 = 点不了。"))
        elif isinstance(d, dict) and "flameLength" in d:
            # 口径同 parseIgniter：Number() 强转后 > 0 的有限数才算写了（"25" 运行时也认）
            n = js_number(d.get("flameLength", ABSENT))
            if n is None or n <= 0:
                bad.append(f"火焰长度 {d.get('flameLength')!r} 不是 > 0 的数 ⇒ 运行时当没写（{IGNITER_FLAME_CM_DEFAULT} cm）。")
        self._note.setText("　".join(bad))
        self._note.setStyleSheet("color:#c66;" if bad else "color:#888;")

    def set_data(self, raw: Any, *, fresh: bool = False) -> None:
        """载入一块（`_MISSING` / `None` / 非对象都行）。`fresh` = 新配一块：写出 `{}`。"""
        was = self._loading
        self._loading = True
        try:
            self._fresh = fresh
            self._orig = _MISSING if raw is _MISSING else copy.deepcopy(raw)
            o = raw if isinstance(raw, dict) and not fresh else {}
            self._flame.set_value(o.get("flameLength"))
        finally:
            self._loading = was
        self._refresh_note()

    def is_fresh(self) -> bool:
        return self._fresh

    def is_untouched(self) -> bool:
        return self._flame.is_untouched()

    def dump(self) -> Any:
        """这一块的落盘值。整块没动过（且不是新配的）⇒ 原样回吐载入值。"""
        if not self._fresh and self.is_untouched():
            return self._orig if self._orig is _MISSING else copy.deepcopy(self._orig)
        o = self._orig if isinstance(self._orig, dict) and not self._fresh else {}
        out: dict[str, Any] = {k: copy.deepcopy(v) for k, v in o.items() if k not in IGNITER_KEYS}
        if self._flame.is_untouched():
            if "flameLength" in o:
                out["flameLength"] = copy.deepcopy(o["flameLength"])
        else:
            v = self._flame.value()
            if v is not None:
                r = round(float(v), 4)
                out["flameLength"] = num_repr_like(int(r) if r.is_integer() else r, o.get("flameLength"))
        return reorder_like(out, o)


class PropIgniterBlock(QWidget):
    """基础块的「能点火」：默认折叠 + 懒建 + 「能点火」开关（不勾 = 不写 `igniter` 键）。

    勾上 = 写对象（`{}` = 全用缺省）；火焰长度可选。没展开过 / 什么都没动 ⇒ 原样回吐载入值。
    """

    changed = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._loading = False
        self._built = False
        self._pending: Any = _MISSING
        self._on_seed = False
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self._section = CollapsibleSection("能点火（不写 = 点不了）", start_open=False)
        self._section.set_header_tool_tip(IGNITER_TIP)
        self._section.expanded_changed.connect(self._on_expanded)
        self._body = QWidget()
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        self._body_layout.setSpacing(4)
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
            self._on = QCheckBox("能点火（igniter）", self._body)
            self._on.setToolTip("勾上 = 写 `igniter` 对象；勾掉 = **不写 `igniter` 键** = 点不了别的东西。\n" + IGNITER_TIP)
            self._on.toggled.connect(self._on_enable_toggled)
            self._body_layout.addWidget(self._on)
            self._form = PropIgniterForm(in_state=False, parent=self._body)
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

    def _on_enable_toggled(self, on: bool) -> None:
        if self._loading:
            return
        self._form.setEnabled(on)
        if on and not isinstance(self._pending, dict) and not self._form.is_fresh():
            # 从"没有 / 坏形态"勾上 = 新配一块：写 {}（全用缺省）
            was = self._loading
            self._loading = True
            try:
                self._form.set_data(self._pending, fresh=True)
            finally:
                self._loading = was
        self._emit()

    def _fill(self) -> None:
        if not self._built:
            return
        was = self._loading
        self._loading = True
        try:
            has = isinstance(self._pending, dict)
            self._on.setChecked(has)
            self._on_seed = has
            self._form.setEnabled(has)
            self._form.set_data(self._pending)
        finally:
            self._loading = was
        self._refresh_title()

    def _refresh_title(self) -> None:
        from ..shared.prop_preview import ABSENT, js_number

        d = self.dump()
        if d is _MISSING:
            self._section.set_title("能点火（不写 = 点不了）")
        elif not isinstance(d, dict):
            self._section.set_title("能点火：（坏，点不了）")
        else:
            n = js_number(d.get("flameLength", ABSENT))
            if n is not None and n > 0:
                self._section.set_title(f"能点火：火焰长度 {n:g} cm")
            else:
                self._section.set_title(f"能点火：火焰长度 {IGNITER_FLAME_CM_DEFAULT} cm（缺省）")

    # ---------------------------------------------------------------- 外部
    def set_data(self, entry: object) -> None:
        """从一条预设载入（只取 `igniter` 键）。"""
        src = entry if isinstance(entry, dict) else {}
        self._pending = copy.deepcopy(src["igniter"]) if "igniter" in src else _MISSING
        if self._pending is not _MISSING:
            self.ensure_built()
            self._section.set_expanded(True)
        if self._built:
            self._fill()
        self._refresh_title()

    def dump(self) -> Any:
        """`_MISSING` = 不写 `igniter` 键。没展开过 / 什么都没动 ⇒ 原样回吐载入值。"""
        if not self._built:
            return self._pending if self._pending is _MISSING else copy.deepcopy(self._pending)
        on = self._on.isChecked()
        if on == self._on_seed and not self._form.is_fresh() and self._form.is_untouched():
            return self._pending if self._pending is _MISSING else copy.deepcopy(self._pending)
        if not on:
            return _MISSING
        return self._form.dump()


#: 状态里 `igniter` 的三档（值是内部标记，不落盘）。
STATE_IGNITER_INHERIT = "inherit"
STATE_IGNITER_NONE = "none"
STATE_IGNITER_OWN = "own"


class PropStateIgniterField(QWidget):
    """状态里的 `igniter`：**三态**（沿用基础块 / 这个状态点不了 `null` / 这个状态自己的一块，整块替换）。"""

    changed = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._loading = False
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self._mode = QComboBox(self)
        self._mode.addItem("沿用基础块（不写 igniter 键）", STATE_IGNITER_INHERIT)
        self._mode.addItem("这个状态点不了（igniter: null）", STATE_IGNITER_NONE)
        self._mode.addItem("这个状态自己的（整块替换基础块那份）", STATE_IGNITER_OWN)
        self._mode.setMaximumWidth(330)
        self._mode.setToolTip(
            "三档，运行时语义各不相同：\n"
            "· 不写 igniter 键 = 沿用基础块那份（基础块也没写 = 点不了）；\n"
            "· igniter: null = **这个状态点不了**；\n"
            "· igniter: {...} = 整块替换基础块那份（火焰长度不写 = 缺省，不从基础块继承）。\n"
            "⚠ 灭了（没有灯）本来就点不了，灭状态什么都不用写。\n" + IGNITER_TIP)
        self._mode.currentIndexChanged.connect(self._on_mode_changed)
        lay.addWidget(self._mode)
        self._form = PropIgniterForm(in_state=True, parent=self)
        self._form.changed.connect(self._emit)
        self._form.setVisible(False)
        lay.addWidget(self._form)

    def _emit(self, *_a: object) -> None:
        if self._loading:
            return
        self.changed.emit()

    def _on_mode_changed(self, *_a: object) -> None:
        self._form.setVisible(self._mode.currentData() == STATE_IGNITER_OWN)
        _relayout_up(self._form, self)
        self._emit()

    def set_data(self, state: dict | None) -> None:
        """按 `'igniter' in state` 判三档（`null` 与"没写"绝不能混）。"""
        was = self._loading
        self._loading = True
        try:
            raw = state or {}
            if "igniter" not in raw:
                mode = STATE_IGNITER_INHERIT
                self._form.set_data(None, fresh=True)
            elif raw.get("igniter") is None:
                mode = STATE_IGNITER_NONE
                self._form.set_data(None, fresh=True)
            else:
                mode = STATE_IGNITER_OWN
                self._form.set_data(raw.get("igniter"))
            idx = self._mode.findData(mode)
            self._mode.setCurrentIndex(idx if idx >= 0 else 0)
            self._form.setVisible(mode == STATE_IGNITER_OWN)
        finally:
            self._loading = was

    def mode(self) -> str:
        return str(self._mode.currentData())

    def write_into(self, out: dict) -> None:
        """按档位写键。沿用档 = **什么都不写**（不是写 null）。"""
        mode = self._mode.currentData()
        if mode == STATE_IGNITER_NONE:
            out["igniter"] = None
        elif mode == STATE_IGNITER_OWN:
            out["igniter"] = self._form.dump()


# =========================================================================== #
# 火把养成（玩法清单 A3.7，2026-09-16）：耐久 `fuel` / 效果块 `effects` / 等级 `levels`
#
# 三块都**只在基础块**——耐久是这根火把的事、脾气不随状态变、等级住在存档里，状态里写了运行时不读
#（校验器报 warning）。TS 权威 `src/data/propPresets.ts`（`PropFuelDef` / `PropEffectDef` / `PropLevelDef`）。
# =========================================================================== #

#: 耐久块里表单管着的键。其余键原样透传
FUEL_KEYS = ("seconds", "windFactor", "outState", "onSpentActions", "keepInHandWhenSpent")

#: 「烧完留在手上」缺省（TS `PropFuelDef.keepInHandWhenSpent`：缺省 false = 烟散完系统自己拿掉）
FUEL_KEEP_IN_HAND_DEFAULT = False
FUEL_KEEP_IN_HAND_TIP = (
    "烧完之后那根杆子留不留在手上。\n"
    "不写（缺省）= 灭掉、照常冒那口烟，烟散完系统自己把它从手上拿掉。\n"
    "写 true = 烧焦的杆子留在手上，玩家自己收——剧情要那根焦木头时用。\n"
    "⚠ 别在「烧完之后」的动作里写卸下挂件：那会把烧完那口烟同帧掐掉。"
)
#: 新配一块耐久时 `seconds` 的缺省（现网临时火把 150 / 200 / 240 秒）
FUEL_SECONDS_SEED = 180.0
#: 没写 `windFactor` 时运行时的缺省（TS `PROP_FUEL_WIND_FACTOR`）
FUEL_WIND_FACTOR_DEFAULT = 0.1
#: 耐久块的说明
FUEL_TIP = (
    "耐久 = 燃料时长（玩法清单 A3.7「火把养成」）。不写这一块 = 没有耐久：点着就一直烧得下去\n"
    "（随身那根旧纤藤就是这样）。写了 = 临时火把，烧完就没。\n"
    "· 只有燃着的时候在烧；残炭烧得慢（三成）；\n"
    "· 风大烧得快：每秒烧掉 1 + 风里那一项 ×「挡过风之后」的气流（护火挡掉的不算）；\n"
    "· 烧到两成以下火苗与灯按剩下的比例变小变暗，火边那个符号装的就是剩下的燃料；\n"
    "· 烧完 = 切到「烧完切到」那个状态（与被风吹灭同一条路，不算「点火」），再执行「烧完之后」的动作。\n"
    "⚠ 只在基础块：状态里写了运行时不读。"
)
#: 效果块列表的说明（基础块与等级两处共用一份）
EFFECTS_TIP = (
    "这支火把的脾气：一份基础燃烧配置 + 若干效果块（prop_effects.json，「挂件效果块」页维护）。\n"
    "合成规矩（制作人定）：数值类相乘（几块都写了就连乘）、行为类（驱 / 招 / 标签）并集；\n"
    f"每支最多 {PROP_EFFECTS_MAX_HINT} 块——多了组合爆炸、玩家也读不懂。多写的运行时只认前两块（校验器报 error）。\n"
    "等级带的效果块与预设自己这一串合起来算上限。\n"
    "⚠ 只在基础块：效果是这根火把的脾气，不随状态变。"
)
#: 等级块的说明
LEVELS_TIP = (
    "等级表（玩法清单 A3.7「火把养成」）：随身那根火把的升级。第 1 项 = 出厂的样子。\n"
    "一级 = 一套外观（换贴图）+ 一串效果块（升级给的是「稳和好用」，那些倍率写在效果块里）。\n"
    "不写这一块 = 这根不能升级（运行时恒第 1 级）。等级本身住在存档里（按挂件 id 记），\n"
    "拿在手上还是收在包里都算数；内容侧用动作 setPropLevel 升、用条件叶 propLevel 问。\n"
    "⚠ 每级必须一眼看得出（制作人定）：换外观、火焰变、描述变。三级封顶，再多玩家感不到差别。"
)


#: 一块效果在运行时的下场（{@link prop_effects_verdict} 的第三项）
EFFECT_TAKES = "take"       # 真生效
EFFECT_UNKNOWN = "unknown"  # 库里查不到 ⇒ 运行时跳过，**不占名额**
EFFECT_OVER = "over"        # 上限之后的 ⇒ 运行时根本没走到，静默不生效


def _quote_ids(items: list[tuple[str, str]], level_name: str) -> str:
    """`[(来源, id), …]` → 「第 2 级「oiled」、预设自己「resin」」。

    **来源必须写出来**：两串可以挂同一个 id（等级挂了 oiled、预设自己也挂了 oiled），
    只列 id 的话红字会写成「真生效的是「oiled」，「oiled」不生效」——作者读不出是哪一个。
    """
    if not items:
        return "（没有）"
    where = {"level": level_name or "等级", "base": "预设自己"}
    return "、".join(f"{where.get(o, o)}「{i or '（空）'}」" for o, i in items)


def _prop_effect_known(model: object) -> Callable[[str], bool]:
    """「这个 id 在 prop_effects.json 里吗」。

    取不到效果块库时一律**当认识**（fail-safe 取"会警告"那一侧）：当不认识的话
    整条红字就此消失，作者看到的是"一块都没超"——那正是这条提示要防的静默。
    """
    table = getattr(model, "prop_effects", None)
    if isinstance(table, dict):
        return lambda eid: eid in table
    return bool


def prop_effects_verdict(
    level_ids: object, base_ids: object, is_known: Callable[[str], bool],
) -> list[tuple[str, str, str]]:
    """按运行时口径算「哪几块真生效」。返回 `[(来源, id, 下场), …]`，来源 ∈ {"level","base"}。

    权威 = `HeldPropSystem.effectsOf`（`src/systems/heldProp/HeldPropSystem.ts`）：

    1. **等级那一串在前、预设自己那一串在后**（`[...levels[lv-1].effects, ...preset.effects]`）；
    2. 查不到的 id **跳过且不占名额**（runtime `if (!e) continue`）——所以写错一个 id
       并不会顶掉后面那块；
    3. 已经收满 {@link PROP_EFFECTS_MAX_HINT} 块就 `break` —— 之后的**一律**不生效
       （包括查不到的那些，runtime 根本没走到它们）。

    这三条缺一条，红字说的数就和玩家看到的火把对不上。
    """
    out: list[tuple[str, str, str]] = []
    taken = 0
    for origin, ids in (("level", level_ids), ("base", base_ids)):
        for raw in ids if isinstance(ids, list) else []:
            eid = raw.strip() if isinstance(raw, str) else str(raw)
            if taken >= PROP_EFFECTS_MAX_HINT:
                out.append((origin, eid, EFFECT_OVER))
                continue
            if not isinstance(raw, str) or not eid or not is_known(eid):
                out.append((origin, eid, EFFECT_UNKNOWN))
                continue
            taken += 1
            out.append((origin, eid, EFFECT_TAKES))
    return out


def prop_effects_cap_note(
    level_ids: object, base_ids: object, is_known: Callable[[str], bool],
    *, level_name: str = "",
) -> str:
    """表单里那行红字（基础块与等级两处共用一份口径）。没有一块被上限挤掉 ⇒ 空串。

    `level_name` = 这次拿来算的是哪一级（「这一级」/「第 2 级」）；空 = 这支火把没有等级。
    """
    verdict = prop_effects_verdict(level_ids, base_ids, is_known)
    over = [(o, i) for o, i, s in verdict if s == EFFECT_OVER]
    if not over:
        return ""
    take = [(o, i) for o, i, s in verdict if s == EFFECT_TAKES]
    unknown = [(o, i) for o, i, s in verdict if s == EFFECT_UNKNOWN]
    n_lv = len(level_ids) if isinstance(level_ids, list) else 0
    n_base = len(base_ids) if isinstance(base_ids, list) else 0
    if n_lv and level_name:
        head = (f"⚠ {level_name}那 {n_lv} 块 + 预设自己那 {n_base} 块 = {n_lv + n_base} 块，"
                f"超过上限 {PROP_EFFECTS_MAX_HINT} 块 —— ")
    else:
        head = f"⚠ 挂了 {n_lv + n_base} 块，超过上限 {PROP_EFFECTS_MAX_HINT} 块 —— "
    body = (f"运行时先算等级、再算预设自己，只收前 {PROP_EFFECTS_MAX_HINT} 块："
            f"真生效的是{_quote_ids(take, level_name)}；"
            f"{_quote_ids(over, level_name)}静默不生效。")
    tail = (f"（{_quote_ids(unknown, level_name)}不在 prop_effects.json 里，"
            f"运行时跳过、不占名额。）" if unknown else "")
    return head + body + tail


def prop_effect_summary(entry: object) -> str:
    """一块效果的「乘了什么」摘要（作者在挑的时候得看得见它到底改什么）。

    只读渲染，口径同 `propPresets.ts::parsePropEffects`：只有 > 0 的有限数才算写了。
    """
    if not isinstance(entry, dict):
        return "（这一条不是对象，运行时丢掉）"
    bits: list[str] = []

    def mul(v: object) -> float | None:
        from ..shared.prop_preview import js_number

        n = js_number(v)
        return n if n is not None and n > 0 else None

    for key, name in (("intensity", "亮度"), ("range", "照多远")):
        sub = entry.get("light")
        n = mul(sub.get(key)) if isinstance(sub, dict) else None
        if n is not None:
            bits.append(f"{name}×{n:g}")
    for key, name in (("burn", "火旺"), ("fuelRate", "烧得快"), ("igniterFlame", "火头长")):
        n = mul(entry.get(key))
        if n is not None:
            bits.append(f"{name}×{n:g}")
    for key, name in (("windSpeed", "吹熄风速"), ("drainSeconds", "掉得慢"),
                      ("recoverSeconds", "回得快"), ("emberBelow", "残炭线")):
        sub = entry.get("wind")
        n = mul(sub.get(key)) if isinstance(sub, dict) else None
        if n is not None:
            bits.append(f"{name}×{n:g}")
    for f in entry.get("fields") or []:
        if not isinstance(f, dict):
            continue
        kind = "驱" if f.get("kind") == "fear" else "招" if f.get("kind") == "attract" else "?"
        tag = str(f.get("tag") or "?").strip() or "?"
        bits.append(f"{kind}「{tag}」")
    tags = [str(t).strip() for t in (entry.get("tags") or []) if isinstance(t, str) and str(t).strip()]
    if tags:
        bits.append("标签：" + "、".join(tags))
    return " · ".join(bits) if bits else "（这一块什么都不改）"


class PropEffectIdsField(QWidget):
    """一串效果块 id（基础块 `effects` / 某一级的 `levels[i].effects`）。两处共用这一个控件。

    每行 = 效果块选择器（`IdRefSelector`，点一下开可搜索弹窗；候选 =
    `ProjectModel.all_prop_effect_ids()`，与校验器接受面同一个函数，**禁裸 QLineEdit**）
    + 一行只读摘要（这一块乘了什么、并了哪些场与标签）+ 上移 / 下移 / 删。

    ## 往返
    - 整串没动过 ⇒ `to_list()` 原样回吐磁盘那一串（含 `" oiled "` 这种带空格的、重复的）；
    - 磁盘上不是字符串的坏条目（运行时跳过）显式成一行只读「(数据) …」原样透传，只能删；
    - 顺序**有意义**（运行时超上限时只认前两块），所以给上移 / 下移。

    ## 上限
    超过 {@link PROP_EFFECTS_MAX_HINT} 块时**不拦**（保值优先：拦下来就配不出"先删一块再换一块"），
    只在底下亮红字，校验器报 error。红字那句话**由宿主给**（`note_builder`，收到本控件此刻
    这一串 id，回吐要显示的文案）——因为"到底哪几块生效"要看另一串（等级 ↔ 预设自己）
    与效果块库，本控件自己看不全。不给 `note_builder` ⇒ 只按本串自己的条数提示。
    """

    changed = Signal()

    def __init__(self, model: Any, parent: QWidget | None = None,
                 *, note_builder: Callable[[list[Any]], str] | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._note_builder = note_builder
        #: 每行：{"kind": "id"|"bad", "host", "orig", "sel", "note"}
        self._rows: list[dict[str, Any]] = []
        self._raw: Any = _MISSING
        self._seed: list[Any] = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self._rows_layout = QVBoxLayout()
        self._rows_layout.setSpacing(2)
        lay.addLayout(self._rows_layout)
        self._add = QPushButton("+ 效果块")
        fit_width_cap(self._add, 120)
        self._add.setToolTip(EFFECTS_TIP)
        self._add.clicked.connect(lambda: self._add_row("", quiet=False))
        lay.addWidget(self._add)
        self._empty = QLabel("（没挂效果块：这支火把就是基础配置）", self)
        self._empty.setStyleSheet("color:#888;")
        lay.addWidget(self._empty)
        self._note = QLabel("", self)
        self._note.setWordWrap(True)
        lay.addWidget(self._note)

    # ---------------------------------------------------------------- 内部
    def _items(self) -> list[tuple[str, str]]:
        fn = getattr(self._model, "all_prop_effect_ids", None)
        if not callable(fn):
            return []
        try:
            return list(fn() or [])
        except Exception:  # noqa: BLE001 —— 候选取不到只是少了下拉，不能反噬面板
            return []

    def _effect_entry(self, eid: str) -> object:
        table = getattr(self._model, "prop_effects", None)
        return table.get(eid) if isinstance(table, dict) else None

    def _add_row(self, raw: Any, *, quiet: bool) -> None:
        host = QWidget(self)
        rl = QVBoxLayout(host)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.setSpacing(0)
        top = QWidget(host)
        tl = QHBoxLayout(top)
        tl.setContentsMargins(0, 0, 0, 0)
        tl.setSpacing(4)
        row: dict[str, Any] = {"host": host, "orig": copy.deepcopy(raw)}
        if isinstance(raw, str):
            row["kind"] = "id"
            sel = IdRefSelector(top, allow_empty=True, editable=False, click_opens_popup=True)
            sel.setMinimumWidth(180)
            sel.setMaximumWidth(320)
            sel.setToolTip("挂哪一块效果（prop_effects.json 的 id）。空着运行时跳过这一条。")
            sel.set_items(self._items())
            sel.set_current(raw.strip())
            sel.value_changed.connect(lambda _v, h=host: self._on_row_changed(h))
            row["sel"] = sel
            tl.addWidget(sel, 1)
        else:
            row["kind"] = "bad"
            lab = QLabel(f"(数据) {raw!r} —— 不是字符串，运行时跳过；原样保留", top)
            lab.setStyleSheet("color:#c66;")
            tl.addWidget(lab, 1)
        for text, tip, delta in (("↑", "上移（超上限时运行时只认前两块，顺序有意义）", -1), ("↓", "下移", 1)):
            b = compact_icon_button(text, tip, top)
            b.clicked.connect(lambda _c=False, h=host, d=delta: self._move(h, d))
            tl.addWidget(b)
        rm = compact_icon_button("−", "卸掉这一块效果", top)
        rm.clicked.connect(lambda _c=False, h=host: self._remove(h))
        tl.addWidget(rm)
        rl.addWidget(top)
        note = QLabel("", host)
        note.setWordWrap(True)
        note.setStyleSheet("color:#888;")
        rl.addWidget(note)
        row["note"] = note
        self._rows.append(row)
        self._rows_layout.addWidget(host)
        # ⚠ addWidget 之后子控件仍是 isHidden()，隐藏项被布局整个跳过（行高按"零行"算）
        host.show()
        self._refresh_row_note(row)
        self._sync_empty()
        if not quiet:
            self._refresh_note()   # 加一块可能就超了上限：红字得当场亮出来
            _relayout_up(host, self)
            self.changed.emit()

    def _refresh_row_note(self, row: dict[str, Any]) -> None:
        sel = row.get("sel")
        if sel is None:
            return
        eid = sel.current_id().strip()
        if not eid:
            row["note"].setText("（没选：运行时跳过这一条）")
            row["note"].setStyleSheet("color:#c66;")
            return
        entry = self._effect_entry(eid)
        if entry is None:
            row["note"].setText(f"⚠「{eid}」不在 prop_effects.json 里 —— 运行时跳过，这支火把的脾气就没了")
            row["note"].setStyleSheet("color:#c66;")
            return
        label = str(entry.get("label") or "").strip() if isinstance(entry, dict) else ""
        head = f"{label}：" if label else ""
        row["note"].setText(head + prop_effect_summary(entry))
        row["note"].setStyleSheet("color:#888;")

    def _on_row_changed(self, host: QWidget) -> None:
        i = self._index_of(host)
        if i >= 0:
            self._refresh_row_note(self._rows[i])
        self._refresh_note()
        self.changed.emit()

    def _index_of(self, host: QWidget) -> int:
        for i, r in enumerate(self._rows):
            if r["host"] is host:
                return i
        return -1

    def _remove(self, host: QWidget) -> None:
        i = self._index_of(host)
        if i < 0:
            return
        row = self._rows.pop(i)
        self._rows_layout.removeWidget(row["host"])
        discard_widget(row["host"])
        self._sync_empty()
        self._refresh_note()
        self.changed.emit()

    def _move(self, host: QWidget, delta: int) -> None:
        i = self._index_of(host)
        j = i + delta
        if i < 0 or j < 0 or j >= len(self._rows):
            return
        self._rows[i], self._rows[j] = self._rows[j], self._rows[i]
        self._rows_layout.removeWidget(host)
        self._rows_layout.insertWidget(j, host)
        host.show()
        self.changed.emit()

    def _sync_empty(self) -> None:
        self._empty.setVisible(not self._rows)

    def _refresh_note(self) -> None:
        """红字重算。**任何**会改变"哪几块生效"的事都得调它：本串增删改、另一串增删改、
        等级换选中（每一级挂的不一样，红字也就不一样）—— 少调一处就是"红字写着旧算术"。"""
        if self._note_builder is not None:
            text = self._note_builder(self._build())
        elif len(self._rows) > PROP_EFFECTS_MAX_HINT:
            text = (f"⚠ 挂了 {len(self._rows)} 块，超过上限 {PROP_EFFECTS_MAX_HINT} 块 —— "
                    f"运行时只收前 {PROP_EFFECTS_MAX_HINT} 块，多写的静默不生效")
        else:
            text = ""
        self._note.setText(text)
        self._note.setStyleSheet("color:#c66;" if text else "color:#888;")
        self._note.setVisible(bool(text))

    # ---------------------------------------------------------------- 外部
    def set_ids(self, raw: object) -> None:
        """载入（不发 `changed`）。`_MISSING` / 非数组 = 空列表（宿主自己决定键写不写）。"""
        for row in list(self._rows):
            self._rows_layout.removeWidget(row["host"])
            discard_widget(row["host"])
        self._rows.clear()
        self._raw = _MISSING if raw is _MISSING else copy.deepcopy(raw)
        for item in raw if isinstance(raw, list) else []:
            self._add_row(item, quiet=True)
        self._sync_empty()
        self._refresh_note()
        self._seed = self._build()

    def reload_refs(self) -> None:
        """跨面板刷新：效果块页新建 / 改名了，候选与摘要要跟上（当前值保值）。"""
        items = self._items()
        for row in self._rows:
            sel = row.get("sel")
            if sel is not None:
                cur = sel.current_id()
                sel.set_items(items)
                sel.set_current(cur)
            self._refresh_row_note(row)
        self._refresh_note()

    def count(self) -> int:
        return len(self._rows)

    def current_ids(self) -> list[Any]:
        """此刻控件里那一串（含还没提交回宿主暂存的改动）。红字与另一串对账用。"""
        return self._build()

    def refresh_note(self) -> None:
        """外部触发重算（另一串变了 / 换了选中的等级）。"""
        self._refresh_note()

    def _build(self) -> list[Any]:
        out: list[Any] = []
        for row in self._rows:
            if row["kind"] == "bad":
                out.append(copy.deepcopy(row["orig"]))
            else:
                out.append(row["sel"].current_id().strip())
        return out

    def is_untouched(self) -> bool:
        return self._build() == self._seed

    def to_list(self) -> Any:
        """`_MISSING` = 不写这个键。没动过 ⇒ 原样回吐磁盘那一串。"""
        if self.is_untouched():
            return self._raw if self._raw is _MISSING else copy.deepcopy(self._raw)
        return self._build()


class PropFuelBlock(QWidget):
    """基础块的「耐久（燃料）」`fuel`：默认折叠 + 懒建 + 「有耐久」开关（不勾 = 不写 `fuel` 键）。

    勾上 = 写对象（新配时按缺省秒数写出来）。没展开过 / 什么都没动 ⇒ 原样回吐载入值
    （一个字节都不经过 Qt 控件）。烧完的动作走 `ActionEditor` 的种子快照
    （它会 materialize 空参数，没动过必须回吐磁盘原值）。
    """

    changed = Signal()

    def __init__(self, model: Any, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._loading = False
        self._built = False
        self._pending: Any = _MISSING
        self._names: list[str] = []
        self._on_seed = False
        self._fresh = False
        self._sec_seed = 0.0
        self._act_seed: list = []
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self._section = CollapsibleSection("耐久（燃料）（不写 = 烧不完）", start_open=False)
        self._section.set_header_tool_tip(FUEL_TIP)
        self._section.expanded_changed.connect(self._on_expanded)
        self._body = QWidget()
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        self._body_layout.setSpacing(4)
        self._section.add_body(self._body)
        outer.addWidget(self._section)

    def _on_expanded(self, on: bool) -> None:
        if on:
            self.ensure_built()

    def ensure_built(self) -> None:
        if self._built:
            return
        from ..shared.action_editor import ActionEditor

        self._built = True
        self._loading = True
        try:
            self._on = QCheckBox("有耐久（烧完就没）", self._body)
            self._on.setToolTip("勾掉 = 不写 fuel 键 = 这根火把没有耐久（点着就一直烧得下去）。\n" + FUEL_TIP)
            self._on.toggled.connect(self._on_enable_toggled)
            self._body_layout.addWidget(self._on)
            self._fields = QWidget(self._body)
            form = compact_form(QFormLayout(self._fields))
            self._seconds = QDoubleSpinBox(self._fields)
            self._seconds.setRange(0.0, 360000.0)
            self._seconds.setDecimals(1)
            self._seconds.setSingleStep(10.0)
            self._seconds.setMaximumWidth(120)
            self._seconds.setToolTip(
                "满燃料能烧多久（秒）。必须 > 0，否则运行时整块 fuel 当没写 = 这根变成烧不完的。\n"
                "现网临时火把：松明 150、湿柴 240、香火把 200。")
            self._seconds.valueChanged.connect(self._emit)
            form.addRow("能烧几秒", self._seconds)
            self._wind = OptionalNumField(
                0.0, 100.0, 0.05, 3, seed=FUEL_WIND_FACTOR_DEFAULT, parent=self._fields,
                check_label="写",
                check_tip=f"不勾 = 不写：按缺省 {FUEL_WIND_FACTOR_DEFAULT:g}（10 m/s 的风里烧得快一倍）。")
            self._wind.set_tool_tip(
                "风里烧得快多少：每秒烧掉 1 + 这个数 × 气流（m/s）。\n"
                "气流是火把头挡过风之后的——所以按住护火每秒确实省燃料。\n"
                f"不写 = {FUEL_WIND_FACTOR_DEFAULT:g}；写了但 < 0 ⇒ 运行时当没写。")
            self._wind.changed.connect(self._emit)
            form.addRow("风里烧得快", self._wind)
            self._out_state = OptionalStateNameCombo("out", self._fields)
            self._out_state.setToolTip(
                "烧完切到哪个状态（与被风吹灭同一条路，不算「点火」）。\n"
                "不写 = 跟「风吹灭」块的灭状态，再没有就是 out。\n"
                "预设里没有这个状态 ⇒ 烧完时运行时切不过去，火把看着还燃着（校验器报 warning）。")
            self._out_state.changed.connect(self._emit)
            form.addRow("烧完切到", self._out_state)
            # 三态而非勾选框：缺省 false，但作者要能配出"沿用缺省 / 留在手上 / 明写不留"三档
            self._keep = TristateBoolCombo(
                tristate_rows(
                    f"沿用缺省（不写 = {str(FUEL_KEEP_IN_HAND_DEFAULT).lower()}：烟散完自动拿掉）",
                    "留在手上（true）", "烟散完拿掉（false）"),
                self._fields)
            self._keep.setToolTip(FUEL_KEEP_IN_HAND_TIP)
            self._keep.currentIndexChanged.connect(self._emit)
            form.addRow("烧完留在手上", self._keep)
            self._body_layout.addWidget(self._fields)
            self._acts = ActionEditor("烧完之后", self._body)
            self._acts.setToolTip(
                "燃料烧完、切完状态之后执行。临时火把在这里把自己从手上卸下、从背包里去掉\n"
                "（detachFromSocket + removeItem）；要推剧情就放 emitNarrativeSignal。\n"
                "顶层的 playPropVfx 不写 target / socket = 这件挂件自己；嵌在 runActions 等容器里的要写全。")
            self._acts.set_project_context(self._model, None)
            self._acts.changed.connect(self._emit)
            self._body_layout.addWidget(self._acts)
            self._note = QLabel("", self._body)
            self._note.setWordWrap(True)
            self._body_layout.addWidget(self._note)
        finally:
            self._loading = False
        self._body.show()
        _relayout_up(self._body, self)
        self._fill()

    def _emit(self, *_a: object) -> None:
        if self._loading:
            return
        self._refresh_note()
        self._refresh_title()
        self.changed.emit()

    def _on_enable_toggled(self, on: bool) -> None:
        if self._loading:
            return
        self._fields.setEnabled(on)
        self._acts.setEnabled(on)
        if on and not isinstance(self._pending, dict) and not self._fresh:
            # 从"没有 / 坏形态"勾上 = 新配一块：按缺省秒数写出来
            self._fresh = True
            was = self._loading
            self._loading = True
            try:
                self._seconds.setValue(FUEL_SECONDS_SEED)
            finally:
                self._loading = was
        self._emit()

    def _fill(self) -> None:
        if not self._built:
            return
        from ..shared.prop_preview import ABSENT, js_number

        was = self._loading
        self._loading = True
        try:
            has = isinstance(self._pending, dict)
            o = self._pending if has else {}
            self._fresh = False
            self._on.setChecked(has)
            self._on_seed = has
            self._fields.setEnabled(has)
            self._acts.setEnabled(has)
            n = js_number(o.get("seconds", ABSENT))
            self._seconds.setValue(n if n is not None and n > 0 else 0.0)
            self._sec_seed = self._seconds.value()
            self._wind.set_value(o.get("windFactor"))
            self._out_state.set_state_names(self._names)
            self._out_state.set_value(o.get("outState", _MISSING))
            acts = o.get("onSpentActions")
            self._acts.set_data([a for a in acts if isinstance(a, dict)] if isinstance(acts, list) else [])
            self._act_seed = self._acts.to_list()
            self._keep.set_value(o.get("keepInHandWhenSpent"))
            self._keep_seed = self._keep.currentIndex()
        finally:
            self._loading = was
        self._refresh_note()
        self._refresh_title()

    def _untouched(self) -> bool:
        return (not self._fresh
                and self._on.isChecked() == self._on_seed
                and self._seconds.value() == self._sec_seed
                and self._keep.currentIndex() == getattr(self, "_keep_seed", 0)
                and self._wind.is_untouched()
                and self._out_state.is_untouched()
                and self._acts.to_list() == self._act_seed)

    def _refresh_note(self) -> None:
        if not self._built:
            return
        bad = ""
        if self._on.isChecked() and self._seconds.value() <= 0:
            bad = "能烧几秒必须 > 0 ⇒ 运行时整块 fuel 当没写：这根火把变成烧不完的。"
        self._note.setText(bad)
        self._note.setStyleSheet("color:#c66;" if bad else "color:#888;")

    def _refresh_title(self) -> None:
        from ..shared.prop_preview import ABSENT, js_number

        d = self.dump()
        if d is _MISSING:
            self._section.set_title("耐久（燃料）（不写 = 烧不完）")
        elif not isinstance(d, dict):
            self._section.set_title("耐久（燃料）：（坏，运行时当没写 = 烧不完）")
        else:
            n = js_number(d.get("seconds", ABSENT))
            head = f"耐久：{n:g} 秒" if n is not None and n > 0 else "耐久：（秒数不是正数 ⇒ 烧不完）"
            acts = d.get("onSpentActions")
            if isinstance(acts, list) and acts:
                head += f"，烧完 {len(acts)} 条动作"
            self._section.set_title(head)

    # ---------------------------------------------------------------- 外部
    def set_data(self, entry: object) -> None:
        """从一条预设载入（只取 `fuel` 键）。"""
        src = entry if isinstance(entry, dict) else {}
        self._pending = copy.deepcopy(src["fuel"]) if "fuel" in src else _MISSING
        if self._pending is not _MISSING:
            self.ensure_built()
            self._section.set_expanded(True)
        if self._built:
            self._fill()
        self._refresh_title()

    def set_state_names(self, names: list[str]) -> None:
        self._names = [str(n) for n in names]
        if self._built:
            self._out_state.set_state_names(self._names)

    def reload_refs(self) -> None:
        if self._built:
            self._acts.reload_refs_from_model()

    def dump(self) -> Any:
        """`_MISSING` = 不写 `fuel` 键。没展开过 / 什么都没动 ⇒ 原样回吐载入值。"""
        if not self._built or self._untouched():
            return self._pending if self._pending is _MISSING else copy.deepcopy(self._pending)
        if not self._on.isChecked():
            return _MISSING
        o = self._pending if isinstance(self._pending, dict) and not self._fresh else {}
        out: dict[str, Any] = {k: copy.deepcopy(v) for k, v in o.items() if k not in FUEL_KEYS}
        v = self._seconds.value()
        if v == self._sec_seed and "seconds" in o and not self._fresh:
            out["seconds"] = copy.deepcopy(o["seconds"])
        else:
            r = round(v, 4)
            out["seconds"] = num_repr_like(int(r) if float(r).is_integer() else r, o.get("seconds"))
        if self._wind.is_untouched():
            if "windFactor" in o:
                out["windFactor"] = copy.deepcopy(o["windFactor"])
        else:
            wf = self._wind.value()
            if wf is not None:
                out["windFactor"] = wf
        os_v = self._out_state.value()
        if os_v is not _MISSING:
            out["outState"] = os_v
        if self._keep.currentIndex() == getattr(self, "_keep_seed", 0):
            if "keepInHandWhenSpent" in o:
                out["keepInHandWhenSpent"] = copy.deepcopy(o["keepInHandWhenSpent"])
        else:
            kp = self._keep.value()
            if kp is not None:
                out["keepInHandWhenSpent"] = kp
        acts = self._acts.to_list()
        if acts == self._act_seed:
            if "onSpentActions" in o:
                out["onSpentActions"] = copy.deepcopy(o["onSpentActions"])
        elif acts or "onSpentActions" in o:
            out["onSpentActions"] = acts
        preserve_numeric_repr(out, o)
        return reorder_like(out, o)


class PropEffectsBlock(QWidget):
    """基础块的「效果块」`effects`：默认折叠 + 懒建。

    `dump()` 返回 `_MISSING` = 不写 `effects` 键；磁盘上显式写着 `[]` 的要原样保住
    （"等于空就删"会改字节）。没展开过 ⇒ 原样回吐磁盘值。
    """

    changed = Signal()

    def __init__(self, model: Any, parent: QWidget | None = None,
                 *, level_effects_getter: Callable[[], list[tuple[str, list[Any]]]] | None = None) -> None:
        super().__init__(parent)
        self._model = model
        #: 给红字用：[(第几级的显示名, 那一级挂的 id 串), …]。等级在运行时**排在前面**，
        #: 所以基础块这一串到底有几块生效要看等级；只数自己那一串就会漏报。
        self._level_effects = level_effects_getter
        self._built = False
        self._pending: Any = _MISSING
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self._section = CollapsibleSection("效果块（脾气）（不写 = 基础配置）", start_open=False)
        self._section.set_header_tool_tip(EFFECTS_TIP)
        self._section.expanded_changed.connect(self._on_expanded)
        self._body = QWidget()
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        self._body_layout.setSpacing(4)
        self._section.add_body(self._body)
        outer.addWidget(self._section)

    def _on_expanded(self, on: bool) -> None:
        if on:
            self.ensure_built()

    def ensure_built(self) -> None:
        if self._built:
            return
        self._built = True
        self._field = PropEffectIdsField(self._model, self._body, note_builder=self._cap_note)
        self._field.changed.connect(self._emit)
        self._body_layout.addWidget(self._field)
        self._body.show()
        _relayout_up(self._body, self)
        self._field.set_ids(self._pending if self._pending is not _MISSING else _MISSING)
        self._refresh_title()

    def _cap_note(self, ids: list[Any]) -> str:
        """红字：拿**最早出事的那一级**说话（等级排在前面，挤掉的是这一串）。

        没有等级 ⇒ 只按这一串自己算。口径见 {@link prop_effects_verdict}。
        """
        known = _prop_effect_known(self._model)
        levels = list(self._level_effects() if self._level_effects else [])
        if not levels:
            return prop_effects_cap_note([], ids, known)
        for name, lv_ids in levels:
            note = prop_effects_cap_note(lv_ids, ids, known, level_name=name)
            if note:
                return note
        return ""

    def refresh_cap_note(self) -> None:
        """等级那边动了（改了 / 换了选中的一级）⇒ 这边的红字得跟着重算。"""
        if self._built:
            self._field.refresh_note()

    def _emit(self, *_a: object) -> None:
        self._refresh_title()
        self.changed.emit()

    def _refresh_title(self) -> None:
        d = self.dump()
        if d is _MISSING:
            self._section.set_title("效果块（脾气）（不写 = 基础配置）")
        elif not isinstance(d, list):
            self._section.set_title("效果块：（坏，运行时当没挂）")
        elif not d:
            self._section.set_title("效果块：（空）")
        else:
            self._section.set_title("效果块：" + "、".join(str(x) for x in d))

    # ---------------------------------------------------------------- 外部
    def set_data(self, entry: object) -> None:
        """从一条预设载入（只取 `effects` 键）。"""
        src = entry if isinstance(entry, dict) else {}
        self._pending = copy.deepcopy(src["effects"]) if "effects" in src else _MISSING
        if self._pending is not _MISSING:
            self.ensure_built()
            self._section.set_expanded(True)
        if self._built:
            self._field.set_ids(self._pending if self._pending is not _MISSING else _MISSING)
        self._refresh_title()

    def reload_refs(self) -> None:
        if self._built:
            self._field.reload_refs()

    def count(self) -> int:
        if self._built:
            return self._field.count()
        return len([x for x in self._pending]) if isinstance(self._pending, list) else 0

    def effect_ids(self) -> list[Any]:
        """这一串 id（没展开过就读磁盘暂存）。给等级那边的红字对账用。"""
        if self._built:
            return self._field.current_ids()
        return list(self._pending) if isinstance(self._pending, list) else []

    def dump(self) -> Any:
        if not self._built:
            return self._pending if self._pending is _MISSING else copy.deepcopy(self._pending)
        return self._field.to_list()


#: 一级里表单管着的键。其余键原样透传
LEVEL_KEYS = ("label", "image", "effects", "note")


class PropLevelsEditor(QWidget):
    """等级表 `levels` 的**嵌套主从列表**：左列各级、右侧那一级的表单。

    ## 顺序即等级
    第 i 条就是第 i 级（`setPropLevel` 的 level、`propLevel` 条件叶比的都是这个下标 + 1），
    所以必须给上移 / 下移，且往返必须保序。

    ## commit-on-leave
    切级之前先把当前表单提交回暂存（editor-data-sync-paradigm 契约 3）——不提交就是
    "填完直接点下一级，刚填的静默消失"。

    ## 往返
    默认折叠 + 懒建：没展开过 ⇒ `dump()` 原样回吐磁盘上的 `levels`。展开后用**种子快照法**：
    载入即算一份输出快照，导出时仍等于快照 ⇒ 回吐磁盘原值（坏条目、不认识的键、键序一个字节不改）。
    """

    changed = Signal()
    #: 「哪几块效果真生效」可能变了（换了选中的一级 / 某一级的效果块改了）。
    #: 与 `changed` 分开：换选中**不是**数据改动，不能拿 `changed` 顶（那就是打开即脏）。
    cap_changed = Signal()

    def __init__(self, model: Any, parent: QWidget | None = None,
                 *, base_effects_getter: Callable[[], list[Any]] | None = None) -> None:
        super().__init__(parent)
        self._model = model
        #: 给红字用：预设自己那一串 id（运行时排在等级**后面**）
        self._base_effects = base_effects_getter
        self._loading = False
        self._built = False
        self._pending: Any = _MISSING
        #: 暂存：每级的原始 dict（未选中的那几级原样躺着）
        self._rows: list[Any] = []
        self._current = -1
        self._seed: Any = _MISSING
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self._section = CollapsibleSection("等级（不写 = 不能升级）", start_open=False)
        self._section.set_header_tool_tip(LEVELS_TIP)
        self._section.expanded_changed.connect(self._on_expanded)
        self._body = QWidget()
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        self._body_layout.setSpacing(4)
        self._section.add_body(self._body)
        outer.addWidget(self._section)

    def _on_expanded(self, on: bool) -> None:
        if on:
            self.ensure_built()

    def ensure_built(self) -> None:
        if self._built:
            return
        from ..shared.image_path_picker import CutsceneImagePathRow

        self._built = True
        self._loading = True
        try:
            hint = QLabel(
                "第 1 级 = 出厂的样子。升级换外观 + 叠效果块；每级必须一眼看得出（换图、火焰变、描述变）。",
                self._body)
            hint.setWordWrap(True)
            hint.setStyleSheet("color:#888;")
            self._body_layout.addWidget(hint)
            split = QWidget(self._body)
            sl = QHBoxLayout(split)
            sl.setContentsMargins(0, 0, 0, 0)
            sl.setSpacing(6)
            left = QWidget(split)
            ll = QVBoxLayout(left)
            ll.setContentsMargins(0, 0, 0, 0)
            ll.setSpacing(2)
            self._list = QListWidget(left)
            self._list.setMaximumWidth(190)
            self._list.setMinimumHeight(96)
            self._list.currentRowChanged.connect(self._on_select_row)
            # 点已经选中的那一行不发 currentRowChanged ⇒ 要靠 itemClicked 才能重新同步右侧表单
            self._list.itemClicked.connect(self._on_item_clicked)
            ll.addWidget(self._list)
            self._empty_hint = QLabel("还没有等级，点 ＋ 加第 1 级（第 1 级 = 出厂的样子）。", left)
            self._empty_hint.setWordWrap(True)
            self._empty_hint.setStyleSheet("color:#888;")
            ll.addWidget(self._empty_hint)
            btns = QHBoxLayout()
            btns.setSpacing(2)
            for text, tip, slot in (
                ("＋", "在末尾加一级", self._on_new),
                ("－", "删掉选中那一级（后面各级整体前移一位）", self._on_delete),
                ("↑", "上移（顺序就是等级）", lambda: self._move(-1)),
                ("↓", "下移", lambda: self._move(1)),
            ):
                b = compact_icon_button(text, tip, left)
                b.clicked.connect(slot)
                btns.addWidget(b)
            btns.addStretch(1)
            ll.addLayout(btns)
            sl.addWidget(left)
            self._detail = QWidget(split)
            df = compact_form(QFormLayout(self._detail))
            self._label = QLineEdit(self._detail)
            self._label.setToolTip(
                "这一级的名字（「裹布浸桐油」）。必填：空的那一条运行时整条不算一级——\n"
                "级数变少，写在内容里的 setPropLevel / propLevel 从此越界。")
            self._label.textChanged.connect(self._on_field_changed)
            df.addRow("名字", self._label)
            self._image = CutsceneImagePathRow(
                self._model, "", external_copy_subdir="props",
                external_copy_hint="项目外图片会复制到 resources/runtime/images/props/")
            self._image.setToolTip(
                "这一级的贴图（不填 = 沿用基础块那张）。状态自己写了图的仍以状态为准。\n"
                "⚠ 每级必须一眼看得出：换图是最直接的一条。")
            self._image.changed.connect(self._on_field_changed)
            df.addRow("贴图", self._image)
            self._effects = PropEffectIdsField(
                self._model, self._detail, note_builder=self._cap_note)
            self._effects.changed.connect(self._on_field_changed)
            df.addRow("效果块", self._effects)
            self._note = QLineEdit(self._detail)
            self._note.setToolTip("作者备注（不是玩家文案，运行时不显示）。")
            self._note.textChanged.connect(self._on_field_changed)
            df.addRow("备注", self._note)
            sl.addWidget(self._detail, 1)
            self._body_layout.addWidget(split)
        finally:
            self._loading = False
        self._body.show()
        _relayout_up(self._body, self)
        self._fill()

    # ---------------------------------------------------------------- 内部
    def _fill(self) -> None:
        if not self._built:
            return
        was = self._loading
        self._loading = True
        try:
            src = self._pending
            self._rows = [copy.deepcopy(x) for x in src] if isinstance(src, list) else []
            self._current = -1
            self._refresh_list()
            # ⚠ `setCurrentRow(0)` 在 `_loading` 里发的 currentRowChanged 会被 `_on_select_row`
            #   直接吞掉 —— 只靠它就是"第 1 级看着选中了、右边表单却是空的且能打字"：
            #   打进去的字提交不到任何一级，只把列表高亮清掉再把整页判脏。所以这里**自己**
            #   把 `_current` 与右侧表单摆到位（仍在 loading 里 ⇒ 不发 changed，打开不判脏）。
            self._current = 0 if self._rows else -1
            if self._rows:
                self._list.setCurrentRow(0)
            self._fill_detail()
        finally:
            self._loading = was
        self._seed = self._build()
        self._refresh_title()
        self.cap_changed.emit()

    def _refresh_list(self, keep: int = -1) -> None:
        was = self._loading
        self._loading = True
        try:
            self._list.clear()
            for i, lv in enumerate(self._rows):
                label = str(lv.get("label") or "").strip() if isinstance(lv, dict) else ""
                bad = "" if isinstance(lv, dict) else "  ⚠ 不是对象"
                warn = "" if label or bad else "  ⚠ 没名字（运行时不算一级）"
                self._list.addItem(f"第 {i + 1} 级　{label or '（无名）'}{warn}{bad}")
            self._empty_hint.setVisible(not self._rows)
        finally:
            self._loading = was
        if 0 <= keep < len(self._rows):
            self._list.setCurrentRow(keep)

    def _on_select_row(self, row: int) -> None:
        if self._loading:
            return
        if self._current >= 0:
            self._commit_current()
        self._current = row
        self._fill_detail()
        self.cap_changed.emit()   # 换一级 = 换一串效果块 ⇒ 基础块那边的红字也变了

    def _on_item_clicked(self, item: object) -> None:
        """点**已经选中**那一行：Qt 不发 currentRowChanged，右侧表单就再也回不来。

        `_on_field_changed` 每次改动都已提交回暂存，所以照暂存重填是无损的。
        """
        if self._loading or item is None:
            return
        row = self._list.row(item)
        if row == self._current:
            self._fill_detail()

    def _fill_detail(self) -> None:
        was = self._loading
        self._loading = True
        try:
            lv = self._rows[self._current] if 0 <= self._current < len(self._rows) else None
            ok = isinstance(lv, dict)
            self._detail.setEnabled(ok)
            src = lv if ok else {}
            self._label.setText(str(src.get("label") or "") if isinstance(src.get("label"), str) else "")
            self._image.set_path(str(src.get("image") or "") if isinstance(src.get("image"), str) else "")
            self._effects.set_ids(src.get("effects", _MISSING) if "effects" in src else _MISSING)
            self._note.setText(str(src.get("note") or "") if isinstance(src.get("note"), str) else "")
        finally:
            self._loading = was

    def _on_field_changed(self, *_a: object) -> None:
        if self._loading:
            return
        self._commit_current()
        self._refresh_list(keep=self._current)
        self._refresh_title()
        self.changed.emit()
        self.cap_changed.emit()

    def _commit_current(self) -> None:
        """当前表单 → 暂存那一级（未知键透传、键序按原序）。"""
        i = self._current
        if not (0 <= i < len(self._rows)) or not isinstance(self._rows[i], dict):
            return
        o = self._rows[i]
        out: dict[str, Any] = {k: copy.deepcopy(v) for k, v in o.items() if k not in LEVEL_KEYS}
        out["label"] = self._label.text().strip()
        img = self._image.path().strip()
        if img:
            out["image"] = img
        eff = self._effects.to_list()
        if eff is not _MISSING and (eff or "effects" in o):
            out["effects"] = eff
        note = self._note.text().strip()
        if note:
            out["note"] = note
        self._rows[i] = reorder_like(out, o)

    def _on_new(self) -> None:
        if self._loading:
            return
        self._commit_current()
        self._rows.append({"label": f"第 {len(self._rows) + 1} 级"})
        self._current = -1
        self._refresh_list(keep=len(self._rows) - 1)
        self._refresh_title()
        self.changed.emit()
        self.cap_changed.emit()

    def _on_delete(self) -> None:
        if self._loading or not (0 <= self._current < len(self._rows)):
            return
        from ..shared import confirm

        i = self._current
        label = str(self._rows[i].get("label") or "") if isinstance(self._rows[i], dict) else ""
        if not confirm.confirm_delete(self, f"第 {i + 1} 级「{label or '（无名）'}」"):
            return
        self._rows.pop(i)
        self._current = -1
        self._refresh_list(keep=min(i, len(self._rows) - 1))
        if not self._rows:
            self._fill_detail()
        self._refresh_title()
        self.changed.emit()
        self.cap_changed.emit()

    def _move(self, delta: int) -> None:
        i = self._current
        j = i + delta
        if self._loading or i < 0 or j < 0 or j >= len(self._rows):
            return
        self._commit_current()
        self._rows[i], self._rows[j] = self._rows[j], self._rows[i]
        self._current = -1
        self._refresh_list(keep=j)
        self._refresh_title()
        self.changed.emit()
        self.cap_changed.emit()

    def _build(self) -> Any:
        """当前暂存 → 落盘形态（`_MISSING` = 不写 `levels` 键）。"""
        if not self._rows:
            # 磁盘上显式写着 `[]` 的要原样保住；本来就没有这个键就别凭空写一个
            return copy.deepcopy(self._pending) if isinstance(self._pending, list) else _MISSING
        return [copy.deepcopy(x) for x in self._rows]

    def _refresh_title(self) -> None:
        d = self.dump()
        if d is _MISSING:
            self._section.set_title("等级（不写 = 不能升级）")
        elif not isinstance(d, list):
            self._section.set_title("等级：（坏，运行时当不能升级）")
        elif not d:
            self._section.set_title("等级：（空 = 不能升级）")
        else:
            names = [str(x.get("label") or "（无名）").strip() if isinstance(x, dict) else "（坏）" for x in d]
            self._section.set_title(f"等级：{len(d)} 级　" + " → ".join(names))

    # ---------------------------------------------------------------- 外部
    def set_data(self, entry: object) -> None:
        """从一条预设载入（只取 `levels` 键）。"""
        src = entry if isinstance(entry, dict) else {}
        self._pending = copy.deepcopy(src["levels"]) if "levels" in src else _MISSING
        if self._pending is not _MISSING:
            self.ensure_built()
            self._section.set_expanded(True)
        if self._built:
            self._fill()
        self._refresh_title()

    def reload_refs(self) -> None:
        if self._built:
            self._effects.reload_refs()

    def _cap_note(self, ids: list[Any]) -> str:
        """这一级的红字：这一级那串 + 预设自己那串，按运行时口径算谁真生效。"""
        base = list(self._base_effects() if self._base_effects else [])
        return prop_effects_cap_note(
            ids, base, _prop_effect_known(self._model), level_name="这一级")

    def refresh_cap_note(self) -> None:
        """预设自己那一串变了 ⇒ 这边的红字得跟着重算。"""
        if self._built:
            self._effects.refresh_note()

    def effects_by_level(self) -> list[tuple[str, list[Any]]]:
        """每一级挂了哪几块：`[(第几级, id 串), …]`。

        没展开过就读磁盘暂存；正在编辑的那一级读**控件里**那一串（还没提交回暂存的
        改动也算），否则基础块的红字会比作者手上的实际配置慢一拍。
        """
        rows: list[Any] = self._rows if self._built else (
            self._pending if isinstance(self._pending, list) else [])
        out: list[tuple[str, list[Any]]] = []
        for i, lv in enumerate(rows):
            if self._built and i == self._current:
                ids = self._effects.current_ids()
            elif isinstance(lv, dict) and isinstance(lv.get("effects"), list):
                ids = list(lv["effects"])
            else:
                ids = []
            out.append((f"第 {i + 1} 级", ids))
        return out

    def dump(self) -> Any:
        """`_MISSING` = 不写 `levels` 键。没展开过 / 什么都没动 ⇒ 原样回吐载入值。"""
        if not self._built:
            return self._pending if self._pending is _MISSING else copy.deepcopy(self._pending)
        self._commit_current()
        built = self._build()
        if built == self._seed:
            return self._pending if self._pending is _MISSING else copy.deepcopy(self._pending)
        return built


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
    #: 状态表单里某个粒子挂载请求在试挂预览上点选：(状态名, 第几条)
    particle_pick_requested = Signal(str, int)

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

        self._st_particles = PropStateParticlesField(self._model, self._detail)
        self._st_particles.changed.connect(self._emit_field)
        self._st_particles.pick_requested.connect(
            lambda i: self.particle_pick_requested.emit(self._current, i))
        df.addRow("粒子挂载", self._st_particles)

        self._st_fire = OptionalPointField(check_label="覆盖", seed=(0.5, 0.1), parent=self._detail)
        self._st_fire.set_tool_tip(
            "覆盖基础块的起火点（状态换了图，起火点可能跟着挪）。不勾 = 沿用基础块。\n"
            "勾上后，试挂预览按这个状态预览时「点选起火点」写的就是这里。")
        self._st_fire.changed.connect(self._emit_field)
        df.addRow("起火点", self._st_fire)
        self._st_burn = OptionalNumField(0.0, 1.0, 0.05, 3, seed=1.0, parent=self._detail)
        self._st_burn.set_tool_tip(BURN_TIP + "不勾 = 沿用基础块（基础块也没写 = 1）。")
        self._st_burn.changed.connect(self._emit_field)
        df.addRow("燃烧 burn", self._st_burn)
        self._st_wind_shelter = OptionalNumField(0.0, 1.0, 0.05, 3, seed=0.0, parent=self._detail)
        self._st_wind_shelter.set_tool_tip(
            WIND_SHELTER_TIP + "不勾 = 沿用基础块（基础块也没写 = 0）。「护火」状态典型给 0.8。")
        self._st_wind_shelter.changed.connect(self._emit_field)
        df.addRow("挡风", self._st_wind_shelter)

        from ..shared.action_editor import ActionEditor
        self._st_on_enter = ActionEditor("进入时动作", self._detail)
        self._st_on_enter.setToolTip(
            "真的**切换**到这个状态时执行（setPropState 切过来 / attachToSocket 挂上时的初始状态）。\n"
            "已经是该状态 ⇒ 不执行；读档重挂、切场景自动重挂 ⇒ 不执行（那是派生表现，不是进入）。\n"
            "同一挂点一帧内状态切换超过 8 次运行时拒绝（防连环）。\n"
            "playPropVfx 在这件挂件上播一个效果（熄灭冒的烟）：顶层这一层 target / socket 留空 = 这件挂件自己；\n"
            "嵌在 runActions 等容器里的不算，要写全。")
        self._st_on_enter.set_project_context(self._model, None)
        self._st_on_enter.changed.connect(self._emit_field)
        self._on_enter_seed: list | None = None
        df.addRow("进入时", self._st_on_enter)
        self._st_on_enter_hint = QLabel(
            "可用 playPropVfx 在这件挂件上播效果（target / socket 留空 = 这件挂件）", self._detail)
        self._st_on_enter_hint.setWordWrap(True)
        self._st_on_enter_hint.setToolTip(
            "只有这一层（进入时动作的顶层）会自动指向这件挂件；嵌在 runActions / chooseAction 等容器里的"
            "要写全 target 与 socket，否则校验器报错、运行时不播。")
        df.addRow("", self._st_on_enter_hint)

        self._st_blowout = PropStateBlowoutField(self._model, self._detail)
        self._st_blowout.changed.connect(self._emit_field)
        df.addRow("风吹灭", self._st_blowout)

        self._st_igniter = PropStateIgniterField(self._detail)
        self._st_igniter.changed.connect(self._emit_field)
        df.addRow("点火", self._st_igniter)

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
        self._st_particles.write_into(out)
        # 燃烧物字段：没动过 ⇒ 磁盘原值原样回吐（含坏形态 / null，运行时自己清洗）
        o = orig or {}
        for key, field in (("firePoint", self._st_fire), ("burn", self._st_burn),
                           ("windShelter", self._st_wind_shelter)):
            if field.is_untouched():
                if key in o:
                    out[key] = copy.deepcopy(o[key])
                continue
            v = field.value()
            if v is not None:
                out[key] = v
        acts = self._st_on_enter.to_list()
        if self._on_enter_seed is not None and acts == self._on_enter_seed:
            # 种子快照：ActionEditor 会把参数 schema 里没填的参数 materialize 出来，
            # 没动过就必须回吐磁盘原值，否则打开→保存就多出一堆空参数（改字节）
            if "onEnterActions" in o:
                out["onEnterActions"] = copy.deepcopy(o["onEnterActions"])
        elif acts or "onEnterActions" in o:
            out["onEnterActions"] = acts
        self._st_blowout.write_into(out)
        self._st_igniter.write_into(out)
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
            self._st_particles.set_data(st)
            self._st_fire.set_value(st.get("firePoint"))
            self._st_burn.set_value(st.get("burn"))
            self._st_wind_shelter.set_value(st.get("windShelter"))
            raw_acts = st.get("onEnterActions")
            self._st_on_enter.set_data(
                [a for a in raw_acts if isinstance(a, dict)] if isinstance(raw_acts, list) else [])
            self._on_enter_seed = self._st_on_enter.to_list()
            self._st_blowout.set_state_names(list(self._states))
            self._st_blowout.set_data(st)
            self._st_igniter.set_data(st)
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
            self._st_particles.reload_refs()
            # 进入时动作的候选（物品 / flag / 场景实体…）是构行时的静态快照，切页回来要重建
            self._st_on_enter.reload_refs_from_model()
            self._st_blowout.reload_refs()

    def set_state_particle_point(self, name: str, index: int, x: float, y: float) -> None:
        """试挂预览上点选：写某个状态第 index 条粒子挂载的挂点（只在右侧正显示那个状态、且它是自己的列表时）。"""
        if self._built and name and name == self._current and self._st_particles.is_own():
            self._st_particles.set_point(index, x, y)     # → _emit_field：先落暂存再对外标脏

    def state_has_fire_point(self, name: str) -> bool:
        """这个状态自己覆盖了起火点吗（右侧表单里当前那条按控件算，其余按暂存数据算）。"""
        from ..shared.prop_preview import parse_fire_point

        if self._built and name and name == self._current:
            return self._st_fire.is_checked()
        st = self._states.get(str(name or ""))
        return isinstance(st, dict) and parse_fire_point(st.get("firePoint")) is not None

    def set_state_fire_point(self, name: str, x: float, y: float) -> None:
        """试挂预览上点选：写某个状态的起火点覆盖（右侧正显示它就走控件，否则直写暂存）。"""
        name = str(name or "")
        if name not in self._states:
            return
        x, y = round(float(x), 4), round(float(y), 4)
        if self._built and name == self._current:
            self._st_fire.set_point(x, y)      # → _emit_field：先落暂存再对外标脏
            return
        st = self._states[name]
        st["firePoint"] = [x, y]
        self._emit()

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
