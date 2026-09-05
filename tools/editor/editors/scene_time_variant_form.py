"""时段外观表单：`timeVariants[<时段>]` 里**每一项**都能在面板上改，不再靠快照与手写 JSON。

## 模型

运行时（`src/utils/sceneAppearance.ts`）把「场景此刻长什么样」算成
`顶层白天基底 ⊕ timeVariants[当前时段]`，变体**只写差异**：

- `backgrounds`：该时段换哪张原画（不写 = 沿用白天）；
- `lighting`：环境块**整块**覆盖（sky / fog / display / emissive / dehaze / giGain / aoStrength），
  运行时按顶层键整块替换、不深合并；**永远不含 lights**——灯是实体，按各自 `phases` 过滤；
- `depthConfig`：该时段另一套深度/碰撞，只在「夜是完全另一张图」时用；
- `ambientSounds` / `bgm` / `filterId`：写了就整个替换（`[]` / `""` 也是"写了"= 该时段没有）。

所以每一项都是**三态**：沿用白天（键不存在）／覆盖成某值／覆盖成空。表单上每项一个
「覆盖」勾：不勾 = 键不存在；勾上那一刻预填白天基底（没有基底就用缺省块），再改。

## 契约

- 表单**就地改**传进来的变体 dict（它是面板的工作副本，深拷自 staging），改完发 `changed`；
  落库仍走面板的 pending/Apply，这里不碰模型、不写盘。
- 只改自己认识的键：块内多出来的键（`sky.color`、手写的 `lightEnv`…）原样保留
  ——编辑器铁律 1：不许丢表单未显示的键。
- 数值按原始表示回写：没改的整数不漂成 float。
- 程序性装载不发 `changed`（载入即脏是红线）。
"""
from __future__ import annotations

import copy
from typing import Callable

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDialog, QDoubleSpinBox, QFormLayout, QHBoxLayout, QLabel,
    QListWidget, QListWidgetItem, QMessageBox, QPushButton, QVBoxLayout, QWidget,
)

from tools.editor.project_model import ProjectModel
from tools.editor.shared.audio_preview_selector import AudioIdPreviewSelector
from tools.editor.shared.collapsible_section import CollapsibleSection
from tools.editor.shared.form_layout import compact_form
from tools.editor.shared.id_ref_selector import IdRefSelector
from . import scene_lights

__all__ = ["TimeVariantForm", "BLOCK_FIELDS", "SCALAR_BLOCKS", "variant_summary"]

#: 结构块里可编辑的字段：(键, 标签, 最小, 最大, 小数位, 步长) 或 (键, 标签, 枚举)。
#: 范围只是控件护栏，不是数据契约（数据契约在 src/data/types.ts）。
BLOCK_FIELDS: dict[str, tuple] = {
    "sky": (
        ("kelvin", "色温 K", 1000.0, 20000.0, 0, 100.0),
        ("intensity", "强度", 0.0, 10.0, 3, 0.01),
        ("hemi", "半球权重 0..1", 0.0, 1.0, 2, 0.05),
    ),
    "fog": (
        ("sigma", "消光 σ (1/wu)", 0.0, 1.0, 4, 0.0005),
        ("scaleHeight", "高度衰减 (wu)", 0.0, 100000.0, 1, 10.0),
        ("baseHeight", "基准高度 (wu)", -100000.0, 100000.0, 1, 10.0),
        ("kelvin", "色温 K", 1000.0, 20000.0, 0, 100.0),
        ("scatter", "散射强度", 0.0, 10.0, 3, 0.01),
    ),
    "display": (
        ("ev", "曝光 EV", -10.0, 10.0, 2, 0.1),
        ("tonemap", "tonemap", ("none", "reinhard", "filmic")),
        ("whiteKelvin", "白点 K", 1000.0, 20000.0, 0, 100.0),
        ("contrast", "对比度", 0.0, 4.0, 2, 0.05),
        ("saturation", "饱和度", 0.0, 4.0, 2, 0.05),
        ("lift", "提亮 lift", -1.0, 1.0, 3, 0.01),
        ("liftKelvin", "lift 色温 K", 1000.0, 20000.0, 0, 100.0),
    ),
    "emissive": (
        ("gain", "增益（0 = 灯不可见）", 0.0, 50.0, 2, 0.1),
        ("coreRadius", "灯体半径 (wu)", 0.0, 10000.0, 1, 1.0),
        ("haloRadius", "光晕半径 (wu)", 0.0, 10000.0, 1, 1.0),
        ("haloGain", "光晕强度", 0.0, 10.0, 3, 0.01),
    ),
}

