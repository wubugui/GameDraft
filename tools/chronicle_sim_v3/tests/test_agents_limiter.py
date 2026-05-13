"""AgentLimiter: per-runner-kind 信号量上限 + 不同 kind 互不阻塞。"""
from __future__ import annotations

import asyncio

import pytest

from tools.chronicle_sim_v3.agents.config import AgentLimiterConfig
from tools.chronicle_sim_v3.agents.limiter import AgentLimiter


@pytest.mark.asyncio
async def test_per_runner_cap_respected() -> None:
    lim = AgentLimiter(AgentLimiterConfig(per_runner={"cline": 2}))
    inflight = 0
    peak = 0
    lock = asyncio.Lock()

    async def task() -> None:
        nonlocal inflight, peak
        async with lim.acquire("cline"):
            async with lock:
                inflight += 1
                peak = max(peak, inflight)
            await asyncio.sleep(0.05)
            async with lock:
                inflight -= 1

    await asyncio.gather(*(task() for _ in range(8)))
    assert peak <= 2


@pytest.mark.asyncio
async def test_different_kinds_independent() -> None:
    """cline / simple_chat 的信号量互相独立。"""
    lim = AgentLimiter(AgentLimiterConfig(per_runner={"cline": 1, "simple_chat": 1}))
    started = []
    finish_event = asyncio.Event()

    async def hold(kind: str) -> None:
        async with lim.acquire(kind):
            started.append(kind)
            await finish_event.wait()

    t1 = asyncio.create_task(hold("cline"))
    t2 = asyncio.create_task(hold("simple_chat"))
    for _ in range(50):
        if len(started) >= 2:
            break
        await asyncio.sleep(0.01)
    assert sorted(started) == ["cline", "simple_chat"]
    finish_event.set()
    await asyncio.gather(t1, t2)


@pytest.mark.asyncio
async def test_unknown_kind_defaults_to_cap_1() -> None:
    """配置里未列出的 runner_kind 退化为 cap=1。"""
    lim = AgentLimiter(AgentLimiterConfig(per_runner={"cline": 5}))
    inflight = 0
    peak = 0
    lock = asyncio.Lock()

    async def task() -> None:
        nonlocal inflight, peak
        async with lim.acquire("brand_new_runner"):
            async with lock:
                inflight += 1
                peak = max(peak, inflight)
            await asyncio.sleep(0.03)
            async with lock:
                inflight -= 1

    await asyncio.gather(*(task() for _ in range(4)))
    assert peak == 1


@pytest.mark.asyncio
async def test_zero_or_negative_cap_promoted_to_one() -> None:
    """配 cap=0 不应导致死锁；实现把它提升到 1。"""
    lim = AgentLimiter(AgentLimiterConfig(per_runner={"cline": 0}))
    counter = 0

    async def go() -> None:
        nonlocal counter
        async with lim.acquire("cline"):
            counter += 1

    await asyncio.gather(*(go() for _ in range(5)))
    assert counter == 5
