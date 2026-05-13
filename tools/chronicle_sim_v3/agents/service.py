"""AgentService —— 业务节点的唯一入口。

数据流（参考 RFC v3-agent.md §6）：
    run(ref, task)
      │
      ├─ Resolver.resolve(logical) → ResolvedAgent
      ├─ Audit.start
      ├─ Cache.lookup（按 mode）
      │     └─ 命中 → Audit.end(cache_hit=True) → Usage.record → 返回
      ├─ Limiter.acquire(runner_kind)
      │     └─ Runner.run_task
      ├─ Cache.store（mode != off）
      ├─ Audit.end
      └─ Usage.record

Runner 工厂：根据 ResolvedAgent.runner_kind 懒构造对应 Runner；
LLMService / ProviderService 由 ctor 注入。
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from time import monotonic
from typing import Any

from tools.chronicle_sim_v3.agents.audit import AgentAuditWriter
from tools.chronicle_sim_v3.agents.cache import (
    AgentCacheStore,
    agent_cache_key,
)
from tools.chronicle_sim_v3.agents.config import AgentsConfig, load_agents_config
from tools.chronicle_sim_v3.agents.errors import (
    AgentConfigError,
    AgentError,
    AgentRunnerError,
)
from tools.chronicle_sim_v3.agents.limiter import AgentLimiter
from tools.chronicle_sim_v3.agents.resolver import AgentResolver, ResolvedAgent
from tools.chronicle_sim_v3.agents.runners.base import (
    AgentRunner,
    AgentRunnerContext,
)
from tools.chronicle_sim_v3.agents.types import (
    AgentObserver,
    AgentRef,
    AgentResult,
    AgentTask,
    NullAgentObserver,
)
from tools.chronicle_sim_v3.agents.usage import AgentUsageStore
from tools.chronicle_sim_v3.llm.render import load_spec
from tools.chronicle_sim_v3.providers.service import ProviderService


class AgentService:
    def __init__(
        self,
        run_dir: Path,
        provider_service: ProviderService,
        llm_service: Any | None = None,
        config: AgentsConfig | None = None,
        *,
        chroma: Any = None,
        spec_search_root: Path | None = None,
    ) -> None:
        self.run_dir = Path(run_dir)
        self.provider_service = provider_service
        self.llm_service = llm_service
        self.config = config or load_agents_config(self.run_dir)
        self.resolver = AgentResolver(self.config)
        self.limiter = AgentLimiter(self.config.limiter)
        self.cache = AgentCacheStore(self.run_dir)
        self.audit = AgentAuditWriter(self.run_dir, self.config.audit)
        self.usage = AgentUsageStore()
        self.chroma = chroma
        self._spec_search_root = spec_search_root or self.run_dir
        self._runners: dict[str, AgentRunner] = {}
        self._closed = False

    # ---------- runner 工厂 ----------

    def _runner_for(self, runner_kind: str) -> AgentRunner:
        if runner_kind in self._runners:
            return self._runners[runner_kind]
        runner: AgentRunner
        if runner_kind == "cline":
            from tools.chronicle_sim_v3.agents.runners.cline import ClineRunner
            runner = ClineRunner()
        elif runner_kind == "simple_chat":
            from tools.chronicle_sim_v3.agents.runners.simple_chat import (
                SimpleChatRunner,
            )
            runner = SimpleChatRunner()
        elif runner_kind == "react":
            from tools.chronicle_sim_v3.agents.runners.react import ReActRunner
            runner = ReActRunner()
        elif runner_kind == "external":
            from tools.chronicle_sim_v3.agents.runners.external import ExternalRunner
            runner = ExternalRunner()
        else:
            raise AgentConfigError(f"未知 runner_kind: {runner_kind!r}")
        self._runners[runner_kind] = runner
        return runner

    # ---------- 主接口 ----------

    async def run(
        self,
        ref: AgentRef,
        task: AgentTask,
        *,
        observer: AgentObserver | None = None,
    ) -> AgentResult:
        if self._closed:
            raise AgentConfigError("AgentService 已关闭")
        observer = observer or NullAgentObserver()
        resolved = self.resolver.resolve(ref.agent)
        runner = self._runner_for(resolved.runner_kind)

        # 渲染 user 文本仅为 audit 用（log_user_prompt_len 等）；
        # 真正的 prompt 渲染在各 Runner 内部完成。
        spec = load_spec(task.spec_ref, self._spec_search_root)
        try:
            from tools.chronicle_sim_v3.llm.render import render
            from tools.chronicle_sim_v3.llm.types import Prompt as LLMPrompt
            _, audit_user_text, _ = render(
                LLMPrompt(
                    spec_ref=task.spec_ref,
                    vars=dict(task.vars),
                    system_extra=task.system_extra,
                ),
                self._spec_search_root,
            )
        except Exception:
            audit_user_text = ""

        cache_mode = self._effective_cache_mode(ref, resolved)
        agent_run_id = self.audit.start(
            logical=resolved.logical,
            physical=resolved.physical,
            runner_kind=resolved.runner_kind,
            spec_ref=task.spec_ref,
            user_text=audit_user_text,
            cache_mode=cache_mode,
            role=ref.role,
        )

        # cache lookup
        cache_payload: dict | None = None
        cache_key = ""
        if self.config.cache.enabled and cache_mode != "off":
            cache_key = agent_cache_key(
                agent_hash=resolved.agent_hash,
                spec_sha=spec.sha,
                vars_payload={
                    "vars": dict(task.vars),
                    "system_extra": task.system_extra,
                },
                output_kind=ref.output_kind,
                runner_kind=resolved.runner_kind,
                mode=cache_mode,
            )
            entry = self.cache.lookup(cache_key)
            if entry:
                cache_payload = entry.get("result", {})
        if cache_payload:
            self.audit.end(
                agent_run_id, cache_hit=True, exit_code=0,
                timings={"total_ms": 0},
                llm_calls_count=cache_payload.get("llm_calls_count"),
            )
            self.usage.record(
                physical=resolved.physical,
                cache_hit=True, latency_ms=0,
                llm_calls=cache_payload.get("llm_calls_count"),
            )
            return AgentResult(
                text=cache_payload.get("text", ""),
                parsed=cache_payload.get("parsed"),
                tool_log=cache_payload.get("tool_log") or [],
                exit_code=0,
                cache_hit=True,
                cached_at=entry.get("created_at") if entry else None,
                timings={"cache_ms": 0},
                audit_id=cache_payload.get("audit_id", ""),
                agent_run_id=agent_run_id,
                physical_agent=resolved.physical,
                runner_kind=resolved.runner_kind,
                llm_calls_count=cache_payload.get("llm_calls_count"),
            )

        timeout_sec = ref.timeout_sec or resolved.timeout_sec
        ctx = AgentRunnerContext(
            run_dir=self.run_dir,
            spec_search_root=self._spec_search_root,
            provider_service=self.provider_service,
            llm_service=self.llm_service,
            chroma=self.chroma,
            observer=observer,
        )

        t_start = monotonic()
        try:
            async with self.limiter.acquire(resolved.runner_kind):
                result = await runner.run_task(
                    resolved=resolved,
                    task=task,
                    ref_output_kind=ref.output_kind,
                    ref_artifact_filename=ref.artifact_filename,
                    ctx=ctx,
                    timeout_sec=timeout_sec,
                )
        except AgentError as e:
            elapsed_ms = int((monotonic() - t_start) * 1000)
            self.audit.end(
                agent_run_id, cache_hit=False, exit_code=1,
                timings={"total_ms": elapsed_ms},
                error_tag=type(e).__name__,
            )
            self.usage.record(
                physical=resolved.physical, cache_hit=False,
                latency_ms=elapsed_ms, error=True,
            )
            raise
        except Exception as e:  # 把未分类异常包装成 AgentRunnerError
            elapsed_ms = int((monotonic() - t_start) * 1000)
            self.audit.end(
                agent_run_id, cache_hit=False, exit_code=1,
                timings={"total_ms": elapsed_ms},
                error_tag=type(e).__name__,
            )
            self.usage.record(
                physical=resolved.physical, cache_hit=False,
                latency_ms=elapsed_ms, error=True,
            )
            raise AgentRunnerError(f"{resolved.runner_kind} runner 异常: {e}") from e

        elapsed_ms = int((monotonic() - t_start) * 1000)
        result.agent_run_id = agent_run_id
        result.physical_agent = resolved.physical
        result.runner_kind = resolved.runner_kind
        result.timings.setdefault("total_ms", elapsed_ms)

        if self.config.cache.enabled and cache_mode != "off" and cache_key:
            self.cache.store(
                cache_key,
                physical_agent=resolved.physical,
                agent_hash=resolved.agent_hash,
                runner_kind=resolved.runner_kind,
                result_payload={
                    "text": result.text,
                    "parsed": result.parsed,
                    "tool_log": result.tool_log,
                    "exit_code": result.exit_code,
                    "audit_id": result.audit_id,
                    "llm_calls_count": result.llm_calls_count,
                },
            )

        self.audit.end(
            agent_run_id, cache_hit=False, exit_code=result.exit_code,
            timings=result.timings,
            llm_calls_count=result.llm_calls_count,
        )
        self.usage.record(
            physical=resolved.physical, cache_hit=False,
            latency_ms=elapsed_ms, llm_calls=result.llm_calls_count,
        )
        return result

    def list_routes(self) -> dict[str, str]:
        return dict(self.config.routes)

    def list_agents(self) -> dict[str, dict]:
        return {
            name: {
                "runner": a.runner,
                "provider": a.provider,
                "llm_route": a.llm_route,
                "model_id": a.model_id,
                "timeout_sec": a.timeout_sec,
                "config_keys": sorted(a.config.keys()),
            }
            for name, a in self.config.agents.items()
        }

    def resolve_route(self, logical: str) -> ResolvedAgent:
        return self.resolver.resolve(logical)

    async def aclose(self) -> None:
        self._closed = True

    # ---------- 内部 ----------

    def _effective_cache_mode(
        self,
        ref: AgentRef,
        resolved: ResolvedAgent,
    ) -> str:
        if ref.cache and ref.cache != "auto":
            return ref.cache
        return self.config.cache.per_route.get(
            resolved.physical, self.config.cache.default_mode
        )
