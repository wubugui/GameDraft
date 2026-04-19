"""社交图操作：基于 JSON 文件（邻居、路径、传播目标）。"""
from __future__ import annotations

from collections import deque
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.world.fs import read_json, write_json


def load_graph(run_dir: Path) -> list[dict[str, Any]]:
    """加载社交图（边列表）。"""
    data = read_json(run_dir, "world/relationships/graph.json")
    return data if isinstance(data, list) else []


def save_graph(run_dir: Path, edges: list[dict[str, Any]]) -> None:
    """保存社交图。"""
    write_json(run_dir, "world/relationships/graph.json", edges)


def get_neighbors(run_dir: Path, agent_id: str) -> list[tuple[str, float, str]]:
    """获取邻居 [(neighbor_id, strength, edge_type)]。"""
    edges = load_graph(run_dir)
    result = []
    for e in edges:
        if e.get("from_agent_id") == agent_id:
            result.append((
                e.get("to_agent_id", ""),
                float(e.get("strength", 0.5)),
                e.get("edge_type", ""),
            ))
        if e.get("to_agent_id") == agent_id:
            result.append((
                e.get("from_agent_id", ""),
                float(e.get("strength", 0.5)),
                e.get("edge_type", ""),
            ))
    return result


def bfs_paths(
    run_dir: Path,
    start: str,
    max_hops: int = 2,
) -> dict[str, tuple[int, list[str]]]:
    """BFS 可达性：{target: (hops, path)}。"""
    edges = load_graph(run_dir)
    # 构建邻接表
    adj: dict[str, list[str]] = {}
    for e in edges:
        f, t = e.get("from_agent_id", ""), e.get("to_agent_id", "")
        if f and t:
            adj.setdefault(f, []).append(t)
            adj.setdefault(t, []).append(f)

    visited: dict[str, tuple[int, list[str]]] = {}
    queue: deque[tuple[str, list[str]]] = deque([(start, [start])])

    while queue:
        node, path = queue.popleft()
        hops = len(path) - 1
        if hops > max_hops:
            continue
        if node != start:
            if node not in visited or visited[node][0] > hops:
                visited[node] = (hops, path)
        for nb in adj.get(node, []):
            if nb not in set(visited.keys()) | {start}:
                if len(path) <= max_hops:
                    queue.append((nb, path + [nb]))

    return visited


def propagation_targets(
    run_dir: Path,
    source_id: str,
    depth: int = 2,
    holder_ids: set[str] | None = None,
) -> list[tuple[str, int]]:
    """获取谣言传播目标 [(target_id, hops)]。"""
    paths = bfs_paths(run_dir, source_id, max_hops=depth)
    result = []
    for target, (hops, _path) in paths.items():
        if holder_ids is None or target in holder_ids:
            result.append((target, hops))
    return sorted(result, key=lambda x: x[1])
