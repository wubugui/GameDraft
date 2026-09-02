"""`SceneEditorV2` —— 新画布的编辑器页。

它把 Document / View / ToolManager 接成一个能开的页，并实现主窗口的**鸭子协议钩子**。
那五个钩子不是可选的：`mainwindow-editor-hooks` 机制卡写得很直白 ——
**缺钩子不报错、静默漏网**。逐个的死法：

| 钩子 | 缺了会怎样 |
|---|---|
| `flush_to_model` | Save All 时本页的未提交编辑不落库，存盘后改动消失 |
| `commit_pending_on_leave` | 切到别的页 = 这次编辑模型里没有，别处的候选/引用看不到 |
| `confirm_close` | 关窗/切工程时静默丢弃未应用编辑 |
| `reload_from_model` | 别的编辑器替换了场景域后，本页还拿着旧投影，Apply 会覆盖回去 |
| `editor_undo` | 工具栏撤销按钮点了没反应 |

**本页没有 staging 层。** 数据只有模型一层，所有写入都是命令。于是
`flush_to_model` / `commit_pending_on_leave` 这两个"提交未应用编辑"的钩子
天然是空操作 —— 没有"未应用"这个状态。这不是偷懒，是这套架构的直接结果：
命令一旦构造就已经落到模型里了。
"""
from __future__ import annotations

import json
from dataclasses import replace

from PySide6.QtCore import QPointF, Qt, QTimer
from PySide6.QtGui import QActionGroup, QPixmap
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QListWidget,
    QComboBox,
    QInputDialog,
    QLineEdit,
    QListWidgetItem,
    QMenu,
    QMessageBox,
    QSplitter,
    QToolBar,
    QTreeWidget,
    QTreeWidgetItem,
    QTreeWidgetItemIterator,
    QVBoxLayout,
    QWidget,
)

from ...shared.anim_atlas_preview import (
    resolved_anim_world_pair,
    spritesheet_public_path,
)
from ...shared.image_path_picker import disk_path_for_runtime_url
from ...shared.move_entity_map_picker import (
    resolve_world_size_for_scene_json,
    scene_background_disk_path,
)
from ...shared.scene_view_filters import (
    ViewAxes,
    passes_group_box_filters,
    passes_view_filters,
    scene_day_night_enabled,
)
from .changes import (
    EntitiesAdded,
    EntitiesChanged,
    EntitiesRemoved,
    EntityProperty,
    EntityRef,
    SceneReloaded,
    SelectionChanged,
)
from .document import SceneDocument
from ...shared.anim_atlas_preview import reference_world_size
from ...shared.patrol_preview import PatrolWalker
from .npc_anim import NpcAnimBank
from .panel_bridge import PanelBridge
from .sorting import assign_content_z
from .tools_builtin import MoveTool, PolygonEditTool, SelectTool
from .tools_overlays import (
    GroupBoxTool,
    LightPlaceTool,
    PerspectiveAxisTool,
    group_bounds,
)
from ...shared.entity_refactor import (
    EntityRefactorError,
    undo_last,
)
from .groups import all_group_ids, assign_group, create_group, delete_group
from .tools_structure import (
    CreateTool,
    create_entity_at,
    create_spawn,
    delete_selected,
    duplicate_selected,
)
from .tools_transform import GroupMoveTool, TransformTool, translate_group
from .view import SceneView

#: NPC 精灵的动画节拍（毫秒）。~30fps 足够看清动画对不对，
#: 又不至于让 NPC 上百的场景每秒裁上千张图。
_ANIM_TICK_MS = 33

__all__ = ["SceneEditorV2"]


def _presence_predicate(axes: ViewAxes, group_index: dict):
    """造一个 `(ref, ent) -> 显不显` 给视图。

    **刻意是模块级函数、不捏 `self`**：这个闭包会被视图长期持有，捏住页就是
    页↔视图的引用环。它捏的 `group_index` 是页那本名册**本身**（页就地改它），
    所以组的时段一变、成员改归属，下一次判定读到的就是新的。
    """
    def _passes(ref, ent) -> bool:
        gid = str((ent or {}).get("group", "") or "") if isinstance(ent, dict) else ""
        return passes_view_filters(ref.kind, ent, axes, group_index.get(gid))

    return _passes


