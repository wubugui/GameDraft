"""用 OdenGraphQt 承载对话流程图（节点、连线、缩放）。

标识分层（避免把策划 id 当 Oden 内部主键）：

- **内部 id**：``NodeObject.id`` / ``AbstractNodeItem.id``，注册在 ``NodeGraph._model.nodes``。
  命中场景项、viewer 信号携带的选中 id、位移字典键等，一律用 ``get_node_by_id`` 解析。
- **Gameplay / JSON**：``graphs/*.json`` 的 ``nodes`` 键、``next`` 等边引用，以及编辑器 ``_data["nodes"]``
  的键；与节点 ``name()`` 对齐（``create_node(..., name=nid)``），便于同一份 JSON 读写。
  **rebuild** 从边表连边、``select_dialogue_node(nid)``、``center_on_node`` 等从策划侧 id 反查节点时，
  使用 ``get_node_by_name``。
- **边界**：改 ``_data``、驱动列表/检查器、右键菜单信号时，在已得到 ``NodeObject`` 之后再读
  ``name()`` / ``missing_id`` /分组前缀；勿把 JSON 节点键传入 ``get_node_by_id``。

本模块内 ``node_object_from_abstract_item`` / ``node_object_from_internal_id`` /
``gameplay_ids_for_context_menu`` 封装上述约定。
"""
from __future__ import annotations

import types
from typing import Any, Callable

from PySide6.QtCore import QObject, QPoint, Qt, Signal
from PySide6.QtGui import QKeySequence, QShortcut, QUndoStack
from PySide6.QtWidgets import QGraphicsItem

from qtpy import QtCore

from OdenGraphQt import NodeGraph, Port
from OdenGraphQt.nodes.backdrop_node import BackdropNode
from OdenGraphQt.qgraphics.node_abstract import AbstractNodeItem
from OdenGraphQt.widgets.viewer import NodeViewer

from .graph_document import extract_flow_edges_detailed, validate_graph

_oden_nodegraph_pyside6_patch_done = False


class _Pyside6SafeNodeViewer(NodeViewer):
    """库内 ``moved_nodes`` 以 QGraphicsItem 为 dict 键，PySide6 槽参数无法传递，并导致拖动/撤销错乱。

    改为发出 ``{view.id: (x, y)}``（拖动起点坐标快照），与 ``NodeGraph._on_nodes_moved`` 补丁配套。
    """

    def mouseReleaseEvent(self, event):  # noqa: ANN001
        if event.button() == QtCore.Qt.MouseButton.LeftButton:
            self.LMB_state = False
        elif event.button() == QtCore.Qt.MouseButton.RightButton:
            self.RMB_state = False
        elif event.button() == QtCore.Qt.MouseButton.MiddleButton:
            self.MMB_state = False

        if self._SLICER_PIPE.isVisible():
            self._on_pipes_sliced(self._SLICER_PIPE.path())
            p = QtCore.QPointF(0.0, 0.0)
            self._SLICER_PIPE.draw_path(p, p)
            self._SLICER_PIPE.setVisible(False)

        if self._rubber_band.isActive:
            self._rubber_band.isActive = False
            if self._rubber_band.isVisible():
                rect = self._rubber_band.rect()
                map_rect = self.mapToScene(rect).boundingRect()
                self._rubber_band.hide()

                rect = QtCore.QRect(self._origin_pos, event.pos()).normalized()
                rect_items = self.scene().items(
                    self.mapToScene(rect).boundingRect()
                )
                node_ids = []
                for item in rect_items:
                    if isinstance(item, AbstractNodeItem):
                        node_ids.append(item.id)

                if node_ids:
                    prev_ids = [
                        n.id for n in self._prev_selection_nodes
                        if not n.selected
                    ]
                    self.node_selected.emit(node_ids[0])
                    self.node_selection_changed.emit(node_ids, prev_ids)

                self.scene().update(map_rect)
                return

        moved_nodes_raw = {
            n: xy_pos
            for n, xy_pos in self._node_positions.items()
            if n.xy_pos != xy_pos
        }
        moved_nodes = {
            str(n.id): (float(xy_pos[0]), float(xy_pos[1]))
            for n, xy_pos in moved_nodes_raw.items()
        }
        if moved_nodes and not self.COLLIDING_state:
            self.moved_nodes.emit(moved_nodes)

        self._node_positions = {}

        nodes, pipes = self.selected_items()
        if self.COLLIDING_state and nodes and pipes:
            self.insert_node.emit(pipes[0], nodes[0].id, moved_nodes)

        prev_ids = [n.id for n in self._prev_selection_nodes if not n.selected]
        node_ids = [n.id for n in nodes if n not in self._prev_selection_nodes]
        self.node_selection_changed.emit(node_ids, prev_ids)

        super(NodeViewer, self).mouseReleaseEvent(event)


