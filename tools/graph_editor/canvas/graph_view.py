from PySide6.QtWidgets import QGraphicsView, QGraphicsItem
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QPainter, QColor

from .graph_scene import GraphScene
from .node_item import NodeItem


class GraphView(QGraphicsView):
    """Zoomable, pannable graph canvas."""

    node_clicked = Signal(str)

    def __init__(self, scene: GraphScene, parent=None):
        super().__init__(scene, parent)
        self._scene = scene
        self._panning = False
        self._pan_start = None

        self.setRenderHint(QPainter.RenderHint.Antialiasing)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setViewportUpdateMode(QGraphicsView.ViewportUpdateMode.SmartViewportUpdate)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        # 略浅于纯黑，连线与标签更容易分辨
        self.setBackgroundBrush(QColor(28, 28, 30))

    def _find_node_item(self, item) -> NodeItem | None:
        """Walk up parent chain to find the owning NodeItem."""
        while item is not None:
            if isinstance(item, NodeItem):
                return item
            item = item.parentItem()
        return None

    def wheelEvent(self, event):
        factor = 1.15
        if event.angleDelta().y() < 0:
            factor = 1.0 / factor
        self.scale(factor, factor)

    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.MiddleButton or event.button() == Qt.MouseButton.RightButton:
            self._panning = True
            self._pan_start = event.position().toPoint()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            event.accept()
            return

        if event.button() == Qt.MouseButton.LeftButton:
            raw_item = self.itemAt(event.position().toPoint())
            node_item = self._find_node_item(raw_item)
            if node_item is not None:
                self._scene.highlight_node(node_item.nd.id)
                self.node_clicked.emit(node_item.nd.id)
            else:
                self._scene.highlight_node(None)

        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._panning and self._pan_start is not None:
            delta = event.position().toPoint() - self._pan_start
            self._pan_start = event.position().toPoint()
            self.horizontalScrollBar().setValue(self.horizontalScrollBar().value() - delta.x())
            self.verticalScrollBar().setValue(self.verticalScrollBar().value() - delta.y())
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.MiddleButton or event.button() == Qt.MouseButton.RightButton:
            self._panning = False
            self.setCursor(Qt.CursorShape.ArrowCursor)
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def fit_all(self):
        rect = self._scene.itemsBoundingRect()
        if not rect.isNull():
            rect.adjust(-50, -50, 50, 50)
            self.fitInView(rect, Qt.AspectRatioMode.KeepAspectRatio)
