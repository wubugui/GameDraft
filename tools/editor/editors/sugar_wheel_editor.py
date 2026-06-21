"""糖画转盘小游戏编辑器：实例 JSON + 画布预览（背景 / 轮盘 / 指针）。"""
from __future__ import annotations

import json
import math
import re
from typing import Any

from PySide6.QtCore import QPointF, Qt, QRectF, Signal
from PySide6.QtGui import QBrush, QColor, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QAbstractItemView,
    QAbstractSpinBox,
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QGraphicsEllipseItem,
    QGraphicsItem,
    QGraphicsPixmapItem,
    QGraphicsScene,
    QGraphicsSceneWheelEvent,
    QGraphicsSimpleTextItem,
    QGraphicsView,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QGroupBox,
    QSpinBox,
    QSplitter,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.action_editor import ActionEditor
from ..shared.collapsible_section import CollapsibleSection
from ..shared.form_layout import compact_form
from ..shared.image_path_picker import CutsceneImagePathRow, disk_path_for_runtime_url


_ID_RE = re.compile(r"^[a-zA-Z][a-zA-Z0-9_\-]{0,63}$")
_DEFAULT_BG = "/resources/runtime/images/minigames/sugar_wheel/sugar_stall_table_bg.png"
_DEFAULT_FOREGROUND = "/resources/runtime/images/minigames/sugar_wheel/sugar_crowd_overlay.png"
_DEFAULT_WHEEL = "/resources/runtime/images/minigames/sugar_wheel/sugar_zodiac_wheel_carved_dragon_monkey_fixed.png"
_DEFAULT_POINTER = "/resources/runtime/images/minigames/sugar_wheel/sugar_zodiac_pointer.png"


def _load_runtime_pixmap(model: ProjectModel | None, url: str) -> QPixmap | None:
    """糖画图素：仅接受 ``/resources/runtime/...`` 媒体 URL（或 runtime 树下的短名）。"""
    u = (url or "").strip()
    if not u:
        return None
    p = disk_path_for_runtime_url(model, u)
    if p is None or not p.is_file():
        return None
    pm = QPixmap(str(p))
    return pm if not pm.isNull() else None


def _num(raw: Any, fallback: float) -> float:
    try:
        n = float(raw)
    except (TypeError, ValueError):
        return fallback
    return n if n == n and n not in (float("inf"), float("-inf")) else fallback


def _preview_wheel_radius_px(doc: dict, scene_w: float, scene_h: float) -> float:
    """与画布 refresh 中盘面半径算法一致（半轴长 R），供表单默认蓄力偏移预览。"""
    max_pct = max(0.2, min(1.0, _num(doc.get("wheelMaxSizePercent"), 0.72)))
    max_px = max(64.0, _num(doc.get("wheelMaxSizePx"), 660))
    size = max(160.0, min(scene_w * max_pct, scene_h * 0.72, max_px))
    size *= max(0.1, min(3.0, _num(doc.get("wheelScale"), 1)))
    return size / 2


# 与运行时 SugarWheelMinigameScene 默认锚点一致；JSON 无 speechAnchors 时画布仍显示可拖圆点。
_SPEECH_ANCHOR_PRESETS: list[dict[str, Any]] = [
    {"role": "child_a", "label": "小孩", "xRatio": 0.08, "yRatio": 0.72, "tailDirection": "down"},
    {"role": "child_b", "label": "小孩", "xRatio": 0.25, "yRatio": 0.70, "tailDirection": "down"},
    {"role": "child_c", "label": "小孩", "xRatio": 0.62, "yRatio": 0.72, "tailDirection": "down"},
    {"role": "child_d", "label": "小孩", "xRatio": 0.82, "yRatio": 0.70, "tailDirection": "down"},
    {"role": "protagonist", "label": "", "xRatio": 0.50, "yRatio": 0.92, "tailDirection": "none"},
    {"role": "stall_owner", "label": "摊主", "xRatio": 0.22, "yRatio": 0.12, "tailDirection": "up"},
]


def _merge_speech_anchors_for_canvas(doc: dict) -> list[dict[str, Any]]:
    by_role: dict[str, dict[str, Any]] = {}
    raw = doc.get("speechAnchors")
    if isinstance(raw, list):
        for a in raw:
            if isinstance(a, dict) and str(a.get("role") or "").strip():
                rid = str(a["role"]).strip()
                by_role[rid] = dict(a)
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for tmpl in _SPEECH_ANCHOR_PRESETS:
        rid = str(tmpl["role"])
        seen.add(rid)
        merged = {**tmpl, **by_role.get(rid, {})}
        merged["role"] = rid
        out.append(merged)
    for rid, a in by_role.items():
        if rid not in seen:
            out.append(dict(a))
    return out


class _SugarWheelMovablePixmap(QGraphicsPixmapItem):
    """可拖动项；松开后由画布写回 wheel / pointer 偏移。"""

    def __init__(self, canvas: SugarWheelCanvas, role: str) -> None:
        super().__init__()
        self._canvas = canvas
        self._role = role
        self.setFlags(
            self.GraphicsItemFlag.ItemIsMovable
            | self.GraphicsItemFlag.ItemSendsGeometryChanges
        )

    def itemChange(self, change: QGraphicsItem.GraphicsItemChange, value: Any) -> Any:  # noqa: ANN401
        res = super().itemChange(change, value)
        if (
            change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged
            and not self._canvas._move_silent
        ):
            self._canvas._after_move(self._role)
        return res


class _SugarWheelSpeechAnchorItem(QGraphicsEllipseItem):
    """可拖动的气泡锚点（屏上比例坐标）。"""

    def __init__(self, canvas: SugarWheelCanvas, role: str, caption: str) -> None:
        super().__init__(-13, -13, 26, 26)
        self._canvas = canvas
        self._role = role
        self.setFlags(
            QGraphicsItem.GraphicsItemFlag.ItemIsMovable
            | QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges
        )
        is_prota = role == "protagonist"
        is_owner = role == "stall_owner"
        if is_prota:
            col = QColor(255, 210, 120, 220)
            pen = QColor(255, 230, 160)
        elif is_owner:
            col = QColor(130, 200, 255, 200)
            pen = QColor(180, 230, 255)
        else:
            col = QColor(255, 180, 90, 210)
            pen = QColor(255, 220, 150)
        self.setBrush(QBrush(col))
        self.setPen(QPen(pen, 2))
        self.setToolTip(f"气泡锚点 role={role}\n拖动调整 xRatio/yRatio（与右侧表同步）")
        lab = caption.strip() or role
        txt = QGraphicsSimpleTextItem(lab, self)
        txt.setBrush(QBrush(QColor(250, 245, 230)))
        br = txt.boundingRect()
        txt.setPos(-br.width() / 2, -br.height() - 4)

    def itemChange(self, change: QGraphicsItem.GraphicsItemChange, value: Any) -> Any:  # noqa: ANN401
        res = super().itemChange(change, value)
        if (
            change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged
            and not self._canvas._move_silent
        ):
            self._canvas._after_speech_anchor_move(self._role)
        return res


class _SugarWheelChargeButtonItem(QGraphicsEllipseItem):
    """可拖动的蓄力圆；Ctrl+滚轮调直径。"""

    def __init__(self, canvas: "SugarWheelCanvas") -> None:
        super().__init__()
        self._canvas = canvas
        self._d = 52.0
        self.setFlags(
            QGraphicsItem.GraphicsItemFlag.ItemIsMovable
            | QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges
        )
        self.setBrush(QBrush(QColor(88, 120, 188, 210)))
        self.setPen(QPen(QColor(190, 220, 255), 2))
        self._label = QGraphicsSimpleTextItem("蓄", self)
        self._label.setBrush(QBrush(QColor(250, 245, 230)))
        br = self._label.boundingRect()
        self._label.setPos(-br.width() / 2, -br.height() / 2)
        self._apply_rect()
        self.setToolTip(
            "蓄力按钮：拖动 = 圆心相对盘心的像素偏移（chargeButtonWheelOffsetX/Y）\n"
            "Ctrl + 滚轮 = 直径（chargeButtonDiameterPx）"
        )
        self.setAcceptHoverEvents(True)

    def _apply_rect(self) -> None:
        h = self._d / 2
        self.setRect(-h, -h, self._d, self._d)
        sc = max(0.45, min(1.5, self._d / 52.0))
        self._label.setScale(sc)

    def diameter(self) -> float:
        return self._d

    def set_diameter(self, d: float, *, silent: bool = False) -> None:
        d = max(28.0, min(160.0, float(d)))
        self._d = d
        self._apply_rect()
        if not silent:
            self._canvas._after_charge_adjust()

    def itemChange(self, change: QGraphicsItem.GraphicsItemChange, value: Any) -> Any:  # noqa: ANN401
        res = super().itemChange(change, value)
        if (
            change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged
            and not self._canvas._move_silent
        ):
            self._canvas._after_charge_adjust()
        return res

    def wheelEvent(self, event: QGraphicsSceneWheelEvent) -> None:
        if event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            ad = event.angleDelta().y()
            delta = 4.0 if ad > 0 else -4.0 if ad < 0 else 0.0
            if delta != 0:
                self.set_diameter(self._d + delta)
            event.accept()
            return
        super().wheelEvent(event)


