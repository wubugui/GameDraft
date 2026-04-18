"""httpx 异步请求：可重试状态码与传输错误。"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

import httpx

T = TypeVar("T")


async def sleep_backoff(attempt: int, base_sec: float) -> None:
    await asyncio.sleep(min(60.0, base_sec * (2**attempt)))


async def run_with_http_retry(
    op: Callable[[], Awaitable[T]],
    *,
    max_attempts: int,
    backoff_sec: float,
    label: str = "",
) -> T:
    last: Exception | None = None
    for attempt in range(max(1, max_attempts)):
        try:
            return await op()
        except httpx.HTTPStatusError as e:
            last = e
            code = e.response.status_code
            if code in (429, 502, 503, 504) and attempt < max_attempts - 1:
                await sleep_backoff(attempt, backoff_sec)
                continue
            raise
        except (httpx.ReadTimeout, httpx.WriteTimeout) as e:
            # 单次读/写已等到 httpx 的 read/write 上限；再重试只会连续「空等」数倍时间，
            # 易被误认为「云端推理极慢」或「没连上」。连接已建立时此处应直接失败并提示调整 chat_timeout_sec。
            raise
        except httpx.TimeoutException as e:
            # 连接握手、连接池等超时：可短 backoff 重试（每次 connect 上限较短）。
            last = e
            if attempt < max_attempts - 1:
                await sleep_backoff(attempt, backoff_sec)
                continue
            raise
        except (httpx.TransportError, httpx.NetworkError) as e:
            last = e
            if attempt < max_attempts - 1:
                await sleep_backoff(attempt, backoff_sec)
                continue
            raise
    assert last is not None
    raise last
