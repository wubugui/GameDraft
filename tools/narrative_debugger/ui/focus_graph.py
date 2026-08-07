"""因果邻域图：以当前（或选中）状态为焦点，只画它前后几跳。

刻意不画全图——186 个状态铺开谁也看不懂，而策划真正要问的只有"我在哪、前面是哪、
后面是哪"。焦点 ±N 跳恰好回答这个，且节点数天然被限制在几十个以内，永远不卡。

布局按跳数分列：左边是"怎么走到这儿的"，右边是"接下来会去哪"。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QPainter,
    QPainterPath,
    QPen,
    QPolygonF,
    QWheelEvent,
)
from PySide6.QtWidgets import (
    QGraphicsItem,
    QGraphicsScene,
    QGraphicsView,
    QStyleOptionGraphicsItem,
    QWidget,
)

from tools.narrative_debugger.model import NarrativeIndex, Neighborhood, StateNode

NODE_W = 168.0
NODE_H = 52.0
# 列距要放得下边上那句人话标签（节点之间留 ~150px），否则标签会压在节点上
COL_GAP = 320.0
ROW_GAP = 84.0
# 自动比例的下限：低于 1:1 字就开始糊。链长了宁可横向拖，也不缩成一条读不了的横条——
# 早先这里是 0.62，四跳时整图被压到 0.62 倍，正是"图太小看不清"的第一个原因。
PREFERRED_SCALE = 1.0
# 图小的时候允许放大到这个倍数把地方吃满，再大就假了
MAX_FIT_SCALE = 1.45
# 手动缩放（按钮 / Ctrl+滚轮）的边界
ZOOM_MIN = 0.35
ZOOM_MAX = 3.0
# 标签最多几个字：放不进两节点之间的空隙就会盖住节点
LABEL_MAX_CHARS = 9


@dataclass(frozen=True)
class GraphPalette:
    bg: QColor
    node: QColor
    node_text: QColor
    node_sub: QColor
    border: QColor
    focus: QColor
    focus_fill: QColor
    live: QColor
    live_fill: QColor
    edge: QColor
    edge_text: QColor
    derived: QColor

    @staticmethod
    def for_dark(dark: bool) -> "GraphPalette":
        if dark:
            return GraphPalette(
                bg=QColor("#1b1c1e"),
                node=QColor("#2a2c30"),
                node_text=QColor("#e8e6e3"),
                node_sub=QColor("#9a9691"),
                border=QColor("#3d4044"),
                focus=QColor("#7aa2f7"),
                focus_fill=QColor("#26344d"),
                live=QColor("#7bc77b"),
                live_fill=QColor("#24361f"),
                edge=QColor("#5a5d62"),
                edge_text=QColor("#8d9096"),
                derived=QColor("#a98adf"),
            )
        return GraphPalette(
            bg=QColor("#faf9f7"),
            node=QColor("#ffffff"),
            node_text=QColor("#23211f"),
            node_sub=QColor("#7a756e"),
            border=QColor("#d6d2cc"),
            focus=QColor("#2f6fd0"),
            focus_fill=QColor("#e4eefb"),
            live=QColor("#3f8c3f"),
            live_fill=QColor("#e6f3e2"),
            edge=QColor("#b3aea7"),
            edge_text=QColor("#7a756e"),
            derived=QColor("#8a63c9"),
        )


class StateItem(QGraphicsItem):
    """一个状态节点。焦点=蓝框，当前激活=绿框，其余=素框。"""

    def __init__(
        self,
        node: StateNode,
        palette: GraphPalette,
        *,
        is_focus: bool,
        is_live: bool,
        has_savepoint: bool,
    ) -> None:
        super().__init__()
        self.node = node
        self.palette = palette
        self.is_focus = is_focus
        self.is_live = is_live
        self.has_savepoint = has_savepoint
        self.setAcceptHoverEvents(True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setToolTip(
            f"{node.display}\n图：{node.graph_label}\nid：{node.graph_id}.{node.state_id}"
            + ("\n（有存档点，双击回到这儿）" if has_savepoint else "")
        )
        self._hover = False

    def boundingRect(self) -> QRectF:
        return QRectF(-NODE_W / 2 - 3, -NODE_H / 2 - 3, NODE_W + 6, NODE_H + 6)

    def hoverEnterEvent(self, event) -> None:  # noqa: ANN001
        self._hover = True
        self.update()
        super().hoverEnterEvent(event)

    def hoverLeaveEvent(self, event) -> None:  # noqa: ANN001
        self._hover = False
        self.update()
        super().hoverLeaveEvent(event)

    def paint(self, painter: QPainter, option: QStyleOptionGraphicsItem, widget: QWidget | None = None) -> None:
        del option, widget
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        rect = QRectF(-NODE_W / 2, -NODE_H / 2, NODE_W, NODE_H)
        p = self.palette

        if self.is_focus:
            fill, line, width = p.focus_fill, p.focus, 2.4
        elif self.is_live:
            fill, line, width = p.live_fill, p.live, 2.0
        else:
            fill, line, width = p.node, p.border, 1.0
        if self._hover:
            line = p.focus

        painter.setBrush(QBrush(fill))
        painter.setPen(QPen(line, width))
        painter.drawRoundedRect(rect, 9, 9)

        if self.has_savepoint:
            painter.setBrush(QBrush(p.live))
            painter.setPen(Qt.PenStyle.NoPen)
            painter.drawEllipse(QPointF(NODE_W / 2 - 11, -NODE_H / 2 + 11), 3.6, 3.6)

        title = QFont()
        title.setPointSizeF(10.5)
        title.setBold(self.is_focus or self.is_live)
        painter.setFont(title)
        painter.setPen(QPen(p.node_text))
        painter.drawText(
            QRectF(-NODE_W / 2 + 11, -NODE_H / 2 + 6, NODE_W - 26, 20),
            int(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter),
            _elide(self.node.display, 13),
        )

        sub = QFont()
        sub.setPointSizeF(8.5)
        painter.setFont(sub)
        painter.setPen(QPen(p.node_sub))
        painter.drawText(
            QRectF(-NODE_W / 2 + 11, 0, NODE_W - 22, 20),
            int(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter),
            _elide(self.node.graph_label, 17),
        )


class EdgeItem(QGraphicsItem):
    """一条因果边。实线=同图迁移，虚线=跨图信号派生。"""

    def __init__(
        self,
        src: QPointF,
        dst: QPointF,
        label: str,
        derived: bool,
        palette: GraphPalette,
        label_at: float = 0.5,
    ) -> None:
        super().__init__()
        self.setZValue(-1)
        self._src = src
        self._dst = dst
        self._label = label
        self._derived = derived
        self._palette = palette
        self._label_at = min(0.78, max(0.28, label_at))
        self._path = self._build_path()
        if label:
            self.setToolTip(label)

    def _build_path(self) -> QPainterPath:
        path = QPainterPath(self._src)
        dx = self._dst.x() - self._src.x()
        ctrl = max(40.0, abs(dx) * 0.45)
        path.cubicTo(
            QPointF(self._src.x() + ctrl, self._src.y()),
            QPointF(self._dst.x() - ctrl, self._dst.y()),
            self._dst,
        )
        return path

    def boundingRect(self) -> QRectF:
        return self._path.boundingRect().adjusted(-70, -34, 70, 34)

    def paint(self, painter: QPainter, option: QStyleOptionGraphicsItem, widget: QWidget | None = None) -> None:
        del option, widget
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        color = self._palette.derived if self._derived else self._palette.edge
        pen = QPen(color, 1.5)
        if self._derived:
            pen.setStyle(Qt.PenStyle.DashLine)
        painter.setPen(pen)
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawPath(self._path)

        # 箭头
        end = self._path.pointAtPercent(1.0)
        before = self._path.pointAtPercent(0.94)
        angle = math.atan2(end.y() - before.y(), end.x() - before.x())
        size = 7.0
        head = QPolygonF([
            end,
            QPointF(end.x() - size * math.cos(angle - 0.42), end.y() - size * math.sin(angle - 0.42)),
            QPointF(end.x() - size * math.cos(angle + 0.42), end.y() - size * math.sin(angle + 0.42)),
        ])
        painter.setBrush(QBrush(color))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawPolygon(head)

        if self._label:
            # 多条边挤在一起时标签会叠成一坨且切在同一处，还不如不写：
            # 按边的序号把标签沿路径错开，并给它一块底色压住穿过去的线。
            mid = self._path.pointAtPercent(self._label_at)
            font = QFont()
            font.setPointSizeF(8.0)
            painter.setFont(font)
            # 截到放得进两节点之间的空隙为止，并抬到节点上沿之上——
            # 否则标签会压在框上，两边的字互相盖住谁也读不了。
            text = _elide(self._label, LABEL_MAX_CHARS)
            metrics = painter.fontMetrics()
            width = min(metrics.horizontalAdvance(text) + 8, COL_GAP - NODE_W - 12)
            box = QRectF(mid.x() - width / 2, mid.y() - NODE_H / 2 - 17, width, 15)
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(QBrush(self._palette.bg))
            painter.drawRoundedRect(box, 3, 3)
            painter.setPen(QPen(self._palette.edge_text))
            painter.drawText(box, int(Qt.AlignmentFlag.AlignCenter), text)


class FocusGraphView(QGraphicsView):
    """焦点邻域画布。单击换焦点，双击请求跳到那一拍。"""

    focusRequested = Signal(str)
    jumpRequested = Signal(str)
    zoomChanged = Signal(float)

    def __init__(self, index: NarrativeIndex, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.index = index
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.palette_ = GraphPalette.for_dark(_is_dark(self))
        self.setBackgroundBrush(QBrush(self.palette_.bg))
        self._live_keys: set[str] = set()
        self._savepoint_keys: set[str] = set()
        self._focus = ""
        self._hops = 2
        self._last_signature: tuple | None = None
        # 手动缩过之后就别再自动重排比例。自动记点默认开着，每存一个点都会重绘一次，
        # 原先每次重绘都跑 fitInView，等于策划刚放大就被当场打回去——体感就是"不能缩放"。
        self._user_zoom = False

    def set_live_states(self, keys: set[str]) -> None:
        self._live_keys = set(keys)

    def set_savepoints(self, keys: set[str]) -> None:
        self._savepoint_keys = set(keys)

    def set_hops(self, hops: int) -> None:
        new_hops = max(1, min(4, hops))
        if new_hops == self._hops:
            return
        self._hops = new_hops
        if self._focus:
            self.render_focus(self._focus)

    @property
    def hops(self) -> int:
        return self._hops

    @property
    def focus_key(self) -> str:
        return self._focus

    def render_focus(self, focus_key: str, *, force: bool = False) -> None:
        # 重建整张 scene 不算贵（几十个 item），但状态推进时一次排空会连发多条
        # state.changed，画面没变化就别重画——省的是肉眼可见的闪烁，不只是 CPU。
        signature = (focus_key, self._hops, frozenset(self._live_keys), frozenset(self._savepoint_keys))
        if not force and signature == self._last_signature:
            return
        self._last_signature = signature
        self._focus = focus_key
        self._scene.clear()
        if not focus_key:
            self._draw_placeholder("等游戏连上，或从左边点一拍")
            return
        hood = self.index.neighborhood(focus_key, self._hops)
        if not hood.nodes:
            self._draw_placeholder("这个状态不在当前数据里")
            return
        positions = self._layout(hood)
        fan: dict[str, int] = {}
        for a, b, label, derived in hood.edges:
            if a not in positions or b not in positions:
                continue
            src = positions[a] + QPointF(NODE_W / 2, 0)
            dst = positions[b] - QPointF(NODE_W / 2, 0)
            seat = fan.get(a, 0)
            fan[a] = seat + 1
            self._scene.addItem(
                EdgeItem(
                    src,
                    dst,
                    _edge_label(self.index, label),
                    derived,
                    self.palette_,
                    label_at=0.42 + 0.13 * (seat % 3),
                )
            )
        for key, node in hood.nodes.items():
            item = StateItem(
                node,
                self.palette_,
                is_focus=key == focus_key,
                is_live=key in self._live_keys and key != focus_key,
                has_savepoint=key in self._savepoint_keys,
            )
            item.setPos(positions[key])
            item.setData(0, key)
            self._scene.addItem(item)
        rect = self._scene.itemsBoundingRect().adjusted(-50, -40, 50, 40)
        self._scene.setSceneRect(rect)
        self._apply_auto_scale(positions[focus_key])

    def _content_rect(self) -> QRectF:
        return self._scene.sceneRect()

    def _fit_scale(self) -> float:
        """整张图完整塞进视口所需的比例。"""
        rect = self._content_rect()
        if rect.isEmpty():
            return 1.0
        vp = self.viewport().size()
        return min(vp.width() / rect.width(), vp.height() / rect.height())

    def _auto_scale(self) -> float:
        """整图放得下就按放得下的比例，图小就放大吃满，但一律不低于 1:1。

        试过"横向反正要拖，那就按高度铺满换更大的字"——145% 一上，焦点两边的邻居全被
        挤出画面。而这一栏的命就是"前后是哪儿"，字大到看不见邻居等于把功能换掉了。
        竖向那点余白认了，想更大有 ＋ 按钮，且缩放会一直粘着。
        """
        return min(MAX_FIT_SCALE, max(self._fit_scale(), PREFERRED_SCALE))

    def _apply_auto_scale(self, center: QPointF | None = None) -> None:
        """自动比例：至少 1:1（保证读得清），图小就放大到把地方吃满。

        手动缩放过就一概不动——重绘不该把人的视角推回去。
        """
        if self._user_zoom:
            if center is not None:
                self.centerOn(center)
            return
        target = self._auto_scale()
        self.resetTransform()
        self.scale(target, target)
        if center is not None:
            self.centerOn(center)
        self.zoomChanged.emit(target)

    # ---- 缩放 ---------------------------------------------------------

    @property
    def zoom(self) -> float:
        return self.transform().m11()

    def zoom_by(self, factor: float) -> None:
        target = max(ZOOM_MIN, min(ZOOM_MAX, self.zoom * factor))
        if abs(target - self.zoom) < 1e-4:
            return
        self._user_zoom = True
        self.resetTransform()
        self.scale(target, target)
        self.zoomChanged.emit(target)

    def zoom_actual(self) -> None:
        """1:1——节点按设计尺寸画，字最清楚。"""
        self._user_zoom = True
        self.resetTransform()
        self.zoomChanged.emit(1.0)

    def zoom_fit(self) -> None:
        """整图塞进视口，并把"手动缩放"解除，之后重绘重新自动排比例。"""
        self._user_zoom = False
        rect = self._content_rect()
        if not rect.isEmpty():
            self.fitInView(rect, Qt.AspectRatioMode.KeepAspectRatio)
        scale = min(ZOOM_MAX, max(ZOOM_MIN, self.zoom))
        self.resetTransform()
        self.scale(scale, scale)
        if self._focus:
            self.centerOn(self._scene.itemsBoundingRect().center())
        self.zoomChanged.emit(scale)

    def resizeEvent(self, event) -> None:  # noqa: ANN001
        # 图区现在会跟着窗口长高变宽（不再被 460px 的上限焊死），比例得跟着重排，
        # 否则拉大窗口只是多出一圈空白。
        super().resizeEvent(event)
        if not self._user_zoom and self._focus:
            self._apply_auto_scale()

    def _layout(self, hood: Neighborhood) -> dict[str, QPointF]:
        """按跳数分列：左边是怎么走到这儿的，右边是接下来会去哪。

        刻意**不折行**：拍子线基本都是一条链，折行会让"上一行末尾→下一行开头"
        那条边变成一根横穿整块空白的长对角线，比一条读得懂的长带更难看。
        长了就横向拖——图区高度会跟着内容收，省下的地方留给下面「在等什么」。
        """
        columns: dict[int, list[str]] = {}
        for key, depth in hood.depth.items():
            columns.setdefault(depth, []).append(key)
        positions: dict[str, QPointF] = {}
        for depth, keys in columns.items():
            keys.sort(key=lambda k: hood.nodes[k].display)
            span = (len(keys) - 1) * ROW_GAP
            for i, key in enumerate(keys):
                positions[key] = QPointF(depth * COL_GAP, i * ROW_GAP - span / 2)
        return positions

    def _draw_placeholder(self, text: str) -> None:
        item = self._scene.addText(text)
        item.setDefaultTextColor(self.palette_.node_sub)
        self._scene.setSceneRect(item.boundingRect().adjusted(-40, -40, 40, 40))

    # ---- 交互 ---------------------------------------------------------

    def mousePressEvent(self, event) -> None:  # noqa: ANN001
        item = self.itemAt(event.pos())
        key = _item_key(item)
        if key and key != self._focus:
            self.focusRequested.emit(key)
            return
        super().mousePressEvent(event)

    def mouseDoubleClickEvent(self, event) -> None:  # noqa: ANN001
        key = _item_key(self.itemAt(event.pos()))
        if key:
            self.jumpRequested.emit(key)
            return
        super().mouseDoubleClickEvent(event)

    def wheelEvent(self, event: QWheelEvent) -> None:
        if event.modifiers() & Qt.KeyboardModifier.ControlModifier:
            self.zoom_by(1.15 if event.angleDelta().y() > 0 else 1 / 1.15)
            event.accept()
            return
        super().wheelEvent(event)


def _item_key(item: QGraphicsItem | None) -> str:
    while item is not None:
        data = item.data(0)
        if isinstance(data, str) and data:
            return data
        item = item.parentItem()
    return ""


def _edge_label(index: NarrativeIndex, signal: str) -> str:
    from tools.narrative_debugger.humanize import signal_phrase

    what, _ = signal_phrase(index, signal)
    return what


def _elide(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _is_dark(widget: QWidget) -> bool:
    color = widget.palette().window().color()
    return (color.red() * 299 + color.green() * 587 + color.blue() * 114) / 1000 < 128
