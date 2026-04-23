"""providers/ —— 三层架构的最底层。

统一管理 API 提供商凭据（base_url / api_key / kind），不在乎使用方是谁。
所有需要 API key 的组件（LLMService、ClineRunner、ExternalRunner 等）
都从这里取，绝对不能内联在 llm.yaml / agents.yaml。
"""
from __future__ import annotations

from tools.chronicle_sim_v3.providers.config import (
    ApiKeyRef,
    ProviderDef,
    ProvidersConfig,
    load_providers_config,
    load_providers_config_text,
)
from tools.chronicle_sim_v3.providers.errors import (
    ProviderConfigError,
    ProviderError,
    ProviderHealthError,
    ProviderNotFoundError,
)
from tools.chronicle_sim_v3.providers.resolver import ProviderResolver
from tools.chronicle_sim_v3.providers.service import ProviderService
from tools.chronicle_sim_v3.providers.types import (
    PROVIDER_KINDS,
    ProviderKind,
    ProviderRef,
    ResolvedProvider,
)

__all__ = [
    "ApiKeyRef",
    "PROVIDER_KINDS",
    "ProviderConfigError",
    "ProviderDef",
    "ProviderError",
    "ProviderHealthError",
    "ProviderKind",
    "ProviderNotFoundError",
    "ProviderRef",
    "ProviderResolver",
    "ProviderService",
    "ProvidersConfig",
    "ResolvedProvider",
    "load_providers_config",
    "load_providers_config_text",
]