def _patch_oden_nodegraph_for_pyside6() -> None:
    """避免 NodeGraph 通过 Signal(NodeObject) 传递 Python 节点子类时 Shiboken 复制失败。

    交互仍可通过 viewer 的 node_selected(str)、node_selection_changed 等信号完成。
    """
    global _oden_nodegraph_pyside6_patch_done
    if _oden_nodegraph_pyside6_patch_done:
        return

    from OdenGraphQt.base.commands import (
        NodeAddedCmd,
        NodeMovedCmd,
        NodeVisibleCmd,
        NodesRemovedCmd,
        PropertyChangedCmd,
    )

    def _on_node_selected(self, node_id):  # noqa: ANN001
        self.get_node_by_id(node_id)

    def _on_node_selection_changed(self, sel_ids, desel_ids):  # noqa: ANN001
        pass

    def _on_node_double_clicked(self, node_id):  # noqa: ANN001
        self.get_node_by_id(node_id)

    def _node_added_redo_skip_bad_emit(self) -> None:
        """原库误用 nodes_deleted.emit(节点对象)；且 Signal(NodeObject) 携带 Python 子类会触发 Shiboken 报错。"""
        self.graph.model.nodes[self.node.id] = self.node
        self.graph.viewer().add_node(self.node.view, self.pos)
        self.node.model.width = self.node.view.width
        self.node.model.height = self.node.view.height

    def _nodes_removed_undo_skip_node_created_emit(self) -> None:
        """跳过 node_created.emit(节点)：同上，避免向 Qt 传递 DialogueFlowNode 等子类实例。"""
        for node in self.nodes:
            self.graph.model.nodes[node.id] = node
            self.graph.scene().addItem(node.view)

    def _on_nodes_moved_pyside_safe(self, node_data):  # noqa: ANN001
        """库内原为 {view: prev_pos}；安全 Viewer 改为 {node_id: prev_pos}。

        键可能是 AbstractNodeItem（用 ``.id``）、NodeObject（``.id``）或 str（已转换的 id）；
        不可对 view 使用 ``str(k)``，否则会得到 ``0x...`` 之类假 id，触发 KeyError。
        """
        cmds: list[tuple[Any, Any]] = []
        for k, prev_pos in node_data.items():
            node_id = getattr(k, "id", None)
            if node_id is None:
                node_id = str(k)
            node = self._model.nodes.get(node_id)
            if node is None:
                continue
            cmds.append((node, prev_pos))
        if not cmds:
            return
        self._undo_stack.beginMacro("move nodes")
        for node, prev_pos in cmds:
            self._undo_stack.push(NodeMovedCmd(node, node.pos(), prev_pos))
        self._undo_stack.endMacro()

    def _set_node_property_no_nodeobject_emit(self, name, value):  # noqa: ANN001
        model = self.node.model
        model.set_property(name, value)
        view = self.node.view
        if hasattr(view, "widgets") and name in view.widgets.keys():
            if view.widgets[name].get_value() != value:
                view.widgets[name].set_value(value)
        if name in view.properties.keys():
            vname = name
            if vname == "pos":
                vname = "xy_pos"
            setattr(view, vname, value)

    def _set_node_visible_no_nodeobject_emit(self, visible):  # noqa: ANN001
        model = self.node.model
        model.set_property("visible", visible)
        node_view = self.node.view
        node_view.visible = visible
        ports = node_view.inputs + node_view.outputs
        for port in ports:
            for pipe in port.connected_pipes:
                pipe.update()
        if self.selected != node_view.isSelected():
            node_view.setSelected(model.selected)

    NodeGraph._on_node_selected = _on_node_selected
    NodeGraph._on_node_selection_changed = _on_node_selection_changed
    NodeGraph._on_node_double_clicked = _on_node_double_clicked
    PropertyChangedCmd.set_node_property = _set_node_property_no_nodeobject_emit
    NodeVisibleCmd.set_node_visible = _set_node_visible_no_nodeobject_emit
    NodeAddedCmd.redo = _node_added_redo_skip_bad_emit
    NodesRemovedCmd.undo = _nodes_removed_undo_skip_node_created_emit
    NodeGraph._on_nodes_moved = _on_nodes_moved_pyside_safe
    _oden_nodegraph_pyside6_patch_done = True
