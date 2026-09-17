"""挂件效果块库：`prop_effects.json`，供挂件预设的 `effects` / `levels[*].effects` 引用。

**这一页存在的理由**（玩法清单 A3.7「火把养成 · 效果自由组合」，制作人 2026-09-16 拍板）：
临时火把**比脾气不比数值**——一支火把 = 一份基础燃烧配置 + 至多两块效果。
把"松明旺而呛、招东西""湿柴不怕风但暗""艾草驱虫"这些脾气写成一块块可组合的数据，
配一支新火把就不用写代码，也不用在每条挂件预设里把同一串倍率重敲一遍（敲五遍必然有一遍不一样）。

## 数值全是**倍率**，1 = 不改

运行时 `parsePropEffects` 的 `positiveScale` 只收 **> 0 的有限数**：0、负数、空串一律**当没写这一项**。
也就是说作者想"把亮度按到 0"，得到的是"亮度一点没变"——画面上完全看不出来。所以这一页
每个数值都是"勾了才写"的显式开关（不勾 = 不写键），底下的校验器对 ≤ 0 报 error。

## 合成规矩（制作人定）

- 数值类**相乘**：几块都写了就连乘（`applyPropEffects`）；
- 行为类**并集**：`fields`（驱 / 招的场）与 `tags` 直接并起来；
- **每支最多两块**（`PROP_EFFECTS_MAX`）——多了组合爆炸、玩家也读不懂。上限在挂件预设页那边提示 + 校验。

## 数据流（与「气味 Profile」页同一条）

单一真相源 = `ProjectModel.prop_effects`（`load_project` 载入的活引用）。编辑即写模型并
`mark_dirty("prop_effects")`，由主编辑器「全部保存」经 `file_io.write_json` 原子落盘；
本页自己**不做任何文件 IO**。写回只动本页管着的键，效果块上的未知键原样保留；
未改动的数值按磁盘原始表示回写（`1` 不漂成 `1.0`）。
"""
from __future__ import annotations

import copy
from typing import Any

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QVBoxLayout,
    QWidget,
)

from ..shared import confirm
from ..shared.form_layout import compact_form, compact_icon_button, fit_width_cap
from ..shared.numeric_roundtrip import preserve_numeric_repr
from ..shared.widget_discard import discard_widget
from .prop_preset_blocks import (
    OptionalNumField,
    PROP_EFFECTS_MAX_HINT,
    _MISSING,
    num_repr_like,
    prop_effect_summary,
    reorder_like,
)

#: 本页管着的顶层键。其余键原样透传（将来给 `PropEffectDef` 加字段不会被吞掉）
MANAGED_KEYS = ("label", "note", "light", "burn", "fuelRate", "wind", "igniterFlame", "fields", "tags")

#: 顶层倍率：(键, 表单标签, 说明)
SCALAR_ROWS: tuple[tuple[str, str, str], ...] = (
    ("burn", "火旺 ×", "燃烧强度倍率：火苗多旺（发射量与火舌大小）。> 1 = 更旺。"),
    ("fuelRate", "烧得快 ×", "燃料烧得快多少：1.5 = 快一半（松明），0.7 = 慢三成（湿柴）。"),
    ("igniterFlame", "火头长 ×", "火头火焰长度倍率：点得着多远的东西（引燃判定的够得着范围）。"),
)
#: 倍率子块：(子块键, 表单分组名, ((键, 标签, 说明), …))
BLOCK_ROWS: tuple[tuple[str, str, tuple[tuple[str, str, str], ...]], ...] = (
    ("light", "光（倍率）", (
        ("intensity", "亮度 ×", "灯的强度倍率。⚠ 亮度与范围只给很小的提升——夜景是画出来的，"
                               "范围一大原画里本该黑的地方就亮了。"),
        ("range", "照多远 ×", "灯的作用半径倍率。同上：别放大。"),
    )),
    ("wind", "抗风（倍率）", (
        ("windSpeed", "吹熄风速 ×", "多大风吹得灭：> 1 = 更耐风（火要更大的风才压得动）。"),
        ("drainSeconds", "掉得慢 ×", "火势掉到底要几秒的倍率：越大越耐（秒数变长 = 掉得慢）。"),
        ("recoverSeconds", "回得快 ×", "火势回满要几秒的倍率：越小越快（秒数变短 = 回得快）。"),
        ("emberBelow", "残炭线 ×", "残炭线的倍率（火势掉过这条线切残炭）。运行时再夹到 0..1。"),
    )),
)
#: `fields` 里一条的两档（值, 展示名）
FIELD_KIND_ROWS: tuple[tuple[str, str], ...] = (
    ("fear", "驱（fear：虫子躲开）"),
    ("attract", "招（attract：东西围过来）"),
)

