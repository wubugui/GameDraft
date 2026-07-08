"""Quest editor: three-panel layout with group tree, graph view, and property panel."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QTreeWidget, QTreeWidgetItem,
    QFormLayout, QLineEdit, QComboBox, QPushButton, QLabel,
    QGraphicsView, QScrollArea, QCheckBox, QFrame, QMessageBox,
    QAbstractItemView, QMenu,
)
from PySide6.QtGui import QPainter, QMouseEvent, QFont, QColor
from PySide6.QtCore import Qt, Signal, QEvent

from ..project_model import ProjectModel
from ..shared.condition_editor import ConditionEditor
from ..shared.action_editor import ActionEditor
from ..shared.id_ref_selector import IdRefSelector
from ..shared.collapsible_section import CollapsibleSection
from ..shared.form_layout import compact_form
from ..shared.rich_text_field import RichTextLineEdit, RichTextTextEdit
from .quest_graph_scene import QuestGraphScene
from .quest_graph_layout_store import QuestGraphLayoutStore
from .quest_graph_items import QuestGroupItem, QuestNodeItem


class _QuestGraphView(QGraphicsView):
    """Zoomable, pannable graph view with click-select and double-click drill-down."""
    node_clicked = Signal(str)
    node_double_clicked = Signal(str)
    blank_clicked = Signal()

    def __init__(self, scene: QuestGraphScene, parent: QWidget | None = None):
        super().__init__(scene, parent)
        self._gscene = scene
        self._panning = False
        self._pan_start = None

        self.setRenderHint(QPainter.RenderHint.Antialiasing)
        self.setDragMode(QGraphicsView.DragMode.NoDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setViewportUpdateMode(QGraphicsView.ViewportUpdateMode.SmartViewportUpdate)
        # 内容比视口小时靠左上,不在大画布里居中漂浮(去居中)。
        self.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        self.setBackgroundBrush(QColor(30, 30, 36))

    def _find_node(self, pos):
        item = self.itemAt(pos)
        while item and not isinstance(item, (QuestGroupItem, QuestNodeItem)):
            item = item.parentItem()
        return item

    def wheelEvent(self, event):
        factor = 1.15
        if event.angleDelta().y() < 0:
            factor = 1.0 / factor
        self.scale(factor, factor)

    def mousePressEvent(self, event):
        if event.button() in (Qt.MouseButton.MiddleButton, Qt.MouseButton.RightButton):
            self._panning = True
            self._pan_start = event.position().toPoint()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            event.accept()
            return

        if event.button() == Qt.MouseButton.LeftButton:
            node = self._find_node(event.position().toPoint())
            if node:
                nid = self._item_id(node)
                self._gscene.highlight_node(nid)
                self.node_clicked.emit(nid)
                event.accept()
                return
            else:
                self._gscene.highlight_node(None)
                self.blank_clicked.emit()
        super().mousePressEvent(event)

    def mouseDoubleClickEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            node = self._find_node(event.position().toPoint())
            if isinstance(node, QuestGroupItem):
                self.node_double_clicked.emit(node.group_data["id"])
                event.accept()
                return
        super().mouseDoubleClickEvent(event)

    def mouseMoveEvent(self, event):
        if self._panning and self._pan_start is not None:
            delta = event.position().toPoint() - self._pan_start
            self._pan_start = event.position().toPoint()
            self.horizontalScrollBar().setValue(
                self.horizontalScrollBar().value() - delta.x())
            self.verticalScrollBar().setValue(
                self.verticalScrollBar().value() - delta.y())
            event.accept()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() in (Qt.MouseButton.MiddleButton, Qt.MouseButton.RightButton):
            self._panning = False
            self.setCursor(Qt.CursorShape.ArrowCursor)
            event.accept()
            return
        super().mouseReleaseEvent(event)

    def fit_all(self):
        rect = self._gscene.itemsBoundingRect()
        if not rect.isNull():
            rect.adjust(-60, -60, 60, 60)
            self.fitInView(rect, Qt.AspectRatioMode.KeepAspectRatio)

    @staticmethod
    def _item_id(item) -> str:
        if isinstance(item, QuestGroupItem):
            return item.group_data.get("id", "")
        if isinstance(item, QuestNodeItem):
            return item.quest_data.get("id", "")
        return ""


class _DraggableQuestTree(QTreeWidget):
    """QTreeWidget with drag-and-drop support for reparenting quests/groups."""
    hierarchy_changed = Signal()

    def __init__(self, parent: QWidget | None = None):
        super().__init__(parent)
        self.setDragEnabled(True)
        self.setAcceptDrops(True)
        self.setDragDropMode(QAbstractItemView.DragDropMode.InternalMove)
        self.setDefaultDropAction(Qt.DropAction.MoveAction)
        self.setDropIndicatorShown(True)

    def dropEvent(self, event):
        dragged = self.currentItem()
        if not dragged:
            event.ignore()
            return

        dragged_data = dragged.data(0, Qt.ItemDataRole.UserRole)
        if not dragged_data:
            event.ignore()
            return

        drop_target = self.itemAt(event.position().toPoint())
        target_data = drop_target.data(0, Qt.ItemDataRole.UserRole) if drop_target else None

        dragged_type, dragged_id = dragged_data
        target_type = target_data[0] if target_data else None
        target_id = target_data[1] if target_data else ""

        if dragged_type == "none":
            event.ignore()
            return

        if dragged_type == "quest":
            if target_type == "group":
                self._move_result = ("quest_to_group", dragged_id, target_id)
            elif target_type == "quest":
                self._move_result = ("quest_to_quest_sibling", dragged_id, target_id)
            elif target_type == "none":
                self._move_result = ("quest_to_ungrouped", dragged_id, "")
            elif target_type is None:
                self._move_result = ("quest_to_ungrouped", dragged_id, "")
            else:
                event.ignore()
                return
        elif dragged_type == "group":
            if target_type == "group" and target_id != dragged_id:
                self._move_result = ("group_to_group", dragged_id, target_id)
            elif target_type is None:
                self._move_result = ("group_to_root", dragged_id, "")
            elif target_type == "none":
                self._move_result = ("group_to_root", dragged_id, "")
            else:
                event.ignore()
                return
        else:
            event.ignore()
            return

        event.accept()
        self.hierarchy_changed.emit()


class _NextQuestsEditor(QWidget):
    """List editor for QuestEdge[] with per-edge condition editing."""
    changed = Signal()

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._edges: list[dict] = []
        self._row_widgets: list[dict] = []
        self._layout = QVBoxLayout(self)
        self._layout.setContentsMargins(0, 0, 0, 0)
        self._layout.setSpacing(4)
        self._header = QHBoxLayout()
        btn_add = QPushButton("+ 后继边")
        btn_add.setToolTip("添加一条 NextQuest 边")
        btn_add.clicked.connect(self._add_edge)
        self._header.addStretch()
        self._header.addWidget(btn_add)
        self._layout.addLayout(self._header)
        self._rows_container = QVBoxLayout()
        self._rows_container.setSpacing(6)
        self._layout.addLayout(self._rows_container)

    def set_data(self, edges: list[dict]) -> None:
        self._edges = [dict(e) for e in edges]
        self._rebuild()

    def to_list(self) -> list[dict]:
        result: list[dict] = []
        for rw in self._row_widgets:
            eid = rw["selector"].current_id()
            if not eid:
                continue
            conds = rw["cond_editor"].to_list()
            bypass = rw["bypass"].isChecked()
            edge: dict = {"questId": eid, "conditions": conds}
            if bypass:
                edge["bypassPreconditions"] = True
            result.append(edge)
        return result

    def _rebuild(self) -> None:
        while self._rows_container.count():
            item = self._rows_container.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()
        self._row_widgets.clear()

        for i, edge in enumerate(self._edges):
            self._add_row(edge, i)

    def _add_row(self, edge: dict, idx: int) -> None:
        frame = QFrame()
        frame.setFrameShape(QFrame.Shape.StyledPanel)
        fl = QVBoxLayout(frame)
        fl.setContentsMargins(6, 4, 6, 4)
        fl.setSpacing(4)

        top_row = QHBoxLayout()
        sel = IdRefSelector(allow_empty=False, editable=False, click_opens_popup=True)
        sel.set_items(self._model.all_quest_ids())
        sel.set_current(edge.get("questId", ""))
        top_row.addWidget(QLabel("目标:"))
        top_row.addWidget(sel, 1)

        bypass = QCheckBox("跳过前置")
        bypass.setChecked(bool(edge.get("bypassPreconditions")))
        top_row.addWidget(bypass)

        btn_up = QPushButton("↑")
        btn_up.setFixedWidth(24)
        btn_up.setToolTip("上移此边（nextQuests 是有序数组）")
        btn_up.clicked.connect(lambda checked=False, f=frame: self._move_edge(f, -1))
        top_row.addWidget(btn_up)
        btn_down = QPushButton("↓")
        btn_down.setFixedWidth(24)
        btn_down.setToolTip("下移此边")
        btn_down.clicked.connect(lambda checked=False, f=frame: self._move_edge(f, 1))
        top_row.addWidget(btn_down)

        btn_del = QPushButton("x")
        btn_del.setFixedWidth(24)
        btn_del.clicked.connect(lambda checked=False, f=frame, i=idx: self._remove_edge(f, i))
        top_row.addWidget(btn_del)
        fl.addLayout(top_row)

        ce = ConditionEditor("边条件")
        ce.set_flag_pattern_context(self._model, None)
        ce.set_data(edge.get("conditions", []))
        fl.addWidget(ce)

        self._rows_container.addWidget(frame)
        self._row_widgets.append({
            "frame": frame, "selector": sel,
            "cond_editor": ce, "bypass": bypass,
        })

    def _read_row(self, rw: dict) -> dict:
        """读出单行的当前控件状态（保留半填行，不像 to_list 那样丢空目标）。"""
        edge: dict = {
            "questId": rw["selector"].current_id(),
            "conditions": rw["cond_editor"].to_list(),
        }
        if rw["bypass"].isChecked():
            edge["bypassPreconditions"] = True
        return edge

    def _move_edge(self, frame: QFrame, delta: int) -> None:
        idx = next((i for i, rw in enumerate(self._row_widgets)
                    if rw["frame"] is frame), -1)
        target = idx + delta
        if idx < 0 or target < 0 or target >= len(self._row_widgets):
            return
        edges = [self._read_row(rw) for rw in self._row_widgets]
        edges[idx], edges[target] = edges[target], edges[idx]
        self.set_data(edges)  # 从交换后的实时状态重建，保证边内条件/跳过随各自边移动
        self.changed.emit()

    def _add_edge(self) -> None:
        new_edge = {"questId": "", "conditions": []}
        self._edges.append(new_edge)
        self._add_row(new_edge, len(self._edges) - 1)
        self.changed.emit()

    def _remove_edge(self, frame: QFrame, idx: int) -> None:
        for i, rw in enumerate(self._row_widgets):
            if rw["frame"] is frame:
                self._row_widgets.pop(i)
                self._edges.pop(min(i, len(self._edges) - 1))
                break
        frame.deleteLater()
        self.changed.emit()


class QuestEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._current_selection: str = ""
        self._selection_type: str = ""
        # 防 commit-on-leave 在 apply→_refresh 重建树后重选时再次触发提交（递归/悬挂）。
        self._suppress_tree_commit: bool = False
        self._breadcrumb: list[str] = []
        # 仅首次填充图（或显式「适应视图」/钻取/返回切层）时自动 fit；普通 apply→_refresh
        # 不再重置缩放，避免每次保存都把用户调好的视图缩放/平移弹回。
        self._did_initial_fit: bool = False

        root = QHBoxLayout(self)
        root.setContentsMargins(4, 4, 4, 4)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # ---- left: group tree ----
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)

        btn_row = QHBoxLayout()
        btn_grp = QPushButton("+ 分组")
        btn_grp.setToolTip("在当前选中分组下新增一个子分组")
        btn_grp.clicked.connect(self._add_group)
        btn_quest = QPushButton("+ 任务")
        btn_quest.setToolTip("在当前选中分组下新增一个任务")
        btn_quest.clicked.connect(self._add_quest)
        btn_del = QPushButton("删除")
        btn_del.setToolTip("删除树中选中的分组或任务（Delete 键亦可）")
        btn_del.clicked.connect(self._delete_selected)
        btn_row.addWidget(btn_grp)
        btn_row.addWidget(btn_quest)
        btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)

        self._tree_search = QLineEdit()
        self._tree_search.setPlaceholderText("搜索…")
        self._tree_search.setClearButtonEnabled(True)
        self._tree_search.setToolTip(
            "按名称 / id 过滤任务结构树（仅隐藏不匹配节点，保留匹配项的上级；不改动数据）")
        self._tree_search.textChanged.connect(self._filter_tree)
        ll.addWidget(self._tree_search)

        self._tree = _DraggableQuestTree()
        self._tree.setHeaderLabels(["任务结构"])
        self._tree.currentItemChanged.connect(self._on_tree_select)
        self._tree.hierarchy_changed.connect(self._on_tree_drop)
        self._tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._tree.customContextMenuRequested.connect(self._show_tree_context_menu)
        self._tree.installEventFilter(self)
        ll.addWidget(self._tree)

        # ---- center: graph view ----
        center = QWidget()
        cl = QVBoxLayout(center)
        cl.setContentsMargins(0, 0, 0, 0)

        self._breadcrumb_label = QLabel("全部分组")
        self._breadcrumb_label.setStyleSheet("padding: 4px; font-weight: bold;")
        cl.addWidget(self._breadcrumb_label)

        # 节点坐标侧档 store（编辑器侧，绝不写游戏数据）；project_path 可能在构造后才设。
        self._layout_store_path = None
        self._graph_scene = QuestGraphScene(
            layout_store=QuestGraphLayoutStore(self._model.project_path),
        )
        self._layout_store_path = self._model.project_path
        self._graph_view = _QuestGraphView(self._graph_scene)
        cl.addWidget(self._graph_view)

        nav_row = QHBoxLayout()
        self._btn_back = QPushButton("返回上层")
        self._btn_back.setToolTip("返回上一层分组视图")
        self._btn_back.clicked.connect(self._go_back)
        self._btn_back.setEnabled(False)
        self._btn_top = QPushButton("回到顶层")
        self._btn_top.setToolTip("回到全部分组的顶层视图")
        self._btn_top.clicked.connect(self._go_top)
        self._btn_fit = QPushButton("适应视图")
        self._btn_fit.setToolTip("缩放并居中以适配全部节点")
        self._btn_fit.clicked.connect(lambda: self._graph_view.fit_all())
        nav_row.addWidget(self._btn_back)
        nav_row.addWidget(self._btn_top)
        nav_row.addWidget(self._btn_fit)
        nav_row.addStretch()
        cl.addLayout(nav_row)

        # ---- right: property panel ----
        self._prop_scroll = QScrollArea()
        self._prop_scroll.setWidgetResizable(True)
        self._prop_container = QWidget()
        self._prop_layout = QVBoxLayout(self._prop_container)
        self._prop_layout.setContentsMargins(6, 6, 6, 6)

        self._build_group_form()
        self._build_quest_form()

        self._prop_layout.addStretch()
        self._prop_scroll.setWidget(self._prop_container)

        splitter.addWidget(left)
        splitter.addWidget(center)
        splitter.addWidget(self._prop_scroll)
        splitter.setSizes([220, 520, 300])
        root.addWidget(splitter)

        self._graph_view.node_clicked.connect(self._on_graph_node_selected)
        self._graph_view.node_double_clicked.connect(self._on_graph_drilldown)

        self._refresh()

    # ======== form builders ========

    def _build_group_form(self) -> None:
        self._grp_frame = QFrame()
        self._grp_frame.setFrameShape(QFrame.Shape.StyledPanel)
        gl = QVBoxLayout(self._grp_frame)

        grp_basic = QWidget()
        f = compact_form(QFormLayout(grp_basic))
        self._g_id = QLineEdit()
        f.addRow("id", self._g_id)
        self._g_name = RichTextLineEdit(self._model)
        f.addRow("name", self._g_name)
        self._g_type = QComboBox()
        self._g_type.addItems(["main", "side"])
        f.addRow("type", self._g_type)
        self._g_parent = IdRefSelector(allow_empty=True, editable=False, click_opens_popup=True)
        f.addRow("parentGroup", self._g_parent)
        sec_group_basic = CollapsibleSection("分组 · 基本信息", start_open=True)
        sec_group_basic.add_body(grp_basic)
        gl.addWidget(sec_group_basic)

        self._g_apply = QPushButton("应用")
        self._g_apply.setToolTip("把当前分组表单的改动写回模型")
        self._g_apply.clicked.connect(self._apply_group)
        gl.addWidget(self._g_apply)

        self._grp_frame.hide()
        self._prop_layout.addWidget(self._grp_frame)

    def _build_quest_form(self) -> None:
        self._quest_frame = QFrame()
        self._quest_frame.setFrameShape(QFrame.Shape.StyledPanel)
        ql = QVBoxLayout(self._quest_frame)

        q_basic = QWidget()
        f = compact_form(QFormLayout(q_basic))
        self._q_id = QLineEdit()
        f.addRow("id", self._q_id)
        self._q_group = IdRefSelector(allow_empty=False, editable=False, click_opens_popup=True)
        f.addRow("group", self._q_group)
        self._q_type = QComboBox()
        self._q_type.addItems(["main", "side"])
        f.addRow("type", self._q_type)
        self._q_side_type = QComboBox()
        self._q_side_type.addItems(["", "errand", "inquiry", "investigation", "commission"])
        f.addRow("sideType", self._q_side_type)
        self._q_title = RichTextLineEdit(self._model)
        f.addRow("title", self._q_title)
        self._q_desc = RichTextTextEdit(self._model)
        self._q_desc.setMinimumHeight(72)
        self._q_desc.setMaximumHeight(180)
        f.addRow("description", self._q_desc)
        sec_q_basic = CollapsibleSection("任务 · 基本信息", start_open=True)
        sec_q_basic.add_body(q_basic)
        ql.addWidget(sec_q_basic)

        _pre_hint = (
            "手动接任务（如动作 updateQuest、运行时 acceptQuest）不会校验本栏 Preconditions。\n"
            "本栏仅用于：任务仍为未接取时，由 flag 变化触发的自动接取。"
        )
        self._q_pre = ConditionEditor("Preconditions", hint=_pre_hint)
        sec_pre = CollapsibleSection("Preconditions（自动接取）", start_open=False)
        sec_pre.set_header_tool_tip(_pre_hint)
        sec_pre.add_body(self._q_pre)
        ql.addWidget(sec_pre)

        self._q_comp = ConditionEditor("Completion Conditions")
        sec_comp = CollapsibleSection("Completion Conditions", start_open=False)
        sec_comp.add_body(self._q_comp)
        ql.addWidget(sec_comp)

        self._q_accept = ActionEditor("Accept Actions (on activate)")
        self._q_accept.set_project_context(self._model, None)
        sec_accept = CollapsibleSection("Accept Actions（接取时）", start_open=False)
        sec_accept.add_body(self._q_accept)
        ql.addWidget(sec_accept)

        self._q_rewards = ActionEditor("Rewards (on complete)")
        self._q_rewards.set_project_context(self._model, None)
        sec_rewards = CollapsibleSection("Rewards（完成时）", start_open=False)
        sec_rewards.add_body(self._q_rewards)
        ql.addWidget(sec_rewards)

        self._q_next_editor = _NextQuestsEditor(self._model)
        sec_next = CollapsibleSection("NextQuests（后继）", start_open=False)
        sec_next.add_body(self._q_next_editor)
        ql.addWidget(sec_next)

        self._q_apply = QPushButton("应用")
        self._q_apply.setToolTip("把当前任务表单的改动写回模型")
        self._q_apply.clicked.connect(self._apply_quest)
        ql.addWidget(self._q_apply)

        self._quest_frame.hide()
        self._prop_layout.addWidget(self._quest_frame)

    # ======== refresh ========

    def _refresh(self) -> None:
        self._rebuild_tree()
        self._refresh_graph()
        self._update_selectors()

    def _update_selectors(self) -> None:
        self._g_parent.set_items(self._model.all_quest_group_ids())
        self._q_group.set_items(self._model.all_quest_group_ids())
        self._q_next_editor._model = self._model

    def _snapshot_tree_expansion(self) -> dict:
        """记录各节点（按其 UserRole 标识）的展开状态，供 rebuild 后恢复。"""
        snap: dict = {}

        def walk(item: QTreeWidgetItem) -> None:
            key = item.data(0, Qt.ItemDataRole.UserRole)
            if key is not None:
                snap[key] = item.isExpanded()
            for i in range(item.childCount()):
                walk(item.child(i))

        for i in range(self._tree.topLevelItemCount()):
            walk(self._tree.topLevelItem(i))
        return snap

    def _restore_tree_expansion(self, snap: dict) -> None:
        def walk(item: QTreeWidgetItem) -> None:
            key = item.data(0, Qt.ItemDataRole.UserRole)
            item.setExpanded(snap.get(key, True))  # 新节点默认展开
            for i in range(item.childCount()):
                walk(item.child(i))

        for i in range(self._tree.topLevelItemCount()):
            walk(self._tree.topLevelItem(i))

    def _rebuild_tree(self) -> None:
        _expand_snap = self._snapshot_tree_expansion()
        self._tree.clear()
        group_items: dict[str, QTreeWidgetItem] = {}
        group_map = {g["id"]: g for g in self._model.quest_groups}

        roots: list[dict] = []
        children: dict[str, list[dict]] = {}
        for g in self._model.quest_groups:
            pg = g.get("parentGroup", "")
            if pg and pg in group_map:
                children.setdefault(pg, []).append(g)
            else:
                roots.append(g)

        def add_group(g: dict, parent_item: QTreeWidgetItem | None) -> None:
            gtype = "[M]" if g.get("type") == "main" else "[S]"
            label = f"{gtype} {g.get('name', g['id'])}"
            if parent_item:
                ti = QTreeWidgetItem(parent_item, [label])
            else:
                ti = QTreeWidgetItem(self._tree, [label])
            ti.setData(0, Qt.ItemDataRole.UserRole, ("group", g["id"]))
            group_items[g["id"]] = ti

            for q in self._model.quests:
                if q.get("group") == g["id"]:
                    qtag = "  [Q]"
                    qlabel = f"{qtag} {q['id']}  {q.get('title', '')}"
                    qi = QTreeWidgetItem(ti, [qlabel])
                    qi.setData(0, Qt.ItemDataRole.UserRole, ("quest", q["id"]))

            for child in children.get(g["id"], []):
                add_group(child, ti)

        for g in roots:
            add_group(g, None)

        ungrouped = [q for q in self._model.quests if not q.get("group")]
        if ungrouped:
            ui = QTreeWidgetItem(self._tree, ["[未分组]"])
            ui.setData(0, Qt.ItemDataRole.UserRole, ("none", ""))
            for q in ungrouped:
                qlabel = f"  [Q] {q['id']}  {q.get('title', '')}"
                qi = QTreeWidgetItem(ui, [qlabel])
                qi.setData(0, Qt.ItemDataRole.UserRole, ("quest", q["id"]))

        # 保留用户的折叠状态：仅首次构建（无快照）时全展开，之后恢复上次状态。
        if _expand_snap:
            self._restore_tree_expansion(_expand_snap)
        else:
            self._tree.expandAll()
        self._filter_tree(self._tree_search.text())

    def _filter_tree(self, text: str) -> None:
        """纯视图过滤：按文本隐藏不匹配的树节点，但保留含匹配后代的祖先节点可见。

        只调用 setHidden，不增删/重排/改动任何任务或分组数据。
        """
        query = (text or "").strip().lower()

        def visit(item: QTreeWidgetItem) -> bool:
            # 返回 item 自身或任一后代是否匹配；匹配则该 item 保持可见。
            self_match = query in item.text(0).lower() if query else True
            child_match = False
            for i in range(item.childCount()):
                if visit(item.child(i)):
                    child_match = True
            visible = self_match or child_match
            item.setHidden(bool(query) and not visible)
            return visible

        root = self._tree.invisibleRootItem()
        for i in range(root.childCount()):
            visit(root.child(i))

    def _refresh_graph(self, *, fit: bool = False) -> None:
        # 工程路径变更（加载/切换工程）时重建侧档 store，让坐标读写指向当前工程。
        if self._model.project_path != self._layout_store_path:
            self._graph_scene.set_layout_store(
                QuestGraphLayoutStore(self._model.project_path),
            )
            self._layout_store_path = self._model.project_path
        if not self._breadcrumb:
            self._graph_scene.populate_top_level(
                self._model.quest_groups, self._model.quests,
            )
            self._breadcrumb_label.setText("全部分组")
            self._btn_back.setEnabled(False)
        else:
            gid = self._breadcrumb[-1]
            gname = gid
            for g in self._model.quest_groups:
                if g["id"] == gid:
                    gname = g.get("name", gid)
                    break
            path = " > ".join(self._breadcrumb)
            self._breadcrumb_label.setText(f"分组: {path}")
            self._graph_scene.populate_group(
                gid, self._model.quests, self._model.quest_groups,
            )
            self._btn_back.setEnabled(True)

        # 只在显式请求或首次填充时适应视图；普通 apply→_refresh 保留当前缩放/平移。
        if fit or not self._did_initial_fit:
            self._graph_view.fit_all()
            self._did_initial_fit = True

    # ======== graph interaction ========

    def _on_graph_drilldown(self, group_id: str) -> None:
        self._breadcrumb.append(group_id)
        self._refresh_graph(fit=True)

    def _on_graph_node_selected(self, node_id: str) -> None:
        # 经树选择统一收口：选中对应树节点触发 _on_tree_select，同步面板 + 图高亮 +
        # _selection_type/_current_selection，避免"图里点了、树没动、当前选择过期"
        # 导致编辑/Apply 落到上一个实体（单向选择脱节）。
        root = self._tree.invisibleRootItem()
        for kind in ("group", "quest"):
            it = self._find_tree_item(root, kind, node_id)
            if it is not None:
                self._tree.setCurrentItem(it)
                return
        # 兜底：树里找不到（极少）时仍直接显示属性，至少不丢交互。
        for g in self._model.quest_groups:
            if g["id"] == node_id:
                self._selection_type = "group"
                self._current_selection = node_id
                self._show_group_props(node_id)
                return
        for q in self._model.quests:
            if q["id"] == node_id:
                self._selection_type = "quest"
                self._current_selection = node_id
                self._show_quest_props(node_id)
                return

    def _go_back(self) -> None:
        if self._breadcrumb:
            self._breadcrumb.pop()
            self._refresh_graph(fit=True)

    def _go_top(self) -> None:
        self._breadcrumb.clear()
        self._refresh_graph(fit=True)

    # ======== tree selection ========

    def _is_dirty(self) -> bool:
        """当前面板是否与模型里的该分组/任务有未应用差异（脏判断与 apply 字段对齐）。"""
        if self._selection_type == "group" and self._current_selection:
            g = next((g for g in self._model.quest_groups
                      if g["id"] == self._current_selection), None)
            if not g:
                return False
            if self._g_id.text().strip() != g.get("id", ""):
                return True
            if self._g_name.text().strip() != g.get("name", ""):
                return True
            if self._g_type.currentText() != g.get("type", "main"):
                return True
            if (self._g_parent.current_id() or "") != (g.get("parentGroup") or ""):
                return True
            return False
        if self._selection_type == "quest" and self._current_selection:
            q = next((q for q in self._model.quests
                      if q["id"] == self._current_selection), None)
            if not q:
                return False
            if self._q_id.text().strip() != q.get("id", ""):
                return True
            if (self._q_group.current_id() or "") != q.get("group", ""):
                return True
            if self._q_type.currentText() != q.get("type", "main"):
                return True
            if self._q_side_type.currentText() != q.get("sideType", ""):
                return True
            if self._q_title.text() != q.get("title", ""):
                return True
            if self._q_desc.toPlainText() != q.get("description", ""):
                return True
            if self._q_pre.to_list() != (q.get("preconditions") or []):
                return True
            if self._q_comp.to_list() != (q.get("completionConditions") or []):
                return True
            if self._q_accept.to_list() != (q.get("acceptActions") or []):
                return True
            if self._q_rewards.to_list() != (q.get("rewards") or []):
                return True
            if self._q_next_editor.to_list() != (q.get("nextQuests") or []):
                return True
            return False
        return False

    def _commit_current_selection(self) -> bool:
        if self._selection_type == "group":
            return self._apply_group()
        if self._selection_type == "quest":
            return self._apply_quest()
        return True

    def flush_to_model(self) -> bool:
        """Save All 钩子：未应用编辑在保存前提交；校验失败时返回 False 中止保存，
        不再"弹完警告照样返回 True 让保存流程以为已写入"（审查 P2-27）。"""
        if self._is_dirty():
            return self._commit_current_selection()
        return True

    def pop_flush_error(self) -> str:
        return "任务/分组的未应用编辑校验未通过（id 为空或重复），请先在 Quest 页修正。"

    def confirm_close(self, parent=None) -> bool:
        if not self._is_dirty():
            return True
        r = QMessageBox.question(
            self, "未应用的修改", "当前任务/分组有未应用的修改。保存到模型？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Cancel:
            return False
        if r == QMessageBox.StandardButton.Save:
            if not self._commit_current_selection():
                return False  # 校验失败：留在编辑器里修
        return True

    def _on_tree_select(self, current: QTreeWidgetItem | None, _prev) -> None:
        if not current:
            return
        data = current.data(0, Qt.ItemDataRole.UserRole)
        if not data:
            return
        sel_type, sel_id = data

        # commit-on-leave：切到别的节点前先提交上一个节点的未应用编辑。apply 会 _refresh
        # 重建树使 current 悬挂，因此提交后用 id 重新定位目标并加 _suppress 防递归。
        if (not self._suppress_tree_commit
                and self._selection_type and self._current_selection
                and (self._selection_type, self._current_selection) != (sel_type, sel_id)
                and self._is_dirty()):
            if not self._commit_current_selection():
                # 校验失败：回到原节点，未保存编辑留在表单里（不静默覆盖丢弃）
                it_old = self._find_tree_item(
                    self._tree.invisibleRootItem(),
                    self._selection_type, self._current_selection)
                if it_old is not None:
                    self._suppress_tree_commit = True
                    try:
                        self._tree.setCurrentItem(it_old)
                    finally:
                        self._suppress_tree_commit = False
                return
            it = self._find_tree_item(self._tree.invisibleRootItem(), sel_type, sel_id)
            if it is not None:
                self._suppress_tree_commit = True
                try:
                    self._tree.setCurrentItem(it)
                finally:
                    self._suppress_tree_commit = False
            return

        self._selection_type = sel_type
        self._current_selection = sel_id

        if sel_type == "group":
            self._show_group_props(sel_id)
            self._graph_scene.highlight_node(sel_id)
            self._g_name.setFocus()
        elif sel_type == "quest":
            self._show_quest_props(sel_id)
            self._graph_scene.highlight_node(sel_id)
            self._q_title.setFocus()

    def eventFilter(self, obj, event):
        # Delete 键删除树中选中项，复用既有删除处理（含确认弹窗），不另写删除逻辑。
        if obj is self._tree and event.type() == QEvent.Type.KeyPress:
            if event.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
                if self._selection_type in ("group", "quest") and self._current_selection:
                    self._delete_selected()
                    return True
        return super().eventFilter(obj, event)

    def _show_tree_context_menu(self, pos) -> None:
        item = self._tree.itemAt(pos)
        if item is not None:
            self._tree.setCurrentItem(item)
        menu = QMenu(self._tree)
        act_grp = menu.addAction("+ 子分组")
        act_quest = menu.addAction("+ 任务")
        menu.addSeparator()
        act_del = menu.addAction("删除")
        act_del.setEnabled(
            self._selection_type in ("group", "quest") and bool(self._current_selection)
        )
        chosen = menu.exec(self._tree.viewport().mapToGlobal(pos))
        if chosen is act_grp:
            self._add_group()
        elif chosen is act_quest:
            self._add_quest()
        elif chosen is act_del:
            self._delete_selected()

    # ======== drag-and-drop ========

    def _on_tree_drop(self) -> None:
        result = getattr(self._tree, "_move_result", None)
        if not result:
            return
        action, src_id, dst_id = result
        self._tree._move_result = None

        if action == "quest_to_group":
            q = next((q for q in self._model.quests if q["id"] == src_id), None)
            if q:
                q["group"] = dst_id
                self._model.mark_dirty("quest")

        elif action == "quest_to_quest_sibling":
            target_q = next((q for q in self._model.quests if q["id"] == dst_id), None)
            q = next((q for q in self._model.quests if q["id"] == src_id), None)
            if q and target_q:
                q["group"] = target_q.get("group", "")
                self._model.mark_dirty("quest")

        elif action == "quest_to_ungrouped":
            q = next((q for q in self._model.quests if q["id"] == src_id), None)
            if q:
                q["group"] = ""
                self._model.mark_dirty("quest")

        elif action == "group_to_group":
            g = next((g for g in self._model.quest_groups if g["id"] == src_id), None)
            if g and dst_id != src_id:
                if self._would_create_cycle(src_id, dst_id):
                    QMessageBox.warning(self, "操作无效", "不能将分组移入自身的子分组中。")
                else:
                    g["parentGroup"] = dst_id
                    self._model.mark_dirty("questGroup")

        elif action == "group_to_root":
            g = next((g for g in self._model.quest_groups if g["id"] == src_id), None)
            if g and "parentGroup" in g:
                del g["parentGroup"]
                self._model.mark_dirty("questGroup")

        self._refresh()
        # 拖拽直写模型：若被拖对象正是右侧表单显示的对象，须立刻从模型重载表单——
        # 否则表单残留旧 group/parentGroup，下一次 commit-on-leave 会把拖拽结果
        # 静默改回去（审查 P1-12/P1-13 拖拽回滚）。
        if self._selection_type == "quest" and self._current_selection == src_id:
            self._show_quest_props(src_id)
        elif self._selection_type == "group" and self._current_selection == src_id:
            self._show_group_props(src_id)

    def _would_create_cycle(self, src_id: str, dst_id: str) -> bool:
        visited: set[str] = {src_id}
        cur = dst_id
        while cur:
            if cur in visited:
                return True
            visited.add(cur)
            parent_g = next(
                (g for g in self._model.quest_groups if g["id"] == cur), None)
            cur = parent_g.get("parentGroup", "") if parent_g else ""
        return False

    # ======== property panels ========

    def _show_group_props(self, gid: str) -> None:
        self._quest_frame.hide()
        self._grp_frame.show()
        self._selection_type = "group"
        self._current_selection = gid

        g = next((g for g in self._model.quest_groups if g["id"] == gid), None)
        if not g:
            return
        self._g_id.setText(g.get("id", ""))
        self._g_name.setText(g.get("name", ""))
        self._g_type.setCurrentText(g.get("type", "main"))
        _excluded = self._collect_descendant_groups(gid)
        _excluded.add(gid)
        self._g_parent.set_items(
            [(gg["id"], gg.get("name", gg["id"]))
             for gg in self._model.quest_groups if gg["id"] not in _excluded]
        )
        self._g_parent.set_current(g.get("parentGroup", ""))

    def _show_quest_props(self, qid: str) -> None:
        self._grp_frame.hide()
        self._quest_frame.show()
        self._selection_type = "quest"
        self._current_selection = qid

        q = next((q for q in self._model.quests if q["id"] == qid), None)
        if not q:
            return
        self._q_id.setText(q.get("id", ""))
        self._q_group.set_items(self._model.all_quest_group_ids())
        self._q_group.set_current(q.get("group", ""))
        self._q_type.setCurrentText(q.get("type", "main"))
        self._q_side_type.setCurrentText(q.get("sideType", ""))
        self._q_title.setText(q.get("title", ""))
        self._q_desc.setPlainText(q.get("description", ""))
        self._q_pre.set_flag_pattern_context(self._model, None)
        self._q_comp.set_flag_pattern_context(self._model, None)
        self._q_pre.set_data(q.get("preconditions", []))
        self._q_comp.set_data(q.get("completionConditions", []))
        self._q_accept.set_project_context(self._model, None)
        self._q_accept.set_data(q.get("acceptActions", []))
        self._q_rewards.set_project_context(self._model, None)
        self._q_rewards.set_data(q.get("rewards", []))
        self._q_next_editor.set_data(q.get("nextQuests", []))

    # ======== apply ========

    def _apply_group(self) -> bool:
        gid = self._current_selection
        g = next((g for g in self._model.quest_groups if g["id"] == gid), None)
        if not g:
            return True
        new_id = self._g_id.text().strip()
        if not new_id:
            QMessageBox.warning(self, "分组 id", "分组 id 不能为空。")
            return False
        if any(gg is not g and gg.get("id") == new_id for gg in self._model.quest_groups):
            QMessageBox.warning(self, "分组 id", f"分组 id 与其它分组重复：{new_id}")
            return False
        if new_id != gid:
            for q in self._model.quests:
                if q.get("group") == gid:
                    q["group"] = new_id
            for gg in self._model.quest_groups:
                if gg.get("parentGroup") == gid:
                    gg["parentGroup"] = new_id
        g["id"] = new_id
        g["name"] = self._g_name.text().strip()
        g["type"] = self._g_type.currentText()
        pg = self._g_parent.current_id()
        if pg:
            # 成环防护：属性面板路径与拖拽路径同一套校验（审查 P1-13：
            # 成环后整条环从树/图消失且带环落盘、不可再选中修复）
            if pg == new_id or self._would_create_cycle(new_id, pg):
                QMessageBox.warning(
                    self, "父分组",
                    "不能把分组挂到自身或其子孙分组下，已保留原父分组。")
            else:
                g["parentGroup"] = pg
        elif "parentGroup" in g:
            del g["parentGroup"]
        self._current_selection = new_id
        self._model.mark_dirty("questGroup")
        self._refresh()
        return True

    def _apply_quest(self) -> bool:
        qid = self._current_selection
        q = next((q for q in self._model.quests if q["id"] == qid), None)
        if not q:
            return True
        new_id = self._q_id.text().strip()
        if not new_id:
            QMessageBox.warning(self, "任务 id", "任务 id 不能为空。")
            return False
        if any(qq is not q and qq.get("id") == new_id for qq in self._model.quests):
            QMessageBox.warning(self, "任务 id", f"任务 id 与其它任务重复：{new_id}")
            return False
        if new_id != qid:
            for qq in self._model.quests:
                for edge in qq.get("nextQuests", []):
                    if edge.get("questId") == qid:
                        edge["questId"] = new_id
        q["id"] = new_id
        q["group"] = self._q_group.current_id() or ""
        q["type"] = self._q_type.currentText()
        st = self._q_side_type.currentText()
        if st:
            q["sideType"] = st
        elif "sideType" in q:
            del q["sideType"]
        q["title"] = self._q_title.text()
        q["description"] = self._q_desc.toPlainText()
        q["preconditions"] = self._q_pre.to_list()
        q["completionConditions"] = self._q_comp.to_list()
        q["acceptActions"] = self._q_accept.to_list()
        q["rewards"] = self._q_rewards.to_list()
        q["nextQuests"] = self._q_next_editor.to_list()
        if "nextQuestId" in q:
            del q["nextQuestId"]
        self._current_selection = new_id
        self._model.mark_dirty("quest")
        self._refresh()
        return True

    # ======== add / delete ========

    def _selected_group_id(self) -> str:
        """Return the group id implied by the current tree selection."""
        if self._selection_type == "group" and self._current_selection:
            return self._current_selection
        if self._selection_type == "quest" and self._current_selection:
            q = next((q for q in self._model.quests
                       if q["id"] == self._current_selection), None)
            if q:
                return q.get("group", "")
        return ""

    @staticmethod
    def _unique_new_id(prefix: str, existing_ids) -> str:
        taken = {str(i) for i in existing_ids}
        n = 0
        while f"{prefix}_{n}" in taken:
            n += 1
        return f"{prefix}_{n}"

    def _add_group(self) -> None:
        parent_id = self._selected_group_id()
        new_gid = self._unique_new_id(
            "group", (g.get("id", "") for g in self._model.quest_groups))
        new_g: dict = {
            "id": new_gid,
            "name": f"新分组_{new_gid.rsplit('_', 1)[-1]}",
            "type": "main",
        }
        if parent_id:
            new_g["parentGroup"] = parent_id
        self._model.quest_groups.append(new_g)
        self._model.mark_dirty("questGroup")
        self._refresh()

    def _add_quest(self) -> None:
        group_id = self._selected_group_id()
        if not group_id and self._model.quest_groups:
            group_id = self._model.quest_groups[0]["id"]

        new_q: dict = {
            "id": self._unique_new_id(
                "quest", (q.get("id", "") for q in self._model.quests)),
            "group": group_id,
            "type": "main",
            "title": "新任务",
            "description": "",
            "preconditions": [],
            "completionConditions": [],
            "acceptActions": [],
            "rewards": [],
            "nextQuests": [],
        }
        self._model.quests.append(new_q)
        self._model.mark_dirty("quest")
        self._refresh()

    def _delete_selected(self) -> None:
        if self._selection_type == "group":
            self._delete_group(self._current_selection)
        elif self._selection_type == "quest":
            self._delete_quest(self._current_selection)

    def _delete_group(self, gid: str) -> None:
        contained_quests = [q for q in self._model.quests if q.get("group") == gid]
        child_groups = [g for g in self._model.quest_groups if g.get("parentGroup") == gid]

        msg_parts = [f"确认删除分组 '{gid}'?"]
        if contained_quests:
            msg_parts.append(f"包含 {len(contained_quests)} 个任务节点")
        if child_groups:
            msg_parts.append(f"包含 {len(child_groups)} 个子分组")
        msg_parts.append("所有内容将一并删除。")

        ret = QMessageBox.warning(
            self, "删除确认", "\n".join(msg_parts),
            QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
        )
        if ret != QMessageBox.StandardButton.Ok:
            return

        all_gids = self._collect_descendant_groups(gid)
        all_gids.add(gid)

        deleted_qids = {
            q.get("id") for q in self._model.quests if q.get("group") in all_gids
        }
        self._model.quests = [
            q for q in self._model.quests if q.get("group") not in all_gids
        ]
        # 清其它任务指向被删任务的 nextQuests 悬垂边（与 _delete_quest 行为对齐，审查 P1-14）
        for q in self._model.quests:
            edges = q.get("nextQuests")
            if isinstance(edges, list):
                kept = [e for e in edges
                        if not (isinstance(e, dict) and e.get("questId") in deleted_qids)]
                if len(kept) != len(edges):
                    q["nextQuests"] = kept
        self._model.quest_groups = [
            g for g in self._model.quest_groups if g["id"] not in all_gids
        ]
        self._current_selection = ""
        self._selection_type = ""
        self._model.mark_dirty("quest")
        self._model.mark_dirty("questGroup")
        self._refresh()

    def _collect_descendant_groups(self, gid: str) -> set[str]:
        result: set[str] = set()
        queue = [g["id"] for g in self._model.quest_groups if g.get("parentGroup") == gid]
        while queue:
            cur = queue.pop(0)
            result.add(cur)
            for g in self._model.quest_groups:
                if g.get("parentGroup") == cur and g["id"] not in result:
                    queue.append(g["id"])
        return result

    def _delete_quest(self, qid: str) -> None:
        refs: list[str] = []
        for q in self._model.quests:
            for edge in q.get("nextQuests", []):
                if edge.get("questId") == qid:
                    refs.append(q["id"])
                    break

        msg = f"确认删除任务 '{qid}'?"
        if refs:
            msg += f"\n被以下任务引用: {', '.join(refs)}\n引用将一并清理。"

        ret = QMessageBox.warning(
            self, "删除确认", msg,
            QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
        )
        if ret != QMessageBox.StandardButton.Ok:
            return

        for q in self._model.quests:
            q["nextQuests"] = [
                e for e in q.get("nextQuests", []) if e.get("questId") != qid
            ]

        self._model.quests = [q for q in self._model.quests if q["id"] != qid]
        self._current_selection = ""
        self._selection_type = ""
        self._model.mark_dirty("quest")
        self._refresh()

    # ======== external navigation ========

    def select_by_id(self, item_id: str, _scene_id: str = "") -> None:
        it = self._find_tree_item(self._tree.invisibleRootItem(), "quest", item_id)
        if it:
            self._tree.setCurrentItem(it)

    def _find_tree_item(self, parent: QTreeWidgetItem, sel_type: str, sel_id: str):
        for i in range(parent.childCount()):
            child = parent.child(i)
            data = child.data(0, Qt.ItemDataRole.UserRole)
            if data and data[0] == sel_type and data[1] == sel_id:
                return child
            found = self._find_tree_item(child, sel_type, sel_id)
            if found:
                return found
        return None
