"""挂点逐帧标注画布：在放大的帧格上点位置、拖角度、切前后。

沿用 `bubble_anchor_field._BubbleStage` 的形状（世界→视口等比适配 + 拖拽），
从"一维、逐 state"推广到"二维、逐帧、多命名挂点"。

坐标口径与 `animation_sockets.socket_pose_to_local` / TS 侧 `socketPoseToLocal` 同源：
画布内部一律用**格内归一化** `x`(0=左 1=右) / `y`(0=顶 1=底＝脚线)，
只在画的时候换成视口像素。
"""
from __future__ import annotations

import math

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QWidget

#: 画布尺寸（与气泡锚画布同量级，13" 屏放得下）
CANVAS_W = 360
CANVAS_H = 420

#: 角度手柄离锚点的视口距离（像素）
HANDLE_R = 46


class SocketCanvas(QWidget):
    """一格帧图 + 若干挂点标记；选中的那个可拖位置、可拖角度手柄。"""

    #: 拖动位置：(归一化 x, 归一化 y)
    posMoved = Signal(float, float)
    #: 拖动角度手柄：角度（度，顺时针为正）
    angleMoved = Signal(float)
    #: 在空白处点击：请求在该点新建/落点
    clickedAt = Signal(float, float)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setFixedSize(CANVAS_W, CANVAS_H)
        self.setCursor(Qt.CursorShape.CrossCursor)
        self._cell: QPixmap | None = None
        #: 挂点名 → (x, y, angle, front)；全部归一化坐标
        self._marks: dict[str, tuple[float, float, float, bool]] = {}
        self._selected: str = ""
        self._drag: str = ""   # '' / 'pos' / 'angle'
        #: 上一帧的标记（洋葱皮，帮着对齐连续帧）
        self._ghost: tuple[float, float] | None = None

    # ---- 数据入口 ----------------------------------------------------

    def set_cell(self, pix: QPixmap | None) -> None:
        self._cell = pix
        self.update()

    def set_marks(self, marks: dict[str, tuple[float, float, float, bool]], selected: str) -> None:
        self._marks = dict(marks)
        self._selected = str(selected or "")
        self.update()

    def set_ghost(self, ghost: tuple[float, float] | None) -> None:
        """洋葱皮：上一帧同挂点的位置，逐帧标注时用来对齐。"""
        self._ghost = ghost
        self.update()

    # ---- 几何 --------------------------------------------------------

    def _fit(self) -> tuple[float, QPointF]:
        """帧格 → 视口的等比适配：返回 (缩放, 格左上角在视口的位置)。"""
        pad = 12.0
        cw = float(self._cell.width()) if self._cell else 1.0
        ch = float(self._cell.height()) if self._cell else 1.0
        if cw <= 0 or ch <= 0:
            return 1.0, QPointF(pad, pad)
        k = min((CANVAS_W - pad * 2) / cw, (CANVAS_H - pad * 2) / ch)
        ox = (CANVAS_W - cw * k) / 2.0
        oy = (CANVAS_H - ch * k) / 2.0
        return k, QPointF(ox, oy)

    def _to_view(self, nx: float, ny: float) -> QPointF:
        k, o = self._fit()
        cw = float(self._cell.width()) if self._cell else 1.0
        ch = float(self._cell.height()) if self._cell else 1.0
        return QPointF(o.x() + nx * cw * k, o.y() + ny * ch * k)

    def _to_norm(self, p: QPointF) -> tuple[float, float]:
        k, o = self._fit()
        cw = float(self._cell.width()) if self._cell else 1.0
        ch = float(self._cell.height()) if self._cell else 1.0
        if cw <= 0 or ch <= 0 or k <= 0:
            return 0.5, 1.0
        nx = (p.x() - o.x()) / (cw * k)
        ny = (p.y() - o.y()) / (ch * k)
        return min(max(nx, 0.0), 1.0), min(max(ny, 0.0), 1.0)

    def _handle_pos(self, nx: float, ny: float, angle: float) -> QPointF:
        c = self._to_view(nx, ny)
        rad = math.radians(angle)
        return QPointF(c.x() + math.cos(rad) * HANDLE_R, c.y() + math.sin(rad) * HANDLE_R)

    # ---- 绘制 --------------------------------------------------------

    def paintEvent(self, _e) -> None:  # noqa: N802 (Qt 命名)
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.fillRect(self.rect(), QColor(28, 30, 34))

        k, o = self._fit()
        if self._cell is not None:
            cw = self._cell.width() * k
            ch = self._cell.height() * k
            p.drawPixmap(QRectF(o.x(), o.y(), cw, ch).toRect(), self._cell)
            # 格边框 + 脚线（底边＝脚点所在，挂点 y=1 就落在这条线上）
            p.setPen(QPen(QColor(90, 96, 108), 1))
            p.drawRect(QRectF(o.x(), o.y(), cw, ch))
            p.setPen(QPen(QColor(120, 200, 140, 180), 1, Qt.PenStyle.DashLine))
            p.drawLine(QPointF(o.x(), o.y() + ch), QPointF(o.x() + cw, o.y() + ch))
            # 中线（x=0.5，脚点所在竖线）
            p.drawLine(QPointF(o.x() + cw / 2, o.y()), QPointF(o.x() + cw / 2, o.y() + ch))

        # 洋葱皮：上一帧位置
        if self._ghost is not None:
            g = self._to_view(self._ghost[0], self._ghost[1])
            p.setPen(QPen(QColor(255, 255, 255, 70), 1, Qt.PenStyle.DotLine))
            p.drawEllipse(g, 7, 7)

        for name, (nx, ny, angle, front) in self._marks.items():
            sel = name == self._selected
            c = self._to_view(nx, ny)
            # 身前实心、身后空心——一眼看出前后档
            col = QColor(255, 196, 84) if sel else QColor(140, 170, 220)
            p.setPen(QPen(col, 2 if sel else 1))
            p.setBrush(col if front else Qt.BrushStyle.NoBrush)
            p.drawEllipse(c, 6 if sel else 4, 6 if sel else 4)
            p.setBrush(Qt.BrushStyle.NoBrush)
            if sel:
                # 角度手柄
                h = self._handle_pos(nx, ny, angle)
                p.setPen(QPen(QColor(255, 196, 84, 200), 1, Qt.PenStyle.DashLine))
                p.drawLine(c, h)
                p.setPen(QPen(QColor(255, 196, 84), 2))
                p.drawEllipse(h, 4, 4)
            p.setPen(QPen(QColor(230, 232, 236) if sel else QColor(150, 156, 168), 1))
            p.drawText(QPointF(c.x() + 9, c.y() - 7), name)
        p.end()

    # ---- 交互 --------------------------------------------------------

    def mousePressEvent(self, e) -> None:  # noqa: N802
        if not self._selected or self._selected not in self._marks:
            nx, ny = self._to_norm(e.position())
            self.clickedAt.emit(nx, ny)
            return
        nx, ny, angle, _front = self._marks[self._selected]
        pos = e.position()
        if (pos - self._handle_pos(nx, ny, angle)).manhattanLength() <= 14:
            self._drag = "angle"
            return
        if (pos - self._to_view(nx, ny)).manhattanLength() <= 16:
            self._drag = "pos"
            return
        # 点空白 = 把选中挂点挪过去（逐帧标注时这是最高频的操作）
        self._drag = "pos"
        gx, gy = self._to_norm(pos)
        self.posMoved.emit(gx, gy)

    def mouseMoveEvent(self, e) -> None:  # noqa: N802
        if not self._drag or self._selected not in self._marks:
            return
        nx, ny, _angle, _front = self._marks[self._selected]
        if self._drag == "pos":
            gx, gy = self._to_norm(e.position())
            self.posMoved.emit(gx, gy)
        else:
            c = self._to_view(nx, ny)
            d = e.position() - c
            self.angleMoved.emit(round(math.degrees(math.atan2(d.y(), d.x())), 1))

    def mouseReleaseEvent(self, _e) -> None:  # noqa: N802
        self._drag = ""
