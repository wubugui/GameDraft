"""OpenAI 兼容 Embedding backend — DashScope 单批 ≤10。"""
from __future__ import annotations

import httpx

from tools.chronicle_sim_v3.llm.backend.base import CancelToken
from tools.chronicle_sim_v3.llm.errors import (
    LLMAuthError,
    LLMBadRequestError,
    LLMNetworkError,
    LLMRateLimitError,
    LLMServerError,
    LLMTimeoutError,
)
from tools.chronicle_sim_v3.llm.types import ResolvedModel


_BATCH = 10


class OpenAICompatEmbedBackend:
    name = "openai_compat_embed"

    def __init__(self, client: httpx.AsyncClient | None = None, batch: int = _BATCH) -> None:
        self._client = client
        self._batch = batch

    async def invoke(
        self,
        resolved: ResolvedModel,
        texts: list[str],
        timeout_sec: int,
        cancel: CancelToken,
    ) -> list[list[float]]:
        url = resolved.base_url.rstrip("/") + "/embeddings"
        headers = {
            "Authorization": f"Bearer {resolved.api_key}",
            "Content-Type": "application/json",
        }
        client_owned = self._client is None
        client = self._client or httpx.AsyncClient(trust_env=False)
        out: list[list[float]] = []
        try:
            for i in range(0, len(texts), self._batch):
                chunk = texts[i : i + self._batch]
                body = {"model": resolved.model_id, "input": chunk}
                try:
                    resp = await client.post(url, json=body, headers=headers, timeout=timeout_sec)
                except httpx.TimeoutException as e:
                    raise LLMTimeoutError(f"embed 超时: {e}") from e
                except httpx.HTTPError as e:
                    raise LLMNetworkError(f"embed 网络错误: {e}") from e
                status = resp.status_code
                if status >= 500:
                    raise LLMServerError(f"embed {status}")
                if status == 429:
                    raise LLMRateLimitError(f"embed 429")
                if status in (401, 403):
                    raise LLMAuthError(f"embed {status}")
                if status >= 400:
                    raise LLMBadRequestError(f"embed {status}: {resp.text[:200]}")
                data = resp.json()
                for item in data.get("data", []):
                    out.append(item.get("embedding", []))
        finally:
            if client_owned:
                await client.aclose()
        return out
