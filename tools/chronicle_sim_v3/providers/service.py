"""ProviderService —— 业务可见的统一入口。

API：
- resolve(provider_id) -> ResolvedProvider
- list_providers() -> list[(id, kind, base_url, has_api_key)]
- health_check(provider_id, timeout_sec) -> dict（async；可选 ping）
- close()  —— 预留

不依赖 llm/ agents/ engine/.（最底层）
"""
from __future__ import annotations

from pathlib import Path

from tools.chronicle_sim_v3.providers.config import (
    ProvidersConfig,
    load_providers_config,
)
from tools.chronicle_sim_v3.providers.health import ping
from tools.chronicle_sim_v3.providers.resolver import ProviderResolver
from tools.chronicle_sim_v3.providers.types import ResolvedProvider


class ProviderService:
    def __init__(
        self,
        run_dir: Path,
        config: ProvidersConfig | None = None,
    ) -> None:
        self.run_dir = Path(run_dir)
        self.config = config or load_providers_config(self.run_dir)
        self.resolver = ProviderResolver(self.config, self.run_dir)

    def resolve(self, provider_id: str) -> ResolvedProvider:
        return self.resolver.resolve(provider_id)

    def has(self, provider_id: str) -> bool:
        return provider_id in self.config.providers

    def list_providers(self) -> list[dict]:
        out: list[dict] = []
        for pid, pdef in sorted(self.config.providers.items()):
            out.append({
                "provider_id": pid,
                "kind": pdef.kind,
                "base_url": pdef.base_url,
                "has_api_key_ref": bool(pdef.api_key_ref),
                "extra_keys": sorted(pdef.extra.keys()),
            })
        return out

    async def health_check(
        self,
        provider_id: str,
        timeout_sec: float = 10.0,
    ) -> dict:
        resolved = self.resolve(provider_id)
        return await ping(resolved, timeout_sec=timeout_sec)
