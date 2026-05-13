"""地图上选取 moveEntityTo 途经点/终点与世界坐标预览（scene_editor / action_editor 共用）。"""
from __future__ import annotations

import math
from pathlib import Path

from PySide6.QtWidgets import (
    QGraphicsView,
    QGraphicsScene,
    QVBoxLayout,
    QHBoxLayout,
    QLabel,
    QGraphicsEllipseItem,
    QGraphicsPixmapItem,
    QGraphicsLineItem,
    QGraphicsItem,
    QDialog,
    QDialogButtonBox,
    QWidget,
    QPushButton,
    QRadioButton,
    QButtonGroup,
)
from PySide6.QtGui import (
    QPixmap,
    QPen,
    QBrush,
    QColor,
    QPainter,
    QWheelEvent,
    QMouseEvent,
    QTransform,
)
from PySide6.QtCore import Qt, QRectF, QPoint, QPointF, Signal, QTimer, QLineF

from ..project_model import ProjectModel

_MARKER_CAM_PICK = QColor(255, 70, 90, 210)
_MARKER_CAM_EDGE = QPen(QColor(255, 210, 220), 0)
_MARKER_WAY_FILL = QColor(80, 160, 255, 220)
_MARKER_DEST_FILL = _MARKER_CAM_PICK
_ROUTE_EDGE_PEN = QPen(QColor(255, 200, 120), 0)


def resolve_world_size_for_scene_json(
    sc: dict, img_path: Path | None,
) -> tuple[float, float]:
    """由场景 JSON + 背景图推导 (worldWidth, worldHeight)，与游戏 AssetManager 思路一致。"""
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


def normalize_move_entity_waypoints(raw: object) -> list[tuple[float, float]]:
    """解析 moveEntityTo.params.waypoints（世界坐标途经点序列）。"""
    out: list[tuple[float, float]] = []
    if not isinstance(raw, list):
        return out
    for it in raw:
        if not isinstance(it, dict):
            continue
        try:
            x = float(it.get("x"))
            y = float(it.get("y"))
        except (TypeError, ValueError):
            continue
        if math.isfinite(x) and math.isfinite(y):
            out.append((x, y))
    return out


