"""水域小游戏编辑器画布：对齐 WaterMinigameScene 的水底绘制与 WaterEntity 的精灵尺度/深度偏移。"""
from __future__ import annotations

import math
from typing import Any

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QGraphicsItem,
    QGraphicsPixmapItem,
    QGraphicsScene,
    QGraphicsView,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from ..project_model import ProjectModel
from ..shared.image_path_picker import disk_path_for_runtime_url


def _load_runtime_pixmap(model: ProjectModel | None, url: str) -> QPixmap | None:
    u = (url or "").strip()
    if not u:
        return None
    if u.startswith("assets/"):
        u = "/" + u
    elif not u.startswith("/"):
        u = "/" + u.lstrip("/")
    if not u.startswith("/assets/"):
        return None
    if model is None or not model.project_path:
        return None
    disk = disk_path_for_runtime_url(model, u)
    if disk is None or not disk.is_file():
        return None
    pm = QPixmap(str(disk))
    return pm if not pm.isNull() else None


def _placeholder_pixmap(w: int = 64, h: int = 64) -> QPixmap:
    pm = QPixmap(w, h)
    pm.fill(QColor(60, 65, 78))
    p = QPainter(pm)
    p.setPen(QPen(QColor(140, 150, 170), 2))
    p.drawLine(0, 0, w, h)
    p.drawLine(w, 0, 0, h)
    p.end()
    return pm


def _parse_tint_hex(raw: str | None, fallback: int = 0x18324A) -> int:
    if not raw:
        return fallback
    s = str(raw).strip()
    if not s:
        return fallback
    hx = s[1:] if s.startswith("#") else s
    if len(hx) == 3:
        hx = "".join(c * 2 for c in hx)
    try:
        n = int(hx, 16)
    except ValueError:
        return fallback
    return n if 0 <= n <= 0xFFFFFF else fallback


def _target_edge_for_category(cat: str) -> int:
    if cat == "grass":
        return 56
    if cat == "floating":
        return 48
    return 44


def _depth_offset_y(ent: dict[str, Any]) -> float:
    """与 WaterEntity.depthOffsetY 一致：effectiveDepth≈静态 def.depth（忽略 depthOsc 相位）。"""
    d = max(0.0, float(ent.get("depth") if ent.get("depth") is not None else 0))
    osc = ent.get("depthOsc")
    if isinstance(osc, dict) and str(osc.get("curve") or "none") != "none":
        amp = float(osc.get("amplitude") or 0)
        if amp != 0:
            d = max(0.0, d + amp * math.sin(0))  # t=0 时 sine 相位用 0
    ed = min(d, 1.35)
    return ed * 18.0


def _ambient_murk(weather: str) -> float:
    w = (weather or "clear").strip().lower()
    if w == "rain":
        return 0.55
    if w == "fog":
        return 0.8
    return 0.35


def _approx_sprite_tint_rgb(
    depth: float,
    *,
    weather: str,
    timeofday: str,
    glow: dict[str, Any] | None,
) -> tuple[int, int, int]:
    """粗略对应 WaterEntity.applyTint（静态帧）。"""
    depth_vis = min(max(0.0, depth), 1.0)
    murk = _ambient_murk(weather)
    lum = 1.1 - depth_vis * 0.55 - murk * 0.35
    r, g, b = lum, lum * 0.98, lum * 1.02

    if isinstance(glow, dict) and glow.get("enabled"):
        gh = glow.get("color")
        if isinstance(gh, str) and gh.strip().startswith("#"):
            hc = QColor(gh.strip())
            if hc.isValid():
                hint = float(glow.get("daylightHint") if glow.get("daylightHint") is not None else 0.4)
                hint = min(1.0, max(0.0, hint))
                cr, cg, cb = hc.red() / 255.0, hc.green() / 255.0, hc.blue() / 255.0
                r = r * (1 - hint) + cr * hint
                g = g * (1 - hint) + cg * hint
                b = b * (1 - hint) + cb * hint

    td = (timeofday or "day").strip().lower()
    if td == "night":
        r *= 0.55
        g *= 0.6
        b *= 0.75
    elif td == "morning":
        r *= 1.05
        g *= 0.97
        b *= 0.9

    return (
        max(0, min(255, int(r * 255))),
        max(0, min(255, int(g * 255))),
        max(0, min(255, int(b * 255))),
    )


