"""过场（Cutscene）步骤序列编辑器 — `steps` schema（present / action / parallel）。

数据为自上而下顺序执行 + parallel fork-join，非 NLE 多轨时间轴。
"""
from __future__ import annotations

import json
from copy import deepcopy
from typing import TYPE_CHECKING, Any

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton, QLabel,
    QScrollArea, QCheckBox, QDoubleSpinBox, QFrame, QMessageBox,
    QDialog, QGroupBox, QToolButton, QSizePolicy, QMenu,
)
from PySide6.QtCore import Qt, Signal, QEvent, QObject
from PySide6.QtGui import QAction, QFont, QMouseEvent

from ..project_model import ProjectModel
from .. import theme as app_theme
from ..shared.id_ref_selector import IdRefSelector
from ..shared.image_path_picker import CutsceneImagePathRow
from ..shared.action_editor import ActionRow, FilterableTypeCombo
from ..shared.cutscene_dialogue_speaker_row import CutsceneShowDialogueFields
from .scene_editor import CutsceneCameraPointPickerDialog, TargetSpawnPickerDialog

if TYPE_CHECKING:
    pass

# ---------------------------------------------------------------
# Cutscene Action whitelist（须与 src/data/types.ts CUTSCENE_ACTION_WHITELIST 一致）
# ---------------------------------------------------------------
CUTSCENE_ACTION_WHITELIST = [
    "moveEntityTo", "faceEntity", "cutsceneSpawnActor", "cutsceneRemoveActor",
    "showEmoteAndWait", "playNpcAnimation", "setEntityEnabled",
    "persistNpcEntityEnabled", "persistHotspotEnabled",
    "tempSetHotspotDisplayFacing",
    "playSfx", "playBgm", "stopBgm",
]

# ---------------------------------------------------------------
# Present step types and their parameter schemas
# ---------------------------------------------------------------
PRESENT_TYPES = [
    "fadeToBlack", "fadeIn", "flashWhite", "waitTime", "waitClick",
    "showTitle", "showDialogue", "showImg", "hideImg",
    "showMovieBar", "hideMovieBar", "showSubtitle",
    "cameraMove", "cameraZoom", "showCharacter",
]

_PRESENT_PARAMS: dict[str, list[tuple[str, str]]] = {
    "fadeToBlack": [("duration", "float")],
    "fadeIn": [("duration", "float")],
    "flashWhite": [("duration", "float")],
    "waitTime": [("duration", "float")],
    "waitClick": [],
    "showTitle": [("text", "text"), ("duration", "float")],
    "showDialogue": [],
    "showImg": [("id", "str"), ("image", "image")],
    "hideImg": [("id", "str")],
    "showMovieBar": [("heightPercent", "float")],
    "hideMovieBar": [],
    "showSubtitle": [("text", "text"), ("position", "str")],
    "cameraMove": [("x", "float"), ("y", "float"), ("duration", "float")],
    "cameraZoom": [("scale", "float"), ("duration", "float")],
    "showCharacter": [("visible", "bool")],
}

_MS_KEYS = frozenset({"duration"})

# 与 CutsceneManager.executePresent 默认一致（毫秒）
_GANTT_MAX_MS = 8000
_GANTT_BAR_PX = 56

def _float_ms(step: dict, key: str, default: float) -> int:
    v = step.get(key)
    if v is None or v == "":
        return int(default)
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return int(default)


def parallel_tracks_summary(tracks: list) -> str:
    types: list[str] = []
    for tr in tracks:
        if isinstance(tr, dict):
            types.append(f'{tr.get("kind", "?")}:{tr.get("type", "?")}')
    s = " | ".join(types[:6])
    if len(types) > 6:
        s += "…"
    if not tracks:
        return "并行 (0 轨)"
    return f"并行 ({len(tracks)} 轨) · {s}"


def step_summary_line(d: dict) -> str:
    kind = str(d.get("kind", "present"))
    if kind == "action":
        t = str(d.get("type", ""))
        p = d.get("params") or {}
        ps = json.dumps(p, ensure_ascii=False) if p else ""
        if len(ps) > 48:
            ps = ps[:45] + "…"
        return f"{t}  {ps}" if ps else t
    if kind == "parallel":
        return parallel_tracks_summary(d.get("tracks") or [])
    if kind == "present":
        t = str(d.get("type", ""))
        if t == "showDialogue":
            tx = str(d.get("text", "")).replace("\n", " ")
            return f"showDialogue: {tx[:40]}…" if len(tx) > 40 else f"showDialogue: {tx}"
        if t == "showTitle":
            tx = str(d.get("text", ""))
            return f"showTitle: {tx[:24]}…" if len(tx) > 24 else f"showTitle: {tx}"
        if t in ("waitTime", "fadeToBlack", "fadeIn", "flashWhite", "cameraMove", "cameraZoom"):
            return f"{t}  {_float_ms(d, 'duration', 0)}ms"
        if t == "showImg":
            return f"showImg  {d.get('id', '')}"
        return t
    return kind


def estimate_step_duration_ms(step: dict) -> int | None:
    """与 CutsceneManager.executePresent 对齐的粗估；None = 不定。"""
    kind = str(step.get("kind", "present"))
    if kind == "action":
        return None
    if kind == "parallel":
        ts = step.get("tracks") or []
        if not ts:
            return 0
        parts: list[int | None] = []
        for s in ts:
            if isinstance(s, dict):
                parts.append(estimate_step_duration_ms(s))
            else:
                parts.append(0)
        if any(p is None for p in parts):
            return None
        return max(p for p in parts) if parts else 0
    if kind != "present":
        return None
    t = str(step.get("type", ""))
    if t in ("waitClick", "showDialogue", "showSubtitle"):
        return None
    if t == "showImg":
        return None
    if t in ("hideImg", "hideMovieBar", "showMovieBar", "showCharacter"):
        return 0
    if t == "fadeToBlack":
        return _float_ms(step, "duration", 1000)
    if t == "fadeIn":
        return _float_ms(step, "duration", 1000)
    if t == "flashWhite":
        return _float_ms(step, "duration", 200)
    if t == "waitTime":
        return _float_ms(step, "duration", 1000)
    if t == "showTitle":
        return _float_ms(step, "duration", 2000)
    if t == "cameraMove":
        return _float_ms(step, "duration", 1000)
    if t == "cameraZoom":
        return _float_ms(step, "duration", 500)
    return None


def format_duration_hint(ms: int | None) -> str:
    if ms is None:
        return "不定"
    if ms == 0:
        return "—"
    return f"~{ms}ms"


def gantt_style_for_ms(ms: int | None, theme_id: str) -> str:
    dark = app_theme.is_dark_theme(theme_id)
    dash = "#868e96" if dark else "#6c757d"
    zero_bg = "#495057" if dark else "#dee2e6"
    fill = "#868e96" if dark else "#6c757d"
    if ms is None:
        return (
            f"background: transparent; border: 1px dashed {dash}; "
            "min-height: 10px; max-height: 10px; border-radius: 2px;"
        )
    if ms <= 0:
        return (
            f"background: {zero_bg}; min-height: 10px; max-height: 10px; "
            "border-radius: 2px; min-width: 4px; max-width: 4px;"
        )
    w = max(4, min(_GANTT_BAR_PX, int(_GANTT_BAR_PX * min(ms, _GANTT_MAX_MS) / _GANTT_MAX_MS)))
    return (
        f"background: {fill}; min-height: 10px; max-height: 10px; "
        f"border-radius: 2px; min-width: {w}px; max-width: {w}px;"
    )


# ===============================================================
# StepWidget — 单步表单（无顶栏按钮；由 StepOutlineFrame 提供大纲行）
# ===============================================================

