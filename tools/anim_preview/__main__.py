"""动画预览工具启动器:起独立 Vite dev(复用游戏 src/rendering,读 public/ 资源,
带实时扫描+监听插件)+ 开浏览器。与 lightvol / 叙事编辑器同款独立 Web 工具。

  ./dev.sh anim-preview                       # 起服 + 开浏览器
  python -m tools.anim_preview --char 官差枪_anim --state run
  python -m tools.anim_preview --no-open --port 5199
"""
from __future__ import annotations

import argparse
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from urllib.parse import urlencode

from tools.dev.paths import env_with_node_path, npm_command, repo_root

ROOT = repo_root()


def _free_port(start: int) -> int:
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("No free port for Anim Preview.")


def _wait_ready(url: str, timeout: float = 40.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.5):
                return True
        except Exception:
            time.sleep(0.4)
    return False


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="anim-preview", description="游戏一致的精灵动画预览(Web)")
    ap.add_argument("--port", type=int, default=5199)
    ap.add_argument("--char", default="", help="启动即选中的角色 id")
    ap.add_argument("--state", default="", help="启动即播放的状态名")
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args(argv)

    port = _free_port(args.port)
    cmd = [
        npm_command(), "run", "dev:anim-preview", "--",
        "--port", str(port), "--strictPort",
    ]
    env = env_with_node_path()
    print(f"$ {' '.join(cmd)}", flush=True)
    proc = subprocess.Popen(cmd, cwd=str(ROOT), env=env)

    base = f"http://127.0.0.1:{port}/"
    query = {k: v for k, v in (("char", args.char), ("state", args.state)) if v}
    url = base + ("?" + urlencode(query) if query else "")

    if not args.no_open:
        def opener() -> None:
            if _wait_ready(base):
                webbrowser.open(url)
            else:
                print("Anim Preview: dev server 未就绪,手动打开 " + url, flush=True)
        threading.Thread(target=opener, daemon=True).start()

    print(f"Anim Preview: {url}", flush=True)
    print("Ctrl-C 结束。", flush=True)
    try:
        return proc.wait()
    except KeyboardInterrupt:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        return 0


if __name__ == "__main__":
    sys.exit(main())
