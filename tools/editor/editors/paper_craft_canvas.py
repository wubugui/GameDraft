"""扎纸（paper_craft）槽位可视化画布：在纸人底图上拖拽 / 缩放槽位矩形。

设计对齐 ``water_minigame_canvas.py``：一个 QGraphicsView 背景 + 每槽一个可拖动 item，
item 几何变化 → 回写模型。本画布只提供「看与改 x/y/width/height」的视图能力，
不改 slots 数组的字段形态或读写映射——未被拖动的槽位导出 JSON 逐字节保持不变。

底图来源：实例级可选字段 ``instance.backgroundImage``（运行时 PaperCraftMinigameScene
读取它绘制纸人底图）。该字段缺省时，画布用中性底色 + 网格作为背板，尺寸取自所有槽位
的外接框（不凭空往 JSON 写底图字段）。

坐标系：scene 坐标 == 运行时屏幕像素坐标（与 slot.x/y/width/height 同义）。回写时按
``int(round(...))`` 取整，保持与既有 QSpinBox 写回完全一致的整数像素语义。
"""
from __future__ import annotations

from typing import Any

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QBrush, QColor, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QGraphicsItem,
    QGraphicsPixmapItem,
    QGraphicsRectItem,
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


# 槽位外接框为空（无槽位或尺寸全 0）时画布的默认逻辑尺寸。
_DEFAULT_CANVAS_W = 560
_DEFAULT_CANVAS_H = 410
# 缩放手柄边长（scene 像素）。
_HANDLE = 9
# 槽位的最小宽高（与新增槽位的合理下限一致，避免缩成 0）。
_MIN_SLOT = 4


def _load_runtime_pixmap(model: ProjectModel | None, url: str) -> QPixmap | None:
    """底图素材：仅接受 ``/resources/runtime/...`` 媒体 URL，文件须存在。"""
    u = (url or "").strip()
    if not u or model is None or not model.project_path:
        return None
    disk = disk_path_for_runtime_url(model, u)
    if disk is None or not disk.is_file():
        return None
    pm = QPixmap(str(disk))
    return pm if not pm.isNull() else None


def _slots_bounds(slots: list[dict]) -> tuple[int, int]:
    """所有槽位矩形的右/下外接框（含一点留白），用于无底图时确定画布尺寸。"""
    max_x = 0
    max_y = 0
    for s in slots:
        if not isinstance(s, dict):
            continue
        x = int(s.get("x") or 0)
        y = int(s.get("y") or 0)
        w = int(s.get("width") or 0)
        h = int(s.get("height") or 0)
        max_x = max(max_x, x + w)
        max_y = max(max_y, y + h)
    if max_x <= 0 or max_y <= 0:
        return (_DEFAULT_CANVAS_W, _DEFAULT_CANVAS_H)
    # 留 24px 边距，便于贴边槽位也能选中其手柄。
    return (max_x + 24, max_y + 24)


class _ResizeHandle(QGraphicsRectItem):
    """槽位矩形右下角的缩放手柄（拖动它改 width/height，不改 x/y）。"""

    def __init__(self, parent: "SlotRectItem") -> None:
        super().__init__(-_HANDLE / 2, -_HANDLE / 2, _HANDLE, _HANDLE, parent)
        self._slot_item = parent
        self.setBrush(QBrush(QColor(255, 230, 80)))
        self.setPen(QPen(QColor(40, 30, 10), 1))
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges, True)
        self.setZValue(10)
        self.setCursor(Qt.CursorShape.SizeFDiagCursor)
        self._syncing = False

    def set_local_pos(self, w: float, h: float) -> None:
        self._syncing = True
        try:
            self.setPos(QPointF(w, h))
        finally:
            self._syncing = False

    def itemChange(self, change, value):  # noqa: ANN001
        if (
            change == QGraphicsItem.GraphicsItemChange.ItemPositionChange
            and not self._syncing
        ):
            p = QPointF(value)
            # 手柄相对矩形左上角的本地坐标即为 (width, height)，夹下限。
            w = max(_MIN_SLOT, p.x())
            h = max(_MIN_SLOT, p.y())
            value = QPointF(w, h)
        res = super().itemChange(change, value)
        if (
            change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged
            and not self._syncing
        ):
            self._slot_item.on_handle_moved(self.pos().x(), self.pos().y())
        return res


