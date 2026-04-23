"""ReActRunner —— 多轮 Thought-Tool-Observation 循环。

每轮：
1. 渲染 prompt（spec.system + spec.user + 工具契约 + 上一轮 OBSERVATION）
2. 调一次 LLMService.chat（cache 关掉，避免循环里 cache 串味）
3. 解析输出（THOUGHT / TOOL+ARGS 或 FINAL）
4. 若 FINAL 或 TOOL=final 则结束并返回 AgentResult
5. 否则执行 tool 拿 OBSERVATION，进入下一轮

约束：
- max_iter（默认 10），超出抛 AgentRunnerError
- 工具错误不抛，作为 OBSERVATION 反馈让模型继续
- llm_calls_count = 实际成功的 chat 次数
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from time import monotonic
from typing import Any

from tools.chronicle_sim_v3.agents.errors import (
    AgentConfigError,
    AgentRunnerError,
)
from tools.chronicle_sim_v3.agents.resolver import ResolvedAgent
from tools.chronicle_sim_v3.agents.runners.base import AgentRunnerContext
from tools.chronicle_sim_v3.agents.runners.react_tools import (
    REACT_TOOLS,
    ReactToolCtx,
    render_tools_doc,
)
from tools.chronicle_sim_v3.agents.types import AgentResult, AgentTask
from tools.chronicle_sim_v3.llm.errors import LLMError
from tools.chronicle_sim_v3.llm.types import LLMRef, OutputSpec, Prompt

_PROTOCOL_FILE = "data/agent_specs/_react_protocol.md"

_LINE_RE = re.compile(r"^([A-Z]+):\s*(.*)$")


def _read_protocol(spec_search_root: Path) -> str:
    cand = spec_search_root / _PROTOCOL_FILE
    if cand.is_file():
        try:
            return cand.read_text(encoding="utf-8")
        except OSError:
            pass
    pkg_root = Path(__file__).resolve().parents[2]
    cand2 = pkg_root / _PROTOCOL_FILE
    if cand2.is_file():
        try:
            return cand2.read_text(encoding="utf-8")
        except OSError:
            pass
    return ""


def parse_react_output(text: str) -> dict:
    """把 LLM 输出解析成 {kind, thought, tool, args, final}。

    宽松解析：忽略前后空行 / 兼容 ARGS 在多行（聚合到下一个大写 KEY 之前）。
    """
    lines = text.splitlines()
    fields: dict[str, str] = {}
    cur_key: str | None = None
    cur_buf: list[str] = []
    for ln in lines:
        m = _LINE_RE.match(ln.strip())
        if m and m.group(1) in {"THOUGHT", "TOOL", "ARGS", "FINAL", "OBSERVATION"}:
            if cur_key is not None:
                fields[cur_key] = "\n".join(cur_buf).strip()
            cur_key = m.group(1)
            cur_buf = [m.group(2)]
        else:
            if cur_key is not None:
                cur_buf.append(ln)
    if cur_key is not None:
        fields[cur_key] = "\n".join(cur_buf).strip()

    thought = fields.get("THOUGHT", "")
    if "FINAL" in fields:
        return {
            "kind": "final",
            "thought": thought,
            "final": fields["FINAL"],
        }
    if "TOOL" in fields:
        tool = fields["TOOL"].strip()
        args_raw = fields.get("ARGS", "{}").strip() or "{}"
        try:
            args = json.loads(args_raw)
            if not isinstance(args, dict):
                args = {"_value": args}
        except json.JSONDecodeError:
            args = {"_raw": args_raw, "_parse_error": True}
        return {
            "kind": "tool",
            "thought": thought,
            "tool": tool,
            "args": args,
        }
    return {
        "kind": "malformed",
        "thought": thought,
        "raw": text.strip(),
    }


class ReActRunner:
    runner_kind = "react"

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
                f"agent {resolved.physical} runner=react 必须配 llm_route"
            )
        if ctx.llm_service is None:
            raise AgentConfigError(
                "AgentService 未注入 llm_service，react 无法工作"
            )

        cfg = resolved.config or {}
        max_iter = int(cfg.get("max_iter", 10))
        if max_iter <= 0:
            raise AgentConfigError(
                f"agent {resolved.physical} react max_iter 必须 > 0"
            )
        enabled_tools = list(cfg.get("tools") or list(REACT_TOOLS.keys()))
        for t in enabled_tools:
            if t not in REACT_TOOLS:
                raise AgentConfigError(
                    f"agent {resolved.physical} react 启用未知工具: {t!r}"
                )

        protocol = _read_protocol(ctx.spec_search_root)
        tools_doc = render_tools_doc(enabled_tools)
        system_extra_base = task.system_extra
        protocol_extra = "\n\n".join(
            x for x in [system_extra_base, protocol, tools_doc] if x
        )

        tool_ctx = ReactToolCtx(vars=dict(task.vars), chroma=ctx.chroma)
        tool_log: list[dict] = []
        observation_buf: list[str] = []
        final_text: str | None = None
        llm_calls = 0
        per_iter_timeout = max(8, int(timeout_sec / max(1, max_iter)) + 4)

        t_start = monotonic()
        for it in range(max_iter):
            if observation_buf:
                obs_block = "\n\n# 上一轮 OBSERVATION\n" + "\n".join(
                    f"- {line}" for line in observation_buf
                )
            else:
                obs_block = ""
            ref = LLMRef(
                role=f"{resolved.physical}.react.{it}",
                model=resolved.llm_route,
                output=OutputSpec(kind="text"),
                cache="off",
                timeout_sec=per_iter_timeout,
            )
            vars_with_obs = dict(task.vars)
            vars_with_obs["__react_observations"] = obs_block.strip()
            prompt = Prompt(
                spec_ref=task.spec_ref,
                vars=vars_with_obs,
                system_extra=protocol_extra,
            )
            try:
                llm_result = await ctx.llm_service.chat(ref, prompt)
            except LLMError as e:
                raise AgentRunnerError(
                    f"react iter={it} LLM 错误: {e}"
                ) from e
            llm_calls += 1
            parsed = parse_react_output(llm_result.text)
            tool_log.append({
                "iter": it,
                "thought": parsed.get("thought", ""),
                "kind": parsed["kind"],
                "raw_len": len(llm_result.text or ""),
            })
            ctx.observer.on_phase("react.iter", {
                "iter": it, "kind": parsed["kind"],
            })

            if parsed["kind"] == "final":
                final_text = parsed["final"]
                tool_log[-1]["final"] = final_text
                break
            if parsed["kind"] == "malformed":
                observation_buf = [
                    "ERROR: 输出格式不合法，"
                    "请严格按 THOUGHT/TOOL/ARGS 或 THOUGHT/FINAL 模板"
                ]
                continue
            tool = parsed["tool"]
            if tool not in enabled_tools:
                observation_buf = [
                    f"ERROR: 工具 {tool!r} 未在本任务的可用列表内"
                ]
                tool_log[-1]["tool"] = tool
                tool_log[-1]["error"] = "tool_not_enabled"
                continue
            tool_log[-1]["tool"] = tool
            tool_log[-1]["args"] = parsed["args"]
            try:
                obs = await REACT_TOOLS[tool](parsed["args"], tool_ctx)
            except Exception as e:  # 不让工具炸 runner
                obs = f"ERROR: 工具 {tool} 抛异常: {type(e).__name__}: {e}"
            tool_log[-1]["observation_len"] = len(obs)
            observation_buf = [f"TOOL {tool} OBSERVATION: {obs}"]
            if tool == "final":
                final_text = obs
                tool_log[-1]["final"] = final_text
                break

        if final_text is None:
            raise AgentRunnerError(
                f"react max_iter={max_iter} 未给出 FINAL"
            )

        elapsed_ms = int((monotonic() - t_start) * 1000)
        return AgentResult(
            text=final_text,
            tool_log=tool_log,
            exit_code=0,
            timings={"total_ms": elapsed_ms, "iters": len(tool_log)},
            runner_kind=self.runner_kind,
            physical_agent=resolved.physical,
            llm_calls_count=llm_calls,
        )
