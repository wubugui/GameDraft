"""ClineRunner —— 起 cline CLI 子进程；凭据来自 ProviderService。

行为参考旧 llm/backend/cline.py（已删除），但结构 / 错误 / 凭据来源全部改造：
1. cline_executable 自动探测（PATH / Windows %APPDATA%/npm/cline.cmd）
2. 临时 cwd `<run>/.chronicle_sim/ws/cline_<uuid>/`
3. `.clinerules/{01_role.md, 02_mcp.md (条件), 03_output_contract.md}` 由 spec 注入
4. `input.md`（user 全文）
5. argv：`cline task -y -a --config <dir> -c <cwd> --timeout <sec> [--json] <SHORT_PROMPT>`
   - 末参恒为短引导句（避免 Windows CreateProcess 命令行总长限制）
   - openai_compat + base_url：task 省略 -m（让 cline auth 写入的模型生效）
6. `cline auth -p openai -k <key> -m <model> -b <base>` 刷凭据（ollama 不传 -k）
7. env：`CLINE_DIR=<run>/.cline_config`，剥代理变量，`NO_PROXY=*`
8. Windows：`CREATE_NO_WINDOW`；libuv 0xC0000409 / UV_HANDLE_CLOSING / async.c 抖动重试 3 次
9. stderr 流式 → observer.on_log_line
10. 工作区文件优先回读（按 ref_artifact_filename），stdout 兜底
11. 成功后 archive_workspace（便于排查归档）
12. 错误分类映射到 AgentRunnerError
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
from tools.chronicle_sim_v3.llm.render import AgentSpec, load_spec
from tools.chronicle_sim_v3.llm.output_parse import parse_output
from tools.chronicle_sim_v3.llm.render import render
from tools.chronicle_sim_v3.llm.types import OutputSpec, Prompt as LLMPrompt
from tools.chronicle_sim_v3.providers.errors import ProviderError
from tools.chronicle_sim_v3.providers.types import ProviderKind, ResolvedProvider

_CLINE_DIRNAME = ".cline_config"

_INPUT_MD_TASK_PROMPT = (
    "完整任务与用户数据已写入当前工作目录 input.md（UTF-8）。"
    "请先用 read_file 读取 input.md 全文，再严格按 .clinerules 里的角色要求输出；"
    "勿以未收到任务正文为由拒答。"
)

_DEFAULT_OUTPUT_CONTRACT = """\
# 输出契约

