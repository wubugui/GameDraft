"""挂件试挂预览：把挂件按某个挂点的逐帧标注摆到角色帧上，所见即游戏所得。

**为什么必须有这个东西**：支点（刀柄在贴图哪儿）、自转（图画歪了多少）、缩放
这三个数只能靠眼睛调——没有预览就只能"改数字 → 进游戏看 → 再改"，一轮几十秒。

**为什么它可信**：位姿走的是 `animation_sockets.socket_pose_to_local`，
与运行时 `socketPoseToLocal` 是同一套数学（parity 测试钉死黄金值）；
支点/自转/缩放的施加顺序照 `SpriteEntity.syncAttachments` 逐条对齐。
两边任一漂了，是 parity 测试红，不是这里悄悄画歪。

**缩放口径**（唯一需要换算的一处）：挂件是 `SpriteEntity.container` 的**兄弟**级子节点，
不继承 `sprite.scale`（世界尺寸/帧像素）。所以 `scale=1` 意味着"贴图 1 像素 = 1 世界单位"，
而且横竖**等比**。角色帧却是按 `worldWidth/cellWidth`、`worldHeight/cellHeight` **分轴**
拉伸的（两个比值不必相等，玩家包就差 8.6%）。画布上角色帧是按原图等比画的，
所以挂件要先在世界单位里摆好、再乘"世界 → 画布"那个**分轴**缩放——
只按 worldWidth 算一个倍率，纵向就会差出那个比值。见 `paint_prop`。
"""
from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QWidget

from .animation_sockets import socket_front_for_facing

CANVAS_W = 340
CANVAS_H = 400


def paint_prop(
    p: QPainter,
    prop: QPixmap,
    at: QPointF,
    *,
    pose_angle: float,
    facing: int,
    view_per_world: tuple[float, float],
    anchor: tuple[float, float],
    rotation: float,
    scale: float,
    outline_only: bool = False,
) -> None:
    """把挂件画到挂点上，变换顺序与 `SpriteEntity.syncAttachments` 逐条对齐。

    - ``at``：挂点在画布上的像素位置（已按朝向翻好）；
    - ``view_per_world``：世界单位 → 画布像素，**分轴**（见模块头「缩放口径」）；
    - 角度 = 挂点标注 + 挂件自转，朝左时**一起**取反；挂件图横向跟着朝向镜像；
    - 支点：贴图上的 (anchorX, anchorY) 对准挂点。
    - ``outline_only``：只描贴图外框（虚线）——挂件排在身后被身体整个挡住时，
      标注的人仍要看得出它在哪、多大、朝哪歪。

    Qt 与 Pixi 的正角都是屏幕顺时针（y 朝下），所以角度不用换号。
    """
    if prop is None or prop.isNull():
        return
    sx, sy = view_per_world
    if not (sx > 0 and sy > 0 and scale > 0):
        return
    sign = -1 if facing < 0 else 1
    w = float(prop.width())
    h = float(prop.height())
    rect = QRectF(-anchor[0] * w, -anchor[1] * h, w, h)
    p.save()
    p.translate(at)
    p.scale(sx, sy)
    p.rotate((pose_angle + rotation) * sign)
    p.scale(scale * sign, scale)
    if outline_only:
        pen = QPen(QColor(255, 196, 84, 220), 1.2, Qt.PenStyle.DashLine)
        pen.setCosmetic(True)
        p.setPen(pen)
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRect(rect)
    else:
        p.drawPixmap(rect, prop, QRectF(prop.rect()))
    p.restore()


