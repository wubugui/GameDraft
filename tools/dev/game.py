"""Vite dev server start/stop (ports 5173-5176)."""

from __future__ import annotations

import os
import platform
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass, field

from tools.dev import proxyenv
from tools.dev.paths import env_with_node_path, npm_command, repo_root

DEV_SERVER_PORTS = (5173, 5174, 5175, 5176)


def start(proxy: str | None = None, check: bool = False) -> int:
    """Run ``npm run dev`` with node on PATH; optional temporary proxy."""
    env = env_with_node_path()
    if proxy is not None:
        env.update(proxyenv.loopback_safe_proxy_env(proxy))
        print(f"临时代理: {env['HTTP_PROXY']}")

    npm = npm_command()
    if check:
        print(f"[check] cwd={repo_root()} cmd={npm} run dev (proxy={proxy or 'no'})")
        return 0

    root = repo_root()
    if proxy is not None and not (root / "node_modules").is_dir():
        print("未检测到 node_modules，正在通过代理安装依赖...")
        rc = subprocess.call([npm, "install"], cwd=str(root), env=env)
        if rc != 0:
            print("npm install 失败，请确认代理已开启且为 HTTP 代理端口。")
            return rc

    print("Starting GameDraft Vite dev server at http://localhost:5173 ...")
    print("Press Ctrl+C to stop.")
    return subprocess.call([npm, "run", "dev"], cwd=str(root), env=env)


def _listening_pids_unix(port: int) -> set[int]:
    if shutil.which("lsof"):
        result = subprocess.run(
            ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
            capture_output=True,
            text=True,
            check=False,
        )
        return {int(p) for p in result.stdout.split() if p.isdigit()}
    if shutil.which("fuser"):
        result = subprocess.run(
            ["fuser", f"{port}/tcp"], capture_output=True, text=True, check=False
        )
        return {int(p) for p in result.stdout.split() if p.isdigit()}
    return set()


def _listening_pids_windows(port: int) -> set[int]:
    result = subprocess.run(
        ["netstat", "-ano", "-p", "tcp"],
        capture_output=True,
        text=True,
        check=False,
    )
    pids: set[int] = set()
    suffix = f":{port}"
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        local_address, state, pid = parts[1], parts[-2], parts[-1]
        if state.upper() != "LISTENING":
            continue
        if not local_address.endswith(suffix) or not pid.isdigit():
            continue
        pids.add(int(pid))
    return pids


def _listening_pids_psutil(port: int) -> set[int]:
    """psutil 全局连接表取监听 PID；覆盖 IPv4/IPv6 双栈(netstat -p tcp 只见 IPv4)。

    psutil 不可用或无权限(macOS 的系统级 net_connections 需要 root)时抛异常，
    由调用方回落到 netstat/lsof 路径。
    """
    import psutil

    pids: set[int] = set()
    for conn in psutil.net_connections(kind="tcp"):
        if (
            conn.status == psutil.CONN_LISTEN
            and conn.laddr
            and conn.laddr.port == port
            and conn.pid
        ):
            pids.add(conn.pid)
    return pids


def _listening_pids(port: int) -> set[int]:
    try:
        return _listening_pids_psutil(port)
    except Exception:
        pass
    if platform.system() == "Windows":
        return _listening_pids_windows(port)
    return _listening_pids_unix(port)


@dataclass
class PortOccupant:
    """占着某端口 LISTEN 的进程的可展示描述(编辑器端口冲突弹窗用)。

    详细字段(命令行/用户/父链)取不到时留空并把原因放进 detail_error——
    展示层如实标注"取不到"，不猜。
    """

    port: int
    pid: int
    name: str = ""
    cmdline: str = ""
    username: str = ""
    started_at: str = ""
    parent_chain: list[str] = field(default_factory=list)
    detail_error: str = ""


def _fallback_process_name(pid: int) -> str:
    """无 psutil 时的进程名兜底(tasklist / ps)。取不到返回空串。"""
    try:
        if platform.system() == "Windows":
            result = subprocess.run(
                ["tasklist", "/FO", "CSV", "/NH", "/FI", f"PID eq {pid}"],
                capture_output=True, text=True, check=False,
            )
            line = result.stdout.strip().splitlines()[0] if result.stdout.strip() else ""
            if line.startswith('"'):
                return line.split('","')[0].strip('"')
            return ""
        result = subprocess.run(
            ["ps", "-p", str(pid), "-o", "comm="],
            capture_output=True, text=True, check=False,
        )
        return result.stdout.strip()
    except Exception:
        return ""


