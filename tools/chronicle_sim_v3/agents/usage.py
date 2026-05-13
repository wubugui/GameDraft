"""AgentUsageStore —— 按 agent_id 聚合调用 / 缓存命中 / 总耗时。

不持久化（进程内统计）；CLI 可在 csim agent usage 打印。
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class AgentRouteStats:
    calls: int = 0
    cache_hits: int = 0
    errors: int = 0
    total_ms: int = 0
    llm_calls_total: int = 0


@dataclass
class AgentUsageStats:
    by_agent: dict[str, AgentRouteStats] = field(default_factory=dict)


class AgentUsageStore:
    def __init__(self) -> None:
        self.stats = AgentUsageStats()

    def record(
        self,
        *,
        physical: str,
        cache_hit: bool,
        latency_ms: int,
        error: bool = False,
        llm_calls: int | None = None,
    ) -> None:
        s = self.stats.by_agent.setdefault(physical, AgentRouteStats())
        s.calls += 1
        if cache_hit:
            s.cache_hits += 1
        if error:
            s.errors += 1
        s.total_ms += int(latency_ms)
        if llm_calls is not None:
            s.llm_calls_total += int(llm_calls)

    def snapshot(self) -> dict[str, dict]:
        """返回可 JSON 序列化的快照（CLI usage 用）。"""
        return {
            agent_id: {
                "calls": st.calls,
                "cache_hits": st.cache_hits,
                "errors": st.errors,
                "total_ms": st.total_ms,
                "llm_calls_total": st.llm_calls_total,
            }
            for agent_id, st in self.stats.by_agent.items()
        }