class PropTryOnCanvas(QWidget):
    """只读预览：角色帧 + 按挂点位姿摆好的挂件 + 支点十字。"""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumSize(CANVAS_W, CANVAS_H)
        self._cell: QPixmap | None = None
        self._prop: QPixmap | None = None
        #: 挂点逐帧标注：(x, y, angle, front)，格内归一化
        self._pose: tuple[float, float, float, bool] | None = None
        self._world_w: float = 0.0
        self._world_h: float = 0.0
        self._anchor = (0.5, 0.5)
        self._rotation = 0.0
        self._scale = 1.0
        self._facing = 1          # 1=朝右 -1=朝左（验镜像）
        self._note = ""

    # ---- 数据入口 ----------------------------------------------------

    def set_host(self, cell: QPixmap | None, world_w: float, world_h: float) -> None:
        """宿主帧 + 动画包世界宽高（两个都要：角色帧分轴拉伸，见模块头「缩放口径」）。"""
        self._cell = cell
        self._world_w = float(world_w or 0.0)
        self._world_h = float(world_h or 0.0)
        self.update()

    def set_pose(self, pose: tuple[float, float, float, bool] | None) -> None:
        self._pose = pose
        self.update()

    def set_prop(self, prop: QPixmap | None) -> None:
        self._prop = prop
        self.update()

    def set_placement(self, anchor_x: float, anchor_y: float, rotation: float, scale: float) -> None:
        self._anchor = (float(anchor_x), float(anchor_y))
        self._rotation = float(rotation)
        self._scale = float(scale)
        self.update()

    def set_facing(self, facing: int) -> None:
        self._facing = -1 if int(facing) < 0 else 1
        self.update()

    def set_note(self, note: str) -> None:
        self._note = str(note or "")
        self.update()

    # ---- 几何 --------------------------------------------------------

    def _fit(self) -> tuple[float, QPointF, float, float]:
        """角色帧 → 视口等比适配：返回 (缩放 k, 左上角, 格宽, 格高)。"""
        pad = 12.0
        cw = float(self._cell.width()) if self._cell else 1.0
        ch = float(self._cell.height()) if self._cell else 1.0
        if cw <= 0 or ch <= 0:
            return 1.0, QPointF(pad, pad), 1.0, 1.0
        k = min((self.width() - pad * 2) / cw, (self.height() - pad * 2) / ch)
        ox = (self.width() - cw * k) / 2.0
        oy = (self.height() - ch * k) / 2.0
        return k, QPointF(ox, oy), cw, ch

    # ---- 绘制 --------------------------------------------------------

    def paintEvent(self, _e) -> None:  # noqa: N802 (Qt 命名)
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        p.fillRect(self.rect(), QColor(28, 30, 34))

        k, o, cw, ch = self._fit()
        # 没有标注时不画挂件，前后无所谓；有标注时 pose[3] 是**标注的**前后（按朝右标，
        # 已按「缺省身前」解好）。切到朝左预览时前后互换——与运行时同一条规则
        front = socket_front_for_facing(bool(self._pose[3]), self._facing) if self._pose else True

        if not front:
            self._draw_prop(p, k, o, cw, ch)
        if self._cell is not None:
            target = QRectF(o.x(), o.y(), cw * k, ch * k)
            if self._facing < 0:
                # 镜像宿主：以格中线翻，与运行时 sprite.scale.x = facingX 同效
                p.save()
                p.translate(target.center().x(), 0.0)
                p.scale(-1.0, 1.0)
                p.translate(-target.center().x(), 0.0)
                p.drawPixmap(target, self._cell, QRectF(self._cell.rect()))
                p.restore()
            else:
                p.drawPixmap(target, self._cell, QRectF(self._cell.rect()))
        if front:
            self._draw_prop(p, k, o, cw, ch)
        else:
            # 身后：真实遮挡照画（所见即游戏所得），再在最上层描一道外框——
            # 被身体整个挡住时标注的人仍要看得出挂件在哪
            self._draw_prop(p, k, o, cw, ch, outline_only=True)

        self._draw_hud(p, k, o, cw, ch)
        p.end()

    def _socket_view_point(self, k: float, o: QPointF, cw: float, ch: float) -> QPointF | None:
        if not self._pose:
            return None
        nx, ny = self._pose[0], self._pose[1]
        if self._facing < 0:
            nx = 1.0 - nx       # 镜像：x 翻到另一侧（与 socket_pose_to_local 的 sign 同效）
        return QPointF(o.x() + nx * cw * k, o.y() + ny * ch * k)

    def _draw_prop(
        self, p: QPainter, k: float, o: QPointF, cw: float, ch: float, *, outline_only: bool = False,
    ) -> None:
        if self._prop is None or self._prop.isNull() or not self._pose:
            return
        c = self._socket_view_point(k, o, cw, ch)
        if c is None:
            return
        if self._world_w <= 0 or self._world_h <= 0:
            return
        paint_prop(
            p, self._prop, c,
            pose_angle=self._pose[2],
            facing=self._facing,
            view_per_world=((cw * k) / self._world_w, (ch * k) / self._world_h),
            anchor=self._anchor,
            rotation=self._rotation,
            scale=self._scale,
            outline_only=outline_only,
        )

    def _draw_hud(self, p: QPainter, k: float, o: QPointF, cw: float, ch: float) -> None:
        # 脚线：挂点 y=1 就是这条线，标注时的基准
        p.setPen(QPen(QColor(90, 100, 115), 1, Qt.PenStyle.DashLine))
        foot_y = o.y() + ch * k
        p.drawLine(QPointF(o.x(), foot_y), QPointF(o.x() + cw * k, foot_y))
        # 支点十字画在最上层：挂件排在身后时它会被角色盖住，
        # 而"支点对没对准握把"恰恰是这页最要看的东西，不能被遮。
        c = self._socket_view_point(k, o, cw, ch)
        if c is not None and self._prop is not None and not self._prop.isNull():
            pen = QPen(QColor(255, 140, 60, 230))
            pen.setWidthF(1.5)
            p.setPen(pen)
            p.drawLine(QPointF(c.x() - 7, c.y()), QPointF(c.x() + 7, c.y()))
            p.drawLine(QPointF(c.x(), c.y() - 7), QPointF(c.x(), c.y() + 7))
        if self._note:
            p.setPen(QColor(190, 195, 205))
            p.drawText(QRectF(6, 4, self.width() - 12, 40),
                       int(Qt.TextFlag.TextWordWrap), self._note)
