"""ExternalRunner —— 通用外部 CLI agent。

行为：
1. 渲染 spec → 写 input.md 到临时 cwd
2. 通过 ProviderService 拿凭据
3. 按 argv_template 构造 argv，占位替换：
   ${input_file} ${output_file} ${cwd} ${api_key} ${base_url} ${model_id}
4. env_vars 同样支持占位（不写到 audit）
5. 子进程跑完读 output_file（utf-8）→ AgentResult.text
6. 错误归一为 AgentRunnerError
7. argv_template 必须是 list[str]；禁止 shell 字符串拼接
"""
from __future__ import annotations

import os
import shutil
from pathlib import Path
from time import monotonic
from typing import Any

from tools.chronicle_sim_v3.agents.errors import (
    AgentConfigError,
    AgentRunnerError,
)
from tools.chronicle_sim_v3.agents.resolver import ResolvedAgent
from tools.chronicle_sim_v3.agents.runners.base import (
    SubprocessAgentRunner,
    archive_workspace,
    build_no_proxy_env,
    materialize_temp_ws,
)
from tools.chronicle_sim_v3.agents.types import AgentResult, AgentTask
from tools.chronicle_sim_v3.providers.errors import ProviderError
from tools.chronicle_sim_v3.providers.types import ResolvedProvider


_DEFAULT_OUTPUT_FILE = "agent_output.txt"
_INPUT_FILE = "input.md"


def _resolve_executable(explicit: str) -> str:
    if not explicit:
        raise AgentConfigError("external runner config 必须含 executable")
    p = Path(explicit).expanduser()
    if p.is_file():
        return str(p.resolve())
    w = shutil.which(explicit)
    if w:
        return w
    return explicit


def _substitute(template: str, mapping: dict[str, str]) -> str:
    out = template
    for k, v in mapping.items():
        out = out.replace("${" + k + "}", v)
    return out


def _build_argv(
    exe: str,
    template: list,
    mapping: dict[str, str],
) -> list[str]:
    if not isinstance(template, list):
        raise AgentConfigError(
            "external runner config.argv_template 必须是 list[str]，"
            "禁止 shell 字符串拼接"
        )
    argv = [exe]
    for piece in template:
        if not isinstance(piece, str):
            raise AgentConfigError(
                "external runner argv_template 元素必须是 str，"
                f"got {type(piece).__name__}"
            )
        argv.append(_substitute(piece, mapping))
    return argv


def _build_env(
    base_env: dict[str, str],
    env_vars_template: dict | None,
    mapping: dict[str, str],
) -> dict[str, str]:
    env = dict(base_env)
    if not env_vars_template:
        return env
    if not isinstance(env_vars_template, dict):
        raise AgentConfigError(
            "external runner config.env_vars 必须是 dict[str, str]"
        )
    for k, raw in env_vars_template.items():
        if not isinstance(k, str) or not isinstance(raw, str):
            raise AgentConfigError(
                "external runner env_vars key/value 必须是 str"
            )
        env[k] = _substitute(raw, mapping)
    return env


class ExternalRunner(SubprocessAgentRunner):
    runner_kind = "external"

    async def run_task(
        self,
        resolved: ResolvedAgent,
        task: AgentTask,
        ref_output_kind: str,
        ref_artifact_filename: str,
        ctx: Any,
        timeout_sec: int,
    ) -> AgentResult:
        observer = ctx.observer
        if not resolved.provider_id:
            raise AgentConfigError(
                f"agent {resolved.physical} runner=external 必须配 provider"
            )
        try:
            provider = ctx.provider_service.resolve(resolved.provider_id)
        except ProviderError as e:
            raise AgentConfigError(
                f"external runner 无法解析 provider {resolved.provider_id!r}: {e}"
            ) from e

        cfg = resolved.config or {}
        executable = str(cfg.get("executable", "") or "")
        argv_template = cfg.get("argv_template")
        env_vars_template = cfg.get("env_vars") or {}
        output_file_name = str(cfg.get("output_file", "") or _DEFAULT_OUTPUT_FILE)
        stream_stderr = bool(cfg.get("stream_stderr", True))

        # 渲染 user 文本写入 input.md
        from tools.chronicle_sim_v3.llm.render import render
        from tools.chronicle_sim_v3.llm.types import Prompt as LLMPrompt
        sys_text, usr_text, _ = render(
            LLMPrompt(
                spec_ref=task.spec_ref,
                vars=dict(task.vars),
                system_extra=task.system_extra,
            ),
            ctx.spec_search_root,
        )
        ws = materialize_temp_ws(ctx.run_dir, sub="external")
        body = ((sys_text + "\n\n---\n\n") if sys_text.strip() else "") + usr_text
        (ws / _INPUT_FILE).write_text(body, encoding="utf-8")

        input_file = ws / _INPUT_FILE
        output_file = ws / (
            ref_artifact_filename or output_file_name
        )

        mapping = {
            "input_file": str(input_file),
            "output_file": str(output_file),
            "cwd": str(ws),
            "api_key": provider.api_key or "",
            "base_url": provider.base_url or "",
            "model_id": resolved.model_id,
        }
        try:
            exe = _resolve_executable(executable)
            argv = _build_argv(exe, argv_template, mapping)
            base_env = build_no_proxy_env()
            env = _build_env(base_env, env_vars_template, mapping)
        except AgentConfigError:
            archive_workspace(ctx.run_dir, ws, role=resolved.physical)
            raise

        t_start = monotonic()
        archived: Path | None = None
        try:
            await self._run_one(
                argv, env, str(ws),
                timeout=float(timeout_sec), observer=observer,
                stream_stderr=stream_stderr,
                phase=f"external.{resolved.physical}",
                source=f"external.{resolved.physical}",
            )
            elapsed_ms = int((monotonic() - t_start) * 1000)

            if not output_file.is_file():
                raise AgentRunnerError(
                    f"external runner 未产出 output_file {output_file}"
                )
            try:
                text_out = output_file.read_text(encoding="utf-8").strip()
            except OSError as e:
                raise AgentRunnerError(
                    f"external runner 读取 output_file 失败: {e}"
                ) from e

            archived = archive_workspace(ctx.run_dir, ws, role=resolved.physical)
            return AgentResult(
                text=text_out,
                exit_code=0,
                timings={"total_ms": elapsed_ms},
                runner_kind=self.runner_kind,
                physical_agent=resolved.physical,
                llm_calls_count=None,
            )
        finally:
            if ws.is_dir() and archived is None:
                archive_workspace(ctx.run_dir, ws, role=resolved.physical)
