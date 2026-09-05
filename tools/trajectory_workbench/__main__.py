# -*- coding: utf-8 -*-
"""CLI：

  python -m tools.trajectory_workbench                       # 桌面应用（默认）
  python -m tools.trajectory_workbench --open coin_drop_demo # 开窗口并直接打开那条资产（已开着就切过去）
  python -m tools.trajectory_workbench --serve [--port 5321]  # 只起 HTTP 服务（给自动化/测试用，**不开浏览器**）
  python -m tools.trajectory_workbench --smoke               # 桌面壳无头自检
  python -m tools.trajectory_workbench --selftest            # 交互层端到端回归（无头真页面 + viewer/tests/selftest.js）
  python -m tools.trajectory_workbench --list                # 资产清单
  python -m tools.trajectory_workbench --rebake <id>...      # 按资产里的 source/authoring 重烘并写回（--all 全部）

一条轨迹一个文件：public/assets/data/trajectories/<id>.json；本工具是它唯一的写入者。

**这是桌面应用**（制作人 2026-09-04 定死）：面向策划的入口只有桌面窗口（tools/desktop_shell：
纯内存 profile、NoCache、NoPersistentCookies、服务端 no-store），不走系统浏览器、不留任何浏览器缓存。
``--serve`` 只是给无头验证与自动化的裸服务，永远不会替你开浏览器。
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
    ap = argparse.ArgumentParser(prog="trajectory_workbench")
    ap.add_argument("--open", default="", help="启动后直接打开这条资产")
    ap.add_argument("--serve", action="store_true", help="只起 HTTP 服务，不开桌面窗口")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--no-open", action="store_true", help="（兼容旧写法；--serve 本来就不开浏览器）")
    ap.add_argument("--smoke", action="store_true", help="桌面壳无头自检：load 完即退")
    ap.add_argument("--selftest", nargs="?", const="tools/trajectory_workbench/viewer/tests/selftest.js", default="",
                    help="交互层端到端回归：无头桌面壳里跑真页面 + 场景脚本（缺省 viewer/tests/selftest.js），有 FAIL 退出码 1")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--rebake", nargs="*", help="重烘这些资产并写回；配 --all 重烘全部")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()

    from tools.trajectory_workbench import assets

    if args.list:
        for r in assets.list_assets():
            flag = "⚠ " + r["error"] if r.get("error") else f"{r['space']:6} {r['frames']:4} 帧  场景={r['sceneId']}"
            print(f"{r['id']}\t{r.get('label', '')}\t{flag}")
        return 0

    if args.rebake is not None:
        from tools.trajectory_workbench.serve import save_document
        ids = [r["id"] for r in assets.list_assets() if not r.get("error")] if args.all else list(args.rebake)
        if not ids:
            print("没有要重烘的资产（给 id 或 --all）")
            return 2
        rc = 0
        for tid in ids:
            doc = assets.load_asset(tid)
            if doc is None:
                print(f"{tid}: 不存在")
                rc = 1
                continue
            try:
                res = save_document(doc)
                n = len(res["doc"].get("keyframes") or [])
                w = "; ".join(res["bake"]["warnings"])
                print(f"{tid}: {n} 帧 → {res['path']}" + (f"  ⚠ {w}" if w else ""))
            except Exception as e:  # noqa: BLE001
                print(f"{tid}: 失败 {type(e).__name__}: {e}")
                rc = 1
        return rc

    if args.serve:
        from http.server import ThreadingHTTPServer
        from tools.trajectory_workbench import serve
        port = args.port or serve.PORT
        if args.open:
            serve.BOOT_OPEN.append(args.open)
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), serve.H)
        except OSError:
            print(f"端口 {port} 已被占用（大概已经在跑）")
            return 2
        print(f"轨迹工作台裸服务（自动化用，不开浏览器）: http://127.0.0.1:{port}/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        return 0

    from tools.trajectory_workbench.app import main as app_main
    t0 = time.time()
    rc = app_main(port=args.port, smoke=args.smoke, open_id=args.open, selftest=args.selftest)
    if args.smoke or args.selftest:
        print(f"[{'selftest' if args.selftest else 'smoke'}] exit {rc} after {time.time() - t0:.1f}s")
    return rc


if __name__ == "__main__":
    sys.exit(main())