def _tint_pixmap_visual(pm: QPixmap, depth: float, ambient: tuple[str, str], glow: dict[str, Any] | None) -> QPixmap:
    tr, tg, tb = _approx_sprite_tint_rgb(depth, weather=ambient[1], timeofday=ambient[0], glow=glow)
    out = QPixmap(pm.size())
    out.fill(Qt.GlobalColor.transparent)
    p = QPainter(out)
    p.drawPixmap(0, 0, pm)
    p.setCompositionMode(QPainter.CompositionMode_Multiply)
    p.fillRect(out.rect(), QColor(tr, tg, tb))
    p.end()
    return out


class _WaterBackdropScene(QGraphicsScene):
    """对齐 setupBottomLayer：tint 底 + 装饰线 + 贴图铺满 bounds，alpha≈0.9。

    水底贴图用最低层 QGraphicsPixmapItem 绘制，避免仅靠 BackgroundLayer 时 SmartViewportUpdate 不重绘导致「看不见背景」。
    """

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._texture_item: QGraphicsPixmapItem | None = None
        self._tint_argb: int = 0xFF18324A

    def set_backdrop(self, pm: QPixmap | None, tint_hex: str) -> None:
        self._tint_argb = 0xFF000000 | _parse_tint_hex(tint_hex, 0x18324A)
        if self._texture_item is not None:
            self.removeItem(self._texture_item)
            self._texture_item = None

        base_pm = pm if pm is not None and not pm.isNull() else None
        r = self.sceneRect()
        bw = max(1, int(r.width()))
        bh = max(1, int(r.height()))
        if base_pm is not None:
            scaled = base_pm.scaled(
                bw,
                bh,
                Qt.AspectRatioMode.IgnoreAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
            self._texture_item = QGraphicsPixmapItem(scaled)
            self._texture_item.setPos(r.left(), r.top())
            self._texture_item.setZValue(-1e9)
            self._texture_item.setOpacity(0.9)
            self._texture_item.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, False)
            self._texture_item.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsFocusable, False)
            self.addItem(self._texture_item)

        self.invalidate(r, QGraphicsScene.SceneLayer.AllLayers)

    def drawBackground(self, painter: QPainter, rect: QRectF) -> None:  # noqa: ARG002
        r = self.sceneRect()
        c = QColor(self._tint_argb)
        painter.fillRect(r, c)

        bh = max(1.0, r.height())
        bw = max(1.0, r.width())
        for y in range(0, int(bh), 48):
            t = y / bh
            painter.fillRect(
                QRectF(r.left(), r.top() + y, bw, 24),
                QColor(7, 20, 33, int(255 * (0.06 + t * 0.16))),
            )
        pen = QPen(QColor(47, 82, 102, int(255 * 0.16)))
        pen.setWidth(1)
        painter.setPen(pen)
        for x in range(0, int(bw), 64):
            painter.drawLine(QPointF(r.left() + x, r.top()), QPointF(r.left() + x + 34, r.bottom()))

    def drawForeground(self, painter: QPainter, rect: QRectF) -> None:  # noqa: ARG002
        r = self.sceneRect()
        painter.setPen(QPen(QColor(255, 255, 255, 160), 1))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRect(r)


