"""Scene editor with visual canvas for hotspots, NPCs, zones, spawn points.

All canvas coordinates are in **world units**.  Background images are loaded
as textures and scaled into a world-sized quad so pixel resolution is
completely decoupled from the coordinate system.
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path, PurePosixPath

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget, QListWidgetItem,
    QGraphicsView, QGraphicsScene, QGraphicsEllipseItem, QGraphicsRectItem,
    QGraphicsItem, QGraphicsObject,
    QGraphicsPixmapItem, QGroupBox, QFormLayout, QLineEdit, QDoubleSpinBox,
    QSpinBox, QComboBox, QCheckBox, QLabel, QPushButton, QScrollArea,
    QStackedWidget, QTextEdit, QToolBar, QMenu, QGraphicsTextItem,
    QToolButton, QMessageBox, QDialog, QDialogButtonBox, QAbstractItemView,
    QSizePolicy, QGraphicsSceneMouseEvent, QGraphicsSceneHoverEvent,
    QGraphicsSceneContextMenuEvent, QTableWidget, QTableWidgetItem, QHeaderView,
)
from PySide6.QtGui import (
    QPixmap, QPen, QBrush, QColor, QFont, QPainter, QWheelEvent,
    QMouseEvent, QContextMenuEvent, QAction, QTransform, QPolygonF,
    QShortcut, QKeySequence, QPainterPath,
)
from PySide6.QtCore import Qt, QRect, QRectF, QPoint, QPointF, Signal, QTimer, QElapsedTimer

from ..project_model import ProjectModel
from ..shared.condition_editor import ConditionEditor
from ..shared.action_editor import ActionEditor
from ..shared.id_ref_selector import IdRefSelector

_HOTSPOT_COLORS = {
    "inspect": QColor(60, 140, 255, 160),
    "pickup": QColor(60, 200, 80, 160),
    "transition": QColor(255, 160, 40, 160),
    "npc": QColor(200, 100, 255, 160),
    "encounter": QColor(255, 60, 60, 160),
}
_NPC_COLOR = QColor(180, 80, 220, 180)
_ZONE_COLOR = QColor(255, 200, 0, 60)
_SPAWN_COLOR = QColor(255, 255, 255, 200)
_RANGE_PEN = QPen(QColor(255, 255, 255, 60), 0, Qt.PenStyle.DotLine)
# 场景视图中 NPC 比例参考框（与 SpriteEntity worldWidth/worldHeight 一致，非可编辑）
_NPC_REF_FILL = QColor(130, 220, 160, 55)
_NPC_REF_PEN = QPen(QColor(90, 180, 120), 0, Qt.PenStyle.DashLine)
_NPC_REF_MARGIN = 24.0
_NPC_REF_Z = -20.0
# 高于参考框、低于可拖实体（0），避免挡住点选 NPC
_NPC_SCENE_ANIM_PREVIEW_Z = -10.0
# 巡逻折线：高于精灵预览、高于 NPC 控制点，shape 仅顶点以便线段处点选 NPC
_PATROL_LINE_COLOR = QColor(0, 200, 220, 220)
_PATROL_OVERLAY_Z = 2.0


def _resolve_world_size(sc: dict, img_path: Path | None) -> tuple[float, float]:
    """Derive (worldWidth, worldHeight) from scene JSON + background image
    aspect ratio, mirroring the logic in the game's AssetManager."""
    ww = sc.get("worldWidth", 0)
    wh = sc.get("worldHeight", 0)
    if ww > 0 and wh > 0:
        return (ww, wh)

    aspect = 16 / 9
    if img_path and img_path.exists():
        pm = QPixmap(str(img_path))
        if not pm.isNull() and pm.width() > 0:
            aspect = pm.height() / pm.width()

    if ww > 0:
        return (ww, ww * aspect)
    if wh > 0:
        return (wh / aspect, wh)
    return (800, 800 * aspect)


def _anim_bundle_key_from_manifest_url(url: str) -> str:
    p = PurePosixPath(str(url).strip().replace("\\", "/").lstrip("/"))
    if p.name == "anim.json":
        return p.parent.name
    return p.stem


def _spritesheet_public_path(
    model: ProjectModel,
    spritesheet: str,
    anim_manifest_url: str | None,
) -> Path | None:
    """与运行时 resolvePathRelativeToAnimManifest 一致，返回 public 下的绝对路径。"""
    if not model.project_path:
        return None
    pub = model.project_path / "public"
    sh = str(spritesheet or "").strip()
    if not sh:
        return None
    if sh.startswith("/assets/"):
        return pub / sh.lstrip("/")
    if not anim_manifest_url:
        return None
    base = PurePosixPath(anim_manifest_url.strip().lstrip("/")).parent
    part = sh[2:] if sh.startswith("./") else sh
    return pub / (base / PurePosixPath(part))


