"""Provider 子系统错误体系（RFC v3-provider.md §10）。"""
from __future__ import annotations


class ProviderError(Exception):
    """所有 Provider 错误的基类。"""


class ProviderConfigError(ProviderError):
    """providers.yaml 加载 / 字段非法 / api_key_ref 解析失败。"""


class ProviderNotFoundError(ProviderError):
    """resolve 时 provider_id 未注册。"""


class ProviderHealthError(ProviderError):
    """ping endpoint 失败。"""
