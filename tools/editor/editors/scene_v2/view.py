"""画布视图 —— 把 Document 的数据投影成图元，并把输入转给当前工具。

镜像 Tiled 的 `MapScene` / `MapItem`。三条结构性质：

1. **一本账**：``_items[(ref, part)] → 图元``。增删由变更事件驱动，不由手势代码
   顺手做。老画布"这一族有哪些图元"手写了三遍且互相不同步，正是精灵藏不掉的根因。

2. **`_sync_entity()` 是唯一的图元同步出口**，而且**显隐是它的最后一行**。
   老画布的显隐是一个"需要记得调"的独立函数，于是任何重建路径都可能把过滤结论
   冲掉（"藏起来的实体刷新一次就冒回来半个"）。这里它不是一个可以忘的步骤，
   而是同步的收尾。

3. **视图不写数据**。它只读 Document，输入一律转给 `ToolManager`。
"""
from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QPainter
from PySide6.QtWidgets import QGraphicsScene, QGraphicsView

from ..scene_canvas_model import iter_part_keys
from .changes import (
    EntitiesAboutToBeRemoved,
    EntitiesAdded,
    EntitiesChanged,
    EntitiesRemoved,
    EntityProperty,
    EntityRef,
    SceneReloaded,
    SelectionChanged,
    ViewFiltersChanged,
)
from .content_items import DisplayImageItem, SpritePreviewItem
from .entity_items import HandleItem, PolygonItem, PolylineItem
from .items import CanvasItem, EntityItem
from .overlays import GroupBoxItem, PerspectiveAxisItem, RubberBandItem
from .renderer import SceneRenderer
from .tools import ToolManager

__all__ = ["SceneView"]

#: 每个实体族在新画布上要建哪些 part 的图元。
#: 键取自 `scene_canvas_model.PART_TABLE`（那张表是"一个实体有哪些图元"的唯一真相），
#: 这里只声明**新画布已经实现**的那几种，未实现的 part 不建图元、也不报错。
_PART_ITEM_FACTORY = {
    ("hotspot", "handle"): HandleItem,
    ("hotspot", "display"): DisplayImageItem,
    ("hotspot", "collision"): PolygonItem,
    ("npc", "handle"): HandleItem,
    ("npc", "collision"): PolygonItem,
    ("npc", "patrol"): PolylineItem,
    ("npc", "sprite"): SpritePreviewItem,
    ("zone", "polygon"): PolygonItem,
    ("spawn", "handle"): HandleItem,
}

#: 内容层 part（前后关系按运行时规则排，不是固定层）
_CONTENT_PARTS = {("hotspot", "display"), ("npc", "sprite")}


