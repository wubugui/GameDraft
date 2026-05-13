"""世界关系图：NetworkX 布局 + WorldGraphNode / WorldGraphEdge。"""
from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QBrush, QColor, QPainter, QPen
from PySide6.QtWidgets import (
    QGraphicsRectItem,
    QGraphicsScene,
    QGraphicsTextItem,
    QGraphicsView,
)

from tools.chronicle_sim_v2.core.world.seed_reader import read_social_graph
from tools.chronicle_sim_v2.gui.world_graph_items import WorldGraphEdge, WorldGraphNode
from tools.chronicle_sim_v2.gui.world_graph_nx import (
    NODE_R,
    build_world_multidigraph,
    classify_world_nodes,
    node_display_labels,
    scale_spring_layout,
)


def _node_tooltip(run_dir: Path, node_id: str, kind: str) -> str:
    from tools.chronicle_sim_v2.core.world import seed_reader as sr

    if kind == "agent":
        ag = sr.read_agent(run_dir, node_id)
        if not ag:
            return node_id
        name = str(ag.get("name", "") or "")
        tier = ag.get("current_tier") or ag.get("tier") or ""
        t = f"{name}（{node_id}）" if name else node_id
        if tier:
            return f"{t}\n层级: {tier}"
        return t
    if kind == "faction":
        for f in sr.read_all_factions(run_dir):
            if str(f.get("id", "")) == node_id:
                n = str(f.get("name", "") or node_id)
                d = str(f.get("description", "") or "")
                return f"{n}\n{node_id}\n\n{d}" if d else f"{n}\n{node_id}"
    if kind == "location":
        for x in sr.read_all_locations(run_dir):
            if str(x.get("id", "")) == node_id:
                n = str(x.get("name", "") or node_id)
                d = str(x.get("description", "") or "")
                return f"{n}\n{node_id}\n\n{d}" if d else f"{n}\n{node_id}"
    return f"{node_id}\n（未在 agents/factions/locations 中登记，可能为别名或他类实体）"


def _edge_tip(d: dict[str, Any]) -> str:
    u = d.get("from_agent_id", "")
    v = d.get("to_agent_id", "")
    rt = d.get("rel_type", "")
    st = d.get("strength", "")
    return f"{u} → {v}\n关系: {rt}\n强度: {st}"


