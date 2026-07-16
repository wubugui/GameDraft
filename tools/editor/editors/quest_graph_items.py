"""Custom QGraphicsItem subclasses for the hierarchical quest graph."""
from __future__ import annotations

import math
from PySide6.QtWidgets import QGraphicsRectItem, QGraphicsPathItem, QGraphicsTextItem, QGraphicsItem
from PySide6.QtCore import Qt, QRectF, QPointF
from PySide6.QtGui import QPen, QBrush, QColor, QFont, QFontMetricsF, QPainterPath

from .. import theme


def format_conditions(conditions: list[dict]) -> str:
    if not conditions:
        return ""
    parts: list[str] = []
    for c in conditions:
        flag = c.get("flag", "")
        if not flag:
            continue
        op = c.get("op", "==")
        val = c.get("value", True)
        if op == "==" and val is True:
            parts.append(flag)
        else:
            parts.append(f"{flag} {op} {val}")
    return " AND ".join(parts) if parts else ""


_GROUP_COLORS = {"main": QColor(50, 80, 140), "side": QColor(40, 120, 80)}
_NODE_COLOR = QColor(60, 80, 140)
_IMPLICIT_EDGE_COLOR = QColor(120, 120, 140, 160)
_EXPLICIT_EDGE_COLOR = QColor(100, 160, 255)
_FONT = "PingFang SC"
_MAX_NODE_WIDTH = 180.0


def _elided_text(item: QGraphicsTextItem, text: str, max_width: float) -> str:
    return QFontMetricsF(item.font()).elidedText(
        text,
        Qt.TextElideMode.ElideRight,
        int(max_width),
    )


class QuestGroupItem(QGraphicsRectItem):
    def __init__(self, group_data: dict, quest_count: int, x: float = 0, y: float = 0):
        self.group_data = group_data
        gtype = group_data.get("type", "main")
        color = _GROUP_COLORS.get(gtype, _GROUP_COLORS["main"])

        name = group_data.get("name", group_data["id"])
        tag = "[M]" if gtype == "main" else "[S]"
        display = f"{tag} {name}"

        super().__init__(0, 0, 140, 50)
        self.setPos(x, y)
        self.setBrush(QBrush(color))
        self.setPen(QPen(color.lighter(130), 2))
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges, True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setZValue(1)
        self.setToolTip(
            f"分组 {group_data['id']}\n{name}\n{quest_count} 个阶段（双击进入）",
        )

        # 编辑器侧档持久化用：稳定键 + 拖拽结束回调（由 scene 注入）。
        self.layout_key: str | None = None
        self.on_moved = None
        # 落盘门控基线（scene._attach_layout 注入）：release 时与当前 pos 比较，
        # 位置未真实变化（纯点击）不写侧档（审查 P0-1 ②）。
        self.layout_baseline: tuple[float, float] | None = None

        self._title_source = display
        self._title = QGraphicsTextItem(display, self)
        self._title.setDefaultTextColor(QColor("#FFFFFF"))
        theme.set_graphics_text_font(
            self._title,
            theme.FONT_ROLE_CANVAS_PRIMARY,
            family=_FONT,
            weight=QFont.Weight.Bold,
        )

        sub = f"{quest_count} 个阶段"
        self._sub_source = sub
        self._sub = QGraphicsTextItem(sub, self)
        self._sub.setDefaultTextColor(QColor(200, 200, 220))
        theme.set_graphics_text_font(
            self._sub,
            theme.FONT_ROLE_CANVAS_SECONDARY,
            family=_FONT,
        )

        self._edges: list = []
        self.refresh_editor_font()

    def refresh_editor_font(self) -> None:
        self._title.setPlainText(self._title_source)
        self._sub.setPlainText(self._sub_source)
        title_rect = self._title.boundingRect()
        sub_rect = self._sub.boundingRect()
        width = max(140.0, title_rect.width() + 30.0, sub_rect.width() + 30.0)
        title_y = 4.0
        sub_y = title_y + title_rect.height() + 2.0
        height = max(50.0, sub_y + sub_rect.height() + 4.0)
        self.setRect(0, 0, width, height)
        self._title.setPos((width - title_rect.width()) / 2, title_y)
        self._sub.setPos((width - sub_rect.width()) / 2, sub_y)

    def add_edge(self, edge: QuestEdgeItem) -> None:
        self._edges.append(edge)

    def center_pos(self) -> tuple[float, float]:
        r = self.rect()
        p = self.pos()
        return p.x() + r.width() / 2, p.y() + r.height() / 2

    def set_highlight(self, on: bool) -> None:
        color = _GROUP_COLORS.get(self.group_data.get("type", "main"), _GROUP_COLORS["main"])
        if on:
            self.setPen(QPen(QColor("#FFFFFF"), 3))
            self.setZValue(10)
        else:
            self.setPen(QPen(color.lighter(130), 2))
            self.setZValue(1)

    def itemChange(self, change, value):
        if change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged:
            for edge in self._edges:
                edge.update_path()
        return super().itemChange(change, value)

    def mouseReleaseEvent(self, event):
        super().mouseReleaseEvent(event)
        _notify_release(self)


