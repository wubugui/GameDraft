"""扎纸（paper_craft）槽位可视化画布：在固定尺寸工作台上拖拽 / 缩放槽位矩形。

设计对齐 ``water_minigame_canvas.py``：一个 QGraphicsView 背景 + 每槽一个可拖动 item，
item 几何变化 → 回写模型。本画布只提供「看与改 x/y/width/height」的视图能力，
不改 slots 数组的字段形态或读写映射——未被拖动的槽位导出 JSON 逐字节保持不变。

坐标系（对齐运行时 ``src/systems/paperCraft/PaperCraftMinigameScene.ts``）：
运行时把 slots 全部画在一块 **固定 560×410 的工作台面板**（``drawPanelBase(table,
0,0,560,410)``）内；slot.x/y/width/height 就是相对这块面板左上角的像素坐标。面板
**顶部约 80px** 被订单标题（y=12, 字号 20）与描述（y=43, 自动换行）占用，是槽位应
避让的保留区。故本画布 sceneRect 固定为 560×410，画出工作台框线 + 顶部保留区提示，
而不再按"槽位外接框 +24"定尺寸（那会随槽位分布漂移，且把边界画在不存在的地方）。

底图语义（对齐运行时）：``instance.backgroundImage`` 在运行时是 **整屏 cover 的半透明
装饰**（``alpha 0.35``，按屏幕尺寸缩放居中，**不**与工作台对齐），并非槽位定位参照。
故本画布把它作为 cover（等比铺满、可溢出裁切）低透明度垫在工作台下作氛围，
绝不 IgnoreAspectRatio 拉伸铺满以暗示"照底图摆槽位即对齐"（审查 P2）。缺省时用中性
底色 + 网格，且不向 JSON 写入该字段。

槽位拖拽范围放宽到整块工作台（可拖出当前所有槽位的外接框），仅夹在 560×410 工作台内；
越界的既有坐标（模型真值）在载入时不被静默夹紧，只有用户拖拽才夹。回写按
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


# 运行时工作台面板尺寸（PaperCraftMinigameScene: drawPanelBase(table,0,0,560,410)）。
# slot.x/y/width/height 即相对这块面板的坐标；画布 sceneRect 固定为此。
_WORKBENCH_W = 560
_WORKBENCH_H = 410
# 面板顶部标题+描述占用的保留区高度（运行时 title y=12 / desc y=43+ 自动换行）。
_TOP_RESERVE = 80
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
        self._syncing = True  # 程序性初始摆位不夹紧、不回写（越界坐标是模型真值）

        self.setPos(QPointF(x, y))
        self._syncing = False
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
            # 运行时底图是整屏 cover 装饰、不与工作台对齐：这里按 cover（等比铺满、
            # 可溢出裁切）居中垫在工作台下作氛围，绝不 IgnoreAspectRatio 拉伸铺满
            # 以暗示"照底图摆槽位即对齐"（审查 P2）。低透明度弱化，不喧宾夺主。
            scaled = pm.scaled(
                max(1, int(r.width())),
                max(1, int(r.height())),
                Qt.AspectRatioMode.KeepAspectRatioByExpanding,
                Qt.TransformationMode.SmoothTransformation,
            )
            self._texture_item = QGraphicsPixmapItem(scaled)
            # 居中裁切：溢出部分对称落在工作台外，中心区域对齐工作台中心。
            self._texture_item.setOffset(
                (r.width() - scaled.width()) / 2.0,
                (r.height() - scaled.height()) / 2.0,
            )
            self._texture_item.setPos(r.left(), r.top())
            self._texture_item.setZValue(-1e9)
            self._texture_item.setOpacity(0.3)  # 对齐运行时 alpha 0.35 的弱化装饰语义
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
        # 工作台外框（560×410 面板边界）。
        painter.setPen(QPen(QColor(124, 95, 58), 1))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRect(r)
        # 顶部保留区（订单标题+描述占用，槽位应避让）：半透明填充 + 分隔虚线 + 文字提示。
        reserve_h = min(float(_TOP_RESERVE), r.height())
        reserve = QRectF(r.left(), r.top(), r.width(), reserve_h)
        painter.fillRect(reserve, QColor(124, 95, 58, 40))
        painter.setPen(QPen(QColor(160, 128, 86, 180), 1, Qt.PenStyle.DashLine))
        painter.drawLine(
            QPointF(r.left(), r.top() + reserve_h),
            QPointF(r.right(), r.top() + reserve_h),
        )
        painter.setPen(QPen(QColor(200, 170, 120)))
        painter.drawText(
            reserve.adjusted(6, 4, -6, -4),
            int(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft),
            "标题 / 描述保留区（运行时约 80px，槽位请避让）",
        )


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
        # 固定工作台坐标系（对齐运行时 560×410 面板），不再随槽位外接框漂移。
        self._scene.setSceneRect(QRectF(0, 0, float(_WORKBENCH_W), float(_WORKBENCH_H)))

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
