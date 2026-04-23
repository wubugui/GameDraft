"""AgentLimiter —— per-runner-kind 信号量。

不同 Runner 性质差异大：
- Cline 子进程：单实例（共享 .cline_config）→ cap=1
- SimpleChat：纯 HTTP → cap=4 默认
- ReAct：HTTP + 本地 tool 串行 → cap=2
- External：取决于实际工具，默认 cap=1
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

from tools.chronicle_sim_v3.agents.config import AgentLimiterConfig


class AgentLimiter:
    def __init__(self, cfg: AgentLimiterConfig) -> None:
        self._cfg = cfg
        self._sems: dict[str, asyncio.Semaphore] = {}
        self._lock = asyncio.Lock()

    async def _ensure(self, runner_kind: str) -> asyncio.Semaphore:
        if runner_kind in self._sems:
            return self._sems[runner_kind]
        async with self._lock:
            if runner_kind not in self._sems:
                cap = max(1, int(self._cfg.per_runner.get(runner_kind, 1)))
                self._sems[runner_kind] = asyncio.Semaphore(cap)
        return self._sems[runner_kind]

    @asynccontextmanager
    async def acquire(self, runner_kind: str):
        sem = await self._ensure(runner_kind)
        await sem.acquire()
        try:
            yield
        finally:
            sem.release()