class SlotRectItem(QGraphicsRectItem):
    """一个槽位的可拖动 + 可缩放矩形。

    item.pos() == 槽位左上角 scene 坐标（== slot.x/y）；rect 始终为 ``(0,0,w,h)``，
    右下手柄给出 (w,h)。拖动矩形改 x/y；拖动手柄改 width/height。两类几何变化都回调
    画布 ``_on_slot_geometry_changed``，由编辑器按 ``int(round)`` 写回模型。
    """

    def __init__(self, row_index: int, slot: dict[str, Any], canvas: "PaperSlotCanvas") -> None:
        x = float(slot.get("x") or 0)
        y = float(slot.get("y") or 0)
        w = max(float(_MIN_SLOT), float(slot.get("width") or 0))
        h = max(float(_MIN_SLOT), float(slot.get("height") or 0))
        super().__init__(0.0, 0.0, w, h)
        self._row_index = row_index
        self._canvas = canvas
        self._optional = bool(slot.get("optional"))
        self._syncing = False

        self.setPos(QPointF(x, y))
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges, True)
        self.setZValue(50 + row_index * 0.01)
        self.setToolTip(f"{slot.get('id') or ''}  {slot.get('label') or ''}")
        self._apply_style()

        self._handle = _ResizeHandle(self)
        self._handle.set_local_pos(w, h)
        self._update_handle_visibility()

    def row_index(self) -> int:
        return self._row_index

    def set_row_index(self, idx: int) -> None:
        self._row_index = idx
        self.setZValue(50 + idx * 0.01)

    def _apply_style(self) -> None:
        sel = self.isSelected()
        edge = QColor(255, 230, 80) if sel else (
            QColor(128, 103, 68) if self._optional else QColor(196, 163, 90)
        )
        pen = QPen(edge, 2)
        if self._optional and not sel:
            pen.setStyle(Qt.PenStyle.DashLine)
        self.setPen(pen)
        fill = QColor(255, 230, 80, 46) if sel else QColor(196, 163, 90, 28)
        self.setBrush(QBrush(fill))

    def _update_handle_visibility(self) -> None:
        # 仅选中态显示缩放手柄，避免众多矩形堆叠手柄时一片杂乱。
        self._handle.setVisible(self.isSelected())

    def update_from_slot(self, slot: dict[str, Any]) -> None:
        """属性面板（spinbox）改了 x/y/w/h 后，把矩形几何同步过来（不触发回写）。"""
        self._syncing = True
        try:
            x = float(slot.get("x") or 0)
            y = float(slot.get("y") or 0)
            w = max(float(_MIN_SLOT), float(slot.get("width") or 0))
            h = max(float(_MIN_SLOT), float(slot.get("height") or 0))
            self._optional = bool(slot.get("optional"))
            self.setPos(QPointF(x, y))
            self.setRect(0.0, 0.0, w, h)
            self._handle.set_local_pos(w, h)
            self._apply_style()
        finally:
            self._syncing = False

    def on_handle_moved(self, w: float, h: float) -> None:
        if self._syncing:
            return
        self.setRect(0.0, 0.0, max(float(_MIN_SLOT), w), max(float(_MIN_SLOT), h))
        self._emit_geometry()

    def _emit_geometry(self) -> None:
        r = self.rect()
        self._canvas._on_slot_geometry_changed(
            self._row_index,
            float(self.pos().x()),
            float(self.pos().y()),
            float(r.width()),
            float(r.height()),
        )

    def itemChange(self, change, value):  # noqa: ANN001
        if (
            change == QGraphicsItem.GraphicsItemChange.ItemPositionChange
            and not self._syncing
        ):
            sc = self.scene()
            if sc is not None:
                sr = sc.sceneRect()
                r = self.rect()
                p = QPointF(value)
                # 把整个矩形夹在画布范围内（左上角 + 宽高都不出界）。
                nx = max(sr.left(), min(sr.right() - r.width(), p.x()))
                ny = max(sr.top(), min(sr.bottom() - r.height(), p.y()))
                value = QPointF(nx, ny)
        res = super().itemChange(change, value)
        if change == QGraphicsItem.GraphicsItemChange.ItemSelectedChange:
            self._apply_style()
            self._update_handle_visibility()
        if (
            change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged
            and not self._syncing
        ):
            self._emit_geometry()
        return res

    def paint(self, painter: QPainter, option, widget=None):  # noqa: ANN001
        super().paint(painter, option, widget)
        painter.save()
        painter.setPen(QPen(QColor(245, 217, 156)))
        painter.drawText(self.rect().adjusted(4, 2, -2, -2), int(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft), self.toolTip())
        painter.restore()


