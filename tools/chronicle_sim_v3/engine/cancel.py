"""引擎层 CancelToken。

与 backend.base.CancelToken 同名同语义，但本文件不依赖 LLM 子系统；
LLMService 接收 backend.base.CancelToken，引擎接收本类，二者鸭子兼容。
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field


@dataclass
class CancelToken:
    _event: asyncio.Event = field(default_factory=asyncio.Event)

    def cancel(self) -> None:
        self._event.set()

    def is_set(self) -> bool:
        return self._event.is_set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    async def wait(self) -> None:
        await self._event.wait()