#: 单个数值就是一整块的那些：(标签, 最小, 最大, 小数位, 步长)。
SCALAR_BLOCKS: dict[str, tuple] = {
    "dehaze": ("去霾（已停用，留作回退）", 0.0, 2.0, 2, 0.05),
    "giGain": ("GI 反弹增益", 0.0, 10.0, 2, 0.05),
    "aoStrength": ("AO 强度 0..1", 0.0, 1.0, 2, 0.05),
}

_BLOCK_LABELS = dict(scene_lights.TV_ENV_BLOCKS)


def _keep_num(new: float, original) -> float | int:
    """没改的整数不漂成 float：数值相等就回写原始表示。"""
    if isinstance(original, bool):
        return new
    if isinstance(original, (int, float)) and float(original) == float(new):
        return original
    return float(new)


def variant_summary(variant: dict | None) -> str:
    """表格第三列：这个时段覆盖了哪些东西（给人扫一眼用）。"""
    v = variant or {}
    parts: list[str] = []
    lit = v.get("lighting") or {}
    if isinstance(lit, dict) and lit:
        parts.append("环境：" + "、".join(sorted(lit)))
    if "depthConfig" in v:
        parts.append("深度/碰撞")
    if "ambientSounds" in v:
        amb = v.get("ambientSounds") or []
        parts.append(f"环境音×{len(amb)}" if amb else "环境音：静音")
    if "bgm" in v:
        parts.append(f"BGM={v['bgm']}" if v.get("bgm") else "BGM：无")
    if "filterId" in v:
        parts.append(f"滤镜={v['filterId']}" if v.get("filterId") else "滤镜：无")
    other = sorted(k for k in v if k not in ("backgrounds", "lighting", "depthConfig",
                                              "ambientSounds", "bgm", "filterId"))
    if other:
        parts.append("另有 " + "/".join(other))
    return "；".join(parts) if parts else "—"


