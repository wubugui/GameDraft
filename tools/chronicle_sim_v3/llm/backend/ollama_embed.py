"""Ollama Embedding backend — 走 /api/embed。"""
from __future__ import annotations

import httpx

from tools.chronicle_sim_v3.llm.backend.base import CancelToken
from tools.chronicle_sim_v3.llm.errors import (
    LLMNetworkError,
    LLMServerError,
    LLMTimeoutError,
)
from tools.chronicle_sim_v3.llm.types import ResolvedModel


class OllamaEmbedBackend:
    name = "ollama_embed"

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client

    async def invoke(
        self,
        resolved: ResolvedModel,
        texts: list[str],
        timeout_sec: int,
        cancel: CancelToken,
    ) -> list[list[float]]:
        host = (resolved.base_url or "http://127.0.0.1:11434").rstrip("/")
        url = host + "/api/embed"
        client_owned = self._client is None
        client = self._client or httpx.AsyncClient(trust_env=False)
        out: list[list[float]] = []
        try:
            for t in texts:
                body = {"model": resolved.model_id, "input": t}
                try:
                    resp = await client.post(url, json=body, timeout=timeout_sec)
                except httpx.TimeoutException as e:
                    raise LLMTimeoutError(f"ollama embed 超时: {e}") from e
                except httpx.HTTPError as e:
                    raise LLMNetworkError(f"ollama embed 网络错误: {e}") from e
                if resp.status_code >= 500:
                    raise LLMServerError(f"ollama embed {resp.status_code}")
                data = resp.json()
                emb = data.get("embeddings") or [data.get("embedding") or []]
                if isinstance(emb[0], list):
                    out.extend(emb)
                else:
                    out.append(emb)  # type: ignore[arg-type]
        finally:
            if client_owned:
                await client.aclose()
        return out
