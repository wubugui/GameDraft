"""CLI:

  python -m tools.scene_relight                          # 桌面应用(默认;零浏览器缓存)
  python -m tools.scene_relight --serve [--port 5317]    # 仅起 HTTP 服务(浏览器/面板用)
  python -m tools.scene_relight --list                   # 场景清单与状态
  python -m tools.scene_relight --scene 码头白天 --preset 夜 --export
  python -m tools.scene_relight --all --preset 夜 --export      # 批量(跳过缺背景的)
  python -m tools.scene_relight --scene X --preset 夜 --out preview.png --width 1024

批量/单场景导出用参数的优先级:out/<场景>/params_<预设>.json(工作台里调过的)
> 全局预设表。--export 落盘 + 备份旧变体;--out 只写指定路径(试跑用,不备份)。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.scene_relight import store                    # noqa: E402
from tools.scene_relight.geometry import Scene, list_scenes  # noqa: E402
from tools.scene_relight.presets import PRESETS          # noqa: E402


def _params_for(sid: str, preset: str) -> dict:
    saved = store.load_params(sid, preset)
    if saved is not None:
        return saved
    if preset not in PRESETS:
        raise SystemExit(f'未知预设 {preset!r};可选: {", ".join(PRESETS)}')
    return PRESETS[preset]


def main() -> None:
    # Windows 控制台默认 GBK,✓/中文场景名一打就 UnicodeEncodeError
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(prog='scene_relight')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--scene')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--preset')
    ap.add_argument('--export', action='store_true', help='全分辨率导出进 runtime 场景目录')
    ap.add_argument('--out', help='只写这个路径(试跑,不进工程)')
    ap.add_argument('--width', type=int, help='--out 时的预览宽度,缺省原生')
    ap.add_argument('--serve', action='store_true', help='仅起 HTTP 服务,不开桌面窗口')
    ap.add_argument('--smoke', action='store_true', help='桌面壳无头自检:load 完即退')
    ap.add_argument('--port', type=int, default=None)
    args = ap.parse_args()

    if args.list:
        for s in list_scenes():
            marks = ('✓深度' if s['depth'] else '○无深度') + (' ✓mask' if s['mask'] else '')
            var = f"  变体: {', '.join(s['variants'])}" if s['variants'] else ''
            print(f"{s['id']:<16} {marks}{var}")
        return

    if args.scene or args.all:
        if not args.preset:
            raise SystemExit('--scene/--all 需要 --preset')
        sids = [s['id'] for s in list_scenes() if s['bg_ok']] if args.all else [args.scene]
        for sid in sids:
            scene = Scene(sid)
            params = _params_for(sid, args.preset)
            if args.out and not args.all:
                data = store.render_png_bytes(scene, params, width=args.width)
                Path(args.out).write_bytes(data)
                print(f'{sid}: → {args.out} ({len(data) / 1048576:.1f}MB)')
            elif args.export:
                res = store.export_variant(scene, args.preset, params)
                print(f"{sid}: → {res['dest']} ({res['bytes'] / 1048576:.1f}MB)"
                      + (f"  旧变体备份 {res['backup']}" if res['backup'] else ''))
            else:
                raise SystemExit('要 --export(进工程)还是 --out <路径>(试跑)?')
        return

    if args.serve:
        from tools.scene_relight.serve import PORT, main as serve_main
        serve_main(args.port or PORT)
        return

    from tools.scene_relight.app import main as app_main
    raise SystemExit(app_main(port=args.port, smoke=args.smoke))


if __name__ == '__main__':
    main()