class TimeVariantForm(QWidget):
    """编辑一个时段的变体。`load()` 装载、就地改、发 `changed`。"""

    changed = Signal()

    def __init__(
        self,
        model: ProjectModel,
        *,
        base_provider: Callable[[], dict],
        bg_candidates: Callable[[], list[str]],
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._model = model
        self._base_provider = base_provider
        self._bg_candidates = bg_candidates
        self._pid = ""
        self._v: dict | None = None
        self._loading = False

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 4, 0, 0)
        outer.setSpacing(4)
        self._title = QLabel("（在上表选一个时段）")
        self._title.setStyleSheet("font-weight:bold;")
        outer.addWidget(self._title)

        # ---- 背景 ----
        bg_row = compact_form(QFormLayout())
        self._bg = QComboBox()
        self._bg.setToolTip(
            "该时段换成哪张背景原画（候选 = 本场景运行时目录里的图）。\n"
            "「沿用白天」= 不写 backgrounds 键。各时段背景必须同尺寸，校验器有闸。")
        self._bg.currentIndexChanged.connect(self._on_bg_changed)
        bg_row.addRow("背景原画", self._bg)
        outer.addLayout(bg_row)

        # ---- 环境覆盖 ----
        env = CollapsibleSection("环境覆盖（整块替换白天那份；灯不在这里）", start_open=True)
        env_inner = QWidget()
        env_lay = QVBoxLayout(env_inner)
        env_lay.setContentsMargins(0, 0, 0, 0)
        env_hint = QLabel(
            "勾上 = 这一块整块用下面的值（勾上那一刻从白天基底预填）；不勾 = 沿用白天。\n"
            "运行时按块整块替换、不逐字段合并，所以一块里的值要成套调。灯按各自「时段归属」过滤。")
        env_hint.setWordWrap(True)
        env_hint.setStyleSheet("color:#888;")
        env_lay.addWidget(env_hint)
        self._block_cb: dict[str, QCheckBox] = {}
        self._block_body: dict[str, QWidget] = {}
        self._fields: dict[tuple[str, str], QWidget] = {}
        for key, spec in BLOCK_FIELDS.items():
            cb = QCheckBox(f"覆盖 {_BLOCK_LABELS.get(key, key)}　[{key}]")
            cb.toggled.connect(lambda on, k=key: self._on_block_toggled(k, on))
            self._block_cb[key] = cb
            env_lay.addWidget(cb)
            body = QWidget()
            form = compact_form(QFormLayout(body))
            form.setContentsMargins(18, 0, 0, 4)
            for field in spec:
                name, label = field[0], field[1]
                if isinstance(field[2], tuple):
                    w: QWidget = QComboBox()
                    for choice in field[2]:
                        w.addItem(choice, choice)
                    w.currentIndexChanged.connect(
                        lambda _i, k=key, f=name, cw=w: self._on_field(k, f, cw.currentData()))
                else:
                    w = self._spin(field[2], field[3], field[4], field[5])
                    w.valueChanged.connect(
                        lambda val, k=key, f=name: self._on_field(k, f, val))
                self._fields[(key, name)] = w
                form.addRow(label, w)
            body.setEnabled(False)
            self._block_body[key] = body
            env_lay.addWidget(body)
        for key, (label, lo, hi, dec, step) in SCALAR_BLOCKS.items():
            row = QWidget()
            hl = QHBoxLayout(row)
            hl.setContentsMargins(0, 0, 0, 0)
            cb = QCheckBox(f"覆盖 {label}　[{key}]")
            cb.toggled.connect(lambda on, k=key: self._on_block_toggled(k, on))
            self._block_cb[key] = cb
            sp = self._spin(lo, hi, dec, step)
            sp.setEnabled(False)
            sp.valueChanged.connect(lambda val, k=key: self._on_field(k, "", val))
            self._fields[(key, "")] = sp
            self._block_body[key] = sp
            hl.addWidget(cb)
            hl.addWidget(sp)
            hl.addStretch(1)
            env_lay.addWidget(row)
        env.add_body(env_inner)
        outer.addWidget(env)

        # ---- 深度 / 碰撞 ----
        depth = CollapsibleSection("深度与碰撞（仅当该时段是完全另一张图）", start_open=False)
        depth_inner = QWidget()
        dl = QVBoxLayout(depth_inner)
        dl.setContentsMargins(0, 0, 0, 0)
        self._depth_cb = QCheckBox("覆盖 depthConfig（该时段另一套深度图 / 碰撞图）")
        self._depth_cb.setToolTip(
            "各时段的背景本应共享几何：relight 出来的夜景（同一张照片换色）**不要**写它，\n"
            "写了反而引入白天能走、夜里卡墙的不一致。只有夜是完全另一张图、连碰撞一起换时才勾。\n"
            "勾上那一刻整份复制白天的 depthConfig（M / 映射 / shader 参数都在里面），再改图名与微调。")
        self._depth_cb.toggled.connect(self._on_depth_toggled)
        dl.addWidget(self._depth_cb)
        self._depth_body = QWidget()
        df = compact_form(QFormLayout(self._depth_body))
        df.setContentsMargins(18, 0, 0, 4)
        self._depth_map = IdRefSelector(allow_empty=False, editable=True)
        self._depth_map.setToolTip("depth_map：该时段的深度图文件名（本场景运行时目录）")
        self._depth_map.value_changed.connect(lambda v: self._on_depth_field("depth_map", v))
        df.addRow("depth_map", self._depth_map)
        self._collision_map = IdRefSelector(allow_empty=False, editable=True)
        self._collision_map.setToolTip("collision_map：该时段的碰撞图文件名（本场景运行时目录）")
        self._collision_map.value_changed.connect(
            lambda v: self._on_depth_field("collision_map", v))
        df.addRow("collision_map", self._collision_map)
        self._depth_tol = self._spin(-50.0, 50.0, 4, 0.05)
        self._depth_tol.valueChanged.connect(lambda v: self._on_depth_field("depth_tolerance", v))
        df.addRow("depth_tolerance", self._depth_tol)
        self._floor_offset = self._spin(-50.0, 50.0, 4, 0.05)
        self._floor_offset.valueChanged.connect(lambda v: self._on_depth_field("floor_offset", v))
        df.addRow("floor_offset", self._floor_offset)
        self._depth_body.setEnabled(False)
        dl.addWidget(self._depth_body)
        depth.add_body(depth_inner)
        outer.addWidget(depth)

        # ---- 声音与滤镜 ----
        snd = CollapsibleSection("声音与滤镜", start_open=True)
        snd_inner = QWidget()
        sl = QVBoxLayout(snd_inner)
        sl.setContentsMargins(0, 0, 0, 0)
        self._amb_cb = QCheckBox("覆盖环境音（勾上且列表为空 = 该时段静音）")
        self._amb_cb.toggled.connect(self._on_amb_toggled)
        sl.addWidget(self._amb_cb)
        self._amb_body = QWidget()
        al = QHBoxLayout(self._amb_body)
        al.setContentsMargins(18, 0, 0, 4)
        self._amb_list = QListWidget()
        self._amb_list.setMaximumHeight(90)
        self._amb_list.currentRowChanged.connect(lambda _r: self._sync_amb_buttons())
        al.addWidget(self._amb_list, 1)
        btns = QVBoxLayout()
        self._amb_add = QPushButton("+")
        self._amb_add.setToolTip("添加环境音（可搜索、可试听）")
        self._amb_add.clicked.connect(self._add_ambient)
        self._amb_del = QPushButton("−")
        self._amb_del.clicked.connect(self._remove_ambient)
        self._amb_up = QPushButton("↑")
        self._amb_up.clicked.connect(lambda: self._move_ambient(-1))
        self._amb_down = QPushButton("↓")
        self._amb_down.clicked.connect(lambda: self._move_ambient(1))
        for b in (self._amb_add, self._amb_del, self._amb_up, self._amb_down):
            b.setMaximumWidth(32)
            btns.addWidget(b)
        btns.addStretch(1)
        al.addLayout(btns)
        self._amb_body.setEnabled(False)
        sl.addWidget(self._amb_body)

        misc = compact_form(QFormLayout())
        self._bgm_cb = QCheckBox("覆盖 BGM（勾上留空 = 该时段无 BGM）")
        self._bgm_cb.toggled.connect(self._on_bgm_toggled)
        self._bgm = AudioIdPreviewSelector(self._model, "bgm", allow_empty=True, editable=True)
        self._bgm.setMinimumWidth(160)
        self._bgm.setEnabled(False)
        self._bgm.value_changed.connect(lambda v: self._on_scalar_key("bgm", v))
        misc.addRow(self._bgm_cb, self._bgm)
        self._filter_cb = QCheckBox("覆盖滤镜（勾上留空 = 该时段无滤镜）")
        self._filter_cb.toggled.connect(self._on_filter_toggled)
        self._filter = IdRefSelector(allow_empty=True, editable=True)
        self._filter.setEnabled(False)
        self._filter.value_changed.connect(lambda v: self._on_scalar_key("filterId", v))
        misc.addRow(self._filter_cb, self._filter)
        sl.addLayout(misc)
        snd.add_body(snd_inner)
        outer.addWidget(snd)

        self.reload_refs()
        self.load("", None)

    # ---- 装载 ---------------------------------------------------------------

    @staticmethod
    def _spin(lo: float, hi: float, dec: int, step: float) -> QDoubleSpinBox:
        s = QDoubleSpinBox()
        s.setRange(lo, hi)
        s.setDecimals(dec)
        s.setSingleStep(step)
        s.setMaximumWidth(120)
        return s

    @property
    def phase_id(self) -> str:
        return self._pid

    def reload_refs(self) -> None:
        """别处新建了 BGM / 滤镜之后重拉候选，保住当前值。"""
        self._bgm.set_items([(a, a) for a in self._model.all_audio_ids("bgm")])
        self._filter.set_items(self._model.all_filter_ids())

    def load(self, phase_id: str, variant: dict | None) -> None:
        """装载一个时段的变体（就地编辑这个 dict）；`variant=None` = 没选中，表单禁用。"""
        self._loading = True
        try:
            self._pid = str(phase_id or "")
            self._v = variant if isinstance(variant, dict) else None
            on = self._v is not None
            self.setEnabled(on)
            self._title.setText(f"时段「{self._pid}」的外观" if on else "（在上表选一个时段）")
            v = self._v or {}
            self._fill_bg(v)
            lit = v.get("lighting") if isinstance(v.get("lighting"), dict) else {}
            for key in list(BLOCK_FIELDS) + list(SCALAR_BLOCKS):
                has = key in lit
                self._block_cb[key].setChecked(has)
                self._block_body[key].setEnabled(has)
                self._fill_block(key, lit.get(key) if has else None)
            dc = v.get("depthConfig") if isinstance(v.get("depthConfig"), dict) else None
            self._depth_cb.setChecked(dc is not None)
            self._depth_body.setEnabled(dc is not None)
            self._fill_depth(dc or {})
            amb = v.get("ambientSounds")
            self._amb_cb.setChecked(isinstance(amb, list))
            self._amb_body.setEnabled(isinstance(amb, list))
            self._amb_list.clear()
            for aid in (amb if isinstance(amb, list) else []):
                self._amb_list.addItem(self._amb_item(str(aid)))
            self._sync_amb_buttons()
            self._bgm_cb.setChecked("bgm" in v)
            self._bgm.setEnabled("bgm" in v)
            self._bgm.set_current(str(v.get("bgm") or ""))
            self._filter_cb.setChecked("filterId" in v)
            self._filter.setEnabled("filterId" in v)
            self._filter.set_current(str(v.get("filterId") or ""))
        finally:
            self._loading = False

    def _fill_bg(self, v: dict) -> None:
        self._bg.blockSignals(True)
        try:
            self._bg.clear()
            self._bg.addItem("（沿用白天那张）", "")
            cur = ""
            bgs = v.get("backgrounds")
            if isinstance(bgs, list) and bgs and isinstance(bgs[0], dict):
                cur = str(bgs[0].get("image") or "")
            names = list(self._bg_candidates()) if self._v is not None else []
            if cur and cur not in names:
                names.append(cur)            # 图没落盘也要保值展示，不许静默清空
            for name in names:
                tag = "（白天那张）" if name == "background.png" else ""
                if name == cur and name not in self._bg_candidates():
                    tag = "（缺失）"
                self._bg.addItem(name + tag, name)
            idx = self._bg.findData(cur)
            self._bg.setCurrentIndex(idx if idx >= 0 else 0)
        finally:
            self._bg.blockSignals(False)

    def _fill_block(self, key: str, block) -> None:
        if key in SCALAR_BLOCKS:
            sp = self._fields[(key, "")]
            sp.blockSignals(True)
            sp.setValue(float(block) if isinstance(block, (int, float)) and not isinstance(block, bool) else 0.0)
            sp.blockSignals(False)
            return
        block = block if isinstance(block, dict) else {}
        # 半块（手写的、只有 sigma 没有 scaleHeight 那种）：运行时是**整块替换**，缺的字段
        # 在夜里就没有值。控件上用白天基底的值兜底显示，并在 tooltip 里说明；
        # 用户一改这一块里的任何字段，就把显示中的值整块写全（见 `_on_field`）。
        # 没装载变体（构造期 / 换场景清空）时不去问基底：那时面板自己都还没建完。
        fallback = self._base_lighting().get(key) if self._v is not None else None
        fallback = fallback if isinstance(fallback, dict) else {}
        for field in BLOCK_FIELDS[key]:
            name = field[0]
            w = self._fields[(key, name)]
            missing = name not in block
            val = block.get(name, fallback.get(name))
            w.blockSignals(True)
            try:
                if isinstance(w, QComboBox):
                    idx = w.findData(str(val if val is not None else ""))
                    if idx < 0 and val is not None:
                        w.addItem(str(val), str(val))   # 未知枚举值保值
                        idx = w.count() - 1
                    w.setCurrentIndex(max(idx, 0))
                else:
                    w.setValue(float(val) if isinstance(val, (int, float)) and not isinstance(val, bool) else 0.0)
                w.setToolTip(
                    "这一块里没写这个字段（显示的是白天的值）。运行时整块替换，夜里它就没有值；"
                    "改这一块的任一字段时会把它一起写全。" if missing else "")
            finally:
                w.blockSignals(False)

    def _fill_depth(self, dc: dict) -> None:
        names = [n for n in self._runtime_files() if n.lower().endswith(".png")] if self._v is not None else []
        for sel, key in ((self._depth_map, "depth_map"), (self._collision_map, "collision_map")):
            sel.set_items([(n, n) for n in names])
            sel.set_current(str(dc.get(key) or ""))
        for sp, key in ((self._depth_tol, "depth_tolerance"), (self._floor_offset, "floor_offset")):
            sp.blockSignals(True)
            val = dc.get(key)
            sp.setValue(float(val) if isinstance(val, (int, float)) and not isinstance(val, bool) else 0.0)
            sp.blockSignals(False)

    def _runtime_files(self) -> list[str]:
        """本场景运行时目录里的全部文件名（深度/碰撞图候选）。候选提供者只列背景，这里另扫。"""
        provider = getattr(self, "_runtime_files_provider", None)
        if callable(provider):
            return list(provider())
        return list(self._bg_candidates())

    def set_runtime_files_provider(self, fn: Callable[[], list[str]]) -> None:
        self._runtime_files_provider = fn

    # ---- 编辑：背景 --------------------------------------------------------

    def _on_bg_changed(self, _i: int) -> None:
        if self._loading or self._v is None:
            return
        img = str(self._bg.currentData() or "")
        if not img:
            self._v.pop("backgrounds", None)
        else:
            bgs = self._v.get("backgrounds")
            if isinstance(bgs, list) and bgs and isinstance(bgs[0], dict):
                bgs[0]["image"] = img            # 只换图名，其余层 / x / y 原样
            else:
                self._v["backgrounds"] = [{"image": img, "x": 0, "y": 0}]
        self.changed.emit()

    # ---- 编辑：环境块 ------------------------------------------------------

    def _base_lighting(self) -> dict:
        base = (self._base_provider() or {}).get("lighting")
        return base if isinstance(base, dict) else {}

    def _on_block_toggled(self, key: str, on: bool) -> None:
        if self._loading or self._v is None:
            return
        lit = self._v.get("lighting")
        if not isinstance(lit, dict):
            lit = {}
        if on:
            if key not in lit:
                base = self._base_lighting()
                src = base.get(key, scene_lights.default_lighting_block().get(key))
                lit[key] = copy.deepcopy(src) if isinstance(src, (dict, list)) else src
            self._v["lighting"] = lit
            self._fill_block(key, lit[key])
        else:
            lit.pop(key, None)
            if lit:
                self._v["lighting"] = lit
            else:
                self._v.pop("lighting", None)
        self._block_body[key].setEnabled(on)
        self.changed.emit()

    def _on_field(self, key: str, field: str, value) -> None:
        if self._loading or self._v is None:
            return
        lit = self._v.get("lighting")
        if not isinstance(lit, dict) or key not in lit:
            return
        if key in SCALAR_BLOCKS:
            lit[key] = _keep_num(value, lit.get(key))
        else:
            block = lit[key]
            if not isinstance(block, dict):
                block = {}
                lit[key] = block
            # 半块补全：块里缺的字段按控件当前显示（= 白天基底）一起写进去，
            # 免得改了 sigma 之后夜里的雾没有 scaleHeight。
            for spec in BLOCK_FIELDS[key]:
                name = spec[0]
                if name in block:
                    continue
                w = self._fields[(key, name)]
                block[name] = w.currentData() if isinstance(w, QComboBox) else float(w.value())
                w.setToolTip("")
            if isinstance(value, str):
                block[field] = value
            else:
                block[field] = _keep_num(value, block.get(field))
        self.changed.emit()

    # ---- 编辑：深度 --------------------------------------------------------

    def _on_depth_toggled(self, on: bool) -> None:
        if self._loading or self._v is None:
            return
        if on:
            if not isinstance(self._v.get("depthConfig"), dict):
                base = (self._base_provider() or {}).get("depthConfig")
                if not isinstance(base, dict):
                    QMessageBox.information(
                        self, "白天还没有 depthConfig",
                        "先用「角色照明实验室」给白天那张图导出深度/碰撞，再给这个时段另配一套。")
                    self._depth_cb.blockSignals(True)
                    self._depth_cb.setChecked(False)
                    self._depth_cb.blockSignals(False)
                    return
                self._v["depthConfig"] = copy.deepcopy(base)
            self._fill_depth(self._v["depthConfig"])
        else:
            self._v.pop("depthConfig", None)
        self._depth_body.setEnabled(on)
        self.changed.emit()

    def _on_depth_field(self, key: str, value) -> None:
        if self._loading or self._v is None:
            return
        dc = self._v.get("depthConfig")
        if not isinstance(dc, dict):
            return
        if isinstance(value, str):
            value = value.strip()
            if not value:
                return                       # 图名不能为空：留着原值
            dc[key] = value
        else:
            dc[key] = _keep_num(value, dc.get(key))
        self.changed.emit()

    # ---- 编辑：环境音 / BGM / 滤镜 ------------------------------------------

    @staticmethod
    def _amb_item(aid: str) -> QListWidgetItem:
        it = QListWidgetItem(aid)
        it.setData(0x0100, aid)              # Qt.ItemDataRole.UserRole
        return it

    def _amb_ids(self) -> list[str]:
        out: list[str] = []
        for i in range(self._amb_list.count()):
            it = self._amb_list.item(i)
            aid = str(it.data(0x0100) or "").strip() if it else ""
            if aid and aid not in out:
                out.append(aid)
        return out

    def _sync_amb_buttons(self) -> None:
        row = self._amb_list.currentRow()
        self._amb_del.setEnabled(row >= 0)
        self._amb_up.setEnabled(row > 0)
        self._amb_down.setEnabled(0 <= row < self._amb_list.count() - 1)

    def _write_amb(self) -> None:
        if self._v is None:
            return
        self._v["ambientSounds"] = self._amb_ids()
        self.changed.emit()

    def _on_amb_toggled(self, on: bool) -> None:
        if self._loading or self._v is None:
            return
        if on:
            if not isinstance(self._v.get("ambientSounds"), list):
                base = (self._base_provider() or {}).get("ambientSounds")
                self._v["ambientSounds"] = [str(a) for a in base] if isinstance(base, list) else []
            self._amb_list.clear()
            for aid in self._v["ambientSounds"]:
                self._amb_list.addItem(self._amb_item(str(aid)))
        else:
            self._v.pop("ambientSounds", None)
            self._amb_list.clear()
        self._amb_body.setEnabled(on)
        self._sync_amb_buttons()
        self.changed.emit()

    def _add_ambient(self) -> None:
        from tools.editor.shared.audio_picker_dialog import AudioPickerDialog
        used = set(self._amb_ids())
        rows = [(a, a) for a in self._model.all_audio_ids("ambient") if a not in used]
        dlg = AudioPickerDialog(self._model, "ambient", rows, current="", allow_empty=False,
                                parent=self, title="添加该时段的环境音（可搜索、可试听）",
                                allow_manual_id=True)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        aid = (dlg.selected_value() or "").strip()
        if not aid or aid in used:
            return
        self._amb_list.addItem(self._amb_item(aid))
        self._amb_list.setCurrentRow(self._amb_list.count() - 1)
        self._write_amb()

    def _remove_ambient(self) -> None:
        row = self._amb_list.currentRow()
        if row < 0:
            return
        self._amb_list.takeItem(row)
        self._sync_amb_buttons()
        self._write_amb()

    def _move_ambient(self, delta: int) -> None:
        row = self._amb_list.currentRow()
        new = row + delta
        if row < 0 or new < 0 or new >= self._amb_list.count():
            return
        it = self._amb_list.takeItem(row)
        self._amb_list.insertItem(new, it)
        self._amb_list.setCurrentRow(new)
        self._write_amb()

    def _on_bgm_toggled(self, on: bool) -> None:
        self._toggle_scalar_key("bgm", on, self._bgm)

    def _on_filter_toggled(self, on: bool) -> None:
        self._toggle_scalar_key("filterId", on, self._filter)

    def _toggle_scalar_key(self, key: str, on: bool, widget) -> None:
        if self._loading or self._v is None:
            return
        if on:
            if key not in self._v:
                base = (self._base_provider() or {}).get(key)
                self._v[key] = str(base or "")
            widget.set_current(str(self._v.get(key) or ""))
        else:
            self._v.pop(key, None)
        widget.setEnabled(on)
        self.changed.emit()

    def _on_scalar_key(self, key: str, value: str) -> None:
        if self._loading or self._v is None or key not in self._v:
            return
        self._v[key] = str(value or "").strip()
        self.changed.emit()
