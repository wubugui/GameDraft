"""从 ProviderProfile + llm_config 构造 Pydantic AI 对话模型。"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

from pydantic_ai.models import Model
from pydantic_ai.models.ollama import OllamaModel
from pydantic_ai.models.openai import OpenAIModel
from pydantic_ai.providers.ollama import OllamaProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.settings import ModelSettings, merge_model_settings

from tools.chronicle_sim_v2.core.llm.audit_log import audit_enabled_from_config
from tools.chronicle_sim_v2.core.llm.provider_profile import ProviderProfile
from tools.chronicle_sim_v2.core.llm.http_transport import httpx_async_client_kwargs
from tools.chronicle_sim_v2.core.llm.pa_dashscope import is_dashscope_openai_compat_base
from tools.chronicle_sim_v2.core.llm.pa_stub import build_stub_function_model


def trace_options_from_llm_config(llm_config: dict[str, Any] | None) -> dict[str, Any]:
    """从 runs.llm_config_json['trace'] 解析调试追踪选项（无则用默认）。"""
    raw = (llm_config or {}).get("trace")
    if not isinstance(raw, dict):
        raw = {}
    try:
        mc = int(raw.get("max_chars", 800_000))
    except (TypeError, ValueError):
        mc = 800_000
    return {
        "full_messages_json": bool(raw.get("full_messages_json", True)),
        "max_chars": max(4096, mc),
        "full_user_prompt": bool(raw.get("full_user_prompt", False)),
    }


@dataclass
class PAChatResources:
    """每个 agent 槽位一份：模型 + 默认 ModelSettings + 可选审计 + 需关闭的 httpx 客户端。"""

    agent_id: str
    model: Model
    default_model_settings: ModelSettings | None
    audit_run_dir: Path | None
    _http_client: httpx.AsyncClient | None = None
    trace: dict[str, Any] = field(default_factory=dict)

    async def aclose(self) -> None:
        if self._http_client is not None:
            await self._http_client.aclose()


def _base_model_settings_for_endpoint(
    *,
    kind: str,
    base_url: str,
) -> ModelSettings | None:
    if kind == "openai_compat":
        if is_dashscope_openai_compat_base(base_url):
            return {
                "thinking": False,
                "extra_body": {"enable_thinking": False},
            }
        return {"max_tokens": 16_384}
    if kind == "ollama":
        return {"max_tokens": 16_384}
    return None


def build_pa_chat_resources(
    agent_id: str,
    profile: ProviderProfile,
    llm_config: dict[str, Any] | None = None,
    *,
    run_dir: Path | None = None,
) -> PAChatResources:
    hk = httpx_async_client_kwargs(llm_config)
    http_client = httpx.AsyncClient(**hk)
    kind = (profile.kind or "").lower()
    audit = audit_enabled_from_config(llm_config) and run_dir is not None
    audit_dir = run_dir if audit else None
    trace_opts = trace_options_from_llm_config(llm_config)

    if kind == "openai_compat":
        base_url = (profile.base_url or "https://api.openai.com/v1").rstrip("/")
        prov = OpenAIProvider(
            base_url=base_url,
            api_key=(profile.api_key or "").strip() or "no-api-key",
            http_client=http_client,
        )
        model = OpenAIModel(profile.model or "gpt-4o-mini", provider=prov)
        defaults = _base_model_settings_for_endpoint(kind="openai_compat", base_url=profile.base_url or "")
        return PAChatResources(
            agent_id=agent_id,
            model=model,
            default_model_settings=defaults,
            audit_run_dir=audit_dir,
            _http_client=http_client,
            trace=trace_opts,
        )

    if kind == "ollama":
        host = (profile.ollama_host or "http://127.0.0.1:11434").rstrip("/")
        base = f"{host}/v1"
        prov = OllamaProvider(base_url=base, http_client=http_client)
        model = OllamaModel(profile.model or "llama3", provider=prov)
        defaults = _base_model_settings_for_endpoint(kind="ollama", base_url=base)
        return PAChatResources(
            agent_id=agent_id,
            model=model,
            default_model_settings=defaults,
            audit_run_dir=audit_dir,
            _http_client=http_client,
            trace=trace_opts,
        )

    stub = build_stub_function_model()
    return PAChatResources(
        agent_id=agent_id,
        model=stub,
        default_model_settings=None,
        audit_run_dir=audit_dir,
        _http_client=None,
        trace=trace_opts,
    )


def merged_settings(
    pa: PAChatResources,
    *overrides: ModelSettings | None,
) -> ModelSettings | None:
    acc: ModelSettings | None = pa.default_model_settings
    for o in overrides:
        acc = merge_model_settings(acc, o)
    return acc