from .graph_mutations import (
    OUT_CHOICE,
    OUT_NEXT,
    OUT_SWITCH_CASE,
    OUT_SWITCH_DEFAULT,
    connect_output_to_target,
    clear_output,
)
from .graph_document_model import GraphDocumentModel
from .oden_dialogue_nodes import (
    DialogueFlowNode,
    DialogueGhostNode,
    PN_NEXT,
    PN_SWITCH_DEFAULT,
    parse_dialogue_out_port,
    pn_choice,
    pn_switch_case,
)


def node_object_from_abstract_item(
    graph: NodeGraph,
    item: AbstractNodeItem,
) -> Any | None:
    """``AbstractNodeItem`` → ``NodeObject``（``get_node_by_id(str(item.id))``）。

    参数为画布运行时内部 id，**勿**传入 graphs JSON 的节点键。
    """
    return graph.get_node_by_id(str(item.id))


def node_object_from_internal_id(graph: NodeGraph, internal_id: str) -> Any | None:
    """用 Oden 内部节点 id（与 ``view.id``、viewer 信号一致）解析节点。**勿**传入策划侧节点 id。"""
    if not internal_id:
        return None
    return graph.get_node_by_id(str(internal_id))


def gameplay_ids_for_context_menu(
    node: Any,
) -> tuple[str | None, str | None, str | None, bool]:
    """将已解析的 ``NodeObject`` 转为右键菜单用的 gameplay 引用。

    返回 ``(对话节点 id, 编辑器分组 gid, 幽灵缺失 id, stop)``。
    ``stop`` 为真时表示已消费该场景项（含幽灵即使缺失 id 为空也应停止栈顶遍历）。
    仅在此类边界向 UI 扩散策划侧 id；图内核路径应先走 ``node_object_from_*``。
    """
    if isinstance(node, DialogueGhostNode):
        mid = (node.missing_id or "").strip() or None
        return (None, None, mid, True)
    if isinstance(node, DialogueFlowNode):
        return (node.name(), None, None, True)
    if isinstance(node, BackdropNode):
        nm = node.name()
        pfx = "__editor_grp_"
        if nm.startswith(pfx):
            return (None, nm[len(pfx) :], None, True)
        return (None, None, None, False)
    return (None, None, None, False)


