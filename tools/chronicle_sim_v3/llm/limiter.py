"""并发与限流闸（RFC v3-llm.md §6）。

只对 LLM 做并发；上层无感。组件：
- 全局 asyncio.Semaphore（concurrency.enabled=False → 容量 1）
- 每 route 一只 qpm TokenBucket（按需懒构造）
- 每 route 一只 tpm TokenBucket（同上）

acquire 是 async context manager；只在退出时归还 semaphore，桶不归还（漏桶模型）。
"""
from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass

from tools.chronicle_sim_v3.llm.config import LLMConfig


@dataclass
class TokenBucket:
    capacity: float
    refill_per_sec: float
    tokens: float = 0.0
    last: float = 0.0

    def __post_init__(self) -> None:
        self.tokens = self.capacity
        self.last = time.monotonic()

    async def acquire(self, n: float) -> None:
        if self.capacity <= 0 or self.refill_per_sec <= 0:
            return
        if n > self.capacity:
            # 一次申请超过桶容量：先一次填满再扣 capacity；后续溢出无法表达，
            # 但 RFC §6.4 默认配置（qpm=60, tpm=200000）不会出现 token 一次申请超容量
            n = self.capacity
        while True:
            now = time.monotonic()
            self.tokens = min(
                self.capacity,
                self.tokens + (now - self.last) * self.refill_per_sec,
            )
            self.last = now
            if self.tokens >= n:
                self.tokens -= n
                return
            need = n - self.tokens
            wait = need / self.refill_per_sec
            await asyncio.sleep(wait)


def _qpm_bucket(qpm: int) -> TokenBucket:
    return TokenBucket(capacity=float(qpm), refill_per_sec=qpm / 60.0)


def _tpm_bucket(tpm: int) -> TokenBucket:
    return TokenBucket(capacity=float(tpm), refill_per_sec=tpm / 60.0)


class Limiter:
    def __init__(self, cfg: LLMConfig) -> None:
        self._cfg = cfg
        cap = cfg.concurrency.max_inflight if cfg.concurrency.enabled else 1
        self._gate = asyncio.Semaphore(cap)
        self._qpm: dict[str, TokenBucket] = {}
        self._tpm: dict[str, TokenBucket] = {}
        self._lock = asyncio.Lock()

    def _route_qpm(self, route: str) -> int | None:
        rl_routes = self._cfg.rate_limits.get("routes", {}) if self._cfg.rate_limits else {}
        rl_default = self._cfg.rate_limits.get("default", {}) if self._cfg.rate_limits else {}
        return rl_routes.get(route, {}).get("qpm") or rl_default.get("qpm")

    def _route_tpm(self, route: str) -> int | None:
        rl_routes = self._cfg.rate_limits.get("routes", {}) if self._cfg.rate_limits else {}
        rl_default = self._cfg.rate_limits.get("default", {}) if self._cfg.rate_limits else {}
        return rl_routes.get(route, {}).get("tpm") or rl_default.get("tpm")

    async def _ensure_buckets(self, route: str) -> None:
        async with self._lock:
            if route not in self._qpm:
                qpm = self._route_qpm(route)
                if qpm:
                    self._qpm[route] = _qpm_bucket(int(qpm))
            if route not in self._tpm:
                tpm = self._route_tpm(route)
                if tpm:
                    self._tpm[route] = _tpm_bucket(int(tpm))

    @asynccontextmanager
    async def acquire(self, route: str, est_tokens: int = 0):
        await self._gate.acquire()
        try:
            await self._ensure_buckets(route)
            if route in self._qpm:
                await self._qpm[route].acquire(1)
            if est_tokens and route in self._tpm:
                await self._tpm[route].acquire(est_tokens)
            yield
        finally:
            self._gate.release()


def estimate_tokens_chars(rendered: str) -> int:
    """RFC §6.3 简单估算：字符数 / 2。中文 1 char ≈ 1.5 token，
    英文 1 word ≈ 1.3 token，平均下来字符数 / 2 偏保守。
    """
    return max(1, len(rendered) // 2)
