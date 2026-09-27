"""LightVolume Lab 启动器:在仓库根起静态服 + 打开浏览器到工具页。

  ./dev.sh lightvol                                  # 起服 + 开浏览器
  ./dev.sh lightvol -- --scene mountain_pass         # 顺带按 scene id 自动载入
  ./dev.sh lightvol -- --no-open --port 8099         # 不开浏览器 / 指定端口

工具页用 base=/public 抓取游戏资源(静态服根=仓库根,资源在 public/ 下)。

画面(预览 quad / 环境 FX)走引擎 RHI(只有 WebGPU,2026-09-28 迁移):页面经 ``/gen/lightvol.bundle.js`` 拿
``bundle.py`` 按需现打的包;``/api/boot`` 报打包状态。所以要经这个启动器打开(file:// 直开拿不到包,只剩载入 / 烘焙 / 切片)。
"""

from __future__ import annotations

import argparse
import json
import socket
import sys
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlparse

ROOT = Path(__file__).resolve().parents[2]
REL = "tools/lightvolume_lab/index.html"


_JS_MIME = "text/javascript; charset=utf-8"


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args) -> None:  # 静默每请求日志
        return

    def guess_type(self, path):  # Windows 注册表常把 .js 映射成 text/plain(模块脚本会被拒)
        if str(path).endswith(".js"):
            return _JS_MIME
        return super().guess_type(path)

    def handle(self) -> None:
        try:
            super().handle()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/gen/lightvol.bundle.js":
            from tools.lightvolume_lab import bundle
            p, err = bundle.ensure_bundle()
            if not p or not p.exists():
                return self._send(404, json.dumps({"ok": False, "err": err or "没有打包产物"}, ensure_ascii=False).encode("utf-8"),
                                  "application/json; charset=utf-8")
            return self._send(200, p.read_bytes(), _JS_MIME)
        if path == "/api/boot":
            try:
                from tools.lightvolume_lab import bundle
                p, err = bundle.ensure_bundle()
            except Exception as e:  # noqa: BLE001 — 打包失败不许拖垮页面
                p, err = None, f"{type(e).__name__}: {e}"
            body = {"ok": True, "bundle": {"ok": bool(p and not err), "err": err}}
            return self._send(200, json.dumps(body, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")
        return super().do_GET()


def _free_port(start: int) -> int:
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("No free port for LightVolume Lab.")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="lightvol", description="LightVolume Lab 离线辐照度体积烘焙/预览")
    ap.add_argument("--port", type=int, default=8099)
    ap.add_argument("--scene", default="", help="按 scene id 自动载入(从 public/ 抓背景+深度+config)")
    ap.add_argument("--autobake", action="store_true", help="载入后自动烘焙")
    ap.add_argument("--no-open", action="store_true")
    args = ap.parse_args(argv)

    port = _free_port(args.port)
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(_QuietHandler, directory=str(ROOT)))

    query = ["base=/public"]
    if args.scene:
        query.append("scene=" + quote(args.scene))
        if args.autobake:
            query.append("autobake=1")
    url = f"http://127.0.0.1:{port}/{REL}?" + "&".join(query)

    print(f"LightVolume Lab: {url}", flush=True)
    print("Ctrl-C 结束。", flush=True)
    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
