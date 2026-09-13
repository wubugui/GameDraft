"""场景灯的「跟随实体」绑定（`LightDef.follow`）的作者面。

## 语义（权威源 `src/data/types.ts` 的 `LightFollowDef`）

这盏灯不待在 `pos`，而是每帧跟着某个实体走（更夫提的灯笼、推车上的马灯）：
运行时 `HeldPropSystem.resolveFollowLight` 每帧把它解成一盏**运行时灯**，
`SceneLightingSystem.effectiveLights` 则**跳过原件**。于是：

- 配了 `follow` 之后 **`pos` 不再参与光照**，只留作编辑器里的参考点；
- 目标不在场（NPC 换班走了 / 名字改错了）⇒ 那一帧这盏灯**不发光，不回落 `pos`**
  —— 回落会让一盏灯莫名钉在半空，比不亮更难查；
- 给了 `socket` 而该帧挂点没有标注 ⇒ 同样这一帧不发光（与挂件一起隐）。

⚠ 手上举着的火把**不走这里**：那是挂件自带的灯（`prop_presets.json` 的 `light` 块）。
这里是"场景里本来就有、但会动"的那种灯。

## 为什么是懒建的折叠块

绝大多数灯不跟随。按 editor-tools norms 的布局纪律，重块默认折叠且**首次展开才造控件**
（全套编辑器测试的耗时对存活控件数呈 O(N²)）。没展开过的块**原样透传磁盘值**——
这既是省控件，也是往返保真最硬的那一道：`dump()` 在未建控件时直接回吐载入时的深拷贝，
一个字节都不经过 Qt 数值控件。

## 往返保真三条（踩过的都在 numeric-roundtrip-fidelity 卡里）

1. **未改动的数值按原始表示回写**（`preserve_numeric_repr`，含 `offset` 逐元素）——
   `QDoubleSpinBox` 一律吐 float，不兜住就"打开即保存"把 `0` 漂成 `0.0`。
   控件本身还会**量化**（`decimals=3` 把 `100.12345` 截成 `100.123`，那时数值已不相等、
   `preserve_numeric_repr` 兜不住）⇒ 另加**种子快照法**（样板 `anim_editor`）：载入时记下
   截断后的种子，保存时控件仍等于种子就回吐磁盘原字面值。
2. **缺省不落键**：`heightWu` / `offset` 原本没写且仍是中性默认时不写进去。
   勾掉「跟随」= **不写 `follow` 键**（不是 `null`、不是 `{}`）。
3. **键序按磁盘原序**，只有新增键才追加；表单不认识的键（将来给 `LightFollowDef`
   加字段）原样透传，不许被吞掉。
"""
from __future__ import annotations

import copy
from typing import Any, Callable

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QCheckBox, QDoubleSpinBox, QFormLayout, QHBoxLayout, QLabel, QVBoxLayout, QWidget,
)

from ..shared.collapsible_section import CollapsibleSection
from ..shared.form_layout import compact_form
from ..shared.id_ref_selector import IdRefSelector
from ..shared.num_fields import float_or
from ..shared.numeric_roundtrip import preserve_numeric_repr
from . import scene_lights

#: `LightFollowDef` 里表单管着的键。此外的键一律原样透传（将来加字段不会被吞）。
FOLLOW_KEYS = ("target", "socket", "heightWu", "offset")

_HEIGHT_TIP = (
    "离地高度，单位 **wu**（世界空间，与 NPC 坐标同一把尺）。\n"
    f"尺度锚：角色高 {scene_lights.CHARACTER_HEIGHT_WU} wu —— 提在手上的灯笼大约 100 wu、"
    "挑在扁担上的约 180 wu。\n"
    "不给挂点时靠它把灯抬到该有的高度；给了挂点则**叠加在挂点高度上**。"
)
_OFFSET_TIP = (
    "世界空间偏移（**wu**），加在解出来的位置上。\n"
    f"尺度锚：角色高 {scene_lights.CHARACTER_HEIGHT_WU} wu。三个 0 = 不偏。"
)