def _resolved_anim_world_pair(
    data: dict,
    model: ProjectModel,
    *,
    anim_manifest_url: str | None = None,
) -> tuple[float, float] | None:
    """与运行时 normalizeAnimationSetDef 一致：worldWidth/worldHeight 可只填其一。"""
    cols = max(1, int(data.get("cols", 1) or 1))
    rows = max(1, int(data.get("rows", 1) or 1))
    w = float(data.get("worldWidth", 0) or 0)
    h = float(data.get("worldHeight", 0) or 0)
    if w > 0 and h > 0:
        return (w, h)
    sheet = str(data.get("spritesheet", "") or "").strip()
    sp = _spritesheet_public_path(model, sheet, anim_manifest_url)
    if sp is None or not sp.is_file():
        return None
    pm = QPixmap(str(sp))
    if pm.isNull() or pm.width() <= 0:
        return None
    cw = int(data.get("cellWidth", 0) or 0)
    ch = int(data.get("cellHeight", 0) or 0)
    fw = max(1, cw if cw > 0 else pm.width() // cols)
    fh = max(1, ch if ch > 0 else pm.height() // rows)
    aspect_hw = fh / fw
    if w > 0:
        return (w, w * aspect_hw)
    if h > 0:
        return (h / aspect_hw, h)
    return None


def _npc_reference_world_size(model: ProjectModel) -> tuple[float, float]:
    """取 player_anim，否则任一动画的推导世界尺寸；缺省 100×160。"""
    pa = model.animations.get("player_anim")
    if isinstance(pa, dict):
        r = _resolved_anim_world_pair(
            pa, model, anim_manifest_url="/assets/animation/player_anim/anim.json")
        if r:
            return r
    for stem, data in sorted(model.animations.items()):
        if not isinstance(data, dict):
            continue
        r = _resolved_anim_world_pair(
            data, model, anim_manifest_url=f"/assets/animation/{stem}/anim.json")
        if r:
            return r
    return (100.0, 160.0)


def _crop_atlas_cell(
    atlas: QPixmap,
    cols: int,
    rows: int,
    atlas_index: int,
    *,
    cell_w: int | None = None,
    cell_h: int | None = None,
    slice_w: int | None = None,
    slice_h: int | None = None,
) -> QPixmap | None:
    if atlas is None or atlas.isNull():
        return None
    pw = atlas.width()
    ph = atlas.height()
    c = max(1, cols)
    r = max(1, rows)
    stride_w = max(1, int(cell_w) if cell_w and cell_w > 0 else pw // c)
    stride_h = max(1, int(cell_h) if cell_h and cell_h > 0 else ph // r)
    sw = max(1, int(slice_w) if slice_w and slice_w > 0 else stride_w)
    sh = max(1, int(slice_h) if slice_h and slice_h > 0 else stride_h)
    col = atlas_index % c
    row = atlas_index // c
    if col >= c or row >= r:
        return None
    x, y = col * stride_w, row * stride_h
    if x + sw > pw or y + sh > ph:
        return None
    return atlas.copy(QRect(x, y, sw, sh))


class _SceneNpcAnimRuntime:
    """场景画布上单个 NPC 的循环动画（与脚底锚点、世界尺寸一致）。"""

    __slots__ = (
        "npc_id", "item", "atlas", "cols", "rows",
        "cell_w", "cell_h", "atlas_frames",
        "world_w", "world_h", "frames", "frame_idx", "_accum",
        "frame_rate", "loop",
        "facing_x", "_prev_x", "_prev_y", "_have_prev",
    )

    def __init__(
        self,
        npc_id: str,
        item: QGraphicsPixmapItem,
        atlas: QPixmap,
        cols: int,
        rows: int,
        world_w: float,
        world_h: float,
        frames: list[int],
        frame_rate: float,
        loop: bool,
        *,
        cell_w: int | None = None,
        cell_h: int | None = None,
        atlas_frames: list[dict] | None = None,
    ) -> None:
        self.npc_id = npc_id
        self.item = item
        self.atlas = atlas
        self.cols = max(1, cols)
        self.rows = max(1, rows)
        self.cell_w = int(cell_w) if cell_w and cell_w > 0 else None
        self.cell_h = int(cell_h) if cell_h and cell_h > 0 else None
        self.atlas_frames = atlas_frames if isinstance(atlas_frames, list) else None
        self.world_w = world_w
        self.world_h = world_h
        self.frames = frames
        self.frame_idx = 0
        self._accum = 0.0
        fr = float(frame_rate)
        self.frame_rate = max(1e-6, fr if fr > 0 else 8.0)
        self.loop = loop
        self.facing_x = 1
        self._prev_x = 0.0
        self._prev_y = 0.0
        self._have_prev = False

    def tick(self, dt: float, npc_x: float, npc_y: float) -> None:
        self._accum += dt
        step = 1.0 / self.frame_rate
        while self._accum >= step and len(self.frames) > 1:
            self._accum -= step
            self.frame_idx += 1
            if self.frame_idx >= len(self.frames):
                if self.loop:
                    self.frame_idx = 0
                else:
                    self.frame_idx = len(self.frames) - 1
                    self._accum = 0.0
                    break
        if self._have_prev:
            dx = npc_x - self._prev_x
            if abs(dx) > 1e-4:
                self.facing_x = 1 if dx > 0 else -1
        self._prev_x = npc_x
        self._prev_y = npc_y
        self._have_prev = True
        self.draw_at(npc_x, npc_y)

    def draw_at(self, npc_x: float, npc_y: float) -> None:
        if not self.frames:
            return
        idx = int(self.frames[self.frame_idx % len(self.frames)])
        sw: int | None = None
        sh: int | None = None
        if self.atlas_frames and 0 <= idx < len(self.atlas_frames):
            b = self.atlas_frames[idx]
            if isinstance(b, dict):
                sw = int(b.get("width", 0) or 0) or None
                sh = int(b.get("height", 0) or 0) or None
        pm = _crop_atlas_cell(
            self.atlas,
            self.cols,
            self.rows,
            idx,
            cell_w=self.cell_w,
            cell_h=self.cell_h,
            slice_w=sw,
            slice_h=sh,
        )
        if pm is None or pm.isNull():
            return
        fw = max(1, pm.width())
        fh = max(1, pm.height())
        self.item.setPixmap(pm)
        sx = (self.world_w / fw) * self.facing_x
        sy = self.world_h / fh
        t = QTransform()
        t.translate(float(npc_x), float(npc_y))
        t.scale(sx, sy)
        t.translate(-fw * 0.5, -float(fh))
        self.item.setTransform(t)
        self.item.setPos(0.0, 0.0)
        self.item.show()


def _background_pixel_aspect(model: ProjectModel, scene_id: str, sc: dict) -> float | None:
    """背景图像素高/宽，与 worldHeight/worldWidth 比例一致时匹配画面。"""
    bgs = sc.get("backgrounds", [])
    if not bgs:
        return None
    img_name = bgs[0].get("image", "background.png")
    img_path = model.scenes_path / scene_id / img_name
    if not img_path.exists():
        return None
    pm = QPixmap(str(img_path))
    if pm.isNull() or pm.width() <= 0:
        return None
    return float(pm.height()) / float(pm.width())


def _zone_polygon_points_for_editor(zone: dict) -> list[tuple[float, float]]:
    """画布用：优先 polygon；否则用遗留矩形字段生成四角；再否则小三角形。"""
    poly = zone.get("polygon")
    if isinstance(poly, list) and len(poly) >= 3:
        pts: list[tuple[float, float]] = []
        for p in poly:
            if isinstance(p, dict):
                pts.append((float(p.get("x", 0)), float(p.get("y", 0))))
        if len(pts) >= 3:
            return pts
    x = float(zone.get("x", 0))
    y = float(zone.get("y", 0))
    w = float(zone.get("width", 100))
    h = float(zone.get("height", 80))
    if w > 0 and h > 0:
        return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    return [(x, y), (x + 80, y), (x + 40, y + 60)]


# ---------------------------------------------------------------------------
# Draggable graphics items  (all sizes in world units)
# ---------------------------------------------------------------------------

class _DraggableCircle(QGraphicsEllipseItem):
    """A filled circle positioned and sized in world units."""

    def __init__(self, x: float, y: float, radius: float,
                 color: QColor, entity_id: str, entity_kind: str,
                 range_radius: float = 0,
                 scene_view: "SceneCanvas | None" = None):
        super().__init__(-radius, -radius, radius * 2, radius * 2)
        self.setPos(x, y)
        self.setBrush(QBrush(color))
        pen_width = 0  # cosmetic (always 1 screen-px regardless of zoom)
        self.setPen(QPen(color.darker(140), pen_width))
        self.setFlags(self.GraphicsItemFlag.ItemIsMovable |
                      self.GraphicsItemFlag.ItemIsSelectable |
                      self.GraphicsItemFlag.ItemSendsGeometryChanges)
        self.entity_id = entity_id
        self.entity_kind = entity_kind
        self._scene_view = scene_view
        self._range_outline: QGraphicsEllipseItem | None = None
        self.set_interaction_range(range_radius)

        self._label = QGraphicsTextItem(entity_id, self)
        self._label.setDefaultTextColor(Qt.GlobalColor.white)
        self._label.setFont(QFont("Consolas", 8))
        self._label.setFlag(
            QGraphicsTextItem.GraphicsItemFlag.ItemIgnoresTransformations, True)
        self._label.setFlag(
            QGraphicsTextItem.GraphicsItemFlag.ItemIsSelectable, False)
        self._label.setPos(radius * 0.5, -radius * 0.5)

    def set_interaction_range(self, range_radius: float) -> None:
        """Update dashed outline for hotspot/NPC interaction range (world units)."""
        r = float(range_radius)
        if r <= 0:
            if self._range_outline is not None:
                self._range_outline.hide()
            return
        if self._range_outline is None:
            self._range_outline = QGraphicsEllipseItem(-r, -r, r * 2, r * 2, self)
            self._range_outline.setPen(_RANGE_PEN)
            self._range_outline.setBrush(QBrush(Qt.GlobalColor.transparent))
            self._range_outline.setFlag(
                QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, False)
        else:
            self._range_outline.setRect(-r, -r, r * 2, r * 2)
            self._range_outline.show()

    def itemChange(
        self,
        change: QGraphicsItem.GraphicsItemChange,
        value: object,
    ) -> object:
        result = super().itemChange(change, value)
        if (
            change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged
            and self._scene_view is not None
        ):
            p = self.pos()
            self._scene_view.item_position_live.emit(
                self.entity_kind, self.entity_id, p.x(), p.y())
        return result


class _DraggableRect(QGraphicsRectItem):
    """A rectangle positioned and sized in world units."""

    def __init__(self, x: float, y: float, w: float, h: float,
                 color: QColor, entity_id: str, entity_kind: str):
        super().__init__(0, 0, w, h)
        self.setPos(x, y)
        self.setBrush(QBrush(color))
        self.setPen(QPen(color.darker(180), 0, Qt.PenStyle.DashLine))
        self.setFlags(self.GraphicsItemFlag.ItemIsMovable |
                      self.GraphicsItemFlag.ItemIsSelectable |
                      self.GraphicsItemFlag.ItemSendsGeometryChanges)
        self.entity_id = entity_id
        self.entity_kind = entity_kind

        self._label = QGraphicsTextItem(entity_id, self)
        self._label.setDefaultTextColor(Qt.GlobalColor.white)
        self._label.setFont(QFont("Consolas", 8))
        self._label.setFlag(
            QGraphicsTextItem.GraphicsItemFlag.ItemIgnoresTransformations, True)
        self._label.setFlag(
            QGraphicsTextItem.GraphicsItemFlag.ItemIsSelectable, False)
        self._label.setPos(2, 2)


class _EditableZonePolygon(QGraphicsObject):
    """Zone：世界坐标闭合多边形；拖顶点、拖内部平移、双击边插点、右键删顶点。"""

    HANDLE_WORLD_R = 14.0

    def __init__(
        self,
        canvas: "SceneCanvas",
        points: list[tuple[float, float]],
        color: QColor,
        entity_id: str,
    ):
        super().__init__()
        self._canvas = canvas
        self.entity_id = entity_id
        self.entity_kind = "zone"
        self._color = color
        self._points: list[list[float]] = [[float(x), float(y)] for x, y in points]
        self.setFlags(
            self.GraphicsItemFlag.ItemIsSelectable
            | self.GraphicsItemFlag.ItemSendsGeometryChanges
        )
        self.setAcceptHoverEvents(True)
        self._drag_vertex: int | None = None
        self._drag_body = False
        self._last_scene: QPointF | None = None
        self._hover_vertex: int | None = None

    def set_points_from_model(self, poly: list) -> None:
        self._points = []
        for p in poly:
            if isinstance(p, dict):
                self._points.append([float(p.get("x", 0)), float(p.get("y", 0))])
        self.prepareGeometryChange()
        self.update()

    def points_to_model(self) -> list[dict[str, float]]:
        return [{"x": round(px, 1), "y": round(py, 1)} for px, py in self._points]

    def _polyf(self) -> QPolygonF:
        return QPolygonF([QPointF(p[0], p[1]) for p in self._points])

    def boundingRect(self) -> QRectF:
        if len(self._points) < 1:
            return QRectF()
        xs = [p[0] for p in self._points]
        ys = [p[1] for p in self._points]
        m = self.HANDLE_WORLD_R + 2
        return QRectF(
            min(xs) - m, min(ys) - m,
            max(xs) - min(xs) + 2 * m, max(ys) - min(ys) + 2 * m,
        )

    def shape(self) -> QPainterPath:
        path = QPainterPath()
        if len(self._points) >= 3:
            path.addPolygon(self._polyf())
            path.closeSubpath()
        r = self.HANDLE_WORLD_R
        for px, py in self._points:
            path.addEllipse(QPointF(px, py), r, r)
        return path

    def paint(self, painter: QPainter, option, widget=None) -> None:
        del option, widget
        painter.save()
        pf = self._polyf()
        painter.setPen(QPen(self._color.darker(180), 0, Qt.PenStyle.DashLine))
        painter.setBrush(QBrush(self._color))
        painter.drawPolygon(pf)
        hrad = self.HANDLE_WORLD_R * 0.38
        for i, (px, py) in enumerate(self._points):
            c = QColor(255, 230, 100)
            if self._hover_vertex == i or self._drag_vertex == i:
                c = QColor(255, 200, 60)
            painter.setBrush(QBrush(c))
            painter.setPen(QPen(QColor(100, 70, 0), 0))
            painter.drawEllipse(QPointF(px, py), hrad, hrad)
        if self._points:
            xs = [p[0] for p in self._points]
            ys = [p[1] for p in self._points]
            painter.setPen(QPen(Qt.GlobalColor.white))
            painter.setFont(QFont("Consolas", 8))
            painter.drawText(QPointF(min(xs) + 3, min(ys) + 12), self.entity_id)
        painter.restore()

    def _vertex_at_scene(self, scene_pos: QPointF) -> int | None:
        x, y = scene_pos.x(), scene_pos.y()
        r2 = self.HANDLE_WORLD_R ** 2
        for i, p in enumerate(self._points):
            dx, dy = p[0] - x, p[1] - y
            if dx * dx + dy * dy <= r2:
                return i
        return None

    def _point_in_polygon(self, x: float, y: float) -> bool:
        n = len(self._points)
        if n < 3:
            return False
        inside = False
        j = n - 1
        for i in range(n):
            xi, yi = self._points[i][0], self._points[i][1]
            xj, yj = self._points[j][0], self._points[j][1]
            dy = yj - yi
            if abs(dy) < 1e-12:
                j = i
                continue
            xinters = xi + (xj - xi) * (y - yi) / dy
            if (yi > y) != (yj > y) and x < xinters:
                inside = not inside
            j = i
        return inside

    def _select_exclusively(self) -> None:
        sc = self.scene()
        if sc is not None:
            sc.clearSelection()
        self.setSelected(True)

    def try_delete_hovered_vertex(self) -> bool:
        """删除当前悬停的顶点（须多于 3 点）；用于 Del/Backspace 快捷操作。"""
        vi = self._hover_vertex
        if vi is None or len(self._points) <= 3:
            return False
        del self._points[vi]
        self._hover_vertex = None
        self.prepareGeometryChange()
        self.update()
        self._canvas._emit_zone_polygon_committed(
            self.entity_id, self.points_to_model())
        return True

    def mousePressEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if event.button() != Qt.MouseButton.LeftButton:
            super().mousePressEvent(event)
            return
        sp = event.scenePos()
        vi = self._vertex_at_scene(sp)
        if vi is not None and event.modifiers() & Qt.KeyboardModifier.ShiftModifier:
            if len(self._points) > 3:
                del self._points[vi]
                if self._hover_vertex == vi:
                    self._hover_vertex = None
                elif self._hover_vertex is not None and self._hover_vertex > vi:
                    self._hover_vertex -= 1
                self.prepareGeometryChange()
                self.update()
                self._select_exclusively()
                self._canvas._emit_zone_polygon_committed(
                    self.entity_id, self.points_to_model())
            event.accept()
            return
        if vi is not None:
            self._drag_vertex = vi
            self._drag_body = False
            self._last_scene = QPointF(sp)
            self._select_exclusively()
            event.accept()
            return
        if self._point_in_polygon(sp.x(), sp.y()):
            self._drag_vertex = None
            self._drag_body = True
            self._last_scene = QPointF(sp)
            self._select_exclusively()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if self._drag_vertex is not None and self._last_scene is not None:
            sp = event.scenePos()
            dx = sp.x() - self._last_scene.x()
            dy = sp.y() - self._last_scene.y()
            self._points[self._drag_vertex][0] += dx
            self._points[self._drag_vertex][1] += dy
            self._last_scene = QPointF(sp)
            self.prepareGeometryChange()
            self.update()
            event.accept()
            return
        if self._drag_body and self._last_scene is not None:
            sp = event.scenePos()
            dx = sp.x() - self._last_scene.x()
            dy = sp.y() - self._last_scene.y()
            for p in self._points:
                p[0] += dx
                p[1] += dy
            self._last_scene = QPointF(sp)
            self.prepareGeometryChange()
            self.update()
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            if self._drag_vertex is not None or self._drag_body:
                self._drag_vertex = None
                self._drag_body = False
                self._last_scene = None
                self._canvas._emit_zone_polygon_committed(
                    self.entity_id, self.points_to_model())
                event.accept()
                return
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if event.button() != Qt.MouseButton.LeftButton:
            super().mouseDoubleClickEvent(event)
            return
        sp = event.scenePos()
        if self._vertex_at_scene(sp) is not None:
            super().mouseDoubleClickEvent(event)
            return
        best_i = -1
        best_d2 = 1e18
        x, y = sp.x(), sp.y()
        n = len(self._points)
        for i in range(n):
            j = (i + 1) % n
            ax, ay = self._points[i][0], self._points[i][1]
            bx, by = self._points[j][0], self._points[j][1]
            abx, aby = bx - ax, by - ay
            denom = abx * abx + aby * aby + 1e-12
            t = max(0, min(1, ((x - ax) * abx + (y - ay) * aby) / denom))
            px, py = ax + t * abx, ay + t * aby
            d2 = (x - px) ** 2 + (y - py) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_i = i
        thr = (self.HANDLE_WORLD_R * 2.2) ** 2
        if best_i >= 0 and best_d2 < thr:
            j = (best_i + 1) % n
            mx = (self._points[best_i][0] + self._points[j][0]) * 0.5
            my = (self._points[best_i][1] + self._points[j][1]) * 0.5
            self._points.insert(best_i + 1, [mx, my])
            self.prepareGeometryChange()
            self.update()
            self._canvas._emit_zone_polygon_committed(
                self.entity_id, self.points_to_model())
        event.accept()

    def contextMenuEvent(self, event: QGraphicsSceneContextMenuEvent) -> None:
        vi = self._vertex_at_scene(event.scenePos())
        if vi is not None and len(self._points) > 3:
            menu = QMenu()
            act = menu.addAction("删除此顶点")
            chosen = menu.exec(event.screenPos())
            if chosen == act:
                del self._points[vi]
                self.prepareGeometryChange()
                self.update()
                self._canvas._emit_zone_polygon_committed(
                    self.entity_id, self.points_to_model())
            event.accept()
            return
        super().contextMenuEvent(event)

    def hoverMoveEvent(self, event: QGraphicsSceneHoverEvent) -> None:
        self._hover_vertex = self._vertex_at_scene(event.scenePos())
        self.update()
        super().hoverMoveEvent(event)

    def hoverLeaveEvent(self, event: QGraphicsSceneHoverEvent) -> None:
        self._hover_vertex = None
        self.update()
        super().hoverLeaveEvent(event)


class _NpcPatrolPolyline(QGraphicsObject):
    """NPC 巡逻开放折线：仅顶点参与命中，线段中点可选中下层 NPC 圆点。"""

    HANDLE_WORLD_R = 14.0

    def __init__(
        self,
        canvas: "SceneCanvas",
        npc_id: str,
        points: list[tuple[float, float]],
    ):
        super().__init__()
        self._canvas = canvas
        self.npc_id = npc_id
        self._points: list[list[float]] = [[float(x), float(y)] for x, y in points]
        self.setFlags(
            self.GraphicsItemFlag.ItemIsSelectable
            | self.GraphicsItemFlag.ItemSendsGeometryChanges
        )
        self.setAcceptHoverEvents(True)
        self.setZValue(_PATROL_OVERLAY_Z)
        self._drag_vertex: int | None = None
        self._last_scene: QPointF | None = None
        self._hover_vertex: int | None = None

    def set_points_from_model(self, route: list) -> None:
        self._points = []
        for p in route:
            if isinstance(p, dict):
                self._points.append([
                    round(float(p.get("x", 0)), 1),
                    round(float(p.get("y", 0)), 1),
                ])
        self.prepareGeometryChange()
        self.update()

    def points_to_model(self) -> list[dict[str, float]]:
        return [{"x": round(px, 1), "y": round(py, 1)} for px, py in self._points]

    def boundingRect(self) -> QRectF:
        if len(self._points) < 1:
            return QRectF()
        xs = [p[0] for p in self._points]
        ys = [p[1] for p in self._points]
        m = self.HANDLE_WORLD_R + 4
        return QRectF(
            min(xs) - m, min(ys) - m,
            max(xs) - min(xs) + 2 * m, max(ys) - min(ys) + 2 * m,
        )

    def shape(self) -> QPainterPath:
        path = QPainterPath()
        r = self.HANDLE_WORLD_R
        for px, py in self._points:
            path.addEllipse(QPointF(px, py), r, r)
        return path

    def paint(self, painter: QPainter, option, widget=None) -> None:
        del option, widget
        painter.save()
        n = len(self._points)
        if n >= 2:
            pen = QPen(_PATROL_LINE_COLOR.darker(120), 0, Qt.PenStyle.DashLine)
            painter.setPen(pen)
            painter.setBrush(QBrush(Qt.GlobalColor.transparent))
            for i in range(n - 1):
                a = self._points[i]
                b = self._points[i + 1]
                painter.drawLine(QPointF(a[0], a[1]), QPointF(b[0], b[1]))
        hrad = self.HANDLE_WORLD_R * 0.38
        for i, (px, py) in enumerate(self._points):
            c = QColor(180, 250, 255)
            if self._hover_vertex == i or self._drag_vertex == i:
                c = QColor(100, 220, 240)
            painter.setBrush(QBrush(c))
            painter.setPen(QPen(QColor(0, 120, 140), 0))
            painter.drawEllipse(QPointF(px, py), hrad, hrad)
            painter.setPen(QPen(Qt.GlobalColor.white))
            painter.setFont(QFont("Consolas", 8))
            painter.drawText(QPointF(px + hrad + 2, py + 4), str(i))
        painter.restore()

    def _vertex_at_scene(self, scene_pos: QPointF) -> int | None:
        x, y = scene_pos.x(), scene_pos.y()
        r2 = self.HANDLE_WORLD_R ** 2
        for i, p in enumerate(self._points):
            dx, dy = p[0] - x, p[1] - y
            if dx * dx + dy * dy <= r2:
                return i
        return None

    def mousePressEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if event.button() != Qt.MouseButton.LeftButton:
            super().mousePressEvent(event)
            return
        sp = event.scenePos()
        vi = self._vertex_at_scene(sp)
        if vi is not None:
            self._drag_vertex = vi
            self._last_scene = QPointF(sp)
            sc = self.scene()
            if sc is not None:
                sc.clearSelection()
            self.setSelected(True)
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if self._drag_vertex is not None and self._last_scene is not None:
            sp = event.scenePos()
            dx = sp.x() - self._last_scene.x()
            dy = sp.y() - self._last_scene.y()
            self._points[self._drag_vertex][0] += dx
            self._points[self._drag_vertex][1] += dy
            self._last_scene = QPointF(sp)
            self.prepareGeometryChange()
            self.update()
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton:
            if self._drag_vertex is not None:
                self._drag_vertex = None
                self._last_scene = None
                self._canvas._emit_npc_patrol_route_committed(
                    self.npc_id, self.points_to_model())
                event.accept()
                return
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if event.button() != Qt.MouseButton.LeftButton:
            super().mouseDoubleClickEvent(event)
            return
        sp = event.scenePos()
        if self._vertex_at_scene(sp) is not None:
            super().mouseDoubleClickEvent(event)
            return
        x, y = sp.x(), sp.y()
        n = len(self._points)
        best_i = -1
        best_d2 = 1e18
        for i in range(max(0, n - 1)):
            ax, ay = self._points[i][0], self._points[i][1]
            bx, by = self._points[i + 1][0], self._points[i + 1][1]
            abx, aby = bx - ax, by - ay
            denom = abx * abx + aby * aby + 1e-12
            t = max(0, min(1, ((x - ax) * abx + (y - ay) * aby) / denom))
            px, py = ax + t * abx, ay + t * aby
            d2 = (x - px) ** 2 + (y - py) ** 2
            if d2 < best_d2:
                best_d2 = d2
                best_i = i
        thr = (self.HANDLE_WORLD_R * 2.2) ** 2
        if best_i >= 0 and best_d2 < thr:
            mx = (self._points[best_i][0] + self._points[best_i + 1][0]) * 0.5
            my = (self._points[best_i][1] + self._points[best_i + 1][1]) * 0.5
            self._points.insert(best_i + 1, [mx, my])
            self.prepareGeometryChange()
            self.update()
            self._canvas._emit_npc_patrol_route_committed(
                self.npc_id, self.points_to_model())
        event.accept()

    def contextMenuEvent(self, event: QGraphicsSceneContextMenuEvent) -> None:
        vi = self._vertex_at_scene(event.scenePos())
        if vi is not None and len(self._points) > 2:
            menu = QMenu()
            act = menu.addAction("删除此顶点")
            chosen = menu.exec(event.screenPos())
            if chosen == act:
                del self._points[vi]
                self.prepareGeometryChange()
                self.update()
                self._canvas._emit_npc_patrol_route_committed(
                    self.npc_id, self.points_to_model())
            event.accept()
            return
        super().contextMenuEvent(event)

    def hoverMoveEvent(self, event: QGraphicsSceneHoverEvent) -> None:
        self._hover_vertex = self._vertex_at_scene(event.scenePos())
        self.update()
        super().hoverMoveEvent(event)

    def hoverLeaveEvent(self, event: QGraphicsSceneHoverEvent) -> None:
        self._hover_vertex = None
        self.update()
        super().hoverLeaveEvent(event)


# ---------------------------------------------------------------------------
# Canvas view  (coordinate system = world units)
# ---------------------------------------------------------------------------

class SceneCanvas(QGraphicsView):
    item_selected = Signal(str, str)   # (entity_kind, entity_id)
    item_deselected = Signal()
    item_moved = Signal(str, str, float, float)  # kind, id, x, y
    item_position_live = Signal(str, str, float, float)  # kind, id, x, y（拖拽中）
    # kind, id, polygon: list[{"x","y"}, ...]
    item_zone_polygon_committed = Signal(str, str, object)
    # npc_id, route: list[{"x","y"}, ...]
    item_npc_patrol_route_committed = Signal(str, object)
    # 右键菜单：在 (wx, wy) 世界坐标处添加实体；kind: hotspot|npc|zone|spawn
    context_add_entity = Signal(str, float, float)

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self._gfx = QGraphicsScene(self)
        self.setScene(self._gfx)
        self.setRenderHints(QPainter.RenderHint.Antialiasing |
                            QPainter.RenderHint.SmoothPixmapTransform)
        self.setViewportUpdateMode(
            QGraphicsView.ViewportUpdateMode.SmartViewportUpdate)
        # 左键用于选择/拖移图元；平移视图使用鼠标中键（见 mousePress/Move/Release）
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self._middle_panning = False
        self._pan_last_pos = QPoint()
        self._pick_cycle_key: tuple[float, float] | None = None
        self._pick_cycle_i: int = 0
        self._saved_item_z: list[tuple[QGraphicsItem, float]] | None = None
        self._bg_item: QGraphicsPixmapItem | None = None
        self._entity_items: dict[str, QGraphicsEllipseItem | QGraphicsRectItem | QGraphicsObject] = {}
        self._npc_ref_items: list[QGraphicsItem] = []
        self._npc_ref_visible: bool = True
        self._patrol_overlays: dict[str, _NpcPatrolPolyline] = {}
        self._world_w: float = 800
        self._world_h: float = 600

    @property
    def handle_radius(self) -> float:
        """A small world-unit radius for clickable entity handles."""
        return max(self._world_w, self._world_h) * 0.008

    def clear_scene(self) -> None:
        self._saved_item_z = None
        self._pick_cycle_key = None
        self._pick_cycle_i = 0
        self._npc_ref_items.clear()
        self._gfx.clear()
        self._bg_item = None
        self._entity_items.clear()
        self._patrol_overlays.clear()

    def _restore_pick_z_order(self) -> None:
        if not self._saved_item_z:
            return
        for it, z in self._saved_item_z:
            if it.scene() is self._gfx:
                it.setZValue(z)
        self._saved_item_z = None

    @staticmethod
    def _entity_stack_at(scene: QGraphicsScene, scene_pos: QPointF) -> list[QGraphicsItem]:
        """同一落点下、按 Z 从高到低排列的可编辑实体（hotspot/npc/zone/spawn）。"""
        seen: set[int] = set()
        out: list[QGraphicsItem] = []
        for it in scene.items(scene_pos):
            if not hasattr(it, "entity_kind"):
                continue
            iid = id(it)
            if iid in seen:
                continue
            seen.add(iid)
            out.append(it)
        return out

    def setup_world(self, world_w: float, world_h: float) -> None:
        self._world_w = world_w
        self._world_h = world_h
        self._gfx.setSceneRect(QRectF(0, 0, world_w, world_h))

    def load_background(self, img_path: Path,
                        world_w: float, world_h: float) -> None:
        """Load image and scale it to fill the (world_w x world_h) quad."""
        if not img_path.exists():
            return
        pm = QPixmap(str(img_path))
        if pm.isNull():
            return
        self._bg_item = QGraphicsPixmapItem(pm)
        self._bg_item.setZValue(-100)
        sx = world_w / pm.width()
        sy = world_h / pm.height()
        self._bg_item.setTransform(QTransform.fromScale(sx, sy))
        self._gfx.addItem(self._bg_item)

    def add_hotspot(self, hs: dict) -> None:
        ht = hs.get("type", "inspect")
        color = _HOTSPOT_COLORS.get(ht, _HOTSPOT_COLORS["inspect"])
        ir = hs.get("interactionRange", 50)
        item = _DraggableCircle(
            hs["x"], hs["y"], self.handle_radius,
            color, hs.get("id", "?"), "hotspot",
            range_radius=ir, scene_view=self)
        self._gfx.addItem(item)
        self._entity_items[f"hotspot:{hs.get('id', '')}"] = item

    def add_npc(self, npc: dict) -> None:
        ir = npc.get("interactionRange", 50)
        item = _DraggableCircle(
            npc["x"], npc["y"], self.handle_radius,
            _NPC_COLOR, npc.get("id", "?"), "npc",
            range_radius=ir, scene_view=self)
        self._gfx.addItem(item)
        self._entity_items[f"npc:{npc.get('id', '')}"] = item

    def add_zone(self, zone: dict) -> None:
        pts = _zone_polygon_points_for_editor(zone)
        item = _EditableZonePolygon(
            self, pts, _ZONE_COLOR, zone.get("id", "?"))
        self._gfx.addItem(item)
        self._entity_items[f"zone:{zone.get('id', '')}"] = item

    def update_zone_polygon(
        self, entity_id: str, polygon: list,
    ) -> None:
        """属性面板改顶点表时同步画布多边形。"""
        key = f"zone:{entity_id}"
        item = self._entity_items.get(key)
        if isinstance(item, _EditableZonePolygon):
            item.set_points_from_model(polygon)

    def _emit_zone_polygon_committed(
        self,
        eid: str,
        polygon: list,
    ) -> None:
        self.item_zone_polygon_committed.emit("zone", eid, polygon)

    def _emit_npc_patrol_route_committed(
        self, npc_id: str, route: list,
    ) -> None:
        self.item_npc_patrol_route_committed.emit(npc_id, route)

    def set_npc_patrol_overlay(
        self, npc_id: str, route: list | None,
    ) -> None:
        """显示/更新巡逻折线；route 为 None 或空则移除。"""
        self.remove_npc_patrol_overlay(npc_id)
        if not npc_id or not route or not isinstance(route, list):
            return
        pts: list[tuple[float, float]] = []
        for p in route:
            if isinstance(p, dict):
                pts.append((float(p.get("x", 0)), float(p.get("y", 0))))
        if len(pts) < 2:
            return
        item = _NpcPatrolPolyline(self, npc_id, pts)
        self._gfx.addItem(item)
        self._patrol_overlays[npc_id] = item

    def remove_npc_patrol_overlay(self, npc_id: str) -> None:
        it = self._patrol_overlays.pop(npc_id, None)
        if it is not None and it.scene() is self._gfx:
            self._gfx.removeItem(it)

    def update_npc_patrol_overlay_points(self, npc_id: str, route: list) -> None:
        item = self._patrol_overlays.get(npc_id)
        if isinstance(item, _NpcPatrolPolyline):
            item.set_points_from_model(route)

    def add_spawn(self, name: str, pos: dict) -> None:
        item = _DraggableCircle(
            pos["x"], pos["y"], self.handle_radius * 0.6,
            _SPAWN_COLOR, name, "spawn", scene_view=self)
        self._gfx.addItem(item)
        self._entity_items[f"spawn:{name}"] = item

    def update_interaction_range(self, kind: str, entity_id: str, range_radius: float) -> None:
        """Refresh dashed circle for hotspot/NPC when interactionRange edits live-update model."""
        key = f"{kind}:{entity_id}"
        item = self._entity_items.get(key)
        if item is not None and hasattr(item, "set_interaction_range"):
            item.set_interaction_range(range_radius)

    def set_npc_reference_visible(self, visible: bool) -> None:
        self._npc_ref_visible = visible
        for it in self._npc_ref_items:
            it.setVisible(visible)

    def _clear_npc_reference_graphics(self) -> None:
        for it in self._npc_ref_items:
            self._gfx.removeItem(it)
        self._npc_ref_items.clear()

    def rebuild_npc_reference(
        self, world_w: float, world_h: float, ref_w: float, ref_h: float
    ) -> None:
        """绘制与运行时 NPC Sprite 同宽高的参考矩形（左上、右下各一块，便于目测场景尺度）。"""
        self._clear_npc_reference_graphics()
        if not self._npc_ref_visible:
            return
        rw = max(1.0, float(ref_w))
        rh = max(1.0, float(ref_h))
        m = _NPC_REF_MARGIN
        pairs = [
            (m, m, "左上"),
            (world_w - rw - m, world_h - rh - m, "右下"),
        ]
        label_txt = f"NPC 参考 {rw:.0f}×{rh:.0f} wu"
        for x0, y0, corner in pairs:
            x = max(0.0, min(float(x0), max(0.0, world_w - rw)))
            y = max(0.0, min(float(y0), max(0.0, world_h - rh)))
            rect = QGraphicsRectItem(x, y, rw, rh)
            rect.setBrush(QBrush(_NPC_REF_FILL))
            rect.setPen(_NPC_REF_PEN)
            rect.setZValue(_NPC_REF_Z)
            rect.setAcceptHoverEvents(False)
            rect.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, False)
            rect.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, False)
            rect.setToolTip(
                f"{corner}：与角色动画 JSON 中 worldWidth×worldHeight "
                f"（脚底锚点、向上为高）同尺寸的参考框，不可编辑。"
            )
            self._gfx.addItem(rect)
            self._npc_ref_items.append(rect)
            tag = QGraphicsTextItem(f"{corner}\n{label_txt}")
            tag.setDefaultTextColor(QColor(200, 240, 210))
            tag.setFont(QFont("Consolas", 8))
            tag.setFlag(QGraphicsTextItem.GraphicsItemFlag.ItemIgnoresTransformations, True)
            tag.setPos(x + 3, y + 3)
            tag.setZValue(_NPC_REF_Z + 0.1)
            tag.setAcceptHoverEvents(False)
            tag.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, False)
            tag.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, False)
            self._gfx.addItem(tag)
            self._npc_ref_items.append(tag)

    def graphics_scene(self) -> QGraphicsScene:
        return self._gfx

    def fit_all(self) -> None:
        self.fitInView(self._gfx.sceneRect(), Qt.AspectRatioMode.KeepAspectRatio)

    def wheelEvent(self, event: QWheelEvent) -> None:
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self.scale(factor, factor)

    def contextMenuEvent(self, event: QContextMenuEvent) -> None:
        scene_pt = self.mapToScene(event.pos())
        r = self._gfx.sceneRect()
        wx = float(max(r.left(), min(r.right(), scene_pt.x())))
        wy = float(max(r.top(), min(r.bottom(), scene_pt.y())))
        wx = round(wx, 1)
        wy = round(wy, 1)
        menu = QMenu(self)
        actions = [
            ("在此添加 Hotspot", "hotspot"),
            ("在此添加 NPC", "npc"),
            ("在此添加 Zone", "zone"),
            ("在此添加命名出生点", "spawn"),
        ]
        for label, kind in actions:
            act = QAction(label, menu)
            act.triggered.connect(
                lambda *_, k=kind, x=wx, y=wy: self.context_add_entity.emit(k, x, y))
            menu.addAction(act)
        menu.exec(event.globalPos())
        event.accept()

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.MiddleButton:
            self._middle_panning = True
            self._pan_last_pos = event.pos()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            event.accept()
            return
        if event.button() == Qt.MouseButton.LeftButton:
            self._restore_pick_z_order()
            sp = self.mapToScene(event.pos())
            stack = self._entity_stack_at(self._gfx, sp)
            if len(stack) < 2:
                self._pick_cycle_key = None
            else:
                key = (round(sp.x(), 1), round(sp.y(), 1))
                if key != self._pick_cycle_key:
                    self._pick_cycle_key = key
                    self._pick_cycle_i = 0
                else:
                    sel = self._gfx.selectedItems()
                    if sel and sel[0] in stack:
                        self._pick_cycle_i = (stack.index(sel[0]) + 1) % len(stack)
                    else:
                        self._pick_cycle_i = 0
                target = stack[self._pick_cycle_i]
                self._saved_item_z = [(it, it.zValue()) for it in stack]
                z_top = max(z for _, z in self._saved_item_z)
                target.setZValue(z_top + 1.0)
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if self._middle_panning:
            if not (event.buttons() & Qt.MouseButton.MiddleButton):
                self._middle_panning = False
                self.unsetCursor()
            else:
                delta = event.pos() - self._pan_last_pos
                self._pan_last_pos = event.pos()
                self.horizontalScrollBar().setValue(
                    self.horizontalScrollBar().value() - delta.x())
                self.verticalScrollBar().setValue(
                    self.verticalScrollBar().value() - delta.y())
                event.accept()
                return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.MiddleButton:
            if self._middle_panning:
                self._middle_panning = False
                self.unsetCursor()
            event.accept()
            return
        super().mouseReleaseEvent(event)
        self._restore_pick_z_order()
        sel = self._gfx.selectedItems()
        if sel:
            it = sel[0]
            if hasattr(it, "entity_kind") and hasattr(it, "entity_id"):
                # Commit world position to scene data first, then reload the
                # property panel. If item_selected runs before item_moved, the
                # spin boxes are filled with stale x/y and stay wrong until the
                # next gesture.
                emit_move = it.entity_kind != "zone"
                if emit_move:
                    self.item_moved.emit(
                        it.entity_kind, it.entity_id,
                        it.pos().x(), it.pos().y(),
                    )
                self.item_selected.emit(it.entity_kind, it.entity_id)
        else:
            self.item_deselected.emit()


