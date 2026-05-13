"""LLMService — 单次 chat / embed 调度（RFC v3-llm.md §3，三层架构版）。

数据流：
    chat / embed
       │
       ├─ Resolver.resolve_route + policy_for（凭据通过 ProviderService 取）
       ├─ Audit.start
       ├─ Cache.lookup（按 mode）
       │     └─ 命中 → Audit.end(cache_hit=True) → Usage.record → 返回
       ├─ Limiter.acquire
       │     └─ Retry 包裹 Backend.invoke
       │           └─ output_parse
       ├─ Cache.store（mode != off 且确定性）
       ├─ Audit.end
       └─ Usage.record

三层架构定位：
- LLMService 是 **Agent 层的内部依赖**，不再是业务节点的入口
- 业务节点应通过 AgentService 调用；csim llm test 仅作开发调试
- 已不含 cline backend；cline 走 agents/runners/cline.py
- 凭据全部由 ProviderService 提供，本类不感知 api_key 来源

API key 永不进 audit / log / usage。
"""
from __future__ import annotations

import asyncio
import inspect
from pathlib import Path
from time import monotonic
from typing import Any

from tools.chronicle_sim_v3.llm.audit import AuditWriter
from tools.chronicle_sim_v3.llm.backend.base import (
    BackendObserver,
    BackendResult,
    CancelToken,
    NullObserver,
)
from tools.chronicle_sim_v3.llm.backend.ollama_embed import OllamaEmbedBackend
from tools.chronicle_sim_v3.llm.backend.openai_compat_chat import (
    OpenAICompatChatBackend,
)
from tools.chronicle_sim_v3.llm.backend.openai_compat_embed import (
    OpenAICompatEmbedBackend,
)
from tools.chronicle_sim_v3.llm.backend.stub import StubBackend, StubEmbedBackend
from tools.chronicle_sim_v3.llm.cache import (
    CacheStore,
    chat_cache_key,
    embed_cache_key,
)
from tools.chronicle_sim_v3.llm.config import LLMConfig, load_llm_config
from tools.chronicle_sim_v3.llm.errors import (
    LLMCancelledError,
    LLMConfigError,
    LLMError,
    LLMOutputParseError,
    classify,
)
from tools.chronicle_sim_v3.llm.limiter import Limiter, estimate_tokens_chars
from tools.chronicle_sim_v3.llm.output_parse import parse_output
from tools.chronicle_sim_v3.llm.render import render
from tools.chronicle_sim_v3.llm.resolver import Resolver
from tools.chronicle_sim_v3.llm.types import (
    CallPolicy,
    LLMRef,
    LLMResult,
    OutputSpec,
    Prompt,
    ResolvedModel,
)
from tools.chronicle_sim_v3.llm.usage import UsageStore
from tools.chronicle_sim_v3.providers.service import ProviderService