class SugarWheelCanvas(QWidget):
    """QGraphicsView 预览：背景先画，转盘居中，指针按 anchorY 旋转锚点对齐中心。"""

    layout_offsets_changed = Signal(float, float, float, float)
    speech_anchor_changed = Signal(str, float, float)
    charge_button_changed = Signal(float, float, float)

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._scene = QGraphicsScene(self)
        self._view = QGraphicsView(self._scene, self)
        self._view.setRenderHints(QPainter.RenderHint.Antialiasing | QPainter.RenderHint.SmoothPixmapTransform)
        self._view.setViewportUpdateMode(QGraphicsView.ViewportUpdateMode.FullViewportUpdate)
        self._view.setMinimumSize(380, 320)  # 画布有 fit/缩放，缩小下限以适配 13"
        self._btn_fit = QPushButton("适应窗口")
        self._btn_fit.setToolTip("将预览缩放到适应窗口大小")
        self._btn_fit.clicked.connect(self._fit)

        self._wheel_item: _SugarWheelMovablePixmap | None = None
        self._pointer_item: _SugarWheelMovablePixmap | None = None
        self._layout_cx_cy: tuple[float, float] | None = None
        self._px = 0.0
        self._py = 0.0
        self._move_silent = False
        self._speech_anchor_items: dict[str, _SugarWheelSpeechAnchorItem] = {}
        self._charge_item: _SugarWheelChargeButtonItem | None = None
        self._charge_ox = 0.0
        self._charge_oy = 0.0

        bar = QHBoxLayout()
        bar.addWidget(self._btn_fit)
        _preview_hint = QLabel("预览")
        _preview_hint.setToolTip(
            "预览：背景→转盘→指针→前景→蓄力圆(蓝)→气泡锚点；"
            "可拖盘面/指针/蓄力圆/彩色圆点；蓄力圆 Ctrl+滚轮调直径"
        )
        bar.addWidget(_preview_hint)
        bar.addStretch()

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addLayout(bar)
        root.addWidget(self._view, stretch=1)

    def resizeEvent(self, event) -> None:  # noqa: ANN001
        super().resizeEvent(event)
        self._fit()

    def refresh(self, doc: dict | None) -> None:
        self._wheel_item = None
        self._pointer_item = None
        self._layout_cx_cy = None
        self._speech_anchor_items = {}
        self._scene.clear()
        self._scene.setSceneRect(QRectF(0, 0, 960, 720))
        self._scene.setBackgroundBrush(QBrush(QColor(5, 5, 9)))
        if not isinstance(doc, dict):
            self._draw_empty()
            self._fit()
            return

        r = self._scene.sceneRect()
        bg_pm = _load_runtime_pixmap(self._model, str(doc.get("backgroundImage") or ""))
        if bg_pm is not None:
            fit = str(doc.get("backgroundFit") or "cover")
            scale = (
                min(r.width() / max(1, bg_pm.width()), r.height() / max(1, bg_pm.height()))
                if fit == "contain"
                else max(r.width() / max(1, bg_pm.width()), r.height() / max(1, bg_pm.height()))
            )
            item = QGraphicsPixmapItem(bg_pm)
            item.setScale(scale)
            item.setPos((r.width() - bg_pm.width() * scale) / 2, (r.height() - bg_pm.height() * scale) / 2)
            item.setZValue(0)
            self._scene.addItem(item)
        else:
            self._draw_missing("backgroundImage", QRectF(0, 0, r.width(), r.height()), 0)

        wheel_pm = _load_runtime_pixmap(self._model, str(doc.get("wheelImage") or ""))
        pointer_pm = _load_runtime_pixmap(self._model, str(doc.get("pointerImage") or ""))
        cx = r.width() / 2
        cy = r.height() / 2
        wx = _num(doc.get("wheelCenterOffsetXPx"), 0)
        wy = _num(doc.get("wheelCenterOffsetYPx"), 0)
        px_off = _num(doc.get("pointerOffsetXPx"), 0)
        py_off = _num(doc.get("pointerOffsetYPx"), 0)
        self._layout_cx_cy = (cx, cy)
        self._px = px_off
        self._py = py_off
        max_pct = max(0.2, min(1.0, _num(doc.get("wheelMaxSizePercent"), 0.72)))
        max_px = max(64.0, _num(doc.get("wheelMaxSizePx"), 660))
        size = max(160.0, min(r.width() * max_pct, r.height() * 0.72, max_px))
        size *= max(0.1, min(3.0, _num(doc.get("wheelScale"), 1)))

        wheel_scale = 1.0
        if wheel_pm is not None:
            wheel_scale = size / max(1, wheel_pm.width(), wheel_pm.height())
            item = _SugarWheelMovablePixmap(self, "wheel")
            item.setPixmap(wheel_pm)
            item.setOffset(-wheel_pm.width() / 2, -wheel_pm.height() / 2)
            item.setScale(wheel_scale)
            item.setPos(cx + wx, cy + wy)
            item.setZValue(10)
            item.setToolTip("拖动：盘面中心相对画布中心的偏移（wheelCenterOffsetX/Y）")
            self._scene.addItem(item)
            self._wheel_item = item
        else:
            self._draw_missing("wheelImage", QRectF(cx - size / 2, cy - size / 2, size, size), 10)

        if pointer_pm is not None and self._wheel_item is not None:
            anchor_x = max(0.0, min(1.0, _num(doc.get("pointerAnchorX"), 0.5)))
            anchor_y = max(0.0, min(1.0, _num(doc.get("pointerAnchorY"), 0.9)))
            p_scale = wheel_scale * max(0.1, min(3.0, _num(doc.get("pointerScale"), 1)))
            ptr = _SugarWheelMovablePixmap(self, "pointer")
            ptr.setPixmap(pointer_pm)
            ptr.setOffset(-pointer_pm.width() * anchor_x, -pointer_pm.height() * anchor_y)
            ptr.setScale(p_scale)
            wpos = self._wheel_item.pos()
            ptr.setPos(wpos.x() + px_off, wpos.y() + py_off)
            ptr.setZValue(20)
            ptr.setToolTip("拖动：指针相对盘心的像素偏移（pointerOffsetX/Y）")
            self._scene.addItem(ptr)
            self._pointer_item = ptr
        elif pointer_pm is not None:
            self._draw_missing("pointerImage", QRectF(cx - 20, cy - size / 2, 40, size), 20)

        fg_pm = _load_runtime_pixmap(self._model, str(doc.get("foregroundImage") or ""))
        if fg_pm is not None:
            fit = str(doc.get("foregroundFit") or "cover")
            scale = (
                min(r.width() / max(1, fg_pm.width()), r.height() / max(1, fg_pm.height()))
                if fit == "contain"
                else max(r.width() / max(1, fg_pm.width()), r.height() / max(1, fg_pm.height()))
            )
            item = QGraphicsPixmapItem(fg_pm)
            item.setScale(scale)
            item.setPos((r.width() - fg_pm.width() * scale) / 2, (r.height() - fg_pm.height() * scale) / 2)
            item.setZValue(30)
            self._scene.addItem(item)

        for entry in _merge_speech_anchors_for_canvas(doc):
            rid = str(entry.get("role") or "").strip()
            if not rid:
                continue
            raw_lab = entry.get("label")
            if raw_lab is not None and str(raw_lab).strip():
                cap = str(raw_lab).strip()
            elif rid == "protagonist":
                cap = "主角"
            else:
                cap = rid
            xr = max(0.0, min(1.0, _num(entry.get("xRatio"), 0.5)))
            yr = max(0.0, min(1.0, _num(entry.get("yRatio"), 0.5)))
            ax = _SugarWheelSpeechAnchorItem(self, rid, cap)
            self._move_silent = True
            try:
                ax.setPos(QPointF(xr * r.width(), yr * r.height()))
            finally:
                self._move_silent = False
            ax.setZValue(100)
            self._scene.addItem(ax)
            self._speech_anchor_items[rid] = ax

        R = size / 2
        self._charge_item = None
        if self._wheel_item is not None:
            if "chargeButtonWheelOffsetXPx" in doc:
                ox = float(_num(doc.get("chargeButtonWheelOffsetXPx"), R * 0.72))
            else:
                ox = R * 0.72
            if "chargeButtonWheelOffsetYPx" in doc:
                oy = float(_num(doc.get("chargeButtonWheelOffsetYPx"), R * 0.72))
            else:
                oy = R * 0.72
            if "chargeButtonDiameterPx" in doc:
                cd = float(_num(doc.get("chargeButtonDiameterPx"), 52))
            else:
                cd = 52.0
            cd = max(28.0, min(160.0, cd))
            self._charge_ox = ox
            self._charge_oy = oy
            ch = _SugarWheelChargeButtonItem(self)
            self._move_silent = True
            try:
                ch.set_diameter(cd, silent=True)
                wpos = self._wheel_item.pos()
                ch.setPos(wpos.x() + ox, wpos.y() + oy)
            finally:
                self._move_silent = False
            ch.setZValue(95)
            self._scene.addItem(ch)
            self._charge_item = ch

        self._fit()

    def _after_move(self, role: str) -> None:
        if self._move_silent or self._layout_cx_cy is None or self._wheel_item is None:
            return
        cx, cy = self._layout_cx_cy
        wpos = self._wheel_item.pos()
        if role == "wheel":
            self._move_silent = True
            try:
                if self._pointer_item is not None:
                    self._pointer_item.setPos(wpos.x() + self._px, wpos.y() + self._py)
                if self._charge_item is not None:
                    self._charge_item.setPos(wpos.x() + self._charge_ox, wpos.y() + self._charge_oy)
            finally:
                self._move_silent = False
        if self._pointer_item is None:
            return
        ppos = self._pointer_item.pos()
        wx = wpos.x() - cx
        wy = wpos.y() - cy
        self._px = ppos.x() - wpos.x()
        self._py = ppos.y() - wpos.y()
        self.layout_offsets_changed.emit(wx, wy, self._px, self._py)

    def _after_charge_adjust(self) -> None:
        if self._move_silent or self._wheel_item is None or self._charge_item is None:
            return
        wpos = self._wheel_item.pos()
        cpos = self._charge_item.pos()
        self._charge_ox = float(cpos.x() - wpos.x())
        self._charge_oy = float(cpos.y() - wpos.y())
        self.charge_button_changed.emit(self._charge_ox, self._charge_oy, float(self._charge_item.diameter()))

    def _after_speech_anchor_move(self, role: str) -> None:
        item = self._speech_anchor_items.get(role)
        if item is None or self._move_silent:
            return
        rr = self._scene.sceneRect()
        w = max(1.0, rr.width())
        h = max(1.0, rr.height())
        pos = item.pos()
        xr = max(0.0, min(1.0, pos.x() / w))
        yr = max(0.0, min(1.0, pos.y() / h))
        snap = QPointF(xr * w, yr * h)
        if (snap - pos).manhattanLength() > 0.5:
            self._move_silent = True
            try:
                item.setPos(snap)
            finally:
                self._move_silent = False
        self.speech_anchor_changed.emit(role, xr, yr)

    def _draw_empty(self) -> None:
        self._scene.addText("没有选中转盘实例")

    def _draw_missing(self, label: str, rect: QRectF, z: float) -> None:
        self._scene.addRect(rect, QPen(QColor(220, 90, 80), 2, Qt.PenStyle.DashLine), QBrush(QColor(60, 20, 20, 80))).setZValue(z)
        text = self._scene.addText(f"缺少 {label}")
        text.setDefaultTextColor(QColor(240, 150, 120))
        text.setPos(rect.left() + 8, rect.top() + 8)
        text.setZValue(z + 1)

    def _fit(self) -> None:
        r = self._scene.sceneRect()
        if r.width() <= 0 or r.height() <= 0:
            return
        self._view.resetTransform()
        self._view.fitInView(r, Qt.AspectRatioMode.KeepAspectRatio)


