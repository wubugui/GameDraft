"""LightVolume Lab 启动器:在仓库根起静态服 + 打开浏览器到工具页。

  ./dev.sh lightvol                                  # 起服 + 开浏览器
  ./dev.sh lightvol -- --scene mountain_pass         # 顺带按 scene id 自动载入
  ./dev.sh lightvol -- --no-open --port 8099         # 不开浏览器 / 指定端口

工具页用 base=/public 抓取游戏资源(静态服根=仓库根,资源在 public/ 下)。
也可直接双击 index.html 用文件选择器载入(file://,无需此启动器)。
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
REL = "tools/lightvolume_lab/index.html"


class _QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args) -> None:  # 静默每请求日志
        return


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
