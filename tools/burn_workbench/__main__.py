# -*- coding: utf-8 -*-
"""CLI：

  sh scripts/py.sh -m tools.burn_workbench                         # 桌面应用（默认）
  sh scripts/py.sh -m tools.burn_workbench --open paper_pile       # 开窗并打开那份模板（已开着就切过去）
  sh scripts/py.sh -m tools.burn_workbench --game-url http://127.0.0.1:5173
  sh scripts/py.sh -m tools.burn_workbench --smoke                 # 桌面壳无头自检：load 完即退
  sh scripts/py.sh -m tools.burn_workbench --selftest [js]         # 交互层端到端回归（临时样例工程 + viewer/tests/selftest.js）
  sh scripts/py.sh -m tools.burn_workbench --serve [--port 5351]   # 只起 HTTP 服务（自动化用）
  sh scripts/py.sh -m tools.burn_workbench --list                  # 模板清单（尺寸 / 图 / 几处在用）
  sh scripts/py.sh -m tools.burn_workbench --check                 # 不写盘：模板形状 / 图在不在 / 粒子效果在不在 / 引用处的模板在不在（✗ = 退出码 1）
  sh scripts/py.sh -m tools.burn_workbench --bundle                # 只重打运行时模块包

可燃物模板 ``public/assets/data/burnables/``：**本工具是唯一的写入者**，主编辑器只读显示；模板和场景无关，
谁用它写在宿主自己身上（热点 / NPC / 挂件预设 / 轨迹 spawn 规格 / 粒子薄片）。本地预览跑的是打包进来的运行时燃烧模拟本体
（``burnSim.ts``），按模板真实尺寸摆一个实例，不是 JS 里另写的一份。
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
    """``--check`` 本体（测试直接调）：返回 ✗ 的条数。"""
    from tools.burn_workbench import scenes, store
    from tools.editor.shared import burnables as B
    bad = 0
    effects = {e["id"] for e in scenes.effect_ids()}
    for r in store.list_assets():
        bid = r["id"]
        lines: list[str] = []
        errs: list[str] = []
        try:
            doc = store.load_asset(bid)
            norm, warn = store.normalize(doc, bid)
        except Exception as e:  # noqa: BLE001
            out(f"{bid}\t✗ {type(e).__name__}: {e}")
            bad += 1
            continue
        lines.extend(f"⚠ {w}" for w in warn)
        image = str(norm.get("image") or "")
        if not image.startswith(scenes.MEDIA_URL_PREFIX):
            errs.append(f"image 必须落在 public/resources/runtime 下（{image}）：运行时读不出图，这份模板不建")
        elif scenes.media_image_file(image) is None:
            errs.append(f"图不存在：{image}（运行时读不出图，这份模板不建）")
        else:
            size = scenes.image_size(image)
            dev = store.aspect_deviation(norm.get("widthCm"), norm.get("heightCm"), *(size or (None, None)))
            if dev is not None and dev > store.ASPECT_TOLERANCE:
                lines.append(f"⚠ 真实尺寸 {norm['widthCm']}×{norm['heightCm']} cm 的宽高比与图（{size[0]}×{size[1]} px）差 {dev * 100:.1f}%："
                             "挂到手上是等比缩放、按宽算")
        for i, slot in enumerate(norm.get("particles") or []):
            eff = str(slot.get("effect") or "")
            if eff and eff not in effects:
                errs.append(f"particles[{i}].effect「{eff}」不在 assets/data/vfx/ 里：这团粒子不发")
        lines = [f"✗ {e}" for e in errs] + lines
        out(f"{bid}\t{'✗' if errs else '✓'}" + "".join(f"\n\t{x}" for x in lines))
        bad += len(errs)
    known = {r["id"] for r in store.list_assets() if not r.get("error")}
    refs = B.scan_template_refs(store.PROJECT)
    ref_bad = 0
    for ref in refs:
        tid = ref["template"]
        where = f"{ref['file']} {'/'.join(str(p) for p in ref['path'])}"
        if tid not in known:
            out(f"引用\t✗ {where}：模板「{tid}」不存在（burnables/ 里没有这个文件）")
            ref_bad += 1
            continue
        if ref.get("kind") == "plate":
            try:
                mode = (store.load_asset(tid) or {}).get("mode", "spread")
            except (OSError, ValueError):
                mode = "spread"
            if mode == "consume":
                out(f"引用\t✗ {where}：粒子薄片只能绑面燃烧模板，「{tid}」是消耗燃烧")
                ref_bad += 1
    out(f"引用\t{'✓' if not ref_bad else '✗'} {len(refs)} 处宿主引用模板" + (f"，{ref_bad} 处有问题" if ref_bad else ""))
    return bad + ref_bad


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(prog="burn_workbench")
    ap.add_argument("--open", default="", help="启动后直接打开这份模板")
    ap.add_argument("--serve", action="store_true", help="只起 HTTP 服务，不开桌面窗口")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--game-url", default="", help="游戏 dev server 地址（缺省读 devstate.json，再退 127.0.0.1:5173）")
    ap.add_argument("--smoke", action="store_true", help="桌面壳无头自检：load 完即退")
    ap.add_argument("--selftest", nargs="?", const="tools/burn_workbench/viewer/tests/selftest.js", default="",
                    help="交互层端到端回归：临时样例工程 + 无头桌面壳里的真页面，有 FAIL 退出码 1")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--check", action="store_true", help="模板形状 / 图 / 粒子效果 / 引用处的模板（不写盘）")
    ap.add_argument("--bundle", action="store_true", help="重打运行时模块的 ESM 包")
    args = ap.parse_args()

    if args.list:
        from tools.burn_workbench import store
        from tools.editor.shared import burnables as B
        counts: dict[str, int] = {}
        for ref in B.scan_template_refs(store.PROJECT):
            counts[ref["template"]] = counts.get(ref["template"], 0) + 1
        for r in store.list_assets():
            if r.get("error"):
                print(f"{r['id']}\t⚠ {r['error']}")
                continue
            flag = " ⚠ id 与文件名不一致" if r.get("idMismatch") else ""
            size = f"{r['widthCm']}×{r['heightCm']} cm" if r.get("widthCm") is not None and r.get("heightCm") is not None else "⚠ 没写尺寸"
            print(f"{r['id']}\t{r['label']}\t{r['mode']}\t{size}\t{r['image']}\t{counts.get(r['id'], 0)} 处在用{flag}")
        return 0

    if args.check:
        return 1 if check() else 0

    if args.bundle:
        from tools.burn_workbench import bundle
        p, err = bundle.ensure_bundle(force=True)
        print(p or "(none)", err or "ok")
        return 0 if p and not err else 1

    if args.serve:
        from http.server import ThreadingHTTPServer
        from tools.burn_workbench import serve
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
        print(f"燃烧工作台裸服务（自动化用）: http://127.0.0.1:{port}/  游戏={serve.LINK.base}", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
        return 0

    from tools.burn_workbench.app import main as app_main
    t0 = time.time()
    rc = app_main(port=args.port, smoke=args.smoke, open_id=args.open, selftest=args.selftest, game_url=args.game_url)
    if args.smoke or args.selftest:
        print(f"[{'selftest' if args.selftest else 'smoke'}] exit {rc} after {time.time() - t0:.1f}s")
    return rc


if __name__ == "__main__":
    sys.exit(main())
