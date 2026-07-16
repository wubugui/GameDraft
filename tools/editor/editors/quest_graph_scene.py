"""QGraphicsScene subclass for hierarchical quest graph visualization."""
from __future__ import annotations

import re
from collections import defaultdict

from PySide6.QtWidgets import QGraphicsScene
from PySide6.QtCore import Signal

from .quest_graph_items import QuestGroupItem, QuestNodeItem, QuestEdgeItem
from .quest_graph_layout_store import QuestGraphLayoutStore

_QUEST_STATUS_RE = re.compile(r"^quest_(.+)_status$")


def _hierarchical_layout(
    node_ids: list[str],
    edges: list[tuple[str, str]],
    h_spacing: float = 200,
    v_spacing: float = 120,
) -> dict[str, tuple[float, float]]:
    if not node_ids:
        return {}

    adj: dict[str, list[str]] = defaultdict(list)
    in_deg: dict[str, int] = {nid: 0 for nid in node_ids}
    id_set = set(node_ids)
    for src, dst in edges:
        if src in id_set and dst in id_set:
            adj[src].append(dst)
            in_deg[dst] = in_deg.get(dst, 0) + 1

    layers: dict[str, int] = {}
    queue = [nid for nid in node_ids if in_deg.get(nid, 0) == 0]
    if not queue:
        queue = [node_ids[0]]
    for nid in queue:
        if nid not in layers:
            layers[nid] = 0

    processed: set[str] = set()
    while queue:
        cur = queue.pop(0)
        if cur in processed:
            continue
        processed.add(cur)
        for nxt in adj.get(cur, []):
            layers[nxt] = max(layers.get(nxt, 0), layers[cur] + 1)
            if nxt not in processed:
                queue.append(nxt)

    for nid in node_ids:
        if nid not in layers:
            layers[nid] = 0

    level_nodes: dict[int, list[str]] = defaultdict(list)
    for nid, lev in layers.items():
        level_nodes[lev].append(nid)

    positions: dict[str, tuple[float, float]] = {}
    for lev, nodes in level_nodes.items():
        total_h = (len(nodes) - 1) * v_spacing
        start_y = -total_h / 2
        for i, nid in enumerate(nodes):
            positions[nid] = (lev * h_spacing, start_y + i * v_spacing)

    return positions


