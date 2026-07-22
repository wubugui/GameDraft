"""角色照明实验室启动器(伪世界 RT / irradiance cache)。

  ./dev.sh char-lighting                       # 起服 + 开浏览器
  ./dev.sh char-lighting -- --port 5311        # 指定端口
  ./dev.sh char-lighting -- --no-open          # 不自动开浏览器
  ./dev.sh char-lighting -- --build <图.png> --name 场景名 [--pitch_deg 45 ...]
                                               # 只跑离线管线,不起服

新场景入库也可直接:
  .tools/venv/bin/python tools/character_lighting_lab/pipeline.py <背景图> --name 名字
"""
from __future__ import annotations

import argparse
import sys
import threading
import webbrowser

from http.server import ThreadingHTTPServer

from tools.character_lighting_lab.serve import H, PORT


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=PORT)
    ap.add_argument('--no-open', action='store_true')
    ap.add_argument('--build', type=str, default=None,
                    help='背景图路径:只跑离线管线后退出(其余参数透传 pipeline)')
    args, extra = ap.parse_known_args()

    if args.build:
        from tools.character_lighting_lab import pipeline
        sys.argv = ['pipeline', args.build, *extra]
        pipeline.main()
        return

    url = f'http://localhost:{args.port}/'
    try:
        srv = ThreadingHTTPServer(('127.0.0.1', args.port), H)
    except OSError:
        # already running (e.g. launched twice from the dev console): just focus it
        print(f'character lighting lab already running: {url}')
        if not args.no_open:
            webbrowser.open(url)
        return
    print(f'character lighting lab: {url}')
    if not args.no_open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