class DialogueFlowOdenController(QObject):
    """包装 NodeGraph：从 JSON 重建、端口事件写回 _data。"""

    canvas_node_selected = Signal(str)
    """对话节点 id；空字符串表示未选或选了幽灵节点。"""

    data_topology_changed = Signal()
    """连线/断线导致 JSON 拓扑变化（已写回 _data）。"""

    canvas_context_menu = Signal(float, float, object, object, object)
    """右键菜单：场景坐标、对话节点 id 或 None、分组框 gid 或 None、幽灵缺失 id 或 None。"""

    editor_frame_rename_requested = Signal(str)
    """双击分组框标题区域：请求改分组显示名（内部分组 id）。"""

    delete_key_requested = Signal()
    """画布上按下 Delete（由主窗口处理删除与确认）。"""

    auto_layout_requested = Signal()

    def __init__(
        self,
        undo_stack: QUndoStack,
        parent: QObject | None = None,
        *,
        toast: Callable[[str, int], None] | None = None,
    ):
        super().__init__(parent)
        self._toast = toast or (lambda msg, _ms: None)
        _patch_oden_nodegraph_for_pyside6()
        self._graph = NodeGraph(
            parent=self,
            undo_stack=undo_stack,
            viewer=_Pyside6SafeNodeViewer(undo_stack=undo_stack),
        )
        self._graph.set_acyclic(False)
        # BackdropNode 由库默认注册，不可重复 register_nodes，否则 NodeRegistrationError。
        self._graph.register_nodes([DialogueFlowNode, DialogueGhostNode])
        self._graph.port_connected.connect(self._on_port_connected)
        self._graph.port_disconnected.connect(self._on_port_disconnected)
        self._graph.viewer().node_selected.connect(self._on_viewer_node_selected)
        self._graph.viewer().moved_nodes.connect(self._on_nodes_moved)

        self._data_get: Callable[[], dict[str, Any]] | None = None
        self._positions_get: Callable[[], dict[str, tuple[float, float]]] | None = None
        self._ghost_positions_get: Callable[[], dict[str, tuple[float, float]]] | None = None
        self._layout_timer_start: Callable[[int], None] | None = None
        self._editor_frame_drag_end_cb: Callable[[], None] | None = None
        self._rebuilding = False
        self._doc_model: GraphDocumentModel | None = None

        vw = self._graph.viewer()
        vw.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        vw.customContextMenuRequested.connect(self._viewer_context_menu)
        QShortcut(QKeySequence("F"), vw, activated=self.fit_all)
        QShortcut(QKeySequence("A"), vw, activated=self._emit_auto_layout_request)
        sc_del = QShortcut(QKeySequence(Qt.Key.Key_Delete), vw, activated=self._emit_delete_key)
        # 仅当焦点在画布（含 viewport） subtree 内时响应，避免与窗口内其它控件的 Delete 冲突
        sc_del.setContext(Qt.ShortcutContext.WidgetWithChildrenShortcut)

    def _viewer_context_menu(self, local_pos: QPoint) -> None:
        v = self._graph.viewer()
        sp = v.mapToScene(local_pos)
        hit_id: str | None = None
        hit_frame_gid: str | None = None
        hit_ghost_missing: str | None = None
        # 栈顶优先：用 view内部 id → NodeObject，再在边界解析 gameplay 引用
        for it in v.scene().items(sp):
            if not isinstance(it, AbstractNodeItem):
                continue
            node_obj = node_object_from_abstract_item(self._graph, it)
            if node_obj is None:
                continue
            hit_id, hit_frame_gid, hit_ghost_missing, stop = (
                gameplay_ids_for_context_menu(node_obj)
            )
            if stop:
                break
        self.canvas_context_menu.emit(
            float(sp.x()), float(sp.y()), hit_id, hit_frame_gid, hit_ghost_missing
        )

    def _emit_delete_key(self) -> None:
        self.delete_key_requested.emit()

    def _emit_auto_layout_request(self) -> None:
        self.auto_layout_requested.emit()

    def set_data_binding(
        self,
        data_get: Callable[[], dict[str, Any]],
        positions_get: Callable[[], dict[str, tuple[float, float]]],
        ghost_positions_get: Callable[[], dict[str, tuple[float, float]]],
        layout_timer_start: Callable[[int], None],
    ) -> None:
        self._data_get = data_get
        self._positions_get = positions_get
        self._ghost_positions_get = ghost_positions_get
        self._layout_timer_start = layout_timer_start

    def set_model(self, model: GraphDocumentModel) -> None:
        """Provide the document model for topology mutations (connect/disconnect)."""
        self._doc_model = model

    def set_editor_frame_drag_end_callback(self, cb: Callable[[], None] | None) -> None:
        """分组框拖动结束（mouse release）后调用，用于按几何重算 nodeGroups。"""
        self._editor_frame_drag_end_cb = cb

    def sync_layout_dicts_from_graph(self) -> None:
        """把当前画布上节点的 scene 坐标写回策划 layout 字典。

        在撤销栈变化时调用：OdenGraphQt 的位移已由 NodeMovedCmd 作用在 view 上，
        切勿再立刻 ``rebuild`` 全图（会用旧的 ``_positions`` 把节点拽回原位）。
        """
        if self._positions_get is None or self._ghost_positions_get is None:
            return
        pos = self._positions_get()
        gh = self._ghost_positions_get()
        for n in self._graph.all_nodes():
            x, y = n.pos()
            if isinstance(n, DialogueFlowNode):
                pos[n.name()] = (float(x), float(y))
            elif isinstance(n, DialogueGhostNode):
                gh[n.missing_id] = (float(x), float(y))

    def viewer(self):
        return self._graph.viewer()

    def fit_all(self) -> None:
        self._graph.fit_to_selection()

    def apply_oden_auto_layout(self) -> bool:
        """调用 OdenGraphQt 自带的 ``NodeGraph.auto_layout_nodes``（按连接关系分层）。

        库内无入边的节点作为起点向下游排布；若无起点（例如全是环）则返回 False，由上层改用 BFS 布局。
        注意：若 ``rank_map`` 键不连续，旧版库在迭代 ``range(len(rank_map))`` 时可能 KeyError，已用 try 捕获。
        """
        nodes = [
            n
            for n in self._graph.all_nodes()
            if isinstance(n, (DialogueFlowNode, DialogueGhostNode))
        ]
        if not nodes:
            return False
        roots = [n for n in nodes if not any(n.connected_input_nodes().values())]
        if not roots:
            return False
        try:
            self._graph.auto_layout_nodes(nodes=nodes, down_stream=True, start_nodes=[])
        except Exception:
            return False
        return True

    def select_dialogue_node(self, nid: str | None) -> None:
        if not nid:
            self._graph.clear_selection()
            return
        n = self._graph.get_node_by_name(nid)
        if n is None:
            return
        self._graph.clear_selection()
        n.set_property("selected", True, push_undo=False)

    def primary_selected_flow_node_id(self) -> str | None:
        """当前画布上选中的第一个对话节点 id（非幽灵）。

        优先 ``NodeGraph.selected_nodes()``；若为空再回退 ``view.isSelected()``，
        避免个别版本/状态下二者不一致导致删键无效。
        """
        ids = self.selected_flow_node_ids()
        return ids[0] if ids else None

    def selected_flow_node_ids(self) -> list[str]:
        """画布上当前选中的全部对话节点 id（非幽灵），按 id 排序。"""
        out: list[str] = []
        try:
            for n in self._graph.selected_nodes():
                if isinstance(n, DialogueFlowNode):
                    out.append(n.name())
        except Exception:
            out = []
        if not out:
            try:
                for n in self._graph.all_nodes():
                    if not isinstance(n, DialogueFlowNode):
                        continue
                    try:
                        if n.view.isSelected():
                            out.append(n.name())
                    except Exception:
                        continue
            except Exception:
                pass
        return sorted(set(out))

    def selected_ghost_missing_ids(self) -> list[str]:
        """画布上当前选中的幽灵节点对应的缺失目标 id（JSON 中不存在的节点 id）。"""
        out: list[str] = []
        try:
            for n in self._graph.selected_nodes():
                if isinstance(n, DialogueGhostNode):
                    mid = (n.missing_id or "").strip()
                    if mid:
                        out.append(mid)
        except Exception:
            out = []
        if not out:
            try:
                for n in self._graph.all_nodes():
                    if not isinstance(n, DialogueGhostNode):
                        continue
                    try:
                        if n.view.isSelected():
                            mid = (n.missing_id or "").strip()
                            if mid:
                                out.append(mid)
                    except Exception:
                        continue
            except Exception:
                pass
        return sorted(set(out))

    def _strip_orphan_scene_items_and_clear_model(self) -> None:
        """delete_nodes 后兜底：去掉仍留在场景中的节点/连线项并清空 model，避免重建叠出「死节点」。"""
        from OdenGraphQt.qgraphics.pipe import LivePipeItem, PipeItem

        sc = self._graph.scene()
        for item in list(sc.items()):
            if isinstance(item, AbstractNodeItem):
                sc.removeItem(item)
            elif isinstance(item, PipeItem) and not isinstance(item, LivePipeItem):
                sc.removeItem(item)
        self._graph.model.nodes.clear()

    def center_on_node(self, nid: str) -> None:
        n = self._graph.get_node_by_name(nid)
        if n is None:
            return
        self._graph.viewer().zoom_to_nodes([n.view])

    def rebuild(
        self,
        data: dict[str, Any],
        positions: dict[str, tuple[float, float]],
        ghost_positions: dict[str, tuple[float, float]],
        *,
        selected_id: str | None,
        entry: str,
        node_diag: dict[str, str] | None = None,
        node_group_colors: dict[str, tuple[int, int, int, int]] | None = None,
        editor_groups: dict[str, Any] | None = None,
        node_to_group: dict[str, str] | None = None,
        editor_group_frames: dict[str, Any] | None = None,
    ) -> None:
        self._rebuilding = True
        try:
            existing = self._graph.all_nodes()
            if existing:
                try:
                    self._graph.delete_nodes(existing, push_undo=False)
                except Exception:
                    pass
                self._strip_orphan_scene_items_and_clear_model()

            nodes = data.get("nodes") or {}
            if not isinstance(nodes, dict):
                return

            node_diag = node_diag or {}
            node_group_colors = node_group_colors or {}
            missing_targets: set[str] = set()
            for _s, d, _lab, _k, _idx in extract_flow_edges_detailed(nodes):
                if d and d not in nodes:
                    missing_targets.add(d)

            flow_ty = DialogueFlowNode.type_
            ghost_ty = DialogueGhostNode.type_

            for nid, raw in nodes.items():
                if not isinstance(raw, dict):
                    continue
                x, y = positions.get(nid, (0.0, 0.0))
                node = self._graph.create_node(
                    flow_ty,
                    name=nid,
                    pos=[float(x), float(y)],
                    push_undo=False,
                    selected=False,
                )
                assert isinstance(node, DialogueFlowNode)
                gcol = node_group_colors.get(nid)
                node.apply_dialogue_shape(
                    raw,
                    is_entry=(nid == entry),
                    diag_tag=node_diag.get(nid),
                    group_rgba=gcol,
                )

            for i, gid in enumerate(sorted(missing_targets)):
                gx, gy = ghost_positions.get(gid, (420.0, 30.0 + i * 72.0))
                gn = self._graph.create_node(
                    ghost_ty,
                    name=f"? {gid}",
                    pos=[float(gx), float(gy)],
                    push_undo=False,
                    selected=False,
                )
                assert isinstance(gn, DialogueGhostNode)
                gn.setup_ghost(gid)

            for s, d, _lab, k, idx in extract_flow_edges_detailed(nodes):
                if s not in nodes:
                    continue
                sn = self._graph.get_node_by_name(s)
                if sn is None or not isinstance(sn, DialogueFlowNode):
                    continue
                op = self._output_port_for_spec(sn, k, idx)
                if op is None:
                    continue
                if d in nodes:
                    dn = self._graph.get_node_by_name(d)
                else:
                    dn = self._graph.get_node_by_name(f"? {d}")
                if dn is None:
                    continue
                inp = dn.input(0)
                op.connect_to(inp, push_undo=False, emit_signal=False)

            self._place_editor_group_frames(nodes, editor_groups, editor_group_frames)

            if selected_id:
                sel = self._graph.get_node_by_name(selected_id)
                if sel is not None:
                    sel.set_property("selected", True, push_undo=False)
        finally:
            self._rebuilding = False

    def _place_editor_group_frames(
        self,
        nodes_dict: dict[str, Any],
        editor_groups: dict[str, Any] | None,
        editor_group_frames: dict[str, Any] | None,
    ) -> None:
        """按持久化的 groupFrames 放置分组框（纯编辑器数据）。"""
        if not editor_groups or not editor_group_frames:
            return
        bd_type = BackdropNode.type_
        for gid in sorted(editor_group_frames.keys()):
            if gid not in editor_groups:
                continue
            fr = editor_group_frames.get(gid)
            if not isinstance(fr, dict):
                continue
            meta = editor_groups.get(gid) or {}
            title = str(meta.get("name") or gid)
            color = str(meta.get("color") or "#4a6fa8")
            try:
                x = float(fr.get("x", 0.0))
                y = float(fr.get("y", 0.0))
                w = float(fr.get("width", 240.0))
                h = float(fr.get("height", 180.0))
            except (TypeError, ValueError):
                continue
            w = max(80.0, w)
            h = max(80.0, h)
            bd = self._graph.create_node(
                bd_type,
                name=f"__editor_grp_{gid}",
                pos=[x, y],
                selected=False,
                color=color,
                push_undo=False,
            )
            bd.set_property("width", w, push_undo=False)
            bd.set_property("height", h, push_undo=False)
            bd.set_property("backdrop_text", title, push_undo=False)
            self._configure_editor_frame_backdrop(bd, str(gid))

    def _configure_editor_frame_backdrop(self, bd: BackdropNode, gid: str) -> None:
        """拖动时仅带动几何上在框内的节点；不按库逻辑误选其它节点。"""
        oden = self
        v = bd.view
        v._editor_frame_gid = gid
        v._editor_grp_graph_ref = self._graph

        v.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, True)
        v.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsSelectable, True)
        v.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsFocusable, True)
        v.setAcceptedMouseButtons(
            Qt.MouseButton.LeftButton
            | Qt.MouseButton.RightButton
            | Qt.MouseButton.MiddleButton
        )
        sizer = getattr(v, "_sizer", None)
        if sizer is not None:
            sizer.setVisible(True)
            sizer.setAcceptedMouseButtons(Qt.MouseButton.LeftButton)

        def _mouse_press(item, event):  # noqa: ANN001
            AbstractNodeItem.mousePressEvent(item, event)
            dg = oden._data_get
            nodes_d = (dg() or {}).get("nodes") if dg else None
            if not isinstance(nodes_d, dict):
                item._editor_drag_captured_ids = []
                return
            fr_rect = item.sceneBoundingRect()
            captured: list[str] = []
            g = item._editor_grp_graph_ref
            for nid in nodes_d:
                nn = g.get_node_by_name(nid)
                if nn is None or not isinstance(nn, DialogueFlowNode):
                    continue
                c = nn.view.sceneBoundingRect().center()
                if fr_rect.contains(c):
                    captured.append(nid)
            item._editor_drag_captured_ids = captured

        def _mouse_double_click(item, event):  # noqa: ANN001
            g = getattr(item, "_editor_frame_gid", None)
            if g:
                oden.editor_frame_rename_requested.emit(str(g))

        def _mouse_release(item, event):  # noqa: ANN001
            QGraphicsItem.mouseReleaseEvent(item, event)
            item.setFlag(QGraphicsItem.GraphicsItemFlag.ItemIsMovable, True)
            item._editor_drag_captured_ids = None
            cb = oden._editor_frame_drag_end_cb
            if cb:
                cb()

        def _item_change(item, change, value):  # noqa: ANN001
            if change == QGraphicsItem.GraphicsItemChange.ItemPositionChange:
                cap = getattr(item, "_editor_drag_captured_ids", None)
                if cap:
                    old = item.pos()
                    new = value
                    dx = float(new.x()) - float(old.x())
                    dy = float(new.y()) - float(old.y())
                    if abs(dx) > 1e-6 or abs(dy) > 1e-6:
                        g = getattr(item, "_editor_grp_graph_ref", None)
                        if g is not None:
                            for nid in cap:
                                n = g.get_node_by_name(nid)
                                if n is not None:
                                    x, y = n.pos()
                                    n.set_property(
                                        "pos",
                                        [float(x) + dx, float(y) + dy],
                                        push_undo=False,
                                    )
            return QGraphicsItem.itemChange(item, change, value)

        v.mousePressEvent = types.MethodType(_mouse_press, v)
        v.mouseReleaseEvent = types.MethodType(_mouse_release, v)
        v.mouseDoubleClickEvent = types.MethodType(_mouse_double_click, v)
        v.itemChange = types.MethodType(_item_change, v)

    def snapshot_editor_group_frames(self) -> dict[str, dict[str, float]]:
        out: dict[str, dict[str, float]] = {}
        for n in self._graph.all_nodes():
            if not isinstance(n, BackdropNode):
                continue
            nm = n.name()
            pfx = "__editor_grp_"
            if not nm.startswith(pfx):
                continue
            gid = nm[len(pfx) :]
            x, y = n.pos()
            w, h = n.size()
            out[gid] = {
                "x": float(x),
                "y": float(y),
                "width": float(w),
                "height": float(h),
            }
        return out

    def dialogue_node_scene_centers(
        self, nodes_dict: dict[str, Any]
    ) -> dict[str, tuple[float, float]]:
        out: dict[str, tuple[float, float]] = {}
        for nid in nodes_dict:
            n = self._graph.get_node_by_name(nid)
            if n is None or not isinstance(n, DialogueFlowNode):
                continue
            c = n.view.sceneBoundingRect().center()
            out[nid] = (float(c.x()), float(c.y()))
        return out

    def snapshot_ghost_positions(self) -> dict[str, tuple[float, float]]:
        out: dict[str, tuple[float, float]] = {}
        for n in self._graph.all_nodes():
            if isinstance(n, DialogueGhostNode):
                x, y = n.pos()
                out[n.missing_id] = (float(x), float(y))
        return out

    @staticmethod
    def _output_port_for_spec(node: DialogueFlowNode, kind: str, index: int) -> Port | None:
        if kind == OUT_NEXT:
            return node.get_output(PN_NEXT)
        if kind == OUT_CHOICE:
            return node.get_output(pn_choice(index))
        if kind == OUT_SWITCH_CASE:
            return node.get_output(pn_switch_case(index))
        if kind == OUT_SWITCH_DEFAULT:
            return node.get_output(PN_SWITCH_DEFAULT)
        return None

    def _on_nodes_moved(self, node_data: dict) -> None:
        if self._positions_get is None or self._ghost_positions_get is None:
            return
        pos = self._positions_get()
        gh = self._ghost_positions_get()
        changed = False
        for node_id, _prev in node_data.items():
            node = node_object_from_internal_id(self._graph, str(node_id))
            if node is None:
                continue
            x, y = node.pos()
            if isinstance(node, DialogueFlowNode):
                pos[node.name()] = (float(x), float(y))
                changed = True
            elif isinstance(node, DialogueGhostNode):
                gh[node.missing_id] = (float(x), float(y))
                changed = True
            elif isinstance(node, BackdropNode):
                fr = node.view.sceneBoundingRect()
                for n in self._graph.all_nodes():
                    if not isinstance(n, DialogueFlowNode):
                        continue
                    c = n.view.sceneBoundingRect().center()
                    if fr.contains(c):
                        mx, my = n.pos()
                        pos[n.name()] = (float(mx), float(my))
                        changed = True
        if changed and self._layout_timer_start:
            self._layout_timer_start(450)

    def _on_viewer_node_selected(self, node_id: str) -> None:
        if not node_id:
            self.canvas_node_selected.emit("")
            return
        node = node_object_from_internal_id(self._graph, node_id)
        if node is None:
            self.canvas_node_selected.emit("")
            return
        if isinstance(node, DialogueGhostNode):
            self.canvas_node_selected.emit("")
            return
        if isinstance(node, DialogueFlowNode):
            self.canvas_node_selected.emit(node.name())
            return
        self.canvas_node_selected.emit("")

    def _data_ref(self) -> dict[str, Any] | None:
        if self._data_get is None:
            return None
        return self._data_get()

    def _on_port_connected(self, inp: Port, outp: Port) -> None:
        data = self._data_ref()
        if self._rebuilding or data is None:
            return
        src_node = outp.node()
        if not isinstance(src_node, DialogueFlowNode):
            return
        spec = parse_dialogue_out_port(outp.name())
        if spec is None:
            return
        kind, idx = spec
        src_id = src_node.name()
        dst_node = inp.node()
        if isinstance(dst_node, DialogueGhostNode):
            dst_id = dst_node.missing_id
        elif isinstance(dst_node, DialogueFlowNode):
            dst_id = dst_node.name()
        else:
            return
        if self._doc_model is not None:
            err = self._doc_model.connect_output(src_id, kind, idx, dst_id)
        else:
            err = connect_output_to_target(data, src_id, kind, idx, dst_id)
        if err:
            self._toast(err, 5000)
            try:
                inp.disconnect_from(outp, push_undo=False, emit_signal=False)
            except Exception:
                pass
            return
        issues = validate_graph(data)
        if issues:
            self._toast(f"校验：{issues[0]}", 5000)
        self.data_topology_changed.emit()

    def _on_port_disconnected(self, inp: Port, outp: Port) -> None:
        data = self._data_ref()
        if self._rebuilding or data is None:
            return
        src_node = outp.node()
        if not isinstance(src_node, DialogueFlowNode):
            return
        spec = parse_dialogue_out_port(outp.name())
        if spec is None:
            return
        kind, idx = spec
        if self._doc_model is not None:
            self._doc_model.clear_output(src_node.name(), kind, idx)
        else:
            clear_output(data, src_node.name(), kind, idx)
        self.data_topology_changed.emit()
