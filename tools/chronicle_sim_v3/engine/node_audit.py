"""节点级审计 — `<run>/audit/nodes/<YYYYMMDD>.jsonl`（RFC §11.3）。

由 Engine 在每个节点完成时统一写。
"""
from __future__ import annotations

import datetime as _dt
import json
import threading
from pathlib import Path
from typing import Any


def _utcnow() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)


class NodeAuditWriter:
    def __init__(self, run_dir: Path, enabled: bool = True) -> None:
        self.run_dir = Path(run_dir)
        self.enabled = enabled
        self._lock = threading.Lock()

    def _today_path(self) -> Path:
        day = _utcnow().strftime("%Y%m%d")
        return self.run_dir / "audit" / "nodes" / f"{day}.jsonl"

    def write(
        self,
        *,
        cook_id: str,
        node_id: str,
        node_kind: str,
        node_version: str,
        status: str,
        duration_ms: int,
        in_hash: str,
        out_hash: str,
        cache_hit: bool,
        mutations_count: int,
        error: str | None = None,
    ) -> None:
        if not self.enabled:
            return
        body = {
            "ts": _utcnow().isoformat() + "Z",
            "cook_id": cook_id,
            "node_id": node_id,
            "node_kind": node_kind,
            "node_version": node_version,
            "status": status,
            "duration_ms": duration_ms,
            "in_hash": in_hash,
            "out_hash": out_hash,
            "cache_hit": cache_hit,
            "mutations_count": mutations_count,
            "error": error,
        }
        p = self._today_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(body, ensure_ascii=False, sort_keys=True)
        with self._lock:
            with open(p, "a", encoding="utf-8", newline="\n") as f:
                f.write(line + "\n")
