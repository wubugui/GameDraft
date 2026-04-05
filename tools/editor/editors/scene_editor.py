"""Scene editor with visual canvas for hotspots, NPCs, zones, spawn points."""
from __future__ import annotations

import copy
from pathlib import Path

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget, QListWidgetItem,
    QGraphicsView, QGraphicsScene, QGraphicsEllipseItem, QGraphicsRectItem,
    QGraphicsPixmapItem, QGroupBox, QFormLayout, QLineEdit, QDoubleSpinBox,
    QSpinBox, QComboBox, QCheckBox, QLabel, QPushButton, QScrollArea,
    QStackedWidget, QTextEdit, QToolBar, QMenu, QGraphicsTextItem,
)
from PySide6.QtGui import (
    QPixmap, QPen, QBrush, QColor, QFont, QPainter, QWheelEvent,
    QMouseEvent, QAction,
)
from PySide6.QtCore import Qt, QRectF, QPointF, Signal

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


# ---------------------------------------------------------------------------
# Draggable graphics items
# ---------------------------------------------------------------------------

class _DraggableCircle(QGraphicsEllipseItem):
    """A circle that can be dragged and reports its new position."""

    def __init__(self, x: float, y: float, radius: float,
                 color: QColor, entity_id: str, entity_kind: str):
        super().__init__(-radius, -radius, radius * 2, radius * 2)
        self.setPos(x, y)
        self.setBrush(QBrush(color))
        self.setPen(QPen(color.darker(140), 1.5))
        self.setFlags(self.GraphicsItemFlag.ItemIsMovable |
                      self.GraphicsItemFlag.ItemIsSelectable |
                      self.GraphicsItemFlag.ItemSendsGeometryChanges)
        self.entity_id = entity_id
        self.entity_kind = entity_kind
        self._label = QGraphicsTextItem(entity_id, self)
        self._label.setDefaultTextColor(Qt.GlobalColor.white)
        font = QFont("Consolas", 7)
        self._label.setFont(font)
        self._label.setPos(-radius, -radius - 14)


class _DraggableRect(QGraphicsRectItem):
    def __init__(self, x: float, y: float, w: float, h: float,
                 color: QColor, entity_id: str, entity_kind: str):
        super().__init__(0, 0, w, h)
        self.setPos(x, y)
        self.setBrush(QBrush(color))
        self.setPen(QPen(color.darker(180), 1, Qt.PenStyle.DashLine))
        self.setFlags(self.GraphicsItemFlag.ItemIsMovable |
                      self.GraphicsItemFlag.ItemIsSelectable |
                      self.GraphicsItemFlag.ItemSendsGeometryChanges)
        self.entity_id = entity_id
        self.entity_kind = entity_kind
        self._label = QGraphicsTextItem(entity_id, self)
        self._label.setDefaultTextColor(Qt.GlobalColor.white)
        font = QFont("Consolas", 7)
        self._label.setFont(font)
        self._label.setPos(2, -14)


# ---------------------------------------------------------------------------
# Canvas view
# ---------------------------------------------------------------------------

