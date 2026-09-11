# -*- coding: utf-8 -*-
"""CLI：

  python -m tools.acoustic_workbench                        # 桌面应用（默认）
  python -m tools.acoustic_workbench --open 山谷_大          # 开窗口并直接打开那个空间（已开着就切过去）
  python -m tools.acoustic_workbench --serve [--port 5331]   # 只起 HTTP 服务（自动化/测试用，不开浏览器）
  python -m tools.acoustic_workbench --game-url http://127.0.0.1:5173   # 指定游戏 dev server
  python -m tools.acoustic_workbench --smoke                 # 桌面壳无头自检
  python -m tools.acoustic_workbench --selftest              # 交互层端到端回归（无头真页面 + viewer/tests/selftest.js）
  python -m tools.acoustic_workbench --list                  # 空间清单
  python -m tools.acoustic_workbench --bundle                # 只重打运行时模块包

声学空间库 public/assets/data/acoustic_spaces.json；本工具是它唯一的写入者。
游戏运行时只是预览器：工作台每动一下游戏下一拍重算 IR，试听也是经通道让游戏播。
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(prog="acoustic_workbench")
    ap.add_argument("--open", default="", help="启动后直接打开这个空间")
    ap.add_argument("--serve", action="store_true", help="只起 HTTP 服务，不开桌面窗口")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--game-url", default="", help="游戏 dev server 地址（缺省读 devstate.json，再退 127.0.0.1:5173）")
    ap.add_argument("--smoke", action="store_true", help="桌面壳无头自检：load 完即退")
    ap.add_argument("--selftest", nargs="?", const="tools/acoustic_workbench/viewer/tests/selftest.js", default="",
                    help="交互层端到端回归：无头桌面壳里跑真页面 + 场景脚本，有 FAIL 退出码 1")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--bundle", action="store_true", help="重打运行时 acousticSpace.ts 的 ESM 包")
    args = ap.parse_args()

    if args.list:
        from tools.acoustic_workbench import spaces
        for r in spaces.list_spaces():
            bound = ",".join(r["boundBy"]) or "（没有场景绑定）"
            flag = " ⚠ v1 残留" if r["legacy"] else ""
            print(f"{r['id']}\t{r['label']}\t场景={r['sceneId'] or '?'}\t面={r['reflectors']}\t×{r['distanceScale']}\t绑定:{bound}{flag}")
        return 0

    if args.bundle:
        from tools.acoustic_workbench import bundle
        p, err = bundle.ensure_bundle(force=True)
        print(p or "(none)", err or "ok")
        return 0 if p and not err else 1

    if args.serve:
        from http.server import ThreadingHTTPServer
        from tools.acoustic_workbench import serve
        port = args.port or serve.PORT
        if args.game_url:
            serve.LINK.set_base(args.game_url)
        if args.open:
            serve.BOOT_OPEN.append(args.open)
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), serve.H)
        except OSError:
            print(f"端口 {port} 已被占用（大概已经在跑）")
            return 2
        print(f"声学工作台裸服务（自动化用，不开浏览器）: http://127.0.0.1:{port}/  游戏={serve.LINK.base}", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        return 0

    from tools.acoustic_workbench.app import main as app_main
    t0 = time.time()
    rc = app_main(port=args.port, smoke=args.smoke, open_id=args.open, selftest=args.selftest, game_url=args.game_url)
    if args.smoke or args.selftest:
        print(f"[{'selftest' if args.selftest else 'smoke'}] exit {rc} after {time.time() - t0:.1f}s")
    return rc


if __name__ == "__main__":
    sys.exit(main())
