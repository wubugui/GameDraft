"""CLI(方案 §12)。GUI 只是壳:`gui` 子命令背后与这里同一条函数链。

    sh scripts/py.sh -m tools.lightbake bake --scene 雾津街头
    bake   --scene X | --all  [--spp 16] [--vol-density 3] [--no-gi]
                              [--sky <json|path>] [--threads 0]
    check  --scene X [--threads 0]      只跑自检(含重档 #8 双烘对比),不写盘
    report --scene X [--open]           只出预览
    diff   --scene X --against DIR      两次产物逐项对比
    gui    --scene X                    编辑器壳(§11.1)
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def _parse_sky(arg: str | None) -> dict | None:
    if not arg:
        return None
    s = arg.strip()
    if s.startswith('{'):
        return json.loads(s)
    return json.loads(Path(s).read_text(encoding='utf-8'))


def _set_threads(n: int) -> None:
    from tools.lightbake.trace import set_threads
    set_threads(n)


def cmd_bake(args) -> int:
    from tools.lightbake import input as input_mod
    from tools.lightbake.pipeline import bake_scene
    _set_threads(args.threads)
    sky = _parse_sky(args.sky)
    ids = args.scene or (input_mod.list_bakeable() if getattr(args, 'all', False)
                         else None)
    if not ids:
        print('要么 --scene X(可重复),要么 --all', file=sys.stderr)
        return 2
    rc = 0
    for sid in ids:
        try:
            ctx = bake_scene(sid, spp=args.spp, sky_override=sky,
                             no_gi=args.no_gi, vol_density=args.vol_density,
                             nee=not args.no_nee,
                             clamp_indirect=args.clamp_indirect,
                             denoise=not args.no_denoise,
                             quiet=args.quiet)
        except Exception as exc:                       # noqa: BLE001 — 单场景失败不拖垮全烘
            print(f'  [{sid}] 失败: {type(exc).__name__}: {exc}', file=sys.stderr)
            rc = 1
            continue
        if ctx.get('failed'):
            rc = 1
    return rc


def cmd_check(args) -> int:
    from tools.lightbake.pipeline import bake_scene
    _set_threads(args.threads)
    ctx = bake_scene(args.scene, write=False, make_report=False,
                     heavy_checks=True, quiet=False)
    return 1 if ctx.get('failed') else 0


def cmd_report(args) -> int:
    from tools.lightbake.pipeline import bake_scene
    _set_threads(args.threads)
    ctx = bake_scene(args.scene, write=False, make_report=True, quiet=False)
    # 自检红更要看 report —— 它就是判读失败的工具(复审纠正:此前红反而不开)
    rp = ctx['out_dir'] / 'preview' / 'report.html'
    if args.open and rp.exists():
        import webbrowser
        webbrowser.open(rp.as_uri())
    return 1 if ctx.get('failed') else 0


def cmd_diff(args) -> int:
    """两份产物逐项对比:字节级 + 逐图统计 + meta 数值差。"""
    import numpy as np
    from PIL import Image
    from tools.lightbake import input as input_mod
    a_dir = input_mod.SCENES_RT / args.scene / 'lighting3'
    b_dir = Path(args.against)
    if (b_dir / args.scene / 'lighting3').is_dir():
        b_dir = b_dir / args.scene / 'lighting3'
    names = sorted({p.name for p in a_dir.glob('*') if p.is_file()}
                   | {p.name for p in b_dir.glob('*') if p.is_file()})
    rc = 0
    for name in names:
        pa, pb = a_dir / name, b_dir / name
        if not pa.exists() or not pb.exists():
            print(f'  ✗ {name}: 只在一侧存在({"A" if pa.exists() else "B"})')
            rc = 1
            continue
        da, db = pa.read_bytes(), pb.read_bytes()
        if da == db:
            print(f'  = {name}: 同字节({len(da)} B)')
            continue
        rc = 1
        if name.endswith('.png'):
            ia = np.asarray(Image.open(pa), np.float32)
            ib = np.asarray(Image.open(pb), np.float32)
            if ia.shape != ib.shape:
                print(f'  ✗ {name}: 尺寸不同 {ia.shape} vs {ib.shape}')
            else:
                d = np.abs(ia - ib)
                print(f'  ≠ {name}: |Δ|均值 {d.mean():.3f}/255  p99 '
                      f'{np.percentile(d, 99):.1f}/255  max {d.max():.0f}/255')
        elif name == 'meta.json':
            ja = json.loads(da.decode('utf-8'))
            jb = json.loads(db.decode('utf-8'))

            def walk(a, b, path=''):
                if isinstance(a, dict) and isinstance(b, dict):
                    for k in sorted(set(a) | set(b)):
                        walk(a.get(k), b.get(k), f'{path}.{k}')
                elif a != b:
                    print(f'    meta{path}: {a!r} → {b!r}')
            walk(ja, jb)
        else:
            print(f'  ≠ {name}: {len(da)} B vs {len(db)} B')
    return rc


def cmd_gui(args) -> int:
    _set_threads(args.threads)
    from tools.lightbake.gui.app import run_gui
    return run_gui(args.scene)


def main(argv: list[str] | None = None) -> int:
    # GBK 控制台防线(§14):中文/符号日志不许炸掉命令 —— CLI 入口统一转 utf-8
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:                              # noqa: BLE001 — 非 tty 等
            pass
    ap = argparse.ArgumentParser(prog='tools.lightbake',
                                 description='独立光照 Baker(方案 §12)')
    sub = ap.add_subparsers(dest='cmd', required=True)

    def common(p, scene_required=True):
        if scene_required:
            p.add_argument('--scene', required=True)
        p.add_argument('--threads', type=int, default=0,
                       help='0 = 全部逻辑核;任何取值产物同字节(契约 6)')

    from tools.lightbake.const import CELLS_PER_CHAR_XZ, GATHER_SPP

    p = sub.add_parser('bake', help='烘焙(结束自动出 report)')
    p.add_argument('--scene', action='append')
    p.add_argument('--all', action='store_true')
    p.add_argument('--spp', type=int, default=GATHER_SPP)

    def _density(v: str) -> float:
        f = float(v)
        if f <= 0:
            raise argparse.ArgumentTypeError('--vol-density 必须 > 0')
        return f
    p.add_argument('--vol-density', type=_density, default=None,
                   help=f'每角色高几格(横向;纵向自动 2 倍),缺省 '
                        f'{CELLS_PER_CHAR_XZ:g};室内场景实测需 4')
    p.add_argument('--no-gi', action='store_true')
    p.add_argument('--no-nee', action='store_true',
                   help='关闭 NEE+MIS 光源采样(firefly 的无偏解,缺省开)')
    p.add_argument('--clamp-indirect', type=float, default=None,
                   help='单样本间接贡献的亮度上限(Cycles 系,有偏;缺省关)')
    p.add_argument('--no-denoise', action='store_true',
                   help='关闭 E间接 的引导去噪(à-trous 联合双边,缺省开)')
    p.add_argument('--sky', help='烘焙期天空:内联 JSON 或 json 文件路径(覆写场景值)')
    p.add_argument('--threads', type=int, default=0)
    p.add_argument('--quiet', action='store_true')
    p.set_defaults(fn=cmd_bake)

    p = sub.add_parser('check', help='只跑自检(含重档双烘对比),不写盘')
    common(p)
    p.set_defaults(fn=cmd_check)

    p = sub.add_parser('report', help='只出预览(重算,不写载荷)')
    common(p)
    p.add_argument('--open', action='store_true')
    p.set_defaults(fn=cmd_report)

    p = sub.add_parser('diff', help='两次产物逐项对比')
    common(p)
    p.add_argument('--against', required=True, help='对照产物目录')
    p.set_defaults(fn=cmd_diff)

    p = sub.add_parser('gui', help='编辑器壳(§11.1)')
    common(p)
    p.set_defaults(fn=cmd_gui)

    args = ap.parse_args(argv)
    return args.fn(args)


if __name__ == '__main__':
    raise SystemExit(main())
