"""Provider 公共数据类。

`ResolvedProvider.provider_hash` 故意不含 api_key：
- cache key 引用 provider_hash（或上层间接引用）
- api_key 轮换不应让大量缓存失效
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

ProviderKind = Literal["openai_compat", "dashscope_compat", "ollama", "stub"]

PROVIDER_KINDS: tuple[ProviderKind, ...] = (
    "openai_compat",
    "dashscope_compat",
    "ollama",
    "stub",
)


@dataclass(frozen=True)
class ProviderRef:
    """节点 / runner 端构造的引用（很薄）。"""

    provider_id: str


@dataclass(frozen=True)
class ResolvedProvider:
    """ProviderResolver.resolve 的产出。

    api_key 是惰性解析后的实际密钥；
    provider_hash 不含 api_key，可放进 cache key / audit。
    """

    provider_id: str
    kind: ProviderKind
    base_url: str
    api_key: str
    extra: dict = field(default_factory=dict)
    provider_hash: str = ""