_FIELDS_TIP = (
    "对世界的影响：燃着的时候在火头处放的场。粒子群体按「标签」查自己的权重反应——\n"
    "驱（fear）= 虫子躲开、招（attract）= 东西围过来。半径 wu、强度与场景动作 emitVfxField 同口径。\n"
    "⚠ 四项缺一 / 半径与强度不是 > 0 的数 ⇒ 运行时整条跳过，虫子照旧不躲不来（一声不吭）。\n"
    "标签要与粒子工作台里那个群体认的标签对得上，对不上 = 权重 0 = 等于没发。"
)
_TAGS_TIP = (
    "内容侧能问的标签：「手持挂件」条件叶的「效果块」写这一块的 id 或这里的标签都命中。\n"
    "所以「手上拿的是驱虫的火把」不用点名是哪一支——几支火把共用一个标签即可。\n"
    "标签是这一页定义出来的新名字（不是引用别处的 id），所以这里是手打输入框。"
)


class _FieldsListField(QWidget):
    """`fields`（驱 / 招的场）的行式列表。每行 = 种类下拉 + 标签 + 半径 + 强度 + 上移 / 下移 / 删。

    ## 往返
    - 每行记着磁盘上那条原对象：不认识的键原样透传、键序按原序、没动过的数值回吐原表示；
    - 磁盘上不是对象的坏条目（运行时跳过）显式成一行只读「(数据) …」原样透传，只能删。
    """

    changed = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        #: 每行：{"kind": "field"|"bad", "host", "orig", "combo", "tag", "radius", "strength", "seeds"}
        self._rows: list[dict[str, Any]] = []
        self._raw: Any = _MISSING
        self._seed: list[Any] = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self._rows_layout = QVBoxLayout()
        self._rows_layout.setSpacing(2)
        lay.addLayout(self._rows_layout)
        add = QPushButton("+ 场（驱 / 招）")
        fit_width_cap(add, 140)
        add.setToolTip(_FIELDS_TIP)
        add.clicked.connect(lambda: self._add_row(
            {"kind": "fear", "tag": "", "radius": 300, "strength": 1}, quiet=False))
        lay.addWidget(add)
        self._empty = QLabel("（不驱也不招）", self)
        self._empty.setStyleSheet("color:#888;")
        lay.addWidget(self._empty)

    # ---------------------------------------------------------------- 内部
    def _add_row(self, raw: Any, *, quiet: bool) -> None:
        host = QWidget(self)
        rl = QHBoxLayout(host)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.setSpacing(4)
        row: dict[str, Any] = {"host": host, "orig": copy.deepcopy(raw)}
        if isinstance(raw, dict):
            row["kind"] = "field"
            combo = QComboBox(host)
            combo.setMaximumWidth(190)
            for value, label in FIELD_KIND_ROWS:
                combo.addItem(label, value)
            want = raw.get("kind")
            idx = combo.findData(want) if isinstance(want, str) else -1
            if idx < 0:
                # 悬垂 / 怪值保值展示，绝不顶替成第一项（运行时会跳过整条，校验器报 error）
                combo.addItem(f"（数据）{want!r}  ⚠ 运行时跳过这一条", _MISSING)
                idx = combo.count() - 1
            combo.setCurrentIndex(idx)
            combo.setToolTip("驱（虫子躲开）还是招（东西围过来）。" + "\n" + _FIELDS_TIP)
            combo.currentIndexChanged.connect(lambda _i: self.changed.emit())
            row["combo"] = combo
            rl.addWidget(combo)
            tag = QLineEdit(host)
            tag.setMaximumWidth(150)
            tag.setPlaceholderText("标签，如 torch:驱虫")
            tag.setToolTip("粒子群体按这个标签查自己的权重。对不上 = 权重 0 = 等于没发。\n" + _FIELDS_TIP)
            tag.setText(raw["tag"] if isinstance(raw.get("tag"), str) else "")
            tag.textChanged.connect(lambda _t: self.changed.emit())
            row["tag"] = tag
            rl.addWidget(tag, 1)
            seeds: dict[str, float] = {}
            # 单位写在**屏幕上**，不许只躺在 tooltip 里：半径 600 是 600 什么，
            # 光看数字分不出（照 「能烧几秒」/「火焰长度 cm」的写法）。
            for key, label, lo, hi, step, dec, tip in (
                ("radius", "半径 wu", 0.0, 100000.0, 10.0, 2, "场的半径（wu；角色高约 150 wu）。必须 > 0。"),
                ("strength", "强度 0.2~3", 0.0, 1000.0, 0.1, 3,
                 "场的强度（无单位的权重，与场景动作 emitVfxField 的 strength 同口径：粒子躲得多急 / "
                 "围得多紧。现网常见 0.2~3）。必须 > 0。"),
            ):
                rl.addWidget(QLabel(label, host))
                sb = QDoubleSpinBox(host)
                sb.setRange(lo, hi)
                sb.setSingleStep(step)
                sb.setDecimals(dec)
                sb.setMaximumWidth(96)
                sb.setToolTip(tip)
                v = raw.get(key)
                sb.setValue(float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.0)
                seeds[key] = sb.value()
                sb.valueChanged.connect(lambda _v: self.changed.emit())
                row[key] = sb
                rl.addWidget(sb)
            row["seeds"] = seeds
        else:
            row["kind"] = "bad"
            lab = QLabel(f"(数据) {raw!r} —— 不是 {{kind, tag, radius, strength}} 对象，运行时跳过；原样保留", host)
            lab.setStyleSheet("color:#c66;")
            rl.addWidget(lab, 1)
        for text, tip, delta in (("↑", "上移", -1), ("↓", "下移", 1)):
            b = compact_icon_button(text, tip, host)
            b.clicked.connect(lambda _c=False, h=host, d=delta: self._move(h, d))
            rl.addWidget(b)
        rm = compact_icon_button("−", "删掉这一条场", host)
        rm.clicked.connect(lambda _c=False, h=host: self._remove(h))
        rl.addWidget(rm)
        self._rows.append(row)
        self._rows_layout.addWidget(host)
        # ⚠ addWidget 之后子控件仍是 isHidden()，隐藏项被布局整个跳过（行高按"零行"算）
        host.show()
        self._sync_empty()
        if not quiet:
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

    def _build(self) -> list[Any]:
        out: list[Any] = []
        for row in self._rows:
            orig = row["orig"]
            if row["kind"] == "bad":
                out.append(copy.deepcopy(orig))
                continue
            o = orig if isinstance(orig, dict) else {}
            item: dict[str, Any] = {
                k: copy.deepcopy(v) for k, v in o.items()
                if k not in ("kind", "tag", "radius", "strength")
            }
            kind = row["combo"].currentData()
            if kind is _MISSING:
                if "kind" in o:
                    item["kind"] = copy.deepcopy(o["kind"])
            else:
                item["kind"] = kind
            item["tag"] = row["tag"].text().strip()
            for key in ("radius", "strength"):
                v = row[key].value()
                if v == row["seeds"].get(key) and isinstance(o.get(key), (int, float)) \
                        and not isinstance(o.get(key), bool):
                    item[key] = o[key]      # 没动过：回吐磁盘原表示（300 不漂成 300.0）
                else:
                    r = round(v, 4)
                    item[key] = num_repr_like(int(r) if float(r).is_integer() else r, o.get(key))
            out.append(reorder_like(item, o))
        return out

    # ---------------------------------------------------------------- 外部
    def set_fields(self, raw: object) -> None:
        """载入（不发 `changed`）。`_MISSING` / 非数组 = 空列表（宿主自己决定键写不写）。"""
        for row in list(self._rows):
            self._rows_layout.removeWidget(row["host"])
            discard_widget(row["host"])
        self._rows.clear()
        self._raw = _MISSING if raw is _MISSING else copy.deepcopy(raw)
        for item in raw if isinstance(raw, list) else []:
            self._add_row(item, quiet=True)
        self._sync_empty()
        self._seed = self._build()

    def is_untouched(self) -> bool:
        return self._build() == self._seed

    def to_list(self) -> Any:
        """`_MISSING` = 不写 `fields` 键。没动过 ⇒ 原样回吐磁盘那一串。"""
        if self.is_untouched():
            return self._raw if self._raw is _MISSING else copy.deepcopy(self._raw)
        return self._build()


