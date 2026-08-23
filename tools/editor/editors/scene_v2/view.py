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

from ...shared.scene_migrations import collision_polygon_local_to_world
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
from .content_items import BackgroundItem, DisplayImageItem, SpritePreviewItem
from .entity_items import HandleItem, PolygonItem, PolylineItem
from .light_curve import light_curve_points
from .items import CanvasItem, EntityItem
from .overlays import (
    GroupBoxItem,
    PerspectiveAxisItem,
    RubberBandItem,
    TransformGizmoItem,
)
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

#: **场景级** part —— 它们不挂在任何实体上，而是场景自己的几何
#: （光环境曲线；透视轴与分组框走独立的覆盖物通道）。
#: 用 `EntityRef("scene", <scene_id>)` 做键，于是它们与实体几何共用同一套
#: 命令 / 撤销 / 顶点编辑工具，不必另起一条平行实现。
_SCENE_PARTS = {"lightcurve": PolylineItem}


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
        # **没有这一行，键盘一个事件都收不到。** 方向键微移 / Delete / Ctrl+D
        # 全走 `keyPressEvent`，而 `QGraphicsView` 默认不接受点击取焦。
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

        #: **一本账**：(ref, part) → 图元
        self._items: dict[tuple[EntityRef, str], EntityItem] = {}
        #: 视图轴（纯视图，不改数据）。判定沿用老画布已验证的那套语义。
        self._presence_filter = None
        #: ``url -> QPixmap | None``。视图**不读盘**，路径解析归宿主。
        self._texture_provider = None
        #: ``npc_dict -> (world_w, world_h, texture_url) | None``。
        #: 精灵尺寸住在动画包里，不在场景 JSON 里 —— 同样归宿主。
        self._sprite_metrics = None
        #: 覆盖物（分组框 / 透视轴 / 橡皮筋）。它们不进图元账，也不进命中白名单。
        self._group_boxes: dict[str, GroupBoxItem] = {}
        self._persp_axis = PerspectiveAxisItem()
        self._gfx.addItem(self._persp_axis)
        self._persp_axis.setVisible(False)
        self._band = RubberBandItem()
        self._gizmo = TransformGizmoItem()
        self._preview_refs: set = set()
        self._preview_transform = None
        self._gfx.addItem(self._band)
        self._band.setVisible(False)
        self._gfx.addItem(self._gizmo)
        # 切工具要重画预览：gizmo 只属于变换工具，切走必须收掉，
        # 否则手柄留在画面上、点它却没有任何工具接管。
        self.tools.tool_changed.connect(lambda _t: self.refresh_gesture_preview())
        self._background = BackgroundItem()
        self._gfx.addItem(self._background)

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
        self._dispatch_change(event)
        # gizmo 挂在"当前选中 + 当前变换"上，选择变了、旋转角变了都要重画。
        # 放在分发之后统一刷一次，而不是散在各分支里 —— 散着写就一定会漏一支
        # （老画布的 gizmo 正是"选择变了才刷"，撤销一次旋转后手柄留在旧角度）。
        self.refresh_gesture_preview()

    def _dispatch_change(self, event) -> None:
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
        # **场景级图元（光环境曲线）也要建。** 它不在任何 `entity_refs` 里，
        # 漏掉的话它只在"收到一次 scene 变更事件"之后才凭空出现 —— 也就是
        # 打开场景时根本看不见、也编辑不了，而单测若直接调 `_sync_entity`
        # 就完全测不出来（本条正是这么漏过一轮的）。
        self._sync_entity(EntityRef("scene", self._doc.scene_id))
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
        if ref.kind == "scene":
            for part, factory in _SCENE_PARTS.items():
                self._sync_part(ref, part, factory, ent, properties)
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
        if part in ("collision", "patrol", "lightcurve") and not pts:
            # 数据门：没有多边形/路线就不该有图元（不是"藏起来"，是不存在）
            self._drop_part(ref, part)
            return
        if item is None:
            item = factory(ref)
            self._gfx.addItem(item)
            self._items[(ref, part)] = item
            self._push_view_scale(item)
        if isinstance(item, HandleItem):
            item.set_base_pos(float(ent.get("x", 0) or 0), float(ent.get("y", 0) or 0))
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
        item.set_base_pos(anchor.x(), anchor.y())
        item.set_geometry(QPointF(0, 0), w, h, scale=scale, rotation=rot, facing=facing)
        if self._texture_provider is not None:
            item.set_pixmap(self._texture_provider(url))
        else:
            item.set_pixmap(None)

    def _content_spec(self, kind: str, ent: dict):
        """内容 part 的几何与贴图来源；没有内容返回 None。

        NPC 精灵的世界尺寸来自**动画包**（不在场景 JSON 里），所以由宿主经
        `set_sprite_metrics_provider` 注入 —— 视图不解析资源路径。
        动画包解不出来时返回 None：与老画布同口径（没有 animFile / 图集读不到
        就没有精灵），也与运行时一致（`getWorldSize()` 为 0 时不出 sprite）。
        """
        if kind == "npc":
            if self._sprite_metrics is None:
                return None
            metrics = self._sprite_metrics(ent)
            if not metrics:
                return None
            w, h, url = metrics
            if w <= 0 or h <= 0:
                return None
            facing = -1 if str(
                ent.get("initialFacing", "")).strip().lower() == "left" else 1
            return (
                QPointF(float(ent.get("x", 0) or 0), float(ent.get("y", 0) or 0)),
                w, h, facing,
                float(ent.get("scale", 1.0) or 1.0),
                float(ent.get("rotation", 0.0) or 0.0),
                url,
            )
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

    def sync_background(self, pix, world_w: float, world_h: float,
                        note: str = "") -> None:
        """背景由宿主解析路径后传进来（视图不读盘）。"""
        self._background.set_background(pix, world_w, world_h, note)

    def set_texture_provider(self, provider) -> None:
        """注入 ``url -> QPixmap | None``。视图不读盘，路径解析归宿主。"""
        self._texture_provider = provider
        self._resync_content()

    def set_sprite_metrics_provider(self, provider) -> None:
        """注入 ``npc_dict -> (world_w, world_h, texture_url) | None``。"""
        self._sprite_metrics = provider
        self._resync_content()

    def _resync_content(self) -> None:
        refs = {ref for (ref, part) in self._items if (ref.kind, part) in _CONTENT_PARTS}
        # 还没建出内容图元的实体也要过一遍：provider 刚接上时它们才第一次有内容
        for kind in ("hotspot", "npc"):
            refs.update(self._doc.entity_refs(kind))
        for ref in refs:
            self._sync_entity(ref)

    def _part_points(self, kind: str, part: str, ent: dict):
        if part == "lightcurve":
            return light_curve_points(ent)
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
        """碰撞面画在**世界坐标**里：`anchor + T(local)`，与运行时同口径。

        `T` 就是实例 transform（scale / rotation），**不能省**。省掉它的后果不是
        "画得略歪"：写回走的是完整反变换，画与写口径不一致时，在 `scale != 1` 的
        实体上拖一个顶点松手就会跳走，而且越拖越远。数学与老画布共用同一对函数
        （`shared/scene_migrations`），两个画布因此不可能各画各的。
        """
        poly = ent.get("collisionPolygon")
        if not isinstance(poly, list) or len(poly) < 3:
            return []
        return collision_polygon_local_to_world(ent, poly)

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
                       self._persp_axis, self._gizmo]
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

    # ---- 手势预览（**纯显示，不碰数据**）----------------------------------

    def set_move_preview(self, refs, dx: float, dy: float) -> None:
        """手势中的位移预览。传空 refs（或零位移）即清除。

        预览走图元的 `set_preview_offset`，与 `_sync_*` 写的"数据位"互不覆盖 ——
        理由见 `items.CanvasItem` 的那段注释。
        """
        wanted = set(refs) if (dx or dy) else set()
        for ref in self._preview_refs - wanted:
            for item in self.items_of(ref):
                item.set_preview_offset(0.0, 0.0)
        for ref in wanted:
            for item in self.items_of(ref):
                item.set_preview_offset(dx, dy)
        self._preview_refs = wanted

    def set_transform_preview(self, spec) -> None:
        """缩放/旋转预览：``(ref, scale, rotation)`` 或 ``None``。

        只改内容图元的绘制几何；松手后由 `_sync_entity` 用真实数据复位。
        """
        old = self._preview_transform
        if old == spec:
            return
        self._preview_transform = spec
        if old is not None and (spec is None or spec[0] != old[0]):
            self._sync_entity(old[0])          # 用真实数据把上一个复位
        if spec is None:
            return
        ref, scale, rot = spec
        ent = self._doc.entity(ref)
        if not isinstance(ent, dict):
            return
        content = self._content_spec(ref.kind, ent)
        if content is None:
            return
        _anchor, w, h, facing, _s, _r, _url = content
        for part in ("display", "sprite"):
            item = self._items.get((ref, part))
            if item is not None:
                item.set_geometry(QPointF(0, 0), w, h,
                                  scale=scale, rotation=rot, facing=facing)

    def refresh_gesture_preview(self) -> None:
        """把当前工具的手势状态投影到画面上。

        **一条通道服务所有工具**：工具只暴露 `band_rect` / `drag_offset` +
        `dragging_refs` / `transform_preview` / `gizmo_positions()` 这几个可选属性，
        视图不为每个工具写分支。老画布是每个手势各写一套预览，于是各有各的漏画
        （橡皮筋画了、拖动没画、gizmo 干脆没画）。
        """
        tool = self.tools.current
        self._band.set_rect(getattr(tool, "band_rect", None))
        off = tuple(getattr(tool, "drag_offset", (0.0, 0.0)) or (0.0, 0.0))
        self.set_move_preview(getattr(tool, "dragging_refs", ()) or (),
                              float(off[0]), float(off[1]))
        self.set_transform_preview(getattr(tool, "transform_preview", None))
        gizmo = getattr(tool, "gizmo_positions", None)
        self._gizmo.set_positions(gizmo() if callable(gizmo) else None)

    @property
    def transform_gizmo(self) -> TransformGizmoItem:
        return self._gizmo

    # ---- 输入转发（一律交给当前工具）--------------------------------------

    def _world(self, event) -> QPointF:
        return self.mapToScene(event.position().toPoint())

    def mousePressEvent(self, event) -> None:
        pos = self._world(event)
        handled = self.tools.mouse_pressed(pos, event.button(), event.modifiers())
        self.refresh_gesture_preview()
        if handled:
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        pos = self._world(event)
        self.cursor_world_moved.emit(pos)
        handled = self.tools.mouse_moved(pos, event.buttons(), event.modifiers())
        if handled:
            self.refresh_gesture_preview()
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        pos = self._world(event)
        handled = self.tools.mouse_released(pos, event.button(), event.modifiers())
        # **松手后必须刷一次**，而且不管工具吃没吃这一下：手势状态已经清空，
        # 预览若不跟着清，画面会永久停在最后一帧偏移上 —— 数据是对的、画面是错的，
        # 属于最难自查的一类。
        self.refresh_gesture_preview()
        if handled:
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
        handled = self.tools.key_pressed(event.key(), event.modifiers())
        self.refresh_gesture_preview()      # Esc 取消手势后要把预览一并撤掉
        if handled:
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