# ---------------------------------------------------------------------------
# Transition target: pick spawn on target scene (preview + list + new)
# ---------------------------------------------------------------------------

class TargetSpawnPickerDialog(QDialog):
    """For switchScene: selected key '' means default spawnPoint; else spawnPoints[key]."""

    def __init__(
        self,
        model: ProjectModel,
        target_scene_id: str,
        initial_spawn_key: str,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._model = model
        self._scene_id = target_scene_id
        sc0 = model.scenes.get(target_scene_id, {})
        init_key = (initial_spawn_key or "").strip()
        if init_key and init_key not in (sc0.get("spawnPoints") or {}):
            init_key = ""
        self._selected_key = init_key
        self._last_world: tuple[float, float] = (800, 600)

        title = sc0.get("name", target_scene_id)
        self.setWindowTitle(f"目标场景出生点 — {target_scene_id}（{title}）")
        self.resize(960, 520)

        root = QVBoxLayout(self)
        main = QHBoxLayout()
        left = QVBoxLayout()
        left.addWidget(QLabel("出生点列表（单击选中；画布可拖拽位置）"))
        self._list = QListWidget()
        self._list.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        left.addWidget(self._list)
        self._btn_new = QPushButton("新建命名出生点")
        self._btn_new.clicked.connect(self._on_new_spawn)
        left.addWidget(self._btn_new)
        hint = QLabel(
            "“默认”对应该场景 JSON 的 spawnPoint；其余对应 spawnPoints 中的键。\n"
            "拖拽图钉会立刻写回该场景数据。"
        )
        hint.setWordWrap(True)
        left.addWidget(hint)

        self._canvas = SceneCanvas()
        self._canvas.setContextMenuPolicy(Qt.ContextMenuPolicy.NoContextMenu)
        self._canvas.item_selected.connect(self._on_canvas_selected)
        self._canvas.item_moved.connect(self._on_canvas_moved)

        main.addLayout(left, 0)
        main.addWidget(self._canvas, 1)
        root.addLayout(main)

        bbox = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        bbox.accepted.connect(self.accept)
        bbox.rejected.connect(self.reject)
        root.addWidget(bbox)

        self._list.currentRowChanged.connect(self._on_list_row)

        self._reload_all()
        self._sync_selection_after_reload()

    def selected_spawn_key(self) -> str:
        return self._selected_key

    def _reload_all(self) -> None:
        sc = self._model.scenes.get(self._scene_id)
        if sc is None:
            return
        self._canvas.clear_scene()
        bgs = sc.get("backgrounds", [])
        img_path: Path | None = None
        if bgs:
            img_name = bgs[0].get("image", "background.png")
            img_path = self._model.scenes_path / self._scene_id / img_name
        if not isinstance(sc.get("spawnPoint"), dict):
            world_w, world_h = _resolve_world_size(sc, img_path)
            sc["spawnPoint"] = {
                "x": round(world_w * 0.5, 1),
                "y": round(world_h * 0.5, 1),
            }
            self._model.mark_dirty("scene", self._scene_id)
        world_w, world_h = _resolve_world_size(sc, img_path)
        self._last_world = (world_w, world_h)
        self._canvas.setup_world(world_w, world_h)
        if img_path:
            self._canvas.load_background(img_path, world_w, world_h)
        sp = sc.get("spawnPoint")
        if isinstance(sp, dict):
            self._canvas.add_spawn("default", sp)
        for name, pos in sorted((sc.get("spawnPoints") or {}).items()):
            if isinstance(pos, dict):
                self._canvas.add_spawn(name, pos)
        self._canvas.fit_all()

        self._list.blockSignals(True)
        self._list.clear()
        def_it = QListWidgetItem("默认（spawnPoint）")
        def_it.setData(Qt.ItemDataRole.UserRole, "")
        self._list.addItem(def_it)
        for name in sorted((sc.get("spawnPoints") or {}).keys()):
            li = QListWidgetItem(name)
            li.setData(Qt.ItemDataRole.UserRole, name)
            self._list.addItem(li)
        self._list.blockSignals(False)

    def _sync_selection_after_reload(self) -> None:
        key = self._selected_key
        self._list.blockSignals(True)
        found = False
        for i in range(self._list.count()):
            it = self._list.item(i)
            if (it.data(Qt.ItemDataRole.UserRole) or "") == key:
                self._list.setCurrentRow(i)
                found = True
                break
        if not found:
            self._list.setCurrentRow(0)
            self._selected_key = ""
        self._list.blockSignals(False)
        self._select_canvas_spawn(self._selected_key)

    def _select_canvas_spawn(self, logical_key: str) -> None:
        eid = "default" if logical_key == "" else logical_key
        item = self._canvas._entity_items.get(f"spawn:{eid}")
        if item is None:
            return
        self._canvas._gfx.clearSelection()
        item.setSelected(True)

    def _on_list_row(self, row: int) -> None:
        if row < 0:
            return
        it = self._list.item(row)
        if it is None:
            return
        raw = it.data(Qt.ItemDataRole.UserRole)
        self._selected_key = raw if isinstance(raw, str) else ""
        self._select_canvas_spawn(self._selected_key)

    def _on_canvas_selected(self, kind: str, eid: str) -> None:
        if kind != "spawn":
            return
        logical = "" if eid == "default" else eid
        self._selected_key = logical
        self._list.blockSignals(True)
        for i in range(self._list.count()):
            li = self._list.item(i)
            if (li.data(Qt.ItemDataRole.UserRole) or "") == logical:
                self._list.setCurrentRow(i)
                break
        self._list.blockSignals(False)

    def _on_canvas_moved(self, kind: str, eid: str, x: float, y: float) -> None:
        if kind != "spawn":
            return
        sc = self._model.scenes.get(self._scene_id)
        if sc is None:
            return
        rx, ry = round(x, 1), round(y, 1)
        if eid == "default":
            sc["spawnPoint"] = {"x": rx, "y": ry}
        else:
            sps = sc.setdefault("spawnPoints", {})
            sps[eid] = {"x": rx, "y": ry}
        self._model.mark_dirty("scene", self._scene_id)

    def _on_new_spawn(self) -> None:
        sc = self._model.scenes.get(self._scene_id)
        if sc is None:
            return
        sps = sc.setdefault("spawnPoints", {})
        n = 0
        while f"spawn_{n}" in sps:
            n += 1
        nid = f"spawn_{n}"
        ww, wh = self._last_world
        sps[nid] = {"x": round(ww * 0.5, 1), "y": round(wh * 0.5, 1)}
        self._model.mark_dirty("scene", self._scene_id)
        self._selected_key = nid
        self._reload_all()
        self._sync_selection_after_reload()


# ---------------------------------------------------------------------------
# Property panel
# ---------------------------------------------------------------------------

class ScenePropertyPanel(QScrollArea):
    changed = Signal()
    # (kind, entity_id, interaction_range) — live canvas sync
    interaction_range_changed = Signal(str, str, float)
    # entity_id, polygon list[{"x","y"}, ...] — 侧栏顶点表驱动画布
    zone_polygon_changed = Signal(str, object)
    # 侧栏改 anim/初始状态后，让主窗口按 npc id 重建该 NPC 的场景动画层
    npc_scene_anim_refresh_requested = Signal(str)
    # 侧栏改 x/y 时同步写回 dict 并通知主窗口重绘该 NPC 位置
    npc_xy_live_changed = Signal(str)
    # 侧栏底部「从场景删除」与工具栏删除共用同一逻辑
    delete_current_entity_requested = Signal()
    # 巡逻折线显示/数据变更后刷新画布 overlay
    npc_patrol_overlay_refresh_requested = Signal()
    # npc_id, enabled — 仅编辑器内沿路径预览精灵
    npc_patrol_preview_changed = Signal(str, bool)

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self.setWidgetResizable(True)
        self.setMinimumWidth(320)
        self._stack = QStackedWidget()
        self.setWidget(self._stack)

        self._empty = QLabel("Select an entity or click scene background")
        self._empty.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._stack.addWidget(self._empty)

        self._scene_panel = self._build_scene_panel()
        self._stack.addWidget(self._scene_panel)

        self._hotspot_panel = self._build_hotspot_panel()
        self._stack.addWidget(self._hotspot_panel)

        self._npc_panel = self._build_npc_panel()
        self._stack.addWidget(self._npc_panel)

        self._zone_panel = self._build_zone_panel()
        self._stack.addWidget(self._zone_panel)

        self._spawn_panel = self._build_spawn_panel()
        self._stack.addWidget(self._spawn_panel)

        self._current_data: dict | None = None
        self._spawn_scene: dict | None = None
        self._spawn_name_original: str = ""
        self._hs_trans_spawn_key: str = ""
        self._hs_trans_loading: bool = False
        self._world_aspect_ratio_hw: float = 16.0 / 9.0
        self._updating_world_dims: bool = False
        # Last opened entity dicts (still bound to model.scenes); used by Save All / flush
        # without requiring Apply or a visible property panel.
        self._pending_hotspot: dict | None = None
        self._pending_npc: dict | None = None
        self._pending_zone: dict | None = None
        self._spawn_flush_scene: dict | None = None
        self._editing_scene_id: str = ""
        self._zn_poly_updating: bool = False
        self._npc_patrol_table_updating: bool = False

    def _append_entity_delete_footer(self, vbox: QVBoxLayout) -> QPushButton:
        vbox.addSpacing(12)
        row = QHBoxLayout()
        row.addStretch(1)
        btn = QPushButton("从场景删除")
        btn.setToolTip("从当前场景数据中移除此实体（未 Save All 前仅内存变更）")
        btn.clicked.connect(self.delete_current_entity_requested.emit)
        row.addWidget(btn)
        vbox.addLayout(row)
        return btn

    def _load_ambient_widgets(self, ambient_ids: list[str]) -> None:
        catalog = list(self._model.all_audio_ids("ambient"))
        want = set(ambient_ids)
        self._sc_ambient_list.blockSignals(True)
        self._sc_ambient_list.clear()
        for aid in sorted(catalog):
            it = QListWidgetItem(aid)
            it.setFlags(it.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            it.setCheckState(
                Qt.CheckState.Checked if aid in want else Qt.CheckState.Unchecked,
            )
            self._sc_ambient_list.addItem(it)
        catalog_set = set(catalog)
        extra = [x for x in ambient_ids if x not in catalog_set]
        self._sc_ambient_extra.setText(", ".join(extra))
        self._sc_ambient_list.blockSignals(False)

    def _ambient_ids_from_widgets(self) -> list[str]:
        checked: list[str] = []
        for i in range(self._sc_ambient_list.count()):
            it = self._sc_ambient_list.item(i)
            if it.checkState() == Qt.CheckState.Checked:
                checked.append(it.text())
        extra_raw = self._sc_ambient_extra.text().strip()
        extra = [s.strip() for s in extra_raw.split(",") if s.strip()]
        seen: set[str] = set()
        out: list[str] = []
        for x in checked + extra:
            if x not in seen:
                seen.add(x)
                out.append(x)
        return out

    def show_empty(self) -> None:
        self._stack.setCurrentWidget(self._empty)

    # ---- scene props ------------------------------------------------------

    def _build_scene_panel(self) -> QWidget:
        w = QWidget()
        form = QFormLayout(w)
        form.setFieldGrowthPolicy(
            QFormLayout.FieldGrowthPolicy.FieldsStayAtSizeHint,
        )
        self._sc_id = QLineEdit(); form.addRow("id", self._sc_id)
        self._sc_name = QLineEdit(); form.addRow("name", self._sc_name)
        self._sc_width = QDoubleSpinBox()
        self._sc_width.setRange(0, 99999)
        self._sc_width.setDecimals(2)
        form.addRow("worldWidth", self._sc_width)
        self._sc_height = QDoubleSpinBox()
        self._sc_height.setRange(0, 99999)
        self._sc_height.setDecimals(2)
        form.addRow("worldHeight", self._sc_height)
        self._sc_lock_aspect = QCheckBox("锁定宽高比（改一侧按比例更新另一侧）")
        self._sc_lock_aspect.setChecked(True)
        self._sc_lock_aspect.setToolTip(
            "比例在打开场景时取自当前 worldHeight÷worldWidth；若仅有一项有效则尽量用背景图像素高宽比。"
        )
        self._sc_lock_aspect.toggled.connect(self._on_lock_aspect_toggled)
        form.addRow("", self._sc_lock_aspect)
        self._sc_width.valueChanged.connect(self._on_world_width_changed)
        self._sc_height.valueChanged.connect(self._on_world_height_changed)
        self._sc_bgm = IdRefSelector(allow_empty=True)
        self._sc_bgm.setMinimumWidth(200)
        self._sc_bgm.value_changed.connect(lambda _x: self.changed.emit())
        form.addRow("bgm", self._sc_bgm)
        self._sc_filter = IdRefSelector(allow_empty=True)
        form.addRow("filterId", self._sc_filter)
        self._sc_zoom = QDoubleSpinBox(); self._sc_zoom.setRange(0.01, 20); self._sc_zoom.setSingleStep(0.1)
        form.addRow("camera.zoom", self._sc_zoom)
        self._sc_ppu = QDoubleSpinBox(); self._sc_ppu.setRange(0.01, 9999); self._sc_ppu.setValue(1)
        form.addRow("camera.ppu", self._sc_ppu)
        self._sc_scale = QDoubleSpinBox(); self._sc_scale.setRange(0.01, 10); self._sc_scale.setValue(1)
        form.addRow("worldScale", self._sc_scale)

        depth_box = QGroupBox("depthConfig（2D 遮挡深度）")
        depth_form = QFormLayout(depth_box)
        self._sc_depth_tol = QDoubleSpinBox()
        self._sc_depth_tol.setRange(-50.0, 50.0)
        self._sc_depth_tol.setDecimals(4)
        self._sc_depth_tol.setSingleStep(0.05)
        self._sc_depth_tol.setToolTip(
            "depth_tolerance：精灵与场景深度比较时的容差（标定深度空间），对应 Scene Depth Editor「深度容差」。",
        )
        depth_form.addRow("depth_tolerance", self._sc_depth_tol)
        self._sc_floor_offset = QDoubleSpinBox()
        self._sc_floor_offset.setRange(-50.0, 50.0)
        self._sc_floor_offset.setDecimals(4)
        self._sc_floor_offset.setSingleStep(0.05)
        self._sc_floor_offset.setToolTip(
            "floor_offset：脚底深度衬底偏移（标定深度空间），对应 Scene Depth Editor「地板偏移」。",
        )
        depth_form.addRow("floor_offset", self._sc_floor_offset)
        self._sc_depth_hint = QLabel()
        self._sc_depth_hint.setWordWrap(True)
        depth_form.addRow(self._sc_depth_hint)
        self._sc_depth_tol.valueChanged.connect(self._on_depth_fields_changed)
        self._sc_floor_offset.valueChanged.connect(self._on_depth_fields_changed)
        form.addRow(depth_box)

        self._sc_walk = QDoubleSpinBox(); self._sc_walk.setRange(0, 9999)
        form.addRow("walkSpeed", self._sc_walk)
        self._sc_run = QDoubleSpinBox(); self._sc_run.setRange(0, 9999)
        form.addRow("runSpeed", self._sc_run)
        amb_box = QWidget()
        amb_box.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Maximum,
        )
        amb_lay = QVBoxLayout(amb_box)
        amb_lay.setContentsMargins(0, 0, 0, 0)
        amb_lay.setSpacing(4)
        amb_hint = QLabel(
            "勾选 audio_config.ambient 中的 id；目录外 id 在下方填写（逗号分隔）。",
        )
        amb_hint.setWordWrap(True)
        amb_hint.setSizePolicy(
            QSizePolicy.Policy.Preferred,
            QSizePolicy.Policy.Maximum,
        )
        amb_lay.addWidget(amb_hint)
        self._sc_ambient_list = QListWidget()
        self._sc_ambient_list.setFixedHeight(110)
        self._sc_ambient_list.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Fixed,
        )
        self._sc_ambient_list.setHorizontalScrollBarPolicy(
            Qt.ScrollBarPolicy.ScrollBarAlwaysOff,
        )
        self._sc_ambient_list.itemChanged.connect(lambda _i: self.changed.emit())
        amb_lay.addWidget(self._sc_ambient_list)
        self._sc_ambient_extra = QLineEdit()
        self._sc_ambient_extra.setPlaceholderText("其它 ambient id，逗号分隔")
        self._sc_ambient_extra.textChanged.connect(self.changed.emit)
        amb_lay.addWidget(self._sc_ambient_extra)
        amb_lbl = QLabel("ambientSounds")
        amb_lbl.setAlignment(
            Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignTop,
        )
        form.addRow(amb_lbl, amb_box)
        return w

    def load_scene_props(
        self, sc: dict, *, clear_pending_edits: bool = False,
    ) -> None:
        self._current_data = sc
        if clear_pending_edits:
            self._pending_hotspot = None
            self._pending_npc = None
            self._pending_zone = None
            self._spawn_flush_scene = None
            self._spawn_scene = None
        self._stack.setCurrentWidget(self._scene_panel)
        self._editing_scene_id = str(sc.get("id", ""))
        self._sc_id.setText(sc.get("id", ""))
        self._sc_name.setText(sc.get("name", ""))
        ww = float(sc.get("worldWidth", 0) or 0)
        wh = float(sc.get("worldHeight", 0) or 0)
        if ww > 0 and wh > 0:
            self._world_aspect_ratio_hw = wh / ww
        else:
            sid = self._editing_scene_id or str(sc.get("id", ""))
            asp = _background_pixel_aspect(self._model, sid, sc)
            if asp is not None and asp > 0:
                self._world_aspect_ratio_hw = asp
            else:
                self._world_aspect_ratio_hw = 16.0 / 9.0
        self._updating_world_dims = True
        self._sc_width.blockSignals(True)
        self._sc_height.blockSignals(True)
        try:
            self._sc_width.setValue(ww)
            self._sc_height.setValue(wh)
        finally:
            self._sc_width.blockSignals(False)
            self._sc_height.blockSignals(False)
        self._updating_world_dims = False
        self._sc_bgm.set_items([(a, a) for a in self._model.all_audio_ids("bgm")])
        self._sc_bgm.set_current(str(sc.get("bgm", "") or ""))
        self._sc_filter.set_items(self._model.all_filter_ids())
        self._sc_filter.set_current(sc.get("filterId", ""))
        cam = sc.get("camera", {})
        self._sc_zoom.setValue(cam.get("zoom", 1))
        self._sc_ppu.setValue(cam.get("pixelsPerUnit", 1))
        self._sc_scale.setValue(sc.get("worldScale", 1))
        self._sc_walk.setValue(sc.get("playerWalkSpeed", 0))
        self._sc_run.setValue(sc.get("playerRunSpeed", 0))
        dc = sc.get("depthConfig")
        self._sc_depth_tol.blockSignals(True)
        self._sc_floor_offset.blockSignals(True)
        try:
            if isinstance(dc, dict):
                self._sc_depth_tol.setEnabled(True)
                self._sc_floor_offset.setEnabled(True)
                self._sc_depth_tol.setValue(float(dc.get("depth_tolerance", 0)))
                self._sc_floor_offset.setValue(float(dc.get("floor_offset", 0)))
                self._sc_depth_hint.setText(
                    "与运行时 SceneDepthSystem 一致；其余 depthConfig 请在 Scene Depth Editor 中导出。",
                )
            else:
                self._sc_depth_tol.setEnabled(False)
                self._sc_floor_offset.setEnabled(False)
                self._sc_depth_tol.setValue(0.0)
                self._sc_floor_offset.setValue(0.0)
                self._sc_depth_hint.setText(
                    "当前场景无 depthConfig。请先用主菜单「Scene Depth Editor」导出后再在此处微调这两项。",
                )
        finally:
            self._sc_depth_tol.blockSignals(False)
            self._sc_floor_offset.blockSignals(False)
        raw_amb = sc.get("ambientSounds", [])
        if not isinstance(raw_amb, list):
            raw_amb = []
        self._load_ambient_widgets([str(x) for x in raw_amb])

    def _on_depth_fields_changed(self, _v: float) -> None:
        if not self._sc_depth_tol.isEnabled():
            return
        self.changed.emit()

    def _on_lock_aspect_toggled(self, checked: bool) -> None:
        if checked:
            w = self._sc_width.value()
            h = self._sc_height.value()
            if w > 0 and h > 0:
                self._world_aspect_ratio_hw = h / w

    def _on_world_width_changed(self, _v: float) -> None:
        if self._updating_world_dims:
            return
        if not self._sc_lock_aspect.isChecked():
            return
        w = self._sc_width.value()
        if w <= 0:
            return
        self._updating_world_dims = True
        self._sc_height.blockSignals(True)
        try:
            self._sc_height.setValue(round(w * self._world_aspect_ratio_hw, 2))
        finally:
            self._sc_height.blockSignals(False)
        self._updating_world_dims = False
        self.changed.emit()

    def _on_world_height_changed(self, _v: float) -> None:
        if self._updating_world_dims:
            return
        if not self._sc_lock_aspect.isChecked():
            return
        h = self._sc_height.value()
        if h <= 0:
            return
        r = self._world_aspect_ratio_hw
        if r <= 1e-12:
            return
        self._updating_world_dims = True
        self._sc_width.blockSignals(True)
        try:
            self._sc_width.setValue(round(h / r, 2))
        finally:
            self._sc_width.blockSignals(False)
        self._updating_world_dims = False
        self.changed.emit()

    def save_scene_props(self) -> None:
        if self._stack.currentWidget() != self._scene_panel:
            return
        sc = self._current_data
        if sc is None:
            return
        sc["name"] = self._sc_name.text()
        ww = self._sc_width.value()
        if ww > 0:
            sc["worldWidth"] = ww
        wh = self._sc_height.value()
        if wh > 0:
            sc["worldHeight"] = wh
        bgm = self._sc_bgm.current_id().strip()
        if bgm:
            sc["bgm"] = bgm
        elif "bgm" in sc:
            del sc["bgm"]
        fid = self._sc_filter.current_id()
        if fid:
            sc["filterId"] = fid
        elif "filterId" in sc:
            del sc["filterId"]
        cam = sc.setdefault("camera", {})
        cam["zoom"] = self._sc_zoom.value()
        cam["pixelsPerUnit"] = self._sc_ppu.value()
        sc_scale = self._sc_scale.value()
        if sc_scale != 1:
            sc["worldScale"] = sc_scale
        elif "worldScale" in sc:
            del sc["worldScale"]
        ws = self._sc_walk.value()
        if ws > 0:
            sc["playerWalkSpeed"] = ws
        elif "playerWalkSpeed" in sc:
            del sc["playerWalkSpeed"]
        rs = self._sc_run.value()
        if rs > 0:
            sc["playerRunSpeed"] = rs
        elif "playerRunSpeed" in sc:
            del sc["playerRunSpeed"]
        dc_save = sc.get("depthConfig")
        if isinstance(dc_save, dict):
            dc_save["depth_tolerance"] = float(self._sc_depth_tol.value())
            dc_save["floor_offset"] = float(self._sc_floor_offset.value())
        ambs = self._ambient_ids_from_widgets()
        if ambs:
            sc["ambientSounds"] = ambs
        elif "ambientSounds" in sc:
            del sc["ambientSounds"]
        self.changed.emit()

    def flush_pending_to_model(self) -> None:
        """Apply whatever the property widgets last referred to into model dicts."""
        self.save_scene_props()
        if self._pending_hotspot is not None:
            self._write_hotspot_widgets_to_dict(self._pending_hotspot)
        if self._pending_npc is not None:
            self._write_npc_widgets_to_dict(self._pending_npc)
        if self._pending_zone is not None:
            self._write_zone_widgets_to_dict(self._pending_zone)
        if self._spawn_flush_scene is not None and self._spawn_scene is not None:
            self._write_spawn_widgets_to_dict(self._spawn_scene)

    # ---- hotspot props ----------------------------------------------------

    def _build_hotspot_panel(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        form = QFormLayout()
        self._hs_id = QLineEdit(); form.addRow("id", self._hs_id)
        self._hs_type = QComboBox()
        self._hs_type.addItems(["inspect", "pickup", "transition", "npc", "encounter"])
        form.addRow("type", self._hs_type)
        self._hs_label = QLineEdit(); form.addRow("label", self._hs_label)
        self._hs_x = QDoubleSpinBox(); self._hs_x.setRange(-99999, 99999); self._hs_x.setDecimals(1)
        form.addRow("x", self._hs_x)
        self._hs_y = QDoubleSpinBox(); self._hs_y.setRange(-99999, 99999); self._hs_y.setDecimals(1)
        form.addRow("y", self._hs_y)
        self._hs_range = QDoubleSpinBox(); self._hs_range.setRange(0, 99999)
        form.addRow("interactionRange", self._hs_range)
        self._hs_range.valueChanged.connect(self._on_hotspot_interaction_range_live)
        self._hs_auto = QCheckBox(); form.addRow("autoTrigger", self._hs_auto)
        lay.addLayout(form)

        self._hs_cond = ConditionEditor("Conditions")
        lay.addWidget(self._hs_cond)

        self._hs_data_stack = QStackedWidget()
        lay.addWidget(QLabel("<b>Data</b>"))
        lay.addWidget(self._hs_data_stack)

        # inspect data
        ip = QWidget()
        il = QVBoxLayout(ip)
        self._hs_inspect_text = QTextEdit(); self._hs_inspect_text.setMaximumHeight(80)
        il.addWidget(QLabel("text")); il.addWidget(self._hs_inspect_text)
        self._hs_inspect_actions = ActionEditor("actions")
        il.addWidget(self._hs_inspect_actions)
        self._hs_data_stack.addWidget(ip)

        # pickup data
        pp = QWidget(); pf = QFormLayout(pp)
        self._hs_pickup_item = IdRefSelector(allow_empty=False)
        self._hs_pickup_item.setMinimumWidth(200)
        self._hs_pickup_item.value_changed.connect(lambda _x: self.changed.emit())
        pf.addRow("itemId", self._hs_pickup_item)
        self._hs_pickup_name = QLineEdit(); pf.addRow("itemName", self._hs_pickup_name)
        self._hs_pickup_count = QSpinBox(); self._hs_pickup_count.setRange(1, 999)
        pf.addRow("count", self._hs_pickup_count)
        self._hs_pickup_currency = QCheckBox(); pf.addRow("isCurrency", self._hs_pickup_currency)
        self._hs_data_stack.addWidget(pp)

        # transition data
        tp = QWidget()
        tlv = QVBoxLayout(tp)
        tf = QFormLayout()
        self._hs_trans_scene = IdRefSelector(
            allow_empty=False, click_opens_popup=True)
        tf.addRow("targetScene", self._hs_trans_scene)
        self._hs_trans_scene.value_changed.connect(self._on_trans_scene_changed)
        spawn_row = QWidget()
        spawn_lay = QHBoxLayout(spawn_row)
        spawn_lay.setContentsMargins(0, 0, 0, 0)
        self._hs_trans_spawn_display = QLineEdit()
        self._hs_trans_spawn_display.setReadOnly(True)
        self._hs_trans_spawn_display.setPlaceholderText("点击右侧按钮在场景预览中选择…")
        spawn_lay.addWidget(self._hs_trans_spawn_display, 1)
        self._hs_trans_pick_btn = QPushButton("选择出生点…")
        self._hs_trans_pick_btn.clicked.connect(self._open_trans_spawn_picker)
        spawn_lay.addWidget(self._hs_trans_pick_btn)
        tf.addRow("targetSpawnPoint", spawn_row)
        tlv.addLayout(tf)
        self._hs_data_stack.addWidget(tp)

        # npc hotspot data
        np_ = QWidget(); nf = QFormLayout(np_)
        self._hs_npc_id = IdRefSelector(allow_empty=True)
        self._hs_npc_id.setMinimumWidth(200)
        self._hs_npc_id.value_changed.connect(lambda _x: self.changed.emit())
        nf.addRow("npcId", self._hs_npc_id)
        self._hs_data_stack.addWidget(np_)

        # encounter data
        ep = QWidget(); ef = QFormLayout(ep)
        self._hs_enc_id = IdRefSelector(allow_empty=False)
        ef.addRow("encounterId", self._hs_enc_id)
        self._hs_data_stack.addWidget(ep)

        self._hs_type.currentTextChanged.connect(self._on_hs_type_changed)
        self._append_entity_delete_footer(lay)
        return w

    _TYPE_TO_DATA_IDX = {"inspect": 0, "pickup": 1, "transition": 2, "npc": 3, "encounter": 4}

    def _on_hs_type_changed(self, t: str) -> None:
        self._hs_data_stack.setCurrentIndex(self._TYPE_TO_DATA_IDX.get(t, 0))

    def _on_trans_scene_changed(self, sid: str) -> None:
        if self._hs_trans_loading:
            return
        if not sid:
            self._hs_trans_spawn_key = ""
            self._refresh_trans_spawn_display()
            return
        sc = self._model.scenes.get(sid)
        if sc and self._hs_trans_spawn_key:
            if self._hs_trans_spawn_key not in (sc.get("spawnPoints") or {}):
                self._hs_trans_spawn_key = ""
        self._refresh_trans_spawn_display()
        # 可编辑 Combo 在下拉关闭的同一事件里弹模态框容易导致列表闪退；延后一拍再打开出生点对话框。
        QTimer.singleShot(0, self._open_trans_spawn_picker)

    def _refresh_trans_spawn_display(self) -> None:
        sid = self._hs_trans_scene.current_id()
        if not sid:
            self._hs_trans_spawn_display.setText("")
            self._hs_trans_pick_btn.setEnabled(False)
            return
        self._hs_trans_pick_btn.setEnabled(True)
        if not self._hs_trans_spawn_key:
            self._hs_trans_spawn_display.setText("默认（spawnPoint，写入时省略 targetSpawnPoint）")
        else:
            self._hs_trans_spawn_display.setText(self._hs_trans_spawn_key)

    def _open_trans_spawn_picker(self) -> None:
        sid = self._hs_trans_scene.current_id()
        if not sid:
            QMessageBox.information(self, "传送热点", "请先选择目标场景。")
            return
        dlg = TargetSpawnPickerDialog(self._model, sid, self._hs_trans_spawn_key, self)
        if dlg.exec() == QDialog.DialogCode.Accepted:
            self._hs_trans_spawn_key = dlg.selected_spawn_key()
            self._refresh_trans_spawn_display()
            self.changed.emit()

    def load_hotspot_props(self, hs: dict) -> None:
        self._current_data = hs
        self._pending_hotspot = hs
        self._stack.setCurrentWidget(self._hotspot_panel)
        self._hs_id.setText(hs.get("id", ""))
        self._hs_type.setCurrentText(hs.get("type", "inspect"))
        self._hs_label.setText(hs.get("label", ""))
        self._hs_x.setValue(hs.get("x", 0))
        self._hs_y.setValue(hs.get("y", 0))
        self._hs_range.blockSignals(True)
        self._hs_range.setValue(hs.get("interactionRange", 50))
        self._hs_range.blockSignals(False)
        self._hs_auto.setChecked(hs.get("autoTrigger", False))
        self._hs_cond.set_flag_pattern_context(self._model, self._editing_scene_id or None)
        self._hs_cond.set_data(hs.get("conditions", []))

        data = hs.get("data", {})
        ht = hs.get("type", "inspect")
        self._on_hs_type_changed(ht)
        if ht == "inspect":
            self._hs_inspect_text.setPlainText(data.get("text", ""))
            self._hs_inspect_actions.set_project_context(
                self._model, self._editing_scene_id or None,
            )
            self._hs_inspect_actions.set_data(data.get("actions", []))
        elif ht == "pickup":
            self._hs_pickup_item.set_items(self._model.all_item_ids())
            self._hs_pickup_item.set_current(data.get("itemId", ""))
            self._hs_pickup_name.setText(data.get("itemName", ""))
            self._hs_pickup_count.setValue(data.get("count", 1))
            self._hs_pickup_currency.setChecked(data.get("isCurrency", False))
        elif ht == "transition":
            self._hs_trans_loading = True
            try:
                self._hs_trans_spawn_key = (data.get("targetSpawnPoint") or "").strip()
                self._hs_trans_scene.set_items(
                    [(s, s) for s in self._model.all_scene_ids()])
                self._hs_trans_scene.set_current(data.get("targetScene", ""))
            finally:
                self._hs_trans_loading = False
            self._refresh_trans_spawn_display()
        elif ht == "npc":
            self._hs_npc_id.set_items(
                self._model.npc_ids_for_scene(self._editing_scene_id or None),
            )
            self._hs_npc_id.set_current(data.get("npcId", ""))
        elif ht == "encounter":
            self._hs_enc_id.set_items(self._model.all_encounter_ids())
            self._hs_enc_id.set_current(data.get("encounterId", ""))

    def _on_hotspot_interaction_range_live(self, value: float) -> None:
        hs = self._pending_hotspot
        if hs is None or self._stack.currentWidget() != self._hotspot_panel:
            return
        hs["interactionRange"] = float(value)
        eid = str(hs.get("id", ""))
        if eid:
            self.interaction_range_changed.emit("hotspot", eid, float(value))
        self.changed.emit()

    def _on_npc_interaction_range_live(self, value: float) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return
        npc["interactionRange"] = float(value)
        eid = str(npc.get("id", ""))
        if eid:
            self.interaction_range_changed.emit("npc", eid, float(value))
        self.changed.emit()

    def _write_hotspot_widgets_to_dict(self, hs: dict) -> None:
        hs["id"] = self._hs_id.text().strip()
        hs["type"] = self._hs_type.currentText()
        hs["label"] = self._hs_label.text()
        hs["x"] = self._hs_x.value()
        hs["y"] = self._hs_y.value()
        hs["interactionRange"] = self._hs_range.value()
        if self._hs_auto.isChecked():
            hs["autoTrigger"] = True
        elif "autoTrigger" in hs:
            del hs["autoTrigger"]
        conds = self._hs_cond.to_list()
        if conds:
            hs["conditions"] = conds
        elif "conditions" in hs:
            del hs["conditions"]

        ht = hs["type"]
        if ht == "inspect":
            hs["data"] = {"text": self._hs_inspect_text.toPlainText()}
            acts = self._hs_inspect_actions.to_list()
            if acts:
                hs["data"]["actions"] = acts
        elif ht == "pickup":
            hs["data"] = {
                "itemId": self._hs_pickup_item.current_id(),
                "itemName": self._hs_pickup_name.text(),
                "count": self._hs_pickup_count.value(),
            }
            if self._hs_pickup_currency.isChecked():
                hs["data"]["isCurrency"] = True
        elif ht == "transition":
            tid = self._hs_trans_scene.current_id()
            hs["data"] = {"targetScene": tid}
            sp = self._hs_trans_spawn_key.strip()
            if sp:
                hs["data"]["targetSpawnPoint"] = sp
        elif ht == "npc":
            hs["data"] = {"npcId": self._hs_npc_id.current_id()}
        elif ht == "encounter":
            hs["data"] = {"encounterId": self._hs_enc_id.current_id()}
        self.changed.emit()

    def save_hotspot_props(self) -> dict | None:
        hs = self._current_data
        if hs is None or self._stack.currentWidget() != self._hotspot_panel:
            return None
        self._write_hotspot_widgets_to_dict(hs)
        return hs

    # ---- NPC props --------------------------------------------------------

    def _build_npc_panel(self) -> QWidget:
        w = QWidget()
        outer = QVBoxLayout(w)
        form = QFormLayout()
        self._npc_id = QLineEdit(); form.addRow("id", self._npc_id)
        self._npc_name = QLineEdit(); form.addRow("name", self._npc_name)
        self._npc_x = QDoubleSpinBox(); self._npc_x.setRange(-99999, 99999); self._npc_x.setDecimals(1)
        self._npc_x.valueChanged.connect(self._on_npc_xy_live)
        form.addRow("x", self._npc_x)
        self._npc_y = QDoubleSpinBox(); self._npc_y.setRange(-99999, 99999); self._npc_y.setDecimals(1)
        self._npc_y.valueChanged.connect(self._on_npc_xy_live)
        form.addRow("y", self._npc_y)
        self._npc_dialogue = IdRefSelector(allow_empty=True)
        self._npc_dialogue.setMinimumWidth(220)
        self._npc_dialogue.value_changed.connect(lambda _x: self.changed.emit())
        form.addRow("dialogueFile", self._npc_dialogue)
        self._npc_knot = QLineEdit(); form.addRow("dialogueKnot", self._npc_knot)
        self._npc_range = QDoubleSpinBox(); self._npc_range.setRange(0, 99999)
        form.addRow("interactionRange", self._npc_range)
        self._npc_range.valueChanged.connect(self._on_npc_interaction_range_live)
        self._npc_anim = IdRefSelector(allow_empty=True)
        self._npc_anim.setMinimumWidth(220)
        self._npc_anim.value_changed.connect(self._on_npc_anim_file_changed)
        form.addRow("animFile", self._npc_anim)
        self._npc_initial_state = QComboBox()
        self._npc_initial_state.setMinimumWidth(220)
        self._npc_initial_state.currentIndexChanged.connect(self._on_npc_initial_state_changed)
        form.addRow("initialAnimState", self._npc_initial_state)
        outer.addLayout(form)

        patrol_box = QGroupBox("巡逻路径（运行时折返 ping-pong）")
        patrol_outer = QVBoxLayout(patrol_box)
        self._npc_patrol_enable = QCheckBox("启用巡逻")
        self._npc_patrol_enable.toggled.connect(self._on_npc_patrol_enable_toggled)
        patrol_outer.addWidget(self._npc_patrol_enable)
        sp_row = QHBoxLayout()
        sp_row.addWidget(QLabel("speed"))
        self._npc_patrol_speed = QDoubleSpinBox()
        self._npc_patrol_speed.setRange(1, 500)
        self._npc_patrol_speed.setValue(60)
        self._npc_patrol_speed.valueChanged.connect(self._on_npc_patrol_speed_changed)
        sp_row.addWidget(self._npc_patrol_speed)
        patrol_outer.addLayout(sp_row)
        move_anim_row = QHBoxLayout()
        move_anim_row.addWidget(QLabel("巡逻移动动画状态"))
        self._npc_patrol_move_anim = QLineEdit()
        self._npc_patrol_move_anim.setPlaceholderText(
            "animFile 内 states 的键名，与运行时一致；留空则移动时不切动画")
        self._npc_patrol_move_anim.editingFinished.connect(
            self._on_npc_patrol_move_anim_finished)
        move_anim_row.addWidget(self._npc_patrol_move_anim)
        patrol_outer.addLayout(move_anim_row)
        self._npc_patrol_preview = QCheckBox("画布预览巡逻（不写回 x,y）")
        self._npc_patrol_preview.setToolTip("需配置 animFile；沿路径折返移动，仅预览。")
        self._npc_patrol_preview.toggled.connect(self._on_npc_patrol_preview_toggled)
        patrol_outer.addWidget(self._npc_patrol_preview)
        ph = QLabel("路点可与出生 x,y 不同；线段中点仍可选中紫色 NPC 控制点。")
        ph.setWordWrap(True)
        patrol_outer.addWidget(ph)
        self._npc_patrol_table = QTableWidget(0, 3)
        self._npc_patrol_table.setHorizontalHeaderLabels(["#", "x", "y"])
        self._npc_patrol_table.horizontalHeader().setSectionResizeMode(
            0, QHeaderView.ResizeMode.ResizeToContents)
        self._npc_patrol_table.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.Stretch)
        self._npc_patrol_table.horizontalHeader().setSectionResizeMode(
            2, QHeaderView.ResizeMode.Stretch)
        self._npc_patrol_table.setMinimumHeight(120)
        self._npc_patrol_table.itemChanged.connect(self._on_npc_patrol_table_item_changed)
        patrol_outer.addWidget(self._npc_patrol_table)
        pr_btns = QHBoxLayout()
        self._npc_patrol_add_pt = QPushButton("添加路点")
        self._npc_patrol_add_pt.clicked.connect(self._on_npc_patrol_add_point)
        self._npc_patrol_del_pt = QPushButton("删除所选路点")
        self._npc_patrol_del_pt.clicked.connect(self._on_npc_patrol_remove_point)
        pr_btns.addWidget(self._npc_patrol_add_pt)
        pr_btns.addWidget(self._npc_patrol_del_pt)
        patrol_outer.addLayout(pr_btns)
        outer.addWidget(patrol_box)
        self._set_npc_patrol_widgets_enabled(False)

        _npc_scene_hint = QLabel(
            "动画仅在主画布上播放（脚底对齐 x,y）；侧栏只编辑 animFile 与 initialAnimState。"
        )
        _npc_scene_hint.setWordWrap(True)
        outer.addWidget(_npc_scene_hint)
        self._append_entity_delete_footer(outer)
        return w

    def _set_npc_patrol_widgets_enabled(self, en: bool) -> None:
        self._npc_patrol_speed.setEnabled(en)
        self._npc_patrol_move_anim.setEnabled(en)
        self._npc_patrol_table.setEnabled(en)
        self._npc_patrol_add_pt.setEnabled(en)
        self._npc_patrol_del_pt.setEnabled(en)
        self._update_npc_patrol_preview_enabled()

    def _update_npc_patrol_preview_enabled(self) -> None:
        en = (
            self._npc_patrol_enable.isChecked()
            and bool(self._npc_anim.current_id().strip())
        )
        self._npc_patrol_preview.setEnabled(en)
        if not en and self._npc_patrol_preview.isChecked():
            self._npc_patrol_preview.blockSignals(True)
            self._npc_patrol_preview.setChecked(False)
            self._npc_patrol_preview.blockSignals(False)
            npc = self._pending_npc
            if npc is not None:
                self.npc_patrol_preview_changed.emit(str(npc.get("id", "")), False)

    def _default_patrol_route_for_npc(self, npc: dict) -> list[dict[str, float]]:
        x = round(float(npc.get("x", 0)), 1)
        y = round(float(npc.get("y", 0)), 1)
        return [{"x": x, "y": y}, {"x": round(x + 50.0, 1), "y": y}]

    def _npc_patrol_route_from_table(self) -> list[dict[str, float]]:
        t = self._npc_patrol_table
        out: list[dict[str, float]] = []
        for r in range(t.rowCount()):
            x_it = t.item(r, 1)
            y_it = t.item(r, 2)
            try:
                x = round(float(x_it.text().strip() if x_it else 0), 1)
                y = round(float(y_it.text().strip() if y_it else 0), 1)
            except (TypeError, ValueError, AttributeError):
                x, y = 0.0, 0.0
            out.append({"x": x, "y": y})
        return out

    def _fill_npc_patrol_table(self, route: list) -> None:
        self._npc_patrol_table_updating = True
        try:
            self._npc_patrol_table.blockSignals(True)
            self._npc_patrol_table.setRowCount(0)
            if not isinstance(route, list):
                route = []
            for i, p in enumerate(route):
                if not isinstance(p, dict):
                    continue
                r = self._npc_patrol_table.rowCount()
                self._npc_patrol_table.insertRow(r)
                ix = QTableWidgetItem(str(i))
                ix.setFlags(ix.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self._npc_patrol_table.setItem(r, 0, ix)
                self._npc_patrol_table.setItem(
                    r, 1, QTableWidgetItem(str(round(float(p.get("x", 0)), 1))))
                self._npc_patrol_table.setItem(
                    r, 2, QTableWidgetItem(str(round(float(p.get("y", 0)), 1))))
            self._npc_patrol_table.blockSignals(False)
            for r in range(self._npc_patrol_table.rowCount()):
                it = self._npc_patrol_table.item(r, 0)
                if it:
                    it.setText(str(r))
        finally:
            self._npc_patrol_table_updating = False

    def _sync_patrol_dict_from_table(self) -> None:
        npc = self._pending_npc
        if npc is None or not self._npc_patrol_enable.isChecked():
            return
        route = self._npc_patrol_route_from_table()
        if len(route) < 2:
            return
        pat = npc.setdefault("patrol", {})
        pat["route"] = route
        if "speed" not in pat:
            pat["speed"] = int(self._npc_patrol_speed.value())
        v = self._npc_patrol_move_anim.text().strip()
        if v:
            pat["moveAnimState"] = v
        elif "moveAnimState" in pat:
            del pat["moveAnimState"]

    def _on_npc_patrol_move_anim_finished(self) -> None:
        if self._stack.currentWidget() != self._npc_panel:
            return
        npc = self._pending_npc
        if npc is None or not self._npc_patrol_enable.isChecked():
            return
        pat = npc.setdefault("patrol", {})
        v = self._npc_patrol_move_anim.text().strip()
        if v:
            pat["moveAnimState"] = v
        elif "moveAnimState" in pat:
            del pat["moveAnimState"]
        self.changed.emit()
        self._request_scene_npc_anim_refresh()

    def _on_npc_patrol_enable_toggled(self, checked: bool) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return
        self._set_npc_patrol_widgets_enabled(checked)
        if checked:
            patrol = npc.setdefault("patrol", {})
            route = patrol.get("route")
            if not isinstance(route, list) or len(route) < 2:
                patrol["route"] = self._default_patrol_route_for_npc(npc)
            if patrol.get("speed") is None:
                patrol["speed"] = 60
            self._npc_patrol_speed.blockSignals(True)
            self._npc_patrol_speed.setValue(int(patrol.get("speed", 60) or 60))
            self._npc_patrol_speed.blockSignals(False)
            self._fill_npc_patrol_table(patrol["route"])
            self._npc_patrol_move_anim.blockSignals(True)
            self._npc_patrol_move_anim.setText(
                str(patrol.get("moveAnimState", "") or ""))
            self._npc_patrol_move_anim.blockSignals(False)
        else:
            npc.pop("patrol", None)
            self._npc_patrol_preview.blockSignals(True)
            self._npc_patrol_preview.setChecked(False)
            self._npc_patrol_preview.blockSignals(False)
            self._npc_patrol_table.setRowCount(0)
            self._npc_patrol_move_anim.blockSignals(True)
            self._npc_patrol_move_anim.clear()
            self._npc_patrol_move_anim.blockSignals(False)
            self.npc_patrol_preview_changed.emit(str(npc.get("id", "")), False)
        self.changed.emit()
        self.npc_patrol_overlay_refresh_requested.emit()

    def _on_npc_patrol_speed_changed(self, _v: float) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return
        if not self._npc_patrol_enable.isChecked():
            return
        pat = npc.setdefault("patrol", {})
        pat["speed"] = int(self._npc_patrol_speed.value())
        self.changed.emit()

    def _on_npc_patrol_preview_toggled(self, checked: bool) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return
        if not self._npc_patrol_enable.isChecked():
            return
        self.npc_patrol_preview_changed.emit(str(npc.get("id", "")), checked)

    def _on_npc_patrol_table_item_changed(self, item: QTableWidgetItem) -> None:
        if self._npc_patrol_table_updating:
            return
        if item.column() == 0:
            return
        if not self._npc_patrol_enable.isChecked():
            return
        self._sync_patrol_dict_from_table()
        self.changed.emit()
        self.npc_patrol_overlay_refresh_requested.emit()

    def _on_npc_patrol_add_point(self) -> None:
        if self._stack.currentWidget() != self._npc_panel or not self._npc_patrol_enable.isChecked():
            return
        npc = self._pending_npc
        if npc is None:
            return
        route = self._npc_patrol_route_from_table()
        if len(route) < 2:
            route = self._default_patrol_route_for_npc(npc)
        last = route[-1]
        nx = round(float(last["x"]) + 40.0, 1)
        ny = round(float(last["y"]), 1)
        route.append({"x": nx, "y": ny})
        self._fill_npc_patrol_table(route)
        self._sync_patrol_dict_from_table()
        self.changed.emit()
        self.npc_patrol_overlay_refresh_requested.emit()

    def _on_npc_patrol_remove_point(self) -> None:
        if self._stack.currentWidget() != self._npc_panel or not self._npc_patrol_enable.isChecked():
            return
        t = self._npc_patrol_table
        row = t.currentRow()
        if row < 0 or t.rowCount() <= 2:
            return
        route = self._npc_patrol_route_from_table()
        if row < len(route):
            del route[row]
        self._fill_npc_patrol_table(route)
        self._sync_patrol_dict_from_table()
        self.changed.emit()
        self.npc_patrol_overlay_refresh_requested.emit()

    def _load_npc_patrol_ui(self, npc: dict) -> None:
        pat = npc.get("patrol")
        en = isinstance(pat, dict) and isinstance(pat.get("route"), list) and len(pat["route"]) >= 2
        self._npc_patrol_enable.blockSignals(True)
        self._npc_patrol_enable.setChecked(en)
        self._npc_patrol_enable.blockSignals(False)
        self._set_npc_patrol_widgets_enabled(en)
        if en and isinstance(pat, dict):
            self._npc_patrol_speed.blockSignals(True)
            self._npc_patrol_speed.setValue(int(pat.get("speed", 60) or 60))
            self._npc_patrol_speed.blockSignals(False)
            self._fill_npc_patrol_table(pat["route"])
            self._npc_patrol_move_anim.blockSignals(True)
            self._npc_patrol_move_anim.setText(
                str(pat.get("moveAnimState", "") or ""))
            self._npc_patrol_move_anim.blockSignals(False)
        else:
            self._npc_patrol_speed.blockSignals(True)
            self._npc_patrol_speed.setValue(60)
            self._npc_patrol_speed.blockSignals(False)
            self._npc_patrol_table.setRowCount(0)
            self._npc_patrol_move_anim.blockSignals(True)
            self._npc_patrol_move_anim.clear()
            self._npc_patrol_move_anim.blockSignals(False)
        self._npc_patrol_preview.blockSignals(True)
        self._npc_patrol_preview.setChecked(False)
        self._npc_patrol_preview.blockSignals(False)
        self._update_npc_patrol_preview_enabled()

    def refresh_npc_patrol_table(self, npc_id: str, route: list) -> None:
        if self._stack.currentWidget() != self._npc_panel or self._pending_npc is None:
            return
        if str(self._pending_npc.get("id", "")) != npc_id:
            return
        if not self._npc_patrol_enable.isChecked():
            return
        if not isinstance(route, list):
            return
        self._fill_npc_patrol_table(route)
        pat = self._pending_npc.setdefault("patrol", {})
        pat["route"] = [dict(x) for x in route] if route else []

    def _request_scene_npc_anim_refresh(self) -> None:
        nid = ""
        if self._pending_npc:
            nid = str(self._pending_npc.get("id", "") or "")
        self.npc_scene_anim_refresh_requested.emit(nid)

    def _on_npc_xy_live(self, _v: float) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return
        npc["x"] = round(float(self._npc_x.value()), 1)
        npc["y"] = round(float(self._npc_y.value()), 1)
        self.changed.emit()
        self.npc_xy_live_changed.emit(str(npc.get("id", "")))

    def _on_npc_initial_state_changed(self, _i: int) -> None:
        if self._npc_initial_state.signalsBlocked():
            return
        self._sync_npc_initial_anim_state_to_dict()
        self.changed.emit()
        self._request_scene_npc_anim_refresh()

    def _on_npc_anim_file_changed(self, _id: str) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            self.changed.emit()
            return
        anim = self._npc_anim.current_id().strip()
        if anim:
            npc["animFile"] = anim
        elif "animFile" in npc:
            del npc["animFile"]
        self._fill_npc_initial_state_combo()
        self._sync_npc_initial_anim_state_to_dict()
        self.changed.emit()
        self._request_scene_npc_anim_refresh()
        self._update_npc_patrol_preview_enabled()

    def _npc_anim_json_path(self, anim_id: str) -> Path | None:
        aid = anim_id.strip()
        if not aid or self._model.project_path is None:
            return None
        if aid.startswith("/"):
            aid = aid[1:]
        return self._model.project_path / "public" / Path(aid).as_posix()

    def _anim_states_from_model(self, anim_id: str) -> dict:
        """仅使用工程已加载的 model.animations（与磁盘一致以打开工程时为准），编辑中不再读盘。"""
        p = self._npc_anim_json_path(anim_id.strip())
        if not p:
            return {}
        bid = _anim_bundle_key_from_manifest_url(anim_id.strip())
        mem = self._model.animations.get(bid)
        if not isinstance(mem, dict):
            return {}
        st = mem.get("states")
        return st if isinstance(st, dict) else {}

    def _fill_npc_initial_state_combo(self) -> None:
        self._npc_initial_state.blockSignals(True)
        self._npc_initial_state.clear()
        anim_id = self._npc_anim.current_id().strip()
        need_refresh = False
        if not anim_id:
            need_refresh = True
        else:
            p = self._npc_anim_json_path(anim_id)
            if not p or not p.is_file():
                need_refresh = True
            states = self._anim_states_from_model(anim_id)
            names = [str(k) for k in states.keys()]
            saved = ""
            if self._pending_npc:
                saved = str(
                    self._pending_npc.get("initialAnimState", "") or "").strip()
            if saved and saved not in names:
                names.insert(0, saved)
            for n in names:
                self._npc_initial_state.addItem(n)
            sel = 0
            if saved and saved in names:
                sel = names.index(saved)
            elif not saved and "idle" in names:
                sel = names.index("idle")
            if names:
                self._npc_initial_state.setCurrentIndex(sel)
        self._npc_initial_state.blockSignals(False)
        if need_refresh:
            self._request_scene_npc_anim_refresh()

    def _sync_npc_initial_anim_state_to_dict(self) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return
        anim = self._npc_anim.current_id().strip()
        if not anim:
            npc.pop("initialAnimState", None)
            return
        ist = self._npc_initial_state.currentText().strip()
        if ist and self._npc_initial_state.count() > 0:
            npc["initialAnimState"] = ist
        elif "initialAnimState" in npc:
            del npc["initialAnimState"]

    def load_npc_props(self, npc: dict) -> None:
        if (
            self._stack.currentWidget() == self._npc_panel
            and self._pending_npc is not None
        ):
            pid = str(self._pending_npc.get("id", "") or "")
            nid = str(npc.get("id", "") or "")
            if pid and nid and pid != nid:
                self.npc_patrol_preview_changed.emit(pid, False)
        self._current_data = npc
        self._pending_npc = npc
        self._stack.setCurrentWidget(self._npc_panel)
        self._npc_id.setText(npc.get("id", ""))
        self._npc_name.setText(npc.get("name", ""))
        self._npc_x.blockSignals(True)
        self._npc_y.blockSignals(True)
        try:
            self._npc_x.setValue(npc.get("x", 0))
            self._npc_y.setValue(npc.get("y", 0))
        finally:
            self._npc_x.blockSignals(False)
            self._npc_y.blockSignals(False)
        d_items = self._model.dialogue_asset_path_choices()
        cur_d = npc.get("dialogueFile", "") or ""
        if cur_d and all(x[0] != cur_d for x in d_items):
            d_items = [(cur_d, cur_d)] + d_items
        self._npc_dialogue.set_items(d_items)
        self._npc_dialogue.set_current(cur_d)
        self._npc_knot.setText(npc.get("dialogueKnot", ""))
        self._npc_range.blockSignals(True)
        self._npc_range.setValue(npc.get("interactionRange", 50))
        self._npc_range.blockSignals(False)
        a_items = self._model.anim_asset_path_choices()
        cur_a = npc.get("animFile", "") or ""
        if cur_a and all(x[0] != cur_a for x in a_items):
            a_items = [(cur_a, cur_a)] + a_items
        self._npc_anim.blockSignals(True)
        try:
            self._npc_anim.set_items(a_items)
            self._npc_anim.set_current(cur_a)
        finally:
            self._npc_anim.blockSignals(False)
        self._fill_npc_initial_state_combo()
        self._load_npc_patrol_ui(npc)
        self.npc_patrol_overlay_refresh_requested.emit()

    def _write_npc_widgets_to_dict(self, npc: dict) -> None:
        npc["id"] = self._npc_id.text().strip()
        npc["name"] = self._npc_name.text()
        npc["x"] = self._npc_x.value()
        npc["y"] = self._npc_y.value()
        dd = self._npc_dialogue.current_id().strip()
        if dd:
            npc["dialogueFile"] = dd
        elif "dialogueFile" in npc:
            del npc["dialogueFile"]
        knot = self._npc_knot.text().strip()
        if knot:
            npc["dialogueKnot"] = knot
        elif "dialogueKnot" in npc:
            del npc["dialogueKnot"]
        npc["interactionRange"] = self._npc_range.value()
        anim = self._npc_anim.current_id().strip()
        if anim:
            npc["animFile"] = anim
        elif "animFile" in npc:
            del npc["animFile"]
        ist = self._npc_initial_state.currentText().strip()
        if anim and ist and self._npc_initial_state.count() > 0:
            npc["initialAnimState"] = ist
        elif "initialAnimState" in npc:
            del npc["initialAnimState"]
        if self._npc_patrol_enable.isChecked():
            route = self._npc_patrol_route_from_table()
            if len(route) >= 2:
                pat_out: dict = {
                    "route": route,
                    "speed": int(self._npc_patrol_speed.value()),
                }
            else:
                pat_out = {
                    "route": self._default_patrol_route_for_npc(npc),
                    "speed": int(self._npc_patrol_speed.value()),
                }
            ma = self._npc_patrol_move_anim.text().strip()
            if ma:
                pat_out["moveAnimState"] = ma
            npc["patrol"] = pat_out
        elif "patrol" in npc:
            del npc["patrol"]
        self.changed.emit()

    def save_npc_props(self) -> dict | None:
        npc = self._current_data
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return None
        self._write_npc_widgets_to_dict(npc)
        return npc

    # ---- zone props -------------------------------------------------------

    def _build_zone_panel(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        form = QFormLayout()
        self._zn_id = QLineEdit()
        form.addRow("id", self._zn_id)
        lay.addLayout(form)

        poly_label = QLabel(
            "polygon 顶点（顺序为边界，首尾不重复）。画布：拖点 / 拖内部平移 / "
            "双击边中点附近插点 / Shift+单击顶点删点 / Del 删鼠标悬停顶点 / 右键顶点菜单也可删。")
        poly_label.setWordWrap(True)
        lay.addWidget(poly_label)

        self._zn_poly_table = QTableWidget(0, 3)
        self._zn_poly_table.setHorizontalHeaderLabels(["#", "x", "y"])
        self._zn_poly_table.horizontalHeader().setSectionResizeMode(
            0, QHeaderView.ResizeMode.ResizeToContents)
        self._zn_poly_table.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.Stretch)
        self._zn_poly_table.horizontalHeader().setSectionResizeMode(
            2, QHeaderView.ResizeMode.Stretch)
        self._zn_poly_table.setMinimumHeight(220)
        self._zn_poly_table.itemChanged.connect(self._on_zone_poly_cell_changed)
        lay.addWidget(self._zn_poly_table)

        btn_row = QHBoxLayout()
        self._zn_poly_add = QPushButton("添加顶点")
        self._zn_poly_add.clicked.connect(self._on_zone_poly_add_vertex)
        self._zn_poly_del = QPushButton("删除选中顶点")
        self._zn_poly_del.setToolTip(
            "按表格当前行删除；画布上请用 Shift+单击顶点，或鼠标移到顶点后按 Del。")
        self._zn_poly_del.clicked.connect(self._on_zone_poly_remove_vertex)
        self._zn_poly_quad = QPushButton("生成轴对齐四边形")
        self._zn_poly_quad.setToolTip("按当前顶点包围盒生成与世界轴对齐的矩形四点")
        self._zn_poly_quad.clicked.connect(self._on_zone_poly_axis_quad)
        btn_row.addWidget(self._zn_poly_add)
        btn_row.addWidget(self._zn_poly_del)
        btn_row.addWidget(self._zn_poly_quad)
        lay.addLayout(btn_row)

        self._zn_cond = ConditionEditor("Conditions")
        lay.addWidget(self._zn_cond)
        self._zn_enter = ActionEditor("onEnter")
        lay.addWidget(self._zn_enter)
        self._zn_stay = ActionEditor("onStay")
        lay.addWidget(self._zn_stay)
        self._zn_exit = ActionEditor("onExit")
        lay.addWidget(self._zn_exit)
        self._append_entity_delete_footer(lay)
        return w

    def _parse_float_cell(self, it: QTableWidgetItem | None, default: float = 0.0) -> float:
        if it is None:
            return default
        try:
            return float(it.text().strip())
        except ValueError:
            return default

    def _zone_polygon_from_table(self) -> list[dict[str, float]]:
        t = self._zn_poly_table
        out: list[dict[str, float]] = []
        for r in range(t.rowCount()):
            x = round(self._parse_float_cell(t.item(r, 1)), 1)
            y = round(self._parse_float_cell(t.item(r, 2)), 1)
            out.append({"x": x, "y": y})
        return out

    def _set_zone_poly_table(self, polygon: list) -> None:
        self._zn_poly_updating = True
        try:
            t = self._zn_poly_table
            t.blockSignals(True)
            t.setRowCount(0)
            if not isinstance(polygon, list):
                polygon = []
            for p in polygon:
                if not isinstance(p, dict):
                    continue
                r = t.rowCount()
                t.insertRow(r)
                ix = QTableWidgetItem(str(r + 1))
                ix.setFlags(ix.flags() & ~Qt.ItemFlag.ItemIsEditable)
                t.setItem(r, 0, ix)
                x = QTableWidgetItem(str(round(float(p.get("x", 0)), 1)))
                t.setItem(r, 1, x)
                y = QTableWidgetItem(str(round(float(p.get("y", 0)), 1)))
                t.setItem(r, 2, y)
            t.blockSignals(False)
            for r in range(t.rowCount()):
                it = t.item(r, 0)
                if it:
                    it.setText(str(r + 1))
        finally:
            self._zn_poly_updating = False

    def _emit_zone_polygon_from_table_if_valid(self) -> None:
        if self._zn_poly_updating:
            return
        if self._stack.currentWidget() != self._zone_panel:
            return
        eid = self._zn_id.text().strip()
        if not eid:
            return
        poly = self._zone_polygon_from_table()
        if len(poly) < 3:
            return
        self.zone_polygon_changed.emit(eid, poly)

    def _on_zone_poly_cell_changed(self, item: QTableWidgetItem) -> None:
        if self._zn_poly_updating:
            return
        if item.column() == 0:
            return
        self._emit_zone_polygon_from_table_if_valid()

    def _on_zone_poly_add_vertex(self) -> None:
        if self._stack.currentWidget() != self._zone_panel:
            return
        t = self._zn_poly_table
        poly = self._zone_polygon_from_table()
        row = t.currentRow()
        if row < 0 and t.rowCount() > 0:
            row = t.rowCount() - 1
        if len(poly) == 0:
            nx, ny = 0.0, 0.0
            ins_at = 0
        elif len(poly) < 2:
            nx = poly[0]["x"] + 10.0
            ny = poly[0]["y"]
            ins_at = 1
        else:
            i = max(0, min(row, len(poly) - 1))
            j = (i + 1) % len(poly)
            nx = (poly[i]["x"] + poly[j]["x"]) * 0.5
            ny = (poly[i]["y"] + poly[j]["y"]) * 0.5
            ins_at = i + 1
        poly.insert(ins_at, {"x": round(nx, 1), "y": round(ny, 1)})
        self._set_zone_poly_table(poly)
        self._emit_zone_polygon_from_table_if_valid()

    def _on_zone_poly_remove_vertex(self) -> None:
        if self._stack.currentWidget() != self._zone_panel:
            return
        t = self._zn_poly_table
        row = t.currentRow()
        if row < 0 or t.rowCount() <= 3:
            return
        poly = self._zone_polygon_from_table()
        if row < len(poly):
            del poly[row]
        self._set_zone_poly_table(poly)
        self._emit_zone_polygon_from_table_if_valid()

    def _on_zone_poly_axis_quad(self) -> None:
        if self._stack.currentWidget() != self._zone_panel:
            return
        poly = self._zone_polygon_from_table()
        if len(poly) < 1:
            poly = [{"x": 0, "y": 0}, {"x": 100, "y": 0}, {"x": 100, "y": 80}, {"x": 0, "y": 80}]
            self._set_zone_poly_table(poly)
            self._emit_zone_polygon_from_table_if_valid()
            return
        xs = [p["x"] for p in poly]
        ys = [p["y"] for p in poly]
        x0, x1 = min(xs), max(xs)
        y0, y1 = min(ys), max(ys)
        if x1 - x0 < 1:
            x1 = x0 + 100
        if y1 - y0 < 1:
            y1 = y0 + 80
        quad = [
            {"x": round(x0, 1), "y": round(y0, 1)},
            {"x": round(x1, 1), "y": round(y0, 1)},
            {"x": round(x1, 1), "y": round(y1, 1)},
            {"x": round(x0, 1), "y": round(y1, 1)},
        ]
        self._set_zone_poly_table(quad)
        self._emit_zone_polygon_from_table_if_valid()

    def refresh_zone_polygon_table(self, eid: str, polygon: list) -> None:
        if self._stack.currentWidget() != self._zone_panel:
            return
        if self._zn_id.text().strip() != eid:
            return
        self._set_zone_poly_table(polygon)

    def load_zone_props(self, zone: dict) -> None:
        self._current_data = zone
        self._pending_zone = zone
        self._stack.setCurrentWidget(self._zone_panel)
        self._zn_id.setText(zone.get("id", ""))
        poly = zone.get("polygon")
        if isinstance(poly, list) and len(poly) >= 3:
            self._set_zone_poly_table(poly)
        else:
            pts = _zone_polygon_points_for_editor(zone)
            self._set_zone_poly_table([{"x": x, "y": y} for x, y in pts])
        self._zn_cond.set_flag_pattern_context(self._model, self._editing_scene_id or None)
        self._zn_cond.set_data(zone.get("conditions", []))
        self._zn_enter.set_project_context(self._model, self._editing_scene_id or None)
        self._zn_stay.set_project_context(self._model, self._editing_scene_id or None)
        self._zn_exit.set_project_context(self._model, self._editing_scene_id or None)
        self._zn_enter.set_data(zone.get("onEnter", []))
        self._zn_stay.set_data(zone.get("onStay", []))
        self._zn_exit.set_data(zone.get("onExit", []))

    def _write_zone_widgets_to_dict(self, zone: dict) -> None:
        zone["id"] = self._zn_id.text().strip()
        poly = self._zone_polygon_from_table()
        if len(poly) >= 3:
            zone["polygon"] = poly
        for k in ("x", "y", "width", "height"):
            zone.pop(k, None)
        c = self._zn_cond.to_list()
        if c:
            zone["conditions"] = c
        elif "conditions" in zone:
            del zone["conditions"]
        oe = self._zn_enter.to_list()
        if oe:
            zone["onEnter"] = oe
        elif "onEnter" in zone:
            del zone["onEnter"]
        oy = self._zn_stay.to_list()
        if oy:
            zone["onStay"] = oy
        elif "onStay" in zone:
            del zone["onStay"]
        ox = self._zn_exit.to_list()
        if ox:
            zone["onExit"] = ox
        elif "onExit" in zone:
            del zone["onExit"]
        if "ruleSlots" in zone:
            del zone["ruleSlots"]
        self.changed.emit()

    def save_zone_props(self) -> dict | None:
        zone = self._current_data
        if zone is None or self._stack.currentWidget() != self._zone_panel:
            return None
        self._write_zone_widgets_to_dict(zone)
        return zone

    # ---- spawn point props ------------------------------------------------

    def _build_spawn_panel(self) -> QWidget:
        w = QWidget()
        outer = QVBoxLayout(w)
        form_host = QWidget()
        form = QFormLayout(form_host)
        self._sp_key = QLineEdit()
        form.addRow("key", self._sp_key)
        self._sp_x = QDoubleSpinBox()
        self._sp_x.setRange(-99999, 99999)
        self._sp_x.setDecimals(1)
        form.addRow("x", self._sp_x)
        self._sp_y = QDoubleSpinBox()
        self._sp_y.setRange(-99999, 99999)
        self._sp_y.setDecimals(1)
        form.addRow("y", self._sp_y)
        self._sp_note = QLabel()
        self._sp_note.setWordWrap(True)
        form.addRow(self._sp_note)
        outer.addWidget(form_host)
        self._sp_delete_btn = self._append_entity_delete_footer(outer)
        return w

    def load_spawn_props(self, sc: dict, spawn_name: str) -> None:
        self._spawn_scene = sc
        self._spawn_flush_scene = sc
        self._spawn_name_original = spawn_name
        self._stack.setCurrentWidget(self._spawn_panel)
        if spawn_name == "default":
            pos = sc.get("spawnPoint")
            if not isinstance(pos, dict):
                pos = {"x": 0, "y": 0}
                sc["spawnPoint"] = pos
            self._sp_key.setReadOnly(True)
            self._sp_key.setText("default")
            self._sp_note.setText("默认出生点，写入 JSON 字段 spawnPoint。")
            self._sp_delete_btn.setEnabled(False)
            self._sp_delete_btn.setToolTip("默认出生点不可删除。")
        else:
            sps = sc.setdefault("spawnPoints", {})
            pos = sps.setdefault(spawn_name, {"x": 0, "y": 0})
            self._sp_key.setReadOnly(False)
            self._sp_key.setText(spawn_name)
            self._sp_delete_btn.setEnabled(True)
            self._sp_delete_btn.setToolTip(
                "从当前场景数据中移除此命名出生点（未 Save All 前仅内存变更）")
            self._sp_note.setText("命名出生点，写入 JSON 字段 spawnPoints。")
        self._sp_x.setValue(float(pos.get("x", 0)))
        self._sp_y.setValue(float(pos.get("y", 0)))

    def _write_spawn_widgets_to_dict(self, sc: dict) -> None:
        x = round(float(self._sp_x.value()), 1)
        y = round(float(self._sp_y.value()), 1)
        orig = self._spawn_name_original
        if orig == "default":
            sc["spawnPoint"] = {"x": x, "y": y}
        else:
            new_key = self._sp_key.text().strip() or orig
            sps = sc.setdefault("spawnPoints", {})
            if new_key != orig:
                sps.pop(orig, None)
            sps[new_key] = {"x": x, "y": y}
            self._spawn_name_original = new_key
        self.changed.emit()

    def save_spawn_props(self) -> None:
        if self._spawn_scene is None:
            return
        if self._stack.currentWidget() != self._spawn_panel:
            return
        self._write_spawn_widgets_to_dict(self._spawn_scene)


# ---------------------------------------------------------------------------
# Main scene editor widget
# ---------------------------------------------------------------------------

class SceneEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_scene_id: str | None = None
        self._last_canvas_world: tuple[float, float] | None = None
        self._scene_npc_runtimes: dict[str, _SceneNpcAnimRuntime] = {}
        self._scene_npc_anim_timer = QTimer(self)
        self._scene_npc_anim_timer.setTimerType(Qt.TimerType.PreciseTimer)
        self._scene_npc_anim_timer.setInterval(8)
        self._scene_npc_anim_timer.timeout.connect(self._tick_scene_npc_anims)
        self._scene_npc_anim_elapsed = QElapsedTimer()
        self._patrol_preview_ids: set[str] = set()
        self._patrol_preview_state: dict[str, dict] = {}
        # 巡逻折线重建若在鼠标事件栈内同步 removeItem，可能触发 Qt 崩溃；延后到下一轮事件循环
        self._patrol_overlay_refresh_timer = QTimer(self)
        self._patrol_overlay_refresh_timer.setSingleShot(True)
        self._patrol_overlay_refresh_timer.timeout.connect(
            self._apply_npc_patrol_overlay_refresh)

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # left: scene list + toolbar
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)

        tb = QToolBar()
        add_menu = QMenu(self)
        add_menu.addAction("Hotspot", self._add_hotspot)
        add_menu.addAction("NPC", self._add_npc)
        add_menu.addAction("Zone", self._add_zone)
        add_menu.addAction("Spawn Point", self._add_spawn)
        # QPushButton + setMenu() uses MenuButtonPopup: only the small arrow
        # opens the menu; users clicking the label see nothing. QToolButton +
        # InstantPopup opens the menu on any click on the control.
        add_btn = QToolButton()
        add_btn.setText("+ Add Entity")
        add_btn.setMenu(add_menu)
        add_btn.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        add_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextOnly)
        tb.addWidget(add_btn)
        save_btn = QPushButton("Apply")
        save_btn.clicked.connect(self._apply_props)
        tb.addWidget(save_btn)
        del_btn = QPushButton("Delete")
        del_btn.clicked.connect(self._delete_selected)
        tb.addWidget(del_btn)
        ll.addWidget(tb)

        self._chk_npc_ref = QCheckBox("场景视图：显示 NPC 比例参考框")
        self._chk_npc_ref.setChecked(True)
        self._chk_npc_ref.setToolTip(
            "在画布左上与右下绘制与角色动画 worldWidth×worldHeight 同尺寸的矩形，"
            "用于目测场景世界单位尺度（数据来自 animation/player_anim 等，不可点选拖动）。"
        )
        self._chk_npc_ref.toggled.connect(self._on_npc_ref_toggled)
        ll.addWidget(self._chk_npc_ref)

        self._scene_list = QListWidget()
        self._scene_list.currentItemChanged.connect(self._on_scene_selected)
        ll.addWidget(self._scene_list)

        # center: canvas
        self._canvas = SceneCanvas()
        self._canvas.item_selected.connect(self._on_item_selected)
        self._canvas.item_deselected.connect(self._on_item_deselected)
        self._canvas.item_moved.connect(self._on_item_moved)
        self._canvas.item_position_live.connect(self._on_item_position_live)
        self._canvas.item_zone_polygon_committed.connect(
            self._on_item_zone_polygon_committed)
        self._canvas.context_add_entity.connect(self._on_canvas_context_add_entity)

        # right: property panel
        self._props = ScenePropertyPanel(model)
        self._props.changed.connect(lambda: model.mark_dirty("scene", self._current_scene_id or ""))
        self._props.interaction_range_changed.connect(self._on_props_interaction_range_changed)
        self._props.zone_polygon_changed.connect(self._on_props_zone_polygon_changed)
        self._props.npc_scene_anim_refresh_requested.connect(
            self._on_npc_scene_anim_refresh_requested)
        self._props.npc_xy_live_changed.connect(self._on_npc_xy_live_changed)
        self._props.delete_current_entity_requested.connect(self._delete_selected)
        self._props.npc_patrol_overlay_refresh_requested.connect(
            self._refresh_npc_patrol_overlay)
        self._props.npc_patrol_preview_changed.connect(
            self._on_npc_patrol_preview_changed)
        self._canvas.item_npc_patrol_route_committed.connect(
            self._on_npc_patrol_route_committed)

        splitter.addWidget(left)
        splitter.addWidget(self._canvas)
        splitter.addWidget(self._props)
        splitter.setSizes([180, 800, 350])
        root.addWidget(splitter)

        del_sc = QShortcut(QKeySequence.StandardKey.Delete, self)
        del_sc.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        del_sc.activated.connect(self._on_delete_key_shortcut)
        bs_sc = QShortcut(QKeySequence(Qt.Key.Key_Backspace), self)
        bs_sc.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        bs_sc.activated.connect(self._on_delete_key_shortcut)

        self._refresh_scene_list()

    def _clear_scene_npc_anim_layers(self) -> None:
        self._scene_npc_anim_timer.stop()
        self._scene_npc_runtimes.clear()
        self._patrol_preview_ids.clear()
        self._patrol_preview_state.clear()

    def _refresh_npc_patrol_overlay(self) -> None:
        self._patrol_overlay_refresh_timer.start(0)

    def _apply_npc_patrol_overlay_refresh(self) -> None:
        for nid in list(self._canvas._patrol_overlays.keys()):
            self._canvas.remove_npc_patrol_overlay(nid)
        npc = self._props._pending_npc
        if self._props._stack.currentWidget() != self._props._npc_panel:
            return
        if npc is not None and self._props._npc_patrol_enable.isChecked():
            route = (npc.get("patrol") or {}).get("route")
            if isinstance(route, list) and len(route) >= 2:
                self._canvas.set_npc_patrol_overlay(
                    str(npc.get("id", "")), route)

    def _on_npc_patrol_route_committed(
        self, npc_id: str, route: object,
    ) -> None:
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return
        if not isinstance(route, list):
            return
        norm: list[dict[str, float]] = []
        for p in route:
            if isinstance(p, dict):
                norm.append({
                    "x": round(float(p.get("x", 0)), 1),
                    "y": round(float(p.get("y", 0)), 1),
                })
        if len(norm) < 2:
            return
        for n in sc.get("npcs", []):
            if isinstance(n, dict) and str(n.get("id", "")) == npc_id:
                pat = n.setdefault("patrol", {})
                pat["route"] = norm
                self._model.mark_dirty("scene", self._current_scene_id or "")
                self._props.refresh_npc_patrol_table(npc_id, norm)
                self._patrol_preview_state.pop(npc_id, None)
                return

    def _on_npc_patrol_preview_changed(self, npc_id: str, on: bool) -> None:
        nid = npc_id.strip()
        if not nid:
            return
        if on:
            self._patrol_preview_ids.add(nid)
            self._patrol_preview_state.pop(nid, None)
        else:
            self._patrol_preview_ids.discard(nid)
            self._patrol_preview_state.pop(nid, None)
        self._refresh_one_scene_npc_anim(nid)

    def _patrol_preview_advance(
        self, npc_id: str, npc: dict, dt: float,
    ) -> tuple[float, float]:
        patrol = npc.get("patrol") or {}
        route = patrol.get("route")
        if not isinstance(route, list) or len(route) < 2:
            return float(npc.get("x", 0)), float(npc.get("y", 0))
        speed = float(patrol.get("speed", 60) or 60)
        st = self._patrol_preview_state.setdefault(npc_id, {})
        if "px" not in st:
            st["px"] = float(npc.get("x", 0))
            st["py"] = float(npc.get("y", 0))
            st["ti"] = 0
            st["step"] = 1
        px = float(st["px"])
        py = float(st["py"])
        ti = int(st["ti"])
        step = int(st["step"])
        n = len(route)
        tgt = route[ti]
        tx = float(tgt["x"])
        ty = float(tgt["y"])
        dx, dy = tx - px, ty - py
        dist = math.hypot(dx, dy)
        move = speed * dt
        if dist <= 1e-5 or dist <= move:
            px, py = tx, ty
            ti += step
            if ti >= n:
                ti = max(0, n - 1)
                step = -1
            elif ti < 0:
                ti = 0
                step = 1
            st["ti"] = ti
            st["step"] = step
        else:
            px += dx / dist * move
            py += dy / dist * move
        st["px"] = px
        st["py"] = py
        return px, py

    def _public_asset_path(self, rel: str) -> Path | None:
        r = (rel or "").strip().lstrip("/").replace("\\", "/")
        if not r or self._model.project_path is None:
            return None
        return self._model.project_path / "public" / r

    def _resolve_anim_public_path(self, anim_id: str) -> Path | None:
        aid = anim_id.strip()
        if not aid:
            return None
        if aid.startswith("/"):
            aid = aid[1:]
        return self._public_asset_path(aid)

    def _try_add_scene_npc_anim(
        self,
        npc: dict,
        json_memo: dict[str, dict],
        atlas_memo: dict[str, QPixmap],
    ) -> None:
        npc_id = str(npc.get("id", "") or "")
        if not npc_id:
            return
        anim_id = str(npc.get("animFile", "") or "").strip()
        if not anim_id:
            return
        path = self._resolve_anim_public_path(anim_id)
        if not path or not path.is_file():
            return
        jkey = str(path.resolve())
        data = json_memo.get(jkey)
        if data is None:
            try:
                with open(path, encoding="utf-8") as f:
                    data = json.load(f)
            except (OSError, json.JSONDecodeError):
                return
            json_memo[jkey] = data
        pair = _resolved_anim_world_pair(
            data, self._model, anim_manifest_url=anim_id.strip())
        if not pair:
            return
        world_w, world_h = pair
        cols = max(1, int(data.get("cols", 1) or 1))
        rows = max(1, int(data.get("rows", 1) or 1))
        cell_w = int(data.get("cellWidth", 0) or 0) or None
        cell_h = int(data.get("cellHeight", 0) or 0) or None
        atlas_frames = data.get("atlasFrames")
        if not isinstance(atlas_frames, list):
            atlas_frames = None
        sheet = str(data.get("spritesheet", "") or "").strip()
        if not sheet:
            return
        ap = _spritesheet_public_path(self._model, sheet, anim_id.strip())
        if not ap or not ap.is_file():
            return
        akey = str(ap.resolve())
        atlas = atlas_memo.get(akey)
        if atlas is None or atlas.isNull():
            atlas = QPixmap(str(ap))
            if atlas.isNull():
                return
            atlas_memo[akey] = atlas
        states = data.get("states")
        if not isinstance(states, dict) or not states:
            return
        want = str(npc.get("initialAnimState", "") or "").strip()
        if want in states:
            state_name = want
        elif "idle" in states:
            state_name = "idle"
        else:
            state_name = next(iter(states.keys()))
        pat = npc.get("patrol")
        if isinstance(pat, dict) and npc_id in self._patrol_preview_ids:
            ma = str(pat.get("moveAnimState", "") or "").strip()
            if ma and ma in states:
                state_name = ma
        st = states.get(state_name)
        if not isinstance(st, dict):
            return
        frames = st.get("frames") or [0]
        if not isinstance(frames, list):
            frames = [0]
        frames_i: list[int] = []
        for x in frames:
            try:
                frames_i.append(int(x))
            except (TypeError, ValueError):
                continue
        if not frames_i:
            frames_i = [0]
        rate = float(st.get("frameRate", 8) or 8)
        loop = bool(st.get("loop", True))
        item = QGraphicsPixmapItem()
        item.setZValue(_NPC_SCENE_ANIM_PREVIEW_Z)
        item.setOpacity(0.9)
        item.setAcceptedMouseButtons(Qt.MouseButton.NoButton)
        item.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, False)
        item.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, False)
        self._canvas.graphics_scene().addItem(item)
        rt = _SceneNpcAnimRuntime(
            npc_id,
            item,
            atlas,
            cols,
            rows,
            world_w,
            world_h,
            frames_i,
            rate,
            loop,
            cell_w=cell_w,
            cell_h=cell_h,
            atlas_frames=atlas_frames,
        )
        nx = float(npc.get("x", 0))
        ny = float(npc.get("y", 0))
        rt.draw_at(nx, ny)
        self._scene_npc_runtimes[npc_id] = rt

    def _rebuild_scene_npc_anim_layers(self) -> None:
        self._clear_scene_npc_anim_layers()
        sc = self._model.scenes.get(self._current_scene_id or "")
        if not sc:
            return
        jmemo: dict[str, dict] = {}
        amemo: dict[str, QPixmap] = {}
        for npc in sc.get("npcs", []):
            if isinstance(npc, dict):
                self._try_add_scene_npc_anim(npc, jmemo, amemo)
        if self._scene_npc_runtimes:
            self._scene_npc_anim_elapsed.start()
            self._scene_npc_anim_timer.start()

    def _refresh_one_scene_npc_anim(self, npc_id: str) -> None:
        if not self._current_scene_id:
            return
        sc = self._model.scenes.get(self._current_scene_id)
        if not sc:
            return
        npc = None
        for n in sc.get("npcs", []):
            if isinstance(n, dict) and str(n.get("id", "")) == npc_id:
                npc = n
                break
        old = self._scene_npc_runtimes.pop(npc_id, None)
        if old is not None and old.item.scene() is not None:
            old.item.scene().removeItem(old.item)
        if npc is None:
            if not self._scene_npc_runtimes:
                self._scene_npc_anim_timer.stop()
            return
        jmemo: dict[str, dict] = {}
        amemo: dict[str, QPixmap] = {}
        self._try_add_scene_npc_anim(npc, jmemo, amemo)
        if self._scene_npc_runtimes and not self._scene_npc_anim_timer.isActive():
            self._scene_npc_anim_elapsed.start()
            self._scene_npc_anim_timer.start()

    def _tick_scene_npc_anims(self) -> None:
        sc = self._model.scenes.get(self._current_scene_id or "")
        if not sc:
            self._scene_npc_anim_timer.stop()
            return
        npc_by_id = {
            str(n.get("id", "")): n
            for n in sc.get("npcs", [])
            if isinstance(n, dict) and n.get("id")
        }
        dt_ms = self._scene_npc_anim_elapsed.restart()
        dt = max(1e-6, dt_ms / 1000.0)
        for rid, rt in list(self._scene_npc_runtimes.items()):
            npc = npc_by_id.get(rid)
            if not npc:
                continue
            if rid in self._patrol_preview_ids:
                px, py = self._patrol_preview_advance(rid, npc, dt)
                rt.tick(dt, px, py)
            else:
                x = float(npc.get("x", 0))
                y = float(npc.get("y", 0))
                rt.tick(dt, x, y)
        self._canvas.viewport().update()

    def _on_npc_scene_anim_refresh_requested(self, npc_id: str) -> None:
        if not npc_id.strip():
            self._rebuild_scene_npc_anim_layers()
        else:
            self._refresh_one_scene_npc_anim(npc_id.strip())

    def _on_npc_xy_live_changed(self, npc_id: str) -> None:
        self._patrol_preview_state.pop(npc_id, None)
        rt = self._scene_npc_runtimes.get(npc_id)
        if rt is None:
            return
        sc = self._model.scenes.get(self._current_scene_id or "")
        if not sc:
            return
        for n in sc.get("npcs", []):
            if isinstance(n, dict) and str(n.get("id", "")) == npc_id:
                if npc_id not in self._patrol_preview_ids:
                    rt.draw_at(float(n.get("x", 0)), float(n.get("y", 0)))
                    self._canvas.viewport().update()
                return

    def _refresh_scene_list(self) -> None:
        self._scene_list.clear()
        for sid in sorted(self._model.scenes.keys()):
            sc = self._model.scenes[sid]
            item = QListWidgetItem(f"{sid}  [{sc.get('name', '')}]")
            item.setData(Qt.ItemDataRole.UserRole, sid)
            self._scene_list.addItem(item)
        if self._scene_list.count() > 0 and self._scene_list.currentRow() < 0:
            self._scene_list.setCurrentRow(0)

    def _on_scene_selected(self, current: QListWidgetItem | None, _prev) -> None:
        if current is None:
            return
        sid = current.data(Qt.ItemDataRole.UserRole)
        self._load_scene(sid)

    def _load_scene(self, scene_id: str, *, reset_view: bool = True) -> None:
        self._current_scene_id = scene_id
        sc = self._model.scenes.get(scene_id)
        if sc is None:
            return
        self._clear_scene_npc_anim_layers()
        self._canvas.clear_scene()

        bgs = sc.get("backgrounds", [])
        img_path: Path | None = None
        if bgs:
            img_name = bgs[0].get("image", "background.png")
            img_path = self._model.scenes_path / scene_id / img_name

        world_w, world_h = _resolve_world_size(sc, img_path)
        self._canvas.setup_world(world_w, world_h)

        if img_path:
            self._canvas.load_background(img_path, world_w, world_h)

        for hs in sc.get("hotspots", []):
            self._canvas.add_hotspot(hs)
        for npc in sc.get("npcs", []):
            self._canvas.add_npc(npc)
        for zone in sc.get("zones", []):
            self._canvas.add_zone(zone)
        sp = sc.get("spawnPoint")
        if sp:
            self._canvas.add_spawn("default", sp)
        for name, pos in sc.get("spawnPoints", {}).items():
            self._canvas.add_spawn(name, pos)

        self._last_canvas_world = (world_w, world_h)
        self._canvas.set_npc_reference_visible(self._chk_npc_ref.isChecked())
        rw, rh = _npc_reference_world_size(self._model)
        self._canvas.rebuild_npc_reference(world_w, world_h, rw, rh)

        if reset_view:
            self._canvas.fit_all()
        self._props.load_scene_props(sc, clear_pending_edits=True)
        self._rebuild_scene_npc_anim_layers()

    def _on_npc_ref_toggled(self, checked: bool) -> None:
        self._canvas.set_npc_reference_visible(checked)
        if self._last_canvas_world is None:
            return
        ww, wh = self._last_canvas_world
        rw, rh = _npc_reference_world_size(self._model)
        self._canvas.rebuild_npc_reference(ww, wh, rw, rh)

    def _on_item_selected(self, kind: str, eid: str) -> None:
        if kind != "npc":
            self._patrol_preview_ids.clear()
            self._patrol_preview_state.clear()
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return
        if kind == "hotspot":
            for hs in sc.get("hotspots", []):
                if hs.get("id") == eid:
                    self._props.load_hotspot_props(hs)
                    return
        elif kind == "npc":
            for npc in sc.get("npcs", []):
                if npc.get("id") == eid:
                    self._props.load_npc_props(npc)
                    return
        elif kind == "zone":
            for zone in sc.get("zones", []):
                if zone.get("id") == eid:
                    if (
                        self._props._stack.currentWidget() == self._props._zone_panel
                        and self._props._pending_zone is zone
                    ):
                        return
                    self._props.load_zone_props(zone)
                    return
        elif kind == "spawn":
            self._props.load_spawn_props(sc, eid)

    def _on_item_deselected(self) -> None:
        if self._current_scene_id:
            sc = self._model.scenes.get(self._current_scene_id)
            if sc:
                self._props.load_scene_props(sc, clear_pending_edits=False)
        self._refresh_npc_patrol_overlay()

    def _on_props_interaction_range_changed(self, kind: str, eid: str, r: float) -> None:
        if eid:
            self._canvas.update_interaction_range(kind, eid, r)

    def _on_props_zone_polygon_changed(self, eid: str, polygon: object) -> None:
        poly_list = polygon if isinstance(polygon, list) else []
        if len(poly_list) < 3:
            return
        self._canvas.update_zone_polygon(eid, poly_list)
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return
        for zone in sc.get("zones", []):
            if zone.get("id") == eid:
                zone["polygon"] = poly_list
                for k in ("x", "y", "width", "height"):
                    zone.pop(k, None)
                break
        self._model.mark_dirty("scene", self._current_scene_id or "")

    def _on_item_zone_polygon_committed(
        self,
        kind: str,
        eid: str,
        polygon: object,
    ) -> None:
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return
        poly_list = polygon if isinstance(polygon, list) else []
        if len(poly_list) < 3:
            return
        for zone in sc.get("zones", []):
            if zone.get("id") == eid:
                zone["polygon"] = poly_list
                for k in ("x", "y", "width", "height"):
                    zone.pop(k, None)
                break
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._props.refresh_zone_polygon_table(eid, poly_list)
        self._canvas.item_selected.emit(kind, eid)

    def _on_item_position_live(
        self, kind: str, eid: str, x: float, y: float,
    ) -> None:
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return
        rx = round(x, 1)
        ry = round(y, 1)
        if kind == "hotspot":
            for hs in sc.get("hotspots", []):
                if hs.get("id") == eid:
                    hs["x"] = rx
                    hs["y"] = ry
                    return
        elif kind == "npc":
            for npc in sc.get("npcs", []):
                if npc.get("id") == eid:
                    npc["x"] = rx
                    npc["y"] = ry
                    self._patrol_preview_state.pop(eid, None)
                    rt = self._scene_npc_runtimes.get(eid)
                    if rt is not None:
                        rt.draw_at(float(rx), float(ry))
                        self._canvas.viewport().update()
                    return
        elif kind == "spawn":
            if eid == "default":
                sc["spawnPoint"] = {"x": rx, "y": ry}
            else:
                sps = sc.setdefault("spawnPoints", {})
                sps[eid] = {"x": rx, "y": ry}

    def _on_item_moved(self, kind: str, eid: str, x: float, y: float) -> None:
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return
        if kind == "hotspot":
            for hs in sc.get("hotspots", []):
                if hs.get("id") == eid:
                    hs["x"] = round(x, 1)
                    hs["y"] = round(y, 1)
                    break
        elif kind == "npc":
            for npc in sc.get("npcs", []):
                if npc.get("id") == eid:
                    npc["x"] = round(x, 1)
                    npc["y"] = round(y, 1)
                    self._patrol_preview_state.pop(eid, None)
                    rt = self._scene_npc_runtimes.get(eid)
                    if rt is not None:
                        rt.draw_at(float(npc["x"]), float(npc["y"]))
                        self._canvas.viewport().update()
                    break
        elif kind == "spawn":
            if eid == "default":
                sc["spawnPoint"] = {"x": round(x, 1), "y": round(y, 1)}
            else:
                sps = sc.setdefault("spawnPoints", {})
                sps[eid] = {"x": round(x, 1), "y": round(y, 1)}
        self._model.mark_dirty("scene", self._current_scene_id or "")

    def flush_to_model(self) -> None:
        """Sync property-panel widgets into model.scenes (for Save All without Apply)."""
        self._props.flush_pending_to_model()
        if self._current_scene_id:
            self._model.mark_dirty("scene", self._current_scene_id)

    def _apply_props(self) -> None:
        self._props.save_scene_props()
        self._props.save_hotspot_props()
        self._props.save_npc_props()
        self._props.save_zone_props()
        self._props.save_spawn_props()
        self._model.mark_dirty("scene", self._current_scene_id or "")
        if self._current_scene_id:
            self._load_scene(self._current_scene_id, reset_view=False)

    def _require_scene(self) -> dict | None:
        sid = self._current_scene_id
        if not sid:
            QMessageBox.information(
                self, "场景编辑器", "请先在左侧列表中选择一个场景。")
            return None
        sc = self._model.scenes.get(sid)
        if sc is None:
            QMessageBox.warning(self, "场景编辑器", "当前场景数据无效。")
            return None
        return sc

    def _on_canvas_context_add_entity(self, kind: str, wx: float, wy: float) -> None:
        if kind == "hotspot":
            self._add_hotspot_at(wx, wy)
        elif kind == "npc":
            self._add_npc_at(wx, wy)
        elif kind == "zone":
            self._add_zone_at(wx, wy)
        elif kind == "spawn":
            self._add_spawn_at(wx, wy)

    def _add_hotspot_at(self, wx: float, wy: float) -> None:
        sc = self._require_scene()
        if sc is None:
            return
        wx = round(float(wx), 1)
        wy = round(float(wy), 1)
        hs_list = sc.setdefault("hotspots", [])
        new_id = f"new_hotspot_{len(hs_list)}"
        hs_list.append({
            "id": new_id, "type": "inspect", "label": "", "x": wx, "y": wy,
            "interactionRange": 50, "data": {"text": ""},
        })
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id, reset_view=False)

    def _add_hotspot(self) -> None:
        self._add_hotspot_at(100, 100)

    def _add_npc_at(self, wx: float, wy: float) -> None:
        sc = self._require_scene()
        if sc is None:
            return
        wx = round(float(wx), 1)
        wy = round(float(wy), 1)
        npc_list = sc.setdefault("npcs", [])
        new_id = f"new_npc_{len(npc_list)}"
        npc_list.append({
            "id": new_id, "name": "New NPC", "x": wx, "y": wy,
            "dialogueFile": "", "interactionRange": 50,
        })
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id, reset_view=False)

    def _add_npc(self) -> None:
        self._add_npc_at(150, 150)

    def _add_zone_at(self, wx: float, wy: float) -> None:
        sc = self._require_scene()
        if sc is None:
            return
        wx = round(float(wx), 1)
        wy = round(float(wy), 1)
        z_list = sc.setdefault("zones", [])
        new_id = f"new_zone_{len(z_list)}"
        z_list.append({
            "id": new_id,
            "polygon": [
                {"x": wx, "y": wy},
                {"x": round(wx + 200, 1), "y": wy},
                {"x": round(wx + 200, 1), "y": round(wy + 100, 1)},
                {"x": wx, "y": round(wy + 100, 1)},
            ],
        })
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id, reset_view=False)

    def _add_zone(self) -> None:
        self._add_zone_at(50, 50)

    def _add_spawn_at(self, wx: float, wy: float) -> None:
        sc = self._require_scene()
        if sc is None:
            return
        wx = round(float(wx), 1)
        wy = round(float(wy), 1)
        sps = sc.setdefault("spawnPoints", {})
        n = 0
        while f"spawn_{n}" in sps:
            n += 1
        name = f"spawn_{n}"
        sps[name] = {"x": wx, "y": wy}
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id, reset_view=False)

    def _add_spawn(self) -> None:
        self._add_spawn_at(200, 200)

    def _try_delete_zone_hovered_vertex(self) -> bool:
        """若当前选中 Zone 多边形且鼠标正悬停某一顶点，则删该顶点。"""
        for it in self._canvas._gfx.selectedItems():
            if isinstance(it, _EditableZonePolygon) and it.try_delete_hovered_vertex():
                return True
        return False

    def _on_delete_key_shortcut(self) -> None:
        if self._try_delete_zone_hovered_vertex():
            return
        self._delete_selected()

    def _delete_selected(self) -> None:
        sc = self._require_scene()
        if sc is None:
            return
        kind: str | None = None
        eid: str | None = None
        for it in self._canvas._gfx.selectedItems():
            if hasattr(it, "entity_kind") and hasattr(it, "entity_id"):
                ek = str(getattr(it, "entity_kind", "") or "")
                ei = getattr(it, "entity_id", None)
                if ek and ei is not None and str(ei) != "":
                    kind, eid = ek, str(ei)
                    break
        if kind is None or eid is None:
            w = self._props._stack.currentWidget()
            if w == self._props._npc_panel and self._props._pending_npc:
                kind, eid = "npc", str(
                    self._props._pending_npc.get("id", "") or "")
            elif w == self._props._hotspot_panel and self._props._pending_hotspot:
                kind, eid = "hotspot", str(
                    self._props._pending_hotspot.get("id", "") or "")
            elif w == self._props._zone_panel and self._props._pending_zone:
                kind, eid = "zone", str(
                    self._props._pending_zone.get("id", "") or "")
            elif w == self._props._spawn_panel and self._props._spawn_scene is not None:
                kind = "spawn"
                eid = str(self._props._spawn_name_original or "")
        if not kind or not eid:
            return
        if kind == "spawn" and eid == "default":
            QMessageBox.information(
                self, "场景编辑器", "默认出生点不可删除。")
            return
        if kind == "hotspot":
            sc["hotspots"] = [h for h in sc.get("hotspots", []) if h.get("id") != eid]
        elif kind == "npc":
            sc["npcs"] = [n for n in sc.get("npcs", []) if n.get("id") != eid]
        elif kind == "zone":
            sc["zones"] = [z for z in sc.get("zones", []) if z.get("id") != eid]
        elif kind == "spawn":
            sc.get("spawnPoints", {}).pop(eid, None)
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id, reset_view=False)

    def select_by_id(self, item_id: str, scene_id: str = "") -> None:
        if scene_id:
            for i in range(self._scene_list.count()):
                it = self._scene_list.item(i)
                if it and it.data(Qt.ItemDataRole.UserRole) == scene_id:
                    self._scene_list.setCurrentItem(it)
                    break
        if not item_id:
            return
        sc = self._model.scenes.get(self._current_scene_id or "")
        if not sc:
            return
        for hs in sc.get("hotspots", []):
            if hs.get("id") == item_id:
                self._props.load_hotspot_props(hs)
                return
        for zone in sc.get("zones", []):
            if zone.get("id") == item_id:
                self._props.load_zone_props(zone)
                return