class StepWidget(QFrame):
    """编辑一个 CutsceneStep。"""

    contentChanged = Signal()

    def __init__(
        self,
        step: dict,
        model: ProjectModel | None = None,
        editor: "TimelineEditor | None" = None,
        parent: QWidget | None = None,
        *,
        parallel_parent: StepWidget | None = None,
        cutscene_id: str | None = None,
    ):
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self._model = model
        self._editor = editor
        self._parallel_parent = parallel_parent
        self._cutscene_id = (cutscene_id or "") or None
        self._outline_frame: StepOutlineFrame | None = None
        self._child_outlines: list[StepOutlineFrame] = []
        self._widgets: dict[str, QWidget] = {}
        self._action_row: ActionRow | None = None
        self._parallel_layout: QVBoxLayout | None = None
        self._parallel_group: QGroupBox | None = None

        kind = str(step.get("kind", "present"))
        self._step_data = deepcopy(step)
        self._original_data = deepcopy(step)

        lay = QVBoxLayout(self)
        lay.setContentsMargins(4, 4, 4, 4)

        # kind selector
        top = QHBoxLayout()
        self._kind_combo = QComboBox()
        self._kind_combo.addItem("present", "present")
        self._kind_combo.addItem("action", "action")
        self._kind_combo.addItem("parallel", "parallel")
        for i in range(self._kind_combo.count()):
            if self._kind_combo.itemData(i) == kind:
                self._kind_combo.setCurrentIndex(i)
                break
        self._kind_combo.currentIndexChanged.connect(self._on_kind_changed)
        top.addWidget(QLabel("kind:"))
        top.addWidget(self._kind_combo, stretch=1)
        lay.addLayout(top)

        self._body = QVBoxLayout()
        lay.addLayout(self._body)

        self._rebuild(kind)

    def _on_parallel_child_changed(self) -> None:
        of = self._outline_frame
        if of is not None:
            of.refresh_header()

    def _find_owning_outlines_and_layout(self):
        if self._parallel_parent is not None:
            return self._parallel_parent._child_outlines, self._parallel_parent._parallel_layout
        if self._editor is not None:
            return self._editor._step_outlines, self._editor._steps_layout
        return None, None

    def _emit_dirty(self) -> None:
        self.contentChanged.emit()
        if self._editor is not None and hasattr(self._editor, "mark_pending_changes"):
            self._editor.mark_pending_changes()
        if self._parallel_parent is not None:
            self._parallel_parent._on_parallel_child_changed()

    def _on_kind_changed(self) -> None:
        new_kind = self._kind_combo.currentData()
        self._step_data = {"kind": new_kind}
        if new_kind == "present":
            self._step_data["type"] = "waitClick"
        elif new_kind == "action":
            self._step_data["type"] = CUTSCENE_ACTION_WHITELIST[0]
            self._step_data["params"] = {}
        elif new_kind == "parallel":
            self._step_data["tracks"] = []
        self._rebuild(new_kind)
        self._emit_dirty()
        if self._outline_frame:
            self._outline_frame.refresh_header()

    def _clear_body(self) -> None:
        for ol in self._child_outlines:
            ol.deleteLater()
        self._child_outlines.clear()
        self._widgets.clear()
        self._action_row = None
        self._parallel_layout = None
        self._parallel_group = None
        while self._body.count() > 0:
            item = self._body.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()
            sub = item.layout()
            if sub:
                while sub.count() > 0:
                    si = sub.takeAt(0)
                    sw = si.widget()
                    if sw:
                        sw.deleteLater()

    def _rebuild(self, kind: str) -> None:
        self._clear_body()
        if kind == "present":
            self._build_present()
        elif kind == "action":
            self._build_action()
        elif kind == "parallel":
            self._build_parallel()

    def _build_present(self) -> None:
        form = QFormLayout()
        self._type_combo = FilterableTypeCombo(
            [(t, t) for t in PRESENT_TYPES],
            orphan_label=lambda v: f"[unknown] {v}",
            select_only=True,
        )
        cur_type = str(self._step_data.get("type", "waitClick"))
        self._type_combo.set_committed_type(cur_type)
        self._type_combo.typeCommitted.connect(self._on_present_type_changed)
        form.addRow("type", self._type_combo)

        self._present_params_layout = QFormLayout()
        form_w = QWidget()
        form_w.setLayout(form)
        self._body.addWidget(form_w)
        params_w = QWidget()
        params_w.setLayout(self._present_params_layout)
        self._body.addWidget(params_w)

        self._rebuild_present_params(cur_type)

    def _on_present_type_changed(self) -> None:
        new_type = self._type_combo.committed_type()
        self._step_data = {"kind": "present", "type": new_type}
        self._rebuild_present_params(new_type)
        self._emit_dirty()
        if self._outline_frame:
            self._outline_frame.refresh_header()

    def _rebuild_present_params(self, ptype: str) -> None:
        while self._present_params_layout.rowCount() > 0:
            self._present_params_layout.removeRow(0)
        self._widgets.clear()

        if ptype == "showDialogue":
            cur_sid = str(self._step_data.get("scriptedNpcId", "") or "")
            wdg = CutsceneShowDialogueFields(
                self._model,
                None,
                str(self._step_data.get("speaker", "") or ""),
                str(self._step_data.get("text", "") or ""),
                cur_sid,
                self,
                on_change=self._emit_dirty,
            )
            self._widgets["__showDialogue__"] = wdg
            self._present_params_layout.addRow(wdg)
            return

        if ptype == "cameraMove":
            self._build_camera_move_present_params()
            return

        if ptype == "showSubtitle":
            self._build_show_subtitle_present_params()
            return

        if ptype == "showImg":
            self._build_show_img_present_params()
            return

        if ptype == "hideImg":
            self._build_hide_img_present_params()
            return

        schema = _PRESENT_PARAMS.get(ptype, [])
        for pname, pt in schema:
            val = self._step_data.get(pname, "")
            label = f"{pname} (ms)" if pt == "float" and pname in _MS_KEYS else pname
            if pt == "float":
                w = QDoubleSpinBox()
                w.setRange(-99999, 99999)
                w.setDecimals(2)
                w.setValue(float(val) if val != "" else 0)
                w.valueChanged.connect(self._emit_dirty)
            elif pt == "bool":
                w = QCheckBox()
                w.setChecked(bool(val) if val != "" else True)
                w.toggled.connect(self._emit_dirty)
            elif pt == "text":
                w = QTextEdit(str(val))
                w.setMaximumHeight(50)
                w.textChanged.connect(self._emit_dirty)
            elif pt == "image":
                w = CutsceneImagePathRow(self._model, str(val) if val else "", self)
                w.setMinimumWidth(360)
                w._edit.textChanged.connect(self._emit_dirty)
            else:
                w = QLineEdit(str(val) if val else "")
                w.textChanged.connect(self._emit_dirty)
            self._widgets[pname] = w
            self._present_params_layout.addRow(label, w)

    def _build_camera_move_present_params(self) -> None:
        """cameraMove：x/y 可手输，也可用绑定场景地图点选。"""
        val_x = self._step_data.get("x", "")
        val_y = self._step_data.get("y", "")
        val_dur = self._step_data.get("duration", "")
        sx = QDoubleSpinBox()
        sx.setRange(-99999, 99999)
        sx.setDecimals(2)
        sx.setValue(float(val_x) if val_x != "" else 0.0)
        sx.valueChanged.connect(self._emit_dirty)
        sy = QDoubleSpinBox()
        sy.setRange(-99999, 99999)
        sy.setDecimals(2)
        sy.setValue(float(val_y) if val_y != "" else 0.0)
        sy.valueChanged.connect(self._emit_dirty)
        sd = QDoubleSpinBox()
        sd.setRange(0, 999999)
        sd.setDecimals(2)
        sd.setValue(float(val_dur) if val_dur != "" else 1000.0)
        sd.valueChanged.connect(self._emit_dirty)

        row = QWidget()
        hl = QHBoxLayout(row)
        hl.setContentsMargins(0, 0, 0, 0)
        hl.addWidget(QLabel("x"))
        hl.addWidget(sx, 1)
        hl.addWidget(QLabel("y"))
        hl.addWidget(sy, 1)
        pick = QPushButton("地图选点…")
        pick.setToolTip(
            "在过场顶部「targetScene」绑定的场景背景上点击，写入 x / y 世界坐标。"
        )
        pick.clicked.connect(self._on_pick_camera_move_point)
        hl.addWidget(pick)
        self._widgets["x"] = sx
        self._widgets["y"] = sy
        self._widgets["duration"] = sd
        self._present_params_layout.addRow("目标位置（世界坐标）", row)
        self._present_params_layout.addRow("duration (ms)", sd)

    def _on_pick_camera_move_point(self) -> None:
        ed = self._editor
        model = self._model
        if ed is None or model is None:
            QMessageBox.warning(self, "选点", "未绑定编辑器或工程模型。")
            return
        sid = ""
        if hasattr(ed, "cutscene_binding_target_scene"):
            sid = ed.cutscene_binding_target_scene()
        sid = str(sid or "").strip()
        if not sid:
            QMessageBox.information(
                self,
                "过场",
                "请先在过场表单中设置「targetScene」，再在地图上选取镜头目标点。",
            )
            return
        if sid not in model.scenes:
            QMessageBox.warning(
                self,
                "选点",
                f"场景「{sid}」未载入工程，无法打开预览。请检查 ID 或过场绑定。",
            )
            return
        wx_w = self._widgets.get("x")
        wy_w = self._widgets.get("y")
        if not isinstance(wx_w, QDoubleSpinBox) or not isinstance(wy_w, QDoubleSpinBox):
            return
        dlg = CutsceneCameraPointPickerDialog(
            model, sid, float(wx_w.value()), float(wy_w.value()), self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            px, py = dlg.picked_xy()
            wx_w.setValue(float(px))
            wy_w.setValue(float(py))
            self._emit_dirty()

    def _subtitle_on_present_mode_changed(self) -> None:
        combo = self._widgets.get("_subtitle_mode")
        spin = self._widgets.get("_subtitle_frac")
        if isinstance(combo, FilterableTypeCombo) and isinstance(spin, QDoubleSpinBox):
            spin.setVisible(combo.committed_type().strip() == "__num__")
        self._emit_dirty()

    def _build_show_subtitle_present_params(self) -> None:
        raw_txt = self._step_data.get("text", "")
        raw_pos = self._step_data.get("position", "bottom")

        tw = QTextEdit(str(raw_txt))
        tw.setMinimumHeight(64)
        tw.setMaximumHeight(120)
        tw.textChanged.connect(self._emit_dirty)

        mode_rows = [
            ("顶部 · top", "top"),
            ("居中 · center", "center"),
            ("底部 · bottom", "bottom"),
            ("纵向 0–1 比例 …", "__num__"),
        ]
        cw = FilterableTypeCombo(mode_rows, self, select_only=True)

        frac = QDoubleSpinBox(self)
        frac.setRange(0.0, 1.0)
        frac.setDecimals(4)
        frac.setSingleStep(0.05)
        frac.setToolTip(
            "与运行时 CutsceneRenderer 一致：0–1 映射到屏上纵向位置。"
        )

        rp = raw_pos
        if isinstance(rp, bool):
            cw.set_committed_type("bottom")
            frac.setValue(0.5)
        elif isinstance(rp, (int, float)):
            cw.set_committed_type("__num__")
            fv = float(rp)
            frac.setValue(max(0.0, min(1.0, fv)))
        else:
            s = str(rp).strip().lower()
            if s in ("top", "center", "bottom"):
                cw.set_committed_type(s)
                frac.setValue(0.5)
            else:
                try:
                    fv = float(s)
                    cw.set_committed_type("__num__")
                    frac.setValue(max(0.0, min(1.0, fv)))
                except (TypeError, ValueError):
                    cw.set_committed_type("bottom")
                    frac.setValue(0.5)

        frac.valueChanged.connect(self._emit_dirty)
        cw.typeCommitted.connect(self._subtitle_on_present_mode_changed)

        row = QWidget(self)
        lay = QHBoxLayout(row)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(cw, 1)
        lay.addWidget(frac)
        row.setToolTip("预设三档或屏幕纵向数值；与运行时 showSubtitle(position) 对齐。")

        self._widgets["text"] = tw
        self._widgets["_subtitle_mode"] = cw
        self._widgets["_subtitle_frac"] = frac
        self._present_params_layout.addRow("text", tw)
        self._present_params_layout.addRow("position", row)
        self._subtitle_on_present_mode_changed()

    def _build_show_img_present_params(self) -> None:
        pool_s: set[str] = set()
        pool_h: set[str] = set()
        ed = self._editor
        if ed is not None and hasattr(ed, "_outline_overlay_show_and_hide_sets"):
            pool_s, pool_h = ed._outline_overlay_show_and_hide_sets()

        uni = sorted(pool_s | pool_h, key=lambda x: (x.lower(), x))
        committed = str(self._step_data.get("id", "") or "").strip()
        orphan = (f"{committed} · 仅此数据引用") if committed else "未命名"
        sel = IdRefSelector(self, allow_empty=True, editable=True)
        sel.setMinimumWidth(220)
        if ed is not None and hasattr(ed, "_merged_overlay_rows"):
            rows_u = ed._merged_overlay_rows(uni, committed, orphan)
        else:
            rows_u = [(x, x) for x in uni]
            if committed and committed not in {x[0] for x in rows_u}:
                rows_u.append((committed, orphan))
        if not rows_u:
            rows_u = [("img", "img")]
        sel.set_items(rows_u)
        sel.set_current(committed)
        sel.value_changed.connect(self._emit_dirty)
        sel.setToolTip(
            "与 hideImg 配对；下拉为步骤树中出现的 id（可再行内输入）。"
        )

        img = CutsceneImagePathRow(self._model, str(self._step_data.get("image") or ""), self)
        img.setMinimumWidth(320)
        img._edit.textChanged.connect(self._emit_dirty)

        self._widgets["id"] = sel
        self._widgets["image"] = img
        self._present_params_layout.addRow("id", sel)
        self._present_params_layout.addRow("image", img)

    def _build_hide_img_present_params(self) -> None:
        pool_s: set[str] = set()
        ed = self._editor
        if ed is not None and hasattr(ed, "_outline_overlay_show_and_hide_sets"):
            pool_s, _ = ed._outline_overlay_show_and_hide_sets()

        uni_show = sorted(pool_s, key=lambda x: (x.lower(), x))
        committed = str(self._step_data.get("id", "") or "").strip()
        orphan = (f"{committed} · 先于 showImg") if committed else "未命名"
        sel = IdRefSelector(self, allow_empty=True, editable=True)
        sel.setMinimumWidth(220)
        if ed is not None and hasattr(ed, "_merged_overlay_rows"):
            rows_u = ed._merged_overlay_rows(uni_show, committed, orphan)
        else:
            rows_u = [(x, x) for x in uni_show]
            if committed and committed not in {x[0] for x in rows_u}:
                rows_u.append((committed, orphan))
        if not rows_u:
            rows_u = [("main", "main")]
        sel.set_items(rows_u)
        sel.set_current(committed)
        sel.value_changed.connect(self._emit_dirty)
        sel.setToolTip("选需隐藏的叠图 id（候选项为本步骤树内 showImg id）")

        self._widgets["id"] = sel
        self._present_params_layout.addRow("id", sel)

    def _ctx_scene_for_cutscene_actions(self) -> str | None:
        ed = self._editor
        if ed is None or not hasattr(ed, "cutscene_binding_target_scene"):
            return None
        s = ed.cutscene_binding_target_scene().strip()
        return s if s else None

    def _build_action(self) -> None:
        ad = {
            "type": str(self._step_data.get("type", CUTSCENE_ACTION_WHITELIST[0])),
            "params": dict(self._step_data.get("params") or {}),
        }
        self._action_row = ActionRow(
            ad,
            model=self._model,
            scene_id=self._ctx_scene_for_cutscene_actions(),
            show_delete_button=False,
            show_reorder_buttons=False,
            parent=self,
            cutscene_id=self._cutscene_id,
        )
        wl_set = set(CUTSCENE_ACTION_WHITELIST)
        self._action_row.type_combo.set_items(
            [(t, t) for t in CUTSCENE_ACTION_WHITELIST],
            orphan_label=lambda v: f"{v} · 过场白名单外",
        )
        ct = ad["type"]
        if ct in wl_set:
            self._action_row.type_combo.set_committed_type(ct)
        self._action_row.changed.connect(self._emit_dirty)
        self._body.addWidget(self._action_row)

    def _build_parallel(self) -> None:
        group = QGroupBox("并行轨（fork-join，齐后继续）")
        group.setStyleSheet("QGroupBox { font-weight: bold; }")
        self._parallel_group = group
        self._parallel_layout = QVBoxLayout(group)
        self._parallel_layout.setSpacing(4)
        tracks = self._step_data.get("tracks", []) or []
        for i, t in enumerate(tracks):
            ol = StepOutlineFrame(
                t, self._model, self._editor, group,
                indent_px=16,
                parallel_parent=self,
                zebra_alt=(i % 2 == 1),
                cutscene_id=self._cutscene_id,
            )
            self._child_outlines.append(ol)
            ol.contentChanged.connect(self._on_parallel_child_changed)
            self._parallel_layout.addWidget(ol)
        add_btn = QPushButton("+ Track")
        add_btn.clicked.connect(self._add_parallel_track)
        self._parallel_layout.addWidget(add_btn)
        self._body.addWidget(group)

    def _add_parallel_track(self) -> None:
        if self._parallel_layout is None:
            return
        data = {"kind": "present", "type": "waitTime", "duration": 1000}
        ol = StepOutlineFrame(
            data, self._model, self._editor,
            self._parallel_group,
            indent_px=16,
            parallel_parent=self,
            zebra_alt=(len(self._child_outlines) % 2 == 1),
            cutscene_id=self._cutscene_id,
        )
        self._child_outlines.append(ol)
        ol.contentChanged.connect(self._on_parallel_child_changed)
        self._parallel_layout.insertWidget(self._parallel_layout.count() - 1, ol)
        self._emit_dirty()
        if self._outline_frame:
            self._outline_frame.refresh_header()

    def to_dict(self) -> dict:
        kind = self._kind_combo.currentData()

        if kind == "action" and self._action_row is not None:
            ad = self._action_row.to_dict()
            return {"kind": "action", "type": ad["type"], "params": ad.get("params", {})}

        if kind == "present":
            ptype = self._type_combo.committed_type()
            schema = _PRESENT_PARAMS.get(ptype, [])
            if not schema and ptype not in PRESENT_TYPES:
                base = deepcopy(self._original_data) if self._original_data.get("kind") == "present" else {}
                base["kind"] = "present"
                base["type"] = ptype
                return base
            d: dict = {"kind": "present", "type": ptype}
            if ptype == "showDialogue":
                wdg = self._widgets.get("__showDialogue__")
                if isinstance(wdg, CutsceneShowDialogueFields):
                    d.update(wdg.to_step_dict())
                return d
            if ptype == "showSubtitle":
                wt = self._widgets.get("text")
                cw = self._widgets.get("_subtitle_mode")
                frac = self._widgets.get("_subtitle_frac")
                txt = (
                    wt.toPlainText().strip("\ufeff") if hasattr(wt, "toPlainText") else ""
                )
                po: Any = "bottom"
                if isinstance(cw, FilterableTypeCombo):
                    pv = cw.committed_type().strip()
                    if pv == "__num__" and isinstance(frac, QDoubleSpinBox):
                        po = float(frac.value())
                    else:
                        po = pv
                d.update({"kind": "present", "type": "showSubtitle", "text": txt, "position": po})
                return d
            for pname, pt in schema:
                w = self._widgets.get(pname)
                if w is None:
                    continue
                if pt == "float":
                    d[pname] = w.value()
                elif pt == "bool":
                    d[pname] = w.isChecked()
                elif pt == "text":
                    d[pname] = w.toPlainText()
                elif pt == "image" and isinstance(w, CutsceneImagePathRow):
                    d[pname] = w.path()
                elif isinstance(w, IdRefSelector):
                    d[pname] = w.current_id().strip()
                else:
                    d[pname] = w.text() if hasattr(w, "text") else str(w)
            return d

        if kind == "parallel":
            return {
                "kind": "parallel",
                "tracks": [ol.to_dict() for ol in self._child_outlines],
            }

        return {"kind": kind}


# ===============================================================
# StepOutlineFrame — 大纲行 + 可折叠详情
# ===============================================================

class StepOutlineFrame(QFrame):
    """竖排大纲中的一行：色条、摘要、估算时长/甘特、折叠详情。"""

    contentChanged = Signal()

    def __init__(
        self,
        step: dict,
        model: ProjectModel | None,
        editor: "TimelineEditor",
        parent: QWidget | None = None,
        *,
        indent_px: int = 0,
        parallel_parent: StepWidget | None = None,
        zebra_alt: bool = False,
        cutscene_id: str | None = None,
    ):
        super().__init__(parent)
        self._model = model
        self._editor = editor
        self._parallel_parent = parallel_parent
        self._indent_px = indent_px
        self._zebra_alt = zebra_alt
        self._collapsed = False
        self._cutscene_id = (cutscene_id or "") or None

        root = QVBoxLayout(self)
        root.setContentsMargins(self._indent_px, 2, 0, 2)
        root.setSpacing(0)

        self._header = QFrame()
        self._header.setObjectName("cutsceneStepHeader")
        hl = QHBoxLayout(self._header)
        hl.setContentsMargins(4, 4, 4, 4)
        hl.setSpacing(6)

        self._strip = QLabel()
        self._strip.setFixedWidth(6)
        hl.addWidget(self._strip)

        self._idx_lbl = QLabel("—")
        self._idx_lbl.setFixedWidth(28)
        self._idx_lbl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        fmono = QFont("Consolas")
        fmono.setStyleHint(QFont.StyleHint.Monospace)
        self._idx_lbl.setFont(fmono)
        hl.addWidget(self._idx_lbl)

        self._badge = QLabel()
        self._badge.setMargin(4)
        bf = self._badge.font()
        bf.setBold(True)
        self._badge.setFont(bf)
        hl.addWidget(self._badge)

        self._summary = QLabel()
        self._summary.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        self._summary.setWordWrap(True)
        hl.addWidget(self._summary, stretch=1)

        self._dur_lbl = QLabel("")
        self._dur_lbl.setFixedWidth(56)
        self._dur_lbl.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self._dur_lbl.setToolTip("估算耗时（仅供参考）")
        hl.addWidget(self._dur_lbl)

        self._gantt = QLabel()
        self._gantt.setFixedSize(_GANTT_BAR_PX + 8, 14)
        self._gantt.setScaledContents(False)
        self._gantt.setToolTip("相对时长（只读，仅供参考）")
        hl.addWidget(self._gantt)

        self._btn_up = QPushButton("\u2191")
        self._btn_up.setFixedWidth(26)
        self._btn_up.setToolTip("上移")
        self._btn_down = QPushButton("\u2193")
        self._btn_down.setFixedWidth(26)
        self._btn_down.setToolTip("下移")
        self._btn_copy = QPushButton("Copy")
        self._btn_copy.setToolTip("复制")
        self._btn_del = QPushButton("Del")
        self._btn_del.setToolTip("删除")
        hl.addWidget(self._btn_up)
        hl.addWidget(self._btn_down)
        hl.addWidget(self._btn_copy)
        hl.addWidget(self._btn_del)

        self._menu_btn = QToolButton()
        self._menu_btn.setText("\u22ee")
        self._menu_btn.setToolTip("并行移入/移出等")
        self._menu_btn.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self._menu_btn.setFixedWidth(28)
        self._step_menu = QMenu(self._menu_btn)
        self._menu_btn.setMenu(self._step_menu)
        self._step_menu.aboutToShow.connect(self._populate_step_menu)
        hl.addWidget(self._menu_btn)

        self._expand = QToolButton()
        self._expand.setArrowType(Qt.ArrowType.DownArrow)
        self._expand.setToolTip("折叠/展开详情")
        self._expand.clicked.connect(self._toggle_collapse)
        hl.addWidget(self._expand)

        for w in (self._strip, self._idx_lbl, self._badge, self._summary, self._dur_lbl, self._gantt):
            w.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)

        root.addWidget(self._header)
        self._header.installEventFilter(self)

        self._detail_wrap = QWidget()
        dl = QVBoxLayout(self._detail_wrap)
        dl.setContentsMargins(8, 4, 4, 4)
        self._step = StepWidget(
            step, model, editor, self._detail_wrap,
            parallel_parent=parallel_parent,
            cutscene_id=self._cutscene_id,
        )
        self._step._outline_frame = self
        dl.addWidget(self._step)
        root.addWidget(self._detail_wrap)

        self._btn_up.clicked.connect(lambda: self._do_move(-1))
        self._btn_down.clicked.connect(lambda: self._do_move(1))
        self._btn_copy.clicked.connect(self._do_copy)
        self._btn_del.clicked.connect(self._do_delete)
        self._step.contentChanged.connect(self._on_step_content_changed)

        self.refresh_header()

    def to_dict(self) -> dict:
        return self._step.to_dict()

    def set_row_index(self, idx: int) -> None:
        self._idx_lbl.setText(str(idx))

    def set_zebra_alt(self, alt: bool) -> None:
        self._zebra_alt = alt
        self._refresh_header_surface()

    def _editor_theme_id(self) -> str:
        tid = getattr(self._editor, "_theme_id", None)
        if tid in app_theme.ALL_THEME_IDS:
            return str(tid)
        return app_theme.current_theme_id()

    def _refresh_header_surface(self) -> None:
        tid = self._editor_theme_id()
        kind = str(self._step.to_dict().get("kind", "present"))
        if app_theme.is_dark_theme(tid):
            border = "#454b54"
            if kind == "action":
                even, odd = "#273040", "#2f3848"
            elif kind == "parallel":
                even, odd = "#302838", "#3a3242"
            else:
                even, odd = "#2b2f36", "#343a42"
        else:
            border = "#dee2e6"
            if kind == "action":
                even, odd = "#eef5ff", "#e3edfd"
            elif kind == "parallel":
                even, odd = "#f3edfb", "#ebe3f5"
            else:
                even, odd = "#ffffff", "#f1f3f5"
        bg = odd if self._zebra_alt else even
        self._header.setStyleSheet(
            f"QFrame#cutsceneStepHeader {{ background-color: {bg}; border-bottom: 1px solid {border}; }}"
        )

    def _kind_palette(self, kind: str, theme_id: str) -> tuple[str, str, str]:
        """strip, badge_bg, badge_fg"""
        if app_theme.is_dark_theme(theme_id):
            if kind == "action":
                return "#4dabf7", "#1864ab", "#ffffff"
            if kind == "parallel":
                return "#9775fa", "#5f3dc4", "#ffffff"
            return "#51cf66", "#2f9e44", "#ffffff"
        if kind == "action":
            return "#0d6efd", "#cfe2ff", "#084298"
        if kind == "parallel":
            return "#6f42c1", "#e2d9f3", "#432874"
        return "#198754", "#d1e7dd", "#0f5132"

    def refresh_header(self) -> None:
        tid = self._editor_theme_id()
        d = self._step.to_dict()
        kind = str(d.get("kind", "present"))
        self._refresh_header_surface()
        sp, bb, bf = self._kind_palette(kind, tid)
        self._strip.setStyleSheet(f"background-color: {sp}; border-radius: 2px;")
        labels = {"present": "PRESENT", "action": "ACTION", "parallel": "PARALLEL"}
        self._badge.setText(labels.get(kind, kind.upper()))
        self._badge.setStyleSheet(
            f"background-color: {bb}; color: {bf}; border-radius: 4px; padding: 2px 6px;"
        )
        primary = "#dcdcdc" if app_theme.is_dark_theme(tid) else "#1a1a1a"
        muted = "#a0a0a0" if app_theme.is_dark_theme(tid) else "#666666"
        self._idx_lbl.setStyleSheet(f"color: {muted};")
        self._summary.setStyleSheet(f"color: {primary};")
        self._dur_lbl.setStyleSheet(f"color: {muted};")
        if kind == "parallel":
            tracks = [ol.to_dict() for ol in self._step._child_outlines]
            summ = parallel_tracks_summary(tracks)
        else:
            summ = step_summary_line(d)
        self._summary.setText(summ)

        est = estimate_step_duration_ms(d)
        self._dur_lbl.setText(format_duration_hint(est))
        self._gantt.setStyleSheet(gantt_style_for_ms(est, tid))

    def _on_step_content_changed(self) -> None:
        self.refresh_header()
        self.contentChanged.emit()

    def eventFilter(self, watched: QObject, event: QEvent) -> bool:
        if watched is self._header and event.type() == QEvent.Type.MouseButtonRelease:
            me = event
            if isinstance(me, QMouseEvent) and me.button() == Qt.MouseButton.LeftButton:
                self._toggle_collapse()
                return True
        return super().eventFilter(watched, event)

    def set_collapsed(self, collapsed: bool, *, refresh: bool = True) -> None:
        self._collapsed = collapsed
        self._detail_wrap.setVisible(not collapsed)
        self._expand.setArrowType(
            Qt.ArrowType.RightArrow if collapsed else Qt.ArrowType.DownArrow
        )
        if refresh:
            self.refresh_header()

    def _toggle_collapse(self) -> None:
        self.set_collapsed(not self._collapsed)

    def _get_owner_list_and_layout(self):
        if self._parallel_parent is not None:
            return self._parallel_parent._child_outlines, self._parallel_parent._parallel_layout
        return self._editor._step_outlines, self._editor._steps_layout

    def _do_move(self, delta: int) -> None:
        lst, layout = self._get_owner_list_and_layout()
        if lst is None or layout is None:
            return
        try:
            i = lst.index(self)
        except ValueError:
            return
        j = i + delta
        if j < 0 or j >= len(lst):
            return
        lst[i], lst[j] = lst[j], lst[i]
        for w in lst:
            layout.removeWidget(w)
        for w in lst:
            layout.addWidget(w)
        self._editor._refresh_outline_indices_and_zebra()
        self._emit_dirty()

    def _do_copy(self) -> None:
        lst, layout = self._get_owner_list_and_layout()
        if lst is None or layout is None:
            return
        try:
            i = lst.index(self)
        except ValueError:
            return
        data = deepcopy(self.to_dict())
        parent_host: QWidget = (
            self._parallel_parent._parallel_group
            if self._parallel_parent is not None and self._parallel_parent._parallel_group is not None
            else self._editor._steps_container
        )
        new_ol = StepOutlineFrame(
            data, self._model, self._editor,
            parent_host,
            indent_px=self._indent_px,
            parallel_parent=self._parallel_parent,
            zebra_alt=(len(lst) % 2 == 1),
            cutscene_id=self._cutscene_id,
        )
        new_ol.contentChanged.connect(self._editor._on_any_outline_changed)
        lst.insert(i + 1, new_ol)
        for w in lst:
            layout.removeWidget(w)
        for w in lst:
            layout.addWidget(w)
        self._editor._refresh_outline_indices_and_zebra()
        self._emit_dirty()

    def _do_delete(self) -> None:
        lst, layout = self._get_owner_list_and_layout()
        if lst is None or layout is None:
            return
        try:
            lst.remove(self)
        except ValueError:
            return
        layout.removeWidget(self)
        self.deleteLater()
        self._editor._refresh_outline_indices_and_zebra()
        self._emit_dirty()

    def _emit_dirty(self) -> None:
        self._editor.mark_pending_changes()
        self.contentChanged.emit()

    def _populate_step_menu(self) -> None:
        ed = self._editor
        m = self._step_menu
        m.clear()

        a_lift = QAction("从并行移出到外层（插在该并行块之后）", self)
        a_lift.setEnabled(self._parallel_parent is not None)
        a_lift.triggered.connect(lambda: ed.lift_parallel_track_out(self))
        m.addAction(a_lift)

        m.addSeparator()

        a_adj = QAction("与下一项合并为并行（两项 fork-join）", self)
        a_adj.setEnabled(ed.can_merge_adjacent_into_parallel(self))
        a_adj.triggered.connect(lambda: ed.merge_adjacent_into_parallel(self))
        m.addAction(a_adj)

        a_prev = QAction("并入上一并行（作为最后一轨）", self)
        a_prev.setEnabled(ed.can_merge_into_prev_parallel(self))
        a_prev.triggered.connect(lambda: ed.merge_into_prev_parallel(self))
        m.addAction(a_prev)

        a_next = QAction("并入下一并行（作为第一轨）", self)
        a_next.setEnabled(ed.can_merge_into_next_parallel(self))
        a_next.triggered.connect(lambda: ed.merge_into_next_parallel(self))
        m.addAction(a_next)


