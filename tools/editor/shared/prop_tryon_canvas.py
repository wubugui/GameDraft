"""挂件试挂预览：把挂件按某个挂点的逐帧标注摆到角色帧上，所见即游戏所得。

**为什么必须有这个东西**：支点（刀柄在贴图哪儿）、自转（图画歪了多少）、缩放
这三个数只能靠眼睛调——没有预览就只能"改数字 → 进游戏看 → 再改"，一轮几十秒。

**为什么它可信**：位姿走的是 `animation_sockets.socket_pose_to_local`，
与运行时 `socketPoseToLocal` 是同一套数学（parity 测试钉死黄金值）；
支点/自转/缩放的施加顺序照 `SpriteEntity.syncAttachments` 逐条对齐。
两边任一漂了，是 parity 测试红，不是这里悄悄画歪。

**缩放口径**（唯一需要换算的一处）：挂件是 `SpriteEntity.container` 的**兄弟**级子节点，
不继承 `sprite.scale`（世界尺寸/帧像素）。所以 `scale=1` 意味着"贴图 1 像素 = 1 世界单位"。
角色帧在画布上占 `k*cellW` 像素、代表 `worldWidth` 个世界单位，
故挂件在画布上的像素倍率 = `scale * k * cellW / worldWidth`。
"""
from __future__ import annotations

import math

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QWidget

CANVAS_W = 340
CANVAS_H = 400


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
        self._anchor = (0.5, 0.5)
        self._rotation = 0.0
        self._scale = 1.0
        self._facing = 1          # 1=朝右 -1=朝左（验镜像）
        self._note = ""

    # ---- 数据入口 ----------------------------------------------------

    def set_host(self, cell: QPixmap | None, world_w: float) -> None:
        self._cell = cell
        self._world_w = float(world_w or 0.0)
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
        front = bool(self._pose[3]) if self._pose else False

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

        self._draw_hud(p, k, o, cw, ch)
        p.end()

    def _socket_view_point(self, k: float, o: QPointF, cw: float, ch: float) -> QPointF | None:
        if not self._pose:
            return None
        nx, ny = self._pose[0], self._pose[1]
        if self._facing < 0:
            nx = 1.0 - nx       # 镜像：x 翻到另一侧（与 socket_pose_to_local 的 sign 同效）
        return QPointF(o.x() + nx * cw * k, o.y() + ny * ch * k)

    def _draw_prop(self, p: QPainter, k: float, o: QPointF, cw: float, ch: float) -> None:
        if self._prop is None or self._prop.isNull() or not self._pose:
            return
        c = self._socket_view_point(k, o, cw, ch)
        if c is None:
            return
        if self._world_w <= 0:
            return
        # 见模块头「缩放口径」：贴图像素 → 世界单位 → 画布像素
        px_per_world = (cw * k) / self._world_w
        mag = self._scale * px_per_world
        if mag <= 0:
            return
        # 角度：挂点标注 + 挂件自转，镜像时**一起**取反（与 syncAttachments 一致）
        ang = (self._pose[2] + self._rotation) * (1 if self._facing > 0 else -1)

        p.save()
        p.translate(c)
        p.rotate(ang)
        p.scale(mag * (1 if self._facing > 0 else -1), mag)
        w = float(self._prop.width())
        h = float(self._prop.height())
        # 支点：贴图上的 (anchorX, anchorY) 对准挂点
        p.drawPixmap(QRectF(-self._anchor[0] * w, -self._anchor[1] * h, w, h),
                     self._prop, QRectF(self._prop.rect()))
        p.restore()

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
