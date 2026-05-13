"""使用量统计 — RFC v3-llm.md §9。

按逻辑路由聚合 calls / tokens / latency / cache_hits。
持久化到 <run>/audit/llm/usage.json，每次 record 写一次（单 Run 下吞吐不大，
读写性能不是瓶颈；P5 GUI 聚合面板若需要可改 sqlite）。
"""
from __future__ import annotations

import threading
from dataclasses import dataclass, field
from pathlib import Path

from tools.chronicle_sim_v3.engine.io import atomic_write_json, read_json


@dataclass
class RouteStats:
    calls: int = 0
    cache_hits: int = 0
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms_total: int = 0
    errors: int = 0


@dataclass
class UsageStats:
    by_route: dict[str, RouteStats] = field(default_factory=dict)

    def record(
        self,
        route: str,
        *,
        tokens_in: int | None,
        tokens_out: int | None,
        latency_ms: int,
        cache_hit: bool,
        error: bool = False,
    ) -> None:
        s = self.by_route.setdefault(route, RouteStats())
        s.calls += 1
        if cache_hit:
            s.cache_hits += 1
        if tokens_in:
            s.tokens_in += int(tokens_in)
        if tokens_out:
            s.tokens_out += int(tokens_out)
        s.latency_ms_total += int(latency_ms)
        if error:
            s.errors += 1

    def to_dict(self) -> dict:
        return {
            "by_route": {
                k: {
                    "calls": v.calls,
                    "cache_hits": v.cache_hits,
                    "tokens_in": v.tokens_in,
                    "tokens_out": v.tokens_out,
                    "latency_ms_total": v.latency_ms_total,
                    "errors": v.errors,
                }
                for k, v in self.by_route.items()
            }
        }

    @classmethod
    def from_dict(cls, d: dict) -> "UsageStats":
        out = cls()
        for k, v in (d.get("by_route") or {}).items():
            out.by_route[k] = RouteStats(**v)
        return out


class UsageStore:
    """持久化包装。线程/进程安全粒度：每次 record 都全量重写（Run 内吞吐有限）。"""

    def __init__(self, run_dir: Path) -> None:
        self.path = Path(run_dir) / "audit" / "llm" / "usage.json"
        self._lock = threading.Lock()
        self._stats = self._load()

    def _load(self) -> UsageStats:
        if self.path.is_file():
            try:
                return UsageStats.from_dict(read_json(self.path))
            except Exception:
                pass
        return UsageStats()

    @property
    def stats(self) -> UsageStats:
        return self._stats

    def record(self, **kwargs) -> None:
        with self._lock:
            self._stats.record(**kwargs)
            atomic_write_json(self.path, self._stats.to_dict())
