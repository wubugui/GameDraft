"""覆盖物：分组框、透视深度轴、橡皮筋。

全部继承 `items.OverlayItem` —— 恒在最上，且**永不进命中白名单**。
它们的命中由各自的工具用显式几何判定（`hit_*` 方法），不靠 Qt 按 z 派发。
这是老画布"组框/gizmo 与实体互相抢点击"那一族的结构性解法。
"""
from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QBrush, QColor, QPen

from .items import OverlayItem

__all__ = ["GroupBoxItem", "PerspectiveAxisItem", "RubberBandItem"]

_GROUP_PEN = QPen(QColor(120, 200, 255, 220), 0, Qt.PenStyle.DashLine)
_GROUP_SEL_PEN = QPen(QColor(255, 236, 120), 0, Qt.PenStyle.DashLine)
_AXIS_PEN = QPen(QColor(255, 170, 60, 230), 0)
_BAND_PEN = QPen(QColor(255, 255, 255, 200), 0, Qt.PenStyle.DashLine)
_BAND_FILL = QColor(255, 255, 255, 30)

#: 边线/把手的命中带宽（屏幕像素）。与 renderer 的口径一致：命中一律按屏幕像素。
EDGE_PICK_PX = 9.0
HANDLE_PICK_PX = 11.0


class GroupBoxItem(OverlayItem):
    """分组框：成员包围盒 + 一个把手。

    **不进 Qt 选择系统**（继承自 OverlayItem 已经不可选），选中态由宿主显式驱动。
    老画布的类注释用六条编号解释过为什么 —— 其中最要紧的是：进了选择系统之后，
    橡皮筋框选和批量删除会把"组"当成实体删掉，而组框的语义是"不管成员显隐，框都在"。
    """

    def __init__(self, gid: str) -> None:
        super().__init__()
        self._gid = str(gid)
        self._rect = QRectF()
        self._title = self._gid
        self._selected = False
        self._scale = 1.0

    @property
    def gid(self) -> str:
        return self._gid

    def set_view_scale(self, scale: float) -> None:
        s = float(scale) if scale and scale > 1e-9 else 1e-9
        if s != self._scale:
            self.prepareGeometryChange()
            self._scale = s
            self.update()

    def set_geometry(self, rect: QRectF | None, title: str) -> None:
        self.prepareGeometryChange()
        self._rect = QRectF(rect) if rect is not None else QRectF()
        self._title = title
        self.update()

    def set_selected(self, on: bool) -> None:
        if self._selected != bool(on):
            self._selected = bool(on)
            self.update()

    def _pad(self) -> float:
        """边线命中带的世界半宽，**上限是框短边的四分之一**。

        缩到极远时 `屏幕像素 / scale` 会算出一个荒唐的世界宽度（实测 0.04 倍下
        9px → 225 世界单位），命中带把整个框连同周围一大片全吞掉。
        手柄/命中带永远不该吞掉超过它所依附之物的一小部分。
        """
        raw = EDGE_PICK_PX / self._scale
        if self._rect.isNull():
            return raw
        shortest = min(self._rect.width(), self._rect.height())
        if shortest <= 0:
            return raw
        return min(raw, shortest / 4.0)

    def handle_center(self) -> QPointF:
        """把手在框**上边线正上方**的左端 —— 那儿是框外空白。

        老画布试过三个位置才收敛到这儿，死法记在它的注释里：框心会把成员挡死、
        左上角斜外侧会盖住相邻组的框角、框内左上角在缩小的视图里会挡住本组成员。
        """
        if self._rect.isNull():
            return QPointF()
        r = HANDLE_PICK_PX / self._scale
        return QPointF(self._rect.left() + r, self._rect.top() - r * 1.6)

    def boundingRect(self) -> QRectF:
        if self._rect.isNull():
            return QRectF()
        pad = self._pad() + HANDLE_PICK_PX / self._scale * 3.0
        return self._rect.adjusted(-pad, -pad, pad, pad)

    def paint(self, painter, option, widget=None) -> None:
        if self._rect.isNull():
            return
        painter.setRenderHint(painter.RenderHint.Antialiasing, True)
        painter.setPen(_GROUP_SEL_PEN if self._selected else _GROUP_PEN)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRect(self._rect)
        c = self.handle_center()
        r = HANDLE_PICK_PX / self._scale
        painter.setBrush(QBrush(QColor(255, 236, 120) if self._selected
                                else QColor(120, 200, 255, 200)))
        painter.drawEllipse(c, r, r)

    # ---- 命中（工具调，不靠 Qt 派发）--------------------------------------

    def hit_handle(self, at: QPointF) -> bool:
        if self._rect.isNull():
            return False
        r = HANDLE_PICK_PX / self._scale
        d = at - self.handle_center()
        return (d.x() * d.x() + d.y() * d.y()) <= r * r

    def hit_edge(self, at: QPointF) -> bool:
        """只有**边线带**算命中，框内空白穿透 —— 否则大框会把里面的一切都吞掉。"""
        if self._rect.isNull():
            return False
        pad = self._pad()
        outer = self._rect.adjusted(-pad, -pad, pad, pad)
        inner = self._rect.adjusted(pad, pad, -pad, -pad)
        return outer.contains(at) and not inner.contains(at)


