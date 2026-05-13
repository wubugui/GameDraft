"""SimpleChatRunner —— 内部调 LLMService.chat 一次，包成 AgentResult。

设计：
- 把 AgentTask + ResolvedAgent 翻译成 LLMRef + Prompt
- 逻辑模型 = ResolvedAgent.llm_route（必须，simple_chat / react 都靠它）
- LLM 层负责重试 / cache / audit；Agent 层只负责 audit + cache（粒度 = 整次 agent 任务）
- llm_calls_count = 1
"""
from __future__ import annotations

from time import monotonic
from typing import Any

from tools.chronicle_sim_v3.agents.errors import (
    AgentConfigError,
    AgentRunnerError,
)
from tools.chronicle_sim_v3.agents.resolver import ResolvedAgent
from tools.chronicle_sim_v3.agents.runners.base import AgentRunnerContext
from tools.chronicle_sim_v3.agents.types import AgentResult, AgentTask
from tools.chronicle_sim_v3.llm.errors import LLMError
from tools.chronicle_sim_v3.llm.types import LLMRef, OutputSpec, Prompt


class SimpleChatRunner:
    runner_kind = "simple_chat"

    async def run_task(
        self,
        resolved: ResolvedAgent,
        task: AgentTask,
        ref_output_kind: str,
        ref_artifact_filename: str,
        ctx: AgentRunnerContext,
        timeout_sec: int,
    ) -> AgentResult:
        if not resolved.llm_route:
            raise AgentConfigError(
                f"agent {resolved.physical} runner=simple_chat 必须配 llm_route"
            )
        if ctx.llm_service is None:
            raise AgentConfigError(
                "AgentService 未注入 llm_service，simple_chat 无法工作"
            )

        cfg = resolved.config or {}
        cache_mode_cfg = str(cfg.get("cache", "auto"))
        # AgentService 已经在外层处理 agent-level 缓存；
        # 这里给 LLM 层用 off，避免双层缓存冲突
        llm_cache_mode = "off" if cache_mode_cfg == "off" else "auto"

        ref = LLMRef(
            role=resolved.physical,
            model=resolved.llm_route,
            output=OutputSpec(
                kind=ref_output_kind or "text",
                artifact_filename=ref_artifact_filename,
            ),
            cache=llm_cache_mode,
            timeout_sec=timeout_sec,
        )
        prompt = Prompt(
            spec_ref=task.spec_ref,
            vars=dict(task.vars),
            system_extra=task.system_extra,
        )

        t0 = monotonic()
        try:
            result = await ctx.llm_service.chat(ref, prompt)
        except LLMError as e:
            raise AgentRunnerError(f"simple_chat LLM 错误: {e}") from e
        elapsed_ms = int((monotonic() - t0) * 1000)

        return AgentResult(
            text=result.text,
            parsed=result.parsed,
            tool_log=list(result.tool_log or []),
            exit_code=result.exit_code,
            timings={
                "total_ms": elapsed_ms,
                "llm_ms": int(result.timings.get("total_ms", elapsed_ms) or elapsed_ms),
            },
            audit_id=result.audit_id,
            runner_kind=self.runner_kind,
            physical_agent=resolved.physical,
            llm_calls_count=1,
        )
