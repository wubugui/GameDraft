"""Map node editor with draggable canvas and transition edge visualization."""
from __future__ import annotations

import math

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QPushButton, QDoubleSpinBox, QScrollArea,
    QGraphicsView, QGraphicsScene, QGraphicsEllipseItem, QGraphicsTextItem,
    QGraphicsLineItem, QGraphicsPolygonItem,
)
from PySide6.QtGui import (
    QPen, QBrush, QColor, QFont, QPainter, QWheelEvent, QPolygonF,
)
from PySide6.QtCore import Qt, Signal, QPointF

from ..project_model import ProjectModel
from ..shared.condition_editor import ConditionEditor
from ..shared.id_ref_selector import IdRefSelector


class _ZoomableView(QGraphicsView):
    """QGraphicsView with mouse-wheel zoom and middle-button pan."""

    def __init__(self, scene: QGraphicsScene, parent: QWidget | None = None):
        super().__init__(scene, parent)
        self.setRenderHint(QPainter.RenderHint.Antialiasing)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self._zoom = 1.0

    def wheelEvent(self, event: QWheelEvent) -> None:  # type: ignore[override]
        factor = 1.25 if event.angleDelta().y() > 0 else 1 / 1.25
        new_zoom = self._zoom * factor
        if 0.1 < new_zoom < 10.0:
            self._zoom = new_zoom
            self.scale(factor, factor)
        event.accept()

    def fit_all(self) -> None:
        rect = self.scene().itemsBoundingRect().adjusted(-40, -40, 40, 40)
        if rect.isEmpty():
            return
        self.fitInView(rect, Qt.AspectRatioMode.KeepAspectRatio)
        self._zoom = self.transform().m11()


_NODE_RADIUS = 12
_ARROW_SIZE = 8
_DUAL_OFFSET = 6

_PEN_NORMAL = QPen(QColor(100, 200, 255, 180), 1.5)
_PEN_CONDITIONAL = QPen(QColor(255, 170, 50, 200), 1.5, Qt.PenStyle.DashLine)
_BRUSH_ARROW_NORMAL = QBrush(QColor(100, 200, 255, 200))
_BRUSH_ARROW_COND = QBrush(QColor(255, 170, 50, 220))


def _arrow_head(tip: QPointF, angle: float, size: float) -> QPolygonF:
    """Build a small triangle pointing at *tip* along *angle* (radians)."""
    left = QPointF(
        tip.x() - size * math.cos(angle - 0.4),
        tip.y() - size * math.sin(angle - 0.4),
    )
    right = QPointF(
        tip.x() - size * math.cos(angle + 0.4),
        tip.y() - size * math.sin(angle + 0.4),
    )
    return QPolygonF([tip, left, right])


class MapEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx = -1

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Node"); btn_add.clicked.connect(self._add)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)

        center = QWidget()
        cl = QVBoxLayout(center)
        self._map_scene = QGraphicsScene()
        self._map_view = _ZoomableView(self._map_scene)
        cl.addWidget(self._map_view)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        f = QFormLayout(detail)
        self._m_scene = IdRefSelector(allow_empty=False)
        f.addRow("sceneId", self._m_scene)
        self._m_name = QLineEdit(); f.addRow("name", self._m_name)
        self._m_x = QDoubleSpinBox(); self._m_x.setRange(-9999, 9999)
        f.addRow("x", self._m_x)
        self._m_y = QDoubleSpinBox(); self._m_y.setRange(-9999, 9999)
        f.addRow("y", self._m_y)
        self._m_cond = ConditionEditor("unlockConditions")
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply)

        right = QWidget()
        rl = QVBoxLayout(right)
        rl.addWidget(scroll)
        scroll.setWidget(detail)
        rl.addWidget(self._m_cond)
        rl.addWidget(apply_btn)

        splitter.addWidget(left)
        splitter.addWidget(center)
        splitter.addWidget(right)
        splitter.setSizes([180, 400, 300])
        root.addWidget(splitter)
        self._refresh()

    def _refresh(self) -> None:
        self._list.clear()
        self._map_scene.clear()

        pos_map: dict[str, tuple[float, float]] = {}

        for i, n in enumerate(self._model.map_nodes):
            sid = n.get("sceneId", "?")
            self._list.addItem(f"{sid}  [{n.get('name', '')}]")
            x, y = n.get("x", 0), n.get("y", 0)
            pos_map[sid] = (x, y)
            el = self._map_scene.addEllipse(x - _NODE_RADIUS, y - _NODE_RADIUS,
                                             _NODE_RADIUS * 2, _NODE_RADIUS * 2,
                                             QPen(QColor(100, 200, 255)),
                                             QBrush(QColor(40, 80, 140)))
            el.setZValue(10)
            txt = self._map_scene.addText(n.get("name", "?"), QFont("Consolas", 7))
            txt.setDefaultTextColor(Qt.GlobalColor.white)
            txt.setPos(x + _NODE_RADIUS + 2, y - 8)
            txt.setZValue(11)

        self._draw_edges(pos_map)

        self._map_view.fit_all()
        self._m_scene.set_items([(s, s) for s in self._model.all_scene_ids()])

    def _draw_edges(self, pos_map: dict[str, tuple[float, float]]) -> None:
        edges = self._model.scene_transitions()

        pair_set: set[tuple[str, str]] = set()
        reverse_set: set[tuple[str, str]] = set()
        for e in edges:
            key = (e["from_scene"], e["to_scene"])
            pair_set.add(key)
        for a, b in pair_set:
            if (b, a) in pair_set:
                reverse_set.add((a, b))
                reverse_set.add((b, a))

        drawn_pairs: set[tuple[str, str]] = set()

        for e in edges:
            fs, ts = e["from_scene"], e["to_scene"]
            if fs not in pos_map or ts not in pos_map or fs == ts:
                continue
            pair_key = (fs, ts)
            if pair_key in drawn_pairs:
                continue
            drawn_pairs.add(pair_key)

            x1, y1 = pos_map[fs]
            x2, y2 = pos_map[ts]

            is_dual = pair_key in reverse_set

            self._draw_arrow(x1, y1, x2, y2, e["conditional"],
                             e["label"], is_dual, _DUAL_OFFSET)

    def _draw_arrow(self, x1: float, y1: float, x2: float, y2: float,
                    conditional: bool, label: str,
                    offset_side: bool, offset_px: float) -> None:
        dx = x2 - x1
        dy = y2 - y1
        dist = math.hypot(dx, dy)
        if dist < 1:
            return

        ux, uy = dx / dist, dy / dist

        if offset_side:
            nx, ny = -uy, ux
            x1 += nx * offset_px
            y1 += ny * offset_px
            x2 += nx * offset_px
            y2 += ny * offset_px
            dx = x2 - x1
            dy = y2 - y1
            dist = math.hypot(dx, dy)
            if dist < 1:
                return
            ux, uy = dx / dist, dy / dist

        sx = x1 + ux * _NODE_RADIUS
        sy = y1 + uy * _NODE_RADIUS
        ex = x2 - ux * _NODE_RADIUS
        ey = y2 - uy * _NODE_RADIUS

        pen = _PEN_CONDITIONAL if conditional else _PEN_NORMAL
        brush = _BRUSH_ARROW_COND if conditional else _BRUSH_ARROW_NORMAL

        line = self._map_scene.addLine(sx, sy, ex, ey, pen)
        line.setZValue(1)

        angle = math.atan2(ey - sy, ex - sx)
        tip = QPointF(ex, ey)
        arrow_poly = _arrow_head(tip, angle, _ARROW_SIZE)
        arrow = self._map_scene.addPolygon(arrow_poly, pen, brush)
        arrow.setZValue(2)

        if label:
            mx = (sx + ex) / 2
            my = (sy + ey) / 2
            lbl = self._map_scene.addText(label, QFont("Consolas", 6))
            lbl.setDefaultTextColor(
                QColor(255, 170, 50) if conditional else QColor(140, 200, 255))
            lbl.setPos(mx + 4, my - 10)
            lbl.setZValue(3)
            lbl.setToolTip(f"{label} ({'conditional' if conditional else 'always'})")

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.map_nodes):
            return
        self._current_idx = row
        n = self._model.map_nodes[row]
        self._m_scene.set_current(n.get("sceneId", ""))
        self._m_name.setText(n.get("name", ""))
        self._m_x.setValue(n.get("x", 0))
        self._m_y.setValue(n.get("y", 0))
        self._m_cond.set_flag_pattern_context(self._model, None)
        self._m_cond.set_data(n.get("unlockConditions", []))

    def _apply(self) -> None:
        if self._current_idx < 0:
            return
        n = self._model.map_nodes[self._current_idx]
        n["sceneId"] = self._m_scene.current_id()
        n["name"] = self._m_name.text()
        n["x"] = self._m_x.value()
        n["y"] = self._m_y.value()
        n["unlockConditions"] = self._m_cond.to_list()
        self._model.mark_dirty("map")
        self._refresh()

    def _add(self) -> None:
        self._model.map_nodes.append({
            "sceneId": "", "name": "New", "x": 100, "y": 100, "unlockConditions": [],
        })
        self._model.mark_dirty("map")
        self._refresh()

    def _delete(self) -> None:
        if self._current_idx >= 0:
            self._model.map_nodes.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("map")
            self._refresh()
