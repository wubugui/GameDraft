# -*- coding: utf-8 -*-
"""CLI：

  python -m tools.vfx_workbench                          # 桌面应用（默认）
  python -m tools.vfx_workbench --open bat_cliff          # 开窗口并直接打开那份效果（已开着就切过去）
  python -m tools.vfx_workbench --serve [--port 5341]     # 只起 HTTP 服务（自动化/测试用，不开浏览器）
  python -m tools.vfx_workbench --game-url http://127.0.0.1:5173
  python -m tools.vfx_workbench --smoke                   # 桌面壳无头自检
  python -m tools.vfx_workbench --selftest                # 交互层端到端回归（无头真页面 + viewer/tests/selftest.js）
  python -m tools.vfx_workbench --list                    # 效果清单
  python -m tools.vfx_workbench --check [id …]            # 归一化校验（不写盘）：形状 / 护栏 / 告警
  python -m tools.vfx_workbench --bundle                  # 只重打运行时模块包

效果资产库 public/assets/data/vfx/；**本工具是它唯一的写入者**，主编辑器只读镜像
（与 assets/data/trajectories/ 完全同模式）。本地预览用的是打包进来的**运行时模拟核心本体**，
不是另写一份 JS。
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
    ap = argparse.ArgumentParser(prog="vfx_workbench")
    ap.add_argument("--open", default="", help="启动后直接打开这份效果")
    ap.add_argument("--serve", action="store_true", help="只起 HTTP 服务，不开桌面窗口")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--game-url", default="", help="游戏 dev server 地址（缺省读 devstate.json，再退 127.0.0.1:5173）")
    ap.add_argument("--smoke", action="store_true", help="桌面壳无头自检：load 完即退")
    ap.add_argument("--selftest", nargs="?", const="tools/vfx_workbench/viewer/tests/selftest.js", default="",
                    help="交互层端到端回归：无头桌面壳里跑真页面 + 场景脚本，有 FAIL 退出码 1")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--check", nargs="*", default=None, help="归一化校验（不写盘）；不给 id = 全部")
    ap.add_argument("--bundle", action="store_true", help="重打运行时模拟核心的 ESM 包")
    args = ap.parse_args()

    if args.list:
        from tools.vfx_workbench import assets
        for r in assets.list_assets():
            if r.get("error"):
                print(f"{r['id']}\t⚠ {r['error']}")
                continue
            flag = " ⚠ id 与文件名不一致" if r.get("idMismatch") else ""
            print(f"{r['id']}\t{r['label']}\t发射器={','.join(r['emitters']) or '（空）'}"
                  f"\t{'群体' if r['flock'] else '粒子'}\t场景={r['sceneId'] or '-'}{flag}")
        return 0

    if args.check is not None:
        from tools.vfx_workbench import assets
        ids = args.check or [r["id"] for r in assets.list_assets()]
        bad = 0
        for eid in ids:
            try:
                doc = assets.load_asset(eid)
                if doc is None:
                    print(f"{eid}\t✗ 不存在")
                    bad += 1
                    continue
                warn: list[str] = []
                assets.normalize_effect(doc, warn)
                print(f"{eid}\t✓" + ("".join(f"\n\t⚠ {w}" for w in warn) if warn else ""))
            except Exception as e:  # noqa: BLE001
                print(f"{eid}\t✗ {type(e).__name__}: {e}")
                bad += 1
        return 1 if bad else 0

    if args.bundle:
        from tools.vfx_workbench import bundle
        p, err = bundle.ensure_bundle(force=True)
        print(p or "(none)", err or "ok")
        return 0 if p and not err else 1

    if args.serve:
        from http.server import ThreadingHTTPServer
        from tools.vfx_workbench import serve
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
        print(f"粒子工作台裸服务（自动化用，不开浏览器）: http://127.0.0.1:{port}/  游戏={serve.LINK.base}", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        return 0

    from tools.vfx_workbench.app import main as app_main
    t0 = time.time()
    rc = app_main(port=args.port, smoke=args.smoke, open_id=args.open, selftest=args.selftest, game_url=args.game_url)
    if args.smoke or args.selftest:
        print(f"[{'selftest' if args.selftest else 'smoke'}] exit {rc} after {time.time() - t0:.1f}s")
    return rc


if __name__ == "__main__":
    sys.exit(main())