- 严格按 01_role.md 定义的角色与输出格式；不要添加无关解释
- 若 OutputSpec.kind 为 json_object / json_array：直接输出合法 JSON，不要包 ``` 围栏
- 若 OutputSpec.kind 为 text：直接输出最终文本
- 完成后调用 attempt_completion 结束任务
"""


def resolve_cline_executable(explicit: str = "") -> str:
    if explicit:
        p = Path(explicit).expanduser()
        if p.is_file():
            return str(p.resolve())
        w = shutil.which(explicit)
        if w:
            return w
        return explicit
    for name in ("cline", "cline.cmd"):
        w = shutil.which(name)
        if w:
            return w
    if os.name == "nt":
        for env_key in ("APPDATA", "LOCALAPPDATA"):
            base = os.environ.get(env_key, "")
            if not base:
                continue
            for fname in ("cline.cmd", "cline"):
                cand = Path(base) / "npm" / fname
                if cand.is_file():
                    return str(cand.resolve())
    return "cline"


def _materialize_clinerules(ws: Path, spec: AgentSpec) -> None:
    rules = ws / ".clinerules"
    rules.mkdir()
    (rules / "01_role.md").write_text(
        spec.system or "(empty system)\n", encoding="utf-8"
    )
    if spec.needs_clinerules_mcp:
        (rules / "02_mcp.md").write_text(spec.mcp + "\n", encoding="utf-8")
    contract = spec.output_contract or _DEFAULT_OUTPUT_CONTRACT
    (rules / "03_output_contract.md").write_text(contract, encoding="utf-8")


def _build_auth_argv(
    exe: str,
    config_dir: Path,
    provider: ResolvedProvider,
    model_id: str,
    *,
    verbose: bool = False,
) -> list[str] | None:
    cfg = ["--config", str(config_dir)]

    def _vx(rest: list[str]) -> list[str]:
        return [exe, "--verbose", *rest] if verbose else [exe, *rest]

    kind: ProviderKind = provider.kind
    if kind in ("openai_compat", "dashscope_compat"):
        key = (provider.api_key or "").strip() or "no-api-key"
        model = (model_id or "gpt-4o-mini").strip()
        base = (provider.base_url or "").strip().rstrip("/")
        if not base:
            base = "https://api.openai.com/v1"
        return _vx([*cfg, "auth", "-p", "openai", "-k", key, "-m", model, "-b", base])
    if kind == "ollama":
        host = (provider.base_url or "http://127.0.0.1:11434").rstrip("/")
        model = (model_id or "llama3").strip()
        return _vx([*cfg, "auth", "-p", "ollama", "-m", model, "-b", f"{host}/v1"])
    if kind == "stub":
        # stub 不需要刷凭据
        return None
    return None


def _cline_task_model_flag(
    provider: ResolvedProvider,
    model_id: str,
) -> str | None:
    """openai_compat + 自定义 base_url 时 task 省略 -m，
    让 cline auth 写入的 model 生效。"""
    if provider.kind in ("openai_compat", "dashscope_compat") and provider.base_url.strip():
        return None
    m = (model_id or "").strip()
    return m or None


def _build_task_argv(
    exe: str,
    config_dir: Path,
    ws: Path,
    *,
    output_kind: str,
    timeout_sec: int,
    model_flag: str | None,
    verbose: bool,
) -> list[str]:
    args: list[str] = [exe]
    if verbose:
        args.append("--verbose")
    args.append("task")
    args.extend([
        "-y", "-a",
        "--config", str(config_dir),
        "-c", str(ws),
        "--timeout", str(timeout_sec),
    ])
    if model_flag:
        args.extend(["-m", model_flag])
    if output_kind == "jsonl":
        args.append("--json")
    args.append(_INPUT_MD_TASK_PROMPT)
    return args


def _read_artifact_or_stdout(
    ws: Path,
    artifact_filename: str,
    stdout_text: str,
) -> str:
    if artifact_filename:
        p = ws / artifact_filename
        if p.is_file():
            try:
                body = p.read_text(encoding="utf-8").strip()
                if body:
                    return body
            except OSError:
                pass
    return stdout_text.strip()


def _stub_cline_text(seed: str, rendered_user: str, physical: str, output_kind: str) -> str:
    import json
    if output_kind == "text":
        return f"[cline-stub:{physical}] seed={seed} prompt={rendered_user[:60]!r}"
    if output_kind == "json_object":
        return json.dumps({
            "ok": True,
            "seed": seed,
            "runner": "cline",
            "physical": physical,
            "echo": rendered_user[:200],
        }, ensure_ascii=False)
    if output_kind == "json_array":
        return json.dumps([{
            "ok": True,
            "seed": seed,
            "runner": "cline",
            "physical": physical,
            "echo": rendered_user[:120],
        }], ensure_ascii=False)
    if output_kind == "jsonl":
        return "\n".join([
            json.dumps({"type": "say", "text": f"[cline-stub] {rendered_user[:60]}"}, ensure_ascii=False),
            json.dumps({"final": {"ok": True, "seed": seed, "runner": "cline"}}, ensure_ascii=False),
        ])
    return f"[cline-stub:{physical}:unknown_kind={output_kind}]"


class ClineRunner(SubprocessAgentRunner):
    runner_kind = "cline"

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
                f"agent {resolved.physical} runner=cline 必须配 provider"
            )
        try:
            provider = ctx.provider_service.resolve(resolved.provider_id)
        except ProviderError as e:
            raise AgentConfigError(
                f"cline runner 无法解析 provider {resolved.provider_id!r}: {e}"
            ) from e

        spec = load_spec(task.spec_ref, ctx.spec_search_root)
        # 渲染 user 文本（cline 是 black box，不需要 system 文本，
        # system 由 .clinerules 注入）
        from tools.chronicle_sim_v3.llm.render import render
        from tools.chronicle_sim_v3.llm.types import Prompt as LLMPrompt
        _, rendered_user, _ = render(
            LLMPrompt(
                spec_ref=task.spec_ref,
                vars=dict(task.vars),
                system_extra=task.system_extra,
            ),
            ctx.spec_search_root,
        )

        config_dir = (ctx.run_dir / _CLINE_DIRNAME).resolve()
        config_dir.mkdir(parents=True, exist_ok=True)

        ws = materialize_temp_ws(ctx.run_dir, sub="cline")
        _materialize_clinerules(ws, spec)
        if rendered_user.strip():
            (ws / "input.md").write_text(rendered_user, encoding="utf-8")

        if provider.kind == "stub":
            import hashlib
            t_start = monotonic()
            output_spec = OutputSpec(
                kind=ref_output_kind,
                artifact_filename=ref_artifact_filename,
            )
            seed = hashlib.sha256(
                f"{resolved.physical}|{task.spec_ref}|{rendered_user}".encode("utf-8")
            ).hexdigest()[:16]
            raw_text = _stub_cline_text(seed, rendered_user, resolved.physical, ref_output_kind)
            parsed, tool_log = parse_output(raw_text, output_spec)
            elapsed_ms = int((monotonic() - t_start) * 1000)
            return AgentResult(
                text=raw_text if ref_output_kind == "text" else (raw_text if isinstance(parsed, str) else raw_text),
                parsed=parsed,
                tool_log=tool_log,
                exit_code=0,
                timings={"total_ms": elapsed_ms, "stub_ms": elapsed_ms},
                runner_kind=self.runner_kind,
                physical_agent=resolved.physical,
                llm_calls_count=None,
            )

        cfg = resolved.config or {}
        verbose = bool(cfg.get("cline_verbose", False))
        stream_stderr = bool(cfg.get("cline_stream_stderr", True))
        executable_cfg = str(cfg.get("cline_executable", "") or "")

        # 强制禁用系统代理（用户硬约束）；config.no_proxy 已废弃。
        env = build_no_proxy_env()
        env["CLINE_DIR"] = str(config_dir)

        exe = resolve_cline_executable(executable_cfg)
        t_start = monotonic()
        t_auth_ms = 0
        t_exec_ms = 0
        archived_path: Path | None = None
        try:
            auth_argv = _build_auth_argv(
                exe, config_dir, provider,
                model_id=resolved.model_id, verbose=verbose,
            )
            if auth_argv:
                t0 = monotonic()
                await self._run_one(
                    auth_argv, env, str(ctx.run_dir.resolve()),
                    timeout=120.0, observer=observer,
                    stream_stderr=stream_stderr,
                    phase="cline.auth", source="cline",
                )
                t_auth_ms = int((monotonic() - t0) * 1000)

            model_flag = _cline_task_model_flag(provider, resolved.model_id)
            task_argv = _build_task_argv(
                exe, config_dir, ws,
                output_kind=ref_output_kind, timeout_sec=timeout_sec,
                model_flag=model_flag, verbose=verbose,
            )
            t0 = monotonic()
            out_b, err_b, rc = await self._run_one(
                task_argv, env, str(ws),
                timeout=float(timeout_sec), observer=observer,
                stream_stderr=stream_stderr,
                phase="cline.task", source="cline",
                return_streams=True,
            )
            t_exec_ms = int((monotonic() - t0) * 1000)
            text_out = (out_b or b"").decode("utf-8", errors="replace")

            if rc != 0:
                err_t = (err_b or b"").decode("utf-8", errors="replace")[:500]
                raise AgentRunnerError(
                    f"cline exit={rc} stderr={err_t!r}"
                )

            final_text = _read_artifact_or_stdout(
                ws, ref_artifact_filename, text_out
            )
            archived_path = archive_workspace(
                ctx.run_dir, ws, role=resolved.physical
            )
            return AgentResult(
                text=final_text,
                exit_code=0,
                timings={
                    "total_ms": int((monotonic() - t_start) * 1000),
                    "auth_ms": t_auth_ms,
                    "exec_ms": t_exec_ms,
                },
                runner_kind=self.runner_kind,
                physical_agent=resolved.physical,
                llm_calls_count=None,  # cline 内部 LLM 调用不可观测
            )
        finally:
            if ws.is_dir() and archived_path is None:
                archive_workspace(ctx.run_dir, ws, role=resolved.physical)