class _PaperBackdropScene(QGraphicsScene):
    """纸人底图背板：有底图则铺满 sceneRect；无底图则中性底色 + 浅网格。"""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._texture_item: QGraphicsPixmapItem | None = None
        self._has_texture = False

    def set_backdrop(self, pm: QPixmap | None) -> None:
        if self._texture_item is not None:
            self.removeItem(self._texture_item)
            self._texture_item = None
        self._has_texture = False
        r = self.sceneRect()
        if pm is not None and not pm.isNull() and r.width() > 0 and r.height() > 0:
            scaled = pm.scaled(
                max(1, int(r.width())),
                max(1, int(r.height())),
                Qt.AspectRatioMode.IgnoreAspectRatio,
                Qt.TransformationMode.SmoothTransformation,
            )
            self._texture_item = QGraphicsPixmapItem(scaled)
            self._texture_item.setPos(r.left(), r.top())
            self._texture_item.setZValue(-1e9)
            self._texture_item.setOpacity(0.6)
            self._texture_item.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, False)
            self.addItem(self._texture_item)
            self._has_texture = True
        self.invalidate(r, QGraphicsScene.SceneLayer.AllLayers)

    def drawBackground(self, painter: QPainter, rect: QRectF) -> None:  # noqa: ARG002
        r = self.sceneRect()
        painter.fillRect(r, QColor(37, 31, 23))
        if not self._has_texture:
            pen = QPen(QColor(90, 76, 56, 120))
            pen.setWidth(1)
            painter.setPen(pen)
            step = 32
            x = int(r.left())
            while x <= int(r.right()):
                painter.drawLine(QPointF(x, r.top()), QPointF(x, r.bottom()))
                x += step
            y = int(r.top())
            while y <= int(r.bottom()):
                painter.drawLine(QPointF(r.left(), y), QPointF(r.right(), y))
                y += step

    def drawForeground(self, painter: QPainter, rect: QRectF) -> None:  # noqa: ARG002
        r = self.sceneRect()
        painter.setPen(QPen(QColor(124, 95, 58), 1))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRect(r)


class _PaperCanvasView(QGraphicsView):
    def __init__(self, scene: QGraphicsScene, parent: QWidget | None = None) -> None:
        super().__init__(scene, parent)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setRenderHints(
            QPainter.RenderHint.Antialiasing | QPainter.RenderHint.SmoothPixmapTransform,
        )
        self.setMouseTracking(True)
        self.setViewportUpdateMode(QGraphicsView.ViewportUpdateMode.FullViewportUpdate)
        self.viewport().setAutoFillBackground(False)

    def wheelEvent(self, event):  # noqa: ANN001
        if event.angleDelta().y() == 0:
            super().wheelEvent(event)
            return
        factor = 1.12 if event.angleDelta().y() > 0 else 1 / 1.12
        self.scale(factor, factor)
        event.accept()