class QuestNodeItem(QGraphicsRectItem):
    def __init__(self, quest_data: dict, x: float = 0, y: float = 0):
        self.quest_data = quest_data

        qid = quest_data.get("id", "?")
        title = quest_data.get("title", "")
        display_id = qid
        display_title = title

        color = _NODE_COLOR
        super().__init__(0, 0, 130, 44)
        self.setPos(x, y)
        self.setBrush(QBrush(color))
        self.setPen(QPen(color.darker(120), 1.5))
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)
        self.setFlag(QGraphicsItem.GraphicsItemFlag.ItemSendsGeometryChanges, True)
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setZValue(1)
        tip = f"任务 {qid}"
        if title:
            tip += f"\n{title}"
        qtype = quest_data.get("type")
        if qtype:
            tip += f"\n类型：{qtype}"
        self.setToolTip(tip)

        # 编辑器侧档持久化用：稳定键 + 拖拽结束回调（由 scene 注入）。
        self.layout_key: str | None = None
        self.on_moved = None
        # 落盘门控基线（scene._attach_layout 注入）：release 时与当前 pos 比较，
        # 位置未真实变化（纯点击）不写侧档（审查 P0-1 ②）。
        self.layout_baseline: tuple[float, float] | None = None

        self._id_source = f"[Q] {display_id}"
        self._id_text = QGraphicsTextItem(self._id_source, self)
        self._id_text.setDefaultTextColor(QColor("#FFFFFF"))
        theme.set_graphics_text_font(
            self._id_text,
            theme.FONT_ROLE_CANVAS_PRIMARY,
            family=_FONT,
        )

        self._node_title_source = display_title
        self._title_text = QGraphicsTextItem(display_title, self)
        self._title_text.setDefaultTextColor(QColor(200, 210, 230))
        theme.set_graphics_text_font(
            self._title_text,
            theme.FONT_ROLE_CANVAS_SECONDARY,
            family=_FONT,
        )

        self._edges: list = []
        self.refresh_editor_font()

    def refresh_editor_font(self) -> None:
        self._id_text.setPlainText(_elided_text(self._id_text, self._id_source, 160.0))
        self._title_text.setPlainText(_elided_text(self._title_text, self._node_title_source, 160.0))
        id_rect = self._id_text.boundingRect()
        title_rect = self._title_text.boundingRect()
        width = min(_MAX_NODE_WIDTH, max(130.0, id_rect.width() + 20.0, title_rect.width() + 20.0))
        id_y = 2.0
        title_y = id_y + id_rect.height() + 1.0
        height = max(44.0, title_y + title_rect.height() + 3.0)
        self.setRect(0, 0, width, height)
        self._id_text.setPos((width - id_rect.width()) / 2, id_y)
        self._title_text.setPos((width - title_rect.width()) / 2, title_y)

    def add_edge(self, edge: QuestEdgeItem) -> None:
        self._edges.append(edge)

    def center_pos(self) -> tuple[float, float]:
        r = self.rect()
        p = self.pos()
        return p.x() + r.width() / 2, p.y() + r.height() / 2

    def set_highlight(self, on: bool) -> None:
        if on:
            self.setPen(QPen(QColor("#FFFFFF"), 3))
            self.setZValue(10)
        else:
            self.setPen(QPen(_NODE_COLOR.darker(120), 1.5))
            self.setZValue(1)

    def itemChange(self, change, value):
        if change == QGraphicsItem.GraphicsItemChange.ItemPositionHasChanged:
            for edge in self._edges:
                edge.update_path()
        return super().itemChange(change, value)

    def mouseReleaseEvent(self, event):
        super().mouseReleaseEvent(event)
        _notify_release(self)


def _persist_layout_if_moved(item) -> None:
    """仅当节点位置相对基线（populate/上次落盘时的坐标）真实变化才写侧档。

    纯点击（press→release 零位移）绝不把自动布局坐标钉进侧档——否则每次点选
    都会污染 .editor/quest_graph_layout.json（审查 P0-1 ②，现存侧档 [0,0] 化石
    即此路径产物）。"""
    cb = getattr(item, "on_moved", None)
    key = getattr(item, "layout_key", None)
    if cb is None or not key:
        return
    p = item.pos()
    cur = (float(p.x()), float(p.y()))
    baseline = getattr(item, "layout_baseline", None)
    if baseline is not None and tuple(baseline) == cur:
        return
    item.layout_baseline = cur
    try:
        cb(key, cur[0], cur[1])
    except Exception:
        # 持久化失败绝不影响交互
        pass