class LLMService:
    def __init__(
        self,
        run_dir: Path,
        provider_service: ProviderService,
        config: LLMConfig | None = None,
        *,
        chat_backend_overrides: dict[str, Any] | None = None,
        embed_backend_overrides: dict[str, Any] | None = None,
        spec_search_root: Path | None = None,
    ) -> None:
        self.run_dir = Path(run_dir)
        self.provider_service = provider_service
        self.config = config or load_llm_config(self.run_dir)
        self.resolver = Resolver(self.config, provider_service)
        self.limiter = Limiter(self.config)
        self.cache = CacheStore(self.run_dir)
        self.audit = AuditWriter(self.run_dir, self.config.audit)
        self.usage = UsageStore(self.run_dir)
        self._chat_backends: dict[str, Any] = {}
        self._embed_backends: dict[str, Any] = {}
        self._spec_search_root = spec_search_root or self.run_dir
        self._closed = False
        self._init_default_backends(chat_backend_overrides, embed_backend_overrides)

    # ---------- backend 工厂 ----------

    def _init_default_backends(
        self,
        chat_overrides: dict[str, Any] | None,
        embed_overrides: dict[str, Any] | None,
    ) -> None:
        stub_seed = int(self.config.stub.get("fixed_seed", 42))
        self._chat_backends["stub"] = StubBackend(fixed_seed=stub_seed)
        self._chat_backends["openai_compat_chat"] = OpenAICompatChatBackend()
        self._embed_backends["stub"] = StubEmbedBackend(fixed_seed=stub_seed)
        self._embed_backends["openai_compat_embed"] = OpenAICompatEmbedBackend()
        self._embed_backends["ollama_embed"] = OllamaEmbedBackend()
        if chat_overrides:
            self._chat_backends.update(chat_overrides)
        if embed_overrides:
            self._embed_backends.update(embed_overrides)

    def _chat_backend_for(self, resolved: ResolvedModel, prompt: Prompt) -> Any:
        invocation = resolved.invocation
        if invocation in self._chat_backends:
            return self._chat_backends[invocation]
        raise LLMConfigError(f"Chat invocation 未注册: {invocation!r}")

    def _embed_backend_for(self, resolved: ResolvedModel) -> Any:
        if resolved.invocation in self._embed_backends:
            return self._embed_backends[resolved.invocation]
        raise LLMConfigError(f"Embed invocation 未注册: {resolved.invocation!r}")

    # ---------- 主接口 ----------

    async def chat(
        self,
        ref: LLMRef,
        prompt: Prompt,
        *,
        cancel: CancelToken | None = None,
        observer: BackendObserver | None = None,
    ) -> LLMResult:
        if self._closed:
            raise LLMConfigError("LLMService 已关闭")
        cancel = cancel or CancelToken()
        observer = observer or NullObserver()
        resolved = self.resolver.resolve_route(ref.model)
        policy = self.resolver.policy_for(ref.model, ref)

        rendered_system, rendered_user, spec = render(prompt, self._spec_search_root)

        audit_id = self.audit.start(
            logical=resolved.logical,
            physical=resolved.physical,
            invocation=resolved.invocation,
            spec_ref=prompt.spec_ref,
            user_text=rendered_user,
            cache_mode=policy.cache_mode,
            role=ref.role,
        )

        cache_hit = False
        cached_at: str | None = None
        if self.config.cache.enabled and policy.cache_mode != "off":
            key = chat_cache_key(
                resolved, spec.sha, rendered_system, rendered_user,
                ref.output, policy.cache_mode,
            )
            entry = self.cache.lookup(key, "chat")
            if entry:
                payload = entry.get("result", {})
                cache_hit = True
                cached_at = entry.get("created_at")
                self.audit.end(
                    audit_id, cache_hit=True, exit_code=0,
                    timings={"total_ms": 0},
                    tokens_in=payload.get("tokens_in"),
                    tokens_out=payload.get("tokens_out"),
                )
                self.usage.record(
                    route=resolved.logical,
                    tokens_in=payload.get("tokens_in"),
                    tokens_out=payload.get("tokens_out"),
                    latency_ms=0,
                    cache_hit=True,
                )
                return LLMResult(
                    text=payload.get("text", ""),
                    parsed=payload.get("parsed"),
                    tool_log=payload.get("tool_log") or [],
                    exit_code=0,
                    cache_hit=True,
                    cached_at=cached_at,
                    timings={"cache_ms": 0},
                    audit_id=audit_id,
                    physical_model=resolved.physical,
                    tokens_in=payload.get("tokens_in"),
                    tokens_out=payload.get("tokens_out"),
                )

        backend = self._chat_backend_for(resolved, prompt)
        est = estimate_tokens_chars(rendered_system + rendered_user)
        t_start = monotonic()
        try:
            async with self.limiter.acquire(resolved.logical, est_tokens=est):
                bres = await self._with_retry(
                    policy,
                    lambda: self._invoke_chat(
                        backend, resolved, prompt, rendered_system, rendered_user,
                        ref.output, policy.timeout_sec, cancel, observer,
                    ),
                )
        except LLMError as e:
            self.audit.end(
                audit_id, cache_hit=False, exit_code=1,
                timings={"total_ms": int((monotonic() - t_start) * 1000)},
                tokens_in=None, tokens_out=None, error_tag=classify(e),
            )
            self.usage.record(
                route=resolved.logical, tokens_in=None, tokens_out=None,
                latency_ms=int((monotonic() - t_start) * 1000),
                cache_hit=False, error=True,
            )
            raise

        try:
            parsed, tool_log_extra = parse_output(bres.text, ref.output)
        except LLMOutputParseError as e:
            self.audit.end(
                audit_id, cache_hit=False, exit_code=bres.exit_code,
                timings=bres.timings, tokens_in=bres.tokens_in,
                tokens_out=bres.tokens_out, error_tag=classify(e),
            )
            self.usage.record(
                route=resolved.logical,
                tokens_in=bres.tokens_in, tokens_out=bres.tokens_out,
                latency_ms=int((monotonic() - t_start) * 1000),
                cache_hit=False, error=True,
            )
            raise

        tool_log = (bres.tool_log or []) + (tool_log_extra or [])
        result = LLMResult(
            text=bres.text,
            parsed=parsed,
            tool_log=tool_log,
            exit_code=bres.exit_code,
            cache_hit=False,
            cached_at=None,
            timings={**bres.timings, "total_ms": int((monotonic() - t_start) * 1000)},
            audit_id=audit_id,
            physical_model=resolved.physical,
            tokens_in=bres.tokens_in,
            tokens_out=bres.tokens_out,
        )

        if self.config.cache.enabled and policy.cache_mode != "off":
            key = chat_cache_key(
                resolved, spec.sha, rendered_system, rendered_user,
                ref.output, policy.cache_mode,
            )
            self.cache.store(
                key, "chat",
                physical_model=resolved.physical,
                route_hash=resolved.route_hash,
                result_payload={
                    "text": result.text,
                    "parsed": result.parsed,
                    "tool_log": result.tool_log,
                    "exit_code": result.exit_code,
                    "tokens_in": result.tokens_in,
                    "tokens_out": result.tokens_out,
                },
            )

        self.audit.end(
            audit_id, cache_hit=False, exit_code=result.exit_code,
            timings=result.timings, tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
        )
        self.usage.record(
            route=resolved.logical,
            tokens_in=result.tokens_in,
            tokens_out=result.tokens_out,
            latency_ms=result.timings.get("total_ms", 0),
            cache_hit=False,
        )
        return result

    async def embed(
        self,
        model: str,
        texts: list[str],
        *,
        cache: str | None = None,
        cancel: CancelToken | None = None,
    ) -> list[list[float]]:
        if self._closed:
            raise LLMConfigError("LLMService 已关闭")
        cancel = cancel or CancelToken()
        resolved = self.resolver.resolve_route(model)
        policy = self.resolver.policy_for(model)
        cache_mode = cache or policy.cache_mode
        backend = self._embed_backend_for(resolved)

        out: list[list[float] | None] = [None] * len(texts)
        miss_idx: list[int] = []
        if self.config.cache.enabled and cache_mode != "off":
            for i, t in enumerate(texts):
                k = embed_cache_key(resolved, t)
                e = self.cache.lookup(k, "embed")
                if e:
                    out[i] = e.get("result", {}).get("vector")
                else:
                    miss_idx.append(i)
        else:
            miss_idx = list(range(len(texts)))

        if miss_idx:
            miss_texts = [texts[i] for i in miss_idx]
            t0 = monotonic()
            async with self.limiter.acquire(resolved.logical, est_tokens=0):
                miss_vecs = await backend.invoke(
                    resolved, miss_texts, policy.timeout_sec, cancel,
                )
            latency_ms = int((monotonic() - t0) * 1000)
            for j, i in enumerate(miss_idx):
                vec = miss_vecs[j] if j < len(miss_vecs) else []
                out[i] = vec
                if self.config.cache.enabled and cache_mode != "off":
                    k = embed_cache_key(resolved, texts[i])
                    self.cache.store(
                        k, "embed",
                        physical_model=resolved.physical,
                        route_hash=resolved.route_hash,
                        result_payload={"vector": vec},
                    )
            self.usage.record(
                route=resolved.logical, tokens_in=None, tokens_out=None,
                latency_ms=latency_ms, cache_hit=False,
            )
        return [v if v is not None else [] for v in out]

    def resolve_route(self, logical: str) -> ResolvedModel:
        return self.resolver.resolve_route(logical)

    def list_routes(self) -> dict[str, str]:
        return dict(self.config.routes)

    def list_models(self) -> dict[str, dict]:
        return {
            name: {
                "provider": m.provider,
                "model_id": m.model_id,
                "invocation": m.invocation,
            }
            for name, m in self.config.models.items()
        }

    async def aclose(self) -> None:
        self._closed = True

    # ---------- 内部 ----------

    async def _invoke_chat(
        self,
        backend,
        resolved: ResolvedModel,
        prompt: Prompt,
        rendered_system: str,
        rendered_user: str,
        output: OutputSpec,
        timeout_sec: int,
        cancel: CancelToken,
        observer: BackendObserver,
    ) -> BackendResult:
        sig = inspect.signature(backend.invoke)
        return await backend.invoke(
            resolved, prompt, rendered_system, rendered_user,
            output, timeout_sec, cancel, observer,
        )

    async def _with_retry(
        self, policy: CallPolicy, fn,
    ):
        last_err: LLMError | None = None
        for attempt in range(1, policy.retry.max_attempts + 1):
            try:
                return await fn()
            except LLMCancelledError:
                raise
            except LLMError as e:
                tag = classify(e)
                if tag in policy.retry.no_retry_on or tag not in policy.retry.retry_on:
                    raise
                if attempt == policy.retry.max_attempts:
                    raise
                delay = self._delay_seconds(policy, attempt)
                await asyncio.sleep(delay)
                last_err = e
        if last_err is not None:
            raise last_err
        raise LLMError("retry 耗尽")

    @staticmethod
    def _delay_seconds(policy: CallPolicy, attempt: int) -> float:
        base = policy.retry.base_ms / 1000.0
        if policy.retry.backoff == "exp":
            return base * (2 ** (attempt - 1))
        return base
