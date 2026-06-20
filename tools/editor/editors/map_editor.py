"""Map node editor with draggable canvas and transition edge visualization."""
from __future__ import annotations

import math

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget,
    QFormLayout, QLineEdit, QPushButton, QDoubleSpinBox, QScrollArea,
    QGraphicsView, QGraphicsScene, QGraphicsEllipseItem, QGraphicsTextItem,
    QGraphicsLineItem, QGraphicsPolygonItem, QGraphicsItem,
)
from PySide6.QtGui import (
    QPen, QBrush, QColor, QFont, QPainter, QWheelEvent, QPolygonF,
    QMouseEvent,
)
from PySide6.QtCore import Qt, QPoint, QPointF

from ..project_model import ProjectModel
from ..shared.condition_editor import ConditionEditor
from ..shared.id_ref_selector import IdRefSelector
from ..shared.rich_text_field import RichTextLineEdit
from ..shared.form_layout import compact_form
from ..shared.fonts import MONO_FONT_FAMILY


class _ZoomableView(QGraphicsView):
    """QGraphicsView：左键选择/拖移图元；中键平移；滚轮缩放。"""

    def __init__(self, scene: QGraphicsScene, parent: QWidget | None = None):
        super().__init__(scene, parent)
        self.setRenderHint(QPainter.RenderHint.Antialiasing)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self._zoom = 1.0
        self._middle_panning = False
        self._pan_last_pos = QPoint()

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

    def mousePressEvent(self, event: QMouseEvent) -> None:  # type: ignore[override]
        if event.button() == Qt.MouseButton.MiddleButton:
            self._middle_panning = True
            self._pan_last_pos = event.pos()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # type: ignore[override]
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

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # type: ignore[override]
        if event.button() == Qt.MouseButton.MiddleButton:
            if self._middle_panning:
                self._middle_panning = False
                self.unsetCursor()
            event.accept()
            return
        super().mouseReleaseEvent(event)


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


class MapNodeGraphicsItem(QGraphicsEllipseItem):
    """可拖动、可选中的地图节点；位置即逻辑坐标 (x, y)。"""

    def __init__(
        self,
        node_index: int,
        x: float,
        y: float,
        radius: float,
        label: str,
        editor: MapEditor,
    ):
        super().__init__(-radius, -radius, radius * 2, radius * 2)
        self._node_index = node_index
        self._editor = editor
        self.setPos(QPointF(float(x), float(y)))
        self.setPen(QPen(QColor(100, 200, 255)))
        self.setBrush(QBrush(QColor(40, 80, 140)))
        self.setZValue(10)
        fl = (
            QGraphicsEllipseItem.GraphicsItemFlag.ItemIsMovable
            | QGraphicsEllipseItem.GraphicsItemFlag.ItemIsSelectable
            | QGraphicsEllipseItem.GraphicsItemFlag.ItemSendsGeometryChanges
        )
        self.setFlags(fl)
        self._label_item = QGraphicsTextItem(label, self)
        self._label_item.setDefaultTextColor(Qt.GlobalColor.white)
        self._label_item.setFont(QFont(MONO_FONT_FAMILY, 7))
        self._label_item.setFlag(
            QGraphicsTextItem.GraphicsItemFlag.ItemIgnoresTransformations, True)
        self._label_item.setPos(radius + 2, -8)
        self._label_item.setZValue(11)

    @property
    def node_index(self) -> int:
        return self._node_index

    def set_label(self, text: str) -> None:
        self._label_item.setPlainText(text)

    def set_node_index(self, index: int) -> None:
        self._node_index = index

    def itemChange(self, change: QGraphicsItem.GraphicsItemChange, value):  # type: ignore[override]
        if change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged:
            self._editor._on_node_item_moved(self._node_index, self.pos())
        if change == QGraphicsItem.GraphicsItemChange.ItemSelectedHasChanged:
            if value:
                self.setPen(QPen(QColor(255, 220, 100), 2.5))
                self._editor._on_node_item_selected(self._node_index)
            else:
                self.setPen(QPen(QColor(100, 200, 255), 1))
        return super().itemChange(change, value)


class MapEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_idx = -1
        self._node_graphics: list[MapNodeGraphicsItem] = []
        self._edge_items: list[QGraphicsItem] = []
        self._syncing_selection = False
        self._updating_from_spin = False
        self._loading_ui = False
        # 别处改了场景/过渡后，地图连线会过期；标记待刷新，下次显示该页时重建。
        self._needs_refresh = False
        model.data_changed.connect(self._on_model_data_changed)

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Node")
        btn_add.clicked.connect(self._add)
        btn_del = QPushButton("Delete")
        btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add)
        btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)

        center = QWidget()
        cl = QVBoxLayout(center)
        self._map_scene = QGraphicsScene()
        self._map_view = _ZoomableView(self._map_scene)
        cl.addWidget(self._map_view)
        self._map_scene.selectionChanged.connect(self._on_scene_selection_changed)

        # 右侧属性面板：表单 + 解锁条件整体放进同一个滚动区，解锁条件
        # （含表达式树 / 兜底文本框）才能拿到自然高度，不再被挤压成重叠布局。
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        detail = QWidget()
        dv = QVBoxLayout(detail)
        dv.setContentsMargins(6, 6, 6, 6)

        form_box = QWidget()
        f = compact_form(QFormLayout(form_box))
        f.setContentsMargins(0, 0, 0, 0)
        self._m_scene = IdRefSelector(allow_empty=False, editable=False, click_opens_popup=True)
        self._m_scene.setMinimumWidth(180)
        f.addRow("sceneId", self._m_scene)
        self._m_name = RichTextLineEdit(self._model)
        self._m_name.setMinimumWidth(200)
        f.addRow("name", self._m_name)
        self._m_x = QDoubleSpinBox()
        self._m_x.setRange(-9999, 9999)
        self._m_x.setDecimals(4)
        f.addRow("x", self._m_x)
        self._m_y = QDoubleSpinBox()
        self._m_y.setRange(-9999, 9999)
        self._m_y.setDecimals(4)
        f.addRow("y", self._m_y)
        self._m_cond = ConditionEditor("unlockConditions")

        dv.addWidget(form_box)
        dv.addWidget(self._m_cond)
        dv.addStretch(1)
        scroll.setWidget(detail)

        # 所有字段一律即时提交（与 x/y 拖移一致）：切换节点不再丢失未保存的
        # name / sceneId / 解锁条件编辑，消除「数据回弹」。载入期由 _loading_ui 守门。
        self._m_x.valueChanged.connect(self._on_xy_spin_changed)
        self._m_y.valueChanged.connect(self._on_xy_spin_changed)
        self._m_scene.value_changed.connect(self._on_scene_field_changed)
        self._m_name.textChanged.connect(self._on_name_field_changed)
        self._m_cond.changed.connect(self._on_cond_field_changed)

        right = QWidget()
        rl = QVBoxLayout(right)
        rl.setContentsMargins(0, 0, 0, 0)
        rl.addWidget(scroll, 1)

        splitter.addWidget(left)
        splitter.addWidget(center)
        splitter.addWidget(right)
        splitter.setSizes([180, 400, 320])
        root.addWidget(splitter)
        self._refresh()

    def _on_model_data_changed(self, data_type: str, _item_id: str = "") -> None:
        # 仅"场景"数据影响地图连线（过渡来自各场景的 changeScene/hotspot）。
        # 地图自身的节点编辑（'map'）已即时反映，不在此重建以免拖拽中自我打断。
        if data_type != "scene":
            return
        self._needs_refresh = True
        if self.isVisible():
            # 当前就在地图页：立即重建连线（场景编辑通常发生在别的页，极少同时可见）。
            self._needs_refresh = False
            self._refresh()

    def showEvent(self, event) -> None:  # type: ignore[override]
        super().showEvent(event)
        if self._needs_refresh:
            self._needs_refresh = False
            self._refresh()

    def _clear_edge_items(self) -> None:
        for it in self._edge_items:
            self._map_scene.removeItem(it)
        self._edge_items.clear()

    def _on_node_item_moved(self, idx: int, pos: QPointF) -> None:
        if self._updating_from_spin:
            return
        if idx < 0 or idx >= len(self._model.map_nodes):
            return
        n = self._model.map_nodes[idx]
        n["x"] = float(pos.x())
        n["y"] = float(pos.y())
        self._model.mark_dirty("map")
        if idx == self._current_idx:
            self._updating_from_spin = True
            try:
                self._m_x.setValue(pos.x())
                self._m_y.setValue(pos.y())
            finally:
                self._updating_from_spin = False
        self._redraw_edges()

    def _on_node_item_selected(self, idx: int) -> None:
        if self._syncing_selection:
            return
        if self._list.currentRow() != idx:
            self._list.setCurrentRow(idx)

    def _on_scene_selection_changed(self) -> None:
        if self._syncing_selection:
            return
        try:
            selected = self._map_scene.selectedItems()
        except RuntimeError:
            # 销毁期：C++ QGraphicsScene 已释放而信号仍连着，避免 SAGV/崩溃。
            return
        sel = [it for it in selected if isinstance(it, MapNodeGraphicsItem)]
        if not sel:
            self._syncing_selection = True
            try:
                self._list.setCurrentRow(-1)
            finally:
                self._syncing_selection = False
            self._current_idx = -1
            return
        idx = sel[0].node_index
        if self._list.currentRow() != idx:
            self._list.setCurrentRow(idx)

    def _on_xy_spin_changed(self) -> None:
        if self._current_idx < 0:
            return
        if self._updating_from_spin or self._loading_ui:
            return
        idx = self._current_idx
        if idx >= len(self._node_graphics):
            return
        x, y = self._m_x.value(), self._m_y.value()
        n = self._model.map_nodes[idx]
        n["x"] = float(x)
        n["y"] = float(y)
        self._model.mark_dirty("map")
        self._updating_from_spin = True
        try:
            self._node_graphics[idx].setPos(QPointF(x, y))
        finally:
            self._updating_from_spin = False
        self._redraw_edges()

    def _refresh(self) -> None:
        # 快照目标选中行：clear() 会同步触发 selectionChanged / currentRowChanged(-1)，
        # 把 _current_idx 清成 -1，若不先快照，末尾的恢复块就成了死代码（选择丢失）。
        target = self._current_idx
        self._syncing_selection = True
        try:
            self._list.clear()
            self._map_scene.clear()
        finally:
            self._syncing_selection = False
        self._node_graphics.clear()
        self._edge_items.clear()

        pos_map: dict[str, tuple[float, float]] = {}

        for i, n in enumerate(self._model.map_nodes):
            sid = n.get("sceneId", "?")
            self._list.addItem(f"{sid}  [{n.get('name', '')}]")
            x, y = n.get("x", 0), n.get("y", 0)
            pos_map[sid] = (float(x), float(y))
            item = MapNodeGraphicsItem(
                i, float(x), float(y), _NODE_RADIUS,
                str(n.get("name", "?")), self)
            self._map_scene.addItem(item)
            self._node_graphics.append(item)

        self._draw_edges(pos_map)
        self._map_view.fit_all()
        self._m_scene.set_items([(s, s) for s in self._model.all_scene_ids()])

        if 0 <= target < len(self._model.map_nodes):
            self._current_idx = target
            self._syncing_selection = True
            try:
                self._list.setCurrentRow(target)
                self._node_graphics[target].setSelected(True)
            finally:
                self._syncing_selection = False
        else:
            self._current_idx = -1

    def _redraw_edges(self) -> None:
        self._clear_edge_items()
        pos_map: dict[str, tuple[float, float]] = {}
        for i, n in enumerate(self._model.map_nodes):
            sid = n.get("sceneId", "?")
            if i < len(self._node_graphics):
                p = self._node_graphics[i].pos()
                pos_map[sid] = (float(p.x()), float(p.y()))
            else:
                pos_map[sid] = (float(n.get("x", 0)), float(n.get("y", 0)))
        self._draw_edges(pos_map)

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
        self._edge_items.append(line)

        angle = math.atan2(ey - sy, ex - sx)
        tip = QPointF(ex, ey)
        arrow_poly = _arrow_head(tip, angle, _ARROW_SIZE)
        arrow = self._map_scene.addPolygon(arrow_poly, pen, brush)
        arrow.setZValue(2)
        self._edge_items.append(arrow)

        if label:
            mx = (sx + ex) / 2
            my = (sy + ey) / 2
            lbl = self._map_scene.addText(label, QFont(MONO_FONT_FAMILY, 6))
            lbl.setDefaultTextColor(
                QColor(255, 170, 50) if conditional else QColor(140, 200, 255))
            lbl.setPos(mx + 4, my - 10)
            lbl.setZValue(3)
            lbl.setToolTip(f"{label} ({'conditional' if conditional else 'always'})")
            self._edge_items.append(lbl)

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.map_nodes):
            self._current_idx = -1
            if not self._syncing_selection:
                self._syncing_selection = True
                try:
                    self._map_scene.clearSelection()
                finally:
                    self._syncing_selection = False
            return
        self._current_idx = row
        self._syncing_selection = True
        try:
            self._map_scene.clearSelection()
            if row < len(self._node_graphics):
                self._node_graphics[row].setSelected(True)
        finally:
            self._syncing_selection = False
        n = self._model.map_nodes[row]
        # 载入字段期间屏蔽即时提交回写（_loading_ui），否则 setText / set_data 会把
        # 刚载入的值又「提交」回模型并刷新列表/画布，造成抖动。
        self._loading_ui = True
        try:
            self._m_scene.set_current(n.get("sceneId", ""))
            self._m_name.setText(n.get("name", ""))
            # 仅用模型/图元坐标更新数值框，且必须 blockSignals：否则会触发 _on_xy_spin_changed，
            # 默认舍入会把节点 setPos 到错误位置。
            if row < len(self._node_graphics):
                p = self._node_graphics[row].pos()
                vx, vy = float(p.x()), float(p.y())
            else:
                vx = float(n.get("x", 0))
                vy = float(n.get("y", 0))
            self._m_x.blockSignals(True)
            self._m_y.blockSignals(True)
            try:
                self._m_x.setValue(vx)
                self._m_y.setValue(vy)
            finally:
                self._m_x.blockSignals(False)
                self._m_y.blockSignals(False)
            self._m_cond.set_flag_pattern_context(self._model, None)
            self._m_cond.set_data(n.get("unlockConditions", []))
        finally:
            self._loading_ui = False

    def _commit_node_field(self, key: str, value) -> bool:
        """即时把单个字段写回当前节点；载入 UI 期间忽略，避免回写覆盖。"""
        if self._loading_ui:
            return False
        if self._current_idx < 0 or self._current_idx >= len(self._model.map_nodes):
            return False
        self._model.map_nodes[self._current_idx][key] = value
        self._model.mark_dirty("map")
        return True

    def _update_list_label(self, idx: int) -> None:
        if 0 <= idx < self._list.count() and idx < len(self._model.map_nodes):
            n = self._model.map_nodes[idx]
            it = self._list.item(idx)
            if it is not None:
                it.setText(f"{n.get('sceneId', '?')}  [{n.get('name', '')}]")

    def _on_scene_field_changed(self, _value: str = "") -> None:
        if not self._commit_node_field("sceneId", self._m_scene.current_id()):
            return
        self._update_list_label(self._current_idx)
        self._redraw_edges()

    def _on_name_field_changed(self, _value: str = "") -> None:
        name = self._m_name.text()
        if not self._commit_node_field("name", name):
            return
        self._update_list_label(self._current_idx)
        if self._current_idx < len(self._node_graphics):
            self._node_graphics[self._current_idx].set_label(name)

    def _on_cond_field_changed(self) -> None:
        self._commit_node_field("unlockConditions", self._m_cond.to_list())

    def _add(self) -> None:
        self._model.map_nodes.append({
            "sceneId": "", "name": "New", "x": 100, "y": 100, "unlockConditions": [],
        })
        self._model.mark_dirty("map")
        self._current_idx = len(self._model.map_nodes) - 1
        self._refresh()

    def _delete(self) -> None:
        if self._current_idx >= 0:
            self._model.map_nodes.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty("map")
            self._refresh()
