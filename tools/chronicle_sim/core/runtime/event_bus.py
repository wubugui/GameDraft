from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Any, Awaitable, Callable, DefaultDict

BusHandler = Callable[[dict[str, Any]], Awaitable[None]]


class EventBus:
    """结构化事件总线（进程内）。"""

    def __init__(self) -> None:
        self._subs: DefaultDict[str, list[BusHandler]] = defaultdict(list)
        self._lock = asyncio.Lock()

    def subscribe(self, topic: str, handler: BusHandler) -> None:
        self._subs[topic].append(handler)

    async def publish(self, topic: str, payload: dict[str, Any]) -> None:
        async with self._lock:
            handlers = list(self._subs.get(topic, []))
        for h in handlers:
            await h(payload)