class SceneCanvas(QGraphicsView):
    item_selected = Signal(str, str)  # (entity_kind, entity_id)
    item_deselected = Signal()
    item_moved = Signal(str, str, float, float)  # kind, id, x, y

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHints(QPainter.RenderHint.Antialiasing |
                            QPainter.RenderHint.SmoothPixmapTransform)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self._bg_item: QGraphicsPixmapItem | None = None
        self._entity_items: dict[str, QGraphicsEllipseItem | QGraphicsRectItem] = {}

    def clear_scene(self) -> None:
        self._scene.clear()
        self._bg_item = None
        self._entity_items.clear()

    def load_background(self, img_path: Path) -> None:
        if not img_path.exists():
            return
        pm = QPixmap(str(img_path))
        if pm.isNull():
            return
        self._bg_item = self._scene.addPixmap(pm)
        self._bg_item.setZValue(-100)
        self._scene.setSceneRect(QRectF(pm.rect()))

    def add_hotspot(self, hs: dict) -> None:
        ht = hs.get("type", "inspect")
        color = _HOTSPOT_COLORS.get(ht, _HOTSPOT_COLORS["inspect"])
        r = min(hs.get("interactionRange", 30), 120)
        item = _DraggableCircle(hs["x"], hs["y"], max(r * 0.3, 8),
                                color, hs.get("id", "?"), "hotspot")
        self._scene.addItem(item)
        self._entity_items[f"hotspot:{hs.get('id', '')}"] = item

    def add_npc(self, npc: dict) -> None:
        item = _DraggableCircle(npc["x"], npc["y"], 10,
                                _NPC_COLOR, npc.get("id", "?"), "npc")
        self._scene.addItem(item)
        self._entity_items[f"npc:{npc.get('id', '')}"] = item

    def add_zone(self, zone: dict) -> None:
        item = _DraggableRect(zone["x"], zone["y"],
                              zone.get("width", 100), zone.get("height", 100),
                              _ZONE_COLOR, zone.get("id", "?"), "zone")
        self._scene.addItem(item)
        self._entity_items[f"zone:{zone.get('id', '')}"] = item

    def add_spawn(self, name: str, pos: dict) -> None:
        item = _DraggableCircle(pos["x"], pos["y"], 6,
                                _SPAWN_COLOR, name, "spawn")
        self._scene.addItem(item)
        self._entity_items[f"spawn:{name}"] = item

    def fit_all(self) -> None:
        self.fitInView(self._scene.sceneRect(), Qt.AspectRatioMode.KeepAspectRatio)

    def wheelEvent(self, event: QWheelEvent) -> None:
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self.scale(factor, factor)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        super().mouseReleaseEvent(event)
        sel = self._scene.selectedItems()
        if sel:
            it = sel[0]
            if hasattr(it, "entity_kind") and hasattr(it, "entity_id"):
                self.item_selected.emit(it.entity_kind, it.entity_id)
                self.item_moved.emit(it.entity_kind, it.entity_id,
                                     it.pos().x(), it.pos().y())
        else:
            self.item_deselected.emit()


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

        self._current_data: dict | None = None

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

    def load_scene_props(self, sc: dict) -> None:
        self._current_data = sc
        self._stack.setCurrentWidget(self._scene_panel)
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
        tp = QWidget(); tf = QFormLayout(tp)
        self._hs_trans_scene = IdRefSelector(allow_empty=False)
        tf.addRow("targetScene", self._hs_trans_scene)
        self._hs_trans_spawn = QLineEdit(); tf.addRow("targetSpawnPoint", self._hs_trans_spawn)
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

    def load_hotspot_props(self, hs: dict) -> None:
        self._current_data = hs
        self._stack.setCurrentWidget(self._hotspot_panel)
        self._hs_id.setText(hs.get("id", ""))
        self._hs_type.setCurrentText(hs.get("type", "inspect"))
        self._hs_label.setText(hs.get("label", ""))
        self._hs_x.setValue(hs.get("x", 0))
        self._hs_y.setValue(hs.get("y", 0))
        self._hs_range.setValue(hs.get("interactionRange", 50))
        self._hs_auto.setChecked(hs.get("autoTrigger", False))
        self._hs_cond.set_flags(sorted(self._model.all_flags()))
        self._hs_cond.set_data(hs.get("conditions", []))

        data = hs.get("data", {})
        ht = hs.get("type", "inspect")
        self._on_hs_type_changed(ht)
        if ht == "inspect":
            self._hs_inspect_text.setPlainText(data.get("text", ""))
            self._hs_inspect_actions.set_data(data.get("actions", []))
        elif ht == "pickup":
            self._hs_pickup_item.setText(data.get("itemId", ""))
            self._hs_pickup_name.setText(data.get("itemName", ""))
            self._hs_pickup_count.setValue(data.get("count", 1))
            self._hs_pickup_currency.setChecked(data.get("isCurrency", False))
        elif ht == "transition":
            self._hs_trans_scene.set_items([(s, s) for s in self._model.all_scene_ids()])
            self._hs_trans_scene.set_current(data.get("targetScene", ""))
            self._hs_trans_spawn.setText(data.get("targetSpawnPoint", ""))
        elif ht == "npc":
            self._hs_npc_id.setText(data.get("npcId", ""))
        elif ht == "encounter":
            self._hs_enc_id.set_items(self._model.all_encounter_ids())
            self._hs_enc_id.set_current(data.get("encounterId", ""))

    def save_hotspot_props(self) -> dict | None:
        hs = self._current_data
        if hs is None or self._stack.currentWidget() != self._hotspot_panel:
            return None
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
            hs["data"] = {"targetScene": self._hs_trans_scene.current_id()}
            sp = self._hs_trans_spawn.text().strip()
            if sp:
                hs["data"]["targetSpawnPoint"] = sp
        elif ht == "npc":
            hs["data"] = {"npcId": self._hs_npc_id.text()}
        elif ht == "encounter":
            hs["data"] = {"encounterId": self._hs_enc_id.current_id()}
        self.changed.emit()
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
        self._stack.setCurrentWidget(self._npc_panel)
        self._npc_id.setText(npc.get("id", ""))
        self._npc_name.setText(npc.get("name", ""))
        self._npc_x.setValue(npc.get("x", 0))
        self._npc_y.setValue(npc.get("y", 0))
        self._npc_dialogue.setText(npc.get("dialogueFile", ""))
        self._npc_knot.setText(npc.get("dialogueKnot", ""))
        self._npc_range.setValue(npc.get("interactionRange", 50))
        self._npc_anim.setText(npc.get("animFile", ""))

    def save_npc_props(self) -> dict | None:
        npc = self._current_data
        if npc is None or self._stack.currentWidget() != self._npc_panel:
            return None
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
        self._stack.setCurrentWidget(self._zone_panel)
        self._zn_id.setText(zone.get("id", ""))
        self._zn_x.setValue(zone.get("x", 0))
        self._zn_y.setValue(zone.get("y", 0))
        self._zn_w.setValue(zone.get("width", 100))
        self._zn_h.setValue(zone.get("height", 100))
        self._zn_cond.set_flags(sorted(self._model.all_flags()))
        self._zn_cond.set_data(zone.get("conditions", []))
        self._zn_enter.set_data(zone.get("onEnter", []))
        self._zn_exit.set_data(zone.get("onExit", []))

    def save_zone_props(self) -> dict | None:
        zone = self._current_data
        if zone is None or self._stack.currentWidget() != self._zone_panel:
            return None
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
        return zone


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
        add_menu = QMenu()
        add_menu.addAction("Hotspot", self._add_hotspot)
        add_menu.addAction("NPC", self._add_npc)
        add_menu.addAction("Zone", self._add_zone)
        add_menu.addAction("Spawn Point", self._add_spawn)
        add_btn = QPushButton("+ Add Entity")
        add_btn.setMenu(add_menu)
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

        # load background
        bgs = sc.get("backgrounds", [])
        if bgs:
            img_name = bgs[0].get("image", "background.png")
            img_path = self._model.scenes_path / scene_id / img_name
            self._canvas.load_background(img_path)

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
        self._props.load_scene_props(sc)

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

    def _on_item_deselected(self) -> None:
        if self._current_scene_id:
            sc = self._model.scenes.get(self._current_scene_id)
            if sc:
                self._props.load_scene_props(sc)

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

    def _apply_props(self) -> None:
        self._props.save_scene_props()
        self._props.save_hotspot_props()
        self._props.save_npc_props()
        self._props.save_zone_props()
        self._model.mark_dirty("scene", self._current_scene_id or "")
        if self._current_scene_id:
            self._load_scene(self._current_scene_id)

    def _add_hotspot(self) -> None:
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return
        hs_list = sc.setdefault("hotspots", [])
        new_id = f"new_hotspot_{len(hs_list)}"
        hs_list.append({
            "id": new_id, "type": "inspect", "label": "", "x": 100, "y": 100,
            "interactionRange": 50, "data": {"text": ""},
        })
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id)

    def _add_npc(self) -> None:
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return
        npc_list = sc.setdefault("npcs", [])
        new_id = f"new_npc_{len(npc_list)}"
        npc_list.append({
            "id": new_id, "name": "New NPC", "x": 150, "y": 150,
            "dialogueFile": "", "interactionRange": 50,
        })
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id)

    def _add_zone(self) -> None:
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return
        z_list = sc.setdefault("zones", [])
        new_id = f"new_zone_{len(z_list)}"
        z_list.append({"id": new_id, "x": 50, "y": 50, "width": 200, "height": 100})
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id)

    def _add_spawn(self) -> None:
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return
        sps = sc.setdefault("spawnPoints", {})
        name = f"spawn_{len(sps)}"
        sps[name] = {"x": 200, "y": 200}
        self._model.mark_dirty("scene", self._current_scene_id or "")
        self._load_scene(self._current_scene_id)

    def _delete_selected(self) -> None:
        sc = self._model.scenes.get(self._current_scene_id or "")
        if sc is None:
            return
        sel = self._canvas._scene.selectedItems()
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
