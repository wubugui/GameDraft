"""Graph document model: single source of truth for dialogue graph data.

All mutations to graph data (nodes, meta, topology) should go through this model
so that proper change signals are emitted and dirty state is tracked consistently.
Read access is via the ``data`` / ``nodes`` properties which return snapshots.
"""
from __future__ import annotations

import copy
from typing import Any

from PySide6.QtCore import QObject, Signal

from .graph_mutations import (
    collect_incoming_refs,
    connect_output_to_target,
    clear_output as _clear_output_impl,
    rename_node_id,
    clear_incoming_to_node,
)


class GraphDocumentModel(QObject):
    node_changed = Signal(str)
    """A node's data was replaced or a field was set (nid)."""

    node_added = Signal(str)
    """A new node was inserted (nid)."""

    node_removed = Signal(str)
    """A node was deleted (nid)."""

    meta_changed = Signal()
    """Graph-level fields (id, entry, meta, preconditions, schemaVersion) changed."""

    topology_changed = Signal(str)
    """A connection field changed (src_nid) -- next / options[].next / cases[].next / defaultNext."""

    dirty_changed = Signal(bool)
    """Dirty state toggled."""

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self._data: dict[str, Any] = {}
        self._dirty: bool = False

    # -- read access --------------------------------------------------------

    @property
    def data(self) -> dict[str, Any]:
        return copy.deepcopy(self._data)

    @property
    def nodes(self) -> dict[str, Any]:
        n = self._data.get("nodes")
        return copy.deepcopy(n) if isinstance(n, dict) else {}

    @property
    def mutable_data(self) -> dict[str, Any]:
        """Internal compatibility view for UI code that still owns live bindings."""
        return self._data

    def to_dict(self) -> dict[str, Any]:
        return self.data

    @property
    def entry(self) -> str:
        return str(self._data.get("entry", "") or "")

    @property
    def is_dirty(self) -> bool:
        return self._dirty

    # -- lifecycle ----------------------------------------------------------

    def load(self, data: dict[str, Any]) -> None:
        """Replace the entire backing dict (e.g. from file). Resets dirty."""
        self._data = copy.deepcopy(data)
        self._set_dirty(False)

    def load_empty(self) -> None:
        self._data = {}
        self._set_dirty(False)

    def replace_data(self, data: dict[str, Any]) -> None:
        """整体替换图数据（节点级撤销/重做用）。

        与 ``load`` 不同：**保持/标记脏态**（撤销回到与磁盘相同的内容也按脏处理，
        保存时字节基线比对仍会原样回写、不产生格式漂移），并且**就地更新** ``_data``
        以维持 ``mutable_data`` 活引用不失联。不逐节点发增删信号，调用方负责整体刷新 UI。
        """
        self._data.clear()
        self._data.update(copy.deepcopy(data))
        self.mark_dirty()

    # -- dirty tracking -----------------------------------------------------

    def mark_dirty(self) -> None:
        self._set_dirty(True)

    def set_dirty(self, dirty: bool) -> None:
        self._set_dirty(dirty)

    def _set_dirty(self, dirty: bool) -> None:
        if self._dirty != dirty:
            self._dirty = dirty
            self.dirty_changed.emit(dirty)

    # -- node mutations -----------------------------------------------------

    def set_node(self, nid: str, node_data: dict[str, Any]) -> None:
        """Replace entire node data for an existing node."""
        nodes = self._data.get("nodes")
        if not isinstance(nodes, dict) or nid not in nodes:
            return
        if nodes[nid] == node_data:
            return
        nodes[nid] = copy.deepcopy(node_data)
        self.node_changed.emit(nid)
        self.mark_dirty()

    def add_node(self, nid: str, node_data: dict[str, Any]) -> None:
        nodes = self._data.setdefault("nodes", {})
        nodes[nid] = copy.deepcopy(node_data)
        self.node_added.emit(nid)
        self.mark_dirty()

    def remove_node(self, nid: str) -> None:
        nodes = self._data.get("nodes")
        if not isinstance(nodes, dict) or nid not in nodes:
            return
        nodes.pop(nid)
        self.node_removed.emit(nid)
        self.mark_dirty()

    def remove_nodes(self, nids: list[str]) -> None:
        nodes = self._data.get("nodes")
        if not isinstance(nodes, dict):
            return
        removed = False
        for nid in nids:
            if nid in nodes:
                nodes.pop(nid)
                self.node_removed.emit(nid)
                removed = True
        if removed:
            self.mark_dirty()

    # -- graph-level mutations ----------------------------------------------

    def apply_meta_patch(
        self, patch: dict[str, Any], *, delete_keys: list[str] | None = None
    ) -> None:
        """Atomically apply top-level fields (id, entry, meta, preconditions, schemaVersion).

        仅在实际改变数据时才发 ``meta_changed`` 并标脏——空操作（如打开后校验回灌相同值）
        不会再误标脏。``delete_keys`` 用于忠实删除某个顶层键（如把缺省的 preconditions 保持缺省）。
        就地修改 ``_data``，不替换对象，避免持有 ``mutable_data`` 活引用的 UI 失联。
        """
        delete_keys = delete_keys or []
        changed = False
        for k, v in patch.items():
            if k not in self._data or self._data[k] != v:
                changed = True
                break
        if not changed:
            for k in delete_keys:
                if k in self._data:
                    changed = True
                    break
        if not changed:
            return
        self._data.update(copy.deepcopy(patch))
        for k in delete_keys:
            self._data.pop(k, None)
        self.meta_changed.emit()
        self.mark_dirty()

    def apply_graph_meta_fields(
        self,
        *,
        graph_id: str,
        entry: str,
        title: str,
        scenario_id: str,
        preconditions: list[Any],
        schema_version_present: bool,
        meta_present: bool,
        preconditions_present: bool,
    ) -> None:
        """把图级字段「忠实」回写顶层：这套「未改动即与磁盘字节一致」的表示规则集中在 model，
        不再散落在 UI（过去 `_widgets_to_data_meta` 内联，靠 widget 的 `_orig_*_present` 决策）。

        - ``schemaVersion``：原本存在才回写、且原样透传（不强制 int 化、缺省不凭空添加）；
        - ``meta``：在原 meta 上原地更新（保留已有键位置与额外键），空且原本缺省则删键、原本存在则保留 ``{}``；
        - ``preconditions``：非空写出；空则按原始表示（原本有键→``[]``，原本缺省→保持缺省删键）。

        ``*_present`` 为「载入时该键是否存在」的基线，由调用方（widget 载入时捕获、存盘后刷新）传入。
        """
        patch: dict[str, Any] = {}
        delete_keys: list[str] = []

        if schema_version_present:
            patch["schemaVersion"] = self._data.get("schemaVersion")
        patch["id"] = graph_id
        patch["entry"] = entry

        prev_meta = self._data.get("meta")
        meta: dict[str, Any] = dict(prev_meta) if isinstance(prev_meta, dict) else {}
        if title:
            meta["title"] = title
        elif "title" in meta:
            del meta["title"]
        if scenario_id:
            meta["scenarioId"] = scenario_id
        elif "scenarioId" in meta:
            del meta["scenarioId"]
        if meta:
            patch["meta"] = meta
        elif meta_present:
            patch["meta"] = {}
        else:
            delete_keys.append("meta")

        if preconditions:
            patch["preconditions"] = list(preconditions)
        elif preconditions_present:
            patch["preconditions"] = []
        else:
            delete_keys.append("preconditions")

        self.apply_meta_patch(patch, delete_keys=delete_keys)

    # -- topology mutations -------------------------------------------------

    def connect_output(
        self, src_id: str, kind: str, idx: int, dst_id: str
    ) -> str | None:
        """Connect an output port. Returns error string or *None* on success."""
        err = connect_output_to_target(self._data, src_id, kind, idx, dst_id)
        if err is None:
            self.topology_changed.emit(src_id)
            self.mark_dirty()
        return err

    def clear_output(self, src_id: str, kind: str, idx: int) -> str | None:
        err = _clear_output_impl(self._data, src_id, kind, idx)
        if err is None:
            self.topology_changed.emit(src_id)
            self.mark_dirty()
        return err

    def clear_incoming_to(self, target_id: str) -> None:
        affected_src_ids = sorted(
            {src_id for src_id, *_ in collect_incoming_refs(self._data, target_id)}
        )
        if not affected_src_ids:
            return
        clear_incoming_to_node(self._data, target_id)
        for src_id in affected_src_ids:
            self.topology_changed.emit(src_id)
        self.mark_dirty()

    # -- rename -------------------------------------------------------------

    def rename_node(self, old_id: str, new_id: str) -> str | None:
        affected_src_ids = sorted(
            {src_id for src_id, *_ in collect_incoming_refs(self._data, old_id)}
        )
        entry_changed = str(self._data.get("entry", "") or "") == old_id and old_id != new_id
        err = rename_node_id(self._data, old_id, new_id)
        if err:
            return err
        if old_id == new_id:
            return None
        self.node_removed.emit(old_id)
        self.node_added.emit(new_id)
        for src_id in affected_src_ids:
            self.topology_changed.emit(src_id)
        if entry_changed:
            self.meta_changed.emit()
        self.mark_dirty()
        return None
