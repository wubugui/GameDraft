# -*- coding: utf-8 -*-
"""重做一张场景的深度(并把所有跟着深度走的东西一起重做)—— 一条命令走完,少一步就是静默错。

**不是另一个烘焙器**:每一步调的都是现役入口(`pipeline.py` / `art_review` / `seed_phase_payload` /
`scene_fields` / `sway_field`),产物照旧落 `runtime/scenes/<id>/`,本模块只负责**按顺序全部跑完**。
为什么要有它:深度一变,下面这些都要跟着重做,而且每一样漏了都**不报错**(2026-09-25 崖墓三张实测):

1. 作者碰撞多边形存的是网格点,几何一变就落到画面别处 → 重烘前 `pin-screen`、导出后 `reanchor`;
2. 时段原画(夜)的载荷还压着旧几何 → `seed_phase_payload(force=True)`;
3. 法线 / 天穹可见性 / albedo(`scene_fields`)与草木拆层(`sway_field`)都读运行时深度 → 重烘;
4. 最后出深度体检图(`art_review depthsheet`):塌平(朝向处处一个灰)直接报错退出。

用法::

    sh scripts/py.sh -m tools.character_lighting_lab.redo_depth <场景> [--calibration structure|level]
         [--skip sway,fields,...]

`--calibration` 不给 = 沿用这张图上次烘的(没烘过就是 level)。structure 要求地形工作台里已经圈好可走区
(见 `pipeline.stage_calibrate_structure`)。其余烘焙参数一律沿用上次 manifest 里的。
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

STEPS = ('pin', 'build', 'reanchor', 'phases', 'fields', 'sway', 'sheet')


def _run(cmd: list[str], label: str) -> None:
    env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8', 'PYTHONUNBUFFERED': '1'}
    print(f'\n===== {label}', flush=True)
    r = subprocess.run(cmd, cwd=ROOT, env=env)
    if r.returncode != 0:
        raise SystemExit(f'✗ {label} 失败(退出码 {r.returncode})—— 后面的步骤没跑,场景可能处在半新半旧的状态,修好后整条重跑')


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(prog='redo_depth', description='重做一张场景的深度 + 全部下游')
    ap.add_argument('scene')
    ap.add_argument('--calibration', choices=('level', 'structure'), default=None)
    ap.add_argument('--skip', default='', help=f'跳过的步骤,逗号分隔:{",".join(STEPS)}')
    a = ap.parse_args()
    skip = {s.strip() for s in a.skip.split(',') if s.strip()}
    bad = skip - set(STEPS)
    if bad:
        raise SystemExit(f'--skip 不认识:{sorted(bad)}(只有 {",".join(STEPS)})')

    from tools.character_lighting_lab import pipeline as pl
    from tools.character_lighting_lab import terrain_compose as tc
    from tools.character_lighting_lab.serve import REBUILD_KEYS
    sid = a.scene
    scene_json = ROOT / 'public' / 'assets' / 'scenes' / f'{sid}.json'
    if not scene_json.is_file():
        raise SystemExit(f'没有这个场景:{sid}')
    bg = pl.scene_background(sid)
    img = ROOT / 'public' / 'resources' / 'runtime' / 'scenes' / sid / bg
    if not img.is_file():
        raise SystemExit(f'{sid}: 主背景 {img} 不存在')
    py = sys.executable

    man_p = pl.work_dir(sid, bg) / 'manifest.json'
    old = json.loads(man_p.read_text(encoding='utf-8'))['params'] if man_p.exists() else {}
    calib = a.calibration or str(old.get('calibration', 'level'))
    has_regions = any(not (r.get('screen') or {}).get('generated')
                      for r in (tc.load_terrain(sid).get('regions') or []))
    if calib == 'structure' and not has_regions:
        raise SystemExit(f'{sid}: structure 标定要地形工作台里圈好的可走区,现在一块都没有 —— 先照原画圈碰撞')

    if 'pin' not in skip and has_regions and tc.load_terrain(sid).get('grid'):
        _run([py, '-m', 'tools.terrain_workbench.art_review', 'pin-screen', sid], 'pin-screen(钉住作者多边形的画面轮廓)')
    if 'build' not in skip:
        extra: list[str] = []
        for k, v in old.items():
            # structure 下俯角 / 起伏由拟合定;calibration 由本命令给
            if k in REBUILD_KEYS and k not in ('calibration',) and not (calib == 'structure' and k in ('pitch_deg', 'relief')):
                extra += [f'--{k}', str(v)]
        extra += ['--calibration', calib]
        _run([py, '-u', str(ROOT / 'tools' / 'character_lighting_lab' / 'pipeline.py'), str(img), '--name', sid,
              '--background', bg, *extra, '--export-runtime', '--export-depth'], f'烘焙 + 导出深度 / 光照({calib})')
    if 'reanchor' not in skip and has_regions:
        _run([py, '-m', 'tools.terrain_workbench.art_review', 'reanchor', sid], 'reanchor(作者多边形按画面轮廓落回新几何)')
    if 'phases' not in skip:
        for other in tc.scene_background_names(sid):
            if other == bg:
                continue
            _run([py, '-c', f'import sys; sys.path.insert(0, {str(ROOT)!r}); '
                            f'from tools.character_lighting_lab.pipeline import seed_phase_payload; '
                            f'print(seed_phase_payload({sid!r}, {other!r}, force=True))'],
                 f'时段原画 {other}:用新几何重新起手')
    if 'fields' not in skip:
        _run([py, '-m', 'tools.character_lighting_lab.scene_fields', '--scene', sid], '几何场(法线 / 天穹可见性 / albedo)')
    if 'sway' not in skip:
        _run([py, '-m', 'tools.character_lighting_lab.sway_field', '--scene', sid], '草木拆层')
    if 'sheet' not in skip and has_regions:
        from tools.terrain_workbench import art_review as ar
        stats = ar.cmd_depthsheet(sid, 800)
        if stats.get('collapsed'):
            raise SystemExit(f'✗ {sid}: 深度塌平了(朝向图处处一个灰)—— 看 {stats["out"]}')
    print(f'\n✓ {sid}: 深度与全部下游已重做(标定 {calib})', flush=True)


if __name__ == '__main__':
    main()