# ===============================================================
# TimelineEditor — 主 Tab
# ===============================================================

class TimelineEditor(QWidget):
    play_requested = Signal(str)

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx: int = -1
        self._pending_changes = False
        self._loading_ui = False
        self._step_outlines: list[StepOutlineFrame] = []
        self._theme_id: str = app_theme.current_theme_id()

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ 过场")
        btn_add.clicked.connect(self._add)
        btn_del = QPushButton("Delete")
        btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add)
        btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)

        right = QWidget()
        rl = QVBoxLayout(right)

        top_row = QHBoxLayout()
        f = QFormLayout()
        self._c_id = QLineEdit()
        f.addRow("id", self._c_id)
        top_row.addLayout(f, stretch=1)
        self._play_btn = QPushButton("Play")
        self._play_btn.setToolTip("在游戏预览中播放该过场")
        self._play_btn.clicked.connect(self._on_play)
        top_row.addWidget(self._play_btn)
        rl.addLayout(top_row)

        bind_form = QFormLayout()
        self._target_scene = IdRefSelector(self, allow_empty=True, editable=False)
        self._target_scene.setMinimumWidth(240)
        self._target_scene.setToolTip(
            "从项目已加载场景列表选择；若 JSON 中已有但工程未载入的场景，会显示为「未在项目场景表中」。"
        )
        self._refresh_target_scene_combo_items("")
        bind_form.addRow("targetScene", self._target_scene)

        self._spawn_key = ""
        self._spawn_loading = False
        spawn_row = QWidget()
        spawn_lay = QHBoxLayout(spawn_row)
        spawn_lay.setContentsMargins(0, 0, 0, 0)
        self._spawn_display = QLineEdit()
        self._spawn_display.setReadOnly(True)
        self._spawn_display.setPlaceholderText("点击右侧按钮在场景预览中选择...")
        spawn_lay.addWidget(self._spawn_display, 1)
        self._spawn_pick_btn = QPushButton("选择出生点...")
        self._spawn_pick_btn.clicked.connect(self._open_spawn_picker)
        spawn_lay.addWidget(self._spawn_pick_btn)
        bind_form.addRow("targetSpawnPoint", spawn_row)
        self._target_scene.value_changed.connect(self._on_target_scene_changed)

        pos_row = QHBoxLayout()
        self._pos_chk = QCheckBox("targetX/Y")
        self._target_x = QDoubleSpinBox()
        self._target_x.setRange(-99999, 99999)
        self._target_x.setDecimals(1)
        self._target_y = QDoubleSpinBox()
        self._target_y.setRange(-99999, 99999)
        self._target_y.setDecimals(1)
        self._target_x.setEnabled(False)
        self._target_y.setEnabled(False)
        self._pos_chk.toggled.connect(self._target_x.setEnabled)
        self._pos_chk.toggled.connect(self._target_y.setEnabled)
        pos_row.addWidget(self._pos_chk)
        pos_row.addWidget(QLabel("X:"))
        pos_row.addWidget(self._target_x)
        pos_row.addWidget(QLabel("Y:"))
        pos_row.addWidget(self._target_y)
        bind_form.addRow(pos_row)

        self._restore_chk = QCheckBox("restoreState")
        self._restore_chk.setChecked(True)
        self._restore_chk.setToolTip("过场结束后是否恢复进入前的场景与玩家位置")
        bind_form.addRow(self._restore_chk)

        rl.addLayout(bind_form)

        hint_row = QHBoxLayout()
        hint = QLabel(
            "<b>步骤序列</b>（竖排 = 执行顺序；PRESENT / ACTION / PARALLEL 色条区分；"
            "点击表头空白或摘要可折叠/展开详情；右侧「不定/~ms」与灰条为粗估，仅供参考；"
            "「⋯」菜单：并行轨移出到外层、两项合并为并行、并入上/下一并行）"
        )
        hint.setWordWrap(True)
        hint_row.addWidget(hint, stretch=1)
        btn_collapse_all = QPushButton("全部折叠")
        btn_collapse_all.setToolTip("折叠本过场所有步骤（含并行子轨）")
        btn_collapse_all.clicked.connect(lambda: self._set_all_step_collapsed(True))
        btn_expand_all = QPushButton("全部展开")
        btn_expand_all.setToolTip("展开本过场所有步骤（含并行子轨）")
        btn_expand_all.clicked.connect(lambda: self._set_all_step_collapsed(False))
        hint_row.addWidget(btn_collapse_all)
        hint_row.addWidget(btn_expand_all)
        rl.addLayout(hint_row)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        self._steps_container = QWidget()
        self._steps_layout = QVBoxLayout(self._steps_container)
        self._steps_layout.setSpacing(2)
        scroll.setWidget(self._steps_container)
        rl.addWidget(scroll, stretch=1)

        step_btns = QHBoxLayout()
        add_present = QPushButton("+ Present")
        add_present.clicked.connect(lambda: self._add_step("present"))
        add_action = QPushButton("+ Action")
        add_action.clicked.connect(lambda: self._add_step("action"))
        add_parallel = QPushButton("+ Parallel")
        add_parallel.clicked.connect(lambda: self._add_step("parallel"))
        step_btns.addWidget(add_present)
        step_btns.addWidget(add_action)
        step_btns.addWidget(add_parallel)
        rl.addLayout(step_btns)

        apply_btn = QPushButton("Apply")
        apply_btn.clicked.connect(self._apply)
        rl.addWidget(apply_btn)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([220, 700])
        root.addWidget(splitter)

        self._refresh()
        self._model.data_changed.connect(self._on_model_data_changed)

        self._c_id.textChanged.connect(self.mark_pending_changes)
        self._target_scene.value_changed.connect(self.mark_pending_changes)
        self._pos_chk.toggled.connect(self.mark_pending_changes)
        self._target_x.valueChanged.connect(self.mark_pending_changes)
        self._target_y.valueChanged.connect(self.mark_pending_changes)
        self._restore_chk.toggled.connect(self.mark_pending_changes)

    def on_editor_theme_changed(self, theme_id: str) -> None:
        self._theme_id = theme_id
        self._refresh_outline_indices_and_zebra()

    def _iter_all_step_outlines(self):
        def walk(ol: StepOutlineFrame):
            yield ol
            if ol._step._kind_combo.currentData() == "parallel":
                for c in ol._step._child_outlines:
                    yield from walk(c)

        for top in self._step_outlines:
            yield from walk(top)

    def _set_all_step_collapsed(self, collapsed: bool) -> None:
        for ol in self._iter_all_step_outlines():
            ol.set_collapsed(collapsed, refresh=False)

    def _on_any_outline_changed(self) -> None:
        self._refresh_outline_indices_and_zebra()
        self._refresh_all_present_overlay_id_selectors()

    def _refresh_outline_indices_and_zebra(self) -> None:
        for i, ol in enumerate(self._step_outlines):
            ol.set_row_index(i + 1)
            ol.set_zebra_alt(i % 2 == 1)
            ol.refresh_header()
        self._refresh_parallel_track_zebra()

    def _refresh_parallel_track_zebra(self) -> None:
        for top in self._step_outlines:
            self._zebra_descendant_tracks(top._step)

    def _zebra_descendant_tracks(self, sw: StepWidget) -> None:
        if sw._kind_combo.currentData() != "parallel":
            return
        for i, ol in enumerate(sw._child_outlines):
            ol.set_zebra_alt(i % 2 == 1)
            ol.refresh_header()
            self._zebra_descendant_tracks(ol._step)

    def _on_model_data_changed(self, data_type: str, _item_id: str) -> None:
        if data_type != "scene":
            return
        if self._loading_ui:
            return
        if self._current_idx < 0:
            return
        self._refresh_target_scene_combo_items(self._target_scene.current_id().strip())

    def mark_pending_changes(self, *args) -> None:
        if self._loading_ui:
            return
        self._pending_changes = True

    def _scene_dropdown_rows(self, orphan_if_missing: str) -> list[tuple[str, str]]:
        """(id, 展示名)：含场景 name；孤儿 targetScene 保留一项以免无法表示未入库引用。"""
        rows: list[tuple[str, str]] = []
        seen: set[str] = set()
        for sid in sorted(self._model.all_scene_ids()):
            seen.add(sid)
            sc = self._model.scenes.get(sid) or {}
            label = sc.get("name") or sid
            rows.append((sid, str(label)))
        o = (orphan_if_missing or "").strip()
        if o and o not in seen:
            rows.append((o, f"{o} · 未在项目场景表中"))
        return rows

    def _refresh_target_scene_combo_items(self, committed: str) -> None:
        self._target_scene.set_items(self._scene_dropdown_rows(committed))
        self._target_scene.set_current((committed or "").strip())

    def has_pending_changes(self) -> bool:
        return self._pending_changes

    def confirm_apply_or_discard(self, parent: QWidget) -> str:
        if not self._pending_changes or self._current_idx < 0:
            return "proceed"
        r = QMessageBox.question(
            parent,
            "过场",
            "当前过场有未 Apply 的修改，如何处理？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
            QMessageBox.StandardButton.Save,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return "cancel"
        if r == QMessageBox.StandardButton.Save:
            if not self._apply():
                return "cancel"
        else:
            self._pending_changes = False
        return "proceed"

    def _refresh(self) -> None:
        self._list.clear()
        for c in self._model.cutscenes:
            self._list.addItem(c.get("id", "?"))

    def _on_target_scene_changed(self, sid: str) -> None:
        if self._spawn_loading:
            return
        if not sid:
            self._spawn_key = ""
            self._refresh_spawn_display()
            self._propagate_cutscene_scene_to_action_rows()
            return
        sc = self._model.scenes.get(sid)
        if sc and self._spawn_key:
            if self._spawn_key not in (sc.get("spawnPoints") or {}):
                self._spawn_key = ""
        self._refresh_spawn_display()
        self._propagate_cutscene_scene_to_action_rows()

    def _refresh_spawn_display(self) -> None:
        sid = self._target_scene.current_id()
        if not sid:
            self._spawn_display.setText("")
            self._spawn_pick_btn.setEnabled(False)
            return
        self._spawn_pick_btn.setEnabled(True)
        if not self._spawn_key:
            self._spawn_display.setText("默认 (spawnPoint)")
        else:
            self._spawn_display.setText(self._spawn_key)

    def _open_spawn_picker(self) -> None:
        sid = self._target_scene.current_id()
        if not sid:
            QMessageBox.information(self, "过场", "请先选择目标场景。")
            return
        dlg = TargetSpawnPickerDialog(self._model, sid, self._spawn_key, self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            self._spawn_key = dlg.selected_spawn_key()
            self._refresh_spawn_display()
            self.mark_pending_changes()

    def _on_select(self, row: int) -> None:
        old = self._current_idx
        if old >= 0 and row >= 0 and old != row and self._pending_changes:
            r = QMessageBox.question(
                self, "过场",
                "当前过场有未 Apply 的修改，切换前如何处理？",
                QMessageBox.StandardButton.Save
                | QMessageBox.StandardButton.Discard
                | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Save,
            )
            if r == QMessageBox.StandardButton.Cancel:
                self._list.blockSignals(True)
                self._list.setCurrentRow(old)
                self._list.blockSignals(False)
                return
            if r == QMessageBox.StandardButton.Save:
                if not self._apply():
                    self._list.blockSignals(True)
                    self._list.setCurrentRow(old)
                    self._list.blockSignals(False)
                    return
            else:
                self._pending_changes = False

        if row < 0 or row >= len(self._model.cutscenes):
            return
        self._loading_ui = True
        try:
            self._current_idx = row
            cs = self._model.cutscenes[row]
            self._c_id.setText(cs.get("id", ""))
            self._spawn_loading = True
            try:
                self._spawn_key = (cs.get("targetSpawnPoint") or "").strip()
                committed = str(cs.get("targetScene") or "").strip()
                self._refresh_target_scene_combo_items(committed)
            finally:
                self._spawn_loading = False
            self._refresh_spawn_display()
            has_pos = "targetX" in cs and "targetY" in cs
            self._pos_chk.setChecked(has_pos)
            self._target_x.setValue(float(cs.get("targetX", 0)))
            self._target_y.setValue(float(cs.get("targetY", 0)))
            self._restore_chk.setChecked(cs.get("restoreState", True))
            self._rebuild_steps(cs.get("steps", []))
            self._pending_changes = False
        finally:
            self._loading_ui = False

    def _rebuild_steps(self, steps: list[dict]) -> None:
        for ol in self._step_outlines:
            self._steps_layout.removeWidget(ol)
            ol.deleteLater()
        self._step_outlines.clear()
        cid = self._current_cutscene_id()
        for i, step in enumerate(steps):
            ol = StepOutlineFrame(
                step, self._model, self, self._steps_container,
                indent_px=0,
                parallel_parent=None,
                zebra_alt=(i % 2 == 1),
                cutscene_id=cid,
            )
            ol.contentChanged.connect(self._on_any_outline_changed)
            self._step_outlines.append(ol)
            self._steps_layout.addWidget(ol)
        self._refresh_outline_indices_and_zebra()

    def _current_cutscene_id(self) -> str | None:
        if 0 <= self._current_idx < len(self._model.cutscenes):
            cid = str(self._model.cutscenes[self._current_idx].get("id", "")).strip()
            return cid or None
        return None

    def cutscene_binding_target_scene(self) -> str:
        """当前过场绑定的场景 ID。

        载入 UI 中与磁盘对齐；绑定表单可操作且未载入时一律以控件为准（含未 Apply 修改），
        以便 action 的 NPC 列表与表单一致。
        """
        if (
            self._current_idx < 0
            or self._current_idx >= len(self._model.cutscenes)
        ):
            return ""
        if getattr(self, "_loading_ui", False):
            return str(
                self._model.cutscenes[self._current_idx].get("targetScene") or "",
            ).strip()
        ts = getattr(self, "_target_scene", None)
        if ts is not None:
            return ts.current_id().strip()
        return str(
            self._model.cutscenes[self._current_idx].get("targetScene") or "",
        ).strip()

    def _outline_overlay_show_and_hide_sets(self) -> tuple[set[str], set[str]]:
        """基于当前编辑器内步骤快照（含未 Apply），收集 showImg / hideImg 的 overlay id。"""
        show_ids: set[str] = set()
        hide_ids: set[str] = set()
        for ol in self._step_outlines:
            self._walk_collect_overlay_ids(ol.to_dict(), show_ids, hide_ids)
        return show_ids, hide_ids

    @staticmethod
    def _walk_collect_overlay_ids(step: dict, show_ids: set[str], hide_ids: set[str]) -> None:
        if not isinstance(step, dict):
            return
        k = str(step.get("kind", ""))
        if k == "present":
            t = str(step.get("type", ""))
            oid = str(step.get("id") or "").strip()
            if oid:
                if t == "showImg":
                    show_ids.add(oid)
                elif t == "hideImg":
                    hide_ids.add(oid)
            return
        if k == "parallel":
            for tr in step.get("tracks") or []:
                TimelineEditor._walk_collect_overlay_ids(tr, show_ids, hide_ids)

    def _merged_overlay_rows(
        self, pool_sorted: list[str], committed: str, orphan_hint: str,
    ) -> list[tuple[str, str]]:
        seen: set[str] = set()
        rows: list[tuple[str, str]] = []
        for i in pool_sorted:
            if i and i not in seen:
                seen.add(i)
                rows.append((i, i))
        c = committed.strip()
        if c and c not in seen:
            rows.append((c, orphan_hint))
        return rows

    def _propagate_cutscene_scene_to_action_rows(self) -> None:
        """绑定 targetScene 变更后刷新各 action 的 NPC/target 下拉候选项。"""
        if getattr(self, "_loading_ui", False):
            return
        sid_raw = self.cutscene_binding_target_scene()
        sid_n = sid_raw if sid_raw else None
        cid = self._current_cutscene_id()
        for ol in self._iter_all_step_outlines():
            sw = getattr(ol, "_step", None)
            if sw is None:
                continue
            ar = getattr(sw, "_action_row", None)
            if isinstance(ar, ActionRow):
                ar.set_project_context(self._model, sid_n, cutscene_id=cid)

    def _refresh_all_present_overlay_id_selectors(self) -> None:
        """步骤树变化后刷新 showImg / hideImg 的 id 下拉候选项。"""
        if getattr(self, "_loading_ui", False):
            return
        show_set, hide_set = self._outline_overlay_show_and_hide_sets()
        show_sorted = sorted(show_set, key=lambda x: (x.lower(), x))
        union_sorted = sorted(
            show_set | hide_set, key=lambda x: (x.lower(), x),
        )
        for ol in self._iter_all_step_outlines():
            sw = ol._step
            if sw._kind_combo.currentData() != "present":
                continue
            ptype = sw._type_combo.committed_type()
            if ptype not in ("showImg", "hideImg"):
                continue
            sel = sw._widgets.get("id")
            if not isinstance(sel, IdRefSelector):
                continue
            cur = sel.current_id().strip()
            if ptype == "showImg":
                hint = (
                    (f"{cur} · 仅本条数据引用")
                    if cur else "(空 id)"
                )
                rows = self._merged_overlay_rows(union_sorted, cur, hint)
            else:
                hint = (
                    (f"{cur} · hide 先于 showImg 或缺同名 showImg")
                    if cur else "(空 id)"
                )
                rows = self._merged_overlay_rows(show_sorted, cur, hint)
            sel.blockSignals(True)
            try:
                sel.set_items(rows)
                sel.set_current(cur)
            finally:
                sel.blockSignals(False)

    def _add_step(self, kind: str) -> None:
        if kind == "present":
            data = {"kind": "present", "type": "waitClick"}
        elif kind == "action":
            data = {"kind": "action", "type": CUTSCENE_ACTION_WHITELIST[0], "params": {}}
        elif kind == "parallel":
            data = {"kind": "parallel", "tracks": []}
        else:
            data = {"kind": kind}
        ol = StepOutlineFrame(
            data, self._model, self, self._steps_container,
            indent_px=0,
            parallel_parent=None,
            zebra_alt=(len(self._step_outlines) % 2 == 1),
            cutscene_id=self._current_cutscene_id(),
        )
        ol.contentChanged.connect(self._on_any_outline_changed)
        self._step_outlines.append(ol)
        self._steps_layout.addWidget(ol)
        self._refresh_outline_indices_and_zebra()
        self.mark_pending_changes()

    def _apply(self) -> bool:
        if self._current_idx < 0:
            return False
        steps = [ol.to_dict() for ol in self._step_outlines]

        cs = self._model.cutscenes[self._current_idx]
        cs["id"] = self._c_id.text().strip()

        scene = self._target_scene.current_id()
        if scene:
            cs["targetScene"] = scene
        else:
            cs.pop("targetScene", None)

        spawn = self._spawn_key.strip()
        if spawn:
            cs["targetSpawnPoint"] = spawn
        else:
            cs.pop("targetSpawnPoint", None)

        if self._pos_chk.isChecked():
            cs["targetX"] = self._target_x.value()
            cs["targetY"] = self._target_y.value()
        else:
            cs.pop("targetX", None)
            cs.pop("targetY", None)

        if not self._restore_chk.isChecked():
            cs["restoreState"] = False
        else:
            cs.pop("restoreState", None)

        cs["steps"] = steps
        cs.pop("commands", None)
        self._model.mark_dirty("cutscene")
        self._pending_changes = False
        self._refresh()
        if 0 <= self._current_idx < self._list.count():
            self._list.setCurrentRow(self._current_idx)
        return True

    def _add(self) -> None:
        self._model.cutscenes.append({
            "id": f"cutscene_{len(self._model.cutscenes)}",
            "steps": [],
        })
        self._model.mark_dirty("cutscene")
        self._pending_changes = False
        self._refresh()

    def _on_play(self) -> None:
        cid = self._c_id.text().strip()
        if cid:
            self.play_requested.emit(cid)

    # ----- 并行结构：移出 / 并入（供 StepOutlineFrame 菜单调用） -----

    def outline_list_and_layout(self, ol: StepOutlineFrame) -> tuple[list[Any], Any]:
        """包含 ol 所在大纲行的列表与纵向 layout（顶层 steps 或某一 parallel 的子轨）。"""
        if ol._parallel_parent is None:
            return self._step_outlines, self._steps_layout
        pw = ol._parallel_parent
        return pw._child_outlines, pw._parallel_layout

    def lift_parallel_track_out(self, child_ol: StepOutlineFrame) -> None:
        """将并行中的一轨移到外层，插在该 parallel 步骤之后（同级）；若并行因此为空则删掉该 parallel。"""
        pw = child_ol._parallel_parent
        if pw is None or pw._outline_frame is None or pw._parallel_layout is None:
            return
        par_ol = pw._outline_frame
        lst, layout = self.outline_list_and_layout(par_ol)
        try:
            idx_par = lst.index(par_ol)
        except ValueError:
            return
        try:
            idx_ch = pw._child_outlines.index(child_ol)
        except ValueError:
            return
        data = deepcopy(child_ol.to_dict())
        pw._child_outlines.pop(idx_ch)
        pw._parallel_layout.removeWidget(child_ol)
        child_ol.deleteLater()

        host = par_ol.parentWidget()
        if host is None:
            host = self._steps_container
        cid = self._current_cutscene_id()
        new_ol = StepOutlineFrame(
            data, self._model, self, host,
            indent_px=par_ol._indent_px,
            parallel_parent=par_ol._parallel_parent,
            zebra_alt=False,
            cutscene_id=cid,
        )
        new_ol.contentChanged.connect(self._on_any_outline_changed)
        lst.insert(idx_par + 1, new_ol)
        self._relayout_outline_list(lst, layout)

        if not pw._child_outlines:
            lst2, layout2 = self.outline_list_and_layout(par_ol)
            try:
                lst2.remove(par_ol)
            except ValueError:
                pass
            if layout2 is not None:
                layout2.removeWidget(par_ol)
            par_ol.deleteLater()
            if layout2 is not None:
                self._relayout_outline_list(lst2, layout2)

        self._refresh_outline_indices_and_zebra()
        self.mark_pending_changes()

    def _relayout_outline_list(self, lst: list[Any], layout: Any) -> None:
        for w in lst:
            layout.removeWidget(w)
        for w in lst:
            layout.addWidget(w)

    def can_merge_adjacent_into_parallel(self, ol: StepOutlineFrame) -> bool:
        if ol._step._kind_combo.currentData() == "parallel":
            return False
        lst, _ = self.outline_list_and_layout(ol)
        try:
            i = lst.index(ol)
        except ValueError:
            return False
        if i + 1 >= len(lst):
            return False
        return lst[i + 1]._step._kind_combo.currentData() != "parallel"

    def merge_adjacent_into_parallel(self, ol: StepOutlineFrame) -> None:
        """当前项与下一项（须均为 present/action）合并为一个 parallel（两轨）。"""
        if not self.can_merge_adjacent_into_parallel(ol):
            return
        lst, layout = self.outline_list_and_layout(ol)
        i = lst.index(ol)
        ol_next = lst[i + 1]
        d1 = deepcopy(ol.to_dict())
        d2 = deepcopy(ol_next.to_dict())
        pdata = {"kind": "parallel", "tracks": [d1, d2]}
        host = ol.parentWidget() or self._steps_container
        indent = ol._indent_px
        pp = ol._parallel_parent
        cid = self._current_cutscene_id()

        lst.pop(i + 1)
        lst.pop(i)
        layout.removeWidget(ol_next)
        layout.removeWidget(ol)
        ol_next.deleteLater()
        ol.deleteLater()

        new_par = StepOutlineFrame(
            pdata, self._model, self, host,
            indent_px=indent,
            parallel_parent=pp,
            zebra_alt=False,
            cutscene_id=cid,
        )
        new_par.contentChanged.connect(self._on_any_outline_changed)
        lst.insert(i, new_par)
        self._relayout_outline_list(lst, layout)
        self._refresh_outline_indices_and_zebra()
        self.mark_pending_changes()

    def can_merge_into_prev_parallel(self, ol: StepOutlineFrame) -> bool:
        if ol._step._kind_combo.currentData() == "parallel":
            return False
        lst, _ = self.outline_list_and_layout(ol)
        try:
            i = lst.index(ol)
        except ValueError:
            return False
        if i == 0:
            return False
        return lst[i - 1]._step._kind_combo.currentData() == "parallel"

    def merge_into_prev_parallel(self, ol: StepOutlineFrame) -> None:
        if not self.can_merge_into_prev_parallel(ol):
            return
        lst, layout = self.outline_list_and_layout(ol)
        i = lst.index(ol)
        prev_ol = lst[i - 1]
        data = deepcopy(ol.to_dict())
        lst.pop(i)
        layout.removeWidget(ol)
        ol.deleteLater()

        par_sw = prev_ol._step
        self._append_track_to_parallel(par_sw, data)
        prev_ol.refresh_header()
        self._relayout_outline_list(lst, layout)
        self._refresh_outline_indices_and_zebra()
        self.mark_pending_changes()

    def can_merge_into_next_parallel(self, ol: StepOutlineFrame) -> bool:
        if ol._step._kind_combo.currentData() == "parallel":
            return False
        lst, _ = self.outline_list_and_layout(ol)
        try:
            i = lst.index(ol)
        except ValueError:
            return False
        if i + 1 >= len(lst):
            return False
        return lst[i + 1]._step._kind_combo.currentData() == "parallel"

    def merge_into_next_parallel(self, ol: StepOutlineFrame) -> None:
        if not self.can_merge_into_next_parallel(ol):
            return
        lst, layout = self.outline_list_and_layout(ol)
        i = lst.index(ol)
        next_ol = lst[i + 1]
        data = deepcopy(ol.to_dict())
        lst.pop(i)
        layout.removeWidget(ol)
        ol.deleteLater()

        par_sw = next_ol._step
        self._prepend_track_to_parallel(par_sw, data)
        next_ol.refresh_header()
        self._relayout_outline_list(lst, layout)
        self._refresh_outline_indices_and_zebra()
        self.mark_pending_changes()

    def _append_track_to_parallel(self, par_sw: StepWidget, data: dict) -> StepOutlineFrame:
        assert par_sw._parallel_layout is not None and par_sw._parallel_group is not None
        cid = self._current_cutscene_id()
        ol = StepOutlineFrame(
            deepcopy(data), self._model, self,
            par_sw._parallel_group,
            indent_px=16,
            parallel_parent=par_sw,
            zebra_alt=(len(par_sw._child_outlines) % 2 == 1),
            cutscene_id=cid,
        )
        ol.contentChanged.connect(self._on_any_outline_changed)
        par_sw._child_outlines.append(ol)
        par_sw._parallel_layout.insertWidget(par_sw._parallel_layout.count() - 1, ol)
        par_sw._on_parallel_child_changed()
        return ol

    def _prepend_track_to_parallel(self, par_sw: StepWidget, data: dict) -> StepOutlineFrame:
        assert par_sw._parallel_layout is not None and par_sw._parallel_group is not None
        cid = self._current_cutscene_id()
        ol = StepOutlineFrame(
            deepcopy(data), self._model, self,
            par_sw._parallel_group,
            indent_px=16,
            parallel_parent=par_sw,
            zebra_alt=False,
            cutscene_id=cid,
        )
        ol.contentChanged.connect(self._on_any_outline_changed)
        par_sw._child_outlines.insert(0, ol)
        par_sw._parallel_layout.insertWidget(0, ol)
        par_sw._on_parallel_child_changed()
        return ol

    def _delete(self) -> None:
        if self._current_idx >= 0:
            self._model.cutscenes.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("cutscene")
            self._pending_changes = False
            self._refresh()