class EntitySpriteItem(QGraphicsPixmapItem):
    """
    JSON pos 为游戏 container 原点；视觉中心为 (pos.x, pos.y + depthOffsetY)。
    此处 item.pos() = 视觉中心 scene 坐标；存盘时 container = 中心 - (0, depthOff)。
    """

    def __init__(
        self,
        row_index: int,
        ent: dict[str, Any],
        canvas: WaterMinigameSceneCanvas,
        pm: QPixmap,
        *,
        ambient: tuple[str, str],
    ):
        cat = str(ent.get("category") or "sunken")
        tw = max(1, pm.width())
        th = max(1, pm.height())
        base = max(tw, th)
        target = _target_edge_for_category(cat)
        sc = target / base if base > 0 else 1.0
        sw = max(1, int(round(tw * sc)))
        sh = max(1, int(round(th * sc)))
        scaled = pm.scaled(sw, sh, Qt.AspectRatioMode.IgnoreAspectRatio, Qt.TransformationMode.SmoothTransformation)

        depth = float(ent.get("depth") if ent.get("depth") is not None else 0)
        glow = ent.get("glow") if isinstance(ent.get("glow"), dict) else None
        vis_pm = _tint_pixmap_visual(scaled, depth, ambient, glow)

        super().__init__(vis_pm)
        self._row_index = row_index
        self._canvas = canvas
        self._half_w = vis_pm.width() / 2.0
        self._half_h = vis_pm.height() / 2.0
        self._depth_off = _depth_offset_y(ent)

        self.setOffset(-self._half_w, -self._half_h)
        self.setTransformationMode(Qt.TransformationMode.SmoothTransformation)

        pos = ent.get("pos") if isinstance(ent.get("pos"), dict) else {}
        px = float(pos.get("x") or 0)
        py = float(pos.get("y") or 0)
        cx = px
        cy = py + self._depth_off
        self.setPos(QPointF(cx, cy))

        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges, True)

        eid = str(ent.get("id") or "")
        self.setToolTip(f"{eid}  [{cat}]")

        zbase = 100.0 if cat == "floating" else 50.0
        self.setZValue(zbase + row_index * 0.05)

    def row_index(self) -> int:
        return self._row_index

    def set_row_index(self, idx: int) -> None:
        self._row_index = idx

    def refresh_geometry_from_ent(self, ent: dict[str, Any], pm: QPixmap, ambient: tuple[str, str]) -> None:
        """同构造逻辑，用于属性面板改了 sprite/depth/category。"""
        cat = str(ent.get("category") or "sunken")
        tw = max(1, pm.width())
        th = max(1, pm.height())
        base = max(tw, th)
        target = _target_edge_for_category(cat)
        sc = target / base if base > 0 else 1.0
        sw = max(1, int(round(tw * sc)))
        sh = max(1, int(round(th * sc)))
        scaled = pm.scaled(sw, sh, Qt.AspectRatioMode.IgnoreAspectRatio, Qt.TransformationMode.SmoothTransformation)
        depth = float(ent.get("depth") if ent.get("depth") is not None else 0)
        glow = ent.get("glow") if isinstance(ent.get("glow"), dict) else None
        vis_pm = _tint_pixmap_visual(scaled, depth, ambient, glow)
        self.setPixmap(vis_pm)
        self._half_w = vis_pm.width() / 2.0
        self._half_h = vis_pm.height() / 2.0
        self._depth_off = _depth_offset_y(ent)
        self.setOffset(-self._half_w, -self._half_h)
        pos = ent.get("pos") if isinstance(ent.get("pos"), dict) else {}
        px = float(pos.get("x") or 0)
        py = float(pos.get("y") or 0)
        self.setPos(QPointF(px, py + self._depth_off))
        zbase = 100.0 if cat == "floating" else 50.0
        self.setZValue(zbase + self._row_index * 0.05)
        self.setToolTip(f"{str(ent.get('id') or '')}  [{cat}]")

    def itemChange(self, change, value):  # noqa: ANN001
        if change == QGraphicsItem.GraphicsItemChange.ItemPositionChange:
            sc = self.scene()
            if sc is not None:
                sr = sc.sceneRect()
                new_center = QPointF(value)
                clamped = QPointF(
                    max(sr.left() + self._half_w, min(sr.right() - self._half_w, new_center.x())),
                    max(sr.top() + self._half_h, min(sr.bottom() - self._half_h, new_center.y())),
                )
                value = clamped
        res = super().itemChange(change, value)
        if change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged:
            self._canvas._on_entity_position_changed(self)
        return res

    def paint(self, painter: QPainter, option, widget=None):  # noqa: ANN001
        super().paint(painter, option, widget)
        if self.isSelected():
            painter.save()
            painter.setPen(QPen(QColor(255, 230, 80), 2, Qt.PenStyle.DashLine))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawRect(self.boundingRect())
            painter.restore()


