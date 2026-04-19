from __future__ import annotations

from pathlib import Path
from typing import Any

from tools.chronicle_sim_v2.core.llm.embeddings import (
    EmbeddingBackend,
    OllamaEmbeddingBackend,
    OpenAICompatEmbeddingBackend,
)
from tools.chronicle_sim_v2.core.llm.http_transport import httpx_async_client_kwargs
from tools.chronicle_sim_v2.core.llm.llm_trace import (
    format_embed_call_for_log,
    format_embed_response_for_log,
    get_llm_gate,
    emit_llm_trace,
)
from tools.chronicle_sim_v2.core.llm.pa_chat import PAChatResources, build_pa_chat_resources
from tools.chronicle_sim_v2.core.llm.provider_profile import ProviderProfile


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


class ClientFactory:
    @staticmethod
    def build_pa_chat(
        agent_id: str,
        profile: ProviderProfile,
        llm_config: dict[str, Any] | None = None,
        *,
        run_dir: Path | None = None,
    ) -> PAChatResources:
        return build_pa_chat_resources(agent_id, profile, llm_config, run_dir=run_dir)

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