class SugarWheelEditor(QWidget):
    """编辑 public/assets/data/sugar_wheel。"""

    preview_requested = Signal(str)

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._loading = False
        self._charge_json_explicit = False
        self._current_id: str | None = None
        self._doc: dict | None = None
        self._prev_sector_row = -1
        self._selected_sector_row = -1

        root = QHBoxLayout(self)
        root.setContentsMargins(4, 4, 4, 4)
        split = QSplitter(Qt.Orientation.Horizontal)
        split.setChildrenCollapsible(False)

        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        self._list = QListWidget()
        self._list.setMinimumWidth(180)  # 三栏预算：实例列表下限收窄
        ll.addWidget(QLabel("转盘实例"))
        self._list_search = QLineEdit()
        self._list_search.setPlaceholderText("搜索…")
        self._list_search.setToolTip("按标题 / id 过滤下方实例列表（仅隐藏不匹配项，不改数据）")
        self._list_search.setClearButtonEnabled(True)
        self._list_search.textChanged.connect(self._on_list_search_changed)
        ll.addWidget(self._list_search)
        ll.addWidget(self._list, stretch=1)
        br = QHBoxLayout()
        self._btn_add = QPushButton("新增")
        self._btn_del = QPushButton("删除")
        self._btn_preview = QPushButton("预览…")
        self._btn_add.setToolTip("新增一个转盘实例（id 作为文件名）")
        self._btn_del.setToolTip("删除当前选中的转盘实例")
        self._btn_preview.setToolTip("在游戏内预览当前转盘实例")
        br.addWidget(self._btn_add)
        br.addWidget(self._btn_del)
        br.addWidget(self._btn_preview)
        ll.addLayout(br)

        self._canvas = SugarWheelCanvas(model)
        self._canvas.layout_offsets_changed.connect(self._on_canvas_layout_offsets)
        self._canvas.speech_anchor_changed.connect(self._on_canvas_speech_anchor)
        self._canvas.charge_button_changed.connect(self._on_canvas_charge_button)

        right = QScrollArea()
        right.setWidgetResizable(True)
        right.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        right.setMinimumWidth(280)  # 三栏预算：表单面板下限收窄
        right_inner = QWidget()
        rv = QVBoxLayout(right_inner)
        rv.setContentsMargins(0, 0, 0, 0)

        self._label = QLineEdit()

        g_res = QGroupBox()
        ff_r = compact_form(QFormLayout(g_res))
        self._bg = CutsceneImagePathRow(model, "", external_copy_subdir="sugar_wheel", path_edit_read_only=True)
        self._bg_fit = QComboBox()
        self._bg_fit.addItems(["cover", "contain"])
        self._foreground = CutsceneImagePathRow(model, "", external_copy_subdir="sugar_wheel", path_edit_read_only=True)
        self._foreground_fit = QComboBox()
        self._foreground_fit.addItems(["cover", "contain"])
        self._wheel = CutsceneImagePathRow(model, "", external_copy_subdir="sugar_wheel", path_edit_read_only=True)
        self._pointer = CutsceneImagePathRow(model, "", external_copy_subdir="sugar_wheel", path_edit_read_only=True)
        self._pointer_anchor_x = self._double(0, 1, 0.5, 3)
        self._pointer_anchor = self._double(0, 1, 0.9, 3)
        self._pointer_scale = self._double(0.1, 3, 1, 3)
        self._wheel_scale = self._double(0.1, 3, 1, 3)
        self._wheel_pct = self._double(0.2, 1, 0.72, 3)
        self._wheel_px = self._double(64, 4096, 660, 0)
        self._wheel_cx_off = self._double(-800, 800, 0, 1)
        self._wheel_cy_off = self._double(-800, 800, 0, 1)
        self._ptr_ox = self._double(-800, 800, 0, 1)
        self._ptr_oy = self._double(-800, 800, 0, 1)
        self._charge_btn_ox = self._double(-1200, 1200, 0, 1)
        self._charge_btn_oy = self._double(-1200, 1200, 0, 1)
        self._charge_btn_d = self._double(28, 160, 52, 0)
        for _spin in (
            self._pointer_anchor_x,
            self._pointer_anchor,
            self._pointer_scale,
            self._wheel_scale,
            self._wheel_pct,
            self._wheel_px,
            self._wheel_cx_off,
            self._wheel_cy_off,
            self._ptr_ox,
            self._ptr_oy,
            self._charge_btn_ox,
            self._charge_btn_oy,
            self._charge_btn_d,
        ):
            _spin.setMaximumWidth(110)
        self._wheel_cx_off.setToolTip("转盘层相对布局中心的水平偏移（px），可在画布拖动盘面。")
        self._wheel_cy_off.setToolTip("转盘层相对布局中心的竖直偏移（px），可在画布拖动盘面。")
        self._ptr_ox.setToolTip("指针在转盘局部坐标内相对盘心的水平偏移（px），可在画布拖动指针。")
        self._ptr_oy.setToolTip("指针在转盘局部坐标内相对盘心的竖直偏移（px），可在画布拖动指针。")
        self._charge_btn_ox.setToolTip(
            "蓄力圆中心相对盘心的水平偏移（px）。画布拖蓝色圆；JSON 未写时运行时用 0.72×半径。"
        )
        self._charge_btn_oy.setToolTip("蓄力圆中心相对盘心的竖直偏移（px）。")
        self._charge_btn_d.setToolTip("蓄力圆直径（px）。预览画布上按住 Ctrl 再滚轮缩放。")
        ff_r.addRow("标题 label", self._label)
        ff_r.addRow("backgroundImage", self._bg)
        ff_r.addRow("backgroundFit", self._bg_fit)
        ff_r.addRow("foregroundImage", self._foreground)
        ff_r.addRow("foregroundFit", self._foreground_fit)
        ff_r.addRow("wheelImage", self._wheel)
        ff_r.addRow("pointerImage", self._pointer)
        ff_r.addRow("pointerAnchorX", self._pointer_anchor_x)
        ff_r.addRow("pointerAnchorY", self._pointer_anchor)
        ff_r.addRow("pointerScale", self._pointer_scale)
        ff_r.addRow("wheelScale", self._wheel_scale)
        ff_r.addRow("wheelMaxSizePercent", self._wheel_pct)
        ff_r.addRow("wheelMaxSizePx", self._wheel_px)
        ff_r.addRow("wheelCenterOffsetXPx", self._wheel_cx_off)
        ff_r.addRow("wheelCenterOffsetYPx", self._wheel_cy_off)
        ff_r.addRow("pointerOffsetXPx", self._ptr_ox)
        ff_r.addRow("pointerOffsetYPx", self._ptr_oy)
        ff_r.addRow("chargeButtonWheelOffsetXPx", self._charge_btn_ox)
        ff_r.addRow("chargeButtonWheelOffsetYPx", self._charge_btn_oy)
        ff_r.addRow("chargeButtonDiameterPx", self._charge_btn_d)
        _sec_res = CollapsibleSection("外观与资源", start_open=True)
        _sec_res.add_body(g_res)
        rv.addWidget(_sec_res)

        g_sec = QGroupBox()
        ff_s = compact_form(QFormLayout(g_sec))
        self._angle = self._double(-360, 360, 0, 2)
        self._sector_phase = self._double(-2, 2, 0, 3)
        self._pointer_art_deg = self._double(-180, 180, 0, 2)
        self._direction = QComboBox()
        self._direction.addItems(["clockwise", "counterclockwise"])
        self._angle.setToolTip("盘面整体旋转校准（度），顺时针为正。")
        self._sector_phase.setToolTip("第 0 格左边界在 offset + phase·step；默认 0。")
        self._pointer_art_deg.setToolTip("指针贴图相对数学正上的附加角（度）。")
        ff_s.addRow("sectorAngleOffsetDeg", self._angle)
        ff_s.addRow("sectorCenterPhase", self._sector_phase)
        ff_s.addRow("pointerArtOffsetDeg", self._pointer_art_deg)
        ff_s.addRow("sectorDirection", self._direction)
        _sec_calib = CollapsibleSection("分格与指针校准", start_open=False)
        _sec_calib.add_body(g_sec)
        rv.addWidget(_sec_calib)

        g_chg = QGroupBox()
        ff_h = compact_form(QFormLayout(g_chg))
        self._charge_ms = self._double(100, 15000, 2600, 0)
        self._min_power = self._double(0, 1, 0, 3)
        self._charge_curve = self._double(1, 3, 1.4, 2)
        self._charge_curve.setToolTip("1=线性；>1 时前段更细腻。")
        ff_h.addRow("powerChargeMs", self._charge_ms)
        ff_h.addRow("minLaunchPower", self._min_power)
        ff_h.addRow("powerChargeCurve", self._charge_curve)
        _sec_chg = CollapsibleSection("蓄力曲线", start_open=False)
        _sec_chg.add_body(g_chg)
        rv.addWidget(_sec_chg)

        g_phy = QGroupBox()
        g_phy_lay = QVBoxLayout(g_phy)
        g_phy_lay.setContentsMargins(0, 0, 0, 0)
        self._drag = self._double(0.02, 8, 0.58, 3)
        self._drag_low_thr = self._double(0, 20, 2.2, 3)
        self._drag_low_boost = self._double(0, 15, 2.0, 3)
        self._v_min = self._double(0, 80, 0, 3)
        self._v_max = self._double(0, 80, 10.5, 3)
        self._a_min = self._double(0, 200, 0, 3)
        self._a_max = self._double(0, 200, 8.5, 3)
        self._a_hl = self._double(0, 10, 0.42, 3)
        self._stop_w = self._double(0.001, 2, 0.06, 3)
        self._stop_settle = self._double(0, 2, 0.12, 3)
        self._dry_fric = self._double(0, 4, 0.34, 3)
        self._bias_creep = self._double(0, 6, 1.2, 2)
        for _spin in (
            self._drag,
            self._drag_low_thr,
            self._drag_low_boost,
            self._v_min,
            self._v_max,
            self._a_min,
            self._a_max,
            self._a_hl,
            self._stop_w,
            self._stop_settle,
            self._dry_fric,
            self._bias_creep,
        ):
            _spin.setMaximumWidth(110)
        self._drag.setToolTip("阻力 k（1/s），ω ← ω + (α − k·ω)·Δt；高速段基准。")
        self._drag_low_thr.setToolTip("|ω| 低于该值（rad/s）时阻力在 k 上渐增，0=关闭。")
        self._drag_low_boost.setToolTip("停转附近最大额外 k（1/s）；与阈值内 smootherstep 混合，末段柔和。")
        self._a_hl.setToolTip("松手后角加速度半衰期（秒）；≤0 表示当帧清零 α。")
        self._stop_w.setToolTip("|ω| 低于该值视为可停转（rad/s）。")
        self._stop_settle.setToolTip("|ω| 持续低于停转阈值达该时长后再出结果；略大一点末段更不「弹一下」。")
        self._dry_fric.setToolTip(
            "干摩擦角加速度（rad/s²），与转向相反；轻拨时单靠 k·ω 会衰得极慢，靠它收尾。\n"
            "写 0 = 关闭。"
        )
        self._bias_creep.setToolTip(
            "低于该角速度（rad/s）时按比例削弱 weight 势能扭矩，避免临界角速下被偏置「顶着」慢悠悠转。\n"
            "写 0 = 不削弱偏置扭矩。"
        )
        g_phy_drag = QGroupBox("阻力（drag）")
        ff_p_drag = compact_form(QFormLayout(g_phy_drag))
        ff_p_drag.addRow("spinLinearDragPerSec", self._drag)
        ff_p_drag.addRow("spinDragLowSpeedThresholdRadPerSec", self._drag_low_thr)
        ff_p_drag.addRow("spinDragLowSpeedBoostPerSec", self._drag_low_boost)
        ff_p_drag.addRow("spinDryFrictionAccelRadPerSec2", self._dry_fric)
        g_phy_lay.addWidget(g_phy_drag)

        g_phy_charge = QGroupBox("蓄力 → 角速度映射（charge）")
        ff_p_charge = compact_form(QFormLayout(g_phy_charge))
        ff_p_charge.addRow("spinChargeMinVelocityRadPerSec", self._v_min)
        ff_p_charge.addRow("spinChargeMaxVelocityRadPerSec", self._v_max)
        ff_p_charge.addRow("spinChargeMinAccelRadPerSec2", self._a_min)
        ff_p_charge.addRow("spinChargeMaxAccelRadPerSec2", self._a_max)
        ff_p_charge.addRow("spinAccelHalfLifeSec", self._a_hl)
        ff_p_charge.addRow("spinWeightBiasCreepRefRadPerSec", self._bias_creep)
        g_phy_lay.addWidget(g_phy_charge)

        g_phy_stop = QGroupBox("停转检测（stop）")
        ff_p_stop = compact_form(QFormLayout(g_phy_stop))
        ff_p_stop.addRow("spinStopSpeedRadPerSec", self._stop_w)
        ff_p_stop.addRow("spinStopSettleSec", self._stop_settle)
        g_phy_lay.addWidget(g_phy_stop)
        _sec_phy = CollapsibleSection("物理停针（运行时）", start_open=False)
        _sec_phy.add_body(g_phy)
        rv.addWidget(_sec_phy)

        g_pre_ch = QGroupBox()
        _pre_ch_tip = (
            "玩家按住蓄力钮时：先对 beforeChargeCondition 求值（ConditionExpr，与热区同源）；\n"
            "通过则执行 beforeChargePassActions 再进入蓄力；不通过则执行 beforeChargeFailActions 且不蓄力。\n"
            "条件留空表示始终通过。"
        )
        pre_l = QVBoxLayout(g_pre_ch)
        pre_l.setContentsMargins(8, 10, 8, 8)
        from ..shared.condition_expr_tree import ConditionExprTreeRootWidget

        self._before_charge_cond = ConditionExprTreeRootWidget(
            self,
            model_getter=lambda: self._model,
        )
        self._before_charge_cond.changed.connect(self._on_before_charge_changed)
        pre_l.addWidget(QLabel("beforeChargeCondition"))
        pre_l.addWidget(self._before_charge_cond)
        self._ae_before_charge_pass = ActionEditor("beforeChargePassActions（通过后再蓄力）")
        self._ae_before_charge_fail = ActionEditor("beforeChargeFailActions（不通过，中断蓄力）")
        for ae in (self._ae_before_charge_pass, self._ae_before_charge_fail):
            ae.set_project_context(model, scene_id=None)
            ae.changed.connect(self._on_before_charge_changed)
        pre_l.addWidget(self._ae_before_charge_pass)
        pre_l.addWidget(self._ae_before_charge_fail)
        _sec_pre_ch = CollapsibleSection("蓄力前：条件与 Action（beforeCharge）", start_open=False)
        _sec_pre_ch.set_header_tool_tip(_pre_ch_tip)
        _sec_pre_ch.add_body(g_pre_ch)
        rv.addWidget(_sec_pre_ch)

        g_sp = QGroupBox()
        ff_sp = compact_form(QFormLayout(g_sp))
        self._speech_dur = self._double(500, 120000, 3000, 0)
        self._speech_dur.setToolTip("默认气泡停留毫秒（外部调用未传 durationMs 时）。")
        ff_sp.addRow("speechDurationMs", self._speech_dur)
        _sec_sp = CollapsibleSection("对白气泡 showSpeech", start_open=False)
        _sec_sp.add_body(g_sp)
        rv.addWidget(_sec_sp)

        self._speech_table = QTableWidget(0, 5)
        self._speech_table.setHorizontalHeaderLabels(["role", "label", "xRatio", "yRatio", "tailDirection"])
        _sh = self._speech_table.horizontalHeaderItem(0)
        if _sh is not None:
            _sh.setToolTip("与 showSpeech(role) 一致，如 child_a、stall_owner、protagonist。")
        _sh1 = self._speech_table.horizontalHeaderItem(1)
        if _sh1 is not None:
            _sh1.setToolTip("小孩/摊主旁显示的名称；主角可留空。")
        _sh4 = self._speech_table.horizontalHeaderItem(4)
        if _sh4 is not None:
            _sh4.setToolTip("up / down / none")
        self._speech_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._speech_table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._speech_table.verticalHeader().setVisible(False)
        self._speech_table.setMinimumHeight(110)
        self._speech_table.horizontalHeader().setStretchLastSection(True)
        sb_sp = QHBoxLayout()
        self._btn_add_speech = QPushButton("+锚点")
        self._btn_del_speech = QPushButton("-锚点")
        self._btn_add_speech.setToolTip("新增一个气泡锚点行")
        self._btn_del_speech.setToolTip("删除选中的气泡锚点行")
        sb_sp.addWidget(QLabel("speechAnchors"))
        sb_sp.addStretch()
        sb_sp.addWidget(self._btn_add_speech)
        sb_sp.addWidget(self._btn_del_speech)
        sw_sp = QWidget()
        sw_spl = QVBoxLayout(sw_sp)
        sw_spl.setContentsMargins(0, 0, 0, 0)
        sw_spl.addLayout(sb_sp)
        sw_spl.addWidget(self._speech_table)
        _sec_speech = CollapsibleSection("对白锚点 speechAnchors", start_open=False)
        _sec_speech.add_body(sw_sp)
        rv.addWidget(_sec_speech)

        self._sector_table = QTableWidget(0, 4)
        self._sector_table.setHorizontalHeaderLabels(["id", "label", "weight", "payload JSON"])
        _hdr = self._sector_table.horizontalHeaderItem(2)
        if _hdr is not None:
            _hdr.setToolTip(
                "跑道高度倾向：空=1，表示基准平地。\n"
                "越大表示该格越低、更容易停留；越小表示该格越高、更难停留。\n"
                "不是精确中奖百分比；0 只是很高的坡，不保证绝对不命中。"
            )
        _hdr0 = self._sector_table.horizontalHeaderItem(0)
        if _hdr0 is not None:
            _hdr0.setToolTip("扇区逻辑 id，透出到 minigame:sugarWheelResult。")
        _hdr1 = self._sector_table.horizontalHeaderItem(1)
        if _hdr1 is not None:
            _hdr1.setToolTip("界面展示用语；可被游戏内文案系统解析。")
        _hdr3 = self._sector_table.horizontalHeaderItem(3)
        if _hdr3 is not None:
            _hdr3.setToolTip("可选 JSON 对象字符串，附着在抽中结果上。")
        self._sector_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._sector_table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._sector_table.verticalHeader().setVisible(False)
        self._sector_table.setMinimumHeight(140)  # 表在滚动区内，降低下限省竖向空间
        self._sector_table.horizontalHeader().setStretchLastSection(True)
        sb = QHBoxLayout()
        self._btn_add_sector = QPushButton("+格子")
        self._btn_del_sector = QPushButton("-格子")
        self._btn_up_sector = QPushButton("上移")
        self._btn_down_sector = QPushButton("下移")
        self._btn_add_sector.setToolTip("新增一格")
        self._btn_del_sector.setToolTip("删除选中的格子")
        self._btn_up_sector.setToolTip("将选中格子上移一位")
        self._btn_down_sector.setToolTip("将选中格子下移一位")
        _sec_lbl = QLabel("格子 sectors")
        _sec_lbl.setToolTip(
            "每行对应盘面上一格。\n「weight」不设=1，视为平地。\n"
            "想体感上少中就写小一点（高坡），容易中就写大一点（低谷）；不是要填「概率％」。"
        )
        sb.addWidget(_sec_lbl)
        sb.addStretch()
        sb.addWidget(self._btn_add_sector)
        sb.addWidget(self._btn_del_sector)
        sb.addWidget(self._btn_up_sector)
        sb.addWidget(self._btn_down_sector)
        sw = QWidget()
        swl = QVBoxLayout(sw)
        swl.setContentsMargins(0, 0, 0, 0)
        swl.addLayout(sb)
        swl.addWidget(self._sector_table)
        _sec_sectors = CollapsibleSection("格子 sectors", start_open=False)
        _sec_sectors.add_body(sw)
        rv.addWidget(_sec_sectors)

        self._g_sector_actions = QGroupBox()
        _sector_actions_tip = (
            "在左侧表格选中一行格子后编辑。\n"
            "· actionsOnPointerDrag：idle/查看结果时在盘面上拖指针并松手后执行（命中当前针对的扇区）。\n"
            "· actionsOnSpinLanding：蓄力开奖停针落在该格后顺序执行，再横幅与 minigame:sugarWheelResult。"
        )
        ga_l = QVBoxLayout(self._g_sector_actions)
        ga_l.setContentsMargins(8, 12, 8, 8)
        self._ae_sector_drag = ActionEditor("actionsOnPointerDrag（拖指针松手后）")
        self._ae_sector_landing = ActionEditor("actionsOnSpinLanding（开奖停在该格后）")
        for ae in (self._ae_sector_drag, self._ae_sector_landing):
            ae.set_project_context(model, scene_id=None)
            ae.changed.connect(self._on_sector_actions_editor_changed)
        ga_l.addWidget(self._ae_sector_drag)
        ga_l.addWidget(self._ae_sector_landing)
        _sec_sector_actions = CollapsibleSection("选中格 · Action（与水族馆实体相同筛选器）", start_open=False)
        _sec_sector_actions.set_header_tool_tip(_sector_actions_tip)
        _sec_sector_actions.add_body(self._g_sector_actions)
        rv.addWidget(_sec_sector_actions)
        self._bind_wheel_action_speech_role_getter()

        # ── 旋转氛围脚本 ──
        g_atmos = QGroupBox()
        _atmos_tip = (
            "每次抽奖随机选一组；每组四阶段（start / spinning / slowing / stop），\n"
            "每阶段是有序步骤列表。步骤使用固定 opcode。"
        )
        atmos_root = QVBoxLayout(g_atmos)
        atmos_root.setContentsMargins(6, 10, 6, 6)

        atmos_bar = QHBoxLayout()
        self._atmos_group_list = QListWidget()
        self._atmos_group_list.setMinimumHeight(80)
        self._atmos_group_list.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._btn_add_atmos_group = QPushButton("+组")
        self._btn_del_atmos_group = QPushButton("-组")
        self._btn_dup_atmos_group = QPushButton("复制")
        self._btn_add_atmos_group.setToolTip("新增一个氛围组")
        self._btn_del_atmos_group.setToolTip("删除选中的氛围组及其全部步骤")
        self._btn_dup_atmos_group.setToolTip("复制选中的氛围组")
        atmos_bar.addWidget(QLabel("氛围组"))
        atmos_bar.addStretch()
        atmos_bar.addWidget(self._btn_add_atmos_group)
        atmos_bar.addWidget(self._btn_dup_atmos_group)
        atmos_bar.addWidget(self._btn_del_atmos_group)
        atmos_root.addLayout(atmos_bar)
        atmos_root.addWidget(self._atmos_group_list)

        ag_form = compact_form(QFormLayout())
        self._atmos_group_id = QLineEdit()
        self._atmos_group_id.setPlaceholderText("组 id")
        self._atmos_group_label = QLineEdit()
        self._atmos_group_label.setPlaceholderText("展示名（可选）")
        self._atmos_group_weight = QDoubleSpinBox()
        self._atmos_group_weight.setRange(0, 100)
        self._atmos_group_weight.setDecimals(1)
        self._atmos_group_weight.setValue(1)
        self._atmos_group_weight.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)
        ag_form.addRow("id", self._atmos_group_id)
        ag_form.addRow("label", self._atmos_group_label)
        ag_form.addRow("weight", self._atmos_group_weight)
        atmos_root.addLayout(ag_form)

        # ── vars: 池列表 + 池内文案列表 ──
        vars_split = QSplitter(Qt.Orientation.Horizontal)
        vars_split.setMinimumHeight(90)  # 降低下限以适配 13"，可拖大
        vars_left = QWidget()
        vll = QVBoxLayout(vars_left)
        vll.setContentsMargins(0, 0, 0, 0)
        vars_bar = QHBoxLayout()
        vars_bar.addWidget(QLabel("文案池"))
        vars_bar.addStretch()
        self._btn_add_var_pool = QPushButton("+池")
        self._btn_del_var_pool = QPushButton("-池")
        self._btn_rename_var_pool = QPushButton("改名")
        self._btn_add_var_pool.setToolTip("新增一个文案池")
        self._btn_del_var_pool.setToolTip("删除选中的文案池")
        self._btn_rename_var_pool.setToolTip("重命名选中的文案池")
        vars_bar.addWidget(self._btn_add_var_pool)
        vars_bar.addWidget(self._btn_rename_var_pool)
        vars_bar.addWidget(self._btn_del_var_pool)
        vll.addLayout(vars_bar)
        self._var_pool_list = QListWidget()
        self._var_pool_list.setMaximumWidth(160)
        vll.addWidget(self._var_pool_list)
        vars_right = QWidget()
        vrl = QVBoxLayout(vars_right)
        vrl.setContentsMargins(0, 0, 0, 0)
        lines_bar = QHBoxLayout()
        lines_bar.addWidget(QLabel("台词"))
        lines_bar.addStretch()
        self._btn_add_var_line = QPushButton("+台词")
        self._btn_del_var_line = QPushButton("-台词")
        self._btn_add_var_line.setToolTip("向当前文案池新增一条台词")
        self._btn_del_var_line.setToolTip("删除选中的台词")
        lines_bar.addWidget(self._btn_add_var_line)
        lines_bar.addWidget(self._btn_del_var_line)
        vrl.addLayout(lines_bar)
        self._var_lines_list = QListWidget()
        self._var_lines_list.setToolTip("双击编辑台词")
        vrl.addWidget(self._var_lines_list)
        vars_split.addWidget(vars_left)
        vars_split.addWidget(vars_right)
        vars_split.setStretchFactor(0, 0)
        vars_split.setStretchFactor(1, 1)
        atmos_root.addWidget(vars_split)

        # ── 四阶段步骤：表格式 ──
        self._atmos_phase_tabs = QTabWidget()
        self._atmos_phase_tabs.setTabPosition(QTabWidget.TabPosition.North)
        self._ATMOS_PHASE_NAMES = ["start", "spinning", "slowing", "stop"]
        self._ATMOS_PHASE_LABELS = ["start 开始转", "spinning 旋转中", "slowing 慢下来", "stop 停止"]
        self._atmos_step_tables: dict[str, QTableWidget] = {}
        _op_choices = ["say", "pick", "wait", "chance", "when_near_sector"]
        for pname, plabel in zip(self._ATMOS_PHASE_NAMES, self._ATMOS_PHASE_LABELS):
            page = QWidget()
            pl = QVBoxLayout(page)
            pl.setContentsMargins(0, 0, 0, 0)
            step_bar = QHBoxLayout()
            btn_add = QPushButton("+步骤")
            btn_del = QPushButton("-步骤")
            btn_up = QPushButton("上移")
            btn_down = QPushButton("下移")
            btn_add.setToolTip("在该阶段新增一个步骤")
            btn_del.setToolTip("删除选中的步骤")
            btn_up.setToolTip("将选中步骤上移一位")
            btn_down.setToolTip("将选中步骤下移一位")
            step_bar.addStretch()
            step_bar.addWidget(btn_add)
            step_bar.addWidget(btn_del)
            step_bar.addWidget(btn_up)
            step_bar.addWidget(btn_down)
            pl.addLayout(step_bar)
            tbl = QTableWidget(0, 7)
            tbl.setHorizontalHeaderLabels(["op", "role", "pool/text", "sec", "p(0-1)", "sectorId", "degBuf"])
            tbl.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
            tbl.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
            tbl.verticalHeader().setVisible(False)
            tbl.setMinimumHeight(110)
            tbl.horizontalHeader().setStretchLastSection(True)
            h0 = tbl.horizontalHeaderItem(0)
            if h0:
                h0.setToolTip("say=说话  pick=抽句入槽  wait=等待  chance=概率  when_near_sector=邻近扇区")
            h2 = tbl.horizontalHeaderItem(2)
            if h2:
                h2.setToolTip("say: 填 pool 名则从文案池随机抽；填直接文案则直接说。\npick: 填 pool 名。")
            pl.addWidget(tbl)
            self._atmos_step_tables[pname] = tbl
            btn_add.clicked.connect(lambda _c=False, _p=pname: self._atmos_step_add(_p))
            btn_del.clicked.connect(lambda _c=False, _p=pname: self._atmos_step_del(_p))
            btn_up.clicked.connect(lambda _c=False, _p=pname: self._atmos_step_move(_p, -1))
            btn_down.clicked.connect(lambda _c=False, _p=pname: self._atmos_step_move(_p, 1))
            tbl.itemChanged.connect(lambda _it, _p=pname: self._on_atmos_step_item_changed(_p))
            self._atmos_phase_tabs.addTab(page, plabel)
        atmos_root.addWidget(self._atmos_phase_tabs)

        _sec_atmos = CollapsibleSection("旋转氛围脚本 atmosphereGroups", start_open=False)
        _sec_atmos.set_header_tool_tip(_atmos_tip)
        _sec_atmos.add_body(g_atmos)
        rv.addWidget(_sec_atmos)

        rv.addStretch()
        right.setWidget(right_inner)

        split.addWidget(left)
        split.addWidget(self._canvas)
        split.addWidget(right)
        self._right_scroll = right
        split.setStretchFactor(0, 0)
        split.setStretchFactor(1, 2)
        split.setStretchFactor(2, 1)
        root.addWidget(split)

        self._list.currentRowChanged.connect(self._on_row_changed)
        self._btn_add.clicked.connect(self._add_instance)
        self._btn_del.clicked.connect(self._delete_instance)
        self._btn_preview.clicked.connect(self._preview)
        self._wire_fields()
        self._model.data_changed.connect(self._on_model_data_changed)
        self._reload_list(None)
        if self._list.count() == 0:
            self._set_enabled(False)

    def _double(self, lo: float, hi: float, val: float, decimals: int) -> QDoubleSpinBox:
        w = QDoubleSpinBox()
        w.setRange(lo, hi)
        w.setDecimals(decimals)
        w.setValue(val)
        w.setButtonSymbols(QAbstractSpinBox.ButtonSymbols.NoButtons)
        return w

    def _wire_fields(self) -> None:
        self._label.textChanged.connect(self._on_label_changed)
        for row in (self._bg, self._foreground, self._wheel, self._pointer):
            row.changed.connect(self._on_images_changed)
        self._bg_fit.currentTextChanged.connect(self._on_config_changed)
        self._foreground_fit.currentTextChanged.connect(self._on_config_changed)
        self._direction.currentTextChanged.connect(self._on_config_changed)
        for w in (
            self._pointer_anchor_x,
            self._pointer_anchor,
            self._pointer_scale,
            self._wheel_scale,
            self._wheel_pct,
            self._wheel_px,
            self._wheel_cx_off,
            self._wheel_cy_off,
            self._ptr_ox,
            self._ptr_oy,
            self._angle,
            self._sector_phase,
            self._pointer_art_deg,
            self._charge_ms,
            self._min_power,
            self._charge_curve,
            self._drag,
            self._drag_low_thr,
            self._drag_low_boost,
            self._v_min,
            self._v_max,
            self._a_min,
            self._a_max,
            self._a_hl,
            self._stop_w,
            self._stop_settle,
            self._dry_fric,
            self._bias_creep,
            self._speech_dur,
        ):
            w.valueChanged.connect(self._on_config_changed)
        for w in (self._charge_btn_ox, self._charge_btn_oy, self._charge_btn_d):
            w.valueChanged.connect(self._on_charge_geometry_spin_changed)
        self._sector_table.itemChanged.connect(self._on_sector_item_changed)
        self._speech_table.itemChanged.connect(self._on_speech_item_changed)
        self._btn_add_sector.clicked.connect(self._add_sector)
        self._btn_del_sector.clicked.connect(self._delete_sector)
        self._btn_up_sector.clicked.connect(lambda _c=False: self._move_sector(-1))
        self._btn_down_sector.clicked.connect(lambda _c=False: self._move_sector(1))
        self._btn_add_speech.clicked.connect(self._add_speech_row)
        self._btn_del_speech.clicked.connect(self._delete_speech_row)
        self._sector_table.itemSelectionChanged.connect(self._on_sector_selection_changed)
        self._atmos_group_list.currentRowChanged.connect(self._on_atmos_group_selected)
        self._btn_add_atmos_group.clicked.connect(self._add_atmos_group)
        self._btn_del_atmos_group.clicked.connect(self._del_atmos_group)
        self._btn_dup_atmos_group.clicked.connect(self._dup_atmos_group)
        self._atmos_group_id.textChanged.connect(self._on_atmos_group_field_changed)
        self._atmos_group_label.textChanged.connect(self._on_atmos_group_field_changed)
        self._atmos_group_weight.valueChanged.connect(self._on_atmos_group_field_changed)
        self._var_pool_list.currentRowChanged.connect(self._on_var_pool_selected)
        self._btn_add_var_pool.clicked.connect(self._add_var_pool)
        self._btn_del_var_pool.clicked.connect(self._del_var_pool)
        self._btn_rename_var_pool.clicked.connect(self._rename_var_pool)
        self._btn_add_var_line.clicked.connect(self._add_var_line)
        self._btn_del_var_line.clicked.connect(self._del_var_line)
        self._var_lines_list.itemChanged.connect(self._on_var_line_changed)

    def _on_model_data_changed(self, dtype: str, _key: str) -> None:
        if dtype == "sugar_wheel":
            return
        self._before_charge_cond.set_model_refresh()
    def _mark_dirty(self, *, refresh_canvas: bool = True) -> None:
        if self._loading:
            return
        self._model.mark_dirty("sugar_wheel")
        if refresh_canvas:
            self._canvas.refresh(self._doc)

    def _flush_before_charge_from_editors(self) -> None:
        if self._loading or not self._doc:
            return
        ex = self._before_charge_cond.get_expr()
        if ex:
            self._doc["beforeChargeCondition"] = ex
        else:
            self._doc.pop("beforeChargeCondition", None)
        lp = self._ae_before_charge_pass.to_list()
        if lp:
            self._doc["beforeChargePassActions"] = lp
        else:
            self._doc.pop("beforeChargePassActions", None)
        lf = self._ae_before_charge_fail.to_list()
        if lf:
            self._doc["beforeChargeFailActions"] = lf
        else:
            self._doc.pop("beforeChargeFailActions", None)
        self._mark_dirty(refresh_canvas=False)

    def _on_before_charge_changed(self) -> None:
        self._flush_before_charge_from_editors()

    def _speech_role_rows_for_action_editor(self) -> list[tuple[str, str]]:
        """与画布/氛围相同的 role 集合：预设 + speechAnchors 覆盖与追加。"""
        rows: list[tuple[str, str]] = [("（选转盘气泡角色）", "")]
        doc = self._doc if isinstance(self._doc, dict) else {}
        for a in _merge_speech_anchors_for_canvas(doc):
            rid = str(a.get("role") or "").strip()
            if not rid:
                continue
            lab = str(a.get("label") or "").strip()
            rows.append((f"{rid} · {lab}" if lab else rid, rid))
        return rows

    def _bind_wheel_action_speech_role_getter(self) -> None:
        for ae in (
            self._ae_sector_drag,
            self._ae_sector_landing,
            self._ae_before_charge_pass,
            self._ae_before_charge_fail,
        ):
            ae.set_wheel_speech_role_rows_getter(self._speech_role_rows_for_action_editor)

    def _refresh_wheel_speech_dependent_combos(self) -> None:
        for ae in (
            self._ae_sector_drag,
            self._ae_sector_landing,
            self._ae_before_charge_pass,
            self._ae_before_charge_fail,
        ):
            ae.refresh_wheel_speech_role_combos()
        self._refresh_atmos_role_combos()

    def _default_atmos_say_role(self) -> str:
        for a in _merge_speech_anchors_for_canvas(self._doc or {}):
            rid = str(a.get("role") or "").strip()
            if rid:
                return rid
        return "child_a"

    def _fill_atmos_role_combo(self, cb: QComboBox, current_role: str) -> None:
        cb.blockSignals(True)
        try:
            cb.clear()
            cur = (current_role or "").strip()
            for a in _merge_speech_anchors_for_canvas(self._doc or {}):
                rid = str(a.get("role") or "").strip()
                if not rid:
                    continue
                lab = str(a.get("label") or "").strip()
                disp = f"{rid} · {lab}" if lab else rid
                cb.addItem(disp, rid)
            idx = cb.findData(cur)
            if idx >= 0:
                cb.setCurrentIndex(idx)
            elif cur:
                cb.addItem(f"(数据中) {cur}", cur)
                cb.setCurrentIndex(cb.count() - 1)
            elif cb.count():
                cb.setCurrentIndex(0)
        finally:
            cb.blockSignals(False)

    def _refresh_atmos_role_combos(self) -> None:
        if not self._doc:
            return
        for pname in self._ATMOS_PHASE_NAMES:
            tbl = self._atmos_step_tables[pname]
            for r in range(tbl.rowCount()):
                w = tbl.cellWidget(r, 1)
                if not isinstance(w, QComboBox):
                    continue
                rd = w.currentData()
                cur = str(rd) if rd is not None else w.currentText().strip()
                self._fill_atmos_role_combo(w, cur)

    def _role_cell_from_atmos_table(self, tbl: QTableWidget, r: int) -> str:
        w = tbl.cellWidget(r, 1)
        if isinstance(w, QComboBox):
            data = w.currentData()
            if data is not None:
                return str(data).strip()
            return w.currentText().strip()
        it = tbl.item(r, 1)
        return it.text().strip() if it else ""

    def _pull_atmos_step_from_ui(self, pname: str) -> None:
        if self._loading or not self._doc:
            return
        g = self._cur_atmos_group()
        if g is None:
            return
        g[pname] = self._read_atmos_step_table(pname)
        self._mark_dirty(refresh_canvas=False)

    def _on_canvas_layout_offsets(self, wx: float, wy: float, px: float, py: float) -> None:
        if not self._doc or self._loading:
            return
        self._loading = True
        try:
            self._wheel_cx_off.setValue(wx)
            self._wheel_cy_off.setValue(wy)
            self._ptr_ox.setValue(px)
            self._ptr_oy.setValue(py)
            self._doc["wheelCenterOffsetXPx"] = float(wx)
            self._doc["wheelCenterOffsetYPx"] = float(wy)
            self._doc["pointerOffsetXPx"] = float(px)
            self._doc["pointerOffsetYPx"] = float(py)
        finally:
            self._loading = False
        self._mark_dirty(refresh_canvas=False)

    def _on_canvas_speech_anchor(self, role: str, xr: float, yr: float) -> None:
        if not self._doc:
            return
        xr = max(0.0, min(1.0, float(xr)))
        yr = max(0.0, min(1.0, float(yr)))
        anchors = self._speech_rows()
        found: dict | None = None
        for a in anchors:
            if str(a.get("role")) == role:
                found = a
                break
        if found is None:
            preset = next((p for p in _SPEECH_ANCHOR_PRESETS if str(p.get("role")) == role), None)
            if preset:
                na = dict(preset)
                na["xRatio"] = xr
                na["yRatio"] = yr
                anchors.append(na)
            else:
                anchors.append({"role": role, "xRatio": xr, "yRatio": yr, "tailDirection": "none"})
        else:
            found["xRatio"] = xr
            found["yRatio"] = yr
        self._loading = True
        try:
            self._fill_speech_rows()
        finally:
            self._loading = False
        self._mark_dirty(refresh_canvas=False)

    def _on_canvas_charge_button(self, ox: float, oy: float, diam: float) -> None:
        if not self._doc or self._loading:
            return
        self._charge_json_explicit = True
        self._loading = True
        try:
            self._charge_btn_ox.setValue(float(ox))
            self._charge_btn_oy.setValue(float(oy))
            self._charge_btn_d.setValue(float(diam))
            self._doc["chargeButtonWheelOffsetXPx"] = float(ox)
            self._doc["chargeButtonWheelOffsetYPx"] = float(oy)
            self._doc["chargeButtonDiameterPx"] = float(diam)
        finally:
            self._loading = False
        self._mark_dirty(refresh_canvas=False)

    def _on_charge_geometry_spin_changed(self, *_args: Any) -> None:
        if self._loading or not self._doc:
            return
        self._charge_json_explicit = True
        self._doc["chargeButtonWheelOffsetXPx"] = float(self._charge_btn_ox.value())
        self._doc["chargeButtonWheelOffsetYPx"] = float(self._charge_btn_oy.value())
        self._doc["chargeButtonDiameterPx"] = float(self._charge_btn_d.value())
        self._mark_dirty()

    def _reload_list(self, select_id: str | None) -> None:
        self._list.blockSignals(True)
        self._list.clear()
        sel = 0
        for i, row in enumerate(self._model.sugar_wheel_index if isinstance(self._model.sugar_wheel_index, list) else []):
            if not isinstance(row, dict):
                continue
            iid = str(row.get("id") or "").strip()
            if not iid:
                continue
            lab = str(row.get("label") or iid)
            it = QListWidgetItem(f"{lab}  [{iid}]")
            it.setData(Qt.ItemDataRole.UserRole, iid)
            self._list.addItem(it)
            if select_id and iid == select_id:
                sel = self._list.count() - 1
        self._list.blockSignals(False)
        if getattr(self, "_list_search", None) is not None:
            self._on_list_search_changed(self._list_search.text())
        if self._list.count() > 0:
            self._list.setCurrentRow(sel)
        else:
            self._current_id = None
            self._doc = None
            self._canvas.refresh(None)

    def _on_list_search_changed(self, text: str) -> None:
        # 纯视图过滤：只 setHidden，不改/不重排任何数据。
        q = (text or "").strip().lower()
        for row in range(self._list.count()):
            it = self._list.item(row)
            if it is None:
                continue
            it.setHidden(bool(q) and q not in it.text().lower())

    def select_by_id(self, item_id: str, _scene_id: str = "") -> None:
        iid = (item_id or "").strip()
        if not iid:
            return
        for row in self._model.sugar_wheel_index if isinstance(self._model.sugar_wheel_index, list) else []:
            if isinstance(row, dict) and str(row.get("id") or "").strip() == iid:
                self._reload_list(iid)
                return

    def _set_enabled(self, on: bool) -> None:
        for w in (
            self._label, self._bg, self._bg_fit, self._foreground, self._foreground_fit, self._wheel, self._pointer,
            self._pointer_anchor_x, self._pointer_anchor, self._pointer_scale, self._wheel_scale,
            self._wheel_pct, self._wheel_px, self._wheel_cx_off, self._wheel_cy_off, self._ptr_ox, self._ptr_oy,
            self._charge_btn_ox, self._charge_btn_oy, self._charge_btn_d,
            self._angle, self._sector_phase,
            self._pointer_art_deg, self._direction,
            self._charge_ms, self._min_power, self._charge_curve,
            self._drag, self._drag_low_thr, self._drag_low_boost, self._v_min, self._v_max, self._a_min, self._a_max,
            self._a_hl, self._stop_w, self._stop_settle, self._dry_fric, self._bias_creep,
            self._speech_dur,
            self._sector_table, self._btn_add_sector, self._btn_del_sector,
            self._btn_up_sector, self._btn_down_sector,
            self._g_sector_actions,
            self._speech_table, self._btn_add_speech, self._btn_del_speech,
            self._btn_preview,
            self._before_charge_cond,
            self._ae_before_charge_pass,
            self._ae_before_charge_fail,
        ):
            w.setEnabled(on)
        self._right_scroll.setEnabled(on)

    def _flush_sector_actions_row(self, row: int) -> None:
        """把 Action 编辑器写回 sectors[row]。"""
        if row < 0 or not self._doc:
            return
        sectors = self._sectors()
        if row >= len(sectors):
            return
        sec = sectors[row]
        lst_drag = self._ae_sector_drag.to_list()
        if lst_drag:
            sec["actionsOnPointerDrag"] = lst_drag
        else:
            sec.pop("actionsOnPointerDrag", None)
        lst_land = self._ae_sector_landing.to_list()
        if lst_land:
            sec["actionsOnSpinLanding"] = lst_land
        else:
            sec.pop("actionsOnSpinLanding", None)

    def _fill_sector_action_editors(self, row: int) -> None:
        self._loading = True
        try:
            sectors = self._sectors()
            if row < 0 or row >= len(sectors):
                self._ae_sector_drag.set_data([])
                self._ae_sector_landing.set_data([])
            else:
                sec = sectors[row]
                self._ae_sector_drag.set_data(
                    list(sec.get("actionsOnPointerDrag") or [])
                    if isinstance(sec.get("actionsOnPointerDrag"), list)
                    else [],
                )
                self._ae_sector_landing.set_data(
                    list(sec.get("actionsOnSpinLanding") or [])
                    if isinstance(sec.get("actionsOnSpinLanding"), list)
                    else [],
                )
        finally:
            self._loading = False

    def _sync_sector_selection_from_table(self, prev_sel: int) -> None:
        sectors = self._sectors()
        if not sectors:
            self._prev_sector_row = -1
            self._selected_sector_row = -1
            self._fill_sector_action_editors(-1)
            return
        r = prev_sel if prev_sel >= 0 else 0
        r = min(r, len(sectors) - 1)
        self._sector_table.blockSignals(True)
        self._sector_table.selectRow(r)
        self._sector_table.blockSignals(False)
        self._prev_sector_row = r
        self._selected_sector_row = r
        self._fill_sector_action_editors(r)

    def _on_sector_selection_changed(self) -> None:
        if self._loading or not self._doc:
            return
        new_r = self._sector_table.currentRow()
        old = self._prev_sector_row
        if old >= 0 and old != new_r:
            self._flush_sector_actions_row(old)
        self._prev_sector_row = new_r
        self._selected_sector_row = new_r
        self._fill_sector_action_editors(new_r)

    def _on_sector_actions_editor_changed(self) -> None:
        if self._loading or not self._doc:
            return
        self._flush_sector_actions_row(self._selected_sector_row)
        self._mark_dirty(refresh_canvas=False)

    def _on_row_changed(self, row: int) -> None:
        if self._doc is not None:
            self._flush_sector_actions_row(self._selected_sector_row)
            self._flush_before_charge_from_editors()
        if row < 0:
            self._current_id = None
            self._doc = None
            self._prev_sector_row = -1
            self._selected_sector_row = -1
            self._loading = True
            try:
                self._fill_sector_action_editors(-1)
            finally:
                self._loading = False
            self._canvas.refresh(None)
            self._set_enabled(False)
            return
        it = self._list.item(row)
        if it is None:
            return
        iid = str(it.data(Qt.ItemDataRole.UserRole) or "").strip()
        self._current_id = iid
        self._doc = self._model.sugar_wheel_instances.get(iid)
        self._set_enabled(True)
        self._fill_form()
        self._canvas.refresh(self._doc)

    def _fill_form(self) -> None:
        self._loading = True
        try:
            d = self._doc or {}
            self._label.setText(str(d.get("label") or ""))
            self._bg.set_path(str(d.get("backgroundImage") or ""))
            self._set_combo(self._bg_fit, str(d.get("backgroundFit") or "cover"))
            self._foreground.set_path(str(d.get("foregroundImage") or ""))
            self._set_combo(self._foreground_fit, str(d.get("foregroundFit") or "cover"))
            self._wheel.set_path(str(d.get("wheelImage") or ""))
            self._pointer.set_path(str(d.get("pointerImage") or ""))
            self._pointer_anchor_x.setValue(_num(d.get("pointerAnchorX"), 0.5))
            self._pointer_anchor.setValue(_num(d.get("pointerAnchorY"), 0.9))
            self._pointer_scale.setValue(_num(d.get("pointerScale"), 1))
            self._wheel_scale.setValue(_num(d.get("wheelScale"), 1))
            self._wheel_pct.setValue(_num(d.get("wheelMaxSizePercent"), 0.72))
            self._wheel_px.setValue(_num(d.get("wheelMaxSizePx"), 660))
            self._wheel_cx_off.setValue(_num(d.get("wheelCenterOffsetXPx"), 0))
            self._wheel_cy_off.setValue(_num(d.get("wheelCenterOffsetYPx"), 0))
            self._ptr_ox.setValue(_num(d.get("pointerOffsetXPx"), 0))
            self._ptr_oy.setValue(_num(d.get("pointerOffsetYPx"), 0))
            rr = self._canvas._scene.sceneRect()
            R = _preview_wheel_radius_px(d, float(rr.width()), float(rr.height()))
            def_ox = R * 0.72
            def_oy = R * 0.72
            self._charge_json_explicit = any(
                k in d
                for k in ("chargeButtonWheelOffsetXPx", "chargeButtonWheelOffsetYPx", "chargeButtonDiameterPx")
            )
            if self._charge_json_explicit:
                self._charge_btn_ox.setValue(_num(d.get("chargeButtonWheelOffsetXPx"), def_ox))
                self._charge_btn_oy.setValue(_num(d.get("chargeButtonWheelOffsetYPx"), def_oy))
                self._charge_btn_d.setValue(_num(d.get("chargeButtonDiameterPx"), 52))
            else:
                self._charge_btn_ox.setValue(def_ox)
                self._charge_btn_oy.setValue(def_oy)
                self._charge_btn_d.setValue(52)
            self._angle.setValue(_num(d.get("sectorAngleOffsetDeg"), 0))
            self._sector_phase.setValue(_num(d.get("sectorCenterPhase"), 0))
            self._pointer_art_deg.setValue(_num(d.get("pointerArtOffsetDeg"), 0))
            self._set_combo(self._direction, str(d.get("sectorDirection") or "clockwise"))
            self._charge_ms.setValue(_num(d.get("powerChargeMs"), 2600))
            self._min_power.setValue(_num(d.get("minLaunchPower"), 0))
            self._charge_curve.setValue(_num(d.get("powerChargeCurve"), 1.4))
            self._drag.setValue(_num(d.get("spinLinearDragPerSec"), 0.58))
            self._drag_low_thr.setValue(_num(d.get("spinDragLowSpeedThresholdRadPerSec"), 0))
            self._drag_low_boost.setValue(_num(d.get("spinDragLowSpeedBoostPerSec"), 0))
            self._v_min.setValue(_num(d.get("spinChargeMinVelocityRadPerSec"), 0))
            self._v_max.setValue(_num(d.get("spinChargeMaxVelocityRadPerSec"), 10.5))
            self._a_min.setValue(_num(d.get("spinChargeMinAccelRadPerSec2"), 0))
            self._a_max.setValue(_num(d.get("spinChargeMaxAccelRadPerSec2"), 8.5))
            self._a_hl.setValue(_num(d.get("spinAccelHalfLifeSec"), 0.42))
            self._stop_w.setValue(_num(d.get("spinStopSpeedRadPerSec"), 0.06))
            self._stop_settle.setValue(_num(d.get("spinStopSettleSec"), 0.12))
            self._dry_fric.setValue(_num(d.get("spinDryFrictionAccelRadPerSec2"), 0.34))
            self._bias_creep.setValue(_num(d.get("spinWeightBiasCreepRefRadPerSec"), 1.2))
            self._speech_dur.setValue(_num(d.get("speechDurationMs"), 3000))
            bcc = d.get("beforeChargeCondition")
            self._before_charge_cond.set_expr(bcc if isinstance(bcc, dict) else None)
            self._before_charge_cond.set_model_refresh()
            self._ae_before_charge_pass.set_data(
                list(d.get("beforeChargePassActions") or [])
                if isinstance(d.get("beforeChargePassActions"), list)
                else [],
            )
            self._ae_before_charge_fail.set_data(
                list(d.get("beforeChargeFailActions") or [])
                if isinstance(d.get("beforeChargeFailActions"), list)
                else [],
            )
            self._fill_speech_rows()
            self._fill_sectors()
            self._fill_atmos_group_list()
            if self._atmos_group_list.count() > 0:
                self._atmos_group_list.setCurrentRow(0)
            self._fill_atmos_group_detail()
            self._refresh_wheel_speech_dependent_combos()
        finally:
            self._loading = False

    def _set_combo(self, cb: QComboBox, text: str) -> None:
        idx = cb.findText(text)
        cb.setCurrentIndex(idx if idx >= 0 else 0)

    def _fill_sectors(self, selection_hint: int | None = None) -> None:
        sectors = self._sectors()
        prev_sel = self._sector_table.currentRow() if selection_hint is None else selection_hint
        self._sector_table.blockSignals(True)
        self._sector_table.setRowCount(len(sectors))
        for r, sec in enumerate(sectors):
            values = [
                str(sec.get("id") or ""),
                str(sec.get("label") or ""),
                str(sec.get("weight") if sec.get("weight") is not None else ""),
                json.dumps(sec.get("payload", {}), ensure_ascii=False) if isinstance(sec.get("payload"), dict) else "",
            ]
            for c, val in enumerate(values):
                self._sector_table.setItem(r, c, QTableWidgetItem(val))
        self._sector_table.blockSignals(False)
        self._sync_sector_selection_from_table(prev_sel)

    def _sectors(self) -> list[dict]:
        assert self._doc is not None
        raw = self._doc.setdefault("sectors", [])
        if not isinstance(raw, list):
            raw = []
            self._doc["sectors"] = raw
        out = [x for x in raw if isinstance(x, dict)]
        self._doc["sectors"] = out
        return out

    def _speech_rows(self) -> list[dict]:
        assert self._doc is not None
        raw = self._doc.setdefault("speechAnchors", [])
        if not isinstance(raw, list):
            raw = []
            self._doc["speechAnchors"] = raw
        out = [x for x in raw if isinstance(x, dict)]
        self._doc["speechAnchors"] = out
        return out

    def _fill_speech_rows(self) -> None:
        if not self._doc:
            self._speech_table.blockSignals(True)
            self._speech_table.setRowCount(0)
            self._speech_table.blockSignals(False)
            return
        rows = self._speech_rows()
        self._speech_table.blockSignals(True)
        self._speech_table.setRowCount(len(rows))
        for r, a in enumerate(rows):
            xr, yr = a.get("xRatio"), a.get("yRatio")
            vals = [
                str(a.get("role") or ""),
                str(a.get("label") if a.get("label") is not None else ""),
                "" if xr is None else str(float(xr)),
                "" if yr is None else str(float(yr)),
                str(a.get("tailDirection") or "none"),
            ]
            for c, val in enumerate(vals):
                self._speech_table.setItem(r, c, QTableWidgetItem(val))
        self._speech_table.blockSignals(False)

    def _on_speech_item_changed(self, _item: QTableWidgetItem) -> None:
        if self._loading or not self._doc:
            return
        anchors = self._speech_rows()
        for r in range(len(anchors)):
            if r >= self._speech_table.rowCount():
                break
            a = anchors[r]
            a["role"] = (self._speech_table.item(r, 0).text() if self._speech_table.item(r, 0) else "").strip()
            lab = (self._speech_table.item(r, 1).text() if self._speech_table.item(r, 1) else "").strip()
            if lab:
                a["label"] = lab
            else:
                a.pop("label", None)
            for key, col in (("xRatio", 2), ("yRatio", 3)):
                txt = (self._speech_table.item(r, col).text() if self._speech_table.item(r, col) else "").strip()
                if txt:
                    try:
                        a[key] = float(txt)
                    except ValueError:
                        pass
                else:
                    a.pop(key, None)
            tail = (self._speech_table.item(r, 4).text() if self._speech_table.item(r, 4) else "").strip().lower()
            if tail in ("up", "down", "none"):
                a["tailDirection"] = tail
            else:
                a["tailDirection"] = "none"
        self._mark_dirty()
        self._refresh_wheel_speech_dependent_combos()

    def _add_speech_row(self) -> None:
        if not self._doc:
            return
        anchors = self._speech_rows()
        anchors.append({"role": f"role_{len(anchors) + 1}", "tailDirection": "none"})
        self._mark_dirty()
        self._fill_speech_rows()
        self._speech_table.selectRow(len(anchors) - 1)
        self._refresh_wheel_speech_dependent_combos()

    def _delete_speech_row(self) -> None:
        if not self._doc:
            return
        r = self._speech_table.currentRow()
        anchors = self._speech_rows()
        if r < 0 or r >= len(anchors):
            return
        anchors.pop(r)
        self._mark_dirty()
        self._fill_speech_rows()
        self._refresh_wheel_speech_dependent_combos()

    def _on_label_changed(self, text: str) -> None:
        if self._loading or not self._doc or not self._current_id:
            return
        self._doc["label"] = text.strip()
        for row in self._model.sugar_wheel_index:
            if isinstance(row, dict) and str(row.get("id")) == self._current_id:
                row["label"] = text.strip()
                break
        cur = self._list.currentItem()
        if cur:
            cur.setText(f"{text.strip()}  [{self._current_id}]")
        self._mark_dirty()

    def _on_images_changed(self) -> None:
        if self._loading or not self._doc:
            return
        self._doc["backgroundImage"] = self._bg.path()
        self._doc["foregroundImage"] = self._foreground.path()
        self._doc["wheelImage"] = self._wheel.path()
        self._doc["pointerImage"] = self._pointer.path()
        self._mark_dirty()

    def _on_config_changed(self, *_args: Any) -> None:
        if self._loading or not self._doc:
            return
        self._doc["backgroundFit"] = self._bg_fit.currentText()
        self._doc["foregroundFit"] = self._foreground_fit.currentText()
        self._doc["pointerAnchorX"] = float(self._pointer_anchor_x.value())
        self._doc["pointerAnchorY"] = float(self._pointer_anchor.value())
        self._doc["pointerScale"] = float(self._pointer_scale.value())
        self._doc["wheelScale"] = float(self._wheel_scale.value())
        self._doc["wheelMaxSizePercent"] = float(self._wheel_pct.value())
        self._doc["wheelMaxSizePx"] = int(round(self._wheel_px.value()))
        self._doc["wheelCenterOffsetXPx"] = float(self._wheel_cx_off.value())
        self._doc["wheelCenterOffsetYPx"] = float(self._wheel_cy_off.value())
        self._doc["pointerOffsetXPx"] = float(self._ptr_ox.value())
        self._doc["pointerOffsetYPx"] = float(self._ptr_oy.value())
        self._doc["sectorAngleOffsetDeg"] = float(self._angle.value())
        self._doc["sectorCenterPhase"] = float(self._sector_phase.value())
        self._doc["pointerArtOffsetDeg"] = float(self._pointer_art_deg.value())
        self._doc["sectorDirection"] = self._direction.currentText()
        self._doc["powerChargeMs"] = int(round(self._charge_ms.value()))
        self._doc["minLaunchPower"] = float(self._min_power.value())
        self._doc["powerChargeCurve"] = float(self._charge_curve.value())
        self._doc["spinLinearDragPerSec"] = float(self._drag.value())
        self._doc["spinDragLowSpeedThresholdRadPerSec"] = float(self._drag_low_thr.value())
        self._doc["spinDragLowSpeedBoostPerSec"] = float(self._drag_low_boost.value())
        self._doc["spinChargeMinVelocityRadPerSec"] = float(self._v_min.value())
        self._doc["spinChargeMaxVelocityRadPerSec"] = float(self._v_max.value())
        self._doc["spinChargeMinAccelRadPerSec2"] = float(self._a_min.value())
        self._doc["spinChargeMaxAccelRadPerSec2"] = float(self._a_max.value())
        self._doc["spinAccelHalfLifeSec"] = float(self._a_hl.value())
        self._doc["spinStopSpeedRadPerSec"] = float(self._stop_w.value())
        self._doc["spinStopSettleSec"] = float(self._stop_settle.value())
        self._doc["spinDryFrictionAccelRadPerSec2"] = float(self._dry_fric.value())
        self._doc["spinWeightBiasCreepRefRadPerSec"] = float(self._bias_creep.value())
        self._doc["speechDurationMs"] = int(round(self._speech_dur.value()))
        self._doc.pop("speechMaxVisible", None)
        if self._charge_json_explicit:
            self._doc["chargeButtonWheelOffsetXPx"] = float(self._charge_btn_ox.value())
            self._doc["chargeButtonWheelOffsetYPx"] = float(self._charge_btn_oy.value())
            self._doc["chargeButtonDiameterPx"] = float(self._charge_btn_d.value())
        else:
            for k in ("chargeButtonWheelOffsetXPx", "chargeButtonWheelOffsetYPx", "chargeButtonDiameterPx"):
                self._doc.pop(k, None)
        self._mark_dirty()

    def _on_sector_item_changed(self, item: QTableWidgetItem) -> None:
        if self._loading or not self._doc:
            return
        sectors = self._sectors()
        r = item.row()
        if r < 0 or r >= len(sectors):
            return
        sec = sectors[r]
        sec["id"] = (self._sector_table.item(r, 0).text() if self._sector_table.item(r, 0) else "").strip()
        sec["label"] = (self._sector_table.item(r, 1).text() if self._sector_table.item(r, 1) else "").strip()
        w_txt = (self._sector_table.item(r, 2).text() if self._sector_table.item(r, 2) else "").strip()
        if w_txt:
            try:
                wval = float(w_txt)
                if not math.isfinite(wval):
                    raise ValueError()
                sec["weight"] = max(0.0, wval)
            except ValueError:
                self._loading = True
                try:
                    tw_cell = self._sector_table.item(r, 2)
                    if tw_cell is not None:
                        old = sec.get("weight")
                        tw_cell.setText("" if old is None else str(old))
                finally:
                    self._loading = False
                return
        else:
            sec.pop("weight", None)
        p_txt = (self._sector_table.item(r, 3).text() if self._sector_table.item(r, 3) else "").strip()
        if p_txt:
            try:
                payload = json.loads(p_txt)
                if isinstance(payload, dict):
                    sec["payload"] = payload
                else:
                    sec["payload"] = {"value": payload}
            except json.JSONDecodeError:
                return
        else:
            sec.pop("payload", None)
        self._mark_dirty()

    def _add_sector(self) -> None:
        if not self._doc:
            return
        sectors = self._sectors()
        n = len(sectors) + 1
        sectors.append({"id": f"sector_{n}", "label": f"格子{n}"})
        self._mark_dirty()
        self._fill_sectors(len(sectors) - 1)

    def _delete_sector(self) -> None:
        if not self._doc:
            return
        r = self._sector_table.currentRow()
        sectors = self._sectors()
        if r < 0 or r >= len(sectors):
            return
        if not confirm.confirm_delete(self, f"扇区「{sectors[r].get('id', '')}」"):
            return
        sectors.pop(r)
        self._mark_dirty()
        n = len(sectors)
        hint = max(0, min(r, n - 1)) if n > 0 else -1
        self._fill_sectors(hint)

    def _move_sector(self, direction: int) -> None:
        if not self._doc:
            return
        r = self._sector_table.currentRow()
        sectors = self._sectors()
        if r < 0 or r >= len(sectors):
            return
        nr = r + direction
        if nr < 0 or nr >= len(sectors):
            return
        sectors[r], sectors[nr] = sectors[nr], sectors[r]
        self._mark_dirty()
        self._fill_sectors(nr)

    def _add_instance(self) -> None:
        raw, ok = QInputDialog.getText(self, "新增转盘实例", "实例 id（将作为文件名 stem）：")
        if not ok:
            return
        iid = raw.strip()
        if not _ID_RE.match(iid):
            QMessageBox.warning(self, "转盘小游戏", "id 格式不正确")
            return
        if iid in self._model.sugar_wheel_instances:
            QMessageBox.warning(self, "转盘小游戏", "该 id 已存在")
            return
        fname = f"{iid}.json"
        self._model.sugar_wheel_index.append({"id": iid, "label": "新转盘", "file": fname})
        self._model.sugar_wheel_instances[iid] = {
            "id": iid,
            "label": "新转盘",
            "backgroundImage": _DEFAULT_BG,
            "backgroundFit": "cover",
            "foregroundImage": _DEFAULT_FOREGROUND,
            "foregroundFit": "cover",
            "wheelImage": _DEFAULT_WHEEL,
            "pointerImage": _DEFAULT_POINTER,
            "pointerAnchorX": 0.5,
            "pointerAnchorY": 0.9,
            "pointerScale": 1,
            "wheelScale": 1,
            "wheelMaxSizePercent": 0.72,
            "wheelMaxSizePx": 660,
            "wheelCenterOffsetXPx": 0,
            "wheelCenterOffsetYPx": 0,
            "pointerOffsetXPx": 0,
            "pointerOffsetYPx": 0,
            "sectorAngleOffsetDeg": 0,
            "sectorCenterPhase": 0,
            "pointerArtOffsetDeg": 0,
            "sectorDirection": "clockwise",
            "powerChargeMs": 2600,
            "minLaunchPower": 0,
            "powerChargeCurve": 1.4,
            "spinLinearDragPerSec": 0.52,
            "spinDragLowSpeedThresholdRadPerSec": 2.2,
            "spinDragLowSpeedBoostPerSec": 2.0,
            "spinChargeMinVelocityRadPerSec": 0,
            "spinChargeMaxVelocityRadPerSec": 10.5,
            "spinChargeMinAccelRadPerSec2": 0,
            "spinChargeMaxAccelRadPerSec2": 8.5,
            "spinAccelHalfLifeSec": 0.42,
            "spinStopSpeedRadPerSec": 0.06,
            "spinStopSettleSec": 0.12,
            "spinDryFrictionAccelRadPerSec2": 0.34,
            "spinWeightBiasCreepRefRadPerSec": 1.2,
            "sectors": [{"id": "sector_1", "label": "格子1"}],
        }
        self._model.mark_dirty("sugar_wheel")
        self._reload_list(iid)

    def _delete_instance(self) -> None:
        if not self._current_id:
            return
        iid = self._current_id
        if QMessageBox.question(self, "转盘小游戏", f"删除实例 {iid!r}？") != QMessageBox.StandardButton.Yes:
            return
        self._model.sugar_wheel_index = [
            x for x in self._model.sugar_wheel_index
            if not (isinstance(x, dict) and str(x.get("id")) == iid)
        ]
        self._model.sugar_wheel_instances.pop(iid, None)
        self._model.mark_dirty("sugar_wheel")
        self._reload_list(None)

    def _preview(self) -> None:
        if self._current_id:
            self.preview_requested.emit(self._current_id)

    # ── 氛围脚本 helpers ──

    def _atmos_groups(self) -> list[dict]:
        assert self._doc is not None
        raw = self._doc.setdefault("atmosphereGroups", [])
        if not isinstance(raw, list):
            raw = []
            self._doc["atmosphereGroups"] = raw
        return raw

    def _fill_atmos_group_list(self) -> None:
        self._atmos_group_list.blockSignals(True)
        self._atmos_group_list.clear()
        if self._doc:
            for g in self._atmos_groups():
                gid = str(g.get("id") or "").strip()
                lab = str(g.get("label") or gid)
                self._atmos_group_list.addItem(f"{lab}  [{gid}]")
        self._atmos_group_list.blockSignals(False)

    def _fill_atmos_group_detail(self) -> None:
        self._loading = True
        try:
            r = self._atmos_group_list.currentRow()
            groups = self._atmos_groups() if self._doc else []
            if r < 0 or r >= len(groups):
                self._atmos_group_id.setText("")
                self._atmos_group_label.setText("")
                self._atmos_group_weight.setValue(1)
                self._var_pool_list.clear()
                self._var_lines_list.clear()
                for pname in self._ATMOS_PHASE_NAMES:
                    self._atmos_step_tables[pname].setRowCount(0)
                return
            g = groups[r]
            self._atmos_group_id.setText(str(g.get("id") or ""))
            self._atmos_group_label.setText(str(g.get("label") or ""))
            self._atmos_group_weight.setValue(_num(g.get("weight"), 1))
            self._fill_var_pool_list(g)
            for pname in self._ATMOS_PHASE_NAMES:
                self._fill_atmos_step_table(pname, g.get(pname))
        finally:
            self._loading = False

    def _on_atmos_group_selected(self, _row: int) -> None:
        self._fill_atmos_group_detail()

    def _add_atmos_group(self) -> None:
        if not self._doc:
            return
        groups = self._atmos_groups()
        n = len(groups) + 1
        groups.append({"id": f"group_{n}", "label": f"氛围{n}", "weight": 1, "vars": {}})
        self._fill_atmos_group_list()
        self._atmos_group_list.setCurrentRow(len(groups) - 1)
        self._mark_dirty(refresh_canvas=False)

    def _del_atmos_group(self) -> None:
        if not self._doc:
            return
        r = self._atmos_group_list.currentRow()
        groups = self._atmos_groups()
        if r < 0 or r >= len(groups):
            return
        if not confirm.confirm_delete(self, "该氛围分组及其全部步骤"):
            return
        groups.pop(r)
        self._fill_atmos_group_list()
        self._fill_atmos_group_detail()
        self._mark_dirty(refresh_canvas=False)

    def _dup_atmos_group(self) -> None:
        if not self._doc:
            return
        r = self._atmos_group_list.currentRow()
        groups = self._atmos_groups()
        if r < 0 or r >= len(groups):
            return
        import copy
        dup = copy.deepcopy(groups[r])
        dup["id"] = str(dup.get("id", "")) + "_copy"
        dup["label"] = str(dup.get("label", "")) + " (副本)"
        groups.insert(r + 1, dup)
        self._fill_atmos_group_list()
        self._atmos_group_list.setCurrentRow(r + 1)
        self._mark_dirty(refresh_canvas=False)

    def _on_atmos_group_field_changed(self, *_a: Any) -> None:
        if self._loading or not self._doc:
            return
        r = self._atmos_group_list.currentRow()
        groups = self._atmos_groups()
        if r < 0 or r >= len(groups):
            return
        g = groups[r]
        g["id"] = self._atmos_group_id.text().strip()
        g["label"] = self._atmos_group_label.text().strip()
        g["weight"] = float(self._atmos_group_weight.value())
        old_text = self._atmos_group_list.item(r)
        if old_text:
            old_text.setText(f"{g.get('label') or g['id']}  [{g['id']}]")
        self._mark_dirty(refresh_canvas=False)

    # ── vars 文案池 UI ──

    def _cur_atmos_group(self) -> dict | None:
        if not self._doc:
            return None
        r = self._atmos_group_list.currentRow()
        groups = self._atmos_groups()
        if r < 0 or r >= len(groups):
            return None
        return groups[r]

    def _cur_vars(self) -> dict:
        g = self._cur_atmos_group()
        if g is None:
            return {}
        v = g.setdefault("vars", {})
        if not isinstance(v, dict):
            v = {}
            g["vars"] = v
        return v

    def _fill_var_pool_list(self, g: dict) -> None:
        self._var_pool_list.blockSignals(True)
        self._var_pool_list.clear()
        self._var_lines_list.clear()
        v = g.get("vars")
        if isinstance(v, dict):
            for k in v:
                self._var_pool_list.addItem(str(k))
        self._var_pool_list.blockSignals(False)
        if self._var_pool_list.count() > 0:
            self._var_pool_list.setCurrentRow(0)
            self._fill_var_lines()

    def _fill_var_lines(self) -> None:
        self._var_lines_list.blockSignals(True)
        self._var_lines_list.clear()
        v = self._cur_vars()
        pool_name = self._var_pool_list.currentItem()
        if pool_name is not None:
            arr = v.get(pool_name.text())
            if isinstance(arr, list):
                for line in arr:
                    it = QListWidgetItem(str(line))
                    it.setFlags(it.flags() | Qt.ItemFlag.ItemIsEditable)
                    self._var_lines_list.addItem(it)
        self._var_lines_list.blockSignals(False)

    def _on_var_pool_selected(self, _row: int) -> None:
        self._fill_var_lines()

    def _add_var_pool(self) -> None:
        g = self._cur_atmos_group()
        if g is None:
            return
        name, ok = QInputDialog.getText(self, "新文案池", "池名称：")
        if not ok or not name.strip():
            return
        name = name.strip()
        v = self._cur_vars()
        if name in v:
            QMessageBox.warning(self, "文案池", f"池 '{name}' 已存在")
            return
        v[name] = []
        self._loading = True
        try:
            self._fill_var_pool_list(g)
            for i in range(self._var_pool_list.count()):
                if self._var_pool_list.item(i).text() == name:
                    self._var_pool_list.setCurrentRow(i)
                    break
        finally:
            self._loading = False
        self._mark_dirty(refresh_canvas=False)

    def _del_var_pool(self) -> None:
        g = self._cur_atmos_group()
        if g is None:
            return
        cur = self._var_pool_list.currentItem()
        if cur is None:
            return
        if not confirm.confirm_delete(self, f"变量池「{cur.text()}」"):
            return
        v = self._cur_vars()
        v.pop(cur.text(), None)
        self._loading = True
        try:
            self._fill_var_pool_list(g)
        finally:
            self._loading = False
        self._mark_dirty(refresh_canvas=False)

    def _rename_var_pool(self) -> None:
        g = self._cur_atmos_group()
        if g is None:
            return
        cur = self._var_pool_list.currentItem()
        if cur is None:
            return
        old_name = cur.text()
        new_name, ok = QInputDialog.getText(self, "改名", "新池名称：", text=old_name)
        if not ok or not new_name.strip() or new_name.strip() == old_name:
            return
        new_name = new_name.strip()
        v = self._cur_vars()
        if new_name in v:
            QMessageBox.warning(self, "文案池", f"池 '{new_name}' 已存在")
            return
        arr = v.pop(old_name, [])
        v[new_name] = arr
        self._loading = True
        try:
            self._fill_var_pool_list(g)
        finally:
            self._loading = False
        self._mark_dirty(refresh_canvas=False)

    def _add_var_line(self) -> None:
        g = self._cur_atmos_group()
        if g is None:
            return
        cur = self._var_pool_list.currentItem()
        if cur is None:
            return
        v = self._cur_vars()
        arr = v.setdefault(cur.text(), [])
        arr.append("")
        it = QListWidgetItem("")
        it.setFlags(it.flags() | Qt.ItemFlag.ItemIsEditable)
        self._var_lines_list.addItem(it)
        self._var_lines_list.setCurrentItem(it)
        self._var_lines_list.editItem(it)
        self._mark_dirty(refresh_canvas=False)

    def _del_var_line(self) -> None:
        g = self._cur_atmos_group()
        if g is None:
            return
        cur_pool = self._var_pool_list.currentItem()
        if cur_pool is None:
            return
        r = self._var_lines_list.currentRow()
        v = self._cur_vars()
        arr = v.get(cur_pool.text())
        if not isinstance(arr, list) or r < 0 or r >= len(arr):
            return
        arr.pop(r)
        self._var_lines_list.takeItem(r)
        self._mark_dirty(refresh_canvas=False)

    def _on_var_line_changed(self, item: QListWidgetItem) -> None:
        if self._loading:
            return
        cur_pool = self._var_pool_list.currentItem()
        if cur_pool is None:
            return
        r = self._var_lines_list.row(item)
        v = self._cur_vars()
        arr = v.get(cur_pool.text())
        if not isinstance(arr, list) or r < 0 or r >= len(arr):
            return
        arr[r] = item.text()
        self._mark_dirty(refresh_canvas=False)

    # ── 步骤表格 UI ──

    _STEP_OP_CHOICES = ["say", "pick", "wait", "chance", "when_near_sector"]

    def _make_atmos_op_combo(self, pname: str, current: str) -> QComboBox:
        """op 是闭合枚举(say/pick/wait/chance/when_near_sector),用下拉避免手打错。
        未知 op 也作为选项保留,不静默改写既有数据。"""
        cb = QComboBox()
        choices = ["say", "pick", "wait", "chance", "when_near_sector"]
        cb.addItems(choices)
        cur = (current or "say").strip()
        if cur and cur not in choices:
            cb.addItem(cur)
        idx = cb.findText(cur)
        cb.setCurrentIndex(idx if idx >= 0 else 0)
        cb.currentIndexChanged.connect(
            lambda _i, _p=pname: self._pull_atmos_step_from_ui(_p))
        return cb

    def _atmos_sector_ids(self) -> list[str]:
        """只读取本实例已定义的格子 id(不触发 setdefault,避免导航时改动数据)。"""
        doc = self._doc if isinstance(self._doc, dict) else {}
        raw = doc.get("sectors")
        if not isinstance(raw, list):
            return []
        return [str(x.get("id", "")) for x in raw
                if isinstance(x, dict) and x.get("id")]

    def _make_atmos_sector_combo(self, pname: str, current: str) -> QComboBox:
        """sectorId 指向本实例已定义的格子;用下拉避免手打错。
        空 = 不指定(read 对空值跳过写入);未知 id 也保留为选项,不静默丢弃。"""
        cb = QComboBox()
        cb.addItem("")
        ids = self._atmos_sector_ids()
        for sid in ids:
            cb.addItem(sid)
        cur = (current or "").strip()
        if cur and cur not in ids:
            cb.addItem(cur)
        if not cur:
            cb.setCurrentIndex(0)
        else:
            idx = cb.findText(cur)
            cb.setCurrentIndex(idx if idx >= 0 else 0)
        cb.currentIndexChanged.connect(
            lambda _i, _p=pname: self._pull_atmos_step_from_ui(_p))
        return cb

    def _fill_atmos_step_table(self, pname: str, steps: Any) -> None:
        tbl = self._atmos_step_tables[pname]
        tbl.blockSignals(True)
        try:
            tbl.setRowCount(0)
            if isinstance(steps, list):
                tbl.setRowCount(len(steps))
                for i, s in enumerate(steps):
                    if not isinstance(s, dict):
                        s = {}
                    tbl.setCellWidget(i, 0, self._make_atmos_op_combo(pname, str(s.get("op", "say"))))
                    cb = QComboBox()
                    self._fill_atmos_role_combo(cb, str(s.get("role", "")))
                    cb.currentIndexChanged.connect(
                        lambda _idx, _p=pname: self._pull_atmos_step_from_ui(_p))
                    tbl.setCellWidget(i, 1, cb)
                    pool_or_text = str(s.get("pool") or s.get("text") or "")
                    tbl.setItem(i, 2, QTableWidgetItem(pool_or_text))
                    tbl.setItem(i, 3, QTableWidgetItem(str(s.get("sec", "")) if "sec" in s else ""))
                    tbl.setItem(i, 4, QTableWidgetItem(str(s.get("p", "")) if "p" in s else ""))
                    tbl.setCellWidget(i, 5, self._make_atmos_sector_combo(pname, str(s.get("sectorId", ""))))
                    tbl.setItem(i, 6, QTableWidgetItem(str(s.get("degBuffer", "")) if "degBuffer" in s else ""))
        finally:
            tbl.blockSignals(False)

    def _read_atmos_step_table(self, pname: str) -> list[dict]:
        tbl = self._atmos_step_tables[pname]
        out: list[dict] = []
        for r in range(tbl.rowCount()):
            def _cell(c: int) -> str:
                it = tbl.item(r, c)
                return it.text().strip() if it else ""
            _op_w = tbl.cellWidget(r, 0)
            op = (_op_w.currentText().strip() if isinstance(_op_w, QComboBox) else _cell(0)) or "say"
            step: dict[str, Any] = {"op": op}
            role = self._role_cell_from_atmos_table(tbl, r)
            pool_or_text = _cell(2)
            sec = _cell(3)
            p = _cell(4)
            _sid_w = tbl.cellWidget(r, 5)
            sid = (_sid_w.currentText().strip() if isinstance(_sid_w, QComboBox) else _cell(5))
            deg = _cell(6)
            if op == "say":
                if role:
                    step["role"] = role
                v = self._cur_vars()
                if pool_or_text in v:
                    step["pool"] = pool_or_text
                elif pool_or_text:
                    step["text"] = pool_or_text
            elif op == "pick":
                if pool_or_text:
                    step["pool"] = pool_or_text
            elif op == "wait":
                try:
                    step["sec"] = float(sec) if sec else 1.0
                except ValueError:
                    step["sec"] = 1.0
            elif op == "chance":
                try:
                    step["p"] = max(0.0, min(1.0, float(p))) if p else 0.5
                except ValueError:
                    step["p"] = 0.5
            elif op == "when_near_sector":
                if sid:
                    step["sectorId"] = sid
                try:
                    step["degBuffer"] = float(deg) if deg else 15.0
                except ValueError:
                    step["degBuffer"] = 15.0
            out.append(step)
        return out

    def _atmos_step_add(self, pname: str) -> None:
        if not self._doc:
            return
        g = self._cur_atmos_group()
        if g is None:
            return
        steps = g.setdefault(pname, [])
        if not isinstance(steps, list):
            steps = []
            g[pname] = steps
        steps.append({"op": "say", "role": self._default_atmos_say_role(), "text": ""})
        self._loading = True
        try:
            self._fill_atmos_step_table(pname, steps)
        finally:
            self._loading = False
        tbl = self._atmos_step_tables[pname]
        tbl.selectRow(tbl.rowCount() - 1)
        self._mark_dirty(refresh_canvas=False)

    def _atmos_step_del(self, pname: str) -> None:
        if not self._doc:
            return
        g = self._cur_atmos_group()
        if g is None:
            return
        tbl = self._atmos_step_tables[pname]
        r = tbl.currentRow()
        steps = g.get(pname)
        if not isinstance(steps, list) or r < 0 or r >= len(steps):
            return
        steps.pop(r)
        self._loading = True
        try:
            self._fill_atmos_step_table(pname, steps)
        finally:
            self._loading = False
        self._mark_dirty(refresh_canvas=False)

    def _atmos_step_move(self, pname: str, direction: int) -> None:
        if not self._doc:
            return
        g = self._cur_atmos_group()
        if g is None:
            return
        tbl = self._atmos_step_tables[pname]
        r = tbl.currentRow()
        steps = g.get(pname)
        if not isinstance(steps, list) or r < 0 or r >= len(steps):
            return
        nr = r + direction
        if nr < 0 or nr >= len(steps):
            return
        steps[r], steps[nr] = steps[nr], steps[r]
        self._loading = True
        try:
            self._fill_atmos_step_table(pname, steps)
        finally:
            self._loading = False
        tbl.selectRow(nr)
        self._mark_dirty(refresh_canvas=False)

    def _on_atmos_step_item_changed(self, pname: str) -> None:
        self._pull_atmos_step_from_ui(pname)

    def flush_to_model(self) -> None:
        # 保存前先把"懒回写"的编辑器内容落进模型：当前激活 sector 的动作、充能前置
        # 条件/动作等都是切行/切实例时才提交，若不在此 flush，未切换的最后一处编辑
        # 会在 Save All 时静默丢失（save-roundtrip 数据丢失）。
        if self._doc is not None:
            self._flush_before_charge_from_editors()
            if self._selected_sector_row >= 0:
                self._flush_sector_actions_row(self._selected_sector_row)
        for iid, doc in self._model.sugar_wheel_instances.items():
            if not isinstance(doc, dict):
                raise ValueError(f"sugar_wheel[{iid}]: 根必须为对象")
            for key in ("wheelImage", "pointerImage"):
                if not str(doc.get(key) or "").strip():
                    raise ValueError(f"sugar_wheel[{iid}]: {key} 不能为空")
            sectors = doc.get("sectors")
            if not isinstance(sectors, list) or not sectors:
                raise ValueError(f"sugar_wheel[{iid}]: sectors 必须为非空数组")
            seen: set[str] = set()
            for sec in sectors:
                if not isinstance(sec, dict):
                    continue
                sid = str(sec.get("id") or "").strip()
                if not sid:
                    raise ValueError(f"sugar_wheel[{iid}]: sector id 不能为空")
                if sid in seen:
                    raise ValueError(f"sugar_wheel[{iid}]: 重复 sector id {sid!r}")
                seen.add(sid)
                wt = sec.get("weight")
                if wt is not None:
                    try:
                        wf = float(wt)
                    except (TypeError, ValueError):
                        raise ValueError(f"sugar_wheel[{iid}] sector[{sid}]: weight 须为数字（或省略）")
                    if not math.isfinite(wf) or wf < 0:
                        raise ValueError(f"sugar_wheel[{iid}] sector[{sid}]: weight 须为有限非负数")
                for ak in ("actionsOnPointerDrag", "actionsOnSpinLanding"):
                    av = sec.get(ak)
                    if av is None:
                        continue
                    if not isinstance(av, list):
                        raise ValueError(f"sugar_wheel[{iid}] sector[{sid}]: {ak} 须为数组（或省略）")
                    for j, act in enumerate(av):
                        if not isinstance(act, dict):
                            raise ValueError(f"sugar_wheel[{iid}] sector[{sid}]: {ak}[{j}] 须为对象")
                        t = act.get("type")
                        if not str(t or "").strip():
                            raise ValueError(f"sugar_wheel[{iid}] sector[{sid}]: {ak}[{j}].type 不能为空")
