"""可燃实例（热点 / NPC 身上的 ``burnable``）在新画布上的着火点标记 —— **只读显示**。

A3.8 模板 + 实例：实体开了可燃，自己的展示图 / 动画失效，画的是模板的图（按模板真实尺寸）；
着火点来自模板 ``ignitionPoints``（模板唯一写入者是燃烧工作台）。标记的位置从与运行时
``burnEntityPlacement`` 同口径的摆法（``shared/burn_geometry``）求，与老画布 ``_BurnPointMarker`` 同一套行：

- 模板标了着火点：每个点一枚菱形，第一个标「缺省」（``igniteBurnable`` 不写 point 时用它）；
- 没标：图中间一个虚线圈（整体点着——缺省也必须看得见）；
- 模板不存在 / 没尺寸：实体锚点上一个红叉（运行时装不上、不画图）。

它**不进命中白名单**（``pick_contains`` 恒 False、``pick_rect`` 为空）：只读的东西不该抢点击，
也不该被框选当成"框到了这个实体"。
"""
from __future__ import annotations

import math

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QFont, QFontMetricsF, QPen

from ...shared import burnables as _bn_lib
from ...shared.burn_geometry import BurnPlacement, placement_frame, uv_to_scene
from ...shared.entity_transform_math import DEFAULT_ENTITY_ANCHOR_X, DEFAULT_ENTITY_ANCHOR_Y
from .changes import EntityRef
from .items import EntityItem

__all__ = ["BurnPointsItem", "burn_marker_rows", "burnable_template_of"]

#: 标记半臂长（屏幕像素）：缩放视图时不缩成一个点
_ARM_PX = 9.0
#: 标签离标记的偏移（屏幕像素）
_LABEL_DX_PX = 10.0
_LABEL_DY_PX = -8.0
_POINT_RGB = (255, 140, 40)
_WARN_RGB = (235, 50, 50)


def burnable_template_of(ent: dict | None) -> str:
    """实体开了可燃时绑的模板 id（``burnable.template`` 去空白）；没开 / 形状坏 ⇒ ``""``（同 ``resolveBurnableHost``）。"""
    host = ent.get("burnable") if isinstance(ent, dict) else None
    tid = host.get("template") if isinstance(host, dict) else None
    return tid.strip() if isinstance(tid, str) else ""


def burn_marker_rows(doc: dict | None, template: str) -> list[tuple[str, float, float, str, str]]:
    """一个可燃实例的标记 ``[(point_id, u, v, label, style)]``，``style`` ∈ ``point / whole / warn``。"""
    if doc is None:
        return [("", 0.5, 1.0, f"可燃模板「{template}」不存在——运行时装不上", "warn")]
    if _bn_lib.template_world_size(doc) is None:
        return [("", 0.5, 1.0, f"可燃模板「{template}」没写真实尺寸——运行时装不上", "warn")]
    pts = _bn_lib.ignition_points_uv(doc)
    if not pts:
        return [("", 0.5, 0.5, f"{template}：没标着火点，整体点着", "whole")]
    return [(pid, u, v, f"着火点 {pid}" + ("（缺省）" if i == 0 else ""), "point")
            for i, (pid, u, v) in enumerate(pts)]


