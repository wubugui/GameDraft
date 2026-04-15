"""图对话编辑器面板：可嵌入主编辑器，也可由独立 MainWindow 承载。"""
from __future__ import annotations

import json
import copy
import re
import uuid
from pathlib import Path
from typing import Any

from PySide6.QtWidgets import (
    QWidget, QSplitter, QListWidget, QListWidgetItem, QVBoxLayout,
    QHBoxLayout, QPushButton, QMessageBox, QFileDialog, QLabel, QLineEdit,
    QPlainTextEdit, QFormLayout, QScrollArea, QGroupBox, QInputDialog,
    QMenu, QCompleter, QDialog, QSizePolicy, QComboBox,
)
from PySide6.QtCore import Qt, Signal, QTimer, QStringListModel
from PySide6.QtGui import QUndoStack, QAction, QCursor, QKeySequence, QShortcut

from .graph_document import (
    graphs_dir,
    list_graph_files,
    load_json,
    save_json,
    validate_graph,
    validate_graph_tiered,
    node_search_haystack,
    default_node,
    suggest_next_id,
    auto_layout_node_positions,
    extract_flow_edges_detailed,
)
from .graph_mutations import (
    rename_node_id,
    collect_incoming_refs,
    clear_incoming_to_node,
)
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
)
from .flow_oden_controller import DialogueFlowOdenController
from .node_inspector import NodeInspector
from .node_picker_dialog import NodePickerDialog
from tools.editor.shared.condition_editor import ConditionEditor


def _graph_form_label(text: str, tip: str | None = None, *, max_w: int = 100) -> QLabel:
    """图属性等表单左侧标签：限制宽度并换行，避免整列被最长一行撑得过宽。"""
    lb = QLabel(text)
    lb.setWordWrap(True)
    lb.setMaximumWidth(max_w)
    lb.setAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
    if tip:
        lb.setToolTip(tip)
    return lb

_GRAPH_PRE_FLAG_KEYS = frozenset({"flag", "op", "value"})


def _split_graph_preconditions(pre: object) -> tuple[list[dict[str, Any]], list[Any]]:
    if pre is None:
        return [], []
    if not isinstance(pre, list):
        # 非数组的 preconditions 整段放入附加 JSON，避免加载后静默丢失
        return [], [pre]
    flags: list[dict[str, Any]] = []
    extra: list[Any] = []
    for c in pre:
        if (
            isinstance(c, dict)
            and "flag" in c
            and set(c.keys()) <= _GRAPH_PRE_FLAG_KEYS
        ):
            flags.append(dict(c))
        else:
            extra.append(c)
    return flags, extra


