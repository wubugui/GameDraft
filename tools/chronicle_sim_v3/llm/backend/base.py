"""Backend 协议（RFC v3-llm.md §5.1）。"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, runtime_checkable

from tools.chronicle_sim_v3.llm.types import OutputSpec, Prompt, ResolvedModel


@dataclass
class CancelToken:
    """简单取消令牌；asyncio 友好。"""

    _event: asyncio.Event = field(default_factory=asyncio.Event)

    def cancel(self) -> None:
        self._event.set()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    async def wait(self) -> None:
        await self._event.wait()


@dataclass
class BackendResult:
    """Backend 调用统一返回结构。"""

    text: str
    tool_log: list[dict] = field(default_factory=list)
    exit_code: int = 0
    timings: dict[str, int] = field(default_factory=dict)
    raw: dict | None = None
    workspace_archive: Path | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None


@runtime_checkable
class BackendObserver(Protocol):
    """Cline backend 用于把子进程 stderr 流式吐出来。"""

    def on_stderr_line(self, line: str) -> None: ...

    def on_phase(self, phase: str, detail: dict) -> None: ...


class NullObserver:
    def on_stderr_line(self, line: str) -> None:  # noqa: D401
        return None

    def on_phase(self, phase: str, detail: dict) -> None:
        return None


@runtime_checkable
class ChatBackend(Protocol):
    name: str

    async def invoke(
        self,
        resolved: ResolvedModel,
        prompt: Prompt,
        rendered_system: str,
        rendered_user: str,
        output: OutputSpec,
        timeout_sec: int,
        cancel: CancelToken,
        observer: BackendObserver,
    ) -> BackendResult: ...


@runtime_checkable
class EmbedBackend(Protocol):
    name: str

    async def invoke(
        self,
        resolved: ResolvedModel,
        texts: list[str],
        timeout_sec: int,
        cancel: CancelToken,
    ) -> list[list[float]]: ...