class BurnPointsItem(EntityItem):
    """一个可燃实例的全部着火点标记（一实体一个图元）。

    几何接口与内容图元（``DisplayImageItem`` / ``SpritePreviewItem``）的 ``set_geometry`` 同签名：
    视图在同步与缩放 / 旋转手势预览里对 ``display`` / ``sprite`` / ``burn`` 三个 part 一视同仁地调，
    于是标记与模板图恒同一个摆法，不会各摆各的。数据位（``set_base_pos``）= 实体锚点，拖动 / 巡逻预览
    走基类的预览位移，跟着走不必重算。
    """

    def __init__(self, ref: EntityRef) -> None:
        super().__init__(ref)
        self._rows: list[tuple[str, float, float, str, str]] = []
        #: 本地坐标（相对实体锚点）的标记位置；与 ``_rows`` 一一对应
        self._local: list[tuple[float, float]] = []
        #: None = 模板图画不出来（只有 warn 行有位置）
        self._geom: tuple[float, float, float, float, int, float, float] | None = None
        self._view_scale = 1.0

    # ---- 数据 --------------------------------------------------------------

    def set_rows(self, rows) -> None:
        rows = [tuple(r) for r in rows or []]
        if rows == self._rows:
            return
        self.prepareGeometryChange()
        self._rows = rows
        self._relayout()

    @property
    def rows(self) -> list[tuple[str, float, float, str, str]]:
        return list(self._rows)

    def set_geometry(self, anchor: QPointF | None, world_w: float = 0.0, world_h: float = 0.0,
                     *, scale: float = 1.0, rotation: float = 0.0, facing: int = 1,
                     anchor_x: float = DEFAULT_ENTITY_ANCHOR_X,
                     anchor_y: float = DEFAULT_ENTITY_ANCHOR_Y) -> None:
        """与内容图元同一套摆法参数；``anchor is None`` 或尺寸为 0 = 模板图画不出来。"""
        if anchor is None or not (world_w and world_w > 0 and world_h and world_h > 0):
            geom = None
        else:
            geom = (float(world_w), float(world_h), float(scale) if scale and scale > 0 else 1.0,
                    float(rotation or 0.0), -1 if facing < 0 else 1,
                    min(1.0, max(0.0, float(anchor_x))), min(1.0, max(0.0, float(anchor_y))))
        if geom == self._geom:
            return
        self.prepareGeometryChange()
        self._geom = geom
        self._relayout()

    def marker_positions(self) -> list[tuple[str, str, tuple[float, float] | None]]:
        """``[(point_id, style, 本地位置 | None)]``——测试与调试用。"""
        return [(r[0], r[4], p) for r, p in zip(self._rows, self._positions())]

    def _positions(self) -> list[tuple[float, float] | None]:
        out: list[tuple[float, float] | None] = []
        frame = None
        if self._geom is not None:
            w, h, s, rot, facing, ax, ay = self._geom
            frame = placement_frame(BurnPlacement(
                x=0.0, y=0.0, width=w, height=h, scale=s, rotation=math.radians(rot),
                flip_x=facing < 0, anchor_x=ax, anchor_y=ay))
        for _pid, u, v, _label, style in self._rows:
            if style == "warn":
                out.append((0.0, 0.0))
            elif frame is None:
                out.append(None)
            else:
                out.append(uv_to_scene(frame, u, v))
        return out

    def _relayout(self) -> None:
        self._local = [p for p in self._positions() if p is not None]
        self.update()

    # ---- 视图缩放（标记按屏幕像素画）----------------------------------------

    def set_view_scale(self, scale: float) -> None:
        s = float(scale) if scale and scale > 1e-9 else 1e-9
        if s != self._view_scale:
            self.prepareGeometryChange()
            self._view_scale = s
            self.update()

    # ---- 命中：不进白名单 ------------------------------------------------------

    def pick_rect(self) -> QRectF:
        return QRectF()

    def pick_contains(self, pos, tol: float = 0.0) -> bool:
        return False

    # ---- 绘制 --------------------------------------------------------------

    def boundingRect(self) -> QRectF:
        if not self._local:
            return QRectF()
        px = 1.0 / self._view_scale
        pad = (_ARM_PX + 3.0) * px
        label_w = 260.0 * px
        label_h = 24.0 * px
        xs = [p[0] for p in self._local]
        ys = [p[1] for p in self._local]
        return QRectF(min(xs) - pad, min(ys) - pad - label_h,
                      max(xs) - min(xs) + 2 * pad + label_w, max(ys) - min(ys) + 2 * pad + label_h)

    def paint(self, painter, option, widget=None) -> None:
        del option, widget
        positions = self._positions()
        if not any(p is not None for p in positions):
            return
        px = 1.0 / self._view_scale
        arm = _ARM_PX * px
        painter.save()
        painter.setRenderHint(painter.RenderHint.Antialiasing, True)
        # 字号跟主题（painter 的缺省字体），不写死像素
        font = QFont(painter.font())
        metrics = QFontMetricsF(font)
        for (pid, _u, _v, label, style), pos in zip(self._rows, positions):
            if pos is None:
                continue
            x, y = pos
            r, g, b = _WARN_RGB if style == "warn" else _POINT_RGB
            for color, width in ((QColor(0, 0, 0, 170), 3.0), (QColor(r, g, b, 240), 1.5)):
                pen = QPen(color, width)
                pen.setCosmetic(True)
                if style == "whole":
                    pen.setStyle(Qt.PenStyle.DashLine)
                painter.setPen(pen)
                painter.setBrush(Qt.BrushStyle.NoBrush)
                if style == "warn":
                    painter.drawLine(QPointF(x - arm, y - arm), QPointF(x + arm, y + arm))
                    painter.drawLine(QPointF(x - arm, y + arm), QPointF(x + arm, y - arm))
                elif style == "whole":
                    painter.drawEllipse(QPointF(x, y), arm, arm)
                else:
                    a = arm * 0.7
                    painter.drawPolygon([QPointF(x, y - a), QPointF(x + a, y), QPointF(x, y + a), QPointF(x - a, y)])
            # 标签按屏幕像素画（缩放视图时字不跟着缩没）
            painter.save()
            painter.translate(x, y)
            painter.scale(px, px)
            painter.setFont(font)
            tx, ty = _LABEL_DX_PX, _LABEL_DY_PX
            tw = metrics.horizontalAdvance(label)
            painter.fillRect(QRectF(tx - 2, ty - metrics.ascent(), tw + 4, metrics.height()), QColor(0, 0, 0, 150))
            painter.setPen(QColor(r, g, b, 255))
            painter.drawText(QPointF(tx, ty), label)
            painter.restore()
        painter.restore()
