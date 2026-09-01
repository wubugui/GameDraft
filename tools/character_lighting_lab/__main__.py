"""角色照明实验室启动器(伪世界 RT / irradiance cache)。

缺省是**本地窗口程序**(2026-08-31):双击即开、关窗即退、端口由系统分配、禁止双开。

  ./dev.sh char-lighting                       # 开窗口(缺省)
  ./dev.sh char-lighting -- --serve            # 只起 HTTP 服务,不开窗口(调页面/开 devtools 用)
  ./dev.sh char-lighting -- --serve --port 5311 --no-open
  ./dev.sh char-lighting -- --smoke            # 无头自检:窗口 load 完即退
  ./dev.sh char-lighting -- --build <图.png> --name 场景名 [--pitch_deg 45 ...]
                                               # 只跑离线管线,不起服
  ./dev.sh char-lighting -- --fields <场景id>  # 只烘几何场(法线/天穹可见性/3D网格/GI命中图)
  ./dev.sh char-lighting -- --fields all       # 全部已导出深度的场景

本工具是**光照烘焙的唯一入口**(2026-08-31 收束):深度、标定、probe、体素、
行走面、以及几何场,全部由这里产出,统一落 `runtime/scenes/<id>/lighting/<背景基名>/`。

⚠ 窗口模式下 `--port` 无意义(端口由系统分配,这正是"不用关心端口"的做法);
它只在 `--serve` 下生效。
"""
from __future__ import annotations

import argparse
import sys
import threading
import webbrowser

from http.server import ThreadingHTTPServer

from tools.character_lighting_lab.serve import H, PORT


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--serve', action='store_true',
                    help='只起 HTTP 服务不开窗口(在真浏览器里调页面时用)')
    ap.add_argument('--smoke', action='store_true', help='无头自检:窗口 load 完即退')
    ap.add_argument('--port', type=int, default=PORT, help='仅 --serve 模式下生效')
    ap.add_argument('--no-open', action='store_true', help='仅 --serve 模式下生效')
    ap.add_argument('--build', type=str, default=None,
                    help='背景图路径:只跑离线管线后退出(其余参数透传 pipeline)')
    ap.add_argument('--fields', type=str, default=None,
                    help='只烘该场景的几何场(法线/天穹可见性/3D 网格/GI 命中图)后退出;'
                         '传 all 烘全部已导出深度的场景')
    args, extra = ap.parse_known_args()

    if args.build:
        from tools.character_lighting_lab import pipeline
        sys.argv = ['pipeline', args.build, *extra]
        pipeline.main()
        return 0

    if args.fields:
        # 几何场烘焙(2026-08-31 从 tools/scene_relight 收束过来)。
        # 它读的是**本实验室导出的** raw_depth_rg.png + depthConfig,所以必须先导过深度。
        from tools.character_lighting_lab import scene_fields
        sys.argv = ['scene_fields'] + (['--all'] if args.fields == 'all'
                                       else ['--scene', args.fields]) + extra
        scene_fields.main()
        return 0

    if args.serve:
        # 浏览器模式:固定端口(要在地址栏敲),沿用旧行为。
        # ⚠ 这一支才需要"端口被占 = 已经有一个在跑"的判断;窗口模式不需要,
        #   它的端口是系统分配的,单实例由命名管道保证(见 tools/desktop_shell.py)。
        url = f'http://localhost:{args.port}/'
        try:
            srv = ThreadingHTTPServer(('127.0.0.1', args.port), H)
        except OSError:
            print(f'character lighting lab already serving: {url}')
            if not args.no_open:
                webbrowser.open(url)
            return 0
        print(f'character lighting lab: {url}')
        if not args.no_open:
            threading.Timer(0.4, lambda: webbrowser.open(url)).start()
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            pass
        return 0

    from tools.character_lighting_lab.app import main as app_main
    return app_main(smoke=args.smoke)


if __name__ == '__main__':
    sys.exit(main())
