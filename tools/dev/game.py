"""Vite dev server start/stop (ports 5173-5176)."""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import time

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


def stop_dev_ports(ports: tuple[int, ...] = DEV_SERVER_PORTS, grace: float = 1.5) -> int:
    """Kill processes listening on the dev server ports. Returns kill count."""
    killed = 0
    pending: dict[int, int] = {}
    for port in ports:
        for pid in _listening_pids_unix(port):
            try:
                os.kill(pid, signal.SIGTERM)
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
                os.kill(pid, signal.SIGKILL)
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
