"""宿主身上的「可燃」块（热点 / NPC / 挂件预设共用一份作者面）。

数据契约（``docs/玩法功能需求清单.md`` A3.8；TS 权威 ``src/data/burnables.ts`` 的 ``BurnableHostDef``）：

    burnable: {template, initial?, playerIgnite?, igniteConditions?, signals?: {ignited?, burntOut?, extinguished?}}

* 开 = 写 ``burnable: {template}``；关 = **删整块**（块里还有别的配置时先确认）；
* 缺省值不写回：``initial`` 缺省 ``unburnt``、``playerIgnite`` 缺省 ``true``、条件空 = 删键、信号空 = 删那一项；
* 键序按 ``burnables.HOST_ORDER``，未知键原样保在末尾；**没展开过 / 什么都没动 ⇒ 原样回吐载入值**（字节级往返）；
* ``playerIgnite`` / ``igniteConditions`` 只对场景实体有意义——挂件（``host_kind="prop"``）不显示这两行，
  磁盘上写着的照样透传（校验器给警告）；
* 模板候选 = ``ProjectModel.burnable_template_ids()``（与校验器同一个函数），未知 / 悬垂值保值展示；
* 开了可燃 ⇒ 宿主自己的图 / 动画一律失效，渲染由实例接管——块里写清楚，宿主再经 ``set_note_provider``
  补它自己的具体冲突（热点展示图与模板图不同、NPC 有动画……）。

布局纪律：默认折叠、首次展开才造控件（有 ``burnable`` 的实体载入时自动展开）；说明进 tooltip。
"""
from __future__ import annotations

import copy
from typing import Any, Callable

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFormLayout,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from . import burnables as _bn
from .collapsible_section import CollapsibleSection
from .form_layout import compact_form
from .id_ref_selector import IdRefSelector


class _Absent:
    __slots__ = ()

    def __copy__(self) -> "_Absent":
        return self

    def __deepcopy__(self, _memo: dict) -> "_Absent":
        return self

    def __repr__(self) -> str:  # pragma: no cover - 调试用
        return "ABSENT"


#: 「不写 ``burnable`` 键」
ABSENT: Any = _Absent()

#: 宿主种类 → ``normalize_burnable_host`` 的 host_kind 与人话
HOST_KINDS: dict[str, tuple[str, str]] = {
    "hotspot": ("entity", "热点"),
    "npc": ("entity", "NPC"),
    "prop": ("prop", "挂件"),
}

_INITIAL_ROWS = (("没点（缺省）", "unburnt"), ("第一次出现就在烧", "burning"))
#: 「第一次出现」下拉里保值那一行的 data
_RAW_ROW = "\x00raw"
_WARN_STYLE = "color:#e05050;"
_TAKEOVER_STYLE = "color:#d08a20;"

SECTION_TIP = (
    "把这个{host}变成一份可燃物模板的实例（A3.8）：写 burnable: {{template, …}}。\n"
    "模板（图、真实尺寸、燃料、着火点、烧法、粒子、火光）只在燃烧工作台里做；这里只配这一个实例：\n"
    "用哪份模板、第一次出现是不是已经在烧{ignite}、点着 / 烧完 / 灭了各发什么叙事信号。\n"
    "开了可燃：{host}自己的图 / 动画一律不画，渲染由实例接管。默认折叠；有配置时自动展开。"
)


def _ordered(d: dict, order: tuple[str, ...]) -> dict:
    out = {k: d[k] for k in order if k in d}
    for k, v in d.items():
        if k not in out:
            out[k] = v
    return out


def host_has_extra_config(value: Any) -> bool:
    """块里除了 ``template`` 还有没有别的配置（关掉之前要不要确认）。"""
    if not isinstance(value, dict):
        return value is not ABSENT
    return any(k != "template" for k in value)


