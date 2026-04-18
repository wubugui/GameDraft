from __future__ import annotations

import asyncio
from typing import Awaitable, Callable, TypeVar

T = TypeVar("T")


async def gather_limited(
    coros: list[Callable[[], Awaitable[T]]],
    limit: int = 6,
) -> list[T]:
    sem = asyncio.Semaphore(limit)

    async def _run(c: Callable[[], Awaitable[T]]) -> T:
        async with sem:
            return await c()

    return await asyncio.gather(*(_run(c) for c in coros))