class WorldGraphView(QGraphicsView):
    """滚轮缩放、左键拖动画布；可拖动节点；点边高亮并发出边索引。Esc 取消高亮。"""

    world_edge_selected = Signal(int)

    SCENE_MARGIN = 48.0

    def __init__(self, parent: Any = None) -> None:
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        self.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
        self.setViewportUpdateMode(QGraphicsView.ViewportUpdateMode.FullViewportUpdate)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setBackgroundBrush(QBrush(QColor("#f0f4f8")))
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self._min_scale = 0.1
        self._max_scale = 16.0
        self._all_edges: list[WorldGraphEdge] = []
        self._run_dir: Path | None = None
        self._raw_edges: list[dict[str, Any]] = []

    def raw_edge_at(self, index: int) -> dict[str, Any] | None:
        if 0 <= index < len(self._raw_edges):
            return self._raw_edges[index]
        return None

    def clear_graph(self) -> None:
        self._scene.clear()
        self._all_edges.clear()
        self._raw_edges = []
        self.resetTransform()
        self._run_dir = None
        t = QGraphicsTextItem("（未加载世界数据）")
        t.setDefaultTextColor(QColor("#4a5568"))
        t.setPos(32, 32)
        self._scene.addItem(t)
        self._scene.setSceneRect(0, 0, 400, 100)
        self.fitInView(self._scene.sceneRect(), Qt.AspectRatioMode.KeepAspectRatio)

    def wheelEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        anchors = self.transformationAnchor()
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        delta = event.angleDelta().y()
        factor = 1.12 if delta > 0 else 1.0 / 1.12
        new_scale = self.transform().m11() * factor
        if new_scale < self._min_scale or new_scale > self._max_scale:
            self.setTransformationAnchor(anchors)
            event.ignore()
            return
        self.scale(factor, factor)
        self.setTransformationAnchor(anchors)
        event.accept()

    def mousePressEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        if event.button() == Qt.MouseButton.LeftButton:
            it = self.itemAt(event.position().toPoint())
            if it is not None and not isinstance(it, WorldGraphEdge):
                self._clear_edge_highlights()
        super().mousePressEvent(event)

    def _on_edge_clicked(self, edge_index: int) -> None:
        for e in self._all_edges:
            e.set_highlighted(e.edge_index() == edge_index)
        self.world_edge_selected.emit(edge_index)

    def _clear_edge_highlights(self) -> None:
        for e in self._all_edges:
            e.set_highlighted(False)

    def keyPressEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        if event.key() == Qt.Key.Key_Escape:
            self._clear_edge_highlights()
        super().keyPressEvent(event)

    def populate(self, run_dir: Path) -> None:
        self._run_dir = run_dir
        self._scene.clear()
        self._all_edges.clear()
        self.resetTransform()
        self._raw_edges = [e for e in read_social_graph(run_dir) if isinstance(e, dict)]

        G = build_world_multidigraph(run_dir)
        r = float(NODE_R)
        if G.number_of_nodes() == 0:
            t = QGraphicsTextItem("（无关系边：请检查 world/relationships/graph.json）")
            t.setDefaultTextColor(QColor("#4a5568"))
            t.setPos(40, 40)
            self._scene.addItem(t)
            self._scene.setSceneRect(0, 0, 520, 120)
            self.fitInView(self._scene.sceneRect(), Qt.AspectRatioMode.KeepAspectRatio)
            return

        pos = scale_spring_layout(G)
        labels = node_display_labels(run_dir)
        nids = [str(n) for n in G.nodes()]
        kinds = classify_world_nodes(run_dir, nids)
        node_map: dict[str, WorldGraphNode] = {}
        for n in G.nodes():
            s = str(n)
            p = pos[s]
            k = kinds.get(s, "other")
            short_label = labels.get(s) or (s if len(s) <= 14 else s[:13] + "…")
            tip = _node_tooltip(run_dir, s, k)
            node = WorldGraphNode(s, k, short_label, tip, r)
            node.setPos(p[0] - r, p[1] - r)
            self._scene.addItem(node)
            node_map[s] = node

        pair_n: dict[tuple[str, str], int] = defaultdict(int)
        for u, v, k, d in G.edges(keys=True, data=True):
            su, sv = str(u), str(v)
            if su not in node_map or sv not in node_map:
                continue
            idx = pair_n[(su, sv)]
            pair_n[(su, sv)] += 1
            nu, nv = node_map[su], node_map[sv]
            raw = d.get("raw")
            raw_d: dict[str, Any] = raw if isinstance(raw, dict) else {}
            eidx = int(d["edge_index"]) if "edge_index" in d else int(k)
            st = float(d.get("strength", 0.5) or 0.5)
            rtype = str(d.get("rel_type", "") or "")
            edge = WorldGraphEdge(
                nu,
                nv,
                edge_index=eidx,
                strength=st,
                rel_type=rtype,
                content_tip=_edge_tip(raw_d) if raw_d else f"{su} → {sv}",
                on_click=self._on_edge_clicked,
                offset_index=idx,
            )
            nu.add_edge(edge)
            nv.add_edge(edge)
            self._scene.addItem(edge)
            self._all_edges.append(edge)

        rect = self._scene.itemsBoundingRect()
        rect.adjust(
            -self.SCENE_MARGIN,
            -self.SCENE_MARGIN,
            self.SCENE_MARGIN,
            self.SCENE_MARGIN,
        )
        bg = QGraphicsRectItem(rect)
        bg.setBrush(QBrush(QColor("#fafafa")))
        bg.setPen(QPen(QColor("#e2e8f0"), 1))
        bg.setZValue(-100)
        self._scene.addItem(bg)
        self._scene.setSceneRect(rect)
        self.fitInView(rect, Qt.AspectRatioMode.KeepAspectRatio)
