# -*- coding: utf-8 -*-
"""CLI:

  python -m tools.sway_workbench                        # 桌面应用(默认)
  python -m tools.sway_workbench --open 跑马梁           # 开窗口并直接装这个场景
  python -m tools.sway_workbench --serve [--port 5351]   # 只起 HTTP 服务(自动化 / 测试用)
  python -m tools.sway_workbench --smoke                 # 桌面壳无头自检
  python -m tools.sway_workbench --list                  # 场景 + 拆层状态
  python -m tools.sway_workbench --bake 跑马梁           # 命令行重烘一次(与页面上的按钮同一条路)

作者面:自动分割打底 → 页面上涂三个通道(补植被 / 锁死不动 / 刚体)→ 重烘 → 推给游戏看真效果。
涂层落 ``lighting/<背景基名>/sway_paint.png``,是**烘焙的输入**,不进发行包。
拆层本体在 ``tools/character_lighting_lab/sway_field.py``,本工具不重写它的任何一步。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(prog="sway_workbench")
    ap.add_argument("--open", default="", help="启动后直接装这个场景")
    ap.add_argument("--serve", action="store_true", help="只起 HTTP 服务,不开桌面窗口")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--smoke", action="store_true", help="桌面壳无头自检:load 完即退")
    ap.add_argument("--selftest", nargs="?", const="tools/sway_workbench/viewer/tests/selftest.js", default="",
                    help="交互层端到端回归:无头桌面壳里跑真页面 + 场景脚本,有 FAIL 退出码 1")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--bake", default="", help="命令行重烘一个场景的拆层")
    args = ap.parse_args()

    if args.list:
        from tools.sway_workbench import layers
        for r in layers.scenes():
            s = r.get("sway")
            state = "没烘过" if not s else (
                f"v{s['version']} / {s['instances']} 株"
                + ("(版本旧,要重烘)" if s["stale"] else "")
                + ("(有涂层)" if s["paint"] else "")
                + ("(有锁定图)" if s["lock"] else ""))
            print(f"{r['id']:<16} 深度 {'有' if r['depth'] else '无':<2} {state}")
        return 0

    if args.bake:
        from tools.sway_workbench import layers
        out = layers.bake(args.bake)
        for line in out.get("log") or []:
            print(line)
        if not out.get("ok"):
            print(f"烘焙失败:{out.get('err')}", file=sys.stderr)
            return 1
        return 0

    if args.serve:
        from tools.sway_workbench import serve
        serve.serve(args.port or serve.PORT)
        return 0

    from tools.sway_workbench import app
    return app.main(port=args.port, smoke=args.smoke, open_id=args.open, selftest=args.selftest)


if __name__ == "__main__":
    sys.exit(main())