class PaperSlotCanvas(QWidget):
    """纸人底图上的槽位矩形可视化编辑器。

    信号：
      * ``slot_selected(int)``：画布选中某槽位（行号；-1 表示清空）。
      * ``slot_geometry_changed(int, int, int, int, int)``：行号 + 取整后的 x,y,w,h。
        编辑器据此写回模型并同步 spinbox。坐标已 ``int(round)``，与原 spinbox 写回同义。
    """

    slot_selected = Signal(int)
    slot_geometry_changed = Signal(int, int, int, int, int)

    def __init__(self, model: ProjectModel, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._items: list[SlotRectItem] = []
        self._silent_select = False
        self._suppress_emit = False

        tb = QHBoxLayout()
        self._btn_fit = QPushButton("适应窗口")
        self._btn_fit.setToolTip("缩放画布以铺满视图")
        tb.addWidget(self._btn_fit)
        tb.addWidget(QLabel("拖拽矩形=改 x/y；拖右下角手柄=改 宽/高（数值见下方精确输入框）"))
        tb.addStretch(1)

        self._scene = _PaperBackdropScene(self)
        self._view = _PaperCanvasView(self._scene, self)
        self._view.setMinimumSize(320, 200)  # 画布有 fit/缩放，缩小下限以适配 13"

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.addLayout(tb)
        root.addWidget(self._view, stretch=1)

        self._btn_fit.clicked.connect(self._fit_view)
        self._scene.selectionChanged.connect(self._on_scene_selection_changed)

    # ── 视图适配 ───────────────────────────────────────────────────────
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

    # ── 选择联动 ───────────────────────────────────────────────────────
    def _on_scene_selection_changed(self) -> None:
        if self._silent_select:
            return
        for s in self._scene.selectedItems():
            if isinstance(s, SlotRectItem):
                self.slot_selected.emit(s.row_index())
                return
        self.slot_selected.emit(-1)

    def set_selected_row(self, row: int) -> None:
        self._silent_select = True
        try:
            self._scene.clearSelection()
            if 0 <= row < len(self._items):
                self._items[row].setSelected(True)
        finally:
            self._silent_select = False

    # ── 几何回写 ───────────────────────────────────────────────────────
    def _on_slot_geometry_changed(self, row: int, x: float, y: float, w: float, h: float) -> None:
        if self._suppress_emit:
            return
        self.slot_geometry_changed.emit(
            row,
            int(round(x)),
            int(round(y)),
            int(round(w)),
            int(round(h)),
        )

    def update_slot_rect(self, row: int, slot: dict) -> None:
        """属性面板（spinbox / 可选勾选）改了某槽 → 同步矩形，不触发回写。"""
        if not (0 <= row < len(self._items)):
            return
        self._suppress_emit = True
        try:
            self._items[row].update_from_slot(slot)
        finally:
            self._suppress_emit = False

    # ── 重建 ───────────────────────────────────────────────────────────
    def refresh(
        self,
        *,
        slots: list[dict],
        background_image: str,
        selected_row: int,
    ) -> None:
        bw, bh = _slots_bounds(slots if isinstance(slots, list) else [])
        self._scene.setSceneRect(QRectF(0, 0, float(bw), float(bh)))

        pm = _load_runtime_pixmap(self._model, background_image)
        self._scene.set_backdrop(pm)

        for it in self._items:
            self._scene.removeItem(it)
        self._items.clear()

        for i, slot in enumerate(slots if isinstance(slots, list) else []):
            if not isinstance(slot, dict):
                continue
            item = SlotRectItem(i, slot, self)
            self._scene.addItem(item)
            self._items.append(item)

        self._silent_select = True
        try:
            self._scene.clearSelection()
            if 0 <= selected_row < len(self._items):
                self._items[selected_row].setSelected(True)
        finally:
            self._silent_select = False
        self._fit_view()
