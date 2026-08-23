"""具体图元 —— 每种实体在画布上长什么样。

全部继承 `items.EntityItem`（不吃鼠标）。**它们只负责画**：几何从 Document 现取，
命中由工具决定。所以这里没有一行 `mousePressEvent`。
"""
from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QBrush, QColor, QPen, QPolygonF

from .changes import EntityRef
from ...shared.light_env_visual import light_env_visual
from .items import EntityItem
from .renderer import point_in_polygon, point_segment_distance_sq

__all__ = [
    "HANDLE_R_PX",
    "HOTSPOT_TYPE_COLORS",
    "ZONE_COLOR_DEPTH_FLOOR",
    "entity_canvas_color",
    "CollisionGhostItem",
    "LightCurveItem",
    "KIND_COLORS",
    "HandleItem",
    "PolygonItem",
    "PolylineItem",
]

#: 把手绘制半径（屏幕像素）。绘制与命中都按屏幕像素 —— 两者用同一口径，
#: 免得出现"看着能点、实际点不中"（老画布顶点就是这么点不中的）。
HANDLE_R_PX = 7.0

#: 各实体族的颜色。与老画布保持一致，免得策划换页要重新认颜色。
KIND_COLORS = {
    "hotspot": QColor(60, 140, 255, 190),
    "npc": QColor(180, 80, 220, 200),
    "zone": QColor(255, 200, 0, 90),
    "spawn": QColor(255, 255, 255, 215),
}

#: 热点**按 type 分色**（与老画布同一份取值）。六类长得一模一样时策划一眼分不出
#: "这是传送点还是可查看点还是遭遇点"，改错对象的概率明显上升。
HOTSPOT_TYPE_COLORS = {
    "inspect": QColor(60, 140, 255, 190),
    "act_spot": QColor(190, 120, 255, 190),
    "pickup": QColor(60, 200, 80, 190),
    "transition": QColor(255, 160, 40, 190),
    "npc": QColor(200, 100, 255, 190),
    "encounter": QColor(255, 60, 60, 190),
}

#: 深度地面与普通触发区必须分色：前者决定角色踩地深度（改错直接影响遮挡与缩放），
#: 两者叠在一起时同色更容易拖错、删错。
ZONE_COLOR_DEPTH_FLOOR = QColor(80, 160, 255, 90)


def entity_canvas_color(kind: str, ent: dict | None) -> QColor:
    """实体在画布上的颜色 —— 与老画布同口径的唯一出口。"""
    d = ent if isinstance(ent, dict) else {}
    if kind == "hotspot":
        return HOTSPOT_TYPE_COLORS.get(
            str(d.get("type", "") or ""), KIND_COLORS["hotspot"])
    if kind == "zone" and d.get("zoneKind") == "depth_floor":
        return ZONE_COLOR_DEPTH_FLOOR
    return KIND_COLORS.get(kind, QColor(200, 200, 200, 200))
_SELECTED_PEN = QPen(QColor(255, 236, 120), 0)
_HOVER_PEN = QPen(QColor(255, 255, 255, 200), 0)


class _StateMixin:
    """选中/悬停态。由视图按 Document 的选择集刷，不是图元自己维护。"""

    def __init__(self, *a, **kw) -> None:
        super().__init__(*a, **kw)
        self._selected = False
        self._hovered = False

    def set_selected(self, on: bool) -> None:
        if self._selected != bool(on):
            self._selected = bool(on)
            self.update()

    def set_hovered(self, on: bool) -> None:
        if self._hovered != bool(on):
            self._hovered = bool(on)
            self.update()


