"""Scene editor with visual canvas for hotspots, NPCs, zones, spawn points.

All canvas coordinates are in **world units**.  Background images are loaded
as textures and scaled into a world-sized quad so pixel resolution is
completely decoupled from the coordinate system.
"""
from __future__ import annotations

import copy
import json
import math
import os
import re
import shutil
import time
from contextlib import contextmanager
from collections.abc import Iterator
from datetime import datetime
from pathlib import Path, PurePosixPath

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget, QListWidgetItem,
    QGraphicsView, QGraphicsScene, QGraphicsEllipseItem, QGraphicsRectItem,
    QGraphicsItem, QGraphicsObject,
    QGraphicsPixmapItem, QGroupBox, QFormLayout, QLineEdit, QDoubleSpinBox,
    QSpinBox, QComboBox, QCheckBox, QLabel, QPushButton, QScrollArea,
    QStackedWidget, QToolBar, QMenu, QGraphicsTextItem,
    QToolButton, QMessageBox, QInputDialog, QFileDialog, QDialog, QDialogButtonBox, QAbstractItemView,
    QSizePolicy, QGraphicsSceneMouseEvent, QGraphicsSceneHoverEvent,
    QGraphicsSceneContextMenuEvent,     QTableWidget, QTableWidgetItem, QHeaderView, QSlider,
    QRadioButton, QButtonGroup,
)
from PySide6.QtGui import (
    QPixmap, QImage, QPen, QBrush, QColor, QFont, QPainter, QWheelEvent,
    QImageReader,
    QMouseEvent, QContextMenuEvent, QAction, QTransform, QPolygonF,
    QShortcut, QKeySequence, QPainterPath,
)
from PySide6.QtCore import (
    Qt,
    QRect,
    QRectF,
    QPoint,
    QPointF,
    Signal,
    Slot,
    QTimer,
    QElapsedTimer,
)

from ..project_model import ProjectModel
from ..shared import confirm
from ..shared.list_affordances import make_list_search_box
from ..shared.rich_text_field import RichTextLineEdit
from ..shared.condition_editor import ConditionEditor
from ..shared.action_editor import ActionEditor, FilterableTypeCombo
from ..shared.audio_preview_selector import AudioIdPreviewSelector, AudioPreviewControls
from ..shared.id_ref_selector import IdRefSelector
from ..shared.image_path_picker import CutsceneImagePathRow, disk_path_for_runtime_url
from ..shared.move_entity_map_picker import WorldPointPickView, resolve_world_size_for_scene_json
from ..shared.collapsible_section import CollapsibleSection
from ..shared.form_layout import compact_form
from ..shared.hex_color_pick_row import HexColorPickRow
from ..shared.portrait_catalog import load_portrait_sets
from ..shared.project_paths import ProjectPaths
from ..shared.fonts import MONO_FONT_FAMILY


def _assert_path_within(path: Path, base: Path) -> Path:
    """安全闸：确保 path 落在 base 目录内，否则抛错。

    任何文件增删/写入只允许发生在本场景自己的目录内；一旦计算出的目标越出
    base（指向其它目录），直接抛错而非擅自处理，杜绝误删/误改他处文件。
    """
    rp = path.resolve()
    rb = base.resolve()
    try:
        rp.relative_to(rb)
    except ValueError:
        raise RuntimeError(f"拒绝操作场景目录之外的文件：{rp}（限定目录 {rb}）")
    return rp


def _scene_background_disk_path(model: ProjectModel, scene_id: str, sc: dict) -> Path | None:
    """场景 JSON 背景项 → ``public/resources/runtime/scenes/<id>/background.png``。

    背景图文件名强约束：场景主背景**只能**叫 ``background.png``。名字不对直接拒绝解析、
    不加载（与运行时 AssetManager / 校验器一致），不再回退或容忍任意文件名。
    backgrounds 为空 = 无背景（合法，返回 None）。
    """
    bgs = sc.get("backgrounds", [])
    if not bgs:
        return None
    img_name = bgs[0].get("image", "")
    if img_name != "background.png":
        return None
    try:
        return model.paths.scene_runtime_asset(scene_id, img_name)
    except ValueError:
        return None

_HOTSPOT_COLORS = {
    "inspect": QColor(60, 140, 255, 160),
    "pickup": QColor(60, 200, 80, 160),
    "transition": QColor(255, 160, 40, 160),
    "npc": QColor(200, 100, 255, 160),
    "encounter": QColor(255, 60, 60, 160),
}
_NPC_COLOR = QColor(180, 80, 220, 180)
_ZONE_COLOR = QColor(255, 200, 0, 60)
_ZONE_COLOR_DEPTH_FLOOR = QColor(80, 160, 255, 72)

_HOTSPOT_COLLISION_ZONE_COLOR = QColor(255, 120, 60, 95)
# NPC 行走阻挡碰撞多边形（与 Hotspot 分色，便于叠放区分）
_NPC_COLLISION_ZONE_COLOR = QColor(80, 200, 140, 95)
# 画布「禁止点选 Zone」时使用的填充与线色（与实体原色解耦，仅作冻结提示）
_ZONE_PICK_FROZEN_FILL = QColor(150, 150, 150, 88)
_ZONE_PICK_FROZEN_PEN = QColor(95, 95, 95, 220)


def _entity_cutscene_ids_from_data(ent: dict) -> list[str]:
    out: list[str] = []
    raw = ent.get("cutsceneIds")
    if isinstance(raw, list):
        for cid in raw:
            s = str(cid or "").strip()
            if s and s not in out:
                out.append(s)
    return out


def _entity_has_cutscene_binding(ent: dict) -> bool:
    return len(_entity_cutscene_ids_from_data(ent)) > 0


def _entity_is_cutscene_only(ent: dict) -> bool:
    return _entity_has_cutscene_binding(ent) and ent.get("cutsceneOnly", True) is not False


def _hotspot_collision_world_to_local(hs: dict, world_poly: list) -> list[dict[str, float]]:
    x0 = float(hs.get("x", 0))
    y0 = float(hs.get("y", 0))
    out: list[dict[str, float]] = []
    for p in world_poly:
        if isinstance(p, dict):
            out.append({
                "x": round(float(p.get("x", 0)) - x0, 1),
                "y": round(float(p.get("y", 0)) - y0, 1),
            })
    return out


def _hotspot_collision_local_to_world(hs: dict, local_poly: list) -> list[dict[str, float]]:
    x0 = float(hs.get("x", 0))
    y0 = float(hs.get("y", 0))
    out: list[dict[str, float]] = []
    for p in local_poly:
        if isinstance(p, dict):
            out.append({
                "x": round(float(p.get("x", 0)) + x0, 1),
                "y": round(float(p.get("y", 0)) + y0, 1),
            })
    return out


def _default_hotspot_collision_triangle_local() -> list[dict[str, float]]:
    return [
        {"x": -20.0, "y": -15.0},
        {"x": 20.0, "y": -15.0},
        {"x": 0.0, "y": 20.0},
    ]


def _hotspot_display_image_pixel_size(
    model: ProjectModel | None, path_url: str,
) -> tuple[int, int] | None:
    """返回图片像素宽高；路径无效时 None。"""
    p = disk_path_for_runtime_url(model, path_url) if model else None
    if p is None or not p.is_file():
        return None
    r = QImageReader(str(p))
    sz = r.size()
    if not sz.isValid() or sz.width() <= 0 or sz.height() <= 0:
        return None
    return sz.width(), sz.height()


def _display_world_height_from_width(ww: float, pw: int, ph: int) -> float:
    if ww <= 0 or pw <= 0 or ph <= 0:
        return 0.0
    return round(ww * (ph / pw), 1)


def _display_world_width_from_height(hh: float, pw: int, ph: int) -> float:
    if hh <= 0 or pw <= 0 or ph <= 0:
        return 0.0
    return round(hh * (pw / ph), 1)


def _hotspot_display_image_dict(
    path: str, ww: float, hh: float, facing: str, sprite_sort: str,
) -> dict:
    d: dict = {"image": path, "worldWidth": float(ww), "worldHeight": float(hh)}
    if (facing or "right").strip().lower() == "left":
        d["facing"] = "left"
    ss = (sprite_sort or "default").strip().lower()
    if ss in ("back", "front"):
        d["spriteSort"] = ss
    return d


def _migrate_scene_hotspot_collision_to_local(sc: dict) -> bool:
    """旧数据 collisionPolygon 为世界坐标：转为相对 (x,y) 的局部坐标并打标。"""
    changed = False
    for hs in sc.get("hotspots") or []:
        if not isinstance(hs, dict):
            continue
        poly = hs.get("collisionPolygon")
        if not isinstance(poly, list) or len(poly) < 3:
            continue
        if hs.get("collisionPolygonLocal") is True:
            continue
        lp = _hotspot_collision_world_to_local(hs, poly)
        if len(lp) < 3:
            continue
        hs["collisionPolygon"] = lp
        hs["collisionPolygonLocal"] = True
        changed = True
    return changed


def _zone_canvas_color(zone: dict) -> QColor:
    if zone.get("zoneKind") == "depth_floor":
        return _ZONE_COLOR_DEPTH_FLOOR
    return _ZONE_COLOR
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
_LIGHTCURVE_LINE_COLOR = QColor(255, 196, 64, 230)  # 暖金,区别于巡逻的青色
_LIGHTCURVE_OVERLAY_Z = 2.5


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
            pa, model, anim_manifest_url="/resources/runtime/animation/player_anim/anim.json")
        if r:
            return r
    for stem, data in sorted(model.animations.items()):
        if not isinstance(data, dict):
            continue
        r = _resolved_anim_world_pair(
            data, model, anim_manifest_url=f"/resources/runtime/animation/{stem}/anim.json")
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
    img_path = _scene_background_disk_path(model, scene_id, sc)
    if img_path is None or not img_path.exists():
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
        self._label.setFont(QFont(MONO_FONT_FAMILY, 8))
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
            # 虚线圈仅作示意，不参与命中；否则大圆会挡住下方的 hotspot 碰撞多边形，
            # 连顶点都难以点到（与常规 zone 不同，碰撞多边形主要靠拖顶点编辑）。
            self._range_outline.setAcceptedMouseButtons(Qt.MouseButton.NoButton)
        else:
            self._range_outline.setRect(-r, -r, r * 2, r * 2)
            self._range_outline.show()

    def set_color(self, color: QColor) -> None:
        c = QColor(color)
        self.setBrush(QBrush(c))
        pen_width = 0
        self.setPen(QPen(c.darker(140), pen_width))

    def set_label(self, text: str) -> None:
        self._label.setPlainText(text)

    def set_entity_id(self, eid: str) -> None:
        self.entity_id = str(eid)
        self._label.setPlainText(self.entity_id)

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
        self._label.setFont(QFont(MONO_FONT_FAMILY, 8))
        self._label.setFlag(
            QGraphicsTextItem.GraphicsItemFlag.ItemIgnoresTransformations, True)
        self._label.setFlag(
            QGraphicsTextItem.GraphicsItemFlag.ItemIsSelectable, False)
        self._label.setPos(2, 2)


class _EditableZonePolygon(QGraphicsObject):
    """Zone：世界坐标闭合多边形；拖顶点、拖内部平移、双击边插点、右键删顶点。
    hotspot_collision：仅顶点（及边插点等），不允许拖内部整体平移。"""

    HANDLE_WORLD_R = 14.0

    def __init__(
        self,
        canvas: "SceneCanvas",
        points: list[tuple[float, float]],
        color: QColor,
        entity_id: str,
        poly_kind: str = "zone",
    ):
        super().__init__()
        self._canvas = canvas
        self.entity_id = entity_id
        if poly_kind == "zone":
            self.entity_kind = "zone"
        elif poly_kind == "npc_collision":
            self.entity_kind = "npc_collision"
        else:
            self.entity_kind = "hotspot_collision"
        self._poly_kind = poly_kind
        self._color = color
        self._points: list[list[float]] = [[float(x), float(y)] for x, y in points]
        self.setFlags(
            self.GraphicsItemFlag.ItemIsSelectable
            | self.GraphicsItemFlag.ItemSendsGeometryChanges
        )
        self.setAcceptHoverEvents(True)
        self.setAcceptedMouseButtons(Qt.MouseButton.LeftButton)
        self._base_color = QColor(color)
        self._pick_frozen = False
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

    def set_zone_pick_frozen(self, frozen: bool) -> None:
        """场景编辑：禁止用鼠标点选/拖动多边形时，灰色显示并忽略画布交互（属性面板仍可用）。"""
        if self._pick_frozen == frozen:
            return
        self._pick_frozen = frozen
        if frozen:
            self._drag_vertex = None
            self._drag_body = False
            self._last_scene = None
            self._hover_vertex = None
            a = self._base_color.alpha()
            self._color = QColor(
                _ZONE_PICK_FROZEN_FILL.red(),
                _ZONE_PICK_FROZEN_FILL.green(),
                _ZONE_PICK_FROZEN_FILL.blue(),
                min(255, max(20, a)),
            )
            self.setFlag(
                self.GraphicsItemFlag.ItemIsSelectable, False,
            )
            self.setAcceptHoverEvents(False)
            self.setAcceptedMouseButtons(Qt.MouseButton.NoButton)
        else:
            self._color = QColor(self._base_color)
            self.setFlag(
                self.GraphicsItemFlag.ItemIsSelectable, True,
            )
            self.setAcceptHoverEvents(True)
            self.setAcceptedMouseButtons(Qt.MouseButton.LeftButton)
        self.update()

    def set_color(self, color: QColor) -> None:
        """更新多边形填充/描边基准色（未冻结时立即生效；冻结时保持灰色罩层语义）。"""
        self._base_color = QColor(color)
        if self._pick_frozen:
            a = self._base_color.alpha()
            self._color = QColor(
                _ZONE_PICK_FROZEN_FILL.red(),
                _ZONE_PICK_FROZEN_FILL.green(),
                _ZONE_PICK_FROZEN_FILL.blue(),
                min(255, max(20, a)),
            )
        else:
            self._color = QColor(self._base_color)
        self.update()

    def set_entity_id(self, eid: str) -> None:
        self.entity_id = str(eid)
        self.update()

    def _emit_polygon_committed(self) -> None:
        poly = self.points_to_model()
        if self._poly_kind == "zone":
            self._canvas._emit_zone_polygon_committed(self.entity_id, poly)
        elif self._poly_kind == "npc_collision":
            self._canvas._emit_npc_collision_polygon_committed(self.entity_id, poly)
        else:
            self._canvas._emit_hotspot_collision_polygon_committed(self.entity_id, poly)

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
        if self._pick_frozen:
            painter.setPen(QPen(_ZONE_PICK_FROZEN_PEN, 0, Qt.PenStyle.DashLine))
        else:
            painter.setPen(QPen(self._color.darker(180), 0, Qt.PenStyle.DashLine))
        painter.setBrush(QBrush(self._color))
        painter.drawPolygon(pf)
        hrad = self.HANDLE_WORLD_R * 0.38
        for i, (px, py) in enumerate(self._points):
            if self._pick_frozen:
                c = QColor(170, 170, 180)
            else:
                c = QColor(255, 230, 100)
            if not self._pick_frozen and (
                self._hover_vertex == i or self._drag_vertex == i
            ):
                c = QColor(255, 200, 60)
            painter.setBrush(QBrush(c))
            painter.setPen(QPen(QColor(100, 70, 0), 0))
            painter.drawEllipse(QPointF(px, py), hrad, hrad)
        if self._points:
            xs = [p[0] for p in self._points]
            ys = [p[1] for p in self._points]
            painter.setPen(QPen(Qt.GlobalColor.white))
            painter.setFont(QFont(MONO_FONT_FAMILY, 8))
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
        if self._pick_frozen:
            return False
        vi = self._hover_vertex
        if vi is None or len(self._points) <= 3:
            return False
        del self._points[vi]
        self._hover_vertex = None
        self.prepareGeometryChange()
        self.update()
        self._emit_polygon_committed()
        return True

    def mousePressEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if self._pick_frozen:
            event.ignore()
            return
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
                self._emit_polygon_committed()
            event.accept()
            return
        if vi is not None:
            self._drag_vertex = vi
            self._drag_body = False
            self._last_scene = QPointF(sp)
            self._select_exclusively()
            event.accept()
            return
        # hotspot / npc 附带 collisionPolygon：仅允许拖顶点，禁止像独立 zone 那样拖内部整体平移。
        if self._poly_kind not in ("hotspot_collision", "npc_collision") and self._point_in_polygon(
            sp.x(), sp.y()
        ):
            self._drag_vertex = None
            self._drag_body = True
            self._last_scene = QPointF(sp)
            self._select_exclusively()
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if self._pick_frozen:
            event.ignore()
            return
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
        if self._pick_frozen:
            event.ignore()
            return
        if event.button() == Qt.MouseButton.LeftButton:
            if self._drag_vertex is not None or self._drag_body:
                self._drag_vertex = None
                self._drag_body = False
                self._last_scene = None
                self._emit_polygon_committed()
                event.accept()
                return
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if self._pick_frozen:
            event.ignore()
            return
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
            self._emit_polygon_committed()
        event.accept()

    def contextMenuEvent(self, event: QGraphicsSceneContextMenuEvent) -> None:
        if self._pick_frozen:
            event.ignore()
            return
        vi = self._vertex_at_scene(event.scenePos())
        if vi is not None and len(self._points) > 3:
            menu = QMenu()
            act = menu.addAction("删除此顶点")
            chosen = menu.exec(event.screenPos())
            if chosen == act:
                del self._points[vi]
                self.prepareGeometryChange()
                self.update()
                self._emit_polygon_committed()
            event.accept()
            return
        super().contextMenuEvent(event)

    def hoverMoveEvent(self, event: QGraphicsSceneHoverEvent) -> None:
        if self._pick_frozen:
            event.ignore()
            return
        self._hover_vertex = self._vertex_at_scene(event.scenePos())
        self.update()
        super().hoverMoveEvent(event)

    def hoverLeaveEvent(self, event: QGraphicsSceneHoverEvent) -> None:
        if self._pick_frozen:
            event.ignore()
            return
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
            painter.setFont(QFont(MONO_FONT_FAMILY, 8))
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