def _describe_pid(port: int, pid: int) -> PortOccupant:
    occ = PortOccupant(port=port, pid=pid)
    try:
        import psutil
    except Exception as exc:  # 环境缺 psutil：仍给出 PID + 进程名，可杀可取消
        occ.name = _fallback_process_name(pid)
        occ.detail_error = f"psutil 不可用({exc})，仅能显示 PID/进程名"
        return occ

    try:
        proc = psutil.Process(pid)
    except Exception as exc:  # 进程在探测与描述之间退出等
        occ.name = _fallback_process_name(pid)
        occ.detail_error = f"进程信息读取失败({exc})"
        return occ

    # 逐字段容错：AccessDenied 常只挡住其中几项(如他人会话的 cmdline)
    errors: list[str] = []
    try:
        occ.name = proc.name()
    except Exception:
        occ.name = _fallback_process_name(pid)
    try:
        occ.cmdline = subprocess.list2cmdline(proc.cmdline())
    except Exception as exc:
        errors.append(f"命令行:{type(exc).__name__}")
    try:
        occ.username = proc.username()
    except Exception as exc:
        errors.append(f"用户:{type(exc).__name__}")
    try:
        occ.started_at = time.strftime(
            "%Y-%m-%d %H:%M:%S", time.localtime(proc.create_time())
        )
    except Exception as exc:
        errors.append(f"启动时间:{type(exc).__name__}")
    try:
        chain = [f"{occ.name or '?'}(PID {pid})"]
        for parent in proc.parents()[:6]:
            try:
                chain.append(f"{parent.name()}(PID {parent.pid})")
            except Exception:
                chain.append(f"?(PID {parent.pid})")
        occ.parent_chain = chain
    except Exception as exc:
        errors.append(f"父进程链:{type(exc).__name__}")
    if errors:
        occ.detail_error = "部分信息取不到 — " + "、".join(errors)
    return occ


def describe_port_occupants(port: int) -> list[PortOccupant]:
    """列出监听 ``port`` 的全部进程描述(按 PID 升序)。空列表 = 端口空闲。"""
    return [_describe_pid(port, pid) for pid in sorted(_listening_pids(port))]


def wait_ports_free(ports: tuple[int, ...], timeout: float = 3.0) -> bool:
    """轮询等待端口全部无监听者；超时仍被占返回 False。"""
    deadline = time.monotonic() + timeout
    while True:
        if all(not _listening_pids(p) for p in ports):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(0.15)


def _terminate_pid(pid: int) -> bool:
    if platform.system() == "Windows":
        result = subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            text=True,
            check=False,
        )
        return result.returncode == 0
    os.kill(pid, signal.SIGTERM)
    return True


def _kill_pid(pid: int) -> bool:
    if platform.system() == "Windows":
        return _terminate_pid(pid)
    os.kill(pid, signal.SIGKILL)
    return True


def stop_dev_ports(ports: tuple[int, ...] = DEV_SERVER_PORTS, grace: float = 1.5) -> int:
    """Kill processes listening on the dev server ports. Returns kill count."""
    killed = 0
    pending: dict[int, int] = {}
    is_windows = platform.system() == "Windows"
    for port in ports:
        for pid in _listening_pids(port):
            try:
                if _terminate_pid(pid):
                    if is_windows:
                        print(f"已结束进程 PID {pid} (端口 {port})")
                        killed += 1
                        continue
                    pending[pid] = port
            except ProcessLookupError:
                continue
    if pending:
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline and pending:
            time.sleep(0.1)
            for pid in list(pending):
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    print(f"已结束进程 PID {pid} (端口 {pending.pop(pid)})")
                    killed += 1
        for pid, port in pending.items():
            try:
                _kill_pid(pid)
                print(f"已强制结束进程 PID {pid} (端口 {port})")
                killed += 1
            except ProcessLookupError:
                killed += 1
    return killed


def stop() -> int:
    print("正在结束 GameDraft 开发服务器 (释放 5173-5176 端口)...")
    stop_dev_ports()
    print("完成。")
    return 0