class PerspectiveAxisItem(OverlayItem):
    """透视深度轴：near → far 的箭头与两个端点手柄。"""

    def __init__(self) -> None:
        super().__init__()
        self._near = QPointF()
        self._far = QPointF()
        self._active = False
        self._scale = 1.0

    def set_view_scale(self, scale: float) -> None:
        s = float(scale) if scale and scale > 1e-9 else 1e-9
        if s != self._scale:
            self.prepareGeometryChange()
            self._scale = s
            self.update()

    def set_axis(self, near: QPointF | None, far: QPointF | None) -> None:
        self.prepareGeometryChange()
        self._active = near is not None and far is not None
        self._near = QPointF(near) if near is not None else QPointF()
        self._far = QPointF(far) if far is not None else QPointF()
        self.setVisible(self._active)
        self.update()

    @property
    def near(self) -> QPointF:
        return QPointF(self._near)

    @property
    def far(self) -> QPointF:
        return QPointF(self._far)

    def _r(self) -> float:
        """端点手柄的世界半径，**上限是轴长的四分之一**。

        不封顶的话，缩到极远时两个端点的命中圈会重叠，轴线中段也算命中 ——
        一条横贯全场的线于是把下面的实体全挡住。
        """
        raw = HANDLE_PICK_PX / self._scale
        if not self._active:
            return raw
        d = self._far - self._near
        length = (d.x() ** 2 + d.y() ** 2) ** 0.5
        return min(raw, length / 4.0) if length > 0 else raw

    def boundingRect(self) -> QRectF:
        if not self._active:
            return QRectF()
        r = self._r() * 2
        return QRectF(self._near, self._far).normalized().adjusted(-r, -r, r, r)

    def paint(self, painter, option, widget=None) -> None:
        if not self._active:
            return
        painter.setRenderHint(painter.RenderHint.Antialiasing, True)
        painter.setPen(_AXIS_PEN)
        painter.drawLine(self._near, self._far)
        r = self._r()
        painter.setBrush(QBrush(QColor(255, 210, 120)))
        painter.drawEllipse(self._near, r, r)
        painter.setBrush(QBrush(QColor(120, 170, 255)))
        painter.drawEllipse(self._far, r, r)

    def hit_endpoint(self, at: QPointF) -> str | None:
        """命中哪个端点手柄。**只有端点吃鼠标**，轴线本身穿透 ——
        否则一条横贯全场的线会把下面的实体全挡住。"""
        if not self._active:
            return None
        r = self._r()
        r2 = r * r
        for name, p in (("near", self._near), ("far", self._far)):
            d = at - p
            if d.x() * d.x() + d.y() * d.y() <= r2:
                return name
        return None


class RubberBandItem(OverlayItem):
    """框选矩形。工具持手势状态，这里只负责画。"""

    def __init__(self) -> None:
        super().__init__()
        self._rect = QRectF()

    def set_rect(self, rect: QRectF | None) -> None:
        self.prepareGeometryChange()
        self._rect = QRectF(rect) if rect is not None else QRectF()
        self.setVisible(not self._rect.isNull())
        self.update()

    def boundingRect(self) -> QRectF:
        return self._rect.adjusted(-1, -1, 1, 1)

    def paint(self, painter, option, widget=None) -> None:
        if self._rect.isNull():
            return
        painter.setPen(_BAND_PEN)
        painter.setBrush(QBrush(_BAND_FILL))
        painter.drawRect(self._rect)