class _LightCurvePolyline(QGraphicsObject):
    """光环境曲线开放折线(画布直编):拖顶点 / 双击边插点 / 右键删点。

    与巡逻折线同构,但每个顶点**携带 env**(光照关键帧):插点时复制邻点 env,
    commit 时把含 env 的完整点列回传,使画布编辑不丢关键帧。
    """

    HANDLE_WORLD_R = 14.0

    def __init__(self, canvas: "SceneCanvas", points: list[dict]):
        super().__init__()
        self._canvas = canvas
        self._points: list[dict] = [
            {"x": float(p.get("x", 0)), "y": float(p.get("y", 0)),
             "env": copy.deepcopy(p.get("env")) if isinstance(p.get("env"), dict) else {}}
            for p in points
        ]
        self.setFlags(
            self.GraphicsItemFlag.ItemIsSelectable
            | self.GraphicsItemFlag.ItemSendsGeometryChanges
        )
        self.setAcceptHoverEvents(True)
        self.setZValue(_LIGHTCURVE_OVERLAY_Z)
        self._drag_vertex: int | None = None
        self._last_scene: QPointF | None = None
        self._hover_vertex: int | None = None
        self._selected: int = -1
        self._ref_width: float = 150.0  # 代表性角色世界宽度,用于接触阴影椭圆尺寸预览

    def set_ref_width(self, w: float) -> None:
        if w and w > 0 and abs(w - self._ref_width) > 1e-6:
            self._ref_width = float(w)
            self.prepareGeometryChange()  # 接触椭圆尺寸/包围盒随之变
            self.update()

    def set_selected(self, i: int) -> None:
        if i != self._selected:
            self._selected = i
            self.prepareGeometryChange()  # 选中点 gizmo 更大,包围盒可能变
            self.update()

    @staticmethod
    def _qcol(c: object, default: tuple = (255, 255, 255)) -> QColor:
        if isinstance(c, (list, tuple)) and len(c) >= 3:
            def f(v: object) -> int:
                try:
                    return max(0, min(255, int(round(max(0.0, min(1.0, float(v))) * 255))))
                except (TypeError, ValueError):
                    return 255
            return QColor(f(c[0]), f(c[1]), f(c[2]))
        return QColor(*default)

    def set_points_from_model(self, points: list) -> None:
        self._points = []
        for p in points:
            if isinstance(p, dict):
                self._points.append({
                    "x": round(float(p.get("x", 0)), 2),
                    "y": round(float(p.get("y", 0)), 2),
                    "env": copy.deepcopy(p.get("env")) if isinstance(p.get("env"), dict) else {},
                })
        self.prepareGeometryChange()
        self.update()

    def points_to_model(self) -> list[dict]:
        return [
            {"x": round(p["x"], 2), "y": round(p["y"], 2), "env": copy.deepcopy(p["env"])}
            for p in self._points
        ]

    def boundingRect(self) -> QRectF:
        if len(self._points) < 1:
            return QRectF()
        xs = [p["x"] for p in self._points]
        ys = [p["y"] for p in self._points]
        m = self.HANDLE_WORLD_R * 7.5  # 方向箭头/影迹的最大伸出
        for p in self._points:                                  # 还要容纳接触阴影椭圆(随 contactSize)
            e = p.get("env") if isinstance(p.get("env"), dict) else {}
            shd = e.get("shadow") if isinstance(e.get("shadow"), dict) else {}
            cs = float(shd.get("contactSize", 1.0) or 1.0)
            m = max(m, self._ref_width * 0.65 * cs)
        m += 4
        return QRectF(
            min(xs) - m, min(ys) - m,
            max(xs) - min(xs) + 2 * m, max(ys) - min(ys) + 2 * m,
        )

    def shape(self) -> QPainterPath:
        path = QPainterPath()
        r = self.HANDLE_WORLD_R
        for p in self._points:
            path.addEllipse(QPointF(p["x"], p["y"]), r, r)
        return path

    def paint(self, painter: QPainter, option, widget=None) -> None:
        del option, widget
        painter.save()
        n = len(self._points)
        if n >= 2:
            painter.setPen(QPen(_LIGHTCURVE_LINE_COLOR.darker(110), 0, Qt.PenStyle.SolidLine))
            painter.setBrush(QBrush(Qt.GlobalColor.transparent))
            for i in range(n - 1):
                a, b = self._points[i], self._points[i + 1]
                painter.drawLine(QPointF(a["x"], a["y"]), QPointF(b["x"], b["y"]))
        for i, p in enumerate(self._points):
            self._paint_light_gizmo(painter, i, p, selected=(i == self._selected))
        painter.restore()

    def _paint_light_gizmo(self, painter: QPainter, i: int, p: dict, *, selected: bool) -> None:
        """在控制点处画该关键帧光照的可视化:主光方向箭头+颜色、环境光环、影迹(方向/长度/暗度)。"""
        e = p.get("env") if isinstance(p.get("env"), dict) else {}
        key = e.get("key", {}) if isinstance(e.get("key"), dict) else {}
        sh = e.get("shadow", {}) if isinstance(e.get("shadow"), dict) else {}
        amb = e.get("ambient", {}) if isinstance(e.get("ambient"), dict) else {}
        az = float(key.get("azimuthDeg", 125) or 125)
        el = max(8.0, min(85.0, float(key.get("elevationDeg", 55) or 55)))
        inten = float(key.get("intensity", 1.0) or 1.0)
        kcol = self._qcol(key.get("color"), (255, 247, 235))
        acol = self._qcol(amb.get("color"), (140, 153, 184))
        dark = max(0.0, min(1.0, float(sh.get("darkness", 0.4) or 0.4)))
        a = math.radians(az)
        # 光来向。与运行时一致:azimuth 在「世界 y 向下」帧度量(影迹 = 光来向反向),
        # 即 EntityShadow 的 offX/offY=cos/sin(az+180)。故此处 sin 不取负,否则会与运行时上下镜像(看着像差 90°)。
        cx, cy = math.cos(a), math.sin(a)
        cot = math.cos(math.radians(el)) / max(math.sin(math.radians(el)), 1e-3)
        lenf = max(0.3, min(1.6, cot))                # 与 resolveLightEnv 同的影长系数
        R = self.HANDLE_WORLD_R
        scale = 1.35 if selected else 0.85
        px, py = p["x"], p["y"]
        # 影迹:从点沿光的反方向,长度=影长系数,暗度=alpha
        sxL = R * (2.4 + 2.2 * lenf) * scale
        spen = QPen(QColor(8, 8, 14, int(70 + 150 * dark)), R * (0.55 if selected else 0.34))
        spen.setCapStyle(Qt.PenCapStyle.RoundCap)
        painter.setPen(spen)
        painter.setBrush(QBrush(Qt.GlobalColor.transparent))
        painter.drawLine(QPointF(px, py), QPointF(px - cx * sxL, py - cy * sxL))
        # 接触阴影范围:脚下椭圆,半轴 = 角色宽×(0.65,0.30)×contactSize,暗度=contact(与 EntityShadow 同公式)
        cs = float(sh.get("contactSize", 1.0) or 1.0)
        con = max(0.0, min(1.0, float(sh.get("contact", 0.45) or 0.45)))
        if cs > 0 and con > 0:
            rx = self._ref_width * 0.65 * cs
            ry = self._ref_width * 0.30 * cs
            fill_a = int((45 + 150 * con) if selected else (18 + 70 * con))
            painter.setBrush(QBrush(QColor(0, 0, 0, fill_a)))
            painter.setPen(QPen(QColor(20, 24, 32, 200), R * 0.12, Qt.PenStyle.DashLine))
            painter.drawEllipse(QPointF(px, py), rx, ry)
        # 主光箭头:从光来向指向控制点,颜色=主光色,强度→不透明度
        arrowL = R * (2.6 + 1.4 * lenf) * scale
        kc = QColor(kcol)
        kc.setAlpha(int(max(70, min(255, 110 + 80 * min(inten, 2.0)))))
        apen = QPen(kc, R * (0.42 if selected else 0.26))
        apen.setCapStyle(Qt.PenCapStyle.RoundCap)
        painter.setPen(apen)
        tailx, taily = px + cx * arrowL, py + cy * arrowL
        painter.drawLine(QPointF(tailx, taily), QPointF(px, py))
        ah = R * 0.7 * scale
        # 箭头头部(指向 px,py)
        head_a1 = math.atan2(py - taily, px - tailx)
        for off in (2.6, -2.6):
            hx = px - math.cos(head_a1 + off) * ah
            hy = py - math.sin(head_a1 + off) * ah
            painter.drawLine(QPointF(px, py), QPointF(hx, hy))
        # 主光色圆盘(半径随强度)+ 环境光环
        disc = R * (0.42 + 0.16 * min(inten, 2.0)) * (1.25 if selected else 1.0)
        painter.setPen(QPen(QColor(255, 255, 255, 230) if selected else QColor(120, 80, 0), 0))
        painter.setBrush(QBrush(kcol))
        painter.drawEllipse(QPointF(px, py), disc, disc)
        ring = QPen(acol, R * 0.2)
        painter.setPen(ring)
        painter.setBrush(QBrush(Qt.GlobalColor.transparent))
        rr = disc + R * 0.4
        painter.drawEllipse(QPointF(px, py), rr, rr)
        # 拖拽/悬停高亮外圈
        if self._hover_vertex == i or self._drag_vertex == i:
            painter.setPen(QPen(QColor(255, 168, 48), R * 0.22))
            painter.setBrush(QBrush(Qt.GlobalColor.transparent))
            painter.drawEllipse(QPointF(px, py), rr + R * 0.3, rr + R * 0.3)
        # 编号 + (选中时)读数
        painter.setPen(QPen(Qt.GlobalColor.white))
        painter.setFont(QFont(MONO_FONT_FAMILY, 9 if selected else 7))
        painter.drawText(QPointF(px + rr + 3, py + 4), str(i))
        if selected:
            painter.setFont(QFont(MONO_FONT_FAMILY, 7))
            painter.setPen(QPen(QColor(255, 230, 170)))
            painter.drawText(
                QPointF(px + rr + 3, py + 16),
                f"az{az:.0f} el{el:.0f} I{inten:.2f} dk{dark:.2f}",
            )

    def _vertex_at_scene(self, scene_pos: QPointF) -> int | None:
        x, y = scene_pos.x(), scene_pos.y()
        r2 = self.HANDLE_WORLD_R ** 2
        for i, p in enumerate(self._points):
            dx, dy = p["x"] - x, p["y"] - y
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
            self._points[self._drag_vertex]["x"] += dx
            self._points[self._drag_vertex]["y"] += dy
            self._last_scene = QPointF(sp)
            self.prepareGeometryChange()
            self.update()
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if event.button() == Qt.MouseButton.LeftButton and self._drag_vertex is not None:
            self._drag_vertex = None
            self._last_scene = None
            self._canvas._emit_lightcurve_committed(self.points_to_model())
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
        best_i, best_d2 = -1, 1e18
        for i in range(max(0, n - 1)):
            a, b = self._points[i], self._points[i + 1]
            abx, aby = b["x"] - a["x"], b["y"] - a["y"]
            denom = abx * abx + aby * aby + 1e-12
            t = max(0, min(1, ((x - a["x"]) * abx + (y - a["y"]) * aby) / denom))
            px, py = a["x"] + t * abx, a["y"] + t * aby
            d2 = (x - px) ** 2 + (y - py) ** 2
            if d2 < best_d2:
                best_d2, best_i = d2, i
        thr = (self.HANDLE_WORLD_R * 2.2) ** 2
        if best_i >= 0 and best_d2 < thr:
            a, b = self._points[best_i], self._points[best_i + 1]
            mx, my = (a["x"] + b["x"]) * 0.5, (a["y"] + b["y"]) * 0.5
            self._points.insert(best_i + 1, {"x": mx, "y": my, "env": copy.deepcopy(a["env"])})
        elif n == 0 or (n >= 1 and best_i < 0):
            # 空曲线/单点时双击空白处直接追加一个点(env 复制末点或留空)
            env = copy.deepcopy(self._points[-1]["env"]) if self._points else {}
            self._points.append({"x": x, "y": y, "env": env})
        self.prepareGeometryChange()
        self.update()
        self._canvas._emit_lightcurve_committed(self.points_to_model())
        event.accept()

    def contextMenuEvent(self, event: QGraphicsSceneContextMenuEvent) -> None:
        vi = self._vertex_at_scene(event.scenePos())
        if vi is not None:
            menu = QMenu()
            act = menu.addAction("删除此控制点")
            chosen = menu.exec(event.screenPos())
            if chosen == act:
                del self._points[vi]
                self.prepareGeometryChange()
                self.update()
                self._canvas._emit_lightcurve_committed(self.points_to_model())
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
    # hotspot_id, polygon: list[{"x","y"}, ...]
    item_hotspot_collision_polygon_committed = Signal(str, object)
    # npc_id, polygon: list[{"x","y"}, ...]
    item_npc_collision_polygon_committed = Signal(str, object)
    # npc_id, route: list[{"x","y"}, ...]
    item_npc_patrol_route_committed = Signal(str, object)
    # 光环境曲线在画布上拖动/插点/删点后提交完整点列(含 env)
    item_lightcurve_committed = Signal(object)
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
        # 位面视图过滤（纯视图，不改数据）：None=显示全部；否则只显示归属含该位面的实体，
        # 缺省(无 planes)实体按该位面世界模型——shared 显示 / exclusive 隐藏，
        # 与运行时 SceneManager.entityInPlane 同口径。
        self._plane_filter: str | None = None
        self._plane_filter_exclusive: bool = False
        self._entity_planes: dict[str, list[str] | None] = {}
        self._patrol_overlays: dict[str, _NpcPatrolPolyline] = {}
        self._lightcurve_overlay: _LightCurvePolyline | None = None
        self._world_w: float = 800
        self._world_h: float = 600
        self._project_model: ProjectModel | None = None
        self._auto_fit_after_layout: bool = False
        self._fit_layout_token: int = 0
        # True 时：画布上禁止点选/拖动所有 Zone 与 Hotspot 碰撞多边形，以便点选其下方实体
        self._zone_pick_frozen: bool = False

    def set_project_model(self, model: ProjectModel | None) -> None:
        """用于将 /assets/... 解析为本地路径，在画布上绘制热区 displayImage。"""
        self._project_model = model

    def set_zone_pick_frozen(self, frozen: bool) -> None:
        """若 True：独立 Zone 与 Hotspot/NPC collisionPolygon 在画布上呈灰色，且不可鼠标选中/拖动（属性表仍可改）。"""
        self._zone_pick_frozen = bool(frozen)
        for it in self._entity_items.values():
            if isinstance(it, _EditableZonePolygon):
                it.set_zone_pick_frozen(self._zone_pick_frozen)

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
        self._entity_planes.clear()  # _plane_filter 保留：切场景后按同一位面视图重贴
        self._patrol_overlays.clear()
        self._lightcurve_overlay = None

    def _restore_pick_z_order(self) -> None:
        if not self._saved_item_z:
            return
        for it, z in self._saved_item_z:
            if it.scene() is self._gfx:
                it.setZValue(z)
        self._saved_item_z = None

    def _entity_stack_at(self, scene_pos: QPointF) -> list[QGraphicsItem]:
        """同一落点下、按 Z 从高到低排列的可编辑实体（hotspot/npc/zone/spawn）。

        zone_pick_frozen 为 True 时，不计入独立 Zone 与 Hotspot 碰撞多边形，以便叠点循环到下层。
        """
        seen: set[int] = set()
        out: list[QGraphicsItem] = []
        skip_z = self._zone_pick_frozen
        for it in self._gfx.items(scene_pos):
            if not hasattr(it, "entity_kind"):
                continue
            if skip_z:
                ek = getattr(it, "entity_kind", None)
                if ek in ("zone", "hotspot_collision", "npc_collision"):
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
        self.refresh_hotspot_visuals(hs)
        self._record_entity_planes(f"hotspot:{hs.get('id', '')}", hs.get("planes"))

    def refresh_hotspot_visuals(self, hs: dict) -> None:
        """同步 displayImage 预览（底边中点对齐 x,y）与 collisionPolygon。"""
        hid = str(hs.get("id", "")).strip()
        if not hid:
            return
        # 仅重建展示图；碰撞多边形在已存在时原地更新顶点，避免在鼠标事件栈内
        # removeItem 掉正在拖拽/悬停的多边形（与巡逻折线延后刷新同类 Qt 崩溃）。
        disp_key = f"hotspot_display:{hid}"
        di = hs.get("displayImage") if isinstance(hs.get("displayImage"), dict) else {}
        img = str(di.get("image", "") or "").strip()
        try:
            ww = float(di.get("worldWidth", 0) or 0)
            hh = float(di.get("worldHeight", 0) or 0)
        except (TypeError, ValueError):
            ww, hh = 0.0, 0.0
        cx = float(hs.get("x", 0))
        cy = float(hs.get("y", 0))
        facing = str(di.get("facing", "") or "right").strip().lower()
        # displayImage 来源签名：拖拽中只有 x/y 变、签名不变时，原地平移既有 pixmap，
        # 不再每帧 remove+重建+从磁盘重载 —— 消除"拖热区时贴图狂闪 + 卡顿"（perf-reload）。
        disp_sig = (img, ww, hh, facing) if (img and ww > 0 and hh > 0) else None
        existing_disp = self._entity_items.get(disp_key)
        if (
            disp_sig is not None
            and isinstance(existing_disp, QGraphicsPixmapItem)
            and getattr(existing_disp, "_disp_sig", None) == disp_sig
            and existing_disp.scene() is self._gfx
        ):
            existing_disp.setPos(cx - ww * 0.5, cy - hh)
        else:
            old_disp = self._entity_items.pop(disp_key, None)
            if old_disp is not None and old_disp.scene() is self._gfx:
                self._gfx.removeItem(old_disp)
            if disp_sig is not None:
                pm_data = QPixmap()
                disk_path = (
                    disk_path_for_runtime_url(self._project_model, img)
                    if self._project_model
                    else None
                )
                if disk_path and disk_path.is_file():
                    pm_data = QPixmap(str(disk_path))
                if not pm_data.isNull():
                    if facing == "left":
                        pm_data = QPixmap.fromImage(pm_data.toImage().mirrored(True, False))
                    sw = max(pm_data.width(), 1)
                    sh = max(pm_data.height(), 1)
                    pix_it = QGraphicsPixmapItem(pm_data)
                    pix_it.setPos(cx - ww * 0.5, cy - hh)
                    pix_it.setTransform(QTransform.fromScale(ww / sw, hh / sh))
                    pix_it.setZValue(-4)
                    pix_it._disp_sig = disp_sig
                    self._gfx.addItem(pix_it)
                    self._entity_items[disp_key] = pix_it
                else:
                    rect = QGraphicsRectItem(cx - ww * 0.5, cy - hh, ww, hh)
                    rect.setBrush(QBrush(QColor(200, 120, 255, 38)))
                    rect.setPen(QPen(QColor(140, 70, 190, 200), 0, Qt.PenStyle.DashLine))
                    rect.setZValue(-4)
                    self._gfx.addItem(rect)
                    self._entity_items[disp_key] = rect
        col_key = f"hotspot_collision:{hid}"
        poly = hs.get("collisionPolygon")
        pts: list[tuple[float, float]] = []
        if isinstance(poly, list) and len(poly) >= 3:
            if hs.get("collisionPolygonLocal") is True:
                for p in _hotspot_collision_local_to_world(hs, poly):
                    pts.append((float(p["x"]), float(p["y"])))
            else:
                for p in poly:
                    if isinstance(p, dict):
                        pts.append((float(p.get("x", 0)), float(p.get("y", 0))))
        if len(pts) >= 3:
            model_pts = [{"x": px, "y": py} for px, py in pts]
            existing = self._entity_items.get(col_key)
            if isinstance(existing, _EditableZonePolygon):
                existing.set_points_from_model(model_pts)
            else:
                old_col = self._entity_items.pop(col_key, None)
                if old_col is not None and old_col.scene() is self._gfx:
                    self._gfx.removeItem(old_col)
                poly_item = _EditableZonePolygon(
                    self, pts, _HOTSPOT_COLLISION_ZONE_COLOR, hid,
                    poly_kind="hotspot_collision",
                )
                poly_item.setZValue(-2)
                self._gfx.addItem(poly_item)
                self._entity_items[col_key] = poly_item
                if self._zone_pick_frozen:
                    poly_item.set_zone_pick_frozen(True)
        else:
            old_col = self._entity_items.pop(col_key, None)
            if old_col is not None and old_col.scene() is self._gfx:
                self._gfx.removeItem(old_col)

    def update_hotspot_collision_polygon(self, entity_id: str, polygon: list) -> None:
        key = f"hotspot_collision:{entity_id}"
        item = self._entity_items.get(key)
        if isinstance(item, _EditableZonePolygon):
            item.set_points_from_model(polygon)

    def refresh_npc_collision_visuals(self, npc: dict) -> None:
        """同步 NPC 的 collisionPolygon 画布多边形（世界坐标与 Hotspot 一致，锚点为 x,y）。"""
        nid = str(npc.get("id", "")).strip()
        if not nid:
            return
        col_key = f"npc_collision:{nid}"
        poly = npc.get("collisionPolygon")
        pts: list[tuple[float, float]] = []
        if isinstance(poly, list) and len(poly) >= 3:
            if npc.get("collisionPolygonLocal") is True:
                for p in _hotspot_collision_local_to_world(npc, poly):
                    pts.append((float(p["x"]), float(p["y"])))
            else:
                for p in poly:
                    if isinstance(p, dict):
                        pts.append((float(p.get("x", 0)), float(p.get("y", 0))))
        if len(pts) >= 3:
            model_pts = [{"x": px, "y": py} for px, py in pts]
            existing = self._entity_items.get(col_key)
            if isinstance(existing, _EditableZonePolygon):
                existing.set_points_from_model(model_pts)
            else:
                old_col = self._entity_items.pop(col_key, None)
                if old_col is not None and old_col.scene() is self._gfx:
                    self._gfx.removeItem(old_col)
                poly_item = _EditableZonePolygon(
                    self, pts, _NPC_COLLISION_ZONE_COLOR, nid,
                    poly_kind="npc_collision",
                )
                poly_item.setZValue(-2)
                self._gfx.addItem(poly_item)
                self._entity_items[col_key] = poly_item
                if self._zone_pick_frozen:
                    poly_item.set_zone_pick_frozen(True)
        else:
            old_col = self._entity_items.pop(col_key, None)
            if old_col is not None and old_col.scene() is self._gfx:
                self._gfx.removeItem(old_col)

    def update_npc_collision_polygon(self, entity_id: str, polygon: list) -> None:
        key = f"npc_collision:{entity_id}"
        item = self._entity_items.get(key)
        if isinstance(item, _EditableZonePolygon):
            item.set_points_from_model(polygon)

    def add_npc(self, npc: dict) -> None:
        ir = npc.get("interactionRange", 50)
        item = _DraggableCircle(
            npc["x"], npc["y"], self.handle_radius,
            _NPC_COLOR, npc.get("id", "?"), "npc",
            range_radius=ir, scene_view=self)
        self._gfx.addItem(item)
        self._entity_items[f"npc:{npc.get('id', '')}"] = item
        self.refresh_npc_collision_visuals(npc)
        self._record_entity_planes(f"npc:{npc.get('id', '')}", npc.get("planes"))

    def add_zone(self, zone: dict) -> None:
        pts = _zone_polygon_points_for_editor(zone)
        item = _EditableZonePolygon(
            self, pts, _zone_canvas_color(zone), zone.get("id", "?"))
        self._gfx.addItem(item)
        self._entity_items[f"zone:{zone.get('id', '')}"] = item
        self._record_entity_planes(f"zone:{zone.get('id', '')}", zone.get("planes"))
        if self._zone_pick_frozen:
            item.set_zone_pick_frozen(True)

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

    def _emit_hotspot_collision_polygon_committed(
        self,
        eid: str,
        polygon: list,
    ) -> None:
        self.item_hotspot_collision_polygon_committed.emit(eid, polygon)

    def _emit_npc_collision_polygon_committed(
        self,
        eid: str,
        polygon: list,
    ) -> None:
        self.item_npc_collision_polygon_committed.emit(eid, polygon)

    def _emit_npc_patrol_route_committed(
        self, npc_id: str, route: list,
    ) -> None:
        self.item_npc_patrol_route_committed.emit(npc_id, route)

    # ---- 光环境曲线画布 overlay ----
    def _emit_lightcurve_committed(self, points: list) -> None:
        self.item_lightcurve_committed.emit(points)

    def set_lightcurve_overlay(
        self, points: list | None, selected: int = -1, ref_width: float = 0.0,
    ) -> None:
        """显示/更新光环境曲线折线；points 为 None 或空则移除。就地更新优先,避免高频析构。"""
        pts = [p for p in (points or []) if isinstance(p, dict)]
        if not pts:
            self.remove_lightcurve_overlay()
            return
        ov = self._lightcurve_overlay
        if isinstance(ov, _LightCurvePolyline) and ov.scene() is self._gfx:
            if ref_width > 0:
                ov.set_ref_width(ref_width)
            ov.set_points_from_model(pts)
            ov.set_selected(selected)
            return
        self.remove_lightcurve_overlay()
        item = _LightCurvePolyline(self, pts)
        if ref_width > 0:
            item.set_ref_width(ref_width)
        item.set_selected(selected)
        self._gfx.addItem(item)
        self._lightcurve_overlay = item

    def remove_lightcurve_overlay(self) -> None:
        it = self._lightcurve_overlay
        self._lightcurve_overlay = None
        if it is None:
            return
        try:
            it.setSelected(False)
        except RuntimeError:
            return
        if it.scene() is self._gfx:
            self._gfx.removeItem(it)

    def set_npc_patrol_overlay(
        self, npc_id: str, route: list | None,
    ) -> None:
        """显示/更新巡逻折线；route 为 None 或空则移除。

        若同名 item 已存在，优先就地更新顶点而非 remove+create——避免在添加路点
        高频路径上反复析构 _NpcPatrolPolyline 造成 Qt 内存抖动甚至 crash。
        """
        if not npc_id or not route or not isinstance(route, list):
            self.remove_npc_patrol_overlay(npc_id)
            return
        pts: list[tuple[float, float]] = []
        for p in route:
            if isinstance(p, dict):
                pts.append((float(p.get("x", 0)), float(p.get("y", 0))))
        if len(pts) < 2:
            self.remove_npc_patrol_overlay(npc_id)
            return
        existing = self._patrol_overlays.get(npc_id)
        if isinstance(existing, _NpcPatrolPolyline) and existing.scene() is self._gfx:
            existing.set_points_from_model(
                [{"x": x, "y": y} for x, y in pts],
            )
            return
        # 若残留一个不同实例就先安全清理
        self.remove_npc_patrol_overlay(npc_id)
        item = _NpcPatrolPolyline(self, npc_id, pts)
        self._gfx.addItem(item)
        self._patrol_overlays[npc_id] = item

    def remove_npc_patrol_overlay(self, npc_id: str) -> None:
        it = self._patrol_overlays.pop(npc_id, None)
        if it is None:
            return
        # 删除前主动 deselect，避免 Qt 在事件分发尚未处理完时通过 selection
        # 列表回到已析构的 Python 端，导致 native 层 SAGV/segfault。
        try:
            it.setSelected(False)
        except RuntimeError:
            return
        if it.scene() is self._gfx:
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

    def move_entity_handle(self, kind: str, entity_id: str, x: float, y: float) -> None:
        """数值框改 x/y 时让可拖图元（hotspot/npc/spawn 的 _DraggableCircle）跟随，
        与精灵/碰撞保持单一真相源（修复"改坐标只动精灵、图元不动"的反向脱节）。

        临时关闭 ItemSendsGeometryChanges，避免 setPos 触发 itemChange→item_position_live
        造成与数值框的回写环。"""
        item = self._entity_items.get(f"{kind}:{entity_id}")
        if item is None or item.scene() is not self._gfx:
            return
        flag = QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges
        had = bool(item.flags() & flag)
        if had:
            item.setFlag(flag, False)
        try:
            item.setPos(float(x), float(y))
        finally:
            if had:
                item.setFlag(flag, True)

    def remove_hotspot_graphics(self, entity_id: str) -> None:
        hid = str(entity_id).strip()
        if not hid:
            return
        self._entity_planes.pop(f"hotspot:{hid}", None)
        for key in (f"hotspot:{hid}", f"hotspot_display:{hid}", f"hotspot_collision:{hid}"):
            it = self._entity_items.pop(key, None)
            if it is not None and it.scene() is self._gfx:
                self._gfx.removeItem(it)

    def remove_npc_graphics(self, entity_id: str) -> None:
        nid = str(entity_id).strip()
        if not nid:
            return
        self.remove_npc_patrol_overlay(nid)
        self._entity_planes.pop(f"npc:{nid}", None)
        for key in (f"npc:{nid}", f"npc_collision:{nid}"):
            it = self._entity_items.pop(key, None)
            if it is not None and it.scene() is self._gfx:
                self._gfx.removeItem(it)

    def remove_zone_graphics(self, entity_id: str) -> None:
        zid = str(entity_id).strip()
        if not zid:
            return
        key = f"zone:{zid}"
        self._entity_planes.pop(key, None)
        it = self._entity_items.pop(key, None)
        if it is not None and it.scene() is self._gfx:
            self._gfx.removeItem(it)

    def remove_spawn_graphics(self, spawn_key: str) -> None:
        sk = str(spawn_key).strip()
        if not sk:
            return
        key = f"spawn:{sk}"
        it = self._entity_items.pop(key, None)
        if it is not None and it.scene() is self._gfx:
            self._gfx.removeItem(it)

    def reload_spawn_items_from_scene(self, sc: dict) -> None:
        """重建出生点图元（spawnPoint + spawnPoints），用于 Apply 后与模型一致。"""
        for key in list(self._entity_items.keys()):
            if key.startswith("spawn:"):
                sk = key[len("spawn:") :]
                self.remove_spawn_graphics(sk)
        sp = sc.get("spawnPoint")
        if isinstance(sp, dict):
            self.add_spawn("default", sp)
        sps = sc.get("spawnPoints")
        if isinstance(sps, dict):
            for name, pos in sps.items():
                if isinstance(pos, dict):
                    self.add_spawn(str(name), pos)

    def set_entity_visible(self, logical_kind: str, entity_id: str, visible: bool) -> None:
        """按逻辑实体类型切换画布上图元可见性（含附属展示图/碰撞）。"""
        eid = str(entity_id).strip()
        if not eid:
            return
        lk = str(logical_kind).strip().lower()
        keys: list[str] = []
        if lk == "hotspot":
            keys = [f"hotspot:{eid}", f"hotspot_display:{eid}", f"hotspot_collision:{eid}"]
        elif lk == "npc":
            keys = [f"npc:{eid}", f"npc_collision:{eid}"]
            ov = self._patrol_overlays.get(eid)
            if ov is not None:
                ov.setVisible(visible)
        elif lk == "zone":
            keys = [f"zone:{eid}"]
        elif lk == "spawn":
            keys = [f"spawn:{eid}"]
        else:
            return
        for key in keys:
            it = self._entity_items.get(key)
            if it is not None:
                it.setVisible(visible)

    # ---- 位面视图过滤（纯视图，不改数据；与运行时 entityInPlane 同口径）----------

    @staticmethod
    def _norm_planes(raw: object) -> list[str] | None:
        """实体 planes 归一：非空字符串列表，或 None（缺省=存在于所有位面）。"""
        if not isinstance(raw, list):
            return None
        xs = [str(p).strip() for p in raw if str(p).strip()]
        return xs or None

    def _entity_visible_under_plane_filter(self, planes: list[str] | None) -> bool:
        pf = self._plane_filter
        if pf is None:
            return True
        if planes is None:
            # 缺省实体：shared 位面存在 / exclusive（独立世界型）不存在
            return not self._plane_filter_exclusive
        return pf in planes

    def _record_entity_planes(self, key: str, raw: object) -> None:
        """add_* 登记实体归属并按当前位面视图即时套用（新图元默认可见，故只需隐藏被过滤掉的）。"""
        planes = self._norm_planes(raw)
        self._entity_planes[key] = planes
        if not self._entity_visible_under_plane_filter(planes):
            kind, _, eid = key.partition(":")
            self.set_entity_visible(kind, eid, False)

    def set_plane_filter(self, plane_id: str | None, exclusive: bool = False) -> None:
        """设位面视图：None=显示全部；否则只显示归属含该位面的实体。缺省实体按
        exclusive（该位面世界模型是否独立世界型）决定显隐。纯预览，不改数据。"""
        self._plane_filter = (str(plane_id).strip() or None) if plane_id else None
        self._plane_filter_exclusive = bool(exclusive) and self._plane_filter is not None
        self._apply_plane_filter()

    def _apply_plane_filter(self) -> None:
        for key, planes in self._entity_planes.items():
            kind, _, eid = key.partition(":")
            self.set_entity_visible(
                kind, eid, self._entity_visible_under_plane_filter(planes))

    def update_hotspot_type_color(self, entity_id: str, hs_type: str) -> None:
        hid = str(entity_id).strip()
        if not hid:
            return
        key = f"hotspot:{hid}"
        item = self._entity_items.get(key)
        if isinstance(item, _DraggableCircle):
            ht = str(hs_type or "").strip() or "inspect"
            color = _HOTSPOT_COLORS.get(ht, _HOTSPOT_COLORS["inspect"])
            item.set_color(color)

    def update_entity_circle_label(self, kind: str, entity_id: str, label_text: str) -> None:
        """更新 hotspot/npc/spawn 圆点旁显示的文本（通常为 id）。"""
        kid = str(kind).strip()
        eid = str(entity_id).strip()
        if not kid or not eid:
            return
        key = f"{kid}:{eid}"
        item = self._entity_items.get(key)
        if isinstance(item, _DraggableCircle):
            item.set_label(label_text)

    def update_zone_canvas_color(self, entity_id: str, zone: dict) -> None:
        zid = str(entity_id).strip()
        if not zid:
            return
        key = f"zone:{zid}"
        item = self._entity_items.get(key)
        if isinstance(item, _EditableZonePolygon):
            item.set_color(_zone_canvas_color(zone))

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
            tag.setFont(QFont(MONO_FONT_FAMILY, 8))
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
        """将场景矩形适配到视口。

        首次进入 Scene 页时，分割器/堆叠布局常在一两帧内才给到最终视口尺寸；若只 fit
        一次，会以「临时」视口算变换，之后视口变大但变换不更新，场景会缩在中间一小块。
        因此在约 320ms 内多次重试，并在 resize 时继续重试直至结束窗口。
        """
        self._auto_fit_after_layout = True
        self._fit_layout_token += 1
        tok = self._fit_layout_token
        self._perform_fit_all()
        for ms in (0, 40, 120, 240):
            QTimer.singleShot(ms, lambda t=tok: self._fit_stabilize_step(t))
        QTimer.singleShot(320, lambda t=tok: self._end_auto_fit_after_layout(t))

    def _fit_stabilize_step(self, token: int) -> None:
        if not self._auto_fit_after_layout or token != self._fit_layout_token:
            return
        self._perform_fit_all()

    def _end_auto_fit_after_layout(self, token: int) -> None:
        if token != self._fit_layout_token:
            return
        self._auto_fit_after_layout = False

    def _perform_fit_all(self) -> bool:
        vp = self.viewport().rect()
        if vp.width() < 8 or vp.height() < 8:
            return False
        sr = self._gfx.sceneRect()
        if sr.width() <= 0 or sr.height() <= 0:
            return False
        self.resetTransform()
        self.fitInView(sr, Qt.AspectRatioMode.KeepAspectRatio)
        return True

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        if self._auto_fit_after_layout:
            self._perform_fit_all()

    def showEvent(self, event) -> None:
        super().showEvent(event)
        if self._auto_fit_after_layout:
            tok = self._fit_layout_token
            QTimer.singleShot(0, lambda t=tok: self._fit_stabilize_step(t))

    def wheelEvent(self, event: QWheelEvent) -> None:
        self._auto_fit_after_layout = False
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
            stack = self._entity_stack_at(sp)
            if len(stack) < 2:
                self._pick_cycle_key = None
            else:
                key = (round(sp.x(), 1), round(sp.y(), 1))
                sel = self._gfx.selectedItems()
                sel0 = sel[0] if sel else None
                if key != self._pick_cycle_key:
                    self._pick_cycle_key = key
                    # 新落点：已选中图元若在叠放栈内则保持为本次操作目标，避免
                    # 「按下移动一丁点」就重置为 stack[0] 导致 Zone 抢走拖动。
                    if sel0 is not None and sel0 in stack:
                        self._pick_cycle_i = stack.index(sel0)
                    else:
                        self._pick_cycle_i = 0
                else:
                    # 同一栅格落点重复点击：在栈内循环切换（原行为）
                    if sel0 is not None and sel0 in stack:
                        self._pick_cycle_i = (stack.index(sel0) + 1) % len(stack)
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
                emit_move = it.entity_kind not in (
                    "zone", "hotspot_collision", "npc_collision",
                )
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
        img_path = _scene_background_disk_path(self._model, self._scene_id, sc)
        world_w, world_h = resolve_world_size_for_scene_json(sc, img_path)
        self._last_world = (world_w, world_h)
        self._canvas.setup_world(world_w, world_h)
        if img_path:
            self._canvas.load_background(img_path, world_w, world_h)
        sp = sc.get("spawnPoint")
        if not isinstance(sp, dict):
            # 仅用于画布展示的兜底默认位，不写 model 不标脏——
            # 旧实现"一打开对话框就注入 spawnPoint 且 Cancel 不回退"（审查 P2）。
            # 用户真拖动默认图钉时 _on_canvas_moved 才写入。
            sp = {"x": round(world_w * 0.5, 1), "y": round(world_h * 0.5, 1)}
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
# Cutscene cameraMove: pick world point on scene background
# ---------------------------------------------------------------------------



