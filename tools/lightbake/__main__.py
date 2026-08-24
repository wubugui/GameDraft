"""CLI(方案 §12)。GUI 只是壳:`gui` 子命令背后与这里同一条函数链。

    sh scripts/py.sh -m tools.lightbake bake --scene 雾津街头
    bake   --scene X | --all  [质量参数组] [--out-root DIR] [--threads 0] [--quiet]
    check  --scene X [质量参数组]        只跑自检(含重档 #8 双烘对比),不写盘
    report --scene X [质量参数组] [--open]  只出预览
    diff   --scene X --against DIR      两次产物逐项对比
    gui    --scene X                    编辑器壳(§11.1)

质量参数组(bake / check / report 三个子命令共享,GUI 面板与之一一镜像):
    --work-w --spp --moment-spp --ao-spp --vol-spp
    --vol-density --vol-max-cells --no-gi
    --no-nee --clamp-indirect --no-denoise --denoise-iters --sky
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


def _positive(name: str):
    def conv(v: str) -> float:
        f = float(v)
        if f <= 0:
            raise argparse.ArgumentTypeError(f'{name} 必须 > 0')
        return f
    return conv


def _quality_flags(p) -> None:
    """质量参数组 —— bake/check/report 共享同一组旗标(审查纠正:此前只有
    bake 有,check/report 无法复现非缺省参数烘出的场景)。"""
    from tools.lightbake.const import (AO_SPP, CELLS_PER_CHAR_XZ, CHAR_VOL_SPP,
                                       GATHER_SPP, MOMENT_SPP, WORK_W)
    # 三级决议:旗标缺省一律 None = 未指定 ⇒ 落到场景 JSON
    # lighting.bakeParams,再落库缺省(2026-08-25「4搞」)。帮助里的数字
    # 是**库缺省**,场景配了 bakeParams 时以场景为准。
    p.add_argument('--work-w', type=int, default=None,
                   help=f'烘焙工作分辨率宽(库缺省 {WORK_W};实际生效为 '
                        'min(work_w, 原画宽),meta.work 记生效值)')
    p.add_argument('--spp', type=int, default=None,
                   help=f'场景 E gather 的每像素样本数(库缺省 {GATHER_SPP};'
                        '室内建议 64)')
    p.add_argument('--moment-spp', type=int, default=None,
                   help=f'遮蔽矩 spp(库缺省 {MOMENT_SPP})。像素侧与体侧'
                        '**同值双接线**(§5.9 铁律 3);256 只多秒级耗时,'
                        '杀 #5 的噪声份额')
    p.add_argument('--ao-spp', type=int, default=None,
                   help=f'场景局部 AO spp(库缺省 {AO_SPP})')
    p.add_argument('--vol-spp', type=int, default=None,
                   help=f'体 AO/GI 共享 trace 的 spp(库缺省 {CHAR_VOL_SPP})')
    p.add_argument('--vol-density', type=_positive('--vol-density'),
                   default=None,
                   help=f'每角色高几格(横向;纵向自动 2 倍),库缺省 '
                        f'{CELLS_PER_CHAR_XZ:g};室内场景实测需 4'
                        '(建议写进场景 bakeParams.volDensity)')
    p.add_argument('--vol-max-cells', type=int, default=None,
                   help='体网格总格数上限(库缺省 200k;红场景提密度时放开)')
    p.add_argument('--gi', action=argparse.BooleanOptionalAction, default=None,
                   help='烘不烘体 GI 通道(--no-gi 关:2..4 写显式零码字,'
                        '运行时凭 meta.no_gi 跳过;§5.9)')
    p.add_argument('--nee', action=argparse.BooleanOptionalAction,
                   default=None,
                   help='NEE+MIS 光源采样(firefly 无偏解,库缺省开;'
                        '--nee 可显式压过场景 JSON 的关闭)')
    p.add_argument('--clamp-indirect', type=_positive('--clamp-indirect'),
                   default=None,
                   help='单样本间接贡献的亮度上限(Cycles 系,有偏;缺省关。'
                        '必须 > 0 —— 0 会把间接光整段清零,故直接拒收)')
    p.add_argument('--denoise', action=argparse.BooleanOptionalAction,
                   default=None,
                   help='E间接 引导去噪(à-trous 联合双边,库缺省开)')
    p.add_argument('--e-chroma-clamp', type=_positive('--e-chroma-clamp'),
                   default=None,
                   help='E 色度向中性钳的幅度 τ(方案 A:治 base=原画⊘E 的'
                        '互补反色;亮度保持,恒等锚不动。0.2~0.3 起试;'
                        '缺省关)')
    p.add_argument('--denoise-iters', type=int, default=None,
                   help='E间接 引导去噪的 à-trous 趟数(库缺省 3;0 = 关,'
                        '等价 --no-denoise;越多越柔)')
    p.add_argument('--sky', help='烘焙期天空:内联 JSON 或 json 文件路径'
                                 '(覆写场景 lighting.bakeSky)')


def _quality_kwargs(args) -> dict:
    """质量旗标 → bake_scene kwargs(纯 kwargs,与 GUI._bake_kwargs 同族)。
    None 原样透传 = 「未指定」,由 bake_scene 三级决议落到场景 JSON/库缺省。"""
    return dict(work_w=args.work_w, spp=args.spp, moment_spp=args.moment_spp,
                ao_spp=args.ao_spp, vol_spp=args.vol_spp,
                vol_density=args.vol_density,
                vol_max_cells=args.vol_max_cells,
                no_gi=(None if args.gi is None else (not args.gi)),
                nee=args.nee, clamp_indirect=args.clamp_indirect,
                denoise=args.denoise, denoise_iters=args.denoise_iters,
                e_chroma_clamp=args.e_chroma_clamp,
                sky_override=_parse_sky(args.sky))


_THREADS_HELP = '0 = 全部逻辑核;任何取值产物同字节(契约 6)'


def cmd_bake(args) -> int:
    from tools.lightbake import input as input_mod
    from tools.lightbake.pipeline import bake_scene
    _set_threads(args.threads)
    ids = args.scene or (input_mod.list_bakeable() if getattr(args, 'all', False)
                         else None)
    if not ids:
        print('要么 --scene X(可重复),要么 --all', file=sys.stderr)
        return 2
    rc = 0
    for sid in ids:
        try:
            ctx = bake_scene(sid,
                             out_root=(Path(args.out_root) if args.out_root
                                       else None),
                             quiet=args.quiet, **_quality_kwargs(args))
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
                     heavy_checks=True, quiet=False, **_quality_kwargs(args))
    return 1 if ctx.get('failed') else 0


def cmd_report(args) -> int:
    from tools.lightbake.pipeline import bake_scene
    _set_threads(args.threads)
    ctx = bake_scene(args.scene, write=False, make_report=True, quiet=False,
                     **_quality_kwargs(args))
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
    # numba 线程数是线程局部的 —— GUI 的工作线程各自再设(审查 [3])
    return run_gui(args.scene, threads=args.threads)


def build_parser() -> argparse.ArgumentParser:
    """构造完整 parser(独立出来给测试用:旗标 ↔ bake_scene kwargs 的
    镜像由 tests/test_cli_parity.py 钉住)。"""
    ap = argparse.ArgumentParser(prog='tools.lightbake',
                                 description='独立光照 Baker(方案 §12)')
    sub = ap.add_subparsers(dest='cmd', required=True)

    def common(p, scene_required=True):
        if scene_required:
            p.add_argument('--scene', required=True)
        p.add_argument('--threads', type=int, default=0, help=_THREADS_HELP)

    p = sub.add_parser('bake', help='烘焙(结束自动出 report)')
    p.add_argument('--scene', action='append')
    p.add_argument('--all', action='store_true')
    _quality_flags(p)
    p.add_argument('--out-root', default=None,
                   help='替代输出根(验证/实验用;缺省 = 正式路径 '
                        'public/resources/runtime/scenes/<sid>/lighting3)')
    p.add_argument('--threads', type=int, default=0, help=_THREADS_HELP)
    p.add_argument('--quiet', action='store_true')
    p.set_defaults(fn=cmd_bake)

    p = sub.add_parser('check', help='只跑自检(含重档双烘对比),不写盘')
    common(p)
    _quality_flags(p)
    p.set_defaults(fn=cmd_check)

    p = sub.add_parser('report', help='只出预览(重算,不写载荷)')
    common(p)
    _quality_flags(p)
    p.add_argument('--open', action='store_true')
    p.set_defaults(fn=cmd_report)

    p = sub.add_parser('diff', help='两次产物逐项对比')
    common(p)
    p.add_argument('--against', required=True, help='对照产物目录')
    p.set_defaults(fn=cmd_diff)

    p = sub.add_parser('gui', help='编辑器壳(§11.1)')
    common(p)
    p.set_defaults(fn=cmd_gui)
    return ap


def main(argv: list[str] | None = None) -> int:
    # GBK 控制台防线(§14):中文/符号日志不许炸掉命令 —— CLI 入口统一转 utf-8
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:                              # noqa: BLE001 — 非 tty 等
            pass
    args = build_parser().parse_args(argv)
    return args.fn(args)


if __name__ == '__main__':
    raise SystemExit(main())
