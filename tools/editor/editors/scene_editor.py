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
from collections.abc import Callable, Iterator
from datetime import datetime
from pathlib import Path, PurePosixPath

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget, QListWidgetItem,
    QGraphicsView, QGraphicsScene, QGraphicsEllipseItem, QGraphicsRectItem,
    QGraphicsItem, QGraphicsObject, QGraphicsPolygonItem,
    QGraphicsPixmapItem, QGroupBox, QFormLayout, QLineEdit, QDoubleSpinBox,
    QSpinBox, QComboBox, QCheckBox, QLabel, QPushButton, QScrollArea,
    QStackedWidget, QToolBar, QMenu, QGraphicsTextItem,
    QToolButton, QMessageBox, QInputDialog, QFileDialog, QDialog, QDialogButtonBox, QAbstractItemView,
    QApplication,
    QTreeWidget, QTreeWidgetItem,
    QSizePolicy, QGraphicsSceneMouseEvent, QGraphicsSceneHoverEvent,
    QGraphicsSceneContextMenuEvent,     QTableWidget, QTableWidgetItem, QHeaderView, QSlider,
    QRadioButton, QButtonGroup, QCompleter, QTabWidget,
)
from PySide6.QtGui import (
    QPixmap, QImage, QPen, QBrush, QColor, QFont, QFontMetricsF, QPainter, QWheelEvent,
    QImageReader,
    QMouseEvent, QContextMenuEvent, QAction, QTransform, QPolygonF,
    QShortcut, QKeySequence, QPainterPath, QPainterPathStroker,
)
from PySide6.QtCore import (
    Qt,
    QEvent,
    QRect,
    QRectF,
    QPoint,
    QPointF,
    Signal,
    Slot,
    QTimer,
    QElapsedTimer,
)

from .scene_canvas_model import iter_part_keys, part_key
from ..shared.entity_sort_math import (
    entity_sort_z,
    hotspot_sort_band_of,
    npc_sort_band_of,
    sort_foot_y_of,
)
from .scene_undo import SceneUndoController
from ..shared.entity_transform_math import (
    entity_perspective_factor,
    entity_rotation_deg_of,
    entity_scale_of,
    inverse_transform_world_vec,
    perspective_axis_data,
    perspective_scale_at,
    transform_local_vec,
)

from ..project_model import ProjectModel
from .. import theme
from ..shared import confirm
from ..shared.list_affordances import make_list_search_box
from ..shared.rich_text_field import RichTextLineEdit
from ..shared.condition_editor import ConditionEditor
from ..shared.action_editor import ActionEditor, FilterableTypeCombo
from ..shared.audio_library import (
    AudioMetaCache,
    audio_config_file_for_id,
    format_duration,
)
from ..shared.audio_preview_selector import AudioIdPreviewSelector, AudioPreviewControls
from ..shared.id_ref_selector import IdRefSelector
from ..shared.reference_picker import ReferencePickerDialog, ReferencePickerField
from ..shared.dialogue_graph_refs import (
    DIALOGUE_GRAPH_OPEN_TOOLTIP,
    dialogue_graph_node_ids,
    dialogue_graph_reference_rows,
    open_dialogue_graph_from_widget,
)
from ..shared.image_path_picker import CutsceneImagePathRow, disk_path_for_runtime_url
from ..shared.move_entity_map_picker import (
    MoveEntityToMapPickerDialog,
    WorldPointPickView,
    resolve_world_size_for_scene_json,
)
from ..shared.player_acts_editor import ZoneActsEditor
from ..shared.collapsible_section import CollapsibleSection
from ..shared.form_layout import compact_form
from ..shared.hex_color_pick_row import HexColorPickRow
from ..shared.portrait_catalog import load_portrait_sets
from ..shared.project_paths import ProjectPaths
from ..shared.fonts import MONO_FONT_FAMILY
from . import scene_lights
from .shadow_bindings_ui import ShadowBindingsEditor

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
    "act_spot": QColor(190, 120, 255, 160),
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
# 叠放实体循环点选「同一落点」的视口像素容差（见 SceneCanvas.mousePressEvent）
_PICK_CYCLE_PX_TOL = 4

# 深度遮挡半透明混合系数的场景默认（与运行时 SceneDepthSystem._occlusionBlendFactor 对齐）。
# 实体缺省不写 occlusionBlendFactor 键 → 运行时用此默认；仅「自定义」勾选才落显式值。
_OCCLUSION_BLEND_DEFAULT = 0.28

# 「进对话时改不改朝向」的四档（运行时权威：src/data/types.ts 的 DialogueFacing）。
# **缺省两边不同**：NPC 是 player（历来就转向玩家）、热点是 keep（历来就不转身）——
# 各自维持改造前的行为，缺省档一律不写键，旧数据字节不动。
_DIALOGUE_FACING_VALUES = ("keep", "left", "right", "player")
_DIALOGUE_FACING_LABELS = {
    "keep": "不改动朝向",
    "left": "朝向左边",
    "right": "朝向右边",
    "player": "朝向角色",
}
_DIALOGUE_FACING_TIP = (
    "进入这段对话的一瞬间，这个实体要不要转身：\n"
    "  不改动 = 保持原朝向（背对着剁馅的屠户、跪着的孝子、只画了一面的烤入人物用这档）\n"
    "  朝左/朝右 = 固定转向一侧（不管玩家绕到哪边）\n"
    "  朝向角色 = 转过来面对玩家\n"
    "对话结束会恢复成进对话前的朝向。热点还需要配了「显示图」才有可镜像的东西。"
)


def _make_dialogue_facing_combo(default_value: str) -> QComboBox:
    """四档对话朝向下拉；`default_value` 那档标注「（默认）」并排在首位。"""
    cb = QComboBox()
    order = [default_value] + [v for v in _DIALOGUE_FACING_VALUES if v != default_value]
    for v in order:
        suffix = "（默认）" if v == default_value else ""
        cb.addItem(f"{_DIALOGUE_FACING_LABELS[v]}{suffix}", v)
    cb.setToolTip(_DIALOGUE_FACING_TIP)
    return cb


def _load_dialogue_facing_combo(cb: QComboBox, data: dict, default_value: str) -> None:
    """按实体数据设当前档；未知/缺省值一律落到 default_value（不静默改数据）。"""
    cur = str(data.get("dialogueFacing", "") or "").strip().lower()
    if cur not in _DIALOGUE_FACING_VALUES:
        cur = default_value
    cb.blockSignals(True)
    try:
        idx = cb.findData(cur)
        cb.setCurrentIndex(idx if idx >= 0 else 0)
    finally:
        cb.blockSignals(False)


def _write_dialogue_facing_combo(cb: QComboBox, data: dict, default_value: str) -> None:
    """缺省档不写键（保住哈希基线与字节级往返），其余写显式值。"""
    v = str(cb.currentData() or default_value)
    if v != default_value and v in _DIALOGUE_FACING_VALUES:
        data["dialogueFacing"] = v
    else:
        data.pop("dialogueFacing", None)


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
    """画布世界点 → authored 局部点：先去锚点平移，再按实例 transform 反变换
    （与运行时 anchorCollisionPolygonToWorld 的求值时正变换互逆——变换态下拖顶点
    写回的仍是干净的未变换局部坐标）。"""
    x0 = float(hs.get("x", 0))
    y0 = float(hs.get("y", 0))
    s = entity_scale_of(hs)
    rot = entity_rotation_deg_of(hs)
    out: list[dict[str, float]] = []
    for p in world_poly:
        if isinstance(p, dict):
            lx, ly = inverse_transform_world_vec(
                float(p.get("x", 0)) - x0, float(p.get("y", 0)) - y0, s, rot)
            out.append({"x": round(lx, 1), "y": round(ly, 1)})
    return out

def _hotspot_collision_local_to_world(hs: dict, local_poly: list) -> list[dict[str, float]]:
    """authored 局部点 → 画布世界点：实例 transform 正变换后加锚点（与运行时同口径）。"""
    x0 = float(hs.get("x", 0))
    y0 = float(hs.get("y", 0))
    s = entity_scale_of(hs)
    rot = entity_rotation_deg_of(hs)
    out: list[dict[str, float]] = []
    for p in local_poly:
        if isinstance(p, dict):
            wx, wy = transform_local_vec(float(p.get("x", 0)), float(p.get("y", 0)), s, rot)
            out.append({"x": round(wx + x0, 1), "y": round(wy + y0, 1)})
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

# ---------------------------------------------------------------------------
# 画布 z 分层
#
# 分成**内容**与**装饰品**两段，因为它们该由完全不同的规则决定次序：
#
# - **内容** = 运行时画面上真实存在的东西（热点展示图、NPC 动画精灵）。它们的前后
#   关系必须与运行时一致，否则画布就在骗人 —— 运行时按「三档 × 档内脚底 y」实时排
#   （`src/rendering/entitySortRule.ts`），编辑器经 `_resort_canvas_content_z`
#   用同一条规则的 Python 镜像派名次。此前这两层是写死的 -10 / -4，于是
#   **画布上 NPC 永远被热点贴图压住**，与游戏里谁前谁后毫无关系。
# - **装饰品** = 只存在于编辑器的东西（把手、碰撞面、辅助线、gizmo、组框、标尺）。
#   它们本来就该恒在内容之上/之下，不参与内容排序。
#
# 装饰品整体搬到 20 万以上、标尺搬到 -20 万，**相对次序一字未改**（原值在各行注释里），
# 于是点选/拖动/gizmo 行为零回归；中间空出的 [-100000, 100000] 全留给内容。
# 平局也照抄：独立 Zone 与各类把手原本都是默认 0，现在同为 `_Z_DECOR_ENTITY`。
# ---------------------------------------------------------------------------
_Z_BACKGROUND = -1_000_000.0        # 原 -100
_Z_BG_PLACEHOLDER = -999_999.0      # 原 -90
_NPC_REF_Z = -200_000.0             # 原 -20（标尺恒在内容之下，别挡住精灵）
_Z_CONTENT_LO = -100_000.0          # 内容区间下界（按名次 +1 递增）
_Z_CONTENT_STEP = 1.0
_Z_CONTENT_HI = 100_000.0           # 内容区间上界（实体数远低于 20 万格）
_Z_DECOR_COLLISION = 300_000.0      # 原 -2：碰撞多边形 + 透视幽灵
_Z_DECOR_ENTITY = 400_000.0         # 原 0（默认）：独立 Zone 与 hotspot/npc/spawn 把手
_PATROL_LINE_COLOR = QColor(0, 200, 220, 220)
_PATROL_OVERLAY_Z = 500_000.0       # 原 2.0
_LIGHTCURVE_LINE_COLOR = QColor(255, 196, 64, 230)  # 暖金,区别于巡逻的青色
_LIGHTCURVE_OVERLAY_Z = 500_100.0   # 原 2.5
_Z_DECOR_GROUP_BOX = 600_000.0      # 原 6_000（细分公式保留，见 sync_group_boxes）
_Z_DECOR_PERSP_AXIS = 800_000.0     # 原 8_000
_Z_DECOR_GIZMO = 900_000.0          # 原 9_000
_Z_PICK_RAISED = 1_000_000.0        # 原 z_top+1：叠放循环点选的临时抬升

# 图集寻址/切分/世界尺寸推导已抽到 shared/anim_atlas_preview.py（气泡锚控件与本画布共用，
# 两份实现会各自漂移）。此处保留私有别名，call site 不变。
from ..shared.anim_atlas_preview import (          # noqa: E402
    anim_bundle_key_from_manifest_url as _anim_bundle_key_from_manifest_url,
    crop_atlas_cell as _crop_atlas_cell,
    resolved_anim_world_pair as _resolved_anim_world_pair,
    spritesheet_public_path as _spritesheet_public_path,
    reference_world_size as _npc_reference_world_size,
)

def _npc_initial_playback_tuple(npc: dict) -> tuple[float, bool, int | None, int | None]:
    """从 npc dict 解析 initialAnimPlayback → (speed, reverse, holdFrame, startFrame)。
    与运行时 Npc.sanitizeInitialAnimPlayback 同口径：speed>0、hold/start≥0，负值/非法=未设。"""
    raw = npc.get("initialAnimPlayback")
    d = raw if isinstance(raw, dict) else {}
    try:
        spd = float(d.get("speed", 1.0))
    except (TypeError, ValueError):
        spd = 1.0
    if not (spd > 0):
        spd = 1.0

    def _nn(v: object) -> int | None:
        try:
            iv = int(float(v))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return None
        return iv if iv >= 0 else None

    return spd, d.get("reverse") is True, _nn(d.get("holdFrame")), _nn(d.get("startFrame"))

class _SceneNpcAnimRuntime:
    """场景画布上单个 NPC 的循环动画（与脚底锚点、世界尺寸一致）。"""

    __slots__ = (
        "npc_id", "item", "atlas", "cols", "rows",
        "cell_w", "cell_h", "atlas_frames",
        "world_w", "world_h", "frames", "frame_idx", "_accum",
        "frame_rate", "loop",
        "facing_x", "_prev_x", "_prev_y", "_have_prev",
        "inst_scale", "inst_rot_deg", "persp",
        "speed_mult", "reverse", "hold_frame", "start_frame",
        "ref_speed", "visible",
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
        ref_speed: float | None = None,
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
        # 实例 transform（quad 级真变换预览；与运行时 container 级施加同口径）
        self.inst_scale = 1.0
        self.inst_rot_deg = 0.0
        # 场景透视缩放系数（近大远小预览；随位置每拍拉取，与运行时 sprite 级施加同口径）
        self.persp = 1.0
        # 初始播放参数（initialAnimPlayback 预览；与 tick 循环的位置/transform 同为每拍拉取）
        self.speed_mult = 1.0
        self.reverse = False
        self.hold_frame: int | None = None
        self.start_frame: int | None = None
        # 本 runtime 所播状态的步速匹配基准（anim.json state.referenceSpeed；巡逻预览步速缩放用）
        self.ref_speed = float(ref_speed) if ref_speed and ref_speed > 0 else None
        # 视图过滤闸门（位面/时段/过场）。**必须是 runtime 的状态，不能只 setVisible(item)**：
        # draw_at 每 8ms 被动画定时器调一次，从前它最后一行是无条件 `item.show()`，
        # 于是"把精灵藏起来"这件事最多活 8 毫秒——外面怎么改都像没生效。
        self.visible = True

    def set_instance_transform(self, scale: float, rot_deg: float) -> None:
        self.inst_scale = float(scale) if scale and scale > 0 else 1.0
        self.inst_rot_deg = float(rot_deg) if rot_deg else 0.0

    def set_playback(
        self, speed: float, reverse: bool,
        hold: int | None, start: int | None,
    ) -> None:
        """每拍拉取式套用初始播放参数。speed/reverse 是连续量直接覆盖；hold/start/reverse
        的**变化边沿**才拨动游标（与运行时起播语义一致：hold 定格 > start 起播帧 >
        反向末帧/正向 0），否则每拍重置游标动画就永远停在起点了。"""
        self.speed_mult = float(speed) if speed and speed > 0 else 1.0
        n = max(1, len(self.frames))
        rev = bool(reverse)
        rev_changed = rev != self.reverse
        self.reverse = rev
        hold_changed = hold != self.hold_frame
        self.hold_frame = hold
        start_changed = start != self.start_frame
        self.start_frame = start
        if hold is not None:
            if hold_changed:
                self.frame_idx = int(hold) % n
                self._accum = 0.0
            return
        if hold_changed or start_changed or rev_changed:
            if start is not None:
                self.frame_idx = int(start) % n
            else:
                self.frame_idx = (n - 1) if rev else 0
            self._accum = 0.0

    def tick(self, dt: float, npc_x: float, npc_y: float) -> None:
        if self.hold_frame is None:
            self._accum += dt
            step = 1.0 / max(1e-6, self.frame_rate * self.speed_mult)
            while self._accum >= step and len(self.frames) > 1:
                self._accum -= step
                self.frame_idx += -1 if self.reverse else 1
                if self.frame_idx < 0 or self.frame_idx >= len(self.frames):
                    if self.loop:
                        self.frame_idx = (len(self.frames) - 1) if self.reverse else 0
                    else:
                        self.frame_idx = 0 if self.reverse else (len(self.frames) - 1)
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
        eff = self.inst_scale * (self.persp if self.persp and self.persp > 0 else 1.0)
        sx = (self.world_w / fw) * self.facing_x * eff
        sy = (self.world_h / fh) * eff
        t = QTransform()
        t.translate(float(npc_x), float(npc_y))
        if self.inst_rot_deg:
            t.rotate(self.inst_rot_deg)
        t.scale(sx, sy)
        t.translate(-fw * 0.5, -float(fh))
        self.item.setTransform(t)
        self.item.setPos(0.0, 0.0)
        # 过闸门，不是无条件 show()：被位面/时段/过场过滤掉的 NPC，其精灵每拍都要
        # 保持隐藏。写成 show() 时"藏起来"只能活到下一拍（8ms），外面怎么改都像没生效。
        self.item.setVisible(self.visible)

    def set_visible(self, on: bool) -> None:
        """视图过滤闸门。立刻生效，且下一拍 draw_at 不会把它冲掉。"""
        self.visible = bool(on)
        self.item.setVisible(self.visible)

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
        # 把手是装饰品，恒在内容之上（原先靠默认 z=0，而内容是负值）。显式写出来，
        # 免得内容 z 改成按运行时规则实时重排后，把手被排到贴图底下点不着。
        self.setZValue(_Z_DECOR_ENTITY)
        self.entity_id = entity_id
        self.entity_kind = entity_kind
        self._scene_view = scene_view
        self._range_outline: QGraphicsEllipseItem | None = None
        self.set_interaction_range(range_radius)

        self._label = QGraphicsTextItem(self)
        self._label.setDefaultTextColor(Qt.GlobalColor.white)
        theme.set_graphics_text_font(
            self._label,
            theme.FONT_ROLE_CANVAS_SECONDARY,
            family=MONO_FONT_FAMILY,
        )
        self._label.setFlag(
            QGraphicsTextItem.GraphicsItemFlag.ItemIgnoresTransformations, True)
        self._label.setFlag(
            QGraphicsTextItem.GraphicsItemFlag.ItemIsSelectable, False)
        self._label.setPos(radius * 0.5, -radius * 0.5)
        self._label_text = entity_id
        self._apply_label_html(entity_id)
        self.setAcceptHoverEvents(True)
        self._refresh_tooltip()

    @staticmethod
    def _esc_html(s: str) -> str:
        return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

    def _apply_label_html(self, text: str) -> None:
        """给标签套半透明黑底，避免白字画在亮背景图上不可读（审查 P3）。"""
        self._label.setHtml(
            f'<span style="background-color: rgba(0,0,0,150); color: #ffffff;">'
            f'&nbsp;{self._esc_html(text)}&nbsp;</span>')

    def _refresh_tooltip(self) -> None:
        self.setToolTip(f"{self.entity_kind}: {self.entity_id}")

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
        self._label_text = str(text)
        self._apply_label_html(self._label_text)
        self._refresh_tooltip()

    def set_entity_id(self, eid: str) -> None:
        self.entity_id = str(eid)
        self._label_text = self.entity_id
        self._apply_label_html(self.entity_id)
        self._refresh_tooltip()

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

class _TransformGizmo(QGraphicsObject):
    """选中实体的实例 transform 手柄（P3）：绕脚底锚点的细环 + 两个世界尺寸手柄。

    - 圆形手柄（环上、随 rotation 转到顶部方位）：拖动=旋转（吸附 0.5°）；
    - 方形手柄（环上、rotation 方位右侧）：拖动=等比缩放（按半径比，钳 0.05–20）；
    - shape() 只含两个手柄的命中区——环体不吃鼠标，实体本体照常点选/拖动；
    - 拖动 live 阶段经 SceneCanvas.transform_gizmo_live 只做视觉/数值框同步，
      release 经 transform_gizmo_committed 一次提交（配合按下时快照 = 一条撤销命令）。
    """

    HANDLE_R = 10.0

    def __init__(self, view: "SceneCanvas"):
        super().__init__()
        self._view = view
        self.kind = ""
        self.eid = ""
        self.scale_v = 1.0
        self.rot_deg = 0.0
        self.ring_r = 60.0
        self._mode: str | None = None
        self._press_scale = 1.0
        self._press_rot = 0.0
        self._press_ang = 0.0
        self._press_len = 1.0
        self.setZValue(_Z_DECOR_GIZMO)
        self.setAcceptedMouseButtons(Qt.MouseButton.LeftButton)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, False)

    def set_target(
        self, kind: str, eid: str, ax: float, ay: float,
        scale_v: float, rot_deg: float, size_hint: float,
    ) -> None:
        self.prepareGeometryChange()
        self.kind = kind
        self.eid = eid
        self.scale_v = float(scale_v) if scale_v and scale_v > 0 else 1.0
        self.rot_deg = float(rot_deg or 0)
        self.ring_r = max(46.0, min(240.0, float(size_hint) * 0.62))
        self.setPos(float(ax), float(ay))
        self.update()

    # ---- 几何 ---------------------------------------------------------------

    def _handle_pos(self, which: str) -> QPointF:
        rad = math.radians(self.rot_deg)
        if which == "rotate":  # 环顶方位（随 rotation 转动）
            a = rad - math.pi / 2
        else:  # scale：rotation 方位右侧
            a = rad
        return QPointF(self.ring_r * math.cos(a), self.ring_r * math.sin(a))

    def boundingRect(self) -> QRectF:
        m = self.ring_r + self.HANDLE_R * 2
        return QRectF(-m, -m, m * 2, m * 2)

    def shape(self) -> QPainterPath:
        # 只有两个手柄参与命中：环体不遮挡下方实体的点选/拖动
        path = QPainterPath()
        for which in ("rotate", "scale"):
            p = self._handle_pos(which)
            path.addEllipse(p, self.HANDLE_R * 1.6, self.HANDLE_R * 1.6)
        return path

    def paint(self, painter: QPainter, _opt, _widget=None) -> None:
        ring_pen = QPen(QColor(120, 200, 255, 150), 0, Qt.PenStyle.DashLine)
        painter.setPen(ring_pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawEllipse(QPointF(0, 0), self.ring_r, self.ring_r)
        rp = self._handle_pos("rotate")
        painter.setPen(QPen(QColor(30, 90, 140, 220), 0))
        painter.setBrush(QBrush(QColor(120, 200, 255, 220)))
        painter.drawEllipse(rp, self.HANDLE_R, self.HANDLE_R)
        sp = self._handle_pos("scale")
        painter.setBrush(QBrush(QColor(255, 200, 90, 220)))
        painter.setPen(QPen(QColor(150, 100, 20, 220), 0))
        painter.drawRect(QRectF(sp.x() - self.HANDLE_R, sp.y() - self.HANDLE_R,
                                self.HANDLE_R * 2, self.HANDLE_R * 2))

    # ---- 交互 ---------------------------------------------------------------

    def mousePressEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        lp = event.pos()
        for which in ("rotate", "scale"):
            hp = self._handle_pos(which)
            dx = lp.x() - hp.x()
            dy = lp.y() - hp.y()
            if math.hypot(dx, dy) <= self.HANDLE_R * 1.8:
                self._mode = which
                self._press_scale = self.scale_v
                self._press_rot = self.rot_deg
                self._press_ang = math.degrees(math.atan2(lp.y(), lp.x()))
                self._press_len = max(1e-6, math.hypot(lp.x(), lp.y()))
                # 撤销：手势起点捕获 before 快照（与实体拖拽同一通道）
                self._view.item_drag_press.emit()
                event.accept()
                return
        event.ignore()

    def mouseMoveEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if self._mode is None:
            event.ignore()
            return
        lp = event.pos()
        if self._mode == "rotate":
            ang = math.degrees(math.atan2(lp.y(), lp.x()))
            raw = self._press_rot + (ang - self._press_ang)
            while raw > 360:
                raw -= 720
            while raw < -360:
                raw += 720
            self.rot_deg = round(raw * 2) / 2  # 吸附 0.5°
        else:
            ratio = max(1e-6, math.hypot(lp.x(), lp.y())) / self._press_len
            self.scale_v = round(
                min(20.0, max(0.05, self._press_scale * ratio)), 2)
        self.update()
        self._view.transform_gizmo_live.emit(
            self.kind, self.eid, float(self.scale_v), float(self.rot_deg))
        event.accept()

    def mouseReleaseEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if self._mode is None:
            event.ignore()
            return
        self._mode = None
        # 零变化点击（按了手柄没动）：不发提交——与实体拖拽的零位移防伪脏同门
        # （审查 P2-A）。live 已写目标 dict，编辑器侧无法事后分辨，只能在源头判。
        if self.scale_v == self._press_scale and self.rot_deg == self._press_rot:
            event.accept()
            return
        self._view.transform_gizmo_committed.emit(
            self.kind, self.eid, float(self.scale_v), float(self.rot_deg))
        event.accept()

    def gesture_active(self) -> bool:
        return self._mode is not None

    def cancel_gesture(self) -> None:
        """Esc 取消：恢复按下时的 scale/rot，经 live 信号让编辑器回滚 staging/预览。"""
        if self._mode is None:
            return
        self._mode = None
        self.scale_v = self._press_scale
        self.rot_deg = self._press_rot
        self.update()
        self._view.transform_gizmo_live.emit(
            self.kind, self.eid, float(self.scale_v), float(self.rot_deg))

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
        # 独立 Zone 原先靠默认 z=0（与把手并列，刻意压在碰撞面之上）；两类碰撞多边形
        # 由建它们的调用方随后覆写成 _Z_DECOR_COLLISION。两者都是装饰品，恒在内容之上，
        # 否则会被热点展示图整个盖住、顶点点不到（碰撞面主要靠拖顶点编辑）。
        self.setZValue(_Z_DECOR_ENTITY)
        self._base_color = QColor(color)
        self._pick_frozen = False
        self._drag_vertex: int | None = None
        self._drag_body = False
        self._last_scene: QPointF | None = None
        self._hover_vertex: int | None = None
        self.setToolTip(f"{self.entity_kind}: {entity_id}")

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
        self.setToolTip(f"{self.entity_kind}: {self.entity_id}")
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
        rect = QRectF(
            min(xs) - m, min(ys) - m,
            max(xs) - min(xs) + 2 * m, max(ys) - min(ys) + 2 * m,
        )
        metrics = QFontMetricsF(theme.make_editor_font(
            theme.FONT_ROLE_CANVAS_SECONDARY,
            family=MONO_FONT_FAMILY,
        ))
        label_rect = QRectF(
            min(xs) + 3,
            min(ys) + 12 - metrics.ascent(),
            metrics.horizontalAdvance(self.entity_id),
            metrics.height(),
        )
        return rect.united(label_rect)

    def refresh_editor_font(self) -> None:
        self.prepareGeometryChange()
        self.update()

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
            font = theme.make_editor_font(
                theme.FONT_ROLE_CANVAS_SECONDARY,
                family=MONO_FONT_FAMILY,
            )
            painter.setFont(font)
            # 半透明黑底垫在 id 文字下，避免白字画在亮背景图上不可读（审查 P3）。
            metrics = QFontMetricsF(font)
            tx, ty = min(xs) + 3, min(ys) + 12
            trect = QRectF(
                tx - 1, ty - metrics.ascent() - 1,
                metrics.horizontalAdvance(self.entity_id) + 2, metrics.height() + 2)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QBrush(QColor(0, 0, 0, 150)))
            painter.drawRect(trect)
            painter.setPen(QPen(Qt.GlobalColor.white))
            painter.drawText(QPointF(tx, ty), self.entity_id)
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
        rect = QRectF(
            min(xs) - m, min(ys) - m,
            max(xs) - min(xs) + 2 * m, max(ys) - min(ys) + 2 * m,
        )
        metrics = QFontMetricsF(theme.make_editor_font(
            theme.FONT_ROLE_CANVAS_SECONDARY,
            family=MONO_FONT_FAMILY,
        ))
        hrad = self.HANDLE_WORLD_R * 0.38
        for i, (px, py) in enumerate(self._points):
            label_rect = QRectF(
                px + hrad + 2,
                py + 4 - metrics.ascent(),
                metrics.horizontalAdvance(str(i)),
                metrics.height(),
            )
            rect = rect.united(label_rect)
        return rect

    def refresh_editor_font(self) -> None:
        self.prepareGeometryChange()
        self.update()

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
        painter.setFont(theme.make_editor_font(
            theme.FONT_ROLE_CANVAS_SECONDARY,
            family=MONO_FONT_FAMILY,
        ))
        for i, (px, py) in enumerate(self._points):
            c = QColor(180, 250, 255)
            if self._hover_vertex == i or self._drag_vertex == i:
                c = QColor(100, 220, 240)
            painter.setBrush(QBrush(c))
            painter.setPen(QPen(QColor(0, 120, 140), 0))
            painter.drawEllipse(QPointF(px, py), hrad, hrad)
            painter.setPen(QPen(Qt.GlobalColor.white))
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
        metrics = QFontMetricsF(theme.make_editor_font(
            theme.FONT_ROLE_CANVAS_MICRO,
            family=MONO_FONT_FAMILY,
        ))
        m = max(m, metrics.horizontalAdvance("az360 el90 I9.99 dk1.00") + self.HANDLE_WORLD_R * 1.5)
        m += 4
        return QRectF(
            min(xs) - m, min(ys) - m,
            max(xs) - min(xs) + 2 * m, max(ys) - min(ys) + 2 * m,
        )

    def refresh_editor_font(self) -> None:
        self.prepareGeometryChange()
        self.update()

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
        primary_font = theme.make_editor_font(
            theme.FONT_ROLE_CANVAS_PRIMARY,
            family=MONO_FONT_FAMILY,
        )
        micro_font = theme.make_editor_font(
            theme.FONT_ROLE_CANVAS_MICRO,
            family=MONO_FONT_FAMILY,
        )
        for i, p in enumerate(self._points):
            self._paint_light_gizmo(
                painter,
                i,
                p,
                selected=(i == self._selected),
                primary_font=primary_font,
                micro_font=micro_font,
            )
        painter.restore()

    def _paint_light_gizmo(
        self,
        painter: QPainter,
        i: int,
        p: dict,
        *,
        selected: bool,
        primary_font,
        micro_font,
    ) -> None:
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
        painter.setFont(primary_font if selected else micro_font)
        painter.drawText(QPointF(px + rr + 3, py + 4), str(i))
        if selected:
            painter.setFont(micro_font)
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

def _persp_editor_num(v: object) -> float | None:
    """透视字段数值解析（与运行时同口径：布尔/非数值/非有限一律 None）。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None

def _persp_cell_text(v: object) -> str:
    """透视表格单元原始文本（保留作者数值表示；非数值原样 str）。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return str(v) if v is not None else ""
    return str(v)

class _PerspAxisItem(QGraphicsObject):
    """透视缩放深度轴：作者画的 near→far 箭头（任意方向）+ 两端可拖手柄 +
    垂直于轴的等缩放等值线（near/far/中途点各一条虚线，视觉确认"等值线自动垂直生成"）。

    拖 near/far 端点：live 经 canvas._persp_axis_drag_update 更新画布预览（不入 model/脏），
    release 经 SceneCanvas.persp_axis_committed(which, x, y) 一次提交（面板→undo→model）。
    中途点只读展示（pos 数值在面板表格编辑）。
    """

    HANDLE_R = 12.0

    def __init__(
        self, canvas: "SceneCanvas",
        near_xy: tuple[float, float], far_xy: tuple[float, float],
        near_scale: float, far_scale: float,
        mid_stops: list[tuple[float, float]],
    ):
        super().__init__()
        self._canvas = canvas
        self.near = QPointF(float(near_xy[0]), float(near_xy[1]))
        self.far = QPointF(float(far_xy[0]), float(far_xy[1]))
        self.near_scale = float(near_scale)
        self.far_scale = float(far_scale)
        self.mid_stops = list(mid_stops)  # [(pos, scale)...]
        self._drag: str | None = None  # 'near' | 'far' | None
        self.setZValue(_Z_DECOR_PERSP_AXIS)
        self.setAcceptedMouseButtons(Qt.MouseButton.LeftButton)

    # ---- 几何 --------------------------------------------------------------
    def _axis_len(self) -> float:
        dx = self.far.x() - self.near.x()
        dy = self.far.y() - self.near.y()
        return math.hypot(dx, dy)

    def _perp_unit(self) -> tuple[float, float]:
        dx = self.far.x() - self.near.x()
        dy = self.far.y() - self.near.y()
        L = math.hypot(dx, dy) or 1.0
        return (-dy / L, dx / L)  # 垂直于轴

    def _iso_half(self) -> float:
        return max(40.0, self._canvas.world_size()[0] * 0.06, self._canvas.world_size()[1] * 0.06)

    def _point_at(self, pos: float) -> QPointF:
        return QPointF(
            self.near.x() + (self.far.x() - self.near.x()) * pos,
            self.near.y() + (self.far.y() - self.near.y()) * pos,
        )

    def boundingRect(self) -> QRectF:
        ih = self._iso_half() + self.HANDLE_R * 2
        left = min(self.near.x(), self.far.x()) - ih
        top = min(self.near.y(), self.far.y()) - ih
        w = abs(self.far.x() - self.near.x()) + ih * 2
        h = abs(self.far.y() - self.near.y()) + ih * 2
        return QRectF(left, top, w, h)

    def shape(self) -> QPainterPath:
        # 只有两个端点手柄参与命中：轴体/等值线不遮挡下方实体点选
        path = QPainterPath()
        r = self.HANDLE_R * 1.5
        path.addEllipse(self.near, r, r)
        path.addEllipse(self.far, r, r)
        return path

    def _draw_iso(self, painter: QPainter, center: QPointF) -> None:
        ux, uy = self._perp_unit()
        h = self._iso_half()
        painter.drawLine(
            QPointF(center.x() - ux * h, center.y() - uy * h),
            QPointF(center.x() + ux * h, center.y() + uy * h),
        )

    def paint(self, painter: QPainter, _opt, _widget=None) -> None:
        # 轴线（实线）+ 箭头指向 far
        painter.setPen(QPen(QColor(255, 170, 60, 230), 0))
        painter.drawLine(self.near, self.far)
        L = self._axis_len() or 1.0
        dx = (self.far.x() - self.near.x()) / L
        dy = (self.far.y() - self.near.y()) / L
        ah = max(18.0, self._iso_half() * 0.35)
        for sgn in (0.5, -0.5):
            painter.drawLine(
                self.far,
                QPointF(self.far.x() - dx * ah + (-dy) * ah * sgn,
                        self.far.y() - dy * ah + (dx) * ah * sgn),
            )
        # 等缩放等值线（虚线，垂直于轴）：near / far / 各中途点
        painter.setPen(QPen(QColor(255, 170, 60, 140), 0, Qt.PenStyle.DashLine))
        self._draw_iso(painter, self.near)
        self._draw_iso(painter, self.far)
        for pos, _s in self.mid_stops:
            self._draw_iso(painter, self._point_at(pos))
        # 端点手柄：near 实心大（近端大）、far 空心小（远端小）
        painter.setPen(QPen(QColor(150, 100, 20, 230), 0))
        painter.setBrush(QBrush(QColor(255, 200, 90, 230)))
        painter.drawEllipse(self.near, self.HANDLE_R, self.HANDLE_R)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawEllipse(self.far, self.HANDLE_R * 0.72, self.HANDLE_R * 0.72)
        # 标签
        painter.setFont(theme.make_editor_font(
            theme.FONT_ROLE_CANVAS_SECONDARY, family=MONO_FONT_FAMILY))
        painter.setPen(QPen(QColor(255, 210, 130, 235), 0))
        painter.drawText(QPointF(self.near.x() + 8, self.near.y() - 6),
                         f"近 ×{self.near_scale:g}")
        painter.drawText(QPointF(self.far.x() + 8, self.far.y() - 6),
                         f"远 ×{self.far_scale:g}")

    def refresh_editor_font(self) -> None:
        self.prepareGeometryChange()
        self.update()

    # ---- 交互 --------------------------------------------------------------
    def mousePressEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        p = event.pos()
        for which, handle in (("near", self.near), ("far", self.far)):
            if math.hypot(p.x() - handle.x(), p.y() - handle.y()) <= self.HANDLE_R * 1.6:
                self._drag = which
                event.accept()
                return
        event.ignore()

    def mouseMoveEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if self._drag is None:
            event.ignore()
            return
        p = event.pos()
        self.prepareGeometryChange()
        if self._drag == "near":
            self.near = QPointF(p.x(), p.y())
        else:
            self.far = QPointF(p.x(), p.y())
        self.update()
        # live：只更新画布预览（不入 model / 不置脏）
        self._canvas._persp_axis_drag_update(self._drag, float(p.x()), float(p.y()))
        event.accept()

    def mouseReleaseEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if self._drag is None:
            event.ignore()
            return
        which = self._drag
        self._drag = None
        handle = self.near if which == "near" else self.far
        self._canvas.persp_axis_committed.emit(which, float(handle.x()), float(handle.y()))
        event.accept()


_GROUP_BOX_COLOR = QColor(120, 230, 200, 150)        # 常态：淡青虚线
_GROUP_BOX_COLOR_SELECTED = QColor(120, 255, 210, 255)
_GROUP_BOX_PAD = 10.0                                 # 世界单位，框离成员的留白
# 命中尺寸一律按**屏幕像素**给：世界单位在真实场景（4000 宽、fit 后 0.21 倍）下
# 会缩成 3px 的可点带，用户根本按不中（审查实测）。世界值 = 屏幕值 ÷ 视图缩放。
_GROUP_EDGE_PICK_PX = 9.0                             # 框边可点带半宽（屏幕像素）
_GROUP_HANDLE_PX = 11.0                               # 把手半径（屏幕像素）
# 命中带内沿与成员之间的净空（屏幕像素）。留白只给到"恰好等于带宽"是不够的：
# 那样带子内沿与成员包围盒相切，定义极值的那个成员永远压线，1 像素取整就把
# 点击吃进带子。净空也按屏幕像素兜底，否则缩得越小越薄。
_GROUP_CLEARANCE_PX = 4.0


class _SceneGroupBox(QGraphicsObject):
    """场景分组在画布上的可见可拖形体（分组是一等实体，但它自己没有坐标）。

    几何全部是**派生**的：框 = 成员几何并集包围盒，把手 = ``editor.anchor`` 或框心。
    整组位移 = 把偏移烘进每个成员自己的坐标（与运行时 moveGroupBy 同语义，作者态版）。

    刻意的设计约束（改动前先读，全是踩过的坑）：

    1. **不进 Qt 选择系统**（``ItemIsSelectable=False``）：橡皮筋框选、批量删除/复制、
       多选页计数的目标集合永远只有真实体，杜绝"框选顺手把组一起删了"。组的选中态
       由编辑器显式经 :meth:`set_selected` 驱动。
    2. **shape() 只含框边描边 + 把手 + 标题**：框内是空的，鼠标穿透到成员，点选
       实体零影响（与 :class:`_TransformGizmo` 环体同法）。
    3. **命中尺寸按屏幕像素算**，不是世界单位：真实场景 4000 宽、fit 后 0.21 倍，
       世界单位的 7px 带宽会缩成 3 个屏幕像素，用户按不中；标题同理要
       ``ItemIgnoresTransformations``，否则缩成 2.5px 的糊线，且它的命中矩形必须
       按当前缩放现算（`mapRectFromItem` 拿到的是未缩放逻辑矩形，对不上文字）。
    4. **把手在框内左上、标题在框上边线之上**：把手不放包围盒中心（那是人群最密
       处，会压住实体，而叠放循环点选够不着组框，挡住就救不回来）；标题不放框内
       ——它是屏幕恒定尺寸，缩小的视图里换算成的世界矩形能罩死好几个成员（实测
       默认 fit 下 120×22px 变成 564×103 世界单位，压掉 4 个 NPC）。框外上方没人。
    5. **两段式选中**：没选中的组，边线按下只选中不拖动；否则用户想从这里起手拉
       橡皮筋，实际把整组悄悄挪走了。Ctrl 手势整个让给实体多选。
    6. **拖动 live 写"成员的当前真相份"**（staging 在就写 staging），并同步右侧
       数值框/顶点表/巡逻表——否则 commit 前的 flush 会拿控件旧值反向覆盖。
    """

    def __init__(self, view: "SceneCanvas", gid: str):
        super().__init__()
        self._view = view
        self.entity_kind = "group"
        self.entity_id = str(gid)
        self.gid = str(gid)
        self._w = 0.0
        self._h = 0.0
        self._anchor_local = QPointF(0.0, 0.0)
        self._title = str(gid)
        self._selected = False
        self._empty = True
        self._mode: str | None = None          # None | 'move' | 'anchor'
        self._acc_dx = 0.0                     # 本次手势累计 Δ（Esc 回滚用）
        self._acc_dy = 0.0
        self._press_scene = QPointF(0.0, 0.0)
        self._anchor_press = QPointF(0.0, 0.0)
        self.setZValue(_Z_DECOR_GROUP_BOX)     # 在实体之上、gizmo 之下
        self.setAcceptedMouseButtons(Qt.MouseButton.LeftButton)
        self.setAcceptHoverEvents(True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, False)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, False)
        # 标题：恒定屏幕字号（同实体标签的做法），随视图缩放的文字在 4000 宽的
        # 真实场景里只有 2.5px 高，肉眼看不见。
        self._title_item = QGraphicsTextItem(self._title, self)
        theme.set_graphics_text_font(
            self._title_item, theme.FONT_ROLE_CANVAS_SECONDARY,
            family=MONO_FONT_FAMILY)
        self._title_item.setFlag(
            QGraphicsTextItem.GraphicsItemFlag.ItemIgnoresTransformations, True)
        self._title_item.setFlag(
            QGraphicsTextItem.GraphicsItemFlag.ItemIsSelectable, False)
        self._title_item.setAcceptedMouseButtons(Qt.MouseButton.NoButton)
        self._apply_title_style()

    # ---- 几何 ---------------------------------------------------------------

    def set_geometry(
        self, rect: QRectF | None, anchor: QPointF, title: str,
    ) -> None:
        """rect=None（空组/成员无几何）时只留把手，框不画。"""
        self.prepareGeometryChange()
        self._title = str(title)
        if rect is None or rect.width() <= 0 or rect.height() <= 0:
            self._empty = True
            self._w = 0.0
            self._h = 0.0
            self.setPos(anchor)
            self._anchor_local = QPointF(0.0, 0.0)
        else:
            self._empty = False
            self._w = float(rect.width())
            self._h = float(rect.height())
            self.setPos(rect.topLeft())
            self._anchor_local = QPointF(
                float(anchor.x()) - rect.left(), float(anchor.y()) - rect.top())
        self.setToolTip(
            f"分组 {self.gid}\n"
            "点框边或标题选中；选中后拖框边/标题/把手 = 整组挪位"
            "（偏移写进每个成员自己的坐标）\n"
            "方向键微移（Shift ×10）· Alt+拖把手 = 只挪把手 · Esc 取消本次拖动\n"
            "框内区域不吃鼠标，成员照常点选；Ctrl+点让给实体多选")
        self._apply_title_style()
        self.update()

    def anchor_scene_pos(self) -> QPointF:
        return QPointF(self.pos().x() + self._anchor_local.x(),
                       self.pos().y() + self._anchor_local.y())

    def _world_per_px(self) -> float:
        """当前视图下 1 个屏幕像素等于多少世界单位（缩放为 0 时退回 1）。"""
        try:
            m = float(self._view.transform().m11())
        except (AttributeError, RuntimeError):
            return 1.0
        return 1.0 / m if m else 1.0

    def _handle_r(self) -> float:
        return _GROUP_HANDLE_PX * self._world_per_px()

    def _edge_pad(self) -> float:
        return _GROUP_EDGE_PICK_PX * self._world_per_px()

    def _on_handle(self, local: QPointF) -> bool:
        r = self._handle_r()
        return math.hypot(
            local.x() - self._anchor_local.x(),
            local.y() - self._anchor_local.y()) <= r

    def hoverMoveEvent(self, event: QGraphicsSceneHoverEvent) -> None:
        """可发现性：框边/把手上换光标，用户不点也知道这里能拖。"""
        if self._empty:
            self.setCursor(Qt.CursorShape.SizeAllCursor)
        elif self._selected and self._on_handle(event.pos()):
            self.setCursor(Qt.CursorShape.CrossCursor)
        else:
            self.setCursor(Qt.CursorShape.SizeAllCursor)
        super().hoverMoveEvent(event)

    def hoverLeaveEvent(self, event: QGraphicsSceneHoverEvent) -> None:
        self.unsetCursor()
        super().hoverLeaveEvent(event)

    def _apply_title_style(self) -> None:
        col = _GROUP_BOX_COLOR_SELECTED if self._selected else _GROUP_BOX_COLOR
        self._title_item.setDefaultTextColor(col)
        self._title_item.setPlainText(self._title)
        # 与把手并排摆在框**上边线之上**的空白里（Figma frame 标签的位置）。
        # 标题是屏幕恒定尺寸（约 120×22px），放框内的话，缩小的视图里换算成世界
        # 矩形就是 564×103 —— 实测把 4 个 NPC（3 个还是本组成员）罩死点不中，
        # 正是当初逼着把把手挪出人群的那条坑经由标题原样复活。
        # 高度取**图元自己的** boundingRect（含内边距），不是字体行高——命中矩形
        # 用的就是它，两者不同源的话标题底边会探进框里，又开始挡成员。
        wpp = self._world_per_px()
        r = self._handle_r()
        h = self._title_item.boundingRect().height() * wpp
        y = self._anchor_local.y() - h / 2.0          # 与把手垂直居中对齐
        if self._anchor_local.y() <= 0.0:
            # 把手在框外（常态）：标题再高也不许探进框内——文字比把手高，光按
            # 把手对齐会让它下缘伸进成员区，那正是 N7 那条坑。
            y = min(y, -h - 2.0 * wpp)
        self._title_item.setPos(self._anchor_local.x() + r * 1.3, y)

    def set_selected(self, on: bool) -> None:
        if self._selected == bool(on):
            return
        self._selected = bool(on)
        self._apply_title_style()
        self.update()

    def is_selected(self) -> bool:
        return self._selected

    def _label_font(self) -> QFont:
        return theme.make_editor_font(
            theme.FONT_ROLE_CANVAS_SECONDARY, family=MONO_FONT_FAMILY)

    def refresh_editor_font(self) -> None:
        """全局字号变化钩子（theme.refresh_graphics_scene_fonts 鸭子调用）。

        标题子图元的字体由同一次遍历直接刷（它自带角色标记），这里重算它的
        摆放位置——行高变了不重摆的话，标题会压到把手上。
        """
        self.prepareGeometryChange()
        self._apply_title_style()
        self.update()

    def _title_hit_rect(self) -> QRectF:
        """标题在本图元坐标系里占的矩形。

        **不能用 `mapRectFromItem`**：标题是 `ItemIgnoresTransformations` 子项，
        那条路拿到的是未缩放的逻辑矩形，命中区因此与画出来的文字对不上——缩小时
        画出来 120×22px 而可点的只有 26×5px（实测只有 19% 的文字响应），放大时
        反过来盖住框左上一带的成员。宽高必须按当前缩放现算，与把手同源。
        """
        try:
            br = self._title_item.boundingRect()
            pos = self._title_item.pos()
        except (RuntimeError, AttributeError):
            return QRectF()
        wpp = self._world_per_px()
        return QRectF(pos.x(), pos.y(), br.width() * wpp, br.height() * wpp)

    def refresh_screen_metrics(self) -> None:
        """视图缩放变了：标题位置与命中矩形都按屏幕像素换算，得重算一遍。

        不重算的话，缩放后标题相对把手会在下一次任意刷新时"跳"一下，命中区也
        停在旧缩放的尺寸上。"""
        self.prepareGeometryChange()
        self._apply_title_style()
        self.update()

    def boundingRect(self) -> QRectF:
        m = self._edge_pad() + self._handle_r() * 2
        rect = QRectF(-m, -m, self._w + m * 2, self._h + m * 2)
        rect = rect.adjusted(-self._handle_r() * 3, -self._handle_r() * 3, 0, 0)
        title = self._title_hit_rect()
        return rect.united(title) if title.isValid() else rect

    def shape(self) -> QPainterPath:
        """只有框边描边 +（选中时的）把手吃鼠标；框内区域留给成员点选。

        两处细节都踩过：
        - **必须 WindingFill**：默认的 OddEvenFill 会让把手椭圆与边框描边的重叠
          区互相抵消，框角上出现约 9 像素的命中缺口——那儿恰好是选中态画角标、
          用户最想点的地方，表现为"点了没反应"。
        - **把手只在选中时吃鼠标**：把手是屏幕恒定尺寸，在缩小的视图里换算成
          世界单位会很大，落在成员身上就把它们挡死了（组框又被叠放循环点选
          跳过，救不回来）。未选中的组从框边选，选中之后把手才接管。
        """
        path = QPainterPath()
        path.setFillRule(Qt.FillRule.WindingFill)
        if self._selected or self._empty:
            path.addEllipse(self._anchor_local, self._handle_r(), self._handle_r())
        # 标题也吃鼠标：未选中态它是除发丝虚线框外唯一常驻的组标识，而且恒 22px
        # 高，是全画布最好按的靶子——不让它可点，"点标签选中这个组"这个几乎人人
        # 会试的动作就落空了（Figma frame 标签正是这么用的）。
        title = self._title_hit_rect()
        if title.isValid():
            path.addRect(title)
        if not self._empty:
            stroker = QPainterPathStroker()
            stroker.setWidth(self._edge_pad() * 2)
            edge = QPainterPath()
            edge.addRect(QRectF(0.0, 0.0, self._w, self._h))
            path.addPath(stroker.createStroke(edge))
        return path

    # ---- 绘制 ---------------------------------------------------------------

    def paint(self, painter: QPainter, _opt, _widget=None) -> None:
        col = _GROUP_BOX_COLOR_SELECTED if self._selected else _GROUP_BOX_COLOR
        if not self._empty:
            # 选中态用 2px cosmetic 描边 + 角标：缩小视图下 1px 虚线几乎看不见，
            # 选中/未选中一眼分不出。**刻意不填充**——组框往往很大，一层色蒙在
            # 背景图上会干扰美术对位判断（编辑器的活就是对着背景摆位置）。
            pen = QPen(col, 2.0 if self._selected else 0.0, Qt.PenStyle.DashLine)
            pen.setCosmetic(True)
            painter.setPen(pen)
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawRect(QRectF(0.0, 0.0, self._w, self._h))
            if self._selected:
                # 四角实线角标：与虚线框一眼可分，缩小时也不会糊成一片
                seg = max(6.0, min(self._w, self._h) * 0.12)
                corner = QPen(col, 3.0, Qt.PenStyle.SolidLine)
                corner.setCosmetic(True)
                painter.setPen(corner)
                for cx, cy, sx, sy in (
                    (0.0, 0.0, 1.0, 1.0), (self._w, 0.0, -1.0, 1.0),
                    (0.0, self._h, 1.0, -1.0), (self._w, self._h, -1.0, -1.0),
                ):
                    painter.drawLine(QPointF(cx, cy), QPointF(cx + seg * sx, cy))
                    painter.drawLine(QPointF(cx, cy), QPointF(cx, cy + seg * sy))
        # 把手：**只在它真能点的时候才画**（与 shape() 的门控严格同步）。
        # 画了却点不动，就是画面上最像按钮的东西点下去毫无反应——未选中态恰恰
        # 是用户第一眼看到的状态，这种虚假承诺比不画更糟。组的存在由虚线框 +
        # 标题表达，信息不丢。
        # 半径用 painter 自己的世界变换（不是 view 的）——离屏渲染/导出到别的
        # 设备时 view 变换并不适用，照抄会画出一颗巨大的豆。
        if self._selected or self._empty:
            ap = self._anchor_local
            wm = painter.worldTransform().m11()
            r = _GROUP_HANDLE_PX / (wm if wm else 1.0)
            painter.setPen(QPen(QColor(20, 70, 60, 230), 0))
            painter.setBrush(QBrush(col))
            painter.drawEllipse(ap, r, r)
            painter.drawLine(QPointF(ap.x() - r * 0.55, ap.y()),
                             QPointF(ap.x() + r * 0.55, ap.y()))
            painter.drawLine(QPointF(ap.x(), ap.y() - r * 0.55),
                             QPointF(ap.x(), ap.y() + r * 0.55))
        # 标题由 _title_item（ItemIgnoresTransformations）画，不在这里 drawText——
        # 随视图缩放的文字在真实场景里只有 2.5 个屏幕像素高，等于没有。

    # ---- 交互 ---------------------------------------------------------------

    def mousePressEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        lp = event.pos()
        # Ctrl = 实体多选手势，不归组框管：组框边线在默认缩放下只有几个屏幕像素宽，
        # 用户眼里那就是"空白处"，吃掉这一下会把辛苦 Ctrl 加选的一串实体全清掉。
        if event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            event.ignore()
            return
        on_handle_hit = self._on_handle(lp)
        # 两段式：没选中的组，第一下**只选中**，不进拖动模式。否则用户想从这里
        # 起手拉橡皮筋框选，实际把整组悄悄挪走了（框边细，起点压上去太容易）。
        if not self._selected and not on_handle_hit:
            self._view.note_group_press()
            self._view.clear_selection()
            self._view.group_clicked.emit(self.gid)
            self._view.group_gesture_finished.emit(self.gid)
            self._mode = None
            event.accept()
            return
        # 选组 = 取消实体选择：否则 release 时 view 会拿残留的实体选中 emit
        # item_selected，把刚装载的分组面板顶掉（同一手势里两个面板打架）。
        self._view.note_group_press()
        self._view.clear_selection()
        # press 阶段**只做画布内的事**（高亮该组），不碰属性面板、不弹窗。
        # 装载面板会切 QStackedWidget → 布局重排 → 画布 resize → 若此刻 fit_all 的
        # 自动适配窗口还开着，resizeEvent 里的 resetTransform() 就会在 Qt 的鼠标
        # 事件派发栈中间重置视图矩阵，直接段错误（实测 SIGSEGV）。面板/树的同步
        # 一律等手势结束（group_gesture_finished）。
        self._view.clear_group_gesture_veto()
        self._view.group_clicked.emit(self.gid)
        # Alt+拖把手 = 只挪把手（改 editor.anchor），不动任何成员；
        # 空组没有成员可挪，拖动一律降级为挪把手（否则手势看着动、松手弹回）。
        # 判据用 on_handle_hit（与 shape() 同源的屏幕像素换算）——早先这里留了个
        # 世界单位常量，缩小的视图下把手可点区远大于它，用户在把手上 Alt+拖会
        # 错判成整组位移。
        alt = bool(event.modifiers() & Qt.KeyboardModifier.AltModifier)
        if (on_handle_hit and alt) or self._empty:
            self._mode = "anchor"
            self._anchor_press = self.anchor_scene_pos()
            self._press_scene = event.scenePos()
            event.accept()
            return
        self._mode = "move"
        self._acc_dx = 0.0
        self._acc_dy = 0.0
        self._press_scene = event.scenePos()
        # 撤销：手势起点捕获 before 快照（与实体拖拽同一通道）
        self._view.item_drag_press.emit()
        if self._view.group_gesture_vetoed():
            # 快照没抓成（未应用编辑被保护性校验挡下）：这次拖动不能放行，
            # 否则成员坐标照改、release 又因提交失败不入栈 = 改了撤不回。
            # 同时必须交还鼠标并清掉 press 标记——那次模态提示会吃掉本次 release，
            # 组框留成 scene 的 mouseGrabber 的话，用户下一次点击是完全没反应的死点。
            self._mode = None
            self.ungrabMouse()
            self._view.clear_group_press()
            event.ignore()
            return
        event.accept()

    def mouseMoveEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if self._mode is None:
            event.ignore()
            return
        sp = event.scenePos()
        ddx = round(sp.x() - self._press_scene.x(), 1)
        ddy = round(sp.y() - self._press_scene.y(), 1)
        if ddx == 0.0 and ddy == 0.0:
            event.accept()
            return
        self._press_scene = QPointF(
            self._press_scene.x() + ddx, self._press_scene.y() + ddy)
        if self._mode == "anchor":
            self.prepareGeometryChange()
            self._anchor_local = QPointF(
                self._anchor_local.x() + ddx, self._anchor_local.y() + ddy)
            self.update()
            event.accept()
            return
        self._acc_dx = round(self._acc_dx + ddx, 1)
        self._acc_dy = round(self._acc_dy + ddy, 1)
        self.moveBy(ddx, ddy)
        self._view.group_translate_live.emit(self.gid, float(ddx), float(ddy))
        event.accept()

    def mouseReleaseEvent(self, event: QGraphicsSceneMouseEvent) -> None:
        if self._mode is None:
            event.ignore()
            return
        mode = self._mode
        self._mode = None
        if mode == "anchor":
            ap = self.anchor_scene_pos()
            if (round(ap.x(), 1), round(ap.y(), 1)) != (
                round(self._anchor_press.x(), 1), round(self._anchor_press.y(), 1)
            ):
                self._view.group_anchor_committed.emit(
                    self.gid, round(float(ap.x()), 1), round(float(ap.y()), 1))
            self._view.group_gesture_finished.emit(self.gid)
            event.accept()
            return
        dx, dy = self._acc_dx, self._acc_dy
        self._acc_dx = 0.0
        self._acc_dy = 0.0
        # 零位移点击（点一下选中）不提交：防伪脏，与实体拖拽同门
        if dx == 0.0 and dy == 0.0:
            self._view.group_translate_abandoned.emit(self.gid)
        else:
            self._view.group_translate_committed.emit(self.gid, float(dx), float(dy))
        # 手势收尾（面板/树同步等一切会改布局的事都排在这之后，不在 press/move 里）
        self._view.group_gesture_finished.emit(self.gid)
        event.accept()

    def gesture_active(self) -> bool:
        return self._mode is not None

    def cancel_gesture(self) -> None:
        """Esc 取消：把本次手势累计的 Δ 原路退回（成员坐标 + 框位置一起退）。"""
        mode = self._mode
        if mode is None:
            return
        self._mode = None
        if mode == "anchor":
            self.prepareGeometryChange()
            ap = self._anchor_press
            self._anchor_local = QPointF(ap.x() - self.pos().x(), ap.y() - self.pos().y())
            self.update()
            return
        dx, dy = self._acc_dx, self._acc_dy
        self._acc_dx = 0.0
        self._acc_dy = 0.0
        if dx == 0.0 and dy == 0.0:
            self._view.group_translate_abandoned.emit(self.gid)
            return
        self.moveBy(-dx, -dy)
        self._view.group_translate_live.emit(self.gid, float(-dx), float(-dy))
        self._view.group_translate_abandoned.emit(self.gid)


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
    # 统一光影：定位模式下点画布 → 把选中的灯落到该处地面
    light_place_requested = Signal(float, float)
    # 右键菜单：在 (wx, wy) 世界坐标处添加实体；kind: hotspot|npc|zone|spawn
    context_add_entity = Signal(str, float, float)
    # 拖拽中按 Esc 取消：把该实体恢复到按下前坐标（kind, id, orig_x, orig_y）
    drag_cancelled = Signal(str, str, float, float)
    # 左键按到可拖实体图元（潜在拖拽起点）：撤销系统在此捕获「拖拽前」快照——
    # live 拖拽会连续写 staging，release 时旧值已被污染，before 必须取在手势起点。
    item_drag_press = Signal()
    # 多选整体拖动 release：list[(kind, id, x, y)]，≥2 项时代替逐项 item_moved，
    # 让编辑器把一次手势收敛成一条撤销命令。
    items_batch_moved = Signal(object)
    # 实例 transform gizmo：拖手柄期间 live（纯视觉/数值框），release 一次提交
    # (kind, id, scale, rotation_deg)
    transform_gizmo_live = Signal(str, str, float, float)
    transform_gizmo_committed = Signal(str, str, float, float)
    # 透视深度轴端点拖动提交：(which 'near'|'far', 新 x, 新 y)
    persp_axis_committed = Signal(str, float, float)
    # 深度轴端点拖动 live：画布已就地更新 cfg 端点，通知编辑器刷新实体预览（不入 model）
    persp_axis_live_refresh = Signal()
    # ---- 场景分组（_SceneGroupBox；组不进 Qt 选择系统，选中态由编辑器驱动） ----
    # 点中组框（框边或把手）：press 阶段发，编辑器**只**做画布内高亮
    group_clicked = Signal(str)
    # 手势结束（release / Esc 之后）：此时才允许装载属性面板、同步实体树等会
    # 改布局的操作——在鼠标事件派发栈中间改布局会触发画布 resize→resetTransform，
    # 实测直接段错误。
    group_gesture_finished = Signal(str)
    # 整组拖动 live：(gid, 增量 dx, 增量 dy) —— 编辑器就地把增量烘进成员坐标
    group_translate_live = Signal(str, float, float)
    # 整组拖动 release：(gid, 本次手势累计 dx, dy) —— 编辑器标脏 + 收敛为一条撤销命令
    group_translate_committed = Signal(str, float, float)
    # 手势作废（零位移点击 / Esc 已原路回滚）：编辑器丢弃按下时捕获的撤销快照
    group_translate_abandoned = Signal(str)
    # Alt+拖把手：只改 editor.anchor（不动成员）(gid, x, y)
    group_anchor_committed = Signal(str, float, float)
    # 选中组时方向键微移：(gid, dx, dy, is_autorepeat)。一次按键 = 一条撤销命令；
    # 按住不放（autorepeat）的连发合并进同一条，免得 Ctrl+Z 要按几十次。
    group_nudge = Signal(str, float, float, bool)
    # 视图缩放变了：组框的留白/把手位置按屏幕像素定尺，需要编辑器重新派生几何
    view_scale_changed = Signal()
    # 画布上右键分组框的菜单项（与右侧面板同名按钮走同一批槽）
    group_select_members_requested = Signal(str)
    group_anchor_reset_requested = Signal(str)
    group_delete_requested = Signal(str)

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self._gfx = QGraphicsScene(self)
        self.setScene(self._gfx)
        self.setRenderHints(QPainter.RenderHint.Antialiasing |
                            QPainter.RenderHint.SmoothPixmapTransform)
        self.setViewportUpdateMode(
            QGraphicsView.ViewportUpdateMode.SmartViewportUpdate)
        # 左键用于选择/拖移图元；按空白拖出橡皮筋框选（多选）；平移视图使用鼠标中键
        # （见 mousePress/Move/Release）。Ctrl+点选为 Qt 原生加选/减选。
        self.setDragMode(QGraphicsView.DragMode.RubberBandDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self._middle_panning = False
        self._pan_last_pos = QPoint()
        # 纯点选（零位移）防伪脏：press 时快照被抓取图元的位置，release 比对；
        # 位置未变则只发 item_selected，不发 item_moved（不写坐标、不标脏）。
        self._press_item_pos: dict[int, tuple[float, float]] = {}
        self._drag_cancelled: bool = False
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
        # 时段视图过滤（同为纯视图）：None=显示全部；否则只显示存在于该时段的实体。
        # 缺省(无 phases)按**实体种类分叉**——NPC 只在「街上有人」的段，热点/区域全时段，
        # 与运行时 SceneManager.getNpcBaseVisibleForInteraction / getHotspotBase… 同口径。
        self._phase_filter: str | None = None
        self._phase_npc_default: list[str] = []
        # 两条过滤共用一份登记：`kind:id` → (planes, phases)。**必须合一**——各存各的
        # 就会各自 set_entity_visible，后跑的那条把前一条的判定冲掉（切位面会让被时段
        # 藏起来的实体冒出来）。判定见 _entity_visible_under_view_filters。
        self._entity_view_meta: dict[str, tuple[list[str] | None, list[str] | None]] = {}
        self._patrol_overlays: dict[str, _NpcPatrolPolyline] = {}
        # 不住 _entity_items 的 part 的适配器（见 scene_canvas_model.EXTERNAL_PARTS）。
        # 巡逻折线由画布自己登记；NPC 动画精灵由 SceneEditor 登记（它才持有 runtime）。
        self._part_adapters: dict[tuple[str, str], dict] = {}
        self.register_part_adapter(
            "npc", "patrol",
            item_of=lambda eid: self._patrol_overlays.get(eid),
            drop=self.remove_npc_patrol_overlay,
        )
        self._lightcurve_overlay: _LightCurvePolyline | None = None
        self._light_place_mode: bool = False
        self._world_w: float = 800
        self._world_h: float = 600
        self._project_model: ProjectModel | None = None
        self._auto_fit_after_layout: bool = False
        self._fit_layout_token: int = 0
        # True 时：画布上禁止点选/拖动所有 Zone 与 Hotspot 碰撞多边形，以便点选其下方实体
        self._zone_pick_frozen: bool = False
        # 实例 transform gizmo（单选 hotspot/npc 时显示；clear_scene 时随场景清空）
        self._transform_gizmo: _TransformGizmo | None = None
        # 点选类对话框（出生点/相机/位置 picker）置 True：恢复 NoDrag 单手势语义——
        # 它们只连 item_moved，批量信号无人消费会造成"框选拖动视觉动、数据不写"（审查 P2-B）。
        self._single_gesture_only = False
        # 场景透视缩放（近大远小）：面板/加载路径经 set_perspective_config 写入；
        # 实体预览统一经 persp_factor 求系数（与运行时同口径，防预览撒谎）。
        self._persp_cfg: dict | None = None
        self._persp_axis_item: "_PerspAxisItem | None" = None
        # 场景分组框：gid -> _SceneGroupBox（同时登记进 _entity_items["group:<gid>"]
        # 供 _focus_canvas_on_entity 定位；组框不参与 Qt 选择系统，见类注释）
        self._group_boxes: dict[str, "_SceneGroupBox"] = {}
        self._group_boxes_visible: bool = True
        self._selected_group: str | None = None
        # 本次鼠标手势落在组框上：release 时跳过实体选中/取消派发
        self._group_press_active: bool = False
        # 编辑器否决了本次组手势（commit-on-leave 被保护性校验挡下）
        self._group_gesture_vetoed: bool = False

    def set_single_gesture_only(self) -> None:
        self._single_gesture_only = True
        self.setDragMode(QGraphicsView.DragMode.NoDrag)

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
        self._group_boxes.clear()  # 图元已随 _gfx.clear() 析构；选中组由调用方重设
        # _plane_filter / _phase_filter 保留：切场景后按同一视图重贴
        self._entity_view_meta.clear()
        self._patrol_overlays.clear()
        self._lightcurve_overlay = None
        self._transform_gizmo = None  # 图元已随 _gfx.clear() 析构
        self._persp_cfg = None
        self._persp_axis_item = None  # 图元已随 _gfx.clear() 析构

    def set_perspective_config(self, cfg: dict | None) -> None:
        """写入当前场景 perspectiveScale（None=未启用）并重建画布深度轴箭头。
        实体图元不在此刷新——调用方按需刷新（加载路径随后 add_*，编辑路径显式刷）。
        **必须深拷贝**：加载路径传入的是 model 的 dict，画布 live 拖动会就地改 cfg 端点，
        直接持引用会污染 model / 破坏撤销基线（审查：拖轴撤销回不去）。"""
        self._persp_cfg = copy.deepcopy(cfg) if isinstance(cfg, dict) else None
        if self._persp_axis_item is not None and self._persp_axis_item.scene() is self._gfx:
            self._gfx.removeItem(self._persp_axis_item)
        self._persp_axis_item = None
        a = perspective_axis_data(self._persp_cfg)
        if a is not None:
            near = self._persp_cfg["near"]
            far = self._persp_cfg["far"]
            mids: list[tuple[float, float]] = []
            for m in (self._persp_cfg.get("midStops") or []):
                if isinstance(m, dict):
                    mp = _persp_editor_num(m.get("pos"))
                    ms = _persp_editor_num(m.get("scale"))
                    if mp is not None and ms is not None and 0.0 < mp < 1.0 and ms > 0:
                        mids.append((mp, ms))
            item = _PerspAxisItem(
                self,
                (float(near["x"]), float(near["y"])),
                (float(far["x"]), float(far["y"])),
                float(near["scale"]), float(far["scale"]), mids)
            self._gfx.addItem(item)
            self._persp_axis_item = item

    def _persp_axis_drag_update(self, which: str, x: float, y: float) -> None:
        """深度轴端点拖动 live：更新画布 cfg 副本端点坐标 + 刷新全部实体预览（不入 model/脏）。"""
        if not isinstance(self._persp_cfg, dict):
            return
        key = "near" if which == "near" else "far"
        pt = self._persp_cfg.get(key)
        if isinstance(pt, dict):
            pt["x"] = x
            pt["y"] = y
        self.persp_axis_live_refresh.emit()

    def persp_factor(
        self, ent: dict | None, kind: str,
        foot_x: float | None = None, foot_y: float | None = None,
    ) -> float:
        """实体画布预览的透视系数（参与判定 × f(脚底点)）；未配置时恒 1。"""
        return entity_perspective_factor(self._persp_cfg, ent, kind, foot_x, foot_y)

    def _sync_collision_persp_ghost(
        self,
        key: str,
        anchor_x: float,
        anchor_y: float,
        world_pts: list[tuple[float, float]],
        pf: float,
        color: QColor,
    ) -> None:
        """运行时命中面幽灵轮廓：参与透视（pf≠1）且有碰撞多边形时，把 authored 世界多边形
        绕锚点 × 透视系数画成只读虚线（与运行时 anchorCollisionPolygonToWorld extraScale
        同口径）。可编辑多边形保持 authored 空间（顶点拖拽/表格写回零改动），两者并存防预览撒谎。"""
        show = pf != 1.0 and len(world_pts) >= 3
        it = self._entity_items.get(key)
        if not show:
            if it is not None:
                self._entity_items.pop(key, None)
                if it.scene() is self._gfx:
                    self._gfx.removeItem(it)
            return
        poly = QPolygonF([
            QPointF(anchor_x + (px - anchor_x) * pf, anchor_y + (py - anchor_y) * pf)
            for px, py in world_pts
        ])
        if isinstance(it, QGraphicsPolygonItem) and it.scene() is self._gfx:
            it.setPolygon(poly)
            return
        if it is not None and it.scene() is self._gfx:
            self._gfx.removeItem(it)
        g = QGraphicsPolygonItem(poly)
        g.setPen(QPen(QColor(color.red(), color.green(), color.blue(), 210), 0,
                      Qt.PenStyle.DashLine))
        g.setBrush(Qt.BrushStyle.NoBrush)
        g.setZValue(_Z_DECOR_COLLISION)
        g.setAcceptedMouseButtons(Qt.MouseButton.NoButton)
        self._gfx.addItem(g)
        self._entity_items[key] = g

    def show_transform_gizmo(
        self, kind: str, eid: str, ax: float, ay: float,
        scale_v: float, rot_deg: float, size_hint: float,
    ) -> None:
        if self._transform_gizmo is None or self._transform_gizmo.scene() is not self._gfx:
            self._transform_gizmo = _TransformGizmo(self)
            self._gfx.addItem(self._transform_gizmo)
        self._transform_gizmo.set_target(kind, eid, ax, ay, scale_v, rot_deg, size_hint)
        self._transform_gizmo.show()

    def hide_transform_gizmo(self) -> None:
        if self._transform_gizmo is not None and self._transform_gizmo.scene() is self._gfx:
            self._transform_gizmo.hide()

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
            # 分组框不是实体图元：不参与叠放循环点选、不抬 z、不进选中集合
            if isinstance(it, _SceneGroupBox):
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

    def _add_bg_placeholder(self, world_w: float, world_h: float, msg: str) -> None:
        """背景图缺失/加载失败时画占位提示，避免对着纯色空画布盲点坐标（审查 P3）。"""
        txt = QGraphicsTextItem(msg)
        txt.setDefaultTextColor(QColor(180, 180, 190))
        theme.set_graphics_text_font(
            txt, theme.FONT_ROLE_CANVAS_SECONDARY, family=MONO_FONT_FAMILY)
        txt.setZValue(_Z_BG_PLACEHOLDER)
        br = txt.boundingRect()
        txt.setPos(max(0.0, world_w / 2 - br.width() / 2),
                   max(0.0, world_h / 2 - br.height() / 2))
        txt.setFlag(QGraphicsTextItem.GraphicsItemFlag.ItemIsSelectable, False)
        self._gfx.addItem(txt)

    def load_background(self, img_path: Path,
                        world_w: float, world_h: float) -> None:
        """Load image and scale it to fill the (world_w x world_h) quad."""
        if not img_path.exists():
            self._add_bg_placeholder(world_w, world_h, "（背景图缺失：仍可点选坐标，但无底图参照）")
            return
        pm = QPixmap(str(img_path))
        if pm.isNull():
            self._add_bg_placeholder(world_w, world_h, "（背景图加载失败：仍可点选坐标，但无底图参照）")
            return
        self._bg_item = QGraphicsPixmapItem(pm)
        self._bg_item.setZValue(_Z_BACKGROUND)
        sx = world_w / pm.width()
        sy = world_h / pm.height()
        self._bg_item.setTransform(QTransform.fromScale(sx, sy))
        self._gfx.addItem(self._bg_item)

    def add_hotspot(self, hs: dict) -> None:
        ht = hs.get("type", "inspect")
        color = _HOTSPOT_COLORS.get(ht, _HOTSPOT_COLORS["inspect"])
        ir = (float(hs.get("interactionRange", 50) or 0)
              * entity_scale_of(hs) * self.persp_factor(hs, "hotspot"))
        item = _DraggableCircle(
            hs["x"], hs["y"], self.handle_radius,
            color, hs.get("id", "?"), "hotspot",
            range_radius=ir, scene_view=self)
        self._gfx.addItem(item)
        self._entity_items[f"hotspot:{hs.get('id', '')}"] = item
        self.refresh_hotspot_visuals(hs)
        self._record_entity_view(f"hotspot:{hs.get('id', '')}", hs)

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
        # 实例 scale × 透视系数：与运行时 Hotspot 容器级复合同口径（防预览撒谎）
        pf = self.persp_factor(hs, "hotspot")
        inst_s = entity_scale_of(hs) * pf
        inst_rot = entity_rotation_deg_of(hs)

        def _foot_anchor_transform(frame_w: float, frame_h: float) -> QTransform:
            """底中锚 quad 的统一变换（与运行时 container 级 transform 同口径）：
            平移到锚点 → 实例旋转 → (实例缩放×帧到世界缩放) → 帧局部底中对齐。"""
            t = QTransform()
            t.translate(cx, cy)
            if inst_rot:
                t.rotate(inst_rot)
            t.scale(inst_s * ww / frame_w, inst_s * hh / frame_h)
            t.translate(-frame_w * 0.5, -frame_h)
            return t

        # displayImage 来源签名：拖拽中只有 x/y 变、签名不变时，原地重摆既有 pixmap，
        # 不再每帧 remove+重建+从磁盘重载 —— 消除"拖热区时贴图狂闪 + 卡顿"（perf-reload）。
        # 实例 transform 进签名：scale/rotation 变化走同样的原地重摆快路径。
        disp_sig = (img, ww, hh, facing) if (img and ww > 0 and hh > 0) else None
        existing_disp = self._entity_items.get(disp_key)
        if (
            disp_sig is not None
            and isinstance(existing_disp, QGraphicsPixmapItem)
            and getattr(existing_disp, "_disp_sig", None) == disp_sig
            and existing_disp.scene() is self._gfx
        ):
            pm0 = existing_disp.pixmap()
            existing_disp.setTransform(
                _foot_anchor_transform(max(pm0.width(), 1), max(pm0.height(), 1)))
            existing_disp.setPos(0.0, 0.0)
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
                    pix_it.setTransform(_foot_anchor_transform(sw, sh))
                    pix_it.setPos(0.0, 0.0)
                    pix_it.setZValue(_Z_CONTENT_LO)
                    pix_it._disp_sig = disp_sig
                    self._gfx.addItem(pix_it)
                    self._entity_items[disp_key] = pix_it
                else:
                    rect = QGraphicsRectItem(0, 0, ww, hh)
                    rect.setBrush(QBrush(QColor(200, 120, 255, 38)))
                    rect.setPen(QPen(QColor(140, 70, 190, 200), 0, Qt.PenStyle.DashLine))
                    rect.setTransform(_foot_anchor_transform(ww, hh))
                    rect.setPos(0.0, 0.0)
                    rect.setZValue(_Z_CONTENT_LO)
                    self._gfx.addItem(rect)
                    self._entity_items[disp_key] = rect
        col_key = f"hotspot_collision:{hid}"
        poly = hs.get("collisionPolygon")
        pts: list[tuple[float, float]] = []
        # 碰撞多边形保持 authored 空间显示（不乘透视系数）：表格/顶点拖拽/写回同一空间，
        # 引入系数会与既有双向同步（表格 world ↔ 画布 world）裂脑。运行时命中面按系数
        # 缩放属已知预览差（参与透视的实体通常用交互半径，见 authoring-surface 文档）。
        if isinstance(poly, list) and len(poly) >= 3:
            if hs.get("collisionPolygonLocal") is True:
                for p in _hotspot_collision_local_to_world(hs, poly):
                    pts.append((float(p["x"]), float(p["y"])))
            else:
                # 旧版世界坐标 authored：与运行时同口径，绕锚点施加实例 transform
                s0 = entity_scale_of(hs)
                r0 = entity_rotation_deg_of(hs)
                for p in poly:
                    if isinstance(p, dict):
                        wx, wy = transform_local_vec(
                            float(p.get("x", 0)) - cx, float(p.get("y", 0)) - cy, s0, r0)
                        pts.append((wx + cx, wy + cy))
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
                poly_item.setZValue(_Z_DECOR_COLLISION)
                self._gfx.addItem(poly_item)
                self._entity_items[col_key] = poly_item
                if self._zone_pick_frozen:
                    poly_item.set_zone_pick_frozen(True)
        else:
            old_col = self._entity_items.pop(col_key, None)
            if old_col is not None and old_col.scene() is self._gfx:
                self._gfx.removeItem(old_col)
        self._sync_collision_persp_ghost(
            f"hotspot_collision_ghost:{hid}", cx, cy, pts, pf,
            _HOTSPOT_COLLISION_ZONE_COLOR)
        # 上面几支都可能**重建**图元（展示图缺件占位框那一支没有签名缓存，每次必重建），
        # 而新图元默认可见。不在这里重贴一次，被位面/时段藏起来的热点只要被刷新一次
        # 就会冒出来半个鬼影：圆点还藏着、贴图回来了。
        self.refresh_entity_presence("hotspot", hid)

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
        # 碰撞多边形保持 authored 空间显示（不乘透视系数），理由同 hotspot 侧注释；
        # 运行时命中面另画只读幽灵轮廓（函数尾）。
        if isinstance(poly, list) and len(poly) >= 3:
            if npc.get("collisionPolygonLocal") is True:
                for p in _hotspot_collision_local_to_world(npc, poly):
                    pts.append((float(p["x"]), float(p["y"])))
            else:
                # 旧版世界坐标 authored：与运行时同口径，绕锚点施加实例 transform
                nx0 = float(npc.get("x", 0))
                ny0 = float(npc.get("y", 0))
                s0 = entity_scale_of(npc)
                r0 = entity_rotation_deg_of(npc)
                for p in poly:
                    if isinstance(p, dict):
                        wx, wy = transform_local_vec(
                            float(p.get("x", 0)) - nx0, float(p.get("y", 0)) - ny0, s0, r0)
                        pts.append((wx + nx0, wy + ny0))
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
                poly_item.setZValue(_Z_DECOR_COLLISION)
                self._gfx.addItem(poly_item)
                self._entity_items[col_key] = poly_item
                if self._zone_pick_frozen:
                    poly_item.set_zone_pick_frozen(True)
        else:
            old_col = self._entity_items.pop(col_key, None)
            if old_col is not None and old_col.scene() is self._gfx:
                self._gfx.removeItem(old_col)
        self._sync_collision_persp_ghost(
            f"npc_collision_ghost:{nid}",
            float(npc.get("x", 0)), float(npc.get("y", 0)),
            pts, self.persp_factor(npc, "npc"),
            _NPC_COLLISION_ZONE_COLOR)
        # 同 refresh_hotspot_visuals 末尾：重建出来的图元默认可见，必须重贴过滤。
        self.refresh_entity_presence("npc", nid)

    def update_npc_collision_polygon(self, entity_id: str, polygon: list) -> None:
        key = f"npc_collision:{entity_id}"
        item = self._entity_items.get(key)
        if isinstance(item, _EditableZonePolygon):
            item.set_points_from_model(polygon)

    def add_npc(self, npc: dict) -> None:
        ir = (float(npc.get("interactionRange", 50) or 0)
              * entity_scale_of(npc) * self.persp_factor(npc, "npc"))
        item = _DraggableCircle(
            npc["x"], npc["y"], self.handle_radius,
            _NPC_COLOR, npc.get("id", "?"), "npc",
            range_radius=ir, scene_view=self)
        self._gfx.addItem(item)
        self._entity_items[f"npc:{npc.get('id', '')}"] = item
        self.refresh_npc_collision_visuals(npc)
        self._record_entity_view(f"npc:{npc.get('id', '')}", npc)

    def add_zone(self, zone: dict) -> None:
        pts = _zone_polygon_points_for_editor(zone)
        item = _EditableZonePolygon(
            self, pts, _zone_canvas_color(zone), zone.get("id", "?"))
        self._gfx.addItem(item)
        self._entity_items[f"zone:{zone.get('id', '')}"] = item
        self._record_entity_view(f"zone:{zone.get('id', '')}", zone)
        if self._zone_pick_frozen:
            item.set_zone_pick_frozen(True)

    # ---- 场景分组框（派生几何；组本身无坐标） -------------------------------

    def sync_group_boxes(self, rows: list[dict]) -> None:
        """全量同步分组框。rows: [{"id","title","rect": QRectF|None,"anchor": QPointF}]

        就地更新优先、多余的移除——加载/提交路径每次都调它，remove+create 会在
        高频路径上反复析构图元（与 patrol overlay 同一教训）。
        """
        wanted: set[str] = set()
        for row in rows:
            gid = str(row.get("id") or "").strip()
            if not gid:
                continue
            wanted.add(gid)
            item = self._group_boxes.get(gid)
            if item is None or item.scene() is not self._gfx:
                item = _SceneGroupBox(self, gid)
                self._gfx.addItem(item)
                self._group_boxes[gid] = item
            rect = row.get("rect")
            anchor = row.get("anchor")
            item.set_geometry(
                rect if isinstance(rect, QRectF) else None,
                anchor if isinstance(anchor, QPointF) else QPointF(0.0, 0.0),
                str(row.get("title") or gid),
            )
            # 小框压在大框之上：两个组重叠时，点重叠处拿到的是更"具体"的那个，
            # 否则大框会把套在它里面的小组彻底挡住、永远点不中。
            # 面积相同的组再按登记顺序拉开一点，避免 z 相等时命中不确定。
            area = (rect.width() * rect.height()) if isinstance(rect, QRectF) else 0.0
            item.setZValue(
                _Z_DECOR_GROUP_BOX + 1.0 / (1.0 + area / 1_000_000.0)
                + len(wanted) * 1e-4)
            item.setVisible(self._group_boxes_visible)
            self._entity_items[f"group:{gid}"] = item
        for gid in [g for g in self._group_boxes if g not in wanted]:
            self.remove_group_box(gid)
        self.set_selected_group(self._selected_group)

    def remove_group_box(self, gid: str) -> None:
        item = self._group_boxes.pop(str(gid), None)
        self._entity_items.pop(f"group:{gid}", None)
        if item is not None and item.scene() is self._gfx:
            self._gfx.removeItem(item)
        if self._selected_group == str(gid):
            self._selected_group = None

    def set_group_boxes_visible(self, visible: bool) -> None:
        self._group_boxes_visible = bool(visible)
        for item in self._group_boxes.values():
            item.setVisible(self._group_boxes_visible)

    def group_boxes_visible(self) -> bool:
        return self._group_boxes_visible

    def set_selected_group(self, gid: str | None) -> None:
        """组的选中态：显式驱动（组不进 Qt 选择系统）。None = 全部取消。"""
        want = str(gid) if gid else None
        self._selected_group = want if (want in self._group_boxes) else None
        for key, item in self._group_boxes.items():
            item.set_selected(key == self._selected_group)

    def selected_group(self) -> str | None:
        return self._selected_group

    def group_box(self, gid: str) -> "_SceneGroupBox | None":
        return self._group_boxes.get(str(gid))

    def active_group_gesture(self) -> "_SceneGroupBox | None":
        for item in self._group_boxes.values():
            if item.gesture_active():
                return item
        return None

    def note_group_press(self) -> None:
        """组框吃下本次左键手势：release 时 view 不再派发实体选中/取消。"""
        self._group_press_active = True

    def clear_group_press(self) -> None:
        """手势被作废：立刻交还给正常派发，别让下一次点击变成死点。"""
        self._group_press_active = False

    def clear_group_gesture_veto(self) -> None:
        self._group_gesture_vetoed = False

    def veto_group_gesture(self) -> None:
        """编辑器在 group_clicked 处理里拒绝本次手势（提交被保护性校验挡下）。"""
        self._group_gesture_vetoed = True

    def group_gesture_vetoed(self) -> bool:
        return self._group_gesture_vetoed

    def update_zone_polygon(
        self, entity_id: str, polygon: list,
    ) -> None:
        """属性面板改顶点表时同步画布多边形。"""
        key = f"zone:{entity_id}"
        item = self._entity_items.get(key)
        if isinstance(item, _EditableZonePolygon):
            item.set_points_from_model(polygon)

    # ---- 图元 → 宿主画布的上报通道（`_emit_*` 与 `_persp_axis_drag_update`）------
    #
    # 这一族**刻意**保持下划线开头，且**刻意**由图元类从"类外"调用：图元
    # （_EditableZonePolygon / _NpcPatrolPolyline / _LightCurvePolyline / _PerspAxisItem）
    # 与画布是同模块内的一体两面，手势结束时要把结果交回宿主再转成 Signal 发出去。
    # 它们不是"越界访问"，是 item→view 的内部回调 —— 与上面那批已收口成公共 API 的
    # 查询/命令是两回事，别顺手把它们也改成 public（那等于邀请编辑器直接伪造手势结果）。

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
    def set_light_place_mode(self, on: bool) -> None:
        """开/关「在画布上定位灯」。开着时左键点击只用来落灯，不选实体。"""
        self._light_place_mode = bool(on)
        self.setCursor(Qt.CursorShape.CrossCursor if on else Qt.CursorShape.ArrowCursor)

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
        # 新建的折线默认可见：被位面/时段藏起来的 NPC 不许因为"加了个巡逻点"就露出来。
        self.refresh_entity_presence("npc", npc_id)

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

    # ---- part 级统一操作（清单唯一真相在 scene_canvas_model.PART_TABLE）--------
    #
    # 此前 set_entity_visible / remove_hotspot_graphics / remove_npc_graphics 各手写
    # 一份"这一族有哪些图元"的字符串清单，彼此不同步——npc 那份漏了动画精灵，于是
    # 切时段藏 NPC 时圆点没了、人还站着。三处合并到 PART_TABLE 后，增删附属图元
    # 只改那一张表。

    def register_part_adapter(
        self,
        kind: str,
        part: str,
        *,
        item_of: "Callable[[str], QGraphicsItem | None]",
        set_visible: "Callable[[str, bool], None] | None" = None,
        drop: "Callable[[str], None] | None" = None,
    ) -> None:
        """登记一个**不住 `_entity_items`** 的 part（见 `EXTERNAL_PARTS`）。

        为什么要适配器而不是把它们搬进 `_entity_items`：巡逻折线住
        `_patrol_overlays`、NPC 动画精灵住 `SceneEditor._scene_npc_runtimes`，
        大量既有测试直接摸这两个容器；搬家会把一次结构收敛变成一次大范围改测试。
        适配器让"账本走一圈"覆盖到它们，而物理存储原地不动。

        `set_visible` 可选：某些 part 的可见性**不能**直接 `item.setVisible()` 了事
        （NPC 精灵的动画定时器每 8ms 会无条件把 item 显出来，必须改 runtime 的闸门）。
        给了就用它，没给就退回 `item_of(...).setVisible(...)`。
        """
        self._part_adapters[(str(kind).strip().lower(), part)] = {
            "item_of": item_of, "set_visible": set_visible, "drop": drop,
        }

    def _part_item(self, kind: str, entity_id: str, part: str, key: str | None):
        """取某个 part 的图元：住 `_entity_items` 的直接查，外部 part 问适配器。"""
        if key is not None:
            return self._entity_items.get(key)
        ad = self._part_adapters.get((str(kind).strip().lower(), part))
        return None if ad is None else ad["item_of"](entity_id)

    def _drop_entity_parts(self, kind: str, entity_id: str) -> None:
        """删掉一个实体的**全部** part 图元（含外部 part），并清掉视图登记。"""
        eid = str(entity_id).strip()
        if not eid:
            return
        k = str(kind).strip().lower()
        self._entity_view_meta.pop(f"{k}:{eid}", None)
        for part, key in iter_part_keys(k, eid):
            if key is None:
                ad = self._part_adapters.get((k, part))
                if ad is not None and ad["drop"] is not None:
                    ad["drop"](eid)
                continue
            it = self._entity_items.pop(key, None)
            if it is not None and it.scene() is self._gfx:
                self._gfx.removeItem(it)

    def remove_hotspot_graphics(self, entity_id: str) -> None:
        self._drop_entity_parts("hotspot", entity_id)

    def remove_npc_graphics(self, entity_id: str) -> None:
        nid = str(entity_id).strip()
        if not nid:
            return
        # 巡逻折线的删除有自己的防崩溃收尾（先 setSelected(False)），走它自己的出口。
        self.remove_npc_patrol_overlay(nid)
        self._drop_entity_parts("npc", nid)

    def remove_zone_graphics(self, entity_id: str) -> None:
        self._drop_entity_parts("zone", entity_id)

    def remove_spawn_graphics(self, spawn_key: str) -> None:
        self._drop_entity_parts("spawn", spawn_key)

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
        """切换一个实体在画布上的可见性 —— **它的每一个 part 都要跟着**。

        清单来自 `PART_TABLE`，不再手写。这一条是"切时段藏 NPC、人还站着"那个 bug
        的根治点：精灵是 npc 族的一个 part，只要它在表里，就不可能再被漏掉。
        """
        eid = str(entity_id).strip()
        if not eid:
            return
        lk = str(logical_kind).strip().lower()
        for part, key in iter_part_keys(lk, eid):
            if key is None:
                ad = self._part_adapters.get((lk, part))
                if ad is None:
                    continue
                # 有些 part 的显隐不能直接 setVisible（精灵会被 8ms 定时器打回来）
                if ad["set_visible"] is not None:
                    ad["set_visible"](eid, visible)
                    continue
                it = ad["item_of"](eid)
                if it is not None:
                    it.setVisible(visible)
                continue
            it = self._entity_items.get(key)
            if it is not None:
                it.setVisible(visible)

    # ---- 位面 / 时段视图过滤（纯视图，不改数据；与运行时派生基底同口径）----------
    #
    # 三条轴的分工，改这块之前先分清楚（混了就是"切一个视图把另一个的判定冲掉"）：
    #   过场视图 → 决定实体**存不存在**（cutsceneOnly 实体不加载，改它触发场景重载）
    #   位面视图 → 决定已存在的实体**显不显**（planes 白名单）
    #   时段视图 → 同上（phases 白名单）
    # 后两条都是后置显隐，故**必须合成一个判定再落 set_entity_visible**；
    # 运行时那边同理，它们是 getNpcBaseVisibleForInteraction 里串起来的一串 and。

    @staticmethod
    def _norm_id_list(raw: object) -> list[str] | None:
        """实体 planes/phases 归一：非空字符串列表，或 None（缺省=不受该轴限制）。"""
        if not isinstance(raw, list):
            return None
        xs = [str(p).strip() for p in raw if str(p).strip()]
        return xs or None

    # 旧名保留：外部（含测试）按 _norm_planes 调用过
    _norm_planes = _norm_id_list

    def _entity_visible_under_plane_filter(self, planes: list[str] | None) -> bool:
        pf = self._plane_filter
        if pf is None:
            return True
        if planes is None:
            # 缺省实体：shared 位面存在 / exclusive（独立世界型）不存在
            return not self._plane_filter_exclusive
        return pf in planes

    def _entity_visible_under_phase_filter(self, kind: str, phases: list[str] | None) -> bool:
        """时段轴判定。**缺省按实体种类分叉**，这是与位面轴唯一的形状差别：

        - NPC 未写 phases → 只在「街上有人」的段（`_phase_npc_default`，由 game_config
          的 `dayNight.phases[].daylight` 派生）。一段都没标时该列表为空 = 不施加限制，
          与运行时 fail-open 同口径（宁可多显示，绝不静默清空）。
        - 热点 / 区域未写 phases → 全时段都在（门、路牌夜里当然还在）。
        """
        pf = self._phase_filter
        if pf is None:
            return True
        if phases is None:
            if str(kind).strip().lower() != "npc":
                return True
            return (not self._phase_npc_default) or pf in self._phase_npc_default
        return pf in phases

    def _entity_visible_under_view_filters(
        self, kind: str, planes: list[str] | None, phases: list[str] | None,
    ) -> bool:
        return (self._entity_visible_under_plane_filter(planes)
                and self._entity_visible_under_phase_filter(kind, phases))

    def _record_entity_view(self, key: str, ent: object) -> None:
        """add_* 登记实体的位面/时段归属并按当前视图即时套用
        （新图元默认可见，故只需隐藏被过滤掉的）。"""
        d = ent if isinstance(ent, dict) else {}
        planes = self._norm_id_list(d.get("planes"))
        phases = self._norm_id_list(d.get("phases"))
        self._entity_view_meta[key] = (planes, phases)
        kind, _, eid = key.partition(":")
        if not self._entity_visible_under_view_filters(kind, planes, phases):
            self.set_entity_visible(kind, eid, False)

    def set_plane_filter(self, plane_id: str | None, exclusive: bool = False) -> None:
        """设位面视图：None=显示全部；否则只显示归属含该位面的实体。缺省实体按
        exclusive（该位面世界模型是否独立世界型）决定显隐。纯预览，不改数据。"""
        self._plane_filter = (str(plane_id).strip() or None) if plane_id else None
        self._plane_filter_exclusive = bool(exclusive) and self._plane_filter is not None
        self._apply_entity_view_filters()

    def set_phase_filter(
        self, phase_id: str | None, npc_default_phases: list[str] | None = None,
    ) -> None:
        """设时段视图：None=显示全部；否则只显示存在于该时段的实体。

        `npc_default_phases` = 「街上有人」的段（`ProjectModel.daylight_phase_ids()`），
        即未写 phases 的 NPC 的缺省归属。由调用方注入而不在这里读 game_config：
        画布只管画，词表归属是模型的事。
        """
        self._phase_filter = (str(phase_id).strip() or None) if phase_id else None
        if npc_default_phases is not None:
            self._phase_npc_default = [str(p).strip() for p in npc_default_phases if str(p).strip()]
        self._apply_entity_view_filters()

    def _apply_entity_view_filters(self) -> None:
        """按位面 ∧ 时段重贴全部已登记实体。两轴合一次算，不许分开各贴各的。"""
        for key in list(self._entity_view_meta):
            kind, _, eid = key.partition(":")
            self.refresh_entity_presence(kind, eid)

    def refresh_entity_presence(self, kind: str, entity_id: str) -> None:
        """按当前视图轴重贴**单个**实体的显隐。

        任何新建/重建了某个 part 图元的路径都该在末尾调一次 —— 新图元默认可见，
        不重贴就会把过滤结论冲掉（"藏起来的实体刷新一次就冒回来一半"那一族 bug）。
        未登记的实体（如出生点，本来就不吃位面/时段轴）直接跳过，不做任何改动。
        """
        k = str(kind).strip().lower()
        eid = str(entity_id).strip()
        meta = self._entity_view_meta.get(f"{k}:{eid}")
        if meta is None:
            return
        planes, phases = meta
        self.set_entity_visible(
            k, eid, self._entity_visible_under_view_filters(k, planes, phases))

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
            theme.set_graphics_text_font(
                tag,
                theme.FONT_ROLE_CANVAS_SECONDARY,
                family=MONO_FONT_FAMILY,
            )
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

    # ---- 公共查询 / 命令（收口用）--------------------------------------------
    #
    # 这一族存在的理由：此前编辑器、图元类、选择器对话框从**类外**直接摸画布私有成员
    # 约 60 处（`_gfx` / `_entity_items` / `_patrol_overlays` / `_bg_item` /
    # `_zoom_by` / `_auto_fit_after_layout` …）。后果不是"不好看"，是**画布这层没有
    # 边界**：图元清单、显隐、z 都可以被绕过去改，任何新规矩都守不住 —— 这次修的
    # "精灵藏不掉"就是被绕过去的一例。
    #
    # 迁移期私有成员保留不删（新 API 与旧 dict 指向同一份对象），测试可继续内省。

    def entity_item(self, kind: str, entity_id: str, part: str = "handle"):
        """按 ``(kind, id, part)`` 取图元；没有就 ``None``。外部 part 也查得到。"""
        k = str(kind).strip().lower()
        return self._part_item(k, str(entity_id).strip(), part,
                               part_key(k, str(entity_id).strip(), part))

    def entity_item_by_key(self, key: str):
        """按既有 ``"kind:id"`` 形式的键取图元（迁移期兼容用）。"""
        return self._entity_items.get(key)

    def has_entity_item(self, key: str) -> bool:
        return key in self._entity_items

    def world_size(self) -> tuple[float, float]:
        return self._world_w, self._world_h

    def scene_rect_top(self) -> float:
        return self._gfx.sceneRect().top()

    def clear_selection(self) -> None:
        self._gfx.clearSelection()

    def selected_items(self) -> list:
        return list(self._gfx.selectedItems())

    def patrol_overlay(self, npc_id: str):
        return self._patrol_overlays.get(npc_id)

    def patrol_overlay_ids(self) -> list[str]:
        return list(self._patrol_overlays.keys())

    def background_item(self):
        return self._bg_item

    def clear_background(self) -> None:
        """摘掉当前背景图元并清句柄（换背景前调；`load_background` 负责装新的）。"""
        old = self._bg_item
        self._bg_item = None
        if old is not None and old.scene() is self._gfx:
            self._gfx.removeItem(old)

    def zoom_by_step(self, factor: float) -> None:
        """按钮式缩放：**先取消待跑的自动适配**，否则那一拍 fit 会把缩放抹掉。

        这条"顺序"此前散在两个按钮回调里各写一遍（`_auto_fit_after_layout = False`
        紧跟 `_zoom_by`），漏写一处就是"点了放大没反应"。收进来一处。
        """
        self._auto_fit_after_layout = False
        self._zoom_by(factor)

    def refresh_entity_view(self, key: str, ent: object) -> None:
        """重登记某实体的位面/时段归属并全量重贴过滤（含由隐转显）。

        Apply 可能改了 `planes` / `phases`，两步必须成对出现 —— 此前是调用方各自
        手写 `_record_entity_view` + `_apply_entity_view_filters` 两行，成对关系
        全靠自觉。
        """
        self._record_entity_view(key, ent)
        self._apply_entity_view_filters()

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
            QTimer.singleShot(ms, self, lambda t=tok: self._fit_stabilize_step(t))
        QTimer.singleShot(320, self, lambda t=tok: self._end_auto_fit_after_layout(t))

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
        self.sync_group_box_screen_metrics()
        return True

    def sync_group_box_screen_metrics(self) -> None:
        """缩放变化后重算各组框里按屏幕像素定尺的部分。

        标题位置/命中矩形能就地刷；但**框的留白与把手位置也依赖缩放**（留白要
        ≥ 边线带宽、把手要抬出框外），那两样是编辑器从模型派生的，只能请它重算
        ——否则会出现"框按旧缩放算、把手按新缩放算"的错配。
        """
        for item in self._group_boxes.values():
            item.refresh_screen_metrics()
        self.view_scale_changed.emit()

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        if self._auto_fit_after_layout:
            self._perform_fit_all()

    def showEvent(self, event) -> None:
        super().showEvent(event)
        if self._auto_fit_after_layout:
            tok = self._fit_layout_token
            QTimer.singleShot(0, self, lambda t=tok: self._fit_stabilize_step(t))

    def wheelEvent(self, event: QWheelEvent) -> None:
        # 触控板：无修饰双指滚动 = 平移；Ctrl+滚轮 = 缩放（与 map/picker 三处画布统一）。
        if not (event.modifiers() & Qt.KeyboardModifier.ControlModifier):
            d = event.angleDelta()
            if d.x() != 0 or d.y() != 0:
                self.horizontalScrollBar().setValue(
                    self.horizontalScrollBar().value() - d.x())
                self.verticalScrollBar().setValue(
                    self.verticalScrollBar().value() - d.y())
            event.accept()
            return
        self._auto_fit_after_layout = False
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self._zoom_by(factor)

    def _zoom_by(self, factor: float) -> None:
        """缩放并钳制在 0.1~10 倍之间（照 map_editor._ZoomableView），避免缩到天文倍数丢场景。"""
        cur = self.transform().m11()
        new = cur * factor
        if new < 0.1 or new > 10.0:
            return
        self.scale(factor, factor)
        self.sync_group_box_screen_metrics()

    def _vertex_menu_item_at(self, scene_pt: QPointF) -> QGraphicsItem | None:
        """落点是否命中某个可删顶点的折线/多边形顶点（Zone/巡逻/光曲线）。
        命中则右键应交给该 item 弹「删除此顶点」，而非弹「添加实体」。"""
        for it in self._gfx.items(scene_pt):
            if isinstance(it, _EditableZonePolygon):
                if not it._pick_frozen and it._vertex_at_scene(scene_pt) is not None:
                    return it
            elif isinstance(it, (_NpcPatrolPolyline, _LightCurvePolyline)):
                if it._vertex_at_scene(scene_pt) is not None:
                    return it
        return None

    def _group_box_at(self, scene_pt: QPointF) -> "_SceneGroupBox | None":
        """落点是否命中某个分组框的可点区（边线/把手）。"""
        if not self._group_boxes_visible:
            return None
        for it in self._gfx.items(scene_pt):
            if isinstance(it, _SceneGroupBox):
                return it
        return None

    def build_group_context_menu(self, gid: str) -> QMenu:
        """构造分组右键菜单（与 exec 分离：`QMenu.exec` 在 PySide 里打桩不掉，
        离屏跑测试会永久挂在模态循环里——护栏只能测这一半）。"""
        menu = QMenu(self)
        rows = (
            ("选中该组全部成员", self.group_select_members_requested),
            ("把手回到默认位置", self.group_anchor_reset_requested),
            ("删除该分组…", self.group_delete_requested),
        )
        for label, sig in rows:
            act = QAction(label, menu)
            act.triggered.connect(lambda *_, s=sig, g=gid: s.emit(g))
            menu.addAction(act)
        return menu

    def _exec_group_context_menu(self, gid: str, global_pos: QPoint) -> None:
        # 只点亮组框（纯画布操作）：**不**发 group_gesture_finished——那条路会经
        # singleShot 装载属性面板，而 menu.exec() 的模态循环恰好会把它跑起来，
        # 又变成"菜单开着的时候布局在重排"。各菜单动作的槽自己会处理面板。
        self.group_clicked.emit(gid)
        self.build_group_context_menu(gid).exec(global_pos)

    def contextMenuEvent(self, event: QContextMenuEvent) -> None:
        scene_pt = self.mapToScene(event.pos())
        # 命中折线/多边形顶点时：把右键转发给场景，让 item 弹「删除此顶点」并处理；
        # 此前 view 覆写从不调 super，这些承诺的删顶点菜单整体不可达，右键还误弹
        # 「添加实体」甚至误加野实体（审查 P2 ①）。仅空白/非顶点处才弹添加菜单。
        if self._vertex_menu_item_at(scene_pt) is not None:
            super().contextMenuEvent(event)
            return
        # 右键命中分组框（边线/把手）：给分组自己的菜单，而不是"在此添加实体"
        box = self._group_box_at(scene_pt)
        if box is not None:
            self._exec_group_context_menu(box.gid, event.globalPos())
            event.accept()
            return
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
        # 统一光影的「在画布上定位」模式：拦在最前面，先落灯再说，
        # 免得点击被下面的实体选中/框选逻辑吃掉。
        if getattr(self, '_light_place_mode', False) and event.button() == Qt.MouseButton.LeftButton:
            sp = self.mapToScene(event.position().toPoint())
            self.light_place_requested.emit(float(sp.x()), float(sp.y()))
            event.accept()
            return
        if event.button() == Qt.MouseButton.MiddleButton:
            self._middle_panning = True
            self._pan_last_pos = event.pos()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            event.accept()
            return
        if event.button() == Qt.MouseButton.LeftButton and (
            event.modifiers() & Qt.KeyboardModifier.ControlModifier
        ):
            # Ctrl+点选 = Qt 原生加选/减选（多选路径）；叠放循环点选与 z 抬升
            # 会与 toggle 语义互相打架，Ctrl 按下时整段跳过。
            self._restore_pick_z_order()
            self._pick_cycle_key = None
        elif event.button() == Qt.MouseButton.LeftButton:
            self._restore_pick_z_order()
            sp = self.mapToScene(event.pos())
            stack = self._entity_stack_at(sp)
            if len(stack) < 2:
                self._pick_cycle_key = None
            else:
                # 叠放循环点选的「同一落点」判定用视口像素 + 容差：世界坐标 round(0.1)
                # 在 fit 缩放下 1 屏幕像素≈数世界单位，鼠标 1px 抖动即被判为新落点、
                # 循环重置（审查 P2 ⑥）。像素容差保留「按下移动一点不重置」语义。
                vp = event.pos()
                prev = self._pick_cycle_key
                same_spot = (
                    prev is not None
                    and abs(vp.x() - prev[0]) <= _PICK_CYCLE_PX_TOL
                    and abs(vp.y() - prev[1]) <= _PICK_CYCLE_PX_TOL
                )
                key = (vp.x(), vp.y())
                sel = self._gfx.selectedItems()
                sel0 = sel[0] if sel else None
                if not same_spot:
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
                # 抬到全画布之上的固定值（原先是 z_top+1，栈内相对值）。装饰品区间
                # 顶到 90 万，内容区间在 ±10 万，1_000_000 恒在两者之上，语义等价且
                # 不依赖栈内当前 z —— 内容 z 现在会随实体移动实时重排。
                target.setZValue(_Z_PICK_RAISED)
        super().mousePressEvent(event)
        if event.button() == Qt.MouseButton.LeftButton:
            # 快照当前选中图元位置，供 release 判定「是否真的移动过」。
            self._press_item_pos = {}
            for it in self._gfx.selectedItems():
                if hasattr(it, "entity_kind") and hasattr(it, "entity_id"):
                    p = it.pos()
                    self._press_item_pos[id(it)] = (p.x(), p.y())
            if self._press_item_pos:
                self.item_drag_press.emit()

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

    def keyPressEvent(self, event) -> None:
        # 拖拽中按 Esc 取消：把被抓取实体恢复到按下前坐标，且不写模型/不标脏（审查 P3）。
        # 仅覆盖可移动实体图元（hotspot/npc/spawn 圆点）；折线/多边形顶点拖拽自有内部处理。
        # Esc 取消 gizmo 手势：复位到按下时的 scale/rot（经 live 信号回滚 staging/预览）
        # 并吞掉 release——否则手势继续、release 照常提交（审查 P1-C）。
        if (
            event.key() == Qt.Key.Key_Escape
            and self._transform_gizmo is not None
            and self._transform_gizmo.gesture_active()
        ):
            self._transform_gizmo.cancel_gesture()
            self._drag_cancelled = True
            self._press_item_pos = {}
            event.accept()
            return
        # Esc 取消整组拖动：组框把累计 Δ 原路退回（成员坐标 + 框位置），同 gizmo 语义
        gesture_box = self.active_group_gesture()
        if event.key() == Qt.Key.Key_Escape and gesture_box is not None:
            gesture_box.cancel_gesture()
            self._drag_cancelled = True
            self._press_item_pos = {}
            event.accept()
            return
        # 选中分组时方向键微移（Shift = ×10）；组不进 Qt 选择系统，故在此单点处理
        if (
            self._selected_group
            and self._selected_group in self._group_boxes
            and self._group_boxes_visible
            and event.key() in (
                Qt.Key.Key_Left, Qt.Key.Key_Right, Qt.Key.Key_Up, Qt.Key.Key_Down,
            )
        ):
            step = 10.0 if (event.modifiers() & Qt.KeyboardModifier.ShiftModifier) else 1.0
            dx, dy = {
                Qt.Key.Key_Left: (-step, 0.0), Qt.Key.Key_Right: (step, 0.0),
                Qt.Key.Key_Up: (0.0, -step), Qt.Key.Key_Down: (0.0, step),
            }[event.key()]
            # autoRepeat（按住不放）合并进同一条撤销命令：一秒 30 次按键 = 30 条
            # 命令的话，用户要按 30 次 Ctrl+Z 才退得回去。
            self.group_nudge.emit(
                self._selected_group, dx, dy, bool(event.isAutoRepeat()))
            event.accept()
            return
        if event.key() == Qt.Key.Key_Escape and self._press_item_pos:
            flag = QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges
            for it in list(self._gfx.selectedItems()):
                snap = self._press_item_pos.get(id(it))
                if snap is None or not hasattr(it, "entity_kind"):
                    continue
                had = bool(it.flags() & flag)
                if had:
                    it.setFlag(flag, False)
                try:
                    it.setPos(snap[0], snap[1])
                finally:
                    if had:
                        it.setFlag(flag, True)
                self.drag_cancelled.emit(
                    it.entity_kind, it.entity_id, float(snap[0]), float(snap[1]))
            self._press_item_pos = {}
            self._drag_cancelled = True
            self._restore_pick_z_order()
            event.accept()
            return
        super().keyPressEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.MiddleButton:
            if self._middle_panning:
                self._middle_panning = False
                self.unsetCursor()
            event.accept()
            return
        super().mouseReleaseEvent(event)
        self._restore_pick_z_order()
        if self._group_press_active:
            # 本次手势是操作分组框（选中/整组拖动/挪把手）：组框自己已提交，
            # 这里不能再走实体选中派发，否则会顶掉分组属性面板。
            self._group_press_active = False
            self._drag_cancelled = False
            self._press_item_pos = {}
            return
        if self._drag_cancelled:
            # 本次拖拽已被 Esc 取消：吞掉 release，不发 item_moved（否则把恢复位当新位写回）。
            self._drag_cancelled = False
            self._press_item_pos = {}
            return
        press_pos = self._press_item_pos
        self._press_item_pos = {}
        sel = self._gfx.selectedItems()
        # 多选整体拖动：统计所有真实位移过的可移动实体图元。zone / 碰撞多边形的
        # 平移走各自 polygon 提交信号，不进坐标批量；零位移不算（防伪脏同族）。
        moved_batch: list[tuple[str, str, float, float]] = []
        if self._single_gesture_only:
            sel = sel[:1]
        for m_it in sel:
            if not (hasattr(m_it, "entity_kind") and hasattr(m_it, "entity_id")):
                continue
            if m_it.entity_kind in (
                "zone", "hotspot_collision", "npc_collision", "group",
            ):
                continue
            m_p0 = press_pos.get(id(m_it))
            m_cur = (m_it.pos().x(), m_it.pos().y())
            if m_p0 is not None and m_p0 != m_cur:
                moved_batch.append(
                    (m_it.entity_kind, str(m_it.entity_id), m_cur[0], m_cur[1]))
        if len(moved_batch) >= 2:
            self.items_batch_moved.emit(moved_batch)
            it0 = sel[0]
            if hasattr(it0, "entity_kind") and hasattr(it0, "entity_id"):
                self.item_selected.emit(it0.entity_kind, it0.entity_id)
            return
        if sel:
            it = sel[0]
            if hasattr(it, "entity_kind") and hasattr(it, "entity_id"):
                # Commit world position to scene data first, then reload the
                # property panel. If item_selected runs before item_moved, the
                # spin boxes are filled with stale x/y and stay wrong until the
                # next gesture.
                # 纯点选（release 位置 == press 位置）不发 item_moved：否则「点一下看
                # 属性」就写坐标+标脏，且 int 坐标漂成 float（审查 P1-09）。
                emit_move = it.entity_kind not in (
                    "zone", "hotspot_collision", "npc_collision", "group",
                )
                if emit_move:
                    p0 = press_pos.get(id(it))
                    cur = (it.pos().x(), it.pos().y())
                    if p0 is not None and p0 == cur:
                        emit_move = False
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
        *,
        empty_label: str = "默认（spawnPoint）",
        empty_hint: str = "“默认”对应该场景 JSON 的 spawnPoint；其余对应 spawnPoints 中的键。",
    ) -> None:
        # empty_label/empty_hint：空键（""）在不同调用方语义不同——switchScene 一定要落人，
        # 空 = 场景默认出生点；过场则可以不挪人（同场景就地开演）。文案由调用方给，别写死。
        super().__init__(parent)
        self._model = model
        self._scene_id = target_scene_id
        self._empty_label = empty_label
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
        hint = QLabel(f"{empty_hint}\n拖拽图钉会立刻写回该场景数据。")
        hint.setWordWrap(True)
        left.addWidget(hint)

        self._canvas = SceneCanvas()
        # 本对话框只消费单实体 item_moved：恢复 NoDrag 单手势，避免框选组拖走
        # 无人消费的批量信号（画布动、数据不写；审查 P2-B）。
        self._canvas.set_single_gesture_only()
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
        _fit_btn = bbox.addButton("适配", QDialogButtonBox.ButtonRole.ActionRole)
        _fit_btn.setToolTip("把整张场景适配回视口（缩放到全览）")
        _fit_btn.clicked.connect(lambda: self._canvas.fit_all())
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
        def_it = QListWidgetItem(self._empty_label)
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
        item = self._canvas.entity_item_by_key(f"spawn:{eid}")
        if item is None:
            return
        self._canvas.clear_selection()
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
        # 去所有权化:拖点只更新坐标,出生点 dict 里 AI 写的未知键透传保留。
        from ..shared.rebuild_merge import merge_preserving_unknown
        if eid == "default":
            sc["spawnPoint"] = merge_preserving_unknown(
                sc.get("spawnPoint"), {"x": rx, "y": ry}, {"x", "y"})
        else:
            sps = sc.setdefault("spawnPoints", {})
            sps[eid] = merge_preserving_unknown(
                sps.get(eid), {"x": rx, "y": ry}, {"x", "y"})
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
        self._coord_lbl.setStyleSheet(f"font-family: {MONO_FONT_FAMILY};")
        theme.set_editor_font_role(self._coord_lbl, theme.FONT_ROLE_SECONDARY)
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
        _fit_btn = bbox.addButton("适配", QDialogButtonBox.ButtonRole.ActionRole)
        _fit_btn.setToolTip("把整张地图适配回视口（缩放到全览）")
        _fit_btn.clicked.connect(lambda: self._view.fit_scene())
        root.addWidget(bbox)

        self._view.setup_from_scene_json(model, scene_id)
        self._view.set_marker_world(self._px, self._py)
        self._sync_lbl()
        QTimer.singleShot(0, self._view, self._view.fit_scene)

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
        self._coord_lbl.setStyleSheet(f"font-family: {MONO_FONT_FAMILY};")
        theme.set_editor_font_role(self._coord_lbl, theme.FONT_ROLE_SECONDARY)
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
        _fit_btn = bbox.addButton("适配", QDialogButtonBox.ButtonRole.ActionRole)
        _fit_btn.setToolTip("把整张地图适配回视口（缩放到全览）")
        _fit_btn.clicked.connect(lambda: self._view.fit_scene())
        root.addWidget(bbox)

        self._view.setup_from_scene_json(model, scene_id)
        self._view.set_marker_world(self._px, self._py)
        self._sync_lbl()
        QTimer.singleShot(0, self._view, self._view.fit_scene)

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
    # picker 类对话框对（可能是其它场景的）模型做了未命令化直写后发出：
    # SceneEditor 借此让撤销栈对该场景做穿越防护（清栈；审查 P1-A）。
    scene_directly_written = Signal(str)
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
    # 透视缩放配置 live 预览：携带按当前 UI 生成的 cfg dict（未启用为 None）
    perspective_preview_changed = Signal(object)
    # 统一光影：「在画布上定位灯」开关
    light_place_mode_changed = Signal(bool)
    # 光环境曲线数据变化→请求画布重建 overlay
    lightcurve_overlay_refresh_requested = Signal()
    # npc_id, enabled — 仅编辑器内沿路径预览精灵
    npc_patrol_preview_changed = Signal(str, bool)
    # 当前面板存在未 Apply 的 staging 修改（True）或已与 source 一致（False）
    pending_dirty_changed = Signal(bool)
    # 背景图已导入/更换（已落盘 + 写入场景数据）→ 请求画布重载背景
    scene_background_changed = Signal()
    # 分组成员列表双击：由 SceneEditor 负责在实体树/画布中导航。
    group_member_activated = Signal(str, str)
    # 分组面板 →（gid, dx, dy）精确整组位移；与画布拖组框同一条写入通道
    group_translate_requested = Signal(str, float, float)
    # 分组面板 → gid：在画布/树上选中该组全部成员
    group_select_members_requested = Signal(str)
    # 分组面板 → gid：清除自定义把手（editor.anchor）
    group_anchor_reset_requested = Signal(str)

    def reload_refs_from_model(self) -> None:
        """重拉跨域引用候选(filter/item/encounter/bgm/animFile/立绘,均为别处可新增的全局列表),
        保留各选择器当前选中值。供切页激活时调用。

        animFile 的候选面还要**先把磁盘上新出现的动画包补进内存**:产线刚发布一批包时,
        编辑器不重启也得能在这里选到它们(2026-08-06:静态占位包批量上线时发现这条断着,
        新包只有整个重开工程才看得见)。只加不改,不会冲掉动画面板未保存的编辑。
        """
        self._model.discover_new_animation_bundles()
        for attr, provider in (
            ("_sc_filter", self._model.all_filter_ids),
            ("_hs_pickup_item", self._model.all_item_ids),
            ("_hs_enc_id", self._model.all_encounter_ids),
            ("_sc_bgm", lambda: [(a, a) for a in self._model.all_audio_ids("bgm")]),
            ("_npc_anim", self._model.anim_asset_path_choices),
            ("_npc_portrait", lambda: [
                (s, s) for s in load_portrait_sets(self._model.project_path)
            ] if self._model.project_path is not None else []),
        ):
            sel = getattr(self, attr, None)
            if isinstance(sel, (IdRefSelector, AudioIdPreviewSelector)):
                sel.set_items(provider())
        for attr in (
            "_npc_dialogue_graph",
            "_npc_dialogue_graph_entry",
            "_hs_inspect_graph_combo",
            "_hs_inspect_entry",
        ):
            picker = getattr(self, attr, None)
            if isinstance(picker, ReferencePickerField):
                picker.refresh_display()
        for attr in (
            "_sc_on_enter",
            "_hs_inspect_actions",
            "_zn_enter",
            "_zn_stay",
            "_zn_exit",
            "_zn_interact",
        ):
            editor = getattr(self, attr, None)
            reload_refs = getattr(editor, "reload_refs_from_model", None)
            if callable(reload_refs):
                reload_refs()

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

        # 多选页：显示选中数量 + 批量操作条（字段级批量编辑首期不做，设计拍板）。
        self._multi_panel = QWidget()
        _ml = QVBoxLayout(self._multi_panel)
        _ml.setContentsMargins(12, 16, 12, 12)
        _ml.setSpacing(8)
        self._multi_label = QLabel("已选 0 个实体")
        self._multi_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        _ml.addWidget(self._multi_label)
        _mrow = QHBoxLayout()
        self._multi_group_btn = QPushButton("指派分组…")
        self._multi_group_btn.setToolTip(
            "给全部选中实体指派同一分组（group 标签；留空可移出分组）。")
        self._multi_dup_btn = QPushButton("复制")
        self._multi_dup_btn.setToolTip("在本场景为每个选中实体各复制一个副本（Ctrl+D）。")
        self._multi_del_btn = QPushButton("删除")
        self._multi_del_btn.setToolTip("删除全部选中实体（Delete；可 Ctrl+Z 撤销）。")
        for _b in (self._multi_group_btn, self._multi_dup_btn, self._multi_del_btn):
            _mrow.addWidget(_b)
        _ml.addLayout(_mrow)
        _mhint = QLabel("整体拖动：直接拖任一选中实体。\nCtrl+点选加减选；空白处拖框选。")
        _mhint.setWordWrap(True)
        _mhint.setStyleSheet("color: #888;")
        _ml.addWidget(_mhint)
        _ml.addStretch(1)
        self._stack.addWidget(self._multi_panel)

        self._scene_panel = self._build_scene_panel()
        self._stack.addWidget(self._scene_panel)

        self._hotspot_panel = self._build_hotspot_panel()
        self._stack.addWidget(self._hotspot_panel)

        self._npc_panel = self._build_npc_panel()
        self._stack.addWidget(self._npc_panel)

        self._zone_panel = self._build_zone_panel()
        self._stack.addWidget(self._zone_panel)

        self._group_panel = self._build_group_panel()
        self._stack.addWidget(self._group_panel)

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
        self._source_group: dict | None = None
        self._staging_group: dict | None = None
        self._pending_group: dict | None = None
        self._group_scene: dict | None = None
        self._group_original_id: str = ""
        self._group_pending_changed: bool = False
        self._group_commit_blocked: bool = False
        self._source_scene: dict | None = None
        self._staging_scene: dict | None = None
        self._hs_cutscene_ids_pending: list[str] = []
        self._npc_cutscene_ids_pending: list[str] = []
        # 位面归属（planes；缺省=存在于所有位面）：与 cutsceneIds 同款 pending 列表
        self._hs_plane_ids_pending: list[str] = []
        self._npc_plane_ids_pending: list[str] = []
        self._zn_plane_ids_pending: list[str] = []
        # 时段归属（phases；缺省=所有时段都在）：与 planes 同款 pending 列表
        self._hs_phase_ids_pending: list[str] = []
        self._npc_phase_ids_pending: list[str] = []
        self._zn_phase_ids_pending: list[str] = []
        self._spawn_flush_scene: dict | None = None
        self._editing_scene_id: str = ""
        self._zn_poly_updating: bool = False
        self._npc_patrol_table_updating: bool = False
        self._npc_col_updating: bool = False
        # 光环境曲线：单一真相源(每项 {x,y,env})，表格只读展示 x/y，env 走逐帧编辑器
        self._sc_lightcurve_points: list[dict] = []
        # 统一光影：灯位
        self._sc_lighting: dict | None = None
        self._sl_selected: int = -1
        self._sl_updating: bool = False
        self._sl_placing: bool = False
        self._sl_space = None
        self._lc_selected: int = -1
        self._lc_table_updating: bool = False
        self._props_changed_suppressed: int = 0
        self._emit_changed_signal = self.changed.emit
        # auto-discard 语义下的"未应用 staging"标记：任何用户编辑路径置 True，
        # _apply_props 完成 / load_*_props 切换实体后置 False；驱动 toolbar 红色提示。
        self._pending_dirty: bool = False

    def _show_panel(self, panel: QWidget) -> None:
        """切换属性页时回到页首。

        QScrollArea 只有一根滚动条，QStackedWidget 各页若直接 setCurrentWidget 会共享上一页
        的 scroll value；长 NPC 页切到 Zone 时因此会从「动作」区开场，误以为基本属性消失。
        """
        self._stack.setCurrentWidget(panel)
        self.verticalScrollBar().setValue(0)

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

    def revert_entity_id(self, kind: str, original: str) -> None:
        """撞名闸拒绝改名后回滚：staging 与可见输入框一起退回原 id。

        只回滚 id 一个字段——本轮其它编辑照常提交，不能因为一个 id 冲突把整批编辑卡掉。
        """
        staging = {
            "hotspot": self._staging_hotspot,
            "npc": self._staging_npc,
            "zone": self._staging_zone,
        }.get(kind)
        if isinstance(staging, dict):
            staging["id"] = original
        edit = {
            "hotspot": self._hs_id,
            "npc": self._npc_id,
            "zone": self._zn_id,
        }.get(kind)
        if edit is not None:
            edit.blockSignals(True)
            try:
                edit.setText(original)
            finally:
                edit.blockSignals(False)

    def entity_staging_pairs(self) -> tuple[tuple[str, dict | None, dict | None], ...]:
        """(kind, source, staging) 三元组，供提交前的 id 撞名闸遍历。"""
        return (
            ("hotspot", self._source_hotspot, self._staging_hotspot),
            ("npc", self._source_npc, self._staging_npc),
            ("zone", self._source_zone, self._staging_zone),
        )

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
        """场景 staging 同样 rebind；实体列表与 entityGroups 仍共享 model 引用。"""
        self._source_scene = sc
        st = copy.deepcopy(sc)
        for lk in ("hotspots", "npcs", "zones", "entityGroups"):
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

    # ---- 出口锚点（日夜块）----
    # 编辑落在工作副本 self._exit_anchors 上，随 props 的 pending/Apply 一起提交，
    # 与场景其它属性同一条路径——不即时改 model，避免"改了没 Apply 却已落盘"。

    def _exit_anchor_row_text(self, a: dict) -> str:
        kind = str(a.get("kind") or "").strip()
        tail = f"  [{kind}]" if kind else ""
        return f"{a.get('id', '(未命名)')}  ({a.get('x', 0):g}, {a.get('y', 0):g}){tail}"

    def _reload_exit_anchor_list(self) -> None:
        self._sc_exit_list.blockSignals(True)
        try:
            self._sc_exit_list.clear()
            for a in self._exit_anchors:
                self._sc_exit_list.addItem(self._exit_anchor_row_text(a))
        finally:
            self._sc_exit_list.blockSignals(False)
        self._exit_anchor_idx = -1
        if self._sc_exit_list.count():
            self._sc_exit_list.setCurrentRow(0)
        else:
            self._set_exit_anchor_form_enabled(False)

    def _set_exit_anchor_form_enabled(self, on: bool) -> None:
        for w in (self._sc_exit_id, self._sc_exit_x, self._sc_exit_y, self._sc_exit_kind):
            w.setEnabled(on)

    def _on_exit_anchor_select(self, row: int) -> None:
        if row < 0 or row >= len(self._exit_anchors):
            self._exit_anchor_idx = -1
            self._set_exit_anchor_form_enabled(False)
            return
        self._exit_anchor_idx = row
        a = self._exit_anchors[row]
        self._loading_exit_anchor = True
        try:
            self._set_exit_anchor_form_enabled(True)
            self._sc_exit_id.setText(str(a.get("id", "") or ""))
            self._sc_exit_x.setValue(float(a.get("x", 0) or 0))
            self._sc_exit_y.setValue(float(a.get("y", 0) or 0))
            idx = self._sc_exit_kind.findData(str(a.get("kind") or ""))
            self._sc_exit_kind.setCurrentIndex(idx if idx >= 0 else 0)
        finally:
            self._loading_exit_anchor = False

    def _on_exit_anchor_field_changed(self, *_args) -> None:
        if getattr(self, "_loading_exit_anchor", False):
            return
        i = self._exit_anchor_idx
        if i < 0 or i >= len(self._exit_anchors):
            return
        a = self._exit_anchors[i]
        a["id"] = self._sc_exit_id.text().strip()
        a["x"] = self._keep_num(self._sc_exit_x.value(), a.get("x"))
        a["y"] = self._keep_num(self._sc_exit_y.value(), a.get("y"))
        kind = str(self._sc_exit_kind.currentData() or "")
        if kind:
            a["kind"] = kind
        else:
            a.pop("kind", None)
        item = self._sc_exit_list.item(i)
        if item is not None:
            item.setText(self._exit_anchor_row_text(a))
        self._emit_props_changed()

    def _add_exit_anchor(self) -> None:
        self._exit_anchors.append({"id": f"出口{len(self._exit_anchors) + 1}", "x": 0.0, "y": 0.0})
        self._reload_exit_anchor_list()
        self._sc_exit_list.setCurrentRow(len(self._exit_anchors) - 1)
        self._emit_props_changed()

    def _delete_exit_anchor(self) -> None:
        i = self._exit_anchor_idx
        if i < 0 or i >= len(self._exit_anchors):
            return
        del self._exit_anchors[i]
        self._reload_exit_anchor_list()
        self._emit_props_changed()

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
        """列表只装**本场景实际用的** id，按编排顺序。

        旧写法是把整个 ambient 目录铺成 110px 的勾选框列表 + 一个逗号串输入框：
        候选越多越难用，两个输入面还得让人猜该填哪个；而且保存时按目录字母序
        回写，作者写的顺序会被静默重排（当前数据恰好都已是字母序，没爆出来）。
        """
        lst = self._sc_ambient_list
        lst.blockSignals(True)
        lst.clear()
        for aid in ambient_ids:
            lst.addItem(self._make_ambient_item(aid))
        lst.blockSignals(False)
        self._sync_ambient_buttons()

    def _make_ambient_item(self, aid: str) -> QListWidgetItem:
        it = QListWidgetItem()
        it.setData(Qt.ItemDataRole.UserRole, aid)
        self._decorate_ambient_item(it)
        return it

    def _decorate_ambient_item(self, it: QListWidgetItem) -> None:
        """行文本直接把「多长 / 在不在」写出来——以前只在 tooltip 里，得逐条悬停才知道。"""
        aid = str(it.data(Qt.ItemDataRole.UserRole) or "")
        path = audio_config_file_for_id(self._model, "ambient", aid)
        if path is None:
            it.setText(f"⚠ {aid}   找不到音频文件")
            it.setToolTip(f"{aid}\n⚠ 找不到音频文件，运行时这层是静音的")
            return
        cache = getattr(self, "_ambient_meta", None)
        duration = cache.duration(path) if cache is not None else None
        it.setText(f"{aid}   {format_duration(duration)}")
        it.setToolTip(f"{aid}\n{path.name}\n时长 {format_duration(duration)}\n（双击试听）")

    def _refresh_ambient_tooltips(self) -> None:
        """后台时长探测出结果后回填显示（只改文本/提示，不动条目与顺序）。"""
        lst = getattr(self, "_sc_ambient_list", None)
        if lst is None:
            return
        lst.blockSignals(True)
        for i in range(lst.count()):
            item = lst.item(i)
            if item is not None:
                self._decorate_ambient_item(item)
        lst.blockSignals(False)

    def _ambient_ids_from_widgets(self) -> list[str]:
        lst = self._sc_ambient_list
        seen: set[str] = set()
        out: list[str] = []
        for i in range(lst.count()):
            it = lst.item(i)
            aid = str(it.data(Qt.ItemDataRole.UserRole) or "").strip() if it else ""
            if aid and aid not in seen:
                seen.add(aid)
                out.append(aid)
        return out

    def _current_ambient_preview_id(self) -> str:
        it = self._sc_ambient_list.currentItem()
        if it is None:
            return ""
        return str(it.data(Qt.ItemDataRole.UserRole) or "").strip()

    def _sync_ambient_buttons(self) -> None:
        lst = self._sc_ambient_list
        row = lst.currentRow()
        has = row >= 0
        self._amb_btn_del.setEnabled(has)
        self._amb_btn_up.setEnabled(has and row > 0)
        self._amb_btn_down.setEnabled(has and row < lst.count() - 1)

    def _add_ambient(self) -> None:
        """走统一的弹窗选择器（可搜索、可试听、能看时长与缺失状态）。"""
        from ..shared.audio_picker_dialog import AudioPickerDialog

        used = set(self._ambient_ids_from_widgets())
        rows = [(a, a) for a in self._model.all_audio_ids("ambient") if a not in used]
        dlg = AudioPickerDialog(
            self._model, "ambient", rows,
            current="", allow_empty=False, parent=self,
            cache=getattr(self, "_ambient_meta", None),
            title="添加环境音（可搜索、可试听）",
            allow_manual_id=True,      # 目录外的 id 也能加，不必再手打逗号串
        )
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        aid = (dlg.selected_value() or "").strip()
        if not aid:
            return
        if aid in used:
            QMessageBox.information(self, "环境音", f"「{aid}」已经在列表里了。")
            return
        self._sc_ambient_list.addItem(self._make_ambient_item(aid))
        self._sc_ambient_list.setCurrentRow(self._sc_ambient_list.count() - 1)
        self._sync_ambient_buttons()
        self._emit_props_changed()

    def _remove_ambient(self) -> None:
        row = self._sc_ambient_list.currentRow()
        if row < 0:
            return
        self._sc_ambient_list.takeItem(row)
        self._sync_ambient_buttons()
        self._emit_props_changed()

    def _move_ambient(self, delta: int) -> None:
        lst = self._sc_ambient_list
        row = lst.currentRow()
        new = row + delta
        if row < 0 or new < 0 or new >= lst.count():
            return
        it = lst.takeItem(row)
        lst.insertItem(new, it)
        lst.setCurrentRow(new)
        self._sync_ambient_buttons()
        self._emit_props_changed()

    def show_empty(self) -> None:
        self._show_panel(self._empty)

    def show_multi_selection(self, count: int) -> None:
        """画布/树多选（≥2 实体）时的右侧状态页；不装载任何单实体表单。
        调用方（SceneEditor）负责先把未应用编辑提交为撤销命令。"""
        self._multi_label.setText(f"已选 {int(count)} 个实体")
        self._show_panel(self._multi_panel)

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

        # ---- 日夜与出口（重块默认折叠：多数场景不参与日夜） ----
        dn_g = self._section("日夜与出口", start_open=False)
        dn_inner = QWidget()
        dn_lay = QVBoxLayout(dn_inner)
        self._sc_daynight = QCheckBox("本场景参与日夜循环")
        self._sc_daynight.setToolTip(
            "不勾＝本场景没有昼夜之分，NPC 也不受日程/时段归属管（旧场景保持原样）。\n"
            "勾上后：时段变化会发出事件，配了日程或时段归属的 NPC 按时段来去。\n"
            "夜里画面长什么样不由这个开关决定——实时算光或另换一张夜景图都行，两者都不配也合法。",
        )
        self._sc_daynight.toggled.connect(lambda _v: self._emit_props_changed())
        dn_lay.addWidget(self._sc_daynight)
        exit_hint = QLabel(
            "出口锚点＝NPC 走到这里才隐去（反过来入场从这里走进来）。\n"
            "一个都不配也不会「当面消失」——那时自动走到场景边界外，只是不够好看。",
        )
        exit_hint.setWordWrap(True)
        exit_hint.setStyleSheet("color:#888;")
        dn_lay.addWidget(exit_hint)
        ex_btns = QHBoxLayout()
        ex_add = QPushButton("+ 出口")
        ex_add.clicked.connect(self._add_exit_anchor)
        ex_del = QPushButton("删除出口")
        ex_del.clicked.connect(self._delete_exit_anchor)
        ex_btns.addWidget(ex_add)
        ex_btns.addWidget(ex_del)
        ex_btns.addStretch(1)
        dn_lay.addLayout(ex_btns)
        self._sc_exit_list = QListWidget()
        self._sc_exit_list.setMaximumHeight(120)
        self._sc_exit_list.currentRowChanged.connect(self._on_exit_anchor_select)
        dn_lay.addWidget(self._sc_exit_list)
        ex_form = compact_form(QFormLayout())
        self._sc_exit_id = QLineEdit()
        self._sc_exit_id.setMaximumWidth(180)
        self._sc_exit_id.setToolTip("出口名（本场景内唯一），日程表的「优先出口」按名引用。")
        self._sc_exit_id.textEdited.connect(self._on_exit_anchor_field_changed)
        ex_form.addRow("id", self._sc_exit_id)
        self._sc_exit_x = QDoubleSpinBox()
        self._sc_exit_x.setRange(-100000, 100000)
        self._sc_exit_x.setMaximumWidth(110)
        self._sc_exit_x.valueChanged.connect(self._on_exit_anchor_field_changed)
        self._sc_exit_y = QDoubleSpinBox()
        self._sc_exit_y.setRange(-100000, 100000)
        self._sc_exit_y.setMaximumWidth(110)
        self._sc_exit_y.valueChanged.connect(self._on_exit_anchor_field_changed)
        xy_row = QWidget()
        xy_lay = QHBoxLayout(xy_row)
        xy_lay.setContentsMargins(0, 0, 0, 0)
        xy_lay.addWidget(QLabel("x"))
        xy_lay.addWidget(self._sc_exit_x)
        xy_lay.addWidget(QLabel("y"))
        xy_lay.addWidget(self._sc_exit_y)
        xy_lay.addStretch(1)
        ex_form.addRow("坐标", xy_row)
        self._sc_exit_kind = QComboBox()
        self._sc_exit_kind.setMaximumWidth(140)
        for _lab, _val in (("（不分类）", ""), ("门", "door"), ("街口", "street"), ("其它", "other")):
            self._sc_exit_kind.addItem(_lab, _val)
        self._sc_exit_kind.setToolTip("只给编辑器分类用，运行时不据此改行为。")
        self._sc_exit_kind.currentIndexChanged.connect(self._on_exit_anchor_field_changed)
        ex_form.addRow("类型", self._sc_exit_kind)
        ex_host = QWidget()
        ex_host.setLayout(ex_form)
        dn_lay.addWidget(ex_host)
        dn_g.add_body(dn_inner)
        outer.addWidget(dn_g)

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
            "默认折叠；与「角色照明实验室」导出一致，此处仅微调 tolerance / floor_offset",
        )
        depth_inner = QWidget()
        depth_form = compact_form(QFormLayout(depth_inner))
        self._sc_depth_tol = QDoubleSpinBox()
        self._sc_depth_tol.setRange(-50.0, 50.0)
        self._sc_depth_tol.setDecimals(4)
        self._sc_depth_tol.setSingleStep(0.05)
        self._sc_depth_tol.setToolTip(
            "depth_tolerance：精灵与场景深度比较时的容差（标定深度空间），对应实验室「深度容差」。",
        )
        depth_form.addRow("depth_tolerance", self._sc_depth_tol)
        self._sc_floor_offset = QDoubleSpinBox()
        self._sc_floor_offset.setRange(-50.0, 50.0)
        self._sc_floor_offset.setDecimals(4)
        self._sc_floor_offset.setSingleStep(0.05)
        self._sc_floor_offset.setToolTip(
            "floor_offset：脚底深度衬底偏移（标定深度空间），对应实验室「地板偏移」。",
        )
        depth_form.addRow("floor_offset", self._sc_floor_offset)
        self._sc_depth_hint = QLabel()
        self._sc_depth_hint.setWordWrap(True)
        depth_form.addRow(self._sc_depth_hint)
        self._sc_depth_tol.valueChanged.connect(self._on_depth_fields_changed)
        self._sc_floor_offset.valueChanged.connect(self._on_depth_fields_changed)
        depth_box.add_body(depth_inner)
        outer.addWidget(depth_box)

        self._persp_box = CollapsibleSection("透视缩放 perspectiveScale（近大远小）", start_open=False)
        self._persp_box.set_header_tool_tip(
            "画一根深度轴箭头（近端大→远端小，可斜任意方向贴合斜街）；实体按脚底点在轴上"
            "的投影缩放。缺省不启用=完全不缩放。玩家/NPC 默认参与（renderRaw 抠图实体除外），"
            "热点需逐个开启。",
        )
        persp_inner = QWidget()
        persp_lay = QVBoxLayout(persp_inner)
        persp_lay.setContentsMargins(0, 0, 0, 0)
        persp_lay.setSpacing(4)
        self._sc_persp_enable = QCheckBox("启用透视缩放")
        self._sc_persp_enable.setToolTip(
            "开启后按深度轴求系数；首次开启会在画布中央生成一根竖直轴，"
            "拖两端手柄改方向/位置。关闭并 Apply 会从场景 JSON 删除 perspectiveScale。",
        )
        self._sc_persp_enable.stateChanged.connect(lambda _s: self._on_persp_widgets_changed())
        persp_lay.addWidget(self._sc_persp_enable)
        self._sc_persp_axis_hint = QLabel("在画布拖动橙色箭头两端设置深度轴（近端■大 / 远端○小）")
        self._sc_persp_axis_hint.setWordWrap(True)
        self._sc_persp_axis_hint.setStyleSheet("color:#c89050;")
        persp_lay.addWidget(self._sc_persp_axis_hint)
        persp_scale_row = compact_form(QFormLayout())
        self._sc_persp_near_scale = QDoubleSpinBox()
        self._sc_persp_near_scale.setRange(0.01, 20.0)
        self._sc_persp_near_scale.setDecimals(3)
        self._sc_persp_near_scale.setSingleStep(0.05)
        self._sc_persp_near_scale.setValue(1.0)
        self._sc_persp_near_scale.setMaximumWidth(110)
        self._sc_persp_near_scale.setToolTip("近端（箭头尾■）缩放系数，通常 1.0（离镜头最近最大）。")
        self._sc_persp_near_scale.valueChanged.connect(lambda _v: self._on_persp_widgets_changed())
        persp_scale_row.addRow("近端缩放", self._sc_persp_near_scale)
        self._sc_persp_far_scale = QDoubleSpinBox()
        self._sc_persp_far_scale.setRange(0.01, 20.0)
        self._sc_persp_far_scale.setDecimals(3)
        self._sc_persp_far_scale.setSingleStep(0.05)
        self._sc_persp_far_scale.setValue(0.5)
        self._sc_persp_far_scale.setMaximumWidth(110)
        self._sc_persp_far_scale.setToolTip("远端（箭头头○）缩放系数，通常 <1（离镜头最远最小）。")
        self._sc_persp_far_scale.valueChanged.connect(lambda _v: self._on_persp_widgets_changed())
        persp_scale_row.addRow("远端缩放", self._sc_persp_far_scale)
        persp_lay.addLayout(persp_scale_row)
        mid_lbl = QLabel("中途点（可选，非线性纵深如台阶）：")
        persp_lay.addWidget(mid_lbl)
        self._sc_persp_table = QTableWidget(0, 2)
        self._sc_persp_table.setHorizontalHeaderLabels(["位置 0–1", "缩放"])
        self._sc_persp_table.horizontalHeader().setStretchLastSection(True)
        self._sc_persp_table.verticalHeader().setVisible(False)
        self._sc_persp_table.setMaximumHeight(110)
        self._sc_persp_table.setToolTip(
            "沿近→远轴的中途缩放点：位置为 0（近）到 1（远）之间的归一化值；"
            "留空即两端线性插值。",
        )
        self._sc_persp_table.itemChanged.connect(lambda _i: self._on_persp_widgets_changed())
        persp_lay.addWidget(self._sc_persp_table)
        self._install_vertex_table_affordances(
            self._sc_persp_table, self._on_persp_remove_row, label="删除选中中途点")
        persp_btns = QHBoxLayout()
        b_add = QPushButton("＋ 中途点")
        b_add.setToolTip("在轴中点加一个中途缩放点（位置 0.5）")
        b_add.clicked.connect(self._on_persp_add_row)
        persp_btns.addWidget(b_add)
        b_del = QPushButton("－ 删除选中")
        b_del.setToolTip("删除选中的中途点（也可按 Delete）")
        b_del.clicked.connect(self._on_persp_remove_row)
        persp_btns.addWidget(b_del)
        persp_btns.addStretch(1)
        persp_lay.addLayout(persp_btns)
        self._sc_persp_speed = QCheckBox("移动速度同步补偿 affectsSpeed")
        self._sc_persp_speed.setChecked(True)
        self._sc_persp_speed.setToolTip(
            "开：移动步长同乘 f，远处角色不会相对背景滑步（推荐）；"
            "关：只缩放视觉，速度不变。",
        )
        self._sc_persp_speed.stateChanged.connect(lambda _s: self._on_persp_widgets_changed())
        persp_lay.addWidget(self._sc_persp_speed)
        # 深度轴端点坐标（画布拖动写入；面板只读展示，不手输）
        self._sc_persp_axis: dict | None = None
        self._persp_box.add_body(persp_inner)
        outer.addWidget(self._persp_box)

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
            "本场景要同时循环播放的环境音（多条会叠在一起）。\n"
            "「添加…」打开可搜索、可试听的选择窗；双击某行试听。",
        )
        self._sc_ambient_list.setMaximumHeight(110)  # 上限而非固定，拥挤时可压缩
        self._sc_ambient_list.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Maximum,
        )
        self._sc_ambient_list.setHorizontalScrollBarPolicy(
            Qt.ScrollBarPolicy.ScrollBarAlwaysOff,
        )
        self._sc_ambient_list.currentRowChanged.connect(
            lambda _r: self._sync_ambient_buttons(),
        )
        self._sc_ambient_list.itemDoubleClicked.connect(
            lambda _i: self._sc_ambient_preview.preview_current(),
        )
        amb_lay.addWidget(self._sc_ambient_list)

        amb_btn_row = QHBoxLayout()
        amb_add = QPushButton("添加…")
        amb_add.setToolTip("打开音频选择窗（可搜索 / 试听 / 看时长与缺失状态）")
        amb_add.clicked.connect(self._add_ambient)
        amb_btn_row.addWidget(amb_add)
        self._amb_btn_del = QPushButton("移除")
        self._amb_btn_del.clicked.connect(self._remove_ambient)
        amb_btn_row.addWidget(self._amb_btn_del)
        self._amb_btn_up = QPushButton("↑")
        self._amb_btn_up.setToolTip("上移（顺序只是编排顺序，多条同时循环播放）")
        self._amb_btn_up.clicked.connect(lambda: self._move_ambient(-1))
        amb_btn_row.addWidget(self._amb_btn_up)
        self._amb_btn_down = QPushButton("↓")
        self._amb_btn_down.clicked.connect(lambda: self._move_ambient(1))
        amb_btn_row.addWidget(self._amb_btn_down)
        amb_btn_row.addStretch(1)
        amb_lay.addLayout(amb_btn_row)
        # 环境音条目的时长探测缓存（后台线程，只喂 tooltip；探完自刷一次列表）
        self._ambient_meta = AudioMetaCache(self)
        self._ambient_meta.updated.connect(self._refresh_ambient_tooltips)
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
        amb_hint = QLabel("多条会同时循环叠放；目录外的 id 也能在选择窗里手填。")
        amb_hint.setStyleSheet("color: #888;")   # 字号交给全局皮肤，本地不写死
        amb_lay.addWidget(amb_hint)
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

        outer.addWidget(self._build_scene_lights_section())

        outer.addStretch(1)
        return w

    # ---- 统一光影：灯位 ------------------------------------------------
    def _build_scene_lights_section(self) -> QWidget:
        """灯位编辑。

        与上面的「光环境曲线」是**两代**系统：那一代是单一全局主光 + 逐 entity 色调；
        这一代是场景里摆真实的点/聚/面光，场景与角色共享同一份光照状态。

        作者模型 = **点哪儿摆哪儿，再拉高度**：画布上点一个地面点 → 取该像素深度
        反投影成伪世界坐标；高度另给一个数值（**米**）。2D 画布只有两个自由度，
        第三个必须由深度图补出来。

        距离量一律用**米**：世界单位是逐场景的（实测 1 wu = 2.0–10.0 m），
        用 wu 填参数会让同一个数在不同场景差 5 倍。
        """
        g = CollapsibleSection("统一光影 lighting（灯位）", start_open=False)
        g.set_header_tool_tip(
            "场景里的点光/聚光/面光/平行光。位置在伪世界空间；距离量用米。\n"
            "⚠ 带阴影的灯是性能预算的唯一约束项——面板常驻显示 N/预算。\n"
            "天光/雾/显示变换等参数在游戏内 F2「统一光影（场景）」里调，改完可存回本文件。")
        inner = QWidget()
        lay = QVBoxLayout(inner)

        self._sl_status = QLabel("")
        self._sl_status.setWordWrap(True)
        lay.addWidget(self._sl_status)

        self._sl_table = QTableWidget(0, 5)
        self._sl_table.setHorizontalHeaderLabels(["id", "类型", "启用", "投影", "强度"])
        hh = self._sl_table.horizontalHeader()
        hh.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        for c in (1, 2, 3, 4):
            hh.setSectionResizeMode(c, QHeaderView.ResizeMode.ResizeToContents)
        self._sl_table.setMinimumHeight(120)
        self._sl_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self._sl_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self._sl_table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._sl_table.itemSelectionChanged.connect(self._on_sl_row_selected)
        self._install_vertex_table_affordances(
            self._sl_table, self._on_sl_remove, label="删除选中的灯")
        lay.addWidget(self._sl_table)

        row1 = QHBoxLayout()
        for kind, label in (("point", "＋点光"), ("spot", "＋聚光"),
                            ("area", "＋面光"), ("directional", "＋平行光")):
            b = QPushButton(label)
            b.clicked.connect(lambda _=False, k=kind: self._on_sl_add(k))
            row1.addWidget(b)
        self._sl_del = QPushButton("删除")
        self._sl_del.clicked.connect(self._on_sl_remove)
        row1.addWidget(self._sl_del)
        row1.addStretch(1)
        lay.addLayout(row1)

        self._sl_sync_status = QLabel("↔ 同步未启动　发0 收0")
        self._sl_sync_status.setWordWrap(True)
        self._sl_sync_status.setToolTip(
            "灯位与正在跑的游戏是双向实时同步的。这行显示连接状态——\n"
            "「连着连着没了」最怕的是没人知道，所以断线在这里一定看得见（并会自动重连）。")
        lay.addWidget(self._sl_sync_status)

        self._sl_pull = QPushButton("立即从运行时抓一次（平时自动同步）")
        self._sl_pull.setToolTip(
            "灯位与游戏是**双向实时同步**的：这张表改了游戏跟着变，游戏里 F3 拖了这张表也跟着变，\n"
            "平时不用点任何按钮。这个按钮只在同步被打断时（游戏刚起来、刚换场景）用来立刻抓一次。\n"
            "同步只把参数搬过来入脏——落盘仍然是本编辑器 Save All（工程唯一写盘出口）。")
        self._sl_pull.clicked.connect(self._on_sl_pull_runtime)
        lay.addWidget(self._sl_pull)

        self._sl_place = QPushButton("在画布上定位选中的灯")
        self._sl_place.setCheckable(True)
        self._sl_place.setToolTip(
            "点亮后在画布上点一下：取该处地面的伪世界坐标作为灯的落点，"
            "再用下面的「离地高度」把它抬起来。")
        self._sl_place.toggled.connect(self._on_sl_place_toggled)
        lay.addWidget(self._sl_place)

        self._sl_form = QWidget()
        form = QFormLayout(self._sl_form)
        self._sl_id = QLineEdit()
        self._sl_id.editingFinished.connect(self._on_sl_field_changed)
        form.addRow("id", self._sl_id)
        self._sl_enabled = QCheckBox("点亮")
        self._sl_enabled.toggled.connect(self._on_sl_field_changed)
        self._sl_cast = QCheckBox("投影（吃性能预算）")
        self._sl_cast.toggled.connect(self._on_sl_field_changed)
        cb = QHBoxLayout()
        cb.addWidget(self._sl_enabled)
        cb.addWidget(self._sl_cast)
        cb.addStretch(1)
        cbw = QWidget()
        cbw.setLayout(cb)
        form.addRow("", cbw)

        def spin(lo: float, hi: float, step: float, dec: int) -> QDoubleSpinBox:
            s = QDoubleSpinBox()
            s.setRange(lo, hi)
            s.setSingleStep(step)
            s.setDecimals(dec)
            s.valueChanged.connect(self._on_sl_field_changed)
            return s

        # 灯型下拉。**以前没有这个东西，编辑器里根本改不了灯型**（F2 面板有，
        # 编辑器没有），只能删了重建。换型走 scene_lights.retype：从新型的缺省
        # 起手，只搬与类型无关的作者意图，旧型专属字段一概摘掉（留着是静默失效）。
        self._sl_kind = QComboBox()
        for _k, _lbl in (("point", "点光"), ("spot", "聚光"),
                         ("area", "面光"), ("directional", "平行光")):
            self._sl_kind.addItem(_lbl, _k)
        self._sl_kind.setToolTip("换灯型会自动摘掉对新类型无意义的字段")
        self._sl_kind.currentIndexChanged.connect(self._on_sl_kind_changed)
        form.addRow("灯型", self._sl_kind)

        self._sl_intensity = spin(0.0, 200.0, 0.1, 2)
        form.addRow("强度", self._sl_intensity)
        self._sl_kelvin = spin(1000.0, 15000.0, 50.0, 0)
        form.addRow("色温 K", self._sl_kelvin)
        self._sl_range = spin(1.0, 8000.0, 10.0, 1)
        self._sl_range.setToolTip("作用半径,单位 **wu**(世界空间,与 NPC 坐标同一把尺)。角色高 150 wu,对着它估。")
        form.addRow("作用半径 wu", self._sl_range)
        self._sl_soft = spin(0.1, 200.0, 0.5, 2)
        self._sl_soft.setToolTip(
            "发光体**半径**,单位 wu。平方后进 1/(r²+c) 当近场软化,防贴脸核爆。"
            "调大 = 光斑变平摊,调小 = 中心更硬更亮。")
        form.addRow("发光体半径 wu", self._sl_soft)
        self._sl_height = spin(-500.0, 2000.0, 5.0, 1)
        self._sl_height.setToolTip("离地高度,单位 wu。角色高 150 wu——街灯大约挂在 2.5 个人高。它直接决定 N·L/r² 的形状。")
        form.addRow("离地高度 wu", self._sl_height)
        self._sl_inner = spin(1.0, 89.0, 1.0, 0)
        form.addRow("聚光内角 °", self._sl_inner)
        self._sl_outer = spin(1.0, 89.0, 1.0, 0)
        form.addRow("聚光外角 °", self._sl_outer)
        self._sl_size_w = spin(1.0, 4000.0, 5.0, 1)
        form.addRow("面光宽 wu", self._sl_size_w)
        self._sl_size_h = spin(1.0, 4000.0, 5.0, 1)
        form.addRow("面光高 wu", self._sl_size_h)
        self._sl_form_layout = form          # 整行隐藏要用它（setRowVisible）
        # 自转：面光绕**自身法线**转。没有它，矩形的横竖由 areaAxes 从法线推出来，
        # 作者说了不算 —— 一扇斜着的窗、一块转过角度的灯板根本表达不出来。
        self._sl_roll = spin(-180.0, 180.0, 5.0, 1)
        form.addRow("面光自转°", self._sl_roll)
        self._sl_two_sided = QCheckBox("面光双面发光")
        self._sl_two_sided.setToolTip(
            "勾上 = 矩形两面都发光（窗、灯箱）；不勾 = 只朝 orientation 那一面。只对面光有意义。")
        self._sl_two_sided.toggled.connect(self._on_sl_field_changed)
        form.addRow("", self._sl_two_sided)
        self._sl_elev = spin(1.0, 89.0, 1.0, 0)
        form.addRow("平行光仰角 °", self._sl_elev)
        self._sl_azim = spin(0.0, 359.0, 1.0, 0)
        form.addRow("平行光方位 °", self._sl_azim)
        lay.addWidget(self._sl_form)

        # 玩家的阴影绑定。玩家不在场景数据里有自己的 def，所以挂在场景上——
        # 本来就该逐场景配（这条街有路灯，那间屋子只有烛火）。
        lay.addWidget(QLabel("玩家阴影绑定"))
        self._player_shadow_bind = ShadowBindingsEditor(self._emit_props_changed, self)
        lay.addWidget(self._player_shadow_bind)

        g.add_body(inner)
        self._sc_lights_fold = g
        return g

    def _ensure_source_scene_for_editing(self) -> None:
        sid = self._editing_scene_id or ""
        sc = self._model.scenes.get(sid)
        if isinstance(sc, dict):
            self._source_scene = sc

    def _warn_bare_id_change(self, kind: str, field: QLineEdit, source: object) -> None:
        """面板裸改实体 id 完全绕过重构引擎：若旧 id 有外部引用，改完会静默悬垂。
        editingFinished 触发（仅交互编辑；程序化 setText/flush 不触发），检测到外部
        引用时给「撤销 / 仍然裸改」二选一，引导走重构菜单（审查 P2 ③）。"""
        # 程序化填充期（load_*_props 在 _suppress_props_changed_emits 内）不打扰。
        if self._props_changed_suppressed:
            return
        if not isinstance(source, dict):
            return
        old_id = str(source.get("id", "") or "").strip()
        new_id = field.text().strip()
        if not old_id or not new_id or new_id == old_id:
            return
        sid = self._editing_scene_id or ""
        if not sid:
            return
        try:
            from ..shared.entity_refactor import scan_entity_usages
            report = scan_entity_usages(self._model, sid, kind, old_id)
        except Exception:
            return  # 扫描失败不阻断编辑（advisory）
        ext = int(report.get("totalRefs", 0)) - int(report.get("selfRefs", 0))
        if ext <= 0:
            return
        box = QMessageBox(self)
        box.setWindowTitle("实体 id 裸改")
        box.setIcon(QMessageBox.Icon.Warning)
        box.setText(
            f"检测到「{old_id}」有 {ext} 处外部引用。\n"
            "在此直接改 id 不会改写这些引用，运行时会静默悬垂、数据校验才报。\n"
            "建议改用工具栏「重构 → 重命名 id」（全项目引用跟随 + 可撤销）。")
        revert_btn = box.addButton("撤销改名", QMessageBox.ButtonRole.RejectRole)
        box.addButton("仍然裸改", QMessageBox.ButtonRole.AcceptRole)
        box.exec()
        if box.clickedButton() is revert_btn:
            field.blockSignals(True)
            try:
                field.setText(old_id)
            finally:
                field.blockSignals(False)
            self._emit_props_changed()

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
            # NOTE: 实体列表/entityGroups 故意共享 model 引用，保持场景树操作直写
            # model 的旧契约；逐实体 _source_*/_staging_* 通路负责字段级 staging commit。
            for lk in ("hotspots", "npcs", "zones", "entityGroups"):
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
                self._source_group = None
                self._staging_group = None
                self._pending_group = None
                self._group_scene = None
                self._group_original_id = ""
                self._group_pending_changed = False
                self._group_commit_blocked = False
                self._spawn_flush_scene = None
                self._spawn_scene = None
            self._show_panel(self._scene_panel)
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
            dn = st.get("dayNight")
            self._sc_daynight.blockSignals(True)
            self._sc_daynight.setChecked(isinstance(dn, dict) and dn.get("enabled") is True)
            self._sc_daynight.blockSignals(False)
            raw_anchors = st.get("exitAnchors")
            self._exit_anchors = [
                copy.deepcopy(a) for a in raw_anchors if isinstance(a, dict)
            ] if isinstance(raw_anchors, list) else []
            self._reload_exit_anchor_list()
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
                        "与运行时 SceneDepthSystem 一致；其余 depthConfig 请在「角色照明实验室」中导出。",
                    )
                else:
                    self._sc_depth_tol.setEnabled(False)
                    self._sc_floor_offset.setEnabled(False)
                    self._sc_depth_tol.setValue(0.0)
                    self._sc_floor_offset.setValue(0.0)
                    self._sc_depth_hint.setText(
                        "当前场景无 depthConfig。请先在「角色照明实验室」烘焙并导出后，再在此处微调这两项。",
                    )
            finally:
                self._sc_depth_tol.blockSignals(False)
                self._sc_floor_offset.blockSignals(False)
            self._load_persp_widgets(st)
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

    # ---- 透视缩放 perspectiveScale（深度轴模型） -------------------------
    def _on_persp_widgets_changed(self) -> None:
        if getattr(self, "_persp_updating", False):
            return
        # 首次启用且无轴：在画布中央生成默认竖直轴（近端底部大→远端顶部小）
        if self._sc_persp_enable.isChecked() and not isinstance(self._sc_persp_axis, dict):
            ww = float(self._sc_width.value() or 0) or 800.0
            wh = float(self._sc_height.value() or 0) or 600.0
            self._sc_persp_axis = {
                "near": {"x": ww * 0.5, "y": wh * 0.92},
                "far": {"x": ww * 0.5, "y": wh * 0.30},
            }
        self._emit_props_changed()
        self.perspective_preview_changed.emit(self._persp_cfg_preview())

    def _persp_mid_stops(self) -> list[dict]:
        out: list[dict] = []
        t = self._sc_persp_table
        for i in range(t.rowCount()):
            it_p = t.item(i, 0)
            it_s = t.item(i, 1)
            try:
                pos = float((it_p.text() if it_p else "").strip())
                s = float((it_s.text() if it_s else "").strip())
            except (TypeError, ValueError):
                continue
            out.append({"pos": pos, "scale": s})
        return out

    def _persp_cfg_preview(self) -> dict | None:
        """按当前 UI + 轴端点生成画布预览用 cfg（未启用或无轴 None）。"""
        if not self._sc_persp_enable.isChecked() or not isinstance(self._sc_persp_axis, dict):
            return None
        near = self._sc_persp_axis.get("near", {})
        far = self._sc_persp_axis.get("far", {})
        cfg: dict = {
            "near": {"x": float(near.get("x", 0)), "y": float(near.get("y", 0)),
                     "scale": float(self._sc_persp_near_scale.value())},
            "far": {"x": float(far.get("x", 0)), "y": float(far.get("y", 0)),
                    "scale": float(self._sc_persp_far_scale.value())},
        }
        mids = self._persp_mid_stops()
        if mids:
            cfg["midStops"] = mids
        return cfg

    def _on_persp_add_row(self) -> None:
        t = self._sc_persp_table
        self._persp_updating = True
        try:
            r = t.rowCount()
            t.insertRow(r)
            t.setItem(r, 0, QTableWidgetItem("0.5"))
            t.setItem(r, 1, QTableWidgetItem("0.75"))
        finally:
            self._persp_updating = False
        self._on_persp_widgets_changed()

    def _on_persp_remove_row(self) -> None:
        r = self._sc_persp_table.currentRow()
        if r < 0:
            return
        self._persp_updating = True
        try:
            self._sc_persp_table.removeRow(r)
        finally:
            self._persp_updating = False
        self._on_persp_widgets_changed()

    def apply_persp_axis_endpoint(self, which: str, x: float, y: float) -> None:
        """画布深度轴端点拖动提交：写回 staging 轴端点坐标（经统一 dirty/预览通路）。"""
        if not isinstance(self._sc_persp_axis, dict):
            self._sc_persp_axis = {"near": {"x": 0.0, "y": 0.0}, "far": {"x": 0.0, "y": 0.0}}
        key = "near" if which == "near" else "far"
        self._sc_persp_axis[key] = {"x": round(float(x), 1), "y": round(float(y), 1)}
        self._on_persp_widgets_changed()

    def _load_persp_widgets(self, st: dict) -> None:
        cfg = st.get("perspectiveScale")
        on = isinstance(cfg, dict)
        self._persp_updating = True
        try:
            near = cfg.get("near") if on else None
            far = cfg.get("far") if on else None
            if isinstance(near, dict) and isinstance(far, dict):
                self._sc_persp_axis = {
                    "near": {"x": _persp_editor_num(near.get("x")) or 0.0,
                             "y": _persp_editor_num(near.get("y")) or 0.0},
                    "far": {"x": _persp_editor_num(far.get("x")) or 0.0,
                            "y": _persp_editor_num(far.get("y")) or 0.0},
                }
            else:
                self._sc_persp_axis = None
            self._sc_persp_near_scale.blockSignals(True)
            self._sc_persp_near_scale.setValue(
                _persp_editor_num((near or {}).get("scale")) or 1.0 if isinstance(near, dict) else 1.0)
            self._sc_persp_near_scale.blockSignals(False)
            self._sc_persp_far_scale.blockSignals(True)
            self._sc_persp_far_scale.setValue(
                _persp_editor_num((far or {}).get("scale")) or 0.5 if isinstance(far, dict) else 0.5)
            self._sc_persp_far_scale.blockSignals(False)
            t = self._sc_persp_table
            t.blockSignals(True)
            t.setRowCount(0)
            mids = cfg.get("midStops") if on else None
            if isinstance(mids, list):
                for m in mids:
                    if not isinstance(m, dict):
                        continue
                    row = t.rowCount()
                    t.insertRow(row)
                    t.setItem(row, 0, QTableWidgetItem(_persp_cell_text(m.get("pos"))))
                    t.setItem(row, 1, QTableWidgetItem(_persp_cell_text(m.get("scale"))))
            t.blockSignals(False)
            self._sc_persp_enable.blockSignals(True)
            self._sc_persp_enable.setChecked(on)
            self._sc_persp_enable.blockSignals(False)
            self._sc_persp_speed.blockSignals(True)
            self._sc_persp_speed.setChecked(not (on and cfg.get("affectsSpeed") is False))
            self._sc_persp_speed.blockSignals(False)
            self._persp_box.set_expanded(on)
        finally:
            self._persp_updating = False

    def _flush_persp_into(self, sc: dict) -> None:
        """UI + 轴端点 → staging：零编辑时按值比较原样保留原 dict（键序/数值表示零变化）。"""
        orig = sc.get("perspectiveScale")
        if not self._sc_persp_enable.isChecked() or not isinstance(self._sc_persp_axis, dict):
            sc.pop("perspectiveScale", None)
            return
        base = orig if isinstance(orig, dict) else {}
        o_near = base.get("near") if isinstance(base.get("near"), dict) else {}
        o_far = base.get("far") if isinstance(base.get("far"), dict) else {}
        ax_near = self._sc_persp_axis.get("near", {})
        ax_far = self._sc_persp_axis.get("far", {})

        def _pt(o: dict, ax: dict, scale_v: float) -> dict:
            nd = dict(o)
            nd["x"] = self._keep_num(round(float(ax.get("x", 0)), 1), o.get("x"))
            nd["y"] = self._keep_num(round(float(ax.get("y", 0)), 1), o.get("y"))
            nd["scale"] = self._keep_num(round(scale_v, 3), o.get("scale"))
            return o if nd == o else nd

        out = dict(base)
        out["near"] = _pt(o_near, ax_near, float(self._sc_persp_near_scale.value()))
        out["far"] = _pt(o_far, ax_far, float(self._sc_persp_far_scale.value()))
        o_mids = base.get("midStops") if isinstance(base.get("midStops"), list) else []
        new_mids: list[dict] = []
        t = self._sc_persp_table
        for i in range(t.rowCount()):
            om = o_mids[i] if i < len(o_mids) and isinstance(o_mids[i], dict) else {}
            it_p = t.item(i, 0)
            it_s = t.item(i, 1)
            try:
                pos = float((it_p.text() if it_p else "").strip())
                s = float((it_s.text() if it_s else "").strip())
            except (TypeError, ValueError):
                if om:
                    new_mids.append(om)
                continue
            nm = dict(om)
            nm["pos"] = self._keep_num(round(pos, 4), om.get("pos"))
            nm["scale"] = self._keep_num(round(s, 3), om.get("scale"))
            new_mids.append(om if nm == om else nm)
        if new_mids:
            out["midStops"] = new_mids
        elif "midStops" in out:
            del out["midStops"]
        if self._sc_persp_speed.isChecked():
            if base.get("affectsSpeed") is not True:
                out.pop("affectsSpeed", None)
        else:
            out["affectsSpeed"] = False
        if isinstance(orig, dict) and out == orig:
            sc["perspectiveScale"] = orig
        else:
            sc["perspectiveScale"] = out

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
                "需在「角色照明实验室」重新打开本场景、重烘并导出深度。")

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
                "请在「角色照明实验室」中重新打开本场景，重烘并导出深度；"
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
        elif w == self._group_panel and self._staging_group is not None:
            self._write_group_widgets_to_dict(self._staging_group)

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
        # 日夜：不勾＝不落键（缺省就是"不参与"，旧场景零字节变化）
        if self._sc_daynight.isChecked():
            dn = sc.setdefault("dayNight", {})
            dn["enabled"] = True
        elif "dayNight" in sc:
            del sc["dayNight"]
        anchors = [a for a in getattr(self, "_exit_anchors", []) if str(a.get("id", "")).strip()]
        if anchors:
            sc["exitAnchors"] = copy.deepcopy(anchors)
        elif "exitAnchors" in sc:
            del sc["exitAnchors"]
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
        self._flush_persp_into(sc)
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
        self._writeback_scene_lights(sc)
        self._emit_props_changed()

    # ---- 统一光影：灯位 ------------------------------------------------
    def _sl_lights(self) -> list[dict]:
        return self._sc_lighting.setdefault("lights", []) if self._sc_lighting else []

    def _sl_current(self) -> dict | None:
        ls = self._sl_lights()
        return ls[self._sl_selected] if 0 <= self._sl_selected < len(ls) else None

    def _fill_sl_table(self, *, select_row: int = -1) -> None:
        self._sl_updating = True
        try:
            ls = self._sl_lights()
            self._sl_table.setRowCount(len(ls))
            for i, l in enumerate(ls):
                for c, txt in enumerate((
                    str(l.get("id", "")),
                    str(l.get("kind", "")),
                    "✓" if l.get("enabled", True) else "",
                    "✓" if l.get("castShadow") else "",
                    f'{float(l.get("intensity", 0) or 0):.2f}',
                )):
                    self._sl_table.setItem(i, c, QTableWidgetItem(txt))
            if 0 <= select_row < len(ls):
                self._sl_table.selectRow(select_row)
                self._sl_selected = select_row
            elif not ls:
                self._sl_selected = -1
        finally:
            self._sl_updating = False
        self._sync_sl_form()
        self._sync_sl_status()

    def _sync_sl_status(self) -> None:
        ls = self._sl_lights()
        n, budget, over = scene_lights.shadow_budget_status(ls)
        issues = scene_lights.validate_lights(ls)
        ww = self._sl_space.world_w if self._sl_space else 0.0
        head = (f"灯 {len(ls)} 盏　带影 <b>{n}/{budget}</b>"
                + ("　<span style='color:#e06c4a'>⚠ 超预算,跑起来会掉帧</span>" if over else "")
                + (f"　世界宽 {ww:.0f} wu　角色高 {scene_lights.CHARACTER_HEIGHT_WU} wu"
                   if ww else "　⚠ 场景缺 worldWidth"))
        if issues:
            head += "<br>" + "<br>".join(f"• {t}" for t in issues[:6])
        self._sl_status.setText(head)

    def _sync_sl_form(self) -> None:
        l = self._sl_current()
        self._sl_form.setEnabled(l is not None)
        if l is None:
            return
        self._sl_updating = True
        try:
            kind = str(l.get("kind", "point"))
            _ki = self._sl_kind.findData(kind)
            if _ki >= 0:
                self._sl_kind.setCurrentIndex(_ki)
            self._sl_id.setText(str(l.get("id", "")))
            self._sl_enabled.setChecked(bool(l.get("enabled", True)))
            self._sl_cast.setChecked(bool(l.get("castShadow")))
            self._sl_intensity.setValue(float(l.get("intensity", 0) or 0))
            self._sl_kelvin.setValue(float(l.get("kelvin", 2400) or 2400))
            self._sl_range.setValue(float(
                l.get("range") or scene_lights.DEFAULT_LIGHT_RANGE_WU))
            self._sl_soft.setValue(float(
                l.get("softeningRadius") or scene_lights.DEFAULT_LAMP_RADIUS_WU))
            self._sl_height.setValue(float(l.get("_editorHeightWu", 300.0) or 0.0))
            self._sl_inner.setValue(float(l.get("innerAngleDeg", 25) or 25))
            self._sl_outer.setValue(float(l.get("outerAngleDeg", 45) or 45))
            self._sl_two_sided.setChecked(bool(l.get("twoSided")))
            sz = l.get("size") or [0.2, 0.15]
            self._sl_size_w.setValue(float(sz[0]))
            self._sl_size_h.setValue(float(sz[1]))
            self._sl_roll.setValue(float(l.get("rollDeg", 0) or 0))
            self._sl_elev.setValue(float(l.get("elevationDeg", 45) or 45))
            self._sl_azim.setValue(float(l.get("azimuthDeg", 180) or 180))
            # 按灯型只留相关的行，别让作者对着一堆不生效的字段发懵
            # ★ 按灯型**整行隐藏**，不是置灰。
            #
            #   以前九个控件永远都在、只把无关的置灰，于是不管选哪种灯，面前
            #   永远摊着「聚光内角/外角 + 面光宽/高/双面 + 平行光仰角/方位」
            #   这一堆用不上的东西 —— 任何一种灯型真正用得上的只有其中 3–4 个。
            #   置灰只是"看得见摸不着"，读表的人还是要逐行判断哪些算数。
            for w, on in (
                (self._sl_range, kind != "directional"),
                # 面光**不吃**软化半径:`lcAreaLight(…, C.x, twoSided, vis)` 的
                # 参数表里根本没有它(点光/聚光走 lcFalloff 才用)。摆着 = 骗人。
                (self._sl_soft, kind in ("point", "spot")),
                (self._sl_height, kind != "directional"),
                (self._sl_inner, kind == "spot"), (self._sl_outer, kind == "spot"),
                (self._sl_size_w, kind == "area"), (self._sl_size_h, kind == "area"),
                (self._sl_roll, kind == "area"),
                (self._sl_two_sided, kind == "area"),
                (self._sl_elev, kind == "directional"), (self._sl_azim, kind == "directional"),
            ):
                self._set_sl_row_visible(w, on)
        finally:
            self._sl_updating = False

    def _set_sl_row_visible(self, w, on: bool) -> None:
        """整行显示/隐藏（连标签一起）。找不到行就退回置灰，绝不因此崩掉表单。"""
        form = getattr(self, "_sl_form_layout", None)
        if form is None:
            w.setEnabled(on)
            return
        try:
            idx, _role = form.getWidgetPosition(w)
            if idx >= 0:
                form.setRowVisible(idx, on)
                return
        except Exception:
            pass
        w.setEnabled(on)

    def _on_sl_kind_changed(self) -> None:
        """换灯型：走 retype（摘掉旧型专属字段），然后整表重刷。

        ⚠ 必须过 `_sl_updating` 闸：`_sync_sl_form` 自己会 setCurrentIndex，
          不挡住就会递归换型，把作者的字段一路清干净。
        """
        if getattr(self, "_sl_updating", False):
            return
        l = self._sl_current()
        if l is None:
            return
        kind = self._sl_kind.currentData()
        if not kind or kind == l.get("kind"):
            return
        lights = self._sl_lights()
        i = lights.index(l)
        lights[i] = scene_lights.retype(l, str(kind))
        self._sync_sl_form()
        self._fill_sl_table(select_row=self._sl_selected)
        self._sync_sl_status()
        self._emit_props_changed()

    def _on_sl_row_selected(self) -> None:
        if self._sl_updating:
            return
        rows = self._sl_table.selectionModel().selectedRows()
        self._sl_selected = rows[0].row() if rows else -1
        self._sync_sl_form()

    def _on_sl_add(self, kind: str) -> None:
        if self._sc_lighting is None:
            self._sc_lighting = scene_lights.default_lighting_block()
        ls = self._sl_lights()
        n = 1
        used = {str(x.get("id")) for x in ls}
        while f"light_{n}" in used:
            n += 1
        l = scene_lights.default_light(n, kind)
        # 新灯落在画面中心的地面上，作者随后用「在画布上定位」挪走
        if kind != "directional" and self._sl_space:
            g = self._sl_space.ground_world_at_scene(
                self._sl_space.world_w * 0.5, self._sl_space.world_h * 0.5)
            if g:
                l["_editorHeightWu"] = 300.0
                l["pos"] = list(self._sl_space.raise_world(g, 2.0))
        ls.append(l)
        self._fill_sl_table(select_row=len(ls) - 1)
        self._emit_props_changed()

    def _on_sl_remove(self) -> None:
        ls = self._sl_lights()
        if not (0 <= self._sl_selected < len(ls)):
            return
        ls.pop(self._sl_selected)
        self._sl_selected = min(self._sl_selected, len(ls) - 1)
        self._fill_sl_table(select_row=self._sl_selected)
        self._emit_props_changed()

    def _on_sl_field_changed(self) -> None:
        if self._sl_updating:
            return
        l = self._sl_current()
        if l is None:
            return
        kind = str(l.get("kind", "point"))
        l["id"] = self._sl_id.text().strip() or l.get("id", "light")
        l["enabled"] = self._sl_enabled.isChecked()
        l["castShadow"] = self._sl_cast.isChecked()
        l["intensity"] = round(self._sl_intensity.value(), 3)
        l["kelvin"] = round(self._sl_kelvin.value(), 1)
        if kind != "directional":
            l["range"] = round(self._sl_range.value(), 4)
            l["softeningRadius"] = round(self._sl_soft.value(), 4)
            # 高度改了要重算 pos —— 只动世界 Y，落点不变
            h = round(self._sl_height.value(), 3)
            prev = float(l.get("_editorHeightWu", h) or 0.0)
            l["_editorHeightWu"] = h
            if self._sl_space and isinstance(l.get("pos"), list) and abs(h - prev) > 1e-9:
                l["pos"] = list(self._sl_space.raise_world(tuple(l["pos"]), h - prev))
        if kind == "spot":
            l["innerAngleDeg"] = round(self._sl_inner.value(), 1)
            l["outerAngleDeg"] = round(self._sl_outer.value(), 1)
        if kind == "area":
            l["size"] = [round(self._sl_size_w.value(), 4),
                         round(self._sl_size_h.value(), 4)]
            l["rollDeg"] = round(self._sl_roll.value(), 1)
            l["twoSided"] = bool(self._sl_two_sided.isChecked())
        else:
            # 换了灯型就把只对面光有意义的键清掉，别在数据里留下不生效的字段
            l.pop("twoSided", None)
            l.pop("rollDeg", None)
        if kind == "directional":
            l["elevationDeg"] = round(self._sl_elev.value(), 1)
            l["azimuthDeg"] = round(self._sl_azim.value(), 1)
        self._fill_sl_table(select_row=self._sl_selected)
        self._emit_props_changed()

    def _on_sl_place_toggled(self, on: bool) -> None:
        self._sl_placing = bool(on)
        self.light_place_mode_changed.emit(bool(on))

    def place_selected_light_at(self, scene_x: float, scene_y: float) -> bool:
        """画布点击时调这里。取该处**地面**的伪世界坐标当落点，再按当前高度抬起。"""
        if not self._sl_placing:
            return False
        l = self._sl_current()
        if l is None or str(l.get("kind")) == "directional" or not self._sl_space:
            return False
        g = self._sl_space.ground_world_at_scene(scene_x, scene_y)
        if g is None:
            self._sl_status.setText(
                "⚠ 这个场景没有深度图，点选取不到地面高度。"
                "先在角色照明实验室导出场景深度，再来摆灯。")
            return True
        h = float(l.get("_editorHeightWu", 300.0) or 0.0)
        l["pos"] = [round(v, 4) for v in self._sl_space.raise_world(g, h)]
        self._fill_sl_table(select_row=self._sl_selected)
        self._emit_props_changed()
        return True

    def _load_scene_lights(self, st: dict) -> None:
        """载入。**整块透传保值**——F2 里调的天光/雾/显示变换本编辑器不显示，
        但必须原样带回去，否则打开保存一次就把它们清了。"""
        lit = st.get("lighting")
        self._sc_lighting = copy.deepcopy(lit) if isinstance(lit, dict) else None
        self._sl_selected = -1
        self._sl_placing = False
        if hasattr(self, "_sl_place"):
            self._sl_place.setChecked(False)
        self._sl_space = scene_lights.SceneLightSpace(str(st.get("id") or ""), st)
        self._recompute_light_heights()
        self._sc_lights_fold.set_expanded(bool(self._sc_lighting and self._sc_lighting.get("lights")))
        self._fill_sl_table(select_row=0 if (self._sc_lighting or {}).get("lights") else -1)
        self._player_shadow_bind.set_lights((self._sc_lighting or {}).get("lights"))
        self._player_shadow_bind.load(st.get("playerShadowBindings"))

    def _recompute_light_heights(self) -> None:
        """从 `pos` 反推「离地高度」供 UI 显示（存档里只有绝对坐标）。

        载入与「从运行时拉取」都走这里——两处各算一遍的话，拉取后那一栏高度
        会停在上一份数据上，而它又是「在画布上定位」的输入，错了会把灯摆到错地方。
        """
        if not (self._sc_lighting and self._sl_space and self._sl_space.load_depth()):
            return
        for l in self._sc_lighting.get("lights") or []:
            pos = l.get("pos")
            if not (isinstance(pos, list) and len(pos) == 3):
                continue
            sx, sy = self._sl_space.world_to_scene(tuple(pos))
            g = self._sl_space.ground_world_at_scene(sx, sy)
            if g:
                l["_editorHeightWu"] = round(
                    self._sl_space.height_wu_above(tuple(pos), g), 3)

    # ---- 与游戏的双向实时同步（驱动在 MainWindow 的定时器，这里只给三个口） ----

    @property
    def current_scene_id(self) -> str:
        return self._sl_space.scene_id if self._sl_space else ""

    def set_sync_status(self, text: str) -> None:
        """把连接状态摆到界面上。断了必须看得见——静默掉线是最难查的一种坏。"""
        if getattr(self, "_sl_sync_status", None) is not None:
            self._sl_sync_status.setText(text)

    def sync_lighting_snapshot(self) -> dict | None:
        """当前这份 lighting（工作副本本体，调用方只读不改）。没配 lighting 则 None。"""
        return self._sc_lighting

    def sync_selected_id(self) -> str | None:
        """本页当前选中那盏灯的 id（没选中 → None）。"""
        l = self._sl_current()
        if not isinstance(l, dict):
            return None
        lid = l.get("id")
        return lid if isinstance(lid, str) and lid else None

    def apply_synced_selection(self, light_id: object) -> None:
        """套用对面的选中：把灯表的行跳到那盏灯上。

        为什么值得单独走一条路：灯一多，「编辑器里选的是哪盏」和「画面上高亮的
        是哪盏」对不上，就等于没法找灯 —— 只能改个参数看画面哪儿变了来反推。

        找不到那个 id 就什么都不做（对面可能刚加了一盏我还没收到）。
        """
        if not isinstance(light_id, str) or not light_id:
            return
        if self.sync_selected_id() == light_id:
            return
        ls = self._sl_lights()
        for i, l in enumerate(ls):
            if isinstance(l, dict) and l.get("id") == light_id:
                self._fill_sl_table(select_row=i)
                return

    def sync_busy(self) -> bool:
        """现在别往里塞对面的数据。

        两种情况：①焦点在灯的表单里（人正在打字，塞进来当场把这次编辑吞了）；
        ②正处于"在画布上定位选中的灯"模式（下一次点击就要落点，参数被换掉会摆到错的灯上）。
        """
        if getattr(self, "_sl_placing", False):
            return True
        app = QApplication.instance()
        fw = app.focusWidget() if app is not None else None
        form = getattr(self, "_sl_form", None)
        if fw is not None and form is not None and (fw is form or form.isAncestorOf(fw)):
            return True
        return False

    def apply_synced_lighting(self, lit: dict) -> None:
        """把对面（游戏）那份整块套进来。只改工作副本 + 入脏，落盘仍由 Save All。"""
        self._sc_lighting = copy.deepcopy(lit)
        keep = self._sl_selected
        self._recompute_light_heights()
        self._sc_lights_fold.set_expanded(bool(self._sc_lighting.get("lights")))
        n = len(self._sc_lighting.get("lights") or [])
        # 尽量保住选中行：同步是每 0.4s 一次的，行一直跳会没法在表里改东西
        self._fill_sl_table(select_row=keep if 0 <= keep < n else (0 if n else -1))
        self._player_shadow_bind.set_lights(self._sc_lighting.get("lights"))
        self._emit_props_changed()
        self._sl_status.setText("↔ 已同步游戏里的灯位（%d 盏）——记得 Save All 才落盘" % n)

    def _on_sl_pull_runtime(self) -> None:
        """立即抓一次（平时靠自动同步）。走 dev server 的同步槽，游戏在哪个浏览器里都行。"""
        expect = self.current_scene_id
        doc, age_ms, err = scene_lights.fetch_sync_doc()
        if err:
            self._sl_status.setText("⚠ %s（游戏跑起来了吗？dev server 在吗？）" % err)
            return
        # 手动抓不受新鲜期限制（人明确要的），但要把岁数说出来——
        # 免得把半天前的残留当成刚摆好的抓进来。
        if scene_lights.is_sync_doc_stale(age_ms):
            mins = int(float(age_ms) / 60000)
            self._sl_status.setText("⚠ 同步槽里这份是 %d 分钟前的（游戏可能没在跑）" % mins)
        self._on_sl_runtime_lighting(doc, expect)

    def _on_sl_runtime_lighting(self, payload: object, expect_scene_id: str) -> None:
        lit, err = scene_lights.validate_pulled_lighting(payload, expect_scene_id)
        if lit is None:
            self._sl_status.setText(f"⚠ 拉取失败：{err}")
            return
        n = len(lit.get("lights") or [])
        cur = len(self._sl_lights())
        r = QMessageBox.question(
            self,
            "从运行时拉取灯位",
            f"用运行时的 lighting 块覆盖本场景（灯 {cur} 盏 → {n} 盏）？\n"
            "天光/雾/显示变换等整块参数一并替换。\n"
            "还没落盘：确认后还要按 Save All（之前可以 Ctrl+Z 撤销）。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if r != QMessageBox.StandardButton.Yes:
            self._sl_status.setText("已取消拉取")
            return
        self._sc_lighting = copy.deepcopy(lit)
        self._sl_selected = -1
        self._recompute_light_heights()
        self._sc_lights_fold.set_expanded(bool(self._sc_lighting.get("lights")))
        self._fill_sl_table(select_row=0 if n else -1)
        self._player_shadow_bind.set_lights(self._sc_lighting.get("lights"))
        self._emit_props_changed()
        self._sl_status.setText(
            f"✓ 已拉取运行时灯位（{n} 盏）——还没落盘，记得 Save All")

    def _writeback_scene_lights(self, sc: dict) -> None:
        """写回。剥掉只给编辑器看的 `_editorHeightWu`（它是从 pos 推出来的派生量，
        不进数据契约）。整块其余字段透传。"""
        if not self._sc_lighting:
            sc.pop("lighting", None)
            self._writeback_player_shadow(sc)
            return
        out = copy.deepcopy(self._sc_lighting)
        for l in out.get("lights") or []:
            l.pop("_editorHeightWu", None)
        sc["lighting"] = out
        self._writeback_player_shadow(sc)

    def _writeback_player_shadow(self, sc: dict) -> None:
        """玩家阴影绑定。None = 不写字段（回落手调单影），不是「不投影」。"""
        b = self._player_shadow_bind.dump()
        if b:
            sc["playerShadowBindings"] = b
        else:
            sc.pop("playerShadowBindings", None)

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
        self._load_scene_lights(st)
        self._fill_lc_table(select_row=0 if pts else -1)
        self.lightcurve_overlay_refresh_requested.emit()

    def commit_scene_staging_to_source(self) -> None:
        """Apply：把场景 staging 中非列表字段提交回模型（含 spawnPoint/spawnPoints）。"""
        src = self._source_scene
        st = self._staging_scene
        if src is None or st is None:
            return
        skip = {"hotspots", "npcs", "zones", "entityGroups"}
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

    # ---- 时段归属（phases）--------------------------------------------------
    # 与 planes 完全同构的一套。语义差别只在候选源与缺省含义的措辞上。

    def _entity_phase_ids_from_data(self, ent: dict) -> list[str]:
        raw = ent.get("phases")
        if not isinstance(raw, list):
            return []
        return [str(x).strip() for x in raw if str(x).strip()]

    def _format_phase_ids_label(self, ids: list[str]) -> str:
        # 空＝缺省，但 NPC 与 热点/zone 的缺省不同，故不写死"所有时段"
        return "、".join(ids) if ids else "（缺省）"

    def _pick_phase_ids(self, current: list[str]) -> list[str] | None:
        dlg = QDialog(self)
        dlg.setWindowTitle("选择时段归属")
        dlg.resize(420, 420)
        lay = QVBoxLayout(dlg)
        hint = QLabel(
            "可多选。写入实体的 phases 字段：实体只在所选时段存在。候选来自 "
            "game_config.dayNight.phases。\n"
            "全不选（清空）= 缺省 —— NPC 缺省是「只在勾了『街上有人』的那几段出没」"
            "（在 Config 页的日夜循环里勾），热点/区域缺省是「所有时段都在」。\n"
            "只在场景勾了「参与日夜循环」时才生效。\n"
            "注意：这是瞬时存在性开关，不会演离场——要 NPC 走到出口再消失，请改用 NPC 日程表。",
        )
        hint.setWordWrap(True)
        lay.addWidget(hint)
        lw = QListWidget(dlg)
        lw.setSelectionMode(QAbstractItemView.SelectionMode.MultiSelection)
        pairs = [(pid, label) for pid, label in self._model.all_time_phase_ids() if pid]
        known = {pid for pid, _ in pairs}
        cur = [x for x in current if x]
        # 保值孤儿项：数据里引用了配置里没有的时段 id，仍列出可去勾，不无声丢。
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

    def _make_phase_ids_row(self, label_attr: str, on_pick, on_clear) -> QWidget:
        """「只读 label + 选择时段… + 清除」行（hotspot/npc/zone 共用）。"""
        row = QWidget()
        rl = QHBoxLayout(row)
        rl.setContentsMargins(0, 0, 0, 0)
        lbl = QLabel(self._format_phase_ids_label([]))
        lbl.setWordWrap(True)
        lbl.setToolTip(
            "时段归属：实体只在所列时段存在。\n"
            "缺省（空）——NPC＝只在勾了「街上有人」的那几段出没；热点/区域＝所有时段都在。\n"
            "候选来自 game_config.dayNight.phases（Config 页维护）；"
            "只在场景开了日夜循环时生效。",
        )
        setattr(self, label_attr, lbl)
        btn_pick = QPushButton("选择时段…")
        btn_pick.setToolTip("多选该实体存在的时段（写入 phases 字段）")
        btn_pick.clicked.connect(on_pick)
        btn_clear = QPushButton("清除")
        btn_clear.setToolTip(
            "清空 phases（回到缺省：NPC=只在「街上有人」的段；热点/区域=所有时段都在）"
        )
        btn_clear.clicked.connect(on_clear)
        rl.addWidget(lbl, 1)
        rl.addWidget(btn_pick)
        rl.addWidget(btn_clear)
        return row

    def _open_hs_phase_ids_picker(self) -> None:
        picked = self._pick_phase_ids(self._hs_phase_ids_pending)
        if picked is None:
            return
        self._hs_phase_ids_pending = picked
        self._hs_phase_ids_label.setText(self._format_phase_ids_label(picked))
        self._emit_props_changed()

    def _clear_hs_phase_ids(self) -> None:
        self._hs_phase_ids_pending = []
        self._hs_phase_ids_label.setText(self._format_phase_ids_label([]))
        self._emit_props_changed()

    def _open_npc_phase_ids_picker(self) -> None:
        picked = self._pick_phase_ids(self._npc_phase_ids_pending)
        if picked is None:
            return
        self._npc_phase_ids_pending = picked
        self._npc_phase_ids_label.setText(self._format_phase_ids_label(picked))
        self._emit_props_changed()

    def _clear_npc_phase_ids(self) -> None:
        self._npc_phase_ids_pending = []
        self._npc_phase_ids_label.setText(self._format_phase_ids_label([]))
        self._emit_props_changed()

    def _open_zn_phase_ids_picker(self) -> None:
        picked = self._pick_phase_ids(self._zn_phase_ids_pending)
        if picked is None:
            return
        self._zn_phase_ids_pending = picked
        self._zn_phase_ids_label.setText(self._format_phase_ids_label(picked))
        self._emit_props_changed()

    def _clear_zn_phase_ids(self) -> None:
        self._zn_phase_ids_pending = []
        self._zn_phase_ids_label.setText(self._format_phase_ids_label([]))
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
        self._hs_id.editingFinished.connect(
            lambda: self._warn_bare_id_change("hotspot", self._hs_id, self._source_hotspot))
        self._hs_type = QComboBox()
        self._hs_type.addItems(
            ["inspect", "pickup", "transition", "npc", "encounter", "act_spot"])
        self._hs_type.setToolTip(
            "act_spot＝身体动词的语境点（躺点 / 跨点）：不出 E 提示，出的是动词提示。")
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
        self._hs_scale = QDoubleSpinBox()
        self._hs_scale.setRange(0.05, 20.0); self._hs_scale.setDecimals(2)
        self._hs_scale.setSingleStep(0.05); self._hs_scale.setValue(1.0)
        self._hs_scale.setToolTip(
            "实例等比缩放（quad 级真变换，绕脚底锚点）：展示图/碰撞/交互半径/阴影随动；"
            "缺省 1 不写入 JSON。运行时可经 setEntityField 改并入档。")
        self._hs_scale.valueChanged.connect(self._on_hs_transform_live)
        form.addRow("scale", self._hs_scale)
        self._hs_rot = QDoubleSpinBox()
        self._hs_rot.setRange(-360.0, 360.0); self._hs_rot.setDecimals(1)
        self._hs_rot.setSingleStep(5.0); self._hs_rot.setValue(0.0)
        self._hs_rot.setToolTip(
            "实例旋转（度，绕脚底锚点）：quad 级真变换同上；缺省 0 不写入 JSON。")
        self._hs_rot.valueChanged.connect(self._on_hs_transform_live)
        form.addRow("rotation°", self._hs_rot)
        self._hs_persp = QComboBox()
        self._hs_persp.addItem("缺省（不参与）", None)
        self._hs_persp.addItem("参与", True)
        self._hs_persp.addItem("不参与", False)
        self._hs_persp.setToolTip(
            "场景透视缩放（perspectiveScale）参与开关：热点缺省不参与——多为贴背景 WYSIWYG "
            "绘制、贴墙热点脚底 y 也不代表真实深度；地面道具（displayImage、会被移动）可选「参与」。"
            "场景未启用透视缩放时本项无效果。")
        self._hs_persp.currentIndexChanged.connect(self._on_hs_persp_changed)
        form.addRow("透视缩放", self._hs_persp)
        self._hs_auto = QCheckBox(); form.addRow("autoTrigger", self._hs_auto)
        self._hs_auto.stateChanged.connect(lambda _s: self._emit_props_changed())
        self._hs_cast_shadow = QCheckBox("投射阴影 + 接触AO")
        self._hs_cast_shadow.setToolTip(
            "缺省开启：有展示图的热区在地面投射阴影并带脚下接触 AO。"
            "关闭则此热区不投影也无接触 AO（仅对有展示图的热区有效）。"
        )
        self._hs_cast_shadow.stateChanged.connect(lambda _s: self._emit_props_changed())
        form.addRow("castShadow", self._hs_cast_shadow)
        self._hs_shadow_bind = ShadowBindingsEditor(self._emit_props_changed, self)
        form.addRow("阴影绑定", self._hs_shadow_bind)
        # 遮挡混合系数：缺省用场景默认（当前 0.28）；勾「自定义」写显式 [0,1] 值并脱离 F2 全局滑块
        _hs_occ_tip = (
            "深度遮挡半透明混合系数 [0,1]：被场景深度遮挡的展示图像素 alpha 乘此系数"
            "（0=硬裁切完全隐藏，1=完全不裁）。不勾「自定义」= 用场景默认 0.28，"
            "随 F2 全局遮挡混合滑块联动；勾选后写显式值、不再受全局滑块影响。"
        )
        self._hs_occblend_on = QCheckBox("自定义")
        self._hs_occblend_on.setToolTip(_hs_occ_tip)
        self._hs_occblend = QDoubleSpinBox()
        self._hs_occblend.setRange(0.0, 1.0)
        self._hs_occblend.setDecimals(2)
        self._hs_occblend.setSingleStep(0.05)
        self._hs_occblend.setValue(_OCCLUSION_BLEND_DEFAULT)
        self._hs_occblend.setEnabled(False)
        self._hs_occblend.setMaximumWidth(90)
        self._hs_occblend.setToolTip(_hs_occ_tip)
        self._hs_occblend_on.toggled.connect(self._hs_occblend.setEnabled)
        self._hs_occblend_on.toggled.connect(lambda *_: self._emit_props_changed())
        self._hs_occblend.valueChanged.connect(lambda *_: self._emit_props_changed())
        _hs_occ_row = QWidget()
        _hs_occ_l = QHBoxLayout(_hs_occ_row)
        _hs_occ_l.setContentsMargins(0, 0, 0, 0)
        _hs_occ_l.addWidget(self._hs_occblend_on)
        _hs_occ_l.addWidget(self._hs_occblend)
        _hs_occ_l.addStretch(1)
        form.addRow("遮挡混合", _hs_occ_row)
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
        form.addRow("时段归属", self._make_phase_ids_row(
            "_hs_phase_ids_label",
            self._open_hs_phase_ids_picker,
            self._clear_hs_phase_ids,
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
        # 对话朝向与上面那档「朝向」正交：这条是**进图对话那一下**怎么摆，退出对话即复位。
        # 键写在热点顶层（不在 displayImage 里）：与 NpcDef.dialogueFacing 同名同语义，
        # 热点转 NPC 时能原样搬过去。
        self._hs_dialogue_facing = _make_dialogue_facing_combo("keep")
        self._hs_dialogue_facing.currentIndexChanged.connect(lambda *_: self._emit_props_changed())
        df.addRow("对话朝向(dialogueFacing)", self._hs_dialogue_facing)
        self._hs_disp_sprite_sort = QComboBox()
        self._hs_disp_sprite_sort.addItem("与角色/NPC 同层（按 Y）", "default")
        self._hs_disp_sprite_sort.addItem("永远画在最底层", "back")
        self._hs_disp_sprite_sort.addItem("永远画在最顶层", "front")
        self._hs_disp_sprite_sort.setToolTip(
            "同一实体层内与玩家、NPC 的叠放；最底/最顶仍会在同档热点之间按 Y 细分。\n"
            "画布已按运行时同一条规则预览（展示图贴图读不出来时不生效，与运行时一致）。"
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
        gcombo = ReferencePickerField(
            lambda: dialogue_graph_reference_rows(self._model),
            self,
            allow_empty=True,
            title="选择热点图对话",
            geometry_key="dialogue_graph_reference_picker",
            on_open=lambda gid: open_dialogue_graph_from_widget(self, gid),
            open_tooltip=DIALOGUE_GRAPH_OPEN_TOOLTIP,
        )
        self._hs_inspect_graph_combo = gcombo
        graph_row.addRow("graphId", gcombo)
        self._hs_inspect_entry = ReferencePickerField(
            lambda: dialogue_graph_node_ids(
                self._model, self._hs_inspect_graph_combo.current_value(),
            ),
            self,
            allow_empty=True,
            title="选择热点图对话入口节点",
            geometry_key="dialogue_graph_entry_reference_picker",
        )
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
            sig_widget.value_changed.connect(lambda *_: self._emit_props_changed())
        gcombo.value_changed.connect(lambda *_: self._refresh_inspect_entry_choices())
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

        self._hs_data_stack.addWidget(self._build_act_spot_page())

        self._hs_type.currentTextChanged.connect(self._on_hs_type_changed)

        lay.addStretch(1)
        self._append_entity_delete_footer(lay)
        return root

    _TYPE_TO_DATA_IDX = {
        "inspect": 0, "pickup": 1, "transition": 2, "npc": 3, "encounter": 4,
        "act_spot": 5,
    }

    # ---- act_spot（躺点 / 跨点）------------------------------------------

    def _build_act_spot_page(self) -> QWidget:
        """身体动词的语境点：躺点 / 跨点。坐标一律地图点选，禁手输。"""
        page = QWidget()
        f = compact_form(QFormLayout(page))

        verbs_row = QWidget()
        vl = QHBoxLayout(verbs_row)
        vl.setContentsMargins(0, 0, 0, 0)
        self._hs_spot_verbs: dict[str, QCheckBox] = {}
        for verb, label in (("lie", "躺（躺点）"), ("jump", "跳（跨点）")):
            cb = QCheckBox(label)
            cb.stateChanged.connect(lambda _s: self._emit_props_changed())
            vl.addWidget(cb)
            self._hs_spot_verbs[verb] = cb
        vl.addStretch(1)
        verbs_row.setToolTip("本点支持哪些动词；勾「跳」时必须设落点。")
        f.addRow("verbs", verbs_row)

        self._hs_spot_prompt = RichTextLineEdit(self._model)
        self._hs_spot_prompt.setToolTip("玩家看到的提示词（可含 [tag:…]）；留空则用上面的 label。")
        self._hs_spot_prompt.textChanged.connect(lambda *_: self._emit_props_changed())
        f.addRow("promptKey（提示词）", self._hs_spot_prompt)

        self._hs_spot_facing = QComboBox()
        self._hs_spot_facing.addItem("（保持当前朝向）", "")
        self._hs_spot_facing.addItem("朝左", "left")
        self._hs_spot_facing.addItem("朝右", "right")
        self._hs_spot_facing.setMaximumWidth(180)
        self._hs_spot_facing.currentIndexChanged.connect(lambda _i: self._emit_props_changed())
        f.addRow("facing（起手朝向）", self._hs_spot_facing)

        self._hs_spot_align_xy: dict[str, float] | None = None
        f.addRow("align（对齐点）", self._make_spot_point_row("align"))
        self._hs_spot_landing_xy: dict[str, float] | None = None
        f.addRow("landing（跳跃落点）", self._make_spot_point_row("landing"))

        self._hs_spot_duration = QSpinBox()
        self._hs_spot_duration.setRange(0, 5000)
        self._hs_spot_duration.setMaximumWidth(120)
        self._hs_spot_duration.setToolTip("跨点跳的抛物线时长（ms）；0 = 用 game_config 缺省")
        self._hs_spot_duration.valueChanged.connect(lambda _v: self._emit_props_changed())
        f.addRow("durationMs（跨点跳）", self._hs_spot_duration)

        self._hs_spot_arc = QSpinBox()
        self._hs_spot_arc.setRange(0, 400)
        self._hs_spot_arc.setMaximumWidth(120)
        self._hs_spot_arc.setToolTip("跨点跳的抬升高度；0 = 用 game_config 缺省")
        self._hs_spot_arc.valueChanged.connect(lambda _v: self._emit_props_changed())
        f.addRow("arcHeight（跨点跳）", self._hs_spot_arc)

        self._hs_spot_actions = ActionEditor("actions（动词生效时）")
        self._hs_spot_actions.changed.connect(self._emit_props_changed)
        f.addRow(self._hs_spot_actions)
        self._hs_spot_exit_actions = ActionEditor("exitActions（起身时·仅躺点）")
        self._hs_spot_exit_actions.changed.connect(self._emit_props_changed)
        f.addRow(self._hs_spot_exit_actions)
        return page

    def _make_spot_point_row(self, which: str) -> QWidget:
        """只读坐标显示 + 「在地图上选…」按钮 + 清除（坐标禁手输，走场景点选）。"""
        row = QWidget()
        rl = QHBoxLayout(row)
        rl.setContentsMargins(0, 0, 0, 0)
        lab = QLabel("（未设置）")
        lab.setStyleSheet("color:#888;")
        rl.addWidget(lab, 1)
        pick = QPushButton("在地图上选…")
        pick.setToolTip("在场景预览里点选坐标（禁止手输，避免落到不可走的地方）")
        pick.clicked.connect(lambda: self._pick_spot_point(which))
        rl.addWidget(pick)
        clear = QPushButton("清除")
        clear.clicked.connect(lambda: self._clear_spot_point(which))
        rl.addWidget(clear)
        setattr(self, f"_hs_spot_{which}_label", lab)
        return row

    def _spot_point_get(self, which: str) -> dict[str, float] | None:
        return getattr(self, f"_hs_spot_{which}_xy", None)

    def _spot_point_set(self, which: str, pt: dict[str, float] | None) -> None:
        setattr(self, f"_hs_spot_{which}_xy", pt)
        lab = getattr(self, f"_hs_spot_{which}_label", None)
        if lab is not None:
            lab.setText("（未设置）" if not pt else f"x={pt['x']:.1f}  y={pt['y']:.1f}")

    def _pick_spot_point(self, which: str) -> None:
        sid = self._editing_scene_id or ""
        if not sid:
            QMessageBox.information(self, "提示", "请先打开一个场景。")
            return
        cur = self._spot_point_get(which) or {}
        hs = self._current_data if isinstance(self._current_data, dict) else {}
        dlg = MoveEntityToMapPickerDialog(
            self._model, sid,
            float(cur.get("x", hs.get("x", 0) or 0)),
            float(cur.get("y", hs.get("y", 0) or 0)),
            None, self,
        )
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        x, y = dlg.result_destination()
        self._spot_point_set(which, {"x": round(float(x), 1), "y": round(float(y), 1)})
        self._emit_props_changed()

    def _clear_spot_point(self, which: str) -> None:
        self._spot_point_set(which, None)
        self._emit_props_changed()

    def _load_act_spot_data(self, data: dict) -> None:
        verbs = data.get("verbs") if isinstance(data.get("verbs"), list) else []
        for verb, cb in self._hs_spot_verbs.items():
            cb.blockSignals(True)
            cb.setChecked(verb in verbs)
            cb.blockSignals(False)
        self._hs_spot_prompt.setText(str(data.get("promptKey") or ""))
        facing = str(data.get("facing") or "")
        idx = self._hs_spot_facing.findData(facing)
        self._hs_spot_facing.setCurrentIndex(idx if idx >= 0 else 0)
        for which in ("align", "landing"):
            raw = data.get(which)
            if isinstance(raw, dict) and isinstance(raw.get("x"), (int, float)):
                self._spot_point_set(
                    which, {"x": float(raw.get("x", 0)), "y": float(raw.get("y", 0))})
            else:
                self._spot_point_set(which, None)
        dm = data.get("durationMs")
        self._hs_spot_duration.setValue(int(dm) if isinstance(dm, (int, float)) else 0)
        ah = data.get("arcHeight")
        self._hs_spot_arc.setValue(int(ah) if isinstance(ah, (int, float)) else 0)
        self._hs_spot_actions.set_project_context(self._model, self._editing_scene_id or None)
        self._hs_spot_exit_actions.set_project_context(
            self._model, self._editing_scene_id or None)
        raw_a = data.get("actions")
        self._hs_spot_actions.set_data(raw_a if isinstance(raw_a, list) else [])
        raw_e = data.get("exitActions")
        self._hs_spot_exit_actions.set_data(raw_e if isinstance(raw_e, list) else [])

    def _compose_act_spot_data(self) -> dict:
        out: dict = {"verbs": [v for v, cb in self._hs_spot_verbs.items() if cb.isChecked()]}
        prompt = self._hs_spot_prompt.text().strip()
        if prompt:
            out["promptKey"] = prompt
        facing = str(self._hs_spot_facing.currentData() or "")
        if facing:
            out["facing"] = facing
        for which in ("align", "landing"):
            pt = self._spot_point_get(which)
            if pt:
                out[which] = {"x": pt["x"], "y": pt["y"]}
        if self._hs_spot_duration.value() > 0:
            out["durationMs"] = int(self._hs_spot_duration.value())
        if self._hs_spot_arc.value() > 0:
            out["arcHeight"] = int(self._hs_spot_arc.value())
        acts = self._hs_spot_actions.to_list()
        if acts:
            out["actions"] = acts
        ex = self._hs_spot_exit_actions.to_list()
        if ex:
            out["exitActions"] = ex
        return out

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
        QTimer.singleShot(0, self, self._open_trans_spawn_picker)

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
        # 对话框内的直写绕过撤销栈：通知编辑器做穿越防护（该场景有命令历史则清栈）
        self.scene_directly_written.emit(str(sid))
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
            self._show_panel(self._hotspot_panel)
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
            self._hs_scale.blockSignals(True)
            self._hs_scale.setValue(entity_scale_of(st))
            self._hs_scale.blockSignals(False)
            self._hs_rot.blockSignals(True)
            self._hs_rot.setValue(entity_rotation_deg_of(st))
            self._hs_rot.blockSignals(False)
            self._hs_occblend_on.blockSignals(True)
            self._hs_occblend.blockSignals(True)
            _hs_ob = st.get("occlusionBlendFactor")
            _hs_ob_set = isinstance(_hs_ob, (int, float)) and not isinstance(_hs_ob, bool)
            self._hs_occblend_on.setChecked(_hs_ob_set)
            self._hs_occblend.setValue(float(_hs_ob) if _hs_ob_set else _OCCLUSION_BLEND_DEFAULT)
            self._hs_occblend.setEnabled(_hs_ob_set)
            self._hs_occblend_on.blockSignals(False)
            self._hs_occblend.blockSignals(False)
            self._hs_persp.blockSignals(True)
            _pv = st.get("perspectiveScaleEnabled")
            self._hs_persp.setCurrentIndex(
                0 if not isinstance(_pv, bool) else (1 if _pv else 2))
            self._hs_persp.blockSignals(False)
            self._hs_auto.setChecked(st.get("autoTrigger", False))
            self._hs_cast_shadow.setChecked(st.get("castShadow", True) is not False)
            self._hs_shadow_bind.set_lights((self._sc_lighting or {}).get("lights"))
            self._hs_shadow_bind.load(st.get("shadowBindings"))
            self._hs_cutscene_ids_pending = self._entity_cutscene_ids_from_data(st)
            self._hs_cutscene_ids_label.setText(
                self._format_cutscene_ids_label(self._hs_cutscene_ids_pending),
            )
            self._sync_hs_cutscene_only_checkbox()
            self._hs_plane_ids_pending = self._entity_plane_ids_from_data(st)
            self._hs_plane_ids_label.setText(
                self._format_plane_ids_label(self._hs_plane_ids_pending),
            )
            self._hs_phase_ids_pending = self._entity_phase_ids_from_data(st)
            self._hs_phase_ids_label.setText(
                self._format_phase_ids_label(self._hs_phase_ids_pending),
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
            # dialogueFacing 在热点顶层（不在 displayImage 里），取 st 不取 di
            _load_dialogue_facing_combo(self._hs_dialogue_facing, st, "keep")
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
                gid = str(data.get("graphId") or "").strip()
                self._hs_inspect_mode_actions.blockSignals(True)
                self._hs_inspect_mode_graph.blockSignals(True)
                try:
                    if gid:
                        self._hs_inspect_mode_graph.setChecked(True)
                        self._hs_inspect_graph_combo.set_value(gid)
                        self._set_inspect_entry_choices(gid, str(data.get("entry") or ""))
                    else:
                        self._hs_inspect_mode_actions.setChecked(True)
                        self._set_inspect_entry_choices("", "")
                        self._hs_inspect_graph_combo.set_value("")
                finally:
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
            elif ht == "act_spot":
                self._load_act_spot_data(data)

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

    @staticmethod
    def _write_transform_fields_live(d: dict, scale_v: float, rot_v: float) -> None:
        """staging 实时写入 scale/rotation：缺省值（1 / 0）不写键（哈希基线友好）；
        数值未变时保留原始 int/float 表示——快照命令的 diff 用 Python 相等判，
        看不见"表示级漂移"，live 路径写 float 会静默逃出撤销直接进存盘（审查 P1-D）。"""
        def _put(key: str, val: float, nd: int) -> None:
            v = round(float(val), nd)
            old = d.get(key)
            if (isinstance(old, (int, float)) and not isinstance(old, bool)
                    and float(old) == v):
                return  # 值等价：保原表示
            d[key] = v

        if scale_v != 1.0:
            _put("scale", scale_v, 2)
        else:
            d.pop("scale", None)
        if rot_v != 0.0:
            _put("rotation", rot_v, 1)
        else:
            d.pop("rotation", None)

    def _on_hs_transform_live(self, _v: float) -> None:
        hs = self._pending_hotspot
        if hs is None or self._stack.currentWidget() != self._hotspot_panel:
            return
        self._write_transform_fields_live(
            hs, float(self._hs_scale.value()), float(self._hs_rot.value()))
        eid = str(hs.get("id", ""))
        self._emit_props_changed()
        if eid:
            # 复用展示图刷新链路：读 staging 重摆展示图/碰撞（含实例 transform）
            self.hotspot_visual_refresh_requested.emit(eid)
            self.interaction_range_changed.emit(
                "hotspot", eid, float(hs.get("interactionRange", 50) or 0))

    def _on_hs_persp_changed(self, _i: int) -> None:
        hs = self._pending_hotspot
        if hs is None or self._stack.currentWidget() != self._hotspot_panel:
            return
        v = self._hs_persp.currentData()
        if v is None:
            hs.pop("perspectiveScaleEnabled", None)
        else:
            hs["perspectiveScaleEnabled"] = bool(v)
        eid = str(hs.get("id", ""))
        self._emit_props_changed()
        if eid:
            # 参与态翻转即时反映到展示图/交互圈（复用实例 transform 的 live 刷新链路）
            self.hotspot_visual_refresh_requested.emit(eid)
            self.interaction_range_changed.emit(
                "hotspot", eid, float(hs.get("interactionRange", 50) or 0))

    def _on_npc_persp_changed(self, _i: int) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return
        v = self._npc_persp.currentData()
        if v is None:
            npc.pop("perspectiveScaleEnabled", None)
        else:
            npc["perspectiveScaleEnabled"] = bool(v)
        eid = str(npc.get("id", ""))
        self._emit_props_changed()
        if eid:
            self.npc_xy_live_changed.emit(eid)
            self.interaction_range_changed.emit(
                "npc", eid, float(npc.get("interactionRange", 50) or 0))

    def _on_npc_sprite_sort_changed(self, _i: int) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return
        v = self._npc_sprite_sort.currentData()
        if v in ("back", "front"):
            npc["spriteSort"] = v
        else:
            npc.pop("spriteSort", None)
        self._emit_props_changed()

    def _on_npc_transform_live(self, _v: float) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return
        self._write_transform_fields_live(
            npc, float(self._npc_scale.value()), float(self._npc_rot.value()))
        eid = str(npc.get("id", ""))
        self._emit_props_changed()
        if eid:
            # 精灵预览由动画 tick 从 staging 自动同步；这里刷新碰撞/交互圈
            self.npc_xy_live_changed.emit(eid)
            self.interaction_range_changed.emit(
                "npc", eid, float(npc.get("interactionRange", 50) or 0))

    def sync_transform_widgets(self, kind: str, eid: str, s: float, rot: float) -> None:
        """gizmo 拖动时反向同步数值框（blockSignals，防回写环）。"""
        if kind == "hotspot":
            hs = self._staging_hotspot
            if (hs is None or str(hs.get("id", "")) != str(eid)
                    or self._stack.currentWidget() != self._hotspot_panel):
                return
            pairs = ((self._hs_scale, s), (self._hs_rot, rot))
        elif kind == "npc":
            npc = self._staging_npc
            if (npc is None or str(npc.get("id", "")) != str(eid)
                    or self._stack.currentWidget() != self._npc_panel):
                return
            pairs = ((self._npc_scale, s), (self._npc_rot, rot))
        else:
            return
        for w, v in pairs:
            w.blockSignals(True)
            w.setValue(float(v))
            w.blockSignals(False)

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
        # 数值保真：值未变按原始 int/float 表示回写（int 1000 不漂成 1000.0；审查 P1-09）。
        hs["x"] = self._keep_num(self._hs_x.value(), hs.get("x"))
        hs["y"] = self._keep_num(self._hs_y.value(), hs.get("y"))
        hs["interactionRange"] = self._keep_num(self._hs_range.value(), hs.get("interactionRange"))
        # 实例 transform：缺省值不写键（保住哈希基线与字节级往返）
        _s_val = float(self._hs_scale.value())
        if _s_val != 1.0:
            hs["scale"] = self._keep_num(round(_s_val, 2), hs.get("scale"))
        else:
            hs.pop("scale", None)
        _r_val = float(self._hs_rot.value())
        if _r_val != 0.0:
            hs["rotation"] = self._keep_num(round(_r_val, 1), hs.get("rotation"))
        else:
            hs.pop("rotation", None)
        # 遮挡混合系数：仅「自定义」勾选时写显式 [0,1]，否则删除键（用场景默认）
        if self._hs_occblend_on.isChecked():
            hs["occlusionBlendFactor"] = self._keep_num(
                round(float(self._hs_occblend.value()), 2), hs.get("occlusionBlendFactor"))
        else:
            hs.pop("occlusionBlendFactor", None)
        # 透视缩放参与：缺省不写键（热点缺省不参与），显式选择才落 true/false
        _hp = self._hs_persp.currentData()
        if _hp is None:
            hs.pop("perspectiveScaleEnabled", None)
        else:
            hs["perspectiveScaleEnabled"] = bool(_hp)
        if self._hs_auto.isChecked():
            hs["autoTrigger"] = True
        elif "autoTrigger" in hs:
            del hs["autoTrigger"]
        # castShadow 缺省开：仅取消勾选才落 false，勾选时省略字段（保持 JSON 干净 + 默认开）
        if not self._hs_cast_shadow.isChecked():
            hs["castShadow"] = False
        elif "castShadow" in hs:
            del hs["castShadow"]
        # 阴影绑定：控件给 None = 不写字段（回落手调单影）；
        # 「不投影」与「不写字段」是两回事，别在这里合并
        _hs_sb = self._hs_shadow_bind.dump()
        if _hs_sb:
            hs["shadowBindings"] = _hs_sb
        else:
            hs.pop("shadowBindings", None)
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
        hs_phases = [x for x in self._hs_phase_ids_pending if str(x).strip()]
        if hs_phases:
            hs["phases"] = hs_phases
        else:
            hs.pop("phases", None)  # 缺省=所有时段都在
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
        _write_dialogue_facing_combo(self._hs_dialogue_facing, hs, "keep")
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
        # 去所有权化(2026-07-13):data 重建时不再抹未知键——managed 取全类型已知键
        # 并集(换类型时旧类型的键必须被清理,不能当"未知"保留);inspect 的 data.text
        # 等 AI 写入、面板不编辑的键自此在人类 Apply 后存活。
        from ..shared.rebuild_merge import merge_preserving_unknown
        _managed_data_keys = {
            "graphId", "entry", "actions",
            "itemId", "itemName", "count", "isCurrency",
            "targetScene", "targetSpawnPoint", "npcId", "encounterId",
            # act_spot
            "verbs", "align", "facing", "landing", "promptKey", "exitActions",
            "durationMs", "arcHeight",
        }
        old_data = hs.get("data")
        if ht == "inspect":
            acts = self._hs_inspect_actions.to_list()
            if self._hs_inspect_mode_graph.isChecked():
                gid = self._hs_inspect_graph_combo.current_value().strip()
                new_data: dict = {}
                if gid:
                    new_data["graphId"] = gid
                ent = self._hs_inspect_entry.current_value().strip()
                if ent:
                    new_data["entry"] = ent
                if acts:
                    new_data["actions"] = acts
                hs["data"] = merge_preserving_unknown(old_data, new_data, _managed_data_keys)
            else:
                new_data = {}
                if acts:
                    new_data["actions"] = acts
                hs["data"] = merge_preserving_unknown(old_data, new_data, _managed_data_keys)
        elif ht == "pickup":
            new_data = {
                "itemId": self._hs_pickup_item.current_id(),
                "itemName": self._hs_pickup_name.text(),
                "count": self._hs_pickup_count.value(),
            }
            if self._hs_pickup_currency.isChecked():
                new_data["isCurrency"] = True
            hs["data"] = merge_preserving_unknown(old_data, new_data, _managed_data_keys)
        elif ht == "transition":
            tid = self._hs_trans_scene.current_id()
            new_data = {"targetScene": tid}
            sp = self._hs_trans_spawn_key.strip()
            if sp:
                new_data["targetSpawnPoint"] = sp
            hs["data"] = merge_preserving_unknown(old_data, new_data, _managed_data_keys)
        elif ht == "npc":
            hs["data"] = merge_preserving_unknown(
                old_data, {"npcId": self._hs_npc_id.current_id()}, _managed_data_keys)
        elif ht == "encounter":
            hs["data"] = merge_preserving_unknown(
                old_data, {"encounterId": self._hs_enc_id.current_id()}, _managed_data_keys)
        elif ht == "act_spot":
            hs["data"] = merge_preserving_unknown(
                old_data, self._compose_act_spot_data(), _managed_data_keys)
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
        self._npc_id.editingFinished.connect(
            lambda: self._warn_bare_id_change("npc", self._npc_id, self._source_npc))
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
        self._npc_dialogue_graph = ReferencePickerField(
            lambda: dialogue_graph_reference_rows(self._model),
            self,
            allow_empty=True,
            title="选择 NPC 图对话",
            geometry_key="dialogue_graph_reference_picker",
            on_open=lambda gid: open_dialogue_graph_from_widget(self, gid),
            open_tooltip=DIALOGUE_GRAPH_OPEN_TOOLTIP,
        )
        self._npc_dialogue_graph.setToolTip("对应 public/assets/dialogues/graphs/<id>.json")
        self._npc_dialogue_graph.value_changed.connect(lambda _x: self._emit_props_changed())
        self._npc_dialogue_graph.value_changed.connect(
            lambda _x: self._refresh_npc_dialogue_entry_choices())
        form.addRow("dialogueGraphId", self._npc_dialogue_graph)
        self._npc_dialogue_graph_entry = ReferencePickerField(
            lambda: dialogue_graph_node_ids(
                self._model, self._npc_dialogue_graph.current_value(),
            ),
            self,
            allow_empty=True,
            title="选择 NPC 图对话入口节点",
            geometry_key="dialogue_graph_entry_reference_picker",
        )
        self._npc_dialogue_graph_entry.setToolTip(
            "可选：从当前 dialogueGraphId 的 nodes 中搜索选择；留空使用图默认 entry。",
        )
        self._npc_dialogue_graph_entry.value_changed.connect(
            lambda *_: self._emit_props_changed())
        form.addRow("dialogueGraphEntry", self._npc_dialogue_graph_entry)
        self._npc_dialogue_facing = _make_dialogue_facing_combo("player")
        self._npc_dialogue_facing.currentIndexChanged.connect(lambda *_: self._emit_props_changed())
        form.addRow("对话朝向(dialogueFacing)", self._npc_dialogue_facing)
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
        self._npc_scale = QDoubleSpinBox()
        self._npc_scale.setRange(0.05, 20.0); self._npc_scale.setDecimals(2)
        self._npc_scale.setSingleStep(0.05); self._npc_scale.setValue(1.0)
        self._npc_scale.setToolTip(
            "实例等比缩放（quad 级真变换，绕脚底锚点）：精灵/碰撞/交互半径/阴影随动；"
            "缺省 1 不写入 JSON。运行时可经 setEntityField 改并入档。")
        self._npc_scale.valueChanged.connect(self._on_npc_transform_live)
        form.addRow("scale", self._npc_scale)
        self._npc_rot = QDoubleSpinBox()
        self._npc_rot.setRange(-360.0, 360.0); self._npc_rot.setDecimals(1)
        self._npc_rot.setSingleStep(5.0); self._npc_rot.setValue(0.0)
        self._npc_rot.setToolTip(
            "实例旋转（度，绕脚底锚点）：quad 级真变换同上；缺省 0 不写入 JSON。")
        self._npc_rot.valueChanged.connect(self._on_npc_transform_live)
        form.addRow("rotation°", self._npc_rot)
        # 遮挡混合系数：缺省用场景默认（当前 0.28）；勾「自定义」写显式 [0,1] 值并脱离 F2 全局滑块
        _npc_occ_tip = (
            "深度遮挡半透明混合系数 [0,1]：被场景深度遮挡的精灵像素 alpha 乘此系数"
            "（0=硬裁切完全隐藏，1=完全不裁）。不勾「自定义」= 用场景默认 0.28，"
            "随 F2 全局遮挡混合滑块联动；勾选后写显式值、不再受全局滑块影响。"
        )
        self._npc_occblend_on = QCheckBox("自定义")
        self._npc_occblend_on.setToolTip(_npc_occ_tip)
        self._npc_occblend = QDoubleSpinBox()
        self._npc_occblend.setRange(0.0, 1.0)
        self._npc_occblend.setDecimals(2)
        self._npc_occblend.setSingleStep(0.05)
        self._npc_occblend.setValue(_OCCLUSION_BLEND_DEFAULT)
        self._npc_occblend.setEnabled(False)
        self._npc_occblend.setMaximumWidth(90)
        self._npc_occblend.setToolTip(_npc_occ_tip)
        self._npc_occblend_on.toggled.connect(self._npc_occblend.setEnabled)
        self._npc_occblend_on.toggled.connect(lambda *_: self._emit_props_changed())
        self._npc_occblend.valueChanged.connect(lambda *_: self._emit_props_changed())
        _npc_occ_row = QWidget()
        _npc_occ_l = QHBoxLayout(_npc_occ_row)
        _npc_occ_l.setContentsMargins(0, 0, 0, 0)
        _npc_occ_l.addWidget(self._npc_occblend_on)
        _npc_occ_l.addWidget(self._npc_occblend)
        _npc_occ_l.addStretch(1)
        form.addRow("遮挡混合", _npc_occ_row)
        self._npc_persp = QComboBox()
        self._npc_persp.addItem("缺省（参与；renderRaw 不参与）", None)
        self._npc_persp.addItem("参与", True)
        self._npc_persp.addItem("不参与", False)
        self._npc_persp.setToolTip(
            "场景透视缩放（perspectiveScale）参与开关：NPC 缺省参与（脚底 y 即深度）；"
            "renderRaw 背景抠图实体缺省不参与（透视已烤进背景）。贴墙/悬空装饰可选「不参与」。"
            "场景未启用透视缩放时本项无效果。")
        self._npc_persp.currentIndexChanged.connect(self._on_npc_persp_changed)
        form.addRow("透视缩放", self._npc_persp)
        self._npc_sprite_sort = QComboBox()
        self._npc_sprite_sort.addItem("与角色/NPC 同层（按 Y）", "default")
        self._npc_sprite_sort.addItem("永远画在最底层", "back")
        self._npc_sprite_sort.addItem("永远画在最顶层", "front")
        self._npc_sprite_sort.setToolTip(
            "同一实体层内与玩家、其它 NPC、热点展示图的叠放；"
            "最底/最顶仍会在同档实体之间按 Y 细分。与热点展示图的「精灵排序」同语义。\n"
            "贴背景的群像/前景路人需要它——它们与背景的前后关系是画出来的，按 Y 排会穿帮。\n"
            "画布已按运行时同一条规则预览。"
        )
        self._npc_sprite_sort.currentIndexChanged.connect(self._on_npc_sprite_sort_changed)
        form.addRow("精灵排序", self._npc_sprite_sort)
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
        form.addRow("时段归属", self._make_phase_ids_row(
            "_npc_phase_ids_label",
            self._open_npc_phase_ids_picker,
            self._clear_npc_phase_ids,
        ))
        self._npc_cast_shadow = QCheckBox("投射阴影 + 接触AO")
        self._npc_cast_shadow.setToolTip(
            "缺省开启：该 NPC 在地面投射阴影并带脚下接触 AO。关闭则此 NPC 不投影也无接触 AO。"
        )
        self._npc_cast_shadow.stateChanged.connect(lambda _s: self._emit_props_changed())
        form.addRow("castShadow", self._npc_cast_shadow)
        # 阴影绑定：**手动指定光源**，系统不自动 resolve（制作人 2026-08-20）
        self._npc_shadow_bind = ShadowBindingsEditor(self._emit_props_changed, self)
        form.addRow("阴影绑定", self._npc_shadow_bind)
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

        play_box = CollapsibleSection("初始播放参数（可选）", start_open=False)
        play_box.set_header_tool_tip(
            "仅进场起播 initialAnimState 那一次生效（调速/倒放/定格/错相）；"
            "之后动作/巡逻/对话切动画会恢复默认参数")
        play_inner = QWidget()
        play_f = compact_form(QFormLayout(play_inner))
        self._npc_anim_speed = QDoubleSpinBox()
        self._npc_anim_speed.setRange(0.1, 10.0)
        self._npc_anim_speed.setDecimals(2)
        self._npc_anim_speed.setSingleStep(0.1)
        self._npc_anim_speed.setValue(1.0)
        self._npc_anim_speed.setMaximumWidth(90)
        self._npc_anim_speed.setToolTip(
            "播放速度倍率：1=原速（缺省不写键）。\n同包多拷贝各给 0.85/1.0/1.15 可打散机械同步感。")
        self._npc_anim_speed.valueChanged.connect(self._on_npc_anim_playback_changed)
        play_f.addRow("speed", self._npc_anim_speed)
        self._npc_anim_reverse = QCheckBox("倒放")
        self._npc_anim_reverse.setToolTip("从末帧向首帧播放（倒转的水车/机关等）；缺省不写键。")
        self._npc_anim_reverse.toggled.connect(self._on_npc_anim_playback_changed)
        play_f.addRow("reverse", self._npc_anim_reverse)
        self._npc_anim_hold = QSpinBox()
        self._npc_anim_hold.setRange(-1, 9999)
        self._npc_anim_hold.setValue(-1)
        self._npc_anim_hold.setMaximumWidth(90)
        self._npc_anim_hold.setToolTip(
            "定格帧（0 基）：≥0 停在此帧不播放（尸体/泥塑等静态摆 pose）；-1=不定格。\n定格时其余三项不生效。")
        self._npc_anim_hold.valueChanged.connect(self._on_npc_anim_playback_changed)
        play_f.addRow("holdFrame", self._npc_anim_hold)
        self._npc_anim_start = QSpinBox()
        self._npc_anim_start.setRange(-1, 9999)
        self._npc_anim_start.setValue(-1)
        self._npc_anim_start.setMaximumWidth(90)
        self._npc_anim_start.setToolTip(
            "起播帧（0 基）：从此帧开始循环——同包多拷贝依次填 0/5/10…错开相位；-1=默认起点。")
        self._npc_anim_start.valueChanged.connect(self._on_npc_anim_playback_changed)
        play_f.addRow("startFrame", self._npc_anim_start)
        play_box.add_body(play_inner)
        self._npc_anim_play_fold = play_box
        outer.addWidget(play_box)

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
            "动画仅在主画布上播放（脚底对齐 x,y）；侧栏编辑 animFile / initialAnimState / 初始播放参数。"
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

    def _sync_npc_anim_playback_to_dict(self, npc: dict) -> None:
        """初始播放参数（speed/reverse/holdFrame/startFrame）：全部中性默认时不写键，
        只写非默认项（speed=1、未勾倒放、-1 哨兵均视为未设）。"""
        out: dict = {}
        spd = round(float(self._npc_anim_speed.value()), 4)
        if abs(spd - 1.0) > 1e-9:
            out["speed"] = int(spd) if float(spd).is_integer() else spd
        if self._npc_anim_reverse.isChecked():
            out["reverse"] = True
        hold = int(self._npc_anim_hold.value())
        if hold >= 0:
            out["holdFrame"] = hold
        start = int(self._npc_anim_start.value())
        if start >= 0:
            out["startFrame"] = start
        if out:
            npc["initialAnimPlayback"] = out
        elif "initialAnimPlayback" in npc:
            del npc["initialAnimPlayback"]

    def _on_npc_anim_playback_changed(self, *_a) -> None:
        npc = self._pending_npc
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return
        self._sync_npc_anim_playback_to_dict(npc)
        self._emit_props_changed()

    def _load_npc_anim_playback_ui(self, npc: dict) -> None:
        raw = npc.get("initialAnimPlayback")
        d = raw if isinstance(raw, dict) else {}
        try:
            spd = float(d.get("speed", 1.0))
        except (TypeError, ValueError):
            spd = 1.0
        if not (spd > 0):
            spd = 1.0

        def _int_or(v: object, fallback: int) -> int:
            try:
                iv = int(float(v))  # type: ignore[arg-type]
            except (TypeError, ValueError):
                return fallback
            return iv if iv >= 0 else fallback

        for w in (self._npc_anim_speed, self._npc_anim_reverse,
                  self._npc_anim_hold, self._npc_anim_start):
            w.blockSignals(True)
        try:
            self._npc_anim_speed.setValue(spd)
            self._npc_anim_reverse.setChecked(d.get("reverse") is True)
            self._npc_anim_hold.setValue(_int_or(d.get("holdFrame"), -1))
            self._npc_anim_start.setValue(_int_or(d.get("startFrame"), -1))
        finally:
            for w in (self._npc_anim_speed, self._npc_anim_reverse,
                      self._npc_anim_hold, self._npc_anim_start):
                w.blockSignals(False)
        self._npc_anim_play_fold.set_expanded(bool(d))

    # --- entry / 动画 state 节点选择器（候选取自模型，保留已存值） -------------
    def _set_inspect_entry_choices(self, graph_id: str, entry_value: str) -> None:
        self._hs_inspect_entry.set_value((entry_value or "").strip())
        self._hs_inspect_entry.refresh_display()

    def _refresh_inspect_entry_choices(self) -> None:
        self._set_inspect_entry_choices(
            self._hs_inspect_graph_combo.current_value().strip(),
            self._hs_inspect_entry.current_value())

    def _set_npc_dialogue_entry_choices(self, graph_id: str, entry_value: str) -> None:
        self._npc_dialogue_graph_entry.set_value(entry_value or "")
        self._npc_dialogue_graph_entry.refresh_display()

    def _refresh_npc_dialogue_entry_choices(self) -> None:
        self._set_npc_dialogue_entry_choices(
            self._npc_dialogue_graph.current_value().strip(),
            self._npc_dialogue_graph_entry.current_value())

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
            self._show_panel(self._npc_panel)
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
            cur_g = str(st.get("dialogueGraphId", "") or "").strip()
            self._npc_dialogue_graph.set_value(cur_g)
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
            self._npc_scale.blockSignals(True)
            self._npc_scale.setValue(entity_scale_of(st))
            self._npc_scale.blockSignals(False)
            self._npc_rot.blockSignals(True)
            self._npc_rot.setValue(entity_rotation_deg_of(st))
            self._npc_rot.blockSignals(False)
            self._npc_occblend_on.blockSignals(True)
            self._npc_occblend.blockSignals(True)
            _npc_ob = st.get("occlusionBlendFactor")
            _npc_ob_set = isinstance(_npc_ob, (int, float)) and not isinstance(_npc_ob, bool)
            self._npc_occblend_on.setChecked(_npc_ob_set)
            self._npc_occblend.setValue(float(_npc_ob) if _npc_ob_set else _OCCLUSION_BLEND_DEFAULT)
            self._npc_occblend.setEnabled(_npc_ob_set)
            self._npc_occblend_on.blockSignals(False)
            self._npc_occblend.blockSignals(False)
            self._npc_persp.blockSignals(True)
            _pv = st.get("perspectiveScaleEnabled")
            self._npc_persp.setCurrentIndex(
                0 if not isinstance(_pv, bool) else (1 if _pv else 2))
            self._npc_persp.blockSignals(False)
            _nss = str(st.get("spriteSort", "") or "default").strip().lower()
            self._npc_sprite_sort.blockSignals(True)
            self._npc_sprite_sort.setCurrentIndex(
                1 if _nss == "back" else (2 if _nss == "front" else 0))
            self._npc_sprite_sort.blockSignals(False)
            self._npc_cutscene_ids_pending = self._entity_cutscene_ids_from_data(st)
            self._npc_cutscene_ids_label.setText(
                self._format_cutscene_ids_label(self._npc_cutscene_ids_pending),
            )
            self._sync_npc_cutscene_only_checkbox()
            self._npc_plane_ids_pending = self._entity_plane_ids_from_data(st)
            self._npc_plane_ids_label.setText(
                self._format_plane_ids_label(self._npc_plane_ids_pending),
            )
            self._npc_phase_ids_pending = self._entity_phase_ids_from_data(st)
            self._npc_phase_ids_label.setText(
                self._format_phase_ids_label(self._npc_phase_ids_pending),
            )
            self._npc_cond.set_flag_pattern_context(self._model, self._editing_scene_id or None)
            self._npc_cond.set_data(st.get("conditions", []))
            self._npc_cond_hide_entity.blockSignals(True)
            self._npc_cond_hide_entity.setChecked(st.get("conditionHidesEntity", False) is True)
            self._npc_cond_hide_entity.blockSignals(False)
            self._npc_cast_shadow.blockSignals(True)
            self._npc_cast_shadow.setChecked(st.get("castShadow", True) is not False)
            self._npc_shadow_bind.set_lights((self._sc_lighting or {}).get("lights"))
            self._npc_shadow_bind.load(st.get("shadowBindings"))
            self._npc_cast_shadow.blockSignals(False)
            self._npc_facing.blockSignals(True)
            try:
                cur_f = str(st.get("initialFacing", "") or "").strip().lower()
                idx = self._npc_facing.findData("left" if cur_f == "left" else "right")
                self._npc_facing.setCurrentIndex(idx if idx >= 0 else 0)
            finally:
                self._npc_facing.blockSignals(False)
            _load_dialogue_facing_combo(self._npc_dialogue_facing, st, "player")
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
            self._load_npc_anim_playback_ui(st)
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
        # 数值保真：值未变按原始 int/float 表示回写（审查 P1-09）。
        npc["x"] = self._keep_num(self._npc_x.value(), npc.get("x"))
        npc["y"] = self._keep_num(self._npc_y.value(), npc.get("y"))
        fv = self._npc_facing.currentData()
        if fv == "left":
            npc["initialFacing"] = "left"
        elif "initialFacing" in npc:
            del npc["initialFacing"]
        for k in ("dialogueFile", "dialogueKnot"):
            if k in npc:
                del npc[k]
        dg = self._npc_dialogue_graph.current_value().strip()
        if dg:
            npc["dialogueGraphId"] = dg
        elif "dialogueGraphId" in npc:
            del npc["dialogueGraphId"]
        dge = self._npc_dialogue_graph_entry.current_value().strip()
        if dge:
            npc["dialogueGraphEntry"] = dge
        elif "dialogueGraphEntry" in npc:
            del npc["dialogueGraphEntry"]
        _write_dialogue_facing_combo(self._npc_dialogue_facing, npc, "player")
        zv = float(self._npc_dialogue_zoom.value())
        if abs(zv - 1.0) > 1e-6:
            npc["dialogueCameraZoom"] = zv
        elif "dialogueCameraZoom" in npc:
            del npc["dialogueCameraZoom"]
        # 数值保真：与 hotspot 侧同款（P1-09 当年只修了 hotspot，NPC 面板同病漏修，
        # 已实际把 teahouse int 0 漂成 0.0——审查 P1-3）
        npc["interactionRange"] = self._keep_num(
            self._npc_range.value(), npc.get("interactionRange"))
        # 实例 transform：缺省值不写键（保住哈希基线与字节级往返）
        _s_val = float(self._npc_scale.value())
        if _s_val != 1.0:
            npc["scale"] = self._keep_num(round(_s_val, 2), npc.get("scale"))
        else:
            npc.pop("scale", None)
        _r_val = float(self._npc_rot.value())
        if _r_val != 0.0:
            npc["rotation"] = self._keep_num(round(_r_val, 1), npc.get("rotation"))
        else:
            npc.pop("rotation", None)
        # 遮挡混合系数：仅「自定义」勾选时写显式 [0,1]，否则删除键（用场景默认）
        if self._npc_occblend_on.isChecked():
            npc["occlusionBlendFactor"] = self._keep_num(
                round(float(self._npc_occblend.value()), 2), npc.get("occlusionBlendFactor"))
        else:
            npc.pop("occlusionBlendFactor", None)
        # 透视缩放参与：缺省不写键（NPC 缺省参与、renderRaw 缺省不参与），显式选择才落 true/false
        _np = self._npc_persp.currentData()
        if _np is None:
            npc.pop("perspectiveScaleEnabled", None)
        else:
            npc["perspectiveScaleEnabled"] = bool(_np)
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
        npc_phases = [x for x in self._npc_phase_ids_pending if str(x).strip()]
        if npc_phases:
            npc["phases"] = npc_phases
        else:
            npc.pop("phases", None)  # NPC 缺省=只在标了 daylight 的段（不是全时段）
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
        _npc_sb = self._npc_shadow_bind.dump()
        if _npc_sb:
            npc["shadowBindings"] = _npc_sb
        else:
            npc.pop("shadowBindings", None)
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
        self._sync_npc_anim_playback_to_dict(npc)
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
        self._zn_id.editingFinished.connect(
            lambda: self._warn_bare_id_change("zone", self._zn_id, self._source_zone))
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
        form.addRow("时段归属", self._make_phase_ids_row(
            "_zn_phase_ids_label",
            self._open_zn_phase_ids_picker,
            self._clear_zn_phase_ids,
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

        it_g = self._section("按 E 交互（onInteract）", start_open=False)
        it_g.set_header_tool_tip(
            "走进来什么都不发生，玩家在本区内按 E 才执行（与 onEnter 相反）。\n"
            "配了动作就会在 HUD 底部出提示条。\n"
            "优先级：附近有可交互的热点 / NPC 时它们先接住 E，本区既不出提示也不触发。")
        it_inner = QWidget()
        it_l = QVBoxLayout(it_inner)
        it_form = compact_form(QFormLayout())
        self._zn_interact_label = RichTextLineEdit(self._model)
        self._zn_interact_label.setPlaceholderText("留空 = [E] 察看")
        self._zn_interact_label.setToolTip(
            "提示条文案，方括号里是键帽，如「[E] 掀开草席」。留空取默认文案。")
        self._zn_interact_label.setMaximumWidth(320)
        self._zn_interact_label.textChanged.connect(lambda *_: self._emit_props_changed())
        it_form.addRow("提示文案", self._zn_interact_label)
        it_l.addLayout(it_form)
        self._zn_interact = ActionEditor("onInteract")
        self._zn_interact.changed.connect(self._emit_props_changed)
        it_l.addWidget(self._zn_interact)
        it_g.add_body(it_inner)
        self._zn_interact_fold = it_g
        lay.addWidget(it_g)

        pa_g = self._section("玩家身体动词（onPlayerAct）", start_open=False)
        pa_g.set_header_tool_tip(
            "玩家在本区内蹲 / 注视 / 踢 / 跳 / 躺 时执行；事件驱动，不受 onStay 的 0.25s 节流影响。")
        self._zn_player_act = ZoneActsEditor()
        self._zn_player_act.changed.connect(self._emit_props_changed)
        pa_g.add_body(self._zn_player_act)
        lay.addWidget(pa_g)

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
        for ae in (self._zn_enter, self._zn_stay, self._zn_exit, self._zn_interact):
            ae.setEnabled(not is_depth)
        # depth_floor 仅参与遮挡、无进出触发，按 E 交互与气味同样无意义 → 一并禁用
        self._zn_interact_fold.setEnabled(not is_depth)
        self._zn_smell_fold.setEnabled(not is_depth)

    def _on_zone_kind_changed(self, _idx: int) -> None:
        new_kind = self._zn_kind.currentData() or "standard"
        # 程序化载入（load_zone_props 在 suppress 内）不弹确认，只同步 UI 与基线。
        if self._props_changed_suppressed:
            self._zn_kind_last = new_kind
            self._apply_zone_kind_ui()
            return
        prev = getattr(self, "_zn_kind_last", "standard")
        if new_kind != prev and not self._confirm_zone_kind_switch(prev, new_kind):
            # 用户取消：退回原类型（阻断信号避免递归）。
            self._zn_kind.blockSignals(True)
            try:
                idx = self._zn_kind.findData(prev)
                self._zn_kind.setCurrentIndex(idx if idx >= 0 else 0)
            finally:
                self._zn_kind.blockSignals(False)
            self._apply_zone_kind_ui()
            return
        self._zn_kind_last = new_kind
        self._apply_zone_kind_ui()
        self._emit_props_changed()

    def _confirm_zone_kind_switch(self, prev: str, new_kind: str) -> bool:
        """切换区域类型会丢字段时先确认（审查 P3）。
        → depth_floor：清空 onEnter/onStay/onExit/smell；← depth_floor：丢 floorOffsetBoost。"""
        if new_kind == "depth_floor":
            # onPlayerAct 也算（确认文案里本来就写了它会丢，判据却漏了 → 只配了动词的区
            # 切类型时会静默丢数据）
            has_actions = bool(
                self._zn_enter.to_list() or self._zn_stay.to_list() or self._zn_exit.to_list()
                or self._zn_interact.to_list() or self._zn_player_act.to_dict())
            has_smell = bool(self._zn_smell_scent.committed_type().strip())
            if not (has_actions or has_smell):
                return True
            lost = []
            if has_actions:
                lost.append("onEnter / onStay / onExit / onInteract / onPlayerAct 动作")
            if has_smell:
                lost.append("区域气味 smell")
            return QMessageBox.question(
                self, "切换区域类型",
                "切到「深度 floor 修正」会清空本区的：\n· " + "\n· ".join(lost)
                + "\n\n确定切换？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            ) == QMessageBox.StandardButton.Yes
        if prev == "depth_floor":
            try:
                boost = float(self._zn_boost.value())
            except (TypeError, ValueError):
                boost = 0.0
            if boost == 0.0:
                return True
            return QMessageBox.question(
                self, "切换区域类型",
                f"切回普通区域会丢弃 floorOffsetBoost（当前 {boost:g}）。\n确定切换？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            ) == QMessageBox.StandardButton.Yes
        return True

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
            self._show_panel(self._zone_panel)
            self._zn_id.setText(st.get("id", ""))
            self._zn_plane_ids_pending = self._entity_plane_ids_from_data(st)
            self._zn_plane_ids_label.setText(
                self._format_plane_ids_label(self._zn_plane_ids_pending),
            )
            self._zn_phase_ids_pending = self._entity_phase_ids_from_data(st)
            self._zn_phase_ids_label.setText(
                self._format_phase_ids_label(self._zn_phase_ids_pending),
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
            self._zn_interact.set_project_context(self._model, self._editing_scene_id or None)
            self._zn_enter.set_data(st.get("onEnter", []))
            self._zn_stay.set_data(st.get("onStay", []))
            self._zn_interact.set_data(st.get("onInteract", []))
            self._zn_interact_label.setText(str(st.get("interactLabel", "") or ""))
            self._zn_player_act.set_project_context(
                self._model, self._editing_scene_id or None)
            self._zn_player_act.set_data(st.get("onPlayerAct"))
            self._zn_exit.set_data(st.get("onExit", []))
            idx = self._zn_kind.findData(st.get("zoneKind") or "standard")
            self._zn_kind.setCurrentIndex(idx if idx >= 0 else 0)
            # 基线：切换类型确认对话框以此判「从哪切到哪」（setCurrentIndex 未变时不触发信号）。
            self._zn_kind_last = str(st.get("zoneKind") or "standard")
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
            oi = st.get("onInteract") or []
            self._zn_interact_fold.set_expanded(
                bool(isinstance(oi, list) and len(oi) > 0))
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
        zn_phases = [x for x in self._zn_phase_ids_pending if str(x).strip()]
        if zn_phases:
            zone["phases"] = zn_phases
        else:
            zone.pop("phases", None)  # 缺省=所有时段都在
        poly = self._zone_polygon_from_table()
        if len(poly) >= 3:
            zone["polygon"] = poly
        for k in ("x", "y", "width", "height"):
            zone.pop(k, None)
        kind = self._zn_kind.currentData() or "standard"
        if kind == "depth_floor":
            zone["zoneKind"] = "depth_floor"
            zone["floorOffsetBoost"] = self._zn_boost.value()
            for k in ("onEnter", "onStay", "onExit", "smell", "onPlayerAct",
                      "onInteract", "interactLabel"):
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
            oi = self._zn_interact.to_list()
            if oi:
                zone["onInteract"] = oi
            elif "onInteract" in zone:
                del zone["onInteract"]
            # 文案只在真有 onInteract 时才有意义：动作清空则文案一并清，不留孤字段
            il = self._zn_interact_label.text().strip()
            if il and oi:
                zone["interactLabel"] = il
            elif "interactLabel" in zone:
                del zone["interactLabel"]
            opa = self._zn_player_act.to_dict()
            if opa:
                zone["onPlayerAct"] = opa
            elif "onPlayerAct" in zone:
                del zone["onPlayerAct"]
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

    # ---- scene entity group props ---------------------------------------

    def _build_group_panel(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setAlignment(Qt.AlignmentFlag.AlignTop)

        basic = self._section("场景分组", start_open=True)
        inner = QWidget()
        form = compact_form(QFormLayout(inner))
        self._grp_id = QLineEdit()
        self._grp_id.setMaximumWidth(260)
        self._grp_id.setToolTip("分组自身 id；成员的 group 字段引用它。限定引用格式为 sceneId:groupId。")
        self._grp_id.textChanged.connect(self._on_group_props_changed)
        self._grp_id.editingFinished.connect(self._validate_group_id_edit)
        form.addRow("id", self._grp_id)
        self._grp_label = QLineEdit()
        self._grp_label.setMaximumWidth(320)
        self._grp_label.setPlaceholderText("可选显示名")
        self._grp_label.textChanged.connect(self._on_group_props_changed)
        form.addRow("label", self._grp_label)
        self._grp_legacy_note = QLabel()
        self._grp_legacy_note.setWordWrap(True)
        self._grp_legacy_note.setToolTip(
            "旧场景可能只有成员上的 group 字符串。仅查看不会写入 entityGroups；"
            "编辑并应用后才把它升级为显式分组实体。")
        form.addRow("状态", self._grp_legacy_note)
        basic.add_body(inner)
        lay.addWidget(basic)

        cond = self._section("整体显影条件 conditions", start_open=False)
        self._grp_cond_fold = cond
        cond_inner = QWidget()
        cond_lay = QVBoxLayout(cond_inner)
        self._grp_cond = ConditionEditor("Group Conditions")
        self._grp_cond.changed.connect(self._on_group_props_changed)
        cond_lay.addWidget(self._grp_cond)
        cond.add_body(cond_inner)
        lay.addWidget(cond)

        members = self._section("成员（只读）", start_open=True)
        members_inner = QWidget()
        members_lay = QVBoxLayout(members_inner)
        self._grp_members = QListWidget()
        self._grp_members.setMinimumHeight(130)
        self._grp_members.setToolTip("成员由 NPC / Hotspot / Zone 的 group 引用派生；双击成员可在树中定位。")
        self._grp_members.itemDoubleClicked.connect(
            lambda item: self.group_member_activated.emit(
                str((item.data(Qt.ItemDataRole.UserRole) or ("", ""))[0]),
                str((item.data(Qt.ItemDataRole.UserRole) or ("", ""))[1]),
            )
        )
        members_lay.addWidget(self._grp_members)
        members.add_body(members_inner)
        lay.addWidget(members)

        lay.addWidget(self._build_group_transform_section())
        lay.addStretch(1)
        self._append_entity_delete_footer(lay)
        return w

    def _build_group_transform_section(self) -> QWidget:
        """整组位移区：画布拖动的键盘/精确输入对等物（同一条写入通道）。"""
        sect = self._section("位置与整体位移", start_open=True)
        inner = QWidget()
        v = QVBoxLayout(inner)
        v.setContentsMargins(0, 0, 0, 0)

        self._grp_bounds_note = QLabel("—")
        self._grp_bounds_note.setWordWrap(True)
        self._grp_bounds_note.setToolTip(
            "分组自身没有坐标：框是成员几何算出来的包围盒，整组位移会把偏移写进每个成员自己的坐标。")
        v.addWidget(self._grp_bounds_note)

        move_row = QWidget()
        form = compact_form(QFormLayout(move_row))
        self._grp_move_dx = QDoubleSpinBox()
        self._grp_move_dy = QDoubleSpinBox()
        for sb, tip in (
            (self._grp_move_dx, "向右为正（世界单位）"),
            (self._grp_move_dy, "向下为正（世界单位）"),
        ):
            sb.setRange(-100000.0, 100000.0)
            sb.setDecimals(1)
            sb.setSingleStep(1.0)
            sb.setValue(0.0)
            sb.setMaximumWidth(110)
            sb.setToolTip(tip)
        form.addRow("Δx", self._grp_move_dx)
        form.addRow("Δy", self._grp_move_dy)
        v.addWidget(move_row)

        self._grp_move_btn = QPushButton("应用位移")
        self._grp_move_btn.setToolTip(
            "把 Δx/Δy 加到全部成员坐标上（含画布上看不到的成员）。可 Ctrl+Z 撤销。\n"
            "画布上也可以直接拖组框，或选中分组后用方向键微移（Shift = ×10）。")
        self._grp_move_btn.clicked.connect(self._on_group_move_clicked)
        v.addWidget(self._grp_move_btn)

        self._grp_move_patrol = QCheckBox("位移带上 NPC 巡逻路线")
        self._grp_move_patrol.setChecked(True)
        self._grp_move_patrol.setToolTip(
            "勾选（默认）：整组挪窝时 NPC 的 patrol.route 路点一起挪，巡逻路线跟着走。\n"
            "取消：只挪 NPC 当前位置，路线留在原地（NPC 会被巡逻立刻拉回原路线）。\n"
            "该开关是编辑器工作态（写 entityGroups[].editor.movePatrol），运行时不读。")
        self._grp_move_patrol.toggled.connect(self._on_group_props_changed)
        v.addWidget(self._grp_move_patrol)

        btn_row = QWidget()
        h = QHBoxLayout(btn_row)
        h.setContentsMargins(0, 0, 0, 0)
        self._grp_select_members_btn = QPushButton("在画布选中全部成员")
        self._grp_select_members_btn.setToolTip(
            "把该组的成员实体全部选中（画布上不可见的成员经实体树参与批量操作）。")
        self._grp_select_members_btn.clicked.connect(
            lambda: self.group_select_members_requested.emit(
                str(self._group_original_id or "")))
        h.addWidget(self._grp_select_members_btn)
        self._grp_anchor_reset_btn = QPushButton("把手回到中心")
        self._grp_anchor_reset_btn.setToolTip(
            "清除自定义把手位置（editor.anchor），回到按成员包围盒中心派生。\n"
            "画布上 Alt+拖动把手可以自定义位置。")
        self._grp_anchor_reset_btn.clicked.connect(
            lambda: self.group_anchor_reset_requested.emit(
                str(self._group_original_id or "")))
        h.addWidget(self._grp_anchor_reset_btn)
        v.addWidget(btn_row)

        sect.add_body(inner)
        return sect

    def _on_group_move_clicked(self) -> None:
        dx = round(float(self._grp_move_dx.value()), 1)
        dy = round(float(self._grp_move_dy.value()), 1)
        if dx == 0.0 and dy == 0.0:
            QMessageBox.information(self, "整组位移", "Δx / Δy 都是 0，没有可应用的位移。")
            return
        self.group_translate_requested.emit(
            str(self._group_original_id or ""), dx, dy)

    def set_group_bounds_note(self, text: str) -> None:
        self._grp_bounds_note.setText(text)

    def _on_group_props_changed(self, *_args) -> None:
        if self._props_changed_suppressed:
            return
        self._group_pending_changed = True
        self._emit_props_changed()

    def _validate_group_id_edit(self) -> None:
        if self._stack.currentWidget() != self._group_panel:
            return
        old_id = self._group_original_id
        new_id = self._grp_id.text().strip()
        existing = {
            gid for gid, _label in self._model.scene_group_ids_for_scene(self._editing_scene_id)
            if gid != old_id
        }
        reason = ""
        if not new_id:
            reason = "分组 id 不能为空。"
        elif ":" in new_id:
            reason = "分组 id 不能包含 ':'（限定引用使用 sceneId:groupId）。"
        elif new_id in existing:
            reason = f"当前场景已经存在分组「{new_id}」。"
        if not reason:
            return
        QMessageBox.warning(self, "场景分组 id", reason)
        self._grp_id.blockSignals(True)
        try:
            self._grp_id.setText(old_id)
        finally:
            self._grp_id.blockSignals(False)

    def load_group_props(self, sc: dict, group_id: str) -> None:
        gid = str(group_id or "").strip()
        with self._suppress_props_changed_emits():
            self.flush_active_panel_widgets_to_staging(only_shared_scene_staging=True)
            self._set_pending_dirty(False)
            self._ensure_source_scene_for_editing()
            groups = sc.get("entityGroups")
            source = None
            if isinstance(groups, list):
                source = next(
                    (g for g in groups if isinstance(g, dict) and str(g.get("id") or "").strip() == gid),
                    None,
                )
            st = copy.deepcopy(source) if source is not None else {"id": gid}
            self._source_group = source
            self._staging_group = st
            self._pending_group = st
            self._group_scene = sc
            self._group_original_id = gid
            self._group_pending_changed = False
            self._group_commit_blocked = False
            self._current_data = st
            self._show_panel(self._group_panel)
            self._grp_id.setText(gid)
            self._grp_label.setText(str(st.get("label") or ""))
            self._grp_legacy_note.setText(
                "显式 entityGroups 实体" if source is not None
                else "兼容旧标签（仅查看不迁移；编辑并应用才升级）"
            )
            self._grp_cond.set_flag_pattern_context(self._model, self._editing_scene_id or None)
            conds = st.get("conditions")
            self._grp_cond.set_data(conds if isinstance(conds, list) else [])
            self._grp_cond_fold.set_expanded(bool(isinstance(conds, list) and conds))
            # 编辑器工作态：movePatrol 缺省 true（不写键 = 带路线走）
            ed_state = st.get("editor") if isinstance(st.get("editor"), dict) else {}
            self._grp_move_patrol.setChecked(ed_state.get("movePatrol") is not False)
            self._grp_move_dx.setValue(0.0)
            self._grp_move_dy.setValue(0.0)
            self._grp_members.clear()
            for coll, kind, ref_kind in (
                ("npcs", "NPC", "npc"),
                ("hotspots", "Hotspot", "hotspot"),
                ("zones", "Zone", "zone"),
            ):
                for member in sc.get(coll, []) or []:
                    if not isinstance(member, dict):
                        continue
                    if str(member.get("group") or "").strip() != gid:
                        continue
                    member_id = str(member.get("id") or "")
                    item = QListWidgetItem(f"{kind}: {member_id or '?'}")
                    item.setData(
                        Qt.ItemDataRole.UserRole, (ref_kind, member_id),
                    )
                    self._grp_members.addItem(item)

    def _write_group_widgets_to_dict(self, group: dict) -> None:
        group["id"] = self._grp_id.text().strip()
        label = self._grp_label.text().strip()
        if label:
            group["label"] = label
        else:
            group.pop("label", None)
        conds = self._grp_cond.to_list()
        if conds:
            group["conditions"] = conds
        else:
            group.pop("conditions", None)
        # editor 子对象：只接管 movePatrol，anchor 与任何未知键原样透传
        # （anchor 由画布把手写模型层；写完那边会 rebind staging，这里不能反向清掉）。
        old_ed = group.get("editor")
        ed = dict(old_ed) if isinstance(old_ed, dict) else {}
        if self._grp_move_patrol.isChecked():
            ed.pop("movePatrol", None)   # 缺省即 true，不写键（存量零变化）
        else:
            ed["movePatrol"] = False
        if ed:
            group["editor"] = ed
        else:
            group.pop("editor", None)

    def rebind_group_after_commit(self, group: dict) -> None:
        self._source_group = group
        st = copy.deepcopy(group)
        self._staging_group = st
        self._pending_group = st
        self._group_original_id = str(group.get("id") or "").strip()
        self._group_pending_changed = False
        self._group_commit_blocked = False
        if self._stack.currentWidget() == self._group_panel:
            self._current_data = st
            self._grp_legacy_note.setText("显式 entityGroups 实体")
        self._set_pending_dirty(False)

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
            self._show_panel(self._spawn_panel)
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
        from ..shared.rebuild_merge import merge_preserving_unknown
        keep = self._keep_num
        if orig == "default":
            old = sc.get("spawnPoint") if isinstance(sc.get("spawnPoint"), dict) else {}
            sc["spawnPoint"] = merge_preserving_unknown(
                old, {"x": keep(x, old.get("x")), "y": keep(y, old.get("y"))}, {"x", "y"})
        else:
            new_key = self._sp_key.text().strip() or orig
            sps = sc.setdefault("spawnPoints", {})
            # 改名撞名：目标键已存在且非本键 → 拒绝改名，退回原键（避免静默吞掉另一出生点）。
            # 面板裸改 key 也绕过重构引擎的入站引用改写，故此处仅保守拒绝并提示走重构菜单。
            if new_key != orig and new_key in sps:
                QMessageBox.warning(
                    self, "出生点",
                    f"出生点 key「{new_key}」已存在，改名会覆盖它。已退回原名「{orig}」。\n"
                    "如需改名并让入站 transition/切场景引用跟随，请用工具栏「重构 → 重命名 id」。")
                new_key = orig
                self._sp_key.blockSignals(True)
                try:
                    self._sp_key.setText(orig)
                finally:
                    self._sp_key.blockSignals(False)
            old = sps.get(orig) if isinstance(sps.get(orig), dict) else {}
            if new_key != orig:
                sps.pop(orig, None)
            sps[new_key] = merge_preserving_unknown(
                old, {"x": keep(x, old.get("x")), "y": keep(y, old.get("y"))}, {"x", "y"})
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
        # 撤销/重做：所有场景内模型写入在提交边界生成快照命令（见 scene_undo.py）。
        self._undo = SceneUndoController(self)
        # 拖拽手势的「按下时」场景快照：(scene_id, deepcopy)；release/取消时消费。
        self._drag_undo_before: tuple[str, dict] | None = None
        # 出口锚点的工作副本（随 props 的 pending/Apply 一起提交，不即时改 model）
        self._exit_anchors: list[dict] = []
        self._exit_anchor_idx: int = -1
        self._loading_exit_anchor: bool = False
        # 本次整组拖动手势里真正改到成员的次数（0 = release 不标脏，防伪脏）
        self._group_live_changed: int = 0
        # 缩放联动重算组框几何的重入哨兵（见 _on_view_scale_changed）
        self._syncing_view_scale: bool = False
        # 方向键微移的"连发会话"：按住不放的一串合并成一条撤销命令
        self._nudge_session: str = ""
        self._nudge_before: dict | None = None
        self._nudge_idle_timer = QTimer(self)
        self._nudge_idle_timer.setSingleShot(True)
        self._nudge_idle_timer.timeout.connect(self._finish_nudge_session)
        # 实体树 ↔ 画布选中双向同步的重入保护 + 场景装载期间选择事件静默
        # （clear_scene 阶段 selectionChanged 会命中正在析构的图元——地图编辑器旧坑同族）。
        self._loading_scene = False
        self._syncing_tree_selection = False
        self._restoring_blocked_navigation = False
        self._last_canvas_world: tuple[float, float] | None = None
        self._scene_npc_runtimes: dict[str, _SceneNpcAnimRuntime] = {}
        # 内容层 z 的上次排序键；相同就整趟跳过（巡逻预览下每 8ms 会调一次）
        self._content_z_key: tuple = ()
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
        save_btn.setToolTip(
            "立即把右侧属性面板的修改提交到当前场景（仅内存，仍需 Save All 落盘）。"
            "即使不点 Apply，切换其它实体 / 场景 / 关闭时也会自动提交这些修改"
            "（commit-on-leave），不会丢弃；想放弃误改请用主窗口的撤销 / 不保存。")
        save_btn.clicked.connect(self._apply_props)
        tb.addWidget(save_btn)
        # 红色"未应用"提示：当前面板有未点 Apply 的 staging 修改时显示；
        # auto-discard 语义下，切换实体/场景会丢弃这些修改，需要让用户感知。
        self._pending_dirty_label = QLabel("● 未应用")
        self._pending_dirty_label.setStyleSheet(
            "color:#ff5555;font-weight:600;padding:0 6px;",
        )
        self._pending_dirty_label.setToolTip(
            "右侧属性面板有未 Apply 的修改。切换其它实体 / 场景 / 关闭时会自动提交"
            "（commit-on-leave），不会丢弃；点 Apply 只是立即提交。",
        )
        self._pending_dirty_label.setVisible(False)
        tb.addWidget(self._pending_dirty_label)
        del_btn = QPushButton("Delete")
        del_btn.setToolTip("删除当前选中的实体")
        del_btn.clicked.connect(self._delete_selected)
        tb.addWidget(del_btn)
        refactor_menu = QMenu(self)
        self._act_duplicate = refactor_menu.addAction(
            "复制实体（本场景）", self._duplicate_selected)
        self._act_duplicate.setShortcut(QKeySequence("Ctrl+D"))
        # 弹出菜单里的 QAction 快捷键默认只在菜单可见时生效；挂回编辑器本体
        # 并限定 WidgetWithChildren，画布/面板聚焦时 Ctrl+D 直达（与 Delete 键同族）。
        self._act_duplicate.setShortcutContext(
            Qt.ShortcutContext.WidgetWithChildrenShortcut)
        self.addAction(self._act_duplicate)
        self._act_duplicate.setToolTip(
            "深拷贝选中实体为副本（新 id、整体偏移落位）；过场绑定不随副本复制。")
        refactor_menu.addSeparator()
        refactor_menu.addAction("迁移到场景…", lambda: self._refactor_selected("move"))
        refactor_menu.addAction("重命名 id…", lambda: self._refactor_selected("rename"))
        refactor_menu.addAction("安全删除（引用报告）…", lambda: self._refactor_selected("delete"))
        refactor_menu.addAction("转为 NPC（纯展示热点）…", lambda: self._refactor_selected("convert"))
        refactor_menu.addSeparator()
        refactor_menu.addAction("撤销上次重构", self._undo_entity_refactor)
        refactor_btn = QToolButton()
        refactor_btn.setText("重构")
        refactor_btn.setToolTip(
            "选中 NPC / 热区 / Zone / 出生点后：本场景复制（Ctrl+D）、跨场景迁移、"
            "全项目改名、带引用报告的安全删除；"
            "迁移/改名/删除先扫描全项目引用并预览，确认才执行（未 Save All 前仅内存变更）。"
            "Zone 的入站引用与出生点的入站 transition/切场景动作会全量机械改写跟随；"
            "polygon / 坐标需迁移后在目标场景重画。")
        refactor_btn.setMenu(refactor_menu)
        refactor_btn.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        refactor_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextOnly)
        tb.addWidget(refactor_btn)
        undo_btn = QToolButton()
        undo_btn.setText("撤销")
        undo_btn.setToolTip(
            "撤销上一步场景编辑（拖动/属性 Apply/增删/复制等；Ctrl+Z）。"
            "跨文件重构（迁移/改名/安全删除）请用「重构 → 撤销上次重构」。")
        undo_btn.clicked.connect(self._editor_undo)
        undo_btn.setEnabled(False)
        self._undo.stack.canUndoChanged.connect(undo_btn.setEnabled)
        tb.addWidget(undo_btn)
        redo_btn = QToolButton()
        redo_btn.setText("重做")
        redo_btn.setToolTip("重做刚撤销的场景编辑（Ctrl+Shift+Z）。")
        redo_btn.clicked.connect(self._editor_redo)
        redo_btn.setEnabled(False)
        self._undo.stack.canRedoChanged.connect(redo_btn.setEnabled)
        tb.addWidget(redo_btn)
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

        self._chk_group_boxes = QCheckBox("显示场景分组框")
        self._chk_group_boxes.setChecked(True)
        self._chk_group_boxes.setToolTip(
            "每个场景分组在画布上画一个虚线框 + 中心把手：点框边/把手=选中该组，"
            "拖动=整组挪位（偏移写进每个成员自己的坐标），方向键微移（Shift ×10），"
            "Alt+拖把手=只挪把手。框内区域不吃鼠标，成员照常点选。\n"
            "取消勾选=只是不画框，分组数据与实体树不受影响。"
        )
        self._chk_group_boxes.toggled.connect(self._on_group_boxes_toggled)
        ll.addWidget(self._chk_group_boxes)

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

        _phase_lab = QLabel("时段视图")
        _phase_lab.setToolTip(
            "只显示存在于所选时段的实体。缺省（无 phases 字段）实体**按种类分叉**——\n"
            "  · NPC：只在勾了「街上有人」的段出现（在 Config 页的日夜循环里勾）；\n"
            "  · 热点 / 区域：全时段都在（门、路牌夜里当然还在）。\n"
            "与位面视图正交、同时生效（两条都通过才显示）；与过场视图也正交——"
            "过场视图决定实体加不加载，这两条只管已加载实体显不显。\n"
            "纯预览过滤，不改数据；选「全部时段」= 不过滤。\n"
            "⚠ 只在场景勾了「参与日夜循环」时运行时才真按时段过滤；本视图对没开日夜的"
            "场景同样能预览，但那只是「假如开了会怎样」。"
        )
        ll.addWidget(_phase_lab)
        self._combo_phase_view = FilterableTypeCombo([], self, select_only=True)
        self._combo_phase_view.setToolTip(_phase_lab.toolTip())
        self._combo_phase_view.typeCommitted.connect(self._on_phase_view_changed)
        ll.addWidget(self._combo_phase_view)

        # 左栏双页签（2026-07-18 布局重组二轮：弹窗切换器手感差，用户拍板改 tab）：
        # 场景列表与实体树是两级导航、永不同时使用——「场景 | 实体」页签互斥、各占
        # 整栏高度。单击选场景不跳页（连续浏览不被打断），双击/回车视为「进入」跳到
        # 实体页；程序化跳实体（全局搜索/引用导航）也落到实体页。
        self._current_scene_lab = QLabel("")
        ll.addWidget(self._current_scene_lab)

        self._scene_list = QListWidget()
        self._scene_list.currentItemChanged.connect(self._on_scene_selected)
        self._scene_list.setToolTip(
            "单击切换场景（画布随之加载）；再点一下当前场景（或双击/回车）"
            "进入「实体」页开始编辑。")
        # 「进入」手势的时序免疫基座：press 时快照当前场景 id。双击的第一下会同步
        # 触发场景加载，重场景下加载耗时吃掉双击间隔、平台把双击拆成两次单击——
        # 故不依赖 Qt 双击合成，itemClicked 里对比快照判定「点的是已当前场景」。
        self._scene_sid_at_press: str | None = None
        self._scene_list.viewport().installEventFilter(self)
        self._scene_list.itemClicked.connect(self._on_scene_item_clicked)
        self._scene_search = make_list_search_box(
            self._scene_list,
            tooltip="按场景 id / 名称过滤下方列表（仅隐藏不匹配项，不改动数据）。")
        self._btn_new_scene = QPushButton("+ 新建场景")
        self._btn_new_scene.setToolTip(
            "创建一个新的空场景（最小骨架：id / name / 出生点）。"
            "背景图与世界尺寸随后在右侧场景属性面板配置；深度/碰撞为可选附加层，"
            "需要时再用「角色照明实验室」处理。")
        self._btn_new_scene.clicked.connect(self._new_scene)

        scenes_tab = QWidget()
        sv = QVBoxLayout(scenes_tab)
        sv.setContentsMargins(0, 4, 0, 0)
        sv.setSpacing(4)
        sv.addWidget(self._scene_search)
        sv.addWidget(self._scene_list, 1)
        sv.addWidget(self._btn_new_scene)

        # 实体树独占左栏其余高度（场景内层级 = 编辑期常驻高频面板）。
        tree_box = QWidget()
        tbx = QVBoxLayout(tree_box)
        tbx.setContentsMargins(0, 0, 0, 0)
        tbx.setSpacing(2)
        tree_row = QHBoxLayout()
        tree_row.setContentsMargins(0, 0, 0, 0)
        self._tree_mode = QComboBox()
        self._tree_mode.addItems(["按类型", "按分组"])
        self._tree_mode.setToolTip(
            "实体树组织方式：按类型（热区/NPC/Zone/出生点）或按分组（group 标签）。")
        self._tree_mode.setMaximumWidth(88)
        self._tree_mode.currentIndexChanged.connect(
            lambda *_: self._refresh_entity_tree())
        self._tree_filter = QLineEdit()
        self._tree_filter.setPlaceholderText("过滤实体…")
        self._tree_filter.setClearButtonEnabled(True)
        self._tree_filter.setToolTip(
            "按 id / 名称 / 分组子串过滤实体树（仅隐藏不匹配项，不改动数据）。")
        self._tree_filter.textChanged.connect(
            lambda *_: self._apply_entity_tree_filter())
        tree_row.addWidget(self._tree_mode)
        tree_row.addWidget(self._tree_filter, 1)
        self._btn_add_group = QPushButton("新增组")
        self._btn_add_group.setToolTip("在当前场景新建一个显式 entityGroups 分组实体。")
        self._btn_add_group.clicked.connect(self._add_scene_group)
        tree_row.addWidget(self._btn_add_group)
        self._entity_tree = QTreeWidget()
        self._entity_tree.setHeaderHidden(True)
        self._entity_tree.setSelectionMode(
            QAbstractItemView.SelectionMode.ExtendedSelection)
        self._entity_tree.setToolTip(
            "当前场景全部实体。点选=画布定位选中；Ctrl/Shift 多选；"
            "分组节点可直接编辑整体显影条件；右键可指派分组 / 复制 / 删除。")
        self._entity_tree.itemSelectionChanged.connect(
            self._on_tree_selection_changed)
        self._entity_tree.setContextMenuPolicy(
            Qt.ContextMenuPolicy.CustomContextMenu)
        self._entity_tree.customContextMenuRequested.connect(
            self._on_tree_context_menu)
        tbx.addLayout(tree_row)
        tbx.addWidget(self._entity_tree)

        self._left_tabs = QTabWidget()
        self._left_tabs.setDocumentMode(True)
        self._left_tabs.addTab(scenes_tab, "场景")
        self._left_tabs.addTab(tree_box, "实体")
        self._left_tabs.setTabToolTip(
            0, "项目场景列表：单击切换场景，点当前场景 / 双击 / 回车进入「实体」页。")
        self._left_tabs.setTabToolTip(
            1, "当前场景的实体层级：点选=画布定位选中；Ctrl/Shift 多选；右键批量操作。")
        # 双击/回车「进入」的快路径（快机器/键盘）；慢路径由 _on_scene_item_clicked
        # 的快照判定兜底（见 _scene_sid_at_press 注释）。
        self._scene_list.itemActivated.connect(self._enter_entity_tab)
        self._scene_list.itemDoubleClicked.connect(self._enter_entity_tab)
        ll.addWidget(self._left_tabs, 1)

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
        self._canvas.drag_cancelled.connect(self._on_drag_cancelled)
        self._canvas.item_drag_press.connect(self._on_canvas_drag_press)
        self._canvas.items_batch_moved.connect(self._on_items_batch_moved)
        # 直连画布的 QGraphicsScene 信号（公共 graphics_scene()）。**不要**在画布上
        # 再包一层 Signal 转发：多一跳就多一次排队时机，而这条回路上的墓碑注释
        # （见下方 _on_canvas_selection_changed）记的正是延后派发引发的 SIGSEGV。
        self._canvas.graphics_scene().selectionChanged.connect(
            self._on_canvas_selection_changed)
        self._canvas.transform_gizmo_live.connect(self._on_gizmo_transform_live)
        self._canvas.transform_gizmo_committed.connect(self._on_gizmo_transform_committed)
        # 全部直连：数据写入必须发生在手势里（撤销快照/提交时序都挂在上面）。
        # 会改**布局**的两件事（装载分组面板、改只读几何行文案）在槽内部经
        # QTimer.singleShot(0, self, ...) 延后——布局重排会让画布 resize，而
        # fit 的 resetTransform() 落在 Qt 鼠标事件派发栈中间就是段错误。
        self._canvas.group_translate_live.connect(self._on_group_translate_live)
        self._canvas.group_clicked.connect(self._on_group_box_clicked)
        self._canvas.group_gesture_finished.connect(self._on_group_gesture_finished)
        self._canvas.group_translate_committed.connect(self._on_group_translate_committed)
        self._canvas.group_translate_abandoned.connect(self._on_group_translate_abandoned)
        self._canvas.group_anchor_committed.connect(self._on_group_anchor_committed)
        self._canvas.group_nudge.connect(self._on_group_nudge)
        # 画布右键菜单与右侧面板按钮共用同一批槽（同一入口，避免两套语义漂移）
        self._canvas.group_select_members_requested.connect(
            self._on_group_select_members_requested)
        self._canvas.group_anchor_reset_requested.connect(
            self._on_group_anchor_reset_requested)
        self._canvas.group_delete_requested.connect(self._on_group_delete_requested)
        self._canvas.view_scale_changed.connect(self._on_view_scale_changed)

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
        self._props._multi_group_btn.clicked.connect(self._assign_group_to_selection)
        self._props._multi_dup_btn.clicked.connect(self._duplicate_selected)
        self._props._multi_del_btn.clicked.connect(self._delete_selected)
        self._props.scene_directly_written.connect(
            self._undo.notice_external_scene_write)
        self._props.group_member_activated.connect(
            self._on_group_member_activated)
        self._props.group_translate_requested.connect(
            self._on_group_translate_requested)
        self._props.group_select_members_requested.connect(
            self._on_group_select_members_requested)
        self._props.group_anchor_reset_requested.connect(
            self._on_group_anchor_reset_requested)
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
        # 统一光影：画布定位 ←→ 属性面板的开关，双向接起来
        self._canvas.light_place_requested.connect(self._on_light_place_requested)
        self._props.light_place_mode_changed.connect(self._canvas.set_light_place_mode)
        self._canvas.persp_axis_committed.connect(self._on_persp_axis_committed)
        self._canvas.persp_axis_live_refresh.connect(self._refresh_all_persp_previews)
        self._props.perspective_preview_changed.connect(self._on_persp_preview_changed)
        # NPC 动画精灵住在这里（_scene_npc_runtimes），不在画布的实体图元表里。
        # 登记成 npc 族的一个 part，画布贴显隐/回收时就能覆盖到它——此前正是因为
        # 画布"看不见"这一层，切时段藏 NPC 时圆点没了、人还站在原地。
        # 显隐走 runtime 的闸门而不是 item.setVisible：动画定时器每 8ms 重画一次。
        self._canvas.register_part_adapter(
            "npc", "sprite",
            item_of=lambda eid: getattr(self._scene_npc_runtimes.get(eid), "item", None),
            set_visible=self._set_npc_sprite_visible,
            drop=self._drop_npc_sprite,
        )

        splitter.addWidget(left)
        # 画布列：顶部一行轻量「实体查找」入口 + 画布本体（小屏纪律：单行紧凑，不加大面板）。
        center = QWidget()
        cl = QVBoxLayout(center)
        cl.setContentsMargins(0, 0, 0, 0)
        cl.setSpacing(2)
        find_row = QHBoxLayout()
        find_row.setContentsMargins(0, 0, 0, 0)
        _find_lab = QLabel("查找")
        find_row.addWidget(_find_lab)
        self._entity_find = QLineEdit()
        self._entity_find.setPlaceholderText("按 类型:id 查找实体（回车定位）")
        self._entity_find.setClearButtonEnabled(True)
        self._entity_find.setMaximumWidth(320)
        self._entity_find.setToolTip(
            "在当前场景内查找并定位实体：输入 id 片段从下拉选，回车或选中即在画布居中并选中该实体。")
        self._entity_find_completer = QCompleter([], self)
        self._entity_find_completer.setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
        self._entity_find_completer.setFilterMode(Qt.MatchFlag.MatchContains)
        self._entity_find_completer.setCompletionMode(
            QCompleter.CompletionMode.PopupCompletion)
        self._entity_find.setCompleter(self._entity_find_completer)
        self._entity_find_completer.activated.connect(self._on_entity_find_chosen)
        self._entity_find.returnPressed.connect(
            lambda: self._on_entity_find_chosen(self._entity_find.text()))
        find_row.addWidget(self._entity_find)
        find_row.addStretch(1)
        cl.addLayout(find_row)
        cl.addWidget(self._canvas, 1)
        splitter.addWidget(center)
        splitter.addWidget(self._props)
        splitter.setSizes([200, 700, 300])  # 合计 1200，13"(1240) 可容；仍可拖动
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
        self._refill_scene_phase_view_combo(init=True)

    def reload_refs_from_model(self) -> None:
        """切页激活时,让属性面板重拉跨域引用候选(filter/item/encounter)。"""
        self._props.reload_refs_from_model()
        # 位面面板可能新增/删位面：刷新「位面视图」下拉候选（保留当前选中）。
        self._refill_scene_plane_view_combo()
        # Config 页可能改了时段表（增删段 / 改 daylight 勾选）：同理刷新「时段视图」。
        self._refill_scene_phase_view_combo()

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

    def _refill_scene_phase_view_combo(self, *, init: bool = False) -> None:
        """时段视图候选 = game_config.dayNight.phases（与条件叶 {timePhase:…} 同一份）。

        标了 daylight 的段在标签上注明「街上有人」——策划一眼看出这一段龙套在不在，
        不用回 Config 页对着表数。
        """
        w = getattr(self, "_combo_phase_view", None)
        if not isinstance(w, FilterableTypeCombo):
            return
        prev = "" if init else w.committed_type().strip()
        daylight = set(self._model.daylight_phase_ids())
        rows: list[tuple[str, str]] = [("（全部时段）", "")]
        for pid, label in self._model.all_time_phase_ids():
            text = f"{pid}（{label}）" if label and str(label) != pid else pid
            rows.append((f"{text}· 街上有人" if pid in daylight else text, pid))
        w.set_entries(rows)
        keys = {v for _a, v in rows}
        w.set_committed_type(prev if (prev and prev in keys) else "")
        # 候选变化后按当前选中重贴一次（选中时段被删则回落到全部=显示全部）。
        self._apply_phase_view_to_canvas(w.committed_type().strip())

    def _apply_phase_view_to_canvas(self, pid: str) -> None:
        self._canvas.set_phase_filter(
            pid or None, npc_default_phases=list(self._model.daylight_phase_ids()))

    def _on_phase_view_changed(self, _t: str = "") -> None:
        w = getattr(self, "_combo_phase_view", None)
        pid = w.committed_type().strip() if isinstance(w, FilterableTypeCombo) else ""
        self._apply_phase_view_to_canvas(pid)
        # 与位面视图同理：只改可见性、不改数据，但"画布不可见成员数"要跟着更新
        self._refresh_group_bounds_note()

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
        # 位面过滤只改可见性、不改数据：框大小不变，但"画布不可见成员数"要跟着更新
        self._refresh_group_bounds_note()

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

    def _set_npc_sprite_visible(self, npc_id: str, visible: bool) -> None:
        """npc/sprite part 的显隐出口（由画布经适配器调）。

        必须落到 runtime 的闸门上：`draw_at` 每 8ms 按 `rt.visible` 重贴一次，
        直接 `item.setVisible(False)` 只能活到下一拍。
        """
        rt = self._scene_npc_runtimes.get(npc_id)
        if rt is not None:
            rt.set_visible(visible)

    def _drop_npc_sprite(self, npc_id: str) -> None:
        """npc/sprite part 的回收出口：**真的把图元从场景里摘掉**。

        此前 `_clear_scene_npc_anim_layers` 只 `dict.clear()` 不 removeItem，
        全靠 `clear_scene()` 的 `_gfx.clear()` 一把梭兜底。而
        `_rebuild_scene_npc_anim_layers` 第一句就调它、路上**没有** clear_scene ——
        于是每次全量重建都会在画布上留下一个再也没人驱动的旧精灵（幽灵）。
        """
        rt = self._scene_npc_runtimes.pop(npc_id, None)
        if rt is None:
            return
        item = rt.item
        gfx = self._canvas.graphics_scene()
        if item is not None and item.scene() is gfx:
            gfx.removeItem(item)

    def _clear_scene_npc_anim_layers(self) -> None:
        self._scene_npc_anim_timer.stop()
        for npc_id in list(self._scene_npc_runtimes):
            self._drop_npc_sprite(npc_id)
        self._scene_npc_runtimes.clear()
        self._patrol_preview_ids.clear()
        self._patrol_preview_state.clear()

    # ---- 内容层 z：按运行时规则实时重排 ------------------------------------
    #
    # 运行时 `Renderer.sortEntityLayer` 按「三档 × 档内脚底 y」每帧排一次；编辑器此前
    # 是一张写死的层表（NPC 精灵恒 -10、热点展示图恒 -4），于是**画布上 NPC 永远被
    # 热点贴图压住**，与游戏里谁前谁后毫无关系 —— 策划照着画布排前后关系等于白排。
    # 这里用同一条规则的 Python 镜像（`entity_sort_math`，双侧 parity 测试钉死）
    # 算出名次，再按名次派 z 到内容区间里。
    #
    # 为什么不直接把运行时的 z 搬过来：运行时档位偏移是 ±1e7，直接当 zValue 会盖穿
    # 全部装饰品（gizmo、把手、碰撞面）。名次映射既保住次序，又留在内容区间内。

    def _content_sort_entries(self) -> list[tuple[float, int, object]]:
        """收集参与内容排序的图元 → ``(排序键 z, 平局序, 图元)``。

        `tie_index` 复刻运行时 `entityLayer` 的 addChild 次序（玩家 → 热点按 JSON 序
        → NPC 按 JSON 序）。运行时平局时靠 Pixi 稳定排序保持数组现序，编辑器只能用
        JSON 数组序近似 —— 但它必须**稳定**，抖动会让画布闪烁。
        """
        sc = self._model.scenes.get(self._current_scene_id or "")
        if not isinstance(sc, dict):
            return []
        out: list[tuple[float, int, object]] = []

        for i, model_hs in enumerate(sc.get("hotspots", []) or []):
            if not isinstance(model_hs, dict):
                continue
            eid = str(model_hs.get("id", "") or "")
            # **必须读 staging 感知的真相源**：拖动/数值框只写 staging 深拷贝，读模型
            # 会算出旧坐标的次序，表现为"拖着拖着前后关系不跟着变，松手才跳一下"。
            # 与 _npc_render_pos_dict 同一条契约（editor-data-sync-paradigm 硬契约 1）。
            hs = self._staging_hotspot_for_canvas_drag(eid) or model_hs
            item = self._canvas.entity_item_by_key(f"hotspot_display:{eid}")
            if item is None:
                continue  # 没展示图的热点不进内容区（运行时容器里也只有不可见 marker）
            # 与运行时 `displaySprite !== null` 同口径：画成紫色缺件框时那边也没有档位
            texture_loaded = isinstance(item, QGraphicsPixmapItem)
            pf = self._canvas.persp_factor(hs, "hotspot")
            di = hs.get("displayImage") if isinstance(hs.get("displayImage"), dict) else {}
            try:
                ww = float(di.get("worldWidth", 0) or 0)
                hh = float(di.get("worldHeight", 0) or 0)
            except (TypeError, ValueError):
                ww = hh = 0.0
            s = entity_scale_of(hs) * pf
            foot = sort_foot_y_of(hs, ww * s, hh * s)
            z = entity_sort_z(
                hotspot_sort_band_of(hs, texture_loaded), float(hs.get("y", 0)), foot)
            out.append((z, 1_000 + i, item))

        for i, npc in enumerate(sc.get("npcs", []) or []):
            if not isinstance(npc, dict):
                continue
            eid = str(npc.get("id", "") or "")
            rt = self._scene_npc_runtimes.get(eid)
            if rt is None or rt.item is None:
                continue
            # 位置与 transform 都读 staging 感知的真相源，与精灵自身每拍拉取的同源
            pos = self._npc_render_pos_dict(eid, npc)
            s = entity_scale_of(pos) * (rt.persp if rt.persp and rt.persp > 0 else 1.0)
            foot = sort_foot_y_of(pos, rt.world_w * s, rt.world_h * s)
            # NPC 的 collisionPolygon **不参与**遮挡带（运行时只有 Hotspot 写
            # entityOcclusionPolygon）；一视同仁会造出运行时根本不存在的层级翻转。
            z = entity_sort_z(npc_sort_band_of(npc), float(pos.get("y", 0)), foot)
            out.append((z, 2_000_000 + i, rt.item))

        return out

    def _resort_canvas_content_z(self) -> None:
        """把内容图元按运行时规则重新派 z。带脏检查，可以随便调。

        脏检查不是可选优化：巡逻预览开着时 NPC 的 y 每 8ms 都在变，不比对就会
        每拍对全场 `setZValue`，Qt 会掉帧（与 perf-reload 同类教训）。
        """
        entries = self._content_sort_entries()
        entries.sort(key=lambda e: (e[0], e[1]))
        key = tuple((tie, round(z, 4), id(item)) for z, tie, item in entries)
        if key == self._content_z_key:
            return
        self._content_z_key = key
        for rank, (_z, _tie, item) in enumerate(entries):
            item.setZValue(_Z_CONTENT_LO + rank * _Z_CONTENT_STEP)

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
        # apply_lightcurve_committed 只写面板 pending；capture 出口的统一提交把它
        # 落进模型并成为一条命令（光曲线画布手势因此可撤销）。
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        with self._undo.capture("编辑光环境曲线"):
            self._props.apply_lightcurve_committed(points)

    def _on_light_place_requested(self, sx: float, sy: float) -> None:
        """画布上点了一下 → 把选中的灯落到该处地面（属性面板负责取深度与抬高）。"""
        # place_selected_light_at 内部已 _emit_props_changed（脏态经既有通道走），
        # 这里只负责把画布事件转过去。
        self._props.place_selected_light_at(float(sx), float(sy))

    def _on_persp_axis_committed(self, which: str, x: float, y: float) -> None:
        # 与光曲线同门：画布手势 → 面板 staging（走统一 dirty/预览），一条撤销命令
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        with self._undo.capture("拖动透视深度轴"):
            self._props.apply_persp_axis_endpoint(str(which), float(x), float(y))

    def _on_persp_preview_changed(self, cfg: object) -> None:
        """面板透视配置 live 变更：重建画布基准线并刷新全部实体预览（与运行时同口径）。"""
        self._canvas.set_perspective_config(cfg if isinstance(cfg, dict) else None)
        self._refresh_all_persp_previews()

    def _refresh_all_persp_previews(self) -> None:
        sc = self._model.scenes.get(self._current_scene_id or "")
        if not sc:
            return
        for hs in sc.get("hotspots", []):
            if not isinstance(hs, dict) or not self._entity_visible_for_cutscene_edit(hs):
                continue
            eid = str(hs.get("id", "") or "")
            item = self._canvas.entity_item_by_key(f"hotspot:{eid}")
            if isinstance(item, _DraggableCircle):
                item.set_interaction_range(
                    float(hs.get("interactionRange", 50) or 0)
                    * entity_scale_of(hs) * self._canvas.persp_factor(hs, "hotspot"))
            self._canvas.refresh_hotspot_visuals(hs)
        for npc in sc.get("npcs", []):
            if not isinstance(npc, dict) or not self._entity_visible_for_cutscene_edit(npc):
                continue
            eid = str(npc.get("id", "") or "")
            item = self._canvas.entity_item_by_key(f"npc:{eid}")
            if isinstance(item, _DraggableCircle):
                item.set_interaction_range(
                    float(npc.get("interactionRange", 50) or 0)
                    * entity_scale_of(npc) * self._canvas.persp_factor(npc, "npc"))
            # 命中面幽灵轮廓随配置变化重派生（多边形本体 authored 空间不动）
            self._canvas.refresh_npc_collision_visuals(npc)
        # NPC 精灵预览由动画 tick 每拍拉取 persp（无需在此显式刷）
        # 透视系数变了 = 成员画布占位变了：分组框跟着重算，否则框对不上眼见的图形
        self._refresh_group_boxes()
        # 透视系数进 footY（旋转态）与遮挡面尺寸，前后关系可能整体翻转
        self._resort_canvas_content_z()

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
        for nid in self._canvas.patrol_overlay_ids():
            if nid != active_npc_id:
                self._canvas.remove_npc_patrol_overlay(nid)
        if active_npc_id:
            self._canvas.set_npc_patrol_overlay(active_npc_id, active_route)

    def _on_npc_patrol_route_committed(
        self, npc_id: str, route: object,
    ) -> None:
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        with self._undo.capture("编辑巡逻路线"):
            self._on_npc_patrol_route_committed_impl(npc_id, route)

    def _on_npc_patrol_route_committed_impl(
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
        use_patrol_anim = False
        if isinstance(pat, dict) and npc_id in self._patrol_preview_ids:
            ma = str(pat.get("moveAnimState", "") or "").strip()
            if ma and ma in states:
                state_name = ma
                use_patrol_anim = True
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
        try:
            ref_speed = float(st.get("referenceSpeed", 0) or 0)
        except (TypeError, ValueError):
            ref_speed = 0.0
        item = QGraphicsPixmapItem()
        item.setZValue(_Z_CONTENT_LO)
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
            ref_speed=ref_speed if ref_speed > 0 else None,
        )
        facing = str(npc.get("initialFacing", "") or "").strip().lower()
        rt.facing_x = -1 if facing == "left" else 1
        pos0 = self._npc_render_pos_dict(npc_id, npc)
        if not use_patrol_anim:
            # 初始播放参数仅作用于初始状态（巡逻预览播 moveAnimState 时素播，与运行时
            # moveTo 语义一致）；读 staging 感知的 pos0，与 tick 循环同源
            rt.set_playback(*_npc_initial_playback_tuple(pos0))
        rt.set_instance_transform(
            entity_scale_of(pos0), entity_rotation_deg_of(pos0))
        nx = float(pos0.get("x", 0))
        ny = float(pos0.get("y", 0))
        rt.persp = self._canvas.persp_factor(pos0, "npc", nx, ny)
        rt.draw_at(nx, ny)
        self._scene_npc_runtimes[npc_id] = rt
        # 新建的精灵默认可见；若这个 NPC 当前正被位面/时段过滤掉，必须立刻重贴，
        # 否则"重建一次就冒回来"。登记进账本之后再调——重贴要经适配器找到它。
        self._canvas.refresh_entity_presence("npc", npc_id)

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
                # 巡逻预览播 moveAnimState：素播 + 步速匹配（与运行时 moveTo 素播后每帧
                # applyLocomotionSpeed 同口径——状态配了 referenceSpeed 才缩放，夹取区间
                # 同 SpriteEntity.LOCOMOTION_RATE_MIN/MAX=0.5~2；巡逻速度缺省 60 同 Game.ts）
                mult = 1.0
                if rt.ref_speed:
                    pat = npc.get("patrol")
                    try:
                        pspd = float(pat.get("speed", 60) or 60) if isinstance(pat, dict) else 60.0
                    except (TypeError, ValueError):
                        pspd = 60.0
                    if pspd > 0:
                        mult = min(2.0, max(0.5, pspd / rt.ref_speed))
                rt.set_playback(mult, False, None, None)
                px, py = self._patrol_preview_advance(rid, npc, dt)
                # 透视系数随巡逻瞬时脚底点每拍拉取（与运行时移动中重求同口径）
                rt.persp = self._canvas.persp_factor(npc, "npc", px, py)
                rt.tick(dt, px, py)
            else:
                pos = self._npc_render_pos_dict(rid, npc)
                # 实例 transform 与位置同源（staging 感知）：数值框/gizmo 的 live 改动
                # 下一拍即反映在精灵预览上，与运行时 container 级施加同口径。
                # 初始播放参数同为每拍拉取且**必须同读 staging 感知的 pos**（speed/reverse
                # 连续覆盖，hold/start 边沿拨游标）——读模型 dict 会掉进「定时器读模型、
                # 编辑写 staging」的 8ms 回弹坑（见 _npc_render_pos_dict 注释）。
                rt.set_instance_transform(
                    entity_scale_of(pos), entity_rotation_deg_of(pos))
                rt.set_playback(*_npc_initial_playback_tuple(pos))
                x = float(pos.get("x", 0))
                y = float(pos.get("y", 0))
                # 透视系数与位置同源每拍拉取（staging 感知：拖动/数值框 live 改坐标即时反映）
                rt.persp = self._canvas.persp_factor(pos, "npc", x, y)
                rt.tick(dt, x, y)
        # 位置变了前后关系就可能变：每拍重排（脏检查命中时是空操作）
        self._resort_canvas_content_z()
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
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
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
        if current is None or self._restoring_blocked_navigation:
            return
        sid = current.data(Qt.ItemDataRole.UserRole)
        previous_sid = self._current_scene_id or ""
        if not self._load_scene(sid):
            self._restore_scene_list_selection(previous_sid)

    def _restore_scene_list_selection(self, scene_id: str) -> None:
        """提交被拒时把 QListWidget 的视觉选中恢复到仍在编辑的场景。"""
        if not scene_id:
            return
        self._restoring_blocked_navigation = True
        self._scene_list.blockSignals(True)
        try:
            for i in range(self._scene_list.count()):
                item = self._scene_list.item(i)
                if item is not None and item.data(Qt.ItemDataRole.UserRole) == scene_id:
                    self._scene_list.setCurrentItem(item)
                    break
        finally:
            self._scene_list.blockSignals(False)
            self._restoring_blocked_navigation = False

    def eventFilter(self, obj, event) -> bool:
        # 场景列表 press 快照：itemClicked 时对比判定「点的是否已当前场景」
        #（press 本身可能同步换场景，release 时 current 已变，须在此提前取样）。
        if obj is self._scene_list.viewport() \
                and event.type() == QEvent.Type.MouseButtonPress:
            self._scene_sid_at_press = self._current_scene_id
        return super().eventFilter(obj, event)

    def _on_scene_item_clicked(self, item: QListWidgetItem | None) -> None:
        """点击已是当前场景的项 =「进入」；切换型点击只切不跳（连续浏览不被打断）。
        双击在重场景下被平台拆成两次单击（首击的加载耗时吃掉双击间隔），
        第二击落到本判定 → 仍然进入，手势对时序免疫。"""
        if item is None:
            return
        sid = item.data(Qt.ItemDataRole.UserRole)
        if sid and sid == self._scene_sid_at_press:
            self._enter_entity_tab()

    def _enter_entity_tab(self, *_args) -> None:
        self._left_tabs.setCurrentIndex(1)

    def _sync_current_scene_label(self) -> None:
        """左栏顶部当前场景指示（实体页下场景名不可见，靠它兜底）；完整名进
        tooltip，文本按列宽省略。"""
        sid = self._current_scene_id or ""
        sc = self._model.scenes.get(sid)
        full = f"{sid}  [{(sc or {}).get('name', '')}]" if sid else "（未选择场景）"
        fm = self._current_scene_lab.fontMetrics()
        self._current_scene_lab.setText(
            fm.elidedText(full, Qt.TextElideMode.ElideMiddle, 180))
        self._current_scene_lab.setToolTip(f"当前场景：{full}")

    def _load_scene(self, scene_id: str, *, reset_view: bool = True) -> bool:
        # 离开当前场景前先提交未应用的画布/面板编辑，避免切场景静默丢弃。
        # （提交本身记为可撤销命令；命令回放期间该入口自动短路。）
        if not self._undo_flush_pending_as_command():
            return False
        self._drag_undo_before = None
        self._loading_scene = True
        try:
            self._load_scene_body(scene_id, reset_view=reset_view)
        finally:
            self._loading_scene = False
        return True

    def _load_scene_body(self, scene_id: str, *, reset_view: bool = True) -> None:
        self._current_scene_id = scene_id
        sc = self._model.scenes.get(scene_id)
        if sc is None:
            return
        # 所有切换路径（页签点选/select_scene_by_id/重构后 reload）都汇入此处，单点同步指示标签
        self._sync_current_scene_label()
        if _migrate_scene_hotspot_collision_to_local(sc):
            self._model.mark_dirty("scene", scene_id)
        self._clear_scene_npc_anim_layers()
        self._canvas.clear_scene()

        img_path = _scene_background_disk_path(self._model, scene_id, sc)

        world_w, world_h = resolve_world_size_for_scene_json(sc, img_path)
        self._canvas.setup_world(world_w, world_h)
        # 透视缩放须在实体图元创建前写入画布（add_* 的交互圈/展示图按系数求半径）
        pcfg = sc.get("perspectiveScale")
        self._canvas.set_perspective_config(pcfg if isinstance(pcfg, dict) else None)

        if img_path:
            self._canvas.load_background(img_path, world_w, world_h)

        try:
            self._canvas.clear_selection()
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
        self._refresh_entity_find_completer(sc)
        self._refresh_entity_tree()
        # 分组框在 NPC 精灵运行时就绪后重建（包围盒要用精灵真实世界尺寸）
        self._canvas.set_group_boxes_visible(self._chk_group_boxes.isChecked())
        self._refresh_group_boxes()
        # 展示图与精灵都已就绪：按运行时规则派一次内容 z
        self._resort_canvas_content_z()

    def _refresh_entity_find_completer(self, sc: dict) -> None:
        """按当前场景实体刷新「实体查找」下拉候选（类型:id）。"""
        if not hasattr(self, "_entity_find_completer"):
            return
        entries: list[str] = []
        for hs in sc.get("hotspots", []):
            if isinstance(hs, dict) and str(hs.get("id", "")).strip():
                entries.append(f"hotspot:{hs['id']}")
        for npc in sc.get("npcs", []):
            if isinstance(npc, dict) and str(npc.get("id", "")).strip():
                entries.append(f"npc:{npc['id']}")
        for zone in sc.get("zones", []):
            if isinstance(zone, dict) and str(zone.get("id", "")).strip():
                entries.append(f"zone:{zone['id']}")
        sp = sc.get("spawnPoint")
        if isinstance(sp, dict):
            entries.append("spawn:default")
        for name in (sc.get("spawnPoints") or {}):
            entries.append(f"spawn:{name}")
        from PySide6.QtCore import QStringListModel
        self._entity_find_completer.setModel(QStringListModel(entries, self))

    def _on_entity_find_chosen(self, text: str) -> None:
        """解析「类型:id」并在画布定位 + 选中该实体（遵守 _focus_canvas_on_entity 落点语义）。"""
        raw = (text or "").strip()
        if not raw or ":" not in raw:
            return
        kind, _, eid = raw.partition(":")
        kind = kind.strip().lower()
        eid = eid.strip()
        if not eid:
            return
        if kind == "spawn":
            self._restore_canvas_selection("spawn", eid)
            self._focus_canvas_on_entity("spawn", eid)
        elif kind in ("hotspot", "npc", "zone"):
            self._select_scene_entity_by_kind(kind, eid, self._current_scene_id or "")

    # ---- 实体树 / 多选 / 分组（P2；与画布选中双向同步） ----------------------

    def _refresh_entity_tree(self) -> None:
        """左栏实体树：当前场景实体 + 一等分组，按类型或分组组织。"""
        if not hasattr(self, "_entity_tree"):
            return
        sc = self._model.scenes.get(self._current_scene_id or "")
        self._syncing_tree_selection = True
        try:
            self._entity_tree.clear()
            if not isinstance(sc, dict):
                return
            entries: list[tuple[str, str, str, str]] = []  # (kind, eid, label, group)
            for hs in sc.get("hotspots", []):
                if isinstance(hs, dict) and str(hs.get("id", "")).strip():
                    eid = str(hs["id"])
                    entries.append(
                        ("hotspot", eid, eid, str(hs.get("group", "") or "")))
            for npc in sc.get("npcs", []):
                if isinstance(npc, dict) and str(npc.get("id", "")).strip():
                    eid = str(npc["id"])
                    name = str(npc.get("name", "") or "").strip()
                    label = f"{eid}（{name}）" if name and name != eid else eid
                    entries.append(
                        ("npc", eid, label, str(npc.get("group", "") or "")))
            for z in sc.get("zones", []):
                if isinstance(z, dict) and str(z.get("id", "")).strip():
                    eid = str(z["id"])
                    entries.append(
                        ("zone", eid, eid, str(z.get("group", "") or "")))
            spawn_entries: list[tuple[str, str, str, str]] = []
            if isinstance(sc.get("spawnPoint"), dict):
                spawn_entries.append(("spawn", "default", "default", ""))
            for name in (sc.get("spawnPoints") or {}):
                spawn_entries.append(("spawn", str(name), str(name), ""))
            group_rows = self._model.scene_group_ids_for_scene(self._current_scene_id)

            def _leaf(parent: QTreeWidgetItem, kind: str, eid: str,
                      label: str, group: str) -> None:
                it = QTreeWidgetItem(parent)
                it.setText(0, label + (f"  [{group}]" if group else ""))
                it.setData(0, Qt.ItemDataRole.UserRole, (kind, eid))
                it.setToolTip(
                    0, f"{kind}: {eid}" + (f"（分组 {group}）" if group else ""))

            def _section(title: str, group_id: str = "") -> QTreeWidgetItem:
                top = QTreeWidgetItem(self._entity_tree)
                top.setText(0, title)
                if group_id:
                    top.setData(0, Qt.ItemDataRole.UserRole, ("group", group_id))
                    top.setToolTip(0, f"sceneGroup: {self._current_scene_id}:{group_id}")
                else:
                    top.setFlags(top.flags() & ~Qt.ItemFlag.ItemIsSelectable)
                return top

            if self._tree_mode.currentIndex() == 0:  # 按类型
                for title, rows in (
                    ("热区", [e for e in entries if e[0] == "hotspot"]),
                    ("NPC", [e for e in entries if e[0] == "npc"]),
                    ("Zone", [e for e in entries if e[0] == "zone"]),
                    ("出生点", spawn_entries),
                ):
                    if not rows:
                        continue
                    top = _section(f"{title}（{len(rows)}）")
                    for kind, eid, label, group in rows:
                        _leaf(top, kind, eid, label, group)
                if group_rows:
                    top = _section(f"场景分组（{len(group_rows)}）")
                    for gid, label in group_rows:
                        shown = gid if label == gid else f"{gid}（{label}）"
                        _leaf(top, "group", gid, shown, "")
            else:  # 按分组
                by_group: dict[str, list] = {}
                ungrouped: list = []
                for e in entries:
                    if e[3]:
                        by_group.setdefault(e[3], []).append(e)
                    else:
                        ungrouped.append(e)
                labels = {gid: label for gid, label in group_rows}
                ordered_groups = [gid for gid, _label in group_rows]
                for gname in ordered_groups:
                    members = by_group.get(gname, [])
                    glabel = labels.get(gname, gname)
                    title = f"组 {gname}（{len(members)}）"
                    if glabel and glabel != gname:
                        title = f"组 {gname} · {glabel}（{len(members)}）"
                    top = _section(title, gname)
                    for kind, eid, label, _g in members:
                        _leaf(top, kind, eid, f"{kind}:{label}", "")
                rest = ungrouped + spawn_entries
                if rest:
                    top = _section(f"未分组（{len(rest)}）")
                    for kind, eid, label, _g in rest:
                        _leaf(top, kind, eid, f"{kind}:{label}", "")
            self._entity_tree.expandAll()
        finally:
            self._syncing_tree_selection = False
        self._apply_entity_tree_filter()

    def _apply_entity_tree_filter(self) -> None:
        if not hasattr(self, "_entity_tree"):
            return
        needle = (self._tree_filter.text() or "").strip().lower()
        root = self._entity_tree.invisibleRootItem()
        for i in range(root.childCount()):
            top = root.child(i)
            own_hay = (top.text(0) + " " + str(top.toolTip(0))).lower()
            own_hit = (not needle) or (needle in own_hay)
            visible_any = own_hit and top.data(0, Qt.ItemDataRole.UserRole) is not None
            for j in range(top.childCount()):
                leaf = top.child(j)
                hay = (leaf.text(0) + " " + str(leaf.toolTip(0))).lower()
                hit = own_hit or (not needle) or (needle in hay)
                leaf.setHidden(not hit)
                visible_any = visible_any or hit
            top.setHidden(not visible_any)

    def _iter_entity_tree_items(self):
        root = self._entity_tree.invisibleRootItem()
        stack = [root.child(i) for i in range(root.childCount())]
        while stack:
            item = stack.pop(0)
            yield item
            stack[0:0] = [item.child(i) for i in range(item.childCount())]

    def _tree_selected_refs(self) -> list[tuple[str, str]]:
        refs: list[tuple[str, str]] = []
        for it in self._entity_tree.selectedItems():
            data = it.data(0, Qt.ItemDataRole.UserRole)
            if data:
                refs.append((str(data[0]), str(data[1])))
        return refs

    def _canvas_selected_entity_refs(self) -> list[tuple[str, str]]:
        """画布当前全部选中实体 (kind, id)：碰撞图元归并到本体、去重保序。"""
        refs: list[tuple[str, str]] = []
        seen: set[tuple[str, str]] = set()
        for it in self._canvas.selected_items():
            ek = getattr(it, "entity_kind", None)
            ei = getattr(it, "entity_id", None)
            if not ek or ei is None or str(ei) == "":
                continue
            kind = {"npc_collision": "npc", "hotspot_collision": "hotspot"}.get(
                str(ek), str(ek))
            key = (kind, str(ei))
            if key not in seen:
                seen.add(key)
                refs.append(key)
        return refs

    def _selected_entity_refs_plural(self) -> list[tuple[str, str]]:
        """批量操作的目标集合：画布选中 ∪ 树选中（保序去重）。

        树能列出画布上选不中的实体（cutscene-only 不建图元、位面过滤 setVisible(False)
        后 Qt 拒绝 setSelected）——只取画布集合会让批量删除/复制/指派组静默漏掉
        这些成员，且与多选页计数打架（审查 P1-B）。无任何选中时退回单选语义。"""
        refs = list(self._canvas_selected_entity_refs())
        seen = set(refs)
        for kind, eid in self._tree_selected_refs():
            key = (str(kind), str(eid))
            if key not in seen:
                seen.add(key)
                refs.append(key)
        if refs:
            return refs
        single = self._selected_entity_ref()
        if single is None:
            return []
        kind = {"npc_collision": "npc", "hotspot_collision": "hotspot"}.get(
            single[0], single[0])
        return [(kind, single[1])]

    def _on_canvas_selection_changed(self) -> None:
        if (
            self._loading_scene
            or self._undo.restoring
            or self._syncing_tree_selection
            or self._restoring_blocked_navigation
        ):
            return
        try:
            refs = self._canvas_selected_entity_refs()
        except RuntimeError:
            return  # 场景析构期的迟到 selectionChanged（图元已删）
        if refs:
            # 选中了真实体 = 离开分组：组框熄灯（组框 press 自己会先清空实体选择，
            # 走的是 refs 为空的分支，不会误灭刚点亮的组）。
            self._canvas.set_selected_group(None)
        self._sync_tree_from_canvas(refs)
        if len(refs) > 1:
            if not self._undo_flush_pending_as_command():
                self._restore_editing_selection_after_block()
                return
            self._props.show_multi_selection(len(refs))
        self._sync_transform_gizmo()

    def _sync_tree_from_canvas(self, refs: list[tuple[str, str]]) -> None:
        if not hasattr(self, "_entity_tree"):
            return
        want = {tuple(r) for r in refs}
        self._syncing_tree_selection = True
        try:
            first_hit: QTreeWidgetItem | None = None
            for item in self._iter_entity_tree_items():
                data = item.data(0, Qt.ItemDataRole.UserRole)
                hit = bool(data) and tuple(data) in want
                item.setSelected(hit)
                if hit and first_hit is None:
                    first_hit = item
            if first_hit is not None:
                self._entity_tree.scrollToItem(first_hit)
        finally:
            self._syncing_tree_selection = False

    def _on_tree_selection_changed(self) -> None:
        if (
            self._syncing_tree_selection
            or self._loading_scene
            or self._undo.restoring
            or self._restoring_blocked_navigation
        ):
            return
        refs = self._tree_selected_refs()
        if not refs:
            return
        editing_ref = self._editing_property_ref()
        if refs != ([editing_ref] if editing_ref is not None else []):
            if not self._undo_flush_pending_as_command():
                self._restore_editing_selection_after_block()
                return
        self._syncing_tree_selection = True
        try:
            self._canvas.clear_selection()
            for kind, eid in refs:
                item = self._canvas.entity_item_by_key(f"{kind}:{eid}")
                if item is not None:
                    item.setSelected(True)
        finally:
            self._syncing_tree_selection = False
        if len(refs) == 1:
            kind, eid = refs[0]
            if kind == "spawn":
                self._canvas.set_selected_group(None)
                self._restore_canvas_selection("spawn", eid)
            elif kind == "group":
                sc = self._model.scenes.get(self._current_scene_id or "")
                if isinstance(sc, dict):
                    self._props.load_group_props(sc, eid)
                # 树选中分组 = 画布上把该组的框点亮并拉进视口（组不进 Qt 选择系统）
                self._canvas.set_selected_group(eid)
                self._canvas.hide_transform_gizmo()
                self._refresh_group_bounds_note()
                self._focus_canvas_on_entity("group", eid)
            else:
                self._canvas.set_selected_group(None)
                self._on_item_selected(kind, eid)
                self._focus_canvas_on_entity(kind, eid)
        else:
            self._canvas.set_selected_group(None)
            self._props.show_multi_selection(len(refs))

    def _editing_property_ref(self) -> tuple[str, str] | None:
        """右侧 staging 正在编辑的对象；不读已被用户新点中的画布选择。"""
        props = self._props
        panel = props._stack.currentWidget()
        if panel == props._hotspot_panel and props._pending_hotspot is not None:
            return "hotspot", str(props._pending_hotspot.get("id") or "")
        if panel == props._npc_panel and props._pending_npc is not None:
            return "npc", str(props._pending_npc.get("id") or "")
        if panel == props._zone_panel and props._pending_zone is not None:
            return "zone", str(props._pending_zone.get("id") or "")
        if panel == props._group_panel and props._pending_group is not None:
            return "group", str(props._group_original_id or props._pending_group.get("id") or "")
        if panel == props._spawn_panel and props._spawn_scene is not None:
            return "spawn", str(props._spawn_name_original or "")
        return None

    def _restore_editing_selection_after_block(self) -> None:
        """fail-safe 导航回滚：保留 staging，并把树/画布选中恢复到原编辑对象。"""
        ref = self._editing_property_ref()
        self._restoring_blocked_navigation = True
        self._syncing_tree_selection = True
        try:
            self._canvas.clear_selection()
            for item in self._iter_entity_tree_items():
                item.setSelected(False)
            if ref is None:
                return
            kind, entity_id = ref
            tree_hit = None
            for item in self._iter_entity_tree_items():
                data = item.data(0, Qt.ItemDataRole.UserRole)
                if data and tuple(data) == (kind, entity_id):
                    item.setSelected(True)
                    self._entity_tree.setCurrentItem(item)
                    tree_hit = item
                    break
            if tree_hit is not None:
                self._entity_tree.scrollToItem(tree_hit)
            if kind != "group":
                canvas_item = self._canvas.entity_item_by_key(f"{kind}:{entity_id}")
                if canvas_item is not None:
                    canvas_item.setSelected(True)
        finally:
            self._syncing_tree_selection = False
            self._restoring_blocked_navigation = False

    def _on_group_member_activated(self, kind: str, entity_id: str) -> None:
        """成员列表双击真正定位实体树/画布，而非只显示一行文本。"""
        if kind not in ("npc", "hotspot", "zone") or not entity_id:
            return
        item = next(
            (
                row for row in self._iter_entity_tree_items()
                if (row.data(0, Qt.ItemDataRole.UserRole) or ()) == (kind, entity_id)
            ),
            None,
        )
        if item is None:
            return
        self._left_tabs.setCurrentIndex(1)
        self._entity_tree.clearSelection()
        self._entity_tree.setCurrentItem(item)
        item.setSelected(True)
        self._entity_tree.scrollToItem(item)

    # ---- 场景分组：画布代理框 / 整组位移（分组是一等实体，但自己没有坐标） ------
    #
    # 位移的唯一真相是**模型层成员名册**，不是画布选中集：cutsceneOnly 实体、被位面
    # 过滤隐藏的成员在画布上根本没有图元，按选中集平移会留下"半份移动"的坏数据
    # （与批量删除/复制的 P1-B 同一个坑）。所有入口（拖框 / 方向键 / 面板 Δ）都汇到
    # `_translate_group_members`。

    _GROUP_MEMBER_COLLS = (("npcs", "npc"), ("hotspots", "hotspot"), ("zones", "zone"))

    def _group_members(self, sc: dict, gid: str) -> list[tuple[str, dict]]:
        """成员名册（含画布上看不到的成员），按 npc→hotspot→zone 保序。

        名册**按模型枚举**（谁属于这个组是模型说了算），但每条返回的 dict 已按
        身份解析成"该写哪一份"——见 :meth:`_group_member_write_dict`。
        """
        gid = str(gid or "").strip()
        out: list[tuple[str, dict]] = []
        if not gid or not isinstance(sc, dict):
            return out
        for coll, kind in self._GROUP_MEMBER_COLLS:
            for ent in sc.get(coll, []) or []:
                if not isinstance(ent, dict):
                    continue
                # 归属与写入都按同一份真相判断：某成员正被面板改 group（还没点
                # 应用）时，屏幕上它已经不在这个组了，位移就不该带上它。
                target = self._group_member_write_dict(kind, ent)
                if str(target.get("group") or "").strip() == gid:
                    out.append((kind, target))
        return out

    def _group_member_write_dict(self, kind: str, ent: dict) -> dict:
        """成员的"当前真相"份：属性面板正编辑它就返回 staging，否则返回模型 dict。

        与单实体拖拽的 `_staging_*_for_canvas_drag` 同口径，**必须**如此：
        整组位移若直写模型，release 的 `_mark_canvas_edit()` 会点亮 pending，
        随后的 commit-on-leave 就用**按下之前**的 staging 深拷贝把这个成员整份拍
        回旧坐标——组里少一个人跟上，画布还照新位置画，肉眼看不出来的坏数据。
        触发条件低到只要"拖组之前点过组里任何一个实体"。
        """
        eid = str(ent.get("id") or "")
        if not eid:
            return ent
        props = self._props
        staging = {
            "npc": props._staging_npc,
            "hotspot": props._staging_hotspot,
            "zone": props._staging_zone,
        }.get(kind)
        if staging is not None and str(staging.get("id") or "") == eid:
            return staging
        return ent

    def _group_def(self, sc: dict, gid: str) -> dict | None:
        """显式 entityGroups 条目；旧标签组返回 None（合法：位移不要求先升格）。"""
        gid = str(gid or "").strip()
        groups = sc.get("entityGroups") if isinstance(sc, dict) else None
        if not gid or not isinstance(groups, list):
            return None
        for g in groups:
            if isinstance(g, dict) and str(g.get("id") or "").strip() == gid:
                return g
        return None

    def _group_editor_state(self, sc: dict, gid: str) -> dict:
        """分组的编辑器工作态（只读副本口径；缺省 = 空 dict）。

        面板未应用的 staging 优先——勾了「不带巡逻路线」还没点应用就拖框时，
        必须按屏幕上的选择走，否则用户看到的开关是假的。
        """
        props = self._props
        if (
            props._staging_group is not None
            and str(props._group_original_id or "").strip() == str(gid or "").strip()
        ):
            st = props._staging_group.get("editor")
            if isinstance(st, dict):
                return st
        g = self._group_def(sc, gid)
        ed = g.get("editor") if isinstance(g, dict) else None
        return ed if isinstance(ed, dict) else {}

    def _group_move_patrol(self, sc: dict, gid: str) -> bool:
        return self._group_editor_state(sc, gid).get("movePatrol") is not False

    def _entity_canvas_bbox(self, kind: str, ent: dict) -> QRectF | None:
        """单个成员在画布上的占位矩形（世界单位）。

        与画布预览同口径（× 实例 scale × 透视系数），这样组框不会对不上眼见的图形。
        巡逻路点**刻意不计入**：movePatrol=false 时路线不动，把它算进去会让框在
        位移后变形，"框整体平移 = Δ" 这条直觉就断了。
        """
        if not isinstance(ent, dict):
            return None
        if kind == "zone":
            pts = _zone_polygon_points_for_editor(ent)
            if len(pts) < 2:
                return None
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            return QRectF(min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))
        try:
            x = float(ent.get("x", 0) or 0)
            y = float(ent.get("y", 0) or 0)
        except (TypeError, ValueError):
            return None
        s = entity_scale_of(ent) * self._canvas.persp_factor(ent, kind)
        w = h = 0.0
        if kind == "hotspot":
            di = ent.get("displayImage")
            if isinstance(di, dict):
                try:
                    w = float(di.get("worldWidth", 0) or 0) * s
                    h = float(di.get("worldHeight", 0) or 0) * s
                except (TypeError, ValueError):
                    w = h = 0.0
        else:  # npc：优先用场景精灵的真实世界尺寸
            rt = self._scene_npc_runtimes.get(str(ent.get("id") or ""))
            if rt is not None:
                w = float(getattr(rt, "world_w", 0) or 0) * s
                h = float(getattr(rt, "world_h", 0) or 0) * s
        if w > 0 and h > 0:
            # 展示图/精灵是底中锚点对齐 (x, y)
            return QRectF(x - w / 2.0, y - h, w, h)
        r = max(self._canvas.handle_radius, 8.0)
        return QRectF(x - r, y - r, r * 2, r * 2)

    def _group_geometry(
        self, sc: dict, gid: str,
    ) -> tuple[QRectF | None, QPointF, int, int]:
        """(包围盒 | None, 把手世界坐标, 成员总数, 画布上不可见的成员数)。"""
        members = self._group_members(sc, gid)
        rect: QRectF | None = None
        for kind, ent in members:
            r = self._entity_canvas_bbox(kind, ent)
            if r is None:
                continue
            rect = r if rect is None else rect.united(r)
        if rect is not None:
            # 留白 = 命中带宽 + 净空。带宽按屏幕像素恒定（9px），缩小的视图里
            # 换算成的世界宽度会远超写死的 10——实测 0.213 倍下带子往框内探进 32
            # 世界单位，把紧贴框线的成员压得点不中。
            # **不能只取 max**：那样带子内沿与成员包围盒恰好相切，定义极值的那个
            # 成员（一定存在）永远压线，1 像素取整就把点击吃进带子里。
            wpp = self._canvas_world_per_px()
            pad = (_GROUP_EDGE_PICK_PX * wpp
                   + max(_GROUP_BOX_PAD, _GROUP_CLEARANCE_PX * wpp))
            rect = rect.adjusted(-pad, -pad, pad, pad)
        hidden = 0
        for kind, ent in members:
            key = f"{kind}:{str(ent.get('id') or '')}"
            item = self._canvas.entity_item_by_key(key)
            if item is None or not item.isVisible():
                hidden += 1
        anchor = self._group_anchor_point(sc, gid, rect)
        return rect, anchor, len(members), hidden

    def _group_anchor_point(
        self, sc: dict, gid: str, rect: QRectF | None,
    ) -> QPointF:
        """把手位置：自定义 editor.anchor 优先，否则框**上边线正上方**的左端。

        三轮才收敛到这儿，前两个位置各自的死法记下来免得再绕：
        - **包围盒中心**：成员最密的地方，把手把实体挡死，而叠放循环点选又刻意
          跳过组框（`_entity_stack_at`），挡住就救不回来。
        - **框左上角的斜外侧**：上下相邻两组时（街上两排 NPC 各一组很常见），
          下组把手落进上组框里盖住它的框角。
        - **框内左上角**：把手是屏幕恒定尺寸，缩小的视图里换算成的世界半径很大
          （0.2 倍下 55 世界单位），选中态会挡住靠近左上角的本组成员。
        框上边线正上方是框外空白——框本身是成员包围盒外扩出来的，那儿不会有成员，
        与标题并排构成一块真正的抓手区（Figma frame 标签 + 手柄）。

        **已知限制**（两条同源：屏幕像素定尺的东西换算进世界坐标后会压住别的东西，
        这条线索前后改了五次，动组框几何之前先读
        `agent_docs/_meta/inbox/2026-08-07-screen-sized-hit-areas-must-stay-off-members.md`）：

        1. 框顶贴着世界上边界时，把手会被钳回可见区（否则标题连同组名一起跑到视口
           外），此时它可能落回框边命中带甚至框内，选中态下会挡住最上排成员。
           当前工程数据不触发（最靠上的分组框顶也在 140 以上）。
        2. 缩得很远时（0.2 倍以下），框的留白按屏幕像素长大，相邻两组的命中带会
           互相盖——净空只保证"我的带子不碰我自己的成员"，管不了邻组。触发条件是
           两组成员包围盒相距 < 2×pad 且视图缩得很远；当前工程每个场景只有一个组，
           不触发。真要收：给屏幕像素那份留白设上限（别让它无限跟着缩放长）。

        两条的现成出路都是放大视图，或取消勾选「显示场景分组框」。
        """
        ed = self._group_editor_state(sc, gid)
        a = ed.get("anchor")
        if isinstance(a, dict):
            try:
                return QPointF(float(a.get("x", 0) or 0), float(a.get("y", 0) or 0))
            except (TypeError, ValueError):
                pass
        if rect is not None:
            wpp = self._canvas_world_per_px()
            # 竖直方向抬出框外（2.2 倍留出把手半径 + 标题高度的余量），水平方向
            # 保持在框宽以内——甩到框左边之外就又会去压左邻组。
            # 再钳进世界上边界：框顶贴着世界顶时抬出去就跑到视口外了，标题（组名 +
            # 成员数这个唯一辨识信息）看不见、把手也够不着。
            y = rect.top() - _GROUP_HANDLE_PX * 2.2 * wpp
            try:
                scene_top = self._canvas.scene_rect_top()
            except (AttributeError, RuntimeError):
                scene_top = 0.0
            return QPointF(
                min(rect.left() + _GROUP_HANDLE_PX * 1.4 * wpp, rect.center().x()),
                max(scene_top + _GROUP_HANDLE_PX * wpp, y))
        ww, wh = self._last_canvas_world or (800.0, 600.0)
        return QPointF(float(ww) / 2.0, float(wh) / 2.0)

    def _canvas_world_per_px(self) -> float:
        try:
            m = float(self._canvas.transform().m11())
        except (AttributeError, RuntimeError):
            return 1.0
        return 1.0 / m if m else 1.0

    def _refresh_group_boxes(self) -> None:
        """按当前模型重建全部分组框（加载 / 提交 / 撤销回放后统一走这里）。"""
        if not hasattr(self, "_canvas") or not hasattr(self, "_chk_group_boxes"):
            return
        sc = self._model.scenes.get(self._current_scene_id or "")
        if not isinstance(sc, dict):
            self._canvas.sync_group_boxes([])
            self._refresh_group_bounds_note()
            return
        rows: list[dict] = []
        for gid, label in self._model.scene_group_ids_for_scene(self._current_scene_id):
            rect, anchor, total, hidden = self._group_geometry(sc, gid)
            title = gid if (not label or label == gid) else f"{gid}（{label}）"
            suffix = f" ×{total}" if total else " ×0"
            rows.append({
                "id": gid,
                # 纯文字前缀：等宽字体缺 emoji 字形时会画成豆腐块（实测 ⛶ 即如此）
                "title": f"[组] {title}{suffix}",
                "rect": rect,
                "anchor": anchor,
            })
        self._canvas.sync_group_boxes(rows)
        self._refresh_group_bounds_note()

    def _refresh_group_bounds_note(self) -> None:
        """分组面板上的只读几何行：框在哪、几个成员、几个在画布上看不见。"""
        props = self._props
        if props._stack.currentWidget() != props._group_panel:
            return
        gid = str(props._group_original_id or "").strip()
        sc = self._model.scenes.get(self._current_scene_id or "")
        if not gid or not isinstance(sc, dict):
            props.set_group_bounds_note("—")
            return
        rect, anchor, total, hidden = self._group_geometry(sc, gid)
        if total == 0:
            props.set_group_bounds_note(
                "该组暂无成员：画布上只画把手，位移无对象。\n"
                "给实体指派分组后，框会自动出现（右键实体树 → 指派分组…）。")
            return
        if rect is None:
            bounds = "成员没有可用几何（坐标缺失？）"
        else:
            bounds = (
                f"包围盒 x {rect.left():.0f} → {rect.right():.0f}，"
                f"y {rect.top():.0f} → {rect.bottom():.0f}"
                f"（{rect.width():.0f} × {rect.height():.0f}）"
            )
        hidden_note = (
            f"，其中 {hidden} 个在画布上不可见（位面/时段/过场视图过滤），位移同样生效"
            if hidden else ""
        )
        props.set_group_bounds_note(
            f"{bounds}\n把手 ({anchor.x():.0f}, {anchor.y():.0f}) · 成员 {total} 个{hidden_note}")

    def _on_view_scale_changed(self) -> None:
        """缩放变了：组框的留白（≥ 边线带宽）与把手位置（抬出框外）都按屏幕像素
        定尺，必须重新派生，否则框按旧缩放、把手按新缩放，两者错配。

        重入哨兵是防御性的：这条回路理论上能经「刷新 → 面板 QLabel.setText →
        布局重排 → 画布 resize → fit」绕回来，实测三条入口（滚轮/fit/resize）都
        不递归（`wheelEvent` 先关掉 `_auto_fit_after_layout`，而 `resizeEvent` 只在
        该标志为真时重 fit，两者互斥），但这种互斥是别处代码的性质，不该赌。
        """
        if self._loading_scene or self._undo.restoring or self._syncing_view_scale:
            return
        self._syncing_view_scale = True
        try:
            self._refresh_group_boxes()
        finally:
            self._syncing_view_scale = False

    def _on_group_boxes_toggled(self, checked: bool) -> None:
        self._canvas.set_group_boxes_visible(bool(checked))
        if checked:
            return
        # 框藏了 = 画布上的选中与方向键微移也没了。树/面板仍停在该组是刻意的
        # （用户还在编辑它的条件），但必须说一声，否则就是"方向键悄悄失灵"。
        had = self._canvas.selected_group()
        self._canvas.set_selected_group(None)
        if had:
            try:
                self.window().statusBar().showMessage(
                    "分组框已隐藏：画布上的整组拖动/方向键微移暂停，"
                    "整组位移改用右侧面板的 Δx/Δy。", 5000)
            except (AttributeError, RuntimeError):
                pass

    @staticmethod
    def _decimals_of(v: object) -> int:
        """一个数值写在 JSON 里带几位小数（int / 非法值算 0）。"""
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            return 0
        if isinstance(v, int):
            return 0
        text = repr(float(v))
        if "e" in text or "E" in text:
            return 6  # 科学计数法：给个够用的上限，别把精度砍没
        _, _, frac = text.partition(".")
        return len(frac.rstrip("0"))

    @classmethod
    def _shift_point_dict(cls, p: object, dx: float, dy: float, keep) -> bool:
        """平移一个 {"x","y"} 点；返回是否真的改了。

        量化精度取**原值自己的小数位**（至少 1 位），不是一律 round 到 0.1：
        真实场景里有几十个 2 位小数坐标，一律砍到 0.1 会让"挪过去再挪回来"
        回不到原处，而这份截断既不显眼也没法从数据上看出是谁干的。
        """
        if not isinstance(p, dict):
            return False
        ox, oy = p.get("x", 0), p.get("y", 0)
        try:
            px = max(1, cls._decimals_of(ox), cls._decimals_of(dx))
            py = max(1, cls._decimals_of(oy), cls._decimals_of(dy))
            nx = round(float(ox or 0) + dx, px)
            ny = round(float(oy or 0) + dy, py)
        except (TypeError, ValueError):
            return False
        p["x"] = keep(nx, ox)
        p["y"] = keep(ny, oy)
        return True

    def _translate_group_members(
        self, sc: dict, gid: str, dx: float, dy: float,
    ) -> int:
        """把 (dx, dy) 烘进该组每个成员自己的坐标；返回被改动的成员数。

        逐类规则（与运行时 moveGroupBy 的作者态对应物）：
        - npc：x/y；`movePatrol` 时连 patrol.route 全部路点；
        - npc / hotspot：`collisionPolygon` **仅当不是局部坐标**——局部多边形挂在
          锚点上会自动跟随，旧世界坐标数据则必须一起平移，否则碰撞面与本体脱节。
          （hotspot 的世界坐标多边形在场景加载时已被迁成局部，NPC 的没有迁移路径，
          所以这条分支对 NPC 是活的；两类都判，不赌某一类"不会出现"。）
        - zone：polygon 全部顶点。
        """
        if not isinstance(sc, dict):
            return 0
        dx = float(dx)
        dy = float(dy)
        if dx == 0.0 and dy == 0.0:
            return 0
        keep = self._props._keep_num
        move_patrol = self._group_move_patrol(sc, gid)
        changed = 0
        for kind, ent in self._group_members(sc, gid):
            hit = False
            if kind in ("npc", "hotspot"):
                if self._shift_point_dict(ent, dx, dy, keep):
                    hit = True
            if kind == "npc" and move_patrol:
                patrol = ent.get("patrol")
                if isinstance(patrol, dict):
                    for pt in patrol.get("route") or []:
                        if self._shift_point_dict(pt, dx, dy, keep):
                            hit = True
            if (
                kind in ("npc", "hotspot")
                and ent.get("collisionPolygonLocal") is not True
            ):
                for pt in ent.get("collisionPolygon") or []:
                    if self._shift_point_dict(pt, dx, dy, keep):
                        hit = True
            if kind == "zone":
                poly = ent.get("polygon")
                if isinstance(poly, list) and len(poly) >= 3:
                    for pt in poly:
                        if self._shift_point_dict(pt, dx, dy, keep):
                            hit = True
                # 遗留矩形字段（x/y/width/height）：没有 polygon 时画布就按它画，
                # 不挪就是"框动它不动"的半份移动；与 polygon 并存时（惰性残留）
                # 也一起挪，免得两套几何各说各话。宽高一律不碰。
                if isinstance(ent.get("x"), (int, float)) and not isinstance(
                    ent.get("x"), bool
                ):
                    if self._shift_point_dict(ent, dx, dy, keep):
                        hit = True
            if hit:
                changed += 1
        return changed

    def _refresh_group_member_visuals(self, sc: dict, gid: str) -> None:
        """整组位移后刷新画布上成员的图元（拖动 live 每步都走，故只做轻量同步）。

        顺带把右侧数值框/顶点表同步过去——不是为了好看：`_commit_pending_scene_edits`
        会先 `flush_pending_to_model()`（widgets → staging），控件里留着旧坐标的话，
        它会把刚写进 staging 的位移**反向覆盖**掉，那个成员就永远挪不动。
        单实体拖拽路径（`_on_item_moved_impl`）同样是写 staging + sync 控件。
        """
        for kind, ent in self._group_members(sc, gid):
            eid = str(ent.get("id") or "")
            if not eid:
                continue
            if kind == "zone":
                self._props.refresh_zone_polygon_table(eid, ent.get("polygon") or [])
            else:
                x = float(ent.get("x", 0) or 0)
                y = float(ent.get("y", 0) or 0)
                if kind == "hotspot":
                    self._props.sync_hotspot_xy_widgets(eid, x, y)
                else:
                    self._props.sync_npc_xy_widgets(eid, x, y)
                    patrol = ent.get("patrol")
                    route = patrol.get("route") if isinstance(patrol, dict) else None
                    if isinstance(route, list) and route:
                        # 巡逻路点表同理：不同步的话 flush 会拿表里的旧路点覆盖回去
                        self._props.refresh_npc_patrol_table(eid, route)
            if kind == "hotspot":
                self._canvas.move_entity_handle(
                    "hotspot", eid, float(ent.get("x", 0) or 0), float(ent.get("y", 0) or 0))
                self._canvas.refresh_hotspot_visuals(ent)
            elif kind == "npc":
                x = float(ent.get("x", 0) or 0)
                y = float(ent.get("y", 0) or 0)
                self._canvas.move_entity_handle("npc", eid, x, y)
                self._patrol_preview_state.pop(eid, None)
                rt = self._scene_npc_runtimes.get(eid)
                if rt is not None:
                    rt.draw_at(x, y)
                self._canvas.refresh_npc_collision_visuals(ent)
                overlay = self._canvas.patrol_overlay(eid)
                if overlay is not None:
                    patrol = ent.get("patrol")
                    route = patrol.get("route") if isinstance(patrol, dict) else None
                    self._canvas.update_npc_patrol_overlay_points(eid, route or [])
            else:
                self._canvas.update_zone_polygon(eid, ent.get("polygon") or [])
        self._canvas.viewport().update()

    def _group_write_target_scene(self, gid: str) -> dict | None:
        """整组位移的写入对象：模型层场景 dict。

        成员三列表与 model 共享引用（见 load_scene_props 注释），直写模型即可；
        但若面板正拿着某个成员的 staging，提交时会用旧坐标覆盖——所以所有入口
        进来之前都必须先 flush pending（`_undo_flush_pending_as_command`）。
        """
        sc = self._model.scenes.get(self._current_scene_id or "")
        return sc if isinstance(sc, dict) else None

    def _on_group_box_clicked(self, gid: str) -> None:
        """press 阶段：**只**点亮组框 + 让画布拿到键盘焦点。

        刻意不装载属性面板、不同步实体树、不弹任何窗——那些都会改布局，而这里
        跑在 Qt 的鼠标事件派发栈中间，画布一 resize 就会触发 fit 的 resetTransform，
        实测直接段错误。收尾统一放 `_on_group_gesture_finished`。
        """
        gid = str(gid or "").strip()
        if not gid:
            return
        self._canvas.set_selected_group(gid)
        self._canvas.hide_transform_gizmo()
        # 画布要能吃方向键微移：把焦点交给画布本体
        self._canvas.setFocus(Qt.FocusReason.MouseFocusReason)

    def _on_group_gesture_finished(self, gid: str) -> None:
        """手势结束：把「会改布局」的收尾排到下一拍再做。

        我们此刻仍在 release 的事件派发栈里，装载面板 = 切 QStackedWidget =
        布局重排 → 画布 resize → fit 的 resetTransform() 在 Qt 鼠标事件处理
        中间执行 → 段错误（实测）。singleShot 必须用带 context 对象的 3 参版，
        否则编辑器销毁后回调照样触发、碰到已析构的 C++ 对象（库内硬规矩）。
        """
        gid = str(gid or "").strip()
        if not gid:
            return
        QTimer.singleShot(
            0, self, lambda g=gid: self._apply_group_gesture_finished(g))

    def _apply_group_gesture_finished(self, gid: str) -> None:
        """手势收尾的实际内容：装载分组面板、同步实体树、刷新只读几何行。

        位移本身写的是「成员的当前真相份」（staging 在就写 staging，见
        `_group_member_write_dict`），所以这里的 commit-on-leave 只会把已含新
        坐标的 staging 写回 source，不存在拿旧副本覆盖的问题。
        """
        gid = str(gid or "").strip()
        if not gid or self._undo.restoring:
            return
        if self._canvas.group_box(gid) is None:
            return  # 组已在本次手势中消失（改名/删除），下一拍的刷新会收拾干净
        sc = self._model.scenes.get(self._current_scene_id or "")
        if not isinstance(sc, dict):
            return
        props = self._props
        already = (
            props._stack.currentWidget() == props._group_panel
            and str(props._group_original_id or "").strip() == gid
        )
        if not already:
            if not self._undo_flush_pending_as_command():
                self._restore_editing_selection_after_block()
                return
            sc = self._model.scenes.get(self._current_scene_id or "") or sc
            if not any(g == gid for g, _lbl
                       in self._model.scene_group_ids_for_scene(self._current_scene_id)):
                # 刚提交的编辑把这个组改没了（改名）：刷新组框，不装载幽灵面板
                self._refresh_group_boxes()
                return
            props.load_group_props(sc, gid)
        self._canvas.set_selected_group(gid)
        self._sync_tree_from_canvas([("group", gid)])
        self._refresh_group_bounds_note()

    def _on_group_translate_live(self, gid: str, dx: float, dy: float) -> None:
        """拖动过程中的增量位移：写入 + 刷新成员图元，不标脏（release 才标）。"""
        if self._undo.restoring:
            return
        sc = self._group_write_target_scene(gid)
        if sc is None:
            return
        if self._translate_group_members(sc, gid, dx, dy) == 0:
            return
        # release 据此判断"这次手势到底改没改到东西"，没改到就不标脏（防伪脏）
        self._group_live_changed += 1
        self._refresh_group_member_visuals(sc, gid)

    def _on_group_translate_committed(self, gid: str, dx: float, dy: float) -> None:
        """整组拖动 release：标脏 + 收敛为一条撤销命令（before 取自按下时快照）。"""
        before_info = self._drag_undo_before
        self._drag_undo_before = None
        changed = self._group_live_changed
        self._group_live_changed = 0
        sc = self._group_write_target_scene(gid)
        if sc is None:
            return
        if changed == 0:
            # 手势有位移但一个成员也没改到（成员几何全缺失/坏元素）：
            # 标脏就是伪脏——脏了却既无变更也无可撤销的命令。
            self._refresh_group_boxes()
            self._canvas.set_selected_group(str(gid or "") or None)
            return
        self._mark_canvas_edit()
        self._after_group_translate(sc, gid, dx, dy)
        if before_info is not None:
            total = len(self._group_members(sc, gid))
            self._undo.complete_deferred(
                before_info[0], f"整组位移 {gid}（{total} 个成员）", before_info[1])

    def _on_group_translate_abandoned(self, gid: str) -> None:
        """零位移点击 / Esc：按下时快照精确回灌，丢掉撤销快照，不留空命令。

        **不能**靠反向 Δ 退回：每一步位移都 round 到 0.1，原坐标带 2 位小数
        （真实场景里有 30+ 个）时反算退不回去，结果是"取消了但数据被截断改过"，
        而且既不标脏也进不了撤销栈——用户因别的编辑触发保存时静默落盘。
        """
        gid = str(gid or "").strip()
        before_info = self._drag_undo_before
        self._drag_undo_before = None
        self._group_live_changed = 0
        sc = self._model.scenes.get(self._current_scene_id or "")
        if isinstance(sc, dict) and before_info is not None and before_info[0] == (
            self._current_scene_id or ""
        ):
            self._restore_group_members_from_snapshot(sc, gid, before_info[1])
        if isinstance(sc, dict):
            self._refresh_group_member_visuals(sc, gid)
        self._refresh_group_boxes()
        self._canvas.set_selected_group(gid or None)

    _GROUP_GEOMETRY_KEYS = (
        "x", "y", "patrol", "polygon", "collisionPolygon", "collisionPolygonLocal",
        "width", "height",
    )

    def _restore_group_members_from_snapshot(
        self, sc: dict, gid: str, snapshot: dict,
    ) -> None:
        """把该组成员的几何字段按快照逐字段回灌（原表示原样，不经任何 round）。"""
        if not isinstance(snapshot, dict):
            return
        for coll, kind in self._GROUP_MEMBER_COLLS:
            snap_by_id = {
                str(e.get("id") or ""): e
                for e in snapshot.get(coll, []) or [] if isinstance(e, dict)
            }
            for ent in sc.get(coll, []) or []:
                if not isinstance(ent, dict):
                    continue
                if str(ent.get("group") or "").strip() != gid:
                    continue
                old = snap_by_id.get(str(ent.get("id") or ""))
                if not isinstance(old, dict):
                    continue
                # staging 在就写 staging：与位移写入的是同一份，否则退不回屏幕上那份
                target = self._group_member_write_dict(kind, ent)
                for key in self._GROUP_GEOMETRY_KEYS:
                    if key in old:
                        target[key] = copy.deepcopy(old[key])
                    else:
                        target.pop(key, None)

    def _report_group_move(self, sc: dict, gid: str, dx: float, dy: float) -> None:
        """状态栏回报本次整组位移的真实影响面。

        画布上看不见的成员（位面/时段/过场视图过滤掉的）也被移动了——不说出来的话，
        用户以为只动了眼前这几个，事后才发现别的位面里的实体跟着跑了。
        """
        members = self._group_members(sc, gid)
        hidden = sum(
            1 for kind, ent in members
            if (lambda it: it is None or not it.isVisible())(
                self._canvas.entity_item_by_key(f"{kind}:{str(ent.get('id') or '')}"))
        )
        tail = f"，其中 {hidden} 个画布上不可见" if hidden else ""
        try:
            self.window().statusBar().showMessage(
                f"分组「{gid}」整体位移 ({dx:+.1f}, {dy:+.1f})："
                f"{len(members)} 个成员已移动{tail}（Ctrl+Z 可撤销）", 4000)
        except (AttributeError, RuntimeError):
            pass  # 无状态栏的宿主（测试/独立窗口）不该因为提示失败而中断位移

    def _after_group_translate(
        self, sc: dict, gid: str, dx: float = 0.0, dy: float = 0.0,
    ) -> None:
        """位移落定后的统一收尾：面板/画布/组框全部重新对齐模型。

        状态栏回报与只读几何行会改布局（可能引发画布 resize→fit→resetTransform），
        位移可能发生在鼠标 release 的事件栈里，所以这两件排到下一拍再做。
        """
        props = self._props
        if dx or dy:
            QTimer.singleShot(
                0, self,
                lambda g=gid, ddx=float(dx), ddy=float(dy): self._report_group_move(
                    self._model.scenes.get(self._current_scene_id or "") or {},
                    g, ddx, ddy))
        if (
            props._stack.currentWidget() == props._group_panel
            and str(props._group_original_id or "").strip() == str(gid or "").strip()
        ):
            # 只读几何行是 QLabel.setText，同样会重排布局，一并排到下一拍。
            QTimer.singleShot(0, self, self._refresh_group_bounds_note)
        self._refresh_group_member_visuals(sc, gid)
        self._refresh_npc_patrol_overlay()
        self._refresh_group_boxes()
        self._canvas.set_selected_group(str(gid or "") or None)

    def _on_group_nudge(
        self, gid: str, dx: float, dy: float, autorepeat: bool = False,
    ) -> None:
        """方向键微移：一次按键 = 一条撤销命令；按住不放的连发合并成一条。"""
        gid = str(gid or "").strip()
        if not gid:
            return
        if autorepeat and self._nudge_session == gid:
            # 连发：直接改数据，不新开命令，也不重复走离开路径的 flush
            # （连发期间不会产生新的未应用编辑）。收口在 _finish_nudge_session。
            sc = self._group_write_target_scene(gid)
            if sc is None:
                return
            if self._translate_group_members(sc, gid, dx, dy) == 0:
                return
            # 必须走 _mark_canvas_edit（不能只 mark_dirty 模型）：位移写的是
            # 「成员的当前真相份」，可能是 staging；不点亮 pending 的话，出口的
            # commit-on-leave 被 is_pending_dirty 门控挡掉，staging 永远回灌不到
            # source——模型少了那几个成员的位移，用户回头点它还会被旧值抹掉。
            self._mark_canvas_edit()
            self._after_group_translate(sc, gid, dx, dy)
            self._nudge_idle_timer.start(400)
            return
        # 非连发：先收口上一串（flush 入口里也会收口，这里是显式表达意图）
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        sc = self._group_write_target_scene(gid)
        if sc is None:
            return
        before = copy.deepcopy(sc)
        if self._translate_group_members(sc, gid, dx, dy) == 0:
            return
        self._mark_canvas_edit()  # 同上：位移可能落在 staging，必须点亮 pending
        self._after_group_translate(sc, gid, dx, dy)
        # 命令等这一串连发结束再入栈：before 已在此刻抓好
        self._nudge_session = gid
        self._nudge_before = before
        self._nudge_idle_timer.start(400)

    def _finish_nudge_session(self) -> None:
        """把一串方向键微移收口成一条撤销命令（幂等；无会话时空转）。"""
        gid = self._nudge_session
        before = self._nudge_before
        self._nudge_session = ""
        self._nudge_before = None
        self._nudge_idle_timer.stop()
        if not gid or before is None or self._undo.restoring:
            return
        sid = self._current_scene_id or ""
        if not sid:
            return
        self._undo.complete_deferred(sid, f"微移分组 {gid}", before)

    def _resolved_group_id_after_flush(self, gid: str) -> str:
        """flush 之后该用哪个 gid。

        面板的「应用位移」「把手回到中心」都要先提交未应用编辑，而那次提交
        可能就把组改名了——继续用按钮按下时的旧 id 查，会查到空成员/空条目，
        于是按钮什么都不做也不吭声（死按钮）。提交后以面板持有的 id 为准。
        """
        props = self._props
        if props._stack.currentWidget() == props._group_panel:
            current = str(props._group_original_id or "").strip()
            if current:
                return current
        return str(gid or "").strip()

    def _on_group_translate_requested(self, gid: str, dx: float, dy: float) -> None:
        """分组面板「应用位移」：与拖动同一条写入通道，一次 = 一条撤销命令。"""
        gid = str(gid or "").strip()
        if not gid:
            return
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        gid = self._resolved_group_id_after_flush(gid)
        sc = self._group_write_target_scene(gid)
        if sc is None:
            return
        members = self._group_members(sc, gid)
        if not members:
            QMessageBox.information(
                self, "整组位移", f"分组「{gid}」当前没有成员，没有可位移的对象。")
            return
        with self._undo.capture(f"整组位移 {gid}"):
            changed = self._translate_group_members(sc, gid, dx, dy)
            if changed == 0:
                return
            # 同拖动/微移：位移可能落在 staging，必须点亮 pending，capture 出口的
            # commit-on-leave 才会把它回灌 source（只 mark_dirty 模型是半份移动）。
            self._mark_canvas_edit()
            self._after_group_translate(sc, gid, dx, dy)

    def _on_group_anchor_committed(self, gid: str, x: float, y: float) -> None:
        """Alt+拖把手：写 editor.anchor（把兼容标签组升级为显式分组实体）。"""
        gid = str(gid or "").strip()
        if not gid:
            return
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        sc = self._group_write_target_scene(gid)
        if sc is None:
            return
        with self._undo.capture(f"移动分组把手 {gid}"):
            g = self._ensure_group_def(sc, gid)
            if g is None:
                return
            ed = g.get("editor")
            ed = ed if isinstance(ed, dict) else {}
            ed["anchor"] = {"x": round(float(x), 1), "y": round(float(y), 1)}
            g["editor"] = ed
            self._model.mark_dirty("scene", self._current_scene_id or "")
            self._resync_group_staging(g)
            self._refresh_group_boxes()
            self._canvas.set_selected_group(gid)

    def _on_group_anchor_reset_requested(self, gid: str) -> None:
        """把手回到中心：删掉 editor.anchor（editor 空了就整个删，不留空壳键）。"""
        gid = str(gid or "").strip()
        if not gid:
            return
        # 先提交再判断：提交可能改名，用旧 id 判"有没有 anchor"会判到另一个组
        # （或判不到），按钮就成了点了没反应的死按钮。
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        gid = self._resolved_group_id_after_flush(gid)
        sc = self._group_write_target_scene(gid)
        if sc is None:
            return
        g = self._group_def(sc, gid)
        ed = g.get("editor") if isinstance(g, dict) else None
        if not isinstance(ed, dict) or "anchor" not in ed:
            QMessageBox.information(
                self, "分组把手", "该分组没有自定义把手位置，本来就在包围盒中心。")
            return
        with self._undo.capture(f"重置分组把手 {gid}"):
            g = self._group_def(sc, gid)
            if not isinstance(g, dict):
                return
            ed = g.get("editor")
            if not isinstance(ed, dict):
                return
            ed.pop("anchor", None)
            if ed:
                g["editor"] = ed
            else:
                g.pop("editor", None)
            self._model.mark_dirty("scene", self._current_scene_id or "")
            self._resync_group_staging(g)
            self._refresh_group_boxes()
            self._canvas.set_selected_group(gid)

    def _ensure_group_def(self, sc: dict, gid: str) -> dict | None:
        """取显式分组条目；旧标签组按需升格（保护性拒绝畸形 entityGroups）。"""
        g = self._group_def(sc, gid)
        if g is not None:
            return g
        raw = sc.get("entityGroups")
        if raw is not None and not isinstance(raw, list):
            QMessageBox.warning(
                self, "场景分组",
                "当前 entityGroups 不是数组；为保护原数据，编辑器不会覆盖它。请先修复校验错误。")
            return None
        groups = raw if isinstance(raw, list) else []
        if raw is None:
            sc["entityGroups"] = groups
        g = {"id": gid}
        groups.append(g)
        return g

    def _resync_group_staging(self, group: dict) -> None:
        """模型层直写分组后重绑 staging：否则面板手里的旧副本会在下次提交时覆盖回去
        （画布/表单零丢失范式的 commit-on-leave 同族坑）。"""
        props = self._props
        if (
            props._stack.currentWidget() == props._group_panel
            and str(props._group_original_id or "").strip()
            == str(group.get("id") or "").strip()
        ):
            props.rebind_group_after_commit(group)

    def _on_group_delete_requested(self, gid: str) -> None:
        """画布右键「删除该分组」：与实体树右键删除同一条路径（带入站引用阻断）。"""
        gid = str(gid or "").strip()
        sc = self._model.scenes.get(self._current_scene_id or "")
        if not gid or not isinstance(sc, dict):
            return
        self._delete_scene_group(sc, gid)

    def _on_group_select_members_requested(self, gid: str) -> None:
        """在画布/树上选中该组全部成员（画布无图元的成员靠树参与批量操作）。"""
        gid = str(gid or "").strip()
        sc = self._model.scenes.get(self._current_scene_id or "")
        if not gid or not isinstance(sc, dict):
            return
        refs = [(kind, str(ent.get("id") or ""))
                for kind, ent in self._group_members(sc, gid)
                if str(ent.get("id") or "")]
        if not refs:
            QMessageBox.information(
                self, "选中成员", f"分组「{gid}」当前没有成员。")
            return
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        self._canvas.set_selected_group(None)
        self._syncing_tree_selection = True
        try:
            self._canvas.clear_selection()
            for item in self._iter_entity_tree_items():
                data = item.data(0, Qt.ItemDataRole.UserRole)
                item.setSelected(bool(data) and tuple(data) in set(refs))
            for kind, eid in refs:
                canvas_item = self._canvas.entity_item_by_key(f"{kind}:{eid}")
                if canvas_item is not None:
                    canvas_item.setSelected(True)
        finally:
            self._syncing_tree_selection = False
        if len(refs) == 1:
            self._on_item_selected(refs[0][0], refs[0][1])
        else:
            self._props.show_multi_selection(len(refs))
        self._sync_transform_gizmo()

    def build_entity_tree_context_menu(self, refs: list[tuple[str, str]]) -> QMenu:
        """构造实体树右键菜单（与 exec 分离，同 `build_group_context_menu`：
        `QMenu.exec` 在 PySide 里打桩不掉，离屏测试一碰就永久阻塞）。
        动作用 `setData(key)` 标身份，派发走 `_run_tree_context_action`——
        测试据此从"菜单里真有这一项 + 这一项真接到那个函数"两侧进。"""
        can_group = any(r[0] in ("npc", "hotspot", "zone") for r in refs)
        menu = QMenu(self)
        act_group = menu.addAction("指派分组…")
        act_group.setData("group")
        act_group.setToolTip("给选中实体指派/移出分组（group 标签）")
        act_group.setEnabled(can_group)
        act_tpl = menu.addAction("应用状态机模板…")
        act_tpl.setData("template")
        act_tpl.setToolTip(
            "给选中的 NPC / 热点 / Zone 批量盖一份叙事状态机产物；"
            "图 id 与 ownerId 由实体推导，暂存后由「全部保存」落盘")
        act_tpl.setEnabled(can_group)
        act_dup = menu.addAction("复制")
        act_dup.setData("duplicate")
        act_dup.setEnabled(any(r[0] in ("npc", "hotspot", "zone", "spawn") for r in refs))
        act_del = menu.addAction("删除")
        act_del.setData("delete")
        return menu

    def _run_tree_context_action(self, key: str) -> None:
        if key == "group":
            self._assign_group_to_selection()
        elif key == "template":
            self._apply_state_machine_template_to_selection()
        elif key == "duplicate":
            self._duplicate_selected()
        elif key == "delete":
            self._delete_selected()

    def _on_tree_context_menu(self, pos) -> None:
        refs = self._tree_selected_refs()
        if not refs:
            return
        menu = self.build_entity_tree_context_menu(refs)
        chosen = menu.exec(self._entity_tree.viewport().mapToGlobal(pos))
        self._run_tree_context_action(str(chosen.data()) if chosen is not None else "")

    def _add_scene_group(self) -> None:
        sc = self._require_scene()
        if sc is None:
            return
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        with self._undo.capture("新增场景分组"):
            raw = sc.get("entityGroups")
            if raw is not None and not isinstance(raw, list):
                QMessageBox.warning(
                    self, "新增场景分组",
                    "当前 entityGroups 不是数组；为保护原数据，编辑器不会覆盖它。请先修复校验错误。",
                )
                return
            groups = raw if isinstance(raw, list) else []
            existing = {gid for gid, _label in self._model.scene_group_ids_for_scene(
                self._current_scene_id)}
            gid = self._unique_entity_id("new_group", existing)
            if raw is None:
                sc["entityGroups"] = groups
            groups.append({"id": gid})
            self._model.mark_dirty("scene", self._current_scene_id or "")
            self._refresh_entity_tree()
            # 新组的画布框要立刻出现：否则要等下一次场景重载才看得见（下面
            # setCurrentItem 触发的 set_selected_group 也会因为框不存在而落空）。
            self._refresh_group_boxes()
            for item in self._iter_entity_tree_items():
                data = item.data(0, Qt.ItemDataRole.UserRole)
                if data and tuple(data) == ("group", gid):
                    self._entity_tree.setCurrentItem(item)
                    item.setSelected(True)
                    break

    def _narrative_page_with_unsaved_draft(self):
        """叙事状态机页若开着**未保存的网页草稿**就返回它，否则 None。

        批量盖章写的是 `model.narrative_graphs`；叙事页的 React 文档是加载期快照，
        它下一次 Ctrl+S 会整份回写——信号有 merge_host_only_author_signals 兜底补回，
        **作曲没有**，这一批 100 张图会被静默抹掉。所以有草稿时拦住，让用户自己决定
        先保存还是先放弃（fail-safe：取不到脏态也按"有草稿"拦）。
        """
        win = self.parent()
        while win is not None and not hasattr(win, "_editor_instances"):
            win = win.parent()
        if win is None:
            # 沿 parent 链找不到主窗 = 完全不知道叙事页什么状态。fail-safe 必须按
            # "有草稿"拦（返回哨兵真值），不能空转放行——docstring 承诺的正是这个，
            # 早先的实现只对 dirty_state 为 None 做到了、对找不到主窗没做到（终审 H6）。
            return object()
        for editor in getattr(win, "_editor_instances", None) or []:
            state_fn = getattr(editor, "_web_editor_dirty_state", None)
            if not callable(state_fn):
                continue
            if state_fn() is not False:
                return editor
        return None

    def _notify_narrative_projection_stale(self) -> None:
        """批量盖章写完模型后，通知叙事状态机页「你的投影旧了」（reload_from_model 鸭子协议）。"""
        win = self.parent()
        while win is not None and not hasattr(win, "_editor_instances"):
            win = win.parent()
        for editor in getattr(win, "_editor_instances", None) or []:
            reload_fn = getattr(editor, "reload_from_model", None)
            if callable(reload_fn) and hasattr(editor, "_web_editor_dirty_state"):
                reload_fn()

    def _apply_state_machine_template_to_selection(self) -> None:
        """选中实体批量盖状态机模板：全有全无暂存进 ProjectModel，零磁盘写。

        入口放在这里而不是叙事编辑器：100 个箱子是**摆的时候**顺手绑的，
        绕去叙事页手建 100 张 wrapper 图不是人干的事（见
        artifact/Reviews/叙事状态机-存量债与实例化评估-2026-08-09.md 第三节）。
        """
        from ..shared.narrative_template_batch import (
            apply_batch_stamp, scene_entity_targets,
        )
        from ..shared.narrative_template_batch_dialog import NarrativeTemplateBatchDialog

        refs = self._selected_entity_refs_plural()
        targets = scene_entity_targets(self._model, self._current_scene_id or "", refs)
        if not targets:
            QMessageBox.information(
                self, "应用状态机模板",
                "请先选中 NPC / 热点 / Zone（出生点与分组没有运行时 owner 索引，盖出来的图收不到信号）。")
            return
        dirty_page = self._narrative_page_with_unsaved_draft()
        if dirty_page is not None:
            QMessageBox.warning(
                self, "应用状态机模板",
                "「叙事状态机」页有未保存的草稿。批量盖章写进的是同一份 narrative_graphs，"
                "那边下一次保存会把这一批作曲整份覆盖掉。\n\n请先去叙事页保存或放弃草稿，再回来盖章。")
            return
        skipped = len(refs) - len(targets)
        dialog = NarrativeTemplateBatchDialog(self._model, targets, parent=self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        plan = dialog.plan()
        if plan is None or not plan.get("ok"):
            QMessageBox.warning(
                self, "应用状态机模板",
                "盖章未执行：" + "；".join(str(m) for m in (plan or {}).get("errors", [])[:4]))
            return
        summary = apply_batch_stamp(self._model, plan)
        # 关键（终审 B1）：叙事页的 React 文档是加载期快照，它下一次 flush 会整份回写
        # compositions（signals 有 merge 兜底、作曲没有）——不通知重投影，这一批图会在
        # 用户下次去叙事页随手改点什么并保存时被静默抹掉。宿主写模型后让网页重投影的
        # 机制是现成的（Task apply 路径同款）：标脏 reload，下次进页自动重载。
        # 上面的脏草稿闸仍保留（防"正在编辑中被盖章冲掉"的反向时序），两道一起才闭合。
        self._notify_narrative_projection_stale()
        lines = [f"已暂存 {len(summary.get('compositions', []))} 份作曲（尚未落盘，请用「全部保存」）。"]
        if summary.get("quests"):
            lines.append(f"镜像任务：{len(summary['quests'])} 条")
        if summary.get("stubs"):
            lines.append(f"对话桩：{len(summary['stubs'])} 份")
        if summary.get("visibilityWired"):
            lines.append(f"显隐条件已接：{len(summary['visibilityWired'])} 个实体（各接到自己那张图）")
        if skipped:
            lines.append(f"已跳过 {skipped} 个不支持的选中项（出生点 / 分组）。")
        if summary.get("warnings"):
            lines.append("提示：" + "；".join(str(w) for w in summary["warnings"][:4]))
        QMessageBox.information(self, "应用状态机模板", "\n".join(lines))

    def _assign_group_to_selection(self) -> None:
        """给选中实体指派场景分组引用；空=移出分组。"""
        refs = [r for r in self._selected_entity_refs_plural()
                if r[0] in ("npc", "hotspot", "zone")]
        if not refs:
            QMessageBox.information(
                self, "指派分组", "请先选中 NPC / 热区 / Zone（出生点不参与分组）。")
            return
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return
        rows = [
            ("__remove_group__", "（移出分组）", "清除选中实体的 group 引用"),
        ]
        rows.extend(
            (gid, label, f"当前场景分组 {gid}")
            for gid, label in self._model.scene_group_ids_for_scene(
                self._current_scene_id,
            )
        )
        current_groups = {
            str(e.get("group") or "").strip()
            for kind, eid in refs
            for e in sc.get({"npc": "npcs", "hotspot": "hotspots", "zone": "zones"}[kind], [])
            if isinstance(e, dict) and str(e.get("id") or "") == eid
        }
        current = next(iter(current_groups)) if len(current_groups) == 1 else ""
        dialog = ReferencePickerDialog(
            rows,
            current=current,
            title=f"给 {len(refs)} 个实体指派分组",
            parent=self,
            geometry_key="scene_group_assignment_picker",
        )
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        picked = dialog.selected_value()
        name = "" if picked == "__remove_group__" else str(picked or "").strip()
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        coll_key = {"npc": "npcs", "hotspot": "hotspots", "zone": "zones"}
        with self._undo.capture(f"指派分组 {name}" if name else "移出分组"):
            changed = False
            for kind, eid in refs:
                for e in sc.get(coll_key[kind], []):
                    if isinstance(e, dict) and str(e.get("id", "")) == eid:
                        if name:
                            if e.get("group") != name:
                                e["group"] = name
                                changed = True
                        elif "group" in e:
                            e.pop("group", None)
                            changed = True
                        break
            if changed:
                self._model.mark_dirty("scene", self._current_scene_id or "")
                # 重载重建 staging：防止已打开实体的旧 staging 稍后整体覆盖掉 group
                self._load_scene(self._current_scene_id, reset_view=False)

    def _on_items_batch_moved(self, moves: object) -> None:
        """多选整体拖动 release：逐项走单实体写回，一次手势收敛为一条撤销命令
        （before 取自 item_drag_press 的按下时快照）。"""
        before_info = self._drag_undo_before
        self._drag_undo_before = None
        items = [m for m in (moves or [])
                 if isinstance(m, (list, tuple)) and len(m) == 4]
        for kind, eid, x, y in items:
            self._on_item_moved_impl(str(kind), str(eid), float(x), float(y))
        if before_info is not None and items:
            self._undo.complete_deferred(
                before_info[0], f"移动 {len(items)} 个实体", before_info[1])
        self._sync_transform_gizmo()
        if items:
            self._refresh_group_boxes()  # 成员挪了 = 组包围盒变了

    # ---- 实例 transform gizmo（P3；quad 级真变换，与运行时同口径） ----------

    def _sync_transform_gizmo(self) -> None:
        """单选 hotspot/npc 时在其锚点显示旋转/缩放手柄；其余情况隐藏。"""
        refs = self._canvas_selected_entity_refs()
        if len(refs) != 1 or refs[0][0] not in ("hotspot", "npc"):
            self._canvas.hide_transform_gizmo()
            return
        kind, eid = refs[0]
        d = (self._staging_hotspot_for_canvas_drag(eid) if kind == "hotspot"
             else self._staging_npc_for_canvas_drag(eid))
        if d is None:
            self._canvas.hide_transform_gizmo()
            return
        s = entity_scale_of(d)
        rot = entity_rotation_deg_of(d)
        # 环半径按画布显示尺寸（× 透视系数）；gizmo 数值本体仍是实例 scale（提交不除回）
        pf = self._canvas.persp_factor(d, kind)
        if kind == "hotspot":
            di = d.get("displayImage") if isinstance(d.get("displayImage"), dict) else {}
            hint = max(
                float(di.get("worldWidth", 0) or 0),
                float(di.get("worldHeight", 0) or 0),
            ) * s * pf or 90.0
        else:
            rt = self._scene_npc_runtimes.get(eid)
            hint = (max(rt.world_w, rt.world_h) * s * pf) if rt is not None else 90.0
        self._canvas.show_transform_gizmo(
            kind, eid, float(d.get("x", 0)), float(d.get("y", 0)), s, rot, hint)

    def _gizmo_target_dict(self, kind: str, eid: str) -> dict | None:
        if kind == "hotspot":
            return self._staging_hotspot_for_canvas_drag(eid)
        if kind == "npc":
            return self._staging_npc_for_canvas_drag(eid)
        return None

    def _refresh_transform_previews(self, kind: str, eid: str, d: dict) -> None:
        eff_r = (float(d.get("interactionRange", 50) or 0)
                 * entity_scale_of(d) * self._canvas.persp_factor(d, kind))
        if kind == "hotspot":
            self._canvas.move_entity_handle("hotspot", eid, d.get("x", 0), d.get("y", 0))
            self._canvas.refresh_hotspot_visuals(d)
            self._canvas.update_interaction_range("hotspot", eid, eff_r)
        else:
            self._canvas.refresh_npc_collision_visuals(d)
            self._canvas.update_interaction_range("npc", eid, eff_r)
            # 精灵预览由动画 tick 从 staging 感知字典自动同步

    def _on_gizmo_transform_live(
        self, kind: str, eid: str, s: float, rot: float,
    ) -> None:
        if self._undo.restoring:
            return
        d = self._gizmo_target_dict(kind, eid)
        if d is None:
            return
        self._props._write_transform_fields_live(d, float(s), float(rot))
        self._props.sync_transform_widgets(kind, eid, float(s), float(rot))
        self._refresh_transform_previews(kind, eid, d)

    def _on_gizmo_transform_committed(
        self, kind: str, eid: str, s: float, rot: float,
    ) -> None:
        before_info = self._drag_undo_before
        self._drag_undo_before = None
        d = self._gizmo_target_dict(kind, eid)
        if d is None:
            return
        self._props._write_transform_fields_live(d, float(s), float(rot))
        self._props.sync_transform_widgets(kind, eid, float(s), float(rot))
        self._mark_canvas_edit()
        self._refresh_transform_previews(kind, eid, d)
        if before_info is not None:
            self._undo.complete_deferred(before_info[0], "调整实例变换", before_info[1])
        self._sync_transform_gizmo()
        self._refresh_group_boxes()  # scale/rotation 改了成员画布占位

    def _on_npc_ref_toggled(self, checked: bool) -> None:
        self._canvas.set_npc_reference_visible(checked)
        if self._last_canvas_world is None:
            return
        ww, wh = self._last_canvas_world
        rw, rh = _npc_reference_world_size(self._model)
        self._canvas.rebuild_npc_reference(ww, wh, rw, rh)

    def _on_block_zone_pick_toggled(self, checked: bool) -> None:
        if checked:
            for it in list(self._canvas.selected_items()):
                if isinstance(it, _EditableZonePolygon):
                    it.setSelected(False)
        self._canvas.set_zone_pick_frozen(checked)

    def _on_canvas_zoom_in(self) -> None:
        # mirror wheelEvent zoom factor; pure view transform, no data change
        self._canvas.zoom_by_step(1.15)

    def _on_canvas_zoom_out(self) -> None:
        self._canvas.zoom_by_step(1 / 1.15)

    def _on_canvas_zoom_fit(self) -> None:
        self._canvas.fit_all()

    def _on_item_selected(self, kind: str, eid: str) -> None:
        if self._restoring_blocked_navigation:
            return
        # 多选（≥2 实体）时不装载单实体面板：右侧转多选页做批量操作。
        if len(self._canvas_selected_entity_refs()) > 1:
            if not self._undo_flush_pending_as_command():
                self._restore_editing_selection_after_block()
                return
            self._props.show_multi_selection(
                len(self._canvas_selected_entity_refs()))
            return
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
                    if not self._undo_flush_pending_as_command():
                        self._restore_editing_selection_after_block()
                        return
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
                    if not self._undo_flush_pending_as_command():
                        self._restore_editing_selection_after_block()
                        return
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
                    if not self._undo_flush_pending_as_command():
                        self._restore_editing_selection_after_block()
                        return
                    props.load_zone_props(zone)
                    return
        elif kind == "spawn":
            if (
                props._stack.currentWidget() == props._spawn_panel
                and str(props._spawn_name_original or "") == str(eid)
            ):
                return
            if not self._undo_flush_pending_as_command():
                self._restore_editing_selection_after_block()
                return
            scene_use = props._staging_scene
            if scene_use is None or scene_use.get("id") != sc.get("id"):
                scene_use = sc
            props.load_spawn_props(scene_use, eid)

    def _on_item_deselected(self) -> None:
        if self._restoring_blocked_navigation or self._syncing_tree_selection:
            return
        # 组框熄灯必须等提交成功之后：保护性校验挡下这次"点空白"时，树/面板还
        # 停在该组，先熄灯就成了"面板显示着组、方向键却不动"的三方脱节。
        if self._current_scene_id:
            sc = self._model.scenes.get(self._current_scene_id)
            if sc:
                # 点画布空白=离开当前实体，与切实体路径一致：先提交未应用编辑再回场景面板。
                # 旧实现直接重建 staging，把编辑连同 pending 标志一起静默丢弃（审查 P0-3）。
                if not self._undo_flush_pending_as_command():
                    self._restore_editing_selection_after_block()
                    return
                sc = self._model.scenes.get(self._current_scene_id) or sc
                self._props.load_scene_props(sc, clear_pending_edits=False)
        self._canvas.set_selected_group(None)
        self._refresh_npc_patrol_overlay()

    def _on_props_interaction_range_changed(self, kind: str, eid: str, r: float) -> None:
        if not eid:
            return
        d = None
        if kind == "hotspot":
            d = self._staging_hotspot_for_canvas_drag(eid)
        elif kind == "npc":
            d = self._staging_npc_for_canvas_drag(eid)
        # 画布交互圈显示有效半径（× 实例 scale × 透视系数），与运行时 effectiveInteractionRange 同口径
        self._canvas.update_interaction_range(
            kind, eid, float(r) * entity_scale_of(d) * self._canvas.persp_factor(d, kind))

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
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        with self._undo.capture("编辑 Zone 多边形"):
            self._on_item_zone_polygon_committed_impl(kind, eid, polygon)

    def _on_item_zone_polygon_committed_impl(
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
        self._refresh_group_boxes()  # zone 是组成员时，多边形改动会改组包围盒

    def _on_item_hotspot_collision_polygon_committed(self, eid: str, polygon: object) -> None:
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        with self._undo.capture("编辑热区碰撞多边形"):
            self._on_item_hotspot_collision_polygon_committed_impl(eid, polygon)

    def _on_item_hotspot_collision_polygon_committed_impl(self, eid: str, polygon: object) -> None:
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
            # 命中面幽灵轮廓随新顶点重派生（延迟回调里做，不在鼠标事件栈内动图元）
            self._canvas.refresh_hotspot_visuals(target)
            self._canvas.item_selected.emit("hotspot_collision", eid)

        QTimer.singleShot(0, self, _deferred_hotspot_collision_ui)

    def _on_props_hotspot_collision_polygon_changed(self, eid: str, polygon: object) -> None:
        poly_list = polygon if isinstance(polygon, list) else []
        if len(poly_list) < 3:
            return
        self._canvas.update_hotspot_collision_polygon(eid, poly_list)

    def _on_item_npc_collision_polygon_committed(self, eid: str, polygon: object) -> None:
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        with self._undo.capture("编辑 NPC 碰撞多边形"):
            self._on_item_npc_collision_polygon_committed_impl(eid, polygon)

    def _on_item_npc_collision_polygon_committed_impl(self, eid: str, polygon: object) -> None:
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
            # 命中面幽灵轮廓随新顶点重派生（延迟回调里做，不在鼠标事件栈内动图元）
            self._canvas.refresh_npc_collision_visuals(target)
            self._canvas.item_selected.emit("npc_collision", eid)

        QTimer.singleShot(0, self, _deferred_npc_collision_ui)

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
            # 热点没有动画 runtime，走不到 tick 那条重排；拖动改了脚底 y 就得重排
            self._resort_canvas_content_z()
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
            # 去所有权化：主画布拖动只更新坐标，AI 写的未知键透传保留（与
            # TargetSpawnPickerDialog 同修法；审查 P2 主画布路径漏改）。
            from ..shared.rebuild_merge import merge_preserving_unknown
            if eid == "default":
                old = scw.get("spawnPoint") if isinstance(scw.get("spawnPoint"), dict) else {}
                scw["spawnPoint"] = merge_preserving_unknown(old, {"x": rx, "y": ry}, {"x", "y"})
            else:
                sps = scw.setdefault("spawnPoints", {})
                old = sps.get(eid) if isinstance(sps.get(eid), dict) else {}
                sps[eid] = merge_preserving_unknown(old, {"x": rx, "y": ry}, {"x", "y"})
            self._props.sync_spawn_xy_widgets(eid, rx, ry)

    @staticmethod
    def _xy_unchanged(d: dict, rx: float, ry: float) -> bool:
        try:
            return (
                isinstance(d.get("x"), (int, float)) and not isinstance(d.get("x"), bool)
                and isinstance(d.get("y"), (int, float)) and not isinstance(d.get("y"), bool)
                and float(d["x"]) == float(rx) and float(d["y"]) == float(ry)
            )
        except (TypeError, ValueError):
            return False

    def _on_drag_cancelled(self, kind: str, eid: str, ox: float, oy: float) -> None:
        """Esc 取消拖拽：把 live 拖拽期间写进 staging 的坐标恢复到按下前值。
        走 _on_item_position_live（写 staging + 刷新视觉/数值框，但不 mark_dirty），
        因 mark_dirty 只在 release 的 _on_item_moved 发生，取消后 release 被吞，故无脏。"""
        self._drag_undo_before = None
        self._on_item_position_live(kind, eid, ox, oy)

    def _on_item_moved(self, kind: str, eid: str, x: float, y: float) -> None:
        """release 落点写回 + 完成「按下时捕获」的延迟撤销命令。

        before 取自 _on_canvas_drag_press（live 拖拽会污染 staging 旧值）；
        零位移/无效实体等早退路径 diff 为空，自然不入栈。"""
        before_info = self._drag_undo_before
        self._drag_undo_before = None
        self._on_item_moved_impl(kind, eid, x, y)
        if before_info is not None:
            label = {"hotspot": "拖动热区", "npc": "拖动 NPC", "spawn": "拖动出生点"}.get(
                kind, f"拖动 {kind}")
            self._undo.complete_deferred(before_info[0], label, before_info[1])
        self._sync_transform_gizmo()
        if kind in ("hotspot", "npc"):
            self._refresh_group_boxes()  # 成员挪了 = 组包围盒变了

    def _on_item_moved_impl(self, kind: str, eid: str, x: float, y: float) -> None:
        rx = round(x, 1)
        ry = round(y, 1)
        keep = self._props._keep_num
        if kind == "hotspot":
            hs = self._staging_hotspot_for_canvas_drag(eid)
            if hs is None:
                return
            # 值未变（画布拾取/微抖后归位）跳过：不写坐标、不标脏，且保留 int/高精度原值。
            if self._xy_unchanged(hs, rx, ry):
                return
            hs["x"] = keep(rx, hs.get("x"))
            hs["y"] = keep(ry, hs.get("y"))
            self._canvas.refresh_hotspot_visuals(hs)
            self._props.sync_hotspot_xy_widgets(eid, rx, ry)
            self._mark_canvas_edit()
            return
        if kind == "npc":
            npc = self._staging_npc_for_canvas_drag(eid)
            if npc is None:
                return
            if self._xy_unchanged(npc, rx, ry):
                return
            npc["x"] = keep(rx, npc.get("x"))
            npc["y"] = keep(ry, npc.get("y"))
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
                old = scw.get("spawnPoint") if isinstance(scw.get("spawnPoint"), dict) else {}
                if self._xy_unchanged(old, rx, ry):
                    return
                from ..shared.rebuild_merge import merge_preserving_unknown
                scw["spawnPoint"] = merge_preserving_unknown(
                    old, {"x": keep(rx, old.get("x")), "y": keep(ry, old.get("y"))}, {"x", "y"})
            else:
                sps = scw.setdefault("spawnPoints", {})
                old = sps.get(eid) if isinstance(sps.get(eid), dict) else {}
                if self._xy_unchanged(old, rx, ry):
                    return
                from ..shared.rebuild_merge import merge_preserving_unknown
                sps[eid] = merge_preserving_unknown(
                    old, {"x": keep(rx, old.get("x")), "y": keep(ry, old.get("y"))}, {"x", "y"})
            self._props.sync_spawn_xy_widgets(eid, rx, ry)
            self._mark_canvas_edit()

    def flush_to_model(self) -> bool:
        """Save All / 关闭前 flush：仅在确有未应用编辑时才提交 staging。

        与 ``confirm_close`` / ``_commit_pending_scene_edits`` 一致走 ``is_pending_dirty``
        门控。此前无条件 ``_apply_props()`` 会在末尾 ``mark_dirty("scene")``，于是"打开
        编辑器啥都没改直接关闭"也被伪标脏、弹出保存提示（关窗时对所有面板逐个 flush）。"""
        if self._props.is_pending_dirty():
            return self._apply_props()
        return True

    def commit_pending_on_leave(self) -> bool:
        """主窗切到别的编辑器页之前提交未应用的属性编辑（鸭子协议钩子）。

        必须走 ``_undo_flush_pending_as_command``——**不能**裸调
        ``_commit_pending_scene_edits``。编辑器内部的每一条离开路径（切实体 / 切场景 /
        点空白 / 新增实体 / 拖拽前）都把这次提交记成独立撤销命令，「应用」按钮也进栈；
        只有这里裸提交的话，同一个"离开当前编辑"动作会因为离开的是实体还是编辑器页而有
        两套撤销语义，且因为写入不在栈里，一次 撤销+重做 会把这次配置静默还原掉。

        没有这个钩子的话，改完场景实体不点「应用」直接切页 = 模型里没有这次配置，
        其它编辑器的候选/引用当然看不到——正是"要重启编辑器才看得到"的第一层根因。

        返回 False = 有闸拦住没提交（草稿仍完整保留在本页），主窗只提示不阻断切页。
        """
        return self._undo_flush_pending_as_command()

    def reload_from_model(self) -> None:
        """Reproject the current scene after another editor replaced its domain.

        Callers must flush this editor first.  Task orchestration swaps the
        native ``model.scenes`` document transactionally, so property-panel
        source dict identities from the previous projection must not remain
        live or a later Apply could overwrite the new task conditions/actions.
        """
        scene_id = self._current_scene_id or ""
        selected = self._selected_entity_ref()
        if selected is not None:
            selected = (
                {
                    "npc_collision": "npc",
                    "hotspot_collision": "hotspot",
                }.get(selected[0], selected[0]),
                selected[1],
            )
        self._refresh_scene_list()
        if scene_id and scene_id in self._model.scenes:
            self._load_scene(scene_id, reset_view=False)
            if selected is not None and selected[0] in {"npc", "hotspot", "zone"}:
                # _load_scene intentionally clears old source/staging dicts.
                # Re-select against the replacement model so the still-visible
                # property form can never become an editable no-op detached
                # from live data. If the entity disappeared, _load_scene's
                # scene panel remains active and old entity fields stay hidden.
                self._select_scene_entity_by_kind(
                    selected[0],
                    selected[1],
                    scene_id,
                )

    def confirm_close(self, parent: QWidget | None = None) -> bool:
        """关闭 / 切项目门控钩子（被 MainWindow._confirm_pending_editor_changes 调用）。

        把未应用的画布/面板编辑提交进模型，让随后的 is_dirty 检查能感知并弹出保存
        提示，修复"拖拽/改名后关闭或切项目静默丢弃"（HIGH-11/12）。正常提交后由
        主窗口统一询问是否保存；若保护性校验拒绝提交（如畸形 entityGroups），则返回
        False 阻断关闭，不能让只存在于表单 staging 的修改绕过 model dirty 门闸而丢失。
        """
        if self._props.is_pending_dirty():
            if not self._apply_props():
                return False
        return not (
            self._props.is_pending_dirty()
            or getattr(self._props, "_group_commit_blocked", False)
        )

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

    def _commit_pending_scene_edits(self) -> bool:
        """commit-on-leave：离开当前实体/场景前，把未应用的 staging 编辑提交回模型。

        消除"切实体/切场景静默丢弃拖拽"的丢数据簇（HIGH-5/7/14）。只在确有未应用
        编辑时执行（is_pending_dirty 门控，避免无谓 flush 与日志噪声），且不触碰画布
        （即将离开当前视图，重绘交由目标视图加载）。
        """
        props = self._props
        if not props.is_pending_dirty():
            return True
        sc_id = self._current_scene_id or ""
        if not sc_id or self._model.scenes.get(sc_id) is None or props._source_scene is None:
            props._set_pending_dirty(False)
            return True
        props.flush_pending_to_model()          # 可见面板 widgets -> staging
        if not self._preflight_group_commit(self._model.scenes[sc_id]):
            props._set_pending_dirty(True)
            return False
        self._preflight_entity_id_commit(self._model.scenes[sc_id])
        props.commit_scene_staging_to_source()  # 场景级非列表字段（含 spawnPoint/spawnPoints）
        self._commit_staging_dict_into(props._source_hotspot, props._staging_hotspot)
        self._commit_staging_dict_into(props._source_npc, props._staging_npc)
        self._commit_staging_dict_into(props._source_zone, props._staging_zone)
        self._commit_group_staging(self._model.scenes[sc_id])
        if props._group_commit_blocked:
            props._set_pending_dirty(True)
            return False
        self._model.mark_dirty("scene", sc_id)
        props._set_pending_dirty(False)
        return True

    # ---- 撤销 / 重做（快照命令；机制见 scene_undo.py 模块注释） -------------

    def _undo_flush_pending_as_command(self) -> bool:
        """离开路径（切实体/切场景/点空白）的 commit-on-leave：语义同
        `_commit_pending_scene_edits`，额外把这次提交记为可撤销命令。

        进来先收口未结束的方向键微移会话——否则那一串连发的 before 快照会跨过
        本次提交，撤销时把别的编辑一起回滚。"""
        self._finish_nudge_session()
        return self._undo.flush_pending_as_command()

    def _on_canvas_drag_press(self) -> None:
        """画布左键按到可拖图元：先把未应用编辑提交为独立命令，再捕获
        「拖拽前」整场景快照，供 release 的 `_on_item_moved` 完成延迟命令。"""
        if self._undo.restoring:
            return
        sid = self._current_scene_id or ""
        sc = self._model.scenes.get(sid)
        if not sid or sc is None:
            self._drag_undo_before = None
            return
        if not self._undo.flush_pending_as_command():
            self._drag_undo_before = None
            # 整组拖动据此在 press 阶段就作废本次手势（实体拖拽维持既有行为）
            self._canvas.veto_group_gesture()
            self._restore_editing_selection_after_block()
            return
        self._drag_undo_before = (sid, copy.deepcopy(sc))

    @staticmethod
    def _focused_text_widget():
        """焦点在文本框内时 Ctrl+Z 交回该框做文本撤销（与 TimelineEditor 同法）。"""
        from PySide6.QtWidgets import (
            QApplication, QLineEdit, QPlainTextEdit, QTextEdit,
        )
        fw = QApplication.focusWidget()
        if isinstance(fw, (QLineEdit, QTextEdit, QPlainTextEdit)):
            return fw
        return None

    def _editor_undo(self) -> None:
        tw = self._focused_text_widget()
        if tw is not None:
            tw.undo()
            return
        # 未应用的 staging 编辑先提交为命令，再撤销——保证 Ctrl+Z 第一步撤的
        # 是屏幕上最新的改动，而不是跳过它撤更早的历史（零丢失范式）。
        # 走 self._undo_flush_pending_as_command（不是 controller 裸方法）：它还负责
        # 收口未结束的方向键微移会话，否则刚微移完按 Ctrl+Z 会跳过它撤更早的命令。
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        if self._undo.stack.canUndo():
            self._undo.stack.undo()

    def _editor_redo(self) -> None:
        tw = self._focused_text_widget()
        if tw is not None:
            tw.redo()
            return
        # pending 提交作为新命令入栈会按 Qt 语义截断 redo 分支（新编辑使旧
        # redo 失效）——比静默丢弃 pending 或让 redo 覆盖它都安全。
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        if self._undo.stack.canRedo():
            self._undo.stack.redo()

    # 主窗口 Edit 菜单的鸭子钩子（main_window._dispatch_undo/_dispatch_redo）。
    def editor_undo(self) -> None:
        self._editor_undo()

    def editor_redo(self) -> None:
        self._editor_redo()

    def _apply_scene_snapshot(self, sid: str, snapshot: dict | None) -> None:
        """命令回放：整场景 dict 回灌 +（当前场景时）画布/面板重载并还原选中。"""
        if snapshot is None:
            # P1 不覆盖场景创建/删除（_new_scene 不入栈），不应出现 None 快照。
            return
        self._undo.restoring = True
        try:
            sc = self._model.scenes.get(sid)
            if sc is None:
                self._model.scenes[sid] = copy.deepcopy(snapshot)
            else:
                sc.clear()
                sc.update(copy.deepcopy(snapshot))
            self._model.mark_dirty("scene", sid)
            if (self._current_scene_id or "") == sid:
                sel = self._capture_canvas_primary_selection()
                # 分组不进 Qt 选择系统，选中态得单独记；否则撤销一次整组位移后
                # 组框就熄灯、面板跳回场景页，用户得重新找回刚才那个组。
                sel_group = self._canvas.selected_group()
                # 先清 pending：_load_scene 顶部的 commit-on-leave 才不会用
                # 回放前的旧 staging 覆盖刚灌入的快照。
                self._props._set_pending_dirty(False)
                self._load_scene(sid, reset_view=False)
                if sel is not None:
                    self._restore_canvas_selection(sel[0], sel[1])
                if sel_group:
                    sc_now = self._model.scenes.get(sid)
                    if isinstance(sc_now, dict) and any(
                        gid == sel_group
                        for gid, _lbl in self._model.scene_group_ids_for_scene(sid)
                    ):
                        self._props.load_group_props(sc_now, sel_group)
                        self._canvas.set_selected_group(sel_group)
                        self._refresh_group_bounds_note()
                # restoring 短路了 selectionChanged 联动：树高亮与 gizmo 手动补同步
                # （数据已正确，纯呈现陈旧；审查 P2-C）。
                self._sync_tree_from_canvas(self._canvas_selected_entity_refs())
                self._sync_transform_gizmo()
        finally:
            self._undo.restoring = False

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
        # 背景导入是未命令化直写 + 文件副作用（PNG 已拷入 runtime，undo 无法回收）：
        # 该场景有命令历史时清栈，防"撤销穿越把背景引用抹掉"（审查 P1-A）。
        self._undo.notice_external_scene_write(sid)
        self._refresh_scene_canvas_viewport_after_commit(sc, sid)

    def _refresh_scene_canvas_viewport_after_commit(self, sc: dict, scene_id: str) -> None:
        img_path = _scene_background_disk_path(self._model, scene_id, sc)
        world_w, world_h = resolve_world_size_for_scene_json(sc, img_path)
        self._canvas.setup_world(world_w, world_h)
        self._canvas.clear_background()
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

    def _scene_group_inbound_references(
        self, scene_id: str, group_id: str,
    ) -> list[str]:
        """扫描会因分组改名/删除而悬垂的、可明确归属到该场景的引用。

        成员 ``entity.group`` 属于本场景内受控引用，会随改名级联/删除清除，不列为
        外部入站。叙事 sceneGroup owner 与同场景（或 params 显式 sceneId /
        targetScene）的批量 group action 无法由单场景撤销栈事务级联，故列出并阻断。
        """
        sid = str(scene_id or "").strip()
        gid = str(group_id or "").strip()
        qualified = f"{sid}:{gid}"
        hits: list[str] = []
        seen_objects: set[int] = set()

        def walk(obj: object, path: str, context_scene: str | None) -> None:
            if isinstance(obj, (dict, list)):
                oid = id(obj)
                if oid in seen_objects:
                    return
                seen_objects.add(oid)
            if isinstance(obj, dict):
                owner_scene = context_scene
                if str(obj.get("ownerType") or "").strip() == "sceneGroup":
                    owner_id = str(obj.get("ownerId") or "").strip()
                    if owner_id == qualified:
                        hits.append(f"{path}: narrative ownerId={qualified}")
                    if ":" in owner_id:
                        owner_scene = owner_id.split(":", 1)[0]
                if str(obj.get("type") or "") in ("setGroupEnabled", "moveGroupBy"):
                    params = obj.get("params") if isinstance(obj.get("params"), dict) else {}
                    action_group = str(params.get("group") or "").strip()
                    explicit_scene = str(
                        params.get("targetScene")
                        or params.get("sceneId")
                        or obj.get("targetScene")
                        or obj.get("sceneId")
                        or ""
                    ).strip()
                    if action_group == gid and (
                        owner_scene == sid or explicit_scene == sid
                    ):
                        action_type = str(obj.get("type") or "group action")
                        hits.append(f"{path}: {action_type}.params.group={gid}")
                for key, value in obj.items():
                    walk(value, f"{path}.{key}", owner_scene)
            elif isinstance(obj, list):
                for index, value in enumerate(obj):
                    walk(value, f"{path}[{index}]", context_scene)

        target_scene = self._model.scenes.get(sid)
        if isinstance(target_scene, dict):
            walk(target_scene, f"scene[{sid}]", sid)
        narrative = getattr(self._model, "narrative_graphs", None)
        if isinstance(narrative, (dict, list)):
            walk(narrative, "narrative_graphs", None)
        # 其它业务桶只有在 action 自带明确场景上下文时才算命中，避免把运行时
        # "当前场景"的裸 group 猜成任一场景并误拦合法数据。
        for attr, value in vars(self._model).items():
            if attr.startswith("_") or attr in ("scenes", "narrative_graphs"):
                continue
            if isinstance(value, (dict, list)):
                walk(value, attr, None)
        return list(dict.fromkeys(hits))

    def _block_group_commit(self, title: str, message: str) -> bool:
        props = self._props
        props._group_commit_blocked = True
        props._set_pending_dirty(True)
        QMessageBox.warning(self, title, message)
        return False

    # npc 与 hotspot 互为 emote / 实体寻址目标，共用一个命名空间（与 validator 的
    # "实体 id 重复" 检查、entity_refactor 的撞名互拒完全同口径）；zone 独立命名空间。
    _ENTITY_ID_NAMESPACES: dict[str, tuple[str, ...]] = {
        "hotspot": ("hotspots", "npcs"),
        "npc": ("hotspots", "npcs"),
        "zone": ("zones",),
    }
    _ENTITY_KIND_LABELS: dict[str, str] = {"hotspot": "热区", "npc": "NPC", "zone": "Zone"}

    @staticmethod
    def _entity_id_conflict(
        sc: dict, kind: str, source: dict, new_id: str,
    ) -> str | None:
        """返回冲突方的描述；无冲突返回 None。按对象身份排除自己，不按 id 比对。"""
        for list_key in SceneEditor._ENTITY_ID_NAMESPACES.get(kind, ()):
            for ent in sc.get(list_key) or []:
                if not isinstance(ent, dict) or ent is source:
                    continue
                if str(ent.get("id", "") or "").strip() == new_id:
                    other = {"hotspots": "热区", "npcs": "NPC", "zones": "Zone"}[list_key]
                    return f"同场景已有一个{other}叫这个 id"
        return None

    def _preflight_entity_id_commit(self, sc: dict) -> None:
        """提交前的实体 id 闸：空 id / 同命名空间撞名一律退回原 id 并提示。

        为什么必须有：id 输入框此前是裸写入（``ent["id"] = 输入框文本``），撞名只有事后
        ``validate-data`` 报 error 才能发现，而运行时 ``getNpcById`` 是 first-wins、画布图元
        按 ``kind:id`` 建键会互相覆盖、属性/删除按 id 首匹配——已经串台了才知道。口径与
        出生点改名的撞名闸一致：**只退回 id 这一个字段**，本轮其它编辑照常提交，不把用户
        整批编辑卡住。

        裸改 id 同样绕过重构引擎的入站引用改写，故提示里指向「重构 → 重命名 id」。
        """
        props = self._props
        for kind, source, staging in props.entity_staging_pairs():
            if not isinstance(source, dict) or not isinstance(staging, dict):
                continue
            old_id = str(source.get("id", "") or "").strip()
            new_id = str(staging.get("id", "") or "").strip()
            if new_id == old_id:
                continue
            label = self._ENTITY_KIND_LABELS.get(kind, kind)
            if not new_id:
                reason = "id 不能为空"
            else:
                conflict = self._entity_id_conflict(sc, kind, source, new_id)
                if conflict is None:
                    continue
                reason = f"「{new_id}」已被占用（{conflict}）"
            # 弹窗可能在"切页 / 点跳转"的半途出现，此时用户已经落到别的页面——
            # 标题与正文必须自带定位（哪个场景的哪个实体），不能只说"id 已被占用"。
            scene_id = self._current_scene_id or "?"
            QMessageBox.warning(
                self, f"{label} id 未改名 —— 场景「{scene_id}」",
                f"场景「{scene_id}」里的{label}「{old_id}」：{reason}。\n"
                "改名会让画布图元、属性面板与动作引用按 id 串台。\n"
                f"已退回原 id「{old_id}」，本次其它修改照常保存。\n\n"
                "如需改名并让全项目引用（动作参数 / 叙事 owner / 对话图）跟随，"
                "请回到「场景」页用工具栏「重构 → 重命名 id」。",
            )
            props.revert_entity_id(kind, old_id)

    def _preflight_group_commit(self, sc: dict) -> bool:
        """在任何 source 写入前验证 group staging，失败时完整保留草稿。"""
        props = self._props
        if not props._group_pending_changed or props._staging_group is None:
            props._group_commit_blocked = False
            return True
        staging = props._staging_group
        old_id = str(props._group_original_id or "").strip()
        new_id = str(staging.get("id") or "").strip()
        if not new_id:
            return self._block_group_commit(
                "场景分组无法提交", "分组 id 不能为空；草稿已保留，请修正后再离开。",
            )
        if ":" in new_id:
            return self._block_group_commit(
                "场景分组无法提交",
                "分组 id 不能包含 ':'；草稿已保留，请修正后再离开。",
            )
        groups = sc.get("entityGroups")
        if groups is not None and not isinstance(groups, list):
            return self._block_group_commit(
                "场景分组无法提交",
                "当前 entityGroups 不是数组。为保护原数据，本次分组编辑未提交、原字段未覆盖；"
                "请先根据 Validate Data 修复该字段。草稿与当前选择均会保留。",
            )
        if isinstance(groups, list) and any(
            group is not props._source_group
            and isinstance(group, dict)
            and str(group.get("id") or "").strip() == new_id
            for group in groups
        ):
            return self._block_group_commit(
                "场景分组无法提交",
                f"当前场景已经存在分组「{new_id}」；草稿已保留，请换一个 id。",
            )
        if old_id and new_id != old_id:
            refs = self._scene_group_inbound_references(
                self._current_scene_id or "", old_id,
            )
            if refs:
                preview = "\n".join(f"• {row}" for row in refs[:12])
                suffix = f"\n…另有 {len(refs) - 12} 处" if len(refs) > 12 else ""
                return self._block_group_commit(
                    "分组改名已阻断",
                    "该分组仍有无法由单场景撤销事务安全级联的入站引用。"
                    "请先在对应编辑器改掉这些引用，再重试；本次改名草稿未丢失：\n"
                    f"{preview}{suffix}",
                )
        props._group_commit_blocked = False
        return True

    def _commit_group_staging(self, sc: dict) -> dict | None:
        """提交分组表单并级联成员引用；仅真实编辑时才物化旧标签。"""
        props = self._props
        if not props._group_pending_changed or props._staging_group is None:
            return props._source_group
        if not self._preflight_group_commit(sc):
            return props._source_group
        staging = copy.deepcopy(props._staging_group)
        old_id = str(props._group_original_id or "").strip()
        new_id = str(staging.get("id") or "").strip()
        groups = sc.get("entityGroups")
        if not isinstance(groups, list):
            groups = []
            sc["entityGroups"] = groups
        source = props._source_group
        if source is None:
            source = staging
            groups.append(source)
        else:
            source.clear()
            source.update(staging)
        if old_id and new_id != old_id:
            for coll in ("npcs", "hotspots", "zones"):
                for member in sc.get(coll, []) or []:
                    if isinstance(member, dict) and str(member.get("group") or "").strip() == old_id:
                        member["group"] = new_id
        props._source_group = source
        props._group_original_id = new_id
        props._group_pending_changed = False
        return source

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
        item = self._canvas.entity_item_by_key(key)
        if item is None:
            self._canvas.add_hotspot(hs)
        elif isinstance(item, _DraggableCircle):
            item.setPos(float(hs.get("x", 0)), float(hs.get("y", 0)))
            item.set_interaction_range(
                float(hs.get("interactionRange", 50))
                * entity_scale_of(hs) * self._canvas.persp_factor(hs, "hotspot"))
        typ = str(hs.get("type", "inspect") or "inspect")
        self._canvas.update_hotspot_type_color(new_id, typ)
        lbl = str(hs.get("id", "") or "").strip() or new_id
        self._canvas.update_entity_circle_label("hotspot", new_id, lbl)
        self._canvas.refresh_hotspot_visuals(hs)
        # planes 归属可能被本次 Apply 改动：更新登记并全量重贴位面过滤（含由隐转显）。
        self._canvas.refresh_entity_view(key, hs)
        # 本次 Apply 可能改了 spriteSort / displayImage / 坐标 / 实例 transform，
        # 全都进排序键 —— 重排一次（脏检查会在没变时空转）。
        self._resort_canvas_content_z()

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
        item = self._canvas.entity_item_by_key(key)
        if item is None:
            self._canvas.add_npc(npc)
        elif isinstance(item, _DraggableCircle):
            item.setPos(float(npc.get("x", 0)), float(npc.get("y", 0)))
            item.set_interaction_range(
                float(npc.get("interactionRange", 50))
                * entity_scale_of(npc) * self._canvas.persp_factor(npc, "npc"))
        disp = str(npc.get("name", "") or "").strip() or new_id
        self._canvas.update_entity_circle_label("npc", new_id, disp)
        self._canvas.refresh_npc_collision_visuals(npc)
        self._refresh_one_scene_npc_anim(new_id)
        # planes 归属可能被本次 Apply 改动：更新登记并全量重贴位面过滤（含由隐转显）。
        self._canvas.refresh_entity_view(key, npc)
        # 同热点侧：spriteSort / 坐标 / 实例 transform 都进排序键
        self._resort_canvas_content_z()

    def _sync_zone_canvas_after_commit(self, old_id: str, zone: dict) -> None:
        new_id = str(zone.get("id", "") or "").strip()
        if not new_id:
            return
        if old_id and old_id != new_id:
            self._canvas.remove_zone_graphics(old_id)
        key = f"zone:{new_id}"
        item = self._canvas.entity_item_by_key(key)
        if item is None:
            self._canvas.add_zone(zone)
            if self._chk_block_zone_pick.isChecked():
                zit = self._canvas.entity_item_by_key(key)
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
        self._canvas.refresh_entity_view(key, zone)

    def _capture_canvas_primary_selection(self) -> tuple[str, str] | None:
        """返回画布当前选中图元的 (entity_kind, entity_id)；无选中则 None。"""
        for it in self._canvas.selected_items():
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
        it = self._canvas.entity_item_by_key(key)
        ek = kind
        if it is None:
            if kind == "hotspot_collision":
                it = self._canvas.entity_item_by_key(f"hotspot:{eid}")
                ek = "hotspot"
            elif kind == "npc_collision":
                it = self._canvas.entity_item_by_key(f"npc:{eid}")
                ek = "npc"
        if it is None:
            return
        self._canvas.clear_selection()
        it.setSelected(True)
        self._on_item_selected(ek, eid)

    def _try_select_canvas_item(self, kind: str, eid: str) -> None:
        key = f"{kind}:{eid}"
        it = self._canvas.entity_item_by_key(key)
        if it is None:
            return
        try:
            self._canvas.clear_selection()
        except (AttributeError, RuntimeError):
            pass
        it.setSelected(True)

    def _apply_props(self) -> bool:
        # Apply 的载荷就是未应用的 staging 编辑本身，故 commit_before=False：
        # before 快照取在提交之前，命令 diff 即本次 Apply 的全部内容。
        applied = False
        with self._undo.capture("应用属性", commit_before=False):
            applied = self._apply_props_impl()
        if not applied:
            self._restore_editing_selection_after_block()
            return False
        self._sync_transform_gizmo()
        # Apply 可能改了 id/name/group：树是模型投影，跟着刷（审查 P2-C）；
        # 重建清掉的树高亮按画布选中补回
        self._refresh_entity_tree()
        # 分组框同理是模型投影：成员坐标/尺寸、group 归属、组改名、把手都可能变
        self._refresh_group_boxes()
        if self._props._stack.currentWidget() == self._props._group_panel:
            gid = str(self._props._group_original_id or "").strip()
            self._canvas.set_selected_group(gid or None)
            self._refresh_group_bounds_note()
            for item in self._iter_entity_tree_items():
                data = item.data(0, Qt.ItemDataRole.UserRole)
                if data and tuple(data) == ("group", gid):
                    self._syncing_tree_selection = True
                    try:
                        item.setSelected(True)
                        self._entity_tree.scrollToItem(item)
                    finally:
                        self._syncing_tree_selection = False
                    break
        else:
            self._sync_tree_from_canvas(self._canvas_selected_entity_refs())
        return True

    def _apply_props_impl(self) -> bool:
        props = self._props

        active_panel = props._stack.currentWidget()
        props.flush_pending_to_model()

        sc_id = self._current_scene_id or ""
        sc_model = self._model.scenes.get(sc_id)
        if sc_model is None:
            return False

        # 保护性校验必须先于任何 source 写入，避免 group 失败时其它 staging 半提交。
        if not self._preflight_group_commit(sc_model):
            return False

        self._preflight_entity_id_commit(sc_model)

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
        committed_group = self._commit_group_staging(sc_model)
        if props._group_commit_blocked:
            props._set_pending_dirty(True)
            return False

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
        elif active_panel == props._group_panel and committed_group is not None:
            props.rebind_group_after_commit(committed_group)
        elif active_panel == props._spawn_panel:
            sk = str(props._spawn_name_original or "").strip() or "default"
            self._try_select_canvas_item("spawn", sk)
        # else 分支（其它面板）：scene rebind 已经清零 dirty，无需再做。

        # transient success feedback (UI only; never affects data)
        try:
            self.window().statusBar().showMessage("已应用到内存（尚未 Save All）", 3000)
        except (AttributeError, RuntimeError):
            pass
        return True

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
    def _namespace_entity_ids(sc: dict, kind: str):
        """某实体种类所在命名空间里已占用的全部 id（npc 与 hotspot 共用一个）。"""
        for list_key in SceneEditor._ENTITY_ID_NAMESPACES.get(kind, ()):
            for ent in sc.get(list_key) or []:
                if isinstance(ent, dict):
                    yield str(ent.get("id", "") or "")

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
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        with self._undo.capture("新增热区"):
            self._add_hotspot_at_impl(wx, wy)

    def _add_hotspot_at_impl(self, wx: float, wy: float) -> None:
        sc = self._require_scene()
        if sc is None:
            return
        wx = round(float(wx), 1)
        wy = round(float(wy), 1)
        hs_list = sc.setdefault("hotspots", [])
        # 取号查整个命名空间（含 npcs）：与 validator / 重构引擎口径一致，
        # 别只查自家列表——否则自动取的号可能一出生就跟同场景 NPC 撞名。
        new_id = self._unique_entity_id(
            "new_hotspot", self._namespace_entity_ids(sc, "hotspot"))
        hs_list.append({
            "id": new_id, "type": "inspect", "label": "", "x": wx, "y": wy,
            "interactionRange": 50, "data": {"text": ""},
        })
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id, reset_view=False)

    def _add_hotspot(self) -> None:
        self._add_hotspot_at(100, 100)

    def _add_npc_at(self, wx: float, wy: float) -> None:
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        with self._undo.capture("新增 NPC"):
            self._add_npc_at_impl(wx, wy)

    def _add_npc_at_impl(self, wx: float, wy: float) -> None:
        sc = self._require_scene()
        if sc is None:
            return
        wx = round(float(wx), 1)
        wy = round(float(wy), 1)
        npc_list = sc.setdefault("npcs", [])
        new_id = self._unique_entity_id(
            "new_npc", self._namespace_entity_ids(sc, "npc"))
        npc_list.append({
            "id": new_id, "name": "New NPC", "x": wx, "y": wy,
            "interactionRange": 50,
        })
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id, reset_view=False)

    def _add_npc(self) -> None:
        self._add_npc_at(150, 150)

    def _add_zone_at(self, wx: float, wy: float) -> None:
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        with self._undo.capture("新增 Zone"):
            self._add_zone_at_impl(wx, wy)

    def _add_zone_at_impl(self, wx: float, wy: float) -> None:
        sc = self._require_scene()
        if sc is None:
            return
        wx = round(float(wx), 1)
        wy = round(float(wy), 1)
        z_list = sc.setdefault("zones", [])
        new_id = self._unique_entity_id(
            "new_zone", self._namespace_entity_ids(sc, "zone"))
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
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        with self._undo.capture("新增出生点"):
            self._add_spawn_at_impl(wx, wy)

    def _add_spawn_at_impl(self, wx: float, wy: float) -> None:
        sc = self._require_scene()
        if sc is None:
            return
        # 直写源前先把未应用编辑提交进模型：否则随后 _load_scene 里的 commit-on-leave
        # 用打开场景时的旧 staging 快照整体覆盖 spawnPoints，新增出生点被静默抹掉
        # （审查 P1-01，与 _delete_selected 同族；P1-25 第二次复发）。
        # capture 进入时已 flush 为命令，此处保留原调用兜底（多为无操作）。
        self._commit_pending_scene_edits()
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
        for it in self._canvas.selected_items():
            if isinstance(it, _EditableZonePolygon) and it.try_delete_hovered_vertex():
                return True
        return False

    def _on_delete_key_shortcut(self) -> None:
        if self._try_delete_zone_hovered_vertex():
            return
        self._delete_selected()

    def _selected_entity_ref(self) -> tuple[str, str] | None:
        """当前选中实体的 (kind, id)：画布选中优先，退回右侧属性面板正在编辑的实体。"""
        for it in self._canvas.selected_items():
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
        if w == self._props._group_panel and self._props._pending_group:
            return "group", str(self._props._pending_group.get("id", "") or "")
        if w == self._props._spawn_panel and self._props._spawn_scene is not None:
            return "spawn", str(self._props._spawn_name_original or "")
        return None

    def _refactor_selected(self, op: str) -> None:
        """实体重构入口（迁移/改名/安全删除）：先提交 staging，再开预览确认对话框。"""
        sc = self._require_scene()
        if sc is None:
            return
        if len(self._selected_entity_refs_plural()) > 1:
            QMessageBox.information(
                self, "实体重构",
                "重构（迁移/改名/安全删除）一次只处理一个实体，请先只选中一个。")
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
        if op == "convert" and kind != "hotspot":
            QMessageBox.information(
                self, "转为 NPC", "只有带展示图的纯展示热区能转成 NPC，请先选中这样一个热区。")
            return
        # commit-on-leave：把属性面板/画布 staging 先落进模型，重构基于已提交数据
        # （记为可撤销命令——用户取消重构对话框时这次提交仍可 Ctrl+Z）。
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        from ..shared.entity_refactor_dialog import (
            ConvertHotspotToNpcDialog,
            MoveEntityDialog,
            RenameEntityDialog,
            SafeDeleteEntityDialog,
        )
        dialog_cls = {
            "move": MoveEntityDialog,
            "rename": RenameEntityDialog,
            "delete": SafeDeleteEntityDialog,
            "convert": ConvertHotspotToNpcDialog,
        }[op]
        try:
            dlg = dialog_cls(self._model, self._current_scene_id or "", kind, eid, self)
        except Exception as exc:  # noqa: BLE001 - 扫描期异常给提示,不崩编辑器
            QMessageBox.warning(self, "实体重构", f"引用扫描失败：{exc}")
            return
        if not dlg.exec() or dlg.result_summary is None:
            return
        summary = dlg.result_summary
        # 跨文件重构（引用网机械改写）已执行：快照撤销不得跨过这个多文件状态，
        # 清空本栈；回退用「重构 → 撤销上次重构」（journal）。
        self._undo.clear()
        self._load_scene(self._current_scene_id, reset_view=False)
        if summary.get("op") == "moveEntity":
            dst = summary["dstScene"]
            self._select_scene_entity_by_kind(kind, eid, dst)
            dangling = len(summary.get("danglingSceneLocal") or [])
            msg = (f"已迁移到「{dst}」；坐标保留原值，请在目标场景重新摆位。"
                   + (f"\n源场景仍有 {dangling} 处裸引用悬垂（见 Validate Data）。" if dangling else ""))
        elif summary.get("op") == "renameEntity":
            skipped = summary.get("scope", {}).get("skippedDialogues") or []
            # 改名后画布/属性回选到新 id 实体（审查 P3：原实现不回选）。
            if kind in ("npc", "hotspot", "zone"):
                self._select_scene_entity_by_kind(kind, summary["newId"], self._current_scene_id or "")
            msg = (f"已改名为「{summary['newId']}」。"
                   + (f"\n未自动改写（指向歧义）的对话图：{'、'.join(skipped)}" if skipped else ""))
        elif summary.get("op") == "convertHotspotToNpc":
            self._select_scene_entity_by_kind("npc", eid, self._current_scene_id or "")
            lines = [f"热区「{eid}」已转成 NPC（id 不变，引用无需改写）。"]
            if summary.get("scale") is not None:
                lines.append(f"实例 scale = {summary['scale']}（按动画包世界身高换算）。")
            if summary.get("droppedFields"):
                lines.append("已丢弃的热点字段：" + "、".join(summary["droppedFields"]))
            for warn in summary.get("warnings") or []:
                lines.append("⚠ " + warn)
            if summary.get("deadHotspotActionRefs"):
                lines.append(
                    f"⚠ {len(summary['deadHotspotActionRefs'])} 处热点专用动作已失效，请自行清理。")
            lines.append("请在画布上目验大小与前后关系。")
            msg = "\n".join(lines)
        else:
            msg = (f"已删除「{eid}」；"
                   f"{summary.get('danglingRefs', 0)} 处引用悬垂（跑 Validate Data 查看）。")
        QMessageBox.information(self, "实体重构", msg)

    def _duplicate_selected(self) -> None:
        """本场景复制选中实体（引擎 duplicate op：deepcopy + 新 id + 偏移落位）。

        成功路径静默（副本被选中即反馈），仅剥离过场绑定时弹一次提示；
        复制是纯场景内变更，撤销走 Ctrl+Z 快照栈（不再进重构 journal——
        双栈同管一个操作会在一边撤销后让另一边的记录悬垂）。"""
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        with self._undo.capture("复制实体"):
            self._duplicate_selected_impl()

    def _duplicate_selected_impl(self) -> None:
        sc = self._require_scene()
        if sc is None:
            return
        refs = [r for r in self._selected_entity_refs_plural()
                if r[0] in ("npc", "hotspot", "zone", "spawn")
                and not (r[0] == "spawn" and r[1] == "default")]
        if not refs:
            QMessageBox.information(
                self, "复制实体",
                "请先选中 NPC / 热区 / Zone / 出生点（默认出生点不参与复制）。")
            return
        # commit-on-leave：先把属性面板/画布 staging 落进模型，副本基于已提交数据
        # 深拷贝（否则复制到的是打开实体时的旧快照，P1-01 家族）。
        self._commit_pending_scene_edits()
        from ..shared import entity_refactor as er
        new_ids: list[tuple[str, str]] = []
        stripped_all: list[str] = []
        errors: list[str] = []
        for kind, eid in refs:
            try:
                summary = er.duplicate_entity(
                    self._model, self._current_scene_id or "", kind, eid)
            except er.EntityRefactorError as exc:
                errors.append(f"{kind}「{eid}」：{exc}")
                continue
            new_ids.append((kind, str(summary.get("newId") or "")))
            stripped_all.extend(summary.get("strippedCutsceneIds") or [])
        if not new_ids:
            if errors:
                QMessageBox.warning(self, "复制实体", "\n".join(errors))
            return
        self._load_scene(self._current_scene_id, reset_view=False)
        if len(new_ids) == 1:
            kind, new_id = new_ids[0]
            if kind == "spawn":
                self._restore_canvas_selection("spawn", new_id)
            else:
                self._select_scene_entity_by_kind(
                    kind, new_id, self._current_scene_id or "")
        else:
            # 批量复制：全选全部副本（多选状态，方便整体拖开摆位）
            self._canvas.clear_selection()
            for kind, new_id in new_ids:
                item = self._canvas.entity_item_by_key(f"{kind}:{new_id}")
                if item is not None:
                    item.setSelected(True)
        notices: list[str] = []
        if stripped_all:
            notices.append(
                f"原实体的过场绑定（{'、'.join(stripped_all)}）未随副本复制：\n"
                "过场步骤按 id 只驱动原实体，副本挂空绑定无意义。")
        if errors:
            notices.append("部分实体复制失败：\n" + "\n".join(errors))
        if notices:
            QMessageBox.information(self, "复制实体", "\n\n".join(notices))

    def _undo_entity_refactor(self) -> None:
        # commit-on-leave：先把未应用的画布/面板 staging 落进模型，否则迟到的
        # commit-on-leave 会用旧 id 的 staging 覆盖引擎撤销后的实体 def，引用网静默
        # 劈叉且不可再撤销（审查 P1-02，对照 _refactor_selected 正确样板）。
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        from ..shared import entity_refactor as er
        result = er.undo_last(self._model)
        if result.get("ok"):
            # journal 回退同样是跨文件状态跳变：清快照栈，防半份回退。
            self._undo.clear()
            self._load_scene(self._current_scene_id, reset_view=False)
        QMessageBox.information(
            self, "实体重构", str(result.get("description") or result.get("reason") or ""))

    def _delete_selected(self) -> None:
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        with self._undo.capture("删除实体"):
            self._delete_selected_impl()

    def _delete_selected_impl(self) -> None:
        sc = self._require_scene()
        if sc is None:
            return
        refs = self._selected_entity_refs_plural()
        group_refs = [r for r in refs if r[0] == "group"]
        if group_refs:
            if len(refs) != 1:
                QMessageBox.information(
                    self, "删除场景分组", "场景分组一次只删除一个，请取消其它选中项。")
                return
            self._delete_scene_group(sc, group_refs[0][1])
            return
        deletable = [r for r in refs
                     if not (r[0] == "spawn" and r[1] == "default")]
        if not deletable:
            if any(r[0] == "spawn" and r[1] == "default" for r in refs):
                QMessageBox.information(
                    self, "场景编辑器", "默认出生点不可删除。")
            return
        if len(deletable) == 1:
            kind, eid = deletable[0]
            _label = {
                "npc": "NPC", "hotspot": "热区",
                "zone": "Zone", "spawn": "出生点",
            }.get(kind, "实体")
            prompt = f"{_label}「{eid}」及其全部配置"
        else:
            prompt = f"选中的 {len(deletable)} 个实体及其全部配置"
        if not confirm.confirm_delete(self, prompt):
            return
        # 直写源前先提交未应用编辑：否则随后 _load_scene 的 commit-on-leave 用旧 staging
        # 快照整体覆盖 spawnPoints，刚删的出生点「复活」（审查 P1-01；P1-25 同族复发）。
        # 实体三列表与 model 共享引用不受此害，spawnPoints 是 deepcopy 快照才中招——
        # 统一先 commit 保各删除路径一致。
        self._commit_pending_scene_edits()
        by_kind: dict[str, set[str]] = {}
        for kind, eid in deletable:
            by_kind.setdefault(kind, set()).add(eid)
        if by_kind.get("hotspot"):
            sc["hotspots"] = [h for h in sc.get("hotspots", [])
                              if h.get("id") not in by_kind["hotspot"]]
        if by_kind.get("npc"):
            sc["npcs"] = [n for n in sc.get("npcs", [])
                          if n.get("id") not in by_kind["npc"]]
        if by_kind.get("zone"):
            sc["zones"] = [z for z in sc.get("zones", [])
                           if z.get("id") not in by_kind["zone"]]
        for eid in by_kind.get("spawn", ()):  # default 已在上方排除
            sc.get("spawnPoints", {}).pop(eid, None)
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id, reset_view=False)

    def _delete_scene_group(self, sc: dict, group_id: str) -> None:
        gid = str(group_id or "").strip()
        if not gid:
            return
        if not self._undo_flush_pending_as_command():
            self._restore_editing_selection_after_block()
            return
        inbound = self._scene_group_inbound_references(
            self._current_scene_id or "", gid,
        )
        if inbound:
            preview = "\n".join(f"• {row}" for row in inbound[:12])
            suffix = f"\n…另有 {len(inbound) - 12} 处" if len(inbound) > 12 else ""
            QMessageBox.warning(
                self,
                "分组删除已阻断",
                "该分组仍有入站引用；删除会制造悬垂，已安全阻断。"
                "请先在对应编辑器移除这些引用：\n"
                f"{preview}{suffix}",
            )
            return
        member_count = sum(
            1
            for coll in ("npcs", "hotspots", "zones")
            for member in sc.get(coll, []) or []
            if isinstance(member, dict) and str(member.get("group") or "").strip() == gid
        )
        answer = QMessageBox.question(
            self,
            "删除场景分组",
            f"删除分组「{gid}」，并将 {member_count} 个成员移出该组（清除成员 group 引用）？\n"
            "实体本身不会被删除。此操作可用 Ctrl+Z 撤销。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        groups = sc.get("entityGroups")
        if isinstance(groups, list):
            sc["entityGroups"] = [
                group for group in groups
                if not (isinstance(group, dict) and str(group.get("id") or "").strip() == gid)
            ]
        for coll in ("npcs", "hotspots", "zones"):
            for member in sc.get(coll, []) or []:
                if isinstance(member, dict) and str(member.get("group") or "").strip() == gid:
                    member.pop("group", None)
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
            # currentItemChanged 的 commit-on-leave 可能因保护性校验拒绝切场景。
            # 此时绝不能继续在旧场景里按同名 id 误选另一个实体。
            if (self._current_scene_id or "") != scene_id:
                return False
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
                # 实体级跳转（全局搜索/引用导航/重构回选）落到「实体」页，树高亮可见
                self._left_tabs.setCurrentIndex(1)
                self._restore_canvas_selection(kind, item_id)
                self._focus_canvas_on_entity(kind, item_id)
                return True
        return False

    def _focus_canvas_on_entity(self, kind: str, eid: str) -> None:
        """外部跳转(全局搜索/引用导航/位面面板)的视口落点:把画布滚到实体处并
        短暂描边。只在 select_*_by_id 族入口调用——_restore_canvas_selection 还被
        普通 reload 复用,日常编辑不能被拽视口。场景加载/适配有延后步骤
        (_fit_stabilize_step),补一拍再断言一次。"""
        def _go() -> None:
            try:
                it = self._canvas.entity_item_by_key(f"{kind}:{eid}")
                if it is None:
                    return
                # centerOn:实体拉到视口正中(整景已适配时无滚动余地,自然无操作),
                # 场景实体多时靠居中+描边直接锁定,不必肉眼扫全图。
                self._canvas.centerOn(it)
                from ..shared.search_spotlight import flash_canvas_item
                flash_canvas_item(self._canvas, it)
            except Exception:
                pass  # 视口聚焦是锦上添花,失败不影响选中本身

        _go()
        QTimer.singleShot(320, self, _go)

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

    def select_by_id(self, item_id: str, scene_id: str = "") -> bool:
        for kind in ("npc", "hotspot", "zone"):
            if self._select_scene_entity_by_kind(kind, item_id, scene_id):
                return True
        return False