class HandleItem(_StateMixin, EntityItem):
    """锚点把手（hotspot / npc / spawn 共用）。

    半径按**屏幕像素**恒定：用 `ItemIgnoresTransformations` 让子坐标系不跟着缩放，
    于是缩小视图后把手不会缩成一个点。老画布的把手是世界单位，缩到 0.2 倍就没了。
    """

    def __init__(self, ref: EntityRef, color: QColor | None = None) -> None:
        super().__init__(ref)
        self._color = color or KIND_COLORS.get(ref.kind, QColor(200, 200, 200, 200))
        self._radius_px = HANDLE_R_PX
        self._label = ""
        self._range_world = 0.0
        self._scale = 1.0
        self.setFlag(
            EntityItem.GraphicsItemFlag.ItemIgnoresTransformations, True)

    def set_view_scale(self, scale: float) -> None:
        """交互半径圈画在世界坐标里，需要知道缩放才能换算成本地像素。"""
        s = float(scale) if scale and scale > 1e-9 else 1e-9
        if s != self._scale:
            self.prepareGeometryChange()
            self._scale = s
            self.update()

    def set_interaction_range(self, world_radius: float) -> None:
        r = max(0.0, float(world_radius or 0.0))
        if r != self._range_world:
            self.prepareGeometryChange()
            self._range_world = r
            self.update()

    def _range_px(self) -> float:
        return self._range_world * self._scale

    def boundingRect(self) -> QRectF:
        r = max(self._radius_px, self._range_px()) + 2.0
        rect = QRectF(-r, -r, r * 2.0, r * 2.0)
        if self._label:
            # 给标签留位置，否则文字会被裁掉一截
            rect = rect.united(QRectF(r, -r - 14.0, 8.0 * len(self._label) + 8.0, 16.0))
        return rect

    def set_color(self, color: QColor) -> None:
        if color != self._color:
            self._color = color
            self.update()

    def set_label(self, text: str) -> None:
        """把手旁边的实体名。

        没有它，"这个圆点是哪个热点""把玩家送到哪个出生点"这类日常判断只能回
        左边实体树逐个点选比对；老画布是抬眼就能读。
        """
        text = str(text or "")
        if text != self._label:
            self.prepareGeometryChange()
            self._label = text
            self.update()

    def paint(self, painter, option, widget=None) -> None:
        painter.setRenderHint(painter.RenderHint.Antialiasing, True)
        rp = self._range_px()
        if rp > self._radius_px:
            painter.setPen(QPen(QColor(255, 255, 255, 60), 0, Qt.PenStyle.DotLine))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawEllipse(QPointF(0, 0), rp, rp)
        painter.setBrush(QBrush(self._color))
        if self._selected:
            painter.setPen(_SELECTED_PEN)
        elif self._hovered:
            painter.setPen(_HOVER_PEN)
        else:
            painter.setPen(QPen(self._color.darker(150), 0))
        r = self._radius_px
        painter.drawEllipse(QPointF(0, 0), r, r)
        if self._label:
            # 本图元是 `ItemIgnoresTransformations`，所以这里的单位就是屏幕像素：
            # 字号天然恒定，缩小视图后不会糊成一团。
            painter.setPen(QPen(QColor(235, 235, 235, 230), 0))
            painter.drawText(QPointF(r + 3.0, -r - 2.0), self._label)

    def pick_rect(self) -> QRectF:
        """把手的命中范围只算圆点本身，**不含交互半径圈** ——
        那个圈动辄上百世界单位，算进去会把下方的一切都吞掉。"""
        r = self._radius_px / self._scale
        return QRectF(self.pos().x() - r, self.pos().y() - r, r * 2.0, r * 2.0)


