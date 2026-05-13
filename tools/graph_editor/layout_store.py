"""持久化节点在画布上的坐标（按 node id）。"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class GraphLayoutStore:
    def __init__(self, path: Path):
        self.path = path
        self._positions: dict[str, tuple[float, float]] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            raw: Any = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        pos = raw.get("node_positions") or {}
        if not isinstance(pos, dict):
            return
        for k, v in pos.items():
            if not isinstance(v, dict):
                continue
            try:
                self._positions[str(k)] = (float(v["x"]), float(v["y"]))
            except (KeyError, TypeError, ValueError):
                continue

    def get_positions(self) -> dict[str, tuple[float, float]]:
        return dict(self._positions)

    def update_position(self, node_id: str, x: float, y: float) -> None:
        self._positions[node_id] = (x, y)

    def replace_all(self, positions: dict[str, tuple[float, float]]) -> None:
        self._positions = dict(positions)
        self.flush()

    def prune_unknown(self, valid_ids: set[str]) -> None:
        self._positions = {
            k: v for k, v in self._positions.items() if k in valid_ids
        }

    def flush(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "node_positions": {
                nid: {"x": xy[0], "y": xy[1]}
                for nid, xy in self._positions.items()
            },
        }
        self.path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
