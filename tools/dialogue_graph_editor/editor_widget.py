"""图对话编辑器面板：可嵌入主编辑器，也可由独立 MainWindow 承载。"""
from __future__ import annotations

import json
import copy
import re
import uuid
from pathlib import Path
from typing import Any

from PySide6.QtWidgets import (
    QWidget, QSplitter, QListWidget, QListWidgetItem, QTreeWidget, QTreeWidgetItem,
    QVBoxLayout,
    QHBoxLayout, QPushButton, QMessageBox, QFileDialog, QLabel, QLineEdit,
    QFormLayout, QScrollArea, QGroupBox, QInputDialog, QColorDialog,
    QMenu, QCompleter, QDialog, QSizePolicy, QComboBox, QApplication,
)
from PySide6.QtCore import Qt, Signal, QTimer, QStringListModel, QSettings
from PySide6.QtGui import QUndoStack, QUndoCommand, QAction, QCursor, QKeySequence, QShortcut, QColor

from tools.editor import theme as app_theme

from .graph_document import (
    graphs_dir,
    list_graph_files,
    load_json,
    save_json,
    write_bytes_atomic,
    validate_graph_tiered,
    node_search_haystack,
    node_summary,
    default_node,
    suggest_next_id,
    auto_layout_node_positions,
    extract_flow_edges_detailed,
)
from .graph_mutations import (
    collect_incoming_refs,
)
from .dialogue_topology import iter_output_slots
from .graph_document_model import GraphDocumentModel
from .graph_analysis import analyze_node_tags
from .flow_layout_store import (
    load_positions_for_graph,
    load_ghost_positions_for_graph,
    write_positions_for_graph,
    load_editor_groups_for_graph,
    load_group_frames_for_graph,
    migrate_layout_map_key,
    remove_layout_entry_for_graph,
)
from .editor_group_geometry import (
    migrate_legacy_frames_from_assignments,
    sync_node_to_group_from_layout_positions,
    sync_node_to_group_from_frames,
    avoid_rects_list,
    parse_group_super_node_gid,
)
from .flow_oden_controller import DialogueFlowOdenController
from .node_inspector import NodeInspector
from .node_picker_dialog import NodePickerDialog
from tools.editor.shared.condition_editor import ConditionEditor

# 左侧图列表树：条目类型存在 UserRole；分组稳定 key 存在 _TREE_GROUP_KEY_ROLE。
_TREE_KIND_ROLE = Qt.ItemDataRole.UserRole + 30
_TREE_GROUP_KEY_ROLE = Qt.ItemDataRole.UserRole + 31
_TK_GROUP = 1
_TK_FILE = 2
_TK_UNSAVED = 3

# 分组配色：新建分组按序取不同色，一眼区分（纯编辑器视觉，不进图 JSON / 不影响运行时）。
_LEGACY_GROUP_COLOR = "#4a6fa8"  # 历史上所有分组的硬编码同色；视作「未配色」，加载时自动派生不同色
_GROUP_COLOR_PALETTE = [
    "#4a6fa8", "#a8564a", "#4a8a5c", "#8a6f4a", "#7a4a8a",
    "#4a8a8a", "#a88a4a", "#a84a7a", "#5a6f8a", "#6f8a4a",
]


def _palette_group_color(index: int) -> str:
    return _GROUP_COLOR_PALETTE[index % len(_GROUP_COLOR_PALETTE)]


def _graph_form_label(text: str, tip: str | None = None, *, max_w: int = 100) -> QLabel:
    """图属性等表单左侧标签：限制宽度并换行，避免整列被最长一行撑得过宽。"""
    lb = QLabel(text)
    lb.setWordWrap(True)
    lb.setMaximumWidth(max_w)
    lb.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
    if tip:
        lb.setToolTip(tip)
    return lb

class _NodeDataChangedCmd(QUndoCommand):
    """Snapshot-based undo for inspector edits. Merges consecutive edits to the same node."""

    _COALESCE_ID = 9001

    def __init__(self, model: GraphDocumentModel, nid: str, old_data: dict, new_data: dict):
        super().__init__(f"edit {nid}")
        self._model = model
        self._nid = nid
        self._old = old_data
        self._new = new_data

    def id(self) -> int:
        return self._COALESCE_ID

    def mergeWith(self, other: QUndoCommand) -> bool:
        if not isinstance(other, _NodeDataChangedCmd):
            return False
        if other._nid != self._nid:
            return False
        self._new = other._new
        return True

    def redo(self) -> None:
        self._model.set_node(self._nid, copy.deepcopy(self._new))

    def undo(self) -> None:
        self._model.set_node(self._nid, copy.deepcopy(self._old))


class _GraphStructureSnapshotCmd(QUndoCommand):
    """结构级操作（节点新增/删除/重命名/复制、清除幽灵连线）的全图快照撤销。

    与检查器的 `_NodeDataChangedCmd`（单节点合并）及 Oden 画布自身的移动/连线命令
    共存于同一 QUndoStack：本命令整图回灌数据+坐标，粒度大但语义清晰、互不越权。
    push 时的首次 redo() 跳过（调用方已直接完成了这次变更），后续 redo/undo 才回灌。
    """

    def __init__(
        self,
        widget: "DialogueGraphEditorWidget",
        label: str,
        before_data: dict,
        before_positions: dict,
        after_data: dict,
        after_positions: dict,
    ):
        super().__init__(label)
        self._widget = widget
        self._before_data = before_data
        self._before_positions = before_positions
        self._after_data = after_data
        self._after_positions = after_positions
        self._first_redo_skipped = False

    def redo(self) -> None:
        if not self._first_redo_skipped:
            self._first_redo_skipped = True
            return
        self._widget._apply_structure_snapshot(self._after_data, self._after_positions)

    def undo(self) -> None:
        self._widget._apply_structure_snapshot(self._before_data, self._before_positions)


def _graph_preconditions_for_editor(pre: object) -> list[dict[str, Any]]:
    return _split_graph_preconditions_for_editor(pre)[0]


def _split_graph_preconditions_for_editor(pre: object) -> tuple[list[dict[str, Any]], list[Any]]:
    if pre is None:
        return [], []
    if isinstance(pre, dict):
        return [pre], []
    if not isinstance(pre, list):
        return [], [pre]
    editable: list[dict[str, Any]] = []
    unknown: list[Any] = []
    for item in pre:
        if isinstance(item, dict):
            editable.append(dict(item))
        else:
            unknown.append(copy.deepcopy(item))
    return editable, unknown


