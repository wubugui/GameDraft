"""Graph layout algorithms using networkx."""
import networkx as nx

from ..model.graph_model import GameGraph
from ..model.node_types import NodeType


def spring_layout(graph: GameGraph, scale: float = 800) -> dict[str, tuple[float, float]]:
    if len(graph.g.nodes) == 0:
        return {}
    pos = nx.spring_layout(graph.g, k=2.5, iterations=80, seed=42, scale=scale)
    return {nid: (float(xy[0]), float(xy[1])) for nid, xy in pos.items()}


def hierarchical_layout(graph: GameGraph, scale: float = 250) -> dict[str, tuple[float, float]]:
    """Layered layout for DAG-like graphs (quest chains)."""
    if len(graph.g.nodes) == 0:
        return {}

    try:
        layers = {}
        for node in nx.topological_sort(graph.g):
            preds = list(graph.g.predecessors(node))
            if not preds:
                layers[node] = 0
            else:
                layers[node] = max(layers.get(p, 0) for p in preds) + 1

        level_nodes: dict[int, list[str]] = {}
        for nid, lev in layers.items():
            level_nodes.setdefault(lev, []).append(nid)

        positions = {}
        for lev, nodes in level_nodes.items():
            for i, nid in enumerate(nodes):
                positions[nid] = (lev * scale, i * scale * 0.6)

        return positions
    except nx.NetworkXUnfeasible:
        return spring_layout(graph, scale)
