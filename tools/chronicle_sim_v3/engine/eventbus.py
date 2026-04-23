"""EventBus 与 CookEvent 枚举（RFC v3-engine.md §11）。

设计：
- 多 sink 解耦：CLI 写 timeline.jsonl + 终端打印；GUI 订阅刷新徽标；测试断言
- emit 是同步无副作用方法，每个 sink 独立异常隔离（一个崩了不影响其它）
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Callable


class CookEvent(str, Enum):
    cook_start = "cook.start"
    cook_end = "cook.end"
    node_ready = "node.ready"
    node_start = "node.start"
    node_end = "node.end"
    node_failed = "node.failed"
    node_cancelled = "node.cancelled"
    node_cache_hit = "node.cache_hit"
    mutation_commit = "mutation.commit"
    llm_call = "llm.call"
    llm_done = "llm.done"
    custom = "custom"


@dataclass
class SubscriptionHandle:
    bus: "EventBus"
    cb: Callable[[dict], None]

    def unsubscribe(self) -> None:
        self.bus._cbs.discard(self.cb)


class EventBus:
    """同步 emit；多 sink；sink 异常吞掉避免影响主循环。"""

    def __init__(self) -> None:
        self._cbs: set[Callable[[dict], None]] = set()

    def subscribe(self, cb: Callable[[dict], None]) -> SubscriptionHandle:
        self._cbs.add(cb)
        return SubscriptionHandle(self, cb)

    def emit(self, event: dict) -> None:
        for cb in list(self._cbs):
            try:
                cb(event)
            except Exception:
                pass
