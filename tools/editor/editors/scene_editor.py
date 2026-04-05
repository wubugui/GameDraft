"""Scene editor with visual canvas for hotspots, NPCs, zones, spawn points.

All canvas coordinates are in **world units**.  Background images are loaded
as textures and scaled into a world-sized quad so pixel resolution is
completely decoupled from the coordinate system.
"""
from __future__ import annotations

import copy
from pathlib import Path

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget, QListWidgetItem,
    QGraphicsView, QGraphicsScene, QGraphicsEllipseItem, QGraphicsRectItem,
    QGraphicsItem,
    QGraphicsPixmapItem, QGroupBox, QFormLayout, QLineEdit, QDoubleSpinBox,
    QSpinBox, QComboBox, QCheckBox, QLabel, QPushButton, QScrollArea,
    QStackedWidget, QTextEdit, QToolBar, QMenu, QGraphicsTextItem,
    QToolButton, QMessageBox, QDialog, QDialogButtonBox, QAbstractItemView,
)
from PySide6.QtGui import (
    QPixmap, QPen, QBrush, QColor, QFont, QPainter, QWheelEvent,
    QMouseEvent, QContextMenuEvent, QAction, QTransform,
)
from PySide6.QtCore import Qt, QRectF, QPoint, QPointF, Signal, QTimer

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


# ---------------------------------------------------------------------------
# Draggable graphics items  (all sizes in world units)
# ---------------------------------------------------------------------------

class _DraggableCircle(QGraphicsEllipseItem):
    """A filled circle positioned and sized in world units."""

    def __init__(self, x: float, y: float, radius: float,
                 color: QColor, entity_id: str, entity_kind: str,
                 range_radius: float = 0):
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

        if range_radius > 0:
            outline = QGraphicsEllipseItem(
                -range_radius, -range_radius,
                range_radius * 2, range_radius * 2, self)
            outline.setPen(_RANGE_PEN)
            outline.setBrush(QBrush(Qt.GlobalColor.transparent))

        self._label = QGraphicsTextItem(entity_id, self)
        self._label.setDefaultTextColor(Qt.GlobalColor.white)
        self._label.setFont(QFont("Consolas", 8))
        self._label.setFlag(
            QGraphicsTextItem.GraphicsItemFlag.ItemIgnoresTransformations, True)
        self._label.setPos(radius * 0.5, -radius * 0.5)


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
        self._label.setPos(2, 2)


# ---------------------------------------------------------------------------
# Canvas view  (coordinate system = world units)
# ---------------------------------------------------------------------------