class CutsceneCameraPointPickerDialog(QDialog):
    """过场 cameraMove：在绑定场景背景上点击得到世界坐标 x,y。"""

    def __init__(
        self,
        model: ProjectModel,
        scene_id: str,
        initial_x: float,
        initial_y: float,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._model = model
        self._scene_id = scene_id
        sc0 = model.scenes.get(scene_id, {})
        title_nm = sc0.get("name", scene_id)
        self.setWindowTitle(f"镜头目标点 — {scene_id}（{title_nm}）")
        self.resize(960, 560)

        self._px = round(float(initial_x), 2)
        self._py = round(float(initial_y), 2)

        root = QVBoxLayout(self)
        hint = QLabel(
            "左键在地图上点击选取镜头移动目标世界坐标；中键拖动画布，滚轮缩放。"
        )
        hint.setWordWrap(True)
        root.addWidget(hint)

        self._coord_lbl = QLabel()
        self._coord_lbl.setStyleSheet(f"font-family: {MONO_FONT_FAMILY}; font-size: 12px;")
        root.addWidget(self._coord_lbl)

        self._view = WorldPointPickView(self)
        self._view.picked.connect(self._on_picked)
        main = QHBoxLayout()
        main.addWidget(self._view, 1)
        root.addLayout(main, 1)

        bbox = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        bbox.accepted.connect(self.accept)
        bbox.rejected.connect(self.reject)
        root.addWidget(bbox)

        self._view.setup_from_scene_json(model, scene_id)
        self._view.set_marker_world(self._px, self._py)
        self._sync_lbl()
        QTimer.singleShot(0, self._view.fit_scene)

    def _sync_lbl(self) -> None:
        self._coord_lbl.setText(f"x = {self._px:.2f}   y = {self._py:.2f}  （世界单位）")

    def _on_picked(self, x: float, y: float) -> None:
        self._px = float(x)
        self._py = float(y)
        self._sync_lbl()

    def picked_xy(self) -> tuple[float, float]:
        return self._px, self._py


def scene_entity_xy_for_action(
    model: ProjectModel | None,
    scene_id: str,
    kind: str,
    entity_id: str,
) -> tuple[float, float]:
    """场景 JSON 中 NPC/Hotspot 的锚点 x,y（世界单位）；用于 Action 表单默认坐标。"""
    if not model or not scene_id or not entity_id:
        return 0.0, 0.0
    sc = model.scenes.get(scene_id) or {}
    if (kind or "").strip().lower() == "hotspot":
        for h in sc.get("hotspots") or []:
            if isinstance(h, dict) and str(h.get("id", "")).strip() == entity_id:
                try:
                    return float(h.get("x", 0) or 0), float(h.get("y", 0) or 0)
                except (TypeError, ValueError):
                    return 0.0, 0.0
    else:
        for n in sc.get("npcs") or []:
            if isinstance(n, dict) and str(n.get("id", "")).strip() == entity_id:
                try:
                    return float(n.get("x", 0) or 0), float(n.get("y", 0) or 0)
                except (TypeError, ValueError):
                    return 0.0, 0.0
    return 0.0, 0.0


class SceneEntityPositionPickerDialog(QDialog):
    """过场 setSceneEntityPosition：在绑定场景背景上点击得到世界坐标（与 cameraMove 同源）。"""

    def __init__(
        self,
        model: ProjectModel,
        scene_id: str,
        entity_kind: str,
        entity_id: str,
        initial_x: float,
        initial_y: float,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._model = model
        self._scene_id = scene_id
        k = (entity_kind or "npc").strip().lower()
        ek = "hotspot" if k == "hotspot" else "npc"
        sc0 = model.scenes.get(scene_id, {})
        title_nm = sc0.get("name", scene_id)
        self.setWindowTitle(f"实体位置 — {scene_id}（{title_nm}） / {ek} · {entity_id}")
        self.resize(960, 560)

        self._px = round(float(initial_x), 2)
        self._py = round(float(initial_y), 2)

        root = QVBoxLayout(self)
        hint = QLabel(
            "左键在地图上点击选取该实体的目标世界坐标；中键拖动画布，滚轮缩放。"
            "确定后写入 Action 的 x/y（不在此对话框内改写场景 JSON）。",
        )
        hint.setWordWrap(True)
        root.addWidget(hint)

        self._coord_lbl = QLabel()
        self._coord_lbl.setStyleSheet(f"font-family: {MONO_FONT_FAMILY}; font-size: 12px;")
        root.addWidget(self._coord_lbl)

        self._view = WorldPointPickView(self)
        self._view.picked.connect(self._on_picked)
        main = QHBoxLayout()
        main.addWidget(self._view, 1)
        root.addLayout(main, 1)

        bbox = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
        )
        bbox.accepted.connect(self.accept)
        bbox.rejected.connect(self.reject)
        root.addWidget(bbox)

        self._view.setup_from_scene_json(model, scene_id)
        self._view.set_marker_world(self._px, self._py)
        self._sync_lbl()
        QTimer.singleShot(0, self._view.fit_scene)

    def _sync_lbl(self) -> None:
        self._coord_lbl.setText(f"x = {self._px:.2f}   y = {self._py:.2f}  （世界单位）")

    def _on_picked(self, x: float, y: float) -> None:
        self._px = float(x)
        self._py = float(y)
        self._sync_lbl()

    def picked_xy(self) -> tuple[float, float]:
        return self._px, self._py


# ---------------------------------------------------------------------------
# 光照环境曲线（lightEnvCurve）
# ---------------------------------------------------------------------------

# 关键帧缺省值，镜像 src/rendering/lightEnv.ts 的 BASELINE；编辑器写「完整」关键帧。
_LC_BASELINE_ENV: dict = {
    "key": {"azimuthDeg": 125.0, "elevationDeg": 55.0, "color": [1.0, 0.97, 0.92], "intensity": 1.0},
    "ambient": {"color": [0.55, 0.6, 0.72], "intensity": 1.0},
    "shadow": {
        "mode": "real", "enabled": True, "darkness": 0.4, "softness": 1.0,
        "contact": 0.5, "contactSize": 1.0,
        "softSamples": 1, "softRadius": 0.05, "billboard": "light",
    },
    "toneStrength": 0.45, "toneEnabled": True,
    "ao": {"contact": 0.45, "form": 0.25},
}


def _rgb01_to_hex(c: object) -> str:
    """光照颜色 [r,g,b]（0..1，可超 1 的 HDR 在编辑器内夹到 1）→ #rrggbb。"""
    if not isinstance(c, (list, tuple)) or len(c) < 3:
        return "#ffffff"
    def ch(v: object) -> int:
        try:
            f = float(v)
        except (TypeError, ValueError):
            f = 1.0
        return max(0, min(255, round(max(0.0, min(1.0, f)) * 255)))
    return f"#{ch(c[0]):02x}{ch(c[1]):02x}{ch(c[2]):02x}"


def _hex_to_rgb01(hx: str) -> list[float]:
    col = QColor(hx if hx.startswith("#") else f"#{hx}")
    if not col.isValid():
        return [1.0, 1.0, 1.0]
    return [round(col.red() / 255, 3), round(col.green() / 255, 3), round(col.blue() / 255, 3)]


def _spin(lo: float, hi: float, step: float, decimals: int) -> QDoubleSpinBox:
    s = QDoubleSpinBox()
    s.setRange(lo, hi)
    s.setSingleStep(step)
    s.setDecimals(decimals)
    s.setMaximumWidth(90)
    return s


class _LightEnvKeyframeEditor(QWidget):
    """单关键帧光照环境编辑器：key/ambient/shadow/tone/ao 全字段，写「完整」env。

    阴影 length 故意不暴露——运行时由 elevation/azimuth 推导（keying 方位/仰角即动画）。
    """

    changed = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._updating = False
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(4)

        # —— 主光 key ——
        kbox = QWidget()
        kform = compact_form(QFormLayout(kbox))
        self.key_az = _spin(0, 360, 1, 1)
        self.key_el = _spin(0, 90, 1, 1)
        self.key_color = HexColorPickRow("#ffffff", title="主光颜色 key.color")
        self.key_int = _spin(0, 4, 0.05, 3)
        kform.addRow("主光方位°(来向)", self.key_az)
        kform.addRow("主光仰角°", self.key_el)
        kform.addRow("主光颜色", self.key_color)
        kform.addRow("主光强度", self.key_int)
        root.addWidget(QLabel("主光 key"))
        root.addWidget(kbox)

        # —— 环境光 ambient ——
        abox = QWidget()
        aform = compact_form(QFormLayout(abox))
        self.amb_color = HexColorPickRow("#8c99b8", title="环境光颜色 ambient.color")
        self.amb_int = _spin(0, 4, 0.05, 3)
        aform.addRow("环境光颜色", self.amb_color)
        aform.addRow("环境光强度", self.amb_int)
        root.addWidget(QLabel("环境光 ambient"))
        root.addWidget(abox)

        # —— 色调 + AO ——
        tbox = QWidget()
        tform = compact_form(QFormLayout(tbox))
        self.tone_strength = _spin(0, 1, 0.02, 3)
        self.tone_enabled = QCheckBox("色调融入 toneEnabled")
        self.ao_contact = _spin(0, 1, 0.02, 3)
        self.ao_form = _spin(0, 1, 0.02, 3)
        tform.addRow("色调强度 toneStrength", self.tone_strength)
        tform.addRow("", self.tone_enabled)
        tform.addRow("AO 接触 contact", self.ao_contact)
        tform.addRow("AO 形体 form", self.ao_form)
        root.addWidget(QLabel("色调 / AO"))
        root.addWidget(tbox)

        # —— 阴影 shadow（默认折叠）——
        sh_fold = CollapsibleSection("阴影 shadow（length/skew 由方位/仰角自动推导）", start_open=False)
        sbox = QWidget()
        sform = compact_form(QFormLayout(sbox))
        self.sh_mode = FilterableTypeCombo.from_flat_strings(["real", "planar", "off"], self, select_only=True)
        self.sh_enabled = QCheckBox("启用阴影 enabled")
        self.sh_darkness = _spin(0, 1, 0.02, 3)
        self.sh_softness = _spin(0, 4, 0.05, 3)
        self.sh_contact = _spin(0, 1, 0.02, 3)
        self.sh_contact_size = _spin(0.1, 3, 0.05, 3)
        self.sh_soft_samples = QSpinBox()
        self.sh_soft_samples.setRange(1, 16)
        self.sh_soft_samples.setMaximumWidth(90)
        self.sh_soft_radius = _spin(0, 1, 0.01, 3)
        self.sh_billboard = FilterableTypeCombo.from_flat_strings(["light", "camera"], self, select_only=True)
        sform.addRow("模式 mode", self.sh_mode)
        sform.addRow("", self.sh_enabled)
        sform.addRow("暗度 darkness", self.sh_darkness)
        sform.addRow("柔和 softness", self.sh_softness)
        sform.addRow("接触 contact", self.sh_contact)
        sform.addRow("接触尺寸 contactSize", self.sh_contact_size)
        sform.addRow("软采样 softSamples", self.sh_soft_samples)
        sform.addRow("软半径 softRadius", self.sh_soft_radius)
        sform.addRow("billboard", self.sh_billboard)
        sh_fold.add_body(sbox)
        root.addWidget(sh_fold)

        # 统一接变更信号
        for sp in (self.key_az, self.key_el, self.key_int, self.amb_int, self.tone_strength,
                   self.ao_contact, self.ao_form, self.sh_darkness, self.sh_softness,
                   self.sh_contact, self.sh_contact_size, self.sh_soft_radius):
            sp.valueChanged.connect(self._on_any)
        self.sh_soft_samples.valueChanged.connect(self._on_any)
        for cb in (self.tone_enabled, self.sh_enabled):
            cb.stateChanged.connect(self._on_any)
        for combo in (self.sh_mode, self.sh_billboard):
            combo.currentIndexChanged.connect(self._on_any)
        for col in (self.key_color, self.amb_color):
            col.changed.connect(self._on_any)

    def _on_any(self, *_a: object) -> None:
        if self._updating:
            return
        self.changed.emit()

    def set_env(self, env: dict | None) -> None:
        """以 BASELINE 为底合并 env（部分关键帧补全），填入控件。"""
        self._updating = True
        try:
            e = copy.deepcopy(_LC_BASELINE_ENV)
            src = env if isinstance(env, dict) else {}
            for grp in ("key", "ambient", "shadow", "ao"):
                if isinstance(src.get(grp), dict):
                    e[grp].update(src[grp])
            if "toneStrength" in src:
                e["toneStrength"] = src["toneStrength"]
            if "toneEnabled" in src:
                e["toneEnabled"] = src["toneEnabled"]
            k, a, sh = e["key"], e["ambient"], e["shadow"]
            self.key_az.setValue(float(k.get("azimuthDeg", 125)))
            self.key_el.setValue(float(k.get("elevationDeg", 55)))
            self.key_color.set_hex(_rgb01_to_hex(k.get("color")))
            self.key_int.setValue(float(k.get("intensity", 1)))
            self.amb_color.set_hex(_rgb01_to_hex(a.get("color")))
            self.amb_int.setValue(float(a.get("intensity", 1)))
            self.tone_strength.setValue(float(e.get("toneStrength", 0.45)))
            self.tone_enabled.setChecked(bool(e.get("toneEnabled", True)))
            self.ao_contact.setValue(float(e["ao"].get("contact", 0.45)))
            self.ao_form.setValue(float(e["ao"].get("form", 0.25)))
            self.sh_mode.set_committed_type(str(sh.get("mode", "real")))
            self.sh_enabled.setChecked(bool(sh.get("enabled", True)))
            self.sh_darkness.setValue(float(sh.get("darkness", 0.4)))
            self.sh_softness.setValue(float(sh.get("softness", 1.0)))
            self.sh_contact.setValue(float(sh.get("contact", 0.5)))
            self.sh_contact_size.setValue(float(sh.get("contactSize", 1.0)))
            self.sh_soft_samples.setValue(int(sh.get("softSamples", 1)))
            self.sh_soft_radius.setValue(float(sh.get("softRadius", 0.05)))
            self.sh_billboard.set_committed_type(str(sh.get("billboard", "light")))
        finally:
            self._updating = False

    def get_env(self) -> dict:
        """读出「完整」env（键序固定，保证编辑器往返稳定）。"""
        return {
            "key": {
                "azimuthDeg": round(self.key_az.value(), 3),
                "elevationDeg": round(self.key_el.value(), 3),
                "color": _hex_to_rgb01(self.key_color.hex()),
                "intensity": round(self.key_int.value(), 3),
            },
            "ambient": {
                "color": _hex_to_rgb01(self.amb_color.hex()),
                "intensity": round(self.amb_int.value(), 3),
            },
            "shadow": {
                "mode": self.sh_mode.committed_type() or "real",
                "enabled": bool(self.sh_enabled.isChecked()),
                "darkness": round(self.sh_darkness.value(), 3),
                "softness": round(self.sh_softness.value(), 3),
                "contact": round(self.sh_contact.value(), 3),
                "contactSize": round(self.sh_contact_size.value(), 3),
                "softSamples": int(self.sh_soft_samples.value()),
                "softRadius": round(self.sh_soft_radius.value(), 3),
                "billboard": self.sh_billboard.committed_type() or "light",
            },
            "toneStrength": round(self.tone_strength.value(), 3),
            "toneEnabled": bool(self.tone_enabled.isChecked()),
            "ao": {
                "contact": round(self.ao_contact.value(), 3),
                "form": round(self.ao_form.value(), 3),
            },
        }


# ---------------------------------------------------------------------------
# Property panel
# ---------------------------------------------------------------------------


class ScenePropertyPanel(QScrollArea):
    changed = Signal()
    # (kind, entity_id, interaction_range) — live canvas sync
    interaction_range_changed = Signal(str, str, float)
    # entity_id, polygon list[{"x","y"}, ...] — 侧栏顶点表驱动画布
    zone_polygon_changed = Signal(str, object)
    hotspot_collision_polygon_changed = Signal(str, object)
    npc_collision_polygon_changed = Signal(str, object)
    hotspot_visual_refresh_requested = Signal(str)
    # 侧栏改 anim/初始状态后，让主窗口按 npc id 重建该 NPC 的场景动画层
    npc_scene_anim_refresh_requested = Signal(str)
    # 侧栏改 x/y 时同步写回 dict 并通知主窗口重绘该 NPC 位置
    npc_xy_live_changed = Signal(str)
    # 侧栏底部「从场景删除」与工具栏删除共用同一逻辑
    delete_current_entity_requested = Signal()
    # 巡逻折线显示/数据变更后刷新画布 overlay
    npc_patrol_overlay_refresh_requested = Signal()
    # 光环境曲线数据变化→请求画布重建 overlay
    lightcurve_overlay_refresh_requested = Signal()
    # npc_id, enabled — 仅编辑器内沿路径预览精灵
    npc_patrol_preview_changed = Signal(str, bool)
    # 当前面板存在未 Apply 的 staging 修改（True）或已与 source 一致（False）
    pending_dirty_changed = Signal(bool)
    # 背景图已导入/更换（已落盘 + 写入场景数据）→ 请求画布重载背景
    scene_background_changed = Signal()

    def reload_refs_from_model(self) -> None:
        """重拉跨域引用候选(filter/item/encounter/bgm,均为别处可新增的全局列表),
        保留各选择器当前选中值。供切页激活时调用。"""
        for attr, provider in (
            ("_sc_filter", self._model.all_filter_ids),
            ("_hs_pickup_item", self._model.all_item_ids),
            ("_hs_enc_id", self._model.all_encounter_ids),
            ("_sc_bgm", lambda: [(a, a) for a in self._model.all_audio_ids("bgm")]),
        ):
            sel = getattr(self, attr, None)
            if isinstance(sel, (IdRefSelector, AudioIdPreviewSelector)):
                sel.set_items(provider())

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self.setWidgetResizable(True)
        self.setMinimumWidth(280)  # 三栏预算：属性面板下限收窄以适配 13"（仍够放表单）
        self._stack = QStackedWidget()
        # 垂直 Minimum：高度至少为当前页 sizeHint，避免滚动区内与 stretch 争抢时将整页压扁。
        self._stack.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Minimum,
        )
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
        self._source_hotspot: dict | None = None
        self._staging_hotspot: dict | None = None
        self._source_npc: dict | None = None
        self._staging_npc: dict | None = None
        self._source_zone: dict | None = None
        self._staging_zone: dict | None = None
        self._source_scene: dict | None = None
        self._staging_scene: dict | None = None
        self._hs_cutscene_ids_pending: list[str] = []
        self._npc_cutscene_ids_pending: list[str] = []
        # 位面归属（planes；缺省=存在于所有位面）：与 cutsceneIds 同款 pending 列表
        self._hs_plane_ids_pending: list[str] = []
        self._npc_plane_ids_pending: list[str] = []
        self._zn_plane_ids_pending: list[str] = []
        self._spawn_flush_scene: dict | None = None
        self._editing_scene_id: str = ""
        self._zn_poly_updating: bool = False
        self._npc_patrol_table_updating: bool = False
        self._npc_col_updating: bool = False
        # 光环境曲线：单一真相源(每项 {x,y,env})，表格只读展示 x/y，env 走逐帧编辑器
        self._sc_lightcurve_points: list[dict] = []
        self._lc_selected: int = -1
        self._lc_table_updating: bool = False
        self._props_changed_suppressed: int = 0
        self._emit_changed_signal = self.changed.emit
        # auto-discard 语义下的"未应用 staging"标记：任何用户编辑路径置 True，
        # _apply_props 完成 / load_*_props 切换实体后置 False；驱动 toolbar 红色提示。
        self._pending_dirty: bool = False

    @contextmanager
    def _suppress_props_changed_emits(self) -> Iterator[None]:
        """程序化填充属性页时阻断 changed（staging 变更信号），避免噪声。"""
        self._props_changed_suppressed += 1
        try:
            yield
        finally:
            self._props_changed_suppressed -= 1

    def _emit_props_changed(self) -> None:
        if self._props_changed_suppressed:
            return
        self._emit_changed_signal()
        self._set_pending_dirty(True)

    def _set_pending_dirty(self, dirty: bool) -> None:
        if bool(dirty) == self._pending_dirty:
            return
        self._pending_dirty = bool(dirty)
        self.pending_dirty_changed.emit(self._pending_dirty)

    def is_pending_dirty(self) -> bool:
        return self._pending_dirty

    # ---- 轻量 rebind：Apply 完成后让 staging 重新指向 source 的新副本 -----
    # 不重置 widgets（widgets 已与 source 一致），消除完整 load_* 重装带来的
    # CutsceneImagePathRow / ConditionEditor / FilterableTypeCombo 副作用。

    def rebind_hotspot_after_commit(self) -> None:
        if self._source_hotspot is None:
            return
        st = copy.deepcopy(self._source_hotspot)
        self._staging_hotspot = st
        self._pending_hotspot = st
        if self._stack.currentWidget() == self._hotspot_panel:
            self._current_data = st
            self._normalize_hotspot_widgets_after_commit(st)
        self._set_pending_dirty(False)

    def rebind_npc_after_commit(self) -> None:
        if self._source_npc is None:
            return
        st = copy.deepcopy(self._source_npc)
        self._staging_npc = st
        self._pending_npc = st
        if self._stack.currentWidget() == self._npc_panel:
            self._current_data = st
        self._set_pending_dirty(False)

    def rebind_zone_after_commit(self) -> None:
        if self._source_zone is None:
            return
        st = copy.deepcopy(self._source_zone)
        self._staging_zone = st
        self._pending_zone = st
        if self._stack.currentWidget() == self._zone_panel:
            self._current_data = st
        self._set_pending_dirty(False)

    def rebind_scene_after_commit(self, sc: dict) -> None:
        """场景 staging 同样 rebind；hotspots/npcs/zones 仍共享 model 引用。"""
        self._source_scene = sc
        st = copy.deepcopy(sc)
        for lk in ("hotspots", "npcs", "zones"):
            if lk in sc:
                st[lk] = sc[lk]
        sp_dict = sc.get("spawnPoints")
        if isinstance(sp_dict, dict):
            st["spawnPoints"] = copy.deepcopy(sp_dict)
        sp_pt = sc.get("spawnPoint")
        if isinstance(sp_pt, dict):
            st["spawnPoint"] = copy.deepcopy(sp_pt)
        self._staging_scene = st
        if self._stack.currentWidget() == self._scene_panel:
            self._current_data = st
        # spawn 面板共享同一份 staging_scene，rebind 后保持指针对齐
        if self._spawn_scene is not None and self._stack.currentWidget() == self._spawn_panel:
            self._spawn_scene = st
            self._spawn_flush_scene = st
        self._set_pending_dirty(False)

    def _normalize_hotspot_widgets_after_commit(self, hs: dict) -> None:
        """少量 displayImage 类字段在 _write_hotspot_widgets_to_dict 中可能被规范化或 pop。
        这里把 source 的最新形态轻量回填到关键 widgets，避免 widgets 与 source 错位
        但又不像 load_hotspot_props 那样重置整个面板触发副作用。"""
        di = hs.get("displayImage") if isinstance(hs.get("displayImage"), dict) else None
        has_disp = isinstance(di, dict) and bool(str(di.get("image", "") or "").strip())
        # 折叠状态：与 load_hotspot_props 的展开规则一致
        try:
            self._hs_disp_fold.set_expanded(
                bool(
                    has_disp
                    and float(self._hs_disp_ww.value()) > 0
                    and float(self._hs_disp_hh.value()) > 0,
                ),
            )
        except (AttributeError, TypeError, ValueError):
            pass
        col = hs.get("collisionPolygon")
        try:
            self._hs_col_fold.set_expanded(isinstance(col, list) and len(col) >= 3)
        except (AttributeError, TypeError):
            pass

    @staticmethod
    def _section(title: str, *, start_open: bool = True) -> CollapsibleSection:
        return CollapsibleSection(title, start_open=start_open)

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

    def _install_vertex_table_affordances(
        self, table: QTableWidget, remove_handler, *, label: str = "删除选中顶点",
    ) -> None:
        """Add right-click menu + Delete-key removal to a vertex/route table.

        Wired purely to the editor's EXISTING remove handler — no new delete
        logic, no data path of its own.
        """
        table.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)

        def _on_menu(pos: QPoint) -> None:
            if table.currentRow() < 0:
                return
            menu = QMenu(table)
            act = QAction(label, menu)
            act.triggered.connect(remove_handler)
            menu.addAction(act)
            menu.exec(table.viewport().mapToGlobal(pos))

        table.customContextMenuRequested.connect(_on_menu)

        original_key_press = table.keyPressEvent

        def _key_press(event) -> None:
            if event.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
                remove_handler()
                event.accept()
                return
            original_key_press(event)

        table.keyPressEvent = _key_press  # type: ignore[method-assign]

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

    def _current_ambient_preview_id(self) -> str:
        item = self._sc_ambient_list.currentItem()
        if item is not None:
            return item.text().strip()
        extra_raw = self._sc_ambient_extra.text().strip()
        extra = [s.strip() for s in extra_raw.split(",") if s.strip()]
        return extra[0] if extra else ""

    def show_empty(self) -> None:
        self._stack.setCurrentWidget(self._empty)

    # ---- scene props ------------------------------------------------------

    def _build_scene_panel(self) -> QWidget:
        w = QWidget()
        outer = QVBoxLayout(w)
        outer.setAlignment(Qt.AlignmentFlag.AlignTop)
        basic = self._section("基本：标识、世界尺寸、滤镜与镜头", start_open=True)
        basic_inner = QWidget()
        form = QFormLayout(basic_inner)
        form.setFieldGrowthPolicy(
            QFormLayout.FieldGrowthPolicy.FieldsStayAtSizeHint,
        )
        self._sc_id = QLineEdit(); form.addRow("id", self._sc_id)
        self._sc_name = QLineEdit(); form.addRow("name", self._sc_name)
        self._sc_name.textChanged.connect(lambda *_: self._emit_props_changed())
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
        self._sc_bgm = AudioIdPreviewSelector(self._model, "bgm", allow_empty=True, editable=True)
        self._sc_bgm.setMinimumWidth(160)
        self._sc_bgm.value_changed.connect(lambda _x: self._emit_props_changed())
        self._sc_bgm.setToolTip("场景背景音乐 id；右侧按钮可试听当前选择。")
        form.addRow("bgm", self._sc_bgm)
        self._sc_filter = IdRefSelector(allow_empty=True, editable=True)
        self._sc_filter.value_changed.connect(lambda _x: self._emit_props_changed())
        form.addRow("filterId", self._sc_filter)
        # 这批控件此前不接 changed 信号 → 永不置 pending-dirty → 不点 Apply 切场景即丢（审查 P1-1）
        self._sc_zoom = QDoubleSpinBox(); self._sc_zoom.setRange(0.01, 20); self._sc_zoom.setSingleStep(0.1)
        self._sc_zoom.valueChanged.connect(lambda _v: self._emit_props_changed())
        form.addRow("camera.zoom", self._sc_zoom)
        self._sc_ppu = QDoubleSpinBox(); self._sc_ppu.setRange(0.01, 9999); self._sc_ppu.setValue(1)
        self._sc_ppu.valueChanged.connect(lambda _v: self._emit_props_changed())
        form.addRow("camera.ppu", self._sc_ppu)
        self._sc_scale = QDoubleSpinBox(); self._sc_scale.setRange(0.01, 10); self._sc_scale.setValue(1)
        self._sc_scale.valueChanged.connect(lambda _v: self._emit_props_changed())
        form.addRow("worldScale", self._sc_scale)
        basic.add_body(basic_inner)
        outer.addWidget(basic)

        bg_g = self._section("背景图", start_open=True)
        bg_inner = QWidget()
        bg_lay = QVBoxLayout(bg_inner)
        self._sc_bg_label = QLabel("未设置")
        self._sc_bg_label.setWordWrap(True)
        self._sc_bg_label.setToolTip(
            "当前场景背景图（backgrounds[0].image）；导入后统一存为本场景 runtime 目录下的 background.png。")
        bg_lay.addWidget(self._sc_bg_label)
        self._sc_bg_thumb = QLabel("（无背景图预览）")
        self._sc_bg_thumb.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self._sc_bg_thumb.setMinimumHeight(90)
        self._sc_bg_thumb.setStyleSheet(
            "border:1px solid #444; background:#1e1e1e; color:#888;")
        self._sc_bg_thumb.setToolTip("当前背景图预览（点画布查看完整效果）。")
        bg_lay.addWidget(self._sc_bg_thumb)
        bg_btns = QHBoxLayout()
        self._sc_bg_import = QPushButton("导入 / 更换背景图…")
        self._sc_bg_import.setToolTip(
            "选择一张图片，转存为本场景 runtime/scenes/<id>/background.png 并设为背景；"
            "首次导入会按图片像素尺寸自动填入世界宽高（可再手改）。")
        self._sc_bg_import.clicked.connect(self._on_import_background)
        bg_btns.addWidget(self._sc_bg_import)
        self._sc_bg_derive_size = QPushButton("按背景图推导尺寸")
        self._sc_bg_derive_size.setToolTip(
            "用当前背景图的像素宽高重设 worldWidth / worldHeight（锁定宽高比时按图片比例）。")
        self._sc_bg_derive_size.clicked.connect(self._on_derive_world_size_from_bg)
        bg_btns.addWidget(self._sc_bg_derive_size)
        bg_btns.addStretch(1)
        bg_lay.addLayout(bg_btns)
        self._sc_bg_depth_warn = QLabel()
        self._sc_bg_depth_warn.setWordWrap(True)
        self._sc_bg_depth_warn.setStyleSheet("color:#e0a030;")
        self._sc_bg_depth_warn.setVisible(False)
        bg_lay.addWidget(self._sc_bg_depth_warn)
        bg_g.add_body(bg_inner)
        outer.addWidget(bg_g)

        depth_box = CollapsibleSection("depthConfig（2D 遮挡深度）", start_open=False)
        depth_box.set_header_tool_tip(
            "默认折叠；与 Scene Depth Editor 导出一致，此处仅微调 tolerance / floor_offset",
        )
        depth_inner = QWidget()
        depth_form = compact_form(QFormLayout(depth_inner))
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
        depth_box.add_body(depth_inner)
        outer.addWidget(depth_box)

        move_g = self._section("角色移动速度", start_open=True)
        move_inner = QWidget()
        move_f = compact_form(QFormLayout(move_inner))
        self._sc_walk = QDoubleSpinBox(); self._sc_walk.setRange(0, 9999)
        self._sc_walk.valueChanged.connect(lambda _v: self._emit_props_changed())
        move_f.addRow("walkSpeed", self._sc_walk)
        self._sc_run = QDoubleSpinBox(); self._sc_run.setRange(0, 9999)
        self._sc_run.valueChanged.connect(lambda _v: self._emit_props_changed())
        move_f.addRow("runSpeed", self._sc_run)
        move_g.add_body(move_inner)
        outer.addWidget(move_g)

        amb_g = self._section("环境音效 ambientSounds", start_open=True)
        amb_inner = QWidget()
        amb_lay = QVBoxLayout(amb_inner)
        self._sc_ambient_list = QListWidget()
        self._sc_ambient_list.setToolTip(
            "勾选 audio_config.ambient 中的 id；目录外 id 在下方填写（逗号分隔）。",
        )
        self._sc_ambient_list.setMaximumHeight(110)  # 上限而非固定，拥挤时可压缩
        self._sc_ambient_list.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Maximum,
        )
        self._sc_ambient_list.setHorizontalScrollBarPolicy(
            Qt.ScrollBarPolicy.ScrollBarAlwaysOff,
        )
        self._sc_ambient_list.itemChanged.connect(lambda _i: self._emit_props_changed())
        self._sc_ambient_list.itemDoubleClicked.connect(
            lambda _i: self._sc_ambient_preview.preview_current(),
        )
        amb_lay.addWidget(self._sc_ambient_list)
        amb_preview_row = QHBoxLayout()
        amb_preview_row.addWidget(QLabel("试听当前 ambient"))
        self._sc_ambient_preview = AudioPreviewControls(
            self._model,
            "ambient",
            self._current_ambient_preview_id,
            self,
        )
        amb_preview_row.addWidget(self._sc_ambient_preview)
        amb_preview_row.addStretch(1)
        amb_lay.addLayout(amb_preview_row)
        self._sc_ambient_extra = QLineEdit()
        self._sc_ambient_extra.setPlaceholderText("其它 ambient id，逗号分隔")
        self._sc_ambient_extra.textChanged.connect(lambda *_: self._emit_props_changed())
        amb_lay.addWidget(self._sc_ambient_extra)
        amb_g.add_body(amb_inner)
        outer.addWidget(amb_g)

        enter_g = CollapsibleSection("进入场景时执行（onEnter）", start_open=False)
        enter_g.set_header_tool_tip(
            "与 Zone 的 onEnter 不同：此处绑定场景根，每次成功加载本场景顺序执行一次。",
        )
        enter_inner = QWidget()
        enter_lay = QVBoxLayout(enter_inner)
        self._sc_on_enter = ActionEditor("onEnter")
        self._sc_on_enter.setToolTip(
            "在 spawn/相机、音频与 Zone 注册之后执行，早于 HUD 收到的 scene:enter。"
            "适用一次性演出、按场景设标志等。",
        )
        self._sc_on_enter.changed.connect(self._emit_props_changed)
        enter_lay.addWidget(self._sc_on_enter)
        enter_g.add_body(enter_inner)
        outer.addWidget(enter_g)
        self._sc_on_enter_fold = enter_g

        lc_g = CollapsibleSection(
            "光环境曲线 lightEnvCurve（玩家位置插值光照）", start_open=False)
        lc_g.set_header_tool_tip(
            "一条世界折线；运行时把玩家位置投影到线上,按弧长在相邻关键帧间插值光照。"
            "≥2 个控制点才生效;为空=用静态 lightEnv（现状不变）。")
        lc_inner = QWidget()
        lc_lay = QVBoxLayout(lc_inner)
        lc_hint = QLabel(
            "控制点(暖金)直接在画布上编辑,和巡逻路线一样：拖顶点移动 / 双击线段插点 / "
            "右键顶点删除。下表选中一行编辑其光照关键帧。")
        lc_hint.setWordWrap(True)
        lc_lay.addWidget(lc_hint)
        self._lc_table = QTableWidget(0, 3)
        self._lc_table.setHorizontalHeaderLabels(["#", "x", "y"])
        self._lc_table.horizontalHeader().setSectionResizeMode(
            0, QHeaderView.ResizeMode.ResizeToContents)
        self._lc_table.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.Stretch)
        self._lc_table.horizontalHeader().setSectionResizeMode(
            2, QHeaderView.ResizeMode.Stretch)
        self._lc_table.setMinimumHeight(110)
        self._lc_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self._lc_table.setSelectionBehavior(
            QAbstractItemView.SelectionBehavior.SelectRows)
        self._lc_table.setSelectionMode(
            QAbstractItemView.SelectionMode.SingleSelection)
        self._lc_table.itemSelectionChanged.connect(self._on_lc_row_selected)
        self._install_vertex_table_affordances(
            self._lc_table, self._on_lc_remove_point, label="删除选中控制点")
        lc_lay.addWidget(self._lc_table)
        lc_btns = QHBoxLayout()
        self._lc_add = QPushButton("添加点")
        self._lc_add.setToolTip("在末点附近追加一个控制点,再到画布上拖到目标位置")
        self._lc_add.clicked.connect(self._on_lc_add_point)
        self._lc_up = QPushButton("上移")
        self._lc_up.clicked.connect(lambda: self._on_lc_move(-1))
        self._lc_down = QPushButton("下移")
        self._lc_down.clicked.connect(lambda: self._on_lc_move(1))
        self._lc_del = QPushButton("删除")
        self._lc_del.clicked.connect(self._on_lc_remove_point)
        for b in (self._lc_add, self._lc_up, self._lc_down, self._lc_del):
            lc_btns.addWidget(b)
        lc_btns.addStretch(1)
        lc_lay.addLayout(lc_btns)
        lc_lay.addWidget(QLabel("选中控制点的光照关键帧："))
        self._lc_env_editor = _LightEnvKeyframeEditor()
        self._lc_env_editor.changed.connect(self._on_lc_env_changed)
        lc_lay.addWidget(self._lc_env_editor)
        lc_g.add_body(lc_inner)
        outer.addWidget(lc_g)
        self._sc_lightcurve_fold = lc_g

        outer.addStretch(1)
        return w

    def _ensure_source_scene_for_editing(self) -> None:
        sid = self._editing_scene_id or ""
        sc = self._model.scenes.get(sid)
        if isinstance(sc, dict):
            self._source_scene = sc

    def load_scene_props(
        self, sc: dict, *, clear_pending_edits: bool = False,
    ) -> None:
        with self._suppress_props_changed_emits():
            # 共享 staging：进入 scene 面板前把 spawn 面板 widgets 也 flush 到
            # _staging_scene；hotspot/npc/zone 走独立 staging，无需 flush。
            self.flush_active_panel_widgets_to_staging(only_shared_scene_staging=True)
            self._set_pending_dirty(False)
            self._source_scene = sc
            st = copy.deepcopy(sc)
            # NOTE: hotspots/npcs/zones 故意共享 model 引用，保持画布右键添加/删除直写
            # model 的旧契约；逐实体 _source_*/_staging_* 通路负责字段级 staging commit。
            for lk in ("hotspots", "npcs", "zones"):
                if lk in sc:
                    st[lk] = sc[lk]
            sp_dict = sc.get("spawnPoints")
            if isinstance(sp_dict, dict):
                st["spawnPoints"] = copy.deepcopy(sp_dict)
            elif "spawnPoints" in sc:
                st["spawnPoints"] = copy.deepcopy(sc["spawnPoints"])
            sp_pt = sc.get("spawnPoint")
            if isinstance(sp_pt, dict):
                st["spawnPoint"] = copy.deepcopy(sp_pt)
            elif "spawnPoint" in sc:
                st["spawnPoint"] = copy.deepcopy(sc["spawnPoint"])
            self._staging_scene = st
            self._current_data = st
            if clear_pending_edits:
                self._pending_hotspot = None
                self._pending_npc = None
                self._pending_zone = None
                self._source_hotspot = None
                self._staging_hotspot = None
                self._source_npc = None
                self._staging_npc = None
                self._source_zone = None
                self._staging_zone = None
                self._spawn_flush_scene = None
                self._spawn_scene = None
            self._stack.setCurrentWidget(self._scene_panel)
            self._editing_scene_id = str(st.get("id", ""))
            self._sc_id.setText(st.get("id", ""))
            self._sc_name.setText(st.get("name", ""))
            ww = float(st.get("worldWidth", 0) or 0)
            wh = float(st.get("worldHeight", 0) or 0)
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
            self._update_bg_label_from(st)
            self._sc_bgm.set_items([(a, a) for a in self._model.all_audio_ids("bgm")])
            self._sc_bgm.set_current(str(st.get("bgm", "") or ""))
            self._sc_filter.set_items(self._model.all_filter_ids())
            self._sc_filter.set_current(st.get("filterId", ""))
            cam = st.get("camera", {})
            self._sc_zoom.setValue(cam.get("zoom", 1))
            self._sc_ppu.setValue(cam.get("pixelsPerUnit", 1))
            self._sc_scale.setValue(st.get("worldScale", 1))
            self._sc_walk.setValue(st.get("playerWalkSpeed", 0))
            self._sc_run.setValue(st.get("playerRunSpeed", 0))
            dc = st.get("depthConfig")
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
            raw_amb = st.get("ambientSounds", [])
            if not isinstance(raw_amb, list):
                raw_amb = []
            self._load_ambient_widgets([str(x) for x in raw_amb])
            self._sc_on_enter.set_project_context(self._model, self._editing_scene_id or None)
            raw_oe = st.get("onEnter", [])
            if not isinstance(raw_oe, list):
                raw_oe = []
            self._sc_on_enter.set_data(raw_oe)
            self._sc_on_enter_fold.set_expanded(bool(raw_oe))
            self._load_lightcurve(st)

    def _on_depth_fields_changed(self, _v: float) -> None:
        if not self._sc_depth_tol.isEnabled():
            return
        self._emit_props_changed()

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
            # 未锁比例也要置脏：改宽高本身就是编辑（旧实现提前 return 导致不点 Apply 即丢）
            self._emit_props_changed()
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
        self._emit_props_changed()

    def _on_world_height_changed(self, _v: float) -> None:
        if self._updating_world_dims:
            return
        if not self._sc_lock_aspect.isChecked():
            self._emit_props_changed()
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
        self._emit_props_changed()

    # ---- 背景图 backgrounds[0] -----------------------------------------
    def _update_bg_label_from(self, sc: dict) -> None:
        bgs = sc.get("backgrounds")
        img = ""
        if isinstance(bgs, list) and bgs and isinstance(bgs[0], dict):
            img = str(bgs[0].get("image", "") or "").strip()
        self._sc_bg_label.setText(img or "未设置")
        self._sc_bg_derive_size.setEnabled(bool(img))
        sid = self._editing_scene_id or str(sc.get("id", "") or "")
        self._refresh_bg_thumb(sid, sc)
        # 已有深度数据时，提醒换图会让深度/碰撞失配。
        has_depth = isinstance(sc.get("depthConfig"), dict)
        self._sc_bg_depth_warn.setVisible(has_depth)
        if has_depth:
            self._sc_bg_depth_warn.setText(
                "⚠ 本场景已有深度数据（depthConfig）。更换背景图后深度/碰撞会与新图失配，"
                "需在 Scene Depth Editor 重新打开本场景、重算并导出深度。")

    def _refresh_bg_thumb(self, scene_id: str, sc: dict) -> None:
        img_path = _scene_background_disk_path(self._model, scene_id, sc)
        if img_path is None or not img_path.exists():
            self._sc_bg_thumb.setPixmap(QPixmap())
            self._sc_bg_thumb.setText("（无背景图预览）")
            return
        # 经 QImage 解码再转 QPixmap，避免同名文件被换图后命中旧缓存。
        qimg = QImage(str(img_path))
        if qimg.isNull():
            self._sc_bg_thumb.setPixmap(QPixmap())
            self._sc_bg_thumb.setText("（预览加载失败）")
            return
        pm = QPixmap.fromImage(qimg).scaledToWidth(
            240, Qt.TransformationMode.SmoothTransformation)
        self._sc_bg_thumb.setText("")
        self._sc_bg_thumb.setPixmap(pm)

    def _set_world_dims_widgets(self, ww: float, wh: float) -> None:
        """直接设世界宽高 widgets（抑制锁宽高比联动），并更新比例缓存。"""
        if ww > 0 and wh > 0:
            self._world_aspect_ratio_hw = wh / ww
        self._updating_world_dims = True
        self._sc_width.blockSignals(True)
        self._sc_height.blockSignals(True)
        try:
            self._sc_width.setValue(round(ww, 2))
            self._sc_height.setValue(round(wh, 2))
        finally:
            self._sc_width.blockSignals(False)
            self._sc_height.blockSignals(False)
        self._updating_world_dims = False

    def _on_import_background(self) -> None:
        sid = (self._editing_scene_id or "").strip()
        if not sid:
            QMessageBox.information(self, "导入背景图", "请先选择或新建一个场景。")
            return
        src, _ = QFileDialog.getOpenFileName(
            self, "选择背景图片", "",
            "图片 (*.png *.jpg *.jpeg *.webp *.bmp);;所有文件 (*.*)")
        if not src:
            return
        img = QImage(src)
        if img.isNull():
            QMessageBox.warning(self, "导入背景图", f"无法读取图片：\n{src}")
            return
        had_depth = isinstance((self._staging_scene or {}).get("depthConfig"), dict)
        try:
            dst_dir = self._model.paths.scene_runtime_dir(sid)
        except (ValueError, OSError) as exc:
            QMessageBox.warning(self, "导入背景图", f"无法解析场景资源目录：{exc}")
            return
        # 安全闸：写入目标必须落在本场景 runtime 目录内（固定 background.png），越界即抛错。
        dst = _assert_path_within(dst_dir / "background.png", dst_dir)
        dst_dir.mkdir(parents=True, exist_ok=True)
        # 把外部图迁入本场景目录：源已是 PNG 就原样字节拷贝（保真）；其它格式转码为 PNG。
        # 目标固定 background.png，替换时直接覆盖前一张；不删改任何其它文件。
        if Path(src).suffix.lower() == ".png":
            shutil.copyfile(src, dst)
        elif not img.save(str(dst), "PNG"):
            QMessageBox.warning(self, "导入背景图", f"保存失败：\n{dst}")
            return

        iw, ih = img.width(), img.height()
        # 把 backgrounds[0].image 标准化为 background.png（保留既有 x/y/z）。
        for tgt in (self._staging_scene, self._source_scene):
            if tgt is None:
                continue
            bgs = tgt.get("backgrounds")
            first = bgs[0] if isinstance(bgs, list) and bgs and isinstance(bgs[0], dict) else {}
            new_bg = dict(first)
            new_bg["image"] = "background.png"
            new_bg.setdefault("x", 0)
            new_bg.setdefault("y", 0)
            tgt["backgrounds"] = [new_bg]

        # 首次导入（世界尺寸尚未设定）按图片像素尺寸填入。
        if self._sc_width.value() <= 0 or self._sc_height.value() <= 0:
            self._set_world_dims_widgets(float(iw), float(ih))
            for tgt in (self._staging_scene, self._source_scene):
                if tgt is not None:
                    tgt["worldWidth"] = float(iw)
                    tgt["worldHeight"] = float(ih)

        self._update_bg_label_from(self._staging_scene or {})
        if sid:
            self._model.mark_dirty("scene", sid)
        self._emit_props_changed()
        self.scene_background_changed.emit()

        if had_depth:
            QMessageBox.warning(
                self, "背景已更换",
                "本场景原有深度数据（depthConfig）现已与新背景失配。\n"
                "请在主菜单「Scene Depth Editor」中重新打开本场景，重算并导出深度；"
                "在那之前游戏内的深度遮挡/碰撞仍按旧图，可能不对。")

    def _on_derive_world_size_from_bg(self) -> None:
        sid = (self._editing_scene_id or "").strip()
        sc = self._staging_scene or {}
        img_path = _scene_background_disk_path(self._model, sid, sc)
        if img_path is None or not img_path.exists():
            QMessageBox.information(self, "推导尺寸", "当前场景还没有背景图。")
            return
        pm = QPixmap(str(img_path))
        if pm.isNull() or pm.width() <= 0:
            QMessageBox.warning(self, "推导尺寸", "背景图读取失败。")
            return
        self._set_world_dims_widgets(float(pm.width()), float(pm.height()))
        self._emit_props_changed()

    def flush_active_panel_widgets_to_staging(
        self, *, only_shared_scene_staging: bool = False,
    ) -> None:
        """把当前可见面板控件写入对应 staging。

        only_shared_scene_staging=True 时仅对 scene/spawn 面板起作用——这两个
        面板都写到共享的 _staging_scene，切换面板时如果不先 flush，那 widgets
        里的修改会因新面板不会覆盖 _staging_scene 而被遗忘（spawn 写 spawnPoint /
        spawnPoints；scene 写 worldWidth 等顶级字段）。hotspot/npc/zone 走独立
        staging dict，切换会被新选中实体的 _staging_* 整体覆盖（auto-discard），
        没有 flush 必要。
        """
        w = self._stack.currentWidget()
        if w == self._scene_panel and self._staging_scene is not None:
            self._flush_scene_widgets_into(self._staging_scene)
            return
        if (
            w == self._spawn_panel
            and self._spawn_flush_scene is not None
            and self._spawn_scene is not None
        ):
            self._write_spawn_widgets_to_dict(self._spawn_scene)
            return
        if only_shared_scene_staging:
            return
        if w == self._hotspot_panel and self._staging_hotspot is not None:
            self._write_hotspot_widgets_to_dict(self._staging_hotspot)
        elif w == self._npc_panel and self._staging_npc is not None:
            self._write_npc_widgets_to_dict(self._staging_npc)
        elif w == self._zone_panel and self._staging_zone is not None:
            self._write_zone_widgets_to_dict(self._staging_zone)

    # ---- canvas → widget sync (画布拖动后回写右侧面板) -----------------

    def sync_hotspot_xy_widgets(self, eid: str, x: float, y: float) -> None:
        """画布拖动 hotspot 后回写右侧 x/y。命中当前编辑实体时才回写；blockSignals
        避免触发 _on_hs_xy_live_refresh；同时刷新局部 collision 表的世界坐标显示。"""
        if self._stack.currentWidget() != self._hotspot_panel:
            return
        hs = self._pending_hotspot
        if hs is None or str(hs.get("id", "")) != str(eid):
            return
        rx = round(float(x), 1)
        ry = round(float(y), 1)
        self._hs_x.blockSignals(True)
        self._hs_y.blockSignals(True)
        try:
            self._hs_x.setValue(rx)
            self._hs_y.setValue(ry)
        finally:
            self._hs_x.blockSignals(False)
            self._hs_y.blockSignals(False)
        if self._hs_col_enable.isChecked():
            col = hs.get("collisionPolygon")
            if (
                isinstance(col, list)
                and len(col) >= 3
                and hs.get("collisionPolygonLocal") is True
            ):
                self._hs_col_updating = True
                try:
                    self._set_hs_col_table(_hotspot_collision_local_to_world(hs, col))
                finally:
                    self._hs_col_updating = False
        self._emit_props_changed()

    def sync_npc_xy_widgets(self, eid: str, x: float, y: float) -> None:
        """画布拖动 NPC 后回写右侧 x/y；行为对应 sync_hotspot_xy_widgets。"""
        if self._stack.currentWidget() != self._npc_panel:
            return
        npc = self._pending_npc
        if npc is None or str(npc.get("id", "")) != str(eid):
            return
        rx = round(float(x), 1)
        ry = round(float(y), 1)
        self._npc_x.blockSignals(True)
        self._npc_y.blockSignals(True)
        try:
            self._npc_x.setValue(rx)
            self._npc_y.setValue(ry)
        finally:
            self._npc_x.blockSignals(False)
            self._npc_y.blockSignals(False)
        if self._npc_col_enable.isChecked():
            col = npc.get("collisionPolygon")
            if (
                isinstance(col, list)
                and len(col) >= 3
                and npc.get("collisionPolygonLocal") is True
            ):
                self._npc_col_updating = True
                try:
                    self._set_npc_col_table(_hotspot_collision_local_to_world(npc, col))
                finally:
                    self._npc_col_updating = False
        self._emit_props_changed()

    def sync_spawn_xy_widgets(self, key: str, x: float, y: float) -> None:
        """画布拖动 spawn 后回写右侧 x/y。"""
        if self._stack.currentWidget() != self._spawn_panel:
            return
        if str(self._spawn_name_original or "") != str(key):
            return
        rx = round(float(x), 1)
        ry = round(float(y), 1)
        self._sp_x.blockSignals(True)
        self._sp_y.blockSignals(True)
        try:
            self._sp_x.setValue(rx)
            self._sp_y.setValue(ry)
        finally:
            self._sp_x.blockSignals(False)
            self._sp_y.blockSignals(False)
        self._emit_props_changed()

    @staticmethod
    def _keep_num(new_val: float, old_val: object) -> object:
        """未改动的数值按原始 int/float 表示回写（1376 不漂成 1376.0）。"""
        if (
            isinstance(old_val, (int, float))
            and not isinstance(old_val, bool)
            and float(old_val) == float(new_val)
        ):
            return old_val
        return new_val

    def _flush_scene_widgets_into(self, sc: dict) -> None:
        sc["name"] = self._sc_name.text()
        ww = self._sc_width.value()
        if ww > 0:
            sc["worldWidth"] = self._keep_num(ww, sc.get("worldWidth"))
        wh = self._sc_height.value()
        if wh > 0:
            sc["worldHeight"] = self._keep_num(wh, sc.get("worldHeight"))
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
        # 场景本无 camera 且取值仍是运行时默认（zoom=1, ppu=1）→ 不注入 camera 块
        zoom_v = self._sc_zoom.value()
        ppu_v = self._sc_ppu.value()
        if "camera" in sc or zoom_v != 1 or ppu_v != 1:
            cam = sc.setdefault("camera", {})
            cam["zoom"] = self._keep_num(zoom_v, cam.get("zoom"))
            cam["pixelsPerUnit"] = self._keep_num(ppu_v, cam.get("pixelsPerUnit"))
        sc_scale = self._sc_scale.value()
        if sc_scale != 1:
            sc["worldScale"] = self._keep_num(sc_scale, sc.get("worldScale"))
        elif "worldScale" in sc:
            del sc["worldScale"]
        ws = self._sc_walk.value()
        if ws > 0:
            sc["playerWalkSpeed"] = self._keep_num(ws, sc.get("playerWalkSpeed"))
        elif "playerWalkSpeed" in sc:
            del sc["playerWalkSpeed"]
        rs = self._sc_run.value()
        if rs > 0:
            sc["playerRunSpeed"] = self._keep_num(rs, sc.get("playerRunSpeed"))
        elif "playerRunSpeed" in sc:
            del sc["playerRunSpeed"]
        dc_save = sc.get("depthConfig")
        if isinstance(dc_save, dict):
            dc_save["depth_tolerance"] = self._keep_num(
                float(self._sc_depth_tol.value()), dc_save.get("depth_tolerance"))
            dc_save["floor_offset"] = self._keep_num(
                float(self._sc_floor_offset.value()), dc_save.get("floor_offset"))
        ambs = self._ambient_ids_from_widgets()
        if ambs:
            sc["ambientSounds"] = ambs
        elif "ambientSounds" in sc:
            del sc["ambientSounds"]
        oe = self._sc_on_enter.to_list()
        if oe:
            sc["onEnter"] = oe
        elif "onEnter" in sc:
            del sc["onEnter"]
        lc_pts = [
            {"x": round(float(p.get("x", 0)), 2), "y": round(float(p.get("y", 0)), 2),
             "env": copy.deepcopy(p.get("env")) if isinstance(p.get("env"), dict) else {}}
            for p in self._sc_lightcurve_points
        ]
        if lc_pts:
            sc["lightEnvCurve"] = {"points": lc_pts}
        elif "lightEnvCurve" in sc:
            del sc["lightEnvCurve"]
        self._emit_props_changed()

    # ---- 光环境曲线 lightEnvCurve --------------------------------------
    def _fill_lc_table(self, *, select_row: int = -1) -> None:
        self._lc_table_updating = True
        try:
            self._lc_table.blockSignals(True)
            self._lc_table.setRowCount(0)
            for i, p in enumerate(self._sc_lightcurve_points):
                r = self._lc_table.rowCount()
                self._lc_table.insertRow(r)
                for col, txt in (
                    (0, str(i)),
                    (1, f"{float(p.get('x', 0)):.2f}"),
                    (2, f"{float(p.get('y', 0)):.2f}"),
                ):
                    it = QTableWidgetItem(txt)
                    it.setFlags(it.flags() & ~Qt.ItemFlag.ItemIsEditable)
                    self._lc_table.setItem(r, col, it)
            self._lc_table.blockSignals(False)
            n = len(self._sc_lightcurve_points)
            if n > 0:
                tgt = select_row if 0 <= select_row < n else min(max(self._lc_selected, 0), n - 1)
                self._lc_table.selectRow(tgt)
        finally:
            self._lc_table_updating = False
        self._on_lc_row_selected()

    def _on_lc_row_selected(self) -> None:
        if self._lc_table_updating:
            return
        row = self._lc_table.currentRow()
        n = len(self._sc_lightcurve_points)
        self._lc_selected = row
        has = 0 <= row < n
        self._lc_env_editor.setEnabled(has)
        self._lc_del.setEnabled(has)
        self._lc_up.setEnabled(has and row > 0)
        self._lc_down.setEnabled(has and row < n - 1)
        if has:
            self._lc_env_editor.set_env(self._sc_lightcurve_points[row].get("env"))
        # 让画布 gizmo 高亮跟随选中行
        self.lightcurve_overlay_refresh_requested.emit()

    def _on_lc_env_changed(self) -> None:
        row = self._lc_selected
        if not (0 <= row < len(self._sc_lightcurve_points)):
            return
        self._sc_lightcurve_points[row]["env"] = self._lc_env_editor.get_env()
        self._emit_props_changed()
        # 同步给画布 overlay 的 env 副本(避免之后拖拽提交时用旧 env 覆盖)
        self.lightcurve_overlay_refresh_requested.emit()

    def _on_lc_add_point(self) -> None:
        st = self._staging_scene or {}
        ww = float(st.get("worldWidth", 0) or 0)
        wh = float(st.get("worldHeight", 0) or 0)
        if self._sc_lightcurve_points:
            last = self._sc_lightcurve_points[-1]
            nx, ny = float(last["x"]) + 60.0, float(last["y"])
            env = (copy.deepcopy(last["env"]) if isinstance(last.get("env"), dict) and last["env"]
                   else copy.deepcopy(_LC_BASELINE_ENV))
        else:
            nx, ny = (ww / 2 if ww > 0 else 400.0), (wh / 2 if wh > 0 else 300.0)
            env = copy.deepcopy(_LC_BASELINE_ENV)
        if ww > 0:
            nx = max(0.0, min(ww, nx))
        if wh > 0:
            ny = max(0.0, min(wh, ny))
        self._sc_lightcurve_points.append({"x": round(nx, 2), "y": round(ny, 2), "env": env})
        self._emit_props_changed()
        self._fill_lc_table(select_row=len(self._sc_lightcurve_points) - 1)
        self.lightcurve_overlay_refresh_requested.emit()

    def _on_lc_remove_point(self) -> None:
        row = self._lc_selected
        if not (0 <= row < len(self._sc_lightcurve_points)):
            return
        del self._sc_lightcurve_points[row]
        self._emit_props_changed()
        self._fill_lc_table(select_row=min(row, len(self._sc_lightcurve_points) - 1))
        self.lightcurve_overlay_refresh_requested.emit()

    def _on_lc_move(self, delta: int) -> None:
        row = self._lc_selected
        n = len(self._sc_lightcurve_points)
        j = row + delta
        if not (0 <= row < n and 0 <= j < n):
            return
        pts = self._sc_lightcurve_points
        pts[row], pts[j] = pts[j], pts[row]
        self._emit_props_changed()
        self._fill_lc_table(select_row=j)
        self.lightcurve_overlay_refresh_requested.emit()

    def apply_lightcurve_committed(self, points: object) -> None:
        """画布 overlay 拖/插/删后回写到面板单一真相源,刷新表+脏标记(overlay 已最新,不回发刷新)。"""
        if not isinstance(points, list):
            return
        norm: list[dict] = []
        for p in points:
            if isinstance(p, dict):
                norm.append({
                    "x": round(float(p.get("x", 0)), 2),
                    "y": round(float(p.get("y", 0)), 2),
                    "env": copy.deepcopy(p["env"]) if isinstance(p.get("env"), dict) else {},
                })
        self._sc_lightcurve_points = norm
        self._emit_props_changed()
        sel = self._lc_selected if 0 <= self._lc_selected < len(norm) else (0 if norm else -1)
        self._fill_lc_table(select_row=sel)

    def _load_lightcurve(self, st: dict) -> None:
        lec = st.get("lightEnvCurve")
        pts: list[dict] = []
        if isinstance(lec, dict) and isinstance(lec.get("points"), list):
            for raw in lec["points"]:
                if not isinstance(raw, dict):
                    continue
                pts.append({
                    "x": float(raw.get("x", 0) or 0),
                    "y": float(raw.get("y", 0) or 0),
                    "env": copy.deepcopy(raw["env"]) if isinstance(raw.get("env"), dict) else {},
                })
        self._sc_lightcurve_points = pts
        self._lc_selected = -1
        self._sc_lightcurve_fold.set_expanded(bool(pts))
        self._fill_lc_table(select_row=0 if pts else -1)
        self.lightcurve_overlay_refresh_requested.emit()

    def commit_scene_staging_to_source(self) -> None:
        """Apply：把场景 staging 中非列表字段提交回模型（含 spawnPoint/spawnPoints）。"""
        src = self._source_scene
        st = self._staging_scene
        if src is None or st is None:
            return
        skip = {"hotspots", "npcs", "zones"}
        for key, val in list(st.items()):
            if key in skip:
                continue
            src[key] = copy.deepcopy(val)
        for key in list(src.keys()):
            if key in skip:
                continue
            if key not in st:
                del src[key]

    def save_scene_props(self) -> None:
        if self._staging_scene is None:
            return
        if self._stack.currentWidget() != self._scene_panel:
            return
        self._flush_scene_widgets_into(self._staging_scene)

    def _entity_cutscene_ids_from_data(self, ent: dict) -> list[str]:
        return _entity_cutscene_ids_from_data(ent)

    def _entity_has_cutscene_binding(self, ent: dict) -> bool:
        return len(self._entity_cutscene_ids_from_data(ent)) > 0

    def _entity_is_cutscene_only(self, ent: dict) -> bool:
        return self._entity_has_cutscene_binding(ent) and ent.get("cutsceneOnly", True) is not False

    def _format_cutscene_ids_label(self, ids: list[str]) -> str:
        return "、".join(ids) if ids else "（未关联）"

    def _set_cutscene_only_checkbox(
        self, checkbox: QCheckBox, *, has_binding: bool, checked: bool,
    ) -> None:
        checkbox.blockSignals(True)
        try:
            checkbox.setEnabled(has_binding)
            checkbox.setChecked(bool(has_binding and checked))
        finally:
            checkbox.blockSignals(False)

    def _sync_hs_cutscene_only_checkbox(self, *, previous_has_binding: bool | None = None) -> None:
        has_binding = bool(self._hs_cutscene_ids_pending)
        if previous_has_binding is None:
            checked = self._entity_is_cutscene_only(self._staging_hotspot or {})
        elif has_binding and not previous_has_binding:
            checked = True
        else:
            checked = self._hs_cutscene_only.isChecked()
        self._set_cutscene_only_checkbox(
            self._hs_cutscene_only, has_binding=has_binding, checked=checked,
        )

    def _sync_npc_cutscene_only_checkbox(self, *, previous_has_binding: bool | None = None) -> None:
        has_binding = bool(self._npc_cutscene_ids_pending)
        if previous_has_binding is None:
            checked = self._entity_is_cutscene_only(self._staging_npc or {})
        elif has_binding and not previous_has_binding:
            checked = True
        else:
            checked = self._npc_cutscene_only.isChecked()
        self._set_cutscene_only_checkbox(
            self._npc_cutscene_only, has_binding=has_binding, checked=checked,
        )

    def _pick_cutscene_ids(self, current: list[str]) -> list[str] | None:
        dlg = QDialog(self)
        dlg.setWindowTitle("选择关联过场")
        dlg.resize(420, 520)
        lay = QVBoxLayout(dlg)
        hint = QLabel("可多选。这里写入 cutsceneIds，作为实体参与过场的唯一绑定来源。")
        hint.setWordWrap(True)
        lay.addWidget(hint)
        lw = QListWidget(dlg)
        lw.setSelectionMode(QAbstractItemView.SelectionMode.MultiSelection)
        search = make_list_search_box(
            lw, tooltip="按过场 id 过滤下方列表（仅隐藏不匹配项，不影响已勾选项）。")
        lay.addWidget(search)
        all_ids = sorted({str(a).strip() for a, _ in self._model.all_cutscene_ids() if str(a).strip()})
        cur = {x for x in current if x}
        for cid in all_ids:
            it = QListWidgetItem(cid)
            if cid in cur:
                it.setSelected(True)
            lw.addItem(it)
        lay.addWidget(lw, 1)
        bbox = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=dlg,
        )
        bbox.accepted.connect(dlg.accept)
        bbox.rejected.connect(dlg.reject)
        lay.addWidget(bbox)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return None
        return [it.text() for it in lw.selectedItems()]

    # ---- 位面归属（planes）--------------------------------------------------

    def _entity_plane_ids_from_data(self, ent: dict) -> list[str]:
        raw = ent.get("planes")
        if not isinstance(raw, list):
            return []
        return [str(x).strip() for x in raw if str(x).strip()]

    def _format_plane_ids_label(self, ids: list[str]) -> str:
        return "、".join(ids) if ids else "（所有位面）"

    def _pick_plane_ids(self, current: list[str]) -> list[str] | None:
        dlg = QDialog(self)
        dlg.setWindowTitle("选择位面归属")
        dlg.resize(420, 520)
        lay = QVBoxLayout(dlg)
        hint = QLabel(
            "可多选。写入实体的 planes 字段：实体仅存在于所选位面；"
            "全不选（清空）= 缺省 = 存在于所有位面。候选来自 planes.json（位面面板维护）。",
        )
        hint.setWordWrap(True)
        lay.addWidget(hint)
        lw = QListWidget(dlg)
        lw.setSelectionMode(QAbstractItemView.SelectionMode.MultiSelection)
        search = make_list_search_box(
            lw, tooltip="按位面 id / 名称过滤下方列表（仅隐藏不匹配项，不影响已勾选项）。")
        lay.addWidget(search)
        pairs = [(pid, label) for pid, label in self._model.all_plane_ids() if pid]
        known = {pid for pid, _ in pairs}
        cur = [x for x in current if x]
        # 保值孤儿项：数据里引用了当前 planes.json 没有的位面 id，仍列出可去勾，不无声丢。
        for orphan in cur:
            if orphan not in known:
                pairs.append((orphan, f"{orphan}（未登记）"))
        cur_set = set(cur)
        for pid, label in pairs:
            text = pid if (not label or label == pid) else f"{pid} — {label}"
            it = QListWidgetItem(text)
            it.setData(Qt.ItemDataRole.UserRole, pid)
            if pid in cur_set:
                it.setSelected(True)
            lw.addItem(it)
        lay.addWidget(lw, 1)
        bbox = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=dlg,
        )
        bbox.accepted.connect(dlg.accept)
        bbox.rejected.connect(dlg.reject)
        lay.addWidget(bbox)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return None
        return [str(it.data(Qt.ItemDataRole.UserRole)) for it in lw.selectedItems()]

    def _open_hs_plane_ids_picker(self) -> None:
        picked = self._pick_plane_ids(self._hs_plane_ids_pending)
        if picked is None:
            return
        self._hs_plane_ids_pending = picked
        self._hs_plane_ids_label.setText(self._format_plane_ids_label(picked))
        self._emit_props_changed()

    def _clear_hs_plane_ids(self) -> None:
        self._hs_plane_ids_pending = []
        self._hs_plane_ids_label.setText(self._format_plane_ids_label([]))
        self._emit_props_changed()

    def _open_npc_plane_ids_picker(self) -> None:
        picked = self._pick_plane_ids(self._npc_plane_ids_pending)
        if picked is None:
            return
        self._npc_plane_ids_pending = picked
        self._npc_plane_ids_label.setText(self._format_plane_ids_label(picked))
        self._emit_props_changed()

    def _clear_npc_plane_ids(self) -> None:
        self._npc_plane_ids_pending = []
        self._npc_plane_ids_label.setText(self._format_plane_ids_label([]))
        self._emit_props_changed()

    def _open_zn_plane_ids_picker(self) -> None:
        picked = self._pick_plane_ids(self._zn_plane_ids_pending)
        if picked is None:
            return
        self._zn_plane_ids_pending = picked
        self._zn_plane_ids_label.setText(self._format_plane_ids_label(picked))
        self._emit_props_changed()

    def _clear_zn_plane_ids(self) -> None:
        self._zn_plane_ids_pending = []
        self._zn_plane_ids_label.setText(self._format_plane_ids_label([]))
        self._emit_props_changed()

    def _make_plane_ids_row(self, label_attr: str, on_pick, on_clear) -> QWidget:
        """「只读 label + 选择位面… + 清除」行（hotspot/npc/zone 共用）。"""
        row = QWidget()
        rl = QHBoxLayout(row)
        rl.setContentsMargins(0, 0, 0, 0)
        lbl = QLabel(self._format_plane_ids_label([]))
        lbl.setWordWrap(True)
        lbl.setToolTip(
            "位面归属：实体仅存在于所列位面；缺省（空）=存在于所有位面。"
            "候选来自 planes.json（位面面板维护）。",
        )
        setattr(self, label_attr, lbl)
        btn_pick = QPushButton("选择位面…")
        btn_pick.setToolTip("多选该实体归属的位面（写入 planes 字段）")
        btn_pick.clicked.connect(on_pick)
        btn_clear = QPushButton("清除")
        btn_clear.setToolTip("清空 planes（回到缺省=存在于所有位面）")
        btn_clear.clicked.connect(on_clear)
        rl.addWidget(lbl, 1)
        rl.addWidget(btn_pick)
        rl.addWidget(btn_clear)
        return row

    def _open_hs_cutscene_ids_picker(self) -> None:
        previous_has_binding = bool(self._hs_cutscene_ids_pending)
        picked = self._pick_cutscene_ids(self._hs_cutscene_ids_pending)
        if picked is None:
            return
        self._hs_cutscene_ids_pending = picked
        self._hs_cutscene_ids_label.setText(self._format_cutscene_ids_label(picked))
        self._sync_hs_cutscene_only_checkbox(previous_has_binding=previous_has_binding)
        self._on_entity_cutscene_bindings_changed()

    def _clear_hs_cutscene_ids(self) -> None:
        previous_has_binding = bool(self._hs_cutscene_ids_pending)
        self._hs_cutscene_ids_pending = []
        self._hs_cutscene_ids_label.setText(self._format_cutscene_ids_label([]))
        self._sync_hs_cutscene_only_checkbox(previous_has_binding=previous_has_binding)
        self._on_entity_cutscene_bindings_changed()

    def _open_npc_cutscene_ids_picker(self) -> None:
        previous_has_binding = bool(self._npc_cutscene_ids_pending)
        picked = self._pick_cutscene_ids(self._npc_cutscene_ids_pending)
        if picked is None:
            return
        self._npc_cutscene_ids_pending = picked
        self._npc_cutscene_ids_label.setText(self._format_cutscene_ids_label(picked))
        self._sync_npc_cutscene_only_checkbox(previous_has_binding=previous_has_binding)
        self._on_entity_cutscene_bindings_changed()

    def _clear_npc_cutscene_ids(self) -> None:
        previous_has_binding = bool(self._npc_cutscene_ids_pending)
        self._npc_cutscene_ids_pending = []
        self._npc_cutscene_ids_label.setText(self._format_cutscene_ids_label([]))
        self._sync_npc_cutscene_only_checkbox(previous_has_binding=previous_has_binding)
        self._on_entity_cutscene_bindings_changed()

    def _on_entity_cutscene_bindings_changed(self, _v: object = None) -> None:
        self._emit_props_changed()

    def flush_pending_to_model(self) -> None:
        """把当前可见面板的控件值写入对应 staging dict。
        只写 staging，不 commit 到 source（commit 由 SceneEditor._apply_props 负责）。
        历史实现里同时 flush 当前面板 + 遍历每个 _pending_* 重写一遍是冗余的，
        因为 _pending_* 与 _staging_* 是同一对象，且只有可见面板的 widgets 才
        承载用户最新输入；其它已离开的实体的 _pending_* 早已与 widgets 无关。
        """
        from ..editor_perf import perf_log_enabled

        # 该 flush 既走 Save All，也走 commit-on-leave（切实体/切场景）。性能戳只在
        # 显式开启 perf 日志时打印，避免每次切换都喷 [SaveAll] 噪声（且名不副实）。
        log_on = perf_log_enabled()
        t0 = time.perf_counter()
        last = t0

        def _stamp(msg: str) -> None:
            nonlocal last
            if not log_on:
                return
            wall = datetime.now().strftime("%H:%M:%S.%f")[:-3]
            now = time.perf_counter()
            print(
                f"[SaveAll {wall}] ScenePropertyPanel {msg}  "
                f"Δ{now - last:.3f}s  Σ{now - t0:.3f}s",
                flush=True,
            )
            last = now

        stack_name = type(self._stack.currentWidget()).__name__
        self.flush_active_panel_widgets_to_staging()
        _stamp(f"flush_active_panel_widgets_to_staging（属性栈顶={stack_name}）")

    # ---- hotspot props ----------------------------------------------------

    def _build_hotspot_panel(self) -> QWidget:
        root = QWidget()
        lay = QVBoxLayout(root)
        lay.setAlignment(Qt.AlignmentFlag.AlignTop)
        basic_g = self._section("基本：id、类型、位置与交互", start_open=True)
        basic_inner = QWidget()
        form = compact_form(QFormLayout(basic_inner))
        self._hs_id = QLineEdit(); form.addRow("id", self._hs_id)
        self._hs_id.textChanged.connect(lambda *_: self._emit_props_changed())
        self._hs_type = QComboBox()
        self._hs_type.addItems(["inspect", "pickup", "transition", "npc", "encounter"])
        self._hs_type.currentIndexChanged.connect(lambda _i: self._emit_props_changed())
        form.addRow("type", self._hs_type)
        self._hs_label = RichTextLineEdit(self._model); form.addRow("label", self._hs_label)
        self._hs_label.textChanged.connect(lambda *_: self._emit_props_changed())
        self._hs_x = QDoubleSpinBox(); self._hs_x.setRange(-99999, 99999); self._hs_x.setDecimals(1)
        self._hs_x.valueChanged.connect(self._on_hs_xy_live_refresh)
        form.addRow("x", self._hs_x)
        self._hs_y = QDoubleSpinBox(); self._hs_y.setRange(-99999, 99999); self._hs_y.setDecimals(1)
        self._hs_y.valueChanged.connect(self._on_hs_xy_live_refresh)
        form.addRow("y", self._hs_y)
        self._hs_range = QDoubleSpinBox(); self._hs_range.setRange(0, 99999)
        form.addRow("interactionRange", self._hs_range)
        self._hs_range.valueChanged.connect(self._on_hotspot_interaction_range_live)
        self._hs_auto = QCheckBox(); form.addRow("autoTrigger", self._hs_auto)
        self._hs_auto.stateChanged.connect(lambda _s: self._emit_props_changed())
        self._hs_cast_shadow = QCheckBox("投射阴影 + 接触AO")
        self._hs_cast_shadow.setToolTip(
            "缺省开启：有展示图的热区在地面投射阴影并带脚下接触 AO。"
            "关闭则此热区不投影也无接触 AO（仅对有展示图的热区有效）。"
        )
        self._hs_cast_shadow.stateChanged.connect(lambda _s: self._emit_props_changed())
        form.addRow("castShadow", self._hs_cast_shadow)
        self._hs_cutscene_only = QCheckBox("仅过场实体（普通场景不生成）")
        self._hs_cutscene_only.setToolTip(
            "默认开启：实体只在关联过场中从场景文件初始化，不读 committed sceneMemory。"
            "关闭：普通场景也存在，进出关联过场时会从场景文件 + committed sceneMemory 重建。"
        )
        self._hs_cutscene_only.toggled.connect(self._on_entity_cutscene_bindings_changed)
        form.addRow("cutsceneOnly", self._hs_cutscene_only)
        hs_multi_row = QWidget()
        hs_multi_l = QHBoxLayout(hs_multi_row)
        hs_multi_l.setContentsMargins(0, 0, 0, 0)
        self._hs_cutscene_ids_label = QLabel("（未关联）")
        self._hs_cutscene_ids_label.setWordWrap(True)
        self._hs_cutscene_ids_btn = QPushButton("选择多个…")
        self._hs_cutscene_ids_btn.clicked.connect(self._open_hs_cutscene_ids_picker)
        self._hs_cutscene_ids_clear_btn = QPushButton("清除")
        self._hs_cutscene_ids_clear_btn.setToolTip("清空 cutsceneIds，并移除 cutsceneOnly 绑定语义。")
        self._hs_cutscene_ids_clear_btn.clicked.connect(self._clear_hs_cutscene_ids)
        hs_multi_l.addWidget(self._hs_cutscene_ids_label, 1)
        hs_multi_l.addWidget(self._hs_cutscene_ids_btn)
        hs_multi_l.addWidget(self._hs_cutscene_ids_clear_btn)
        form.addRow("cutsceneIds", hs_multi_row)
        form.addRow("位面归属", self._make_plane_ids_row(
            "_hs_plane_ids_label",
            self._open_hs_plane_ids_picker,
            self._clear_hs_plane_ids,
        ))
        basic_g.add_body(basic_inner)
        lay.addWidget(basic_g)

        cond_g = self._section("触发条件 conditions", start_open=False)
        cond_g.set_header_tool_tip("默认折叠；已配置条件时自动展开。")
        self._hs_cond_fold = cond_g
        cond_inner = QWidget()
        cond_l = QVBoxLayout(cond_inner)
        self._hs_cond_hide_entity = QCheckBox("条件不满足时隐藏实体")
        self._hs_cond_hide_entity.setToolTip(
            "需在下方配置非空 conditions；"
            "勾选后条件失败时热点不渲染且不可碰撞（仍受 sceneMemory / 过场基底显隐约束）。",
        )
        self._hs_cond_hide_entity.stateChanged.connect(lambda _s: self._emit_props_changed())
        cond_l.addWidget(self._hs_cond_hide_entity)
        self._hs_cond = ConditionEditor("Conditions")
        self._hs_cond.changed.connect(self._emit_props_changed)
        cond_l.addWidget(self._hs_cond)
        cond_g.add_body(cond_inner)
        lay.addWidget(cond_g)

        disp = CollapsibleSection("显示图（可选）", start_open=False)
        disp.set_header_tool_tip(
            "底边中点对齐 x,y；世界宽高可独立编辑，换图不会自动改尺寸；"
            "「自动」按当前图素比从另一维推导。默认折叠，配置立绘/展示图时展开。"
        )
        disp_inner = QWidget()
        dlay = QVBoxLayout(disp_inner)
        self._hs_disp_row = CutsceneImagePathRow(
            self._model, "", self,
            external_copy_subdir="illustrations",
        )
        self._hs_disp_row.changed.connect(self._on_hs_display_row_changed)
        dlay.addWidget(self._hs_disp_row)
        df = compact_form(QFormLayout())
        ww_row = QWidget()
        ww_h = QHBoxLayout(ww_row)
        ww_h.setContentsMargins(0, 0, 0, 0)
        self._hs_disp_ww = QDoubleSpinBox()
        self._hs_disp_ww.setRange(1, 999999)
        self._hs_disp_ww.setDecimals(1)
        self._hs_disp_ww.setSingleStep(1.0)
        self._hs_disp_ww.setValue(100)
        self._hs_disp_ww.setToolTip("世界宽度（世界单位）；可手输或拖动下方滑块")
        self._hs_disp_ww.valueChanged.connect(self._on_hs_disp_ww_value_changed)
        self._hs_disp_auto_h_btn = QPushButton("自动")
        self._hs_disp_auto_h_btn.setToolTip(
            "按当前图片长宽比，用已填的 worldWidth 计算 worldHeight（无有效图片时禁用）",
        )
        self._hs_disp_auto_h_btn.clicked.connect(self._on_hs_disp_auto_height_from_width)
        ww_h.addWidget(self._hs_disp_ww, 1)
        ww_h.addWidget(self._hs_disp_auto_h_btn)
        df.addRow("worldWidth", ww_row)
        self._hs_disp_ww_slider = QSlider(Qt.Orientation.Horizontal)
        self._hs_disp_ww_slider.setRange(100, 10_000)
        self._hs_disp_ww_slider.setValue(1000)
        self._hs_disp_ww_slider.setToolTip(
            "拖动调节世界宽度（约 10～1000，与上方数值同步，步进 0.1；超出范围可手输）"
        )
        self._hs_disp_ww_slider.valueChanged.connect(self._on_hs_disp_ww_slider_changed)
        df.addRow(self._hs_disp_ww_slider)
        hh_row = QWidget()
        hh_h = QHBoxLayout(hh_row)
        hh_h.setContentsMargins(0, 0, 0, 0)
        self._hs_disp_hh = QDoubleSpinBox()
        self._hs_disp_hh.setRange(1, 999999)
        self._hs_disp_hh.setDecimals(1)
        self._hs_disp_hh.setSingleStep(1.0)
        self._hs_disp_hh.setValue(100)
        self._hs_disp_hh.setToolTip("世界高度（世界单位）")
        self._hs_disp_hh.valueChanged.connect(self._on_hs_disp_hh_value_changed)
        self._hs_disp_auto_w_btn = QPushButton("自动")
        self._hs_disp_auto_w_btn.setToolTip(
            "按当前图片长宽比，用已填的 worldHeight 计算 worldWidth（无有效图片时禁用）",
        )
        self._hs_disp_auto_w_btn.clicked.connect(self._on_hs_disp_auto_width_from_height)
        hh_h.addWidget(self._hs_disp_hh, 1)
        hh_h.addWidget(self._hs_disp_auto_w_btn)
        df.addRow("worldHeight", hh_row)
        self._hs_disp_ratio_hint = QLabel("")
        self._hs_disp_ratio_hint.setStyleSheet("color:#888;")
        self._hs_disp_ratio_hint.setWordWrap(True)
        df.addRow("", self._hs_disp_ratio_hint)
        self._hs_disp_facing = QComboBox()
        self._hs_disp_facing.addItem("朝右（默认）", "right")
        self._hs_disp_facing.addItem("朝左", "left")
        self._hs_disp_facing.setToolTip("展示图水平镜像，与 NPC initialFacing 一致")
        self._hs_disp_facing.currentIndexChanged.connect(self._on_hs_disp_facing_changed)
        df.addRow("朝向", self._hs_disp_facing)
        self._hs_disp_sprite_sort = QComboBox()
        self._hs_disp_sprite_sort.addItem("与角色/NPC 同层（按 Y）", "default")
        self._hs_disp_sprite_sort.addItem("永远画在最底层", "back")
        self._hs_disp_sprite_sort.addItem("永远画在最顶层", "front")
        self._hs_disp_sprite_sort.setToolTip(
            "仅运行时有效：同一 entityLayer 内与玩家、NPC 的叠放；"
            "最底/最顶仍会在同档热点之间按 Y 细分。"
        )
        self._hs_disp_sprite_sort.currentIndexChanged.connect(self._on_hs_disp_sprite_sort_changed)
        df.addRow("精灵排序", self._hs_disp_sprite_sort)
        dlay.addLayout(df)
        disp.add_body(disp_inner)
        self._hs_disp_fold = disp
        lay.addWidget(disp)

        colg = CollapsibleSection(
            "碰撞多边形（可选，世界坐标；区域内阻挡行走）",
            start_open=False,
        )
        colg.set_header_tool_tip("默认折叠；需要行走阻挡时展开")
        col_inner = QWidget()
        clay = QVBoxLayout(col_inner)
        self._hs_col_enable = QCheckBox("启用碰撞多边形")
        self._hs_col_enable.toggled.connect(self._on_hs_collision_toggle)
        clay.addWidget(self._hs_col_enable)
        col_hint = QLabel(
            "与 Zone 相同：拖顶点、拖内部平移、双击边插点、Shift+单击删点；"
            "侧栏表格与画布双向同步。")
        col_hint.setWordWrap(True)
        clay.addWidget(col_hint)
        self._hs_col_table = QTableWidget(0, 3)
        self._hs_col_table.setHorizontalHeaderLabels(["#", "x", "y"])
        self._hs_col_table.horizontalHeader().setSectionResizeMode(
            0, QHeaderView.ResizeMode.ResizeToContents)
        self._hs_col_table.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.Stretch)
        self._hs_col_table.horizontalHeader().setSectionResizeMode(
            2, QHeaderView.ResizeMode.Stretch)
        self._hs_col_table.setMinimumHeight(140)
        self._hs_col_table.itemChanged.connect(self._on_hs_col_cell_changed)
        self._install_vertex_table_affordances(
            self._hs_col_table, self._on_hs_col_remove_vertex)
        clay.addWidget(self._hs_col_table)
        col_btns = QHBoxLayout()
        self._hs_col_add = QPushButton("添加顶点")
        self._hs_col_add.clicked.connect(self._on_hs_col_add_vertex)
        self._hs_col_del = QPushButton("删除选中顶点")
        self._hs_col_del.clicked.connect(self._on_hs_col_remove_vertex)
        col_btns.addWidget(self._hs_col_add)
        col_btns.addWidget(self._hs_col_del)
        clay.addLayout(col_btns)
        colg.add_body(col_inner)
        self._hs_col_fold = colg
        lay.addWidget(colg)
        self._hs_col_updating = False

        data_g = self._section("按类型的数据（inspect / pickup / transition …）", start_open=False)
        data_g.set_header_tool_tip("默认折叠；已配置数据时自动展开。")
        self._hs_data_fold = data_g
        data_inner = QWidget()
        data_l = QVBoxLayout(data_inner)
        self._hs_data_stack = QStackedWidget()
        data_l.addWidget(self._hs_data_stack)
        data_g.add_body(data_inner)
        lay.addWidget(data_g)

        # inspect data（无 graphId 时仅配置 actions；与图对话 graphId 互斥）
        ip = QWidget()
        il = QVBoxLayout(ip)
        mode_row = QHBoxLayout()
        self._hs_inspect_mode_group = QButtonGroup(self)
        self._hs_inspect_mode_actions = QRadioButton("Actions（无图对话）")
        self._hs_inspect_mode_graph = QRadioButton("图对话（graphId）")
        self._hs_inspect_mode_actions.setChecked(True)
        self._hs_inspect_mode_actions.setToolTip(
            "不写 graphId：按 E 后不进入图对话；直接执行下方 actions（可走图对话/弹层等其它动作）。",
        )
        self._hs_inspect_mode_group.addButton(self._hs_inspect_mode_actions)
        self._hs_inspect_mode_group.addButton(self._hs_inspect_mode_graph)
        mode_row.addWidget(self._hs_inspect_mode_actions)
        mode_row.addWidget(self._hs_inspect_mode_graph)
        mode_row.addStretch()
        il.addLayout(mode_row)
        graph_row = compact_form(QFormLayout())
        gcombo = FilterableTypeCombo([], self, select_only=True)
        gcombo.setMinimumWidth(160)
        self._hs_inspect_graph_combo = gcombo
        graph_row.addRow("graphId", gcombo)
        self._hs_inspect_entry = FilterableTypeCombo([("（留空）", "")], self, select_only=True)
        self._hs_inspect_entry.setMinimumWidth(160)
        self._hs_inspect_entry.setToolTip(
            "可选 entry 节点 id：从所选 graphId 的图节点中选（留空=图默认入口）。"
            "已存的未知值以「(数据)」前缀保留可选。",
        )
        graph_row.addRow("entry", self._hs_inspect_entry)
        self._hs_inspect_graph_wrap = QWidget()
        self._hs_inspect_graph_wrap.setLayout(graph_row)
        il.addWidget(self._hs_inspect_graph_wrap)
        self._hs_inspect_actions = ActionEditor("actions")
        self._hs_inspect_actions.setToolTip(
            "无图对话：按 E 后执行此处动作链。\n图对话：通常在图内 runActions；此处为图结束后的附加动作（可选）。",
        )
        self._hs_inspect_actions.changed.connect(self._emit_props_changed)
        il.addWidget(self._hs_inspect_actions)
        self._hs_data_stack.addWidget(ip)

        def _sync_inspect_mode_ui() -> None:
            graph_on = self._hs_inspect_mode_graph.isChecked()
            self._hs_inspect_graph_wrap.setVisible(graph_on)

        def _on_inspect_mode_clicked(_btn) -> None:
            _sync_inspect_mode_ui()
            self._emit_props_changed()

        self._hs_inspect_mode_group.buttonClicked.connect(_on_inspect_mode_clicked)
        for sig_widget in (gcombo, self._hs_inspect_entry):
            sig_widget.typeCommitted.connect(lambda *_: self._emit_props_changed())
        gcombo.typeCommitted.connect(lambda *_: self._refresh_inspect_entry_choices())
        _sync_inspect_mode_ui()

        # pickup data
        pp = QWidget(); pf = compact_form(QFormLayout(pp))
        self._hs_pickup_item = IdRefSelector(
            allow_empty=False, editable=False, click_opens_popup=True)
        self._hs_pickup_item.setMinimumWidth(160)
        self._hs_pickup_item.value_changed.connect(lambda _x: self._emit_props_changed())
        pf.addRow("itemId", self._hs_pickup_item)
        self._hs_pickup_name = QLineEdit(); pf.addRow("itemName", self._hs_pickup_name)
        self._hs_pickup_name.textChanged.connect(lambda *_: self._emit_props_changed())
        self._hs_pickup_count = QSpinBox(); self._hs_pickup_count.setRange(1, 999)
        pf.addRow("count", self._hs_pickup_count)
        self._hs_pickup_count.valueChanged.connect(lambda _v: self._emit_props_changed())
        self._hs_pickup_currency = QCheckBox(); pf.addRow("isCurrency", self._hs_pickup_currency)
        self._hs_pickup_currency.stateChanged.connect(lambda _s: self._emit_props_changed())
        self._hs_data_stack.addWidget(pp)

        # transition data
        tp = QWidget()
        tlv = QVBoxLayout(tp)
        tf = compact_form(QFormLayout())
        self._hs_trans_scene = IdRefSelector(
            allow_empty=False, editable=False, click_opens_popup=True)
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
        np_ = QWidget(); nf = compact_form(QFormLayout(np_))
        self._hs_npc_id = IdRefSelector(
            allow_empty=True, editable=False, click_opens_popup=True)
        self._hs_npc_id.setMinimumWidth(160)
        self._hs_npc_id.value_changed.connect(lambda _x: self._emit_props_changed())
        nf.addRow("npcId", self._hs_npc_id)
        self._hs_data_stack.addWidget(np_)

        # encounter data
        ep = QWidget(); ef = compact_form(QFormLayout(ep))
        self._hs_enc_id = IdRefSelector(
            allow_empty=False, editable=False, click_opens_popup=True)
        self._hs_enc_id.value_changed.connect(lambda _x: self._emit_props_changed())
        ef.addRow("encounterId", self._hs_enc_id)
        self._hs_data_stack.addWidget(ep)

        self._hs_type.currentTextChanged.connect(self._on_hs_type_changed)
        lay.addStretch(1)
        self._append_entity_delete_footer(lay)
        return root

    _TYPE_TO_DATA_IDX = {"inspect": 0, "pickup": 1, "transition": 2, "npc": 3, "encounter": 4}

    def _on_hs_type_changed(self, t: str) -> None:
        self._hs_data_stack.setCurrentIndex(self._TYPE_TO_DATA_IDX.get(t, 0))

    def _hs_col_polygon_from_table(self) -> list[dict[str, float]]:
        t = self._hs_col_table
        out: list[dict[str, float]] = []
        for r in range(t.rowCount()):
            x = round(self._parse_float_cell(t.item(r, 1)), 1)
            y = round(self._parse_float_cell(t.item(r, 2)), 1)
            out.append({"x": x, "y": y})
        return out

    def _set_hs_col_table(self, polygon: list) -> None:
        self._hs_col_updating = True
        try:
            t = self._hs_col_table
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
                t.setItem(r, 1, QTableWidgetItem(str(round(float(p.get("x", 0)), 1))))
                t.setItem(r, 2, QTableWidgetItem(str(round(float(p.get("y", 0)), 1))))
            t.blockSignals(False)
            for r in range(t.rowCount()):
                it = t.item(r, 0)
                if it:
                    it.setText(str(r + 1))
        finally:
            self._hs_col_updating = False

    def _on_hs_display_row_changed(self) -> None:
        self._sync_hs_disp_width_slider_from_spin()
        self._update_hs_disp_ratio_hint()
        self._update_hs_disp_auto_buttons()
        self._sync_hs_display_to_dict_and_refresh()

    def _compute_hs_display_world_height(self, path: str, ww: float) -> float:
        if not path or ww <= 0:
            return 0.0
        px = _hotspot_display_image_pixel_size(self._model, path)
        if px is None:
            return max(1.0, float(ww))
        pw, ph = px
        return _display_world_height_from_width(ww, pw, ph)

    def _update_hs_disp_ratio_hint(self) -> None:
        path = self._hs_disp_row.path().strip()
        if not path:
            self._hs_disp_ratio_hint.setText("（无图片路径，「自动」按钮不可用）")
            return
        px = _hotspot_display_image_pixel_size(self._model, path)
        if px is None:
            self._hs_disp_ratio_hint.setText(
                "（无法读取图素尺寸，「自动」不可用；可手填宽高）",
            )
            return
        pw, ph = px
        self._hs_disp_ratio_hint.setText(f"当前图素: {pw}×{ph}")

    def _update_hs_disp_auto_buttons(self) -> None:
        path = self._hs_disp_row.path().strip()
        ok = bool(
            path and _hotspot_display_image_pixel_size(self._model, path) is not None,
        )
        self._hs_disp_auto_h_btn.setEnabled(ok)
        self._hs_disp_auto_w_btn.setEnabled(ok)

    def _on_hs_disp_auto_height_from_width(self) -> None:
        path = self._hs_disp_row.path().strip()
        if not path:
            return
        px = _hotspot_display_image_pixel_size(self._model, path)
        if px is None:
            return
        pw, ph = px
        ww = float(self._hs_disp_ww.value())
        hh = _display_world_height_from_width(ww, pw, ph)
        if hh <= 0:
            return
        self._hs_disp_hh.blockSignals(True)
        self._hs_disp_hh.setValue(hh)
        self._hs_disp_hh.blockSignals(False)
        self._update_hs_disp_ratio_hint()
        self._sync_hs_display_to_dict_and_refresh()

    def _on_hs_disp_auto_width_from_height(self) -> None:
        path = self._hs_disp_row.path().strip()
        if not path:
            return
        px = _hotspot_display_image_pixel_size(self._model, path)
        if px is None:
            return
        pw, ph = px
        hh = float(self._hs_disp_hh.value())
        ww = _display_world_width_from_height(hh, pw, ph)
        if ww <= 0:
            return
        self._hs_disp_ww.blockSignals(True)
        self._hs_disp_ww.setValue(ww)
        self._hs_disp_ww.blockSignals(False)
        self._sync_hs_disp_width_slider_from_spin()
        self._update_hs_disp_ratio_hint()
        self._sync_hs_display_to_dict_and_refresh()

    def _on_hs_disp_ww_value_changed(self, _v: float) -> None:
        self._sync_hs_disp_width_slider_from_spin()
        self._update_hs_disp_ratio_hint()
        self._sync_hs_display_to_dict_and_refresh()

    def _on_hs_disp_hh_value_changed(self, _v: float) -> None:
        self._update_hs_disp_ratio_hint()
        self._sync_hs_display_to_dict_and_refresh()

    def _sync_hs_disp_width_slider_from_spin(self) -> None:
        raw = int(round(float(self._hs_disp_ww.value()) * 10))
        raw = max(
            self._hs_disp_ww_slider.minimum(),
            min(self._hs_disp_ww_slider.maximum(), raw),
        )
        self._hs_disp_ww_slider.blockSignals(True)
        self._hs_disp_ww_slider.setValue(raw)
        self._hs_disp_ww_slider.blockSignals(False)

    def _on_hs_disp_ww_slider_changed(self, v: int) -> None:
        self._hs_disp_ww.blockSignals(True)
        self._hs_disp_ww.setValue(v / 10.0)
        self._hs_disp_ww.blockSignals(False)
        self._update_hs_disp_ratio_hint()
        self._sync_hs_display_to_dict_and_refresh()

    def _on_hs_disp_facing_changed(self, _i: int) -> None:
        self._sync_hs_display_to_dict_and_refresh()

    def _on_hs_disp_sprite_sort_changed(self, _i: int) -> None:
        self._sync_hs_display_to_dict_and_refresh()

    def _on_hs_xy_live_refresh(self, _v: float | None = None) -> None:
        """x/y 与局部碰撞多边形联动：表格显示世界坐标，画布随 hs 位置刷新。"""
        hs = self._pending_hotspot
        if hs is None or self._stack.currentWidget() != self._hotspot_panel:
            return
        hs["x"] = float(self._hs_x.value())
        hs["y"] = float(self._hs_y.value())
        if self._hs_col_enable.isChecked():
            col = hs.get("collisionPolygon")
            if isinstance(col, list) and len(col) >= 3 and hs.get("collisionPolygonLocal") is True:
                self._hs_col_updating = True
                try:
                    self._set_hs_col_table(_hotspot_collision_local_to_world(hs, col))
                finally:
                    self._hs_col_updating = False
        self._emit_props_changed()
        eid = str(hs.get("id", "")).strip()
        if eid:
            self.hotspot_visual_refresh_requested.emit(eid)

    def _sync_hs_display_to_dict_and_refresh(self) -> None:
        hs = self._pending_hotspot
        if hs is None or self._stack.currentWidget() != self._hotspot_panel:
            return
        path = self._hs_disp_row.path().strip()
        ww = float(self._hs_disp_ww.value())
        hh = float(self._hs_disp_hh.value())
        if path and ww > 0 and hh > 0:
            fac = self._hs_disp_facing.currentData()
            sort = self._hs_disp_sprite_sort.currentData()
            hs["displayImage"] = _hotspot_display_image_dict(
                path, ww, hh, str(fac or "right"), str(sort or "default"),
            )
        else:
            hs.pop("displayImage", None)
        self._emit_props_changed()
        eid = str(hs.get("id", "")).strip()
        if eid:
            self.hotspot_visual_refresh_requested.emit(eid)

    def _on_hs_collision_toggle(self, checked: bool) -> None:
        hs = self._pending_hotspot
        if hs is None or self._stack.currentWidget() != self._hotspot_panel:
            return
        if checked:
            poly = hs.get("collisionPolygon")
            if not (isinstance(poly, list) and len(poly) >= 3):
                hs["collisionPolygon"] = _default_hotspot_collision_triangle_local()
                hs["collisionPolygonLocal"] = True
            wpoly = _hotspot_collision_local_to_world(hs, hs["collisionPolygon"])
            self._set_hs_col_table(wpoly)
        else:
            hs.pop("collisionPolygon", None)
            hs.pop("collisionPolygonLocal", None)
            self._hs_col_updating = True
            try:
                self._hs_col_table.setRowCount(0)
            finally:
                self._hs_col_updating = False
        self._emit_props_changed()
        eid = str(hs.get("id", "")).strip()
        if eid:
            self.hotspot_visual_refresh_requested.emit(eid)
            if checked and isinstance(hs.get("collisionPolygon"), list):
                wpoly = _hotspot_collision_local_to_world(hs, hs["collisionPolygon"])
                self.hotspot_collision_polygon_changed.emit(eid, wpoly)

    def _emit_hs_col_polygon_if_valid(self) -> None:
        if self._hs_col_updating:
            return
        if self._stack.currentWidget() != self._hotspot_panel:
            return
        if not self._hs_col_enable.isChecked():
            return
        hs = self._pending_hotspot
        if hs is None:
            return
        eid = str(hs.get("id", "")).strip()
        if not eid:
            return
        poly_world = self._hs_col_polygon_from_table()
        if len(poly_world) < 3:
            return
        hs["collisionPolygon"] = _hotspot_collision_world_to_local(hs, poly_world)
        hs["collisionPolygonLocal"] = True
        self.hotspot_collision_polygon_changed.emit(eid, poly_world)
        self._emit_props_changed()

    def _on_hs_col_cell_changed(self, item: QTableWidgetItem) -> None:
        if self._hs_col_updating:
            return
        if item.column() == 0:
            return
        self._emit_hs_col_polygon_if_valid()

    def _on_hs_col_add_vertex(self) -> None:
        if self._stack.currentWidget() != self._hotspot_panel:
            return
        if not self._hs_col_enable.isChecked():
            return
        hs = self._pending_hotspot
        if hs is None:
            return
        t = self._hs_col_table
        poly = self._hs_col_polygon_from_table()
        row = t.currentRow()
        if len(poly) < 3:
            hs["collisionPolygon"] = _default_hotspot_collision_triangle_local()
            hs["collisionPolygonLocal"] = True
            poly = _hotspot_collision_local_to_world(hs, hs["collisionPolygon"])
        else:
            if row < 0 and t.rowCount() > 0:
                row = t.rowCount() - 1
            i = max(0, min(row, len(poly) - 1))
            j = (i + 1) % len(poly)
            nx = (poly[i]["x"] + poly[j]["x"]) * 0.5
            ny = (poly[i]["y"] + poly[j]["y"]) * 0.5
            poly.insert(i + 1, {"x": round(nx, 1), "y": round(ny, 1)})
        self._set_hs_col_table(poly)
        self._emit_hs_col_polygon_if_valid()

    def _on_hs_col_remove_vertex(self) -> None:
        if self._stack.currentWidget() != self._hotspot_panel:
            return
        t = self._hs_col_table
        row = t.currentRow()
        if row < 0 or t.rowCount() <= 3:
            return
        poly = self._hs_col_polygon_from_table()
        if row < len(poly):
            del poly[row]
        self._set_hs_col_table(poly)
        self._emit_hs_col_polygon_if_valid()

    def refresh_hotspot_collision_table(self, eid: str) -> None:
        """侧栏表格显示世界坐标（由内存中的局部 collisionPolygon 换算）。"""
        if self._stack.currentWidget() != self._hotspot_panel:
            return
        hs = self._pending_hotspot
        if hs is None or str(hs.get("id", "")) != eid:
            return
        col = hs.get("collisionPolygon")
        if not isinstance(col, list) or len(col) < 3:
            return
        if hs.get("collisionPolygonLocal") is True:
            self._set_hs_col_table(_hotspot_collision_local_to_world(hs, col))
        else:
            self._set_hs_col_table(col)

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
        # 改 targetScene 本身就是编辑：先置脏，随后弹的出生点对话框即使 Cancel 也不丢置脏
        self._emit_props_changed()
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
        accepted = dlg.exec() == QDialog.DialogCode.Accepted
        # 对话框内"新建/拖动出生点"直写 model；若目标场景恰是正在编辑的场景，
        # 必须把 staging 的出生点快照同步刷新——否则稍后 Apply 用打开场景时的旧快照
        # 整体覆盖 spawnPoints，刚建的出生点被删、引用悬垂（审查 P1-25）。
        # Cancel 也要同步：移动/新建不随 Cancel 回退。
        st = self._staging_scene
        src_sc = self._model.scenes.get(sid)
        if st is not None and src_sc is not None and str(st.get("id")) == str(sid):
            if "spawnPoints" in src_sc:
                st["spawnPoints"] = copy.deepcopy(src_sc.get("spawnPoints"))
            else:
                st.pop("spawnPoints", None)
            if "spawnPoint" in src_sc:
                st["spawnPoint"] = copy.deepcopy(src_sc.get("spawnPoint"))
            else:
                st.pop("spawnPoint", None)
        if accepted:
            self._hs_trans_spawn_key = dlg.selected_spawn_key()
            self._refresh_trans_spawn_display()
            self._emit_props_changed()

    def load_hotspot_props(self, hs: dict) -> None:
        with self._suppress_props_changed_emits():
            # 切走共享面板（scene/spawn）时把 widgets flush 到 _staging_scene，
            # 否则修改会因 hotspot 面板不动 _staging_scene 而无声丢失。
            # 实体类（hotspot/npc/zone）走独立 staging，无需 flush（auto-discard）。
            self.flush_active_panel_widgets_to_staging(only_shared_scene_staging=True)
            self._set_pending_dirty(False)
            self._ensure_source_scene_for_editing()
            self._source_hotspot = hs
            st = copy.deepcopy(hs)
            self._staging_hotspot = st
            self._pending_hotspot = st
            self._current_data = st
            self._stack.setCurrentWidget(self._hotspot_panel)
            self._hs_id.setText(st.get("id", ""))
            self._hs_type.setCurrentText(st.get("type", "inspect"))
            self._hs_label.setText(st.get("label", ""))
            self._hs_x.blockSignals(True)
            self._hs_y.blockSignals(True)
            self._hs_x.setValue(st.get("x", 0))
            self._hs_y.setValue(st.get("y", 0))
            self._hs_x.blockSignals(False)
            self._hs_y.blockSignals(False)
            self._hs_range.blockSignals(True)
            self._hs_range.setValue(st.get("interactionRange", 50))
            self._hs_range.blockSignals(False)
            self._hs_auto.setChecked(st.get("autoTrigger", False))
            self._hs_cast_shadow.setChecked(st.get("castShadow", True) is not False)
            self._hs_cutscene_ids_pending = self._entity_cutscene_ids_from_data(st)
            self._hs_cutscene_ids_label.setText(
                self._format_cutscene_ids_label(self._hs_cutscene_ids_pending),
            )
            self._sync_hs_cutscene_only_checkbox()
            self._hs_plane_ids_pending = self._entity_plane_ids_from_data(st)
            self._hs_plane_ids_label.setText(
                self._format_plane_ids_label(self._hs_plane_ids_pending),
            )
            self._hs_cond.set_flag_pattern_context(self._model, self._editing_scene_id or None)
            self._hs_cond.set_data(st.get("conditions", []))
            self._hs_cond_hide_entity.blockSignals(True)
            self._hs_cond_hide_entity.setChecked(st.get("conditionHidesEntity", False) is True)
            self._hs_cond_hide_entity.blockSignals(False)

            di = st.get("displayImage") if isinstance(st.get("displayImage"), dict) else {}
            pimg = str(di.get("image", "") or "")
            self._hs_disp_row.set_path(pimg)
            self._hs_disp_ww.blockSignals(True)
            self._hs_disp_ww_slider.blockSignals(True)
            self._hs_disp_hh.blockSignals(True)
            ww0 = float(di.get("worldWidth", 100) or 100)
            self._hs_disp_ww.setValue(ww0)
            self._sync_hs_disp_width_slider_from_spin()
            raw_hh = di.get("worldHeight")
            try:
                hh0 = float(raw_hh) if raw_hh is not None and raw_hh != "" else 0.0
            except (TypeError, ValueError):
                hh0 = 0.0
            if hh0 <= 0 and pimg.strip() and ww0 > 0:
                hh0 = self._compute_hs_display_world_height(pimg.strip(), ww0)
            if hh0 <= 0:
                hh0 = max(1.0, ww0)
            self._hs_disp_hh.setValue(hh0)
            self._hs_disp_ww_slider.blockSignals(False)
            self._hs_disp_ww.blockSignals(False)
            self._hs_disp_hh.blockSignals(False)
            self._update_hs_disp_ratio_hint()
            self._update_hs_disp_auto_buttons()
            fac = str(di.get("facing", "") or "right").strip().lower()
            self._hs_disp_facing.blockSignals(True)
            self._hs_disp_facing.setCurrentIndex(1 if fac == "left" else 0)
            self._hs_disp_facing.blockSignals(False)
            ss = str(di.get("spriteSort", "") or "default").strip().lower()
            sort_idx = 0
            if ss == "back":
                sort_idx = 1
            elif ss == "front":
                sort_idx = 2
            self._hs_disp_sprite_sort.blockSignals(True)
            self._hs_disp_sprite_sort.setCurrentIndex(sort_idx)
            self._hs_disp_sprite_sort.blockSignals(False)
            colpoly = st.get("collisionPolygon")
            has_col = isinstance(colpoly, list) and len(colpoly) >= 3
            self._hs_col_enable.blockSignals(True)
            self._hs_col_enable.setChecked(has_col)
            self._hs_col_enable.blockSignals(False)
            if has_col:
                if st.get("collisionPolygonLocal") is True:
                    self._set_hs_col_table(_hotspot_collision_local_to_world(st, colpoly))
                else:
                    self._set_hs_col_table(colpoly)
            else:
                self._hs_col_updating = True
                try:
                    self._hs_col_table.setRowCount(0)
                finally:
                    self._hs_col_updating = False

            disp_path = str(di.get("image", "") or "").strip()
            self._hs_disp_fold.set_expanded(
                bool(
                    disp_path
                    and float(self._hs_disp_ww.value()) > 0
                    and float(self._hs_disp_hh.value()) > 0,
                ),
            )
            self._hs_col_fold.set_expanded(has_col)

            data = st.get("data", {})
            _hs_conds = st.get("conditions")
            self._hs_cond_fold.set_expanded(
                bool(isinstance(_hs_conds, list) and len(_hs_conds) > 0))
            self._hs_data_fold.set_expanded(bool(isinstance(data, dict) and data))
            ht = st.get("type", "inspect")
            self._on_hs_type_changed(ht)
            if ht == "inspect":
                gids = self._model.all_dialogue_graph_ids()
                self._hs_inspect_graph_combo.set_entries([(g, g) for g in gids])
                gid = str(data.get("graphId") or "").strip()
                self._hs_inspect_graph_combo.blockSignals(True)
                self._hs_inspect_mode_actions.blockSignals(True)
                self._hs_inspect_mode_graph.blockSignals(True)
                try:
                    if gid:
                        self._hs_inspect_mode_graph.setChecked(True)
                        self._hs_inspect_graph_combo.set_committed_type(gid)
                        self._set_inspect_entry_choices(gid, str(data.get("entry") or ""))
                    else:
                        self._hs_inspect_mode_actions.setChecked(True)
                        self._set_inspect_entry_choices("", "")
                        if gids:
                            self._hs_inspect_graph_combo.set_committed_type(gids[0])
                        else:
                            self._hs_inspect_graph_combo.set_committed_type("")
                finally:
                    self._hs_inspect_graph_combo.blockSignals(False)
                    self._hs_inspect_mode_actions.blockSignals(False)
                    self._hs_inspect_mode_graph.blockSignals(False)
                graph_on = self._hs_inspect_mode_graph.isChecked()
                self._hs_inspect_graph_wrap.setVisible(graph_on)
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
        self._emit_props_changed()

    def _on_npc_interaction_range_live(self, value: float) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return
        npc["interactionRange"] = float(value)
        eid = str(npc.get("id", ""))
        if eid:
            self.interaction_range_changed.emit("npc", eid, float(value))
        self._emit_props_changed()

    def _npc_col_polygon_from_table(self) -> list[dict[str, float]]:
        t = self._npc_col_table
        out: list[dict[str, float]] = []
        for r in range(t.rowCount()):
            x_it = t.item(r, 1)
            y_it = t.item(r, 2)
            try:
                x = round(float((x_it.text() if x_it else "0").strip()), 1)
                y = round(float((y_it.text() if y_it else "0").strip()), 1)
            except (TypeError, ValueError, AttributeError):
                x, y = 0.0, 0.0
            out.append({"x": x, "y": y})
        return out

    def _set_npc_col_table(self, polygon: list) -> None:
        self._npc_col_updating = True
        try:
            t = self._npc_col_table
            t.blockSignals(True)
            t.setRowCount(0)
            for i, p in enumerate(polygon):
                if not isinstance(p, dict):
                    continue
                r = t.rowCount()
                t.insertRow(r)
                ix = QTableWidgetItem(str(i))
                ix.setFlags(ix.flags() & ~Qt.ItemFlag.ItemIsEditable)
                t.setItem(r, 0, ix)
                t.setItem(
                    r, 1, QTableWidgetItem(str(round(float(p.get("x", 0)), 1))))
                t.setItem(
                    r, 2, QTableWidgetItem(str(round(float(p.get("y", 0)), 1))))
            t.blockSignals(False)
            for r in range(t.rowCount()):
                it = t.item(r, 0)
                if it:
                    it.setText(str(r))
        finally:
            self._npc_col_updating = False

    def _on_npc_collision_toggle(self, checked: bool) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return
        if checked:
            poly = npc.get("collisionPolygon")
            if not (isinstance(poly, list) and len(poly) >= 3):
                npc["collisionPolygon"] = _default_hotspot_collision_triangle_local()
                npc["collisionPolygonLocal"] = True
            wpoly = _hotspot_collision_local_to_world(npc, npc["collisionPolygon"])
            self._set_npc_col_table(wpoly)
        else:
            npc.pop("collisionPolygon", None)
            npc.pop("collisionPolygonLocal", None)
            self._npc_col_updating = True
            try:
                self._npc_col_table.setRowCount(0)
            finally:
                self._npc_col_updating = False
        self._emit_props_changed()
        eid = str(npc.get("id", "")).strip()
        if eid:
            if checked and isinstance(npc.get("collisionPolygon"), list):
                wpoly = _hotspot_collision_local_to_world(npc, npc["collisionPolygon"])
                self.npc_collision_polygon_changed.emit(eid, wpoly)
            else:
                self.npc_collision_polygon_changed.emit(eid, [])

    def _emit_npc_col_polygon_if_valid(self) -> None:
        if self._npc_col_updating:
            return
        if self._stack.currentWidget() != self._npc_panel:
            return
        if not self._npc_col_enable.isChecked():
            return
        npc = self._pending_npc
        if npc is None:
            return
        eid = str(npc.get("id", "")).strip()
        if not eid:
            return
        poly_world = self._npc_col_polygon_from_table()
        if len(poly_world) < 3:
            return
        npc["collisionPolygon"] = _hotspot_collision_world_to_local(npc, poly_world)
        npc["collisionPolygonLocal"] = True
        self.npc_collision_polygon_changed.emit(eid, poly_world)
        self._emit_props_changed()

    def _on_npc_col_cell_changed(self, item: QTableWidgetItem) -> None:
        if self._npc_col_updating:
            return
        if item.column() == 0:
            return
        self._emit_npc_col_polygon_if_valid()

    def _on_npc_col_add_vertex(self) -> None:
        if self._stack.currentWidget() != self._npc_panel:
            return
        if not self._npc_col_enable.isChecked():
            return
        npc = self._pending_npc
        if npc is None:
            return
        t = self._npc_col_table
        poly = self._npc_col_polygon_from_table()
        row = t.currentRow()
        if len(poly) < 3:
            npc["collisionPolygon"] = _default_hotspot_collision_triangle_local()
            npc["collisionPolygonLocal"] = True
            poly = _hotspot_collision_local_to_world(npc, npc["collisionPolygon"])
        else:
            if row < 0 and t.rowCount() > 0:
                row = t.rowCount() - 1
            i = max(0, min(row, len(poly) - 1))
            j = (i + 1) % len(poly)
            nx = (poly[i]["x"] + poly[j]["x"]) * 0.5
            ny = (poly[i]["y"] + poly[j]["y"]) * 0.5
            poly.insert(i + 1, {"x": round(nx, 1), "y": round(ny, 1)})
        self._set_npc_col_table(poly)
        self._emit_npc_col_polygon_if_valid()

    def _on_npc_col_remove_vertex(self) -> None:
        if self._stack.currentWidget() != self._npc_panel:
            return
        t = self._npc_col_table
        row = t.currentRow()
        if row < 0 or t.rowCount() <= 3:
            return
        poly = self._npc_col_polygon_from_table()
        if row < len(poly):
            del poly[row]
        self._set_npc_col_table(poly)
        self._emit_npc_col_polygon_if_valid()

    def refresh_npc_collision_table(self, eid: str) -> None:
        if self._stack.currentWidget() != self._npc_panel:
            return
        npc = self._pending_npc
        if npc is None or str(npc.get("id", "")) != eid:
            return
        col = npc.get("collisionPolygon")
        if not isinstance(col, list) or len(col) < 3:
            return
        if npc.get("collisionPolygonLocal") is True:
            self._set_npc_col_table(_hotspot_collision_local_to_world(npc, col))
        else:
            self._set_npc_col_table(col)

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
        # castShadow 缺省开：仅取消勾选才落 false，勾选时省略字段（保持 JSON 干净 + 默认开）
        if not self._hs_cast_shadow.isChecked():
            hs["castShadow"] = False
        elif "castShadow" in hs:
            del hs["castShadow"]
        hs_ids = [x for x in self._hs_cutscene_ids_pending if str(x).strip()]
        if hs_ids:
            hs["cutsceneIds"] = hs_ids
        else:
            hs.pop("cutsceneIds", None)
        hs.pop("cutsceneId", None)
        hs_planes = [x for x in self._hs_plane_ids_pending if str(x).strip()]
        if hs_planes:
            hs["planes"] = hs_planes
        else:
            hs.pop("planes", None)  # 缺省=存在于所有位面
        if self._entity_has_cutscene_binding(hs):
            if self._hs_cutscene_only.isChecked():
                hs.pop("cutsceneOnly", None)
            else:
                hs["cutsceneOnly"] = False
        else:
            hs.pop("cutsceneOnly", None)
        conds = self._hs_cond.to_list()
        if conds:
            hs["conditions"] = conds
        elif "conditions" in hs:
            del hs["conditions"]
        if self._hs_cond_hide_entity.isChecked():
            hs["conditionHidesEntity"] = True
        elif "conditionHidesEntity" in hs:
            del hs["conditionHidesEntity"]

        path = self._hs_disp_row.path().strip()
        ww = float(self._hs_disp_ww.value())
        hh = float(self._hs_disp_hh.value())
        fac = self._hs_disp_facing.currentData()
        sort = self._hs_disp_sprite_sort.currentData()
        if path and ww > 0 and hh > 0:
            hs["displayImage"] = _hotspot_display_image_dict(
                path, ww, hh, str(fac or "right"), str(sort or "default"),
            )
        else:
            hs.pop("displayImage", None)
        if self._hs_col_enable.isChecked():
            poly_world = self._hs_col_polygon_from_table()
            if len(poly_world) >= 3:
                hs["collisionPolygon"] = _hotspot_collision_world_to_local(hs, poly_world)
                hs["collisionPolygonLocal"] = True
            elif "collisionPolygon" in hs:
                del hs["collisionPolygon"]
                hs.pop("collisionPolygonLocal", None)
        else:
            hs.pop("collisionPolygon", None)
            hs.pop("collisionPolygonLocal", None)

        ht = hs["type"]
        if ht == "inspect":
            acts = self._hs_inspect_actions.to_list()
            if self._hs_inspect_mode_graph.isChecked():
                gid = self._hs_inspect_graph_combo.committed_type().strip()
                new_data: dict = {}
                if gid:
                    new_data["graphId"] = gid
                ent = self._hs_inspect_entry.committed_type().strip()
                if ent:
                    new_data["entry"] = ent
                if acts:
                    new_data["actions"] = acts
                hs["data"] = new_data
            else:
                new_data = {}
                if acts:
                    new_data["actions"] = acts
                hs["data"] = new_data
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
        self._emit_props_changed()

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
        outer.setAlignment(Qt.AlignmentFlag.AlignTop)
        base_g = self._section("身份、位置、对话与交互范围", start_open=True)
        base_inner = QWidget()
        form = compact_form(QFormLayout(base_inner))
        self._npc_id = QLineEdit(); form.addRow("id", self._npc_id)
        self._npc_id.textChanged.connect(lambda *_: self._emit_props_changed())
        self._npc_character = QComboBox()
        self._npc_character.setMinimumWidth(180)
        self._npc_character.setToolTip(
            "引用角色注册表（「角色」页 / character_registry.json）：名字·动画包·对话头像默认从角色继承，"
            "跨场景同一角色只配一次。选「（独立NPC）」= 不引用、身份就地定义。\n"
            "下方 name/animFile/portrait 默认显示继承值、仍可改：改成异于继承的值 = 只覆盖此摆放的装扮"
            "（换角色本身请去「角色」页）；设回继承值或清空 = 继续继承。"
        )
        self._npc_character.currentIndexChanged.connect(self._on_npc_character_changed)
        form.addRow("角色(characterId)", self._npc_character)
        self._npc_name = QLineEdit(); form.addRow("name", self._npc_name)
        self._npc_name.textChanged.connect(lambda *_: self._emit_props_changed())
        self._npc_x = QDoubleSpinBox(); self._npc_x.setRange(-99999, 99999); self._npc_x.setDecimals(1)
        self._npc_x.valueChanged.connect(self._on_npc_xy_live)
        form.addRow("x", self._npc_x)
        self._npc_y = QDoubleSpinBox(); self._npc_y.setRange(-99999, 99999); self._npc_y.setDecimals(1)
        self._npc_y.valueChanged.connect(self._on_npc_xy_live)
        form.addRow("y", self._npc_y)
        self._npc_facing = QComboBox()
        self._npc_facing.addItem("朝右（默认）", "right")
        self._npc_facing.addItem("朝左", "left")
        self._npc_facing.setToolTip("进入场景时的左右朝向（与游戏中 setFacing 一致）")
        self._npc_facing.currentIndexChanged.connect(self._on_npc_facing_changed)
        form.addRow("initialFacing", self._npc_facing)
        self._npc_dialogue_graph = IdRefSelector(allow_empty=True, editable=True)
        self._npc_dialogue_graph.setMinimumWidth(160)
        self._npc_dialogue_graph.setToolTip("对应 public/assets/dialogues/graphs/<id>.json")
        self._npc_dialogue_graph.value_changed.connect(lambda _x: self._emit_props_changed())
        self._npc_dialogue_graph.value_changed.connect(
            lambda _x: self._refresh_npc_dialogue_entry_choices())
        form.addRow("dialogueGraphId", self._npc_dialogue_graph)
        self._npc_dialogue_graph_entry = FilterableTypeCombo([], self, select_only=False)
        self._npc_dialogue_graph_entry.setMinimumWidth(160)
        self._npc_dialogue_graph_entry.lineEdit().setPlaceholderText(
            "可选，覆盖图 JSON 的 entry 节点 id")
        self._npc_dialogue_graph_entry.typeCommitted.connect(
            lambda *_: self._emit_props_changed())
        form.addRow("dialogueGraphEntry", self._npc_dialogue_graph_entry)
        self._npc_dialogue_zoom = QDoubleSpinBox()
        self._npc_dialogue_zoom.setRange(0.05, 8.0)
        self._npc_dialogue_zoom.setDecimals(3)
        self._npc_dialogue_zoom.setValue(1.0)
        self._npc_dialogue_zoom.setToolTip(
            "进入该 NPC 对话时镜头渐变缩放到该值（与场景 camera.zoom 同语义）；缺省 1.0；"
            "对话结束由运行时自动恢复场景 zoom。")
        self._npc_dialogue_zoom.valueChanged.connect(lambda _v: self._emit_props_changed())
        form.addRow("dialogueCameraZoom", self._npc_dialogue_zoom)
        self._npc_range = QDoubleSpinBox(); self._npc_range.setRange(0, 99999)
        form.addRow("interactionRange", self._npc_range)
        self._npc_range.valueChanged.connect(self._on_npc_interaction_range_live)
        self._npc_cutscene_only = QCheckBox("仅过场实体（普通场景不生成）")
        self._npc_cutscene_only.setToolTip(
            "默认开启：实体只在关联过场中从场景文件初始化，不读 committed sceneMemory。"
            "关闭：普通场景也存在，进出关联过场时会从场景文件 + committed sceneMemory 重建。"
        )
        self._npc_cutscene_only.toggled.connect(self._on_entity_cutscene_bindings_changed)
        form.addRow("cutsceneOnly", self._npc_cutscene_only)
        npc_multi_row = QWidget()
        npc_multi_l = QHBoxLayout(npc_multi_row)
        npc_multi_l.setContentsMargins(0, 0, 0, 0)
        self._npc_cutscene_ids_label = QLabel("（未关联）")
        self._npc_cutscene_ids_label.setWordWrap(True)
        self._npc_cutscene_ids_btn = QPushButton("选择多个…")
        self._npc_cutscene_ids_btn.clicked.connect(self._open_npc_cutscene_ids_picker)
        self._npc_cutscene_ids_clear_btn = QPushButton("清除")
        self._npc_cutscene_ids_clear_btn.setToolTip("清空 cutsceneIds，并移除 cutsceneOnly 绑定语义。")
        self._npc_cutscene_ids_clear_btn.clicked.connect(self._clear_npc_cutscene_ids)
        npc_multi_l.addWidget(self._npc_cutscene_ids_label, 1)
        npc_multi_l.addWidget(self._npc_cutscene_ids_btn)
        npc_multi_l.addWidget(self._npc_cutscene_ids_clear_btn)
        form.addRow("cutsceneIds", npc_multi_row)
        form.addRow("位面归属", self._make_plane_ids_row(
            "_npc_plane_ids_label",
            self._open_npc_plane_ids_picker,
            self._clear_npc_plane_ids,
        ))
        self._npc_cast_shadow = QCheckBox("投射阴影 + 接触AO")
        self._npc_cast_shadow.setToolTip(
            "缺省开启：该 NPC 在地面投射阴影并带脚下接触 AO。关闭则此 NPC 不投影也无接触 AO。"
        )
        self._npc_cast_shadow.stateChanged.connect(lambda _s: self._emit_props_changed())
        form.addRow("castShadow", self._npc_cast_shadow)
        base_g.add_body(base_inner)
        outer.addWidget(base_g)

        npc_cond_g = self._section("触发条件 conditions", start_open=False)
        npc_cond_g.set_header_tool_tip("默认折叠；与热点相同，控制是否可交互；可选「条件不满足时隐藏」。")
        npc_cond_inner = QWidget()
        npc_cond_l = QVBoxLayout(npc_cond_inner)
        self._npc_cond_hide_entity = QCheckBox("条件不满足时隐藏实体")
        self._npc_cond_hide_entity.setToolTip(
            "需配置非空 conditions；勾选后条件失败时 NPC 不可见（仍受 sceneMemory / 过场基底显隐约束）。",
        )
        self._npc_cond_hide_entity.stateChanged.connect(lambda _s: self._emit_props_changed())
        npc_cond_l.addWidget(self._npc_cond_hide_entity)
        self._npc_cond = ConditionEditor("Conditions")
        self._npc_cond.changed.connect(self._emit_props_changed)
        npc_cond_l.addWidget(self._npc_cond)
        npc_cond_g.add_body(npc_cond_inner)
        outer.addWidget(npc_cond_g)

        ncc_g = self._section("行走阻挡碰撞多边形", start_open=False)
        ncc_g.set_header_tool_tip(
            "与 Hotspot 相同：作为玩家行走碰撞（与互动范围圈无关），相对 NPC 的 x,y 存局部多边形。",
        )
        ncc_inner = QWidget()
        ncc_l = QVBoxLayout(ncc_inner)
        self._npc_col_enable = QCheckBox("启用碰撞多边形")
        self._npc_col_enable.toggled.connect(self._on_npc_collision_toggle)
        ncc_l.addWidget(self._npc_col_enable)
        h_cc = QLabel(
            "侧栏为「世界坐标」；写入 JSON 时相对当前 x,y 存局部坐标。画布仅拖顶点/插点/删点，不拖整体平移。")
        h_cc.setWordWrap(True)
        ncc_l.addWidget(h_cc)
        self._npc_col_table = QTableWidget(0, 3)
        self._npc_col_table.setHorizontalHeaderLabels(["#", "x", "y"])
        self._npc_col_table.horizontalHeader().setSectionResizeMode(
            0, QHeaderView.ResizeMode.ResizeToContents)
        self._npc_col_table.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.Stretch)
        self._npc_col_table.horizontalHeader().setSectionResizeMode(
            2, QHeaderView.ResizeMode.Stretch)
        self._npc_col_table.setMinimumHeight(120)
        self._npc_col_table.itemChanged.connect(self._on_npc_col_cell_changed)
        self._install_vertex_table_affordances(
            self._npc_col_table, self._on_npc_col_remove_vertex)
        ncc_l.addWidget(self._npc_col_table)
        ncc_btns = QHBoxLayout()
        self._npc_col_add = QPushButton("添加顶点")
        self._npc_col_add.clicked.connect(self._on_npc_col_add_vertex)
        self._npc_col_del = QPushButton("删除选中顶点")
        self._npc_col_del.clicked.connect(self._on_npc_col_remove_vertex)
        ncc_btns.addWidget(self._npc_col_add)
        ncc_btns.addWidget(self._npc_col_del)
        ncc_l.addLayout(ncc_btns)
        ncc_g.add_body(ncc_inner)
        self._npc_col_fold = ncc_g
        outer.addWidget(ncc_g)

        anim_g = self._section("骨骼动画 animFile / 初始状态", start_open=True)
        anim_inner = QWidget()
        anim_f = compact_form(QFormLayout(anim_inner))
        self._npc_anim = IdRefSelector(allow_empty=True, editable=True)
        self._npc_anim.setMinimumWidth(180)
        self._npc_anim.value_changed.connect(self._on_npc_anim_file_changed)
        anim_f.addRow("animFile", self._npc_anim)
        self._npc_initial_state = QComboBox()
        self._npc_initial_state.setMinimumWidth(180)
        self._npc_initial_state.currentIndexChanged.connect(self._on_npc_initial_state_changed)
        anim_f.addRow("initialAnimState", self._npc_initial_state)
        self._npc_portrait = IdRefSelector(allow_empty=True, editable=False)
        self._npc_portrait.setMinimumWidth(180)
        self._npc_portrait.setToolTip(
            "对话头像立绘集（resources/runtime/images/dialogue_portraits/<slug>/）。\n"
            "图对话行头像选「跟随说话NPC」时按此解析；留空则该 NPC 不出头像。"
        )
        self._npc_portrait.value_changed.connect(self._on_npc_portrait_slug_changed)
        anim_f.addRow("portraitSlug", self._npc_portrait)
        anim_g.add_body(anim_inner)
        outer.addWidget(anim_g)

        patrol_box = CollapsibleSection("巡逻路径（运行时折返 ping-pong）", start_open=False)
        patrol_box.set_header_tool_tip("默认折叠；启用巡逻时展开编辑路点")
        patrol_inner = QWidget()
        patrol_outer = QVBoxLayout(patrol_inner)
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
        self._npc_patrol_move_anim = QComboBox()
        self._npc_patrol_move_anim.setMinimumWidth(150)
        self._npc_patrol_move_anim.setToolTip(
            "animFile 内 states 的键名，与运行时一致；留空则移动时不切动画")
        self._npc_patrol_move_anim.currentIndexChanged.connect(
            lambda *_: self._on_npc_patrol_move_anim_finished())
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
        self._install_vertex_table_affordances(
            self._npc_patrol_table, self._on_npc_patrol_remove_point,
            label="删除所选路点")
        patrol_outer.addWidget(self._npc_patrol_table)
        pr_btns = QHBoxLayout()
        self._npc_patrol_add_pt = QPushButton("添加路点")
        self._npc_patrol_add_pt.clicked.connect(self._on_npc_patrol_add_point)
        self._npc_patrol_del_pt = QPushButton("删除所选路点")
        self._npc_patrol_del_pt.clicked.connect(self._on_npc_patrol_remove_point)
        self._npc_patrol_up_pt = QPushButton("上移")
        self._npc_patrol_up_pt.clicked.connect(lambda: self._move_npc_patrol_point(-1))
        self._npc_patrol_down_pt = QPushButton("下移")
        self._npc_patrol_down_pt.clicked.connect(lambda: self._move_npc_patrol_point(1))
        pr_btns.addWidget(self._npc_patrol_add_pt)
        pr_btns.addWidget(self._npc_patrol_del_pt)
        pr_btns.addWidget(self._npc_patrol_up_pt)
        pr_btns.addWidget(self._npc_patrol_down_pt)
        pr_btns.addStretch(1)
        patrol_outer.addLayout(pr_btns)
        patrol_box.add_body(patrol_inner)
        self._npc_patrol_fold = patrol_box
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
        self._npc_patrol_up_pt.setEnabled(en)
        self._npc_patrol_down_pt.setEnabled(en)
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
        v = self._npc_patrol_move_anim.currentText().strip()
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
        v = self._npc_patrol_move_anim.currentText().strip()
        if v:
            pat["moveAnimState"] = v
        elif "moveAnimState" in pat:
            del pat["moveAnimState"]
        self._emit_props_changed()
        self._request_scene_npc_anim_refresh()

    def _on_npc_patrol_enable_toggled(self, checked: bool) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return
        if checked:
            self._npc_patrol_fold.set_expanded(True)
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
            self._fill_npc_patrol_move_anim_combo()
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
        self._emit_props_changed()
        self.npc_patrol_overlay_refresh_requested.emit()

    def _on_npc_patrol_speed_changed(self, _v: float) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return
        if not self._npc_patrol_enable.isChecked():
            return
        pat = npc.setdefault("patrol", {})
        pat["speed"] = int(self._npc_patrol_speed.value())
        self._emit_props_changed()

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
        self._emit_props_changed()
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
        self._emit_props_changed()
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
        self._emit_props_changed()
        self.npc_patrol_overlay_refresh_requested.emit()

    def _move_npc_patrol_point(self, delta: int) -> None:
        if self._stack.currentWidget() != self._npc_panel or not self._npc_patrol_enable.isChecked():
            return
        t = self._npc_patrol_table
        row = t.currentRow()
        if row < 0:
            return
        target = row + delta
        if target < 0 or target >= t.rowCount():
            return
        route = self._npc_patrol_route_from_table()
        if row >= len(route) or target >= len(route):
            return
        route[row], route[target] = route[target], route[row]
        self._fill_npc_patrol_table(route)
        self._npc_patrol_table.setCurrentCell(target, 1)
        self._sync_patrol_dict_from_table()
        self._emit_props_changed()
        self.npc_patrol_overlay_refresh_requested.emit()

    def _load_npc_patrol_ui(self, npc: dict) -> None:
        pat = npc.get("patrol")
        en = isinstance(pat, dict) and isinstance(pat.get("route"), list) and len(pat["route"]) >= 2
        self._npc_patrol_fold.set_expanded(en)
        self._npc_patrol_enable.blockSignals(True)
        self._npc_patrol_enable.setChecked(en)
        self._npc_patrol_enable.blockSignals(False)
        self._set_npc_patrol_widgets_enabled(en)
        if en and isinstance(pat, dict):
            self._npc_patrol_speed.blockSignals(True)
            self._npc_patrol_speed.setValue(int(pat.get("speed", 60) or 60))
            self._npc_patrol_speed.blockSignals(False)
            self._fill_npc_patrol_table(pat["route"])
            self._fill_npc_patrol_move_anim_combo()
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
        if self._npc_col_enable.isChecked():
            col = npc.get("collisionPolygon")
            if isinstance(col, list) and len(col) >= 3 and npc.get("collisionPolygonLocal") is True:
                self._npc_col_updating = True
                try:
                    self._set_npc_col_table(_hotspot_collision_local_to_world(npc, col))
                finally:
                    self._npc_col_updating = False
        self._emit_props_changed()
        self.npc_xy_live_changed.emit(str(npc.get("id", "")))

    def _npc_character_items(self) -> list[tuple[str, str]]:
        out: list[tuple[str, str]] = [("（独立NPC）", "")]
        for cid, ch in sorted((self._model.character_registry or {}).items()):
            nm = (ch.get("name") or cid) if isinstance(ch, dict) else cid
            out.append((f"{nm} · {cid}", cid))
        return out

    def _npc_char_inherited(self, key: str) -> str:
        cid = str(self._npc_character.currentData() or "").strip()
        ch = (self._model.character_registry or {}).get(cid) if cid else None
        v = ch.get(key) if isinstance(ch, dict) else None
        return v.strip() if isinstance(v, str) else ""

    def _write_identity_override(self, npc: dict, key: str, value: str) -> None:
        """characterId 引用时写 name/animFile/portraitSlug：仅当就地值非空且异于继承值才写（本摆放覆盖），
        等于继承值或空则删键（继续继承角色注册表）。"""
        inherited = self._npc_char_inherited(key)
        if value and value != inherited:
            npc[key] = value
        else:
            npc.pop(key, None)

    def _apply_npc_character_inheritance(self) -> None:
        """引用角色时：name/animFile/portrait 保持可编辑，展示「就地覆盖值优先、否则继承值」，
        并把继承值写进 tooltip 作提示。改成异于继承 = 覆盖此摆放，等于/空 = 继续继承。"""
        cid = str(self._npc_character.currentData() or "").strip()
        # 一律可编辑（覆盖靠「值是否异于继承」判定，不再禁用字段）
        self._npc_name.setReadOnly(False)
        self._npc_anim.setEnabled(True)
        self._npc_portrait.setEnabled(True)
        npc = self._pending_npc or {}
        if not cid:
            for w in (self._npc_name, self._npc_anim, self._npc_portrait):
                w.setToolTip("")
            return

        def _eff(key: str) -> tuple[str, str]:
            inh = self._npc_char_inherited(key)
            own = str(npc.get(key) or "").strip()
            return (own or inh), inh

        nm, nm_inh = _eff("name")
        self._npc_name.blockSignals(True)
        self._npc_name.setText(nm)
        self._npc_name.blockSignals(False)
        self._npc_name.setToolTip(f"继承自角色：{nm_inh or '（空）'}；改成别的值 = 只覆盖此摆放，设回/清空 = 继续继承")

        af, af_inh = _eff("animFile")
        a_items = self._model.anim_asset_path_choices()
        if af and all(x[0] != af for x in a_items):
            a_items = [(af, af)] + a_items
        self._npc_anim.blockSignals(True)
        self._npc_anim.set_items(a_items)
        self._npc_anim.set_current(af)
        self._npc_anim.blockSignals(False)
        self._npc_anim.setToolTip(f"继承自角色：{af_inh or '（空）'}；改成别的动画包 = 只覆盖此摆放的装扮，设回/清空 = 继续继承")

        ps, ps_inh = _eff("portraitSlug")
        p_items = (
            [(s, s) for s in load_portrait_sets(self._model.project_path)]
            if self._model.project_path is not None else []
        )
        if ps and all(x[0] != ps for x in p_items):
            p_items = [(ps, ps)] + p_items
        self._npc_portrait.blockSignals(True)
        self._npc_portrait.set_items(p_items)
        self._npc_portrait.set_current(ps)
        self._npc_portrait.blockSignals(False)
        self._npc_portrait.setToolTip(f"继承自角色：{ps_inh or '（空）'}；改成别的立绘集 = 只覆盖此摆放，设回/清空 = 继续继承")

    def _on_npc_character_changed(self, _i: int) -> None:
        if self._npc_character.signalsBlocked():
            return
        if self._pending_npc is None or self._stack.currentWidget() != self._npc_panel:
            self._emit_props_changed()
            return
        # 切换角色（或切到独立）会更换继承基线，先清掉旧的就地覆盖，避免残留错角色的装扮
        for _k in ("name", "animFile", "portraitSlug"):
            self._pending_npc.pop(_k, None)
        self._apply_npc_character_inheritance()
        self._fill_npc_initial_state_combo()
        self._emit_props_changed()
        self._request_scene_npc_anim_refresh()

    def _on_npc_facing_changed(self, _i: int) -> None:
        if self._npc_facing.signalsBlocked():
            return
        self._emit_props_changed()
        self._request_scene_npc_anim_refresh()

    def _on_npc_initial_state_changed(self, _i: int) -> None:
        if self._npc_initial_state.signalsBlocked():
            return
        self._sync_npc_initial_anim_state_to_dict()
        self._emit_props_changed()
        self._request_scene_npc_anim_refresh()

    def _on_npc_anim_file_changed(self, _id: str) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            self._emit_props_changed()
            return
        anim = self._npc_anim.current_id().strip()
        if str(self._npc_character.currentData() or "").strip():
            # 引用角色：异于继承才作本摆放覆盖写入，等于/空则继续继承
            self._write_identity_override(npc, "animFile", anim)
        elif anim:
            npc["animFile"] = anim
        elif "animFile" in npc:
            del npc["animFile"]
        self._fill_npc_initial_state_combo()
        self._fill_npc_patrol_move_anim_combo()
        self._sync_npc_initial_anim_state_to_dict()
        self._emit_props_changed()
        self._request_scene_npc_anim_refresh()
        self._update_npc_patrol_preview_enabled()

    def _on_npc_portrait_slug_changed(self, _id: str) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            self._emit_props_changed()
            return
        slug = self._npc_portrait.current_id().strip()
        if str(self._npc_character.currentData() or "").strip():
            # 引用角色：异于继承才作本摆放覆盖写入，等于/空则继续继承
            self._write_identity_override(npc, "portraitSlug", slug)
        elif slug:
            npc["portraitSlug"] = slug
        elif "portraitSlug" in npc:
            del npc["portraitSlug"]
        self._emit_props_changed()

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

    # --- entry / 动画 state 节点选择器（候选取自模型，保留已存值） -------------
    def _set_inspect_entry_choices(self, graph_id: str, entry_value: str) -> None:
        gid = (graph_id or "").strip()
        node_ids = self._model.dialogue_graph_node_ids(gid) if gid else []
        rows = [("（留空）", "")] + [(n, n) for n in node_ids]
        ev = (entry_value or "").strip()
        # select_only 选择器：已存的未知 entry 注入保留（IdRefSelector 悬垂保值同款范式）。
        if ev and all(x[1] != ev for x in rows):
            rows = [(f"(数据) {ev}", ev)] + rows
        self._hs_inspect_entry.blockSignals(True)
        try:
            self._hs_inspect_entry.set_entries(rows)
            self._hs_inspect_entry.set_committed_type(ev)
        finally:
            self._hs_inspect_entry.blockSignals(False)

    def _refresh_inspect_entry_choices(self) -> None:
        self._set_inspect_entry_choices(
            self._hs_inspect_graph_combo.committed_type().strip(),
            self._hs_inspect_entry.committed_type())

    def _set_npc_dialogue_entry_choices(self, graph_id: str, entry_value: str) -> None:
        gid = (graph_id or "").strip()
        node_ids = self._model.dialogue_graph_node_ids(gid) if gid else []
        self._npc_dialogue_graph_entry.blockSignals(True)
        try:
            self._npc_dialogue_graph_entry.set_entries(
                [("（留空）", "")] + [(n, n) for n in node_ids])
            self._npc_dialogue_graph_entry.set_committed_type(entry_value or "")
        finally:
            self._npc_dialogue_graph_entry.blockSignals(False)

    def _refresh_npc_dialogue_entry_choices(self) -> None:
        self._set_npc_dialogue_entry_choices(
            self._npc_dialogue_graph.current_id().strip(),
            self._npc_dialogue_graph_entry.committed_type())

    def _fill_npc_patrol_move_anim_combo(self) -> None:
        """填巡逻移动动画状态下拉：留空 + 该 NPC animFile 的 states；保留已存值。"""
        self._npc_patrol_move_anim.blockSignals(True)
        try:
            self._npc_patrol_move_anim.clear()
            self._npc_patrol_move_anim.addItem("")  # 留空 = 移动时不切动画
            anim_id = self._npc_anim.current_id().strip()
            names = (
                [str(k) for k in self._anim_states_from_model(anim_id).keys()]
                if anim_id else [])
            saved = ""
            pat = self._pending_npc.get("patrol") if self._pending_npc else None
            if isinstance(pat, dict):
                saved = str(pat.get("moveAnimState", "") or "").strip()
            if saved and saved not in names:
                names.insert(0, saved)
            for n in names:
                self._npc_patrol_move_anim.addItem(n)
            idx = self._npc_patrol_move_anim.findText(saved) if saved else 0
            self._npc_patrol_move_anim.setCurrentIndex(idx if idx >= 0 else 0)
        finally:
            self._npc_patrol_move_anim.blockSignals(False)

    def load_npc_props(self, npc: dict) -> None:
        with self._suppress_props_changed_emits():
            self.flush_active_panel_widgets_to_staging(only_shared_scene_staging=True)
            self._set_pending_dirty(False)
            self._ensure_source_scene_for_editing()
            if (
                self._stack.currentWidget() == self._npc_panel
                and self._pending_npc is not None
            ):
                pid = str(self._pending_npc.get("id", "") or "")
                nid = str(npc.get("id", "") or "")
                if pid and nid and pid != nid:
                    self.npc_patrol_preview_changed.emit(pid, False)
            self._source_npc = npc
            st = copy.deepcopy(npc)
            self._staging_npc = st
            self._pending_npc = st
            self._current_data = st
            self._stack.setCurrentWidget(self._npc_panel)
            self._npc_id.setText(st.get("id", ""))
            self._npc_name.setText(st.get("name", ""))
            self._npc_x.blockSignals(True)
            self._npc_y.blockSignals(True)
            try:
                self._npc_x.setValue(st.get("x", 0))
                self._npc_y.setValue(st.get("y", 0))
            finally:
                self._npc_x.blockSignals(False)
                self._npc_y.blockSignals(False)
            g_items = [(gid, gid) for gid in self._model.all_dialogue_graph_ids()]
            cur_g = str(st.get("dialogueGraphId", "") or "").strip()
            if cur_g and all(x[0] != cur_g for x in g_items):
                g_items = [(cur_g, cur_g)] + g_items
            self._npc_dialogue_graph.set_items(g_items)
            self._npc_dialogue_graph.set_current(cur_g)
            self._set_npc_dialogue_entry_choices(
                cur_g, str(st.get("dialogueGraphEntry", "") or ""))
            self._npc_dialogue_zoom.blockSignals(True)
            try:
                self._npc_dialogue_zoom.setValue(float(st.get("dialogueCameraZoom", 1.0)))
            except (TypeError, ValueError):
                self._npc_dialogue_zoom.setValue(1.0)
            self._npc_dialogue_zoom.blockSignals(False)
            self._npc_range.blockSignals(True)
            self._npc_range.setValue(st.get("interactionRange", 50))
            self._npc_range.blockSignals(False)
            self._npc_cutscene_ids_pending = self._entity_cutscene_ids_from_data(st)
            self._npc_cutscene_ids_label.setText(
                self._format_cutscene_ids_label(self._npc_cutscene_ids_pending),
            )
            self._sync_npc_cutscene_only_checkbox()
            self._npc_plane_ids_pending = self._entity_plane_ids_from_data(st)
            self._npc_plane_ids_label.setText(
                self._format_plane_ids_label(self._npc_plane_ids_pending),
            )
            self._npc_cond.set_flag_pattern_context(self._model, self._editing_scene_id or None)
            self._npc_cond.set_data(st.get("conditions", []))
            self._npc_cond_hide_entity.blockSignals(True)
            self._npc_cond_hide_entity.setChecked(st.get("conditionHidesEntity", False) is True)
            self._npc_cond_hide_entity.blockSignals(False)
            self._npc_cast_shadow.blockSignals(True)
            self._npc_cast_shadow.setChecked(st.get("castShadow", True) is not False)
            self._npc_cast_shadow.blockSignals(False)
            self._npc_facing.blockSignals(True)
            try:
                cur_f = str(st.get("initialFacing", "") or "").strip().lower()
                idx = self._npc_facing.findData("left" if cur_f == "left" else "right")
                self._npc_facing.setCurrentIndex(idx if idx >= 0 else 0)
            finally:
                self._npc_facing.blockSignals(False)
            a_items = self._model.anim_asset_path_choices()
            cur_a = st.get("animFile", "") or ""
            if cur_a and all(x[0] != cur_a for x in a_items):
                a_items = [(cur_a, cur_a)] + a_items
            self._npc_anim.blockSignals(True)
            try:
                self._npc_anim.set_items(a_items)
                self._npc_anim.set_current(cur_a)
            finally:
                self._npc_anim.blockSignals(False)
            p_items: list[tuple[str, str]] = [
                (s, s) for s in load_portrait_sets(self._model.project_path)
            ] if self._model.project_path is not None else []
            cur_p = st.get("portraitSlug", "") or ""
            if cur_p and all(x[0] != cur_p for x in p_items):
                p_items = [(cur_p, f"{cur_p}（缺集）")] + p_items
            self._npc_portrait.blockSignals(True)
            try:
                self._npc_portrait.set_items(p_items)
                self._npc_portrait.set_current(cur_p)
            finally:
                self._npc_portrait.blockSignals(False)
            # 角色引用：装下拉 + 设当前，再按继承态切 name/animFile/portrait 只读展示
            self._npc_character.blockSignals(True)
            try:
                self._npc_character.clear()
                for label, cid in self._npc_character_items():
                    self._npc_character.addItem(label, cid)
                cur_cid = str(st.get("characterId", "") or "").strip()
                if cur_cid and self._npc_character.findData(cur_cid) < 0:
                    self._npc_character.addItem(f"{cur_cid}（缺角色）", cur_cid)
                idx = self._npc_character.findData(cur_cid)
                self._npc_character.setCurrentIndex(idx if idx >= 0 else 0)
            finally:
                self._npc_character.blockSignals(False)
            self._apply_npc_character_inheritance()
            self._fill_npc_initial_state_combo()
            self._load_npc_patrol_ui(st)
            colp = st.get("collisionPolygon")
            has_ncc = isinstance(colp, list) and len(colp) >= 3
            self._npc_col_enable.blockSignals(True)
            self._npc_col_enable.setChecked(has_ncc)
            self._npc_col_enable.blockSignals(False)
            if has_ncc:
                if st.get("collisionPolygonLocal") is True:
                    self._set_npc_col_table(_hotspot_collision_local_to_world(st, colp))
                else:
                    self._set_npc_col_table(colp)
            else:
                self._npc_col_updating = True
                try:
                    self._npc_col_table.setRowCount(0)
                finally:
                    self._npc_col_updating = False
            self._npc_col_fold.set_expanded(has_ncc)
            self.npc_patrol_overlay_refresh_requested.emit()

    def _write_npc_widgets_to_dict(self, npc: dict) -> None:
        npc["id"] = self._npc_id.text().strip()
        _cid = str(self._npc_character.currentData() or "").strip()
        if _cid:
            # 引用角色：name/animFile/portraitSlug 默认继承角色注册表；仅「就地值异于继承」时写覆盖（本摆放换装）
            npc["characterId"] = _cid
            self._write_identity_override(npc, "name", self._npc_name.text().strip())
            self._write_identity_override(npc, "portraitSlug", self._npc_portrait.current_id().strip())
        else:
            npc.pop("characterId", None)
            npc["name"] = self._npc_name.text()
        npc["x"] = self._npc_x.value()
        npc["y"] = self._npc_y.value()
        fv = self._npc_facing.currentData()
        if fv == "left":
            npc["initialFacing"] = "left"
        elif "initialFacing" in npc:
            del npc["initialFacing"]
        for k in ("dialogueFile", "dialogueKnot"):
            if k in npc:
                del npc[k]
        dg = self._npc_dialogue_graph.current_id().strip()
        if dg:
            npc["dialogueGraphId"] = dg
        elif "dialogueGraphId" in npc:
            del npc["dialogueGraphId"]
        dge = self._npc_dialogue_graph_entry.committed_type().strip()
        if dge:
            npc["dialogueGraphEntry"] = dge
        elif "dialogueGraphEntry" in npc:
            del npc["dialogueGraphEntry"]
        zv = float(self._npc_dialogue_zoom.value())
        if abs(zv - 1.0) > 1e-6:
            npc["dialogueCameraZoom"] = zv
        elif "dialogueCameraZoom" in npc:
            del npc["dialogueCameraZoom"]
        npc["interactionRange"] = self._npc_range.value()
        npc_ids = [x for x in self._npc_cutscene_ids_pending if str(x).strip()]
        if npc_ids:
            npc["cutsceneIds"] = npc_ids
        else:
            npc.pop("cutsceneIds", None)
        npc.pop("cutsceneId", None)
        npc_planes = [x for x in self._npc_plane_ids_pending if str(x).strip()]
        if npc_planes:
            npc["planes"] = npc_planes
        else:
            npc.pop("planes", None)  # 缺省=存在于所有位面
        if self._entity_has_cutscene_binding(npc):
            if self._npc_cutscene_only.isChecked():
                npc.pop("cutsceneOnly", None)
            else:
                npc["cutsceneOnly"] = False
        else:
            npc.pop("cutsceneOnly", None)
        n_conds = self._npc_cond.to_list()
        if n_conds:
            npc["conditions"] = n_conds
        elif "conditions" in npc:
            del npc["conditions"]
        if self._npc_cond_hide_entity.isChecked():
            npc["conditionHidesEntity"] = True
        elif "conditionHidesEntity" in npc:
            del npc["conditionHidesEntity"]
        # castShadow 缺省开：仅取消勾选才落 false，勾选时省略字段（保持 JSON 干净 + 默认开）
        if not self._npc_cast_shadow.isChecked():
            npc["castShadow"] = False
        elif "castShadow" in npc:
            del npc["castShadow"]
        anim = self._npc_anim.current_id().strip()
        if _cid:
            # 引用角色：animFile 默认继承；异于继承才作本摆放覆盖写入
            self._write_identity_override(npc, "animFile", anim)
        elif anim:
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
            ma = self._npc_patrol_move_anim.currentText().strip()
            if ma:
                pat_out["moveAnimState"] = ma
            npc["patrol"] = pat_out
        elif "patrol" in npc:
            del npc["patrol"]
        if self._npc_col_enable.isChecked():
            poly_world = self._npc_col_polygon_from_table()
            if len(poly_world) >= 3:
                npc["collisionPolygon"] = _hotspot_collision_world_to_local(
                    npc, poly_world,
                )
                npc["collisionPolygonLocal"] = True
            elif "collisionPolygon" in npc:
                del npc["collisionPolygon"]
                npc.pop("collisionPolygonLocal", None)
        else:
            npc.pop("collisionPolygon", None)
            npc.pop("collisionPolygonLocal", None)
        self._emit_props_changed()

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
        lay.setAlignment(Qt.AlignmentFlag.AlignTop)
        top_g = self._section("基本：id 与区域类型", start_open=True)
        top_inner = QWidget()
        form = compact_form(QFormLayout(top_inner))
        self._zn_id = QLineEdit()
        form.addRow("id", self._zn_id)
        self._zn_id.textChanged.connect(lambda *_: self._emit_props_changed())
        self._zn_kind = QComboBox()
        self._zn_kind.addItem("普通（进出/停留）", "standard")
        self._zn_kind.addItem("深度 floor 修正（仅遮挡，脚底中心判点）", "depth_floor")
        self._zn_kind.currentIndexChanged.connect(self._on_zone_kind_changed)
        form.addRow("区域类型", self._zn_kind)
        self._zn_boost = QDoubleSpinBox()
        self._zn_boost.setRange(-1e6, 1e6)
        self._zn_boost.setDecimals(4)
        self._zn_boost.setToolTip(
            "depth_floor：叠加到深度遮挡 d_base（与场景 floor_offset 同语义）。重叠多区取 |值| 最大者。")
        self._zn_boost.valueChanged.connect(lambda _v: self._emit_props_changed())
        form.addRow("floorOffsetBoost", self._zn_boost)
        form.addRow("位面归属", self._make_plane_ids_row(
            "_zn_plane_ids_label",
            self._open_zn_plane_ids_picker,
            self._clear_zn_plane_ids,
        ))
        top_g.add_body(top_inner)
        lay.addWidget(top_g)

        poly_g = self._section("polygon 顶点表", start_open=False)
        self._zn_poly_fold = poly_g
        poly_g.set_header_tool_tip(
            "默认折叠；编辑顶点时展开。polygon 顶点（顺序为边界，首尾不重复）。画布操作：拖点 / 拖内部平移 / "
            "双击边中点附近插点 / Shift+单击顶点删点 / Del 删鼠标悬停顶点 / 右键顶点菜单也可删。")
        poly_inner = QWidget()
        poly_l = QVBoxLayout(poly_inner)
        poly_label = QLabel("顶点顺序即边界，首尾不重复。")
        poly_label.setWordWrap(True)
        poly_label.setToolTip(
            "画布操作：拖点 / 拖内部平移 / 双击边中点附近插点 / "
            "Shift+单击顶点删点 / Del 删鼠标悬停顶点 / 右键顶点菜单也可删。")
        poly_l.addWidget(poly_label)

        self._zn_poly_table = QTableWidget(0, 3)
        self._zn_poly_table.setToolTip(
            "画布操作：拖点 / 拖内部平移 / 双击边中点附近插点 / "
            "Shift+单击顶点删点 / Del 删鼠标悬停顶点 / 右键顶点菜单也可删。")
        self._zn_poly_table.setHorizontalHeaderLabels(["#", "x", "y"])
        self._zn_poly_table.horizontalHeader().setSectionResizeMode(
            0, QHeaderView.ResizeMode.ResizeToContents)
        self._zn_poly_table.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.Stretch)
        self._zn_poly_table.horizontalHeader().setSectionResizeMode(
            2, QHeaderView.ResizeMode.Stretch)
        self._zn_poly_table.setMinimumHeight(120)
        self._zn_poly_table.itemChanged.connect(self._on_zone_poly_cell_changed)
        self._install_vertex_table_affordances(
            self._zn_poly_table, self._on_zone_poly_remove_vertex)
        poly_l.addWidget(self._zn_poly_table)

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
        poly_l.addLayout(btn_row)
        poly_g.add_body(poly_inner)
        lay.addWidget(poly_g)

        cond_g = self._section("触发条件 conditions", start_open=False)
        cond_g.set_header_tool_tip("默认折叠；已配置条件时自动展开。")
        self._zn_cond_fold = cond_g
        cond_inner_z = QWidget()
        cond_l = QVBoxLayout(cond_inner_z)
        self._zn_cond = ConditionEditor("Conditions")
        self._zn_cond.changed.connect(self._emit_props_changed)
        cond_l.addWidget(self._zn_cond)
        cond_g.add_body(cond_inner_z)
        lay.addWidget(cond_g)

        act_g = self._section("动作：onEnter / onStay / onExit", start_open=False)
        act_inner = QWidget()
        act_l = QVBoxLayout(act_inner)
        self._zn_enter = ActionEditor("onEnter")
        self._zn_enter.changed.connect(self._emit_props_changed)
        act_l.addWidget(self._zn_enter)
        self._zn_stay = ActionEditor("onStay")
        self._zn_stay.changed.connect(self._emit_props_changed)
        act_l.addWidget(self._zn_stay)
        self._zn_exit = ActionEditor("onExit")
        self._zn_exit.changed.connect(self._emit_props_changed)
        act_l.addWidget(self._zn_exit)
        act_g.add_body(act_inner)
        self._zn_act_fold = act_g
        lay.addWidget(act_g)

        smell_g = self._section("区域气味（进入本区呈现·zone 层）", start_open=False)
        self._zn_smell_fold = smell_g
        smell_inner = QWidget()
        smell_form = compact_form(QFormLayout(smell_inner))
        # scent 从 smell_profiles.json 下拉（进 load 时按 model 填充候选）；空=本区不配气味。
        self._zn_smell_scent = FilterableTypeCombo([], self, select_only=True)
        self._zn_smell_scent.setToolTip(
            "玩家进入本区自动呈现的环境气味（zone 层；离区自动撤回；被剧情 setSmell 的 action 层压过）。"
            "选「无」=本区不配气味。")
        self._zn_smell_scent.typeCommitted.connect(lambda _t: self._emit_props_changed())
        smell_form.addRow("气味 scent", self._zn_smell_scent)
        self._zn_smell_intensity = QSpinBox()
        self._zn_smell_intensity.setRange(0, 100)
        self._zn_smell_intensity.setValue(60)
        self._zn_smell_intensity.valueChanged.connect(lambda _v: self._emit_props_changed())
        smell_form.addRow("浓度 intensity", self._zn_smell_intensity)
        self._zn_smell_dir = QDoubleSpinBox()
        self._zn_smell_dir.setRange(-1.0, 1.0)
        self._zn_smell_dir.setSingleStep(0.1)
        self._zn_smell_dir.setDecimals(3)  # 与写回 round(...,3) 精度一致，载入 0.125 不被控件截断
        self._zn_smell_dir.setToolTip("方位偏向 -1..1（0=居中；气缕拖向来源那侧）。")
        self._zn_smell_dir.valueChanged.connect(lambda _v: self._emit_props_changed())
        smell_form.addRow("方位偏向 dir", self._zn_smell_dir)
        self._zn_smell_flicker = QCheckBox("波动 flicker（不稳的味在 HUD 上明灭跳）")
        self._zn_smell_flicker.toggled.connect(lambda _v: self._emit_props_changed())
        smell_form.addRow("", self._zn_smell_flicker)
        smell_g.add_body(smell_inner)
        lay.addWidget(smell_g)

        lay.addStretch(1)
        self._append_entity_delete_footer(lay)
        return w

    def _apply_zone_kind_ui(self) -> None:
        kind = self._zn_kind.currentData()
        is_depth = kind == "depth_floor"
        self._zn_boost.setEnabled(is_depth)
        for ae in (self._zn_enter, self._zn_stay, self._zn_exit):
            ae.setEnabled(not is_depth)
        # depth_floor 仅参与遮挡、无进出触发，气味无意义 → 禁用气味区
        self._zn_smell_fold.setEnabled(not is_depth)

    def _on_zone_kind_changed(self, _idx: int) -> None:
        self._apply_zone_kind_ui()
        self._emit_props_changed()

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
        # 三份顶点表中唯一漏置脏的一份：hotspot(:_emit_hs_col_polygon_if_valid)/NPC 都有，
        # zone 没有 → 只改侧栏顶点、切实体即丢（审查 P1-2）
        self._emit_props_changed()

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
        with self._suppress_props_changed_emits():
            self.flush_active_panel_widgets_to_staging(only_shared_scene_staging=True)
            self._set_pending_dirty(False)
            self._ensure_source_scene_for_editing()
            self._source_zone = zone
            st = copy.deepcopy(zone)
            self._staging_zone = st
            self._pending_zone = st
            self._current_data = st
            self._stack.setCurrentWidget(self._zone_panel)
            self._zn_id.setText(st.get("id", ""))
            self._zn_plane_ids_pending = self._entity_plane_ids_from_data(st)
            self._zn_plane_ids_label.setText(
                self._format_plane_ids_label(self._zn_plane_ids_pending),
            )
            poly = st.get("polygon")
            if isinstance(poly, list) and len(poly) >= 3:
                self._set_zone_poly_table(poly)
            else:
                pts = _zone_polygon_points_for_editor(st)
                self._set_zone_poly_table([{"x": x, "y": y} for x, y in pts])
            self._zn_cond.set_flag_pattern_context(self._model, self._editing_scene_id or None)
            self._zn_cond.set_data(st.get("conditions", []))
            self._zn_enter.set_project_context(self._model, self._editing_scene_id or None)
            self._zn_stay.set_project_context(self._model, self._editing_scene_id or None)
            self._zn_exit.set_project_context(self._model, self._editing_scene_id or None)
            self._zn_enter.set_data(st.get("onEnter", []))
            self._zn_stay.set_data(st.get("onStay", []))
            self._zn_exit.set_data(st.get("onExit", []))
            idx = self._zn_kind.findData(st.get("zoneKind") or "standard")
            self._zn_kind.setCurrentIndex(idx if idx >= 0 else 0)
            try:
                self._zn_boost.setValue(float(st.get("floorOffsetBoost", 0)))
            except (TypeError, ValueError):
                self._zn_boost.setValue(0.0)
            sm = st.get("smell") if isinstance(st.get("smell"), dict) else {}
            self._zn_smell_scent.set_entries(
                [("（无 zone 气味）", "")]
                + [(name, sid) for sid, name in (self._model.all_smell_profile_ids() if self._model else [])]
            )
            self._zn_smell_scent.set_committed_type(str(sm.get("scent") or ""))
            try:
                self._zn_smell_intensity.setValue(int(sm.get("intensity", 60)))
            except (TypeError, ValueError):
                self._zn_smell_intensity.setValue(60)
            try:
                self._zn_smell_dir.setValue(float(sm.get("dir", 0)))
            except (TypeError, ValueError):
                self._zn_smell_dir.setValue(0.0)
            self._zn_smell_flicker.setChecked(bool(sm.get("flicker", False)))
            self._zn_smell_fold.set_expanded(bool(sm.get("scent")))
            self._apply_zone_kind_ui()
            oe = st.get("onEnter") or []
            oy = st.get("onStay") or []
            ox = st.get("onExit") or []
            has_act = bool(
                (isinstance(oe, list) and len(oe) > 0)
                or (isinstance(oy, list) and len(oy) > 0)
                or (isinstance(ox, list) and len(ox) > 0)
            )
            self._zn_act_fold.set_expanded(has_act)
            _zn_conds = st.get("conditions")
            self._zn_cond_fold.set_expanded(
                bool(isinstance(_zn_conds, list) and len(_zn_conds) > 0))

    def _write_zone_widgets_to_dict(self, zone: dict) -> None:
        zone["id"] = self._zn_id.text().strip()
        zn_planes = [x for x in self._zn_plane_ids_pending if str(x).strip()]
        if zn_planes:
            zone["planes"] = zn_planes
        else:
            zone.pop("planes", None)  # 缺省=存在于所有位面
        poly = self._zone_polygon_from_table()
        if len(poly) >= 3:
            zone["polygon"] = poly
        for k in ("x", "y", "width", "height"):
            zone.pop(k, None)
        kind = self._zn_kind.currentData() or "standard"
        if kind == "depth_floor":
            zone["zoneKind"] = "depth_floor"
            zone["floorOffsetBoost"] = self._zn_boost.value()
            for k in ("onEnter", "onStay", "onExit", "smell"):
                zone.pop(k, None)
        else:
            zone.pop("zoneKind", None)
            zone.pop("floorOffsetBoost", None)
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
            scent = self._zn_smell_scent.committed_type().strip()
            if scent:
                old_sm = zone.get("smell") if isinstance(zone.get("smell"), dict) else {}
                sm: dict = {"scent": scent}
                inten = int(self._zn_smell_intensity.value())
                # 原本没有 intensity 且仍为运行时默认 60 → 不注入（省略即默认，SmellSystem.ts:23）
                if "intensity" in old_sm or inten != 60:
                    sm["intensity"] = self._keep_num(inten, old_sm.get("intensity"))
                dval = round(float(self._zn_smell_dir.value()), 3)
                if "dir" in old_sm and float(old_sm.get("dir") or 0) == float(self._zn_smell_dir.value()):
                    sm["dir"] = old_sm["dir"]  # 未改动按原精度回写（0.125 不被 round 成 0.13→0.125 显示截断）
                elif dval != 0:
                    sm["dir"] = dval
                if self._zn_smell_flicker.isChecked():
                    sm["flicker"] = True
                # 保留未知键
                for k, v in old_sm.items():
                    if k not in ("scent", "intensity", "dir", "flicker"):
                        sm[k] = v
                zone["smell"] = sm
            elif "smell" in zone:
                del zone["smell"]
        c = self._zn_cond.to_list()
        if c:
            zone["conditions"] = c
        elif "conditions" in zone:
            del zone["conditions"]
        if "ruleSlots" in zone:
            del zone["ruleSlots"]
        self._emit_props_changed()

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
        outer.setAlignment(Qt.AlignmentFlag.AlignTop)
        sp_g = self._section("出生点 key与坐标", start_open=True)
        sp_inner = QWidget()
        sp_l = QVBoxLayout(sp_inner)
        form_host = QWidget()
        form = compact_form(QFormLayout(form_host))
        self._sp_key = QLineEdit()
        self._sp_key.textChanged.connect(lambda *_: self._emit_props_changed())
        form.addRow("key", self._sp_key)
        self._sp_x = QDoubleSpinBox()
        self._sp_x.setRange(-99999, 99999)
        self._sp_x.setDecimals(1)
        self._sp_x.valueChanged.connect(lambda _v: self._emit_props_changed())
        form.addRow("x", self._sp_x)
        self._sp_y = QDoubleSpinBox()
        self._sp_y.setRange(-99999, 99999)
        self._sp_y.setDecimals(1)
        self._sp_y.valueChanged.connect(lambda _v: self._emit_props_changed())
        form.addRow("y", self._sp_y)
        self._sp_note = QLabel()
        self._sp_note.setWordWrap(True)
        form.addRow(self._sp_note)
        sp_l.addWidget(form_host)
        sp_g.add_body(sp_inner)
        outer.addWidget(sp_g)
        outer.addStretch(1)
        self._sp_delete_btn = self._append_entity_delete_footer(outer)
        return w

    def load_spawn_props(self, sc: dict, spawn_name: str) -> None:
        with self._suppress_props_changed_emits():
            # spawn 自身就写共享 _staging_scene；切走前 flush 保证 spawn 修改不丢。
            self.flush_active_panel_widgets_to_staging(only_shared_scene_staging=True)
            self._set_pending_dirty(False)
            self._ensure_source_scene_for_editing()
            scene_use = self._staging_scene
            if scene_use is None or scene_use.get("id") != sc.get("id"):
                scene_use = sc
            self._spawn_scene = scene_use
            self._spawn_flush_scene = scene_use
            self._spawn_name_original = spawn_name
            self._stack.setCurrentWidget(self._spawn_panel)
            if spawn_name == "default":
                pos = scene_use.get("spawnPoint")
                if not isinstance(pos, dict):
                    pos = {"x": 0, "y": 0}
                    scene_use["spawnPoint"] = pos
                self._sp_key.setReadOnly(True)
                self._sp_key.setText("default")
                self._sp_note.setText("默认出生点，写入 JSON 字段 spawnPoint。")
                self._sp_delete_btn.setEnabled(False)
                self._sp_delete_btn.setToolTip("默认出生点不可删除。")
            else:
                sps = scene_use.setdefault("spawnPoints", {})
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
        self._emit_props_changed()

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
        self._lightcurve_overlay_refresh_timer = QTimer(self)
        self._lightcurve_overlay_refresh_timer.setSingleShot(True)
        self._lightcurve_overlay_refresh_timer.timeout.connect(
            self._apply_lightcurve_overlay_refresh)

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
        add_btn.setToolTip("向当前场景新增实体（Hotspot / NPC / Zone / 出生点）")
        add_btn.setMenu(add_menu)
        add_btn.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        add_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextOnly)
        tb.addWidget(add_btn)
        save_btn = QPushButton("Apply")
        save_btn.setToolTip("提交右侧属性面板的修改到当前场景；不点则切换其它实体或场景时丢弃这些修改。")
        save_btn.clicked.connect(self._apply_props)
        tb.addWidget(save_btn)
        # 红色"未应用"提示：当前面板有未点 Apply 的 staging 修改时显示；
        # auto-discard 语义下，切换实体/场景会丢弃这些修改，需要让用户感知。
        self._pending_dirty_label = QLabel("● 未应用")
        self._pending_dirty_label.setStyleSheet(
            "color:#ff5555;font-weight:600;padding:0 6px;",
        )
        self._pending_dirty_label.setToolTip(
            "右侧属性面板有未 Apply 的修改；切换其它实体或场景会丢弃这些修改。",
        )
        self._pending_dirty_label.setVisible(False)
        tb.addWidget(self._pending_dirty_label)
        del_btn = QPushButton("Delete")
        del_btn.setToolTip("删除当前选中的实体")
        del_btn.clicked.connect(self._delete_selected)
        tb.addWidget(del_btn)
        refactor_menu = QMenu(self)
        refactor_menu.addAction("迁移到场景…", lambda: self._refactor_selected("move"))
        refactor_menu.addAction("重命名 id…", lambda: self._refactor_selected("rename"))
        refactor_menu.addAction("安全删除（引用报告）…", lambda: self._refactor_selected("delete"))
        refactor_menu.addSeparator()
        refactor_menu.addAction("撤销上次重构", self._undo_entity_refactor)
        refactor_btn = QToolButton()
        refactor_btn.setText("重构")
        refactor_btn.setToolTip(
            "选中 NPC / 热区 / Zone / 出生点后：跨场景迁移、全项目改名、带引用报告的安全删除；"
            "先扫描全项目引用并预览，确认才执行（未 Save All 前仅内存变更）。"
            "Zone 的入站引用与出生点的入站 transition/切场景动作会全量机械改写跟随；"
            "polygon / 坐标需迁移后在目标场景重画。")
        refactor_btn.setMenu(refactor_menu)
        refactor_btn.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        refactor_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextOnly)
        tb.addWidget(refactor_btn)
        ll.addWidget(tb)

        # canvas zoom controls (do not touch data; operate only on the view)
        zoom_tb = QToolBar()
        zoom_in_btn = QToolButton()
        zoom_in_btn.setText("+")
        zoom_in_btn.setToolTip("放大画布视图")
        zoom_in_btn.clicked.connect(self._on_canvas_zoom_in)
        zoom_tb.addWidget(zoom_in_btn)
        zoom_out_btn = QToolButton()
        zoom_out_btn.setText("−")
        zoom_out_btn.setToolTip("缩小画布视图")
        zoom_out_btn.clicked.connect(self._on_canvas_zoom_out)
        zoom_tb.addWidget(zoom_out_btn)
        zoom_fit_btn = QToolButton()
        zoom_fit_btn.setText("适配")
        zoom_fit_btn.setToolTip("将整个场景适配到画布视口（Fit）")
        zoom_fit_btn.clicked.connect(self._on_canvas_zoom_fit)
        zoom_tb.addWidget(zoom_fit_btn)
        ll.addWidget(zoom_tb)

        self._chk_npc_ref = QCheckBox("显示 NPC 比例参考框")
        self._chk_npc_ref.setChecked(True)
        self._chk_npc_ref.setToolTip(
            "在画布左上与右下绘制与角色动画 worldWidth×worldHeight 同尺寸的矩形，"
            "用于目测场景世界单位尺度（数据来自 animation/player_anim 等，不可点选拖动）。"
        )
        self._chk_npc_ref.toggled.connect(self._on_npc_ref_toggled)
        ll.addWidget(self._chk_npc_ref)

        self._chk_block_zone_pick = QCheckBox(
            "锁定 Zone / 碰撞多边形点选")
        self._chk_block_zone_pick.setChecked(False)
        self._chk_block_zone_pick.setToolTip(
            "勾选后，独立 Zone 与 Hotspot、NPC 的碰撞多边形在画布上显示为灰色，且无法用鼠标选中、"
            "拖顶点或整体平移，便于点选叠在一起的其它实体。右侧属性与顶点表仍可编辑。"
        )
        self._chk_block_zone_pick.toggled.connect(self._on_block_zone_pick_toggled)
        ll.addWidget(self._chk_block_zone_pick)

        self._scene_edit_cutscene_id = ""
        _ctx_lab = QLabel("过场编辑视图")
        _ctx_lab.setToolTip(
            "不加载过场时画布隐藏 cutsceneOnly 的 NPC/Hotspot；cutsceneOnly 关闭的共享实体与常规实体始终显示。"
            "选择某过场后会额外显示绑定该 id 的仅过场实体。"
        )
        ll.addWidget(_ctx_lab)
        self._combo_cutscene_ctx = FilterableTypeCombo([], self, select_only=True)
        self._combo_cutscene_ctx.setToolTip(_ctx_lab.toolTip())
        self._combo_cutscene_ctx.typeCommitted.connect(self._on_cutscene_edit_context_changed)
        ll.addWidget(self._combo_cutscene_ctx)

        _plane_lab = QLabel("位面视图")
        _plane_lab.setToolTip(
            "只显示归属所选位面的实体；缺省（无 planes 字段）实体按该位面世界模型——"
            "共享世界型(shared)显示、独立世界型(exclusive)隐藏，与运行时位面显隐同口径。"
            "纯预览过滤，不改数据；选「全部位面」= 不过滤。"
        )
        ll.addWidget(_plane_lab)
        self._combo_plane_view = FilterableTypeCombo([], self, select_only=True)
        self._combo_plane_view.setToolTip(_plane_lab.toolTip())
        self._combo_plane_view.typeCommitted.connect(self._on_plane_view_changed)
        ll.addWidget(self._combo_plane_view)

        self._btn_new_scene = QPushButton("+ 新建场景")
        self._btn_new_scene.setToolTip(
            "创建一个新的空场景（最小骨架：id / name / 出生点）。"
            "背景图与世界尺寸随后在右侧场景属性面板配置；深度/碰撞为可选附加层，"
            "需要时再用 Scene Depth Editor 处理。")
        self._btn_new_scene.clicked.connect(self._new_scene)
        ll.addWidget(self._btn_new_scene)

        self._scene_list = QListWidget()
        self._scene_list.currentItemChanged.connect(self._on_scene_selected)
        self._scene_search = make_list_search_box(
            self._scene_list,
            tooltip="按场景 id / 名称过滤下方列表（仅隐藏不匹配项，不改动数据）。")
        ll.addWidget(self._scene_search)
        ll.addWidget(self._scene_list)

        # center: canvas
        self._canvas = SceneCanvas()
        self._canvas.set_project_model(model)
        self._canvas.item_selected.connect(self._on_item_selected)
        self._canvas.item_deselected.connect(self._on_item_deselected)
        self._canvas.item_moved.connect(self._on_item_moved)
        self._canvas.item_position_live.connect(self._on_item_position_live)
        self._canvas.item_zone_polygon_committed.connect(
            self._on_item_zone_polygon_committed)
        self._canvas.item_hotspot_collision_polygon_committed.connect(
            self._on_item_hotspot_collision_polygon_committed)
        self._canvas.item_npc_collision_polygon_committed.connect(
            self._on_item_npc_collision_polygon_committed)
        self._canvas.context_add_entity.connect(self._on_canvas_context_add_entity)

        # right: property panel
        self._props = ScenePropertyPanel(model)
        self._props.interaction_range_changed.connect(self._on_props_interaction_range_changed)
        self._props.zone_polygon_changed.connect(self._on_props_zone_polygon_changed)
        self._props.hotspot_collision_polygon_changed.connect(
            self._on_props_hotspot_collision_polygon_changed)
        self._props.npc_collision_polygon_changed.connect(
            self._on_props_npc_collision_polygon_changed)
        self._props.hotspot_visual_refresh_requested.connect(
            self._on_hotspot_visual_refresh_requested)
        self._props.scene_background_changed.connect(
            self._on_scene_background_changed)
        self._props.npc_scene_anim_refresh_requested.connect(
            self._on_npc_scene_anim_refresh_requested)
        self._props.npc_xy_live_changed.connect(self._on_npc_xy_live_changed)
        self._props.delete_current_entity_requested.connect(self._delete_selected)
        self._props.npc_patrol_overlay_refresh_requested.connect(
            self._refresh_npc_patrol_overlay)
        self._props.lightcurve_overlay_refresh_requested.connect(
            self._refresh_lightcurve_overlay)
        self._props.npc_patrol_preview_changed.connect(
            self._on_npc_patrol_preview_changed)
        # QueuedConnection：避免在按钮 click 槽里同步触发 toolbar setVisible
        # 引起 layout 重排与画布 paintEvent 重入。可用 EDITOR_DISABLE_DIRTY_LABEL=1
        # 完全跳过这条通路用于二分定位。
        if os.environ.get("EDITOR_DISABLE_DIRTY_LABEL") != "1":
            self._props.pending_dirty_changed.connect(
                self._pending_dirty_label.setVisible,
                Qt.ConnectionType.QueuedConnection,
            )
        self._canvas.item_npc_patrol_route_committed.connect(
            self._on_npc_patrol_route_committed)
        self._canvas.item_lightcurve_committed.connect(
            self._on_lightcurve_committed)

        splitter.addWidget(left)
        splitter.addWidget(self._canvas)
        splitter.addWidget(self._props)
        splitter.setSizes([160, 740, 300])  # 合计 1200，13"(1240) 可容；仍可拖动
        root.addWidget(splitter)

        del_sc = QShortcut(QKeySequence.StandardKey.Delete, self)
        del_sc.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        del_sc.activated.connect(self._on_delete_key_shortcut)
        bs_sc = QShortcut(QKeySequence(Qt.Key.Key_Backspace), self)
        bs_sc.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        bs_sc.activated.connect(self._on_delete_key_shortcut)

        self._refresh_scene_list()
        self._refill_scene_cutscene_ctx_combo(init=True)
        self._refill_scene_plane_view_combo(init=True)

    def reload_refs_from_model(self) -> None:
        """切页激活时,让属性面板重拉跨域引用候选(filter/item/encounter)。"""
        self._props.reload_refs_from_model()
        # 位面面板可能新增/删位面：刷新「位面视图」下拉候选（保留当前选中）。
        self._refill_scene_plane_view_combo()

    def _refill_scene_plane_view_combo(self, *, init: bool = False) -> None:
        w = getattr(self, "_combo_plane_view", None)
        if not isinstance(w, FilterableTypeCombo):
            return
        prev = "" if init else w.committed_type().strip()
        rows: list[tuple[str, str]] = [("（全部位面）", "")]
        rows += [
            (f"{pid}（{label}）" if label and str(label) != pid else pid, pid)
            for pid, label in self._model.all_plane_ids()
        ]
        w.set_entries(rows)
        keys = {v for _a, v in rows}
        w.set_committed_type(prev if (prev and prev in keys) else "")
        # 候选变化后按当前选中重贴一次（选中位面被删则回落到全部=显示全部）。
        pid0 = w.committed_type().strip()
        self._canvas.set_plane_filter(
            pid0 or None, exclusive=self._plane_view_exclusive(pid0))

    def _plane_view_exclusive(self, pid: str) -> bool:
        """所选位面是否独立世界型（含 extends 链解析），与运行时缺省实体口径一致。"""
        return bool(pid) and self._model.plane_membership(pid) == "exclusive"

    def activate_plane_view(self, plane_id: str) -> None:
        """外部跳转入口（位面面板 hub）：打开指定位面的位面视图（空/未知 id 回落全部）。"""
        w = getattr(self, "_combo_plane_view", None)
        if not isinstance(w, FilterableTypeCombo):
            return
        self._refill_scene_plane_view_combo()
        pid = str(plane_id or "").strip()
        known = {p for p, _ in self._model.all_plane_ids()}
        w.set_committed_type(pid if pid in known else "")
        self._on_plane_view_changed()

    def _on_plane_view_changed(self, _t: str = "") -> None:
        w = getattr(self, "_combo_plane_view", None)
        pid = w.committed_type().strip() if isinstance(w, FilterableTypeCombo) else ""
        self._canvas.set_plane_filter(
            pid or None, exclusive=self._plane_view_exclusive(pid))

    def _refill_scene_cutscene_ctx_combo(self, *, init: bool = False) -> None:
        w = getattr(self, "_combo_cutscene_ctx", None)
        if not isinstance(w, FilterableTypeCombo):
            return
        prev = ""
        if not init:
            prev = w.committed_type().strip()
        rows = [("（不加载：隐藏绑定实体）", "")]
        rows += [(cid, cid) for cid, _ in self._model.all_cutscene_ids()]
        w.set_entries(rows)
        keys = {v for _a, v in rows}
        if prev and prev in keys:
            w.set_committed_type(prev)
        elif not init:
            w.set_committed_type("")

    def _on_cutscene_edit_context_changed(self, _t: str = "") -> None:
        w = getattr(self, "_combo_cutscene_ctx", None)
        cid = ""
        if isinstance(w, FilterableTypeCombo):
            cid = w.committed_type().strip()
        self._scene_edit_cutscene_id = cid
        if self._current_scene_id:
            self._load_scene(self._current_scene_id, reset_view=False)

    def _entity_visible_for_cutscene_edit(self, ent: dict) -> bool:
        bindings = _entity_cutscene_ids_from_data(ent)
        if not bindings:
            return True
        if not _entity_is_cutscene_only(ent):
            return True
        ctx = getattr(self, "_scene_edit_cutscene_id", "").strip()
        return bool(ctx) and ctx in bindings

    def _clear_scene_npc_anim_layers(self) -> None:
        self._scene_npc_anim_timer.stop()
        self._scene_npc_runtimes.clear()
        self._patrol_preview_ids.clear()
        self._patrol_preview_state.clear()

    def _refresh_lightcurve_overlay(self) -> None:
        self._lightcurve_overlay_refresh_timer.start(0)

    def _apply_lightcurve_overlay_refresh(self) -> None:
        """把当前场景的光环境曲线点列同步到画布 overlay（任何属性页下都显示,便于随时拖动）。"""
        data = self._props._sc_lightcurve_points
        pts: list | None = None
        if isinstance(data, list) and data:
            pts = [
                {"x": d.get("x", 0), "y": d.get("y", 0), "env": d.get("env", {})}
                for d in data if isinstance(d, dict)
            ]
        rw, _rh = _npc_reference_world_size(self._model)  # 代表性角色宽,使接触椭圆与实际站位一致
        self._canvas.set_lightcurve_overlay(
            pts, selected=self._props._lc_selected, ref_width=rw)

    def _on_lightcurve_committed(self, points: object) -> None:
        self._props.apply_lightcurve_committed(points)

    def _refresh_npc_patrol_overlay(self) -> None:
        self._patrol_overlay_refresh_timer.start(0)

    def _apply_npc_patrol_overlay_refresh(self) -> None:
        """只对当前编辑的 NPC 同步 patrol overlay；其它残留 overlay 一并清理。"""
        npc = self._props._pending_npc
        active_npc_id = ""
        active_route: list | None = None
        if (
            self._props._stack.currentWidget() == self._props._npc_panel
            and npc is not None
            and self._props._npc_patrol_enable.isChecked()
        ):
            active_npc_id = str(npc.get("id", "") or "")
            r = (npc.get("patrol") or {}).get("route")
            if isinstance(r, list) and len(r) >= 2:
                active_route = r
        for nid in list(self._canvas._patrol_overlays.keys()):
            if nid != active_npc_id:
                self._canvas.remove_npc_patrol_overlay(nid)
        if active_npc_id:
            self._canvas.set_npc_patrol_overlay(active_npc_id, active_route)

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
        npc_st = self._props._staging_npc
        target: dict | None = None
        if npc_st is not None and str(npc_st.get("id", "")) == str(npc_id):
            target = npc_st
        else:
            for n in sc.get("npcs", []):
                if isinstance(n, dict) and str(n.get("id", "")) == npc_id:
                    target = n
                    break
        if target is None:
            return
        pat = target.setdefault("patrol", {})
        pat["route"] = norm
        self._mark_canvas_edit()
        self._props.refresh_npc_patrol_table(npc_id, norm)
        self._patrol_preview_state.pop(npc_id, None)

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
        # characterId 引用的 NPC 无就地 animFile，须经角色注册表解析（否则画布不出 sprite）
        anim_id = self._model.character_field(npc, "animFile").strip()
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
        facing = str(npc.get("initialFacing", "") or "").strip().lower()
        rt.facing_x = -1 if facing == "left" else 1
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

    @Slot()
    def _npc_render_pos_dict(self, rid: str, model_npc: dict) -> dict:
        """统一的 NPC 位置真相源：正在编辑（staging）的那个 NPC 读 staging，其它读模型。

        这是修复"精灵闪烁/不跟随"的关键——动画定时器、draw_at、refresh 都经此解析，
        与拖拽/数值框写入处一致，杜绝"定时器读模型、编辑写 staging"的每 8ms 回弹。
        与 _staging_npc_for_canvas_drag 同源（拖拽写哪里、这里就读哪里）。
        """
        sn = self._props._staging_npc
        if sn is not None and str(sn.get("id", "")) == str(rid):
            return sn
        return model_npc

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
                pos = self._npc_render_pos_dict(rid, npc)
                x = float(pos.get("x", 0))
                y = float(pos.get("y", 0))
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
        npc_st = self._props._staging_npc
        n = None
        if npc_st is not None and str(npc_st.get("id", "")) == str(npc_id):
            n = npc_st
        else:
            sc = self._model.scenes.get(self._current_scene_id or "")
            if not sc:
                return
            for cand in sc.get("npcs", []):
                if isinstance(cand, dict) and str(cand.get("id", "")) == npc_id:
                    n = cand
                    break
        if n is None:
            return
        self._canvas.move_entity_handle("npc", npc_id, n.get("x", 0), n.get("y", 0))
        self._canvas.refresh_npc_collision_visuals(n)
        if rt is None:
            return
        if npc_id not in self._patrol_preview_ids:
            rt.draw_at(float(n.get("x", 0)), float(n.get("y", 0)))
            self._canvas.viewport().update()

    def _new_scene(self) -> None:
        sid, ok = QInputDialog.getText(
            self, "新建场景", "场景 id（仅字母 / 数字 / 下划线 / 连字符）：")
        if not ok:
            return
        sid = (sid or "").strip()
        if not sid:
            return
        if not re.match(r"^[A-Za-z0-9_\-]+$", sid):
            QMessageBox.warning(
                self, "新建场景",
                f"非法场景 id：{sid!r}\n仅允许字母、数字、下划线、连字符。")
            return
        if sid in self._model.scenes:
            QMessageBox.warning(self, "新建场景", f"场景 id 已存在：{sid}")
            return
        name, ok = QInputDialog.getText(
            self, "新建场景", "场景显示名（留空则用 id）：", text=sid)
        if not ok:
            return
        name = (name or "").strip() or sid

        # 最小合法骨架：world 尺寸留 0（导入背景后按图推导）、背景空、给个出生点占位。
        self._model.scenes[sid] = {
            "id": sid,
            "name": name,
            "worldWidth": 0,
            "worldHeight": 0,
            "backgrounds": [],
            "spawnPoint": {"x": 400.0, "y": 400.0},
            "hotspots": [],
            "npcs": [],
            "zones": [],
        }
        # 不预建任何目录：本场景 runtime 目录在导入背景图时按需创建（仅落在该场景目录内）。
        self._model.mark_dirty("scene", sid)

        # 清空搜索，保证新场景在列表中可见再选中。
        try:
            self._scene_search.clear()
        except (AttributeError, RuntimeError):
            pass
        self._refresh_scene_list()
        for i in range(self._scene_list.count()):
            it = self._scene_list.item(i)
            if it is not None and it.data(Qt.ItemDataRole.UserRole) == sid:
                self._scene_list.setCurrentItem(it)
                break

    def _refresh_scene_list(self) -> None:
        self._scene_list.clear()
        for sid in sorted(self._model.scenes.keys()):
            sc = self._model.scenes[sid]
            item = QListWidgetItem(f"{sid}  [{sc.get('name', '')}]")
            item.setData(Qt.ItemDataRole.UserRole, sid)
            self._scene_list.addItem(item)
        # 重新套用搜索过滤，使 setHidden 与新内容一致
        self._scene_search.textChanged.emit(self._scene_search.text())
        if self._scene_list.count() > 0 and self._scene_list.currentRow() < 0:
            self._scene_list.setCurrentRow(0)

    def _on_scene_selected(self, current: QListWidgetItem | None, _prev) -> None:
        if current is None:
            return
        sid = current.data(Qt.ItemDataRole.UserRole)
        self._load_scene(sid)

    def _load_scene(self, scene_id: str, *, reset_view: bool = True) -> None:
        # 离开当前场景前先提交未应用的画布/面板编辑，避免切场景静默丢弃。
        self._commit_pending_scene_edits()
        self._current_scene_id = scene_id
        sc = self._model.scenes.get(scene_id)
        if sc is None:
            return
        if _migrate_scene_hotspot_collision_to_local(sc):
            self._model.mark_dirty("scene", scene_id)
        self._clear_scene_npc_anim_layers()
        self._canvas.clear_scene()

        img_path = _scene_background_disk_path(self._model, scene_id, sc)

        world_w, world_h = resolve_world_size_for_scene_json(sc, img_path)
        self._canvas.setup_world(world_w, world_h)

        if img_path:
            self._canvas.load_background(img_path, world_w, world_h)

        try:
            self._canvas._gfx.clearSelection()
        except (AttributeError, RuntimeError):
            pass
        self._on_item_deselected()

        for hs in sc.get("hotspots", []):
            if isinstance(hs, dict) and self._entity_visible_for_cutscene_edit(hs):
                self._canvas.add_hotspot(hs)
        for npc in sc.get("npcs", []):
            if isinstance(npc, dict) and self._entity_visible_for_cutscene_edit(npc):
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
        self._canvas.set_zone_pick_frozen(self._chk_block_zone_pick.isChecked())

    def _on_npc_ref_toggled(self, checked: bool) -> None:
        self._canvas.set_npc_reference_visible(checked)
        if self._last_canvas_world is None:
            return
        ww, wh = self._last_canvas_world
        rw, rh = _npc_reference_world_size(self._model)
        self._canvas.rebuild_npc_reference(ww, wh, rw, rh)

    def _on_block_zone_pick_toggled(self, checked: bool) -> None:
        if checked:
            for it in list(self._canvas._gfx.selectedItems()):
                if isinstance(it, _EditableZonePolygon):
                    it.setSelected(False)
        self._canvas.set_zone_pick_frozen(checked)

    def _on_canvas_zoom_in(self) -> None:
        # mirror wheelEvent zoom factor; pure view transform, no data change
        self._canvas._auto_fit_after_layout = False
        self._canvas.scale(1.15, 1.15)

    def _on_canvas_zoom_out(self) -> None:
        self._canvas._auto_fit_after_layout = False
        self._canvas.scale(1 / 1.15, 1 / 1.15)

    def _on_canvas_zoom_fit(self) -> None:
        self._canvas.fit_all()

    def _on_item_selected(self, kind: str, eid: str) -> None:
        if kind not in ("npc", "npc_collision"):
            self._patrol_preview_ids.clear()
            self._patrol_preview_state.clear()
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return
        # 已经在编辑同一实体则跳过 load_*_props 重装：拖动结束后 SceneCanvas
        # mouseReleaseEvent 会顺手 emit item_selected，若不短路就会用 source 的
        # 旧 x/y 覆盖刚 sync 到 widgets 的新坐标，造成"画布对、属性弹回"。
        props = self._props
        if kind in ("hotspot", "hotspot_collision"):
            for hs in sc.get("hotspots", []):
                if hs.get("id") == eid:
                    sh = props._staging_hotspot
                    if (
                        props._stack.currentWidget() == props._hotspot_panel
                        and sh is not None
                        and str(sh.get("id", "")) == str(eid)
                    ):
                        return
                    self._commit_pending_scene_edits()
                    props.load_hotspot_props(hs)
                    return
        elif kind in ("npc", "npc_collision"):
            for npc in sc.get("npcs", []):
                if npc.get("id") == eid:
                    sn = props._staging_npc
                    if (
                        props._stack.currentWidget() == props._npc_panel
                        and sn is not None
                        and str(sn.get("id", "")) == str(eid)
                    ):
                        return
                    self._commit_pending_scene_edits()
                    props.load_npc_props(npc)
                    return
        elif kind == "zone":
            for zone in sc.get("zones", []):
                if zone.get("id") == eid:
                    sz = props._staging_zone
                    if (
                        props._stack.currentWidget() == props._zone_panel
                        and sz is not None
                        and str(sz.get("id", "")) == str(eid)
                    ):
                        return
                    self._commit_pending_scene_edits()
                    props.load_zone_props(zone)
                    return
        elif kind == "spawn":
            if (
                props._stack.currentWidget() == props._spawn_panel
                and str(props._spawn_name_original or "") == str(eid)
            ):
                return
            self._commit_pending_scene_edits()
            scene_use = props._staging_scene
            if scene_use is None or scene_use.get("id") != sc.get("id"):
                scene_use = sc
            props.load_spawn_props(scene_use, eid)

    def _on_item_deselected(self) -> None:
        if self._current_scene_id:
            sc = self._model.scenes.get(self._current_scene_id)
            if sc:
                # 点画布空白=离开当前实体，与切实体路径一致：先提交未应用编辑再回场景面板。
                # 旧实现直接重建 staging，把编辑连同 pending 标志一起静默丢弃（审查 P0-3）。
                self._commit_pending_scene_edits()
                sc = self._model.scenes.get(self._current_scene_id) or sc
                self._props.load_scene_props(sc, clear_pending_edits=False)
        self._refresh_npc_patrol_overlay()

    def _on_props_interaction_range_changed(self, kind: str, eid: str, r: float) -> None:
        if eid:
            self._canvas.update_interaction_range(kind, eid, r)

    def _on_props_zone_polygon_changed(self, eid: str, polygon: object) -> None:
        poly_list = polygon if isinstance(polygon, list) else []
        if len(poly_list) < 3:
            return
        z_st = self._props._staging_zone
        if z_st is None or str(z_st.get("id", "")) != str(eid):
            return
        z_st["polygon"] = poly_list
        for k in ("x", "y", "width", "height"):
            z_st.pop(k, None)
        self._canvas.update_zone_polygon(eid, poly_list)

    def _on_item_zone_polygon_committed(
        self,
        kind: str,
        eid: str,
        polygon: object,
    ) -> None:
        poly_list = polygon if isinstance(polygon, list) else []
        if len(poly_list) < 3:
            return
        z_st = self._props._staging_zone
        if z_st is not None and str(z_st.get("id", "")) == str(eid):
            z_st["polygon"] = poly_list
            for k2 in ("x", "y", "width", "height"):
                z_st.pop(k2, None)
        else:
            sc = self._model.scenes.get(self._current_scene_id or "")
            if sc is None:
                return
            for zone in sc.get("zones", []):
                if zone.get("id") == eid:
                    zone["polygon"] = poly_list
                    for k2 in ("x", "y", "width", "height"):
                        zone.pop(k2, None)
                    break
            else:
                return
        self._mark_canvas_edit()
        self._props.refresh_zone_polygon_table(eid, poly_list)
        self._canvas.item_selected.emit(kind, eid)

    def _on_item_hotspot_collision_polygon_committed(self, eid: str, polygon: object) -> None:
        poly_list = polygon if isinstance(polygon, list) else []
        if len(poly_list) < 3:
            return
        hs_st = self._props._staging_hotspot
        target: dict | None = None
        if hs_st is not None and str(hs_st.get("id", "")) == str(eid):
            target = hs_st
        else:
            sc = self._model.scenes.get(self._current_scene_id or "")
            if sc is None:
                return
            for hs in sc.get("hotspots", []):
                if hs.get("id") == eid:
                    target = hs
                    break
        if target is None:
            return
        target["collisionPolygon"] = _hotspot_collision_world_to_local(target, poly_list)
        target["collisionPolygonLocal"] = True
        self._mark_canvas_edit()

        def _deferred_hotspot_collision_ui() -> None:
            self._props.refresh_hotspot_collision_table(eid)
            self._canvas.item_selected.emit("hotspot_collision", eid)

        QTimer.singleShot(0, _deferred_hotspot_collision_ui)

    def _on_props_hotspot_collision_polygon_changed(self, eid: str, polygon: object) -> None:
        poly_list = polygon if isinstance(polygon, list) else []
        if len(poly_list) < 3:
            return
        self._canvas.update_hotspot_collision_polygon(eid, poly_list)

    def _on_item_npc_collision_polygon_committed(self, eid: str, polygon: object) -> None:
        poly_list = polygon if isinstance(polygon, list) else []
        if len(poly_list) < 3:
            return
        npc_st = self._props._staging_npc
        target: dict | None = None
        if npc_st is not None and str(npc_st.get("id", "")) == str(eid):
            target = npc_st
        else:
            sc = self._model.scenes.get(self._current_scene_id or "")
            if sc is None:
                return
            for npc in sc.get("npcs", []):
                if npc.get("id") == eid:
                    target = npc
                    break
        if target is None:
            return
        target["collisionPolygon"] = _hotspot_collision_world_to_local(target, poly_list)
        target["collisionPolygonLocal"] = True
        self._mark_canvas_edit()

        def _deferred_npc_collision_ui() -> None:
            self._props.refresh_npc_collision_table(eid)
            self._canvas.item_selected.emit("npc_collision", eid)

        QTimer.singleShot(0, _deferred_npc_collision_ui)

    def _on_props_npc_collision_polygon_changed(self, eid: str, polygon: object) -> None:
        poly_list = polygon if isinstance(polygon, list) else []
        if len(poly_list) < 3:
            sc = self._model.scenes.get(self._current_scene_id or "")
            if sc is None:
                return
            for npc in sc.get("npcs", []):
                if str(npc.get("id", "")) == eid:
                    self._canvas.refresh_npc_collision_visuals(npc)
                    return
            return
        self._canvas.update_npc_collision_polygon(eid, poly_list)

    def _on_hotspot_visual_refresh_requested(self, eid: str) -> None:
        if not eid:
            return
        hs_st = self._props._staging_hotspot
        if hs_st is not None and str(hs_st.get("id", "")) == str(eid):
            self._canvas.move_entity_handle("hotspot", eid, hs_st.get("x", 0), hs_st.get("y", 0))
            self._canvas.refresh_hotspot_visuals(hs_st)
            return
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return
        for hs in sc.get("hotspots", []):
            if hs.get("id") == eid:
                self._canvas.move_entity_handle("hotspot", eid, hs.get("x", 0), hs.get("y", 0))
                self._canvas.refresh_hotspot_visuals(hs)
                return

    def _on_item_position_live(
        self, kind: str, eid: str, x: float, y: float,
    ) -> None:
        rx = round(x, 1)
        ry = round(y, 1)
        if kind == "hotspot":
            hs = self._staging_hotspot_for_canvas_drag(eid)
            if hs is None:
                return
            hs["x"] = rx
            hs["y"] = ry
            self._canvas.refresh_hotspot_visuals(hs)
            self._props.sync_hotspot_xy_widgets(eid, rx, ry)
            return
        if kind == "npc":
            npc = self._staging_npc_for_canvas_drag(eid)
            if npc is None:
                return
            npc["x"] = rx
            npc["y"] = ry
            self._patrol_preview_state.pop(eid, None)
            rt = self._scene_npc_runtimes.get(eid)
            if rt is not None:
                rt.draw_at(float(rx), float(ry))
                self._canvas.viewport().update()
            self._canvas.refresh_npc_collision_visuals(npc)
            self._props.sync_npc_xy_widgets(eid, rx, ry)
            return
        if kind == "spawn":
            scw = self._spawn_scene_write_dict()
            if scw is None:
                return
            if eid == "default":
                scw["spawnPoint"] = {"x": rx, "y": ry}
            else:
                sps = scw.setdefault("spawnPoints", {})
                sps[eid] = {"x": rx, "y": ry}
            self._props.sync_spawn_xy_widgets(eid, rx, ry)

    def _on_item_moved(self, kind: str, eid: str, x: float, y: float) -> None:
        rx = round(x, 1)
        ry = round(y, 1)
        if kind == "hotspot":
            hs = self._staging_hotspot_for_canvas_drag(eid)
            if hs is None:
                return
            hs["x"] = rx
            hs["y"] = ry
            self._canvas.refresh_hotspot_visuals(hs)
            self._props.sync_hotspot_xy_widgets(eid, rx, ry)
            self._mark_canvas_edit()
            return
        if kind == "npc":
            npc = self._staging_npc_for_canvas_drag(eid)
            if npc is None:
                return
            npc["x"] = rx
            npc["y"] = ry
            self._patrol_preview_state.pop(eid, None)
            rt = self._scene_npc_runtimes.get(eid)
            if rt is not None:
                rt.draw_at(float(rx), float(ry))
                self._canvas.viewport().update()
            self._canvas.refresh_npc_collision_visuals(npc)
            self._props.sync_npc_xy_widgets(eid, rx, ry)
            self._mark_canvas_edit()
            return
        if kind == "spawn":
            scw = self._spawn_scene_write_dict()
            if scw is None:
                return
            if eid == "default":
                scw["spawnPoint"] = {"x": rx, "y": ry}
            else:
                sps = scw.setdefault("spawnPoints", {})
                sps[eid] = {"x": rx, "y": ry}
            self._props.sync_spawn_xy_widgets(eid, rx, ry)
            self._mark_canvas_edit()

    def flush_to_model(self) -> None:
        """Save All / 关闭前 flush：仅在确有未应用编辑时才提交 staging。

        与 ``confirm_close`` / ``_commit_pending_scene_edits`` 一致走 ``is_pending_dirty``
        门控。此前无条件 ``_apply_props()`` 会在末尾 ``mark_dirty("scene")``，于是"打开
        编辑器啥都没改直接关闭"也被伪标脏、弹出保存提示（关窗时对所有面板逐个 flush）。"""
        if self._props.is_pending_dirty():
            self._apply_props()

    def confirm_close(self, parent: QWidget | None = None) -> bool:
        """关闭 / 切项目门控钩子（被 MainWindow._confirm_pending_editor_changes 调用）。

        把未应用的画布/面板编辑提交进模型，让随后的 is_dirty 检查能感知并弹出保存
        提示，修复"拖拽/改名后关闭或切项目静默丢弃"（HIGH-11/12）。本身不弹窗、
        始终返回 True 不阻塞——保存与否由主窗口统一的 Unsaved Changes 提示决定；
        若用户选择放弃，内存模型随之丢弃，本次提交不会落盘。
        """
        if self._props.is_pending_dirty():
            self._apply_props()
        return True

    def _mark_canvas_edit(self) -> None:
        """任何画布编辑（拖实体/出生点/多边形顶点）统一入口：

        立即把模型标脏并点亮"未应用"提示。这保证：
        - 关闭程序 / 切项目的门控读 model.is_dirty 时能感知，弹出保存提示，
          不再静默丢弃（修复 HIGH-3/4/11/12/13/15）；
        - 红色未应用指示与切换时的 commit-on-leave 一致触发。
        """
        sid = self._current_scene_id or ""
        if sid:
            self._model.mark_dirty("scene", sid)
        self._props._set_pending_dirty(True)

    def _commit_pending_scene_edits(self) -> None:
        """commit-on-leave：离开当前实体/场景前，把未应用的 staging 编辑提交回模型。

        消除"切实体/切场景静默丢弃拖拽"的丢数据簇（HIGH-5/7/14）。只在确有未应用
        编辑时执行（is_pending_dirty 门控，避免无谓 flush 与日志噪声），且不触碰画布
        （即将离开当前视图，重绘交由目标视图加载）。
        """
        props = self._props
        if not props.is_pending_dirty():
            return
        sc_id = self._current_scene_id or ""
        if not sc_id or self._model.scenes.get(sc_id) is None or props._source_scene is None:
            props._set_pending_dirty(False)
            return
        props.flush_pending_to_model()          # 可见面板 widgets -> staging
        props.commit_scene_staging_to_source()  # 场景级非列表字段（含 spawnPoint/spawnPoints）
        self._commit_staging_dict_into(props._source_hotspot, props._staging_hotspot)
        self._commit_staging_dict_into(props._source_npc, props._staging_npc)
        self._commit_staging_dict_into(props._source_zone, props._staging_zone)
        self._model.mark_dirty("scene", sc_id)
        props._set_pending_dirty(False)

    def _spawn_scene_write_dict(self) -> dict | None:
        props = self._props
        st = props._staging_scene
        sid = str(self._current_scene_id or "")
        if st is not None and str(st.get("id", "")) == sid:
            return st
        return self._model.scenes.get(sid)

    def _staging_hotspot_for_canvas_drag(self, eid: str) -> dict | None:
        hs = self._props._staging_hotspot
        if hs is not None and str(hs.get("id", "")) == str(eid):
            return hs
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return None
        for h in sc.get("hotspots", []):
            if isinstance(h, dict) and str(h.get("id", "")) == str(eid):
                return h
        return None

    def _staging_npc_for_canvas_drag(self, eid: str) -> dict | None:
        npc = self._props._staging_npc
        if npc is not None and str(npc.get("id", "")) == str(eid):
            return npc
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return None
        for n in sc.get("npcs", []):
            if isinstance(n, dict) and str(n.get("id", "")) == str(eid):
                return n
        return None

    def _on_scene_background_changed(self) -> None:
        """面板导入/更换背景图后（已落盘 + 写入 source）重载画布背景与世界尺寸。"""
        sid = self._current_scene_id or ""
        sc = self._model.scenes.get(sid)
        if sc is None:
            return
        self._refresh_scene_canvas_viewport_after_commit(sc, sid)

    def _refresh_scene_canvas_viewport_after_commit(self, sc: dict, scene_id: str) -> None:
        img_path = _scene_background_disk_path(self._model, scene_id, sc)
        world_w, world_h = resolve_world_size_for_scene_json(sc, img_path)
        self._canvas.setup_world(world_w, world_h)
        old_bg = getattr(self._canvas, "_bg_item", None)
        scene_gfx = self._canvas.graphics_scene()
        if old_bg is not None and old_bg.scene() is scene_gfx:
            scene_gfx.removeItem(old_bg)
            self._canvas._bg_item = None
        if img_path:
            self._canvas.load_background(img_path, world_w, world_h)
        self._last_canvas_world = (world_w, world_h)
        rw, rh = _npc_reference_world_size(self._model)
        self._canvas.rebuild_npc_reference(world_w, world_h, rw, rh)

    def _commit_staging_dict_into(self, source: dict | None, staging: dict | None) -> None:
        if source is None or staging is None:
            return
        source.clear()
        source.update(copy.deepcopy(staging))

    def _sync_hotspot_canvas_after_commit(self, old_id: str, hs: dict) -> None:
        new_id = str(hs.get("id", "") or "").strip()
        if not new_id:
            return
        vis = self._entity_visible_for_cutscene_edit(hs)
        if old_id and old_id != new_id:
            self._canvas.remove_hotspot_graphics(old_id)
        if not vis:
            self._canvas.remove_hotspot_graphics(new_id)
            return
        key = f"hotspot:{new_id}"
        item = self._canvas._entity_items.get(key)
        if item is None:
            self._canvas.add_hotspot(hs)
        elif isinstance(item, _DraggableCircle):
            item.setPos(float(hs.get("x", 0)), float(hs.get("y", 0)))
            item.set_interaction_range(float(hs.get("interactionRange", 50)))
        typ = str(hs.get("type", "inspect") or "inspect")
        self._canvas.update_hotspot_type_color(new_id, typ)
        lbl = str(hs.get("id", "") or "").strip() or new_id
        self._canvas.update_entity_circle_label("hotspot", new_id, lbl)
        self._canvas.refresh_hotspot_visuals(hs)
        # planes 归属可能被本次 Apply 改动：更新登记并全量重贴位面过滤（含由隐转显）。
        self._canvas._record_entity_planes(key, hs.get("planes"))
        self._canvas._apply_plane_filter()

    def _sync_npc_canvas_after_commit(self, old_id: str, npc: dict) -> None:
        new_id = str(npc.get("id", "") or "").strip()
        if not new_id:
            return
        vis = self._entity_visible_for_cutscene_edit(npc)
        if old_id and old_id != new_id:
            self._canvas.remove_npc_graphics(old_id)
            rt = self._scene_npc_runtimes.pop(old_id, None)
            if rt is not None and rt.item.scene() is not None:
                rt.item.scene().removeItem(rt.item)
        if not vis:
            self._canvas.remove_npc_graphics(new_id)
            rt2 = self._scene_npc_runtimes.pop(new_id, None)
            if rt2 is not None and rt2.item.scene() is not None:
                rt2.item.scene().removeItem(rt2.item)
            return
        key = f"npc:{new_id}"
        item = self._canvas._entity_items.get(key)
        if item is None:
            self._canvas.add_npc(npc)
        elif isinstance(item, _DraggableCircle):
            item.setPos(float(npc.get("x", 0)), float(npc.get("y", 0)))
            item.set_interaction_range(float(npc.get("interactionRange", 50)))
        disp = str(npc.get("name", "") or "").strip() or new_id
        self._canvas.update_entity_circle_label("npc", new_id, disp)
        self._canvas.refresh_npc_collision_visuals(npc)
        self._refresh_one_scene_npc_anim(new_id)
        # planes 归属可能被本次 Apply 改动：更新登记并全量重贴位面过滤（含由隐转显）。
        self._canvas._record_entity_planes(key, npc.get("planes"))
        self._canvas._apply_plane_filter()

    def _sync_zone_canvas_after_commit(self, old_id: str, zone: dict) -> None:
        new_id = str(zone.get("id", "") or "").strip()
        if not new_id:
            return
        if old_id and old_id != new_id:
            self._canvas.remove_zone_graphics(old_id)
        key = f"zone:{new_id}"
        item = self._canvas._entity_items.get(key)
        if item is None:
            self._canvas.add_zone(zone)
            if self._chk_block_zone_pick.isChecked():
                zit = self._canvas._entity_items.get(key)
                if isinstance(zit, _EditableZonePolygon):
                    zit.set_zone_pick_frozen(True)
        else:
            self._canvas.update_zone_canvas_color(new_id, zone)
            poly = zone.get("polygon")
            if isinstance(poly, list) and len(poly) >= 3:
                self._canvas.update_zone_polygon(new_id, poly)
            else:
                pts = _zone_polygon_points_for_editor(zone)
                self._canvas.update_zone_polygon(
                    new_id, [{"x": x, "y": y} for x, y in pts],
                )
        # planes 归属可能被本次 Apply 改动：更新登记并全量重贴位面过滤（含由隐转显）。
        self._canvas._record_entity_planes(key, zone.get("planes"))
        self._canvas._apply_plane_filter()

    def _capture_canvas_primary_selection(self) -> tuple[str, str] | None:
        """返回画布当前选中图元的 (entity_kind, entity_id)；无选中则 None。"""
        for it in self._canvas._gfx.selectedItems():
            if hasattr(it, "entity_kind") and hasattr(it, "entity_id"):
                ei = getattr(it, "entity_id", None)
                if ei is not None and str(ei).strip() != "":
                    return (str(getattr(it, "entity_kind", "")), str(ei))
        return None

    def _restore_target_after_apply(
        self, pre_sel: tuple[str, str] | None,
    ) -> tuple[str, str] | None:
        """Apply 后还原选中：flush 后 staging/_pending_* 已与控件对齐；pre_sel 来自 Apply 前画布选中。"""
        props = self._props

        def _hs(kind0: str) -> tuple[str, str] | None:
            hs = props._pending_hotspot
            if not hs:
                return None
            nid = str(hs.get("id", "") or "").strip()
            if not nid:
                return None
            return (kind0, nid)

        def _npc(kind0: str) -> tuple[str, str] | None:
            npc = props._pending_npc
            if not npc:
                return None
            nid = str(npc.get("id", "") or "").strip()
            if not nid:
                return None
            return (kind0, nid)

        def _zone_t() -> tuple[str, str] | None:
            z = props._pending_zone
            if not z:
                return None
            zid = str(z.get("id", "") or "").strip()
            if not zid:
                return None
            return ("zone", zid)

        def _spawn_t() -> tuple[str, str] | None:
            key = str(props._spawn_name_original or "").strip()
            if not key:
                return None
            return ("spawn", key)

        if pre_sel:
            k0, _ = pre_sel
            if k0 in ("hotspot", "hotspot_collision"):
                r = _hs(k0)
                if r:
                    return r
            elif k0 in ("npc", "npc_collision"):
                r = _npc(k0)
                if r:
                    return r
            elif k0 == "zone":
                r = _zone_t()
                if r:
                    return r
            elif k0 == "spawn":
                r = _spawn_t()
                if r:
                    return r

        w = props._stack.currentWidget()
        if w == props._hotspot_panel:
            return _hs("hotspot")
        if w == props._npc_panel:
            return _npc("npc")
        if w == props._zone_panel:
            return _zone_t()
        if w == props._spawn_panel:
            return _spawn_t()
        return None

    def _restore_canvas_selection(self, kind: str, eid: str) -> None:
        """reload 场景后选中图元并刷新右侧属性（与鼠标选中语义一致）。"""
        key = f"{kind}:{eid}"
        it = self._canvas._entity_items.get(key)
        ek = kind
        if it is None:
            if kind == "hotspot_collision":
                it = self._canvas._entity_items.get(f"hotspot:{eid}")
                ek = "hotspot"
            elif kind == "npc_collision":
                it = self._canvas._entity_items.get(f"npc:{eid}")
                ek = "npc"
        if it is None:
            return
        self._canvas._gfx.clearSelection()
        it.setSelected(True)
        self._on_item_selected(ek, eid)

    def _try_select_canvas_item(self, kind: str, eid: str) -> None:
        key = f"{kind}:{eid}"
        it = self._canvas._entity_items.get(key)
        if it is None:
            return
        try:
            self._canvas._gfx.clearSelection()
        except (AttributeError, RuntimeError):
            pass
        it.setSelected(True)

    def _apply_props(self) -> None:
        props = self._props

        active_panel = props._stack.currentWidget()
        props.flush_pending_to_model()

        sc_id = self._current_scene_id or ""
        sc_model = self._model.scenes.get(sc_id)
        if sc_model is None:
            return

        old_hs_id = (
            str(props._source_hotspot.get("id", "") or "").strip()
            if props._source_hotspot
            else ""
        )
        old_npc_id = (
            str(props._source_npc.get("id", "") or "").strip()
            if props._source_npc
            else ""
        )
        old_zone_id = (
            str(props._source_zone.get("id", "") or "").strip()
            if props._source_zone
            else ""
        )

        props.commit_scene_staging_to_source()

        self._commit_staging_dict_into(props._source_hotspot, props._staging_hotspot)
        self._commit_staging_dict_into(props._source_npc, props._staging_npc)
        self._commit_staging_dict_into(props._source_zone, props._staging_zone)

        self._refresh_scene_canvas_viewport_after_commit(sc_model, sc_id)
        self._canvas.reload_spawn_items_from_scene(sc_model)

        if props._source_hotspot is not None:
            self._sync_hotspot_canvas_after_commit(old_hs_id, props._source_hotspot)
        if props._source_npc is not None:
            self._sync_npc_canvas_after_commit(old_npc_id, props._source_npc)
        if props._source_zone is not None:
            self._sync_zone_canvas_after_commit(old_zone_id, props._source_zone)

        self._model.mark_dirty("scene", sc_id)

        # 轻量 rebind 替代 load_*_props 整页重装：staging 仅 deepcopy(source)，
        # 不重置 widgets（widgets 已与 source 一致）。同时复位红色"未应用"提示。
        props.rebind_scene_after_commit(sc_model)
        if active_panel == props._hotspot_panel and props._source_hotspot is not None:
            eid = str(props._source_hotspot.get("id", "") or "").strip()
            props.rebind_hotspot_after_commit()
            if eid:
                self._try_select_canvas_item("hotspot", eid)
        elif active_panel == props._npc_panel and props._source_npc is not None:
            eid = str(props._source_npc.get("id", "") or "").strip()
            props.rebind_npc_after_commit()
            if eid:
                self._try_select_canvas_item("npc", eid)
        elif active_panel == props._zone_panel and props._source_zone is not None:
            eid = str(props._source_zone.get("id", "") or "").strip()
            props.rebind_zone_after_commit()
            if eid:
                self._try_select_canvas_item("zone", eid)
        elif active_panel == props._spawn_panel:
            sk = str(props._spawn_name_original or "").strip() or "default"
            self._try_select_canvas_item("spawn", sk)
        # else 分支（其它面板）：scene rebind 已经清零 dirty，无需再做。

        # transient success feedback (UI only; never affects data)
        try:
            self.window().statusBar().showMessage("已应用到内存（尚未 Save All）", 3000)
        except (AttributeError, RuntimeError):
            pass

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

    @staticmethod
    def _unique_entity_id(prefix: str, existing_ids) -> str:
        """new_xxx_N 探测式取号：len() 命名在删过中间项后会撞既存 id（审查 P1-26），
        撞车会让画布图元键覆盖、属性/删除按 id 首匹配串台。"""
        taken = {str(i) for i in existing_ids}
        n = 0
        while f"{prefix}_{n}" in taken:
            n += 1
        return f"{prefix}_{n}"

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
        new_id = self._unique_entity_id(
            "new_hotspot", (h.get("id", "") for h in hs_list if isinstance(h, dict)))
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
        new_id = self._unique_entity_id(
            "new_npc", (n.get("id", "") for n in npc_list if isinstance(n, dict)))
        npc_list.append({
            "id": new_id, "name": "New NPC", "x": wx, "y": wy,
            "interactionRange": 50,
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
        new_id = self._unique_entity_id(
            "new_zone", (z.get("id", "") for z in z_list if isinstance(z, dict)))
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

    def _selected_entity_ref(self) -> tuple[str, str] | None:
        """当前选中实体的 (kind, id)：画布选中优先，退回右侧属性面板正在编辑的实体。"""
        for it in self._canvas._gfx.selectedItems():
            if hasattr(it, "entity_kind") and hasattr(it, "entity_id"):
                ek = str(getattr(it, "entity_kind", "") or "")
                ei = getattr(it, "entity_id", None)
                if ek and ei is not None and str(ei) != "":
                    return ek, str(ei)
        w = self._props._stack.currentWidget()
        if w == self._props._npc_panel and self._props._pending_npc:
            return "npc", str(self._props._pending_npc.get("id", "") or "")
        if w == self._props._hotspot_panel and self._props._pending_hotspot:
            return "hotspot", str(self._props._pending_hotspot.get("id", "") or "")
        if w == self._props._zone_panel and self._props._pending_zone:
            return "zone", str(self._props._pending_zone.get("id", "") or "")
        if w == self._props._spawn_panel and self._props._spawn_scene is not None:
            return "spawn", str(self._props._spawn_name_original or "")
        return None

    def _refactor_selected(self, op: str) -> None:
        """实体重构入口（迁移/改名/安全删除）：先提交 staging，再开预览确认对话框。"""
        sc = self._require_scene()
        if sc is None:
            return
        ref = self._selected_entity_ref()
        kind = ""
        if ref is not None:
            kind = {"npc_collision": "npc", "hotspot_collision": "hotspot"}.get(ref[0], ref[0])
        if ref is None or kind not in ("npc", "hotspot", "zone", "spawn"):
            QMessageBox.information(
                self, "实体重构", "请先选中一个 NPC / 热区 / Zone / 出生点。")
            return
        eid = ref[1]
        if kind == "spawn" and eid == "default":
            QMessageBox.information(self, "实体重构", "默认出生点不参与重构。")
            return
        # commit-on-leave：把属性面板/画布 staging 先落进模型，重构基于已提交数据
        self._commit_pending_scene_edits()
        from ..shared.entity_refactor_dialog import (
            MoveEntityDialog,
            RenameEntityDialog,
            SafeDeleteEntityDialog,
        )
        dialog_cls = {
            "move": MoveEntityDialog,
            "rename": RenameEntityDialog,
            "delete": SafeDeleteEntityDialog,
        }[op]
        try:
            dlg = dialog_cls(self._model, self._current_scene_id or "", kind, eid, self)
        except Exception as exc:  # noqa: BLE001 - 扫描期异常给提示,不崩编辑器
            QMessageBox.warning(self, "实体重构", f"引用扫描失败：{exc}")
            return
        if not dlg.exec() or dlg.result_summary is None:
            return
        summary = dlg.result_summary
        self._load_scene(self._current_scene_id, reset_view=False)
        if summary.get("op") == "moveEntity":
            dst = summary["dstScene"]
            self._select_scene_entity_by_kind(kind, eid, dst)
            dangling = len(summary.get("danglingSceneLocal") or [])
            msg = (f"已迁移到「{dst}」；坐标保留原值，请在目标场景重新摆位。"
                   + (f"\n源场景仍有 {dangling} 处裸引用悬垂（见 Validate Data）。" if dangling else ""))
        elif summary.get("op") == "renameEntity":
            skipped = summary.get("scope", {}).get("skippedDialogues") or []
            msg = (f"已改名为「{summary['newId']}」。"
                   + (f"\n未自动改写（指向歧义）的对话图：{'、'.join(skipped)}" if skipped else ""))
        else:
            msg = (f"已删除「{eid}」；"
                   f"{summary.get('danglingRefs', 0)} 处引用悬垂（跑 Validate Data 查看）。")
        QMessageBox.information(self, "实体重构", msg)

    def _undo_entity_refactor(self) -> None:
        from ..shared import entity_refactor as er
        result = er.undo_last(self._model)
        if result.get("ok"):
            self._load_scene(self._current_scene_id, reset_view=False)
        QMessageBox.information(
            self, "实体重构", str(result.get("description") or result.get("reason") or ""))

    def _delete_selected(self) -> None:
        sc = self._require_scene()
        if sc is None:
            return
        ref = self._selected_entity_ref()
        kind: str | None = ref[0] if ref else None
        eid: str | None = ref[1] if ref else None
        if not kind or not eid:
            return
        if kind == "spawn" and eid == "default":
            QMessageBox.information(
                self, "场景编辑器", "默认出生点不可删除。")
            return
        _label = {
            "npc": "NPC", "npc_collision": "NPC",
            "hotspot": "热区", "hotspot_collision": "热区",
            "zone": "Zone", "spawn": "出生点",
        }.get(kind, "实体")
        if not confirm.confirm_delete(self, f"{_label}「{eid}」及其全部配置"):
            return
        if kind == "hotspot":
            sc["hotspots"] = [h for h in sc.get("hotspots", []) if h.get("id") != eid]
        elif kind == "hotspot_collision":
            sc["hotspots"] = [h for h in sc.get("hotspots", []) if h.get("id") != eid]
        elif kind == "npc":
            sc["npcs"] = [n for n in sc.get("npcs", []) if n.get("id") != eid]
        elif kind == "npc_collision":
            sc["npcs"] = [n for n in sc.get("npcs", []) if n.get("id") != eid]
        elif kind == "zone":
            sc["zones"] = [z for z in sc.get("zones", []) if z.get("id") != eid]
        elif kind == "spawn":
            sc.get("spawnPoints", {}).pop(eid, None)
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id, reset_view=False)

    def _scene_id_for_entity(self, kind: str, item_id: str) -> str:
        item_id = (item_id or "").strip()
        if not item_id:
            return ""
        collection = {"npc": "npcs", "hotspot": "hotspots", "zone": "zones"}.get(kind)
        if not collection:
            return ""
        for sid, scene in self._model.scenes.items():
            if not isinstance(scene, dict):
                continue
            if any(isinstance(e, dict) and str(e.get("id", "")).strip() == item_id for e in scene.get(collection, []) or []):
                return str(sid)
        return ""

    def _select_scene_entity_by_kind(self, kind: str, item_id: str, scene_id: str = "") -> bool:
        item_id = (item_id or "").strip()
        scene_id = (scene_id or "").strip() or self._scene_id_for_entity(kind, item_id)
        if scene_id:
            for i in range(self._scene_list.count()):
                it = self._scene_list.item(i)
                if it and it.data(Qt.ItemDataRole.UserRole) == scene_id:
                    self._scene_list.setCurrentItem(it)
                    break
        if not item_id:
            return False
        sc = self._model.scenes.get(self._current_scene_id or "")
        if not sc:
            return False
        collection = {"npc": "npcs", "hotspot": "hotspots", "zone": "zones"}.get(kind)
        if not collection:
            return False
        for entity in sc.get(collection, []):
            if isinstance(entity, dict) and str(entity.get("id", "")).strip() == item_id:
                self._restore_canvas_selection(kind, item_id)
                return True
        return False

    def select_npc_by_id(self, item_id: str, scene_id: str = "") -> None:
        self._select_scene_entity_by_kind("npc", item_id, scene_id)

    def select_hotspot_by_id(self, item_id: str, scene_id: str = "") -> None:
        self._select_scene_entity_by_kind("hotspot", item_id, scene_id)

    def select_zone_by_id(self, item_id: str, scene_id: str = "") -> None:
        self._select_scene_entity_by_kind("zone", item_id, scene_id)

    def select_scene_by_id(self, scene_id: str, _scene_id: str = "") -> None:
        """Select a whole scene by id (used by narrative scene-wrapper navigation)."""
        scene_id = (scene_id or "").strip()
        if not scene_id:
            return
        for i in range(self._scene_list.count()):
            it = self._scene_list.item(i)
            if it is not None and it.data(Qt.ItemDataRole.UserRole) == scene_id:
                self._scene_list.setCurrentItem(it)
                return

    def select_by_id(self, item_id: str, scene_id: str = "") -> None:
        for kind in ("npc", "hotspot", "zone"):
            if self._select_scene_entity_by_kind(kind, item_id, scene_id):
                return