class SceneView(QGraphicsView):
    """场景画布。**只读 Document、只转发输入**。"""

    #: 鼠标世界坐标变化（状态栏用）
    cursor_world_moved = Signal(QPointF)

    def __init__(self, document, parent=None) -> None:
        super().__init__(parent)
        self._doc = document
        self._gfx = QGraphicsScene(self)
        self.setScene(self._gfx)
        self.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)
        # 图元不吃鼠标，橡皮筋由 SelectTool 自己画 —— 不用 Qt 的 RubberBandDrag，
        # 那会与工具的手势语义打架（谁先收到 release 不确定）。
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setMouseTracking(True)

        self.renderer = SceneRenderer(1.0)
        self.tools = ToolManager(self)

        #: **一本账**：(ref, part) → 图元
        self._items: dict[tuple[EntityRef, str], EntityItem] = {}
        #: 视图轴（纯视图，不改数据）。判定沿用老画布已验证的那套语义。
        self._presence_filter = None
        #: ``url -> QPixmap | None``。视图**不读盘**，路径解析归宿主。
        self._texture_provider = None
        #: 覆盖物（分组框 / 透视轴 / 橡皮筋）。它们不进图元账，也不进命中白名单。
        self._group_boxes: dict[str, GroupBoxItem] = {}
        self._persp_axis = PerspectiveAxisItem()
        self._gfx.addItem(self._persp_axis)
        self._persp_axis.setVisible(False)
        self._band = RubberBandItem()
        self._gfx.addItem(self._band)
        self._band.setVisible(False)

        self._doc.changed.connect(self._on_document_changed)
        self.rebuild_all()

    # ---- 账本查询 ----------------------------------------------------------

    def item_for(self, ref: EntityRef, part: str = "handle") -> EntityItem | None:
        return self._items.get((ref, part))

    def items_of(self, ref: EntityRef) -> list[EntityItem]:
        return [it for (r, _p), it in self._items.items() if r == ref]

    def entity_items(self) -> list[EntityItem]:
        return list(self._items.values())

    # ---- 变更事件分发（唯一入口）------------------------------------------

    def _on_document_changed(self, event) -> None:
        if isinstance(event, SceneReloaded):
            self.rebuild_all()
        elif isinstance(event, EntitiesAdded):
            for ref in event.refs:
                self._sync_entity(ref)
        elif isinstance(event, EntitiesChanged):
            for ref in event.refs:
                self._sync_entity(ref, event.properties)
        elif isinstance(event, EntitiesAboutToBeRemoved):
            # **指针还活着时**清引用：图元真正删除放在 Removed，此刻只解除关联
            for ref in event.refs:
                self._detach_hover_and_active(ref)
        elif isinstance(event, EntitiesRemoved):
            for ref in event.refs:
                self._drop_entity(ref)
        elif isinstance(event, SelectionChanged):
            self._apply_selection(event.refs)
        elif isinstance(event, ViewFiltersChanged):
            for ref in list({r for r, _p in self._items}):
                self._apply_presence(ref)

    # ---- 图元同步（唯一出口）----------------------------------------------

    def rebuild_all(self) -> None:
        """整份重建。切场景 / 撤销回灌 / 外部重载走这里。

        只清**实体图元**，覆盖物（透视轴 / 橡皮筋 / 分组框）保留 ——
        `QGraphicsScene.clear()` 会连它们一起析构，之后任何引用都是野指针。
        """
        for key in list(self._items):
            item = self._items.pop(key)
            if item.scene() is self._gfx:
                self._gfx.removeItem(item)
        for kind in ("zone", "hotspot", "npc", "spawn"):
            for ref in self._doc.entity_refs(kind):
                self._sync_entity(ref)
        self._apply_selection(self._doc.selection)
        self._update_scene_rect()

    def _sync_entity(self, ref: EntityRef, properties=EntityProperty.ALL) -> None:
        """把一个实体的全部 part 图元同步到当前数据。

        **显隐是最后一行，不是一个可以忘记调用的独立步骤** —— 这是"重建丢显隐"
        那一族 bug 在新架构里没有发生余地的原因。
        """
        ent = self._doc.entity(ref)
        if ent is None:
            self._drop_entity(ref)
            return
        for part, _key in iter_part_keys(ref.kind, ref.id):
            factory = _PART_ITEM_FACTORY.get((ref.kind, part))
            if factory is None:
                continue
            self._sync_part(ref, part, factory, ent, properties)
        self._apply_presence(ref)

    def _sync_part(self, ref, part, factory, ent, properties) -> None:
        item = self._items.get((ref, part))
        if (ref.kind, part) in _CONTENT_PARTS:
            self._sync_content_part(ref, part, factory, ent)
            return
        pts = self._part_points(ref.kind, part, ent)
        if part in ("collision", "patrol") and not pts:
            # 数据门：没有多边形/路线就不该有图元（不是"藏起来"，是不存在）
            self._drop_part(ref, part)
            return
        if item is None:
            item = factory(ref)
            self._gfx.addItem(item)
            self._items[(ref, part)] = item
            self._push_view_scale(item)
        if isinstance(item, HandleItem):
            item.setPos(float(ent.get("x", 0) or 0), float(ent.get("y", 0) or 0))
            if properties & (EntityProperty.BEHAVIOUR | EntityProperty.TRANSFORM
                             | EntityProperty.ALL):
                item.set_interaction_range(float(ent.get("interactionRange", 0) or 0))
        else:
            item.set_points(pts)

    def _sync_content_part(self, ref, part, factory, ent) -> None:
        """内容 part（展示图 / 精灵）的同步。

        贴图由宿主经 `set_texture_provider` 注入 —— 视图**不读盘**：读盘要经
        ProjectModel 的路径解析，那是宿主的事；视图只管画。没有 provider 时
        画占位框，且 `texture_loaded` 为 False（与运行时"没有 displaySprite"同口径）。
        """
        spec = self._content_spec(ref.kind, ent)
        if spec is None:
            self._drop_part(ref, part)
            return
        item = self._items.get((ref, part))
        if item is None:
            item = factory(ref)
            self._gfx.addItem(item)
            self._items[(ref, part)] = item
        anchor, w, h, facing, scale, rot, url = spec
        item.setPos(anchor)
        item.set_geometry(QPointF(0, 0), w, h, scale=scale, rotation=rot, facing=facing)
        if self._texture_provider is not None:
            item.set_pixmap(self._texture_provider(url))
        else:
            item.set_pixmap(None)

    @staticmethod
    def _content_spec(kind: str, ent: dict):
        """内容 part 的几何与贴图来源；没有内容返回 None。"""
        if kind != "hotspot":
            return None
        di = ent.get("displayImage")
        if not isinstance(di, dict):
            return None
        url = str(di.get("image", "") or "").strip()
        try:
            w = float(di.get("worldWidth", 0) or 0)
            h = float(di.get("worldHeight", 0) or 0)
        except (TypeError, ValueError):
            return None
        if not url or w <= 0 or h <= 0:
            return None
        facing = -1 if str(di.get("facing", "")).strip().lower() == "left" else 1
        return (
            QPointF(float(ent.get("x", 0) or 0), float(ent.get("y", 0) or 0)),
            w, h, facing,
            float(ent.get("scale", 1.0) or 1.0),
            float(ent.get("rotation", 0.0) or 0.0),
            url,
        )

    # ---- 覆盖物 ------------------------------------------------------------

    @property
    def perspective_axis(self) -> PerspectiveAxisItem:
        return self._persp_axis

    @property
    def rubber_band(self) -> RubberBandItem:
        return self._band

    @property
    def group_boxes(self) -> dict:
        return dict(self._group_boxes)

    def sync_group_boxes(self, rows) -> None:
        """按 ``[(gid, rect, title), ...]`` 重建分组框。差集回收，不整批重建 ——
        重建会丢掉选中态，而组的选中态不在 Qt 选择系统里、丢了就回不来。"""
        wanted = {}
        for gid, rect, title in rows:
            box = self._group_boxes.get(gid)
            if box is None:
                box = GroupBoxItem(gid)
                self._gfx.addItem(box)
                self._group_boxes[gid] = box
                box.set_view_scale(self.renderer.view_scale)
            box.set_geometry(rect, title)
            wanted[gid] = box
        for gid in [g for g in self._group_boxes if g not in wanted]:
            box = self._group_boxes.pop(gid)
            if box.scene() is self._gfx:
                self._gfx.removeItem(box)

    def sync_perspective_axis(self, near, far) -> None:
        self._persp_axis.set_axis(near, far)

    def set_texture_provider(self, provider) -> None:
        """注入 ``url -> QPixmap | None``。视图不读盘，路径解析归宿主。"""
        self._texture_provider = provider
        for (ref, part) in list(self._items):
            if (ref.kind, part) in _CONTENT_PARTS:
                self._sync_entity(ref)

    def _part_points(self, kind: str, part: str, ent: dict):
        if part == "polygon":
            return ent.get("polygon") or []
        if part == "collision":
            return self._collision_world_points(ent)
        if part == "patrol":
            patrol = ent.get("patrol")
            return (patrol or {}).get("route") or [] if isinstance(patrol, dict) else []
        return []

    @staticmethod
    def _collision_world_points(ent: dict):
        """碰撞面画在**世界坐标**里。加载期迁移保证了它一定是局部坐标，
        所以这里只做"锚点 + 局部值"，不再有第二个分支。"""
        poly = ent.get("collisionPolygon")
        if not isinstance(poly, list) or len(poly) < 3:
            return []
        x0 = float(ent.get("x", 0) or 0)
        y0 = float(ent.get("y", 0) or 0)
        return [{"x": x0 + float(p.get("x", 0)), "y": y0 + float(p.get("y", 0))}
                for p in poly if isinstance(p, dict)]

    def _drop_part(self, ref: EntityRef, part: str) -> None:
        item = self._items.pop((ref, part), None)
        if item is not None and item.scene() is self._gfx:
            self._gfx.removeItem(item)

    def _drop_entity(self, ref: EntityRef) -> None:
        for part, _key in iter_part_keys(ref.kind, ref.id):
            self._drop_part(ref, part)

    def _detach_hover_and_active(self, ref: EntityRef) -> None:
        for item in self.items_of(ref):
            item.set_hovered(False)

    # ---- 选中态与视图过滤 --------------------------------------------------

    def _apply_selection(self, refs) -> None:
        chosen = set(refs)
        for (ref, _part), item in self._items.items():
            item.set_selected(ref in chosen)

    def set_presence_filter(self, predicate) -> None:
        """注入"这个实体现在该不该显示"的判定。``None`` = 全部显示。

        判定本身不在视图里 —— 它是数据语义（位面 ∧ 时段 ∧ 过场），
        由宿主按老画布已验证的那套口径提供。视图只负责**落到每一个 part 上**。
        """
        self._presence_filter = predicate
        for ref in list({r for r, _p in self._items}):
            self._apply_presence(ref)

    def _apply_presence(self, ref: EntityRef) -> None:
        if self._presence_filter is None:
            visible = True
        else:
            ent = self._doc.entity(ref)
            visible = True if ent is None else bool(self._presence_filter(ref, ent))
        for item in self.items_of(ref):
            item.setVisible(visible)

    # ---- 缩放 --------------------------------------------------------------

    def _push_view_scale(self, item=None) -> None:
        scale = self.transform().m11() or 1.0
        self.renderer.set_view_scale(scale)
        if item is not None:
            targets = [item]
        else:
            targets = [*self._items.values(), *self._group_boxes.values(),
                       self._persp_axis]
        for it in targets:
            setter = getattr(it, "set_view_scale", None)
            if callable(setter):
                setter(scale)

    def _update_scene_rect(self) -> None:
        sc = self._doc.scene() or {}
        try:
            w = float(sc.get("worldWidth", 0) or 0)
            h = float(sc.get("worldHeight", 0) or 0)
        except (TypeError, ValueError):
            w = h = 0.0
        if w > 0 and h > 0:
            self._gfx.setSceneRect(QRectF(0, 0, w, h))

    def fit_scene(self) -> None:
        rect = self._gfx.sceneRect()
        if rect.width() > 0 and rect.height() > 0:
            self.fitInView(rect, Qt.AspectRatioMode.KeepAspectRatio)
            self._push_view_scale()

    def zoom_by(self, factor: float) -> None:
        cur = self.transform().m11()
        new = cur * float(factor)
        if new < 0.02 or new > 20.0:
            return
        self.scale(factor, factor)
        self._push_view_scale()

    # ---- 输入转发（一律交给当前工具）--------------------------------------

    def _world(self, event) -> QPointF:
        return self.mapToScene(event.position().toPoint())

    def mousePressEvent(self, event) -> None:
        pos = self._world(event)
        if self.tools.mouse_pressed(pos, event.button(), event.modifiers()):
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        pos = self._world(event)
        self.cursor_world_moved.emit(pos)
        if self.tools.mouse_moved(pos, event.buttons(), event.modifiers()):
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        pos = self._world(event)
        if self.tools.mouse_released(pos, event.button(), event.modifiers()):
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event) -> None:
        pos = self._world(event)
        if self.tools.mouse_double_clicked(pos, event.button(), event.modifiers()):
            event.accept()
            return
        super().mouseDoubleClickEvent(event)

    def keyPressEvent(self, event) -> None:
        if self.tools.key_pressed(event.key(), event.modifiers()):
            event.accept()
            return
        super().keyPressEvent(event)

    def wheelEvent(self, event) -> None:
        if not (event.modifiers() & Qt.KeyboardModifier.ControlModifier):
            d = event.angleDelta()
            self.horizontalScrollBar().setValue(
                self.horizontalScrollBar().value() - d.x())
            self.verticalScrollBar().setValue(
                self.verticalScrollBar().value() - d.y())
            event.accept()
            return
        self.zoom_by(1.15 if event.angleDelta().y() > 0 else 1 / 1.15)
        event.accept()
