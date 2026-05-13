"""谣言传播图：NetworkX 布局 + QGraphicsObject 节点 + QGraphicsItem 边（Qt 官方 networkx 示例模式）。"""
from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

from PySide6.QtCore import QPointF, Qt, Signal
from PySide6.QtGui import QBrush, QColor, QPainter, QPen
from PySide6.QtWidgets import (
    QGraphicsRectItem,
    QGraphicsScene,
    QGraphicsTextItem,
    QGraphicsView,
)

from tools.chronicle_sim_v2.core.world.seed_reader import read_agent
from tools.chronicle_sim_v2.gui.rumor_graph_items import RumorGraphEdge, RumorGraphNode
from tools.chronicle_sim_v2.gui.rumor_nx import (
    NODE_R,
    rumor_multidigraph_from_rows,
    scale_spring_layout,
)


def _label_short(s: str, limit: int = 14) -> str:
    return s if len(s) <= limit else s[: max(1, limit - 1)] + "…"


def _agent_tip(run_dir: Path | None, agent_id: str) -> str:
    if not run_dir:
        return agent_id
    ag = read_agent(run_dir, agent_id)
    if not ag:
        return agent_id
    name = ag.get("name") or ""
    if name:
        return f"{name} ({agent_id})"
    return agent_id


def _edge_tooltip(d: dict[str, Any]) -> str:
    ev = d.get("event", "")
    hop = d.get("hop", "")
    c = d.get("content", "")
    ri = d.get("row_index", -1)
    dist = "走样" if d.get("distorted") else "未走样"
    return (
        f"记录 #{ri + 1}（{dist}）\n来源事件: {ev}\n跳数: {hop}\n\n{c}"
    )


class RumorGraphView(QGraphicsView):
    """滚轮缩放、左键拖动画布；点边时按 `originating_event_id` 高亮整条传播链的边与节点。"""

    rumor_row_selected = Signal(int)
    SCENE_MARGIN = 48.0

    def __init__(self, parent: Any = None) -> None:
        super().__init__(parent)
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        self.setRenderHint(QPainter.RenderHint.TextAntialiasing, True)
        self.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, True)
        self.setViewportUpdateMode(QGraphicsView.ViewportUpdateMode.FullViewportUpdate)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setBackgroundBrush(QBrush(QColor("#f0f4f8")))
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self._min_scale = 0.12
        self._max_scale = 14.0
        self._all_edges: list[RumorGraphEdge] = []
        self._rumor_node_map: dict[str, RumorGraphNode] = {}
        self._list_rows: list[dict[str, Any]] = []
        self._row_to_chain_key: dict[int, str] = {}
        self._chain_key_to_rows: dict[str, set[int]] = {}

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
            if it is not None and not isinstance(it, RumorGraphEdge):
                self._clear_edge_highlights()
        super().mousePressEvent(event)

    def _on_edge_clicked(self, row_index: int) -> None:
        key = self._row_to_chain_key.get(row_index, f"singleton:{row_index}")
        rows = self._chain_key_to_rows.get(key, {row_index})
        for e in self._all_edges:
            e.set_highlighted(e.row_index() in rows)
        involved: set[str] = set()
        for ri in rows:
            if 0 <= ri < len(self._list_rows):
                r = self._list_rows[ri]
                tu = str(r.get("teller_id", "") or "")
                hv = str(r.get("hearer_id", "") or "")
                if tu:
                    involved.add(tu)
                if hv:
                    involved.add(hv)
        for aid, node in self._rumor_node_map.items():
            node.set_chain_highlighted(aid in involved)
        self.rumor_row_selected.emit(row_index)

    def _clear_edge_highlights(self) -> None:
        for e in self._all_edges:
            e.set_highlighted(False)
        for n in self._rumor_node_map.values():
            n.set_chain_highlighted(False)

    def keyPressEvent(self, event) -> None:  # type: ignore[no-untyped-def]
        if event.key() == Qt.Key.Key_Escape:
            self._clear_edge_highlights()
        super().keyPressEvent(event)

    def populate(self, run_dir: Path | None, rows: list[Any]) -> None:
        self._scene.clear()
        self._all_edges.clear()
        self._rumor_node_map.clear()
        self._row_to_chain_key.clear()
        self._chain_key_to_rows.clear()
        self.resetTransform()
        list_rows = [r for r in rows if isinstance(r, dict)]
        self._list_rows = list_rows
        by_key: dict[str, set[int]] = defaultdict(set)
        for i, r in enumerate(list_rows):
            eid = str(r.get("originating_event_id", "") or "").strip()
            if eid:
                key = f"ev:{eid}"
            else:
                key = f"singleton:{i}"
            self._row_to_chain_key[i] = key
            by_key[key].add(i)
        self._chain_key_to_rows = {k: set(v) for k, v in by_key.items()}
        G = rumor_multidigraph_from_rows(list_rows)
        r = float(NODE_R)

        if G.number_of_nodes() == 0:
            t = QGraphicsTextItem("（无谣言节点）")
            t.setDefaultTextColor(QColor("#4a5568"))
            t.setPos(40, 40)
            self._scene.addItem(t)
            self._scene.setSceneRect(0, 0, 400, 120)
            self.fitInView(self._scene.sceneRect(), Qt.AspectRatioMode.KeepAspectRatio)
            return

        pos = scale_spring_layout(G)
        node_map: dict[str, RumorGraphNode] = {}
        for n in G.nodes():
            s = str(n)
            p = pos[s]
            node = RumorGraphNode(
                s,
                _label_short(s),
                _agent_tip(run_dir, s),
                r,
            )
            node.setPos(p[0] - r, p[1] - r)
            self._scene.addItem(node)
            node_map[s] = node
        self._rumor_node_map = node_map

        pair_n: dict[tuple[str, str], int] = defaultdict(int)
        for u, v, k, d in G.edges(keys=True, data=True):
            su, sv = str(u), str(v)
            if su not in node_map or sv not in node_map:
                continue
            idx = pair_n[(su, sv)]
            pair_n[(su, sv)] += 1
            nu, nv = node_map[su], node_map[sv]
            edge = RumorGraphEdge(
                nu,
                nv,
                row_index=int(d.get("row_index", 0)),
                distorted=bool(d.get("distorted")),
                offset_index=idx,
                content_tip=_edge_tooltip(d),
                on_click=self._on_edge_clicked,
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
