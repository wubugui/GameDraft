# -*- coding: utf-8 -*-
"""碰撞 / 行走面作者层迁移（2026-09-14，地形工作台上线的一次性搬家）。

每个有 `depthConfig` 的场景：

1. `depthConfig.collision`（场景 JSON，git）→ `runtime/scenes/<id>/collision.json`（DVC，旁挂），
   场景 JSON 里那一块删掉。运行时先读旁挂，所以这一步对画面零变化。
2. 建作者层 `runtime/scenes/<id>/terrain/`：`collision_auto.png` = 现在的 `collision.png`
   （它已经含历史上的屏幕笔刷），`terrain.json` 记网格。合成 = 自动 ⊕（空）作者层 ⇒ 与现在**逐字节相同**。
3. 实验室 `out/<id>/<bg>/collision_edit.png`（屏幕空间笔刷，git 忽略、DVC 不管）→ `terrain/walk_brush.png`
   （世界 XZ 笔刷层），走运行时那条反投影链逐像素落格；源文件改名 `*.migrated.png`。
   这三张画的碰撞今天就靠它们定，不入库等于只存在一台机器上。
4. 各时段目录：`ground_base.png` = 现在的 `ground_d.png`（未修补基底），`lighting.json.ground_base` 记 min/max。

只搬不删（除了场景 JSON 里那一块 `collision`）；`--dry-run` 只打印；幂等。
迁移完自动用合成器重算一遍与磁盘上的 `collision.png` 比：不带笔刷的场景必须逐字节相同，
带笔刷的报出差异格数（笔刷经两条不同的投影链落格，差几个格是预期的）。

    sh scripts/py.sh tools/migrate_terrain_authoring.py --dry-run
    sh scripts/py.sh tools/migrate_terrain_authoring.py [--scene <id>]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.character_lighting_lab import terrain_compose as tc          # noqa: E402
from tools.character_lighting_lab.pipeline import work_dir               # noqa: E402
from tools.character_lighting_lab.scene_geometry import bake_key         # noqa: E402

SCENES_JSON = ROOT / 'public' / 'assets' / 'scenes'
SCENES_RT = ROOT / 'public' / 'resources' / 'runtime' / 'scenes'


def _write_scene_json(path: Path, data: dict) -> None:
    # 与编辑器 / 烘焙器同一种落盘格式(indent=2、ensure_ascii=False、末尾换行、LF)
    tc._awrite(path, (json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))


def _strokes_to_world_brush(sid: str, data: dict, cfg: dict, grid: tc.GridMeta, edit_png: Path) -> np.ndarray | None:
    """屏幕空间笔刷(work 分辨率,R: 1 可走 / 2 阻挡)→ 世界网格笔刷层。逐像素走运行时反投影链。"""
    from tools.character_lighting_lab import audit_walkable as aw
    e = np.asarray(Image.open(edit_png).convert('RGB'), np.uint8)[..., 0]
    h, w = e.shape
    ys, xs = np.nonzero(e > 0)
    if len(ys) == 0:
        return None
    g = aw._scene_geometry(sid, data, cfg)
    if isinstance(g, str):
        print(f'  ⚠ {sid}: 取不到几何({g}),笔刷层没法转')
        return None
    ground = aw._ground_sampler(sid)
    M = cfg['M']
    R = M['R']
    ppu, cx, cy = M['ppu'], M['cx'], M['cy']
    brush = np.zeros((grid.grid_height, grid.grid_width), np.uint8)
    n_ok = 0
    for py, px in zip(ys, xs):
        u, v = (px + 0.5) / w, (py + 0.5) / h
        d = ground(u, v)
        sx, sy = u * 2 * cx, v * 2 * cy
        qx, qy = (sx - cx) / ppu, (cy - sy) / ppu
        X = R[0][0] * qx + R[0][1] * qy + R[0][2] * d
        Z = R[2][0] * qx + R[2][1] * qy + R[2][2] * d
        gx, gz = grid.cell_of(np.array([X]), np.array([Z]))
        if not grid.inside(gx, gz)[0]:
            continue
        val = int(e[py, px])
        cur = brush[gz[0], gx[0]]
        if val == 2 or cur == 0:          # 阻挡压过可走
            brush[gz[0], gx[0]] = 2 if val == 2 else 1
        n_ok += 1
    print(f'  笔刷 {edit_png.name}: {len(ys)} 像素 → {int((brush > 0).sum())} 格(可走 {int((brush == 1).sum())} / 阻挡 {int((brush == 2).sum())})')
    return brush


def migrate_scene(sid: str, dry: bool) -> dict:
    sj = SCENES_JSON / f'{sid}.json'
    data = json.loads(sj.read_text(encoding='utf-8'))
    cfg = data.get('depthConfig')
    rt = SCENES_RT / sid
    if not cfg or not rt.is_dir():
        return {'sid': sid, 'skipped': '无 depthConfig / 运行时目录'}
    col_name = cfg.get('collision_map', 'collision.png')
    col_png = rt / col_name
    report: dict = {'sid': sid}
    # ---- 1. 网格声明 → 旁挂
    gm = tc.load_collision_meta(sid, cfg, rt)
    if gm is None or not col_png.exists():
        report['skipped'] = '没有碰撞网格 / collision.png'
        return report
    legacy = cfg.get('collision')
    if not (rt / tc.SIDECAR_FILE).exists():
        report['sidecar'] = 'new'
        if not dry:
            tc._awrite_json(rt / tc.SIDECAR_FILE, {'version': tc.SIDECAR_VERSION, 'collision_map': col_name,
                                                    **gm.to_dict(), 'composed': {'migrated_from': 'depthConfig.collision'}})
    if legacy is not None:
        report['scene_json'] = 'collision block removed'
        if not dry:
            del cfg['collision']
            _write_scene_json(sj, data)
    # ---- 2. 作者层
    doc = tc.load_terrain(sid)
    cur = tc.read_u8_png(col_png)
    if doc.get('auto') is None:
        report['auto'] = 'from current collision.png'
        if not dry:
            doc = tc.record_auto(sid, cur > 127, gm)
    if doc.get('grid') is None:
        doc['grid'] = gm.to_dict()
    # ---- 3. 实验室屏幕笔刷 → 世界笔刷层
    bgs = data.get('backgrounds') or []
    bg_name = (bgs[0].get('image') if bgs and isinstance(bgs[0], dict) else None) or 'background.png'
    try:
        wd = work_dir(sid, bg_name)
    except Exception:  # noqa: BLE001
        wd = None
    edit = wd / 'collision_edit.png' if wd else None
    if edit and edit.exists() and doc.get('brush') is None:
        brush = _strokes_to_world_brush(sid, data, cfg, gm, edit)
        if brush is not None:
            report['brush'] = int((brush > 0).sum())
            if not dry:
                tc.write_u8_png(tc.terrain_dir(sid) / tc.BRUSH_FILE, brush)
                doc['brush'] = {'file': tc.BRUSH_FILE, **gm.to_dict(), 'migrated_from': str(edit.relative_to(ROOT))}
                edit.rename(edit.with_name('collision_edit.migrated.png'))
    if not dry:
        tc.save_terrain(sid, doc)
    # ---- 4. 行走面基底
    n_base = 0
    for bd in tc.scene_bake_dirs(sid):
        if not (bd / tc.GROUND_BASE_FILE).exists():
            n_base += 1
            if not dry:
                tc.ensure_ground_base(bd)
    report['ground_base_new'] = n_base
    # ---- 校验:合成 == 磁盘
    if not dry:
        blocked, _src, _grid = tc.compose_collision(sid)
        composed = np.where(blocked, 255, 0).astype(np.uint8)
        if composed.shape == cur.shape:
            diff = int((composed != cur).sum())
            report['diff_cells'] = diff
        else:
            report['diff_cells'] = f'shape {composed.shape} vs {cur.shape}'
    return report


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(prog='migrate_terrain_authoring')
    ap.add_argument('--scene', help='只迁这一个场景;缺省全部')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    sids = [args.scene] if args.scene else sorted(p.stem for p in SCENES_JSON.glob('*.json'))
    for sid in sids:
        r = migrate_scene(sid, args.dry_run)
        print(json.dumps(r, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