class DialogueGraphEditorWidget(QWidget):
    """编辑 public/assets/dialogues/graphs/*.json。

    「未保存 /脏」针对所有会使该 JSON 落盘内容变化的操作：图属性（id、entry、meta、preconditions）、
    节点增删改与右侧检查器、画布连线拓扑等。
    纯画布坐标只写入 resources/editor_projects/editor_data/dialogue_flow_layout.json，不改变 graphs/*.json，不标脏。
    """

    title_changed = Signal(str)
    dirty_changed = Signal(bool)

    def __init__(
        self,
        project_path: str | Path,
        parent: QWidget | None = None,
        *,
        project_model: Any | None = None,
    ):
        super().__init__(parent)
        self._project = Path(project_path).resolve()
        self._injected_project_model = project_model
        self._graphs_dir = graphs_dir(self._project)
        self._current_path: Path | None = None
        self._model = GraphDocumentModel(self)
        self._data: dict = self._model.mutable_data
        # 磁盘原始字节/语义基线：保存时内容无实质变化则原样回写，保格式零变化
        self._loaded_disk_bytes: bytes | None = None
        self._loaded_disk_data: dict | None = None
        # 「新建图」草稿的出厂快照：Save All 用它识别「从未编辑过的全新草稿」并跳过静默物化（审查 P3）
        self._new_draft_pristine: dict | None = None
        # 最近一次保存失败的中文原因（供内嵌 flush 降级提示；成功/开始保存时清空）
        self._last_save_failure: str = ""
        self._editing_node_id: str | None = None
        self._positions: dict[str, tuple[float, float]] = {}
        self._layout_save_timer = QTimer(self)
        self._layout_save_timer.setSingleShot(True)
        self._layout_save_timer.timeout.connect(self._flush_flow_layout_to_disk)
        self._inspector_scene_timer = QTimer(self)
        self._inspector_scene_timer.setSingleShot(True)
        self._inspector_scene_timer.timeout.connect(self._rebuild_flow_scene)
        # 单一 toast 计时器：避免多次 QTimer.singleShot 堆叠互相提前清空消息
        self._toast_timer = QTimer(self)
        self._toast_timer.setSingleShot(True)
        self._toast_timer.timeout.connect(self._on_toast_timeout)
        self._meta_rebuild_timer = QTimer(self)
        self._meta_rebuild_timer.setSingleShot(True)
        self._meta_rebuild_timer.timeout.connect(self._rebuild_flow_scene)
        self._validation_refresh_timer = QTimer(self)
        self._validation_refresh_timer.setSingleShot(True)
        self._validation_refresh_timer.timeout.connect(self._on_validation_refresh_timer)
        self._validation_notify_toast = False
        self._last_validation: tuple[list[str], list[str]] = ([], [])
        self._connect_feedback_messages: list[str] = []
        self._ghost_positions: dict[str, tuple[float, float]] = {}
        self._editor_groups: dict[str, dict[str, Any]] = {}
        self._node_to_group: dict[str, str] = {}
        self._editor_group_frames: dict[str, dict[str, Any]] = {}
        self._draft_layout_basename: str | None = None
        self._unsaved_list_token = "__unsaved__"
        self._file_tree_group_key: tuple[str, str] | None = None
        self._inspector_project_model = None
        self._inspector_project_model_failed = False
        self._undo_stack = QUndoStack(self)
        self._undo_stack.indexChanged.connect(self._on_undo_index_changed)
        # 跟踪栈长度以区分"全新入栈(编辑/移动)"与"undo/redo 回退"——前者画布已就地应用、
        # 不需整图重建；后者才需重建反映回退状态。count 变=入栈，count 不变=undo/redo。
        self._prev_undo_count = 0
        # push(_NodeDataChangedCmd) 会同步触发 indexChanged；若此时再 set_node 会整页重建，丢掉 Action 折叠等 UI 状态。
        self._suppress_inspector_resync_from_undo = False
        self._model.dirty_changed.connect(self.dirty_changed)
        self._model.topology_changed.connect(self._on_model_topology_changed)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(4, 4, 4, 4)
        outer.setSpacing(4)

        from PySide6.QtWidgets import QToolBar
        tb = QToolBar("图对话工具栏")
        tb.setMovable(False)
        for text, slot in (
            ("打开…", self.open_file_dialog),
            ("保存", self.save),
            ("另存为…", self.save_as),
            ("重命名图…", self._rename_graph_file_dialog),
        ):
            tb.addAction(text, slot)
        tb.addSeparator()
        for text, slot in (
            ("校验当前图", self.run_validate),
            ("自动布局", self._flow_auto_layout),
            ("适应画布", self._flow_fit_view),
        ):
            tb.addAction(text, slot)
        tb.addSeparator()
        for text, slot in (
            ("重命名节点…", self._rename_node_dialog),
            ("复制子树", self._copy_subtree),
        ):
            tb.addAction(text, slot)
        tb.addSeparator()
        _undo_scope_tip = (
            "覆盖范围：节点内容编辑、画布移动/连线、节点新增/删除/重命名/复制、"
            "复制子树、清除幽灵连线。\n"
            "图属性（id / entry / 标题 / preconditions / 叙事归属）的修改不入撤销栈。"
        )
        self._btn_undo = QPushButton("撤销")
        self._btn_undo.setToolTip("撤销上一步操作。\n" + _undo_scope_tip)
        self._btn_undo.clicked.connect(self._undo_stack.undo)
        tb.addWidget(self._btn_undo)
        self._btn_redo = QPushButton("重做")
        self._btn_redo.setToolTip("重做刚撤销的操作。\n" + _undo_scope_tip)
        self._btn_redo.clicked.connect(self._undo_stack.redo)
        tb.addWidget(self._btn_redo)
        self._search_edit = QLineEdit()
        self._search_edit.setPlaceholderText("搜索节点 id 或内容… Enter 定位（再按 Enter 下一条）")
        self._search_edit.returnPressed.connect(self._on_search_node)
        self._search_model = QStringListModel(self)
        self._search_completer = QCompleter(self._search_model, self)
        self._search_completer.setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
        self._search_completer.setFilterMode(Qt.MatchFlag.MatchContains)
        self._search_completer.setCompletionMode(QCompleter.CompletionMode.PopupCompletion)
        self._search_edit.setCompleter(self._search_completer)
        self._search_edit.textChanged.connect(self._update_search_completions)
        self._search_edit.textChanged.connect(self._reset_search_cycle)
        self._last_search_hits: list[str] = []
        self._last_search_idx: int = -1
        tb.addWidget(self._search_edit)
        outer.addWidget(tb)

        splitter = QSplitter(Qt.Orientation.Horizontal)

        file_box = QWidget()
        fv = QVBoxLayout(file_box)
        fv.addWidget(QLabel("graphs/*.json（按叙事归属分组）"))
        self._file_list_filter = QLineEdit()
        self._file_list_filter.setPlaceholderText("筛选文件名或 scenario…")
        self._file_list_filter.textChanged.connect(self._on_file_list_filter_changed)
        fv.addWidget(self._file_list_filter)
        self._file_tree = QTreeWidget()
        self._file_tree.setHeaderHidden(True)
        self._file_tree.setRootIsDecorated(True)
        self._file_tree.setAnimated(True)
        self._file_tree.setIndentation(16)
        self._file_tree.currentItemChanged.connect(self._on_file_tree_item_changed)
        self._file_tree.itemExpanded.connect(self._on_file_tree_expand_toggle)
        self._file_tree.itemCollapsed.connect(self._on_file_tree_expand_toggle)
        fv.addWidget(self._file_tree, 1)
        b_refresh = QPushButton("刷新列表")
        b_refresh.clicked.connect(self._refresh_file_list)
        fv.addWidget(b_refresh)
        b_new_file = QPushButton("新建图")
        b_new_file.clicked.connect(self.create_new_graph_draft)
        fv.addWidget(b_new_file)
        b_del_file = QPushButton("删除图…")
        b_del_file.clicked.connect(self.delete_selected_graph_file)
        fv.addWidget(b_del_file)

        # 「被引用」反查面板：当前图被哪些地图实体/Scenario/叙事图/其它对话引用；双击跳过去。
        # 整段可折叠（折叠后只留标题行，最省空间），折叠态用 QSettings 跨会话记住——UI 本就拥挤。
        refs_wrap = QVBoxLayout()
        refs_wrap.setContentsMargins(0, 0, 0, 0)
        refs_wrap.setSpacing(2)
        refs_head = QHBoxLayout()
        refs_head.addWidget(QLabel("<b>被引用</b>"))
        self._refs_count = QLabel("")
        self._refs_count.setStyleSheet("color: #888;")
        refs_head.addWidget(self._refs_count, 1)
        self._refs_toggle = QPushButton("收起")
        self._refs_toggle.setFixedWidth(56)
        self._refs_toggle.clicked.connect(self._toggle_refs_panel)
        refs_head.addWidget(self._refs_toggle)
        refs_wrap.addLayout(refs_head)

        self._refs_body = QWidget()
        refs_body_layout = QVBoxLayout(self._refs_body)
        refs_body_layout.setContentsMargins(0, 0, 0, 0)
        self._refs_tree = QTreeWidget()
        self._refs_tree.setHeaderHidden(True)
        self._refs_tree.setRootIsDecorated(True)
        self._refs_tree.setMaximumHeight(240)
        self._refs_tree.itemDoubleClicked.connect(self._on_referrer_double_clicked)
        refs_body_layout.addWidget(self._refs_tree)
        self._refs_hint = QLabel("打开一张图后显示引用它的实体")
        self._refs_hint.setWordWrap(True)
        refs_body_layout.addWidget(self._refs_hint)
        self._refs_refresh_btn = QPushButton("刷新引用")
        self._refs_refresh_btn.clicked.connect(self._refresh_referrers)
        refs_body_layout.addWidget(self._refs_refresh_btn)
        refs_wrap.addWidget(self._refs_body)
        fv.addLayout(refs_wrap)
        self._refs_collapsed = False
        self._restore_refs_panel_state()

        splitter.addWidget(file_box)

        self._oden = DialogueFlowOdenController(self._undo_stack, self, toast=self._toast)
        self._oden.set_model(self._model)
        self._oden.set_data_binding(
            lambda: self._data,
            lambda: self._positions,
            lambda: self._ghost_positions,
            self._on_flow_layout_debounced,
        )
        self._oden.canvas_node_selected.connect(self._on_flow_node_clicked)
        self._oden.data_topology_changed.connect(self._on_oden_topology_changed)
        self._oden.connection_rejected.connect(self._on_connection_rejected)
        self._oden.auto_layout_requested.connect(self._flow_auto_layout)
        self._oden.canvas_context_menu.connect(self._on_flow_canvas_context_menu)
        self._oden.editor_frame_rename_requested.connect(self._on_editor_frame_rename)
        self._oden.editor_group_expand_requested.connect(self._toggle_editor_group_collapsed)
        self._oden.set_editor_frame_drag_end_callback(self._on_editor_frame_drag_finished)
        self._oden.delete_key_requested.connect(self._on_flow_delete_key)
        self._flow_view = self._oden.viewer()
        self._flow_view.setMinimumHeight(260)
        self._flow_view.setFocusPolicy(Qt.FocusPolicy.StrongFocus)

        node_box = QWidget()
        nv = QVBoxLayout(node_box)
        nv.addWidget(QLabel("节点列表（与图中选中同步）"))
        self._node_list_filter = QLineEdit()
        self._node_list_filter.setPlaceholderText("筛选节点 id 或类型…")
        self._node_list_filter.textChanged.connect(self._on_node_list_filter_changed)
        nv.addWidget(self._node_list_filter)
        self._node_list = QListWidget()
        self._node_list.currentItemChanged.connect(self._on_node_item_changed)
        nv.addWidget(self._node_list, 1)
        sc_del_list = QShortcut(
            QKeySequence(Qt.Key.Key_Delete), self._node_list, activated=self._on_flow_delete_key
        )
        sc_del_list.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)
        hb = QHBoxLayout()
        self._btn_add = QPushButton("添加节点")
        self._btn_del = QPushButton("删除")
        self._btn_dup = QPushButton("复制")
        self._btn_add.clicked.connect(self._add_node)
        self._btn_del.clicked.connect(self._delete_node)
        self._btn_dup.clicked.connect(self._duplicate_node)
        hb.addWidget(self._btn_add)
        hb.addWidget(self._btn_del)
        hb.addWidget(self._btn_dup)
        nv.addLayout(hb)

        _flow_hint_detail = (
            "流程图（OdenGraphQt）：输出端口拖线到目标节点的「in」· 滚轮缩放 · 中键/右键平移 · "
            "F 适应整图 · A /「自动布局」按图 entry 做 BFS 分层（避开已有分组框占位）· "
            "空白处右键可「新建分组框」；节点中心在框内即归入该组 · "
            "布局写入 resources/editor_projects/editor_data/dialogue_flow_layout.json · "
            "依赖由 ./dev.sh install-deps 安装"
        )
        flow_hint = QLabel("流程图：端口拖线连节点 · 滚轮缩放 · 中键平移 · F 适应 · A 自动布局（详见悬停提示）")
        flow_hint.setWordWrap(True)
        flow_hint.setStyleSheet("color: #888;")
        app_theme.set_editor_font_role(flow_hint, app_theme.FONT_ROLE_HINT)
        fallback_font = flow_hint.font()
        fallback_font.setPixelSize(app_theme.font_px_for_role(app_theme.FONT_ROLE_HINT))
        flow_hint.setFont(fallback_font)
        flow_hint.setToolTip(_flow_hint_detail)
        self._flow_view.setToolTip(_flow_hint_detail)
        flow_top = QWidget()
        ft_l = QVBoxLayout(flow_top)
        ft_l.setContentsMargins(0, 0, 0, 0)
        ft_l.setSpacing(4)
        ft_l.addWidget(flow_hint)
        ft_l.addWidget(self._flow_view, 1)

        mid_split = QSplitter(Qt.Orientation.Vertical)
        mid_split.addWidget(flow_top)
        mid_split.addWidget(node_box)
        mid_split.setSizes([520, 220])

        splitter.addWidget(mid_split)

        right = QWidget()
        rv = QVBoxLayout(right)
        rv.setContentsMargins(0, 0, 0, 0)

        graph_prop_header = QHBoxLayout()
        from PySide6.QtWidgets import QToolButton
        self._graph_prop_toggle = QToolButton()
        self._graph_prop_toggle.setArrowType(Qt.ArrowType.RightArrow)
        self._graph_prop_toggle.setAutoRaise(True)
        self._graph_prop_toggle.setToolTip("折叠 / 展开图属性")
        graph_prop_title = QLabel("<b>图属性</b>")
        graph_prop_header.addWidget(self._graph_prop_toggle)
        graph_prop_header.addWidget(graph_prop_title, 1)
        rv.addLayout(graph_prop_header)

        self._graph_prop_body = QWidget()
        self._graph_group = self._graph_prop_body
        gform = QFormLayout(self._graph_prop_body)
        gform.setContentsMargins(4, 2, 4, 2)
        gform.setLabelAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        gform.setHorizontalSpacing(8)
        gform.setVerticalSpacing(6)

        def _toggle_graph_props():
            vis = not self._graph_prop_body.isVisible()
            self._graph_prop_body.setVisible(vis)
            self._graph_prop_toggle.setArrowType(
                Qt.ArrowType.DownArrow if vis else Qt.ArrowType.RightArrow
            )
        self._graph_prop_toggle.clicked.connect(_toggle_graph_props)
        self._edit_graph_id = QLineEdit()
        self._edit_entry = QLineEdit()
        self._btn_pick_entry = QPushButton("选")
        self._btn_pick_entry.clicked.connect(self._on_pick_entry_clicked)
        self._edit_title = QLineEdit()
        self._pre_cond_ed = ConditionEditor(
            "preconditions（结构化条件）",
            parent=self,
            hint="用 flag 行和表达式树编辑；quest / scenario / scenarioLine / all / any / not 不需要手写 JSON。",
        )
        self._pre_cond_ed.setMinimumHeight(160)
        self._pre_cond_ed.changed.connect(self._on_graph_meta_changed)
        self._pre_unknown_preconditions: list[Any] = []
        erow = QHBoxLayout()
        erow.addWidget(self._edit_entry)
        erow.addWidget(self._btn_pick_entry)
        gw = QWidget()
        gw.setLayout(erow)
        gform.addRow(
            _graph_form_label(
                "id",
                tip="与 graph JSON 文件名一致（不含 .json）。已保存文件请用工具栏「重命名图…」改磁盘文件名；保存后会与文件名同步。",
            ),
            self._edit_graph_id,
        )
        gform.addRow(_graph_form_label("entry", tip="图入口节点 id"), gw)
        gform.addRow(
            _graph_form_label("标题", tip="写入 meta.title"),
            self._edit_title,
        )
        self._edit_meta_scenario = QComboBox()
        self._edit_meta_scenario.setEditable(True)
        self._edit_meta_scenario.setInsertPolicy(QComboBox.InsertPolicy.NoInsert)
        self._edit_meta_scenario.setMinimumWidth(180)
        if self._injected_project_model is not None:
            self._edit_meta_scenario.setToolTip(
                "须选自 scenarios.json 清单。保存后写入 meta.scenarioId，并同步更新该 scenario 的 dialogueGraphIds。\n"
                "留空表示不归属任何 scenario（左侧列表归入「未归属」）。",
            )
        else:
            # 独立运行模式诚实化（审查 P2）：没有主编辑器 ProjectModel，保存只写图 JSON 的
            # meta.scenarioId，不会自动同步 scenarios.json 的 dialogueGraphIds 索引。
            self._edit_meta_scenario.setToolTip(
                "须选自 scenarios.json 清单。保存后写入图 JSON 的 meta.scenarioId。\n"
                "留空表示不归属任何 scenario（左侧列表归入「未归属」）。\n\n"
                "注意：当前为独立运行模式，不会自动同步 scenarios.json 的 dialogueGraphIds 索引；\n"
                "改叙事归属 / 重命名 / 删除图后，请在主编辑器内保存一次，或跑 ./dev.sh validate-data 核对索引。",
            )
        _scen_le = self._edit_meta_scenario.lineEdit()
        if _scen_le is not None:
            _scen_le.setPlaceholderText("从下拉选择 scenario id")
        self._meta_scenario_row = QWidget(self._graph_prop_body)
        _ms_lay = QHBoxLayout(self._meta_scenario_row)
        _ms_lay.setContentsMargins(0, 0, 0, 0)
        _ms_lay.addWidget(self._edit_meta_scenario, 1)
        self._btn_open_scenario = QPushButton("打开叙事页…", self._meta_scenario_row)
        self._btn_open_scenario.setToolTip(
            "在主编辑器中打开「数据编辑 → 叙事编排 → Scenarios」并选中当前 scenario。",
        )
        self._btn_open_scenario.clicked.connect(self._on_open_linked_scenario_clicked)
        _ms_lay.addWidget(self._btn_open_scenario)
        if self._injected_project_model is not None:
            _narr_tip = (
                "对应 JSON：meta.scenarioId。与 scenarios.json 双向维护：本图会出现在该 scenario 的 dialogueGraphIds 中。"
            )
        else:
            _narr_tip = (
                "对应 JSON：meta.scenarioId。独立运行模式只写本图 JSON，"
                "不自动同步 scenarios.json 的 dialogueGraphIds 索引——"
                "请在主编辑器内保存一次，或跑 ./dev.sh validate-data 核对。"
            )
        gform.addRow(
            _graph_form_label("叙事归属", tip=_narr_tip),
            self._meta_scenario_row,
        )
        gform.addRow(QLabel(), self._pre_cond_ed)
        rv.addWidget(self._graph_prop_body)
        self._collapse_graph_prop_panel()

        for w in (
            self._edit_graph_id,
            self._edit_entry,
            self._edit_title,
        ):
            w.textChanged.connect(self._on_graph_meta_changed)
        self._edit_meta_scenario.currentTextChanged.connect(self._on_graph_meta_changed)

        self._inspector = NodeInspector(
            self._node_ids_sorted,
            project_root=self._project,
            project_model_getter=self._get_project_model_for_inspector,
            node_types_getter=self._node_types_for_picker,
            dialogue_graph_id_getter=lambda: str(self._data.get("id", "") or "").strip(),
        )
        self._inspector.set_change_callback(self._on_inspector_changed)
        # 分组一律由画布分组框几何决定，检查器只读展示所属分组（不再提供会误导的
        # 下拉「指派分组」入口——那两个回调过去只是弹 toast 让人去画布操作）。
        self._inspector.set_editor_group_geometry_mode(True)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        scroll.setWidget(self._inspector)
        # 允许分割条把右栏压窄：避免子控件 minimumWidth 把整列撑死
        self._inspector.setMinimumWidth(0)
        scroll.setMinimumWidth(0)
        _right_col_policy = QSizePolicy(
            QSizePolicy.Policy.Ignored,
            QSizePolicy.Policy.Expanding,
        )
        self._inspector.setSizePolicy(_right_col_policy)
        scroll.setSizePolicy(_right_col_policy)
        right.setMinimumWidth(160)
        right.setSizePolicy(
            QSizePolicy.Policy.Ignored,
            QSizePolicy.Policy.Expanding,
        )
        rv.addWidget(QLabel("节点内容"), 0)
        rv.addWidget(scroll, 1)

        splitter.addWidget(right)
        self._main_splitter = splitter
        self._restore_splitter_sizes()

        outer.addWidget(splitter, 1)

        self._validation_dock = QWidget()
        val_layout = QVBoxLayout(self._validation_dock)
        val_layout.setContentsMargins(0, 0, 0, 0)
        val_layout.setSpacing(2)

        val_head = QHBoxLayout()
        val_head.addWidget(QLabel("<b>校验</b>"))
        self._validation_counts = QLabel("无加载图")
        self._validation_counts.setStyleSheet("color: #888;")
        val_head.addWidget(self._validation_counts, 1)
        self._validation_toggle = QPushButton("收起")
        self._validation_toggle.setFixedWidth(56)
        self._validation_toggle.clicked.connect(self._toggle_validation_dock)
        val_head.addWidget(self._validation_toggle)
        val_layout.addLayout(val_head)

        self._validation_body = QWidget()
        val_body_layout = QVBoxLayout(self._validation_body)
        val_body_layout.setContentsMargins(0, 0, 0, 0)
        self._validation_list = QListWidget()
        self._validation_list.setMinimumHeight(72)
        self._validation_list.setMaximumHeight(160)
        self._validation_list.setAlternatingRowColors(True)
        val_body_layout.addWidget(self._validation_list)
        val_layout.addWidget(self._validation_body)

        outer.addWidget(self._validation_dock)
        self._validation_dock_collapsed = False
        self._restore_validation_dock_state()

        self._status_label = QLabel("")
        self._status_label.setWordWrap(True)
        outer.addWidget(self._status_label)

        self._refresh_file_list()
        self._sync_ui_enabled(False)
        self._emit_title()
        self._on_undo_index_changed()

    @staticmethod
    def _hex_to_rgba(h: str, default: tuple[int, int, int, int] = (52, 52, 58, 255)) -> tuple[int, int, int, int]:
        s = (h or "").strip()
        if s.startswith("#") and len(s) >= 7:
            try:
                return (int(s[1:3], 16), int(s[3:5], 16), int(s[5:7], 16), 255)
            except ValueError:
                pass
        return default

    def _layout_path_for_io(self) -> Path | None:
        if self._current_path:
            return self._current_path
        if self._draft_layout_basename:
            return self._graphs_dir / self._draft_layout_basename
        return None

    def _new_editor_group_id_and_register(self, display_name: str) -> str:
        """登记新编辑器分组，返回内部分组 id（不写盘，由调用方 flush）。"""
        base = f"g_{len(self._editor_groups) + 1}"
        gid = base
        n = 0
        while gid in self._editor_groups:
            n += 1
            gid = f"{base}_{n}"
        # 新组按现有组数取调色板下一色，天然与已有组不同
        self._editor_groups[gid] = {
            "name": display_name.strip(),
            "color": _palette_group_color(len(self._editor_groups)),
        }
        return gid

    def _maybe_autocolor_legacy_groups(self) -> bool:
        """把没配色/仍是历史同色的分组按序派生成不同色（一次性修旧数据的「都同色」）。返回是否有改动。"""
        changed = False
        for idx, (gid, meta) in enumerate(self._editor_groups.items()):
            if not isinstance(meta, dict):
                continue
            cur = str(meta.get("color") or "").strip().lower()
            if not cur or cur == _LEGACY_GROUP_COLOR:
                meta["color"] = _palette_group_color(idx)
                changed = True
        return changed

    def _on_editor_frame_change_color(self, gid: str) -> None:
        if gid not in self._editor_groups:
            return
        cur = str((self._editor_groups.get(gid) or {}).get("color") or _LEGACY_GROUP_COLOR)
        picked = QColorDialog.getColor(QColor(cur), self, "分组颜色")
        if not picked.isValid():
            return
        self._editor_groups.setdefault(gid, {})["color"] = picked.name()
        self._rebuild_flow_scene()
        if self._layout_path_for_io():
            self._flush_flow_layout_to_disk()

    def _sync_node_groups_from_scene(self) -> None:
        nodes = self._data.get("nodes") or {}
        if not isinstance(nodes, dict) or not nodes:
            return
        centers = self._oden.dialogue_node_scene_centers(nodes)
        sync_node_to_group_from_frames(
            nodes_dict=nodes,
            group_frames=self._editor_group_frames,
            node_to_group=self._node_to_group,
            node_center_scene=centers,
        )

    def _on_editor_frame_drag_finished(self) -> None:
        self._oden.sync_layout_dicts_from_graph()
        snap = self._oden.snapshot_editor_group_frames()
        if snap:
            self._editor_group_frames.update(snap)
        self._sync_node_groups_from_scene()
        self._layout_save_timer.start(450)
        self._inspector_scene_timer.start(120)

    def _on_editor_frame_rename(self, gid: str) -> None:
        if gid not in self._editor_groups:
            return
        cur = str((self._editor_groups.get(gid) or {}).get("name") or gid)
        name, ok = QInputDialog.getText(self, "分组名称", "显示名称：", text=cur)
        if not ok or not (name or "").strip():
            return
        self._editor_groups.setdefault(gid, {})["name"] = name.strip()
        self._rebuild_flow_scene()
        if self._layout_path_for_io():
            self._flush_flow_layout_to_disk()

    def _spawn_group_frame_at(self, scene_x: float, scene_y: float) -> None:
        name, ok = QInputDialog.getText(self, "新建分组框", "分组显示名称：", text="分组")
        if not ok or not (name or "").strip():
            return
        gid = self._new_editor_group_id_and_register(name.strip())
        self._editor_group_frames[gid] = {
            "x": float(scene_x) - 180.0,
            "y": float(scene_y) - 140.0,
            "width": 420.0,
            "height": 300.0,
        }
        self._rebuild_flow_scene()
        if self._layout_path_for_io():
            self._flush_flow_layout_to_disk()
        self._toast(f"已新建分组框「{name.strip()}」，将节点拖入框内即可归入该组。", 4500)

    def _delete_editor_group_frame(self, gid: str) -> None:
        if gid not in self._editor_group_frames:
            return
        self._editor_group_frames.pop(gid, None)
        self._editor_groups.pop(gid, None)
        for nid in list(self._node_to_group.keys()):
            if self._node_to_group.get(nid) == gid:
                del self._node_to_group[nid]
        self._rebuild_flow_scene()
        if self._layout_path_for_io():
            self._flush_flow_layout_to_disk()

    def _node_group_color_map(self) -> dict[str, tuple[int, int, int, int]]:
        out: dict[str, tuple[int, int, int, int]] = {}
        for nid, gid in self._node_to_group.items():
            g = self._editor_groups.get(gid) or {}
            c = str(g.get("color") or "#4a6fa8")
            out[nid] = self._hex_to_rgba(c)
        return out

    def _hidden_node_ids(self) -> set[str]:
        """折叠分组的成员节点：画布上不渲染（只留分组框）。"""
        collapsed = {
            gid for gid, m in self._editor_groups.items()
            if isinstance(m, dict) and m.get("collapsed")
        }
        if not collapsed:
            return set()
        return {nid for nid, gid in self._node_to_group.items() if gid in collapsed}

    def _toggle_editor_group_collapsed(self, gid: str) -> None:
        if gid not in self._editor_groups:
            return
        meta = self._editor_groups.setdefault(gid, {})
        meta["collapsed"] = not bool(meta.get("collapsed"))
        self._rebuild_flow_scene()
        if self._layout_path_for_io():
            self._flush_flow_layout_to_disk()

    def _update_search_completions(self, _t: str) -> None:
        nodes = self._data.get("nodes") or {}
        if not isinstance(nodes, dict):
            return
        labels: list[str] = []
        for nid in self._node_ids_sorted():
            raw = nodes.get(nid, {})
            hay = node_search_haystack(nid, raw)
            labels.append(f"{nid}\t{hay[:80]}")
        self._search_model.setStringList(labels)

    def _on_flow_canvas_context_menu(
        self,
        scene_x: float,
        scene_y: float,
        hit_node_id: object,
        hit_frame_gid: object,
        hit_ghost_missing: object,
    ) -> None:
        if not isinstance(self._data.get("nodes"), dict) or not self._data["nodes"]:
            self._toast("请先打开或新建图", 3000)
            return
        nid = hit_node_id if isinstance(hit_node_id, str) and hit_node_id else None
        fgid = hit_frame_gid if isinstance(hit_frame_gid, str) and hit_frame_gid else None
        ghost_mid = (
            hit_ghost_missing.strip()
            if isinstance(hit_ghost_missing, str) and hit_ghost_missing.strip()
            else None
        )
        super_gid = parse_group_super_node_gid(nid) if nid else None
        menu = QMenu(self)
        if ghost_mid:
            act_g = QAction(f'清除指向缺失节点「{ghost_mid}」的连线…', self)
            act_g.triggered.connect(
                lambda checked=False, g=ghost_mid: self._remove_ghost_missing_targets([g])
            )
            menu.addAction(act_g)
            menu.addSeparator()
        if fgid and fgid in self._editor_group_frames:
            act_nm = QAction("编辑分组名称…", self)
            act_nm.triggered.connect(lambda checked=False, g=fgid: self._on_editor_frame_rename(g))
            menu.addAction(act_nm)
            act_color = QAction("改颜色…", self)
            act_color.triggered.connect(lambda checked=False, g=fgid: self._on_editor_frame_change_color(g))
            menu.addAction(act_color)
            _collapsed = bool((self._editor_groups.get(fgid) or {}).get("collapsed"))
            act_col = QAction("展开此分组" if _collapsed else "折叠此分组（隐藏组内节点）", self)
            act_col.triggered.connect(lambda checked=False, g=fgid: self._toggle_editor_group_collapsed(g))
            menu.addAction(act_col)
            act_rm = QAction("删除此分组框…", self)
            act_rm.triggered.connect(lambda checked=False, g=fgid: self._delete_editor_group_frame(g))
            menu.addAction(act_rm)
            menu.addSeparator()
        if super_gid and super_gid in self._editor_groups:
            act_ex = QAction("展开此分组", self)
            act_ex.triggered.connect(
                lambda checked=False, g=super_gid: self._toggle_editor_group_collapsed(g)
            )
            menu.addAction(act_ex)
        elif nid and nid in self._data["nodes"]:
            act_entry = QAction("设为入口节点", self)
            cur_ent = str(self._data.get("entry", "") or "").strip()
            act_entry.setEnabled(cur_ent != nid)
            act_entry.triggered.connect(
                lambda checked=False, n=nid: self._canvas_context_set_entry_node(n)
            )
            menu.addAction(act_entry)
            act_del = QAction("删除此节点…", self)
            act_del.triggered.connect(lambda checked=False, n=nid: self._canvas_context_delete_node(n))
            menu.addAction(act_del)
            act_dup = QAction("复制此节点…", self)
            act_dup.triggered.connect(lambda checked=False, n=nid: self._canvas_context_duplicate_node(n))
            menu.addAction(act_dup)
        else:
            act_nf = QAction("新建分组框…", self)
            act_nf.triggered.connect(
                lambda checked=False, sx=scene_x, sy=scene_y: self._spawn_group_frame_at(sx, sy)
            )
            menu.addAction(act_nf)
            menu.addSeparator()
            for nt, label in (
                ("line", "line"),
                ("runActions", "runActions"),
                ("choice", "choice"),
                ("switch", "switch"),
                ("ownerState", "ownerState（所属实体状态）"),
                ("contextState", "contextState（上下文状态）"),
                ("end", "end"),
            ):
                act = QAction(f"在此处添加 {label}", self)
                act.triggered.connect(
                    lambda checked=False, t=nt, sx=scene_x, sy=scene_y: self._spawn_node_at_canvas(
                        t, sx, sy
                    )
                )
                menu.addAction(act)
        menu.exec(QCursor.pos())

    def _focus_node_in_editor(self, nid: str) -> None:
        if nid not in (self._data.get("nodes") or {}):
            return
        self._ensure_node_visible_in_list(nid)
        self._oden.select_dialogue_node(nid)

    def focus_node_by_id(self, nid: str) -> bool:
        """外部跳转入口（主编辑器全局搜索）：选中节点、视图飞到节点(缩放+居中,
        复用内部搜索同款 center_on_node)、检查器同步。

        程序化选中不触发画布点击信号,检查器要显式跟一把;返回节点是否存在。
        _load_path 尾部有 singleShot(0) 的「适配全图」,会把刚打开的图拉到最远
        视距——这里在其后再排一个同类定时器补断言(FIFO 后到先赢),
        保证"搜索跳转刚打开的图"也直接看见节点。"""
        nid = (nid or "").strip()
        if not nid or nid not in (self._data.get("nodes") or {}):
            return False
        self._focus_node_in_editor(nid)
        self._oden.center_on_node(nid)
        self._apply_selected_node_to_inspector()
        QTimer.singleShot(0, lambda: self._refocus_view_if_present(nid))
        return True

    def _refocus_view_if_present(self, nid: str) -> None:
        """补断言:节点仍在当前图上才重新飞过去(图可能已被切走)。"""
        try:
            if nid in (self._data.get("nodes") or {}):
                self._oden.center_on_node(nid)
        except Exception:
            pass  # 视图补断言失败不影响选中/检查器

    def _canvas_context_delete_node(self, nid: str) -> None:
        if nid not in (self._data.get("nodes") or {}):
            return
        self._delete_node(nid)

    def _canvas_context_duplicate_node(self, nid: str) -> None:
        if nid not in (self._data.get("nodes") or {}):
            return
        self._duplicate_node(nid)

    def _canvas_context_set_entry_node(self, nid: str) -> None:
        if nid not in (self._data.get("nodes") or {}):
            return
        self._edit_entry.blockSignals(True)
        try:
            self._edit_entry.setText(nid)
        finally:
            self._edit_entry.blockSignals(False)
        self._model.apply_meta_patch({"entry": nid})
        self._emit_title()
        self._rebuild_flow_scene()
        self._schedule_validation_refresh()

    def _validate_current_graph(self) -> tuple[list[str], list[str]]:
        return validate_graph_tiered(
            self._data,
            project_root=self._project,
            project_model=self._get_project_model_for_inspector(),
        )

    def _schedule_validation_refresh(self, delay_ms: int = 350, *, notify_toast: bool = False) -> None:
        if notify_toast:
            self._validation_notify_toast = True
        self._validation_refresh_timer.start(delay_ms)

    def _on_validation_refresh_timer(self) -> None:
        self._refresh_validation_panel(flush_inspector=False)
        if not self._validation_notify_toast:
            return
        self._validation_notify_toast = False
        err, warn = self._last_validation
        if not err and not warn:
            return
        first = err[0] if err else warn[0]
        prefix = "错误" if err else "警告"
        self._set_validation_dock_collapsed(False)
        self._save_validation_dock_state()
        self._toast(f"{prefix}：{first}（见下方校验面板）", 5000)

    @staticmethod
    def _humanize_connect_err(err: str) -> str:
        mapping = {
            "cannot connect node to itself": "不能连接节点到自身",
            "source node does not exist": "源节点不存在",
            "invalid source node data": "源节点数据无效",
            "invalid output port": (
                "无效输出端口：画布端口与节点 JSON 不同步。"
                "常见原因是 contextState/ownerState 在右侧改了分支数但画布尚未重建；"
                "可先点「校验当前图」或切换节点刷新画布后再连线。"
            ),
            "node does not exist": "节点不存在",
            "invalid node data": "节点数据无效",
        }
        return mapping.get(err.strip(), err)

    def _sync_meta_for_validation(self) -> None:
        if not isinstance(self._data.get("nodes"), dict):
            return
        try:
            self._widgets_to_data_meta()
        except (json.JSONDecodeError, ValueError):
            pass

    def _sync_data_for_validation(self) -> None:
        self._sync_meta_for_validation()
        try:
            self._flush_current_inspector_to_data()
        except ValueError:
            pass

    def _refresh_validation_panel(self, *, flush_inspector: bool = False) -> None:
        self._validation_list.clear()
        nodes = self._data.get("nodes")
        if not isinstance(nodes, dict) or not nodes:
            self._last_validation = ([], [])
            self._validation_counts.setText("无加载图")
            self._validation_counts.setStyleSheet("color: #888;")
            return
        if flush_inspector:
            self._sync_data_for_validation()
        else:
            self._sync_meta_for_validation()
        err, warn = self._validate_current_graph()
        if self._connect_feedback_messages:
            err = list(self._connect_feedback_messages) + err
        self._last_validation = (err, warn)
        if not err and not warn:
            self._validation_counts.setText("无问题")
            self._validation_counts.setStyleSheet("color: #4a8;")
            item = QListWidgetItem("未发现校验问题")
            item.setFlags(Qt.ItemFlag.NoItemFlags)
            self._validation_list.addItem(item)
            return
        parts: list[str] = []
        if err:
            parts.append(f"错误 {len(err)}")
        if warn:
            parts.append(f"警告 {len(warn)}")
        self._validation_counts.setText(" · ".join(parts))
        self._validation_counts.setStyleSheet("color: #c44;" if err else "color: #a80;")
        for msg in err:
            item = QListWidgetItem(f"错误：{msg}")
            item.setForeground(QColor("#e05050"))
            self._validation_list.addItem(item)
        for msg in warn:
            item = QListWidgetItem(f"警告：{msg}")
            item.setForeground(QColor("#d0a020"))
            self._validation_list.addItem(item)

    def _set_validation_dock_collapsed(self, collapsed: bool) -> None:
        self._validation_dock_collapsed = collapsed
        self._validation_body.setVisible(not collapsed)
        self._validation_toggle.setText("展开" if collapsed else "收起")

    def _toggle_validation_dock(self) -> None:
        self._set_validation_dock_collapsed(not self._validation_dock_collapsed)
        self._save_validation_dock_state()

    def _restore_validation_dock_state(self) -> None:
        s = QSettings("GameDraft", "DialogueGraphEditor")
        collapsed = bool(s.value("validation_dock_collapsed", False))
        self._set_validation_dock_collapsed(collapsed)
        height = s.value("validation_dock_height")
        if isinstance(height, int) and 72 <= height <= 240:
            self._validation_list.setMaximumHeight(height)
            self._validation_list.setMinimumHeight(min(height, 120))

    def _save_validation_dock_state(self) -> None:
        s = QSettings("GameDraft", "DialogueGraphEditor")
        s.setValue("validation_dock_collapsed", self._validation_dock_collapsed)
        s.setValue("validation_dock_height", self._validation_list.maximumHeight())

    def _owner_state_wrapper_available(self) -> tuple[bool, str]:
        model = self._get_project_model_for_inspector()
        if model is None:
            return False, "无法加载项目模型，不能创建 OwnerStateNode"
        dialogue_id = str(self._data.get("id", "") or "").strip()
        if not dialogue_id:
            return False, "当前对话图缺少 id，不能创建 OwnerStateNode"
        from tools.editor.shared.narrative_catalog import resolve_owner_wrapper_states

        info = resolve_owner_wrapper_states(self._project, model, dialogue_id)
        wrappers = info.get("wrappers") or []
        if not wrappers:
            return False, str(info.get("message") or "未找到所属实体 wrapper")
        return True, str(info.get("message") or "")

    def _guard_owner_state_node_creation(self) -> bool:
        ok, msg = self._owner_state_wrapper_available()
        if ok:
            return True
        QMessageBox.warning(
            self,
            "无法创建 OwnerStateNode",
            f"{msg}\n\n请先在叙事编辑器为引用该对话图的 NPC/Hotspot 绑定 wrapperGraph。",
        )
        return False

    def _spawn_node_at_canvas(self, node_type: str, scene_x: float, scene_y: float) -> None:
        if node_type == "ownerState" and not self._guard_owner_state_node_creation():
            return
        snap = self._begin_structure_snapshot()
        nodes = self._model.nodes
        nid = suggest_next_id(nodes)
        self._model.add_node(nid, default_node(node_type, {k: v for k, v in nodes.items() if k != nid}))
        self._positions[nid] = (float(scene_x), float(scene_y))
        self._emit_title()
        self._ensure_node_visible_in_list(nid)
        self._rebuild_flow_scene()
        self._oden.select_dialogue_node(nid)
        self._layout_save_timer.start(450)
        self._push_structure_undo(f"新增节点 {nid}", snap)

    def _on_flow_delete_key(self) -> None:
        nids = self._oden.selected_flow_node_ids()
        if nids:
            self._delete_nodes(nids)
            return
        mids = self._oden.selected_ghost_missing_ids()
        if mids:
            self._remove_ghost_missing_targets(mids)
            return
        self._toast("请先选中要删除的节点或幽灵占位", 2500)

    def create_new_graph_draft(self) -> None:
        if self._model.is_dirty:
            r = QMessageBox.question(
                self,
                "未保存",
                "放弃当前修改并新建？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if r != QMessageBox.StandardButton.Yes:
                return
        stem = "new_dialogue"
        self._model.load({
            "schemaVersion": 1,
            "id": stem,
            "entry": "n_start",
            "meta": {"title": stem},
            "preconditions": [],
            "nodes": {
                "n_start": {
                    "type": "line",
                    "speaker": {"kind": "player"},
                    "text": "",
                    "next": "",
                },
            },
        })
        self._data = self._model.mutable_data
        self._loaded_disk_bytes = None  # 新草稿无磁盘基线
        self._loaded_disk_data = None
        self._current_path = None
        self._draft_layout_basename = f"__draft_{uuid.uuid4().hex[:10]}.json"
        self._editor_groups.clear()
        self._node_to_group.clear()
        self._editor_group_frames.clear()
        self._ghost_positions.clear()
        self._undo_stack.clear()
        self._apply_data_to_widgets()
        self._sync_ui_enabled(True)
        self._positions = auto_layout_node_positions(
            self._data.get("nodes") or {},
            str(self._data.get("entry", "") or ""),
        )
        self._reset_node_list_filter()
        self._populate_node_list(select_first=True)
        self._rebuild_flow_scene()
        self._oden.fit_all()
        self._mark_dirty()
        # 记录全新草稿的出厂快照：Save All 用它识别「从未编辑过的草稿」并跳过静默物化（审查 P3）。
        self._new_draft_pristine = self._model.to_dict()
        self._refresh_file_list(select_unsaved=True)
        self._emit_title()
        self._collapse_graph_prop_panel()
        self._schedule_validation_refresh(0)
        self._refresh_referrers()

    def _reset_to_no_file_loaded(self) -> None:
        self._model.load_empty()
        self._data = self._model.mutable_data
        self._current_path = None
        self._draft_layout_basename = None
        self._new_draft_pristine = None
        self._editing_node_id = None
        self._editor_groups.clear()
        self._node_to_group.clear()
        self._editor_group_frames.clear()
        self._positions.clear()
        self._ghost_positions.clear()
        self._undo_stack.clear()
        self._apply_data_to_widgets()
        self._reset_node_list_filter()
        self._populate_node_list()
        self._set_dirty(False)
        self._sync_ui_enabled(False)
        self._emit_title()
        self._connect_feedback_messages.clear()
        self._refresh_validation_panel(flush_inspector=False)

    def delete_selected_graph_file(self) -> None:
        it = self._file_tree.currentItem()
        if it is None:
            self._toast("请先在左侧列表选中要删除的 graphs/*.json", 3000)
            return
        # _file_tree 是 QTreeWidget:树节点取数必须带列号(分组化改造漏改点,2026-07-13 修)
        raw = it.data(0, Qt.ItemDataRole.UserRole)
        if raw == self._unsaved_list_token:
            QMessageBox.information(
                self,
                "无法删除",
                "「未保存」项没有对应的磁盘文件。\n"
                "若要放弃当前草稿，请先通过「新建图」在提示中选择放弃修改。",
            )
            return
        path = Path(str(raw))
        try:
            path = path.resolve()
            gdir = self._graphs_dir.resolve()
        except OSError:
            QMessageBox.warning(self, "删除", "无法解析图文件路径。")
            return
        if path.parent.resolve() != gdir:
            QMessageBox.warning(self, "删除", "只能删除项目 graphs 目录下的 .json 文件。")
            return
        if not path.is_file():
            self._toast("文件不存在，已刷新列表", 3000)
            self._refresh_file_list()
            if self._current_path:
                self._sync_file_list_selection(self._current_path)
            return
        was_open = (
            self._current_path is not None
            and path.resolve() == self._current_path.resolve()
        )
        msg = (
            f"永久删除磁盘上的 {path.name}？\n"
            f"将从 resources/editor_projects/editor_data/dialogue_flow_layout.json 中移除该图的布局数据。"
        )
        if was_open and self._model.is_dirty:
            msg += "\n\n当前该图有未保存修改，删除后这些修改将一并丢失。"
        r = QMessageBox.question(
            self,
            "删除图文件",
            msg,
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if r != QMessageBox.StandardButton.Yes:
            return
        try:
            raw_del = load_json(path)
        except Exception:
            raw_del = {}
        del_gid = path.stem
        if isinstance(raw_del, dict):
            del_gid = str(raw_del.get("id", path.stem)).strip() or path.stem
        pm_del = self._injected_project_model
        if pm_del is not None and del_gid:
            pm_del.relink_dialogue_graph_to_scenarios(del_gid, None)
        try:
            path.unlink()
        except OSError as e:
            QMessageBox.critical(self, "删除失败", str(e))
            return
        remove_layout_entry_for_graph(self._project, path)
        if was_open:
            rest = list_graph_files(self._project)
            if rest:
                self._load_path(rest[0])
            else:
                self._reset_to_no_file_loaded()
                self._refresh_file_list()
        else:
            has_draft = bool((self._data.get("nodes") or {}))
            self._refresh_file_list(select_unsaved=has_draft and self._current_path is None)
            if self._current_path:
                self._sync_file_list_selection(self._current_path)

    def has_unsaved_changes(self) -> bool:
        return self._model.is_dirty

    def is_untouched_new_draft(self) -> bool:
        """当前是否为「新建后从未被编辑过」的全新草稿（无磁盘文件、内容仍等于新建模板）。

        供内嵌 Save All 的 flush 判定：这种草稿跳过写盘、保留脏态，
        不静默物化成 graphs/new_dialogue.json（审查 P3）。
        """
        if self._current_path is not None:
            return False
        if self._new_draft_pristine is None:
            return False
        return self._model.to_dict() == self._new_draft_pristine

    def last_save_failure_reason(self) -> str:
        """最近一次 save() 失败的中文原因（成功后为空串），供宿主降级提示。"""
        return self._last_save_failure

    def graph_display_name(self) -> str:
        """给宿主提示用的当前图人类可读名。"""
        if self._current_path is not None:
            return self._current_path.stem
        gid = str(self._data.get("id", "") or "").strip()
        return f"{gid or '新图'}（未保存草稿）"

    def current_path(self) -> Path | None:
        return self._current_path

    def confirm_discard_or_save_before_close(self, parent: QWidget | None) -> bool:
        if not self._model.is_dirty:
            return True
        r = QMessageBox.question(
            parent or self,
            "图对话未保存",
            "当前图对话有未保存修改，是否保存？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Save:
            return bool(self.save())
        if r == QMessageBox.StandardButton.Cancel:
            return False
        return True

    def discard_unsaved_changes(self) -> None:
        """真正放弃当前未保存修改：有文件则重载磁盘版本，纯草稿则回到未加载状态。

        嵌入主编辑器时供关闭路径在用户选「放弃」后调用——只清 dirty 标志不够，
        随后的统一 flush 仍会按未保存内容判脏并写盘（复核 P1-01）。
        """
        if not self._model.is_dirty:
            return
        if self._current_path is not None:
            self._load_path(self._current_path)
        else:
            self._reset_to_no_file_loaded()
            self._refresh_file_list()

    def load_path(self, path: Path) -> None:
        """打开指定 graphs/*.json（若当前有未保存修改会先提示保存/放弃/取消）。"""
        if not self._prompt_save_if_dirty():
            return
        self._load_path(path)

    def open_file_dialog(self) -> None:
        # 打开前先处理未保存修改（旧实现直接覆盖，静默丢弃全部编辑，审查 P1-8）
        if not self._prompt_save_if_dirty():
            return
        path, _ = QFileDialog.getOpenFileName(
            self,
            "打开图对话",
            str(self._graphs_dir),
            "JSON (*.json)",
        )
        if path:
            self._load_path(Path(path))

    def _prompt_save_if_dirty(self) -> bool:
        """有未保存修改时提示 保存/放弃/取消。返回 False = 用户取消，调用方应中止。"""
        if not self._model.is_dirty:
            return True
        r = QMessageBox.question(
            self,
            "未保存",
            "当前文件已修改，是否保存？",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if r == QMessageBox.StandardButton.Save:
            return self.save()
        if r == QMessageBox.StandardButton.Cancel:
            return False
        return True  # Discard

    def save(self) -> bool:
        self._last_save_failure = ""
        if self._current_path:
            return self._write_to_path(self._current_path)
        try:
            self._widgets_to_data_meta(relink_catalog=True)
        except json.JSONDecodeError as e:
            self._last_save_failure = f"preconditions 条件解析失败：{e}"
            QMessageBox.critical(
                self, "保存失败", f"preconditions 条件解析失败：{e}"
            )
            return False
        except ValueError as e:
            self._last_save_failure = str(e)
            QMessageBox.critical(self, "保存失败", str(e))
            return False
        stem = self._sanitize_filename_stem(self._edit_graph_id.text())
        target = self._graphs_dir / f"{stem}.json"
        n = 0
        while target.exists():
            n += 1
            target = self._graphs_dir / f"{stem}_{n}.json"
        return self._write_to_path(target)

    @staticmethod
    def _sanitize_filename_stem(s: str) -> str:
        t = re.sub(r"[^\w\-.]+", "_", (s or "").strip())
        return t or "new_dialogue"

    def save_as(self) -> bool:
        path, _ = QFileDialog.getSaveFileName(
            self,
            "另存为",
            str(self._graphs_dir),
            "JSON (*.json)",
        )
        if not path:
            return False
        p = Path(path)
        if not p.suffix:
            p = p.with_suffix(".json")
        return self._write_to_path(p)

    def _rename_graph_file_dialog(self) -> None:
        """将当前已保存的 graphs/*.json 改名，并迁移 editor_data 中的流程布局键。"""
        if self._current_path is None:
            QMessageBox.information(
                self,
                "重命名图",
                "当前没有已关联的磁盘文件（例如仍为「未保存」草稿）。\n"
                "请先点击「保存」生成 graphs/*.json；或先用「另存为…」指定文件名。\n"
                "之后可用本功能改文件名。",
            )
            return
        try:
            self._widgets_to_data_meta(relink_catalog=True)
            self._flush_current_inspector_to_data()
        except json.JSONDecodeError as e:
            QMessageBox.critical(
                self, "重命名图", f"preconditions 条件解析失败：{e}"
            )
            return
        except ValueError as e:
            QMessageBox.critical(self, "重命名图", str(e))
            return
        errors, warnings = self._validate_current_graph()
        if errors:
            QMessageBox.critical(
                self,
                "无法重命名",
                "图数据存在错误，请先修正后再试：\n" + "\n".join(errors[:40]),
            )
            return
        if warnings:
            wtxt = "\n".join(warnings[:40])
            if len(warnings) > 40:
                wtxt += f"\n… 共 {len(warnings)} 条警告"
            r = QMessageBox.question(
                self,
                "校验警告",
                wtxt + "\n\n仍要重命名吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )
            if r != QMessageBox.StandardButton.Yes:
                return
        try:
            old_path = self._current_path.resolve()
            gdir = self._graphs_dir.resolve()
        except OSError as e:
            QMessageBox.critical(self, "重命名图", str(e))
            return
        if old_path.parent.resolve() != gdir:
            QMessageBox.warning(self, "重命名图", "当前文件不在项目 graphs 目录下，无法重命名。")
            return
        if not old_path.is_file():
            QMessageBox.warning(self, "重命名图", "当前路径不是有效文件，已取消。")
            self._refresh_file_list()
            return
        cur_stem = old_path.stem
        new_stem_raw, ok = QInputDialog.getText(
            self,
            "重命名图文件",
            "新的图 id（将保存为 graphs/<id>.json，不含扩展名）：\n\n"
            "注意：场景、NPC、动作等里若引用了旧图名，需自行改为新名。",
            text=cur_stem,
        )
        if not ok:
            return
        new_stem = self._sanitize_filename_stem(new_stem_raw)
        new_path = (self._graphs_dir / f"{new_stem}.json").resolve()
        if new_path == old_path:
            return
        if new_path.is_file():
            QMessageBox.warning(
                self,
                "重命名图",
                f"已存在文件：{new_path.name}\n请改用其它名称，或先处理冲突文件。",
            )
            return
        old_graph_id = str(self._data.get("id", "")).strip()
        self._model.apply_meta_patch({"id": new_stem})
        try:
            save_json(new_path, self._model.to_dict())
        except OSError as e:
            self._model.apply_meta_patch({"id": old_graph_id})
            QMessageBox.critical(self, "重命名图", f"写入新文件失败：{e}")
            return
        try:
            old_path.unlink()
        except OSError as e:
            QMessageBox.warning(
                self,
                "重命名图",
                f"新文件已写入 {new_path.name}，但未能删除旧文件 {old_path.name}：{e}\n"
                "请手动删除重复的旧文件。",
            )
        migrate_layout_map_key(self._project, old_path, new_path)
        self._current_path = new_path
        self._draft_layout_basename = None
        pm_rn = self._injected_project_model
        if pm_rn is not None:
            if old_graph_id and old_graph_id != new_stem:
                pm_rn.rename_dialogue_graph_in_scenarios_catalog(old_graph_id, new_stem)
            meta_rn = self._data.get("meta") if isinstance(self._data.get("meta"), dict) else {}
            sc_rn = str(meta_rn.get("scenarioId", "")).strip()
            pm_rn.relink_dialogue_graph_to_scenarios(new_stem, sc_rn or None)
        self._apply_data_to_widgets()
        self._set_dirty(False)
        self._flush_flow_layout_to_disk()
        self._emit_title()
        self._toast(f"已重命名为 {new_path.name}", 4000)
        self._refresh_file_list()
        self._sync_file_list_selection(new_path)

    def run_validate(self) -> None:
        if not self._data.get("nodes"):
            QMessageBox.information(self, "校验", "没有加载图。")
            return
        try:
            self._widgets_to_data_meta()
            self._flush_current_inspector_to_data()
        except json.JSONDecodeError as e:
            QMessageBox.critical(self, "校验", f"preconditions 条件解析失败：{e}")
            return
        except ValueError as e:
            QMessageBox.critical(self, "校验", str(e))
            return
        self._connect_feedback_messages.clear()
        self._refresh_validation_panel(flush_inspector=True)
        err, warn = self._last_validation
        if not err and not warn:
            self._toast("校验通过，未发现明显问题。", 3000)
            return
        self._set_validation_dock_collapsed(False)
        self._save_validation_dock_state()
        self._toast(f"校验完成：错误 {len(err)}，警告 {len(warn)}（见下方校验面板）", 5000)

    def _on_connection_rejected(self, err: str) -> None:
        self._connect_feedback_messages = [f"连线失败：{self._humanize_connect_err(err)}"]
        self._set_validation_dock_collapsed(False)
        self._refresh_validation_panel(flush_inspector=False)

    def new_file(self) -> None:
        """兼容旧入口：等价于左侧「新建图」。"""
        self.create_new_graph_draft()

    def _node_types_for_picker(self) -> dict[str, str]:
        nodes = self._data.get("nodes") or {}
        if not isinstance(nodes, dict):
            return {}
        return {
            k: str((v or {}).get("type", "?"))
            for k, v in nodes.items()
            if isinstance(v, dict)
        }

    def _get_project_model_for_inspector(self):
        """供节点检查器打开 FlagPickerDialog；失败则返回 None。"""
        if self._injected_project_model is not None:
            return self._injected_project_model
        if self._inspector_project_model_failed:
            return None
        if self._inspector_project_model is None:
            try:
                from tools.editor.project_model import ProjectModel

                m = ProjectModel()
                m.load_project(self._project)
                self._inspector_project_model = m
            except Exception:
                self._inspector_project_model_failed = True
                self._inspector_project_model = None
                return None
        return self._inspector_project_model

    def _toast(self, msg: str, ms: int = 4000) -> None:
        self._toast_timer.stop()
        self._status_label.setText(msg)
        self._status_label.update()
        if ms > 0:
            self._toast_timer.start(ms)

    def _on_toast_timeout(self) -> None:
        lbl = getattr(self, "_status_label", None)
        if lbl is not None:
            lbl.clear()

    def _set_dirty(self, dirty: bool) -> None:
        self._model.set_dirty(dirty)

    def _sync_ui_enabled(self, has_file: bool):
        self._graph_group.setEnabled(has_file)
        self._inspector.setEnabled(has_file)
        self._node_list.setEnabled(has_file)
        self._flow_view.setEnabled(has_file)
        for b in (self._btn_add, self._btn_del, self._btn_dup):
            b.setEnabled(has_file)
        saved = self._current_path is not None
        self._edit_graph_id.setReadOnly(saved)
        if saved:
            self._edit_graph_id.setToolTip("保存后由文件名决定，用工具栏「重命名图...」修改")
            self._edit_graph_id.setStyleSheet("color: #888;")
        else:
            self._edit_graph_id.setToolTip("")
            self._edit_graph_id.setStyleSheet("")
        if not has_file:
            self._positions.clear()
            self._ghost_positions.clear()
            self._editor_group_frames.clear()
            self._undo_stack.clear()
            self._oden.rebuild(
                {},
                {},
                {},
                selected_id=None,
                entry="",
                node_diag={},
                node_group_colors=None,
                editor_groups={},
                node_to_group={},
                editor_group_frames={},
            )

    def _on_flow_layout_debounced(self, ms: int) -> None:
        """节点拖动结束：只防抖写盘坐标。

        不再整图重建：拖动只改坐标（Qt 已直接落位、边随节点自动重画、分组框为固定持久几何、
        可达性着色只随拓扑），重建纯属多余，正是"拖动后节点闪一下/再拖时跳变/选中丢失"的根因。
        """
        self._layout_save_timer.start(ms)

    def _flush_flow_layout_to_disk(self) -> None:
        lp = self._layout_path_for_io()
        if not lp:
            return
        self._oden.sync_layout_dicts_from_graph()
        snap = self._oden.snapshot_editor_group_frames()
        if snap:
            self._editor_group_frames.update(snap)
        self._sync_node_groups_from_scene()
        self._canonicalize_editor_layout_to_graph_nodes()
        gh = self._ghost_positions if self._ghost_positions else None
        write_positions_for_graph(
            self._project,
            lp,
            self._positions,
            ghost_positions=gh,
            editor_groups=self._editor_groups,
            editor_node_groups=self._node_to_group,
            group_frames=self._editor_group_frames,
        )

    def _flow_auto_layout(self) -> None:
        if not self._layout_path_for_io():
            return
        nodes = self._data.get("nodes") or {}
        if not nodes:
            return
        # 自动布局会覆盖全部手工摆位且不可撤销：已有手工坐标时先确认（审查 P3-3）
        if self._positions:
            r = QMessageBox.question(
                self,
                "自动布局",
                "将按算法重排所有节点位置，覆盖当前手工摆位且不可撤销。继续？",
                QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
                QMessageBox.StandardButton.Cancel,
            )
            if r != QMessageBox.StandardButton.Ok:
                return
        entry = str(self._data.get("entry", "") or "")
        avoid = avoid_rects_list(self._editor_group_frames)
        # 场景已建 → 采集节点真实渲染宽高，让分层布局按真值分配层距（宽对白节点不再重叠）。
        node_sizes = self._oden.measure_node_render_sizes()
        self._positions = auto_layout_node_positions(
            nodes, entry, avoid_rects=avoid, node_sizes=node_sizes or None
        )
        self._rebuild_flow_scene()
        self._flush_flow_layout_to_disk()
        self._oden.fit_all()
        # 仅更新画布坐标 + resources/editor_projects/editor_data/dialogue_flow_layout.json，不改 graphs/*.json，勿标脏以免切文件误提示保存对话

    def _flow_fit_view(self) -> None:
        self._oden.fit_all()

    def _on_flow_node_clicked(self, nid: str) -> None:
        if not nid:
            return
        if nid not in self._model.nodes:
            return
        self._node_list.blockSignals(True)
        try:
            self._ensure_node_visible_in_list(nid)
        finally:
            self._node_list.blockSignals(False)
        self._apply_selected_node_to_inspector()

    def _on_oden_topology_changed(self) -> None:
        self._connect_feedback_messages.clear()
        self._emit_title()
        self._inspector_scene_timer.start(120)
        self._schedule_validation_refresh(0, notify_toast=True)

    def _on_model_topology_changed(self, src_nid: str) -> None:
        """拓扑经 Model 变化：仅把检查器表单里正在显示的该节点同步刷新。

        校验刷新不在此处触发——否则一次画布连线会走两条路径各调一次 `_schedule_validation_refresh`
        （本方法 + 画布手势的 `_on_oden_topology_changed`）。改由单一入口负责：画布连线/断线→
        `_on_oden_topology_changed`（即时 + toast）；rename/删除/清除入边→各自调用点已显式调度。
        model.topology_changed 的全部发射源（connect/clear_output、clear_incoming_to、rename_node）
        都被上述路径覆盖，此处去掉调度不会漏校验。
        """
        insp_nid = self._inspector.current_node_id()
        if insp_nid and insp_nid == src_nid:
            node_data = self._model.nodes.get(src_nid)
            if node_data:
                self._inspector.update_topology_from_data(node_data)

    def _sync_inspector_from_selection(self) -> None:
        nid = self._active_editing_nid()
        if nid and nid in self._model.nodes:
            raw = copy.deepcopy(self._data["nodes"][nid])
            self._inspector.set_node(
                nid,
                raw,
                editor_groups=self._editor_groups,
                editor_group_for_node=self._node_to_group.get(nid, ""),
            )

    def _on_undo_index_changed(self) -> None:
        self._btn_undo.setEnabled(self._undo_stack.canUndo())
        self._btn_redo.setEnabled(self._undo_stack.canRedo())
        new_count = self._undo_stack.count()
        is_fresh_push = new_count != self._prev_undo_count
        self._prev_undo_count = new_count
        if self._layout_path_for_io():
            # 始终把画布坐标同步进 _positions 并防抖写盘（移动/撤销都需要持久化坐标）。
            self._flush_flow_layout_to_disk()
            # 仅 undo/redo（count 不变）才整图重建以反映回退后的数据/拓扑；
            # 全新编辑已就地更新、拖动已由画布直接应用——此处再重建纯属浪费，正是
            # "每次编辑闪一下整图""拖动节点乱跳/弹回"的根因。
            if not is_fresh_push:
                self._inspector_scene_timer.start(80)
        if self._suppress_inspector_resync_from_undo:
            return
        self._sync_inspector_from_selection()
        self._schedule_validation_refresh(500)

    # ----- 结构级操作的快照撤销（节点增删/重命名/复制/清幽灵连线，审查 P2-④） --------
    def _begin_structure_snapshot(self) -> tuple[dict, dict]:
        """在结构级变更前调用：抓当前全图数据 + 画布坐标快照。"""
        return (self._model.data, dict(self._positions))

    def _push_structure_undo(self, label: str, before: tuple[dict, dict]) -> None:
        """结构级变更完成后调用：数据真变了才把 before/after 快照压入撤销栈。"""
        after_data = self._model.data
        if before[0] == after_data:
            return  # 被取消/无实质变化：不入栈
        cmd = _GraphStructureSnapshotCmd(
            self, label, before[0], before[1], after_data, dict(self._positions)
        )
        # push 会同步触发 indexChanged；调用方已自行完成 UI 刷新，
        # 抑制 indexChanged 里的检查器 resync，避免重复重建表单丢焦点。
        self._suppress_inspector_resync_from_undo = True
        try:
            self._undo_stack.push(cmd)
        finally:
            self._suppress_inspector_resync_from_undo = False

    def _apply_structure_snapshot(self, data: dict, positions: dict) -> None:
        """undo/redo 回灌全图快照并整体刷新 UI（保持脏态，不触碰磁盘字节基线）。"""
        self._model.replace_data(data)
        self._data = self._model.mutable_data
        self._positions = dict(positions)
        self._editing_node_id = None
        self._apply_data_to_widgets()
        self._populate_node_list(select_first=True, preserve_selection=False)
        self._canonicalize_editor_layout_to_graph_nodes()
        self._rebuild_flow_scene()
        if self._layout_path_for_io():
            self._flush_flow_layout_to_disk()
        self._emit_title()
        self._schedule_validation_refresh()

    def _reset_search_cycle(self) -> None:
        self._last_search_hits = []
        self._last_search_idx = -1

    def _on_search_node(self) -> None:
        line = (self._search_edit.text() or "").strip()
        if not line:
            return
        q = line.lower()
        nid_part = line.split("\t")[0].strip().lower()
        nodes = self._data.get("nodes") or {}
        hits: list[str] = []
        for nid in self._node_ids_sorted():
            hay = node_search_haystack(nid, nodes.get(nid, {})).lower()
            if nid_part == nid.lower() or q in nid.lower() or q in hay:
                hits.append(nid)
        if not hits:
            self._toast("未找到匹配节点", 3000)
            self._last_search_hits = []
            self._last_search_idx = -1
            return
        if hits == self._last_search_hits and self._last_search_idx >= 0:
            self._last_search_idx = (self._last_search_idx + 1) % len(hits)
        else:
            self._last_search_hits = hits
            self._last_search_idx = 0
        hit = hits[self._last_search_idx]
        count_info = f" ({self._last_search_idx + 1}/{len(hits)})" if len(hits) > 1 else ""
        self._toast(f"定位到 {hit}{count_info}", 3000)
        self._node_list.blockSignals(True)
        try:
            self._ensure_node_visible_in_list(hit)
        finally:
            self._node_list.blockSignals(False)
        self._apply_selected_node_to_inspector()
        self._oden.select_dialogue_node(hit)
        self._oden.center_on_node(hit)

    def _rename_node_dialog(self) -> None:
        old = self._current_node_id_from_list()
        if not old:
            return
        new_id, ok = QInputDialog.getText(self, "重命名节点", "新节点 id（将更新所有引用）", text=old)
        if not ok or not (new_id or "").strip():
            return
        new_id = new_id.strip()
        snap = self._begin_structure_snapshot()
        err = self._model.rename_node(old, new_id)
        if err:
            QMessageBox.warning(self, "重命名", err)
            return
        if old in self._positions:
            self._positions[new_id] = self._positions.pop(old)
        if old in self._node_to_group:
            self._node_to_group[new_id] = self._node_to_group.pop(old)
        self._editing_node_id = new_id
        self._emit_title()
        self._populate_node_list()
        self._node_list.blockSignals(True)
        try:
            self._ensure_node_visible_in_list(new_id)
        finally:
            self._node_list.blockSignals(False)
        self._apply_selected_node_to_inspector()
        self._rebuild_flow_scene()
        self._schedule_validation_refresh()
        self._push_structure_undo(f"重命名节点 {old} → {new_id}", snap)

    @staticmethod
    def _remap_local_next(raw: dict, old_to_new: dict, seen: set[str]) -> None:
        t = raw.get("type")
        if t in ("line", "runActions"):
            nxt = str(raw.get("next", "") or "")
            if nxt in seen:
                raw["next"] = old_to_new[nxt]
        elif t == "choice":
            for opt in raw.get("options") or []:
                if isinstance(opt, dict):
                    nxt = str(opt.get("next", "") or "")
                    if nxt in seen:
                        opt["next"] = old_to_new[nxt]
        elif t in ("switch", "ownerState", "contextState"):
            # ownerState/contextState 与 switch 同构（cases[].next + defaultNext），
            # ownerState 另有 missingWrapperNext——旧实现漏掉这两类节点，复制子树后
            # 副本的出边仍指向原子树造成跨树窜线（审查 P1-39）。
            for c in raw.get("cases") or []:
                if isinstance(c, dict):
                    nxt = str(c.get("next", "") or "")
                    if nxt in seen:
                        c["next"] = old_to_new[nxt]
            dn = str(raw.get("defaultNext", "") or "")
            if dn in seen:
                raw["defaultNext"] = old_to_new[dn]
            mwn = str(raw.get("missingWrapperNext", "") or "")
            if mwn in seen:
                raw["missingWrapperNext"] = old_to_new[mwn]

    def _copy_subtree(self) -> None:
        root = self._current_node_id_from_list()
        nodes = self._data.get("nodes") or {}
        if not root or root not in nodes:
            return
        snap = self._begin_structure_snapshot()
        seen: set[str] = set()
        stack = [root]
        while stack:
            u = stack.pop()
            if u in seen or u not in nodes:
                continue
            seen.add(u)
            for s, d, _l, _k, _i in extract_flow_edges_detailed(nodes):
                if s == u and d in nodes:
                    stack.append(d)
        temp = dict(nodes)
        old_to_new: dict[str, str] = {}
        for oid in sorted(seen, key=lambda x: (x.lower(), x)):
            nid_new = suggest_next_id(temp)
            old_to_new[oid] = nid_new
            temp[nid_new] = {"type": "end"}
        brx, bry = self._positions.get(root, (0.0, 0.0))
        for i, oid in enumerate(sorted(seen, key=lambda x: (x.lower(), x))):
            nid_new = old_to_new[oid]
            raw = copy.deepcopy(nodes[oid])
            self._remap_local_next(raw, old_to_new, seen)
            self._model.add_node(nid_new, raw)
            self._positions[nid_new] = (brx + 240.0 + (i % 5) * 40.0, bry + (i // 5) * 85.0)
        self._emit_title()
        self._populate_node_list()
        self._rebuild_flow_scene()
        self._push_structure_undo(f"复制子树（{len(seen)} 个节点）", snap)

    def _flow_layout_is_collapsed(self) -> bool:
        """仅当坐标明显是「未初始化脏数据」（全挤在场景原点附近一点）时视为塌缩。

        旧实现用「外包框宽高都 < 2px」判定，会把正常手摆的紧密布局误判为塌缩并整表重算，
        表现为重新打开或任意 rebuild 后布局错乱。
        """
        nodes = self._data.get("nodes") or {}
        if len(nodes) < 2:
            return False
        coords: list[tuple[float, float]] = []
        for nid in nodes:
            p = self._positions.get(nid)
            if p is None:
                return False
            coords.append((float(p[0]), float(p[1])))
        xs = [c[0] for c in coords]
        ys = [c[1] for c in coords]
        span_x = max(xs) - min(xs)
        span_y = max(ys) - min(ys)
        cx = sum(xs) / len(xs)
        cy = sum(ys) / len(ys)
        eps = 1e-3
        if span_x >= eps or span_y >= eps:
            return False
        return abs(cx) < 1.0 and abs(cy) < 1.0

    def _ensure_positions_for_nodes(self) -> None:
        nodes = self._data.get("nodes") or {}
        if not nodes:
            return
        entry = str(self._data.get("entry", "") or "")
        avoid = avoid_rects_list(self._editor_group_frames)
        if self._flow_layout_is_collapsed():
            self._positions = auto_layout_node_positions(
                nodes, entry, avoid_rects=avoid
            )
            if self._layout_path_for_io():
                self._flush_flow_layout_to_disk()
            return
        fallback = auto_layout_node_positions(nodes, entry, avoid_rects=avoid)
        for nid in nodes:
            if nid not in self._positions:
                self._positions[nid] = fallback.get(nid, (0.0, 0.0))

    def _canonicalize_editor_layout_to_graph_nodes(self) -> bool:
        """以 graphs/*.json 中当前 ``nodes`` 为唯一准绳裁剪编辑器布局（坐标、分组、ghosts）。

        避免 layout 文件残留已删节点 id，进而与画布/Oden 状态不一致或出现无法对应 JSON 的占位。
        返回是否修改过任何字典内容（用于打开文件后决定是否回写 layout）。
        """
        raw_nodes = self._data.get("nodes")
        nodes: dict[str, Any] = raw_nodes if isinstance(raw_nodes, dict) else {}
        changed = False
        for k in list(self._positions.keys()):
            if k not in nodes:
                del self._positions[k]
                changed = True
        for k in list(self._node_to_group.keys()):
            if k not in nodes:
                del self._node_to_group[k]
                changed = True
        for k, gid in list(self._node_to_group.items()):
            if gid not in self._editor_groups:
                del self._node_to_group[k]
                changed = True
        for k in list(self._editor_group_frames.keys()):
            if k not in self._editor_groups:
                del self._editor_group_frames[k]
                changed = True
        missing: set[str] = set()
        for _s, d, _lab, _k, _idx in extract_flow_edges_detailed(nodes):
            if d and d not in nodes:
                missing.add(str(d))
        for k in list(self._ghost_positions.keys()):
            if str(k) not in missing:
                del self._ghost_positions[k]
                changed = True
        return changed

    def _rebuild_flow_scene(self) -> None:
        fw = QApplication.focusWidget()
        restore_graph_prop_focus = (
            fw is not None and self._graph_prop_body.isAncestorOf(fw)
        )
        self._canonicalize_editor_layout_to_graph_nodes()
        if not self._layout_path_for_io():
            self._oden.rebuild(
                {},
                {},
                {},
                selected_id=None,
                entry="",
                node_diag={},
                node_group_colors=None,
                editor_groups={},
                node_to_group={},
                editor_group_frames={},
            )
            if restore_graph_prop_focus and fw is not None:
                fw.setFocus(Qt.FocusReason.OtherFocusReason)
            return
        self._ensure_positions_for_nodes()
        sync_node_to_group_from_layout_positions(
            positions=self._positions,
            nodes_dict=self._data.get("nodes") or {},
            group_frames=self._editor_group_frames,
            node_to_group=self._node_to_group,
        )
        sel = self._current_node_id_from_list()
        tags = analyze_node_tags(self._data)
        entry = str(self._data.get("entry", "") or "")
        self._oden.rebuild(
            self._data,
            self._positions,
            self._ghost_positions,
            selected_id=sel,
            entry=entry,
            node_diag=tags,
            node_group_colors=self._node_group_color_map(),
            editor_groups=self._editor_groups,
            node_to_group=self._node_to_group,
            editor_group_frames=self._editor_group_frames,
        )
        # 仅以画布上实际幽灵节点为准，去掉已失效的 ghost 坐标，避免脏键残留到下次写入。
        snap = self._oden.snapshot_ghost_positions()
        self._ghost_positions.clear()
        self._ghost_positions.update(snap)
        if restore_graph_prop_focus and fw is not None:
            fw.setFocus(Qt.FocusReason.OtherFocusReason)

    def _on_file_list_filter_changed(self, _text: str = "") -> None:
        self._rebuild_file_tree(preserve_selection=True)

    def _file_tree_settings(self) -> QSettings:
        proj = str(self._project)
        s = QSettings("GameDraft", "DialogueGraphEditor")
        s.beginGroup("graph_file_tree")
        s.beginGroup(proj)
        return s

    def _on_file_tree_expand_toggle(self, item: QTreeWidgetItem) -> None:
        gk = item.data(0, _TREE_GROUP_KEY_ROLE)
        if gk:
            self._file_tree_settings().setValue(f"grp_expanded/{gk}", item.isExpanded())

    def _read_graph_meta_scenario_for_path(self, path: Path) -> str:
        try:
            data = load_json(path)
        except Exception:
            return ""
        if not isinstance(data, dict):
            return ""
        meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
        return str(meta.get("scenarioId", "")).strip()

    def _walk_file_tree_items(self, parent: QTreeWidgetItem | None = None):
        if parent is None:
            for i in range(self._file_tree.topLevelItemCount()):
                yield from self._walk_file_tree_items(self._file_tree.topLevelItem(i))
        else:
            yield parent
            for i in range(parent.childCount()):
                yield from self._walk_file_tree_items(parent.child(i))

    def _rebuild_file_tree(
        self,
        *,
        select_unsaved: bool = False,
        preserve_selection: bool = True,
    ) -> None:
        q = (self._file_list_filter.text() or "").strip().lower()
        pm = self._injected_project_model or self._get_project_model_for_inspector()
        known_scenarios: list[str] = []
        known_set: set[str] = set()
        if pm is not None:
            known_scenarios = pm.scenario_ids_ordered()
            known_set = set(known_scenarios)

        prev_path: Path | None = None
        prev_unsaved = False
        if preserve_selection and not select_unsaved:
            cur = self._file_tree.currentItem()
            if cur is not None:
                k = cur.data(0, _TREE_KIND_ROLE)
                if k == _TK_FILE:
                    try:
                        prev_path = Path(str(cur.data(0, Qt.ItemDataRole.UserRole))).resolve()
                    except OSError:
                        prev_path = None
                elif k == _TK_UNSAVED:
                    prev_unsaved = True

        def gkey_title(sid: str) -> tuple[str, str]:
            s = (sid or "").strip()
            if not s:
                return "__ungrouped__", "未归属"
            if s in known_set:
                return s, s
            return f"__orphan__:{s}", f"未知：{s}"

        bucket: dict[str, tuple[str, list[tuple[str, Any]]]] = {}
        draft_label = f"【未保存】{self._data.get('id', '新图')}"
        if self._current_path is None and isinstance(self._data.get("nodes"), dict) and self._data["nodes"]:
            gk, gt = gkey_title(self._meta_scenario_value())
            if gk not in bucket:
                bucket[gk] = (gt, [])
            bucket[gk][1].append((draft_label, self._unsaved_list_token))

        for p in list_graph_files(self._project):
            sid = self._read_graph_meta_scenario_for_path(p)
            gk, gt = gkey_title(sid)
            if gk not in bucket:
                bucket[gk] = (gt, [])
            bucket[gk][1].append((p.name, p))

        ordered_gkeys: list[str] = []
        for sid in known_scenarios:
            if sid in bucket:
                ordered_gkeys.append(sid)
        orphans = sorted(k for k in bucket if k.startswith("__orphan__:"))
        for k in orphans:
            if k not in ordered_gkeys:
                ordered_gkeys.append(k)
        if "__ungrouped__" in bucket and "__ungrouped__" not in ordered_gkeys:
            ordered_gkeys.append("__ungrouped__")
        for k in bucket:
            if k not in ordered_gkeys:
                ordered_gkeys.append(k)

        settings = self._file_tree_settings()
        self._file_tree.blockSignals(True)
        try:
            self._file_tree.clear()
            for gkey in ordered_gkeys:
                if gkey not in bucket:
                    continue
                gtitle, entries = bucket[gkey]
                filtered: list[tuple[str, Any]] = []
                for lab, role in entries:
                    role_s = str(role).lower() if not isinstance(role, Path) else lab.lower()
                    if q and q not in lab.lower() and q not in gtitle.lower() and q not in gkey.lower() and q not in role_s:
                        continue
                    filtered.append((lab, role))
                if not filtered:
                    continue
                group_item = QTreeWidgetItem([f"{gtitle}  ({len(filtered)})"])
                group_item.setData(0, _TREE_KIND_ROLE, _TK_GROUP)
                group_item.setData(0, _TREE_GROUP_KEY_ROLE, gkey)
                group_item.setFlags(Qt.ItemFlag.ItemIsEnabled)
                self._file_tree.addTopLevelItem(group_item)
                exp = settings.value(f"grp_expanded/{gkey}", True)
                if not isinstance(exp, bool):
                    exp = True
                group_item.setExpanded(bool(exp))
                for lab, role in sorted(filtered, key=lambda x: (x[0].lower(), str(x[1]))):
                    child = QTreeWidgetItem([lab])
                    if role == self._unsaved_list_token:
                        child.setData(0, _TREE_KIND_ROLE, _TK_UNSAVED)
                        child.setData(0, Qt.ItemDataRole.UserRole, self._unsaved_list_token)
                    else:
                        child.setData(0, _TREE_KIND_ROLE, _TK_FILE)
                        child.setData(0, Qt.ItemDataRole.UserRole, str(role))
                    group_item.addChild(child)
        finally:
            self._file_tree.blockSignals(False)

        # 恢复选中必须屏蔽信号：否则程序化 setCurrentItem 会重入
        # _on_file_tree_item_changed——程序化"打开 B"时它把选中恢复到旧文件 A，
        # 反手又加载回 A（内容=A、树高亮 B、B 点不开，审查 P1-38）。
        self._file_tree.blockSignals(True)
        try:
            if select_unsaved and self._current_path is None:
                for it in self._walk_file_tree_items():
                    if it.data(0, _TREE_KIND_ROLE) == _TK_UNSAVED:
                        self._file_tree.setCurrentItem(it)
                        break
            elif prev_path is not None:
                for it in self._walk_file_tree_items():
                    if it.data(0, _TREE_KIND_ROLE) != _TK_FILE:
                        continue
                    try:
                        if Path(str(it.data(0, Qt.ItemDataRole.UserRole))).resolve() == prev_path:
                            self._file_tree.setCurrentItem(it)
                            break
                    except OSError:
                        pass
            elif prev_unsaved:
                for it in self._walk_file_tree_items():
                    if it.data(0, _TREE_KIND_ROLE) == _TK_UNSAVED:
                        self._file_tree.setCurrentItem(it)
                        break
            elif self._current_path:
                self._sync_file_list_selection(self._current_path)
        finally:
            self._file_tree.blockSignals(False)

    def _refresh_file_list(self, *, select_unsaved: bool = False) -> None:
        self._rebuild_file_tree(
            select_unsaved=select_unsaved,
            preserve_selection=not select_unsaved,
        )

    def _update_unsaved_file_list_display(self) -> None:
        """未保存草稿仅改图 id 时更新列表文案，避免整树重建导致失焦。"""
        if self._current_path is not None:
            return
        new_label = f"【未保存】{self._data.get('id', '新图')}"
        for it in self._walk_file_tree_items():
            if it.data(0, _TREE_KIND_ROLE) == _TK_UNSAVED:
                if it.text(0) != new_label:
                    it.setText(0, new_label)
                return
        self._refresh_file_list(select_unsaved=True)

    def _node_ids_sorted(self) -> list[str]:
        nodes = self._data.get("nodes")
        if not isinstance(nodes, dict):  # nodes 容器畸形（list/str）→ 无节点，不崩
            return []
        return sorted(nodes.keys(), key=lambda x: (x.lower(), x))

    def _reset_node_list_filter(self) -> None:
        self._node_list_filter.blockSignals(True)
        self._node_list_filter.clear()
        self._node_list_filter.blockSignals(False)

    def _select_node_row_by_id(self, nid: str) -> bool:
        for i in range(self._node_list.count()):
            it = self._node_list.item(i)
            if it and str(it.data(Qt.ItemDataRole.UserRole) or "") == nid:
                self._node_list.setCurrentRow(i)
                return True
        return False

    def _ensure_node_visible_in_list(self, nid: str) -> None:
        if self._select_node_row_by_id(nid):
            return
        self._node_list_filter.blockSignals(True)
        self._node_list_filter.clear()
        self._node_list_filter.blockSignals(False)
        self._populate_node_list(select_first=False, preserve_selection=False)
        self._select_node_row_by_id(nid)

    def _emit_title(self):
        t = "图对话"
        if self._current_path:
            t += f" — {self._current_path.name}"
        elif isinstance(self._data.get("nodes"), dict) and self._data["nodes"]:
            t += f" — 【未保存】{self._data.get('id', '新图')}"
        if self._model.is_dirty:
            t += " *"
        self.title_changed.emit(t)

    def _mark_dirty(self):
        self._model.mark_dirty()
        self._emit_title()

    def _collapse_graph_prop_panel(self) -> None:
        """打开/新建图后默认折叠图属性区域，让节点面板优先占用纵向空间。"""
        self._graph_prop_body.setVisible(False)
        self._graph_prop_toggle.setArrowType(Qt.ArrowType.RightArrow)

    def _load_path(self, path: Path):
        try:
            disk_bytes = path.read_bytes()
            raw = json.loads(disk_bytes.decode("utf-8"))
        except (OSError, ValueError, json.JSONDecodeError) as e:
            QMessageBox.critical(self, "打开失败", str(e))
            return
        if not isinstance(raw, dict):
            # 顶层文档畸形（agent/手写成 list/str/数字等，而非 { id, entry, nodes }）：
            # 降级为空图，避免整条 load 链上 self._data.get(...) 抛 AttributeError 崩溃。
            # 原始字节仍保留在 _loaded_disk_bytes 供对照；不静默改盘，用户需在外部工具修复。
            raw = {}
        elif "nodes" in raw and not isinstance(raw.get("nodes"), dict):
            # nodes 容器畸形（写成 list/str 等）：降级为空 nodes，避免画布重建 / 分组同步 /
            # 布局等下游把 nodes 当 dict 遍历（.keys()/.items()）而崩。磁盘校验门
            # （validate_graph_tiered）读盘原文仍会把它报为「nodes 必须是对象」error。
            raw = dict(raw)
            raw["nodes"] = {}
        self._model.load(raw)
        self._data = self._model.mutable_data
        # 记录磁盘原始字节与语义快照：保存时若内容无实质变化，原样写回原字节，
        # 保证"打开未改→导出格式零变化"（磁盘是外部工具按不一致风格预格式化的，无法用序列化器复现）。
        self._loaded_disk_bytes = disk_bytes
        self._loaded_disk_data = copy.deepcopy(raw)
        self._current_path = path
        self._draft_layout_basename = None
        self._new_draft_pristine = None  # 打开了真实文件：不再是全新草稿
        self._editing_node_id = None
        self._apply_data_to_widgets()
        self._reset_node_list_filter()
        self._sync_ui_enabled(True)
        self._positions = load_positions_for_graph(self._project, path)
        self._ghost_positions = load_ghost_positions_for_graph(self._project, path)
        self._editor_groups, self._node_to_group = load_editor_groups_for_graph(self._project, path)
        self._editor_group_frames = load_group_frames_for_graph(self._project, path)
        nodes = self._data.get("nodes") or {}
        entry = str(self._data.get("entry", "") or "")
        migrated_frames = False
        if (
            not self._editor_group_frames
            and self._editor_groups
            and self._node_to_group
            and self._positions
        ):
            self._editor_group_frames = migrate_legacy_frames_from_assignments(
                self._positions, self._node_to_group, self._editor_groups
            )
            migrated_frames = bool(self._editor_group_frames)
        regen_layout = False
        avoid = avoid_rects_list(self._editor_group_frames)
        if not self._positions:
            self._positions = auto_layout_node_positions(
                nodes, entry, avoid_rects=avoid
            )
            regen_layout = True
        elif self._flow_layout_is_collapsed():
            self._positions = auto_layout_node_positions(
                nodes, entry, avoid_rects=avoid
            )
            regen_layout = True
        layout_fixed = self._canonicalize_editor_layout_to_graph_nodes()
        # 旧「都同色」分组：加载即在内存里派生成不同色（确定性，跨开一致）。故意不因此单独写盘——
        # 打开不改磁盘；等用户下次真正动布局/改色时随统一 flush 一起持久化。
        self._maybe_autocolor_legacy_groups()
        self._undo_stack.clear()
        self._populate_node_list(select_first=True)
        self._rebuild_flow_scene()
        if regen_layout or migrated_frames or layout_fixed:
            self._flush_flow_layout_to_disk()
        QTimer.singleShot(0, self._flow_fit_view)
        self._emit_title()
        self._refresh_file_list()
        self._sync_file_list_selection(path)
        self._collapse_graph_prop_panel()
        self._schedule_validation_refresh(0)
        # 切文件后清跨文件残留的「连线失败」横幅（审查 P3-5）
        self._connect_feedback_messages = []
        self._refresh_referrers()

    # ----- 「被引用」反查（纯只读展示 + 双击导航；不改任何数据） -------------------
    def _set_refs_collapsed(self, collapsed: bool) -> None:
        self._refs_collapsed = collapsed
        self._refs_body.setVisible(not collapsed)  # 折叠 = 整段隐藏，只留标题行
        self._refs_toggle.setText("展开" if collapsed else "收起")

    def _toggle_refs_panel(self) -> None:
        self._set_refs_collapsed(not self._refs_collapsed)
        self._save_refs_panel_state()

    def _restore_refs_panel_state(self) -> None:
        s = QSettings("GameDraft", "DialogueGraphEditor")
        self._set_refs_collapsed(bool(s.value("referrers_panel_collapsed", False, type=bool)))

    def _save_refs_panel_state(self) -> None:
        s = QSettings("GameDraft", "DialogueGraphEditor")
        s.setValue("referrers_panel_collapsed", self._refs_collapsed)

    def _refresh_referrers(self) -> None:
        """按当前图 id 反查引用它的实体，填充左栏「被引用」树。"""
        from .dialogue_references import (
            CATEGORY_ORDER,
            find_dialogue_referrers,
            group_by_category,
        )

        self._refs_tree.clear()
        graph_id = self._current_path.stem if self._current_path is not None else ""
        model = self._injected_project_model
        if not graph_id or model is None:
            self._refs_count.setText("")
            self._refs_hint.setText("打开一张图后显示引用它的实体")
            return

        # 其它对话图：读盘扫一遍（不含当前图），找谁跳到本图。
        other_dialogues: dict[str, Any] = {}
        try:
            for p in list_graph_files(self._project):
                if p.stem == graph_id:
                    continue
                try:
                    other_dialogues[p.stem] = load_json(p)
                except (OSError, ValueError):
                    continue
        except OSError:
            pass

        referrers = find_dialogue_referrers(
            graph_id,
            scenes=getattr(model, "scenes", None) or {},
            scenarios_catalog=getattr(model, "scenarios_catalog", None),
            narrative_graphs=getattr(model, "narrative_graphs", None),
            other_dialogues=other_dialogues,
        )
        if not referrers:
            self._refs_count.setText("0")
            self._refs_hint.setText(f"没有实体引用「{graph_id}」")
            return
        self._refs_count.setText(f"{len(referrers)} 处")
        self._refs_hint.setText(f"{len(referrers)} 处引用（双击跳转）")

        grouped = group_by_category(referrers)
        for category in CATEGORY_ORDER:
            items = grouped.get(category)
            if not items:
                continue
            cat_item = QTreeWidgetItem([f"{category}（{len(items)}）"])
            self._refs_tree.addTopLevelItem(cat_item)
            # 地图实体再按场景分子组
            if category == "地图实体":
                by_scene: dict[str, list] = {}
                for ref in items:
                    by_scene.setdefault(ref.scene_id, []).append(ref)
                for scene_id, scene_refs in by_scene.items():
                    scene_item = QTreeWidgetItem([f"场景 {scene_id}" if scene_id else "（未归属场景）"])
                    cat_item.addChild(scene_item)
                    for ref in scene_refs:
                        self._add_referrer_leaf(scene_item, ref)
            else:
                for ref in items:
                    self._add_referrer_leaf(cat_item, ref)
        self._refs_tree.expandAll()

    def _add_referrer_leaf(self, parent: QTreeWidgetItem, ref) -> None:
        leaf = QTreeWidgetItem([f"{ref.label}  ·  {ref.detail}"])
        leaf.setToolTip(0, f"{ref.label} — {ref.detail}（双击导航）")
        leaf.setData(0, Qt.ItemDataRole.UserRole, ref.nav)
        parent.addChild(leaf)

    def _on_referrer_double_clicked(self, item: QTreeWidgetItem, _col: int) -> None:
        nav = item.data(0, Qt.ItemDataRole.UserRole)
        if not (isinstance(nav, tuple) and len(nav) == 2):
            return  # 分组行不跳转
        method_name, args = nav
        fn = getattr(self.window(), str(method_name), None)
        if callable(fn):
            fn(*args)

    def _sync_file_list_selection(self, path: Path) -> None:
        target = path.resolve()
        self._file_tree.blockSignals(True)
        try:
            for it in self._walk_file_tree_items():
                if it.data(0, _TREE_KIND_ROLE) != _TK_FILE:
                    continue
                raw = it.data(0, Qt.ItemDataRole.UserRole)
                if raw == self._unsaved_list_token:
                    continue
                try:
                    if Path(str(raw)).resolve() == target:
                        self._file_tree.setCurrentItem(it)
                        break
                except OSError:
                    pass
        finally:
            self._file_tree.blockSignals(False)

    def _refresh_meta_scenario_combo(self) -> None:
        cb = self._edit_meta_scenario
        cb.blockSignals(True)
        cb.clear()
        cb.addItem("（未指定）", "")
        pm = self._get_project_model_for_inspector()
        if pm:
            for sid in pm.scenario_ids_ordered():
                cb.addItem(sid, sid)
        cb.blockSignals(False)

    def _set_meta_scenario_value(self, val: str) -> None:
        cb = self._edit_meta_scenario
        cb.blockSignals(True)
        v = (val or "").strip()
        if not v:
            cb.setCurrentIndex(0)
        else:
            idx = cb.findData(v)
            if idx >= 0:
                cb.setCurrentIndex(idx)
            else:
                cb.setCurrentIndex(-1)
                cb.setEditText(v)
        cb.blockSignals(False)

    def _meta_scenario_value(self) -> str:
        cb = self._edit_meta_scenario
        if cb.currentIndex() == 0:
            return ""
        t = cb.currentText().strip()
        if t == "（未指定）":
            return ""
        if cb.currentIndex() > 0:
            d = cb.itemData(cb.currentIndex())
            if isinstance(d, str) and d.strip():
                return d.strip()
        return t

    def _apply_data_to_widgets(self):
        for w in (
            self._edit_graph_id,
            self._edit_entry,
            self._edit_title,
        ):
            w.blockSignals(True)
        self._edit_meta_scenario.blockSignals(True)
        self._pre_cond_ed.blockSignals(True)
        try:
            self._edit_graph_id.setText(str(self._data.get("id", "")))
            self._edit_entry.setText(str(self._data.get("entry", "")))
            meta = self._data.get("meta") or {}
            self._edit_title.setText(str(meta.get("title", "")))
            saved_sc = str(meta.get("scenarioId", "")) if isinstance(meta, dict) else ""
            self._refresh_meta_scenario_combo()
            self._set_meta_scenario_value(saved_sc)
            pre = self._data.get("preconditions")
            editable_pre, unknown_pre = _split_graph_preconditions_for_editor(pre)
            self._pre_unknown_preconditions = copy.deepcopy(unknown_pre)
            # 记录原始"空表示"，让 _widgets_to_data_meta 忠实回写（缺省保持缺省、[]保持[]），
            # 避免「打开即把缺省 preconditions 归一成 [] → 假脏 + 导出漂移」。
            self._orig_preconditions_present = "preconditions" in self._data
            self._orig_meta_present = "meta" in self._data
            self._orig_schema_version_present = "schemaVersion" in self._data
            self._pre_cond_ed.set_flag_pattern_context(
                self._get_project_model_for_inspector(), None
            )
            self._pre_cond_ed.set_data(editable_pre)
        finally:
            self._pre_cond_ed.blockSignals(False)
            for w in (
                self._edit_graph_id,
                self._edit_entry,
                self._edit_title,
            ):
                w.blockSignals(False)
            self._edit_meta_scenario.blockSignals(False)
        meta_tail = self._data.get("meta") if isinstance(self._data.get("meta"), dict) else {}
        sc_tail = str(meta_tail.get("scenarioId", "")).strip()
        self._file_tree_group_key = (str(self._data.get("id", "")).strip(), sc_tail)

    def _sync_scenario_catalog_for_graph_meta(self, old_graph_id: str) -> None:
        pm = self._injected_project_model
        if pm is None:
            return
        new_id = str(self._data.get("id", "")).strip()
        meta = self._data.get("meta") if isinstance(self._data.get("meta"), dict) else {}
        new_sc = str(meta.get("scenarioId", "")).strip()
        o = (old_graph_id or "").strip()
        n = new_id
        if o and n and o != n:
            pm.rename_dialogue_graph_in_scenarios_catalog(o, n)
        link_id = n or o
        if link_id:
            pm.relink_dialogue_graph_to_scenarios(link_id, new_sc if new_sc else None)

    def _widgets_to_data_meta(self, *, relink_catalog: bool = False):
        """把图属性控件的值 + 载入时的「原键是否存在」基线交给 model 忠实回写顶层字段。

        「忠实=未改动即与磁盘字节一致」的表示规则（schemaVersion 透传、meta 原地更新保键序、
        preconditions/meta 缺省保持缺省）已下沉到 `GraphDocumentModel.apply_graph_meta_fields`，
        本方法只负责采集控件值与 `_orig_*_present` 基线。

        ``relink_catalog`` 仅在真正保存时为 True：把「叙事归属→scenarios 目录」的跨文件
        改写限定在保存那一刻，不再随每次校验刷新（每键）改 scenarios 目录——否则放弃草稿
        也会在目录留下悬空 dialogueGraphIds、被主编辑器整体保存落盘（审查 P2-18）。
        """
        old_graph_id = str(self._data.get("id", "")).strip()
        merged_preconditions = list(self._pre_cond_ed.to_list())
        merged_preconditions.extend(copy.deepcopy(self._pre_unknown_preconditions))
        self._model.apply_graph_meta_fields(
            graph_id=self._edit_graph_id.text().strip(),
            entry=self._edit_entry.text().strip(),
            title=self._edit_title.text().strip(),
            scenario_id=self._meta_scenario_value(),
            preconditions=merged_preconditions,
            schema_version_present=getattr(
                self, "_orig_schema_version_present", "schemaVersion" in self._data
            ),
            meta_present=getattr(self, "_orig_meta_present", "meta" in self._data),
            preconditions_present=getattr(
                self, "_orig_preconditions_present", "preconditions" in self._data
            ),
        )
        if relink_catalog:
            self._sync_scenario_catalog_for_graph_meta(old_graph_id)

    def _flush_current_inspector_to_data(self) -> None:
        """保存/校验前：把右侧节点面板内容写回 _data['nodes']。

        以面板 _node_id 为准；不一致时以 inspector 当前 id 为 fallback 而非抛异常。
        """
        if not self._model.nodes:
            return
        nid = self._active_editing_nid()
        if not nid:
            return
        try:
            node = self._inspector.get_node()
        except ValueError as e:
            # 让保存/校验的「表单非法」报错能定位到具体节点（否则只有一句裸 ValueError，
            # 用户不知道是哪个节点/字段）。该节点即右侧正在编辑的节点，已在检查器可见。
            raise ValueError(f"节点 {nid!r}：{e}") from e
        self._model.set_node(nid, node)
        self._editing_node_id = nid

    def _on_graph_meta_changed(self):
        if not isinstance(self._data.get("nodes"), dict):
            return
        old_id = str(self._data.get("id", "")).strip()
        old_meta = self._data.get("meta") if isinstance(self._data.get("meta"), dict) else {}
        old_sc = str(old_meta.get("scenarioId", "")).strip()
        old_key = (old_id, old_sc)
        old_entry = str(self._data.get("entry", "") or "").strip()
        try:
            self._widgets_to_data_meta()
        except (json.JSONDecodeError, ValueError):
            return
        new_id = str(self._data.get("id", "")).strip()
        new_meta = self._data.get("meta") if isinstance(self._data.get("meta"), dict) else {}
        new_sc = str(new_meta.get("scenarioId", "")).strip()
        new_key = (new_id, new_sc)
        new_entry = str(self._data.get("entry", "") or "").strip()
        self._file_tree_group_key = new_key
        self._emit_title()
        # 仅 entry 变化才影响画布（入口节点高亮）；title/scenarioId/id 改动不重建画布
        if old_entry != new_entry:
            self._meta_rebuild_timer.start(300)
        if old_key != new_key:
            self._rebuild_file_tree(preserve_selection=True)
        elif self._current_path is None and self._draft_layout_basename:
            self._update_unsaved_file_list_display()
        self._schedule_validation_refresh()

    def _on_node_list_filter_changed(self, _t: str = "") -> None:
        if not isinstance(self._data.get("nodes"), dict):
            return
        self._populate_node_list(select_first=False, preserve_selection=True)

    def _populate_node_list(
        self, select_first: bool = False, *, preserve_selection: bool = True
    ):
        prev = self._current_node_id_from_list() if preserve_selection else None
        self._node_list.blockSignals(True)
        try:
            self._node_list.clear()
            q = (self._node_list_filter.text() or "").strip().lower()
            for nid in self._node_ids_sorted():
                n = (self._data.get("nodes") or {}).get(nid, {})
                # 畸形节点值（agent 误写成字符串/列表等）：不当场崩，列出为畸形项，
                # 由校验面板给出「节点 X 不是对象」错误（审查 P2-③，offscreen 实证 str.get 崩溃）。
                if not isinstance(n, dict):
                    label = f"{nid}  (畸形节点：非对象)"
                    it = QListWidgetItem(label)
                    it.setForeground(QColor("#e05050"))
                    it.setData(Qt.ItemDataRole.UserRole, nid)
                    if not (q and q not in nid.lower() and q not in label.lower()):
                        self._node_list.addItem(it)
                    continue
                t = n.get("type", "?")
                summ = node_summary(nid, n)
                label = f"{nid}  ({t})  {summ}" if summ else f"{nid}  ({t})"
                if q and q not in nid.lower() and q not in label.lower():
                    continue
                it = QListWidgetItem(label)
                it.setData(Qt.ItemDataRole.UserRole, nid)
                self._node_list.addItem(it)
            if self._node_list.count() == 0:
                self._editing_node_id = None
                self._inspector.set_node("", {"type": "end"}, editor_groups=None, editor_group_for_node=None)
                return
            if select_first:
                ent = str(self._data.get("entry", "") or "").strip()
                nodes = self._data.get("nodes") or {}
                pick = ent if ent in nodes else None
                if pick and self._select_node_row_by_id(pick):
                    pass
                else:
                    self._node_list.setCurrentRow(0)
            elif prev and self._select_node_row_by_id(prev):
                pass
            else:
                self._node_list.setCurrentRow(0)
        finally:
            self._node_list.blockSignals(False)
        self._apply_selected_node_to_inspector()

    def _current_node_id_from_list(self) -> str | None:
        it = self._node_list.currentItem()
        if it is None:
            return None
        v = it.data(Qt.ItemDataRole.UserRole)
        if v is None:
            return None
        return str(v)

    def _active_editing_nid(self) -> str | None:
        """Single source of truth for which node is being edited -- prefers inspector."""
        insp = self._inspector.current_node_id().strip()
        if insp and insp in self._model.nodes:
            return insp
        lst = self._current_node_id_from_list()
        if lst and lst in self._model.nodes:
            return lst
        if self._editing_node_id and self._editing_node_id in self._model.nodes:
            return self._editing_node_id
        return None

    def _on_open_linked_scenario_clicked(self) -> None:
        sid = self._meta_scenario_value().strip()
        if not sid:
            QMessageBox.information(self, "叙事归属", "请先在「叙事归属」下拉中选择 scenario。")
            return
        w = self.window()
        fn = getattr(w, "navigate_to_scenario_catalog", None)
        if callable(fn):
            fn(sid)
        else:
            QMessageBox.information(
                self,
                "叙事编排",
                "请从主编辑器打开：数据编辑 → 叙事编排 → Scenarios。",
            )

    def _on_file_tree_item_changed(
        self, cur: QTreeWidgetItem | None, prev: QTreeWidgetItem | None
    ):
        if cur is None:
            return
        if cur.data(0, _TREE_KIND_ROLE) == _TK_GROUP:
            return
        raw = cur.data(0, Qt.ItemDataRole.UserRole)
        if raw == self._unsaved_list_token:
            return
        path = Path(raw)
        if self._current_path and path.resolve() == self._current_path.resolve():
            return
        if self._model.is_dirty:
            r = QMessageBox.question(
                self,
                "未保存",
                "当前文件已修改，是否保存？",
                QMessageBox.StandardButton.Save
                | QMessageBox.StandardButton.Discard
                | QMessageBox.StandardButton.Cancel,
            )
            if r == QMessageBox.StandardButton.Save:
                if not self.save():
                    self._revert_file_selection(prev)
                    return
            elif r == QMessageBox.StandardButton.Cancel:
                self._revert_file_selection(prev)
                return

        self._load_path(path)

    def _revert_file_selection(self, prev: QTreeWidgetItem | None):
        self._file_tree.blockSignals(True)
        try:
            if prev:
                self._file_tree.setCurrentItem(prev)
            elif self._current_path:
                for it in self._walk_file_tree_items():
                    if it.data(0, _TREE_KIND_ROLE) != _TK_FILE:
                        continue
                    raw = it.data(0, Qt.ItemDataRole.UserRole)
                    if raw == self._unsaved_list_token:
                        continue
                    try:
                        if Path(str(raw)).resolve() == self._current_path.resolve():
                            self._file_tree.setCurrentItem(it)
                            break
                    except OSError:
                        pass
            elif self._current_path is None:
                for it in self._walk_file_tree_items():
                    if it.data(0, Qt.ItemDataRole.UserRole) == self._unsaved_list_token:
                        self._file_tree.setCurrentItem(it)
                        break
        finally:
            self._file_tree.blockSignals(False)

    def _on_node_item_changed(self, _cur=None, _prev=None):
        self._apply_selected_node_to_inspector()
        nid = self._current_node_id_from_list()
        self._oden.select_dialogue_node(nid)

    def _apply_selected_node_to_inspector(self):
        nid = self._current_node_id_from_list()
        if not nid:
            self._editing_node_id = None
            return
        if nid != self._editing_node_id and self._editing_node_id:
            try:
                if self._editing_node_id in self._model.nodes and self._inspector.is_form_valid():
                    self._model.set_node(self._editing_node_id, self._inspector.get_node())
            except ValueError as e:
                QMessageBox.warning(self, "无法切换节点", str(e))
                self._node_list.blockSignals(True)
                try:
                    if self._editing_node_id:
                        self._ensure_node_visible_in_list(self._editing_node_id)
                finally:
                    self._node_list.blockSignals(False)
                return
        self._editing_node_id = nid
        nodes = self._data.get("nodes") or {}
        raw = copy.deepcopy(nodes.get(nid, {"type": "end"}))
        # 畸形节点值（非 dict）由检查器 set_node 内部守卫降级为只读透传（审查 P2-③），此处直接透传。
        self._inspector.set_node(
            nid,
            raw,
            editor_groups=self._editor_groups,
            editor_group_for_node=self._node_to_group.get(nid, ""),
        )

    def _on_inspector_changed(self):
        if "nodes" not in self._data:
            return
        nid = self._active_editing_nid()
        if not nid:
            return
        try:
            new_node = self._inspector.get_node()
        except ValueError as e:
            self._toast(str(e), 5000)
            return
        old_node = copy.deepcopy(self._model.nodes.get(nid, {}))
        self._model.set_node(nid, new_node)
        cmd = _NodeDataChangedCmd(self._model, nid, old_node, copy.deepcopy(new_node))
        self._suppress_inspector_resync_from_undo = True
        try:
            self._undo_stack.push(cmd)
        finally:
            self._suppress_inspector_resync_from_undo = False
        self._emit_title()
        self._refresh_node_list_row(nid)
        # 高频编辑（改正文/选项文字/动作参数等"纯视觉"）→ 原地更新该节点视觉，不删-建整图、
        # 不丢连线、无闪烁。一旦改动涉及【连线目标】(next/case.next/option.next/defaultNext…)
        # 或【端口签名】(增删分支/改类型) → 立即整图重建：重建会正确重画边，并刷新跨节点的
        # 可达性诊断着色（reachability 只随拓扑变化，纯视觉编辑不影响，故无残留色）。
        topo_changed = self._node_output_targets(old_node) != self._node_output_targets(new_node)
        if topo_changed or not self._update_canvas_node_in_place(nid):
            self._inspector_scene_timer.start(0)
        self._schedule_validation_refresh()

    @staticmethod
    def _node_output_targets(node: dict[str, Any]) -> list[tuple[str, int, str]]:
        """节点各输出槽的 (kind, index, target)，用于判断编辑是否改变了连线拓扑。"""
        if not isinstance(node, dict):
            return []
        return [(s.kind, s.index, s.target) for s in iter_output_slots(node)]

    def _update_canvas_node_in_place(self, nid: str) -> bool:
        """把单个节点的纯视觉变化原地刷到画布。返回 False 表示需整图重建。"""
        if not self._layout_path_for_io():
            return True  # 未关联文件/无画布：无需更新
        raw = (self._model.nodes or {}).get(nid)
        if raw is None:
            return False
        entry = str(self._data.get("entry", "") or "")
        tags = analyze_node_tags(self._data)
        return self._oden.update_node_visual(
            nid,
            raw,
            is_entry=(nid == entry),
            diag_tag=tags.get(nid),
            group_rgba=self._node_group_color_map().get(nid),
        )

    def _refresh_node_list_row(self, nid: str):
        for i in range(self._node_list.count()):
            it = self._node_list.item(i)
            if it and str(it.data(Qt.ItemDataRole.UserRole) or "") == nid:
                n = (self._data.get("nodes") or {}).get(nid, {})
                t = n.get("type", "?")
                summ = node_summary(nid, n)
                it.setText(f"{nid}  ({t})  {summ}" if summ else f"{nid}  ({t})")
                break

    def _on_pick_entry_clicked(self):
        ids = self._node_ids_sorted()
        if not ids:
            return
        dlg = NodePickerDialog(
            ids,
            type_by_id=self._node_types_for_picker(),
            title="选择入口节点 entry",
            initial=self._edit_entry.text().strip(),
            parent=self,
        )
        if dlg.exec() == QDialog.DialogCode.Accepted:
            self._edit_entry.setText(dlg.selected_id())
            self._on_graph_meta_changed()

    def _add_node(self):
        nodes = self._model.nodes
        dlg = QDialog(self)
        dlg.setWindowTitle("添加节点")
        dlg.setMinimumWidth(340)
        lay = QVBoxLayout(dlg)
        fl = QFormLayout()
        id_edit = QLineEdit(suggest_next_id(nodes))
        type_cb = QComboBox()
        for t, label in (
            ("line", "line"),
            ("runActions", "runActions"),
            ("choice", "choice"),
            ("switch", "switch"),
            ("ownerState", "ownerState（所属实体状态）"),
            ("contextState", "contextState（上下文状态）"),
            ("end", "end"),
        ):
            type_cb.addItem(label, t)
        fl.addRow("节点 id", id_edit)
        fl.addRow("类型", type_cb)
        lay.addLayout(fl)
        btns = QHBoxLayout()
        btn_ok = QPushButton("确定")
        btn_cancel = QPushButton("取消")
        btn_ok.clicked.connect(dlg.accept)
        btn_cancel.clicked.connect(dlg.reject)
        btns.addStretch()
        btns.addWidget(btn_ok)
        btns.addWidget(btn_cancel)
        lay.addLayout(btns)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        nid = id_edit.text().strip()
        if not nid:
            return
        if nid in nodes:
            QMessageBox.warning(self, "重复", f"已存在节点 {nid!r}")
            return
        t = type_cb.currentData()
        if not isinstance(t, str) or not t:
            t = type_cb.currentText()
        if t == "ownerState" and not self._guard_owner_state_node_creation():
            return
        snap = self._begin_structure_snapshot()
        self._model.add_node(nid, default_node(t, {k: v for k, v in nodes.items() if k != nid}))
        self._emit_title()
        self._populate_node_list()
        self._node_list.blockSignals(True)
        try:
            self._ensure_node_visible_in_list(nid)
        finally:
            self._node_list.blockSignals(False)
        self._apply_selected_node_to_inspector()
        self._rebuild_flow_scene()
        self._schedule_validation_refresh()
        self._push_structure_undo(f"新增节点 {nid}", snap)

    def _resolve_delete_targets(self, explicit_id: str | None) -> list[str]:
        """显式 id（右键菜单等）优先，否则用画布多选，再退回节点列表当前行。"""
        if explicit_id and explicit_id.strip():
            return [explicit_id.strip()]
        sel = self._oden.selected_flow_node_ids()
        if sel:
            return sel
        cur = self._current_node_id_from_list()
        if cur:
            return [cur]
        one = self._oden.primary_selected_flow_node_id()
        return [one] if one else []

    def _delete_nodes(self, targets: list[str]) -> None:
        node_dict = self._model.nodes
        if not node_dict:
            return
        to_del = sorted({n for n in targets if n in node_dict})
        if not to_del:
            return
        to_del_set = set(to_del)
        ext_refs = 0
        for nid in to_del:
            for src, *_r in collect_incoming_refs(self._data, nid):
                if src not in to_del_set:
                    ext_refs += 1
        preview = "、".join(to_del[:12])
        if len(to_del) > 12:
            preview += f" 等共 {len(to_del)} 个"
        if ext_refs:
            msg = (
                f"删除节点 {preview}？\n\n"
                f"仍有 {ext_refs} 条来自其它节点的连线指向待删除节点。\n"
                "「断开并删除」将先清除入边再删除；「直接删除」可能留下悬空 next。"
            )
            box = QMessageBox(QMessageBox.Icon.Question, "删除节点", msg, parent=self)
            btn_cut = box.addButton("断开并删除", QMessageBox.ButtonRole.AcceptRole)
            btn_force = box.addButton("直接删除", QMessageBox.ButtonRole.DestructiveRole)
            box.addButton("取消", QMessageBox.ButtonRole.RejectRole)
            box.exec()
            clicked = box.clickedButton()
            if clicked == btn_cut:
                snap = self._begin_structure_snapshot()
                for nid in to_del:
                    self._model.clear_incoming_to(nid)
            elif clicked != btn_force:
                return
            else:
                snap = self._begin_structure_snapshot()
        else:
            confirm = QMessageBox.question(
                self,
                "删除",
                f"删除节点 {preview}？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )
            if confirm != QMessageBox.StandardButton.Yes:
                return
            snap = self._begin_structure_snapshot()
        self._model.remove_nodes(to_del)
        for nid in to_del:
            self._node_to_group.pop(nid, None)
        if self._editing_node_id in to_del_set:
            self._editing_node_id = None
        entry = str(self._data.get("entry", "") or "")
        if entry in to_del_set:
            self._edit_entry.setText("")
        self._mark_dirty()
        self._populate_node_list(select_first=True)
        self._canonicalize_editor_layout_to_graph_nodes()
        self._rebuild_flow_scene()
        if self._layout_path_for_io():
            self._flush_flow_layout_to_disk()
        self._schedule_validation_refresh()
        label = f"删除节点 {to_del[0]}" if len(to_del) == 1 else f"删除 {len(to_del)} 个节点"
        self._push_structure_undo(label, snap)

    def _remove_ghost_missing_targets(self, mids: list[str]) -> None:
        """幽灵节点对应 JSON 外 id：清空所有指向这些 id 的连线并移除布局里 ghost 坐标。"""
        u = sorted({str(m).strip() for m in mids if str(m).strip()})
        if not u:
            return
        total_refs = sum(len(collect_incoming_refs(self._data, mid)) for mid in u)
        if total_refs == 0:
            for mid in u:
                self._ghost_positions.pop(mid, None)
            self._rebuild_flow_scene()
            if self._layout_path_for_io():
                self._flush_flow_layout_to_disk()
            self._toast("已移除幽灵布局坐标（无连线指向这些缺失 id）", 2500)
            self._schedule_validation_refresh()
            return
        preview = "、".join(u[:16])
        if len(u) > 16:
            preview += f" 等共 {len(u)} 个"
        r = QMessageBox.question(
            self,
            "清除缺失目标连线",
            f"将清空所有指向以下缺失 id 的 next 类连线（共 {total_refs} 条）：\n{preview}",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if r != QMessageBox.StandardButton.Yes:
            return
        snap = self._begin_structure_snapshot()
        for mid in u:
            self._model.clear_incoming_to(mid)
            self._ghost_positions.pop(mid, None)
        self._mark_dirty()
        self._rebuild_flow_scene()
        if self._layout_path_for_io():
            self._flush_flow_layout_to_disk()
        self._schedule_validation_refresh()
        self._push_structure_undo("清除指向缺失节点的连线", snap)

    def _delete_node(self, nid: str | None = None):
        # 工具栏 clicked 可能传入 bool；仅非空 str 才视为显式节点 id。
        explicit = nid.strip() if isinstance(nid, str) and nid.strip() else None
        targets = self._resolve_delete_targets(explicit)
        if targets:
            self._delete_nodes(targets)
            return
        mids = self._oden.selected_ghost_missing_ids()
        if mids:
            self._remove_ghost_missing_targets(mids)

    def _duplicate_node(self, source_nid: str | None = None):
        # 工具栏 clicked 可能传入 bool；仅当 source_nid 为非空 str 时才视为画布/显式指定。
        if isinstance(source_nid, str) and source_nid.strip():
            nid = source_nid.strip()
        else:
            nid = self._current_node_id_from_list()
        if not nid:
            return
        nodes = self._model.nodes
        new_id, ok = QInputDialog.getText(
            self, "复制为", "新 id", text=suggest_next_id(nodes)
        )
        if not ok or not new_id.strip():
            return
        new_id = new_id.strip()
        if new_id in nodes:
            QMessageBox.warning(self, "重复", f"已存在 {new_id!r}")
            return
        snap = self._begin_structure_snapshot()
        self._model.add_node(new_id, copy.deepcopy(nodes[nid]))
        ox, oy = self._positions.get(nid, (0.0, 0.0))
        self._positions[new_id] = (float(ox) + 40.0, float(oy) + 40.0)
        self._emit_title()
        self._populate_node_list()
        self._node_list.blockSignals(True)
        try:
            self._ensure_node_visible_in_list(new_id)
        finally:
            self._node_list.blockSignals(False)
        self._apply_selected_node_to_inspector()
        self._rebuild_flow_scene()
        self._schedule_validation_refresh()
        self._push_structure_undo(f"复制节点 {nid} → {new_id}", snap)

    def _restore_splitter_sizes(self) -> None:
        s = QSettings("GameDraft", "DialogueGraphEditor")
        raw = s.value("main_splitter_sizes")
        if isinstance(raw, list) and len(raw) == 3:
            try:
                self._main_splitter.setSizes([int(x) for x in raw])
                return
            except (TypeError, ValueError):
                pass
        self._main_splitter.setSizes([200, 820, 280])

    def _save_splitter_sizes(self) -> None:
        s = QSettings("GameDraft", "DialogueGraphEditor")
        s.setValue("main_splitter_sizes", self._main_splitter.sizes())

    def hideEvent(self, event) -> None:
        self._save_splitter_sizes()
        self._save_validation_dock_state()
        super().hideEvent(event)

    def _can_write_loaded_bytes_verbatim(self, path: Path) -> bool:
        """保存到原文件、且当前内容相对磁盘语义零变化时，可原样回写原始字节（格式零变化）。"""
        disk_bytes = getattr(self, "_loaded_disk_bytes", None)
        disk_data = getattr(self, "_loaded_disk_data", None)
        if disk_bytes is None or disk_data is None or self._current_path is None:
            return False
        try:
            if path.resolve() != self._current_path.resolve():
                return False  # 另存为 / 改名：用序列化器正常写出
        except OSError:
            return False
        return self._model.to_dict() == disk_data

    def _confirm_overwrite_external_changes(self, path: Path) -> bool:
        """保存前的外部并发写检查：磁盘字节 ≠ 载入基线 → 明确询问是否覆盖。

        内嵌与独立图对话编辑器可同开同一文件，双方各自保存时后写者会静默覆盖
        前者；用载入时记录的 `_loaded_disk_bytes` 基线比对拦下这种覆盖。
        """
        disk_bytes = getattr(self, "_loaded_disk_bytes", None)
        if disk_bytes is None or self._current_path is None:
            return True  # 新草稿 / 无基线：不做冲突判断
        try:
            if path.resolve() != self._current_path.resolve():
                return True  # 另存为：写新文件，无覆盖风险
            now = path.read_bytes()
        except OSError:
            return True  # 文件被外部删除等：照常写出（等价于重建）
        if now == disk_bytes:
            return True
        r = QMessageBox.question(
            self,
            "磁盘文件已被外部修改",
            f"{path.name} 自载入后被其它程序（另一个图对话编辑器 / 外部工具）修改过。\n\n"
            "继续保存会用当前编辑器内容覆盖那些外部修改。仍要覆盖吗？\n"
            "选「No」取消本次保存，可先到外部确认后再存。",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        return r == QMessageBox.StandardButton.Yes

    def _write_to_path(self, path: Path) -> bool:
        self._last_save_failure = ""
        old_draft = self._draft_layout_basename
        draft_lp = (self._graphs_dir / old_draft) if old_draft else None
        try:
            self._widgets_to_data_meta(relink_catalog=True)
            self._flush_current_inspector_to_data()
        except json.JSONDecodeError as e:
            self._last_save_failure = f"preconditions 条件解析失败：{e}"
            QMessageBox.critical(
                self, "保存失败", f"preconditions 条件解析失败：{e}"
            )
            return False
        except ValueError as e:
            self._last_save_failure = str(e)
            QMessageBox.critical(self, "保存失败", str(e))
            return False

        errors, warnings = self._validate_current_graph()
        if errors:
            etxt = "\n".join(errors[:50])
            if len(errors) > 50:
                etxt += f"\n... 共 {len(errors)} 条错误"
            r = QMessageBox.question(
                self,
                "校验错误",
                etxt + "\n\n图数据存在错误。仍要强制保存吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No,
            )
            if r != QMessageBox.StandardButton.Yes:
                self._last_save_failure = f"图有 {len(errors)} 处校验错误，未确认强制保存"
                return False
        if warnings:
            wtxt = "\n".join(warnings[:40])
            if len(warnings) > 40:
                wtxt += f"\n… 共 {len(warnings)} 条警告"
            r = QMessageBox.question(
                self,
                "校验警告",
                wtxt + "\n\n仍要保存吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if r != QMessageBox.StandardButton.Yes:
                self._last_save_failure = f"图有 {len(warnings)} 处校验警告，未确认保存"
                return False

        # 外部并发写检查：磁盘自载入后被别处（内嵌/独立图编辑器、外部工具）改过时，
        # 直接写盘就是 last-writer-wins 静默覆盖，必须让用户明确选择。
        if not self._confirm_overwrite_external_changes(path):
            self._last_save_failure = "磁盘文件已被外部修改，未确认覆盖"
            return False

        id_before_disk = str(self._data.get("id", "")).strip()
        final_gid = path.stem
        self._model.apply_meta_patch({"id": final_gid})
        try:
            if self._can_write_loaded_bytes_verbatim(path):
                # 内容相对磁盘零实质变化：原样写回原始字节，保证导出格式与磁盘完全一致。
                write_bytes_atomic(path, self._loaded_disk_bytes)
            else:
                save_json(path, self._model.to_dict())
                # 刷新"磁盘基线"为刚写出的内容，使后续无改动再保存也走原样回写、字节稳定。
                try:
                    self._loaded_disk_bytes = path.read_bytes()
                    self._loaded_disk_data = self._model.to_dict()
                except OSError:
                    pass
        except OSError as e:
            self._model.apply_meta_patch({"id": id_before_disk})
            self._last_save_failure = f"写入磁盘失败：{e}"
            QMessageBox.critical(self, "保存失败", str(e))
            return False
        if draft_lp is not None and old_draft:
            migrate_layout_map_key(self._project, draft_lp, path)
        self._current_path = path
        self._draft_layout_basename = None
        self._new_draft_pristine = None  # 已落盘：不再是全新草稿
        pm_sv = self._injected_project_model
        if pm_sv is not None:
            if id_before_disk and id_before_disk != final_gid:
                pm_sv.rename_dialogue_graph_in_scenarios_catalog(id_before_disk, final_gid)
            meta_sv = self._data.get("meta") if isinstance(self._data.get("meta"), dict) else {}
            sc_sv = str(meta_sv.get("scenarioId", "")).strip()
            pm_sv.relink_dialogue_graph_to_scenarios(final_gid, sc_sv or None)
        self._apply_data_to_widgets()
        self._flush_flow_layout_to_disk()
        self._set_dirty(False)
        self._emit_title()
        self._toast("已保存", 3000)
        self._refresh_file_list()
        self._sync_file_list_selection(path)
        return True
