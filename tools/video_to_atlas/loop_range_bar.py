"""双关键点循环区间条：轨道 + 左右两柄拖动，类似进度条上选一段。"""
from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, QSize, Qt, Signal
from PySide6.QtGui import QColor, QMouseEvent, QPaintEvent, QPainter, QPen
from PySide6.QtWidgets import QWidget


class LoopRangeBar(QWidget):
    """时间轴上 [t0, t1]（秒），duration 为总时长。"""

    rangeChanged = Signal(float, float)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(56)
        self.setMouseTracking(True)
        self._duration_sec = 1.0
        self._t0 = 0.0
        self._t1 = 1.0
        self._drag: str | None = None  # "t0" | "t1"
        self._margin = 14
        self._handle_r = 9
        self._min_gap = 0.02

    def duration_sec(self) -> float:
        return self._duration_sec

    def set_duration_sec(self, d: float) -> None:
        d = max(0.001, float(d))
        self._duration_sec = d
        self._t0 = max(0.0, min(self._t0, d))
        self._t1 = max(self._t0 + self._min_gap, min(self._t1, d))
        self.update()

    def range_sec(self) -> tuple[float, float]:
        return self._t0, self._t1

    def set_range_sec(self, t0: float, t1: float, emit: bool = False) -> None:
        d = self._duration_sec
        t0 = max(0.0, min(float(t0), d))
        t1 = max(0.0, min(float(t1), d))
        if t1 < t0 + self._min_gap:
            if t1 <= t0:
                t1 = min(d, t0 + self._min_gap)
            else:
                t0 = max(0.0, t1 - self._min_gap)
        self._t0 = t0
        self._t1 = t1
        self.update()
        if emit:
            self.rangeChanged.emit(self._t0, self._t1)

    def _time_to_x(self, t: float) -> float:
        m = float(self._margin)
        w = float(self.width()) - 2 * m
        if w <= 0:
            return m
        return m + (t / self._duration_sec) * w

    def _x_to_time(self, x: float) -> float:
        m = float(self._margin)
        w = float(self.width()) - 2 * m
        if w <= 0:
            return 0.0
        r = (x - m) / w
        r = max(0.0, min(1.0, r))
        return r * self._duration_sec

    def _handle_at(self, name: str) -> QPointF:
        t = self._t0 if name == "t0" else self._t1
        x = self._time_to_x(t)
        y = float(self.height()) / 2.0
        return QPointF(x, y)

    def _hit(self, pos: QPointF) -> str | None:
        p0 = self._handle_at("t0")
        p1 = self._handle_at("t1")
        r = float(self._handle_r + 4)
        if (pos - p0).manhattanLength() <= r * 1.8:
            return "t0"
        if (pos - p1).manhattanLength() <= r * 1.8:
            return "t1"
        return None

    def paintEvent(self, event: QPaintEvent) -> None:
        del event
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        h = self.height()
        m = self._margin
        track_y = h // 2
        track_h = 8
        x0 = self._time_to_x(0)
        x1 = self._time_to_x(self._duration_sec)
        p.setBrush(QColor(55, 55, 60))
        p.setPen(Qt.PenStyle.NoPen)
        p.drawRoundedRect(QRectF(x0, track_y - track_h / 2, x1 - x0, float(track_h)), 3, 3)

        xa = self._time_to_x(self._t0)
        xb = self._time_to_x(self._t1)
        p.setBrush(QColor(70, 130, 220))
        p.drawRoundedRect(QRectF(xa, track_y - track_h / 2, xb - xa, float(track_h)), 3, 3)

        for name, color in (("t0", QColor(240, 240, 245)), ("t1", QColor(240, 240, 245))):
            pt = self._handle_at(name)
            p.setBrush(color)
            p.setPen(QPen(QColor(30, 30, 35), 2))
            p.drawEllipse(pt, float(self._handle_r), float(self._handle_r))

    def mousePressEvent(self, event: QMouseEvent) -> None:
        if event.button() != Qt.MouseButton.LeftButton:
            return
        pos = QPointF(event.position())
        hit = self._hit(pos)
        if hit:
            self._drag = hit
        else:
            t = self._x_to_time(pos.x())
            d0 = abs(t - self._t0)
            d1 = abs(t - self._t1)
            if d0 <= d1:
                self._drag = "t0"
            else:
                self._drag = "t1"
            self._move_drag(t)
        event.accept()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:
        if self._drag:
            t = self._x_to_time(event.position().x())
            self._move_drag(t)
        event.accept()

    def _move_drag(self, t: float) -> None:
        if self._drag == "t0":
            t = max(0.0, min(t, self._t1 - self._min_gap))
            if abs(t - self._t0) > 1e-6:
                self._t0 = t
                self.rangeChanged.emit(self._t0, self._t1)
        elif self._drag == "t1":
            t = min(self._duration_sec, max(t, self._t0 + self._min_gap))
            if abs(t - self._t1) > 1e-6:
                self._t1 = t
                self.rangeChanged.emit(self._t0, self._t1)
        self.update()

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:
        self._drag = None
        event.accept()

    def sizeHint(self):
        return QSize(400, 56)
