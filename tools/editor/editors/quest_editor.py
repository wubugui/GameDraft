"""Quest editor: three-panel layout with group tree, graph view, and property panel."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QTreeWidget, QTreeWidgetItem,
    QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton, QLabel,
    QGraphicsView, QScrollArea, QCheckBox, QFrame, QMessageBox,
    QAbstractItemView,
)
from PySide6.QtGui import QPainter, QMouseEvent, QFont, QColor
from PySide6.QtCore import Qt, Signal

from ..project_model import ProjectModel
from ..shared.condition_editor import ConditionEditor
from ..shared.action_editor import ActionEditor
from ..shared.id_ref_selector import IdRefSelector
from .quest_graph_scene import QuestGraphScene
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
        self._header.addWidget(QLabel("NextQuests (后继)"))
        btn_add = QPushButton("+")
        btn_add.setFixedWidth(28)
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
        sel = IdRefSelector(allow_empty=False)
        sel.set_items(self._model.all_quest_ids())
        sel.set_current(edge.get("questId", ""))
        top_row.addWidget(QLabel("目标:"))
        top_row.addWidget(sel, 1)

        bypass = QCheckBox("跳过前置")
        bypass.setChecked(bool(edge.get("bypassPreconditions")))
        top_row.addWidget(bypass)

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
        self._breadcrumb: list[str] = []

        root = QHBoxLayout(self)
        root.setContentsMargins(4, 4, 4, 4)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        # ---- left: group tree ----
        left = QWidget()
        ll = QVBoxLayout(left)
        ll.setContentsMargins(0, 0, 0, 0)

        btn_row = QHBoxLayout()
        btn_grp = QPushButton("+ 分组")
        btn_grp.clicked.connect(self._add_group)
        btn_quest = QPushButton("+ 任务")
        btn_quest.clicked.connect(self._add_quest)
        btn_del = QPushButton("删除")
        btn_del.clicked.connect(self._delete_selected)
        btn_row.addWidget(btn_grp)
        btn_row.addWidget(btn_quest)
        btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)

        self._tree = _DraggableQuestTree()
        self._tree.setHeaderLabels(["任务结构"])
        self._tree.currentItemChanged.connect(self._on_tree_select)
        self._tree.hierarchy_changed.connect(self._on_tree_drop)
        ll.addWidget(self._tree)

        # ---- center: graph view ----
        center = QWidget()
        cl = QVBoxLayout(center)
        cl.setContentsMargins(0, 0, 0, 0)

        self._breadcrumb_label = QLabel("全部分组")
        self._breadcrumb_label.setStyleSheet("padding: 4px; font-weight: bold;")
        cl.addWidget(self._breadcrumb_label)

        self._graph_scene = QuestGraphScene()
        self._graph_view = _QuestGraphView(self._graph_scene)
        cl.addWidget(self._graph_view)

        nav_row = QHBoxLayout()
        self._btn_back = QPushButton("返回上层")
        self._btn_back.clicked.connect(self._go_back)
        self._btn_back.setEnabled(False)
        self._btn_top = QPushButton("回到顶层")
        self._btn_top.clicked.connect(self._go_top)
        self._btn_fit = QPushButton("适应视图")
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
        splitter.setSizes([220, 500, 380])
        root.addWidget(splitter)

        self._graph_view.node_clicked.connect(self._on_graph_node_selected)
        self._graph_view.node_double_clicked.connect(self._on_graph_drilldown)

        self._refresh()

    # ======== form builders ========

    def _build_group_form(self) -> None:
        self._grp_frame = QFrame()
        self._grp_frame.setFrameShape(QFrame.Shape.StyledPanel)
        gl = QVBoxLayout(self._grp_frame)
        gl.addWidget(QLabel("分组属性"))

        f = QFormLayout()
        self._g_id = QLineEdit()
        f.addRow("id", self._g_id)
        self._g_name = QLineEdit()
        f.addRow("name", self._g_name)
        self._g_type = QComboBox()
        self._g_type.addItems(["main", "side"])
        f.addRow("type", self._g_type)
        self._g_parent = IdRefSelector(allow_empty=True)
        f.addRow("parentGroup", self._g_parent)
        gl.addLayout(f)

        self._g_apply = QPushButton("应用")
        self._g_apply.clicked.connect(self._apply_group)
        gl.addWidget(self._g_apply)

        self._grp_frame.hide()
        self._prop_layout.addWidget(self._grp_frame)

    def _build_quest_form(self) -> None:
        self._quest_frame = QFrame()
        self._quest_frame.setFrameShape(QFrame.Shape.StyledPanel)
        ql = QVBoxLayout(self._quest_frame)
        ql.addWidget(QLabel("任务属性"))

        f = QFormLayout()
        self._q_id = QLineEdit()
        f.addRow("id", self._q_id)
        self._q_group = IdRefSelector(allow_empty=False)
        f.addRow("group", self._q_group)
        self._q_type = QComboBox()
        self._q_type.addItems(["main", "side"])
        f.addRow("type", self._q_type)
        self._q_side_type = QComboBox()
        self._q_side_type.addItems(["", "errand", "inquiry", "investigation", "commission"])
        f.addRow("sideType", self._q_side_type)
        self._q_title = QLineEdit()
        f.addRow("title", self._q_title)
        self._q_desc = QTextEdit()
        self._q_desc.setMaximumHeight(80)
        f.addRow("description", self._q_desc)
        ql.addLayout(f)

        _pre_hint = (
            "手动接任务（如动作 updateQuest、运行时 acceptQuest）不会校验本栏 Preconditions。\n"
            "本栏仅用于：任务仍为未接取时，由 flag 变化触发的自动接取。"
        )
        self._q_pre = ConditionEditor("Preconditions", hint=_pre_hint)
        ql.addWidget(self._q_pre)
        self._q_comp = ConditionEditor("Completion Conditions")
        ql.addWidget(self._q_comp)
        self._q_accept = ActionEditor("Accept Actions (on activate)")
        self._q_accept.set_project_context(self._model, None)
        ql.addWidget(self._q_accept)
        self._q_rewards = ActionEditor("Rewards (on complete)")
        self._q_rewards.set_project_context(self._model, None)
        ql.addWidget(self._q_rewards)

        self._q_next_editor = _NextQuestsEditor(self._model)
        ql.addWidget(self._q_next_editor)

        self._q_apply = QPushButton("应用")
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

    def _rebuild_tree(self) -> None:
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

        self._tree.expandAll()

    def _refresh_graph(self) -> None:
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

        self._graph_view.fit_all()

    # ======== graph interaction ========

    def _on_graph_drilldown(self, group_id: str) -> None:
        self._breadcrumb.append(group_id)
        self._refresh_graph()

    def _on_graph_node_selected(self, node_id: str) -> None:
        for g in self._model.quest_groups:
            if g["id"] == node_id:
                self._show_group_props(node_id)
                return
        for q in self._model.quests:
            if q["id"] == node_id:
                self._show_quest_props(node_id)
                return

    def _go_back(self) -> None:
        if self._breadcrumb:
            self._breadcrumb.pop()
            self._refresh_graph()

    def _go_top(self) -> None:
        self._breadcrumb.clear()
        self._refresh_graph()

    # ======== tree selection ========

    def _on_tree_select(self, current: QTreeWidgetItem | None, _prev) -> None:
        if not current:
            return
        data = current.data(0, Qt.ItemDataRole.UserRole)
        if not data:
            return
        sel_type, sel_id = data
        self._selection_type = sel_type
        self._current_selection = sel_id

        if sel_type == "group":
            self._show_group_props(sel_id)
            self._graph_scene.highlight_node(sel_id)
        elif sel_type == "quest":
            self._show_quest_props(sel_id)
            self._graph_scene.highlight_node(sel_id)

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
        self._g_parent.set_items(
            [(gg["id"], gg.get("name", gg["id"]))
             for gg in self._model.quest_groups if gg["id"] != gid]
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

    def _apply_group(self) -> None:
        gid = self._current_selection
        g = next((g for g in self._model.quest_groups if g["id"] == gid), None)
        if not g:
            return
        new_id = self._g_id.text().strip()
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
            g["parentGroup"] = pg
        elif "parentGroup" in g:
            del g["parentGroup"]
        self._current_selection = new_id
        self._model.mark_dirty("questGroup")
        self._refresh()

    def _apply_quest(self) -> None:
        qid = self._current_selection
        q = next((q for q in self._model.quests if q["id"] == qid), None)
        if not q:
            return
        new_id = self._q_id.text().strip()
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

    def _add_group(self) -> None:
        idx = len(self._model.quest_groups)
        parent_id = self._selected_group_id()
        new_g: dict = {
            "id": f"group_{idx}",
            "name": f"新分组_{idx}",
            "type": "main",
        }
        if parent_id:
            new_g["parentGroup"] = parent_id
        self._model.quest_groups.append(new_g)
        self._model.mark_dirty("questGroup")
        self._refresh()

    def _add_quest(self) -> None:
        idx = len(self._model.quests)
        group_id = self._selected_group_id()
        if not group_id and self._model.quest_groups:
            group_id = self._model.quest_groups[0]["id"]

        new_q: dict = {
            "id": f"quest_{idx}",
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

        self._model.quests = [
            q for q in self._model.quests if q.get("group") not in all_gids
        ]
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
