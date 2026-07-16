"""Parallax 场景编辑器启动器：起独立 Vite dev（复用游戏 Pixi 渲染 + 读 public/ 资源，
带图片扫描 / 场景读写后端插件）+ 开浏览器。与 anim_preview / 叙事编辑器同款独立 Web 工具。

  ./dev.sh parallax-editor                       # 起服 + 开浏览器
  python -m tools.parallax_editor --scene shenxianding_02_demo
  python -m tools.parallax_editor --no-open --port 5205

已在 <port>（默认 5205）跑着同一个 parallax 编辑器时，不再重复起服，直接开浏览器复用。
主编辑器 Tools → External tools 与 present:parallaxScene 步的「在 Parallax 编辑器里配置轨迹…」
按钮都走本模块，所以反复点不会堆出一串 dev server。
"""
from __future__ import annotations

import argparse
import json
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
    raise RuntimeError("No free port for Parallax Editor.")


def _wait_ready(url: str, timeout: float = 40.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.5):
                return True
        except Exception:
            time.sleep(0.4)
    return False


def _already_serving(port: int) -> bool:
    """端口上是否已经跑着*本工具*：命中 /api/parallax/scenes 且返回 {scenes:[...]}。

    只认自家后端，避免把别的占用了 5205 的服务误当成 parallax 编辑器去复用。
    """
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/parallax/scenes", timeout=1.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        return isinstance(data, dict) and isinstance(data.get("scenes"), list)
    except Exception:
        return False


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        prog="parallax-editor",
        description="Parallax 视差场景可视化编辑器（Web）：拖拽打关键帧、配轨迹、存 parallax_scenes.json",
    )
    ap.add_argument("--port", type=int, default=5205)
    ap.add_argument("--scene", default="", help="启动即选中的 parallax 场景 id（深链 ?scene=…）")
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args(argv)

    query = {"scene": args.scene} if args.scene else {}
    suffix = ("?" + urlencode(query)) if query else ""

    # 已经在跑同一个编辑器 → 直接复用，不再起第二个 dev server。
    if _already_serving(args.port):
        url = f"http://127.0.0.1:{args.port}/{suffix}"
        if not args.no_open:
            webbrowser.open(url)
        print(f"Parallax Editor 已在运行，复用：{url}", flush=True)
        return 0

    port = _free_port(args.port)
    cmd = [
        npm_command(), "run", "dev:parallax-editor", "--",
        "--port", str(port), "--strictPort",
    ]
    env = env_with_node_path()
    print(f"$ {' '.join(cmd)}", flush=True)
    proc = subprocess.Popen(cmd, cwd=str(ROOT), env=env)

    base = f"http://127.0.0.1:{port}/"
    url = base + suffix

    if not args.no_open:
        def opener() -> None:
            if _wait_ready(base):
                webbrowser.open(url)
            else:
                print("Parallax Editor: dev server 未就绪，手动打开 " + url, flush=True)
        threading.Thread(target=opener, daemon=True).start()

    print(f"Parallax Editor: {url}", flush=True)
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
