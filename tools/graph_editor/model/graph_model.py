import networkx as nx

from .node_types import NodeData, NodeType
from .edge_types import EdgeType


class GameGraph:
    """Unified graph holding all game entities and their relationships."""

    def __init__(self):
        self.g = nx.DiGraph()

    def clear(self):
        self.g.clear()

    def add_node(self, nd: NodeData):
        self.g.add_node(nd.id, nd=nd)

    def get_node(self, node_id: str) -> NodeData | None:
        if node_id in self.g.nodes:
            return self.g.nodes[node_id].get("nd")
        return None

    def add_edge(self, src: str, dst: str, edge_type: EdgeType, label: str = ""):
        self.g.add_edge(src, dst, edge_type=edge_type, label=label)

    def nodes_by_type(self, nt: NodeType) -> list[NodeData]:
        return [
            d["nd"] for _, d in self.g.nodes(data=True)
            if d.get("nd") and d["nd"].node_type == nt
        ]

    def all_nodes(self) -> list[NodeData]:
        return [d["nd"] for _, d in self.g.nodes(data=True) if d.get("nd")]

    def neighbors_of(self, node_id: str) -> set[str]:
        result: set[str] = set()
        if node_id in self.g:
            result.update(self.g.successors(node_id))
            result.update(self.g.predecessors(node_id))
        return result

    def edges_of(self, node_id: str) -> list[tuple[str, str, dict]]:
        result = []
        if node_id in self.g:
            for u, v, d in self.g.edges(data=True):
                if u == node_id or v == node_id:
                    result.append((u, v, d))
        return result

    def all_edges(self) -> list[tuple[str, str, dict]]:
        return list(self.g.edges(data=True))

    def subgraph_by_types(self, node_types: set[NodeType]) -> "GameGraph":
        sub = GameGraph()
        for nid, d in self.g.nodes(data=True):
            nd = d.get("nd")
            if nd and nd.node_type in node_types:
                sub.add_node(nd)
        for u, v, d in self.g.edges(data=True):
            if u in sub.g and v in sub.g:
                sub.g.add_edge(u, v, **d)
        return sub

    def subgraph_with_neighbors(self, root_types: set[NodeType]) -> "GameGraph":
        """Get subgraph of root_types plus all directly connected nodes."""
        root_ids = set()
        for nid, d in self.g.nodes(data=True):
            nd = d.get("nd")
            if nd and nd.node_type in root_types:
                root_ids.add(nid)

        all_ids = set(root_ids)
        for rid in root_ids:
            all_ids.update(self.neighbors_of(rid))

        sub = GameGraph()
        for nid in all_ids:
            nd = self.get_node(nid)
            if nd:
                sub.add_node(nd)
        for u, v, d in self.g.edges(data=True):
            if u in sub.g and v in sub.g:
                sub.g.add_edge(u, v, **d)
        return sub

    def flag_writers(self, flag_id: str) -> list[str]:
        writers = []
        for u, v, d in self.g.in_edges(flag_id, data=True):
            if d.get("edge_type") == EdgeType.WRITES_FLAG:
                writers.append(u)
        return writers

    def flag_readers(self, flag_id: str) -> list[str]:
        readers = []
        for u, v, d in self.g.out_edges(flag_id, data=True):
            if d.get("edge_type") == EdgeType.READS_FLAG:
                readers.append(v)
        return readers

    def dialogue_subgraph(self, ink_basename: str) -> "GameGraph":
        """Extract subgraph for a specific ink file, plus connected external entities."""
        knot_ids = set()
        for nd in self.nodes_by_type(NodeType.DIALOGUE_KNOT):
            if nd.data.get("file") == ink_basename:
                knot_ids.add(nd.id)

        all_ids = set(knot_ids)
        for kid in knot_ids:
            all_ids.update(self.neighbors_of(kid))

        sub = GameGraph()
        for nid in all_ids:
            nd = self.get_node(nid)
            if nd:
                sub.add_node(nd)
        for u, v, d in self.g.edges(data=True):
            if u in sub.g and v in sub.g:
                sub.g.add_edge(u, v, **d)
        return sub

    def diagnostics(self) -> dict:
        write_only = []
        read_only = []
        orphaned = []

        for nd in self.nodes_by_type(NodeType.FLAG):
            writers = self.flag_writers(nd.id)
            readers = self.flag_readers(nd.id)
            if writers and not readers:
                write_only.append(nd.id)
            elif readers and not writers:
                read_only.append(nd.id)

        for nd in self.all_nodes():
            if self.g.degree(nd.id) == 0:
                orphaned.append(nd.id)

        return {
            "write_only_flags": write_only,
            "read_only_flags": read_only,
            "orphaned_nodes": orphaned,
        }
