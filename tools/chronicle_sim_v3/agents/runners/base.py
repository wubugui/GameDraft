"""AgentRunner Protocol + AgentRunnerContext + SubprocessAgentRunner 基类。

Runner 是无状态对象；每次 run_task 自带 context（凭据 + 服务）。
SubprocessAgentRunner 抽出 cline / external 共有的子进程编排：
- ws 临时目录创建 / 归档
- env 剥代理 / NO_PROXY
- Windows libuv 抖动重试
- stderr 流式回调 observer
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import os
import shutil
import subprocess
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from tools.chronicle_sim_v3.agents.errors import (
    AgentRunnerError,
    AgentTimeoutError,
)
from tools.chronicle_sim_v3.agents.resolver import ResolvedAgent
from tools.chronicle_sim_v3.agents.types import (
    AgentObserver,
    AgentResult,
    AgentTask,
    NullAgentObserver,
)


@dataclass
class AgentRunnerContext:
    """Runner 运行期注入项。"""

    run_dir: Path
    spec_search_root: Path
    provider_service: Any                       # ProviderService（cline / external 必需）
    llm_service: Any | None = None              # LLMService（simple_chat / react 必需）
    chroma: Any = None                          # 给 react tools 用
    observer: AgentObserver = field(default_factory=NullAgentObserver)


class AgentRunner(Protocol):
    """Runner 协议。"""

    runner_kind: str  # cline / simple_chat / react / external

    async def run_task(
        self,
        resolved: ResolvedAgent,
        task: AgentTask,
        ref_output_kind: str,
        ref_artifact_filename: str,
        ctx: AgentRunnerContext,
        timeout_sec: int,
    ) -> AgentResult: ...


# ---------- 子进程基类 ----------

_PROXY_ENV_KEYS = frozenset({
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "FTP_PROXY", "SOCKS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "all_proxy", "ftp_proxy", "socks_proxy", "no_proxy",
})

_CHRONICLE_SIM_DIR = ".chronicle_sim"
_WS_SUBDIR = "ws"
_WS_ARCHIVE_SUBDIR = "ws_archive"


def build_no_proxy_env(no_proxy: bool = True) -> dict[str, str]:
    """构造子进程 env：**强制**剥离所有代理变量并设 NO_PROXY=*。

    用户硬约束："本系统所有的连接都强制禁用所有的系统代理"。
    `no_proxy` 形参保留只为兼容旧签名；任意取值都按 True 处理。
    """
    del no_proxy  # 不再可配置
    env = dict(os.environ)
    for k in list(env.keys()):
        if k in _PROXY_ENV_KEYS:
            env.pop(k, None)
            continue
        lu = k.lower()
        if "proxy" in lu and ("http" in lu or "socks" in lu or lu.endswith("_proxy")):
            env.pop(k, None)
    env["NO_PROXY"] = "*"
    env["no_proxy"] = "*"
    return env


def materialize_temp_ws(run_dir: Path, sub: str = "agent") -> Path:
    base = run_dir / _CHRONICLE_SIM_DIR / _WS_SUBDIR
    base.mkdir(parents=True, exist_ok=True)
    ws = base / f"{sub}_{uuid.uuid4().hex[:12]}"
    ws.mkdir()
    return ws


def archive_workspace(run_dir: Path, ws: Path, role: str) -> Path | None:
    if not ws.is_dir():
        return None
    base = run_dir / _CHRONICLE_SIM_DIR / _WS_ARCHIVE_SUBDIR
    base.mkdir(parents=True, exist_ok=True)
    ts = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    safe_role = "".join(c for c in role if c.isalnum() or c in "_-") or "agent"
    target = base / f"{ts}_{safe_role}_{uuid.uuid4().hex[:8]}"
    try:
        shutil.move(str(ws), str(target))
        return target
    except OSError:
        return None


def _subprocess_kwargs() -> dict[str, Any]:
    if os.name != "nt":
        return {}
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


def _win_exit_unsigned(rc: int) -> int:
    if rc >= 0:
        return rc
    return rc + (1 << 32)


def is_libuv_crash(rc: int, err_b: bytes) -> bool:
    if os.name != "nt":
        return False
    if _win_exit_unsigned(rc) == 0xC0000409:
        return True
    es = (err_b or b"").decode("utf-8", errors="replace")
    if "UV_HANDLE_CLOSING" in es:
        return True
    if "Assertion failed" in es and "async.c" in es:
        return True
    return False


async def _stream_communicate(
    proc: asyncio.subprocess.Process,
    *,
    stream_stderr: bool,
    observer: AgentObserver,
    source: str,
) -> tuple[bytes, bytes]:
    if os.name == "nt" or not stream_stderr or proc.stderr is None:
        out_b, err_b = await proc.communicate(None)
        out_b, err_b = out_b or b"", err_b or b""
        if stream_stderr and err_b:
            for line in err_b.splitlines():
                s = line.decode("utf-8", errors="replace").rstrip()
                if s:
                    observer.on_log_line(source, s)
        return out_b, err_b

    async def _read_stdout() -> bytes:
        if proc.stdout is None:
            return b""
        return await proc.stdout.read()

    async def _drain_stderr() -> bytes:
        buf = bytearray()
        if proc.stderr is None:
            return b""
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            buf.extend(line)
            s = line.decode("utf-8", errors="replace").rstrip()
            if s:
                observer.on_log_line(source, s)
        return bytes(buf)

    out_b, err_b = await asyncio.gather(_read_stdout(), _drain_stderr())
    await proc.wait()
    return out_b or b"", err_b or b""


class SubprocessAgentRunner:
    """共享子进程编排基类（cline / external 都继承）。

    具体 Runner 通过 `runner_kind` / `run_task` 实现自己的工作区准备
    与 argv 构造；本基类提供 `_run_one` 子进程执行原语。
    """

    runner_kind: str = "subprocess"

    async def _run_one(
        self,
        argv: list[str],
        env: dict[str, str],
        cwd: str,
        *,
        timeout: float,
        observer: AgentObserver,
        stream_stderr: bool,
        phase: str,
        source: str = "subprocess",
        return_streams: bool = False,
        retry_libuv: int = 3,
    ):
        observer.on_phase(phase, {"argv_head": argv[:6]})
        last_err: Exception | None = None
        for attempt in range(retry_libuv):
            try:
                proc = await asyncio.create_subprocess_exec(
                    *argv,
                    stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=env,
                    cwd=cwd,
                    **_subprocess_kwargs(),
                )
            except FileNotFoundError as e:
                raise AgentRunnerError(
                    f"未找到可执行 {argv[0]!r}；安装或在 agents.yaml.config "
                    f"指定 executable 绝对路径"
                ) from e
            try:
                out_b, err_b = await asyncio.wait_for(
                    _stream_communicate(
                        proc, stream_stderr=stream_stderr,
                        observer=observer, source=source,
                    ),
                    timeout=timeout,
                )
            except asyncio.TimeoutError as e:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                raise AgentTimeoutError(
                    f"{phase} 子进程超时 {timeout}s"
                ) from e
            rc = proc.returncode if proc.returncode is not None else -1
            if rc == 0:
                if return_streams:
                    return out_b, err_b, rc
                return None
            if attempt < retry_libuv - 1 and is_libuv_crash(rc, err_b):
                observer.on_phase(f"{phase}.libuv_retry", {
                    "attempt": attempt + 1,
                    "rc_unsigned": _win_exit_unsigned(rc),
                })
                await asyncio.sleep(0.12 * (2 ** attempt))
                last_err = AgentRunnerError(f"libuv crash rc={rc}")
                continue
            if return_streams:
                return out_b, err_b, rc
            err_t = (err_b or b"").decode("utf-8", errors="replace")[:500]
            raise AgentRunnerError(
                f"{phase} exit={rc} stderr={err_t!r}"
            )
        if last_err is not None:
            raise last_err
        raise AgentRunnerError(f"{phase} 重试耗尽")