class SceneCanvas(QGraphicsView):
    item_selected = Signal(str, str)   # (entity_kind, entity_id)
    item_deselected = Signal()
    item_moved = Signal(str, str, float, float)  # kind, id, x, y
    # 右键菜单：在 (wx, wy) 世界坐标处添加实体；kind: hotspot|npc|zone|spawn
    context_add_entity = Signal(str, float, float)

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self._gfx = QGraphicsScene(self)
        self.setScene(self._gfx)
        self.setRenderHints(QPainter.RenderHint.Antialiasing |
                            QPainter.RenderHint.SmoothPixmapTransform)
        # 左键用于选择/拖移图元；平移视图使用鼠标中键（见 mousePress/Move/Release）
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self._middle_panning = False
        self._pan_last_pos = QPoint()
        self._pick_cycle_key: tuple[float, float] | None = None
        self._pick_cycle_i: int = 0
        self._saved_item_z: list[tuple[QGraphicsItem, float]] | None = None
        self._bg_item: QGraphicsPixmapItem | None = None
        self._entity_items: dict[str, QGraphicsEllipseItem | QGraphicsRectItem] = {}
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
        self._gfx.clear()
        self._bg_item = None
        self._entity_items.clear()

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
            range_radius=ir)
        self._gfx.addItem(item)
        self._entity_items[f"hotspot:{hs.get('id', '')}"] = item

    def add_npc(self, npc: dict) -> None:
        ir = npc.get("interactionRange", 50)
        item = _DraggableCircle(
            npc["x"], npc["y"], self.handle_radius,
            _NPC_COLOR, npc.get("id", "?"), "npc",
            range_radius=ir)
        self._gfx.addItem(item)
        self._entity_items[f"npc:{npc.get('id', '')}"] = item

    def add_zone(self, zone: dict) -> None:
        item = _DraggableRect(
            zone["x"], zone["y"],
            zone.get("width", 100), zone.get("height", 100),
            _ZONE_COLOR, zone.get("id", "?"), "zone")
        self._gfx.addItem(item)
        self._entity_items[f"zone:{zone.get('id', '')}"] = item

    def add_spawn(self, name: str, pos: dict) -> None:
        item = _DraggableCircle(
            pos["x"], pos["y"], self.handle_radius * 0.6,
            _SPAWN_COLOR, name, "spawn")
        self._gfx.addItem(item)
        self._entity_items[f"spawn:{name}"] = item

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
                self.item_moved.emit(it.entity_kind, it.entity_id,
                                     it.pos().x(), it.pos().y())
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
        # Last opened entity dicts (still bound to model.scenes); used by Save All / flush
        # without requiring Apply or a visible property panel.
        self._pending_hotspot: dict | None = None
        self._pending_npc: dict | None = None
        self._pending_zone: dict | None = None
        self._spawn_flush_scene: dict | None = None
        self._editing_scene_id: str = ""

    def show_empty(self) -> None:
        self._stack.setCurrentWidget(self._empty)

    # ---- scene props ------------------------------------------------------

    def _build_scene_panel(self) -> QWidget:
        w = QWidget()
        form = QFormLayout(w)
        self._sc_id = QLineEdit(); form.addRow("id", self._sc_id)
        self._sc_name = QLineEdit(); form.addRow("name", self._sc_name)
        self._sc_width = QDoubleSpinBox(); self._sc_width.setRange(0, 99999)
        form.addRow("worldWidth", self._sc_width)
        self._sc_height = QDoubleSpinBox(); self._sc_height.setRange(0, 99999)
        form.addRow("worldHeight", self._sc_height)
        self._sc_bgm = QLineEdit(); form.addRow("bgm", self._sc_bgm)
        self._sc_filter = IdRefSelector(allow_empty=True)
        form.addRow("filterId", self._sc_filter)
        self._sc_zoom = QDoubleSpinBox(); self._sc_zoom.setRange(0.01, 20); self._sc_zoom.setSingleStep(0.1)
        form.addRow("camera.zoom", self._sc_zoom)
        self._sc_ppu = QDoubleSpinBox(); self._sc_ppu.setRange(0.01, 9999); self._sc_ppu.setValue(1)
        form.addRow("camera.ppu", self._sc_ppu)
        self._sc_scale = QDoubleSpinBox(); self._sc_scale.setRange(0.01, 10); self._sc_scale.setValue(1)
        form.addRow("worldScale", self._sc_scale)
        self._sc_walk = QDoubleSpinBox(); self._sc_walk.setRange(0, 9999)
        form.addRow("walkSpeed", self._sc_walk)
        self._sc_run = QDoubleSpinBox(); self._sc_run.setRange(0, 9999)
        form.addRow("runSpeed", self._sc_run)
        self._sc_ambient = QLineEdit(); form.addRow("ambientSounds", self._sc_ambient)
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
        self._sc_width.setValue(sc.get("worldWidth", 0))
        self._sc_height.setValue(sc.get("worldHeight", 0))
        self._sc_bgm.setText(sc.get("bgm", ""))
        self._sc_filter.set_items(self._model.all_filter_ids())
        self._sc_filter.set_current(sc.get("filterId", ""))
        cam = sc.get("camera", {})
        self._sc_zoom.setValue(cam.get("zoom", 1))
        self._sc_ppu.setValue(cam.get("pixelsPerUnit", 1))
        self._sc_scale.setValue(sc.get("worldScale", 1))
        self._sc_walk.setValue(sc.get("playerWalkSpeed", 0))
        self._sc_run.setValue(sc.get("playerRunSpeed", 0))
        self._sc_ambient.setText(", ".join(sc.get("ambientSounds", [])))

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
        bgm = self._sc_bgm.text().strip()
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
        raw_ambient = self._sc_ambient.text().strip()
        if raw_ambient:
            sc["ambientSounds"] = [s.strip() for s in raw_ambient.split(",") if s.strip()]
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
        self._hs_pickup_item = QLineEdit(); pf.addRow("itemId", self._hs_pickup_item)
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
        self._hs_npc_id = QLineEdit(); nf.addRow("npcId", self._hs_npc_id)
        self._hs_data_stack.addWidget(np_)

        # encounter data
        ep = QWidget(); ef = QFormLayout(ep)
        self._hs_enc_id = IdRefSelector(allow_empty=False)
        ef.addRow("encounterId", self._hs_enc_id)
        self._hs_data_stack.addWidget(ep)

        self._hs_type.currentTextChanged.connect(self._on_hs_type_changed)
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
        self._hs_range.setValue(hs.get("interactionRange", 50))
        self._hs_auto.setChecked(hs.get("autoTrigger", False))
        fc = self._model.registry_flag_choices(self._editing_scene_id or None)
        self._hs_cond.set_flag_pattern_context(self._model, self._editing_scene_id or None)
        self._hs_cond.set_flags(fc)
        self._hs_cond.set_data(hs.get("conditions", []))

        data = hs.get("data", {})
        ht = hs.get("type", "inspect")
        self._on_hs_type_changed(ht)
        if ht == "inspect":
            self._hs_inspect_text.setPlainText(data.get("text", ""))
            self._hs_inspect_actions.set_flag_completions(fc)
            self._hs_inspect_actions.set_data(data.get("actions", []))
        elif ht == "pickup":
            self._hs_pickup_item.setText(data.get("itemId", ""))
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
            self._hs_npc_id.setText(data.get("npcId", ""))
        elif ht == "encounter":
            self._hs_enc_id.set_items(self._model.all_encounter_ids())
            self._hs_enc_id.set_current(data.get("encounterId", ""))

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
                "itemId": self._hs_pickup_item.text(),
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
            hs["data"] = {"npcId": self._hs_npc_id.text()}
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
        form = QFormLayout(w)
        self._npc_id = QLineEdit(); form.addRow("id", self._npc_id)
        self._npc_name = QLineEdit(); form.addRow("name", self._npc_name)
        self._npc_x = QDoubleSpinBox(); self._npc_x.setRange(-99999, 99999); self._npc_x.setDecimals(1)
        form.addRow("x", self._npc_x)
        self._npc_y = QDoubleSpinBox(); self._npc_y.setRange(-99999, 99999); self._npc_y.setDecimals(1)
        form.addRow("y", self._npc_y)
        self._npc_dialogue = QLineEdit(); form.addRow("dialogueFile", self._npc_dialogue)
        self._npc_knot = QLineEdit(); form.addRow("dialogueKnot", self._npc_knot)
        self._npc_range = QDoubleSpinBox(); self._npc_range.setRange(0, 99999)
        form.addRow("interactionRange", self._npc_range)
        self._npc_anim = QLineEdit(); form.addRow("animFile", self._npc_anim)
        return w

    def load_npc_props(self, npc: dict) -> None:
        self._current_data = npc
        self._pending_npc = npc
        self._stack.setCurrentWidget(self._npc_panel)
        self._npc_id.setText(npc.get("id", ""))
        self._npc_name.setText(npc.get("name", ""))
        self._npc_x.setValue(npc.get("x", 0))
        self._npc_y.setValue(npc.get("y", 0))
        self._npc_dialogue.setText(npc.get("dialogueFile", ""))
        self._npc_knot.setText(npc.get("dialogueKnot", ""))
        self._npc_range.setValue(npc.get("interactionRange", 50))
        self._npc_anim.setText(npc.get("animFile", ""))

    def _write_npc_widgets_to_dict(self, npc: dict) -> None:
        npc["id"] = self._npc_id.text().strip()
        npc["name"] = self._npc_name.text()
        npc["x"] = self._npc_x.value()
        npc["y"] = self._npc_y.value()
        npc["dialogueFile"] = self._npc_dialogue.text()
        knot = self._npc_knot.text().strip()
        if knot:
            npc["dialogueKnot"] = knot
        elif "dialogueKnot" in npc:
            del npc["dialogueKnot"]
        npc["interactionRange"] = self._npc_range.value()
        anim = self._npc_anim.text().strip()
        if anim:
            npc["animFile"] = anim
        elif "animFile" in npc:
            del npc["animFile"]
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
        self._zn_id = QLineEdit(); form.addRow("id", self._zn_id)
        self._zn_x = QDoubleSpinBox(); self._zn_x.setRange(-99999, 99999); self._zn_x.setDecimals(1)
        form.addRow("x", self._zn_x)
        self._zn_y = QDoubleSpinBox(); self._zn_y.setRange(-99999, 99999); self._zn_y.setDecimals(1)
        form.addRow("y", self._zn_y)
        self._zn_w = QDoubleSpinBox(); self._zn_w.setRange(0, 99999)
        form.addRow("width", self._zn_w)
        self._zn_h = QDoubleSpinBox(); self._zn_h.setRange(0, 99999)
        form.addRow("height", self._zn_h)
        lay.addLayout(form)
        self._zn_cond = ConditionEditor("Conditions"); lay.addWidget(self._zn_cond)
        self._zn_enter = ActionEditor("onEnter"); lay.addWidget(self._zn_enter)
        self._zn_exit = ActionEditor("onExit"); lay.addWidget(self._zn_exit)
        return w

    def load_zone_props(self, zone: dict) -> None:
        self._current_data = zone
        self._pending_zone = zone
        self._stack.setCurrentWidget(self._zone_panel)
        self._zn_id.setText(zone.get("id", ""))
        self._zn_x.setValue(zone.get("x", 0))
        self._zn_y.setValue(zone.get("y", 0))
        self._zn_w.setValue(zone.get("width", 100))
        self._zn_h.setValue(zone.get("height", 100))
        zf = self._model.registry_flag_choices(self._editing_scene_id or None)
        self._zn_cond.set_flag_pattern_context(self._model, self._editing_scene_id or None)
        self._zn_cond.set_flags(zf)
        self._zn_cond.set_data(zone.get("conditions", []))
        self._zn_enter.set_flag_completions(zf)
        self._zn_exit.set_flag_completions(zf)
        self._zn_enter.set_data(zone.get("onEnter", []))
        self._zn_exit.set_data(zone.get("onExit", []))

    def _write_zone_widgets_to_dict(self, zone: dict) -> None:
        zone["id"] = self._zn_id.text().strip()
        zone["x"] = self._zn_x.value()
        zone["y"] = self._zn_y.value()
        zone["width"] = self._zn_w.value()
        zone["height"] = self._zn_h.value()
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
        ox = self._zn_exit.to_list()
        if ox:
            zone["onExit"] = ox
        elif "onExit" in zone:
            del zone["onExit"]
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
        form = QFormLayout(w)
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
        else:
            sps = sc.setdefault("spawnPoints", {})
            pos = sps.setdefault(spawn_name, {"x": 0, "y": 0})
            self._sp_key.setReadOnly(False)
            self._sp_key.setText(spawn_name)
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
        del_btn = QPushButton("Delete")
        del_btn.clicked.connect(self._delete_selected)
        tb.addWidget(del_btn)
        save_btn = QPushButton("Apply")
        save_btn.clicked.connect(self._apply_props)
        tb.addWidget(save_btn)
        ll.addWidget(tb)

        self._scene_list = QListWidget()
        self._scene_list.currentItemChanged.connect(self._on_scene_selected)
        ll.addWidget(self._scene_list)

        # center: canvas
        self._canvas = SceneCanvas()
        self._canvas.item_selected.connect(self._on_item_selected)
        self._canvas.item_deselected.connect(self._on_item_deselected)
        self._canvas.item_moved.connect(self._on_item_moved)
        self._canvas.context_add_entity.connect(self._on_canvas_context_add_entity)

        # right: property panel
        self._props = ScenePropertyPanel(model)
        self._props.changed.connect(lambda: model.mark_dirty("scene", self._current_scene_id or ""))

        splitter.addWidget(left)
        splitter.addWidget(self._canvas)
        splitter.addWidget(self._props)
        splitter.setSizes([180, 800, 350])
        root.addWidget(splitter)

        self._refresh_scene_list()

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

    def _load_scene(self, scene_id: str) -> None:
        self._current_scene_id = scene_id
        sc = self._model.scenes.get(scene_id)
        if sc is None:
            return
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

        self._canvas.fit_all()
        self._props.load_scene_props(sc, clear_pending_edits=True)

    def _on_item_selected(self, kind: str, eid: str) -> None:
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
                    self._props.load_zone_props(zone)
                    return
        elif kind == "spawn":
            self._props.load_spawn_props(sc, eid)

    def _on_item_deselected(self) -> None:
        if self._current_scene_id:
            sc = self._model.scenes.get(self._current_scene_id)
            if sc:
                self._props.load_scene_props(sc, clear_pending_edits=False)

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
                    break
        elif kind == "zone":
            for zone in sc.get("zones", []):
                if zone.get("id") == eid:
                    zone["x"] = round(x, 1)
                    zone["y"] = round(y, 1)
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
            self._load_scene(self._current_scene_id)

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
        self._load_scene(self._current_scene_id)

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
        self._load_scene(self._current_scene_id)

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
            "id": new_id, "x": wx, "y": wy, "width": 200, "height": 100,
        })
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id)

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
        self._load_scene(self._current_scene_id)

    def _add_spawn(self) -> None:
        self._add_spawn_at(200, 200)

    def _delete_selected(self) -> None:
        sc = self._require_scene()
        if sc is None:
            return
        sel = self._canvas._gfx.selectedItems()
        if not sel:
            return
        it = sel[0]
        if not hasattr(it, "entity_kind"):
            return
        kind = it.entity_kind
        eid = it.entity_id
        if kind == "hotspot":
            sc["hotspots"] = [h for h in sc.get("hotspots", []) if h.get("id") != eid]
        elif kind == "npc":
            sc["npcs"] = [n for n in sc.get("npcs", []) if n.get("id") != eid]
        elif kind == "zone":
            sc["zones"] = [z for z in sc.get("zones", []) if z.get("id") != eid]
        elif kind == "spawn" and eid != "default":
            sc.get("spawnPoints", {}).pop(eid, None)
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id)
