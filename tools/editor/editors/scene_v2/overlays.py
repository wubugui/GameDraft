"""覆盖物：分组框、透视深度轴、橡皮筋。

全部继承 `items.OverlayItem` —— 恒在最上，且**永不进命中白名单**。
它们的命中由各自的工具用显式几何判定（`hit_*` 方法），不靠 Qt 按 z 派发。
这是老画布"组框/gizmo 与实体互相抢点击"那一族的结构性解法。
"""
from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QBrush, QColor, QPen

from .items import OverlayItem

__all__ = ["GroupBoxItem", "PerspectiveAxisItem", "RubberBandItem",
           "ScaleReferenceItem", "TransformGizmoItem"]

_GROUP_PEN = QPen(QColor(120, 200, 255, 220), 0, Qt.PenStyle.DashLine)
_GROUP_SEL_PEN = QPen(QColor(255, 236, 120), 0, Qt.PenStyle.DashLine)
_AXIS_PEN = QPen(QColor(255, 170, 60, 230), 0)
_AXIS_MID_PEN = QPen(QColor(255, 210, 140, 170), 0, Qt.PenStyle.DashLine)
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
        self._anchor: QPointF | None = None

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
        if self._anchor is not None:
            # 作者自己摆过把手（`editor.anchor`）就用它。派生位置会压住成员时，
            # 这是唯一的救济手段 —— 老画布注释里写明那个位置是为了躲开成员密集区
            # 才反复调过三轮的。
            return QPointF(self._anchor)
        if self._rect.isNull():
            return QPointF()
        r = HANDLE_PICK_PX / self._scale
        return QPointF(self._rect.left() + r, self._rect.top() - r * 1.6)

    def set_anchor(self, anchor: QPointF | None) -> None:
        """自定义把手位置；`None` = 回到派生位置。"""
        self.prepareGeometryChange()
        self._anchor = QPointF(anchor) if anchor is not None else None
        self.update()

    @property
    def has_custom_anchor(self) -> bool:
        return self._anchor is not None

    def boundingRect(self) -> QRectF:
        if self._anchor is not None:
            r = HANDLE_PICK_PX / self._scale
            handle = QRectF(self._anchor.x() - r * 2, self._anchor.y() - r * 2,
                            r * 4, r * 4)
            if self._rect.isNull():
                return handle
            return self._rect.adjusted(-r * 2, -r * 3, r * 2, r * 2).united(handle)
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
        # **标题**：多组场景里没有它就只剩几个一模一样的虚线框，分不出谁是谁，
        # 也看不到成员数。字号按屏幕像素恒定（除以缩放），缩小视图后不会糊成一团。
        if self._title:
            painter.setPen(_GROUP_SEL_PEN if self._selected else _GROUP_PEN)
            font = painter.font()
            font.setPointSizeF(max(1e-3, 9.0 / self._scale))
            painter.setFont(font)
            painter.drawText(
                QPointF(self._rect.left(), self._rect.top() - 4.0 / self._scale),
                self._title)

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
        self._near_scale: float | None = None
        self._far_scale: float | None = None
        self._mid_stops: list = []

    def set_view_scale(self, scale: float) -> None:
        s = float(scale) if scale and scale > 1e-9 else 1e-9
        if s != self._scale:
            self.prepareGeometryChange()
            self._scale = s
            self.update()

    def set_axis(self, near: QPointF | None, far: QPointF | None,
                 near_scale: float | None = None,
                 far_scale: float | None = None,
                 mid_stops: list | None = None) -> None:
        self.prepareGeometryChange()
        self._active = near is not None and far is not None
        self._near = QPointF(near) if near is not None else QPointF()
        self._far = QPointF(far) if far is not None else QPointF()
        self._near_scale = near_scale
        self._far_scale = far_scale
        self._mid_stops = list(mid_stops or [])
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
        # **指向远端的箭头**：轴是有方向的（近 → 远），没有箭头时两个端点长得
        # 一样，调轴时得回面板对着数字才知道哪头是远。
        self._draw_arrow(painter)
        painter.setPen(_AXIS_PEN)
        painter.setBrush(QBrush(QColor(255, 210, 120)))
        painter.drawEllipse(self._near, r, r)
        painter.setBrush(QBrush(QColor(120, 170, 255)))
        painter.drawEllipse(self._far, r, r)
        # **近/远端缩放读数 + 中途点等值线**：调透视轴时的现场读数。
        # 缺了它们，"近远端缩放到底是多少、中途点卡在轴的哪个位置"全得回面板
        # 对着数字猜。
        self._draw_readouts(painter, r)

    def _draw_arrow(self, painter) -> None:
        import math

        dx = self._far.x() - self._near.x()
        dy = self._far.y() - self._near.y()
        length = math.hypot(dx, dy)
        if length <= 1e-6:
            return
        ux, uy = dx / length, dy / length
        size = min(self._r() * 1.6, length * 0.2)
        tipx, tipy = self._far.x(), self._far.y()
        for sign in (1, -1):
            painter.drawLine(
                QPointF(tipx, tipy),
                QPointF(tipx - ux * size + sign * uy * size * 0.5,
                        tipy - uy * size - sign * ux * size * 0.5))

    def _draw_readouts(self, painter, r: float) -> None:
        import math

        font = painter.font()
        font.setPointSizeF(max(1e-3, 8.0 / self._scale))
        painter.setFont(font)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        gap = r + 4.0 / self._scale
        if self._near_scale is not None:
            painter.drawText(
                QPointF(self._near.x() + gap, self._near.y()),
                f"近 ×{float(self._near_scale):g}")
        if self._far_scale is not None:
            painter.drawText(
                QPointF(self._far.x() + gap, self._far.y()),
                f"远 ×{float(self._far_scale):g}")
        dx = self._far.x() - self._near.x()
        dy = self._far.y() - self._near.y()
        length = math.hypot(dx, dy)
        if length <= 1e-6:
            return
        # 等值线垂直于轴：一眼看出中途点把轴切在哪
        nx, ny = -dy / length, dx / length
        half = min(length * 0.12, 60.0 / self._scale)
        painter.setPen(_AXIS_MID_PEN)
        for stop in self._mid_stops:
            try:
                pos = float(stop.get("pos"))
                sc = float(stop.get("scale"))
            except (TypeError, ValueError, AttributeError):
                continue
            if not (0.0 < pos < 1.0):
                continue
            cx = self._near.x() + dx * pos
            cy = self._near.y() + dy * pos
            painter.drawLine(QPointF(cx - nx * half, cy - ny * half),
                             QPointF(cx + nx * half, cy + ny * half))
            painter.drawText(QPointF(cx + nx * half, cy + ny * half), f"×{sc:g}")

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