class SceneEditorV2(QWidget):
    """场景编辑器（新画布）。"""

    def __init__(self, model, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._doc: SceneDocument | None = None
        self._view: SceneView | None = None
        self._axes = ViewAxes()
        #: `gid -> entityGroups 里那一条`。时段轴要按成员的 `group` 标签取组的
        #: 「时段归属」，**先建一次映射再遍历** —— 在每个实体上线性搜 entityGroups
        #: 会把显隐这趟变成 O(实体×分组)，而它在每次拖动、每次重投影上都要跑一遍。
        #: **就地改（clear/update），不换对象**：判定闭包捏着的就是这个 dict，
        #: 换掉它闭包就永远看着一份旧名册。
        self._group_index: dict[str, dict] = {}
        #: 「分组框」总开关的用户选择。框的显隐 = **这个开关 ∧ 时段轴**，
        #: 合成一次再落 setVisible；分头各写各的就会互相冲掉。
        self._group_boxes_on = True
        self._content_z_key: tuple | None = None
        #: 贴图与动画包解析结果的缓存。不缓存的话拖一次实体要重读几十次盘
        #: （老画布的 `_disp_sig` 签名缓存是同一个教训：perf-reload）。
        self._texture_cache: dict[str, QPixmap] = {}
        self._anim_cache: dict[str, tuple] = {}

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        lv = QVBoxLayout(left)
        lv.setContentsMargins(0, 0, 0, 0)
        self._scene_list = QListWidget()
        self._scene_list.currentItemChanged.connect(self._on_scene_row_changed)
        lv.addWidget(QLabel("场景"))
        lv.addWidget(self._scene_list, 1)
        self._tree = QTreeWidget()
        self._tree.setHeaderHidden(True)
        self._tree.setSelectionMode(QTreeWidget.SelectionMode.ExtendedSelection)
        self._tree.itemSelectionChanged.connect(self._on_tree_selection_changed)
        # 树的右键菜单。**没有它，在树里选中实体就删不掉也复制不了** ——
        # 快捷键只挂在画布上（`SceneView.keyPressEvent`），焦点在树上时全部失效，
        # 而用户的习惯正是"在左树里点名字选实体、再按 Delete"。
        self._tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._tree.customContextMenuRequested.connect(self._show_tree_menu)
        self._syncing_tree = False
        lv.addWidget(QLabel("实体"))
        # 过滤框 + 视图模式：实体多的场景（雾津街头 30+ 项）没有它们只能靠肉眼扫
        self._tree_filter = QLineEdit()
        self._tree_filter.setPlaceholderText("过滤实体 id…")
        self._tree_filter.textChanged.connect(lambda _t: self.refresh_entity_tree())
        lv.addWidget(self._tree_filter)
        self._tree_mode = QComboBox()
        self._tree_mode.addItems(["按类型", "按分组"])
        self._tree_mode.currentIndexChanged.connect(
            lambda _i: self.refresh_entity_tree())
        lv.addWidget(self._tree_mode)
        lv.addWidget(self._tree, 2)
        splitter.addWidget(left)

        right = QWidget()
        rv = QVBoxLayout(right)
        rv.setContentsMargins(0, 0, 0, 0)
        self._toolbar = QToolBar()
        self._axis_bar = QToolBar()
        rv.addWidget(self._toolbar)
        rv.addWidget(self._axis_bar)
        self._canvas_host = QWidget()
        self._canvas_layout = QVBoxLayout(self._canvas_host)
        self._canvas_layout.setContentsMargins(0, 0, 0, 0)
        rv.addWidget(self._canvas_host, 1)
        self._status = QLabel("")
        rv.addWidget(self._status)
        splitter.addWidget(right)
        splitter.setStretchFactor(1, 1)

        # 复用老画布那 6657 行属性面板，**一行不改**。它的 staging 在新架构里
        # 降级成"UI 局部编辑缓冲"——Document 永远不读它，编辑经 PanelBridge
        # 变成命令。详见 panel_bridge 模块文档。
        from ..scene_editor import ScenePropertyPanel
        self._props = ScenePropertyPanel(model)
        splitter.addWidget(self._props)
        self._bridge: PanelBridge | None = None
        self._loaded_scene_obj = None
        self._tool_actions: dict = {}
        #: npc_id → 巡逻预览游标（只在勾了预览的 NPC 上有）
        self._patrol_walkers: dict = {}
        # NPC 精灵的动画驱动。**宿主持有** —— 解析 anim.json、读图集、跑定时器
        # 都是读资源，视图那层不做这件事。
        self._anim_bank = NpcAnimBank(model, self._public_asset_path)
        self._anim_timer = QTimer(self)
        self._anim_timer.setTimerType(Qt.TimerType.CoarseTimer)
        self._anim_timer.setInterval(_ANIM_TICK_MS)
        self._anim_timer.timeout.connect(self._tick_npc_anims)
        root.addWidget(splitter)

        self._build_axis_bar()
        self.refresh_axis_choices()
        self.refresh_scene_list()

    # ---- 场景装载 ----------------------------------------------------------

    def refresh_scene_list(self) -> None:
        """重建左侧场景清单。**只动清单，不重载场景。**

        此前这里在收尾处又调了一次 `load_scene(current)`，于是
        `reload_from_model()`（主窗口每次切页都调）会**装载两遍**：每次切页
        新建两套 Document / View / PanelBridge，旧的那套还挂着信号。
        清单刷新与场景装载是两件事，混在一起既浪费又让"装载了几次"变得没法推理。
        """
        current = self.current_scene_id
        self._scene_list.blockSignals(True)
        self._scene_list.clear()
        row = -1
        for i, sid in enumerate(sorted(self._model.scenes.keys())):
            item = QListWidgetItem(sid)
            item.setData(Qt.ItemDataRole.UserRole, sid)
            self._scene_list.addItem(item)
            if sid == current:
                row = i
        if row >= 0:
            self._scene_list.setCurrentRow(row)
        self._scene_list.blockSignals(False)

    @property
    def current_scene_id(self) -> str:
        return self._doc.scene_id if self._doc is not None else ""

    @property
    def document(self) -> SceneDocument | None:
        return self._doc

    @property
    def view(self) -> SceneView | None:
        return self._view

    def load_scene(self, scene_id: str) -> bool:
        if scene_id not in self._model.scenes:
            return False
        if self._view is not None:
            self._canvas_layout.removeWidget(self._view)
            self._view.deleteLater()
            self._view = None
        if self._bridge is not None:
            # 面板是页面级共享的（换场景不重建），旧桥不断开就会一直挂在
            # panel.changed 上，持着上个场景的 ref 与已析构的文档。
            self._bridge.detach()
            self._bridge.deleteLater()
            self._bridge = None
        if self._doc is not None:
            self._doc.deleteLater()
        # **重建视图 = 内容层 z 的脏检查缓存作废。**
        # 缓存键是 (装配序, z, ref) —— 刻意不含图元身份（CPython 的 id 会被回收
        # 复用，图元换人后键"看着没变"）。代价是换一批全新图元时键仍然相同，
        # 于是 `assign_content_z` 早退、一个 setZValue 都不发，全场内容图元停在
        # 默认 z=0：该被挡住的贴图跑到前面来，而数据其实没变 —— 用户会去改数据
        # "修"一个根本不存在的问题。切页/跳转/Task 编排后重投影都会走到这里。
        self._content_z_key = None
        self._doc = SceneDocument(self._model, scene_id, self)
        self._bridge = PanelBridge(self._props, self._doc, self)
        # 桥恒返回 None，于是 write_target 恒指向模型 —— 新画布没有第二层真相。
        self._doc.set_staging_provider(self._bridge)
        # 装载时选择为空 → 落在场景属性页。**必须经桥**，不能自己调
        # `load_scene_props`：直接调的话面板确实显示了场景页，但桥的 `_loaded`
        # 还是 None，于是这一页上的每一次编辑都在 `commit_panel_edits` 第一个
        # 分支早退 —— 界面看着能改，改完一个字节都不进模型。
        self._bridge.sync_from_selection()
        #: 装载那一刻的场景 dict 对象。重投影时靠它判断"是不是被换掉了"。
        self._loaded_scene_obj = self._doc.scene()
        self._view = SceneView(self._doc, self._canvas_host)
        self._canvas_layout.addWidget(self._view)
        self._view.set_texture_provider(self._load_texture)
        self._view.set_sprite_metrics_provider(self._npc_sprite_metrics)
        self._anim_bank.clear()
        self._patrol_walkers.clear()
        self._view.set_sprite_frame_provider(self._anim_bank.frame_pixmap)
        self._refresh_background()
        self._install_tools()
        # 轴的选择跨场景保留（机制卡「已知坑」第一条），但**总闸不是选择**：
        # 换场景就得换成新场景自己的 dayNight.enabled，再按当前轴重贴。
        self._sync_day_night_gate()
        self._apply_view_axes()
        self._doc.changed.connect(self._on_doc_changed)
        self._view.content_resort_requested.connect(self.resort_content_z)
        self._view.context_menu_requested.connect(self._show_canvas_menu)
        self._view.content_resort_requested.connect(self._sync_live_xy_widgets)
        # 适配要等 Qt 把 view 真正布局出来 —— 记账逻辑在 `SceneView.request_fit`
        # （钩子必须挂在视图自己身上，理由见那里）。
        self._view.request_fit()
        self._sync_scene_row(scene_id)
        self.resort_content_z()
        self.refresh_group_boxes()
        self.refresh_perspective_axis()
        self.refresh_scene_geometry()
        self.refresh_entity_tree()
        self._anim_timer.start()
        return True

    # ---- 资源解析（视图不读盘，路径解析归这里）-----------------------------

    def _refresh_background(self) -> None:
        """场景背景。**文件名强约束走共享出口** —— 与老画布、坐标点选器同一份
        解析（`background.png` 或该场景自己声明过的时段背景），否则会显示一张
        游戏根本不加载的背景。

        底图**吃时段轴**：夜靠换整张原画得到，只按时段藏实体而不换底图，
        画布上就是「白天的街 + 夜里的人」。解析不到就回落白天那张。
        """
        if self._doc is None or self._view is None:
            return
        sc = self._doc.scene() or {}
        path = scene_background_disk_path(
            self._model, self._doc.scene_id, sc, self._phase_view_id())
        if path is None:
            path = scene_background_disk_path(self._model, self._doc.scene_id, sc)
        world_w, world_h = resolve_world_size_for_scene_json(
            sc, path if path and path.is_file() else None)
        pix = None
        note = ""
        if path is not None and path.is_file():
            pix = QPixmap(str(path))
            if pix.isNull():
                pix, note = None, f"{self._doc.scene_id}\n（背景图加载失败）"
        elif sc.get("backgrounds"):
            note = (f"{self._doc.scene_id}\n"
                    "（背景图缺失，或图名既不是 background.png 也没配进 timeVariants）")
        else:
            note = f"{self._doc.scene_id}\n（本场景无背景图）"
        self._view.sync_background(pix, world_w, world_h, note)

    def _public_asset_path(self, rel: str):
        """``/anim/x.json`` 之类的公开资源相对路径 → 磁盘路径。与老画布同口径。"""
        r = (rel or "").strip().lstrip("/").replace("\\", "/")
        if not r or self._model.project_path is None:
            return None
        return self._model.project_path / "public" / r

    def _load_texture(self, url: str):
        """``url -> QPixmap | None``。读不出来返回 None，视图会画缺件占位框
        且把 `texture_loaded` 置 False —— 与运行时"没有 displaySprite"同口径。"""
        if not url:
            return None
        cached = self._texture_cache.get(url)
        if cached is not None:
            return cached if not cached.isNull() else None
        path = disk_path_for_runtime_url(self._model, url)
        pix = QPixmap(str(path)) if path is not None else QPixmap()
        self._texture_cache[url] = pix
        return pix if not pix.isNull() else None

    def _tick_npc_anims(self) -> None:
        """把 NPC 精灵推进一帧。

        `hideEvent`/`showEvent` 里停/开定时器：页不可见时没人看，白烧 CPU；
        而 28 个场景里 NPC 上百，每拍裁图不是免费的。
        """
        if self._view is None:
            return
        if self._anim_bank.advance(_ANIM_TICK_MS / 1000.0):
            self._view.refresh_sprite_frames()
        self._tick_patrol_previews()

    def hideEvent(self, event) -> None:  # noqa: N802 - Qt 接口
        self._anim_timer.stop()
        super().hideEvent(event)

    def showEvent(self, event) -> None:  # noqa: N802 - Qt 接口
        if self._doc is not None:
            self._anim_timer.start()
        super().showEvent(event)

    def _npc_sprite_metrics(self, npc: dict):
        """NPC 精灵的世界尺寸；动画包解不出来返回 None。

        返回 None 时视图不建精灵图元 —— 与老画布同口径（没有 animFile / 图集
        读不到就没有精灵），也与运行时一致（`getWorldSize()` 为 0 时不出 sprite）。

        尺寸与**当前帧**都由 `NpcAnimBank` 给（它解析 anim.json、持图集与帧游标），
        第三项 URL 只是留给旧契约的占位 —— 精灵的像素走帧通路，不走 texture_provider。
        """
        size = self._anim_bank.world_size(npc)
        if size is None:
            return None
        return (size[0], size[1], "")

    def refresh_scene_geometry(self) -> None:
        """场景级几何（光环境曲线）。用 scene ref 走与实体几何**同一套**
        命令 / 撤销 / 顶点编辑，不另起一条平行实现。"""
        if self._doc is None or self._view is None:
            return
        self._view._sync_entity(EntityRef("scene", self._doc.scene_id))

    def _sync_scene_row(self, scene_id: str) -> None:
        self._scene_list.blockSignals(True)
        for i in range(self._scene_list.count()):
            it = self._scene_list.item(i)
            if it.data(Qt.ItemDataRole.UserRole) == scene_id:
                self._scene_list.setCurrentRow(i)
                break
        self._scene_list.blockSignals(False)

    def _on_scene_row_changed(self, current, _previous) -> None:
        if current is None:
            return
        # 切场景前先把本页的挂起编辑提交（本架构下是空操作，但钩子语义要保持一致）
        self.commit_pending_on_leave()
        self.load_scene(current.data(Qt.ItemDataRole.UserRole))

    # ---- 工具 --------------------------------------------------------------

    def _install_tools(self) -> None:
        doc, view = self._doc, self._view
        r = view.renderer
        self.select_tool = view.tools.register(SelectTool(doc, r, view))
        self.move_tool = view.tools.register(MoveTool(doc, r, view))
        self.polygon_tool = view.tools.register(PolygonEditTool(doc, r, view))
        self.transform_tool = view.tools.register(TransformTool(doc, r, view))
        # `GroupMoveTool` **不进工具栏**：它没有 mouse_pressed，手势唯一入口是
        # `begin()`，切过去之后拖组框/点实体/按方向键全都没反应 —— 工具栏上一个
        # 名字最像"我想干的事"的按钮却让画布装死。整组拖动本来就在 `GroupBoxTool`
        # 里（点框选中、再拖就是整组走），这里只留它做程序化位移入口。
        self.group_tool = GroupMoveTool(doc, r, view, self)
        self.create_hotspot_tool = view.tools.register(
            CreateTool(doc, r, "hotspot", view))
        self.create_npc_tool = view.tools.register(CreateTool(doc, r, "npc", view))
        self.create_zone_tool = view.tools.register(CreateTool(doc, r, "zone", view))
        self.persp_tool = view.tools.register(
            PerspectiveAxisTool(doc, r, view.perspective_axis))
        self.group_box_tool = view.tools.register(GroupBoxTool(doc, r, view))
        # 摆灯模式排在**最前面**：它开着的时候点击就该落灯，不该被点选吃掉
        self.light_place_tool = LightPlaceTool(doc, r, self._props, self)
        self.select_tool.add_delegate(self.light_place_tool)
        # **"选择"工具兼管 gizmo 手柄与分组框** —— 回到老画布的无模式手感：
        # 选中一个实体就出手柄、点组框边线就选中组，不必先切工具。
        self.select_tool.add_delegate(self.transform_tool)
        self.select_tool.add_delegate(self.move_tool)
        # 分组框排在**实体点选之后**：框边经过最外侧成员，排前面会吃掉它们的点击
        self.select_tool.add_delegate(self.group_box_tool, after_entities=True)
        view.tools.status_text_changed.connect(self._status.setText)
        self._doc.notice.connect(self._status.setText)
        self._connect_panel_signals()
        self._rebuild_toolbar(view)
        view.tools.select(self.select_tool)

    def _connect_panel_signals(self) -> None:
        """接面板 → 编辑器那一族信号。

        起初一条都没接：面板底部的「从场景删除」、分组面板的四个按钮、多选页的
        三个批量按钮、成员双击定位……在新画布上全是**死控件** —— 点了毫无反馈
        也无报错，用户只会以为编辑器卡了。接线是幂等的（`_panel_wired` 挡住重复
        连接：面板是页面级共享的，每换一个场景就会再走一次这里）。
        """
        if getattr(self, "_panel_wired", False):
            return
        self._panel_wired = True
        p = self._props
        pairs = [
            ("delete_current_entity_requested", lambda: self.delete_selected()),
            ("group_delete_requested", self._on_group_delete),
            ("group_select_members_requested", self._on_group_select_members),
            ("group_anchor_reset_requested", self._on_group_anchor_reset),
            ("group_translate_requested", self._on_group_translate),
            ("group_member_activated", self.select_entity),
            ("scene_directly_written", self._on_scene_directly_written),
            ("light_place_mode_changed", self._on_light_place_mode),
            ("npc_patrol_preview_changed", self._on_patrol_preview_toggled),
        ]
        for name, slot in pairs:
            sig = getattr(p, name, None)
            if sig is not None:
                sig.connect(slot)
        for attr, slot in (("_multi_group_btn", self._on_assign_group_clicked),
                           ("_multi_dup_btn", lambda: self.duplicate_selected()),
                           ("_multi_del_btn", lambda: self.delete_selected())):
            btn = getattr(p, attr, None)
            if btn is not None:
                btn.clicked.connect(slot)

    def _on_scale_reference_toggled(self, on: bool) -> None:
        """NPC 比例参考框：画布上唯一的世界单位实物比例尺。"""
        if self._view is None:
            return
        if not on:
            self._view.scale_reference.setVisible(False)
            return
        w, h = reference_world_size(self._model)
        self._view.scale_reference.setVisible(True)
        self._view.set_scale_reference(w, h, f"参考角色 {w:g}×{h:g}")

    def _on_patrol_preview_toggled(self, npc_id: str, on: bool) -> None:
        """「画布预览巡逻（不写回 x,y）」。

        面板是新老画布共用的，所以这个复选框在 v2 上照常显示、照常可勾 ——
        没接线时勾了什么都不发生，策划会以为是自己的路线/速度配错了，
        去改一堆本来没问题的数据。
        """
        nid = str(npc_id or "")
        if not nid:
            return
        if on:
            self._patrol_walkers[nid] = PatrolWalker()
        else:
            self._patrol_walkers.pop(nid, None)
            # 关掉时把精灵拨回数据里的真实位置
            if self._view is not None:
                self._view.set_move_preview((), 0.0, 0.0)
                self._view._sync_entity(EntityRef("npc", nid))

    def _tick_patrol_previews(self) -> None:
        """把预览中的 NPC 沿路线挪一步。**只动画面，不写 x/y。**"""
        if self._doc is None or self._view is None or not self._patrol_walkers:
            return
        for nid, walker in list(self._patrol_walkers.items()):
            ref = EntityRef("npc", nid)
            npc = self._doc.entity(ref)
            if not isinstance(npc, dict):
                self._patrol_walkers.pop(nid, None)
                continue
            px, py = walker.advance(npc, _ANIM_TICK_MS / 1000.0)
            dx = px - float(npc.get("x", 0) or 0)
            dy = py - float(npc.get("y", 0) or 0)
            for item in self._view.items_of(ref):
                item.set_preview_offset(dx, dy)
        self.resort_content_z()

    def _on_light_place_mode(self, on: bool) -> None:
        tool = getattr(self, "light_place_tool", None)
        if tool is not None:
            tool.set_mode(bool(on))
            if on:
                self._status.setText("点击画布把选中的灯落到该处地面")

    def _on_group_delete(self, gid: str) -> None:
        if self._doc is not None:
            delete_group(self._doc, gid)

    def _on_group_select_members(self, gid: str) -> None:
        if self._doc is None:
            return
        refs = [ref for kind in ("hotspot", "npc", "zone")
                for ref in self._doc.entity_refs(kind)
                if str((self._doc.entity(ref) or {}).get("group", "")) == str(gid)]
        if refs:
            self._doc.set_selection(refs)

    def _on_group_anchor_reset(self, gid: str) -> None:
        """「重置把手」：清掉 `editor.anchor`，回到派生位置。"""
        tool = getattr(self, "group_box_tool", None)
        if tool is not None:
            tool.set_group_anchor(str(gid), None)

    def _on_group_translate(self, gid: str, dx: float, dy: float) -> None:
        if self._doc is not None:
            translate_group(self._doc, gid, dx, dy)

    def _on_scene_directly_written(self, sid: str) -> None:
        """别的对话框直写了某个场景（坐标点选器一族）。

        本页的撤销栈持的是**字段级** before/after，跨过一次外部直写做 undo 会把
        那次直写连带撤掉且 redo 找不回，所以收到就清栈；如果写的正是当前场景，
        还要重投影 —— 否则用户刚建好的出生点在画布和实体树上都看不见，
        会以为没建成而重复新建。

        清栈与重投影由 `Document.notice_external_scene_write` 一步做完（对别的场景
        是空操作）。这里只剩它做不了的一种情形：场景 dict **对象**被换掉了
        （Task 编排 / 导入那一族），那要整份重建 Document / View，走 `reload_from_model`。
        """
        if self._doc is None:
            return
        self._doc.notice_external_scene_write(sid)
        if (str(sid or "") == self.current_scene_id
                and self._loaded_scene_obj is not self._model.scenes.get(sid)):
            self.reload_from_model()

    def _on_assign_group_clicked(self) -> None:
        """多选页的「指派分组」。"""
        if self._doc is None or not self._doc.selection:
            return
        choices = all_group_ids(self._doc)
        gid, ok = QInputDialog.getItem(
            self, "指派分组", "选择或输入分组 id：",
            ["（移出分组）"] + choices, 0, True)
        if not ok:
            return
        target = "" if gid == "（移出分组）" else str(gid or "").strip()
        if target and target not in choices:
            create_group(self._doc, target)
        assign_group(self._doc, list(self._doc.selection), target)

    def _build_axis_bar(self) -> None:
        """三条视图轴的控件：过场编辑视图 / 位面视图 / 时段视图。

        判定层（`shared/scene_view_filters`）与落显隐层（`view.set_presence_filter`）
        一直是好的，缺的纯粹是**控件**：`set_view_axes` 在全仓只有测试在调，
        于是整套"按位面/时段分层预览"在新画布上不可达 —— 多位面/多时段场景里
        实体互相叠死，点选与摆位全靠猜。
        """
        self._axis_combos = {}
        for key, label in (("cutscene", "过场"), ("plane", "位面"), ("phase", "时段")):
            self._axis_bar.addWidget(QLabel(f" {label} "))
            combo = QComboBox()
            combo.setMinimumWidth(120)
            combo.currentIndexChanged.connect(
                lambda _i, k=key: self._on_axis_combo_changed(k))
            self._axis_combos[key] = combo
            self._axis_bar.addWidget(combo)

    def refresh_axis_choices(self) -> None:
        """按当前工程重填三个下拉的候选。别处新建位面/时段后要调它。"""
        combos = getattr(self, "_axis_combos", None)
        if not combos:
            return
        rows = {
            "cutscene": [("（不加载：隐藏仅过场实体）", "")]
            + [(cid, cid) for cid, _ in self._model.all_cutscene_ids()],
            "plane": [("（全部位面）", "")]
            + [(pid, pid) for pid, _ in self._model.all_plane_ids()],
            "phase": [("（全部时段）", "")]
            + [(pid, pid) for pid, _ in self._model.all_time_phase_ids()],
        }
        for key, combo in combos.items():
            prev = combo.currentData()
            combo.blockSignals(True)
            combo.clear()
            for text, value in rows[key]:
                combo.addItem(text, value)
            idx = combo.findData(prev)
            combo.setCurrentIndex(idx if idx >= 0 else 0)
            combo.blockSignals(False)
        self._on_axis_combo_changed(None)

    def _phase_view_id(self) -> str:
        """时段视图选中的段 id（空 = 全部时段 = 白天基底）。"""
        combos = getattr(self, "_axis_combos", None)
        if not combos or "phase" not in combos:
            return ""
        return str(combos["phase"].currentData() or "")

    def _on_axis_combo_changed(self, _key) -> None:
        combos = getattr(self, "_axis_combos", None)
        if not combos:
            return
        # 时段轴还管底图（夜 = 换整张原画）。放在设轴之前/之后都行，但**必须有**：
        # 漏了它，切到夜只藏了人、街还是白天那张。
        self._refresh_background()
        plane = str(combos["plane"].currentData() or "")
        self.set_view_axes(ViewAxes(
            cutscene_id=str(combos["cutscene"].currentData() or ""),
            plane_id=plane or None,
            # "独立世界型"位面里缺省实体不存在 —— 口径与运行时一致
            plane_exclusive=bool(
                plane and self._model.plane_membership(plane) == "exclusive"),
            phase_id=str(combos["phase"].currentData() or "") or None,
            npc_default_phases=tuple(self._model.daylight_phase_ids()),
            # 场景总闸：没开日夜的场景里 phases 一个字都不生效（运行时恒显）
            day_night_enabled=self._scene_day_night_enabled(),
        ))

    def _rebuild_toolbar(self, view) -> None:
        """工具按钮 + 视图动作。

        **按钮必须互斥且跟着当前工具走**：v2 里"现在是什么工具"决定了按下鼠标
        会发生什么，勾选态与真实模式对不上时，用户无从判断自己在哪个模式。
        此前既没有 QActionGroup、也没在 `tool_changed` 时同步，于是点过两个工具
        两个按钮都亮着，而启动时活着的那个反而不亮。
        """
        self._toolbar.clear()
        group = QActionGroup(self._toolbar)
        group.setExclusive(True)
        self._tool_actions = {}
        for tool in view.tools.tools:
            act = self._toolbar.addAction(tool.display_name)
            act.setCheckable(True)
            group.addAction(act)
            # **每个按钮都要有 tooltip**。只有一个两三字的按钮名时，用户唯一能做的
            # 就是挨个点开试 —— 而这套画布里"现在是哪个工具"决定了按下鼠标会发生
            # 什么，试错的代价不小。
            act.setToolTip(getattr(tool, "tooltip", "") or tool.status_hint)
            act.triggered.connect(lambda _c, t=tool: view.tools.select(t))
            self._tool_actions[tool.tool_id] = act
        view.tools.tool_changed.connect(self._sync_tool_actions)
        self._toolbar.addSeparator()
        act_ref = self._toolbar.addAction("比例参考")
        act_ref.setCheckable(True)
        act_ref.setToolTip("在世界左上/右下各画一个与角色同尺寸的框，"
                           "用来判断世界尺寸与交互半径的量级")
        act_ref.toggled.connect(self._on_scale_reference_toggled)
        act_lock = self._toolbar.addAction("锁定 Zone")
        act_lock.setCheckable(True)
        act_lock.setToolTip("勾上之后 Zone 不参与点选（仍然显示），"
                            "方便选中被大面积 Zone 盖住的实体")
        act_lock.toggled.connect(
            lambda on: setattr(view, "zone_pick_frozen", bool(on)))
        act_boxes = self._toolbar.addAction("分组框")
        act_boxes.setCheckable(True)
        act_boxes.setChecked(True)
        act_boxes.toggled.connect(self._on_group_boxes_toggled)
        # 视图动作：缩放 / 适配 / 撤销 / 重做。老画布工具栏上都有；
        # 没有"适配"时视口一旦跑偏只能靠滚轮一格一格摇回来。
        for text, tip, slot in (
                ("−", "缩小画布视图", lambda: view.zoom_by(1 / 1.15)),
                ("+", "放大画布视图（Ctrl+滚轮同效）", lambda: view.zoom_by(1.15)),
                ("适配", "把整个场景适配到视口", self.fit_view),
                ("撤销", "撤销上一步画布编辑（Ctrl+Z）；"
                        "焦点在输入框里时退的是那一格字", self.editor_undo),
                ("重做", "重做（Ctrl+Y）", self.editor_redo)):
            act = self._toolbar.addAction(text)
            act.setToolTip(tip)
            act.triggered.connect(slot)

    def _sync_tool_actions(self, tool) -> None:
        act = self._tool_actions.get(getattr(tool, "tool_id", ""))
        if act is not None and not act.isChecked():
            act.setChecked(True)

    def _show_canvas_menu(self, world_pos, global_pos) -> None:
        """画布右键菜单：**在落点就地新建**，外加对选中项的删除/复制。

        老画布最常用的建实体方式就是"在想要的位置右键"。v2 起初一个 QMenu 都
        没有，只能先切到某个"新建"工具再点 —— 而三个新建工具当时还重名。
        """
        if self._doc is None:
            return
        menu = QMenu(self._view)
        for kind, label in (("hotspot", "在此新建热点"),
                            ("npc", "在此新建 NPC"),
                            ("zone", "在此新建区域")):
            act = menu.addAction(label)
            act.triggered.connect(
                lambda _c, k=kind, p=QPointF(world_pos): create_entity_at(
                    self._doc, k, p))
        act_spawn = menu.addAction("在此新建命名出生点")
        act_spawn.triggered.connect(
            lambda _c, p=QPointF(world_pos): self._create_spawn_at(p))
        menu.addSeparator()
        act_group = menu.addAction("新建分组")
        act_group.triggered.connect(lambda _c: create_group(self._doc))
        sel = self._doc.selection
        if sel:
            menu.addSeparator()
            act_assign = menu.addAction(f"指派分组（{len(sel)}）…")
            act_assign.triggered.connect(self._on_assign_group_clicked)
            act_dup = menu.addAction(f"复制选中（{len(sel)}）")
            act_dup.triggered.connect(self.duplicate_selected)
            act_del = menu.addAction(f"删除选中（{len(sel)}）")
            act_del.triggered.connect(self.delete_selected_interactive)
        # 摆位是在画布上做的，改名/迁移/安全删除也该在这儿够得着。此前只有实体树
        # 右键挂了重构，画布上唯一的删除入口是上面那颗**裸删**——引用报告看都看不到。
        self._add_refactor_actions(menu)
        menu.exec(global_pos)

    # ---- 跨文件重构（改名 / 迁移 / 安全删除）---------------------------------
    #
    # 这三件事最容易搞坏引用：改名/迁移/删除一个被别处引用的实体，不跟随改写就是
    # 悬垂引用，而且**没有任何提示**，要等 Validate Data 才发现。老画布为此专门
    # 有一个"重构"菜单：先全项目扫描、弹预览、确认才执行。新画布起初一个入口
    # 都没有，删除就是裸删。
    #
    # 实现全部在 `shared/entity_refactor`（跨文件机械改写 + 自己的撤销日志），
    # 弹窗复用 `shared/entity_refactor_dialog` —— **与老画布同一套**。注意它
    # **不进本页的 QUndoStack** —— 跨文件改写撤不进字段级命令栈，撤销走
    # `entity_refactor.undo_last`。
    #
    # 这里曾经手拼过一份简化版（QInputDialog + QMessageBox），四处与引擎对不上，
    # 而且**全部静默**：
    #   1. 读 `usages["total"]` / `["rows"]` / `["hits"]` —— 报告里计数叫
    #      `totalRefs`，明细是按处置类别分的组（qualified / sceneLocal /
    #      dialogues / globalRefs / ownerBindings / tagRefs / questGuidance /
    #      bubbleLineSpeakers），那三个键**一个都不存在**。于是改名/迁移/删除
    #      三个框恒报「全项目有 0 处引用」+ 空预览：越是引用多的实体，越是被
    #      这句话骗着删掉。
    #   2. `move_entity(model, sid, target, kind, id)` —— 引擎签名是
    #      `(model, src_scene, kind, entity_id, dst_scene)`，实参整体错位一格。
    #   3. `delete_entity` 不传 `force`（有引用时引擎硬拒），也没接返回的
    #      `reverse_ops`。
    #   4. 三条路径都没 `push_journal` —— 菜单上那颗「撤销上次重构」读的就是
    #      这本日志，于是本页做的重构**永远撤不回来**（更糟：撤到的是别处更早
    #      的那一次）。
    # 共享对话框里这四件事全是对的，别再另起一套。

    #: 重构 op → 共享对话框类名（延迟 import：这几个框拉起 IdRefSelector 等重控件）
    _REFACTOR_DIALOGS = {
        "move": "MoveEntityDialog",
        "rename": "RenameEntityDialog",
        "delete": "SafeDeleteEntityDialog",
    }

    #: 菜单项文案 → op。画布与实体树两处右键共用，顺序即菜单顺序。
    _REFACTOR_MENU = (
        ("重命名 id…", "rename"),
        ("迁移到场景…", "move"),
        ("安全删除（引用报告）…", "delete"),
    )

    def _add_refactor_actions(self, menu: QMenu) -> bool:
        """选中恰好一个实体时，把重构三项 + 撤销挂到 `menu` 上；返回挂没挂。

        **画布右键与实体树右键共用这一段。** 两处各写一遍就是两套门条件，迟早漂成
        「树里能改名、画布上不能」这种没人说得清的差别——而实际上这两处指的是
        同一个选择集（`SceneDocument.selection`）。

        门条件与 `refactor_selected` 的过滤**必须同口径**：那边按
        `kind in (hotspot/npc/zone/spawn)` 过滤后要求恰好一个，这里就照抄。
        树菜单此前的写法是「非 spawn 实体恰好 1 个」，选中 [npc, spawn] 时菜单
        照挂、点下去却被拒——菜单显示的可用性与真实可用性对不上。
        """
        doc = self._doc
        if doc is None:
            return False
        targets = [r for r in doc.selection
                   if r.kind in ("hotspot", "npc", "zone", "spawn")]
        if len(targets) != 1:
            return False
        menu.addSeparator()
        for label, op in self._REFACTOR_MENU:
            act = menu.addAction(label)
            act.triggered.connect(lambda _c, o=op: self.refactor_selected(o))
        act = menu.addAction("撤销上次重构")
        act.triggered.connect(lambda _c: self.undo_last_refactor())
        return True

    def refactor_selected(self, op: str) -> bool:
        """`op` ∈ {"rename", "move", "delete"}。返回是否真的执行了。"""
        if self._doc is None:
            return False
        cls_name = self._REFACTOR_DIALOGS.get(op)
        if cls_name is None:
            return False
        sel = [r for r in self._doc.selection
               if r.kind in ("hotspot", "npc", "zone", "spawn")]
        if len(sel) != 1:
            self._doc.notify("请先选中恰好一个实体再做重构")
            return False
        ref = sel[0]
        if ref.kind == "spawn" and ref.id == "default":
            self._doc.notify("默认出生点不参与重构")
            return False
        sid = self.current_scene_id
        from ...shared import entity_refactor_dialog as erd
        try:
            dlg = getattr(erd, cls_name)(self._model, sid, ref.kind, ref.id, self)
        except Exception as exc:  # noqa: BLE001 - 扫描期异常给提示，不崩编辑器
            QMessageBox.warning(self, "实体重构", f"引用扫描失败：{exc}")
            return False
        if not dlg.exec() or dlg.result_summary is None:
            return False
        summary = dlg.result_summary
        # 跨文件改写绕过了本页的命令栈：**必须清栈**。字段级命令的快照是重构前的
        # 那份场景，撤过这道坎就是把已经机械改写过的引用网撕成半截。
        # （`reload_from_model` 在场景 dict 对象身份没变时只重投影、刻意保住栈，
        # 所以清栈这一步得在这儿自己做。）
        self._doc.undo_stack.clear()
        self.reload_from_model()
        self._post_refactor_notice(op, summary, ref)
        return True

    def _post_refactor_notice(self, op: str, summary: dict, ref) -> None:
        """重构完成后回选实体并把**引擎实际做了什么**说清楚。

        与老画布同口径：迁移的悬垂裸引用数、改名跳过的歧义对话图、删除后的悬垂
        计数，都是"数据已经变了但还没人告诉你"的东西——不当场说，就得等
        Validate Data 才发现。
        """
        doc = self._doc
        if doc is None:
            return
        kind = ref.kind
        if op == "move":
            dst = summary.get("dstScene") or ""
            dangling = len(summary.get("danglingSceneLocal") or [])
            msg = f"已迁移到「{dst}」；坐标保留原值，请在目标场景重新摆位。"
            if dangling:
                msg += f"\n源场景仍有 {dangling} 处裸引用悬垂（见 Validate Data）。"
        elif op == "rename":
            new_id = str(summary.get("newId") or "")
            if new_id and kind in ("hotspot", "npc", "zone"):
                doc.set_selection([EntityRef(kind, new_id)])
            skipped = (summary.get("scope") or {}).get("skippedDialogues") or []
            msg = f"已改名为「{new_id}」。"
            if skipped:
                msg += f"\n未自动改写（指向歧义）的对话图：{'、'.join(skipped)}"
        else:
            msg = (f"已删除「{ref.id}」；"
                   f"{summary.get('danglingRefs', 0)} 处引用悬垂（跑 Validate Data 查看）。")
        QMessageBox.information(self, "实体重构", msg)
        doc.notify(f"重构完成（{op}）。撤销请用「重构 → 撤销上次重构」")

    def undo_last_refactor(self) -> bool:
        """撤销上一次跨文件重构。**与 Ctrl+Z 是两条独立的历史** ——
        字段级命令栈撤不了跨文件机械改写。"""
        try:
            undo_last(self._model)
        except EntityRefactorError as exc:
            QMessageBox.warning(self, "撤销重构失败", str(exc))
            return False
        self.reload_from_model()
        return True

    def _show_tree_menu(self, pos) -> None:
        if self._doc is None:
            return
        sel = list(self._doc.selection)
        menu = QMenu(self._tree)
        groups = [r for r in sel if r.kind == "group"]
        entities = [r for r in sel if r.kind in ("hotspot", "npc", "zone")]
        if groups:
            act = menu.addAction(f"删除分组「{groups[0].id}」")
            act.triggered.connect(lambda _c, g=groups[0].id: self._on_group_delete(g))
            act2 = menu.addAction("选中本组全部成员")
            act2.triggered.connect(
                lambda _c, g=groups[0].id: self._on_group_select_members(g))
        if entities:
            act = menu.addAction(f"指派分组（{len(entities)}）…")
            act.triggered.connect(self._on_assign_group_clicked)
        if sel:
            menu.addSeparator()
            act_dup = menu.addAction(f"复制（{len(sel)}）")
            act_dup.triggered.connect(self.duplicate_selected)
            act_del = menu.addAction(f"删除（{len(sel)}）")
            act_del.triggered.connect(self.delete_selected_interactive)
        self._add_refactor_actions(menu)
        if menu.isEmpty():
            act = menu.addAction("新建分组")
            act.triggered.connect(lambda _c: create_group(self._doc))
        menu.exec(self._tree.viewport().mapToGlobal(pos))

    def _sync_live_xy_widgets(self) -> None:
        """拖动中把 x/y 实时喂给属性面板的数值框。

        数据此刻**没有**被改（手势不写数据），喂的是预览位置。不喂的话想拖到某个
        精确坐标时没有实时读数，只能松手看一眼、不对再拖一次。
        """
        if self._doc is None or self._view is None:
            return
        offsets = self._view.preview_offsets()
        if not offsets or self._bridge is None:
            return
        # **必须挡住桥**：面板的回写方法末尾会 `_emit_props_changed()`，
        # 不挡就会把预览坐标当成用户编辑提交成命令 —— 手势中写了数据，
        # 而且模型一动、图元的数据位跟着动，预览位移再叠上去，实体越拖越快地飘走。
        with self._bridge.pushing_values():
            for ref, (dx, dy) in offsets.items():
                ent = self._doc.entity(ref)
                if not isinstance(ent, dict) or "x" not in ent:
                    continue
                setter = getattr(
                    self._props,
                    {"hotspot": "sync_hotspot_xy_widgets",
                     "npc": "sync_npc_xy_widgets"}.get(ref.kind, ""), None)
                if callable(setter):
                    setter(ref.id, float(ent["x"]) + dx, float(ent["y"]) + dy)

    def _create_spawn_at(self, world_pos) -> None:
        name, ok = QInputDialog.getText(self, "新建命名出生点", "出生点名称：")
        if ok and str(name or "").strip():
            create_spawn(self._doc, str(name).strip(),
                         world_pos.x(), world_pos.y())

    def fit_view(self) -> None:
        """把整个场景适配到视口。"""
        if self._view is not None:
            self._view.fit_scene()

    # ---- 视图轴与 z 序 -----------------------------------------------------

    def set_view_axes(self, axes: ViewAxes) -> None:
        """设置三条视图轴。**日夜总闸那一格不收调用方的**，一律从当前场景重新派生。

        机制卡 scene-view-filter-axes 的硬契约：「总闸跟场景走，不跟轴选择走」。
        照收传进来的值就等于给了调用方一个开关，可以在一个没开日夜的场景上按时段
        把实体藏起来——而运行时那边它们恒显，正是这张卡要消灭的「编辑器骗人」。
        三个组装点（时段下拉 / 装载场景 / 场景属性变更）填的值与这里派生的一致，
        所以它们经过这条路不会被改写。
        """
        self._axes = replace(axes, day_night_enabled=self._scene_day_night_enabled())
        self._apply_view_axes()

    def _scene_day_night_enabled(self) -> bool:
        """当前场景的时段总闸。装载/切场景时要重新取——轴的选择跨场景保留，
        而"这个场景开没开日夜"是场景自己的事，不跟着选择走。"""
        return scene_day_night_enabled(
            self._doc.scene() if self._doc is not None else None)

    def _sync_day_night_gate(self) -> bool:
        """把当前场景的总闸并回轴状态，返回"变了没有"。

        装载新场景 / 场景属性改了「启用日夜」时调：轴的其余几格保留用户选择，
        只有这一格必须换成新场景自己的——不换的话，从开了日夜的场景切到没开的，
        时段过滤会继续按上一个场景的闸把实体藏着，而运行时那边它们恒显。
        """
        want = self._scene_day_night_enabled()
        if self._axes.day_night_enabled == want:
            return False
        self._axes = replace(self._axes, day_night_enabled=want)
        return True

    def _rebuild_group_index(self) -> None:
        """重建 `gid -> 组定义` 映射。**就地改**，理由见 `_group_index` 的注释。

        只认 `entityGroups` 里的显式条目 —— 与运行时
        `SceneManager.currentSceneGroupPhases` 同口径：只在成员身上出现的兼容标签组
        没有定义，按无条件组处理（它照样有框、能拖，只是不施加时段限制）。
        """
        index = self._group_index
        index.clear()
        sc = (self._doc.scene() if self._doc is not None else None) or {}
        for g in sc.get("entityGroups") or []:
            if not isinstance(g, dict):
                continue
            gid = str(g.get("id", "") or "").strip()
            if gid and gid not in index:      # 撞名取第一条，与运行时的 find 一致
                index[gid] = g

    def _apply_view_axes(self) -> None:
        if self._view is None:
            return
        axes = self._axes
        self._rebuild_group_index()
        # 分组框只吃时段这一条轴，但它同样是"合成一次再落显隐"，所以跟实体一起刷
        self._apply_group_box_presence()
        if not axes.any_active:
            self._view.set_presence_filter(None)
            return
        self._view.set_presence_filter(_presence_predicate(axes, self._group_index))

    def _apply_group_box_presence(self) -> None:
        """分组框的显隐：**用户总开关 ∧ 时段轴**，合成一个判定再落。

        位面轴与过场轴刻意不参与，理由见 `passes_group_box_filters` ——
        并进去会让 exclusive 位面视图下全场分组框消失。

        **藏起来的框同时要退出命中册子**：`GroupBoxTool._box_at` 只比几何、
        不看 `isVisible`，留在册子里就是一个看不见的点击靶 —— 用户以为点的是空白，
        实际选中了一个组，再按方向键（很多人用方向键的肌肉记忆）就把整组坐标改了，
        而画布上一个动的东西都没有。
        """
        if self._view is None:
            return
        visible: dict[str, object] = {}
        for gid, box in self._view.group_boxes.items():
            on = self._group_boxes_on and passes_group_box_filters(
                self._group_index.get(gid), self._axes)
            box.setVisible(on)
            if on:
                visible[gid] = box
            else:
                box.set_selected(False)
        tool = getattr(self, "group_box_tool", None)
        if tool is None:
            return
        if tool.selected_gid and tool.selected_gid not in visible:
            tool.select_group("")
        tool.set_boxes(visible)

    def _on_group_boxes_toggled(self, on: bool) -> None:
        """「分组框」总开关。**不能直接接到 `view.set_group_boxes_visible`** ——
        那条路无条件把每个框都点亮，会把时段轴藏起来的空框放出来。"""
        self._group_boxes_on = bool(on)
        if self._view is not None:
            # 视图自己的标志仍要跟着走：新建的框以它为初值
            self._view.set_group_boxes_visible(self._group_boxes_on)
        self._apply_group_box_presence()

    def resort_content_z(self) -> None:
        if self._doc is None or self._view is None:
            return
        self._content_z_key = assign_content_z(
            self._doc, self._view, cache=self._content_z_key)

    def refresh_group_boxes(self) -> None:
        """按模型层名册重建分组框。包围盒**不受视图过滤影响** ——
        被藏起来的成员照样算进去，否则框会随着切视图忽大忽小而成员一个没少。"""
        if self._doc is None or self._view is None:
            return
        self._rebuild_group_index()
        sc = self._doc.scene() or {}
        labels = {str(g.get("id", "")): str(g.get("label", "") or "").strip()
                  for g in sc.get("entityGroups") or [] if isinstance(g, dict)}
        rows = []
        # **按 `all_group_ids` 建**：它同时认 `entityGroups` 条目与"只在成员身上
        # 出现"的兼容标签组。只遍历 entityGroups 的话，旧场景在新画布上看不到
        # 任何分组框，用户会以为分组数据丢了 —— 而组框是整组位移的唯一入口。
        for gid in all_group_ids(self._doc):
            rect = group_bounds(self._doc, gid)
            label = labels.get(gid, "")
            count = sum(1 for kind in ("hotspot", "npc", "zone")
                        for ref in self._doc.entity_refs(kind)
                        if str((self._doc.entity(ref) or {}).get("group", "")) == gid)
            rows.append((gid, rect, f"[组] {label or gid} ×{count}"))
        self._view.sync_group_boxes(rows)
        # 自定义把手位置（`editor.anchor`）—— 老画布里摆好的位置在新画布上要生效
        for gid, box in self._view.group_boxes.items():
            ent = self._doc.model_entity(EntityRef("group", gid)) or {}
            editor = ent.get("editor") if isinstance(ent.get("editor"), dict) else {}
            anchor = editor.get("anchor")
            if isinstance(anchor, dict):
                try:
                    box.set_anchor(QPointF(float(anchor.get("x", 0)),
                                           float(anchor.get("y", 0))))
                    continue
                except (TypeError, ValueError):
                    pass
            box.set_anchor(None)
        # 新建的框默认按总开关可见 —— 时段轴要在这里补贴一次，
        # 否则"框在、人没了"的空框会在每次刷新后冒回来（重建丢显隐那一族）。
        # 它同时是把框交给命中册子的**唯一出口**（藏起来的不交）。
        self._apply_group_box_presence()

    def refresh_perspective_axis(self) -> None:
        if self._doc is None or self._view is None:
            return
        cfg = (self._doc.scene() or {}).get("perspectiveScale")
        if not isinstance(cfg, dict):
            self._view.sync_perspective_axis(None, None)
            return
        near, far = cfg.get("near"), cfg.get("far")
        if not isinstance(near, dict) or not isinstance(far, dict):
            self._view.sync_perspective_axis(None, None)
            return
        self._view.sync_perspective_axis(
            QPointF(float(near.get("x", 0)), float(near.get("y", 0))),
            QPointF(float(far.get("x", 0)), float(far.get("y", 0))),
            near_scale=near.get("scale"),
            far_scale=far.get("scale"),
            mid_stops=cfg.get("midStops"))

    def refresh_entity_tree(self) -> None:
        """左侧实体树。选择与 Document 双向同步 —— 树与画布看到的是**同一份**选择集。"""
        if self._doc is None:
            return
        needle = self._tree_filter.text().strip().lower()
        by_group = self._tree_mode.currentIndex() == 1
        self._tree.blockSignals(True)
        self._tree.clear()
        if by_group:
            # 按分组看：**分组也是可选中的节点**（选中后右侧就是分组面板）。
            # 起初树里根本没有分组节点，于是建组/改组名/看成员在新画布上做不到。
            for gid in all_group_ids(self._doc):
                top = QTreeWidgetItem([f"[组] {gid}"])
                top.setData(0, Qt.ItemDataRole.UserRole, ("group", gid))
                self._tree.addTopLevelItem(top)
                for kind in ("hotspot", "npc", "zone"):
                    for ref in self._doc.entity_refs(kind):
                        ent = self._doc.entity(ref) or {}
                        if str(ent.get("group", "")) != gid:
                            continue
                        if needle and needle not in ref.id.lower():
                            continue
                        node = QTreeWidgetItem([ref.id])
                        node.setData(0, Qt.ItemDataRole.UserRole,
                                     (ref.kind, ref.id))
                        top.addChild(node)
                top.setExpanded(True)
            ungrouped = QTreeWidgetItem(["（未分组）"])
            self._tree.addTopLevelItem(ungrouped)
            for kind in ("hotspot", "npc", "zone"):
                for ref in self._doc.entity_refs(kind):
                    ent = self._doc.entity(ref) or {}
                    if str(ent.get("group", "")):
                        continue
                    if needle and needle not in ref.id.lower():
                        continue
                    node = QTreeWidgetItem([ref.id])
                    node.setData(0, Qt.ItemDataRole.UserRole, (ref.kind, ref.id))
                    ungrouped.addChild(node)
            ungrouped.setExpanded(True)
        else:
            for kind, label in (("hotspot", "热点"), ("npc", "NPC"),
                                ("zone", "区域"), ("spawn", "出生点")):
                top = QTreeWidgetItem([label])
                self._tree.addTopLevelItem(top)
                for ref in self._doc.entity_refs(kind):
                    if needle and needle not in ref.id.lower():
                        continue
                    node = QTreeWidgetItem([ref.id])
                    node.setData(0, Qt.ItemDataRole.UserRole, (ref.kind, ref.id))
                    top.addChild(node)
                top.setExpanded(True)
        self._tree.blockSignals(False)
        self._sync_tree_selection()

    def _scroll_tree_to_selection(self) -> None:
        """把树滚到当前选中那一行 —— 否则画布上点一个实体，树里对应行可能在
        滚动区外，看不到高亮。"""
        if self._doc is None or self._syncing_tree:
            return
        chosen = set(self._doc.selection)
        if not chosen:
            return
        it = QTreeWidgetItemIterator(self._tree)
        while it.value():
            node = it.value()
            data = node.data(0, Qt.ItemDataRole.UserRole)
            if data is not None and EntityRef(*data) in chosen:
                self._tree.scrollToItem(node)
                break
            it += 1

    def _center_on_selection(self) -> None:
        """把画布滚到当前选择上。

        树里点一行画布不滚过去、画布上点一个实体树也不滚到那一行时，实体多的
        场景里树基本失去"定位"功能：点一行只能看见树自己变蓝，找不到东西在哪。
        """
        if self._doc is None or self._view is None:
            return
        sel = self._doc.selection
        if len(sel) != 1:
            return
        for part in ("handle", "polygon", "display", "sprite"):
            item = self._view.item_for(sel[0], part)
            if item is not None and item.isVisible():
                self._view.centerOn(item)
                return

    def _sync_tree_selection(self) -> None:
        if self._doc is None or self._syncing_tree:
            return
        chosen = set(self._doc.selection)
        self._syncing_tree = True
        try:
            self._tree.blockSignals(True)
            it = QTreeWidgetItemIterator(self._tree)
            while it.value():
                node = it.value()
                data = node.data(0, Qt.ItemDataRole.UserRole)
                if data is not None:
                    node.setSelected(EntityRef(*data) in chosen)
                it += 1
            self._tree.blockSignals(False)
        finally:
            self._syncing_tree = False

    def _on_tree_selection_changed(self) -> None:
        if self._doc is None or self._syncing_tree:
            return
        refs = []
        for node in self._tree.selectedItems():
            data = node.data(0, Qt.ItemDataRole.UserRole)
            if data is not None:
                refs.append(EntityRef(*data))
        self._syncing_tree = True
        try:
            self._doc.set_selection(refs)
        finally:
            self._syncing_tree = False
        # 树里点一行 → 画布滚过去（老画布的 `_focus_canvas_on_entity` 同位）
        self._center_on_selection()

    def _on_doc_changed(self, event) -> None:
        if isinstance(event, SceneReloaded):
            # 整份重建换了一批全新图元：内容层 z 的脏检查缓存键刻意不含图元身份
            # （理由见 `load_scene`），不作废就会早退、新图元全停在 z=0。
            self._content_z_key = None
        # 任何数据变更都可能改前后关系；脏检查让这一趟在没变时是空操作
        self.resort_content_z()
        if isinstance(event, SelectionChanged):
            self._sync_tree_selection()
            self._scroll_tree_to_selection()
            # 有些工具的提示**随选择变**（「编辑多边形」要说清当前能编什么），
            # 选择一变就重播一次，否则状态栏一直停在"先选中一个…"上。
            tool = self._view.tools.current if self._view is not None else None
            if tool is not None:
                tool.announce()
            return
        self.refresh_group_boxes()
        self.refresh_perspective_axis()
        self.refresh_scene_geometry()
        # **场景级字段变了要重刷背景。** 在面板里换/导入背景图或改世界尺寸之后
        # 不刷的话，画布仍显示旧背景（或"本场景无背景图"占位），而磁盘与数据其实
        # 已经换了 —— 用户会以为导入失败反复重导；sceneRect 也停在旧世界尺寸，
        # 适配与滚动范围全是错的，必须切走场景再切回来才恢复。
        if isinstance(event, SceneReloaded) or (
                isinstance(event, EntitiesChanged)
                and any(r.kind == "scene" for r in event.refs)):
            self._refresh_background()
            # 场景属性页可能刚拨了「启用日夜」：时段轴的总闸跟着换，并当场重贴。
            # 不接的话，关掉日夜之后画布还按时段藏着实体，而运行时已经恒显了。
            if self._sync_day_night_gate():
                self._apply_view_axes()
        if isinstance(event, (EntitiesAdded, EntitiesRemoved, SceneReloaded)):
            self.refresh_entity_tree()
        elif (isinstance(event, EntitiesChanged)
                and event.properties & EntityProperty.IDENTITY
                and any(self._doc.model_entity(r) is None for r in event.refs)):
            # 改了 id：事件里带着旧 ref（已经查不到）与新 ref。树按 id 列行，不重建
            # 就一直显示旧 id、点它选不中任何东西。只在**真的换了 id** 时重建 ——
            # name / label 也归 IDENTITY，但树不显示它们，逐字敲名字不该每键重建一次树。
            self.refresh_entity_tree()
        # **组的时段归属改了、成员换了组、整份场景被换掉 → 重贴显隐。**
        # 视图收到变更时是拿着旧名册判的（它的 `changed` 订阅早于本页），
        # 不补这一趟的话：改完组的「时段归属」画布纹丝不动，用户会以为没生效
        # 而去改数据；撤销回灌（SceneReloaded）之后更是拿上一份场景的分组在判。
        if isinstance(event, (EntitiesAdded, EntitiesRemoved, SceneReloaded)) or (
                isinstance(event, EntitiesChanged)
                and event.properties & (EntityProperty.GROUPING
                                        | EntityProperty.PRESENCE)):
            self._apply_view_axes()

    # ---- 编辑动作（供快捷键/菜单接线）--------------------------------------

    def delete_selected(self) -> bool:
        """删除当前选择（**不弹窗**）。

        删除是可撤销的，所以这条路不拦；但**必须说出刚删了什么** ——
        误触 Delete（尤其焦点不明确时）之后，用户至少要知道发生了什么才想得起
        按 Ctrl+Z。菜单那条路另有确认（`delete_selected_interactive`）。

        刻意不在这里弹模态：本方法也是程序化入口（快捷键、面板按钮、测试都走它），
        塞一个模态循环进去会让无头环境**挂死**。
        """
        if self._doc is None:
            return False
        sel = list(self._doc.selection)
        if not sel:
            return False
        names = "、".join(f"{r.kind}:{r.id}" for r in sel[:6])
        more = f" 等 {len(sel)} 个" if len(sel) > 6 else ""
        if not delete_selected(self._doc):
            return False
        self._doc.notify(f"已删除 {names}{more}（Ctrl+Z 可撤销）")
        return True

    def delete_selected_interactive(self) -> bool:
        """菜单里的删除：先问一句再删。"""
        if self._doc is None or not self._doc.selection:
            return False
        n = len(self._doc.selection)
        names = "、".join(f"{r.kind}:{r.id}" for r in list(self._doc.selection)[:6])
        more = f" 等 {n} 个" if n > 6 else ""
        if QMessageBox.question(
                self, "删除实体",
                f"从场景删除 {names}{more}？") != QMessageBox.StandardButton.Yes:
            return False
        return self.delete_selected()

    def duplicate_selected(self) -> bool:
        return duplicate_selected(self._doc) if self._doc else False

    def select_entity(self, kind: str, entity_id: str) -> bool:
        """供全局搜索/跨页跳转定位到某个实体。"""
        if self._doc is None:
            return False
        ref = EntityRef(kind, entity_id)
        if self._doc.model_entity(ref) is None:
            return False
        self._doc.set_selection([ref])
        item = self._view.item_for(ref, "handle") if self._view else None
        if item is not None and self._view is not None:
            self._view.centerOn(item)
        return True

    # ---- 跨页跳转落点（主窗口按这些方法名找页）------------------------------
    #
    # `scene_page_registry.NAV_TARGET` 承诺"改一个常量就能把跳转整体切到新画布"。
    # 这几个方法缺一个，切过去之后那一类跳转就**静默失效**：页切了、定位没做，
    # 用户点搜索结果跳过来发现是空的。

    def select_scene_by_id(self, scene_id: str) -> bool:
        return self.load_scene(str(scene_id or ""))

    def select_hotspot_by_id(self, scene_id: str, entity_id: str) -> bool:
        return self._select_in_scene(scene_id, "hotspot", entity_id)

    def select_npc_by_id(self, scene_id: str, entity_id: str) -> bool:
        return self._select_in_scene(scene_id, "npc", entity_id)

    def select_zone_by_id(self, scene_id: str, entity_id: str) -> bool:
        return self._select_in_scene(scene_id, "zone", entity_id)

    def _select_in_scene(self, scene_id: str, kind: str, entity_id: str) -> bool:
        sid = str(scene_id or "").strip()
        if sid and sid != self.current_scene_id and not self.load_scene(sid):
            return False
        return self.select_entity(kind, str(entity_id or ""))

    def activate_plane_view(self, plane_id: str) -> bool:
        """外部跳转入口（位面面板 hub）：打开指定位面的位面视图。

        未知 / 空 id 回落"全部位面"。缺了它，位面页那种"带位面的跳转"
        在新画布上无从落地。
        """
        combo = getattr(self, "_axis_combos", {}).get("plane")
        if combo is None:
            return False
        idx = combo.findData(str(plane_id or "").strip())
        combo.setCurrentIndex(idx if idx >= 0 else 0)
        return True

    def reload_refs_from_model(self) -> None:
        """别处新建了物品/滤镜/遭遇/BGM/立绘/动画包之后刷新引用候选。

        缺了这个钩子，「要重启编辑器才看得到刚建的东西」那一族老 bug 会在新画布
        上原样复活 —— 面板下拉里永远看不见新引用。
        """
        reload = getattr(self._props, "reload_refs_from_model", None)
        if callable(reload):
            reload()
        self.refresh_axis_choices()

    # ---- 主窗口鸭子协议钩子 ------------------------------------------------

    def flush_to_model(self) -> bool:
        """Save All / 关闭前提交未应用编辑。

        **本页恒为 True**：没有 staging 层，命令一旦构造就已经落到模型里了，
        不存在"未应用"这个状态。钩子仍然实现，因为主窗口是按鸭子协议逐个调的，
        缺了它主窗口会把本页当成"缺钩子"锁死。
        """
        return True

    def commit_pending_on_leave(self) -> bool:
        """切到别的页之前提交。理由同 `flush_to_model`，恒为 True。"""
        return True

    def confirm_close(self, parent: QWidget | None = None) -> bool:
        """关闭 / 切工程门控。没有未应用编辑可丢，故恒允许。

        场景本身是否脏由 `ProjectModel.is_dirty` 判断，主窗口统一询问是否保存 ——
        那一层不归本页管。
        """
        return True

    def reload_from_model(self) -> None:
        """别的编辑器替换了场景域之后，按模型重投影。

        必须**保住当前选择**：不保的话，Task 编排替换场景后用户的选中态丢失，
        属性面板会掉回场景级，看着像"我刚才在编辑的东西没了"。

        **场景 dict 还是同一个对象时不重建。** 主窗口每次切页都调本方法，而
        `load_scene` 会新建 Document 与 View —— 于是每查一次别的页就丢一次
        视口位置（逐个摆位时要重新找回刚才在编辑的那块区域），**撤销历史也
        一起没**（在用户完全没意识到的时机被清空，误操作再也退不回去）。
        老画布在同样的路径上是保住的，那属于实打实的倒退。

        判据是**对象身份**而不是内容比对：别的编辑器"替换场景域"时换的就是
        dict 对象本身（Task 编排、导入、切工程）；只是改了里面的字段则不必重建，
        重投影一遍就够。
        """
        sid = self.current_scene_id
        self.refresh_scene_list()
        if not sid or sid not in self._model.scenes:
            return
        # 与**装载那一刻**记下的对象比。不能拿 `self._doc.scene()` 比 ——
        # 它每次都现读 `model.scenes[sid]`，于是永远等于当前对象，"被换掉了"
        # 这件事就再也检测不到，该重建的一趟被静默跳过。
        same_object = (self._doc is not None
                       and self._loaded_scene_obj is self._model.scenes[sid])
        if same_object:
            self._reproject_in_place()
            return
        selection = tuple(self._doc.selection) if self._doc else ()
        self.load_scene(sid)
        if self._doc is not None and selection:
            alive = [r for r in selection if self._doc.model_entity(r) is not None]
            if alive:
                self._doc.set_selection(alive)

    def _reproject_in_place(self) -> None:
        """按现有 Document 重画一遍：视口、撤销栈、选择全部保住。"""
        if self._doc is None or self._view is None:
            return
        # **先把已经不存在的实体从选择集里摘掉。** 别的编辑器可能删过东西；
        # 留着悬垂 ref 会让属性面板继续显示一个已经不存在的实体，
        # 用户在那张表单上打的字既不写这个也不写那个。
        self._doc._prune_selection()
        self._content_z_key = None      # 图元没换，但排序键可能已经变了
        self._view.rebuild_all()
        self._refresh_background()
        self._apply_view_axes()
        self.resort_content_z()
        self.refresh_group_boxes()
        self.refresh_perspective_axis()
        self.refresh_scene_geometry()
        self.refresh_entity_tree()
        if self._bridge is not None:
            self._bridge.sync_from_selection()

    @staticmethod
    def _focused_text_widget():
        """焦点在文本框里时，Ctrl+Z 该归那个框（与老画布、TimelineEditor 同法）。

        不交回去的话，在属性面板输入框里打字想退一格，退掉的是画布上一步编辑 ——
        而文本框自己的撤销历史没被用上，这一步在框里不可逆。
        """
        from PySide6.QtWidgets import (
            QApplication, QLineEdit, QPlainTextEdit, QTextEdit,
        )

        fw = QApplication.focusWidget()
        return fw if isinstance(fw, (QLineEdit, QTextEdit, QPlainTextEdit)) else None

    def editor_undo(self) -> None:
        tw = self._focused_text_widget()
        if tw is not None:
            tw.undo()
            return
        if self._doc is not None:
            self._doc.undo_stack.undo()

    def editor_redo(self) -> None:
        tw = self._focused_text_widget()
        if tw is not None:
            tw.redo()
            return
        if self._doc is not None:
            self._doc.undo_stack.redo()
