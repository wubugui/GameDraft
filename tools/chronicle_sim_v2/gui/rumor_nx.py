"""谣言拓扑：NetworkX 建图 + spring 布局，与官方 Qt+NetworkX 示例思路一致；供 QGraphics 与 SVG 共用。"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from html import escape as E
from pathlib import Path
from typing import Any

import networkx as nx
import numpy as np

from tools.chronicle_sim_v2.core.world.seed_reader import read_agent

WIDTH = 1100.0
HEIGHT = 780.0
MARGIN = 48.0
NODE_R = 28.0
PARALLEL_OFFSET = 7.0


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


def rumor_multidigraph_from_rows(rows: list[Any]) -> nx.MultiDiGraph:
    G: nx.MultiDiGraph = nx.MultiDiGraph()
    for i, r in enumerate(rows):
        if not isinstance(r, dict):
            continue
        u, v = str(r.get("teller_id", "")), str(r.get("hearer_id", ""))
        if not u or not v:
            continue
        G.add_edge(
            u,
            v,
            key=i,
            row_index=i,
            distorted=bool(r.get("distorted")),
            content=str(r.get("content", ""))[:800],
            event=str(r.get("originating_event_id", "")),
            hop=str(r.get("propagation_hop", "")),
        )
    return G


def scale_spring_layout(
    G: nx.Graph,
    width: float = WIDTH,
    height: float = HEIGHT,
    margin: float = MARGIN,
    seed: int = 42,
) -> dict[str, tuple[float, float]]:
    if len(G) == 0:
        return {}
    nodes = list(G.nodes())
    if len(nodes) == 1:
        return {nodes[0]: (width / 2, height / 2)}
    n = len(nodes)
    k = 2.0 / (n**0.5) if n > 1 else 1.0
    pos: dict[Any, np.ndarray] = nx.spring_layout(
        G, seed=seed, k=k, iterations=100, weight=None, dim=2
    )
    xs = [float(pos[v][0]) for v in nodes]
    ys = [float(pos[v][1]) for v in nodes]
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    spanx = max(maxx - minx, 0.1)
    spany = max(maxy - miny, 0.1)
    inner_w, inner_h = width - 2 * margin, height - 2 * margin
    out: dict[str, tuple[float, float]] = {}
    for v in nodes:
        px, py = float(pos[v][0]), float(pos[v][1])
        out[str(v)] = (
            margin + (px - minx) / spanx * inner_w,
            margin + (py - miny) / spany * inner_h,
        )
    return out


@dataclass(frozen=True)
class RumorDrawEdge:
    x1: float
    y1: float
    x2: float
    y2: float
    distorted: bool
    row_index: int


def _shorten_line(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    r1: float,
    r2: float,
) -> tuple[float, float, float, float]:
    dx, dy = x2 - x1, y2 - y1
    dist = float(np.hypot(dx, dy))
    if dist < 1e-6:
        return x1, y1, x2, y2
    ux, uy = dx / dist, dy / dist
    return (x1 + ux * r1, y1 + uy * r1, x2 - ux * r2, y2 - uy * r2)


def build_draw_edges(
    G: nx.MultiDiGraph, pos: dict[str, tuple[float, float]], node_r: float = NODE_R
) -> list[RumorDrawEdge]:
    out: list[RumorDrawEdge] = []
    pair_n: dict[tuple[str, str], int] = defaultdict(int)
    for u, v, k, d in G.edges(keys=True, data=True):
        if u not in pos or v not in pos:
            continue
        idx = pair_n[(u, v)]
        pair_n[(u, v)] += 1
        off = (idx) * PARALLEL_OFFSET
        x1, y1 = pos[u]
        x2, y2 = pos[v]
        dx, dy = x2 - x1, y2 - y1
        ln = float(np.hypot(dx, dy)) or 1.0
        px, py = -dy / ln, dx / ln
        sx1, sy1 = x1 + px * off, y1 + py * off
        sx2, sy2 = x2 + px * off, y2 + py * off
        sxe1, sye1, sxe2, sye2 = _shorten_line(sx1, sy1, sx2, sy2, node_r, node_r)
        out.append(
            RumorDrawEdge(
                sxe1,
                sye1,
                sxe2,
                sye2,
                bool(d.get("distorted")),
                int(d.get("row_index", -1)),
            )
        )
    return out


def build_rumor_graph_svg(run_dir: Path | None, rows: list[Any]) -> str:
    w, h = WIDTH, HEIGHT
    G = rumor_multidigraph_from_rows(
        [r for r in rows if isinstance(r, dict)]
    )
    if G.number_of_nodes() == 0:
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{int(w)}" height="{int(h)}"'
            f' viewBox="0 0 {w} {h}"><text x="40" y="40">（无节点）</text></svg>'
        )
    pos = scale_spring_layout(G, w, h)
    draw_edges = build_draw_edges(G, pos, NODE_R)

    parts: list[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{int(w)}" height="{int(h)}"'
        f' viewBox="0 0 {w} {h}">',
        '<rect width="100%" height="100%" fill="#fafafa"/>',
        '<defs><marker id="arr" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto">',
        '<path d="M0,0 L0,6 L7,3 z" fill="#4a5568"/></marker></defs>',
    ]
    for e in draw_edges:
        col = "#276749" if e.distorted else "#4a5568"
        wid = 2.5 if e.distorted else 2.0
        parts.append(
            f'<line x1="{e.x1:.1f}" y1="{e.y1:.1f}" x2="{e.x2:.1f}" y2="{e.y2:.1f}" '
            f'stroke="{col}" stroke-width="{wid}" marker-end="url(#arr)" opacity="0.92"/>'
        )
    for nid, (px, py) in pos.items():
        tip = E(_agent_tip(run_dir, str(nid)))
        lab = E(_label_short(str(nid)))
        parts.append(
            "<g>"
            f"<title>{tip}</title>"
            f'<circle cx="{px:.1f}" cy="{py:.1f}" r="22" fill="#ebf8ff" stroke="#2c5282" stroke-width="2.5"/>'
            f'<text x="{px:.1f}" y="{(py + 5):.1f}" text-anchor="middle" font-size="11" '
            f"font-family='Microsoft YaHei,sans-serif' fill='#1a365d'>{lab}</text>"
            "</g>"
        )
    parts.append("</svg>")
    return "".join(parts)