class BurnableHostSection(QWidget):
    """「可燃」折叠块。宿主调用 :meth:`load` / :meth:`write_to` / :meth:`value`，连 ``changed``。"""

    changed = Signal()
    #: 「打开燃烧工作台」：模板 id（可空）
    open_workbench_requested = Signal(str)

    def __init__(self, model: Any, host_kind: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        if host_kind not in HOST_KINDS:
            raise ValueError(f"host_kind 必须是 {tuple(HOST_KINDS)}")
        self._model = model
        self._host_kind = host_kind
        self._host_name = HOST_KINDS[host_kind][1]
        self._raw: Any = ABSENT
        self._scene_id: str | None = None
        self._edited: set[str] = set()
        self._built = False
        self._loading = False
        self._note_provider: Callable[[str, dict | None], list[str]] | None = None
        #: 最近一次开着时的模板（关了再开回来接着用）
        self._last_template = ""
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(0)
        self._section = CollapsibleSection("可燃（没开）", start_open=False)
        self._section.set_header_tool_tip(SECTION_TIP.format(
            host=self._host_name, ignite="、玩家能不能按 E 点、能点的条件" if self._entity_host else ""))
        self._section.expanded_changed.connect(self._on_expanded)
        self._body = QWidget()
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        self._body_layout.setSpacing(4)
        self._section.add_body(self._body)
        outer.addWidget(self._section)

    # ------------------------------------------------------------------ 属性
    @property
    def _entity_host(self) -> bool:
        return HOST_KINDS[self._host_kind][0] == "entity"

    @property
    def section(self) -> CollapsibleSection:
        return self._section

    def is_built(self) -> bool:
        return self._built

    def set_note_provider(self, fn: Callable[[str, dict | None], list[str]] | None) -> None:
        """宿主补充的冲突提示：``fn(模板 id, 模板文档或 None) -> [一行提示…]``（只在开着时调）。"""
        self._note_provider = fn
        self.refresh_notes()

    # ------------------------------------------------------------------ 懒建
    def _on_expanded(self, on: bool) -> None:
        if on:
            self.ensure_built()

    def ensure_built(self) -> None:
        if self._built:
            return
        self._built = True
        from .action_editor import NarrativeSignalPickerField
        from .condition_editor import ConditionEditor

        self._loading = True
        try:
            body = self._body
            top = QHBoxLayout()
            top.setContentsMargins(0, 0, 0, 0)
            self.enable_box = QCheckBox(f"这个{self._host_name}是可燃物（实例化一份模板）", body)
            self.enable_box.setToolTip(
                "勾上 = 写 burnable: {template}；勾掉 = 删掉整个 burnable 块（块里还有别的配置时先问一句）。")
            self.enable_box.toggled.connect(self._on_enable_toggled)
            top.addWidget(self.enable_box)
            top.addStretch(1)
            # 开关旁边、不在字段区里：没开可燃时字段区整块灰掉，按钮仍要点得动（先去工作台做模板）
            self.open_btn = QPushButton("打开燃烧工作台", body)
            self.open_btn.setToolTip("另起燃烧工作台进程并打开这份模板（--open <模板 id>）；没选模板就只打开工作台。\n"
                                     "模板在那边存盘后，这里与画布会自动重画（也可「工具 → 刷新燃烧数据」）。")
            self.open_btn.clicked.connect(lambda: self.open_workbench_requested.emit(self.current_template()))
            top.addWidget(self.open_btn)
            self._body_layout.addLayout(top)
            # 接管说明与冲突提示紧跟开关（作者勾上的那一眼就得看见"自己的图 / 动画不画了"）
            self.takeover_label = QLabel("", body)
            self.takeover_label.setWordWrap(True)
            self.takeover_label.setStyleSheet(_TAKEOVER_STYLE)
            self._body_layout.addWidget(self.takeover_label)
            self.warn_label = QLabel("", body)
            self.warn_label.setWordWrap(True)
            self.warn_label.setStyleSheet(_WARN_STYLE)
            self._body_layout.addWidget(self.warn_label)

            self._fields = QWidget(body)
            form = compact_form(QFormLayout(self._fields))
            form.setContentsMargins(0, 0, 0, 0)
            self.template_selector = IdRefSelector(self._fields, allow_empty=False, editable=False, click_opens_popup=True)
            self.template_selector.setMaximumWidth(320)
            self.template_selector.setToolTip(
                "用哪份可燃物模板（assets/data/burnables/<id>.json）。候选来自燃烧工作台存下的全部模板；\n"
                "磁盘上写着但已经不存在的模板保值显示（标「缺失」），不会被悄悄换掉。")
            self.template_selector.value_changed.connect(lambda *_: self._edit("template"))
            form.addRow("模板", self.template_selector)

            self.summary_label = QLabel("", self._fields)
            self.summary_label.setWordWrap(True)
            self.summary_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            form.addRow(self.summary_label)

            self.initial_combo = QComboBox(self._fields)
            for label, data in _INITIAL_ROWS:
                self.initial_combo.addItem(label, data)
            self.initial_combo.setMaximumWidth(220)
            self.initial_combo.setToolTip(
                "实例第一次出现时是不是已经在烧（有着火点从第一个点烧起，没有就整体点着）。\n"
                + ("场景实体 = 第一次进场（或被生成出来）那一刻。" if self._entity_host
                   else "挂件 = 挂上一支新的（包里没有记着烧到哪的）那一刻。"))
            self.initial_combo.currentIndexChanged.connect(lambda *_: self._edit("initial"))
            form.addRow("第一次出现", self.initial_combo)

            self.player_ignite_box: QCheckBox | None = None
            self.conditions = None
            if self._entity_host:
                self.player_ignite_box = QCheckBox("玩家拿着火能按 E 点它（缺省能）", self._fields)
                self.player_ignite_box.setToolTip(
                    "勾掉 = 写 playerIgnite: false：玩家按 E 点不了（剧情动作 igniteBurnable 照样能点；"
                    "玩家拿着灭着的火把照样能从它身上引火）。")
                self.player_ignite_box.toggled.connect(lambda *_: self._edit("playerIgnite"))
                form.addRow("玩家点火", self.player_ignite_box)

            self.signal_fields: dict[str, Any] = {}
            for moment in _bn.SIGNAL_KEYS:
                row = QWidget(self._fields)
                rl = QHBoxLayout(row)
                rl.setContentsMargins(0, 0, 0, 0)
                picker = NarrativeSignalPickerField(self._model, "", row)
                picker.valueChanged.connect(lambda *_, m=moment: self._edit(f"signals.{m}"))
                rl.addWidget(picker, 1)
                clear = QPushButton("清空", row)
                clear.setToolTip("不发这个信号（删掉这一项）")
                clear.clicked.connect(lambda *_, m=moment: self._clear_signal(m))
                rl.addWidget(clear)
                self.signal_fields[moment] = picker
                owner = ("拿着它的人的 id" if not self._entity_host else "这个实体的 id")
                row.setToolTip(f"{_bn.SIGNAL_MOMENT_LABELS[moment]}发的叙事信号（实发源 owner = {owner}）。")
                form.addRow(f"{_bn.SIGNAL_MOMENT_LABELS[moment]}发信号", row)
            if self._entity_host:
                # 条件编辑器块头大，放在最后，别把信号三行挤到屏幕外
                self.conditions = ConditionEditor(
                    "玩家能点的条件", self._fields,
                    hint="与实体自己的条件同时满足才能按 E 点；空 = 无条件。")
                self.conditions.changed.connect(lambda: self._edit("igniteConditions"))
                form.addRow(self.conditions)
            self._body_layout.addWidget(self._fields)
        finally:
            self._loading = False
        self._body.show()
        self._fill()

    # ------------------------------------------------------------------ 载入 / 回填
    def load(self, entity: Any, scene_id: str | None = None) -> None:
        """从宿主（热点 / NPC / 挂件预设 dict）载入 ``burnable`` 键。不标脏、不发 ``changed``。"""
        src = entity if isinstance(entity, dict) else {}
        self._raw = copy.deepcopy(src["burnable"]) if "burnable" in src else ABSENT
        self._scene_id = scene_id
        self._edited = set()
        tid = self._raw.get("template") if isinstance(self._raw, dict) else None
        # 换了宿主：上一个宿主的模板不许带过来（没开的宿主勾上时重新挑）
        self._last_template = tid.strip() if isinstance(tid, str) else ""
        if self._raw is not ABSENT:
            self.ensure_built()
            self._section.set_expanded(True)
        if self._built:
            self._fill()
        self._refresh_title()

    def _fill(self) -> None:
        if not self._built:
            return
        was = self._loading
        self._loading = True
        try:
            raw = self._raw
            d = raw if isinstance(raw, dict) else {}
            self.template_selector.set_items(self._template_items())
            self.template_selector.set_current(str(d.get("template") or self._last_template or ""))
            on = raw is not ABSENT
            self.enable_box.setChecked(on)
            ini = d.get("initial", "unburnt")
            # 未知值保值：加一行「（数据）…」（选着它 = 不动磁盘上那个值）
            extra = self.initial_combo.findData(_RAW_ROW)
            if extra >= 0:
                self.initial_combo.removeItem(extra)
            idx = self.initial_combo.findData(ini) if isinstance(ini, str) else -1
            if idx < 0:
                self.initial_combo.addItem(f"（数据）{ini!r}", _RAW_ROW)
                idx = self.initial_combo.count() - 1
            self.initial_combo.setCurrentIndex(idx)
            if self.player_ignite_box is not None:
                self.player_ignite_box.setChecked(d.get("playerIgnite") is not False)
            if self.conditions is not None:
                self.conditions.set_flag_pattern_context(self._model, self._scene_id or None)
                conds = d.get("igniteConditions")
                self.conditions.set_data(conds if isinstance(conds, list) else [])
            sig = d.get("signals") if isinstance(d.get("signals"), dict) else {}
            for moment, picker in self.signal_fields.items():
                v = sig.get(moment)
                # 信号选择控件没有程序性 setter（它只经信号管理器改值）：回填直接落它那两个字段，不发 valueChanged
                picker._value = v.strip() if isinstance(v, str) else ""
                picker._refresh_line()
            self._sync_enabled()
        finally:
            self._loading = was
        self.refresh_notes()

    def _template_items(self) -> list[tuple[str, str]]:
        fn = getattr(self._model, "burnable_template_ids", None)
        return list(fn()) if callable(fn) else []

    def _sync_enabled(self) -> None:
        on = self.enable_box.isChecked()
        self._fields.setEnabled(on)
        has_candidates = bool(self._template_items())
        # 一份模板都没有且现在没开：勾不上（勾上也选不出模板），提示先去工作台做一份
        self.enable_box.setEnabled(on or has_candidates)
        if not on and not has_candidates:
            self.enable_box.setToolTip("还没有任何可燃物模板：先在燃烧工作台里做一份（下面「打开燃烧工作台」）。")

    # ------------------------------------------------------------------ 编辑
    def _edit(self, key: str) -> None:
        if self._loading:
            return
        self._edited.add(key)
        if key == "template":
            tid = self.template_selector.current_id().strip()
            if tid:
                self._last_template = tid
        self.refresh_notes()
        self._refresh_title()
        self.changed.emit()

    def _clear_signal(self, moment: str) -> None:
        picker = self.signal_fields[moment]
        if not picker.current_signal():
            return
        picker._value = ""
        picker._refresh_line()
        self._edit(f"signals.{moment}")

    def _confirm_disable(self, text: str) -> bool:
        """关掉可燃之前的确认（测试里 monkeypatch 这一个方法，别让离屏模态框挂死）。"""
        ans = QMessageBox.question(self, "关掉可燃", text,
                                   QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
        return ans == QMessageBox.StandardButton.Yes

    def _on_enable_toggled(self, on: bool) -> None:
        if self._loading:
            return
        if not on:
            current = self._value_if_enabled()
            if host_has_extra_config(current):
                tid = current.get("template", "") if isinstance(current, dict) else ""
                if not self._confirm_disable(
                        f"关掉可燃会删掉整个 burnable 块（模板「{tid}」以及第一次出现 / 玩家点火 / 条件 / 信号这些配置）。\n"
                        "确定关掉吗？"):
                    self._loading = True
                    try:
                        self.enable_box.setChecked(True)
                    finally:
                        self._loading = False
                    return
        else:
            if not self.template_selector.current_id().strip():
                pick = self._auto_template()
                if not pick:
                    self._loading = True
                    try:
                        self.enable_box.setChecked(False)
                    finally:
                        self._loading = False
                    self.refresh_notes()
                    return
                self._loading = True
                try:
                    self.template_selector.set_current(pick)
                finally:
                    self._loading = False
                self._edited.add("template")
                self._last_template = pick
        self._sync_enabled()
        self._edit("enabled")

    def _auto_template(self) -> str:
        """勾上时还没选模板：先挑图与宿主现有展示图一致的那份，否则第一份。"""
        items = self._template_items()
        if not items:
            return ""
        hint = self._host_image_hint()
        if hint:
            for tid, _lab in items:
                doc = self._template_doc(tid)
                if isinstance(doc, dict) and str(doc.get("image") or "").strip() == hint:
                    return tid
        return items[0][0]

    #: 宿主现有的图（热点 / NPC 的 displayImage.image，挂件的 image）——宿主可覆写这个回调
    host_image_hint: Callable[[], str] | None = None

    def _host_image_hint(self) -> str:
        fn = self.host_image_hint
        try:
            return str(fn() or "").strip() if callable(fn) else ""
        except Exception:  # noqa: BLE001 — 只是挑缺省模板的提示
            return ""

    # ------------------------------------------------------------------ 取值
    def current_template(self) -> str:
        if self._built:
            return self.template_selector.current_id().strip()
        return str(self._raw.get("template") or "").strip() if isinstance(self._raw, dict) else ""

    def is_enabled(self) -> bool:
        if self._built:
            return self.enable_box.isChecked()
        return self._raw is not ABSENT

    def _value_if_enabled(self) -> Any:
        """按控件当前值算一份块（忽略开关）。"""
        if not self._built or not self._edited:
            return copy.deepcopy(self._raw)
        raw = self._raw
        base = copy.deepcopy(raw) if isinstance(raw, dict) else {}
        tid = self.template_selector.current_id().strip()
        if ("template" in self._edited or "enabled" in self._edited or not isinstance(raw, dict)) and tid:
            base["template"] = tid
        if "initial" in self._edited:
            data = self.initial_combo.currentData()
            if data == "burning":
                base["initial"] = "burning"
            elif data == "unburnt":
                base.pop("initial", None)
        if "playerIgnite" in self._edited and self.player_ignite_box is not None:
            if self.player_ignite_box.isChecked():
                base.pop("playerIgnite", None)
            else:
                base["playerIgnite"] = False
        if "igniteConditions" in self._edited and self.conditions is not None:
            conds = self.conditions.to_list()
            if conds:
                base["igniteConditions"] = conds
            else:
                base.pop("igniteConditions", None)
        sig_keys = [k for k in self._edited if k.startswith("signals.")]
        if sig_keys:
            sig = dict(base["signals"]) if isinstance(base.get("signals"), dict) else {}
            for k in sig_keys:
                moment = k.split(".", 1)[1]
                v = self.signal_fields[moment].current_signal().strip()
                if v:
                    sig[moment] = v
                else:
                    sig.pop(moment, None)
            if sig:
                base["signals"] = _ordered(sig, _bn.SIGNAL_KEYS)
            else:
                base.pop("signals", None)
        return _ordered(base, _bn.HOST_ORDER)

    def value(self) -> Any:
        """``ABSENT`` = 不写 ``burnable`` 键。没展开过 / 什么都没动 ⇒ 原样回吐载入值。"""
        if not self._built or not self._edited:
            return copy.deepcopy(self._raw)
        if not self.enable_box.isChecked():
            return ABSENT
        return self._value_if_enabled()

    def write_to(self, entity: dict) -> None:
        """把块写回宿主 dict（键已在 = 原位替换；新增 = 追加到末尾）。"""
        v = self.value()
        if v is ABSENT:
            entity.pop("burnable", None)
        else:
            entity["burnable"] = copy.deepcopy(v)

    # ------------------------------------------------------------------ 提示 / 标题
    def _template_doc(self, tid: str) -> dict | None:
        fn = getattr(self._model, "burnable_doc", None)
        doc = fn(tid) if callable(fn) and tid else None
        return doc if isinstance(doc, dict) else None

    def template_summary(self, tid: str) -> tuple[str, str]:
        """``(摘要, 错误)``：模板的关键参数一行；模板不存在 / 没尺寸时错误非空。"""
        if not tid:
            return "", "还没选模板"
        doc = self._template_doc(tid)
        if doc is None:
            errs = getattr(self._model, "burnables_errors", None) or {}
            if tid in errs:
                return "", f"模板「{tid}」读不懂（{errs[tid]}）——运行时装不上，这个实例不可燃也不画"
            return "", f"模板「{tid}」不在 assets/data/burnables/ 里——运行时装不上，这个实例不可燃也不画"
        name = str(doc.get("label") or "").strip()
        mode = "消耗燃烧（蜡烛 / 香）" if doc.get("mode") == "consume" else "面燃烧（纸 / 布）"
        size = _bn.template_world_size(doc)
        pts = _bn.ignition_point_ids(doc)
        pts_text = f"着火点 {len(pts)} 个（{'、'.join(pts)}）" if pts else "没标着火点（整体点着）"
        head = f"{name + ' · ' if name else ''}{mode}"
        if size is None:
            return head + " · " + pts_text, f"模板「{tid}」没写真实尺寸（widthCm / heightCm）——运行时装不上"
        dims = f"{doc['widthCm']:g}×{doc['heightCm']:g} cm（{size[0]:.1f}×{size[1]:.1f} wu）"
        grip = ""
        if self._host_kind == "prop":
            gu, gv = _bn.template_grip(doc)
            grip = f" · 握点 u {gu:g} v {gv:g}" + ("（缺省底边中点）" if "grip" not in doc else "")
        return f"{head} · {dims} · {pts_text}{grip}", ""

    def takeover_text(self, tid: str, doc: dict | None) -> str:
        size = _bn.template_world_size(doc) if doc is not None else None
        dims = f"模板真实尺寸 {doc['widthCm']:g}×{doc['heightCm']:g} cm" if size else "模板真实尺寸"
        if self._host_kind == "hotspot":
            return (f"开了可燃：这个热点自己的展示图（displayImage 的图与宽高）不画了——画的是模板的图，按{dims}"
                    "× 热点缩放 / 旋转 / 朝向；展示图的朝向与前后排序（facing / spriteSort）照用。")
        if self._host_kind == "npc":
            return (f"开了可燃：这个 NPC 自己的动画与展示图一律不画、不再播动画（走路也不播）——画的是模板的图，按{dims}"
                    "× NPC 缩放 / 旋转 / 朝向。")
        width = f"模板真实宽 {doc['widthCm']:g} cm" if size else "模板真实宽"
        return (f"开了可燃：这个挂件自己的贴图与支点（image / images / anchorX / anchorY）被模板接管——画的是模板的图，"
                f"挂点对准模板握点、等比缩放到{width}（× 这里的缩放）；"
                "火把那一套（灯 / 粒子挂载 / 帧动画火苗 / 起火点 / 玩家操作 / 吹熄 / 点火能力 / 燃料 / 效果块 / 等级 / 状态表）与可燃互斥。")

    def refresh_notes(self) -> None:
        """重算摘要 / 接管说明 / 宿主冲突提示（模板重读、宿主改了展示图时宿主调）。"""
        self._refresh_title()
        if not self._built:
            return
        on = self.enable_box.isChecked()
        tid = self.template_selector.current_id().strip()
        summary, err = self.template_summary(tid) if on or tid else ("", "")
        self.summary_label.setText(summary)
        warns: list[str] = []
        if not isinstance(self._raw, dict) and self._raw is not ABSENT and not self._edited:
            warns.append(f"⚠ 磁盘上的 burnable 形状不对（{self._raw!r}）：运行时当不可燃；改任意一项会整块重写")
        if on:
            if err:
                warns.append("⚠ " + err)
            doc = self._template_doc(tid)
            self.takeover_label.setText(self.takeover_text(tid, doc))
            self.takeover_label.setVisible(True)
            if self._note_provider is not None:
                try:
                    warns.extend("⚠ " + s for s in self._note_provider(tid, doc) if s)
                except Exception as exc:  # noqa: BLE001 — 提示失败不许拖垮面板
                    warns.append(f"⚠ 冲突检查失败：{exc}")
        else:
            self.takeover_label.setText("")
            self.takeover_label.setVisible(False)
            if not self._template_items():
                warns.append("还没有任何可燃物模板：先在燃烧工作台里做一份。")
        self.warn_label.setText("\n".join(warns))
        self.warn_label.setVisible(bool(warns))

    def _refresh_title(self) -> None:
        v = self.value()
        if v is ABSENT:
            self._section.set_title("可燃（没开）")
            return
        if not isinstance(v, dict):
            self._section.set_title("可燃：（形状坏了）")
            return
        tid = str(v.get("template") or "").strip()
        bits = []
        if v.get("initial") == "burning":
            bits.append("一出现就在烧")
        if self._entity_host and v.get("playerIgnite") is False:
            bits.append("玩家不能点")
        missing = self._template_doc(tid) is None
        self._section.set_title(
            f"可燃：{tid or '（没选模板）'}" + ("（模板不存在）" if missing and tid else "")
            + (f" · {' · '.join(bits)}" if bits else ""))

    # ------------------------------------------------------------------ 宿主钩子
    def reload_refs_from_model(self) -> None:
        """模板重读 / 切页：重拉模板候选（当前值保值）、重算提示。不改数据、不发 changed。"""
        if self._built:
            was = self._loading
            self._loading = True
            try:
                cur = self.template_selector.current_id()
                self.template_selector.set_items(self._template_items())
                self.template_selector.set_current(cur)
                self._sync_enabled()
            finally:
                self._loading = was
        self.refresh_notes()