def _notify_release(item) -> None:
    """拖拽结束的持久化入口：多选拖动时只有被抓取项收到 release，须把随之移动的
    其它选中项一并持久化（审查 P0-1 ③）；每项各自按「位置真实变化」门控。"""
    _persist_layout_if_moved(item)
    scene = item.scene()
    if scene is None:
        return
    for it in scene.selectedItems():
        if it is item:
            continue
        _persist_layout_if_moved(it)


class QuestEdgeItem(QGraphicsPathItem):
    def __init__(
        self,
        src_item: QuestGroupItem | QuestNodeItem,
        dst_item: QuestGroupItem | QuestNodeItem,
        conditions: list[dict] | None = None,
        implicit: bool = False,
        bypass: bool = False,
    ):
        super().__init__()
        self.src_item = src_item
        self.dst_item = dst_item
        self.conditions = conditions or []
        self.implicit = implicit
        self.bypass = bypass

        color = _IMPLICIT_EDGE_COLOR if implicit else _EXPLICIT_EDGE_COLOR
        pen = QPen(color, 1.8)
        if implicit:
            pen.setStyle(Qt.PenStyle.DashLine)
            pen.setWidthF(1.2)
        self.setPen(pen)
        self.setZValue(0)

        label = format_conditions(self.conditions)
        if bypass and not implicit:
            label = f"{label} [bypass]" if label else "[bypass]"
        if implicit and not label:
            label = "(precond)"
        self._label = QGraphicsTextItem(label, self)
        self._label.setDefaultTextColor(color.lighter(140) if not implicit else QColor(160, 160, 180))
        theme.set_graphics_text_font(
            self._label,
            theme.FONT_ROLE_CANVAS_MICRO,
            family=_FONT,
        )

        cond_text = format_conditions(self.conditions)
        tip_lines = ["前置依赖（隐式）" if implicit else "解锁连边"]
        tip_lines.append(f"条件：{cond_text}" if cond_text else "条件：无")
        if bypass:
            tip_lines.append("bypass：满足条件即可绕过前置")
        self.setToolTip("\n".join(tip_lines))

        src_item.add_edge(self)
        dst_item.add_edge(self)
        self.update_path()

    def refresh_editor_font(self) -> None:
        self.update_path()

    def update_path(self) -> None:
        sx, sy = self.src_item.center_pos()
        dx, dy = self.dst_item.center_pos()

        path = QPainterPath()
        path.moveTo(sx, sy)

        mid_x = (sx + dx) / 2
        mid_y = (sy + dy) / 2

        if abs(dx - sx) > abs(dy - sy):
            cx1, cy1 = mid_x, sy
            cx2, cy2 = mid_x, dy
        else:
            cx1, cy1 = sx, mid_y
            cx2, cy2 = dx, mid_y

        path.cubicTo(cx1, cy1, cx2, cy2, dx, dy)

        t = 0.5
        bx = (1-t)**3*sx + 3*(1-t)**2*t*cx1 + 3*(1-t)*t**2*cx2 + t**3*dx
        by = (1-t)**3*sy + 3*(1-t)**2*t*cy1 + 3*(1-t)*t**2*cy2 + t**3*dy

        lr = self._label.boundingRect()
        self._label.setPos(bx - lr.width() / 2, by - lr.height() - 2)

        arrow_size = 8
        angle = math.atan2(dy - cy2, dx - cx2) if (dx != cx2 or dy != cy2) else math.atan2(dy - sy, dx - sx)
        p1 = QPointF(
            dx - arrow_size * math.cos(angle - math.pi / 6),
            dy - arrow_size * math.sin(angle - math.pi / 6),
        )
        p2 = QPointF(
            dx - arrow_size * math.cos(angle + math.pi / 6),
            dy - arrow_size * math.sin(angle + math.pi / 6),
        )
        path.moveTo(dx, dy)
        path.lineTo(p1)
        path.moveTo(dx, dy)
        path.lineTo(p2)

        self.setPath(path)

    def set_highlight(self, on: bool) -> None:
        color = _IMPLICIT_EDGE_COLOR if self.implicit else _EXPLICIT_EDGE_COLOR
        if on:
            self.setPen(QPen(color.lighter(150), 2.5))
            self.setZValue(5)
        else:
            pen = QPen(color, 1.8)
            if self.implicit:
                pen.setStyle(Qt.PenStyle.DashLine)
                pen.setWidthF(1.2)
            self.setPen(pen)
            self.setZValue(0)