def _num_repr_like(value: float, original: Any) -> Any:
    """数值相等就回吐原始表示（`0` 不漂成 `0.0`）。`preserve_numeric_repr` 的单值版。"""
    if isinstance(original, bool) or not isinstance(original, (int, float)):
        return value
    return original if float(original) == float(value) else value


def _reorder_like(out: dict, original: Any) -> dict:
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


class LightFollowEditor(QWidget):
    """一盏灯的 `follow` 块。`changed` 由调用方接到自己的脏标记上。

    用法::

        w = LightFollowEditor(on_changed=self._on_sl_field_changed)
        form.addRow(w)
        ...
        w.set_context(model, scene_id)     # 候选取自 ProjectModel 的 id-provider
        w.set_data(light.get("follow"))    # None = 这盏灯不跟随
        ...
        f = w.dump()                       # None = **不写** follow 键
    """

    changed = Signal()

    def __init__(self, on_changed: Callable[[], None] | None = None,
                 parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._on_changed = on_changed
        self._loading = False
        self._built = False
        self._pending: dict | None = None
        self._model: Any = None
        self._scene_id: str | None = None
        # 种子快照（控件量化后的值）。控件仍等于种子 = 用户没动过 ⇒ 回吐磁盘原字面值。
        self._height_seed: float | None = None
        self._offset_seeds: list[float] = []
        # 当前候选面（自己留一份：别去读共享控件的私有缓存）
        self._target_items: list[tuple[str, str]] = []
        self._socket_items: list[tuple[str, str]] = []
        #: 盘上这份 `follow` 是坏的（没有 target）⇒ **只读透传**，别趁作者改别的字段时
        #: 顺手把它删掉。显式标记 + "用户动过没有"配对判断（shared-widget-value-fidelity
        #: 契约 5/6）：作者一碰这块（`_emit`）标记就清掉，那时他的意图算数。
        self._bad_passthrough = False

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self._section = CollapsibleSection("跟随实体（不跟随）", start_open=False)
        self._section.set_header_tool_tip(
            "让这盏灯每帧跟着某个实体走（更夫提的灯笼、推车上的马灯）。\n"
            "⚠ 配了跟随之后 pos **不再参与光照**，只留作编辑器里的参考点。\n"
            "⚠ 目标不在场那一帧这盏灯**不发光**，不回落到 pos。\n"
            "手上举着的火把不走这里——那是挂件自带的灯（挂件预设的 light 块）。")
        self._section.expanded_changed.connect(self._on_expanded)
        self._body = QWidget()
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        self._body_layout.setSpacing(4)
        self._section.add_body(self._body)
        outer.addWidget(self._section)

    # ------------------------------------------------------------------ 懒建
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
        # ⚠ 懒建出来的行必须**当场算进高度**，否则首次展开时这一块是一条缝
        #   （editor-change-verification-gate 的「布局塌陷」；护栏
        #   `TestLayout::test_首次展开后跟随块不是一条缝` 实测会红）。
        #   `show()` 是防御：本控件的子控件一出生就带 parent，不走 bubble_lines 那个
        #   "先做顶层再 addWidget、于是被布局整个跳过"的坑，但别人改这里时未必。
        #   `_relayout` 自内向外逐层 invalidate+activate —— 只捅最近一两层不够
        #   （外面还套着 QFormLayout → QScrollArea）。
        self._body.show()
        self._relayout()
        self._fill_widgets()

    def _relayout(self) -> None:
        w: QWidget | None = self._body
        while w is not None:
            lay = w.layout()
            if lay is not None:
                lay.invalidate()
                lay.activate()
            w.updateGeometry()
            if w is self:
                break
            w = w.parentWidget()

    def _build_body(self) -> None:
        self._on = QCheckBox("跟随某个实体（pos 不再参与光照）", self._body)
        self._on.setToolTip(
            "勾上 = 这盏灯每帧跟着下面那个实体走。\n"
            "勾掉 = **不写 follow 键**（回到「灯钉在 pos 上」那条老路）。")
        self._on.toggled.connect(self._on_enable_toggled)
        self._body_layout.addWidget(self._on)

        self._fields = QWidget(self._body)
        form = compact_form(QFormLayout(self._fields))

        # 引用字段一律走共享选择器（norms 选择器铁律：禁止裸 QLineEdit）。
        # 候选是"本场景 player + NPC"，可能上二十个 ⇒ IdRefSelector 会自动换成
        # 可搜索弹窗（`_SEARCH_PICKER_MIN_ITEMS`）。未知/悬垂值保值展示。
        self._target = IdRefSelector(
            allow_empty=False, editable=False, click_opens_popup=True)
        self._target.setMinimumWidth(170)
        self._target.setToolTip(
            "跟着谁走：`player` 或**本场景**的 NPC id。\n"
            "目标不在场（NPC 换班走了 / 名字改错了）⇒ 那一帧这盏灯不发光，不回落 pos。\n"
            "标了「缺失」的值是本场景找不到的引用——已保值，不会被改写。")
        self._target.value_changed.connect(self._on_target_changed)
        form.addRow("跟随目标", self._target)

        # 挂点候选从目标动画包的 sockets.json 派生；取不到就允许保值自由值
        # （editable=True：手打的名字与旧数据都不会被清掉）。
        self._socket = IdRefSelector(
            allow_empty=True, editable=True, click_opens_popup=True)
        self._socket.setMaximumWidth(200)
        self._socket.setToolTip(
            "跟哪个挂点（灯笼在手上就给 right_hand）。留空 = 跟实体**脚点**。\n"
            "候选来自该目标动画包的 sockets.json（在动画编辑器的「挂点」区标）；\n"
            "取不到候选时可以手打——名字跨动画包通用。\n"
            "⚠ 给了挂点而该帧挂点没有标注 ⇒ 这一帧不发光（与挂件一起隐）。")
        self._socket.value_changed.connect(self._emit)
        form.addRow("挂点", self._socket)

        self._height = self._spin(-500.0, 2000.0, 5.0)
        self._height.setToolTip(_HEIGHT_TIP)
        form.addRow("离地高度 wu", self._height)

        off_row = QWidget(self._fields)
        ol = QHBoxLayout(off_row)
        ol.setContentsMargins(0, 0, 0, 0)
        ol.setSpacing(4)
        self._offset: list[QDoubleSpinBox] = []
        for axis in ("x", "y", "z"):
            lbl = QLabel(axis, off_row)
            lbl.setToolTip(_OFFSET_TIP)
            ol.addWidget(lbl)
            sb = self._spin(-20000.0, 20000.0, 5.0)
            sb.setToolTip(_OFFSET_TIP)
            ol.addWidget(sb)
            self._offset.append(sb)
        ol.addStretch(1)
        form.addRow("偏移 wu", off_row)
        self._body_layout.addWidget(self._fields)

        self._note = QLabel("", self._body)
        self._note.setWordWrap(True)
        self._body_layout.addWidget(self._note)

    def _spin(self, lo: float, hi: float, step: float) -> QDoubleSpinBox:
        # 量程给足世界坐标（泛型小量程会把真数据 clamp 掉，见 numeric-roundtrip 契约 2）。
        sb = QDoubleSpinBox(self._fields)
        sb.setRange(lo, hi)
        sb.setSingleStep(step)
        sb.setDecimals(3)
        sb.setMaximumWidth(96)
        sb.valueChanged.connect(self._emit)
        return sb

    # ------------------------------------------------------------------ 内部
    def _emit(self, *_a: object) -> None:
        if self._loading:
            return
        self._bad_passthrough = False    # 作者碰过这一块了，他的意图从此算数
        self._refresh_note()
        self._refresh_title()
        self.changed.emit()
        if self._on_changed:
            self._on_changed()

    def _on_enable_toggled(self, *_a: object) -> None:
        if self._built:
            self._fields.setEnabled(self._on.isChecked())
        self._emit()

    def _on_target_changed(self, *_a: object) -> None:
        self._refresh_socket_items()
        self._emit()

    def _refresh_socket_items(self) -> None:
        """按当前目标重取挂点候选。**当前值保值**（IdRefSelector 负责）。"""
        if not self._built:
            return
        items: list[tuple[str, str]] = []
        fn = getattr(self._model, "socket_names_for_actor", None)
        if callable(fn):
            try:
                items = list(fn(self._scene_id, self._target.current_id()) or [])
            except Exception:  # noqa: BLE001 —— 取不到候选只是少了下拉，不能反噬面板
                items = []
        self._socket_items = items
        cur = self._socket.current_id()
        was = self._loading
        self._loading = True
        try:
            self._socket.set_items(items)
            self._socket.set_current(cur)
        finally:
            self._loading = was

    def _refresh_title(self) -> None:
        """折起来时标题就是这条的辨识依据，所以它必须说出"跟着谁走"。"""
        f = self.dump()
        tgt = str((f or {}).get("target") or "").strip()
        if tgt:
            title = f"跟随实体：跟着「{tgt}」走"
        elif f is not None:
            title = "跟随实体：⚠ 配了 follow 但没有 target"
        else:
            title = "跟随实体（不跟随）"
        self._section.set_title(title)

    def _refresh_note(self) -> None:
        if not self._built:
            return
        if not self._on.isChecked():
            self._note.setText("")
            return
        tgt = self._target.current_id().strip()
        if not tgt:
            self._note.setText(
                "⚠ 数据里的 follow 没有 target（运行时永远解不出目标 ⇒ 这盏灯不亮）；"
                "原值已原样保留，选个目标就修好了。"
                if self._bad_passthrough else
                "⚠ 勾了跟随但还没选目标 —— follow 还没写进数据。")
            self._note.setStyleSheet("color:#c66;")
            return
        parts = [
            f"这盏灯每帧跟着「{tgt}」走；pos 不再参与光照（只当编辑器参考点）。",
            "目标不在场那一帧这盏灯不发光，**不回落 pos**。",
        ]
        bad = False
        sock = self._socket.current_id().strip()
        if sock:
            known = {rid for rid, _ in self._socket_items}
            if not known:
                parts.append(
                    f"⚠「{tgt}」的动画包没有挂点标注（sockets.json）——"
                    "这个挂点解不出来，那一帧这盏灯就不发光。")
                bad = True
            elif sock not in known:
                parts.append(f"⚠ 挂点「{sock}」不在该动画包的标注里（原值已保留）。")
                bad = True
        self._note.setText("　".join(parts))
        self._note.setStyleSheet("color:#c66;" if bad else "color:#888;")

    def _fill_widgets(self) -> None:
        if not self._built:
            return
        f = self._pending if isinstance(self._pending, dict) else None
        was = self._loading
        self._loading = True
        try:
            self._refresh_target_items()
            self._on.setChecked(f is not None)
            self._fields.setEnabled(f is not None)
            self._target.set_current(str((f or {}).get("target") or ""))
            self._refresh_socket_items()
            self._socket.set_current(str((f or {}).get("socket") or ""))
            self._height.setValue(float_or((f or {}).get("heightWu"), 0.0))
            off = (f or {}).get("offset")
            off = off if isinstance(off, list) and len(off) == 3 else [0.0, 0.0, 0.0]
            for sb, v in zip(self._offset, off):
                sb.setValue(float_or(v, 0.0))
            # 种子必须在 setValue **之后**取（记的是控件量化后的那个值）
            self._height_seed = self._height.value()
            self._offset_seeds = [sb.value() for sb in self._offset]
            # 盘上是坏 follow（没 target）⇒ 转成只读透传，等作者真的动它
            self._bad_passthrough = f is not None and not str(
                f.get("target") or "").strip()
        finally:
            self._loading = was
        self._refresh_note()

    def _refresh_target_items(self) -> None:
        if not self._built:
            return
        items: list[tuple[str, str]] = []
        fn = getattr(self._model, "light_follow_target_items_for_scene", None)
        if callable(fn):
            try:
                items = list(fn(self._scene_id) or [])
            except Exception:  # noqa: BLE001 —— 同上，候选取不到不许反噬
                items = []
        self._target_items = items
        self._target.set_items(items)

    # ---- 候选面（给调用方与测试看；不去读共享控件的私有缓存）----
    def target_items(self) -> list[tuple[str, str]]:
        return list(self._target_items)

    def socket_items(self) -> list[tuple[str, str]]:
        return list(self._socket_items)

    # ------------------------------------------------------------------ 外部
    def set_context(self, model: Any, scene_id: str | None) -> None:
        """喂 ProjectModel 与当前场景 id（候选面由它们决定，换场景必须重喂）。"""
        self._model = model
        self._scene_id = scene_id
        if self._built:
            cur = self._target.current_id()
            was = self._loading
            self._loading = True
            try:
                self._refresh_target_items()
                self._target.set_current(cur)
                self._refresh_socket_items()
            finally:
                self._loading = was

    def reload_refs_from_model(self) -> None:
        """切页回来时重拉候选（跨面板刷新约定）。当前值保值。"""
        self.set_context(self._model, self._scene_id)

    def set_data(self, follow: object) -> None:
        """从灯数据载入。`None` / 非 dict = 这盏灯不跟随。

        配了 follow 的灯**当场把控件建出来并展开**——折着看不见等于没接进来。
        """
        self._pending = copy.deepcopy(follow) if isinstance(follow, dict) else None
        if self._pending is not None and not self._built:
            self.ensure_built()          # 内含一次 `_fill_widgets`
        elif self._built:
            self._fill_widgets()
        if self._pending is not None:
            self._section.set_expanded(True)
        self._refresh_title()

    def dump(self) -> dict | None:
        """产出写回值。`None` = **不写 `follow` 键**（不是 null、不是空对象）。

        没展开过 ⇒ 原样回吐载入时的深拷贝（一个字节都不经过 Qt 控件）。
        """
        if not self._built or self._bad_passthrough:
            return copy.deepcopy(self._pending)
        if not self._on.isChecked():
            return None
        target = self._target.current_id().strip()
        if not target:
            # 勾了跟随却没选目标：写 `{"target": ""}` 是往数据里塞垃圾（运行时找不到
            # 目标 ⇒ 这盏灯永远不亮，而作者以为配好了）。宁可不写，并在面板上说出来。
            return None
        orig = self._pending if isinstance(self._pending, dict) else None
        out: dict = {}
        # 表单不认识的键原样透传（将来给 LightFollowDef 加字段不会被吞掉）
        for k, v in (orig or {}).items():
            if k not in FOLLOW_KEYS:
                out[k] = copy.deepcopy(v)
        out["target"] = target
        sock = self._socket.current_id().strip()
        if sock:
            out["socket"] = sock
        h = self._seeded(self._height.value(), self._height_seed,
                         (orig or {}).get("heightWu"))
        if h != 0 or (orig is not None and "heightWu" in orig):
            out["heightWu"] = h
        orig_off = (orig or {}).get("offset")
        orig_off = orig_off if isinstance(orig_off, list) and len(orig_off) == 3 else []
        off = [
            self._seeded(sb.value(),
                         self._offset_seeds[i] if i < len(self._offset_seeds) else None,
                         orig_off[i] if i < len(orig_off) else None)
            for i, sb in enumerate(self._offset)
        ]
        if any(v != 0 for v in off) or (orig is not None and "offset" in orig):
            out["offset"] = off
        # 数值表示保真：种子法兜住控件量化，`preserve_numeric_repr` 兜住 int→float
        preserve_numeric_repr(out, orig)
        if "offset" in out and orig_off:
            out["offset"] = [_num_repr_like(v, o)
                             for v, o in zip(out["offset"], orig_off)]
        return _reorder_like(out, orig)

    @staticmethod
    def _seeded(value: float, seed: float | None, original: Any) -> Any:
        """控件没动过（仍等于种子）且磁盘原值是数 ⇒ 回吐原字面值；否则用控件值。"""
        if (seed is not None and value == seed
                and isinstance(original, (int, float)) and not isinstance(original, bool)):
            return original
        return round(value, 4)
