from __future__ import annotations

import sqlite3
from collections import deque
from typing import Any


class SocialGraph:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def neighbors(self, agent_id: str) -> list[tuple[str, float, str]]:
        rows = self._conn.execute(
            """
            SELECT to_agent_id, strength * propagation_factor AS w, edge_type
            FROM social_graph_edges WHERE from_agent_id = ?
            UNION
            SELECT from_agent_id, strength * propagation_factor AS w, edge_type
            FROM social_graph_edges WHERE to_agent_id = ?
            """,
            (agent_id, agent_id),
        ).fetchall()
        return [(r[0], float(r[1]), r[2]) for r in rows]

    def bfs_paths(
        self,
        start: str,
        max_hops: int = 3,
    ) -> dict[str, tuple[int, list[str]]]:
        """返回可达节点 -> (跳数, 路径)。"""
        seen: dict[str, tuple[int, list[str]]] = {start: (0, [start])}
        q: deque[str] = deque([start])
        while q:
            cur = q.popleft()
            dist, path = seen[cur]
            if dist >= max_hops:
                continue
            for nb, _, _ in self.neighbors(cur):
                if nb in seen:
                    continue
                seen[nb] = (dist + 1, path + [nb])
                q.append(nb)
        return seen

    def load_edges_from_seed(self, edges: list[dict[str, Any]]) -> None:
        for e in edges:
            self._conn.execute(
                """
                INSERT INTO social_graph_edges (from_agent_id, to_agent_id, edge_type, strength, propagation_factor)
                VALUES (?,?,?,?,?)
                """,
                (
                    e["from_agent_id"],
                    e["to_agent_id"],
                    e.get("edge_type", "熟人"),
                    float(e.get("strength", 0.5)),
                    float(e.get("propagation_factor", 1.0)),
                ),
            )
