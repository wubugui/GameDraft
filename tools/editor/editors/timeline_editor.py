"""过场（Cutscene）步骤序列编辑器 — `steps` schema（present / action / parallel）。

数据为自上而下顺序执行 + parallel fork-join，非 NLE 多轨时间轴。
"""
from __future__ import annotations

import json
from copy import deepcopy
from typing import TYPE_CHECKING

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton, QLabel,
    QScrollArea, QCheckBox, QDoubleSpinBox, QFrame, QMessageBox,
    QDialog, QGroupBox, QToolButton, QSizePolicy,
)
from PySide6.QtCore import Qt, Signal, QEvent, QObject
from PySide6.QtGui import QFont, QMouseEvent

from ..project_model import ProjectModel
from .. import theme as app_theme
from ..shared.id_ref_selector import IdRefSelector
from ..shared.image_path_picker import CutsceneImagePathRow
from ..shared.action_editor import ActionRow, FilterableTypeCombo
from .scene_editor import TargetSpawnPickerDialog

if TYPE_CHECKING:
    pass

# ---------------------------------------------------------------
# Cutscene Action whitelist（须与 src/data/types.ts CUTSCENE_ACTION_WHITELIST 一致）
# ---------------------------------------------------------------
CUTSCENE_ACTION_WHITELIST = [
    "moveEntityTo", "faceEntity", "cutsceneSpawnActor", "cutsceneRemoveActor",
    "showEmoteAndWait", "playNpcAnimation", "setEntityEnabled",
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
    "showDialogue": [("speaker", "str"), ("text", "text")],
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
    ):
        super().__init__(parent)
        self.setFrameShape(QFrame.Shape.NoFrame)
        self._model = model
        self._editor = editor
        self._parallel_parent = parallel_parent
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

    def _build_action(self) -> None:
        ad = {
            "type": str(self._step_data.get("type", CUTSCENE_ACTION_WHITELIST[0])),
            "params": dict(self._step_data.get("params") or {}),
        }
        self._action_row = ActionRow(
            ad,
            model=self._model,
            scene_id=None,
            show_delete_button=False,
            show_reorder_buttons=False,
            parent=self,
        )
        wl_set = set(CUTSCENE_ACTION_WHITELIST)
        self._action_row.type_combo.set_items(
            [(t, t) for t in CUTSCENE_ACTION_WHITELIST],
            orphan_label=lambda v: f"[not whitelisted] {v}",
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
    ):
        super().__init__(parent)
        self._model = model
        self._editor = editor
        self._parallel_parent = parallel_parent
        self._indent_px = indent_px
        self._zebra_alt = zebra_alt
        self._collapsed = False

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
        self._step = StepWidget(step, model, editor, self._detail_wrap, parallel_parent=parallel_parent)
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
        self._target_scene = IdRefSelector(self, allow_empty=True)
        self._target_scene.setMinimumWidth(200)
        if self._model:
            self._target_scene.set_items(
                [("", "(none)")] + [(s, s) for s in self._model.all_scene_ids()])
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
            "点击表头空白或摘要可折叠/展开详情；右侧「不定/~ms」与灰条为粗估，仅供参考）"
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
        pass

    def mark_pending_changes(self, *args) -> None:
        if self._loading_ui:
            return
        self._pending_changes = True

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
            return
        sc = self._model.scenes.get(sid)
        if sc and self._spawn_key:
            if self._spawn_key not in (sc.get("spawnPoints") or {}):
                self._spawn_key = ""
        self._refresh_spawn_display()
        self.mark_pending_changes()

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
                self._target_scene.set_current(cs.get("targetScene", "") or "")
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
        for i, step in enumerate(steps):
            ol = StepOutlineFrame(
                step, self._model, self, self._steps_container,
                indent_px=0,
                parallel_parent=None,
                zebra_alt=(i % 2 == 1),
            )
            ol.contentChanged.connect(self._on_any_outline_changed)
            self._step_outlines.append(ol)
            self._steps_layout.addWidget(ol)
        self._refresh_outline_indices_and_zebra()

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

    def _delete(self) -> None:
        if self._current_idx >= 0:
            self._model.cutscenes.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("cutscene")
            self._pending_changes = False
            self._refresh()
