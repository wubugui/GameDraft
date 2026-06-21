"""编辑 public/assets/data/water_minigames：实例 + 实体；引用字段用选择器（与主工程其它编辑器一致）。"""
from __future__ import annotations

import re
from typing import Any

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QAbstractSpinBox,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSplitter,
    QSpinBox,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
    QInputDialog,
    QColorDialog,
)

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.action_editor import ActionEditor
from ..shared.form_layout import compact_form
from ..shared.hex_color_pick_row import HexColorPickRow
from ..shared.id_ref_selector import IdRefSelector
from ..shared.image_path_picker import CutsceneImagePathRow
from ..shared.pick_strings_dialog import pick_string_tag_marker

from .water_minigame_canvas import WaterMinigameSceneCanvas, _depth_offset_y


_SPOT_KEY_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_\-]{0,63}$")

_CATEGORY_ORDER = ["grass", "floating", "swimming", "sunken"]
_TIME_OPTS = ["morning", "day", "night"]
_WEATHER_OPTS = ["clear", "rain", "fog"]
_PULL_RHYTHM = ["stable", "burst", "spasm", "heavy_sink"]
_FAILURE = ["escape", "snap", "bite"]
_VALUE_TIER = ["normal", "premium"]
_MOTION_PATH = ["stationary", "drift", "patrol", "approach", "flee"]
_LOCATION_PRESETS = ["dock", "wild", "grave", "dev"]


def _deep_merge_locations(model: ProjectModel) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for x in _LOCATION_PRESETS:
        seen.add(x)
        out.append(x)
    bag = getattr(model, "water_minigames_instances", {}) or {}
    for doc in bag.values():
        if not isinstance(doc, dict):
            continue
        surf = doc.get("surface")
        if isinstance(surf, dict):
            loc = str(surf.get("location") or "").strip()
            if loc and loc not in seen:
                seen.add(loc)
                out.append(loc)
    return sorted(out, key=lambda s: s.casefold())


def _collect_spot_id_items(model: ProjectModel, extras: set[str]) -> list[tuple[str, str]]:
    seen: dict[str, str] = {}
    bag = getattr(model, "water_minigames_instances", {}) or {}
    for doc in bag.values():
        if not isinstance(doc, dict):
            continue
        sp = str(doc.get("spotId") or "").strip()
        if sp:
            seen.setdefault(sp, sp)
    for x in extras:
        xs = str(x).strip()
        if xs:
            seen.setdefault(xs, xs)
    return [(k, k) for k in sorted(seen.keys(), key=str.casefold)]


def _looks_like_string_tag(s: str) -> bool:
    t = (s or "").strip()
    return t.startswith("[tag:string:") and t.endswith("]")


def _combo_set_text(cb: QComboBox, text: str) -> None:
    t = (text or "").strip()
    idx = cb.findText(t)
    if idx >= 0:
        cb.setCurrentIndex(idx)
        return
    cb.addItem(t)
    cb.setCurrentIndex(cb.count() - 1)


