"""Optional performance stamping for desktop editor hot paths."""

from __future__ import annotations

import os
import time
from contextlib import contextmanager
from datetime import datetime

_ENV_FLAG = "GAMEDRAFT_EDITOR_PERF_LOG"


def perf_log_enabled() -> bool:
    v = os.environ.get(_ENV_FLAG, "").strip().lower()
    return v in ("1", "true", "yes", "on")


class PerfClock:
    def __init__(self, *, label: str = "") -> None:
        self._label = label
        self._t0 = time.perf_counter()
        self._last = self._t0

    def stamp(self, msg: str) -> None:
        if not perf_log_enabled():
            return
        wall = datetime.now().strftime("%H:%M:%S.%f")[:-3]
        now = time.perf_counter()
        prefix = f"[Perf {wall}]"
        if self._label:
            prefix += f" {self._label}"
        print(f"{prefix} {msg}  d{now - self._last:.3f}s  s{now - self._t0:.3f}s", flush=True)
        self._last = now


def maybe_stamp(clock: PerfClock | None, msg: str) -> None:
    if clock is not None:
        clock.stamp(msg)


def gated_print(msg: str) -> None:
    if perf_log_enabled():
        print(msg, flush=True)


@contextmanager
def perf_span(label: str):
    """整块耗时段：开启 PERF 时打一个 start/end stamp（上下文管理器）。"""
    if not perf_log_enabled():
        yield None
        return
    ck = PerfClock(label=f"#{label}")
    ck.stamp("start")
    try:
        yield ck
    finally:
        ck.stamp("end")

