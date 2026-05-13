"""OpenAI 兼容 Chat backend — 直 HTTP（httpx）。

P0 内已实现，但 RFC 明示『P6 才默认放进 routes 示例』。
本类已可用（用户在 llm.yaml 写 backend: openai_compat_chat 即可），
仅是 stub backend 之外的『确定性单测可控』后备。
"""
from __future__ import annotations

import httpx

from tools.chronicle_sim_v3.llm.backend.base import (
    BackendObserver,
    BackendResult,
    CancelToken,
    NullObserver,
)
from tools.chronicle_sim_v3.llm.errors import (
    LLMAuthError,
    LLMBadRequestError,
    LLMNetworkError,
    LLMRateLimitError,
    LLMServerError,
    LLMTimeoutError,
)
from tools.chronicle_sim_v3.llm.types import OutputSpec, Prompt, ResolvedModel


class OpenAICompatChatBackend:
    name = "openai_compat_chat"

    def __init__(self, client: httpx.AsyncClient | None = None) -> None:
        self._client = client

    def _client_or_make(self) -> httpx.AsyncClient:
        return self._client or httpx.AsyncClient(trust_env=False)

    async def invoke(
        self,
        resolved: ResolvedModel,
        prompt: Prompt,
        rendered_system: str,
        rendered_user: str,
        output: OutputSpec,
        timeout_sec: int,
        cancel: CancelToken,
        observer: BackendObserver | None = None,
    ) -> BackendResult:
        observer = observer or NullObserver()
        url = resolved.base_url.rstrip("/") + "/chat/completions"
        body = {
            "model": resolved.model_id,
            "messages": [
                {"role": "system", "content": rendered_system},
                {"role": "user", "content": rendered_user},
            ],
        }
        if resolved.extra:
            body.update(resolved.extra)
        headers = {
            "Authorization": f"Bearer {resolved.api_key}",
            "Content-Type": "application/json",
        }
        client_owned = self._client is None
        client = self._client_or_make()
        try:
            resp = await client.post(url, json=body, headers=headers, timeout=timeout_sec)
        except httpx.TimeoutException as e:
            raise LLMTimeoutError(f"openai_compat_chat 超时 {timeout_sec}s: {e}") from e
        except httpx.HTTPError as e:
            raise LLMNetworkError(f"openai_compat_chat 网络错误: {e}") from e
        finally:
            if client_owned:
                await client.aclose()
        status = resp.status_code
        if status >= 500:
            raise LLMServerError(f"openai_compat_chat {status}: {resp.text[:200]}")
        if status == 429:
            raise LLMRateLimitError(f"openai_compat_chat 429: {resp.text[:200]}")
        if status in (401, 403):
            raise LLMAuthError(f"openai_compat_chat {status}")
        if status >= 400:
            raise LLMBadRequestError(
                f"openai_compat_chat {status}: {resp.text[:200]}"
            )
        try:
            data = resp.json()
        except ValueError as e:
            raise LLMBadRequestError(f"响应非 JSON: {e}") from e
        choice = (data.get("choices") or [{}])[0]
        msg = (choice.get("message") or {}).get("content", "")
        usage = data.get("usage") or {}
        return BackendResult(
            text=msg or "",
            exit_code=0,
            timings={"exec_ms": 0},
            tokens_in=usage.get("prompt_tokens"),
            tokens_out=usage.get("completion_tokens"),
            raw={"id": data.get("id")},
        )