class _TagsListField(QWidget):
    """`tags`（内容侧能问的标签）的行式列表。每行 = 一个手打输入框 + 删。

    标签是这一页**定义**出来的新名字（`heldProp` 条件叶按它问），不是引用别处的 id ——
    所以裸输入框在这里是选择器铁律的明文例外。
    """

    changed = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._rows: list[dict[str, Any]] = []
        self._raw: Any = _MISSING
        self._seed: list[Any] = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self._rows_layout = QVBoxLayout()
        self._rows_layout.setSpacing(2)
        lay.addLayout(self._rows_layout)
        add = QPushButton("+ 标签")
        fit_width_cap(add, 100)
        add.setToolTip(_TAGS_TIP)
        add.clicked.connect(lambda: self._add_row("", quiet=False))
        lay.addWidget(add)
        self._empty = QLabel("（没有标签：条件叶只能点名这一块的 id）", self)
        self._empty.setStyleSheet("color:#888;")
        lay.addWidget(self._empty)

    def _add_row(self, raw: Any, *, quiet: bool) -> None:
        host = QWidget(self)
        rl = QHBoxLayout(host)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.setSpacing(4)
        row: dict[str, Any] = {"host": host, "orig": copy.deepcopy(raw)}
        if isinstance(raw, str):
            row["kind"] = "tag"
            ed = QLineEdit(host)
            ed.setMaximumWidth(220)
            ed.setPlaceholderText("标签，如 驱虫")
            ed.setToolTip(_TAGS_TIP)
            ed.setText(raw)
            ed.textChanged.connect(lambda _t: self.changed.emit())
            row["edit"] = ed
            rl.addWidget(ed)
        else:
            row["kind"] = "bad"
            lab = QLabel(f"(数据) {raw!r} —— 不是字符串，运行时跳过；原样保留", host)
            lab.setStyleSheet("color:#c66;")
            rl.addWidget(lab, 1)
        rm = compact_icon_button("−", "删掉这个标签", host)
        rm.clicked.connect(lambda _c=False, h=host: self._remove(h))
        rl.addWidget(rm)
        rl.addStretch(1)   # 排完再擑：按钮跟它管的那个框贴在一起，不被推到行尾
        self._rows.append(row)
        self._rows_layout.addWidget(host)
        host.show()
        self._sync_empty()
        if not quiet:
            self.changed.emit()

    def _remove(self, host: QWidget) -> None:
        for i, r in enumerate(self._rows):
            if r["host"] is host:
                self._rows.pop(i)
                self._rows_layout.removeWidget(host)
                discard_widget(host)
                self._sync_empty()
                self.changed.emit()
                return

    def _sync_empty(self) -> None:
        self._empty.setVisible(not self._rows)

    def _build(self) -> list[Any]:
        out: list[Any] = []
        for row in self._rows:
            if row["kind"] == "bad":
                out.append(copy.deepcopy(row["orig"]))
            else:
                out.append(row["edit"].text().strip())
        return out

    # ---------------------------------------------------------------- 外部
    def set_tags(self, raw: object) -> None:
        for row in list(self._rows):
            self._rows_layout.removeWidget(row["host"])
            discard_widget(row["host"])
        self._rows.clear()
        self._raw = _MISSING if raw is _MISSING else copy.deepcopy(raw)
        for item in raw if isinstance(raw, list) else []:
            self._add_row(item, quiet=True)
        self._sync_empty()
        self._seed = self._build()

    def is_untouched(self) -> bool:
        return self._build() == self._seed

    def to_list(self) -> Any:
        if self.is_untouched():
            return self._raw if self._raw is _MISSING else copy.deepcopy(self._raw)
        return self._build()