class TransformGizmoItem(OverlayItem):
    """缩放 / 旋转的手柄图形。

    位置**不自己算** —— 由 `TransformTool.gizmo_positions()` 给，工具照同一个
    函数判命中。两边各算一遍是"看着在这、点着在那"的标准做法，本仓已经栽过。

    手柄尺寸按**屏幕像素**恒定：缩小视图后仍抓得住。
    """

    #: 手柄绘制半径（屏幕像素）
    HANDLE_R_PX = 7.0

    def __init__(self) -> None:
        super().__init__()
        self._pos: dict[str, QPointF] = {}
        self._scale = 1.0
        self.setVisible(False)

    def set_view_scale(self, scale: float) -> None:
        s = float(scale) if scale and scale > 1e-9 else 1e-9
        if s != self._scale:
            self.prepareGeometryChange()
            self._scale = s
            self.update()

    def set_positions(self, positions: dict | None) -> None:
        self.prepareGeometryChange()
        self._pos = dict(positions or {})
        self.setVisible(bool(self._pos.get("anchor")))
        self.update()

    def _r_world(self) -> float:
        return self.HANDLE_R_PX / self._scale

    def boundingRect(self) -> QRectF:
        pts = [p for p in self._pos.values() if isinstance(p, QPointF)]
        if not pts:
            return QRectF()
        xs = [p.x() for p in pts]
        ys = [p.y() for p in pts]
        pad = self._r_world() + 2.0
        return QRectF(min(xs) - pad, min(ys) - pad,
                      max(xs) - min(xs) + pad * 2, max(ys) - min(ys) + pad * 2)

    def paint(self, painter, option, widget=None) -> None:
        anchor = self._pos.get("anchor")
        if not isinstance(anchor, QPointF):
            return
        painter.setRenderHint(painter.RenderHint.Antialiasing, True)
        r = self._r_world()
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.setPen(_GIZMO_LINE_PEN)
        for key in ("rotate", "scale"):
            p = self._pos.get(key)
            if isinstance(p, QPointF):
                painter.drawLine(anchor, p)
        rot = self._pos.get("rotate")
        if isinstance(rot, QPointF):
            painter.setPen(_GIZMO_PEN)
            painter.setBrush(QBrush(_GIZMO_ROTATE_FILL))
            painter.drawEllipse(rot, r, r)
        sca = self._pos.get("scale")
        if isinstance(sca, QPointF):
            painter.setPen(_GIZMO_PEN)
            painter.setBrush(QBrush(_GIZMO_SCALE_FILL))
            painter.drawRect(QRectF(sca.x() - r, sca.y() - r, r * 2.0, r * 2.0))


