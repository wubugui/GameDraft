# -*- coding: utf-8 -*-
"""CLI:

  sh scripts/py.sh -m tools.breathing_workbench                          # 桌面应用(默认)
  sh scripts/py.sh -m tools.breathing_workbench --open dream_face_paper  # 开窗并打开那张呼吸图(已开着就切过去)
  sh scripts/py.sh -m tools.breathing_workbench --game-url http://127.0.0.1:5173
  sh scripts/py.sh -m tools.breathing_workbench --smoke                  # 桌面壳无头自检:load 完即退
  sh scripts/py.sh -m tools.breathing_workbench --selftest [js]          # 交互层端到端回归(临时样例工程 + viewer/tests/selftest.js)
  sh scripts/py.sh -m tools.breathing_workbench --serve [--port 5352]    # 只起 HTTP 服务(自动化用)
  sh scripts/py.sh -m tools.breathing_workbench --list                   # 呼吸图清单(尺寸 / 底图 / 几处在用)
  sh scripts/py.sh -m tools.breathing_workbench --check                  # 不写盘:形状 / 分层图与位移场在不在、大小对不对(✗ = 退出码 1)
  sh scripts/py.sh -m tools.breathing_workbench --bundle                 # 只重打运行时模块包

呼吸图资产 ``public/assets/data/breathing/``:**本工具是唯一的写入者**,主编辑器只读显示;工作台只改表演参数与名字,
分层 / 位移场 / 骨架常数由离线拆层工具烘出来。本地预览跑的是打包进来的运行时表演模拟本体(``BreathingPerformance.ts``)
和游戏同一份着色器(``breathingShade.glsl``),不是 JS 里另写的一份。
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def check(out=print) -> int:
    """``--check`` 本体(测试直接调):返回 ✗ 的条数。"""
    from tools.breathing_workbench import store, story
    bad = 0
    for r in store.list_assets():
        bid = r["id"]
        if r.get("error"):
            out(f"{bid}\t✗ {r['error']}")
            bad += 1
            continue
        errs, warns = store.check_asset(bid)
        uses = len(story.stories_for(bid))
        lines = [f"✗ {e}" for e in errs] + [f"⚠ {w}" for w in warns]
        out(f"{bid}\t{'✗' if errs else '✓'}\t{uses} 处在用" + "".join(f"\n\t{x}" for x in lines))
        bad += len(errs)
    return bad


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(prog="breathing_workbench")
    ap.add_argument("--open", default="", help="启动后直接打开这张呼吸图")
    ap.add_argument("--serve", action="store_true", help="只起 HTTP 服务,不开桌面窗口")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--game-url", default="", help="游戏 dev server 地址(缺省读 devstate.json,再退 127.0.0.1:5173)")
    ap.add_argument("--smoke", action="store_true", help="桌面壳无头自检:load 完即退")
    ap.add_argument("--selftest", nargs="?", const="tools/breathing_workbench/viewer/tests/selftest.js", default="",
                    help="交互层端到端回归:临时样例工程 + 无头桌面壳里的真页面,有 FAIL 退出码 1")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--check", action="store_true", help="形状 / 分层图 / 位移场(不写盘)")
    ap.add_argument("--bundle", action="store_true", help="重打运行时模块的 ESM 包")
    args = ap.parse_args()

    if args.list:
        from tools.breathing_workbench import store, story
        for r in store.list_assets():
            if r.get("error"):
                print(f"{r['id']}\t⚠ {r['error']}")
                continue
            flag = " ⚠ id 与文件名不一致" if r.get("idMismatch") else ""
            size = "×".join(str(v) for v in (r.get("size") or [])) or "⚠ 没写尺寸"
            print(f"{r['id']}\t{r['label']}\t{size}\t{r['base']}\t{len(story.stories_for(r['id']))} 处在用{flag}")
        return 0

    if args.check:
        return 1 if check() else 0

    if args.bundle:
        from tools.breathing_workbench import bundle
        p, err = bundle.ensure_bundle(force=True)
        print(p or "(none)", err or "ok")
        return 0 if p and not err else 1

    if args.serve:
        from http.server import ThreadingHTTPServer
        from tools.breathing_workbench import serve
        port = args.port or serve.PORT
        if args.game_url:
            serve.LINK.set_base(args.game_url)
        if args.open:
            serve.BOOT_OPEN.append(args.open)
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), serve.H)
        except OSError:
            print(f"端口 {port} 已被占用(大概已经在跑)")
            return 2
        print(f"呼吸工作台裸服务(自动化用): http://127.0.0.1:{port}/  游戏={serve.LINK.base}", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        return 0

    from tools.breathing_workbench.app import main as app_main
    t0 = time.time()
    rc = app_main(port=args.port, smoke=args.smoke, open_id=args.open, selftest=args.selftest, game_url=args.game_url)
    if args.smoke or args.selftest:
        print(f"[{'selftest' if args.selftest else 'smoke'}] exit {rc} after {time.time() - t0:.1f}s")
    return rc


if __name__ == "__main__":
    sys.exit(main())
