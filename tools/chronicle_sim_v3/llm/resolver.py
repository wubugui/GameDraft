"""路由 / 物理模型解析（RFC v3-llm.md §4，三层架构版）。

变更：
- 不再持有 run_dir 解析 api_key；改为依赖 ProviderService（从 Provider 拿凭据）
- route_hash 仍**不含 api_key**：业务侧 cache key 引用 route_hash，
  api_key 轮换不应让大量缓存失效
- route_hash 引入 provider_id / provider_hash（保证换 provider 时缓存失效）
"""
from __future__ import annotations

from tools.chronicle_sim_v3.engine.canonical import canonical_json, sha256_hex
from tools.chronicle_sim_v3.llm.config import (
    CacheConfig,
    LLMConfig,
    RetryConfigEntry,
)
from tools.chronicle_sim_v3.llm.errors import LLMConfigError, LLMRouteError
from tools.chronicle_sim_v3.llm.types import (
    CallPolicy,
    LLMRef,
    RateLimit,
    ResolvedModel,
    RetryPolicy,
)
from tools.chronicle_sim_v3.providers.errors import ProviderError
from tools.chronicle_sim_v3.providers.service import ProviderService


class Resolver:
    def __init__(self, config: LLMConfig, provider_service: ProviderService) -> None:
        self.config = config
        self.provider_service = provider_service

    def resolve_route(self, logical: str) -> ResolvedModel:
        physical = self.config.routes.get(logical)
        if not physical:
            raise LLMRouteError(f"未知逻辑模型 id: {logical}")
        mdef = self.config.models.get(physical)
        if not mdef:
            raise LLMConfigError(
                f"路由 {logical}→{physical} 但 {physical} 未在 models 注册"
            )
        # 通过 ProviderService 拿 base_url + api_key
        try:
            resolved_provider = self.provider_service.resolve(mdef.provider)
        except ProviderError as e:
            raise LLMConfigError(
                f"路由 {logical}→{physical} 的 provider {mdef.provider!r} 解析失败: {e}"
            ) from e

        route_hash_payload = {
            "physical": physical,
            "provider_id": mdef.provider,
            "provider_hash": resolved_provider.provider_hash,
            "invocation": mdef.invocation,
            "model_id": mdef.model_id,
            "extra": dict(mdef.extra),
            # 故意不含 api_key
        }
        route_hash = sha256_hex(canonical_json(route_hash_payload))[:16]
        return ResolvedModel(
            logical=logical,
            physical=physical,
            provider_id=mdef.provider,
            invocation=mdef.invocation,
            base_url=resolved_provider.base_url,
            api_key=resolved_provider.api_key,
            model_id=mdef.model_id,
            extra=dict(mdef.extra),
            route_hash=route_hash,
        )

    def policy_for(self, logical: str, ref: LLMRef | None = None) -> CallPolicy:
        cfg = self.config
        timeout_default = int(cfg.timeout.get("default_sec", 600))
        timeout = (
            (ref.timeout_sec if ref and ref.timeout_sec else None)
            or int(cfg.timeout.get("per_route", {}).get(logical, timeout_default))
        )
        retry_raw = cfg.retry.get(logical) or cfg.retry.get("default") or {}
        try:
            retry_cfg = RetryConfigEntry.model_validate(retry_raw)
        except Exception as e:
            raise LLMConfigError(f"retry 配置非法: {e}") from e
        retry = RetryPolicy(
            max_attempts=(
                ref.retry_max_attempts
                if ref and ref.retry_max_attempts
                else retry_cfg.max_attempts
            ),
            backoff=retry_cfg.backoff,
            base_ms=retry_cfg.base_ms,
            retry_on=tuple(retry_cfg.retry_on),
            no_retry_on=tuple(retry_cfg.no_retry_on),
        )
        rl_routes = cfg.rate_limits.get("routes", {}) if cfg.rate_limits else {}
        rl_default = cfg.rate_limits.get("default", {}) if cfg.rate_limits else {}
        rl_raw = rl_routes.get(logical) or rl_default or {}
        rate_limit = RateLimit(
            qpm=rl_raw.get("qpm"),
            tpm=rl_raw.get("tpm"),
        )
        cache: CacheConfig = cfg.cache
        if ref and ref.cache and ref.cache != "auto":
            cache_mode = ref.cache
        else:
            cache_mode = cache.per_route.get(logical, cache.default_mode)
        return CallPolicy(
            timeout_sec=timeout,
            retry=retry,
            rate_limit=rate_limit,
            cache_mode=cache_mode,
            audit_log_user_prompt=cfg.audit.log_user_prompt,
            audit_log_user_prompt_max_chars=cfg.audit.log_user_prompt_max_chars,
        )
