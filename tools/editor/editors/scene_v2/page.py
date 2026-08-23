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

from PySide6.QtCore import QPointF, Qt, QTimer
from PySide6.QtGui import QActionGroup, QPixmap
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QListWidget,
    QComboBox,
    QListWidgetItem,
    QMenu,
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
from ...shared.scene_view_filters import ViewAxes, passes_view_filters
from .changes import (
    EntitiesAdded,
    EntitiesChanged,
    EntitiesRemoved,
    EntityRef,
    SceneReloaded,
    SelectionChanged,
)
from .document import SceneDocument
from .npc_anim import NpcAnimBank
from .panel_bridge import PanelBridge
from .sorting import assign_content_z
from .tools_builtin import MoveTool, PolygonEditTool, SelectTool
from .tools_overlays import GroupBoxTool, PerspectiveAxisTool, group_bounds
from .tools_structure import (
    CreateTool,
    create_entity_at,
    delete_selected,
    duplicate_selected,
)
from .tools_transform import GroupMoveTool, TransformTool
from .view import SceneView

#: NPC 精灵的动画节拍（毫秒）。~30fps 足够看清动画对不对，
#: 又不至于让 NPC 上百的场景每秒裁上千张图。
_ANIM_TICK_MS = 33

__all__ = ["SceneEditorV2"]


