"""几何场烘焙:法线 / 天穹可见性(逐像素 + 3D 网格)/ 命中图。

**烘的全是几何项**——只依赖深度场与标定,与时刻、天气、灯全无关。
光怎么变都不用重烘(需求 R1 的落地形式)。产物落 `runtime/scenes/<id>/lighting2/`。

| 产物 | 内容 | 消费方 |
|---|---|---|
| `normal.png` | 场景法线 RGB8(xy 映射到 0..1,z 取 \\|z\\|) | 场景光照 pass |
| `skyvis.png` | 逐像素天穹可见性 R8 | 场景光照 pass |
| `skyvis_grid.bin` | **3D** 天穹可见性,`(nx,ny,nz)` f32 C 序 | 角色照明(三线性插值) |
| `meta.json` | 网格参数 / 世界 AABB / M / 标定 / background_sha1 / 版本 | 两者 |

3D 网格是角色"吃天光遮蔽"的落地(需求 R4):角色按自己的伪世界位置插值,
头脚高度差天然被网格表达,不需要"脚点采样 + 高度补偿"那种近似。
1680 个标量 = 6.7 KB,比现有 probe atlas 小两个数量级。
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.atomic_io import retry_transient                      # noqa: E402

from .geometry import Scene, resize_f                            # noqa: E402
from .relight import _SKY_AZIMS, _SKY_ELEVS, sun_dir             # noqa: E402

#: 载荷代次。改任何产物布局都要 +1,并同步 validate.py 与运行时消费端。
PAYLOAD_VERSION = 1

#: 烘焙工作分辨率(宽);天穹可见性是低频量,不需要原生分辨率。
WORK_W = 512

#: 角色带缺省不写死——由**角色真实世界高度**推出(见 character_band_wu)。
#: ⚠ 旧 probe 管线的 `probe_band=1.6` 建立在"1 wu = 1 m、角色高 1.5 wu"的假设上,
#:   而实测 1 wu ≈ 7.5–10 m、角色高 **0.17–0.23 wu**——旧值大了 6–8 倍,
#:   竖直分辨率因此几乎全浪费在角色够不着的空中。本模块不复制该错误。
DEFAULT_BAND = None

#: 角色高度的场景坐标缺省值(player_anim 的 worldHeight)
DEFAULT_CHAR_SCENE_H = 150.0

#: 3D 网格分辨率。载荷极小(f32 标量),竖直方向给足
DEFAULT_GRID = (24, 10, 16)


def _atomic_bytes(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.tmp')
    tmp.write_bytes(data)
    retry_transient(os.replace, tmp, dest)


def _march_blocked_from(q0: np.ndarray, dir_q: np.ndarray, depth: np.ndarray,
                        ppu: float, cx: float, cy: float,
                        steps: int, length: float,
                        bias0: float, thick: float) -> np.ndarray:
    """从**任意** q 空间起点沿 dir_q march 深度场,返回逐点 blocked 布尔。

    与 `relight._march_blocked` 同一套判据,区别只在起点:那个从每个像素自己的
    表面出发(逐像素),这个从空间中任意一批点出发(供 3D 网格用)。

    q0: (N,3) 起点;dir_q: (3,) 方向(已归一,q 空间);depth: (h,w) 深度场。
    """
    h, w = depth.shape
    step = length / max(steps, 1)
    blocked = np.zeros(len(q0), bool)
    for i in range(1, steps + 1):
        q = q0 + dir_q[None, :] * (step * i)
        px = q[:, 0] * ppu + cx
        py = cy - q[:, 1] * ppu
        inside = (px >= 0) & (px < w) & (py >= 0) & (py < h)
        xi = np.clip(px, 0, w - 1).astype(np.int32)
        yi = np.clip(py, 0, h - 1).astype(np.int32)
        pen = q[:, 2] - depth[yi, xi]
        bias = bias0 + 0.02 * step * i
        blocked |= inside & (pen > bias) & (pen < thick)
    return blocked


def character_band_wu(scene: Scene, char_scene_h: float = DEFAULT_CHAR_SCENE_H) -> dict:
    """角色的真实世界高度,以及据此推出的可达高度带。

    刻度链:场景坐标 --(native_w / worldWidth)--> 背景像素 --(1/ppu)--> 世界单位。
    实测雾津街头 1 wu ≈ 10 m、角色 0.170 wu;码头白天 1 wu ≈ 7.5 m、角色 0.227 wu。
    **建筑离地是角色的 6 倍左右,这是物理正确的(两层楼 vs 人)。**
    """
    data = json.loads(scene_json_path(scene).read_text(encoding='utf-8'))
    world_w = float(data.get('worldWidth') or 0.0)
    nw = scene.native[0]
    ppu = float(scene.cfg['ppu']) if scene.cfg else 0.0
    if world_w <= 0 or ppu <= 0:
        raise RuntimeError('缺 worldWidth 或 depthConfig.M.ppu,无法推角色刻度')
    scene_per_wu = world_w / (nw / ppu)          # 一个世界单位 = 多少场景坐标
    char_wu = char_scene_h / scene_per_wu
    return {
        'char_wu': char_wu,
        'scene_per_wu': scene_per_wu,
        'meters_per_wu': 1.7 / char_wu if char_wu > 0 else 0.0,
        'band': char_wu * 1.15,                  # 头顶留一点余量
    }


def scene_json_path(scene: Scene) -> Path:
    from .geometry import SCENES_JSON
    return SCENES_JSON / f'{scene.sid}.json'


def bake_skyvis_grid(geo: dict, grid: tuple[int, int, int], band: float) -> dict:
    """3D 天穹可见性网格。返回 {'data': (nx,ny,nz) f32, 'bounds': {...}}。

    判据与逐像素版 `sky_field` **同源**(同一组方向、同一套 march),
    这是"角色与场景吃同一个遮蔽场"的前半条保证。
    """
    nx, ny, nz = grid
    pos = geo['pos']
    R = geo['R']
    depth = geo['depth']
    ppu, cx, cy = geo['ppu'], geo['cx'], geo['cy']

    # 世界 AABB:x/z 取可见面的 1~99 分位(掐掉边缘外推的野值)
    px_ = pos[..., 0].ravel()
    py_ = pos[..., 1].ravel()
    pz_ = pos[..., 2].ravel()
    x0, x1 = np.percentile(px_, [1, 99])
    z0, z1 = np.percentile(pz_, [1, 99])
    # y:覆盖「最低地面 → 最高地面 + 角色带」。
    # ⚠ 地面本身的起伏(p2..p60)常常比角色还高,必须一并覆盖,否则远处地面上的角色
    #   会落到网格外被钳到边界层(旧 probe 系统踩过:远端角色有效插值权重为 0)。
    y0 = float(np.percentile(py_, 2)) - 0.02
    y1 = float(np.percentile(py_, 60)) + band
    y1 = max(y1, y0 + band * 1.5)

    gx = np.linspace(x0, x1, nx)
    gy = np.linspace(y0, y1, ny)
    gz = np.linspace(z0, z1, nz)
    X, Y, Z = np.meshgrid(gx, gy, gz, indexing='ij')
    world = np.stack([X.ravel(), Y.ravel(), Z.ravel()], -1).astype(np.float32)
    q = world @ R                      # world → q(R 正交 ⇒ 转置即逆)

    up_norm = 0.0
    acc = np.zeros(len(q), np.float32)
    for elev in _SKY_ELEVS:
        for azim in _SKY_AZIMS:
            d_w = sun_dir(elev, azim)
            d_q = (R.T @ d_w).astype(np.float32)
            blocked = _march_blocked_from(q, d_q, depth, ppu, cx, cy,
                                          steps=16, length=2.2, bias0=0.05, thick=2.0)
            # 网格点在空气中,没有自身法线 ⇒ 权重只用方向的向上分量(半球余弦)
            wgt = max(float(d_w[1]), 0.0)
            acc += (~blocked).astype(np.float32) * wgt
            up_norm += wgt
    vis = (acc / max(up_norm, 1e-6)).reshape(nx, ny, nz)
    return {
        'data': np.clip(vis, 0.0, 1.0).astype(np.float32),
        'bounds': {'x0': float(x0), 'x1': float(x1),
                   'y0': float(y0), 'y1': float(y1),
                   'z0': float(z0), 'z1': float(z1)},
    }


def bake(sid: str, grid: tuple[int, int, int] = DEFAULT_GRID,
         band: float | None = DEFAULT_BAND, work_w: int = WORK_W) -> dict:
    """烘一个场景的全部几何场。band 缺省由角色真实高度推出。"""
    from .relight import sky_field

    scene = Scene(sid)
    nw, nh = scene.native
    w = min(work_w, nw)
    h = max(1, round(nh * w / nw))
    geo = scene.geometry((w, h), normal_sigma=max(0.8, 0.8 * (w / 640.0)))
    if geo is None:
        raise RuntimeError(f'场景 {sid} 没有 depthConfig / 深度图,无法烘几何场')
    scale = character_band_wu(scene)
    if band is None:
        band = scale['band']

    out = scene.rt_dir / 'lighting2'

    # ---- 法线 ----
    n = geo['normal']
    nrm = np.zeros((h, w, 3), np.uint8)
    nrm[..., 0] = np.round((n[..., 0] * 0.5 + 0.5) * 255).astype(np.uint8)
    nrm[..., 1] = np.round((n[..., 1] * 0.5 + 0.5) * 255).astype(np.uint8)
    nrm[..., 2] = np.round(np.abs(n[..., 2]) * 255).astype(np.uint8)
    import io
    buf = io.BytesIO()
    Image.fromarray(nrm).save(buf, format='PNG', optimize=True)
    _atomic_bytes(out / 'normal.png', buf.getvalue())

    # ---- 逐像素天穹可见性 ----
    sky = sky_field(geo, w / 640.0)
    buf = io.BytesIO()
    Image.fromarray(np.round(np.clip(sky, 0, 1) * 255).astype(np.uint8), mode='L') \
        .save(buf, format='PNG', optimize=True)
    _atomic_bytes(out / 'skyvis.png', buf.getvalue())

    # ---- 3D 天穹可见性网格 ----
    g = bake_skyvis_grid(geo, grid, band)
    _atomic_bytes(out / 'skyvis_grid.bin', g['data'].tobytes())

    # ---- meta ----
    bg_sha1 = hashlib.sha1(scene_bg_bytes(scene)).hexdigest()[:12]
    meta = {
        'version': PAYLOAD_VERSION,
        'background_sha1': bg_sha1,
        'work': {'w': w, 'h': h},
        'native': {'w': nw, 'h': nh},
        'cal': {'ppu': geo['ppu'], 'cx': geo['cx'], 'cy': geo['cy']},
        'M': [[float(v) for v in row] for row in geo['R']],
        'grid': {'nx': grid[0], 'ny': grid[1], 'nz': grid[2], **g['bounds']},
        'band': band,
        # 刻度链:角色的真实世界高度。U11 的标定与角色带都靠它,别再假设 1 wu = 1 m。
        'scale': {'char_wu': scale['char_wu'], 'scene_per_wu': scale['scene_per_wu'],
                  'meters_per_wu': scale['meters_per_wu']},
        'sky_dirs': {'elevs': list(_SKY_ELEVS), 'azims': list(_SKY_AZIMS)},
        'depth_range': list(geo['d_range']),
    }
    _atomic_bytes(out / 'meta.json',
                  (json.dumps(meta, ensure_ascii=False, indent=1) + '\n').encode('utf-8'))

    return {
        'dest': str(out),
        'scale': scale,
        'band': band,
        'skyvis_px': {'min': float(sky.min()), 'max': float(sky.max()),
                      'mean': float(sky.mean())},
        'skyvis_grid': {'min': float(g['data'].min()), 'max': float(g['data'].max()),
                        'mean': float(g['data'].mean()),
                        'count': int(g['data'].size)},
        'bounds': g['bounds'],
        'bytes': sum(f.stat().st_size for f in out.iterdir() if f.is_file()),
    }


def scene_bg_bytes(scene: Scene) -> bytes:
    return (scene.rt_dir / scene.bg_name).read_bytes()


def main() -> None:
    import argparse
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(prog='scene_relight.bake')
    ap.add_argument('--scene')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--band', type=float, default=None,
                    help='角色可达高度带(wu)。缺省由角色真实高度推出,别手填 1.6')
    ap.add_argument('--work-w', type=int, default=WORK_W)
    args = ap.parse_args()

    from .geometry import list_scenes
    if args.all:
        sids = [s['id'] for s in list_scenes() if s['bg_ok'] and s['depth']]
    elif args.scene:
        sids = [args.scene]
    else:
        raise SystemExit('要 --scene <id> 还是 --all ?')

    for sid in sids:
        try:
            r = bake(sid, band=args.band, work_w=args.work_w)
        except Exception as e:                       # noqa: BLE001
            print(f'{sid}: 失败 {type(e).__name__}: {e}')
            continue
        px = r['skyvis_px']
        gr = r['skyvis_grid']
        sc = r['scale']
        print(f"{sid}: → lighting2/ ({r['bytes']/1024:.0f} KB)")
        print(f"   刻度 角色 {sc['char_wu']:.3f} wu(1 wu ≈ {sc['meters_per_wu']:.1f} m)"
              f"  角色带 {r['band']:.3f} wu")
        print(f"   逐像素天穹可见性 {px['min']:.2f}–{px['max']:.2f} 均 {px['mean']:.2f}"
              f"  网格 {gr['count']} 点 均 {gr['mean']:.2f}")


if __name__ == '__main__':
    main()
