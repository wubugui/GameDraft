"""内容层图元 —— 运行时画面上**真实存在**的东西。

与装饰层（把手、多边形、辅助线）分开的理由不是分类癖：内容的前后关系必须与运行时
一致（否则画布骗人），而装饰本来就该恒在内容之上。两者由完全不同的规则决定次序，
混在一起就会出现老画布那种"NPC 永远被热点贴图压住"。

内容图元的三条约束：

1. **不吃鼠标、不进命中白名单**（继承 `CanvasItem`，且不是 `EntityItem`）。
   贴图往往比实体本体大得多，能点的话会把下方一切都吞掉。
2. **底边中点对齐锚点**（脚底锚），与运行时 `SpriteEntity` 的 anchor 同口径。
3. **贴图读不出来时画占位框**，并把 `texture_loaded` 置 False ——
   运行时那边此时同样**没有档位**（`displaySprite !== null` 才标 band），
   排序必须同口径，否则缺件的热点会排到错误的层。
"""
from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QBrush, QColor, QPen, QPixmap, QTransform

from .changes import EntityRef
from .items import CanvasItem

__all__ = ["BackgroundItem", "DisplayImageItem", "SpritePreviewItem"]

#: 背景恒在最底。它不参与内容排序 —— 运行时 `backgroundLayer` 本来就恒在
#: `entityLayer` 之下，语义一致。
Z_BACKGROUND = -1_000_000.0


class BackgroundItem(CanvasItem):
    """场景背景图，缩放填满 world_w × world_h。

    读不出来时画一句占位提示而不是留空白：对着纯色空画布盲点坐标，
    策划分不清"这个场景没有背景"和"背景加载失败"。
    """

    def __init__(self) -> None:
        super().__init__()
        self._pix: QPixmap | None = None
        self._w = 0.0
        self._h = 0.0
        self._note = ""
        self.setZValue(Z_BACKGROUND)

    def set_background(self, pix: QPixmap | None, world_w: float, world_h: float,
                       note: str = "") -> None:
        self.prepareGeometryChange()
        self._pix = pix if (pix is not None and not pix.isNull()) else None
        self._w = max(0.0, float(world_w or 0.0))
        self._h = max(0.0, float(world_h or 0.0))
        self._note = note
        self.update()

    def boundingRect(self) -> QRectF:
        return QRectF(0, 0, self._w, self._h)

    def paint(self, painter, option, widget=None) -> None:
        rect = QRectF(0, 0, self._w, self._h)
        if self._w <= 0 or self._h <= 0:
            return
        if self._pix is not None:
            painter.drawPixmap(rect, self._pix, QRectF(self._pix.rect()))
            return
        painter.setBrush(QBrush(QColor(38, 40, 46)))
        painter.setPen(QPen(QColor(90, 95, 105), 0, Qt.PenStyle.DashLine))
        painter.drawRect(rect)
        if self._note:
            painter.setPen(QPen(QColor(170, 175, 185)))
            painter.drawText(rect, Qt.AlignmentFlag.AlignCenter, self._note)

_MISSING_FILL = QColor(200, 120, 255, 38)
_MISSING_PEN = QPen(QColor(140, 70, 190, 200), 0, Qt.PenStyle.DashLine)


class _FootAnchoredItem(CanvasItem):
    """底中锚的世界尺寸贴图。子类只负责提供 pixmap 与世界尺寸。"""

    def __init__(self, ref: EntityRef) -> None:
        super().__init__()
        self._ref = ref
        self._pix: QPixmap | None = None
        self._world_w = 0.0
        self._world_h = 0.0
        self._anchor = QPointF(0.0, 0.0)
        self._facing = 1
        self._scale = 1.0
        self._rotation = 0.0
        self.texture_loaded = False

    @property
    def ref(self) -> EntityRef:
        return self._ref

    @property
    def world_size(self) -> tuple[float, float]:
        return (self._world_w, self._world_h)

    def set_geometry(self, anchor: QPointF, world_w: float, world_h: float,
                     *, scale: float = 1.0, rotation: float = 0.0,
                     facing: int = 1) -> None:
        self.prepareGeometryChange()
        self._anchor = QPointF(anchor)
        self._world_w = max(0.0, float(world_w or 0.0))
        self._world_h = max(0.0, float(world_h or 0.0))
        self._scale = float(scale) if scale and scale > 0 else 1.0
        self._rotation = float(rotation or 0.0)
        self._facing = -1 if facing < 0 else 1
        self.update()

    def set_pixmap(self, pix: QPixmap | None) -> None:
        self.prepareGeometryChange()
        self._pix = pix if (pix is not None and not pix.isNull()) else None
        self.texture_loaded = self._pix is not None
        self.update()

    # ---- 几何 --------------------------------------------------------------

    def _quad(self) -> QRectF:
        """底中锚的本地 quad（未旋转）。"""
        w = self._world_w * self._scale
        h = self._world_h * self._scale
        return QRectF(-w / 2.0, -h, w, h)

    def boundingRect(self) -> QRectF:
        q = self._quad()
        if self._rotation:
            # 旋转后的 AABB：四角变换取包围
            t = QTransform().rotate(self._rotation)
            return t.mapRect(q).adjusted(-1, -1, 1, 1)
        return q.adjusted(-1, -1, 1, 1)

    def paint(self, painter, option, widget=None) -> None:
        if self._world_w <= 0 or self._world_h <= 0:
            return
        painter.save()
        if self._rotation:
            painter.rotate(self._rotation)
        q = self._quad()
        if self._pix is not None:
            src = self._pix
            if self._facing < 0:
                src = QPixmap.fromImage(src.toImage().mirrored(True, False))
            painter.drawPixmap(q, src, QRectF(src.rect()))
        else:
            # 缺件占位：与运行时"没有 displaySprite"同口径 —— 不只是画个框，
            # `texture_loaded` 也是 False，排序那边据此不给档位。
            painter.setBrush(QBrush(_MISSING_FILL))
            painter.setPen(_MISSING_PEN)
            painter.drawRect(q)
        painter.restore()


class DisplayImageItem(_FootAnchoredItem):
    """热点的 `displayImage` 预览。"""


class SpritePreviewItem(_FootAnchoredItem):
    """NPC 的动画精灵预览（当前帧）。

    **可见性有自己的闸门**：动画驱动每拍会重画，直接 `setVisible(False)` 会被下一拍
    冲掉。老画布正是这么被坑的 —— 藏起来的精灵最多活 8 毫秒。这里把闸门做成
    `visible_gate`，重画时读它。
    """

    def __init__(self, ref: EntityRef) -> None:
        super().__init__(ref)
        self.visible_gate = True

    def setVisible(self, on: bool) -> None:  # noqa: N802 - Qt 接口
        """记住闸门状态，供动画驱动重画时复用。"""
        self.visible_gate = bool(on)
        super().setVisible(bool(on))

    def refresh_frame(self, pix: QPixmap | None) -> None:
        """动画驱动每拍调。**必须按闸门重设可见性**，不许无条件 show()。"""
        self.set_pixmap(pix)
        super().setVisible(self.visible_gate)