_GIZMO_PEN = QPen(QColor(30, 30, 30, 220), 0)
_GIZMO_LINE_PEN = QPen(QColor(255, 236, 120, 200), 0, Qt.PenStyle.DashLine)
_GIZMO_ROTATE_FILL = QColor(120, 220, 255, 235)
_GIZMO_SCALE_FILL = QColor(255, 236, 120, 235)


class ScaleReferenceItem(OverlayItem):
    """NPC 比例参考框：画布上唯一的**世界单位实物比例尺**。

    给新场景定 `worldWidth/worldHeight`、或判断某个热点交互半径"按人身高算大概
    多少"时，没有它就只能靠数字盲估。老画布默认在世界左上/右下各画一个与角色
    动画的 worldWidth×worldHeight 同尺寸的框。
    """

    def __init__(self) -> None:
        super().__init__()
        self._rects: list[QRectF] = []
        self._label = ""
        self._scale = 1.0
        self.setVisible(False)

    def set_view_scale(self, scale: float) -> None:
        s = float(scale) if scale and scale > 1e-9 else 1e-9
        if s != self._scale:
            self.prepareGeometryChange()
            self._scale = s
            self.update()

    def set_reference(self, world_w: float, world_h: float,
                      scene_w: float, scene_h: float, label: str = "") -> None:
        self.prepareGeometryChange()
        w = float(world_w or 0)
        h = float(world_h or 0)
        self._label = str(label or "")
        if w <= 0 or h <= 0 or scene_w <= 0 or scene_h <= 0:
            self._rects = []
        else:
            pad = 20.0
            self._rects = [
                QRectF(pad, pad, w, h),
                QRectF(scene_w - pad - w, scene_h - pad - h, w, h),
            ]
        self.setVisible(bool(self._rects) and self.isVisible())
        self.update()

    def boundingRect(self) -> QRectF:
        if not self._rects:
            return QRectF()
        out = QRectF(self._rects[0])
        for r in self._rects[1:]:
            out = out.united(r)
        return out.adjusted(-4, -20, 4, 4)

    def paint(self, painter, option, widget=None) -> None:
        if not self._rects:
            return
        painter.setPen(_SCALE_REF_PEN)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        for r in self._rects:
            painter.drawRect(r)
        if self._label:
            font = painter.font()
            font.setPointSizeF(max(1e-3, 8.0 / self._scale))
            painter.setFont(font)
            top = self._rects[0]
            painter.drawText(
                QPointF(top.left(), top.top() - 3.0 / self._scale), self._label)


_SCALE_REF_PEN = QPen(QColor(160, 255, 200, 170), 0, Qt.PenStyle.DotLine)
