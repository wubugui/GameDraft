from __future__ import annotations

import asyncio
import traceback
from typing import Any

from PySide6.QtCore import QObject, QRunnable, Signal
from PySide6.QtWidgets import QProgressDialog


def close_qprogress_safely(progress: QProgressDialog) -> None:
    """程序化 reset/close 时暂时屏蔽信号，避免误触发 canceled（部分 Qt/Windows 组合会如此）。"""
    progress.blockSignals(True)
    try:
        progress.reset()
        progress.close()
    finally:
        progress.blockSignals(False)


class AsyncSignals(QObject):
    finished = Signal(object)
    error = Signal(str, str)
    cancelled = Signal()


class AsyncWorker(QRunnable):
    """单次 asyncio.run，不支持取消（短任务可用）。"""

    def __init__(self, coro: Any) -> None:
        super().__init__()
        self.coro = coro
        self.signals = AsyncSignals()

    def run(self) -> None:
        try:
            result = asyncio.run(self.coro)
            self.signals.finished.emit(result)
        except Exception as e:
            raw = (str(e) or "").strip()
            qual = type(e).__qualname__
            summary = f"{qual}: {raw}" if raw else f"{qual}（无文本说明，常见于请求超时或连接中断）"
            detail = traceback.format_exc()
            self.signals.error.emit(summary, detail)


class CancellableAsyncWorker(QRunnable):
    """在独立线程中跑事件循环，支持 request_cancel() 与任务 cancel。"""

    def __init__(self, coro: Any) -> None:
        super().__init__()
        self.coro = coro
        self.signals = AsyncSignals()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._task: asyncio.Task[Any] | None = None

    def run(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        try:
            task = loop.create_task(self.coro)
            self._task = task
            result = loop.run_until_complete(task)
            self.signals.finished.emit(result)
        except asyncio.CancelledError:
            self.signals.cancelled.emit()
        except Exception as e:
            raw = (str(e) or "").strip()
            qual = type(e).__qualname__
            summary = f"{qual}: {raw}" if raw else f"{qual}（无文本说明，常见于请求超时或连接中断）"
            detail = traceback.format_exc()
            self.signals.error.emit(summary, detail)
        finally:
            try:
                loop.run_until_complete(loop.shutdown_asyncgens())
            except Exception:
                pass
            loop.close()
            self._loop = None
            self._task = None

    def request_cancel(self) -> None:
        if self._loop is not None and self._task is not None and not self._task.done():
            self._loop.call_soon_threadsafe(self._task.cancel)
