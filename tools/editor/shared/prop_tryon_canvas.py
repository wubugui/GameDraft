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

**起火点与火苗**（2026-09-15 燃烧物契约）：起火点跟着燃烧物走（同 `paint_prop` 那一套变换，
数学在 `prop_preview.fire_point_offset`，与运行时同一公式）；火苗以格底中点为锚、画面竖直
向上、不跟燃烧物转、不吃光——预览只画第 0 帧、高 = burn × 满火高度（wu），无风无闪。
开了「点选」时在画布上按下 / 拖动，把光标位置逆变换回贴图归一化坐标发出去（所见即所得）。

**可燃挂件**（2026-09-16 A3.8 模板 + 实例）：宿主页把模板的图、握点、按模板真实宽换算的 scale 喂进来
（``prop_preview.burnable_prop_placement``），这里照常按 `paint_prop` 摆；模板的着火点经 `set_burn_points`
画成火橙菱形（与起火点 / 粒子挂点同一套 uv → 画布变换）。
"""
from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QMouseEvent, QPainter, QPen, QPixmap, QPolygonF
from PySide6.QtWidgets import QWidget

from .animation_sockets import socket_front_for_facing
from .prop_preview import fire_point_from_offset, fire_point_offset

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
    """预览：角色帧 + 按挂点位姿摆好的挂件 + 支点十字 + 起火点十字与火苗。

    数据只读；唯一的交互是「点选起火点」（`set_fire_pick_enabled`），结果经
    `fire_point_picked(x, y)` 发给宿主，由宿主决定写进基础块还是某个状态。
    """

    #: 在画布上点选 / 拖出的起火点（贴图归一化 0..1）
    fire_point_picked = Signal(float, float)

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
        #: 起火点（贴图归一化）；None = 没写，火从挂点本身出
        self._fire_point: tuple[float, float] | None = None
        #: 火苗第 0 帧（已裁好的一格）与此刻的高度（wu = burn × 满火高度）
        self._flame_cell: QPixmap | None = None
        self._flame_height_wu = 0.0
        #: 有没有配火（决定画不画起火点十字：灯笼也可以只写起火点不写火苗）
        self._fire_configured = False
        self._fire_pick = False
        #: 粒子挂载 (效果 id, 贴图归一化挂点 or None)
        self._mounts: list[tuple[str, tuple[float, float] | None]] = []
        #: 可燃挂件模板的着火点 (id, 贴图归一化 uv)
        self._burn_points: list[tuple[str, tuple[float, float]]] = []

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

    def set_fire(
        self,
        fire_point: tuple[float, float] | None,
        *,
        configured: bool,
        flame_cell: QPixmap | None = None,
        flame_height_wu: float = 0.0,
    ) -> None:
        """起火点 + 火苗（第 0 帧一格 + 此刻高度 wu）。`configured=False` = 这个挂件没有火，什么都不画。"""
        self._fire_point = fire_point
        self._fire_configured = bool(configured)
        self._flame_cell = flame_cell if flame_cell is not None and not flame_cell.isNull() else None
        self._flame_height_wu = max(0.0, float(flame_height_wu or 0.0))
        self.update()

    def set_fire_pick_enabled(self, on: bool) -> None:
        self._fire_pick = bool(on)
        self.setCursor(Qt.CursorShape.CrossCursor if self._fire_pick else Qt.CursorShape.ArrowCursor)
        self.update()

    def fire_pick_enabled(self) -> bool:
        return self._fire_pick

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
            self._draw_flame(p, k, o, cw, ch)
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
            self._draw_flame(p, k, o, cw, ch)
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

    # ---- 起火点 / 火苗 ------------------------------------------------

    def _view_per_world(self, k: float, cw: float, ch: float) -> tuple[float, float] | None:
        if self._world_w <= 0 or self._world_h <= 0:
            return None
        return ((cw * k) / self._world_w, (ch * k) / self._world_h)

    def _fire_geometry(self) -> dict | None:
        """起火点变换要的量（挂点画布位置、分轴缩放、合成角…）；取不到返回 None。"""
        if not self._pose:
            return None
        k, o, cw, ch = self._fit()
        c = self._socket_view_point(k, o, cw, ch)
        vpw = self._view_per_world(k, cw, ch)
        if c is None or vpw is None:
            return None
        sign = -1 if self._facing < 0 else 1
        prop_ok = self._prop is not None and not self._prop.isNull()
        return {
            "at": c, "vpw": vpw, "sign": sign,
            "frame_w": float(self._prop.width()) if prop_ok else 0.0,
            "frame_h": float(self._prop.height()) if prop_ok else 0.0,
            "angle": (self._pose[2] + self._rotation) * sign,
        }

    def fire_view_point(self) -> QPointF | None:
        """起火点在画布上的像素位置（没配火 / 算不出来返回 None）。"""
        if not self._fire_configured:
            return None
        return self._uv_view_point(self._fire_point)

    def _uv_view_point(self, uv: tuple[float, float] | None) -> QPointF | None:
        """贴图归一化点 → 画布像素（None = 挂点本身）。与起火点同一套变换（`fire_point_offset`）。"""
        g = self._fire_geometry()
        if g is None:
            return None
        if uv is None:
            return g["at"]
        if g["frame_w"] <= 0 or g["frame_h"] <= 0:
            return None                          # 贴图尺寸不知道，归一化点落不到画布上
        dx, dy = fire_point_offset(
            uv, anchor_x=self._anchor[0], anchor_y=self._anchor[1],
            frame_w=g["frame_w"], frame_h=g["frame_h"], angle_deg=g["angle"],
            facing=g["sign"], scale=self._scale,
        )
        sx, sy = g["vpw"]
        return QPointF(g["at"].x() + dx * sx, g["at"].y() + dy * sy)

    def set_particle_mounts(self, mounts: list[tuple[str, tuple[float, float] | None]]) -> None:
        """粒子挂载 (效果 id, 挂点)：挂点 None = 起火点 → 挂点本身（契约 v3）。粒子本身不模拟，只画点 + id。"""
        self._mounts = [(str(e), p) for e, p in (mounts or [])]
        self.update()

    def set_burn_points(self, points: list[tuple[str, tuple[float, float]]]) -> None:
        """可燃挂件模板的着火点 (id, uv)：火橙菱形 + id。空列表 = 不画（不是可燃挂件 / 模板没标着火点）。"""
        self._burn_points = [(str(pid), (float(uv[0]), float(uv[1]))) for pid, uv in (points or [])]
        self.update()

    def burn_point_view_points(self) -> list[tuple[str, QPointF]]:
        """每个着火点在画布上的位置（算不出来的跳过）。与起火点同一套变换。"""
        out: list[tuple[str, QPointF]] = []
        for pid, uv in self._burn_points:
            at = self._uv_view_point(uv)
            if at is not None:
                out.append((pid, at))
        return out

    def particle_mount_view_points(self) -> list[tuple[str, QPointF]]:
        """每个粒子挂载在画布上的位置（算不出来的跳过）。挂点没写落到起火点，再没有落到挂点本身。"""
        out: list[tuple[str, QPointF]] = []
        for effect, point in getattr(self, "_mounts", []):
            at = self._uv_view_point(point if point is not None else self._fire_point)
            if at is not None:
                out.append((effect, at))
        return out

    def flame_view_rect(self) -> QRectF | None:
        """火苗第 0 帧在画布上的矩形：格底中点对准起火点、竖直向上、宽高按世界单位分轴换算。"""
        if self._flame_cell is None or self._flame_height_wu <= 0:
            return None
        at = self.fire_view_point()
        if at is None:
            return None
        k, _o, cw, ch = self._fit()
        vpw = self._view_per_world(k, cw, ch)
        if vpw is None:
            return None
        fw = float(self._flame_cell.width())
        fh = float(self._flame_cell.height())
        if fw <= 0 or fh <= 0:
            return None
        h_view = self._flame_height_wu * vpw[1]
        w_view = self._flame_height_wu * (fw / fh) * vpw[0]
        return QRectF(at.x() - w_view / 2.0, at.y() - h_view, w_view, h_view)

    def _draw_flame(self, p: QPainter, _k: float, _o: QPointF, _cw: float, _ch: float) -> None:
        rect = self.flame_view_rect()
        if rect is None:
            return
        p.drawPixmap(rect, self._flame_cell, QRectF(self._flame_cell.rect()))

    def _pick_at(self, pos: QPointF) -> None:
        g = self._fire_geometry()
        if g is None or g["frame_w"] <= 0 or g["frame_h"] <= 0:
            return
        sx, sy = g["vpw"]
        uv = fire_point_from_offset(
            (pos.x() - g["at"].x()) / sx, (pos.y() - g["at"].y()) / sy,
            anchor_x=self._anchor[0], anchor_y=self._anchor[1],
            frame_w=g["frame_w"], frame_h=g["frame_h"], angle_deg=g["angle"],
            facing=g["sign"], scale=self._scale,
        )
        if uv is not None:
            self.fire_point_picked.emit(uv[0], uv[1])

    def mousePressEvent(self, e: QMouseEvent) -> None:  # noqa: N802 (Qt 命名)
        if self._fire_pick and e.button() == Qt.MouseButton.LeftButton:
            self._pick_at(e.position())
            e.accept()
            return
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e: QMouseEvent) -> None:  # noqa: N802 (Qt 命名)
        if self._fire_pick and e.buttons() & Qt.MouseButton.LeftButton:
            self._pick_at(e.position())
            e.accept()
            return
        super().mouseMoveEvent(e)

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
        # 起火点：斜十字 + 小圈（与支点的正十字分得开），同样画在最上层
        fire = self.fire_view_point()
        if fire is not None:
            pen = QPen(QColor(90, 220, 255, 240))
            pen.setWidthF(1.5)
            p.setPen(pen)
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawLine(QPointF(fire.x() - 6, fire.y() - 6), QPointF(fire.x() + 6, fire.y() + 6))
            p.drawLine(QPointF(fire.x() - 6, fire.y() + 6), QPointF(fire.x() + 6, fire.y() - 6))
            p.drawEllipse(fire, 3.0, 3.0)
        # 粒子挂点：小圆点 + 效果 id（同一点上多个效果时 id 往下错开，不叠成一团）
        stacked: dict[tuple[int, int], int] = {}
        for effect, at in self.particle_mount_view_points():
            key = (round(at.x()), round(at.y()))
            n = stacked.get(key, 0)
            stacked[key] = n + 1
            p.setPen(QPen(QColor(20, 20, 24, 230), 1.0))
            p.setBrush(QColor(255, 120, 200, 235))
            p.drawEllipse(at, 3.5, 3.5)
            p.setPen(QColor(255, 170, 225))
            p.drawText(QPointF(at.x() + 6, at.y() - 4 + n * 12), effect)
        # 可燃挂件的着火点：火橙菱形 + id（与场景画布的着火点标记同色）
        for pid, at in self.burn_point_view_points():
            p.setPen(QPen(QColor(20, 20, 24, 230), 1.0))
            p.setBrush(QColor(255, 140, 40, 235))
            p.drawPolygon(QPolygonF([QPointF(at.x(), at.y() - 5), QPointF(at.x() + 5, at.y()),
                                     QPointF(at.x(), at.y() + 5), QPointF(at.x() - 5, at.y())]))
            p.setPen(QColor(255, 180, 110))
            p.drawText(QPointF(at.x() + 7, at.y() + 4), pid)
        p.setBrush(Qt.BrushStyle.NoBrush)
        if self._fire_pick:
            pen = QPen(QColor(90, 220, 255, 160), 2, Qt.PenStyle.DashLine)
            p.setPen(pen)
            p.drawRect(QRectF(self.rect()).adjusted(1, 1, -1, -1))
        if self._note:
            p.setPen(QColor(190, 195, 205))
            p.drawText(QRectF(6, 4, self.width() - 12, 40),
                       int(Qt.TextFlag.TextWordWrap), self._note)
