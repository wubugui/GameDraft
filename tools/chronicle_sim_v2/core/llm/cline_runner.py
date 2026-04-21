"""Cline CLI 子进程调用：每次 agent 调用独立临时 cwd + Run 级 `--config`。

唯一入口：`run_agent_cline(...)`；LLM/Cline 相关选项一律从 ``run_dir/config/llm_config.json`` 读取。
stub 槽位短路返回本地占位文本，不起子进程。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from time import monotonic
from typing import Any

from tools.chronicle_sim_v2.core.llm.agent_llm import AgentLLMResources
from tools.chronicle_sim_v2.core.llm.agent_spec import AgentSpec, render_system
from tools.chronicle_sim_v2.core.llm.audit_log import (
    append_llm_audit,
    audit_enabled_from_config,
)
from tools.chronicle_sim_v2.core.llm.cline_workspace import (
    cleanup_temp_ws,
    cline_config_path,
    materialize_temp_ws,
    write_llm_effective_snapshot,
)
from tools.chronicle_sim_v2.core.llm.llm_trace import emit_llm_trace, get_llm_gate
from tools.chronicle_sim_v2.core.llm.provider_profile import ProviderProfile
from tools.chronicle_sim_v2.core.llm.stub_llm import ChronicleStubLLM, stub_response_text
from tools.chronicle_sim_v2.core.sim.run_manager import load_llm_config

ARGV_STDIN_THRESHOLD = 8192
DEFAULT_TIMEOUT_SEC = 3600
# Cline `cline task --thinking [tokens]` 会把下一 argv 当作 token 数；裸 `--thinking` 会吞掉紧跟的 prompt。
THINKING_TOKEN_DEFAULT = "1024"
# 新版 Cline CLI：`task` 子命令要求 argv 中必须出现可被识别的 prompt；**stdin 不再**计为 prompt，
# 长文若仍走「短占位句 + stdin」会报 ``Either taskId or prompt must be provided``。
# 长提示改为：同目录 ``input.md`` 已含全文（run_agent_cline 在 cwd 物化），末参为下述短句引导 read_file。
INPUT_MD_TASK_PROMPT = (
    "完整任务与用户数据已写入当前工作目录 input.md（UTF-8）。"
    "请先用 read_file 读取 input.md 全文，再严格按 .clinerules 里的角色要求输出；勿以未收到任务正文为由拒答。"
)
_INITIALIZER_SEED_FILENAME = "seed_draft.json"
_DEFAULT_ACT_JSON_FILENAME = "agent_output.json"
# ACT 模式下完整 JSON 落盘；initializer 沿用历史文件名，其余 JSON 类 agent 统一 agent_output.json
_ACT_JSON_ARTIFACT: dict[str, str] = {
    "initializer": _INITIALIZER_SEED_FILENAME,
    "director": _DEFAULT_ACT_JSON_FILENAME,
    "gm": _DEFAULT_ACT_JSON_FILENAME,
    "tier_s_npc": _DEFAULT_ACT_JSON_FILENAME,
    "tier_a_npc": _DEFAULT_ACT_JSON_FILENAME,
    "tier_b_npc": _DEFAULT_ACT_JSON_FILENAME,
}


def _merge_act_json_file_from_workspace(
    temp_ws: Path, stdout_text: str, agent_id: str
) -> tuple[str, bool, str]:
    """Cline ACT 下 stdout 常为 ``attempt_completion`` 摘要；完整 JSON 应落在工作区约定文件名。

    若工作区存在以 ``{`` / ``[`` 开头的正文，则优先于 stdout。返回 ``(text, took_file, filename_used)``。
    """
    fname = _ACT_JSON_ARTIFACT.get(agent_id)
    if not fname:
        return stdout_text, False, ""
    path = temp_ws / fname
    if not path.is_file():
        return stdout_text, False, ""
    try:
        body = path.read_text(encoding="utf-8")
    except OSError:
        return stdout_text, False, ""
    stripped = body.lstrip("\ufeff").strip()
    if stripped.startswith("{") or stripped.startswith("["):
        return stripped, True, fname
    return stdout_text, False, ""


@dataclass
class RunnerResult:
    """unified runner 输出。jsonl 模式下 `tool_log` 为 Cline 侧工具调用记录。

    `temp_ws_path` 仅在 `keep_temp_ws=True` 时非空；调用方必须自己负责清理。
    """

    text: str
    tool_log: list[dict[str, Any]] = field(default_factory=list)
    exit_code: int = 0
    temp_ws_path: Path | None = None


def _normalize_openai_compat_base_url(base: str) -> str:
    b = (base or "").strip().rstrip("/")
    if not b:
        return "https://api.openai.com/v1"
    if b.endswith("/v1") or "/v1" in b:
        return b
    return f"{b}/v1"


def _cline_log_flags(llm_config: dict[str, Any] | None) -> tuple[bool, bool]:
    """(cline_verbose, cline_stream_stderr)：前者为 CLI 增加 --verbose；后者为运行中转发 stderr 行。"""
    cfg = llm_config or {}
    verbose = bool(cfg.get("cline_verbose", False))
    raw = cfg.get("cline_stream_stderr", True)
    if isinstance(raw, str):
        stream = raw.strip().lower() not in ("0", "false", "no", "off", "")
    else:
        stream = bool(raw)
    return verbose, stream


def build_cline_auth_argv(
    exe: str,
    config_dir: Path,
    profile: ProviderProfile,
    *,
    verbose: bool = False,
) -> list[str] | None:
    """构造非交互 `cline auth --config <dir> ...` 参数；stub / 无连接时返回 None。"""
    kind = (profile.kind or "").lower()
    if kind in ("", "stub"):
        return None
    model = (profile.model or "").strip()
    cfg = ["--config", str(config_dir)]

    def _vx(rest: list[str]) -> list[str]:
        if verbose:
            return [exe, "--verbose", *rest]
        return [exe, *rest]

    if kind == "openai_compat":
        # 一律 ``-p openai`` + ``-b``：与界面「OpenAI 兼容」一致；不再根据 sk-ant- 猜 Anthropic（易与纯兼容网关混淆）。
        key = (profile.api_key or "").strip()
        raw_base = (profile.base_url or "").strip()
        if not model:
            model = "gpt-4o-mini"
        base = _normalize_openai_compat_base_url(raw_base)
        k = key if key else "no-api-key"
        return _vx([*cfg, "auth", "-p", "openai", "-k", k, "-m", model, "-b", base])

    if kind == "ollama":
        host = (profile.ollama_host or "http://127.0.0.1:11434").rstrip("/")
        if not model:
            model = "llama3"
        base = f"{host}/v1"
        return _vx([*cfg, "auth", "-p", "ollama", "-m", model, "-b", base])

    return None


async def _feed_stdin_if_needed(
    proc: asyncio.subprocess.Process,
    *,
    use_stdin: bool,
    data: bytes | None,
) -> None:
    if not use_stdin or not data:
        if proc.stdin is not None:
            proc.stdin.close()
        return
    proc.stdin.write(data)
    await proc.stdin.drain()
    proc.stdin.close()


async def _drain_stderr_lines(
    proc: asyncio.subprocess.Process,
    emit: Any,
    *,
    prefix: str = "[Cline·stderr]",
) -> bytes:
    buf = bytearray()
    if proc.stderr is None:
        return b""
    while True:
        line = await proc.stderr.readline()
        if not line:
            break
        buf.extend(line)
        if emit:
            s = line.decode("utf-8", errors="replace").rstrip("\r\n")
            if s:
                clipped = s if len(s) <= 8000 else s[:8000] + "…"
                emit(f"{prefix} {clipped}")
    return bytes(buf)


async def _communicate_with_stderr_stream(
    proc: asyncio.subprocess.Process,
    *,
    stdin_bytes: bytes | None,
    use_stdin: bool,
    stream_stderr: bool,
    stderr_emit: Any,
) -> tuple[bytes, bytes]:
    """与 communicate 等价，但在 stream_stderr 时对 stderr 按行回调（便于 GUI 实时日志）。"""
    # Windows：**一律**用 communicate，禁止走下方 gather；否则在 stream_stderr=false 等分支仍可能并发读写管道，
    # Cline(Node)/libuv 退出时出现 UV_HANDLE_CLOSING 断言（约 0xC0000409）。
    if os.name == "nt":
        out_b, err_b = await proc.communicate(stdin_bytes if use_stdin else None)
        out_b, err_b = out_b or b"", err_b or b""
        if stream_stderr and stderr_emit:
            for line in err_b.splitlines():
                s = line.decode("utf-8", errors="replace").rstrip("\r\n")
                if s:
                    clipped = s if len(s) <= 8000 else s[:8000] + "…"
                    stderr_emit(f"[Cline·stderr] {clipped}")
        return out_b, err_b

    if not stream_stderr or proc.stderr is None:
        out_b, err_b = await proc.communicate(stdin_bytes if use_stdin else None)
        return out_b or b"", err_b or b""

    async def _read_stdout() -> bytes:
        if proc.stdout is None:
            return b""
        return await proc.stdout.read()

    out_b, err_b, _ = await asyncio.gather(
        _read_stdout(),
        _drain_stderr_lines(proc, stderr_emit),
        _feed_stdin_if_needed(proc, use_stdin=use_stdin, data=stdin_bytes),
    )
    await proc.wait()
    return out_b or b"", err_b or b""


def describe_api_key_for_log(key: str) -> str:
    """与 ``cline auth -k <此值>`` 一致：脱敏描述，便于核对是否与表单粘贴一致（不输出完整密钥）。"""
    k = (key or "").strip()
    if not k:
        return "空字符串（-k 将为 no-api-key 占位，请求必失败）"
    n = len(k)
    if n <= 12:
        return f"len={n}（过短，请检查是否截断）"
    # DashScope/OpenAI 类 sk- 密钥：头尾可对账
    return f"len={n} head={k[:12]!r} tail={k[-4:]!r}"


def _redact_auth_argv_for_log(argv: list[str]) -> str:
    parts: list[str] = []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "-k" and i + 1 < len(argv):
            parts.extend(["-k", "***"])
            i += 2
            continue
        parts.append(a)
        i += 1
    return " ".join(parts[:24]) + (" …" if len(parts) > 24 else "")


def resolve_cline_executable(llm_config: dict[str, Any] | None) -> str:
    """解析 Cline CLI 路径：显式配置 > PATH（cline / cline.cmd）> Windows npm 全局 shim。

    从 IDE、Conda 等环境启动时 PATH 常不含 npm 全局目录，故在 Windows 上额外探测
    ``%APPDATA%\\npm\\cline.cmd`` 等常见位置。
    """
    cfg = llm_config or {}
    raw = str(cfg.get("cline_executable", "") or cfg.get("cline_path", "") or "").strip()
    if raw:
        p = Path(raw).expanduser()
        if p.is_file():
            return str(p.resolve())
        w = shutil.which(raw)
        if w:
            return w
        return raw

    for name in ("cline", "cline.cmd"):
        w = shutil.which(name)
        if w:
            return w

    if os.name == "nt":
        for env_key in ("APPDATA", "LOCALAPPDATA"):
            base = os.environ.get(env_key, "")
            if not base:
                continue
            npm = Path(base) / "npm"
            for fname in ("cline.cmd", "cline"):
                candidate = npm / fname
                if candidate.is_file():
                    return str(candidate.resolve())

    return "cline"


def _cline_exe(llm_config: dict[str, Any] | None) -> str:
    return resolve_cline_executable(llm_config)


def _cline_missing_runtime_error(exe: str) -> RuntimeError:
    extra = ""
    if os.name == "nt":
        ad = (os.environ.get("APPDATA") or "").strip()
        if ad:
            p = Path(ad) / "npm" / "cline.cmd"
            extra = f" 若已执行 npm i -g cline，可将 llm_config.cline_executable 设为: {p}"
    return RuntimeError(
        f"未找到 Cline 可执行文件: {exe}。请安装 Node 20+ 并 npm i -g cline，"
        "或在 llm_config 中设置 cline_executable 为完整路径。"
        + (f" {extra}" if extra else "")
    )


def _cline_timeout_sec(llm_config: dict[str, Any] | None, *, default: int = DEFAULT_TIMEOUT_SEC) -> int:
    cfg = llm_config or {}
    raw = cfg.get("cline_timeout_sec")
    try:
        v = int(raw)
        return max(60, min(v, 86400))
    except (TypeError, ValueError):
        return default


# Node/undici、git、部分库会读这些变量；Cline 子进程必须不走系统代理，避免阿里云等直连被劫持或 401/证书错误。
_CLINE_STRIP_PROXY_ENV = frozenset(
    {
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "FTP_PROXY",
        "ftp_proxy",
        "SOCKS_PROXY",
        "socks_proxy",
        "NO_PROXY",
        "no_proxy",
    }
)


def build_cline_env() -> dict[str, str]:
    """Cline 子进程环境：继承当前进程环境，但剔除代理相关变量，并强制 ``NO_PROXY=*``（不走 HTTP(S) 代理）。"""
    env = dict(os.environ)
    for k in list(env.keys()):
        if k in _CLINE_STRIP_PROXY_ENV:
            env.pop(k, None)
            continue
        lu = k.lower()
        if "proxy" in lu and ("http" in lu or "socks" in lu or lu.endswith("_proxy")):
            env.pop(k, None)
    # 明确声明不经过代理（覆盖系统/用户此前对 NO_PROXY 的设置）
    env["NO_PROXY"] = "*"
    env["no_proxy"] = "*"
    return env


def _cline_subprocess_kwargs() -> dict[str, Any]:
    """Windows：无控制台窗口，减少 Node/libuv 与管道在退出时的异常交互。"""
    if os.name != "nt":
        return {}
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def _is_stub(pa: AgentLLMResources) -> bool:
    profile = getattr(pa, "profile", None)
    if isinstance(getattr(pa, "llm", None), ChronicleStubLLM):
        return True
    if isinstance(profile, ProviderProfile) and (profile.kind or "").lower() in ("", "stub"):
        return True
    return False


def _win_exit_code_unsigned(rc: int) -> int:
    """``subprocess`` 在 Windows 上可能返回负的 NTSTATUS，统一成 32 位无符号便于比对。"""
    if rc >= 0:
        return rc
    return rc + (1 << 32)


def _is_flaky_windows_cline_subprocess(rc: int, err_b: bytes) -> bool:
    """Cline 基于 Node/libuv；Windows 上管道关闭竞态可能触发 ``UV_HANDLE_CLOSING`` 断言崩溃（常见 exit 0xC0000409）。"""
    if os.name != "nt":
        return False
    u = _win_exit_code_unsigned(rc)
    if u == 0xC0000409:
        return True
    es = (err_b or b"").decode("utf-8", errors="replace")
    if "UV_HANDLE_CLOSING" in es:
        return True
    if "Assertion failed" in es and "async.c" in es:
        return True
    return False


async def refresh_cline_auth_for_profile(
    pa: AgentLLMResources,
    run_dir: Path,
    *,
    llm_config: dict[str, Any] | None = None,
    phase_log: Any = None,
) -> None:
    """在启动任务前刷新 Cline 凭据；auth 与任务调用共用同一 `--config` 目录。"""
    if _is_stub(pa):
        return
    cfg = llm_config if llm_config is not None else load_llm_config(run_dir)
    profile = pa.profile
    if not isinstance(profile, ProviderProfile):
        return
    exe = _cline_exe(cfg)
    cl_verbose, cl_stream = _cline_log_flags(cfg)
    argv = build_cline_auth_argv(
        exe, cline_config_path(run_dir), profile, verbose=cl_verbose
    )
    if not argv:
        return

    def _ph(msg: str) -> None:
        if phase_log:
            phase_log(msg)

    def _stderr_emit(msg: str) -> None:
        if phase_log:
            phase_log(msg)
        else:
            emit_llm_trace(msg)

    _ph(f"[Cline] 刷新凭据: {_redact_auth_argv_for_log(argv)}")
    raw_k = (profile.api_key or "").strip() if isinstance(profile, ProviderProfile) else ""
    kind_l = (profile.kind or "").lower()
    if raw_k and kind_l not in ("", "stub", "ollama"):
        _ph(
            f"[Cline] 子进程 ``cline auth`` 的 ``-k`` 与 ``pa.profile.api_key`` 相同，指纹: "
            f"{describe_api_key_for_log(raw_k)}"
        )
    elif kind_l == "ollama":
        _ph("[Cline] ollama 槽位 auth 不使用 -k")

    last_exc: RuntimeError | None = None
    for attempt in range(3):
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=build_cline_env(),
                cwd=str(run_dir.resolve()),
                **_cline_subprocess_kwargs(),
            )
        except FileNotFoundError as e:
            raise _cline_missing_runtime_error(exe) from e

        out_b, err_b = await asyncio.wait_for(
            _communicate_with_stderr_stream(
                proc,
                stdin_bytes=None,
                use_stdin=False,
                stream_stderr=cl_stream,
                stderr_emit=_stderr_emit if cl_stream else None,
            ),
            timeout=120.0,
        )
        rc = proc.returncode if proc.returncode is not None else -1
        if rc == 0:
            emit_llm_trace(f"[cline·auth] agent_id={pa.agent_id!r} ok")
            return

        err_t = (err_b or b"").decode("utf-8", errors="replace")
        out_t = (out_b or b"").decode("utf-8", errors="replace")
        last_exc = RuntimeError(
            f"cline auth 失败（exit {rc}）。stderr: {err_t[:2000]}\nstdout: {out_t[:800]}"
        )
        if attempt < 2 and _is_flaky_windows_cline_subprocess(rc, err_b):
            delay_s = 0.12 * (2**attempt)
            _ph(
                f"[Cline] auth 子进程异常（疑似 Windows Node/libuv 管道竞态，exit 0x{_win_exit_code_unsigned(rc):08X}），"
                f"{delay_s:.2f}s 后重试 ({attempt + 2}/3)…"
            )
            await asyncio.sleep(delay_s)
            continue
        raise last_exc

    if last_exc is not None:
        raise last_exc


def _build_argv(
    exe: str,
    config_dir: Path,
    temp_ws: Path,
    *,
    model: str,
    timeout_sec: int,
    spec: AgentSpec,
    user_text: str,
    cline_verbose: bool = False,
) -> tuple[list[str], bool]:
    """返回 (argv, use_stdin)。短提示走 argv 末段；超过阈值则末段为 ``INPUT_MD_TASK_PROMPT``，全文在同 cwd 的 ``input.md``。"""
    args: list[str] = [exe]
    if cline_verbose:
        args.append("--verbose")
    # 必须用 `task` 子命令走 headless，裸 `cline` 在当前版本会进入 Kanban / 交互模式
    # （参考 docs.cline.bot：CLI Reference `cline task` 与 Kanban Getting Started）。
    args.append("task")
    args.extend(
        [
            "-y",
            "-a",
            "--config",
            str(config_dir),
            "-c",
            str(temp_ws),
            "--timeout",
            str(timeout_sec),
        ]
    )
    if model:
        args.extend(["-m", model])
    if spec.thinking:
        args.extend(["--thinking", THINKING_TOKEN_DEFAULT])
    if spec.output_mode == "jsonl":
        args.append("--json")

    # 一律通过 argv 传「prompt」以满足 Cline 校验；长文见 cwd 下已写入的 input.md。
    use_stdin = False
    if len(user_text) > ARGV_STDIN_THRESHOLD:
        args.append(INPUT_MD_TASK_PROMPT)
    else:
        args.append(user_text)
    return args, use_stdin


_TOOL_NAME_KEYS = ("tool_name", "name", "tool")
_TOOL_ARGS_KEYS = ("args", "input", "arguments", "params")
_READ_FILE_MARK = "read_file"


def _extract_tool_record(obj: Any) -> dict[str, Any] | None:
    """从 Cline --json 一行 JSON 中尽力抽出 `{tool_name, args:{path?}, content?}`。"""
    if not isinstance(obj, dict):
        return None
    name = ""
    for k in _TOOL_NAME_KEYS:
        v = obj.get(k)
        if isinstance(v, str) and v:
            name = v
            break
    if not name:
        say = obj.get("say")
        text = obj.get("text") or ""
        if isinstance(say, str) and say.lower() == "tool" and isinstance(text, str):
            m = re.search(r"([a-zA-Z_][a-zA-Z0-9_]*_?file|grep_search|list_dir|glob_search)", text)
            if m:
                name = m.group(1)
    if not name:
        return None

    args_obj: dict[str, Any] = {}
    for k in _TOOL_ARGS_KEYS:
        v = obj.get(k)
        if isinstance(v, dict):
            args_obj = v
            break
    content_raw = obj.get("content") or obj.get("output") or obj.get("result") or ""
    if not isinstance(content_raw, str):
        try:
            content_raw = json.dumps(content_raw, ensure_ascii=False)
        except (TypeError, ValueError):
            content_raw = str(content_raw)

    return {
        "tool_name": name,
        "args": {k: v for k, v in args_obj.items() if isinstance(k, str)},
        "content": content_raw,
    }


def _parse_jsonl_output(raw: str) -> tuple[str, list[dict[str, Any]]]:
    """解析 Cline --json 逐行：拼接 say/text 为最终文本，抽取 tool_log。"""
    say_parts: list[str] = []
    tool_log: list[dict[str, Any]] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict):
            continue

        t = obj.get("type")
        say = obj.get("say")
        text = obj.get("text") if isinstance(obj.get("text"), str) else ""
        if t == "say" and isinstance(say, str) and say.lower() == "text" and text:
            say_parts.append(text)

        rec = _extract_tool_record(obj)
        if rec is not None:
            tool_log.append(rec)

    final_text = "\n\n".join(say_parts).strip() if say_parts else raw.strip()
    return final_text, tool_log


async def run_agent_cline(
    pa: AgentLLMResources,
    run_dir: Path,
    spec: AgentSpec,
    *,
    user_text: str,
    system_ctx: dict[str, str] | None = None,
    phase_log: Any = None,
    keep_temp_ws: bool = False,
) -> RunnerResult:
    """统一 agent 运行入口。stub 短路；否则物化临时 cwd → auth → cline → 解析 → 审计 → 清理。

    `keep_temp_ws=True` 时保留 cwd 并通过 `RunnerResult.temp_ws_path` 返回，
    调用方（探针校验）用完后**必须**自己调 `cleanup_temp_ws`。
    """
    if _is_stub(pa):
        # stub 不走 Cline：直接合成占位文本，system 仍按 TOML 渲染以便确定性
        system_text = render_system(spec, system_ctx or {})
        fake = f"{system_text}\n\n---\n\n{user_text}"
        return RunnerResult(text=stub_response_text(fake), tool_log=[], exit_code=0)

    cfg = load_llm_config(run_dir)
    config_dir = cline_config_path(run_dir)
    exe = _cline_exe(cfg)
    timeout_sec = _cline_timeout_sec(cfg, default=7200 if spec.output_mode == "jsonl" else DEFAULT_TIMEOUT_SEC)

    profile = pa.profile
    model = profile.model if isinstance(profile, ProviderProfile) else ""

    def _ph(msg: str) -> None:
        if phase_log:
            phase_log(msg)

    def _stderr_emit(msg: str) -> None:
        if phase_log:
            phase_log(msg)
        else:
            emit_llm_trace(msg)

    cl_verbose, cl_stream = _cline_log_flags(cfg)

    temp_ws = materialize_temp_ws(run_dir, spec, system_ctx=system_ctx or {})
    # 与 argv 用户提示同文的 `input.md`（长提示时 CLI 只认 argv 短句，正文须读此文件）。
    if (user_text or "").strip():
        (temp_ws / "input.md").write_text(user_text, encoding="utf-8")
    argv: list[str] = []
    use_stdin = False
    t_start = monotonic()
    t_auth = 0
    t_exec = 0
    keep_on_return = False

    try:
        argv, use_stdin = _build_argv(
            exe,
            config_dir,
            temp_ws,
            model=model,
            timeout_sec=timeout_sec,
            spec=spec,
            user_text=user_text,
            cline_verbose=cl_verbose,
        )

        _ph(
            f"[Cline] agent={spec.agent_id} cwd={temp_ws.name} "
            f"model={model!r} timeout={timeout_sec}s stdin={'yes' if use_stdin else 'no'} "
            f"verbose={'yes' if cl_verbose else 'no'} stream_stderr={'yes' if cl_stream else 'no'}"
        )

        async with get_llm_gate():
            auth_start = monotonic()
            await refresh_cline_auth_for_profile(
                pa, run_dir, llm_config=cfg, phase_log=phase_log
            )
            t_auth = int((monotonic() - auth_start) * 1000)

            emit_llm_trace(
                f"[cline·in] agent_id={pa.agent_id!r} argv_head={argv[:8]!r} "
                f"stdin={'yes' if use_stdin else 'no'} user_len={len(user_text)}"
            )

            exec_start = monotonic()
            try:
                proc = await asyncio.create_subprocess_exec(
                    *argv,
                    stdin=asyncio.subprocess.PIPE if use_stdin else asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=build_cline_env(),
                    cwd=str(temp_ws),
                    **_cline_subprocess_kwargs(),
                )
            except FileNotFoundError as e:
                raise _cline_missing_runtime_error(exe) from e

            stdin_bytes = user_text.encode("utf-8") if use_stdin else None
            try:
                out_b, err_b = await asyncio.wait_for(
                    _communicate_with_stderr_stream(
                        proc,
                        stdin_bytes=stdin_bytes,
                        use_stdin=use_stdin,
                        stream_stderr=cl_stream,
                        stderr_emit=_stderr_emit if cl_stream else None,
                    ),
                    timeout=float(timeout_sec),
                )
            except asyncio.TimeoutError as e:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                raise RuntimeError(
                    f"Cline 进程超时（>{timeout_sec}s，与 llm_config.cline_timeout_sec 一致）。"
                ) from e
            rc = proc.returncode if proc.returncode is not None else -1
            t_exec = int((monotonic() - exec_start) * 1000)

        text_out = (out_b or b"").decode("utf-8", errors="replace")
        text_err = (err_b or b"").decode("utf-8", errors="replace")

        if spec.output_mode == "jsonl":
            final_text, tool_log = _parse_jsonl_output(text_out)
        else:
            final_text, tool_log = text_out.strip(), []

        if spec.output_mode == "text":
            merged, took_file, used_name = _merge_act_json_file_from_workspace(
                temp_ws, final_text, spec.agent_id
            )
            if took_file and used_name:
                _ph(
                    f"[Cline] {spec.agent_id}：已采用工作区 {used_name} "
                    "（ACT 模式下 stdout 常为 attempt_completion 摘要，非完整 JSON）"
                )
                final_text = merged

        emit_llm_trace(
            f"[cline·out] agent_id={pa.agent_id!r} rc={rc} "
            f"stdout_len={len(text_out)} stderr_len={len(text_err)} tools={len(tool_log)}"
        )

        if rc != 0:
            es = text_err.strip()
            os_ = text_out.strip()
            _ph(
                f"[Cline] 退出码 {rc}，stderr(len={len(text_err)}): {text_err[:2000]!r} "
                f"stdout(len={len(text_out)}): {text_out[:2000]!r}"
            )
            # Cline 常把鉴权/配置错误打在 stdout，stderr 为空
            parts: list[str] = []
            if es:
                parts.append(f"stderr: {es[:1200]}")
            if os_:
                parts.append(f"stdout: {os_[:2000]}")
            detail = " | ".join(parts) if parts else "(stderr 与 stdout 皆空)"
            raise RuntimeError(f"Cline 退出码 {rc}: {detail}")

        timings = {
            "total_ms": int((monotonic() - t_start) * 1000),
            "auth_ms": t_auth,
            "exec_ms": t_exec,
        }

        if isinstance(profile, ProviderProfile):
            write_llm_effective_snapshot(
                run_dir,
                agent_id=pa.agent_id,
                profile=profile,
                argv=argv,
                timings_ms=timings,
                extra={
                    "output_mode": spec.output_mode,
                    "mcp": spec.mcp,
                    "thinking": spec.thinking,
                    "copy_chronicle_to_cwd": spec.copy_chronicle_to_cwd,
                    "temp_ws_name": temp_ws.name,
                    "user_len": len(user_text),
                    "stdout_len": len(text_out),
                    "tool_log_n": len(tool_log),
                },
            )

        if audit_enabled_from_config(cfg) and pa.audit_run_dir:
            append_llm_audit(
                pa.audit_run_dir,
                pa.agent_id,
                messages=[
                    {"role": "system", "content": f"(.clinerules/01_role.md, {len(spec.system)} chars)"},
                    {"role": "user", "content": user_text},
                ],
                response_text=final_text,
                extra={
                    "argv_head": argv[:8],
                    "temp_ws_name": temp_ws.name,
                    "tool_log_n": len(tool_log),
                },
            )

        kept_ws = temp_ws if keep_temp_ws else None
        keep_on_return = keep_temp_ws
        return RunnerResult(
            text=final_text, tool_log=tool_log, exit_code=rc, temp_ws_path=kept_ws
        )
    finally:
        if not keep_on_return:
            cleanup_temp_ws(temp_ws)
