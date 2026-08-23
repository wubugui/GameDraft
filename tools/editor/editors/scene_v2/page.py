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

from PySide6.QtCore import QPointF, Qt
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QSplitter,
    QToolBar,
    QTreeWidget,
    QTreeWidgetItem,
    QTreeWidgetItemIterator,
    QVBoxLayout,
    QWidget,
)

from ...shared.scene_view_filters import ViewAxes, passes_view_filters
from .changes import (
    EntitiesAdded,
    EntitiesRemoved,
    EntityRef,
    SceneReloaded,
    SelectionChanged,
)
from .document import SceneDocument
from .sorting import assign_content_z
from .tools_builtin import MoveTool, PolygonEditTool, SelectTool
from .tools_overlays import GroupBoxTool, PerspectiveAxisTool, group_bounds
from .tools_structure import CreateTool, delete_selected, duplicate_selected
from .tools_transform import GroupMoveTool, TransformTool
from .view import SceneView

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
        rv.addWidget(self._toolbar)
        self._canvas_host = QWidget()
        self._canvas_layout = QVBoxLayout(self._canvas_host)
        self._canvas_layout.setContentsMargins(0, 0, 0, 0)
        rv.addWidget(self._canvas_host, 1)
        self._status = QLabel("")
        rv.addWidget(self._status)
        splitter.addWidget(right)
        splitter.setStretchFactor(1, 1)
        root.addWidget(splitter)

        self.refresh_scene_list()

    # ---- 场景装载 ----------------------------------------------------------

    def refresh_scene_list(self) -> None:
        current = self.current_scene_id
        self._scene_list.blockSignals(True)
        self._scene_list.clear()
        for sid in sorted(self._model.scenes.keys()):
            item = QListWidgetItem(sid)
            item.setData(Qt.ItemDataRole.UserRole, sid)
            self._scene_list.addItem(item)
        self._scene_list.blockSignals(False)
        if current and current in self._model.scenes:
            self.load_scene(current)

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
        if self._doc is not None:
            self._doc.deleteLater()
        self._doc = SceneDocument(self._model, scene_id, self)
        self._view = SceneView(self._doc, self._canvas_host)
        self._canvas_layout.addWidget(self._view)
        self._install_tools()
        self._apply_view_axes()
        self._doc.changed.connect(self._on_doc_changed)
        self._view.fit_scene()
        self._sync_scene_row(scene_id)
        self.resort_content_z()
        self.refresh_group_boxes()
        self.refresh_perspective_axis()
        self.refresh_entity_tree()
        return True

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
        self.group_tool = view.tools.register(GroupMoveTool(doc, r, view))
        self.create_hotspot_tool = view.tools.register(
            CreateTool(doc, r, "hotspot", view))
        self.create_npc_tool = view.tools.register(CreateTool(doc, r, "npc", view))
        self.create_zone_tool = view.tools.register(CreateTool(doc, r, "zone", view))
        self.persp_tool = view.tools.register(
            PerspectiveAxisTool(doc, r, view.perspective_axis))
        self.group_box_tool = view.tools.register(GroupBoxTool(doc, r, view))
        view.tools.status_text_changed.connect(self._status.setText)
        self._toolbar.clear()
        for tool in view.tools.tools:
            act = self._toolbar.addAction(tool.display_name)
            act.setCheckable(True)
            act.triggered.connect(lambda _c, t=tool: view.tools.select(t))
        view.tools.select(self.select_tool)

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