class _PointsItem(_StateMixin, EntityItem):
    """折线/多边形的公共部分：点列 + 顶点手柄绘制。"""

    def __init__(self, ref: EntityRef, color: QColor, *, closed: bool) -> None:
        super().__init__(ref)
        self._pts: list[tuple[float, float]] = []
        self._color = color
        self._closed = closed
        self._scale = 1.0
        self._active_vertex: int | None = None
        #: 恒显顶点手柄（供选不中的点列用，见 `paint`）
        self.always_show_vertices = False

    @property
    def closed(self) -> bool:
        return self._closed

    def points(self) -> list[tuple[float, float]]:
        return list(self._pts)

    def set_points(self, pts) -> None:
        new = [(float(p["x"]), float(p["y"])) if isinstance(p, dict)
               else (float(p[0]), float(p[1])) for p in pts or []]
        if new != self._pts:
            self.prepareGeometryChange()
            self._pts = new
            self.update()

    def set_view_scale(self, scale: float) -> None:
        s = float(scale) if scale and scale > 1e-9 else 1e-9
        if s != self._scale:
            self.prepareGeometryChange()
            self._scale = s
            self.update()

    def set_active_vertex(self, index: int | None) -> None:
        if index != self._active_vertex:
            self._active_vertex = index
            self.update()

    def _handle_r_world(self) -> float:
        return HANDLE_R_PX / self._scale

    def boundingRect(self) -> QRectF:
        if not self._pts:
            return QRectF()
        xs = [p[0] for p in self._pts]
        ys = [p[1] for p in self._pts]
        pad = self._handle_r_world() + 2.0
        return QRectF(min(xs) - pad, min(ys) - pad,
                      max(xs) - min(xs) + pad * 2, max(ys) - min(ys) + pad * 2)

    def pick_contains(self, pos, tol: float = 0.0) -> bool:
        """按**真实形状**判定命中：顶点圈 → 边线带 → （闭合时）形内。

        缺省实现拿 AABB 比，对三角形/凹多边形/折线的误差见
        `EntityItem.pick_contains` 的说明。
        """
        pts = self._pts
        if not pts:
            return False
        px, py = pos.x(), pos.y()
        r = max(self._handle_r_world(), float(tol))
        r2 = r * r
        for x, y in pts:
            dx = x - px
            dy = y - py
            if dx * dx + dy * dy <= r2:
                return True
        n = len(pts)
        closed = self._closed and n >= 3
        span = n if closed else n - 1
        for i in range(max(0, span)):
            ax, ay = pts[i]
            bx, by = pts[(i + 1) % n]
            if point_segment_distance_sq(px, py, ax, ay, bx, by) <= r2:
                return True
        return closed and point_in_polygon(px, py, pts)

    def paint(self, painter, option, widget=None) -> None:
        if not self._pts:
            return
        painter.setRenderHint(painter.RenderHint.Antialiasing, True)
        poly = QPolygonF([QPointF(x, y) for x, y in self._pts])
        pen = _SELECTED_PEN if self._selected else QPen(self._color.darker(140), 0)
        painter.setPen(pen)
        if self._closed and len(self._pts) >= 3:
            painter.setBrush(QBrush(self._color))
            painter.drawPolygon(poly)
        else:
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawPolyline(poly)
        # 顶点手柄：缺省只在选中时画，免得满屏都是点。
        # `always_show_vertices` 是给**没有选中概念**的点列开的口子 ——
        # 场景级光环境曲线不属于任何实体、选不中，可它的控制点又永远可拖：
        # 看不见却拖得动是最坏的组合（想编的找不到点、不想编的会误拖误删，
        # 而删一个看不见的控制点还会连带把它那一帧光带走）。
        if not self._selected and not self.always_show_vertices:
            return
        r = self._handle_r_world()
        for i, (x, y) in enumerate(self._pts):
            painter.setBrush(QBrush(
                QColor(255, 236, 120) if i == self._active_vertex
                else QColor(255, 255, 255, 220)))
            painter.setPen(QPen(QColor(40, 40, 40), 0))
            painter.drawEllipse(QPointF(x, y), r, r)


class PolygonItem(_PointsItem):
    """闭合多边形：Zone、碰撞面。"""

    def __init__(self, ref: EntityRef, color: QColor | None = None) -> None:
        super().__init__(ref, color or KIND_COLORS.get(ref.kind, QColor(255, 200, 0, 90)),
                         closed=True)

    def set_color(self, color: QColor) -> None:
        if color != self._color:
            self._color = color
            self.update()


