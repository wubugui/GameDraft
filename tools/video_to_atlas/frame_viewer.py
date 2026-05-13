"""Full-size frame viewer dialog with zoom and pan."""
from __future__ import annotations

import cv2
import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QBrush, QColor, QImage, QPixmap, QWheelEvent
from PySide6.QtWidgets import (
    QDialog,
    QGraphicsPixmapItem,
    QGraphicsScene,
    QGraphicsView,
    QVBoxLayout,
)


class _ZoomView(QGraphicsView):
    def __init__(self, scene: QGraphicsScene) -> None:
        super().__init__(scene)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setRenderHint(self.renderHints().SmoothPixmapTransform)
        self._zoom = 1.0

    def wheelEvent(self, event: QWheelEvent) -> None:
        factor = 1.15 if event.angleDelta().y() > 0 else 1.0 / 1.15
        self._zoom *= factor
        self._zoom = max(0.05, min(self._zoom, 50.0))
        self.setTransform(self.transform().scale(factor, factor))


def _checkerboard_brush(cell: int = 16) -> QBrush:
    from PySide6.QtGui import QPixmap as QP, QPainter
    size = cell * 2
    pm = QP(size, size)
    p = QPainter(pm)
    p.fillRect(0, 0, size, size, QColor(210, 210, 210))
    p.fillRect(0, 0, cell, cell, QColor(170, 170, 170))
    p.fillRect(cell, cell, cell, cell, QColor(170, 170, 170))
    p.end()
    return QBrush(pm)


class FrameViewerDialog(QDialog):
    def __init__(self, bgra: np.ndarray, title: str = "Frame Viewer",
                 parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(800, 600)
        self.setWindowFlags(self.windowFlags() | Qt.WindowType.WindowMaximizeButtonHint)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)

        self._scene = QGraphicsScene(self)
        self._scene.setBackgroundBrush(_checkerboard_brush())
        self._view = _ZoomView(self._scene)
        layout.addWidget(self._view)

        rgba = cv2.cvtColor(bgra, cv2.COLOR_BGRA2RGBA)
        h, w = rgba.shape[:2]
        rgba = np.ascontiguousarray(rgba)
        qimg = QImage(rgba.data, w, h, w * 4, QImage.Format.Format_RGBA8888).copy()
        pix = QPixmap.fromImage(qimg)
        self._item = QGraphicsPixmapItem(pix)
        self._scene.addItem(self._item)
        self._scene.setSceneRect(self._item.boundingRect())