class QuestGraphScene(QGraphicsScene):
    node_selected = Signal(str)
    group_drilldown = Signal(str)
    edge_selected = Signal(str, str)
    nothing_selected = Signal()

    def __init__(self, parent=None, layout_store: QuestGraphLayoutStore | None = None):
        super().__init__(parent)
        self._node_items: dict[str, QuestGroupItem | QuestNodeItem] = {}
        self._edge_items: list[QuestEdgeItem] = []
        self._current_mode: str = "top"
        # 编辑器侧档：节点手动坐标持久化（绝不写游戏数据）。缺省给一个无工程的空 store。
        self._layout_store: QuestGraphLayoutStore = (
            layout_store if layout_store is not None else QuestGraphLayoutStore(None)
        )
        # 当前视图的「分组前缀」，群视图为分组 id，顶层为 ""。
        self._scope_group: str = ""

    def set_layout_store(self, store: QuestGraphLayoutStore) -> None:
        self._layout_store = store

    # ---- 侧档键命名 -------------------------------------------------------
    @staticmethod
    def _top_key(node_id: str) -> str:
        return f"top::{node_id}"

    def _group_key(self, node_id: str) -> str:
        return f"grp::{self._scope_group}::{node_id}"

    def _attach_layout(self, item, key: str) -> None:
        """给节点装上侧档键 + 拖拽结束回调，并用已保存坐标覆盖自动布局。"""
        item.layout_key = key
        item.on_moved = self._on_node_moved
        saved = self._layout_store.get(key)
        if saved is not None:
            item.setPos(saved[0], saved[1])
        # 落盘门控基线：release 时与它比较，纯点击（位置未变）不写侧档，
        # 防自动布局坐标被点选钉进侧档（审查 P0-1 ②）。
        item.layout_baseline = (float(item.pos().x()), float(item.pos().y()))

    def _on_node_moved(self, key: str, x: float, y: float) -> None:
        valid = {
            getattr(it, "layout_key", None)
            for it in self._node_items.values()
        }
        valid.discard(None)
        self._layout_store.set(key, x, y, valid_keys=valid)

    def populate_top_level(self, groups: list[dict], quests: list[dict]) -> None:
        self.clear()
        self._node_items.clear()
        self._edge_items.clear()
        self._current_mode = "top"
        self._scope_group = ""

        group_quest_count: dict[str, int] = defaultdict(int)
        for q in quests:
            grp = q.get("group", "")
            if grp:
                group_quest_count[grp] += 1

        group_ids = [g["id"] for g in groups]
        top_groups = [g for g in groups if not g.get("parentGroup")]

        cross_edges: list[tuple[str, str, list[dict]]] = []
        for q in quests:
            src_grp = q.get("group", "")
            for edge in q.get("nextQuests", []):
                dst_id = edge.get("questId", "")
                dst_q = next((qq for qq in quests if qq["id"] == dst_id), None)
                if dst_q:
                    dst_grp = dst_q.get("group", "")
                    if src_grp and dst_grp and src_grp != dst_grp:
                        cross_edges.append((src_grp, dst_grp, edge.get("conditions", [])))

        layout_edges = [(s, d) for s, d, _ in cross_edges]
        child_groups: dict[str, list[dict]] = defaultdict(list)
        for g in groups:
            pg = g.get("parentGroup")
            if pg:
                child_groups[pg].append(g)

        all_top_ids = [g["id"] for g in top_groups]
        positions = _hierarchical_layout(all_top_ids, layout_edges)

        for g in top_groups:
            gid = g["id"]
            count = group_quest_count.get(gid, 0)
            for cg in child_groups.get(gid, []):
                count += group_quest_count.get(cg["id"], 0)
            x, y = positions.get(gid, (0, 0))
            item = QuestGroupItem(g, count, x, y)
            self._attach_layout(item, self._top_key(gid))
            self._node_items[gid] = item
            self.addItem(item)

        seen_cross: set[tuple[str, str]] = set()
        for src_grp, dst_grp, conds in cross_edges:
            key = (src_grp, dst_grp)
            if key in seen_cross:
                continue
            seen_cross.add(key)
            src_item = self._node_items.get(src_grp)
            dst_item = self._node_items.get(dst_grp)
            if src_item and dst_item:
                ei = QuestEdgeItem(src_item, dst_item, conds)
                self._edge_items.append(ei)
                self.addItem(ei)

        implicit = self._compute_cross_group_implicit(quests, groups)
        for src_grp, dst_grp in implicit:
            if (src_grp, dst_grp) in seen_cross:
                continue
            seen_cross.add((src_grp, dst_grp))
            src_item = self._node_items.get(src_grp)
            dst_item = self._node_items.get(dst_grp)
            if src_item and dst_item:
                ei = QuestEdgeItem(src_item, dst_item, implicit=True)
                self._edge_items.append(ei)
                self.addItem(ei)

    def populate_group(self, group_id: str, quests: list[dict], groups: list[dict]) -> None:
        self.clear()
        self._node_items.clear()
        self._edge_items.clear()
        self._current_mode = "group"
        self._scope_group = group_id

        group_quests = [q for q in quests if q.get("group") == group_id]
        child_groups = [g for g in groups if g.get("parentGroup") == group_id]

        quest_ids_in_group = {q["id"] for q in group_quests}
        edges_for_layout: list[tuple[str, str]] = []
        edge_data: list[tuple[str, str, list[dict], bool]] = []

        for q in group_quests:
            for edge in q.get("nextQuests", []):
                dst = edge.get("questId", "")
                if dst in quest_ids_in_group:
                    edges_for_layout.append((q["id"], dst))
                    edge_data.append((
                        q["id"], dst,
                        edge.get("conditions", []),
                        bool(edge.get("bypassPreconditions")),
                    ))

        all_node_ids = [q["id"] for q in group_quests]
        positions = _hierarchical_layout(all_node_ids, edges_for_layout)

        for q in group_quests:
            qid = q["id"]
            x, y = positions.get(qid, (0, 0))
            item = QuestNodeItem(q, x, y)
            self._attach_layout(item, self._group_key(qid))
            self._node_items[qid] = item
            self.addItem(item)

        child_group_ids = [cg["id"] for cg in child_groups]
        cg_positions = _hierarchical_layout(
            child_group_ids, [],
            h_spacing=200, v_spacing=130,
        )
        max_x = max((p[0] for p in positions.values()), default=0) + 250
        for cg in child_groups:
            cgid = cg["id"]
            count = sum(1 for qq in quests if qq.get("group") == cgid)
            cx, cy = cg_positions.get(cgid, (0, 0))
            item = QuestGroupItem(cg, count, max_x + cx, cy)
            self._attach_layout(item, self._group_key(cgid))
            self._node_items[cgid] = item
            self.addItem(item)

        for src_id, dst_id, conds, bypass in edge_data:
            src_item = self._node_items.get(src_id)
            dst_item = self._node_items.get(dst_id)
            if src_item and dst_item:
                ei = QuestEdgeItem(src_item, dst_item, conds, bypass=bypass)
                self._edge_items.append(ei)
                self.addItem(ei)

        implicit = self._compute_implicit_edges(group_quests)
        explicit_pairs = {(s, d) for s, d, _, _ in edge_data}
        for src_id, dst_id in implicit:
            if (src_id, dst_id) in explicit_pairs:
                continue
            src_item = self._node_items.get(src_id)
            dst_item = self._node_items.get(dst_id)
            if src_item and dst_item:
                ei = QuestEdgeItem(src_item, dst_item, implicit=True)
                self._edge_items.append(ei)
                self.addItem(ei)

    def _compute_implicit_edges(self, quests: list[dict]) -> list[tuple[str, str]]:
        quest_map = {q["id"]: q for q in quests}
        result: list[tuple[str, str]] = []
        for q in quests:
            for cond in q.get("preconditions", []):
                flag = cond.get("flag", "")
                m = _QUEST_STATUS_RE.match(flag)
                if m:
                    src_qid = m.group(1)
                    if src_qid in quest_map and src_qid != q["id"]:
                        result.append((src_qid, q["id"]))
        return result

    def _compute_cross_group_implicit(
        self, quests: list[dict], groups: list[dict],
    ) -> list[tuple[str, str]]:
        quest_group_map = {q["id"]: q.get("group", "") for q in quests}
        result: list[tuple[str, str]] = []
        for q in quests:
            dst_grp = q.get("group", "")
            for cond in q.get("preconditions", []):
                flag = cond.get("flag", "")
                m = _QUEST_STATUS_RE.match(flag)
                if m:
                    src_qid = m.group(1)
                    src_grp = quest_group_map.get(src_qid, "")
                    if src_grp and dst_grp and src_grp != dst_grp:
                        result.append((src_grp, dst_grp))
        return result

    def highlight_node(self, node_id: str | None) -> None:
        for ni in self._node_items.values():
            ni.set_highlight(False)
        for ei in self._edge_items:
            ei.set_highlight(False)

        if node_id is None:
            self.nothing_selected.emit()
            return

        target = self._node_items.get(node_id)
        if not target:
            return
        target.set_highlight(True)

        for ei in self._edge_items:
            src_id = self._item_id(ei.src_item)
            dst_id = self._item_id(ei.dst_item)
            if src_id == node_id or dst_id == node_id:
                ei.set_highlight(True)

        self.node_selected.emit(node_id)

    @staticmethod
    def _item_id(item: QuestGroupItem | QuestNodeItem) -> str:
        if isinstance(item, QuestGroupItem):
            return item.group_data.get("id", "")
        return item.quest_data.get("id", "")