class PropEffectsEditor(QWidget):
    """维护 `public/assets/data/prop_effects.json`（主从列表 + 详情表单）。

    与「气味 Profile」页同一条数据流：编辑即写 `ProjectModel.prop_effects` 并标脏，
    Ctrl+S 由主编辑器统一落盘；本页不碰文件。所以**没有** `flush_to_model`
    （没有"本地脏了但收不走"的敞口，见 `test_flush_hook_parity`）。
    """

    def __init__(self, model, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._cur_id: str = ""
        self._loading = False
        self._build_ui()
        self.reload_refs_from_model()

    # ---------------------------------------------------------------- 模型
    @property
    def _data(self) -> dict:
        d = getattr(self._model, "prop_effects", None)
        if not isinstance(d, dict):
            d = {}
            try:
                self._model.prop_effects = d
            except Exception:  # noqa: BLE001 — 假模型（测试替身）没这个属性也不能炸
                pass
        return d

    def _mark_dirty(self) -> None:
        mk = getattr(self._model, "mark_dirty", None)
        if callable(mk):
            mk("prop_effects")

    # ---------------------------------------------------------------- UI
    def _build_ui(self) -> None:
        root = QVBoxLayout(self)
        hint = QLabel(
            "一支火把 = 一份基础燃烧配置 + 至多两块效果。数值全是倍率（1 = 不改，"
            "≤ 0 运行时当没写）；驱 / 招与标签是并集。挂件预设页的「效果块」「等级」引用这里的 id。")
        hint.setWordWrap(True)
        hint.setToolTip(
            "玩法清单 A3.7「火把养成 · 效果自由组合」：临时火把比脾气不比数值——\n"
            "比数值就只剩「哪根最强」，另一类立刻变垃圾。松明旺而呛、招东西；湿柴不怕风但暗、冒烟；\n"
            "香火把亮得可怜，但点着时某些东西不靠近；艾草驱虫。")
        root.addWidget(hint)
        self._status = QLabel("")
        self._status.setWordWrap(True)
        root.addWidget(self._status)

        body = QHBoxLayout()
        root.addLayout(body, stretch=1)

        left = QWidget(self)
        lv = QVBoxLayout(left)
        lv.setContentsMargins(0, 0, 0, 0)
        self._list = QListWidget(left)
        self._list.setMaximumWidth(230)
        self._list.currentItemChanged.connect(self._on_select)
        lv.addWidget(self._list)
        btn_row = QHBoxLayout()
        btn_row.setSpacing(2)
        for text, tip, slot, narrow in (
            ("＋", "新增一块效果", self._on_new, True),
            ("改名", "改这一块的 id（引用它的挂件预设会一并改写）", self._on_rename, False),
            ("－", "删掉选中那一块", self._on_delete, True),
        ):
            b = compact_icon_button(text, tip, left) if narrow else QPushButton(text, left)
            if not narrow:
                b.setToolTip(tip)
            b.clicked.connect(slot)
            btn_row.addWidget(b)
        btn_row.addStretch(1)
        lv.addLayout(btn_row)
        deep = QPushButton("查引用", left)
        deep.setToolTip(
            "扫全工程的条件叶（「手持挂件」的「效果块」写这一块的 id 或标签）。\n"
            "要读盘上所有对话图，所以不挂在选中事件上——点一次跑一次。")
        deep.clicked.connect(lambda: self._refresh_usage(deep=True))
        lv.addWidget(deep)
        self._usage = QLabel("", left)
        self._usage.setWordWrap(True)
        self._usage.setStyleSheet("color:#888;")
        lv.addWidget(self._usage)
        body.addWidget(left)

        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        self._detail = QWidget()
        dl = QVBoxLayout(self._detail)
        basic = QGroupBox("基本", self._detail)
        bf = compact_form(QFormLayout(basic))
        self._id_label = QLabel("（无选中）", basic)
        bf.addRow("id", self._id_label)
        self._label = QLineEdit(basic)
        self._label.setToolTip(
            "作者面显示的名字（「松脂旺」）。必填：空的运行时回落成 id，挑的时候就认不出来了。")
        self._label.textChanged.connect(self._on_change)
        bf.addRow("名字", self._label)
        self._note = QLineEdit(basic)
        self._note.setToolTip("作者备注（不是玩家文案，运行时不显示）。写清楚这一块是给哪种火把用的。")
        self._note.textChanged.connect(self._on_change)
        bf.addRow("备注", self._note)
        dl.addWidget(basic)

        nums = QGroupBox("倍率（1 = 不改；不勾 = 不写这一项）", self._detail)
        nf = compact_form(QFormLayout(nums))
        self._scalars: dict[str, OptionalNumField] = {}
        for key, label, tip in SCALAR_ROWS:
            f = self._make_scale_field(nums, tip)
            nf.addRow(label, f)
            self._scalars[key] = f
        dl.addWidget(nums)
        self._blocks: dict[str, dict[str, OptionalNumField]] = {}
        for block, title, rows in BLOCK_ROWS:
            box = QGroupBox(title, self._detail)
            form = compact_form(QFormLayout(box))
            fields: dict[str, OptionalNumField] = {}
            for key, label, tip in rows:
                f = self._make_scale_field(box, tip)
                form.addRow(label, f)
                fields[key] = f
            self._blocks[block] = fields
            dl.addWidget(box)

        fields_box = QGroupBox("对世界的影响（驱 / 招）", self._detail)
        ffl = QVBoxLayout(fields_box)
        self._fields = _FieldsListField(fields_box)
        self._fields.setToolTip(_FIELDS_TIP)
        self._fields.changed.connect(self._on_change)
        ffl.addWidget(self._fields)
        dl.addWidget(fields_box)

        tags_box = QGroupBox("标签（条件叶按它问）", self._detail)
        tfl = QVBoxLayout(tags_box)
        self._tags = _TagsListField(tags_box)
        self._tags.setToolTip(_TAGS_TIP)
        self._tags.changed.connect(self._on_change)
        tfl.addWidget(self._tags)
        dl.addWidget(tags_box)

        self._summary = QLabel("", self._detail)
        self._summary.setWordWrap(True)
        self._summary.setStyleSheet("color:#888;")
        dl.addWidget(self._summary)
        dl.addWidget(QLabel("改动随主编辑器「全部保存」(Ctrl+S) 写入 prop_effects.json", self._detail))
        dl.addStretch(1)
        scroll.setWidget(self._detail)
        body.addWidget(scroll, 1)

    def _make_scale_field(self, parent: QWidget, tip: str) -> OptionalNumField:
        f = OptionalNumField(
            0.0, 1000.0, 0.05, 3, seed=1.0, parent=parent, check_label="写",
            check_tip="不勾 = 不写这一项（这个参数不变）。")
        f.set_tool_tip(
            tip + "\n⚠ 全是倍率：1 = 不改。运行时只收 > 0 的数——0 / 负数一律当没写，"
                  "作者想按到 0，结果是「一点没变」。")
        f.changed.connect(self._on_change)
        return f

    # ---------------------------------------------------------------- 数据
    def reload_refs_from_model(self) -> None:
        """从模型重建列表（保持当前选中）。主窗口切页 / 开工程后调用。"""
        cur = self._cur_id
        self._list.blockSignals(True)
        self._list.clear()
        for eid in self._data:
            entry = self._data.get(eid)
            label = str(entry.get("label") or "").strip() if isinstance(entry, dict) else ""
            item = QListWidgetItem(f"{eid}　{label}" if label else str(eid), self._list)
            # id 存在 UserRole 里：显示文本带着名字，靠切串取 id 迟早被名字里的分隔符坑到
            item.setData(Qt.ItemDataRole.UserRole, str(eid))
        self._list.blockSignals(False)
        if cur:
            for i in range(self._list.count()):
                if self._row_id(i) == cur:
                    self._list.setCurrentRow(i)
                    return
        self._cur_id = ""
        if self._list.count():
            self._list.setCurrentRow(0)
        else:
            self._fill_detail()

    def _row_id(self, i: int) -> str:
        it = self._list.item(i)
        return str(it.data(Qt.ItemDataRole.UserRole) or "") if it is not None else ""

    def select_by_id(self, effect_id: str, _scene_id: str = "") -> bool:
        """全局搜索 / 跳转落点：按 id 选中。返回是否真的定位到了（导航诚实化契约）。"""
        for i in range(self._list.count()):
            if self._row_id(i) == effect_id:
                self._list.setCurrentRow(i)
                return True
        return False

    def _on_select(self, cur, _prev) -> None:
        self._cur_id = str(cur.data(Qt.ItemDataRole.UserRole) or "") if cur is not None else ""
        self._fill_detail()

    def _fill_detail(self) -> None:
        entry = self._data.get(self._cur_id)
        src = entry if isinstance(entry, dict) else {}
        self._loading = True
        try:
            self._detail.setEnabled(bool(self._cur_id) and isinstance(entry, dict))
            self._id_label.setText(self._cur_id or "（无选中）")
            self._label.setText(src["label"] if isinstance(src.get("label"), str) else "")
            self._note.setText(src["note"] if isinstance(src.get("note"), str) else "")
            for key, f in self._scalars.items():
                f.set_value(src.get(key))
            for block, fields in self._blocks.items():
                sub = src.get(block)
                sub = sub if isinstance(sub, dict) else {}
                for key, f in fields.items():
                    f.set_value(sub.get(key))
            self._fields.set_fields(src.get("fields", _MISSING) if "fields" in src else _MISSING)
            self._tags.set_tags(src.get("tags", _MISSING) if "tags" in src else _MISSING)
        finally:
            self._loading = False
        self._refresh_summary()
        self._refresh_usage()

    def _refresh_summary(self) -> None:
        entry = self._data.get(self._cur_id)
        if not isinstance(entry, dict):
            self._summary.setText("")
            return
        self._summary.setText("这一块乘了什么：" + prop_effect_summary(entry))

    def _refresh_usage(self, *, deep: bool = False) -> None:
        """谁在用这一块（改名 / 删除前必答的三问之一）。

        选中即显示的是**挂件预设**那一半（内存里的一张表，白菜价）；内容里 `{heldProp, effect}`
        的那一半要扫全工程动作 / 条件容器**并读盘上所有对话图**，点一次「查引用」才跑——
        挂在选中事件上会让每点一下列表都卡半秒。改名 / 删除这两条路无论如何都跑全量。
        """
        if not self._cur_id:
            self._usage.setText("")
            return
        users = self._users_of(self._cur_id)
        bits: list[str] = []
        if users:
            bits.append("用它的挂件预设：" + "、".join(users))
        if deep:
            conds = self._condition_users_of(self._cur_id)
            bits.append("条件叶里问它的：" + "、".join(conds) if conds else "没有条件叶问它。")
        elif not users:
            bits.append("还没有挂件预设用它。")
        self._usage.setText("；".join(bits))

    def _condition_users_of(self, eid: str) -> list[str]:
        """内容里 `{heldProp, effect}` 问到这一块的位置（改名要跟着改，不然那些条件恒为假）。"""
        from ..shared.prop_preset_refs import scan_effect_usages

        try:
            return scan_effect_usages(self._model, eid)
        except Exception:  # noqa: BLE001 — 扫描是锦上添花，不许把面板打挂
            return []

    def _users_of(self, eid: str) -> list[str]:
        out: list[str] = []
        presets = getattr(self._model, "prop_presets", None)
        for pid, entry in (presets or {}).items():
            if not isinstance(entry, dict):
                continue
            ids = [x for x in (entry.get("effects") or []) if isinstance(x, str)]
            for lv in entry.get("levels") or []:
                if isinstance(lv, dict):
                    ids += [x for x in (lv.get("effects") or []) if isinstance(x, str)]
            if eid in {x.strip() for x in ids}:
                out.append(str(pid))
        return sorted(out)

    # ---------------------------------------------------------------- 写回
    def _on_change(self, *_a: object) -> None:
        if self._loading or not self._cur_id:
            return
        old = self._data.get(self._cur_id)
        old = old if isinstance(old, dict) else {}
        managed: dict[str, Any] = {}
        label = self._label.text().strip()
        if label:
            managed["label"] = label
        note = self._note.text().strip()
        if note:
            managed["note"] = note
        for key, f in self._scalars.items():
            if f.is_untouched():
                if key in old:
                    managed[key] = copy.deepcopy(old[key])
                continue
            v = f.value()
            if v is not None:
                managed[key] = v
        for block, fields in self._blocks.items():
            if self._block_untouched(fields):
                # 整块一个控件都没动：原样保住磁盘那份（含空对象、坏形态、不认识的子键）
                if block in old:
                    managed[block] = copy.deepcopy(old[block])
                continue
            o_sub = old.get(block) if isinstance(old.get(block), dict) else {}
            sub: dict[str, Any] = {k: copy.deepcopy(v) for k, v in o_sub.items() if k not in fields}
            for key, f in fields.items():
                if f.is_untouched():
                    if key in o_sub:
                        sub[key] = copy.deepcopy(o_sub[key])
                    continue
                v = f.value()
                if v is not None:
                    sub[key] = v
            if sub:
                managed[block] = reorder_like(sub, o_sub)
        fields_v = self._fields.to_list()
        if fields_v is not _MISSING:
            managed["fields"] = fields_v
        tags_v = self._tags.to_list()
        if tags_v is not _MISSING:
            managed["tags"] = tags_v
        # 按原键序合并：old 里已有的管理键保持原位置更新，新增的追加在尾部；
        # 本页不认识的键原样保留（将来给 PropEffectDef 加字段不会被吞掉）
        merged: dict[str, Any] = {}
        for k, v in old.items():
            if k in managed:
                merged[k] = managed.pop(k)
            elif k in MANAGED_KEYS:
                continue     # 被清空的管理键（名字 / 备注空、倍率取消勾选）→ 删除
            else:
                merged[k] = v
        merged.update(managed)
        preserve_numeric_repr(merged, old)
        if merged == old:
            return           # 无实质变化：不写不标脏
        self._data[self._cur_id] = merged
        self._mark_dirty()
        self._refresh_summary()
        self._refresh_list_label()
        self._status.setText("已写入内存；Ctrl+S 保存工程写入磁盘。")

    @staticmethod
    def _block_untouched(fields: dict[str, OptionalNumField]) -> bool:
        return all(f.is_untouched() for f in fields.values())

    def _refresh_list_label(self) -> None:
        entry = self._data.get(self._cur_id)
        label = str(entry.get("label") or "").strip() if isinstance(entry, dict) else ""
        for i in range(self._list.count()):
            if self._row_id(i) == self._cur_id:
                it = self._list.item(i)
                if it is not None:
                    it.setText(f"{self._cur_id}　{label}" if label else self._cur_id)
                    it.setData(Qt.ItemDataRole.UserRole, self._cur_id)
                return

    # ---------------------------------------------------------------- 增删改名
    def _on_new(self) -> None:
        # 定义自身新 id 是裸输入框的唯一合法场合（选择器铁律的明文例外）
        new_id, ok = QInputDialog.getText(self, "新增效果块", "效果块 id（英文/下划线，全表唯一）：")
        eid = (new_id or "").strip()
        if not ok or not eid:
            return
        if eid in self._data:
            QMessageBox.warning(self, "新增效果块", f"id「{eid}」已存在。")
            return
        self._data[eid] = {"label": eid}
        self._mark_dirty()
        self._cur_id = eid
        self.reload_refs_from_model()
        self._status.setText(
            f"新建效果块「{eid}」。数值全是倍率（1 = 不改），至多两块挂在同一支火把上"
            f"（上限 {PROP_EFFECTS_MAX_HINT}）。")

    def _on_rename(self) -> None:
        old_id = self._cur_id
        if not old_id:
            return
        from ..shared.prop_preset_refs import rename_effect_references

        users = self._users_of(old_id) + self._condition_users_of(old_id)
        tail = ("\n引用它的地方会一并改写：" + "、".join(users)) if users else ""
        new_id, ok = QInputDialog.getText(
            self, "重命名效果块", f"「{old_id}」的新 id：{tail}", text=old_id)
        eid = (new_id or "").strip()
        if not ok or not eid or eid == old_id:
            return
        if eid in self._data:
            QMessageBox.warning(self, "重命名", f"id「{eid}」已存在。")
            return
        rebuilt: dict[str, Any] = {}
        for k, v in self._data.items():
            rebuilt[eid if k == old_id else k] = v
        self._data.clear()
        self._data.update(rebuilt)
        self._mark_dirty()
        n = self._rename_in_presets(old_id, eid)
        # 内容里的 `{heldProp, effect}`：不跟着改 = 那些条件从此恒为假，运行时一行都不 warn
        c = rename_effect_references(self._model, old_id, eid)
        self._cur_id = eid
        self.reload_refs_from_model()
        self._status.setText(f"已改名为「{eid}」；同时改写了 {n} 处挂件预设引用、{c} 处条件叶引用。")

    def _rename_in_presets(self, old: str, new: str) -> int:
        """把挂件预设里 `effects` / `levels[*].effects` 对 old 的引用改写成 new。

        不改写 = 那几支火把的脾气从此静默消失（运行时只 log 一行）。
        """
        presets = getattr(self._model, "prop_presets", None)
        if not isinstance(presets, dict):
            return 0
        total = 0

        def fix(lst: object) -> bool:
            hit = False
            if isinstance(lst, list):
                for i, x in enumerate(lst):
                    if isinstance(x, str) and x.strip() == old:
                        lst[i] = new
                        hit = True
            return hit

        for entry in presets.values():
            if not isinstance(entry, dict):
                continue
            if fix(entry.get("effects")):
                total += 1
            for lv in entry.get("levels") or []:
                if isinstance(lv, dict) and fix(lv.get("effects")):
                    total += 1
        if total:
            mk = getattr(self._model, "mark_dirty", None)
            if callable(mk):
                mk("prop_presets")
        return total

    def _on_delete(self) -> None:
        if not self._cur_id:
            return
        users = self._users_of(self._cur_id) + self._condition_users_of(self._cur_id)
        if users:
            QMessageBox.warning(
                self, "删除效果块",
                f"「{self._cur_id}」还被这些地方用着：{'、'.join(users)}。\n"
                "先去把它卸下来 / 改掉条件——删了之后运行时只 log 一行，"
                "那几支火把的脾气会静默消失，问它的条件从此恒为假。")
            return
        if not confirm.confirm_delete(self, f"效果块「{self._cur_id}」"):
            return
        self._data.pop(self._cur_id, None)
        self._mark_dirty()
        self._cur_id = ""
        self.reload_refs_from_model()
