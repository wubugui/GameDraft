from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from tools.chronicle_sim.core.llm.adapter import LLMAdapter, LLMResponse
from tools.chronicle_sim.core.llm.audit_log import append_llm_audit, audit_enabled_from_config
from tools.chronicle_sim.core.llm.embeddings import (
    EmbeddingBackend,
    OllamaEmbeddingBackend,
    OpenAICompatEmbeddingBackend,
)
from tools.chronicle_sim.core.llm.llm_trace import (
    format_chat_call_for_log,
    format_chat_response_for_log,
    format_embed_call_for_log,
    format_embed_response_for_log,
    get_llm_gate,
    emit_llm_trace,
)
from tools.chronicle_sim.core.llm.http_transport import httpx_async_client_kwargs
from tools.chronicle_sim.core.llm.ollama import OllamaAdapter
from tools.chronicle_sim.core.llm.openai_compat import OpenAICompatAdapter
from tools.chronicle_sim.core.llm.stub_adapter import StubLLMAdapter


@dataclass
class ProviderProfile:
    kind: str = "stub"
    base_url: str = ""
    api_key: str = ""
    model: str = "stub"
    ollama_host: str = "http://127.0.0.1:11434"
    extra: dict[str, Any] = field(default_factory=dict)


class _GatedTracedEmbeddingBackend(EmbeddingBackend):
    """串行 + 记录嵌入调用的输入/输出（向量仅记录条数与维度）。"""

    def __init__(self, inner: EmbeddingBackend) -> None:
        self._inner = inner

    async def embed(self, texts: list[str]) -> list[list[float]]:
        async with get_llm_gate():
            emit_llm_trace(f"[embed·in] {format_embed_call_for_log(texts)}")
            out = await self._inner.embed(texts)
            emit_llm_trace(f"[embed·out] {format_embed_response_for_log(out)}")
        return out

    async def aclose(self) -> None:
        await self._inner.aclose()


def _retry_opts(llm_config: dict[str, Any] | None) -> tuple[int, float]:
    retries, backoff = 3, 1.0
    if llm_config and isinstance(llm_config.get("http"), dict):
        h = llm_config["http"]
        try:
            retries = int(h.get("max_retries", retries))
        except (TypeError, ValueError):
            pass
        try:
            backoff = float(h.get("retry_backoff_sec", backoff))
        except (TypeError, ValueError):
            pass
    return max(1, retries), max(0.1, backoff)


class LLMClient:
    """每个 agent 独立包装：持有 agent_id 便于日志与隔离。"""

    def __init__(
        self,
        agent_id: str,
        adapter: LLMAdapter,
        *,
        audit_run_dir: Path | None = None,
        audit_enabled: bool = False,
    ) -> None:
        self.agent_id = agent_id
        self.adapter = adapter
        self._audit_run_dir = audit_run_dir if audit_enabled else None

    async def chat(
        self,
        messages: list[dict[str, str]],
        **kwargs: Any,
    ) -> Any:
        async with get_llm_gate():
            emit_llm_trace(f"[chat·in] {format_chat_call_for_log(self.agent_id, messages, kwargs)}")
            resp: LLMResponse = await self.adapter.chat(messages, **kwargs)
            emit_llm_trace(f"[chat·out] {format_chat_response_for_log(self.agent_id, resp)}")
        if self._audit_run_dir is not None:
            append_llm_audit(
                self._audit_run_dir,
                self.agent_id,
                messages=list(messages),
                response_text=resp.text,
                raw=resp.raw,
            )
        return resp

    async def aclose(self) -> None:
        if hasattr(self.adapter, "close"):
            await self.adapter.close()  # type: ignore[misc]


class ClientFactory:
    @staticmethod
    def build_for_agent(
        agent_id: str,
        profile: ProviderProfile,
        llm_config: dict[str, Any] | None = None,
        *,
        run_dir: Path | None = None,
    ) -> LLMClient:
        hk = httpx_async_client_kwargs(llm_config)
        retries, backoff = _retry_opts(llm_config)
        adapter: LLMAdapter
        if profile.kind == "openai_compat":
            adapter = OpenAICompatAdapter(
                base_url=profile.base_url or "https://api.openai.com/v1",
                api_key=profile.api_key,
                default_model=profile.model,
                client_kwargs=hk,
                max_retries=retries,
                retry_backoff_sec=backoff,
            )
        elif profile.kind == "ollama":
            adapter = OllamaAdapter(
                host=profile.ollama_host,
                default_model=profile.model,
                client_kwargs=hk,
                max_retries=retries,
                retry_backoff_sec=backoff,
            )
        else:
            adapter = StubLLMAdapter()
        aud = audit_enabled_from_config(llm_config) and run_dir is not None
        return LLMClient(agent_id, adapter, audit_run_dir=run_dir, audit_enabled=aud)

    @staticmethod
    def build_embedding_backend(
        profile: ProviderProfile | None,
        llm_config: dict[str, Any] | None = None,
    ) -> EmbeddingBackend | None:
        if profile is None:
            return None
        hk = httpx_async_client_kwargs(llm_config)
        kind = (profile.kind or "").lower()
        if kind in ("none", "off", "disabled", "stub"):
            return None
        if kind == "ollama":
            return _GatedTracedEmbeddingBackend(
                OllamaEmbeddingBackend(
                    profile.ollama_host or "http://127.0.0.1:11434",
                    profile.model or "nomic-embed-text",
                    client_kwargs=hk,
                )
            )
        if kind == "openai_compat":
            return _GatedTracedEmbeddingBackend(
                OpenAICompatEmbeddingBackend(
                    profile.base_url or "https://api.openai.com/v1",
                    profile.api_key,
                    profile.model or "text-embedding-3-small",
                    client_kwargs=hk,
                )
            )
        return None
