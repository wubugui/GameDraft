"""世界关系图：NetworkX 建图 + spring 布局（与 `rumor_nx` 共用 scale）。"""
from __future__ import annotations

from pathlib import Path

import networkx as nx

from tools.chronicle_sim_v2.core.world.seed_reader import read_social_graph
from tools.chronicle_sim_v2.gui.rumor_nx import NODE_R, build_draw_edges, scale_spring_layout

__all__ = [
    "NODE_R",
    "build_world_multidigraph",
    "classify_world_nodes",
    "node_display_labels",
    "scale_spring_layout",
    "build_draw_edges",
]


def build_world_multidigraph(run_dir: Path) -> nx.MultiDiGraph:
    """从 `world/relationships/graph.json` 建多重有向图；边属性含 rel_type、strength、edge_index、raw。"""
    G: nx.MultiDiGraph = nx.MultiDiGraph()
    edges = read_social_graph(run_dir)
    for i, e in enumerate(edges):
        if not isinstance(e, dict):
            continue
        u = str(e.get("from_agent_id", "")).strip()
        v = str(e.get("to_agent_id", "")).strip()
        if not u or not v:
            continue
        st = e.get("strength", 0.5)
        try:
            strength = float(st) if st is not None else 0.5
        except (TypeError, ValueError):
            strength = 0.5
        G.add_edge(
            u,
            v,
            key=i,
            edge_index=i,
            rel_type=str(e.get("rel_type", "") or ""),
            strength=strength,
            raw=e,
        )
    return G


def classify_world_nodes(
    run_dir: Path, node_ids: list[str]
) -> dict[str, str]:
    """将节点 id 分为 agent / faction / location / other。"""
    from tools.chronicle_sim_v2.core.world.seed_reader import (
        read_all_agents,
        read_all_factions,
        read_all_locations,
    )

    agents = {str(a.get("id", "")) for a in read_all_agents(run_dir) if a.get("id")}
    facs = {str(f.get("id", "")) for f in read_all_factions(run_dir) if f.get("id")}
    locs = {str(x.get("id", "")) for x in read_all_locations(run_dir) if x.get("id")}
    out: dict[str, str] = {}
    for nid in node_ids:
        if nid in agents:
            out[nid] = "agent"
        elif nid in facs:
            out[nid] = "faction"
        elif nid in locs:
            out[nid] = "location"
        else:
            out[nid] = "other"
    return out


def node_display_labels(run_dir: Path) -> dict[str, str]:
    """id -> 短显示名（用于节点圆内文字）。"""
    from tools.chronicle_sim_v2.core.world.seed_reader import (
        read_all_agents,
        read_all_factions,
        read_all_locations,
    )

    def short(s: str, lim: int = 14) -> str:
        return s if len(s) <= lim else s[: max(1, lim - 1)] + "…"

    lab: dict[str, str] = {}
    for a in read_all_agents(run_dir):
        aid = str(a.get("id", ""))
        if not aid:
            continue
        name = str(a.get("name", "") or "")
        lab[aid] = short(name or aid)
    for f in read_all_factions(run_dir):
        fid = str(f.get("id", ""))
        if not fid:
            continue
        name = str(f.get("name", "") or "")
        lab[fid] = short(name or fid, 10)
    for x in read_all_locations(run_dir):
        lid = str(x.get("id", ""))
        if not lid:
            continue
        name = str(x.get("name", "") or "")
        lab[lid] = short(name or lid, 10)
    return lab
