# -*- coding: utf-8 -*-
"""工作台 RHI 接入层 · 测试侧：在真 Chrome（真 GPU 的 WebGPU）里跑工作台页面（冒烟 / 页内自检）。

  from tools.workbench_rhi import browser
  with browser.serving([sys.executable, "-m", "tools.xxx_workbench", "--serve", "--port", "{port}"]) as base:
      r = browser.run_page(base + "/", selftest=path, no_skip=True)

* 浏览器由 ``chrome_page.mjs``（playwright-core）起：channel chrome、缺省无头；``PLAYWRIGHT_CORE`` 指到 playwright-core 的包目录
  （仓库不装它）。没有 node / playwright-core / Chrome ⇒ ``unavailable()`` 给出原因，测试据此 skip，不算失败。
* 平台无关：只起子进程与本机回环端口。
"""
from __future__ import annotations

import os
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from tools.workbench_rhi.build import ROOT, node_exe

RUNNER = Path(__file__).resolve().parent / "chrome_page.mjs"
EXIT_NO_BROWSER = 3


def playwright_core() -> str | None:
    """playwright-core 的包目录（``PLAYWRIGHT_CORE``，或仓库根 node_modules 里恰好有）；没有 = None。"""
    env = os.environ.get("PLAYWRIGHT_CORE", "").strip()
    if env and (Path(env) / "package.json").is_file():
        return env
    local = ROOT / "node_modules" / "playwright-core"
    return str(local) if (local / "package.json").is_file() else None


def unavailable() -> str:
    """跑不了真浏览器的原因；能跑返回 ''。"""
    if not node_exe():
        return "没有 node"
    if not playwright_core():
        return "没有 playwright-core（设 PLAYWRIGHT_CORE 指到它的包目录）"
    return ""


def qt_host_unavailable() -> str:
    """工作台的 Qt 宿主（``desktop_shell.run_desktop(webgpu=True)`` → ``tools.qt_webgpu.WebGpuView``：Windows 上 WebView2、
    macOS 上 WKWebView）在这台机器上起不来的原因；起得来返回 ''。QtWebEngine 没编 Dawn，不算。"""
    try:
        import PySide6.QtWebView  # noqa: F401
        import PySide6.QtWidgets  # noqa: F401
    except Exception as e:  # noqa: BLE001
        return f"没有 PySide6 QtWebView（WebGPU 宿主）：{e}"
    return ""


def skip_lines(report: str) -> list[str]:
    """自检报告里的 SKIP 行（WebGPU 宿主里一条都不许有）。"""
    return [ln for ln in report.splitlines() if ln.startswith("SKIP")]


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_port(port: int, proc: subprocess.Popen, timeout: float) -> None:
    t0 = time.time()
    while time.time() - t0 < timeout:
        if proc.poll() is not None:
            raise RuntimeError(f"服务进程提前退出（{proc.returncode}）")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.2)
    raise TimeoutError(f"端口 {port} {timeout:.0f} 秒内没起来")


@contextmanager
def serving(argv: list[str], port: int | None = None, ready_timeout: float = 60.0) -> Iterator[str]:
    """起一个工作台服务子进程（argv 里的 ``{port}`` 换成端口），等端口能连上，给出 ``http://127.0.0.1:<port>``；退出时结束它。"""
    port = port or free_port()
    cmd = [a.replace("{port}", str(port)) for a in argv]
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1", PYTHONUNBUFFERED="1")
    proc = subprocess.Popen(cmd, cwd=str(ROOT), env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        _wait_port(port, proc, ready_timeout)
        yield f"http://127.0.0.1:{port}"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=10)
        if proc.stdout:
            proc.stdout.close()


def run_page(url: str, *, selftest: str | Path | None = None, smoke: bool = False, no_skip: bool = False,
             shot: str | Path | None = None, extra: list[str] | None = None, timeout: float = 900.0) -> subprocess.CompletedProcess:
    """``chrome_page.mjs`` 跑一次；返回完成的进程（stdout 里是原样报告）。退出码 3 = 起不来浏览器 / 没有 playwright-core。"""
    args = [node_exe() or "node", str(RUNNER), "--url", url]
    if selftest:
        args += ["--selftest", str(selftest)]
    if smoke:
        args += ["--smoke"]
    if no_skip:
        args += ["--no-skip"]
    if shot:
        args += ["--shot", str(shot)]
    args += list(extra or [])
    env = dict(os.environ)
    pw = playwright_core()
    if pw:
        env["PLAYWRIGHT_CORE"] = pw
    return subprocess.run(args, cwd=str(ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=timeout, env=env)


if __name__ == "__main__":  # 手动：python -m tools.workbench_rhi.browser <url> [--smoke | --selftest js]
    a = sys.argv[1:]
    if not a:
        print(__doc__)
        sys.exit(2)
    r = run_page(a[0], smoke="--smoke" in a, selftest=a[a.index("--selftest") + 1] if "--selftest" in a else None,
                 no_skip="--no-skip" in a)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr)
    sys.exit(r.returncode)