class WorldPointPickView(QGraphicsView):
    """仅背景 + 选点标记；左键设点，中键平移，滚轮缩放。"""

    picked = Signal(float, float)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._gfx = QGraphicsScene(self)
        self.setScene(self._gfx)
        self.setRenderHints(
            QPainter.RenderHint.Antialiasing
            | QPainter.RenderHint.SmoothPixmapTransform)
        self.setViewportUpdateMode(
            QGraphicsView.ViewportUpdateMode.SmartViewportUpdate)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setTransformationAnchor(
            QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self._bg_item: QGraphicsPixmapItem | None = None
        self._marker: QGraphicsEllipseItem | None = None
        self._world_w: float = 800.0
        self._world_h: float = 600.0
        self._middle_panning = False
        self._pan_last_pos = QPoint()

    def clear_visual(self) -> None:
        self._gfx.clear()
        self._bg_item = None
        self._marker = None

    def setup_from_scene_json(
        self,
        model: ProjectModel,
        scene_id: str,
    ) -> tuple[float, float]:
        """返回 (world_w, world_h)。无场景数据时占位 800×600。"""
        self.clear_visual()
        sc = model.scenes.get(scene_id) or {}
        bgs = sc.get("backgrounds", [])
        img_path: Path | None = None
        if bgs:
            img_name = bgs[0].get("image", "background.png")
            try:
                img_path = model.paths.scene_runtime_asset(scene_id, str(img_name))
            except ValueError:
                img_path = None
        if img_path is not None and not img_path.is_file():
            img_path = None
        ww, wh = resolve_world_size_for_scene_json(sc, img_path)
        self._world_w = float(ww)
        self._world_h = float(wh)
        self._gfx.setSceneRect(QRectF(0, 0, ww, wh))
        if img_path is not None and img_path.is_file():
            pm = QPixmap(str(img_path))
            if not pm.isNull():
                self._bg_item = QGraphicsPixmapItem(pm)
                self._bg_item.setZValue(-100)
                sx = ww / pm.width()
                sy = wh / pm.height()
                self._bg_item.setTransform(QTransform.fromScale(sx, sy))
                self._gfx.addItem(self._bg_item)
        return ww, wh

    def marker_radius_world(self) -> float:
        return max(self._world_w, self._world_h) * 0.01

    def set_marker_world(self, wx: float, wy: float) -> None:
        rx = float(max(0.0, min(self._world_w, wx)))
        ry = float(max(0.0, min(self._world_h, wy)))
        rr = self.marker_radius_world()
        if self._marker is not None and self._marker.scene() is self._gfx:
            self._gfx.removeItem(self._marker)
        self._marker = QGraphicsEllipseItem(rx - rr, ry - rr, rr * 2, rr * 2)
        self._marker.setBrush(QBrush(_MARKER_CAM_PICK))
        self._marker.setPen(_MARKER_CAM_EDGE)
        self._marker.setZValue(50.0)
        self._gfx.addItem(self._marker)

    def fit_scene(self) -> None:
        sr = self._gfx.sceneRect()
        if sr.width() <= 0 or sr.height() <= 0:
            return
        self.resetTransform()
        self.fitInView(sr, Qt.AspectRatioMode.KeepAspectRatio)

    def _handle_left_pick_world(self, wx: float, wy: float) -> None:
        self.set_marker_world(wx, wy)
        self.picked.emit(wx, wy)

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() == Qt.MouseButton.MiddleButton:
            self._middle_panning = True
            self._pan_last_pos = event.pos()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            event.accept()
            return
        if event.button() == Qt.MouseButton.LeftButton:
            sp = self.mapToScene(event.pos())
            r = self._gfx.sceneRect()
            rx = float(max(r.left(), min(r.right(), sp.x())))
            ry = float(max(r.top(), min(r.bottom(), sp.y())))
            rx = round(rx, 2)
            ry = round(ry, 2)
            self._handle_left_pick_world(rx, ry)
            event.accept()
            return
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

    def wheelEvent(self, event: QWheelEvent) -> None:
        factor = 1.15 if event.angleDelta().y() > 0 else 1 / 1.15
        self.scale(factor, factor)
        event.accept()


class MoveEntityPathPickView(WorldPointPickView):
    """同一场景画布：途经点模式左键追加折线顶点；终点模式左键设定最终 x/y。"""

    MODE_VERTEX = "vertex"
    MODE_DEST = "dest"
    routeChanged = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._pick_mode = self.MODE_VERTEX
        self._vertices: list[tuple[float, float]] = []
        self._dest_xy: tuple[float, float] = (400.0, 300.0)
        self._route_items: list[QGraphicsItem] = []

    def set_pick_mode(self, mode: str) -> None:
        self._pick_mode = (
            mode if mode in (self.MODE_VERTEX, self.MODE_DEST) else self.MODE_VERTEX
        )

    def vertices(self) -> list[tuple[float, float]]:
        return list(self._vertices)

    def set_vertices(self, verts: list[tuple[float, float]]) -> None:
        self._vertices = list(verts)

    def destination(self) -> tuple[float, float]:
        return float(self._dest_xy[0]), float(self._dest_xy[1])

    def set_destination(self, dx: float, dy: float) -> None:
        self._dest_xy = (float(dx), float(dy))

    def setup_from_scene_json(
        self,
        model: ProjectModel,
        scene_id: str,
    ) -> tuple[float, float]:
        ww, wh = super().setup_from_scene_json(model, scene_id)
        if self._marker is not None and self._marker.scene() is self._gfx:
            self._gfx.removeItem(self._marker)
        self._marker = None
        dx, dy = self._dest_xy
        self._dest_xy = (
            float(max(0.0, min(self._world_w, dx))),
            float(max(0.0, min(self._world_h, dy))),
        )
        nv: list[tuple[float, float]] = []
        for vx, vy in self._vertices:
            nv.append((
                float(max(0.0, min(self._world_w, vx))),
                float(max(0.0, min(self._world_h, vy))),
            ))
        self._vertices = nv
        self._redraw_route()
        return ww, wh

    def pop_last_vertex(self) -> bool:
        if not self._vertices:
            return False
        self._vertices.pop()
        self._redraw_route()
        return True

    def clear_vertices(self) -> None:
        self._vertices.clear()
        self._redraw_route()

    def _redraw_route(self) -> None:
        for it in self._route_items:
            try:
                if it.scene() is self._gfx:
                    self._gfx.removeItem(it)
            except RuntimeError:
                pass
        self._route_items.clear()

        rr_v = max(self.marker_radius_world() * 0.75, 3.5)
        rr_d = max(self.marker_radius_world() * 1.05, 5.0)

        pts: list[tuple[float, float]] = list(self._vertices) + [self._dest_xy]
        for i in range(len(pts) - 1):
            ax, ay = pts[i]
            bx, by = pts[i + 1]
            li = QGraphicsLineItem(QLineF(QPointF(ax, ay), QPointF(bx, by)))
            li.setPen(_ROUTE_EDGE_PEN)
            li.setZValue(30.0)
            self._gfx.addItem(li)
            self._route_items.append(li)

        pen_v = QPen(QColor(200, 235, 255), 0)
        for vx, vy in self._vertices:
            el = QGraphicsEllipseItem(vx - rr_v, vy - rr_v, rr_v * 2, rr_v * 2)
            el.setBrush(QBrush(_MARKER_WAY_FILL))
            el.setPen(pen_v)
            el.setZValue(40.0)
            self._gfx.addItem(el)
            self._route_items.append(el)

        fx, fy = self._dest_xy
        dest_item = QGraphicsEllipseItem(fx - rr_d, fy - rr_d, rr_d * 2, rr_d * 2)
        dest_item.setBrush(QBrush(_MARKER_DEST_FILL))
        dest_item.setPen(_MARKER_CAM_EDGE)
        dest_item.setZValue(48.0)
        self._gfx.addItem(dest_item)
        self._route_items.append(dest_item)
        self.routeChanged.emit()

    def _handle_left_pick_world(self, wx: float, wy: float) -> None:
        rx = float(max(0.0, min(self._world_w, wx)))
        ry = float(max(0.0, min(self._world_h, wy)))
        if self._pick_mode == self.MODE_VERTEX:
            self._vertices.append((rx, ry))
        else:
            self._dest_xy = (rx, ry)
        self._redraw_route()


class MoveEntityToMapPickerDialog(QDialog):
    """moveEntityTo：必选终点在世界地图上；途经点可选（折线）；仅对话框内写入坐标。"""

    def __init__(
        self,
        model: ProjectModel,
        scene_id: str,
        dest_x: float,
        dest_y: float,
        waypoints_xy: list[tuple[float, float]] | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._model = model
        self._scene_id = scene_id
        sc0 = model.scenes.get(scene_id, {})
        title_nm = sc0.get("name", scene_id)
        self.setWindowTitle(f"移动目标路径 — {scene_id}（{title_nm}）")
        self.resize(980, 620)

        root = QVBoxLayout(self)
        root.addWidget(QLabel(
            "左键在地图上点击：在「途经点」模式下逐个追加折线顶点；切换到「终点」模式后单击设定最终到达位置。\n"
            "中键平移画布，滚轮缩放。终点为必填；未设置途经点时游戏中沿直线移动到终点。"
        ))

        toolbar = QHBoxLayout()
        self._rb_vertex = QRadioButton("途经点模式")
        self._rb_dest = QRadioButton("终点模式")
        self._rb_vertex.setChecked(True)
        grp = QButtonGroup(self)
        grp.addButton(self._rb_vertex)
        grp.addButton(self._rb_dest)
        toolbar.addWidget(self._rb_vertex)
        toolbar.addWidget(self._rb_dest)
        btn_undo = QPushButton("撤销上一途经点")
        btn_undo.clicked.connect(self._on_undo_vertex)
        btn_clear = QPushButton("清空途经点")
        btn_clear.clicked.connect(self._on_clear_vertices)
        toolbar.addWidget(btn_undo)
        toolbar.addWidget(btn_clear)
        toolbar.addStretch(1)
        root.addLayout(toolbar)

        self._lbl = QLabel("", self)
        self._lbl.setStyleSheet("font-family: Consolas; font-size:12px;")
        root.addWidget(self._lbl)

        self._view = MoveEntityPathPickView(self)
        self._view.routeChanged.connect(self._sync_label)
        self._view.set_vertices(list(waypoints_xy or []))
        self._view.set_destination(dest_x, dest_y)
        self._view.setup_from_scene_json(model, scene_id)

        root.addWidget(self._view, 1)
        bbox = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
        )
        bbox.accepted.connect(self.accept)
        bbox.rejected.connect(self.reject)
        root.addWidget(bbox)

        self._rb_vertex.toggled.connect(lambda _on: self._sync_mode_radio())
        self._rb_dest.toggled.connect(lambda _on: self._sync_mode_radio())
        self._sync_mode_radio()
        QTimer.singleShot(0, self._view.fit_scene)
        self._sync_label()

    def _sync_mode_radio(self) -> None:
        self._view.set_pick_mode(
            MoveEntityPathPickView.MODE_VERTEX if self._rb_vertex.isChecked()
            else MoveEntityPathPickView.MODE_DEST,
        )

    def _on_undo_vertex(self) -> None:
        self._view.pop_last_vertex()

    def _on_clear_vertices(self) -> None:
        self._view.clear_vertices()

    def _sync_label(self) -> None:
        dx, dy = self._view.destination()
        n = len(self._view.vertices())
        self._lbl.setText(f"途经点个数: {n}   终点: x={dx:.2f}  y={dy:.2f}")

    def result_waypoints_objects(self) -> list[dict[str, float]]:
        return [
            {"x": round(float(vx), 2), "y": round(float(vy), 2)}
            for vx, vy in self._view.vertices()
        ]

    def result_destination(self) -> tuple[float, float]:
        return self._view.destination()