def _entity_row_from_item(it: QGraphicsItem | None) -> int | None:
    while it is not None:
        if isinstance(it, EntitySpriteItem):
            return it.row_index()
        it = it.parentItem()
    return None


class WaterCanvasView(QGraphicsView):
    place_click = Signal(float, float)

    def __init__(self, scene: QGraphicsScene, parent: QWidget | None = None) -> None:
        super().__init__(scene, parent)
        self._place_mode = False
        self.setDragMode(QGraphicsView.DragMode.RubberBandDrag)
        self.setRenderHints(
            QPainter.RenderHint.Antialiasing | QPainter.RenderHint.SmoothPixmapTransform,
        )
        self.setMouseTracking(True)
        self.setViewportUpdateMode(QGraphicsView.ViewportUpdateMode.FullViewportUpdate)
        vp = self.viewport()
        vp.setAutoFillBackground(False)

    def set_place_mode(self, on: bool) -> None:
        self._place_mode = on
        self.setDragMode(
            QGraphicsView.DragMode.NoDrag if on else QGraphicsView.DragMode.RubberBandDrag,
        )
        self.setCursor(Qt.CursorShape.CrossCursor if on else Qt.CursorShape.ArrowCursor)

    def mousePressEvent(self, event):  # noqa: ANN001
        if self._place_mode and event.button() == Qt.MouseButton.LeftButton:
            hit = self.itemAt(event.pos())
            if hit is None or _entity_row_from_item(hit) is None:
                pt = self.mapToScene(event.position().toPoint())
                self.place_click.emit(pt.x(), pt.y())
                event.accept()
                return
        super().mousePressEvent(event)

    def wheelEvent(self, event):  # noqa: ANN001
        if event.angleDelta().y() == 0:
            super().wheelEvent(event)
            return
        factor = 1.12 if event.angleDelta().y() > 0 else 1 / 1.12
        self.scale(factor, factor)
        event.accept()