class SceneEditorV2(QWidget):
    """场景编辑器（新画布）。"""

    def __init__(self, model, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._doc: SceneDocument | None = None
        self._view: SceneView | None = None
        self._axes = ViewAxes()
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
        self._syncing_tree = False
        lv.addWidget(QLabel("实体"))
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
        self._pending_fit = False
        self._tool_actions: dict = {}
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
        self._view = SceneView(self._doc, self._canvas_host)
        self._canvas_layout.addWidget(self._view)
        self._view.set_texture_provider(self._load_texture)
        self._view.set_sprite_metrics_provider(self._npc_sprite_metrics)
        self._anim_bank.clear()
        self._view.set_sprite_frame_provider(self._anim_bank.frame_pixmap)
        self._refresh_background()
        self._install_tools()
        self._apply_view_axes()
        self._doc.changed.connect(self._on_doc_changed)
        self._view.content_resort_requested.connect(self.resort_content_z)
        self._view.context_menu_requested.connect(self._show_canvas_menu)
        # **fit 要等 Qt 把 view 真正布局出来。** 刚 addWidget 的 view 视口还是
        # 98x28 之类的占位尺寸，此刻 fit 出来的缩放是正确值的 4~6%：每开一个场景
        # 都要 Ctrl+滚轮摇二十格才能看清。老画布为此专门排了 0/40/120/240ms 四次
        # 重试；这里改成"视口第一次拿到像样尺寸时再 fit"，语义更直接。
        self._pending_fit = True
        self._view.fit_scene()
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
        解析（只认 `background.png`），否则会显示一张游戏根本不加载的背景。"""
        if self._doc is None or self._view is None:
            return
        sc = self._doc.scene() or {}
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
            note = f"{self._doc.scene_id}\n（背景图缺失或文件名不是 background.png）"
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

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt 接口
        """视口第一次拿到像样尺寸时补做那次 fit（见 `load_scene` 里的注释）。"""
        super().resizeEvent(event)
        if not getattr(self, "_pending_fit", False) or self._view is None:
            return
        vp = self._view.viewport()
        if vp.width() > 200 and vp.height() > 150:
            self._pending_fit = False
            self._view.fit_scene()

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
        # **"选择"工具兼管 gizmo 手柄与分组框** —— 回到老画布的无模式手感：
        # 选中一个实体就出手柄、点组框边线就选中组，不必先切工具。
        self.select_tool.add_delegate(self.transform_tool)
        self.select_tool.add_delegate(self.move_tool)
        # 分组框排在**实体点选之后**：框边经过最外侧成员，排前面会吃掉它们的点击
        self.select_tool.add_delegate(self.group_box_tool, after_entities=True)
        view.tools.status_text_changed.connect(self._status.setText)
        self._doc.notice.connect(self._status.setText)
        self._rebuild_toolbar(view)
        view.tools.select(self.select_tool)

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

    def _on_axis_combo_changed(self, _key) -> None:
        combos = getattr(self, "_axis_combos", None)
        if not combos:
            return
        plane = str(combos["plane"].currentData() or "")
        self.set_view_axes(ViewAxes(
            cutscene_id=str(combos["cutscene"].currentData() or ""),
            plane_id=plane or None,
            # "独立世界型"位面里缺省实体不存在 —— 口径与运行时一致
            plane_exclusive=bool(
                plane and self._model.plane_membership(plane) == "exclusive"),
            phase_id=str(combos["phase"].currentData() or "") or None,
            npc_default_phases=tuple(self._model.daylight_phase_ids()),
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
            act.triggered.connect(lambda _c, t=tool: view.tools.select(t))
            self._tool_actions[tool.tool_id] = act
        view.tools.tool_changed.connect(self._sync_tool_actions)
        self._toolbar.addSeparator()
        # 视图动作：缩放 / 适配 / 撤销 / 重做。老画布工具栏上都有；
        # 没有"适配"时视口一旦跑偏只能靠滚轮一格一格摇回来。
        for text, slot in (("−", lambda: view.zoom_by(1 / 1.15)),
                           ("+", lambda: view.zoom_by(1.15)),
                           ("适配", self.fit_view),
                           ("撤销", self.editor_undo),
                           ("重做", self.editor_redo)):
            act = self._toolbar.addAction(text)
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
        sel = self._doc.selection
        if sel:
            menu.addSeparator()
            act_dup = menu.addAction(f"复制选中（{len(sel)}）")
            act_dup.triggered.connect(self.duplicate_selected)
            act_del = menu.addAction(f"删除选中（{len(sel)}）")
            act_del.triggered.connect(self.delete_selected)
        menu.exec(global_pos)

    def fit_view(self) -> None:
        """把整个场景适配到视口。"""
        if self._view is not None:
            self._view.fit_scene()

    # ---- 视图轴与 z 序 -----------------------------------------------------

    def set_view_axes(self, axes: ViewAxes) -> None:
        self._axes = axes
        self._apply_view_axes()

    def _apply_view_axes(self) -> None:
        if self._view is None:
            return
        axes = self._axes
        if not axes.any_active:
            self._view.set_presence_filter(None)
            return
        self._view.set_presence_filter(
            lambda ref, ent: passes_view_filters(ref.kind, ent, axes))

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
        sc = self._doc.scene() or {}
        rows = []
        for grp in sc.get("entityGroups") or []:
            if not isinstance(grp, dict):
                continue
            gid = str(grp.get("id", "") or "")
            if not gid:
                continue
            rect = group_bounds(self._doc, gid)
            label = str(grp.get("label", "") or "").strip()
            rows.append((gid, rect, f"[组] {label or gid}"))
        self._view.sync_group_boxes(rows)
        self.group_box_tool.set_boxes(self._view.group_boxes)

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
            QPointF(float(far.get("x", 0)), float(far.get("y", 0))))

    def refresh_entity_tree(self) -> None:
        """左侧实体树。选择与 Document 双向同步 —— 树与画布看到的是**同一份**选择集。"""
        if self._doc is None:
            return
        self._tree.blockSignals(True)
        self._tree.clear()
        for kind, label in (("hotspot", "热点"), ("npc", "NPC"),
                            ("zone", "区域"), ("spawn", "出生点")):
            top = QTreeWidgetItem([label])
            self._tree.addTopLevelItem(top)
            for ref in self._doc.entity_refs(kind):
                node = QTreeWidgetItem([ref.id])
                node.setData(0, Qt.ItemDataRole.UserRole, (ref.kind, ref.id))
                top.addChild(node)
            top.setExpanded(True)
        self._tree.blockSignals(False)
        self._sync_tree_selection()

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

    def _on_doc_changed(self, event) -> None:
        # 任何数据变更都可能改前后关系；脏检查让这一趟在没变时是空操作
        self.resort_content_z()
        if isinstance(event, SelectionChanged):
            self._sync_tree_selection()
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
        if isinstance(event, (EntitiesAdded, EntitiesRemoved, SceneReloaded)):
            self.refresh_entity_tree()

    # ---- 编辑动作（供快捷键/菜单接线）--------------------------------------

    def delete_selected(self) -> bool:
        return delete_selected(self._doc) if self._doc else False

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
        """
        sid = self.current_scene_id
        selection = tuple(self._doc.selection) if self._doc else ()
        self.refresh_scene_list()
        if sid and sid in self._model.scenes:
            self.load_scene(sid)
            if self._doc is not None and selection:
                alive = [r for r in selection if self._doc.model_entity(r) is not None]
                if alive:
                    self._doc.set_selection(alive)

    def editor_undo(self) -> None:
        if self._doc is not None:
            self._doc.undo_stack.undo()

    def editor_redo(self) -> None:
        if self._doc is not None:
            self._doc.undo_stack.redo()