class DialogueGraphEditorWidget(QWidget):
    """编辑 public/assets/dialogues/graphs/*.json。

    「未保存 /脏」针对所有会使该 JSON 落盘内容变化的操作：图属性（id、entry、meta、preconditions）、
    节点增删改与右侧检查器、画布连线拓扑等。
    纯画布坐标只写入 editor_data/dialogue_flow_layout.json，不改变 graphs/*.json，不标脏。
    """

    title_changed = Signal(str)
    dirty_changed = Signal(bool)

    def __init__(self, project_path: str | Path, parent: QWidget | None = None):
        super().__init__(parent)
        self._project = Path(project_path).resolve()
        self._graphs_dir = graphs_dir(self._project)
        self._current_path: Path | None = None
        self._data: dict = {}
        self._dirty = False
        self._editing_node_id: str | None = None
        self._positions: dict[str, tuple[float, float]] = {}
        self._layout_save_timer = QTimer(self)
        self._layout_save_timer.setSingleShot(True)
        self._layout_save_timer.timeout.connect(self._flush_flow_layout_to_disk)
        self._inspector_scene_timer = QTimer(self)
        self._inspector_scene_timer.setSingleShot(True)
        self._inspector_scene_timer.timeout.connect(self._rebuild_flow_scene)
        self._ghost_positions: dict[str, tuple[float, float]] = {}
        self._editor_groups: dict[str, dict[str, Any]] = {}
        self._node_to_group: dict[str, str] = {}
        self._editor_group_frames: dict[str, dict[str, Any]] = {}
        self._draft_layout_basename: str | None = None
        self._unsaved_list_token = "__unsaved__"
        self._inspector_project_model = None
        self._inspector_project_model_failed = False
        self._undo_stack = QUndoStack(self)
        self._undo_stack.indexChanged.connect(self._on_undo_index_changed)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(4, 4, 4, 4)
        outer.setSpacing(4)

        tb = QHBoxLayout()
        for text, slot in (
            ("打开…", self.open_file_dialog),
            ("保存", self.save),
            ("另存为…", self.save_as),
            ("重命名图…", self._rename_graph_file_dialog),
            ("校验当前图", self.run_validate),
            ("自动布局", self._flow_auto_layout),
            ("适应画布", self._flow_fit_view),
            ("重命名节点…", self._rename_node_dialog),
            ("复制子树", self._copy_subtree),
        ):
            b = QPushButton(text)
            b.clicked.connect(slot)
            tb.addWidget(b)
        self._btn_undo = QPushButton("撤销")
        self._btn_undo.clicked.connect(self._undo_stack.undo)
        tb.addWidget(self._btn_undo)
        self._btn_redo = QPushButton("重做")
        self._btn_redo.clicked.connect(self._undo_stack.redo)
        tb.addWidget(self._btn_redo)
        self._search_edit = QLineEdit()
        self._search_edit.setPlaceholderText("搜索节点 id 或内容… Enter 定位")
        self._search_edit.returnPressed.connect(self._on_search_node)
        self._search_model = QStringListModel(self)
        self._search_completer = QCompleter(self._search_model, self)
        self._search_completer.setCaseSensitivity(Qt.CaseSensitivity.CaseInsensitive)
        self._search_completer.setFilterMode(Qt.MatchFlag.MatchContains)
        self._search_completer.setCompletionMode(QCompleter.CompletionMode.PopupCompletion)
        self._search_edit.setCompleter(self._search_completer)
        self._search_edit.textChanged.connect(self._update_search_completions)
        tb.addWidget(self._search_edit, 1)
        outer.addLayout(tb)

        splitter = QSplitter(Qt.Orientation.Horizontal)

        file_box = QWidget()
        fv = QVBoxLayout(file_box)
        fv.addWidget(QLabel("graphs/*.json"))
        self._file_list_entries: list[tuple[str, Any]] = []
        self._file_list_filter = QLineEdit()
        self._file_list_filter.setPlaceholderText("筛选文件名…")
        self._file_list_filter.textChanged.connect(self._on_file_list_filter_changed)
        fv.addWidget(self._file_list_filter)
        self._file_list = QListWidget()
        self._file_list.currentItemChanged.connect(self._on_file_item_changed)
        fv.addWidget(self._file_list, 1)
        b_refresh = QPushButton("刷新列表")
        b_refresh.clicked.connect(self._refresh_file_list)
        fv.addWidget(b_refresh)
        b_new_file = QPushButton("新建图")
        b_new_file.clicked.connect(self.create_new_graph_draft)
        fv.addWidget(b_new_file)
        b_del_file = QPushButton("删除图…")
        b_del_file.clicked.connect(self.delete_selected_graph_file)
        fv.addWidget(b_del_file)
        splitter.addWidget(file_box)

        self._oden = DialogueFlowOdenController(self._undo_stack, self, toast=self._toast)
        self._oden.set_data_binding(
            lambda: self._data,
            lambda: self._positions,
            lambda: self._ghost_positions,
            self._on_flow_layout_debounced,
        )
        self._oden.canvas_node_selected.connect(self._on_flow_node_clicked)
        self._oden.data_topology_changed.connect(self._on_oden_topology_changed)
        self._oden.auto_layout_requested.connect(self._flow_auto_layout)
        self._oden.canvas_context_menu.connect(self._on_flow_canvas_context_menu)
        self._oden.editor_frame_rename_requested.connect(self._on_editor_frame_rename)
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

        flow_hint = QLabel(
            "流程图（OdenGraphQt）：输出端口拖线到目标节点的「in」· 滚轮缩放 · 中键/右键平移 · "
            "F 适应 · A /「自动布局」优先用库内 auto_layout_nodes，失败时回退 BFS（节点不会落入已有分组框内）· "
            "空白处右键可「新建分组框」；节点中心在框内即归入该组 · "
            "布局写入 editor_data/dialogue_flow_layout.json · "
            "依赖 pip install -r tools/dialogue_graph_editor/requirements.txt"
        )
        flow_hint.setWordWrap(True)
        flow_hint.setStyleSheet("color: #888; font-size: 11px;")
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

        self._graph_group = QGroupBox("图属性")
        gform = QFormLayout()
        gform.setLabelAlignment(Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop)
        gform.setHorizontalSpacing(8)
        gform.setVerticalSpacing(6)
        self._edit_graph_id = QLineEdit()
        self._edit_entry = QLineEdit()
        self._btn_pick_entry = QPushButton("选")
        self._btn_pick_entry.clicked.connect(self._on_pick_entry_clicked)
        self._edit_title = QLineEdit()
        self._pre_cond_ed = ConditionEditor(
            "preconditions（flag 条件）",
            parent=self,
            hint="仅含 flag / op / value 的条目用下表编辑；其余形状保留在「附加 JSON」并与上表合并保存。",
        )
        self._pre_cond_ed.setMinimumHeight(160)
        self._pre_cond_ed.changed.connect(self._on_graph_meta_changed)
        self._edit_pre_extra = QPlainTextEdit()
        self._edit_pre_extra.setPlaceholderText(
            '附加条件 JSON 数组，例如含 quest 的项；可为空。例：[{"quest":"q1","questStatus":"Active"}]'
        )
        self._edit_pre_extra.setMaximumHeight(120)
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
        self._edit_meta_scenario.setToolTip(
            "可选。下拉选自 scenarios.json 的 scenario id；与清单一致时可通过校验。\n"
            "留空表示不写 meta.scenarioId。仅作图级归属标注与检索，与节点内 setScenarioPhase 无自动关联。",
        )
        _scen_le = self._edit_meta_scenario.lineEdit()
        if _scen_le is not None:
            _scen_le.setPlaceholderText("可选，留空不写 meta.scenarioId")
        gform.addRow(
            _graph_form_label(
                "叙事归属",
                tip="对应 JSON：meta.scenarioId（可选）。标明本图归属哪条叙事 scenario，便于检索与校验；"
                "不改变玩法逻辑；节点里推进阶段仍用动作的 setScenarioPhase。",
            ),
            self._edit_meta_scenario,
        )
        gform.addRow(QLabel(), self._pre_cond_ed)
        gform.addRow(
            _graph_form_label(
                "附加 JSON",
                tip="preconditions 中无法用 flag 表表达的项（如 quest），JSON 数组；与上表合并保存",
            ),
            self._edit_pre_extra,
        )
        self._graph_group.setLayout(gform)
        rv.addWidget(self._graph_group)

        for w in (
            self._edit_graph_id,
            self._edit_entry,
            self._edit_title,
        ):
            if isinstance(w, QPlainTextEdit):
                w.textChanged.connect(self._on_graph_meta_changed)
            else:
                w.textChanged.connect(self._on_graph_meta_changed)
        self._edit_meta_scenario.currentTextChanged.connect(self._on_graph_meta_changed)
        self._edit_pre_extra.textChanged.connect(self._on_graph_meta_changed)

        self._inspector = NodeInspector(
            self._node_ids_sorted,
            project_root=self._project,
            project_model_getter=self._get_project_model_for_inspector,
            node_types_getter=self._node_types_for_picker,
        )
        self._inspector.set_change_callback(self._on_inspector_changed)
        self._inspector.set_editor_group_callbacks(
            self._assign_node_editor_group,
            self._create_editor_group_dialog,
        )
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
        splitter.setSizes([200, 820, 280])

        outer.addWidget(splitter, 1)

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

    def _assign_node_editor_group(self, nid: str, group_id: str) -> None:
        _ = (nid, group_id)
        self._toast("分组由画布上的分组框决定：把节点拖入框内即可，勿在此下拉修改。", 4000)

    def _new_editor_group_id_and_register(self, display_name: str) -> str:
        """登记新编辑器分组，返回内部分组 id（不写盘，由调用方 flush）。"""
        base = f"g_{len(self._editor_groups) + 1}"
        gid = base
        n = 0
        while gid in self._editor_groups:
            n += 1
            gid = f"{base}_{n}"
        self._editor_groups[gid] = {"name": display_name.strip(), "color": "#4a6fa8"}
        return gid

    def _create_editor_group_dialog(self) -> str | None:
        self._toast("请用画布右键「新建分组框」创建分组。", 3500)
        return None

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
            act_rm = QAction("删除此分组框…", self)
            act_rm.triggered.connect(lambda checked=False, g=fgid: self._delete_editor_group_frame(g))
            menu.addAction(act_rm)
            menu.addSeparator()
        if nid and nid in self._data["nodes"]:
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
            for nt in ("line", "runActions", "choice", "switch", "end"):
                act = QAction(f"在此处添加 {nt}", self)
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

    def _canvas_context_delete_node(self, nid: str) -> None:
        if nid not in (self._data.get("nodes") or {}):
            return
        self._delete_node(nid)

    def _canvas_context_duplicate_node(self, nid: str) -> None:
        if nid not in (self._data.get("nodes") or {}):
            return
        self._duplicate_node(nid)

    def _spawn_node_at_canvas(self, node_type: str, scene_x: float, scene_y: float) -> None:
        nodes = self._data.setdefault("nodes", {})
        nid = suggest_next_id(nodes)
        nodes[nid] = default_node(node_type, {k: v for k, v in nodes.items() if k != nid})
        self._positions[nid] = (float(scene_x), float(scene_y))
        self._mark_dirty()
        self._ensure_node_visible_in_list(nid)
        self._rebuild_flow_scene()
        self._oden.select_dialogue_node(nid)
        self._layout_save_timer.start(450)

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
        if self._dirty:
            r = QMessageBox.question(
                self,
                "未保存",
                "放弃当前修改并新建？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            )
            if r != QMessageBox.StandardButton.Yes:
                return
        stem = "new_dialogue"
        self._data = {
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
        }
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
        self._refresh_file_list(select_unsaved=True)
        self._emit_title()

    def _reset_to_no_file_loaded(self) -> None:
        self._data = {}
        self._current_path = None
        self._draft_layout_basename = None
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

    def delete_selected_graph_file(self) -> None:
        it = self._file_list.currentItem()
        if it is None:
            self._toast("请先在左侧列表选中要删除的 graphs/*.json", 3000)
            return
        raw = it.data(Qt.ItemDataRole.UserRole)
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
            f"将从 editor_data/dialogue_flow_layout.json 中移除该图的布局数据。"
        )
        if was_open and self._dirty:
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
        return self._dirty

    def confirm_discard_or_save_before_close(self, parent: QWidget | None) -> bool:
        if not self._dirty:
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

    def load_path(self, path: Path) -> None:
        """打开指定 graphs/*.json（若当前有未保存修改会按切换文件的逻辑提示）。"""
        self._load_path(path)

    def open_file_dialog(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            "打开图对话",
            str(self._graphs_dir),
            "JSON (*.json)",
        )
        if path:
            self._load_path(Path(path))

    def save(self) -> bool:
        if self._current_path:
            return self._write_to_path(self._current_path)
        try:
            self._widgets_to_data_meta()
        except json.JSONDecodeError as e:
            QMessageBox.critical(
                self, "保存失败", f"附加 preconditions（JSON）解析失败：{e}"
            )
            return False
        except ValueError as e:
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
            self._widgets_to_data_meta()
            self._flush_current_inspector_to_data()
        except json.JSONDecodeError as e:
            QMessageBox.critical(
                self, "重命名图", f"附加 preconditions（JSON）解析失败：{e}"
            )
            return
        except ValueError as e:
            QMessageBox.critical(self, "重命名图", str(e))
            return
        errors, warnings = validate_graph_tiered(self._data)
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
        self._data["id"] = new_stem
        try:
            save_json(new_path, self._data)
        except OSError as e:
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
            QMessageBox.critical(self, "校验", f"附加 preconditions（JSON）：{e}")
            return
        except ValueError as e:
            QMessageBox.critical(self, "校验", str(e))
            return
        err, warn = validate_graph_tiered(self._data)
        if not err and not warn:
            QMessageBox.information(self, "校验", "未发现明显问题。")
            return
        parts: list[str] = []
        if err:
            parts.append("错误：\n" + "\n".join(err))
        if warn:
            parts.append("警告：\n" + "\n".join(warn))
        QMessageBox.warning(self, "校验", "\n\n".join(parts))

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
        self._status_label.setText(msg)
        if ms > 0:
            self._status_label.repaint()

    def _set_dirty(self, dirty: bool) -> None:
        if self._dirty == dirty:
            return
        self._dirty = dirty
        self.dirty_changed.emit(dirty)

    def _sync_ui_enabled(self, has_file: bool):
        self._graph_group.setEnabled(has_file)
        self._inspector.setEnabled(has_file)
        self._node_list.setEnabled(has_file)
        self._flow_view.setEnabled(has_file)
        for b in (self._btn_add, self._btn_del, self._btn_dup):
            b.setEnabled(has_file)
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
        """节点拖动结束：防抖写盘，并重建流程图（含编辑器分组背景框）。"""
        self._layout_save_timer.start(ms)
        self._inspector_scene_timer.start(ms)

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
        entry = str(self._data.get("entry", "") or "")
        avoid = avoid_rects_list(self._editor_group_frames)
        if self._oden.apply_oden_auto_layout():
            self._oden.sync_layout_dicts_from_graph()
            from .editor_group_geometry import nudge_node_positions_avoid_rects

            nudge_node_positions_avoid_rects(self._positions, nodes, avoid)
            self._rebuild_flow_scene()
        else:
            self._positions = auto_layout_node_positions(
                nodes, entry, avoid_rects=avoid
            )
            self._rebuild_flow_scene()
        self._flush_flow_layout_to_disk()
        self._oden.fit_all()
        # 仅更新画布坐标 + editor_data/dialogue_flow_layout.json，不改 graphs/*.json，勿标脏以免切文件误提示保存对话

    def _flow_fit_view(self) -> None:
        self._oden.fit_all()

    def _on_flow_node_clicked(self, nid: str) -> None:
        if not nid:
            return
        if nid not in (self._data.get("nodes") or {}):
            return
        self._node_list.blockSignals(True)
        self._ensure_node_visible_in_list(nid)
        self._node_list.blockSignals(False)
        self._apply_selected_node_to_inspector()

    def _on_oden_topology_changed(self) -> None:
        self._mark_dirty()
        self._sync_inspector_from_selection()

    def _sync_inspector_from_selection(self) -> None:
        nid = self._current_node_id_from_list() or self._editing_node_id
        if nid and nid in (self._data.get("nodes") or {}):
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
        if self._layout_path_for_io():
            # 移动节点会 push NodeMovedCmd 并触发本槽；若此处整图 rebuild，
            # 会用尚未写入的 _positions 覆盖刚拖好的坐标，表现为松手弹回原位。
            self._flush_flow_layout_to_disk()
            self._inspector_scene_timer.start(80)
        self._sync_inspector_from_selection()

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
            return
        hit = hits[0]
        self._node_list.blockSignals(True)
        self._ensure_node_visible_in_list(hit)
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
        err = rename_node_id(self._data, old, new_id)
        if err:
            QMessageBox.warning(self, "重命名", err)
            return
        if old in self._positions:
            self._positions[new_id] = self._positions.pop(old)
        if old in self._node_to_group:
            self._node_to_group[new_id] = self._node_to_group.pop(old)
        self._editing_node_id = new_id
        self._undo_stack.clear()
        self._mark_dirty()
        self._populate_node_list()
        self._node_list.blockSignals(True)
        self._ensure_node_visible_in_list(new_id)
        self._node_list.blockSignals(False)
        self._apply_selected_node_to_inspector()
        self._rebuild_flow_scene()
        if validate_graph(self._data):
            self._toast("重命名后存在校验问题，请运行「校验当前图」", 5000)

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
        elif t == "switch":
            for c in raw.get("cases") or []:
                if isinstance(c, dict):
                    nxt = str(c.get("next", "") or "")
                    if nxt in seen:
                        c["next"] = old_to_new[nxt]
            dn = str(raw.get("defaultNext", "") or "")
            if dn in seen:
                raw["defaultNext"] = old_to_new[dn]

    def _copy_subtree(self) -> None:
        root = self._current_node_id_from_list()
        nodes = self._data.get("nodes") or {}
        if not root or root not in nodes:
            return
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
            nodes[nid_new] = raw
            self._positions[nid_new] = (brx + 240.0 + (i % 5) * 40.0, bry + (i // 5) * 85.0)
        self._undo_stack.clear()
        self._mark_dirty()
        self._populate_node_list()
        self._rebuild_flow_scene()

    def _flow_layout_is_collapsed(self) -> bool:
        nodes = self._data.get("nodes") or {}
        if len(nodes) < 2:
            return False
        xs: list[float] = []
        ys: list[float] = []
        for nid in nodes:
            x, y = self._positions.get(nid, (0.0, 0.0))
            xs.append(x)
            ys.append(y)
        return (max(xs) - min(xs) < 2.0) and (max(ys) - min(ys) < 2.0)

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

    def _on_file_list_filter_changed(self, _text: str = "") -> None:
        self._apply_file_list_filter(preserve_selection=True)

    def _apply_file_list_filter(self, *, preserve_selection: bool = True) -> None:
        prev_role: Any = None
        if preserve_selection:
            cur = self._file_list.currentItem()
            if cur is not None:
                prev_role = cur.data(Qt.ItemDataRole.UserRole)
        q = (self._file_list_filter.text() or "").strip().lower()
        self._file_list.blockSignals(True)
        self._file_list.clear()
        for disp, role in self._file_list_entries:
            if q and q not in disp.lower():
                continue
            it = QListWidgetItem(disp)
            it.setData(Qt.ItemDataRole.UserRole, role)
            self._file_list.addItem(it)
        self._file_list.blockSignals(False)
        if preserve_selection and prev_role is not None:
            for i in range(self._file_list.count()):
                it = self._file_list.item(i)
                if it and it.data(Qt.ItemDataRole.UserRole) == prev_role:
                    self._file_list.setCurrentItem(it)
                    return

    def _refresh_file_list(self, *, select_unsaved: bool = False) -> None:
        self._file_list_entries.clear()
        if self._current_path is None and isinstance(self._data.get("nodes"), dict) and self._data["nodes"]:
            self._file_list_entries.append(
                (f"【未保存】{self._data.get('id', '新图')}", self._unsaved_list_token)
            )
        for p in list_graph_files(self._project):
            self._file_list_entries.append((p.name, str(p)))
        self._apply_file_list_filter(preserve_selection=not select_unsaved)
        if select_unsaved and self._current_path is None:
            for i in range(self._file_list.count()):
                it = self._file_list.item(i)
                if it and it.data(Qt.ItemDataRole.UserRole) == self._unsaved_list_token:
                    self._file_list.setCurrentItem(it)
                    break
        elif self._current_path:
            self._sync_file_list_selection(self._current_path)

    def _node_ids_sorted(self) -> list[str]:
        nodes = self._data.get("nodes") or {}
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
        if self._dirty:
            t += " *"
        self.title_changed.emit(t)

    def _mark_dirty(self):
        self._set_dirty(True)
        self._emit_title()

    def _load_path(self, path: Path):
        try:
            self._data = load_json(path)
        except (OSError, json.JSONDecodeError) as e:
            QMessageBox.critical(self, "打开失败", str(e))
            return
        self._current_path = path
        self._draft_layout_basename = None
        self._set_dirty(False)
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
        self._undo_stack.clear()
        self._populate_node_list(select_first=True)
        self._rebuild_flow_scene()
        if regen_layout or migrated_frames or layout_fixed:
            self._flush_flow_layout_to_disk()
        QTimer.singleShot(0, self._flow_fit_view)
        self._emit_title()
        self._refresh_file_list()
        self._sync_file_list_selection(path)

    def _sync_file_list_selection(self, path: Path) -> None:
        target = path.resolve()
        self._file_list.blockSignals(True)
        for i in range(self._file_list.count()):
            it = self._file_list.item(i)
            if it is None:
                continue
            raw = it.data(Qt.ItemDataRole.UserRole)
            if raw == self._unsaved_list_token:
                continue
            try:
                if Path(str(raw)).resolve() == target:
                    self._file_list.setCurrentItem(it)
                    break
            except OSError:
                pass
        self._file_list.blockSignals(False)

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
            self._edit_pre_extra,
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
            flag_part, extra_part = _split_graph_preconditions(pre)
            self._pre_cond_ed.set_flag_pattern_context(
                self._get_project_model_for_inspector(), None
            )
            self._pre_cond_ed.set_data(flag_part)
            if not extra_part:
                self._edit_pre_extra.setPlainText("")
            else:
                try:
                    self._edit_pre_extra.setPlainText(
                        json.dumps(extra_part, ensure_ascii=False, indent=2)
                    )
                except (TypeError, ValueError):
                    self._edit_pre_extra.setPlainText(str(extra_part))
        finally:
            self._pre_cond_ed.blockSignals(False)
            for w in (
                self._edit_graph_id,
                self._edit_entry,
                self._edit_title,
                self._edit_pre_extra,
            ):
                w.blockSignals(False)
            self._edit_meta_scenario.blockSignals(False)

    def _widgets_to_data_meta(self):
        sv = self._data.get("schemaVersion", 1)
        try:
            self._data["schemaVersion"] = int(sv)
        except (TypeError, ValueError):
            self._data["schemaVersion"] = 1
        self._data["id"] = self._edit_graph_id.text().strip()
        self._data["entry"] = self._edit_entry.text().strip()
        title = self._edit_title.text().strip()
        scenario_id = self._meta_scenario_value()
        prev_meta = self._data.get("meta")
        meta: dict = {}
        if isinstance(prev_meta, dict):
            meta = {k: v for k, v in prev_meta.items() if k not in ("title", "scenarioId")}
        if title:
            meta["title"] = title
        if scenario_id:
            meta["scenarioId"] = scenario_id
        self._data["meta"] = meta
        merged: list[Any] = list(self._pre_cond_ed.to_list())
        raw_ex = self._edit_pre_extra.toPlainText().strip()
        if raw_ex:
            extra = json.loads(raw_ex)
            if not isinstance(extra, list):
                raise ValueError("附加 preconditions 必须是 JSON 数组")
            merged.extend(extra)
        self._data["preconditions"] = merged

    def _flush_current_inspector_to_data(self) -> None:
        """保存/校验前：把右侧节点面板内容写回 _data['nodes']。

        以面板 `NodeInspector._node_id` 为准（与 set_node 一致）；若与节点列表当前行不一致则拒绝写入，避免串节点。
        """
        nodes = self._data.get("nodes")
        if not isinstance(nodes, dict) or not nodes:
            return
        insp = (getattr(self._inspector, "_node_id", None) or "").strip()
        lst = self._current_node_id_from_list() or self._editing_node_id
        if insp and lst and insp != lst:
            raise ValueError(
                "节点列表当前行与右侧编辑面板不是同一节点，请在左侧列表中再点选要保存的节点后重试。"
            )
        nid = insp or lst
        if not nid or nid not in nodes:
            return
        self._data["nodes"][nid] = self._inspector.get_node()
        self._editing_node_id = nid

    def _on_graph_meta_changed(self):
        if not isinstance(self._data.get("nodes"), dict):
            return
        try:
            self._widgets_to_data_meta()
        except (json.JSONDecodeError, ValueError):
            return
        self._mark_dirty()
        self._rebuild_flow_scene()
        if self._current_path is None and self._draft_layout_basename:
            self._refresh_file_list(select_unsaved=True)

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
                t = n.get("type", "?")
                label = f"{nid}  ({t})"
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

    def _on_file_item_changed(self, cur: QListWidgetItem | None, prev: QListWidgetItem | None):
        if not cur:
            return
        raw = cur.data(Qt.ItemDataRole.UserRole)
        if raw == self._unsaved_list_token:
            return
        path = Path(raw)
        if self._current_path and path.resolve() == self._current_path.resolve():
            return
        if self._dirty:
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

    def _revert_file_selection(self, prev: QListWidgetItem | None):
        self._file_list.blockSignals(True)
        if prev:
            self._file_list.setCurrentItem(prev)
        elif self._current_path:
            for i in range(self._file_list.count()):
                it = self._file_list.item(i)
                if it is None:
                    continue
                raw = it.data(Qt.ItemDataRole.UserRole)
                if raw == self._unsaved_list_token:
                    continue
                try:
                    if Path(str(raw)).resolve() == self._current_path.resolve():
                        self._file_list.setCurrentItem(it)
                        break
                except OSError:
                    pass
        elif self._current_path is None:
            for i in range(self._file_list.count()):
                it = self._file_list.item(i)
                if it and it.data(Qt.ItemDataRole.UserRole) == self._unsaved_list_token:
                    self._file_list.setCurrentItem(it)
                    break
        self._file_list.blockSignals(False)

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
                # 切换列表行前先把旧节点写回；若旧 id 已不在图中（例如刚删节点），切勿 setdefault 把它插回去
                prev_nodes = self._data.get("nodes")
                if isinstance(prev_nodes, dict) and self._editing_node_id in prev_nodes:
                    prev_nodes[self._editing_node_id] = self._inspector.get_node()
            except ValueError as e:
                QMessageBox.warning(self, "无法切换节点", str(e))
                self._node_list.blockSignals(True)
                if self._editing_node_id:
                    self._ensure_node_visible_in_list(self._editing_node_id)
                self._node_list.blockSignals(False)
                return
        self._editing_node_id = nid
        nodes = self._data.get("nodes") or {}
        raw = copy.deepcopy(nodes.get(nid, {"type": "end"}))
        self._inspector.set_node(
            nid,
            raw,
            editor_groups=self._editor_groups,
            editor_group_for_node=self._node_to_group.get(nid, ""),
        )

    def _on_inspector_changed(self):
        if "nodes" not in self._data:
            return
        nid = (getattr(self._inspector, "_node_id", None) or "").strip()
        if not nid:
            nid = self._current_node_id_from_list() or (self._editing_node_id or "")
        if not nid:
            return
        nodes = self._data.get("nodes") or {}
        if nid not in nodes:
            return
        try:
            new_node = self._inspector.get_node()
        except ValueError as e:
            self._toast(str(e), 5000)
            return
        self._data.setdefault("nodes", {})[nid] = new_node
        self._mark_dirty()
        self._refresh_node_list_row(nid)
        self._inspector_scene_timer.start(120)

    def _refresh_node_list_row(self, nid: str):
        for i in range(self._node_list.count()):
            it = self._node_list.item(i)
            if it and str(it.data(Qt.ItemDataRole.UserRole) or "") == nid:
                n = (self._data.get("nodes") or {}).get(nid, {})
                t = n.get("type", "?")
                it.setText(f"{nid}  ({t})")
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
        nodes = self._data.setdefault("nodes", {})
        nid, ok = QInputDialog.getText(self, "新节点 id", "字母/数字/下划线", text=suggest_next_id(nodes))
        if not ok or not nid.strip():
            return
        nid = nid.strip()
        if nid in nodes:
            QMessageBox.warning(self, "重复", f"已存在节点 {nid!r}")
            return
        items = ["line", "runActions", "choice", "switch", "end"]
        t, ok = QInputDialog.getItem(self, "节点类型", "type", items, 0, False)
        if not ok:
            return
        nodes[nid] = default_node(t, {k: v for k, v in nodes.items() if k != nid})
        self._mark_dirty()
        self._populate_node_list()
        self._node_list.blockSignals(True)
        self._ensure_node_visible_in_list(nid)
        self._node_list.blockSignals(False)
        self._apply_selected_node_to_inspector()
        self._rebuild_flow_scene()

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
        node_dict = self._data.setdefault("nodes", {})
        if not isinstance(node_dict, dict):
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
        if ext_refs:
            r = QMessageBox.question(
                self,
                "删除节点",
                f"仍有 {ext_refs} 条来自其它节点的连线指向待删除节点。是否先断开这些入边再删除？\n"
                "选「否」将直接删除（可能留下悬空 next）。",
                QMessageBox.StandardButton.Yes
                | QMessageBox.StandardButton.No
                | QMessageBox.StandardButton.Cancel,
            )
            if r == QMessageBox.StandardButton.Cancel:
                return
            if r == QMessageBox.StandardButton.Yes:
                for nid in to_del:
                    clear_incoming_to_node(self._data, nid)
        preview = "、".join(to_del[:12])
        if len(to_del) > 12:
            preview += f" 等共 {len(to_del)} 个"
        confirm = QMessageBox.question(
            self,
            "删除",
            f"删除节点 {preview}？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if confirm != QMessageBox.StandardButton.Yes:
            return
        for nid in to_del:
            node_dict.pop(nid, None)
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

    def _remove_ghost_missing_targets(self, mids: list[str]) -> None:
        """幽灵节点对应 JSON 外 id：清空所有指向这些 id 的连线并移除布局里 ghost 坐标。"""
        u = sorted({str(m).strip() for m in mids if str(m).strip()})
        if not u:
            return
        total_refs = sum(len(collect_incoming_refs(self._data, mid)) for mid in u)
        if total_refs == 0:
            for mid in u:
                self._ghost_positions.pop(mid, None)
            self._mark_dirty()
            self._rebuild_flow_scene()
            if self._layout_path_for_io():
                self._flush_flow_layout_to_disk()
            self._toast("已移除幽灵布局坐标（无连线指向这些缺失 id）", 2500)
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
        for mid in u:
            clear_incoming_to_node(self._data, mid)
            self._ghost_positions.pop(mid, None)
        self._mark_dirty()
        self._rebuild_flow_scene()
        if self._layout_path_for_io():
            self._flush_flow_layout_to_disk()

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
        nodes = self._data.setdefault("nodes", {})
        new_id, ok = QInputDialog.getText(
            self, "复制为", "新 id", text=suggest_next_id(nodes)
        )
        if not ok or not new_id.strip():
            return
        new_id = new_id.strip()
        if new_id in nodes:
            QMessageBox.warning(self, "重复", f"已存在 {new_id!r}")
            return
        nodes[new_id] = copy.deepcopy(nodes[nid])
        ox, oy = self._positions.get(nid, (0.0, 0.0))
        self._positions[new_id] = (float(ox) + 40.0, float(oy) + 40.0)
        self._mark_dirty()
        self._populate_node_list()
        self._node_list.blockSignals(True)
        self._ensure_node_visible_in_list(new_id)
        self._node_list.blockSignals(False)
        self._apply_selected_node_to_inspector()
        self._rebuild_flow_scene()

    def _write_to_path(self, path: Path) -> bool:
        old_draft = self._draft_layout_basename
        draft_lp = (self._graphs_dir / old_draft) if old_draft else None
        try:
            self._widgets_to_data_meta()
            self._flush_current_inspector_to_data()
        except json.JSONDecodeError as e:
            QMessageBox.critical(
                self, "保存失败", f"附加 preconditions（JSON）解析失败：{e}"
            )
            return False
        except ValueError as e:
            QMessageBox.critical(self, "保存失败", str(e))
            return False

        errors, warnings = validate_graph_tiered(self._data)
        if errors:
            QMessageBox.critical(self, "保存失败（存在错误）", "\n".join(errors[:50]))
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
                return False

        try:
            save_json(path, self._data)
        except OSError as e:
            QMessageBox.critical(self, "保存失败", str(e))
            return False
        if draft_lp is not None and old_draft:
            migrate_layout_map_key(self._project, draft_lp, path)
        self._current_path = path
        self._draft_layout_basename = None
        self._data["id"] = path.stem
        self._apply_data_to_widgets()
        self._flush_flow_layout_to_disk()
        self._set_dirty(False)
        self._emit_title()
        self._toast("已保存", 3000)
        self._refresh_file_list()
        self._sync_file_list_selection(path)
        return True
