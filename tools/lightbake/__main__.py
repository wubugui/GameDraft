"""CLI（方案 §12）。

```bash
sh scripts/py.sh -m tools.lightbake bake  --scene 雾津街头
sh scripts/py.sh -m tools.lightbake bake  --all
sh scripts/py.sh -m tools.lightbake check --scene 雾津街头
sh scripts/py.sh -m tools.lightbake report --scene 雾津街头 [--open]
sh scripts/py.sh -m tools.lightbake diff   --scene 雾津街头 --against DIR
```

`bake` 结束自动出 report 并跑自检，红就非零退出。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# GBK 控制台：中文 print 会 UnicodeEncodeError。日志统一按 UTF-8 输出。
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, 'reconfigure'):
        _stream.reconfigure(encoding='utf-8', errors='replace')


def _parse_sky(args) -> dict | None:
    """`--sky <json|path>` 的解析：JSON 字符串 / .json 文件 / 图片（skybox）。"""
    if not args.sky:
        return None
    s = args.sky
    # JSON 字符串
    if s.lstrip().startswith('{'):
        return json.loads(s)
    p = Path(s)
    if p.suffix.lower() == '.json':
        return json.loads(p.read_text(encoding='utf-8'))
    # 图片 → skybox
    return {'mode': 'skybox', 'file': s}


def cmd_bake(args) -> int:
    from .bake import bake_scene, scene_payload_dir
    from .check import any_failed, run_checks
    from .input import list_scenes
    from .payload import write_payload
    from .report import build_report

    sky = _parse_sky(args)
    if args.sky_color:
        sky = dict(sky or {})
        sky['mode'] = 'color'
        sky['color'] = [float(v) for v in args.sky_color.split(',')]
    if args.sky_intensity is not None:
        sky = dict(sky or {'mode': 'color', 'color': [1.0, 1.0, 1.0]})
        sky['intensity'] = args.sky_intensity

    if args.scene:
        ids = args.scene
    else:
        ids = [s['id'] for s in list_scenes() if s['depth'] and s['bg_ok']]

    failed = False
    for sid in ids:
        print(f'== 烘焙 {sid} ==', flush=True)
        try:
            b = bake_scene(sid, work_w=args.work_w, spp=args.spp,
                           vol_density=args.vol_density, no_gi=args.no_gi,
                           sky=sky, progress=not args.quiet)
        except Exception as exc:                              # noqa: BLE001
            print(f'  {sid} 跳过: {type(exc).__name__}: {exc}', flush=True)
            failed = True
            continue
        out = scene_payload_dir(sid)
        write_payload(b, out)
        results = run_checks(b)
        for r in results:
            print(f'  自检 {r.cid:>2} {"绿" if r.ok else "红"}  {r.name}: {r.detail}', flush=True)
        if any_failed(results):
            failed = True
        html = build_report(b, results)
        (out / 'preview').mkdir(parents=True, exist_ok=True)
        (out / 'preview' / 'report.html').write_text(html, encoding='utf-8')
        print(f'  产物写进 {out}', flush=True)
    return 1 if failed else 0


def cmd_check(args) -> int:
    from .bake import bake_scene
    from .check import any_failed, run_checks

    sky = _parse_sky(args)
    failed = False
    for sid in args.scene:
        print(f'== 自检 {sid} ==', flush=True)
        b = bake_scene(sid, work_w=args.work_w, spp=args.spp,
                       vol_density=args.vol_density, no_gi=args.no_gi,
                       sky=sky, progress=not args.quiet)
        results = run_checks(b)
        for r in results:
            print(f'  {r.cid:>2} {"绿" if r.ok else "红"}  {r.name}: {r.detail}', flush=True)
        if any_failed(results):
            failed = True
    return 1 if failed else 0


def cmd_report(args) -> int:
    from .bake import bake_scene, scene_payload_dir
    from .check import run_checks
    from .report import build_report

    sky = _parse_sky(args)
    for sid in args.scene:
        print(f'== 预览 {sid} ==', flush=True)
        b = bake_scene(sid, work_w=args.work_w, spp=args.spp,
                       vol_density=args.vol_density, no_gi=args.no_gi,
                       sky=sky, progress=not args.quiet)
        results = run_checks(b)
        out = scene_payload_dir(sid) / 'preview'
        out.mkdir(parents=True, exist_ok=True)
        html_path = out / 'report.html'
        html_path.write_text(build_report(b, results), encoding='utf-8')
        print(f'  写到 {html_path}', flush=True)
        if args.open:
            import webbrowser
            webbrowser.open(html_path.resolve().as_uri())
    return 0


def cmd_diff(args) -> int:
    from .input import scene_paths

    import numpy as np
    from PIL import Image

    for sid in args.scene:
        rt = scene_paths(sid)['rt_dir']
        a = rt / 'lighting3'
        b_dir = Path(args.against)
        if not b_dir.exists():
            print(f'{sid}: against 目录不存在 {b_dir}', flush=True)
            return 1
        print(f'== diff {sid} ==', flush=True)
        names = sorted({p.name for p in a.glob('*') if p.is_file()}
                       | {p.name for p in b_dir.glob('*') if p.is_file()})
        for name in names:
            fa, fb = a / name, b_dir / name
            if not fa.exists() or not fb.exists():
                print(f'  {name}: 仅单侧存在', flush=True)
                continue
            if name.endswith('.png'):
                ia = np.asarray(Image.open(fa).convert('RGBA'), np.float32)
                ib = np.asarray(Image.open(fb).convert('RGBA'), np.float32)
                same_shape = ia.shape == ib.shape
                md = float(np.abs(ia - ib).max()) if same_shape else float('nan')
                print(f'  {name}: 同形状={same_shape} 逐通道最大差={md:.3f}', flush=True)
            elif name.endswith('.bin'):
                ba, bb = fa.read_bytes(), fb.read_bytes()
                print(f'  {name}: 同长度={len(ba) == len(bb)}（{len(ba)} vs {len(bb)} 字节）', flush=True)
            elif name.endswith('.json'):
                da = json.loads(fa.read_text(encoding='utf-8'))
                db = json.loads(fb.read_text(encoding='utf-8'))
                ka, kb = set(da), set(db)
                print(f'  {name}: 键差 仅A={sorted(ka - kb)} 仅B={sorted(kb - ka)}', flush=True)
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog='tools.lightbake',
                                 description='独立光照 Baker：从场景输入产出光照载荷 + 自包含预览')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p_bake = sub.add_parser('bake', help='烘一个/全部场景，出 report + 自检')
    p_bake.add_argument('--scene', action='append', help='场景 id，可重复；缺省全烘')
    p_bake.add_argument('--all', action='store_true', help='全烘（默认，缺 --scene 时）')

    p_chk = sub.add_parser('check', help='只跑自检，不写盘')
    p_chk.add_argument('--scene', action='append', required=True)

    p_rep = sub.add_parser('report', help='只出预览')
    p_rep.add_argument('--scene', action='append', required=True)
    p_rep.add_argument('--open', action='store_true')

    p_diff = sub.add_parser('diff', help='两次产物逐项对比')
    p_diff.add_argument('--scene', action='append', required=True)
    p_diff.add_argument('--against', required=True)

    for p in (p_bake, p_chk, p_rep):
        p.add_argument('--spp', type=int, default=16)
        p.add_argument('--vol-density', type=int, default=3)
        p.add_argument('--no-gi', action='store_true')
        p.add_argument('--work-w', type=int, default=1024)
        p.add_argument('--sky', help='逃逸辐射：JSON 字符串 / .json 文件 / 图片路径')
        p.add_argument('--sky-color', metavar='R,G,B', help='纯色天空，线性 RGB')
        p.add_argument('--sky-intensity', type=float, default=None)
        p.add_argument('--quiet', action='store_true')

    args = ap.parse_args(argv)
    return {'bake': cmd_bake, 'check': cmd_check, 'report': cmd_report, 'diff': cmd_diff}[args.cmd](args)


if __name__ == '__main__':
    raise SystemExit(main())
