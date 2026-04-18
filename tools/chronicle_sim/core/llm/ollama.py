from __future__ import annotations

from typing import Any

import httpx

from tools.chronicle_sim.core.llm.adapter import LLMAdapter, LLMResponse
from tools.chronicle_sim.core.llm.http_retry import run_with_http_retry


class OllamaAdapter(LLMAdapter):
    def __init__(
        self,
        host: str = "http://127.0.0.1:11434",
        default_model: str = "llama3",
        *,
        client_kwargs: dict[str, Any] | None = None,
        max_retries: int = 3,
        retry_backoff_sec: float = 1.0,
    ) -> None:
        self.host = host.rstrip("/")
        self.default_model = default_model
        self._max_retries = max(1, int(max_retries))
        self._retry_backoff_sec = float(retry_backoff_sec)
        opts: dict[str, Any] = {
            "timeout": httpx.Timeout(connect=30.0, read=300.0, write=300.0, pool=30.0),
            "trust_env": False,
        }
        if client_kwargs:
            opts.update(client_kwargs)
        opts["trust_env"] = False
        self._client = httpx.AsyncClient(**opts)

    async def close(self) -> None:
        await self._client.aclose()

    async def chat(
        self,
        messages: list[dict[str, str]],
        *,
        model: str | None = None,
        temperature: float = 0.7,
        json_schema: dict[str, Any] | None = None,
    ) -> LLMResponse:
        mid = model or self.default_model
        body: dict[str, Any] = {
            "model": mid,
            "messages": messages,
            "stream": False,
            "options": {"temperature": temperature},
        }
        if json_schema:
            body["format"] = "json"

        async def _post() -> LLMResponse:
            r = await self._client.post(f"{self.host}/api/chat", json=body)
            r.raise_for_status()
            data = r.json()
            text = data.get("message", {}).get("content", "") or ""
            return LLMResponse(text=text, raw=data)

        return await run_with_http_retry(
            _post,
            max_attempts=self._max_retries,
            backoff_sec=self._retry_backoff_sec,
        )