class CollisionGhostItem(_PointsItem):
    """**运行时真正生效的**命中面轮廓（只读虚线）。

    参与透视缩放的实体上，作者画的多边形与游戏里真能点到的范围差一个透视系数
    （远端可差一半）。老画布同时画 authored（可编辑实线）+ ghost（只读虚线）
    两套，明确告诉你"真正生效的是这一圈"；新画布起初只有前一套 —— 策划照着画的
    命中面在游戏里点不到，而画布上没有任何提示。

    它**不进命中白名单**（`pick_contains` 恒 False）：只读的东西不该抢点击。
    """

    def __init__(self, ref: EntityRef, color: QColor | None = None) -> None:
        super().__init__(ref, color or QColor(255, 120, 60, 200), closed=True)

    def pick_contains(self, pos, tol: float = 0.0) -> bool:
        return False

    def paint(self, painter, option, widget=None) -> None:
        if len(self._pts) < 3:
            return
        painter.setRenderHint(painter.RenderHint.Antialiasing, True)
        painter.setPen(QPen(self._color, 0, Qt.PenStyle.DashLine))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawPolygon(QPolygonF([QPointF(x, y) for x, y in self._pts]))


class PolylineItem(_PointsItem):
    """开放折线：巡逻路线、光环境曲线。**不是闭合的** —— 闭合边不存在，
    所以双击最后一点与第一点之间的空白不该插点。"""

    def __init__(self, ref: EntityRef, color: QColor | None = None) -> None:
        super().__init__(ref, color or QColor(0, 200, 220, 220), closed=False)


class LightCurveItem(PolylineItem):
    """光环境曲线：折线 + **每个控制点的一套光照可视化**。

    只画一条青线的话，"这一段的光从哪来、影子多长多黑"这层信息整个丢了 ——
    而那正是光曲线在画布上存在的意义；作者只能盯右侧表格里的数字反推。

    解析走 `shared/light_env_visual`（与老画布同一份），两个画布不会画出两种光。
    """

    def __init__(self, ref: EntityRef, color: QColor | None = None) -> None:
        super().__init__(ref, color or QColor(0, 200, 220, 220))
        self.always_show_vertices = True
        self._envs: list = []
        self._ref_width = 100.0

    def set_envs(self, envs) -> None:
        self._envs = list(envs or [])
        self.update()

    def set_reference_width(self, width: float) -> None:
        w = float(width or 0)
        if w > 0 and w != self._ref_width:
            self._ref_width = w
            self.update()

    def paint(self, painter, option, widget=None) -> None:
        super().paint(painter, option, widget)
        if not self._pts or not self._envs:
            return
        painter.setRenderHint(painter.RenderHint.Antialiasing, True)
        r = self._handle_r_world()
        for i, (px, py) in enumerate(self._pts):
            if i >= len(self._envs):
                break
            vis = light_env_visual(self._envs[i])
            # 接触阴影：脚下椭圆，半轴与 EntityShadow 同公式
            if vis.contact_size > 0 and vis.contact > 0:
                painter.setBrush(QBrush(QColor(0, 0, 0,
                                               int(18 + 70 * vis.contact))))
                painter.setPen(QPen(QColor(20, 24, 32, 200), 0,
                                    Qt.PenStyle.DashLine))
                painter.drawEllipse(
                    QPointF(px, py),
                    self._ref_width * 0.65 * vis.contact_size,
                    self._ref_width * 0.30 * vis.contact_size)
            # 影迹：沿光来向的**反方向**，长度随仰角、暗度随 darkness
            trail = r * (2.4 + 2.2 * vis.shadow_len)
            pen = QPen(QColor(8, 8, 14, int(70 + 150 * vis.darkness)), 0)
            pen.setCapStyle(Qt.PenCapStyle.RoundCap)
            painter.setPen(pen)
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawLine(QPointF(px, py),
                             QPointF(px - vis.dir_x * trail,
                                     py - vis.dir_y * trail))
            # 主光来向箭头：颜色 = 主光色，强度 → 不透明度
            arrow = r * (2.6 + 1.4 * vis.shadow_len)
            kc = QColor(*vis.key_rgb)
            kc.setAlpha(int(max(70, min(255, 110 + 80 * min(vis.intensity, 2.0)))))
            painter.setPen(QPen(kc, 0))
            painter.drawLine(QPointF(px + vis.dir_x * arrow,
                                     py + vis.dir_y * arrow),
                             QPointF(px, py))
            # 环境光色环
            painter.setPen(QPen(QColor(*vis.ambient_rgb, 200), 0))
            painter.setBrush(Qt.BrushStyle.NoBrush)
            painter.drawEllipse(QPointF(px, py), r * 1.5, r * 1.5)