class WaterMinigameEditor(QWidget):
    """就地修改 model.water_minigames_*；保存工程时写入 index + 各 file。"""

    preview_requested = Signal(str)

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._loading = False
        self._current_inst_id: str | None = None
        self._doc: dict | None = None
        self._cur_ent: dict | None = None
        # ActionEditor 当前归属的实体（按身份记，而非行号）：懒回写只写它，
        # 删除/重排后行号漂移也不会把动作串台进别的实体。
        self._ae_owner: dict | None = None
        self._extra_spot_ids: set[str] = set()
        self._prev_ent_row: int = -1
        self._selected_ent_row: int = -1

        root = QHBoxLayout(self)
        root.setContentsMargins(4, 4, 4, 4)

        split = QSplitter(Qt.Orientation.Horizontal)
        split.setChildrenCollapsible(False)

        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        self._inst_list_w = QListWidget()
        self._inst_list_w.setMinimumWidth(180)  # 三栏预算：实例列表下限收窄
        ll.addWidget(QLabel("水域实例"))
        ll.addWidget(self._inst_list_w, stretch=1)
        btn_row = QHBoxLayout()
        self._btn_add_inst = QPushButton("新增")
        self._btn_add_inst.setToolTip("新增一个水域实例（id 将作为文件名）")
        self._btn_del_inst = QPushButton("删除")
        self._btn_del_inst.setToolTip("删除当前选中的水域实例")
        self._btn_preview = QPushButton("预览…")
        self._btn_preview.setToolTip("保存后以开发模式启动游戏并直接进入当前实例（URL waterPreview）")
        btn_row.addWidget(self._btn_add_inst)
        btn_row.addWidget(self._btn_del_inst)
        btn_row.addWidget(self._btn_preview)
        ll.addLayout(btn_row)

        self._inst_list_w.currentRowChanged.connect(self._on_inst_row_changed)
        self._btn_add_inst.clicked.connect(self._add_instance_dialog)
        self._btn_del_inst.clicked.connect(self._remove_current_instance)
        self._btn_preview.clicked.connect(self._emit_preview)

        self._canvas = WaterMinigameSceneCanvas(model)
        self._canvas.entity_selected.connect(self._on_canvas_entity_selected)
        self._canvas.entity_moved.connect(self._on_canvas_entity_moved)
        self._canvas.place_requested.connect(self._on_canvas_place_entity)

        right_split = QSplitter(Qt.Orientation.Vertical)
        right_split.setChildrenCollapsible(False)

        inst_scroll = QScrollArea()
        inst_scroll.setWidgetResizable(True)
        inst_scroll.setMinimumHeight(100)  # 表单可滚，降低下限给下方实体区让位
        inst_host = QWidget()
        inst_form = compact_form(QFormLayout(inst_host))

        self._inst_label = QLineEdit()
        self._inst_label.setPlaceholderText("列表显示名")

        self._spot_sel = IdRefSelector(allow_empty=True, editable=False, click_opens_popup=True)
        self._spot_wrap = QWidget()
        spl = QHBoxLayout(self._spot_wrap)
        spl.setContentsMargins(0, 0, 0, 0)
        spl.addWidget(self._spot_sel, stretch=1)
        self._btn_new_spot = QPushButton("新建锚点…")
        self._btn_new_spot.setToolTip("登记新的 spotId；下拉仅可选已有锚点")
        spl.addWidget(self._btn_new_spot)

        self._surf_loc = QComboBox()
        self._surf_loc.setEditable(False)
        self._surf_time = QComboBox()
        for x in _TIME_OPTS:
            self._surf_time.addItem(x)
        self._surf_weather = QComboBox()
        for x in _WEATHER_OPTS:
            self._surf_weather.addItem(x)

        bounds_row = QHBoxLayout()
        self._bounds_w = QSpinBox()
        self._bounds_w.setRange(64, 8192)
        self._bounds_h = QSpinBox()
        self._bounds_h.setRange(64, 8192)
        bounds_row.addWidget(self._bounds_w)
        bounds_row.addWidget(QLabel("×"))
        bounds_row.addWidget(self._bounds_h)
        bounds_row.addStretch(1)
        bounds_wrap = QWidget()
        bounds_wrap.setLayout(bounds_row)

        self._wb_tex = CutsceneImagePathRow(
            model,
            "",
            external_copy_subdir="illustrations",
            external_copy_hint="水底贴图：仅 Browse 写入路径",
            path_edit_read_only=True,
        )
        self._wb_tint_row = HexColorPickRow("#1b2f42", title="水底色调 waterBottom.tint")
        self._wb_depth = QDoubleSpinBox()
        self._wb_depth.setRange(0.0, 9999.0)
        self._wb_depth.setDecimals(3)
        self._wb_depth.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)

        inst_form.addRow("标题 label", self._inst_label)
        inst_form.addRow("spotId（水域锚点）", self._spot_wrap)
        inst_form.addRow("surface.location", self._surf_loc)
        inst_form.addRow("surface.time", self._surf_time)
        inst_form.addRow("surface.weather", self._surf_weather)
        inst_form.addRow("bounds", bounds_wrap)
        inst_form.addRow("waterBottom.texture", self._wb_tex)
        inst_form.addRow("waterBottom.tint", self._wb_tint_row)
        inst_form.addRow("waterBottom.depth", self._wb_depth)

        inst_scroll.setWidget(inst_host)

        ent_outer = QWidget()
        ent_outer_l = QVBoxLayout(ent_outer)
        ent_outer_l.setContentsMargins(0, 0, 0, 0)
        ent_tool = QHBoxLayout()
        self._btn_add_ent = QPushButton("+实体")
        self._btn_add_ent.setToolTip("在水域中央新增一个实体")
        self._btn_rm_ent = QPushButton("−实体")
        self._btn_rm_ent.setToolTip("删除当前选中的实体")
        self._btn_ent_up = QPushButton("↑")
        self._btn_ent_up.setToolTip("上移当前实体（调整 entities 数组顺序）")
        self._btn_ent_up.setMaximumWidth(30)
        self._btn_ent_down = QPushButton("↓")
        self._btn_ent_down.setToolTip("下移当前实体（调整 entities 数组顺序）")
        self._btn_ent_down.setMaximumWidth(30)
        ent_tool.addWidget(QLabel("实体属性"))
        ent_tool.addStretch()
        ent_tool.addWidget(self._btn_ent_up)
        ent_tool.addWidget(self._btn_ent_down)
        ent_tool.addWidget(self._btn_add_ent)
        ent_tool.addWidget(self._btn_rm_ent)
        ent_outer_l.addLayout(ent_tool)

        # 实体列表：与画布选择双向同步；上方便于在多实体时快速定位/选择。
        self._ent_list_w = QListWidget()
        self._ent_list_w.setMaximumHeight(140)
        self._ent_list_w.setToolTip("实体列表：单击选中，与画布选择双向同步；Delete 删除")
        self._ent_list_w.currentRowChanged.connect(self._on_ent_list_row_changed)
        self._ent_list_w.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._ent_list_w.customContextMenuRequested.connect(self._on_ent_list_context_menu)
        self._ent_list_w.installEventFilter(self)
        ent_outer_l.addWidget(self._ent_list_w)

        ent_scroll = QScrollArea()
        ent_scroll.setWidgetResizable(True)
        ent_scroll.setMinimumWidth(260)   # 三栏预算：表单下限收窄
        ent_scroll.setMinimumHeight(180)  # 可滚，降低下限省竖向空间
        ent_host = QWidget()
        ef = compact_form(QFormLayout(ent_host))

        self._ent_id = QLineEdit()
        self._ent_cat = QComboBox()
        for c in _CATEGORY_ORDER:
            self._ent_cat.addItem(c)

        self._ent_sprite = CutsceneImagePathRow(
            model,
            "",
            external_copy_subdir="illustrations",
            external_copy_hint="精灵：仅 Browse",
            path_edit_read_only=True,
        )

        px = QHBoxLayout()
        self._ent_px = QSpinBox()
        self._ent_px.setRange(-50000, 50000)
        self._ent_py = QSpinBox()
        self._ent_py.setRange(-50000, 50000)
        px.addWidget(self._ent_px)
        px.addWidget(QLabel(","))
        px.addWidget(self._ent_py)
        px.addStretch(1)
        pxw = QWidget()
        pxw.setLayout(px)

        self._ent_depth = QDoubleSpinBox()
        self._ent_depth.setRange(0.0, 9999.0)
        self._ent_depth.setDecimals(4)
        self._ent_depth.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)

        self._motion_group = QGroupBox("位移 motion")
        self._motion_group.setCheckable(True)
        mf = compact_form(QFormLayout(self._motion_group))
        self._motion_path = QComboBox()
        for p in _MOTION_PATH:
            self._motion_path.addItem(p)
        self._motion_speed = QDoubleSpinBox()
        self._motion_speed.setRange(0.0, 99.0)
        self._motion_speed.setDecimals(4)
        self._motion_speed.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)
        mf.addRow("path", self._motion_path)
        mf.addRow("speed", self._motion_speed)

        self._pull_group = QGroupBox("拉扯 pull")
        self._pull_group.setCheckable(True)
        pf = compact_form(QFormLayout(self._pull_group))
        self._pull_zone = QDoubleSpinBox()
        self._pull_zone.setRange(0.001, 1.0)
        self._pull_zone.setDecimals(4)
        self._pull_zone.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)
        self._pull_speed = QDoubleSpinBox()
        self._pull_speed.setRange(0.05, 9.99)
        self._pull_speed.setDecimals(4)
        self._pull_speed.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)
        self._pull_rhythm = QComboBox()
        for r in _PULL_RHYTHM:
            self._pull_rhythm.addItem(r)
        self._pull_fail = QComboBox()
        for r in _FAILURE:
            self._pull_fail.addItem(r)
        self._pull_time = QSpinBox()
        self._pull_time.setRange(1, 600)
        pf.addRow("zoneSize", self._pull_zone)
        pf.addRow("sliderSpeed", self._pull_speed)
        pf.addRow("rhythm", self._pull_rhythm)
        pf.addRow("failurePolicy", self._pull_fail)
        pf.addRow("timeLimitSec", self._pull_time)

        self._ent_value_tier = QComboBox()
        self._ent_value_tier.addItem("(默认)")
        for vt in _VALUE_TIER:
            self._ent_value_tier.addItem(vt)

        self._ent_consume = QCheckBox("consumeOnSuccess")

        self._cue_stack = QStackedWidget()
        self._cue_plain = QPlainTextEdit()
        self._cue_plain.setPlaceholderText("自定义 cue…")
        self._cue_plain.setMaximumHeight(72)
        cue_tag_w = QWidget()
        ctl = QHBoxLayout(cue_tag_w)
        ctl.setContentsMargins(0, 0, 0, 0)
        self._cue_tag_disp = QLineEdit()
        self._cue_tag_disp.setReadOnly(True)
        self._cue_pick = QPushButton("选择 Strings 词条…")
        self._cue_pick.setToolTip("从 Strings 表中挑选词条，写入 [tag:string:…] 引用")
        ctl.addWidget(self._cue_tag_disp, stretch=1)
        ctl.addWidget(self._cue_pick)
        self._cue_stack.addWidget(self._cue_plain)
        self._cue_stack.addWidget(cue_tag_w)
        self._cue_mode = QComboBox()
        self._cue_mode.addItems(["自定义文案", "Strings 词条引用"])
        self._cue_mode.setMaximumWidth(180)  # 模式选择器：上限即可，小屏可缩、大屏不拉满

        self._hint_stack = QStackedWidget()
        self._hint_plain = QPlainTextEdit()
        self._hint_plain.setPlaceholderText("自定义 hint…")
        self._hint_plain.setMaximumHeight(72)
        hint_tag_w = QWidget()
        htl = QHBoxLayout(hint_tag_w)
        htl.setContentsMargins(0, 0, 0, 0)
        self._hint_tag_disp = QLineEdit()
        self._hint_tag_disp.setReadOnly(True)
        self._hint_pick = QPushButton("选择 Strings 词条…")
        self._hint_pick.setToolTip("从 Strings 表中挑选词条，写入 [tag:string:…] 引用")
        htl.addWidget(self._hint_tag_disp, stretch=1)
        htl.addWidget(self._hint_pick)
        self._hint_stack.addWidget(self._hint_plain)
        self._hint_stack.addWidget(hint_tag_w)
        self._hint_mode = QComboBox()
        self._hint_mode.addItems(["自定义文案", "Strings 词条引用"])
        self._hint_mode.setMaximumWidth(180)  # 模式选择器：上限即可，小屏可缩、大屏不拉满

        cue_box = QWidget()
        cuel = QVBoxLayout(cue_box)
        cuel.setContentsMargins(0, 0, 0, 0)
        cuel.addWidget(self._cue_mode)
        cuel.addWidget(self._cue_stack)
        # 去掉宽度下限：cue 编辑区跟随表单列宽伸缩（小屏可缩、大屏占满）

        hint_box = QWidget()
        hintl = QVBoxLayout(hint_box)
        hintl.setContentsMargins(0, 0, 0, 0)
        hintl.addWidget(self._hint_mode)
        hintl.addWidget(self._hint_stack)
        # 去掉宽度下限：hint 编辑区跟随表单列宽伸缩（小屏可缩、大屏占满）

        ef.addRow("实体 id", self._ent_id)
        ef.addRow("category", self._ent_cat)
        ef.addRow("sprite", self._ent_sprite)
        ef.addRow("pos x,y", pxw)
        ef.addRow("depth", self._ent_depth)
        ef.addRow(self._motion_group)
        ef.addRow(self._pull_group)
        ef.addRow("valueTier", self._ent_value_tier)
        ef.addRow(self._ent_consume)
        ef.addRow("cue", cue_box)
        ef.addRow("hint", hint_box)

        self._ae_pick = ActionEditor("onPick")
        self._ae_ok = ActionEditor("onPullSuccess")
        self._ae_fail = ActionEditor("onPullFail")
        for ae in (self._ae_pick, self._ae_ok, self._ae_fail):
            ae.set_project_context(model, None)
            ae.changed.connect(self._mark_wm_dirty)

        ae_wrap = QWidget()
        ae_l = QVBoxLayout(ae_wrap)
        ae_l.setContentsMargins(0, 0, 0, 0)
        ae_l.addWidget(self._ae_pick)
        ae_l.addWidget(self._ae_ok)
        ae_l.addWidget(self._ae_fail)
        ef.addRow(ae_wrap)

        ent_scroll.setWidget(ent_host)

        ent_outer_l.addWidget(ent_scroll, stretch=1)

        right_split.addWidget(inst_scroll)
        right_split.addWidget(ent_outer)
        right_split.setStretchFactor(0, 0)
        right_split.setStretchFactor(1, 1)

        split.addWidget(left)
        split.addWidget(self._canvas)
        split.addWidget(right_split)
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 2)
        split.setStretchFactor(2, 1)

        root.addWidget(split)

        self._model.data_changed.connect(self._on_model_data_changed)

        self._wire_signals()

        self._reload_instance_list(select_id=None)
        if self._inst_list_w.count() == 0:
            self._set_editor_enabled(False)

    # ---- signals / wiring -------------------------------------------------

    def _wire_signals(self) -> None:
        self._inst_label.textChanged.connect(self._on_inst_label_changed)
        self._spot_sel.value_changed.connect(self._on_spot_changed)
        self._btn_new_spot.clicked.connect(self._on_new_spot_clicked)
        self._surf_loc.currentTextChanged.connect(self._on_surface_changed)
        self._surf_time.currentTextChanged.connect(self._on_surface_changed)
        self._surf_weather.currentTextChanged.connect(self._on_surface_changed)
        self._bounds_w.valueChanged.connect(self._on_bounds_changed)
        self._bounds_h.valueChanged.connect(self._on_bounds_changed)
        self._wb_tex.changed.connect(self._on_wb_changed)
        self._wb_tint_row.changed.connect(self._on_wb_changed)
        self._wb_depth.valueChanged.connect(self._on_wb_changed)

        self._btn_add_ent.clicked.connect(self._add_entity)
        self._btn_rm_ent.clicked.connect(self._remove_entity)
        self._btn_ent_up.clicked.connect(self._move_entity_up)
        self._btn_ent_down.clicked.connect(self._move_entity_down)

        self._ent_id.textChanged.connect(self._on_ent_id_changed)
        self._ent_cat.currentTextChanged.connect(self._on_ent_scalar_changed)
        self._ent_sprite.changed.connect(self._on_ent_sprite_changed)
        self._ent_px.valueChanged.connect(self._on_ent_pos_changed)
        self._ent_py.valueChanged.connect(self._on_ent_pos_changed)
        self._ent_depth.valueChanged.connect(self._on_ent_scalar_changed_spin)
        self._motion_group.toggled.connect(self._on_motion_toggled)
        self._motion_path.currentTextChanged.connect(self._on_motion_field_changed)
        self._motion_speed.valueChanged.connect(self._on_motion_field_changed)
        self._pull_group.toggled.connect(self._on_pull_toggled)
        for w in (
            self._pull_zone,
            self._pull_speed,
            self._pull_rhythm,
            self._pull_fail,
            self._pull_time,
        ):
            if isinstance(w, QComboBox):
                w.currentTextChanged.connect(self._on_pull_field_changed)
            else:
                w.valueChanged.connect(self._on_pull_field_changed)
        self._ent_value_tier.currentTextChanged.connect(self._on_ent_value_tier_changed)
        self._ent_consume.stateChanged.connect(self._on_ent_consume_changed)

        self._cue_mode.currentIndexChanged.connect(self._on_cue_mode_changed)
        self._cue_plain.textChanged.connect(self._on_cue_plain_changed)
        self._cue_pick.clicked.connect(self._on_cue_pick)
        self._hint_mode.currentIndexChanged.connect(self._on_hint_mode_changed)
        self._hint_plain.textChanged.connect(self._on_hint_plain_changed)
        self._hint_pick.clicked.connect(self._on_hint_pick)

    def eventFilter(self, obj, event):  # noqa: N802 (Qt override)
        if obj is self._ent_list_w and event.type() == event.Type.KeyPress:
            if event.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
                row = self._ent_list_w.currentRow()
                if row >= 0:
                    # 让内部记账对齐可见选中行，再走既有删除逻辑。
                    if row != self._selected_ent_row:
                        self._on_canvas_entity_selected(row)
                    self._remove_entity()
                    return True
        return super().eventFilter(obj, event)

    def _mark_wm_dirty(self) -> None:
        if self._loading or not self._doc or not self._current_inst_id:
            return
        self._model.mark_dirty("water_minigames")

    def _on_model_data_changed(self, dtype: str, _key: str) -> None:
        if dtype in ("strings", "item", "flag_registry", "quest", "rule", "scene"):
            for ae in (self._ae_pick, self._ae_ok, self._ae_fail):
                ae.set_project_context(self._model, None)

    # ---- instances --------------------------------------------------------

    def _reload_instance_list(self, select_id: str | None) -> None:
        self._inst_list_w.blockSignals(True)
        self._inst_list_w.clear()
        idx = self._model.water_minigames_index
        if not isinstance(idx, list):
            idx = []
        sel_row = 0
        for i, row in enumerate(idx):
            if not isinstance(row, dict):
                continue
            iid = str(row.get("id") or "").strip()
            lab = str(row.get("label") or iid)
            it = QListWidgetItem(f"{lab}  [{iid}]")
            it.setData(Qt.ItemDataRole.UserRole, iid)
            self._inst_list_w.addItem(it)
            if select_id and iid == select_id:
                sel_row = i
        self._inst_list_w.blockSignals(False)
        if self._inst_list_w.count() > 0:
            self._inst_list_w.setCurrentRow(sel_row)

    def select_by_id(self, item_id: str, _scene_id: str = "") -> None:
        iid = (item_id or "").strip()
        if not iid:
            return
        for row in self._model.water_minigames_index if isinstance(self._model.water_minigames_index, list) else []:
            if isinstance(row, dict) and str(row.get("id") or "").strip() == iid:
                self._reload_instance_list(select_id=iid)
                return

    def _set_editor_enabled(self, on: bool) -> None:
        for w in (
            self._inst_label,
            self._spot_sel,
            self._btn_new_spot,
            self._surf_loc,
            self._surf_time,
            self._surf_weather,
            self._bounds_w,
            self._bounds_h,
            self._wb_tex,
            self._wb_tint_row,
            self._wb_depth,
            self._canvas,
            self._btn_add_ent,
            self._btn_rm_ent,
            self._btn_ent_up,
            self._btn_ent_down,
            self._ent_list_w,
            self._ent_id,
            self._ent_cat,
            self._ent_sprite,
            self._ent_px,
            self._ent_py,
            self._ent_depth,
            self._motion_group,
            self._pull_group,
            self._ent_value_tier,
            self._ent_consume,
            self._cue_mode,
            self._cue_plain,
            self._cue_pick,
            self._hint_mode,
            self._hint_plain,
            self._hint_pick,
            self._ae_pick,
            self._ae_ok,
            self._ae_fail,
        ):
            w.setEnabled(on)
        self._btn_preview.setEnabled(on and self._current_inst_id is not None)

    def _flush_actions_for_entity_row(self, row: int) -> None:
        # 按身份回写：只把 ActionEditor 内容写回它当前归属的那个实体 dict，且仅当该实体
        # 仍在列表中。这样删除/重排导致行号漂移时，绝不会把动作误刷进顶上来补位的实体
        # （历史上按 row 取 ents[row] 正是串台根因）。row 参数仅保留兼容签名。
        if not self._doc:
            return
        owner = self._ae_owner
        if not isinstance(owner, dict):
            return
        ents = self._doc.get("entities")
        if not isinstance(ents, list) or not any(owner is e for e in ents):
            return
        self._ae_assign(owner)

    def _on_inst_row_changed(self, row: int) -> None:
        self._flush_actions_for_entity_row(self._selected_ent_row)
        self._prev_ent_row = -1
        self._selected_ent_row = -1
        if row < 0:
            self._current_inst_id = None
            self._doc = None
            self._canvas.refresh(
                bounds_wh=(720, 480),
                texture_url="",
                tint_hex="#1b2f42",
                entities=[],
                selected_row=-1,
            )
            self._set_editor_enabled(False)
            return
        it = self._inst_list_w.item(row)
        if it is None:
            return
        iid = str(it.data(Qt.ItemDataRole.UserRole) or "").strip()
        self._current_inst_id = iid
        self._doc = self._model.water_minigames_instances.get(iid)
        self._set_editor_enabled(True)
        self._refresh_spot_selector()
        self._fill_instance_form()
        self._reload_entities_canvas(select_row=0)

    def _refresh_spot_selector(self) -> None:
        items = _collect_spot_id_items(self._model, self._extra_spot_ids)
        cur = ""
        if self._doc:
            cur = str(self._doc.get("spotId") or "").strip()
        self._spot_sel.blockSignals(True)
        self._spot_sel.set_items(items)
        self._spot_sel.set_current(cur)
        self._spot_sel.blockSignals(False)

    def _fill_instance_form(self) -> None:
        self._loading = True
        try:
            assert self._doc is not None
            self._inst_label.setText(str(self._doc.get("label") or ""))
            self._refresh_spot_selector()

            locs = _deep_merge_locations(self._model)
            self._surf_loc.blockSignals(True)
            self._surf_loc.clear()
            for x in locs:
                self._surf_loc.addItem(x)
            surf = self._doc.get("surface")
            if isinstance(surf, dict):
                _combo_set_text(self._surf_loc, str(surf.get("location") or "dock"))
                _combo_set_text(self._surf_time, str(surf.get("time") or "day"))
                _combo_set_text(self._surf_weather, str(surf.get("weather") or "clear"))
            else:
                self._surf_loc.setCurrentIndex(0)
                self._surf_time.setCurrentIndex(_TIME_OPTS.index("day"))
                self._surf_weather.setCurrentIndex(_WEATHER_OPTS.index("clear"))
            self._surf_loc.blockSignals(False)

            b = self._doc.get("bounds")
            if isinstance(b, dict):
                self._bounds_w.setValue(int(b.get("width") or 720))
                self._bounds_h.setValue(int(b.get("height") or 480))
            else:
                self._bounds_w.setValue(720)
                self._bounds_h.setValue(480)

            wb = self._doc.get("waterBottom")
            if isinstance(wb, dict):
                self._wb_tex.set_path(str(wb.get("texture") or ""))
                self._wb_tint_row.set_hex(str(wb.get("tint") or "#1b2f42"))
                self._wb_depth.setValue(float(wb.get("depth") if wb.get("depth") is not None else 1.0))
            else:
                self._wb_tex.set_path("")
                self._wb_tint_row.set_hex("#1b2f42")
                self._wb_depth.setValue(1.0)
        finally:
            self._loading = False

    def _ensure_surface_dict(self) -> dict:
        assert self._doc is not None
        surf = self._doc.get("surface")
        if not isinstance(surf, dict):
            surf = {}
            self._doc["surface"] = surf
        return surf

    def _ensure_wb_dict(self) -> dict:
        assert self._doc is not None
        wb = self._doc.get("waterBottom")
        if not isinstance(wb, dict):
            wb = {}
            self._doc["waterBottom"] = wb
        return wb

    def _on_inst_label_changed(self, text: str) -> None:
        if self._loading or not self._doc or not self._current_inst_id:
            return
        self._doc["label"] = text.strip()
        for row in self._model.water_minigames_index:
            if isinstance(row, dict) and str(row.get("id")) == self._current_inst_id:
                row["label"] = text.strip()
                break
        self._mark_wm_dirty()
        r = self._inst_list_w.currentRow()
        if r >= 0 and self._inst_list_w.item(r):
            iid = self._current_inst_id
            self._inst_list_w.item(r).setText(f"{text.strip()}  [{iid}]")

    def _on_spot_changed(self, _sid: str) -> None:
        if self._loading or not self._doc:
            return
        self._doc["spotId"] = self._spot_sel.current_id().strip()
        self._mark_wm_dirty()

    def _on_new_spot_clicked(self) -> None:
        raw, ok = QInputDialog.getText(self, "新建锚点", "新的 spotId（字母开头，字母数字下划线横线）：")
        if not ok:
            return
        sp = raw.strip()
        if not _SPOT_KEY_RE.match(sp):
            QMessageBox.warning(self, "水域小游戏", "spotId 格式不正确")
            return
        self._extra_spot_ids.add(sp)
        self._refresh_spot_selector()
        self._spot_sel.blockSignals(True)
        self._spot_sel.set_current(sp)
        self._spot_sel.blockSignals(False)
        self._on_spot_changed(sp)

    def _on_surface_changed(self, *_a: Any) -> None:
        if self._loading or not self._doc:
            return
        surf = self._ensure_surface_dict()
        surf["location"] = self._surf_loc.currentText().strip()
        surf["time"] = self._surf_time.currentText().strip()
        surf["weather"] = self._surf_weather.currentText().strip()
        self._mark_wm_dirty()
        self._refresh_canvas_visual()

    def _on_bounds_changed(self, _v: int = 0) -> None:
        if self._loading or not self._doc:
            return
        self._doc["bounds"] = {"width": self._bounds_w.value(), "height": self._bounds_h.value()}
        self._mark_wm_dirty()
        self._refresh_canvas_visual()

    def _on_wb_changed(self, *_a: Any) -> None:
        if self._loading or not self._doc:
            return
        wb = self._ensure_wb_dict()
        wb["texture"] = self._wb_tex.path().strip()
        wb["tint"] = self._wb_tint_row.hex().strip()
        wb["depth"] = float(self._wb_depth.value())
        self._mark_wm_dirty()
        self._refresh_canvas_visual()

    def _add_instance_dialog(self) -> None:
        raw, ok = QInputDialog.getText(self, "新增水域实例", "实例 id（将作为文件名 stem）：")
        if not ok:
            return
        iid = raw.strip()
        if not re.match(r"^[a-zA-Z][a-zA-Z0-9_\-]{0,63}$", iid):
            QMessageBox.warning(self, "水域小游戏", "id 格式不正确")
            return
        bag = self._model.water_minigames_instances
        if iid in bag:
            QMessageBox.warning(self, "水域小游戏", "该 id 已存在")
            return
        fname = f"{iid}.json"
        row = {"id": iid, "label": "新水域", "file": fname}
        self._model.water_minigames_index.append(row)
        doc = {
            "id": iid,
            "label": "新水域",
            "spotId": "",
            "waterBottom": {"texture": "", "tint": "#1b2f42", "depth": 1.0},
            "surface": {"location": "dock", "time": "day", "weather": "clear"},
            "bounds": {"width": 720, "height": 480},
            "entities": [],
        }
        bag[iid] = doc
        self._model.mark_dirty("water_minigames")
        self._reload_instance_list(select_id=iid)

    def _remove_current_instance(self) -> None:
        if not self._current_inst_id:
            return
        iid = self._current_inst_id
        if QMessageBox.question(self, "水域小游戏", f"删除实例 {iid!r}？") != QMessageBox.StandardButton.Yes:
            return
        self._model.water_minigames_index = [
            x for x in self._model.water_minigames_index
            if not (isinstance(x, dict) and str(x.get("id")) == iid)
        ]
        self._model.water_minigames_instances.pop(iid, None)
        self._model.mark_dirty("water_minigames")
        self._reload_instance_list(select_id=None)

    def _emit_preview(self) -> None:
        if self._current_inst_id:
            self.preview_requested.emit(self._current_inst_id)

    # ---- entities ---------------------------------------------------------

    def _entities_list(self) -> list[dict]:
        assert self._doc is not None
        ents = self._doc.setdefault("entities", [])
        if not isinstance(ents, list):
            self._doc["entities"] = []
            ents = self._doc["entities"]
        out: list[dict] = []
        for e in ents:
            if isinstance(e, dict):
                out.append(e)
        self._doc["entities"] = out
        return out

    def _refresh_canvas_visual(self) -> None:
        if not self._doc:
            return
        ents = self._entities_list()
        bw = int(self._bounds_w.value())
        bh = int(self._bounds_h.value())
        wb = self._doc.get("waterBottom")
        if not isinstance(wb, dict):
            wb = {}
        tex = str(wb.get("texture") or "")
        tint = str(wb.get("tint") or "#1b2f42")
        sel = self._selected_ent_row
        if not ents:
            sel = -1
        elif sel >= len(ents):
            sel = len(ents) - 1
        surf = self._doc.get("surface")
        if isinstance(surf, dict):
            tim = str(surf.get("time") or "day").strip() or "day"
            wth = str(surf.get("weather") or "clear").strip() or "clear"
        else:
            tim, wth = "day", "clear"
        self._canvas.refresh(
            bounds_wh=(bw, bh),
            texture_url=tex,
            tint_hex=tint,
            entities=ents,
            selected_row=sel,
            ambient=(tim, wth),
        )

    def _rebuild_ent_list(self, selected_row: int) -> None:
        """重建实体 QListWidget（纯 UI 镜像，不动数据）。"""
        ents = self._entities_list() if self._doc else []
        self._ent_list_w.blockSignals(True)
        self._ent_list_w.clear()
        for e in ents:
            eid = str(e.get("id") or "")
            cat = str(e.get("category") or "")
            self._ent_list_w.addItem(QListWidgetItem(f"{eid}  [{cat}]"))
        if 0 <= selected_row < self._ent_list_w.count():
            self._ent_list_w.setCurrentRow(selected_row)
        self._ent_list_w.blockSignals(False)

    def _reload_entities_canvas(self, select_row: int) -> None:
        ents = self._entities_list()
        if not ents:
            old = self._prev_ent_row
            if old >= 0:
                self._flush_actions_for_entity_row(old)
            self._prev_ent_row = -1
            self._selected_ent_row = -1
            self._cur_ent = None
            self._refresh_canvas_visual()
            self._fill_entity_form(None)
            self._rebuild_ent_list(-1)
            return
        row = min(max(select_row, 0), len(ents) - 1)
        old = self._prev_ent_row
        if old >= 0 and old != row:
            self._flush_actions_for_entity_row(old)
        self._prev_ent_row = row
        self._selected_ent_row = row
        self._refresh_canvas_visual()
        self._cur_ent = ents[row]
        self._fill_entity_form(self._cur_ent)
        self._rebuild_ent_list(row)

    def _sync_ent_list_selection(self, row: int) -> None:
        """仅同步实体列表高亮，不触发其行变更处理（纯 UI）。"""
        if row == self._ent_list_w.currentRow():
            return
        self._ent_list_w.blockSignals(True)
        if 0 <= row < self._ent_list_w.count():
            self._ent_list_w.setCurrentRow(row)
        else:
            self._ent_list_w.setCurrentRow(-1)
        self._ent_list_w.blockSignals(False)

    def _on_ent_list_row_changed(self, row: int) -> None:
        """实体列表被点选：复用画布选择处理，保证与画布双向一致。"""
        if row < 0:
            return
        if row == self._selected_ent_row:
            return
        self._on_canvas_entity_selected(row)

    def _on_ent_list_context_menu(self, pos) -> None:
        from PySide6.QtWidgets import QMenu

        row = self._ent_list_w.currentRow()
        if row < 0:
            return
        menu = QMenu(self._ent_list_w)
        act_up = menu.addAction("上移")
        act_down = menu.addAction("下移")
        menu.addSeparator()
        act_del = menu.addAction("删除")
        chosen = menu.exec(self._ent_list_w.mapToGlobal(pos))
        if chosen is act_up:
            self._move_entity_up()
        elif chosen is act_down:
            self._move_entity_down()
        elif chosen is act_del:
            # 让内部记账对齐可见选中行，再走既有删除逻辑。
            if row != self._selected_ent_row:
                self._on_canvas_entity_selected(row)
            self._remove_entity()

    def _active_ent_row(self) -> int:
        """当前操作目标行：优先列表里可见的选中行（最贴近用户意图），
        否则回退到内部记账 _selected_ent_row。"""
        r = self._ent_list_w.currentRow()
        if r >= 0:
            return r
        return self._selected_ent_row

    def _move_entity_up(self) -> None:
        cur = self._active_ent_row()
        self._swap_entity(cur, cur - 1)

    def _move_entity_down(self) -> None:
        cur = self._active_ent_row()
        self._swap_entity(cur, cur + 1)

    def _swap_entity(self, a: int, b: int) -> None:
        if not self._doc:
            return
        ents = self._entities_list()
        if a < 0 or b < 0 or a >= len(ents) or b >= len(ents) or a == b:
            return
        # 移动前先把待写动作落回当前实体（按身份记账），避免重排后串台。
        self._flush_actions_for_entity_row(self._active_ent_row())
        ents[a], ents[b] = ents[b], ents[a]
        self._mark_wm_dirty()
        self._reload_entities_canvas(select_row=b)
        # 画布重建过程中移除旧选中项会冒出一次 entity_selected(-1)，
        # 在此重新确立到移动后的目标行，让面板/列表选中跟随移动结果。
        self._on_canvas_entity_selected(b)

    def _on_canvas_entity_selected(self, row: int) -> None:
        old = self._prev_ent_row
        if old >= 0 and old != row:
            self._flush_actions_for_entity_row(old)
        self._prev_ent_row = row
        self._selected_ent_row = row
        self._sync_ent_list_selection(row)
        ents = self._entities_list()
        if row < 0 or row >= len(ents):
            self._cur_ent = None
            self._fill_entity_form(None)
            return
        self._cur_ent = ents[row]
        self._fill_entity_form(self._cur_ent)

    def _on_canvas_entity_moved(self, row: int, x: float, y: float) -> None:
        if row < 0 or not self._doc:
            return
        ents = self._entities_list()
        if row >= len(ents):
            return
        ent = ents[row]
        ent["pos"] = {"x": int(round(x)), "y": int(round(y))}
        self._mark_wm_dirty()
        if row == self._selected_ent_row:
            self._loading = True
            try:
                self._ent_px.setValue(int(round(x)))
                self._ent_py.setValue(int(round(y)))
            finally:
                self._loading = False

    def _on_canvas_place_entity(self, x: float, y: float) -> None:
        if not self._doc:
            return
        ents = self._entities_list()
        base = "entity_new"
        nid = base
        exist = {str(e.get("id")) for e in ents if e.get("id")}
        n = 1
        while nid in exist:
            nid = f"{base}_{n}"
            n += 1
        new_ent: dict[str, Any] = {
            "id": nid,
            "category": "grass",
            "sprite": "",
            "depth": 0.5,
        }
        cy = float(y) - _depth_offset_y(new_ent)
        new_ent["pos"] = {"x": int(round(x)), "y": int(round(cy))}
        ents.append(new_ent)
        self._mark_wm_dirty()
        self._canvas.set_place_mode(False)
        self._reload_entities_canvas(len(ents) - 1)

    def _fill_entity_form(self, ent: dict | None) -> None:
        # ActionEditor 自此归属 ent（身份记账），后续懒回写只认它。
        self._ae_owner = ent if isinstance(ent, dict) else None
        self._loading = True
        try:
            if ent is None:
                self._ent_id.clear()
                self._ent_cat.setCurrentIndex(0)
                self._ent_sprite.set_path("")
                self._ent_px.setValue(0)
                self._ent_py.setValue(0)
                self._ent_depth.setValue(0.5)
                self._motion_group.setChecked(False)
                self._motion_path.setCurrentIndex(0)
                self._motion_speed.setValue(0.05)
                self._pull_group.setChecked(False)
                self._pull_zone.setValue(0.1)
                self._pull_speed.setValue(1.0)
                self._pull_rhythm.setCurrentIndex(0)
                self._pull_fail.setCurrentIndex(0)
                self._pull_time.setValue(15)
                self._ent_value_tier.setCurrentIndex(0)
                self._ent_consume.setChecked(False)
                self._cue_mode.setCurrentIndex(0)
                self._cue_plain.clear()
                self._cue_tag_disp.clear()
                self._hint_mode.setCurrentIndex(0)
                self._hint_plain.clear()
                self._hint_tag_disp.clear()
                self._cue_stack.setCurrentIndex(0)
                self._hint_stack.setCurrentIndex(0)
                self._ae_pick.set_data([])
                self._ae_ok.set_data([])
                self._ae_fail.set_data([])
                return

            self._ent_id.setText(str(ent.get("id") or ""))
            cat = str(ent.get("category") or "grass")
            idx = self._ent_cat.findText(cat)
            self._ent_cat.setCurrentIndex(idx if idx >= 0 else 0)
            self._ent_sprite.set_path(str(ent.get("sprite") or ""))
            pos = ent.get("pos") if isinstance(ent.get("pos"), dict) else {}
            self._ent_px.setValue(int(pos.get("x") or 0))
            self._ent_py.setValue(int(pos.get("y") or 0))
            self._ent_depth.setValue(float(ent.get("depth") if ent.get("depth") is not None else 0.5))

            motion = ent.get("motion")
            has_m = isinstance(motion, dict)
            self._motion_group.setChecked(has_m)
            if has_m:
                mp = str(motion.get("path") or "stationary")
                mi = self._motion_path.findText(mp)
                self._motion_path.setCurrentIndex(mi if mi >= 0 else 0)
                self._motion_speed.setValue(float(motion.get("speed") if motion.get("speed") is not None else 0.05))

            pull = ent.get("pull")
            has_p = isinstance(pull, dict)
            self._pull_group.setChecked(has_p)
            if has_p:
                self._pull_zone.setValue(float(pull.get("zoneSize") if pull.get("zoneSize") is not None else 0.1))
                self._pull_speed.setValue(float(pull.get("sliderSpeed") if pull.get("sliderSpeed") is not None else 1.0))
                rh = str(pull.get("rhythm") or "stable")
                ri = self._pull_rhythm.findText(rh)
                self._pull_rhythm.setCurrentIndex(ri if ri >= 0 else 0)
                fp = str(pull.get("failurePolicy") or "escape")
                fi = self._pull_fail.findText(fp)
                self._pull_fail.setCurrentIndex(fi if fi >= 0 else 0)
                tl = pull.get("timeLimitSec")
                self._pull_time.setValue(int(tl) if tl is not None else 15)

            vt = ent.get("valueTier")
            if vt in _VALUE_TIER:
                self._ent_value_tier.setCurrentIndex(_VALUE_TIER.index(str(vt)) + 1)
            else:
                self._ent_value_tier.setCurrentIndex(0)

            self._ent_consume.setChecked(bool(ent.get("consumeOnSuccess")))

            cue = str(ent.get("cue") or "")
            if _looks_like_string_tag(cue):
                self._cue_mode.setCurrentIndex(1)
                self._cue_stack.setCurrentIndex(1)
                self._cue_tag_disp.setText(cue)
                self._cue_plain.clear()
            else:
                self._cue_mode.setCurrentIndex(0)
                self._cue_stack.setCurrentIndex(0)
                self._cue_plain.setPlainText(cue)
                self._cue_tag_disp.clear()

            hint = str(ent.get("hint") or "")
            if _looks_like_string_tag(hint):
                self._hint_mode.setCurrentIndex(1)
                self._hint_stack.setCurrentIndex(1)
                self._hint_tag_disp.setText(hint)
                self._hint_plain.clear()
            else:
                self._hint_mode.setCurrentIndex(0)
                self._hint_stack.setCurrentIndex(0)
                self._hint_plain.setPlainText(hint)
                self._hint_tag_disp.clear()

            self._ae_pick.set_data(list(ent.get("onPick") or []) if isinstance(ent.get("onPick"), list) else [])
            self._ae_ok.set_data(
                list(ent.get("onPullSuccess") or []) if isinstance(ent.get("onPullSuccess"), list) else [],
            )
            self._ae_fail.set_data(
                list(ent.get("onPullFail") or []) if isinstance(ent.get("onPullFail"), list) else [],
            )
        finally:
            self._loading = False

    def _add_entity(self) -> None:
        if not self._doc:
            return
        ents = self._entities_list()
        base = "entity_new"
        nid = base
        exist = {str(e.get("id")) for e in ents if e.get("id")}
        n = 1
        while nid in exist:
            nid = f"{base}_{n}"
            n += 1
        cx = max(0, self._bounds_w.value() // 2)
        vis_cy = max(0, self._bounds_h.value() // 2)
        new_ent: dict[str, Any] = {
            "id": nid,
            "category": "grass",
            "sprite": "",
            "depth": 0.5,
        }
        cy = float(vis_cy) - _depth_offset_y(new_ent)
        new_ent["pos"] = {"x": cx, "y": int(round(cy))}
        ents.append(new_ent)
        self._mark_wm_dirty()
        self._reload_entities_canvas(select_row=len(ents) - 1)
        self._ent_id.setFocus()

    def _remove_entity(self) -> None:
        row = self._selected_ent_row
        ents = self._entities_list()
        if row < 0 or row >= len(ents):
            return
        if not confirm.confirm_delete(self, f"水域实体「{ents[row].get('id', '')}」"):
            return
        ents.pop(row)
        self._mark_wm_dirty()
        self._reload_entities_canvas(select_row=min(row, len(ents) - 1))

    def _refresh_ent_list_label(self, row: int) -> None:
        """更新实体列表对应行的显示文本（纯 UI，不动数据）。"""
        if row < 0 or row >= self._ent_list_w.count() or not self._cur_ent:
            return
        eid = str(self._cur_ent.get("id") or "")
        cat = str(self._cur_ent.get("category") or "")
        it = self._ent_list_w.item(row)
        if it is not None:
            it.setText(f"{eid}  [{cat}]")

    def _on_ent_id_changed(self, text: str) -> None:
        if self._loading or not self._cur_ent:
            return
        self._cur_ent["id"] = text.strip()
        self._mark_wm_dirty()
        r = self._selected_ent_row
        if r >= 0:
            self._canvas.update_marker_visual(r, self._entities_list())
        self._refresh_ent_list_label(self._selected_ent_row)

    def _on_ent_scalar_changed(self, _t: str = "") -> None:
        if self._loading or not self._cur_ent:
            return
        self._cur_ent["category"] = self._ent_cat.currentText().strip()
        self._mark_wm_dirty()
        r = self._selected_ent_row
        if r >= 0:
            self._canvas.update_marker_visual(r, self._entities_list())
        self._refresh_ent_list_label(self._selected_ent_row)

    def _on_ent_sprite_changed(self) -> None:
        if self._loading or not self._cur_ent:
            return
        self._cur_ent["sprite"] = self._ent_sprite.path().strip()
        self._mark_wm_dirty()
        r = self._selected_ent_row
        if r >= 0:
            self._canvas.update_marker_visual(r, self._entities_list())

    def _on_ent_pos_changed(self, _v: int = 0) -> None:
        if self._loading or not self._cur_ent:
            return
        x = self._ent_px.value()
        y = self._ent_py.value()
        self._cur_ent["pos"] = {"x": x, "y": y}
        self._mark_wm_dirty()
        r = self._selected_ent_row
        if r >= 0:
            self._canvas.set_marker_center(r, float(x), float(y))

    def _on_ent_scalar_changed_spin(self, _v: float = 0.0) -> None:
        if self._loading or not self._cur_ent:
            return
        self._cur_ent["depth"] = float(self._ent_depth.value())
        self._mark_wm_dirty()
        r = self._selected_ent_row
        if r >= 0:
            self._canvas.update_marker_visual(r, self._entities_list())

    def _on_motion_toggled(self, on: bool) -> None:
        if self._loading or not self._cur_ent:
            return
        if not on:
            self._cur_ent.pop("motion", None)
        else:
            self._cur_ent["motion"] = {
                "path": self._motion_path.currentText(),
                "speed": float(self._motion_speed.value()),
            }
        self._mark_wm_dirty()

    def _on_motion_field_changed(self, *_a: Any) -> None:
        if self._loading or not self._cur_ent or not self._motion_group.isChecked():
            return
        self._cur_ent["motion"] = {
            "path": self._motion_path.currentText(),
            "speed": float(self._motion_speed.value()),
        }
        self._mark_wm_dirty()

    def _on_pull_toggled(self, on: bool) -> None:
        if self._loading or not self._cur_ent:
            return
        if not on:
            self._cur_ent.pop("pull", None)
        else:
            self._sync_pull_dict()
        self._mark_wm_dirty()

    def _sync_pull_dict(self) -> None:
        assert self._cur_ent is not None
        self._cur_ent["pull"] = {
            "zoneSize": float(self._pull_zone.value()),
            "sliderSpeed": float(self._pull_speed.value()),
            "rhythm": self._pull_rhythm.currentText(),
            "failurePolicy": self._pull_fail.currentText(),
            "timeLimitSec": int(self._pull_time.value()),
        }

    def _on_pull_field_changed(self, *_a: Any) -> None:
        if self._loading or not self._cur_ent or not self._pull_group.isChecked():
            return
        self._sync_pull_dict()
        self._mark_wm_dirty()

    def _on_ent_value_tier_changed(self, text: str) -> None:
        if self._loading or not self._cur_ent:
            return
        t = text.strip()
        if t == "(默认)":
            self._cur_ent.pop("valueTier", None)
        else:
            self._cur_ent["valueTier"] = t
        self._mark_wm_dirty()

    def _on_ent_consume_changed(self, _state: int) -> None:
        if self._loading or not self._cur_ent:
            return
        if self._ent_consume.isChecked():
            self._cur_ent["consumeOnSuccess"] = True
        else:
            self._cur_ent.pop("consumeOnSuccess", None)
        self._mark_wm_dirty()

    def _on_cue_mode_changed(self, idx: int) -> None:
        self._cue_stack.setCurrentIndex(1 if idx == 1 else 0)
        if self._loading or not self._cur_ent:
            return
        if idx == 1:
            cur = self._cue_plain.toPlainText().strip()
            if cur and not _looks_like_string_tag(cur):
                self._cue_plain.clear()
            if self._cue_tag_disp.text().strip():
                self._cur_ent["cue"] = self._cue_tag_disp.text().strip()
            else:
                self._cur_ent.pop("cue", None)
        else:
            self._cue_tag_disp.clear()
            self._cur_ent["cue"] = self._cue_plain.toPlainText().strip()
            if not self._cur_ent["cue"]:
                self._cur_ent.pop("cue", None)
        self._mark_wm_dirty()

    def _on_cue_plain_changed(self) -> None:
        if self._loading or not self._cur_ent:
            return
        if self._cue_mode.currentIndex() != 0:
            return
        txt = self._cue_plain.toPlainText().strip()
        if txt:
            self._cur_ent["cue"] = txt
        else:
            self._cur_ent.pop("cue", None)
        self._mark_wm_dirty()

    def _on_cue_pick(self) -> None:
        cur = self._cue_tag_disp.text().strip()
        picked = pick_string_tag_marker(
            self,
            self._model,
            title="选择 cue 的 Strings 词条",
            current_marker=cur,
        )
        if picked is None:
            return
        self._cue_tag_disp.setText(picked)
        self._cue_mode.setCurrentIndex(1)
        self._cue_stack.setCurrentIndex(1)
        if self._cur_ent:
            self._cur_ent["cue"] = picked
            self._mark_wm_dirty()

    def _on_hint_mode_changed(self, idx: int) -> None:
        self._hint_stack.setCurrentIndex(1 if idx == 1 else 0)
        if self._loading or not self._cur_ent:
            return
        if idx == 1:
            if self._hint_tag_disp.text().strip():
                self._cur_ent["hint"] = self._hint_tag_disp.text().strip()
            else:
                self._cur_ent.pop("hint", None)
        else:
            self._hint_tag_disp.clear()
            self._cur_ent["hint"] = self._hint_plain.toPlainText().strip()
            if not self._cur_ent["hint"]:
                self._cur_ent.pop("hint", None)
        self._mark_wm_dirty()

    def _on_hint_plain_changed(self) -> None:
        if self._loading or not self._cur_ent:
            return
        if self._hint_mode.currentIndex() != 0:
            return
        txt = self._hint_plain.toPlainText().strip()
        if txt:
            self._cur_ent["hint"] = txt
        else:
            self._cur_ent.pop("hint", None)
        self._mark_wm_dirty()

    def _on_hint_pick(self) -> None:
        cur = self._hint_tag_disp.text().strip()
        picked = pick_string_tag_marker(
            self,
            self._model,
            title="选择 hint 的 Strings 词条",
            current_marker=cur,
        )
        if picked is None:
            return
        self._hint_tag_disp.setText(picked)
        self._hint_mode.setCurrentIndex(1)
        self._hint_stack.setCurrentIndex(1)
        if self._cur_ent:
            self._cur_ent["hint"] = picked
            self._mark_wm_dirty()

    def flush_to_model(self) -> None:
        self._flush_actions_for_entity_row(self._selected_ent_row)
        bag = getattr(self._model, "water_minigames_instances", {}) or {}
        for iid, doc in bag.items():
            if not isinstance(doc, dict):
                raise ValueError(f"water_minigames[{iid}]: 根必须为对象")
            ents = doc.get("entities")
            if ents is None:
                doc["entities"] = []
                ents = doc["entities"]
            if not isinstance(ents, list):
                raise ValueError(f"water_minigames[{iid}]: entities 必须为数组")
            seen: set[str] = set()
            for e in ents:
                if not isinstance(e, dict):
                    continue
                eid = str(e.get("id") or "").strip()
                if not eid:
                    raise ValueError(f"water_minigames[{iid}]: 实体 id 不能为空")
                if eid in seen:
                    raise ValueError(f"water_minigames[{iid}]: 重复的实体 id {eid!r}")
                seen.add(eid)
        self._model.mark_dirty("water_minigames")

    def _ae_assign(self, ent: dict) -> None:
        ent["onPick"] = self._ae_pick.to_list()
        ent["onPullSuccess"] = self._ae_ok.to_list()
        ent["onPullFail"] = self._ae_fail.to_list()