class WaterMinigameSceneCanvas(QWidget):
    entity_selected = Signal(int)
    entity_moved = Signal(int, float, float)
    place_requested = Signal(float, float)

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._items: list[EntitySpriteItem] = []
        self._silent_select = False
        self._suppress_moved = False
        self._ambient: tuple[str, str] = ("day", "clear")

        tb = QHBoxLayout()
        self._btn_fit = QPushButton("适应窗口")
        self._btn_place = QPushButton("点击放置实体")
        self._btn_place.setCheckable(True)
        self._btn_place.setToolTip("空白处点击新建；精灵尺度/色调与游戏中一致（无水面折射）")
        tb.addWidget(self._btn_fit)
        tb.addWidget(self._btn_place)
        tb.addWidget(QLabel("水底与精灵与运行时代码对齐；拖拽 = 移动实体位置"))
        tb.addStretch()

        self._scene = _WaterBackdropScene(self)
        self._view = WaterCanvasView(self._scene, self)
        self._view.setMinimumSize(420, 280)

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addLayout(tb)
        root.addWidget(self._view, stretch=1)

        self._btn_fit.clicked.connect(self._fit_view)
        self._btn_place.toggled.connect(self._view.set_place_mode)
        self._view.place_click.connect(self._on_place_click)
        self._scene.selectionChanged.connect(self._on_scene_selection_changed)

    def set_ambient(self, timeofday: str, weather: str) -> None:
        self._ambient = (timeofday.strip() or "day", weather.strip() or "clear")

    def _on_place_click(self, x: float, y: float) -> None:
        if self._btn_place.isChecked():
            self.place_requested.emit(float(x), float(y))

    def _on_entity_position_changed(self, it: EntitySpriteItem) -> None:
        if self._suppress_moved:
            return
        row = it.row_index()
        cx = float(it.pos().x())
        cy = float(it.pos().y())
        py = cy - it._depth_off
        self.entity_moved.emit(row, cx, py)

    def _on_scene_selection_changed(self) -> None:
        if self._silent_select:
            return
        for s in self._scene.selectedItems():
            if isinstance(s, EntitySpriteItem):
                self.entity_selected.emit(s.row_index())
                return
        self.entity_selected.emit(-1)

    def resizeEvent(self, event) -> None:  # noqa: ANN001
        super().resizeEvent(event)
        if self._scene.sceneRect().width() > 0:
            self._fit_view()

    def showEvent(self, event) -> None:  # noqa: ANN001
        super().showEvent(event)
        self._fit_view()

    def _fit_view(self) -> None:
        r = self._scene.sceneRect()
        if r.width() <= 0 or r.height() <= 0:
            return
        self._view.resetTransform()
        self._view.fitInView(r, Qt.AspectRatioMode.KeepAspectRatio)

    def refresh(
        self,
        *,
        bounds_wh: tuple[int, int],
        texture_url: str,
        tint_hex: str,
        entities: list[dict],
        selected_row: int,
        ambient: tuple[str, str] | None = None,
    ) -> None:
        if ambient:
            self._ambient = ambient

        bw, bh = bounds_wh
        bw = max(1, bw)
        bh = max(1, bh)
        self._scene.setSceneRect(QRectF(0, 0, float(bw), float(bh)))

        pm = _load_runtime_pixmap(self._model, texture_url)
        self._scene.set_backdrop(pm, tint_hex)

        for it in self._items:
            self._scene.removeItem(it)
        self._items.clear()

        for i, ent in enumerate(entities):
            if not isinstance(ent, dict):
                continue
            raw_pm = _load_runtime_pixmap(self._model, str(ent.get("sprite") or ""))
            base_pm = raw_pm if raw_pm is not None else _placeholder_pixmap()
            item = EntitySpriteItem(i, ent, self, base_pm, ambient=self._ambient)
            self._scene.addItem(item)
            self._items.append(item)

        self._silent_select = True
        self._scene.clearSelection()
        if 0 <= selected_row < len(self._items):
            self._items[selected_row].setSelected(True)
        self._silent_select = False
        self._fit_view()

    def set_selected_row(self, row: int) -> None:
        self._silent_select = True
        self._scene.clearSelection()
        if 0 <= row < len(self._items):
            self._items[row].setSelected(True)
        self._silent_select = False

    def update_marker_visual(self, row: int, entities: list[dict]) -> None:
        self.refresh_entity_row(row, entities)

    def refresh_entity_row(self, row: int, entities: list[dict]) -> None:
        """属性面板改了 sprite/category/depth 等时刷新单行。"""
        if not (0 <= row < len(self._items)) or row >= len(entities):
            return
        ent = entities[row]
        if not isinstance(ent, dict):
            return
        it = self._items[row]
        raw_pm = _load_runtime_pixmap(self._model, str(ent.get("sprite") or ""))
        pm = raw_pm if raw_pm is not None else _placeholder_pixmap()
        self._suppress_moved = True
        try:
            it.refresh_geometry_from_ent(ent, pm, ambient=self._ambient)
        finally:
            self._suppress_moved = False

    def set_marker_center(self, row: int, x: float, y: float) -> None:
        """x,y 为 JSON container.pos；视觉中心 y = y + depthOff。"""
        if not (0 <= row < len(self._items)):
            return
        it = self._items[row]
        self._suppress_moved = True
        try:
            cy = float(y) + it._depth_off
            it.setPos(QPointF(float(x), cy))
        finally:
            self._suppress_moved = False

    def set_place_mode(self, on: bool) -> None:
        self._btn_place.setChecked(on)
