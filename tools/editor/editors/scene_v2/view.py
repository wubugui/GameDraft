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

from ...shared.entity_transform_math import (
    entity_perspective_factor,
    entity_scale_of,
)
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
from .entity_items import (
    CollisionGhostItem,
    LightCurveItem,
    HandleItem,
    PolygonItem,
    PolylineItem,
    entity_canvas_color,
)
from .light_curve import light_curve_points
from .items import CanvasItem, EntityItem
from .overlays import (
    GroupBoxItem,
    PerspectiveAxisItem,
    RubberBandItem,
    ScaleReferenceItem,
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
    ("hotspot", "ghost"): CollisionGhostItem,
    ("npc", "handle"): HandleItem,
    ("npc", "collision"): PolygonItem,
    ("npc", "ghost"): CollisionGhostItem,
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
_SCENE_PARTS = {"lightcurve": LightCurveItem}


class SceneView(QGraphicsView):
    """场景画布。**只读 Document、只转发输入**。"""

    #: 鼠标世界坐标变化（状态栏用）
    cursor_world_moved = Signal(QPointF)

    #: 请宿主在此处弹右键菜单：``(世界坐标, 全局屏幕坐标)``
    context_menu_requested = Signal(QPointF, object)

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
        #: ``npc_dict -> QPixmap | None``（图集里的**当前一格**）。
        #: 与 `_texture_provider` 分开：精灵是随时间变的一帧，展示图是一整张。
        self._sprite_frame = None
        #: 中键平移的上一帧位置（None = 没在平移）
        self._pan_from = None
        #: 还欠一次"布好版之后再适配"
        self._pending_fit = False
        #: 最近一次鼠标所在的世界坐标（`None` = 还没进过画布）
        self.last_cursor_world = None
        #: 覆盖物（分组框 / 透视轴 / 橡皮筋）。它们不进图元账，也不进命中白名单。
        self._group_boxes: dict[str, GroupBoxItem] = {}
        self._group_boxes_visible = True
        #: 锁定 Zone 点选（只影响命中，不影响显示）
        self.zone_pick_frozen = False
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
        self._scale_ref = ScaleReferenceItem()
        self._gfx.addItem(self._scale_ref)
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
        if part in ("collision", "ghost", "patrol", "lightcurve") and not pts:
            # 数据门：没有多边形/路线就不该有图元（不是"藏起来"，是不存在）
            self._drop_part(ref, part)
            return
        if item is None:
            item = factory(ref)
            self._gfx.addItem(item)
            self._items[(ref, part)] = item
            self._push_view_scale(item)
            if part == "lightcurve":
                # 光曲线选不中（它不属于任何实体），所以控制点必须恒显
                item.always_show_vertices = True
        if isinstance(item, HandleItem):
            item.set_base_pos(float(ent.get("x", 0) or 0), float(ent.get("y", 0) or 0))
            item.set_color(entity_canvas_color(ref.kind, ent))
            item.set_label(ref.id)
            if properties & (EntityProperty.POSITION | EntityProperty.BEHAVIOUR
                             | EntityProperty.TRANSFORM | EntityProperty.ALL):
                # **缺省 50，且乘实例 scale 与透视系数** —— 与运行时同口径。
                # 少乘的话策划照着虚线圈调"走到多近能交互"，实际游戏里最多差
                # 2.2 倍（透视）× 实例缩放；缺省写 0 则整个圈直接不画，
                # 而运行时缺省是 50，等于画布对玩法参数直接撒谎。
                raw = ent.get("interactionRange", 50)
                try:
                    base = float(raw if raw is not None else 50)
                except (TypeError, ValueError):
                    base = 50.0
                item.set_interaction_range(
                    base * entity_scale_of(ent)
                    * self.perspective_factor(ent, ref.kind))
        else:
            item.set_points(pts)
            if part == "lightcurve":
                # 每个控制点驮着一份 env —— 图元照它画光照可视化
                item.set_envs([p.get("env") if isinstance(p, dict) else None
                               for p in pts])
            if part == "polygon":
                # Zone 按 zoneKind 分色：深度地面决定角色踩地深度，
                # 与普通触发区同色时叠在一起容易拖错、删错。
                setter = getattr(item, "set_color", None)
                if callable(setter):
                    setter(entity_canvas_color(ref.kind, ent))

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
        if ref.kind == "npc" and self._sprite_frame is not None:
            # 精灵走**帧**通路（图集里的一格），不是整张图
            item.refresh_frame(self._sprite_frame(ent))
        elif self._texture_provider is not None:
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
                # 实例 scale **×** 透视系数：与运行时容器级复合同口径（防预览撒谎）
                float(ent.get("scale", 1.0) or 1.0)
                * self.perspective_factor(ent, kind),
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
            float(ent.get("scale", 1.0) or 1.0)
            * self.perspective_factor(ent, kind),
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

    def set_group_boxes_visible(self, on: bool) -> None:
        """分组框总开关。对着背景图精细对位时那些虚线框很碍事，
        老画布提供了这条出路，新画布不该缺。"""
        self._group_boxes_visible = bool(on)
        for box in self._group_boxes.values():
            box.setVisible(self._group_boxes_visible)

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
                box.setVisible(self._group_boxes_visible)
            box.set_geometry(rect, title)
            wanted[gid] = box
        for gid in [g for g in self._group_boxes if g not in wanted]:
            box = self._group_boxes.pop(gid)
            if box.scene() is self._gfx:
                self._gfx.removeItem(box)

    def sync_perspective_axis(self, near, far, *, near_scale=None,
                              far_scale=None, mid_stops=None) -> None:
        self._persp_axis.set_axis(near, far, near_scale=near_scale,
                                  far_scale=far_scale, mid_stops=mid_stops)

    def sync_background(self, pix, world_w: float, world_h: float,
                        note: str = "") -> None:
        """背景由宿主解析路径后传进来（视图不读盘）。"""
        self._background.set_background(pix, world_w, world_h, note)

    def set_texture_provider(self, provider) -> None:
        """注入 ``url -> QPixmap | None``。视图不读盘，路径解析归宿主。"""
        self._texture_provider = provider
        self._resync_content()

    def set_sprite_frame_provider(self, provider) -> None:
        """注入 ``npc_dict -> QPixmap | None``（**当前帧**，不是整张图集）。

        NPC 精灵与静态展示图走两条不同的贴图通路：展示图是一张图，精灵是图集里
        随时间变的一格。共用 `texture_provider` 的下场是把整张图集压进 NPC 的世界
        框里 —— 画布上每个 NPC 变成一坨缩微小人网格，而且不会动。
        """
        self._sprite_frame = provider
        self._resync_content()

    def refresh_sprite_frames(self) -> None:
        """动画驱动每拍调：把当前帧推进已有的精灵图元。**不重建图元**。"""
        if self._sprite_frame is None:
            return
        for (ref, part), item in list(self._items.items()):
            if part != "sprite":
                continue
            ent = self._doc.entity(ref)
            if isinstance(ent, dict):
                item.refresh_frame(self._sprite_frame(ent))

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

    def perspective_factor(self, ent: dict, kind: str,
                           foot_x=None, foot_y=None) -> float:
        """实体在画布上的**透视系数**（参与判定 × f(脚底点)）；未配置时恒 1。

        **画布上一切"多大"的东西都要乘它**：贴图/精灵的世界尺寸、交互半径圈、
        内容层排序用的脚底 quad。漏乘的后果不是"画得略歪"，而是编辑器**撒谎**：
        透视场景里最多差 2.2 倍，策划照着画布摆好的构图进游戏就是散的，
        而且没有任何报错。老画布在这一处专门写了注释「防预览撒谎」。

        与老画布共用同一份数学（`shared/entity_transform_math`），两个画布因此
        不可能各算各的。
        """
        sc = self._doc.scene() or {}
        cfg = sc.get("perspectiveScale") if isinstance(sc, dict) else None
        return entity_perspective_factor(cfg, ent, kind, foot_x, foot_y)

    def _part_points(self, kind: str, part: str, ent: dict):
        if part == "lightcurve":
            return light_curve_points(ent)
        if part == "polygon":
            return ent.get("polygon") or []
        if part == "collision":
            return self._collision_world_points(ent)
        if part == "ghost":
            return self._collision_ghost_points(ent, kind)
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

    def _collision_ghost_points(self, ent: dict, kind: str):
        """运行时真正生效的命中面：authored 多边形绕锚点再乘一次透视系数。

        与运行时 `anchorCollisionPolygonToWorld` 同口径。透视系数为 1 时与
        authored 完全重合，这时**不建图元**（两条线重叠反而看不清）。
        """
        pts = self._collision_world_points(ent)
        if len(pts) < 3:
            return []
        pf = self.perspective_factor(ent, kind)
        if abs(pf - 1.0) < 1e-6:
            return []
        ax = float(ent.get("x", 0) or 0)
        ay = float(ent.get("y", 0) or 0)
        return [{"x": ax + (p["x"] - ax) * pf, "y": ay + (p["y"] - ay) * pf}
                for p in pts]

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
                       self._persp_axis, self._gizmo, self._scale_ref]
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

    #: 视口小于这个尺寸时不认为它"已经布好版"（刚 addWidget 的 view 是 100x30 之类）
    _FIT_MIN_VIEWPORT = 64

    def end_auto_fit(self) -> None:
        """用户第一次自己动视口（缩放/平移/手势）之后，就别再自动适配了。"""
        self._pending_fit = False

    def request_fit(self) -> None:
        """请求把整个场景适配到视口 —— **布好版之前先记账**。

        刚 `addWidget` 的 view 视口还是 100x30 之类的占位尺寸，此刻 fit 出来的
        缩放是正确值的百分之一：整个场景被画成十几个像素，背景和实体全挤成一坨，
        用户以为"新画布什么都没画出来"。

        钩子必须挂在**本视图**上：页是先布版、后 `load_scene` 新建 view 的，
        所以页的 `resizeEvent` 在这之后再也不会触发 —— 挂在页上等于永远等不到。
        （上一版正是这么错的。）
        """
        self._pending_fit = True
        self._fit_if_laid_out()

    def _fit_if_laid_out(self) -> bool:
        """布好版就适配一次。**在用户自己动视口之前，每次布版都重来一次。**

        布局是分几拍settle 的（工具栏第二行出现、splitter 归位…），只在"第一次
        拿到像样尺寸"时适配一次的话，后面那几拍会把比例改掉，结果差十几个百分点。
        所以这里不清账，改由 `end_auto_fit()` 在用户第一次缩放/平移/按下手势时清 ——
        与老画布 `_auto_fit_after_layout` 同一套语义。
        """
        if not self._pending_fit:
            return False
        vp = self.viewport()
        if (vp.width() < self._FIT_MIN_VIEWPORT
                or vp.height() < self._FIT_MIN_VIEWPORT):
            return False
        rect = self._gfx.sceneRect()
        if rect.width() <= 0 or rect.height() <= 0:
            return False
        self.fitInView(rect, Qt.AspectRatioMode.KeepAspectRatio)
        self._push_view_scale()
        return True

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt 接口
        super().resizeEvent(event)
        self._fit_if_laid_out()

    def showEvent(self, event) -> None:  # noqa: N802 - Qt 接口
        super().showEvent(event)
        self._fit_if_laid_out()

    def fit_scene(self) -> None:
        """立刻适配（用户点「适配」按钮走这里，不看布版状态）。"""
        self._pending_fit = False
        rect = self._gfx.sceneRect()
        if rect.width() > 0 and rect.height() > 0:
            self.fitInView(rect, Qt.AspectRatioMode.KeepAspectRatio)
            self._push_view_scale()

    def zoom_by(self, factor: float) -> None:
        self.end_auto_fit()
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

    def preview_offsets(self) -> dict:
        """手势中每个实体的预览位移 ``{ref: (dx, dy)}``。排序要把它算进脚底 y。"""
        if not self._preview_refs:
            return {}
        off = (0.0, 0.0)
        for ref in self._preview_refs:
            items = self.items_of(ref)
            if items:
                off = items[0].preview_offset
                break
        return {ref: off for ref in self._preview_refs}

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
        # **碰撞面、幽灵、交互半径圈也要跟着转/缩。**
        # 只动贴图的话，转的时候画面自相矛盾：贴图转了、碰撞面和交互圈留在原地，
        # 用户没法边拖边把碰撞面与美术对齐，只能松手看一眼、不满意再来一次。
        preview_ent = dict(ent)
        preview_ent["scale"] = scale
        preview_ent["rotation"] = rot
        for part in ("collision", "ghost"):
            item = self._items.get((ref, part))
            if item is not None:
                item.set_points(self._part_points(ref.kind, part, preview_ent))
        handle = self._items.get((ref, "handle"))
        if handle is not None:
            raw = ent.get("interactionRange", 50)
            try:
                base = float(raw if raw is not None else 50)
            except (TypeError, ValueError):
                base = 50.0
            handle.set_interaction_range(
                base * float(scale) * self.perspective_factor(preview_ent, ref.kind))

    #: 手势预览刷新后要不要重排内容层（宿主接上；视图自己不算 z）
    content_resort_requested = Signal()

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
        # **拖动中也要重排前后关系。** 手势期间不写数据（对的），但脚底 y 已经
        # 在画面上变了；不重排的话"把这个人挪到树后面"这类调层动作看到的层级是
        # 错的，只能靠松手那一跳试错。老画布在 live 分支里每帧都重排。
        if self._preview_refs or self._preview_transform is not None:
            self.content_resort_requested.emit()

    @property
    def transform_gizmo(self) -> TransformGizmoItem:
        return self._gizmo

    @property
    def scale_reference(self) -> ScaleReferenceItem:
        return self._scale_ref

    def set_scale_reference(self, world_w: float, world_h: float,
                            label: str = "") -> None:
        sc = self._doc.scene() or {}
        try:
            w = float(sc.get("worldWidth", 0) or 0)
            h = float(sc.get("worldHeight", 0) or 0)
        except (TypeError, ValueError):
            w = h = 0.0
        self._scale_ref.set_reference(world_w, world_h, w, h, label)

    # ---- 输入转发（一律交给当前工具）--------------------------------------

    def _world(self, event) -> QPointF:
        return self.mapToScene(event.position().toPoint())

    def mousePressEvent(self, event) -> None:
        # **中键拖动平移画布**：全编辑器统一的手势（map / quest / 坐标点选器都有），
        # 老画布也有。缺了它，放大之后只剩滚轮与拖滚动条，横向平移尤其难受 ——
        # 习惯了的人会以为画布卡死。必须排在转发给工具**之前**：工具链不认中键。
        if event.button() == Qt.MouseButton.MiddleButton:
            self.end_auto_fit()
            self._pan_from = event.position().toPoint()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            event.accept()
            return
        self.end_auto_fit()
        pos = self._world(event)
        handled = self.tools.mouse_pressed(pos, event.button(), event.modifiers())
        self.refresh_gesture_preview()
        if handled:
            event.accept()
            return
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        if self._pan_from is not None:
            now = event.position().toPoint()
            delta = now - self._pan_from
            self._pan_from = now
            self.horizontalScrollBar().setValue(
                self.horizontalScrollBar().value() - delta.x())
            self.verticalScrollBar().setValue(
                self.verticalScrollBar().value() - delta.y())
            event.accept()
            return
        pos = self._world(event)
        #: 供"对着某个顶点按 Delete"这类以鼠标位置为准的快捷键用
        self.last_cursor_world = pos
        self.cursor_world_moved.emit(pos)
        handled = self.tools.mouse_moved(pos, event.buttons(), event.modifiers())
        if handled:
            self.refresh_gesture_preview()
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.MiddleButton and self._pan_from is not None:
            self._pan_from = None
            self.unsetCursor()
            event.accept()
            return
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

    def contextMenuEvent(self, event) -> None:  # noqa: N802 - Qt 接口
        """右键：先让当前工具处理（多边形工具要删顶点），否则请宿主弹菜单。

        菜单内容归宿主 —— 视图不知道有哪些实体族、也不该持有命令。
        """
        pos = self.mapToScene(event.pos())
        if self.tools.mouse_pressed(pos, Qt.MouseButton.RightButton,
                                    event.modifiers()):
            self.refresh_gesture_preview()
            event.accept()
            return
        self.context_menu_requested.emit(pos, event.globalPos())
        event.accept()

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
