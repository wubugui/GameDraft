"""Limiter：semaphore + qpm 漏桶。"""
from __future__ import annotations

import asyncio
import time

import pytest

from tools.chronicle_sim_v3.llm.config import load_llm_config_text
from tools.chronicle_sim_v3.llm.limiter import Limiter, TokenBucket


_BASE = """\
schema: chronicle_sim_v3/llm@1
models:
  a: {provider: stub_local, invocation: stub}
  b: {provider: stub_local, invocation: stub}
routes: {offline: a, embed: b}
concurrency:
  enabled: true
  max_inflight: 2
rate_limits:
  default: {qpm: 600}
  routes:
    offline: {qpm: 60}
"""


@pytest.mark.asyncio
async def test_concurrency_cap_respected() -> None:
    cfg = load_llm_config_text(_BASE)
    lim = Limiter(cfg)
    inflight = 0
    peak = 0
    lock = asyncio.Lock()

    async def task():
        nonlocal inflight, peak
        async with lim.acquire("offline", est_tokens=1):
            async with lock:
                inflight += 1
                peak = max(peak, inflight)
            await asyncio.sleep(0.05)
            async with lock:
                inflight -= 1

    await asyncio.gather(*(task() for _ in range(8)))
    assert peak <= 2


@pytest.mark.asyncio
async def test_concurrency_disabled_serializes() -> None:
    cfg_text = _BASE.replace("enabled: true", "enabled: false")
    cfg = load_llm_config_text(cfg_text)
    lim = Limiter(cfg)
    peak = 0
    inflight = 0
    lock = asyncio.Lock()

    async def task():
        nonlocal inflight, peak
        async with lim.acquire("offline", est_tokens=1):
            async with lock:
                inflight += 1
                peak = max(peak, inflight)
            await asyncio.sleep(0.02)
            async with lock:
                inflight -= 1

    await asyncio.gather(*(task() for _ in range(4)))
    assert peak == 1


@pytest.mark.asyncio
async def test_qpm_bucket_throttles() -> None:
    """qpm=60 → 1 req / sec；连发 3 次至少耗 1.5s。"""
    bucket = TokenBucket(capacity=2.0, refill_per_sec=1.0)
    # 桶初始已满 = 2 token；前 2 个 acquire 立即过；第 3 个等 1s
    t0 = time.monotonic()
    await bucket.acquire(1)
    await bucket.acquire(1)
    await bucket.acquire(1)
    elapsed = time.monotonic() - t0
    assert elapsed >= 0.7  # 留点裕度


@pytest.mark.asyncio
async def test_token_bucket_zero_capacity_passthrough() -> None:
    b = TokenBucket(capacity=0, refill_per_sec=0)
    t0 = time.monotonic()
    await b.acquire(99999)  # 容量 0 → 直接 return
    assert time.monotonic() - t0 < 0.05
