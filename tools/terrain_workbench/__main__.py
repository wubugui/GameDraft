# -*- coding: utf-8 -*-
"""CLI：

  python -m tools.terrain_workbench                        # 桌面应用（默认）
  python -m tools.terrain_workbench --open 崖墓             # 开窗口并直接装这个场景（已开着就切过去）
  python -m tools.terrain_workbench --serve [--port 5361]   # 只起 HTTP 服务（自动化 / 测试用，不开浏览器）
  python -m tools.terrain_workbench --game-url http://127.0.0.1:5173
  python -m tools.terrain_workbench --smoke                 # 桌面壳无头自检
  python -m tools.terrain_workbench --selftest              # 交互层端到端回归（无头真页面 + viewer/tests/selftest.js）
  python -m tools.terrain_workbench --list                  # 场景清单 + 地形状态
  python -m tools.terrain_workbench --check [id …]          # 形状 / 磁盘一致 / 连通性（不写盘）
  python -m tools.terrain_workbench --export <id>           # 导出到游戏：盘上的作者层合成进资源
  python -m tools.terrain_workbench --push <id>             # 推给游戏：盘上的作者层合成进预览并通知游戏

`public/resources/runtime/scenes/<id>/terrain/` 的**唯一写入者**；`collision.png` / `collision.json` / 各时段
`ground_d.png` 由它（或烘焙器导出时）经同一个合成器写出。主编辑器只读显示。
"""
from __future__ import annotations

import argparse
import json
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
    ap = argparse.ArgumentParser(prog="terrain_workbench")
    ap.add_argument("--open", default="", help="启动后直接装这个场景")
    ap.add_argument("--serve", action="store_true", help="只起 HTTP 服务，不开桌面窗口")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--game-url", default="", help="游戏 dev server 地址（缺省实探 devstate 与常用端口）")
    ap.add_argument("--smoke", action="store_true", help="桌面壳无头自检：load 完即退")
    ap.add_argument("--selftest", nargs="?", const="tools/terrain_workbench/viewer/tests/selftest.js", default="",
                    help="交互层端到端回归：无头桌面壳里跑真页面 + 场景脚本，有 FAIL 退出码 1")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--check", nargs="*", default=None, help="不给 id = 全部有深度的场景")
    ap.add_argument("--export", default="", help="导出到游戏（写资源）")
    ap.add_argument("--push", default="", help="推给游戏（预览目录，资源不动）")
    args = ap.parse_args()

    if args.list:
        from tools.terrain_workbench import authoring
        for r in authoring.scenes():
            g = r.get("grid")
            tail = ("\t待导出" if r["needsExport"] else "") + ("\t⚠ " + r["docErr"] if r.get("docErr") else "")
            grid_txt = "网格 %dx%d" % (g["grid_width"], g["grid_height"]) if g else "无网格"
            print(f"{r['id']}\t{r['name']}\t{'有深度' if r['depth'] else '无深度'}\t{grid_txt}\t"
                  f"多边形 {r['regions']} / 高度操作 {r['heightOps']} / 笔刷 {'有' if r['brush'] else '无'}{tail}")
        return 0

    if args.check is not None:
        from tools.terrain_workbench import authoring
        ids = args.check or [r["id"] for r in authoring.scenes() if r["depth"]]
        bad = 0
        for sid in ids:
            try:
                r = authoring.check_scene(sid)
            except Exception as e:  # noqa: BLE001
                print(f"{sid}\t✗ {type(e).__name__}: {e}")
                bad += 1
                continue
            lines = [*(f"✗ {p}" for p in r["problems"]), *(f"⚠ {p}" for p in r["reach"])]
            print(f"{sid}\t{'✓' if not lines else ''}" + ("".join(f"\n\t{ln}" for ln in lines) if lines else "")
                  + ("\n\t待导出" if r.get("needsExport") else ""))
            bad += 1 if r["problems"] else 0
        return 1 if bad else 0

    if args.export or args.push:
        from tools.character_lighting_lab import terrain_compose as tc
        from tools.terrain_workbench import authoring
        sid = authoring.safe_sid(args.export or args.push)
        if args.export:
            r = tc.export_terrain(sid)
            print(json.dumps({"exported": sid, "blocked_pct": round(r["blocked_pct"], 2), "grid": r["grid"],
                              "ground": r["ground"]}, ensure_ascii=False))
            authoring.drop_preview_after_export(sid, print)
            print(authoring.push_note(authoring.push_to_game(sid, "export"), sid))
        else:
            r = tc.export_terrain(sid, out_dir=authoring.preview_root(sid))
            print(json.dumps({"preview": authoring._rel(authoring.preview_root(sid)), "blocked_pct": round(r["blocked_pct"], 2)},
                             ensure_ascii=False))
            print(authoring.push_note(authoring.push_to_game(sid, "preview"), sid))
        return 0

    if args.serve:
        from http.server import ThreadingHTTPServer
        from tools.terrain_workbench import serve
        import os
        port = args.port or serve.PORT
        if args.game_url:
            os.environ["GAMEDRAFT_GAME_URL"] = args.game_url
        if args.open:
            serve.BOOT_OPEN.append(args.open)
        try:
            httpd = ThreadingHTTPServer(("127.0.0.1", port), serve.H)
        except OSError:
            print(f"端口 {port} 已被占用（大概已经在跑）")
            return 2
        print(f"地形工作台裸服务（自动化用，不开浏览器）: http://127.0.0.1:{port}/", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        return 0

    from tools.terrain_workbench.app import main as app_main
    t0 = time.time()
    rc = app_main(port=args.port, smoke=args.smoke, open_id=args.open, selftest=args.selftest, game_url=args.game_url)
    if args.smoke or args.selftest:
        print(f"[{'selftest' if args.selftest else 'smoke'}] exit {rc} after {time.time() - t0:.1f}s")
    return rc


if __name__ == "__main__":
    sys.exit(main())
