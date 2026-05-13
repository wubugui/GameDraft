"""ProviderResolver —— 把 provider_id 解析成 ResolvedProvider（含 raw key）。

设计：
- provider_hash 只取 (kind, base_url, extra)，**绝不含 api_key**
- api_key 解析在调用 resolve 时才发生（惰性）；失败抛 ProviderConfigError
"""
from __future__ import annotations

from pathlib import Path

from tools.chronicle_sim_v3.engine.canonical import canonical_json, sha256_hex
from tools.chronicle_sim_v3.providers.config import ApiKeyRef, ProvidersConfig
from tools.chronicle_sim_v3.providers.errors import ProviderNotFoundError
from tools.chronicle_sim_v3.providers.types import ProviderKind, ResolvedProvider


def compute_provider_hash(
    kind: str,
    base_url: str,
    extra: dict,
) -> str:
    """16 字符短 hash，业务可放进 cache key / audit。"""
    payload = {
        "kind": kind,
        "base_url": base_url,
        "extra": extra or {},
    }
    return sha256_hex(canonical_json(payload))[:16]


class ProviderResolver:
    def __init__(self, config: ProvidersConfig, run_dir: Path) -> None:
        self.config = config
        self.run_dir = Path(run_dir)

    def resolve(self, provider_id: str) -> ResolvedProvider:
        pdef = self.config.providers.get(provider_id)
        if pdef is None:
            raise ProviderNotFoundError(
                f"未注册 provider id: {provider_id!r}；"
                f"已注册：{sorted(self.config.providers.keys())}"
            )
        api_key = ""
        if pdef.api_key_ref:
            api_key = ApiKeyRef.parse(pdef.api_key_ref).resolve(self.run_dir)
        ph = compute_provider_hash(pdef.kind, pdef.base_url, dict(pdef.extra))
        kind: ProviderKind = pdef.kind  # type: ignore[assignment]
        return ResolvedProvider(
            provider_id=provider_id,
            kind=kind,
            base_url=pdef.base_url,
            api_key=api_key,
            extra=dict(pdef.extra),
            provider_hash=ph,
        )

    def list_ids(self) -> list[str]:
        return sorted(self.config.providers.keys())
