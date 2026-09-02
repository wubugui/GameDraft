"""验 **baker 真正落盘的那些字节**,不是验一套复刻品。

制作人 2026-09-01:「你这些东西不是用 baker 直接跑出来的?那你另外写一套东西
就算验证对了有意义么?老子要验证的是 baker 的所有算法是正确的」——说得对。

所以本模块**只读产物**:

    lighting/<背景基名>/atlas_l2.bin      probe 图集(运行时真正查的那块)
    lighting/<背景基名>/skyvis.png        逐像素天穹遮蔽(场景 pass 真正采的那张)
    lighting/<背景基名>/lighting.json     probe 网格 / 世界盒 / M / 烘焙参数
    lighting/<背景基名>/geometry.json     天穹遮蔽的估计口径 + 哈希门

然后按**运行时着色器的口径**把它们重建出来,和参照比。参照用的是 baker 自己的
估计器(`estimators.gather_scene_e` / `sky_moments`)跑高 spp —— 同一个被积量、
同一个 tracer,只是样本多到噪声可以忽略。

## 为什么参照能复现出与烘焙同一个辐射场

`rebake_lighting` 把 **HDR 恢复参数与逃逸辐射规格**都写进了
`lighting.json.baked_params`(`hdr_method` / `hdr_pa` / `max_gain_ev` / `escape`)。
本模块照着它重建辐射场 —— 少了这一步就会拿另一个辐射场去比另一个 E,
数字看着像回事而其实两边根本不是一件事(第一版 parity 脚本就是这么错的:
它喂 `srgb_to_linear(原画)`,而烘焙喂的是 `stage_hdr` 恢复后的场)。

## 不做什么

不重新烘焙、不写任何文件。要改进烘焙结果请去跑 `rebake_lighting`,
本模块只回答「盘上这份对不对」。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

from .escape import make_escape_sampler
from .estimators import (gather_scene_e, probe_eval_bins, probe_eval_sh,
                         sky_moments, sky_vis_of_normal)
from .scene_geometry import Scene, resize_rgb, surface_points_q
from .trace import DepthField

__all__ = ['load_payload', 'verify_skyao', 'verify_probe', 'main']

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)
SCENES_RT = Path(__file__).resolve().parents[2] / 'public' / 'resources' / 'runtime' / 'scenes'


class _Layout:
    """`probe_reconstruct` 要的最小 layout —— 全部字段直接来自 `lighting.json`。"""

    def __init__(self, man: dict):
        p = man['probes']
        self.grid = (int(p['nx']), int(p['ny']), int(p['nz']))
        w = man['world']
        self.bounds = {k: float(w[k]) for k in ('x0', 'x1', 'y0', 'y1', 'z0', 'z1')}


def load_payload(sid: str, background: str | None = None) -> dict:
    """读盘。**一个字节都不重算。**"""
    from .scene_geometry import bake_key, scene_paths
    bg = background or scene_paths(sid)['bg_name']
    d = SCENES_RT / sid / 'lighting' / bake_key(bg)
    man = json.loads((d / 'lighting.json').read_text(encoding='utf-8'))
    geom = json.loads((d / 'geometry.json').read_text(encoding='utf-8'))
    P = man['probes']
    n = P['nx'] * P['ny'] * P['nz']
    out = {'dir': d, 'bg': bg, 'lighting': man, 'geometry': geom, 'n_probes': n,
           'layout': _Layout(man)}
    # 'l2' 槽的列数按阶数:老载荷没记 sh_k 就是 9(L2),新载荷 L4=25
    # 'bin' 槽的列数按 bin_ob(8→64 / 16→256);老载荷没记就是 8
    for stem, K in (('l1', 4), ('l2', int(P.get('sh_k', 9))),
                    ('bin', int(P.get('bin_ob', 8)) ** 2)):
        f = d / f'atlas_{stem}.bin'
        if f.exists():
            out[f'atlas_{stem}'] = np.frombuffer(f.read_bytes(), np.float16
                                                 ).reshape(n, K, 4)[:, :, :3].astype(np.float32)
    out['valid'] = (np.frombuffer((d / 'probes_valid.bin').read_bytes(), np.uint8) > 128
                    ).astype(np.float32)
    out['skyvis'] = np.asarray(Image.open(d / 'skyvis.png').convert('L'), np.float32) / 255.0
    return out


def _geo_for(sid: str, pay: dict):
    """按载荷记录的工作分辨率重建几何 —— 与烘焙那次逐字同源。"""
    sc = Scene(sid, background=pay['bg'])
    w, h = int(pay['lighting']['work']['w']), int(pay['lighting']['work']['h'])
    geo = sc.geometry((w, h), normal_sigma=max(0.8, 0.8 * (w / 640.0)))
    if geo is None:
        raise RuntimeError(f'{sid} 没有 depthConfig / 深度图')
    return sc, geo


def _radiance_like_bake(sc: Scene, pay: dict, geo: dict) -> np.ndarray:
    """把烘焙那次用的辐射场**原样**重建,并用哈希证明它真的一样。

    走 `pipeline.build_radiance_field` —— 与烘焙**同一个函数**,不是"照着写一遍"。
    再对 `baked_params.radiance_sha1` 做逐位比对:对不上就直接拒绝比较,
    因为那时候「参照 E」与「盘上的 E」根本不是同一个输入的产物,
    比出来的任何数字都无意义(制作人 2026-09-01 点名的就是这件事)。
    """
    from . import pipeline as PL
    h, w = geo['depth'].shape
    P = dict(PL.DEFAULTS)
    P.update({k: v for k, v in (pay['lighting'].get('baked_params') or {}).items()
              if k in PL.DEFAULTS and k not in ('escape', 'probe_dims')})
    rad = PL.build_radiance_field(pay['dir'].parent.parent / pay['bg'], (w, h), P)['base']
    want = (pay['lighting'].get('baked_params') or {}).get('radiance_sha1')
    got = PL.radiance_sha1(rad)
    if want is None:
        print(f'  ⚠ 载荷里没有 radiance_sha1(烘焙于 2026-09-01 加哈希之前)——'
              f'无法证明输入对齐,本次比较仅供参考。复算得 {got}')
    elif want != got:
        raise RuntimeError(
            f'辐射场对不上:载荷记的 {want},复算得 {got}。\n'
            f'参照与盘上的 E 不是同一个输入的产物,比较无意义 —— '
            f'先确认 baked_params 的 HDR 参数与背景图没被改过,或重跑 rebake_lighting。')
    else:
        print(f'  辐射场哈希对齐 ✓ {got}')
    return rad


def _trilinear(vals: np.ndarray, grid: tuple, bounds: dict,
               world_pts: np.ndarray) -> np.ndarray:
    """规则网格上的三线性 —— 与着色器 `probeE` 的权重/索引口径逐条一致。

    `vals` 形状 (nx*ny*nz, ...);返回 (n, ...)。
    """
    nx, ny, nz = grid
    wmin = np.array([bounds['x0'], bounds['y0'], bounds['z0']], np.float32)
    wsc = np.array([(nx - 1) / max(bounds['x1'] - bounds['x0'], 1e-5),
                    (ny - 1) / max(bounds['y1'] - bounds['y0'], 1e-5),
                    (nz - 1) / max(bounds['z1'] - bounds['z0'], 1e-5)], np.float32)
    pn = np.array([nx, ny, nz], np.int32)
    t = np.clip((world_pts - wmin) * wsc, 0.0, pn - 1.001)
    b0 = t.astype(np.int32)
    f = t - b0
    out = np.zeros((len(world_pts), *vals.shape[1:]), np.float64)
    for c in range(8):
        off = np.array([c & 1, (c >> 1) & 1, (c >> 2) & 1], np.int32)
        pi = np.minimum(b0 + off, pn - 1)
        w = (np.where(off[0], f[:, 0], 1 - f[:, 0])
             * np.where(off[1], f[:, 1], 1 - f[:, 1])
             * np.where(off[2], f[:, 2], 1 - f[:, 2]))
        fl = pi[:, 0] * (ny * nz) + pi[:, 1] * nz + pi[:, 2]
        v = vals[fl]
        out += v * (w.reshape(w.shape + (1,) * (v.ndim - 1)))
    return out


def verify_skyao_volume(sid: str, background: str | None = None, spp: int = 512,
                        pay: dict | None = None) -> dict:
    """**体积** skyao 的 parity —— 与 E 那张同构,验的是盘上的 `skyao_probe.bin`。

        ref   逐像素:表面点上估遮蔽矩,按该像素**自己的法线**求值
        probe 盘上的 skyao_probe.bin 三线性插到像素位置,再按同一法线求值

    第三条 `legacy` 是旧的 `skyvis_grid.bin`(每格 1 个标量 T(up)):按任意法线求值
    做不到,只能把每个点当「朝上的板」。留着它是为了把**形式**的锅和**密度**的锅
    分开 —— 同样的格数下矩明显好,就说明问题出在标量存不下方向性。
    """
    from .probe_layout import grid_points
    pay = pay or load_payload(sid, background)
    sc, geo = _geo_for(sid, pay)
    h, w = geo['depth'].shape
    R, N = geo['R'], geo['normal']
    field = DepthField.from_geo(geo)

    a0r, a1r = sky_moments(surface_points_q(geo), R, field, spp=spp)
    ref = sky_vis_of_normal(a0r.reshape(h, w), a1r.reshape(h, w, 3), N)

    sp = pay['geometry']['skyao_probe']
    grid = (int(sp['nx']), int(sp['ny']), int(sp['nz']))
    bnds = {k: float(sp[k]) for k in ('x0', 'x1', 'y0', 'y1', 'z0', 'z1')}
    atlas = np.frombuffer((pay['dir'] / 'skyao_probe.bin').read_bytes(), np.float16)
    atlas = atlas.reshape(int(sp['atlas_h']), int(sp['atlas_w']), 4).astype(np.float32)
    # 反平铺:(atlas_h, atlas_w, 4) -> (nx, ny, nz, 4)
    nx, ny, nz = grid
    tx_, ty_ = int(sp['tiles_x']), int(sp['tiles_y'])
    mom = np.zeros((nx, ny, nz, 4), np.float32)
    for z in range(nz):
        ty, tx = divmod(z, tx_)
        mom[:, :, z, :] = atlas[ty * ny:(ty + 1) * ny, tx * nx:(tx + 1) * nx].transpose(1, 0, 2)
    flat = mom.reshape(-1, 4)

    wpts = geo['pos'].reshape(-1, 3).astype(np.float32)
    m = _trilinear(flat, grid, bnds, wpts).astype(np.float32)
    got = sky_vis_of_normal(m[:, 0].reshape(h, w), m[:, 1:].reshape(h, w, 3), N)

    # 旧标量场(现行 skyvis_grid.bin)作对照
    scal = np.frombuffer((pay['dir'] / 'skyvis_grid.bin').read_bytes(), np.float32)
    legacy = None
    if scal.size == nx * ny * nz:
        legacy = np.clip(_trilinear(scal.copy(), grid, bnds, wpts), 0, 1
                         ).astype(np.float32).reshape(h, w)

    inbox = np.ones(len(wpts), bool)
    for i2, (lo, hi) in enumerate((('x0', 'x1'), ('y0', 'y1'), ('z0', 'z1'))):
        inbox &= (wpts[:, i2] >= bnds[lo]) & (wpts[:, i2] <= bnds[hi])
    inbox = inbox.reshape(h, w)
    vert, up = np.abs(N[..., 1]) < 0.25, N[..., 1] > 0.85
    d = got - ref
    out = {'ref': ref, 'got': got, 'legacy': legacy, 'diff': d, 'inbox': inbox,
           'grid': f'{nx}x{ny}x{nz}', 'cells': nx * ny * nz, 'spp': spp,
           'cell_wu': sp.get('cell_wu'), 'inbox_frac': float(inbox.mean()),
           'bias': float(d[inbox].mean()), 'abs': float(np.abs(d)[inbox].mean()),
           'abs_vert': float(np.abs(d)[vert & inbox].mean()) if (vert & inbox).any() else float('nan'),
           'abs_up': float(np.abs(d)[up & inbox].mean()) if (up & inbox).any() else float('nan')}
    if legacy is not None:
        dl = legacy - ref
        out['legacy_abs'] = float(np.abs(dl)[inbox].mean())
        out['legacy_bias'] = float(dl[inbox].mean())
        out['legacy_diff'] = dl
    return out


def verify_skyao(sid: str, background: str | None = None, spp: int = 1024,
                 pay: dict | None = None) -> dict:
    """`skyvis.png`(盘上的)vs 同一估计器高 spp 的参照。

    ⚠ **这一条两边都是逐像素的**,只验逐像素估计器的噪声水平,
    **与体积无关**。要验体积(角色实际查的那个)看 `verify_skyao_volume`。
    """
    pay = pay or load_payload(sid, background)
    sc, geo = _geo_for(sid, pay)
    h, w = geo['depth'].shape
    got = pay['skyvis']
    if got.shape != (h, w):
        raise RuntimeError(f'skyvis.png {got.shape[::-1]} 与载荷记录的工作分辨率 {(w, h)} 不符')
    a0, a1 = sky_moments(surface_points_q(geo), geo['R'], DepthField.from_geo(geo), spp=spp)
    ref = sky_vis_of_normal(a0.reshape(h, w), a1.reshape(h, w, 3), geo['normal'])
    N = geo['normal']
    vert, up = np.abs(N[..., 1]) < 0.25, N[..., 1] > 0.85
    d = got - ref
    return {'ref': ref, 'got': got, 'diff': d, 'normal': N, 'spp': spp,
            'bias': float(d.mean()), 'abs': float(np.abs(d).mean()),
            'abs_vert': float(np.abs(d)[vert].mean()), 'abs_up': float(np.abs(d)[up].mean()),
            'quant': 1.0 / 255,
            'sampling': pay['geometry'].get('sky_sampling')}


def verify_probe(sid: str, background: str | None = None, spp: int = 512,
                 basis: str = 'l2', pay: dict | None = None,
                 ref_cache: dict | None = None) -> dict:
    """`atlas_*.bin`(盘上的)vs 逐像素参照 E。

    参照的辐射场与逃逸辐射都按 `baked_params` 重建 —— 两边必须是同一件事。

    `ref_cache`:扫 probe 密度时,参照 E **与 probe 密度无关**,算一次就够。
    传 `{'sha': 辐射场哈希, 'ref': (h,w,3)}` 复用;哈希对不上一律重算 ——
    缓存不许成为"拿旧参照比新载荷"的暗门。
    """
    from .parity import probe_reconstruct
    pay = pay or load_payload(sid, background)
    sc, geo = _geo_for(sid, pay)
    h, w = geo['depth'].shape
    rad = _radiance_like_bake(sc, pay, geo)
    esc_spec = (pay['lighting'].get('baked_params') or {}).get('escape')
    esc = make_escape_sampler(esc_spec)
    R = geo['R']
    n_q = (geo['normal'].reshape(-1, 3) @ R).astype(np.float32)
    n_q /= np.maximum(np.linalg.norm(n_q, axis=1, keepdims=True), 1e-9)
    from . import pipeline as PL
    rad_sha = PL.radiance_sha1(rad)
    # 参照与烘焙同一套降方差配置:NEE 按同一张辐射场建表(判据同 bake),
    # clamp 跟 baked_params(有偏项必须两侧同钳,否则 parity 比的是两种偏差)。
    bp = pay['lighting'].get('baked_params') or {}
    _cl = bp.get('probe_clamp')
    _cl = float(_cl) if _cl is not None else None
    from .nee import build_nee
    dfield = DepthField.from_geo(geo)
    nee_ctx = (build_nee(np.asarray(rad, np.float32), dfield,
                         threshold=float(bp.get('probe_nee_threshold', 1.0)))
               if bool(bp.get('probe_nee', True)) else None)
    ckey = (rad_sha, spp, _cl, nee_ctx is not None)
    if ref_cache is not None and ref_cache.get('key') == ckey and ref_cache.get('ref') is not None:
        ref = ref_cache['ref']
        print(f'  参照 E:复用缓存(辐射场哈希 {rad_sha} 一致)')
    else:
        ref = gather_scene_e(surface_points_q(geo), n_q, R, dfield,
                             rad, esc, spp,
                             nee_ctx=nee_ctx, clamp=_cl,
                             fold_escape=bool(bp.get('probe_fold_escape', False))
                             ).reshape(h, w, 3)
        if ref_cache is not None:
            ref_cache.update({'key': ckey, 'ref': ref})

    # ⚠ probe 用的是**实验室 det=-1 的 M**(lighting.json.world.M),与
    #   depthConfig 的 det=+1 不是一个矩阵。世界位置要用它那套反推。
    M = np.asarray(pay['lighting']['world']['M'], np.float32)
    n_probe = np.ascontiguousarray((geo['normal'].reshape(-1, 3) @ R).astype(np.float32))
    n_probe /= np.maximum(np.linalg.norm(n_probe, axis=1, keepdims=True), 1e-9)
    # 查询点沿法线偏移(与着色器 probeE 同一常量,见 parity.query_bias_wu)
    from .parity import query_bias_wu
    q = surface_points_q(geo) + n_probe * query_bias_wu(pay['layout'])
    wpts = np.ascontiguousarray(q @ M.T, np.float32)
    lay = pay['layout']
    got = probe_reconstruct(lay, pay[f'atlas_{basis}'], pay['valid'],
                            wpts, n_probe, 'bins' if basis.startswith('bin') else basis
                            ).reshape(h, w, 3)

    b = lay.bounds
    inbox = np.ones(len(wpts), bool)
    for i, (lo, hi) in enumerate((('x0', 'x1'), ('y0', 'y1'), ('z0', 'z1'))):
        inbox &= (wpts[:, i] >= b[lo]) & (wpts[:, i] <= b[hi])
    inbox = inbox.reshape(h, w)
    lr, lg = ref @ LUMA, got @ LUMA
    m = inbox & (lr > np.percentile(lr[inbox], 2)) if inbox.any() else np.zeros_like(inbox)
    ratio = np.where(m, lg / np.maximum(lr, 1e-9), np.nan)
    fin = ratio[np.isfinite(ratio)]
    return {'ref': ref, 'got': got, 'ratio': ratio, 'inbox': inbox, 'mask': m,
            'basis': basis, 'spp': spp, 'escape': esc_spec,
            'grid': 'x'.join(str(v) for v in lay.grid),
            'rad_range': (float(rad.min()), float(rad.max())),
            'inbox_frac': float(inbox.mean()),
            'ratio_p50': float(np.median(fin)) if fin.size else float('nan'),
            'med_dev': float(np.median(np.abs(fin - 1))) if fin.size else float('nan'),
            'p95_dev': float(np.percentile(np.abs(fin - 1), 95)) if fin.size else float('nan')}


def _plt():
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    plt.rcParams['font.sans-serif'] = ['Microsoft YaHei', 'SimHei', 'DejaVu Sans']
    plt.rcParams['axes.unicode_minus'] = False
    return plt


def fig_skyao_volume(sid: str, v: dict, out: Path) -> None:
    """场景直接吃 skyao probe 的着色 vs 逐像素 ref。灰度(标量场,不上色板)。"""
    plt = _plt()
    has_leg = v.get('legacy') is not None
    cols = 4 if has_leg else 3
    fig, ax = plt.subplots(1, cols, figsize=(5.4 * cols, 4.2), constrained_layout=True)
    for a in ax:
        a.set_xticks([])
        a.set_yticks([])
    im = ax[0].imshow(v['ref'], cmap='gray', vmin=0, vmax=1)
    ax[0].set_title('ref:逐像素({}spp)\n均 {:.4f}'.format(v['spp'], v['ref'].mean()), fontsize=10)
    fig.colorbar(im, ax=ax[0], fraction=.04)
    ax[1].imshow(v['got'], cmap='gray', vmin=0, vmax=1)
    ax[1].set_title('盘上 skyao_probe.bin 三线性重建\n{} = {:,} 格 x4   均 {:.4f}'
                    .format(v['grid'], v['cells'], v['got'].mean()), fontsize=10)
    im = ax[2].imshow(v['diff'], cmap='RdBu_r', vmin=-0.2, vmax=0.2)
    ax[2].set_title('probe − ref   偏置 {:+.4f}  |·|均 {:.4f}\n竖直面 {:.4f}  朝上面 {:.4f}   盒内 {:.0f}%'
                    .format(v['bias'], v['abs'], v['abs_vert'], v['abs_up'],
                            v['inbox_frac'] * 100), fontsize=10)
    fig.colorbar(im, ax=ax[2], fraction=.04)
    if has_leg:
        im = ax[3].imshow(v['legacy_diff'], cmap='RdBu_r', vmin=-0.2, vmax=0.2)
        ax[3].set_title('旧 skyvis_grid.bin(每格 1 个标量)− ref\n偏置 {:+.4f}  |·|均 {:.4f}'
                        '   —— 按任意法线求值做不到'
                        .format(v['legacy_bias'], v['legacy_abs']), fontsize=10)
        fig.colorbar(im, ax=ax[3], fraction=.04)
    fig.suptitle('{} —— 场景直接吃 skyao probe 着色 vs 逐像素 ref(全部读盘)'.format(sid),
                 fontsize=11)
    fig.savefig(out, dpi=110)
    plt.close(fig)


def _fig_skyao(sid: str, sk: dict, out: Path) -> None:
    """skyao 是 [0,1] 标量 —— **灰度**,不上色板。"""
    plt = _plt()
    fig, ax = plt.subplots(1, 3, figsize=(16.5, 3.8), constrained_layout=True)
    for a in ax:
        a.set_xticks([]); a.set_yticks([])
    for j, (img, t) in enumerate((
            (sk['got'], f'盘上的 skyvis.png\n均 {sk["got"].mean():.4f}'),
            (sk['ref'], f'参照:baker 自己的估计器 {sk["spp"]}spp\n均 {sk["ref"].mean():.4f}'))):
        im = ax[j].imshow(img, cmap='gray', vmin=0, vmax=1)
        ax[j].set_title(t, fontsize=10); fig.colorbar(im, ax=ax[j], fraction=.03)
    im = ax[2].imshow(sk['diff'], cmap='RdBu_r', vmin=-0.08, vmax=0.08)
    ax[2].set_title(f'盘上 − 参照   偏置 {sk["bias"]:+.4f}  |·|均 {sk["abs"]:.4f}\n'
                    f'竖直面 {sk["abs_vert"]:.4f}  朝上面 {sk["abs_up"]:.4f}'
                    f'  (8bit 量化下限 {sk["quant"]:.4f})', fontsize=10)
    fig.colorbar(im, ax=ax[2], fraction=.03)
    fig.suptitle(f'{sid} skyao —— 验的是 baker 落盘的 skyvis.png', fontsize=11)
    fig.savefig(out, dpi=110)


def _fig_e(sid: str, pr: dict, out: Path) -> None:
    """E 是 RGB 辐照度 —— 彩色。上排看强度,下排把**色度放大 4 倍**看色相有没有偏。"""
    plt = _plt()
    m = pr['mask']
    key = float(np.median((pr['ref'] @ LUMA)[m])) if m.any() else 1.0

    def tm(e, boost=1.0):
        x = e * (0.18 / max(key, 1e-9))
        if boost != 1.0:                       # 亮度不动,只把色度绕中性放大
            lum = np.maximum(x @ LUMA, 1e-9)[..., None]
            x = lum * np.clip(1.0 + (x / lum - 1.0) * boost, 0, None)
        return np.clip(x, 0, 1) ** (1 / 2.2)

    fig, ax = plt.subplots(2, 3, figsize=(16.5, 7.2), constrained_layout=True)
    for a in ax.ravel():
        a.set_xticks([]); a.set_yticks([])
    ax[0, 0].imshow(tm(pr['ref']))
    ax[0, 0].set_title(f'参照 E:逐像素 gather（{pr["spp"]}spp）', fontsize=10)
    ax[0, 1].imshow(tm(pr['got']))
    ax[0, 1].set_title(f'盘上的 atlas_{pr["basis"]}.bin 重建 E\n（按运行时着色器 probeE 的口径）',
                       fontsize=10)
    im = ax[0, 2].imshow(pr['ratio'], cmap='RdBu_r', vmin=0.6, vmax=1.4)
    ax[0, 2].set_title(f'盘上 / 参照 亮度比  中位 {pr["ratio_p50"]:.3f}\n'
                       f'典型差 {pr["med_dev"]:.3f}  p95 {pr["p95_dev"]:.3f}'
                       f'  盒内 {pr["inbox_frac"]*100:.0f}%', fontsize=10)
    fig.colorbar(im, ax=ax[0, 2], fraction=.03)
    ax[1, 0].imshow(tm(pr['ref'], 4.0)); ax[1, 0].set_title('参照 E　色度 x4（亮度不动）', fontsize=10)
    ax[1, 1].imshow(tm(pr['got'], 4.0)); ax[1, 1].set_title('盘上 E　色度 x4 —— 与左图比色相', fontsize=10)
    lr, lg = pr['ref'] @ LUMA, pr['got'] @ LUMA
    cr = pr['ref'][m] / np.maximum(lr[m][:, None], 1e-9)
    cg = pr['got'][m] / np.maximum(lg[m][:, None], 1e-9)
    cd = np.abs(cg - cr).max(1)
    ax[1, 2].remove()
    axh = fig.add_subplot(2, 3, 6)
    fin = pr['ratio'][np.isfinite(pr['ratio'])]
    axh.hist(np.clip(fin, 0.3, 2.0), bins=90, color='#48c', alpha=.85)
    axh.axvline(1.0, color='k', lw=1.2)
    axh.set_xlabel('盘上 / 参照 亮度比'); axh.set_ylabel('像素数'); axh.grid(alpha=.3)
    axh.set_title(f'比值分布  中位 {np.median(fin):.3f}\n'
                  f'色度差中位 {np.median(cd):.4f}  p95 {np.percentile(cd, 95):.4f}', fontsize=10)
    fig.suptitle(f'{sid} E —— 验的是 baker 落盘的 atlas_{pr["basis"]}.bin　'
                 f'probe {pr["grid"]}　逃逸辐射={pr["escape"]}', fontsize=11)
    fig.savefig(out, dpi=110)


def fig_both(sid: str, sk: dict, pr: dict, out: Path) -> None:
    """一个背景一张图:上排 skyao(灰度),下排 E(彩色)。左=参照,中=盘上,右=差异。

    skyao 与 E 放在同一张里是**刻意**的:它们吃同一份深度、同一个 tracer,
    一张图能一眼看出「是这个场景的几何有问题」还是「只是某一侧的算法有问题」。
    """
    plt = _plt()
    fig, ax = plt.subplots(2, 3, figsize=(15.5, 6.6), constrained_layout=True)
    for a in ax.ravel():
        a.set_xticks([]); a.set_yticks([])
    im = ax[0, 0].imshow(sk['ref'], cmap='gray', vmin=0, vmax=1)
    ax[0, 0].set_title(f'skyao 参照({sk["spp"]}spp)  均 {sk["ref"].mean():.4f}', fontsize=9)
    ax[0, 1].imshow(sk['got'], cmap='gray', vmin=0, vmax=1)
    ax[0, 1].set_title(f'skyao 盘上 skyvis.png  均 {sk["got"].mean():.4f}', fontsize=9)
    im2 = ax[0, 2].imshow(sk['diff'], cmap='RdBu_r', vmin=-0.08, vmax=0.08)
    ax[0, 2].set_title(f'盘上 − 参照  偏置 {sk["bias"]:+.4f}  |·| {sk["abs"]:.4f}', fontsize=9)
    fig.colorbar(im2, ax=ax[0, 2], fraction=.03)

    m = pr['mask']
    key = float(np.median((pr['ref'] @ LUMA)[m])) if m.any() else 1.0

    def tm(e):
        return np.clip(e * (0.18 / max(key, 1e-9)), 0, 1) ** (1 / 2.2)

    ax[1, 0].imshow(tm(pr['ref']))
    ax[1, 0].set_title(f'E 参照:逐像素 gather({pr["spp"]}spp)', fontsize=9)
    ax[1, 1].imshow(tm(pr['got']))
    ax[1, 1].set_title(f'E 盘上 atlas_{pr["basis"]}.bin 重建', fontsize=9)
    im3 = ax[1, 2].imshow(pr['ratio'], cmap='RdBu_r', vmin=0.6, vmax=1.4)
    ax[1, 2].set_title(f'盘上/参照  中位 {pr["ratio_p50"]:.3f}  典型差 {pr["med_dev"]:.3f}'
                       f'  p95 {pr["p95_dev"]:.3f}', fontsize=9)
    fig.colorbar(im3, ax=ax[1, 2], fraction=.03)
    fig.suptitle(f'{sid}　probe {pr["grid"]} = {pr.get("n_probes", "?")} 颗　'
                 f'逃逸辐射={pr["escape"]}　—— 全部是 baker 落盘的字节', fontsize=10)
    fig.savefig(out, dpi=100)
    plt.close(fig)


def main() -> None:
    import argparse
    import sys
    for st in (sys.stdout, sys.stderr):
        if hasattr(st, 'reconfigure'):
            st.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(prog='character_lighting_lab.verify',
                                 description='验 baker 落盘的产物(只读,不重烘)')
    ap.add_argument('--scene', required=True)
    ap.add_argument('--background')
    ap.add_argument('--sky-spp', type=int, default=1024)
    ap.add_argument('--probe-spp', type=int, default=512)
    ap.add_argument('--basis', default='l2', choices=('l1', 'l2', 'bin'))
    ap.add_argument('--fig', help='对照图落点前缀:出 <前缀>_skyao.png 与 <前缀>_e.png')
    ap.add_argument('--skyao-volume', dest='skyao_volume',
                    help='场景直接吃 skyao probe 的对照图落点(只出这张就退出)')
    a = ap.parse_args()

    pay = load_payload(a.scene, a.background)
    if a.skyao_volume:
        v = verify_skyao_volume(a.scene, a.background, a.probe_spp, pay=pay)
        fig_skyao_volume(a.scene, v, Path(a.skyao_volume))
        print('[skyao 体积] {} = {:,} 格   偏置 {:+.4f}  |误差|均 {:.4f}  '
              '竖直面 {:.4f}  朝上面 {:.4f}'.format(
                  v['grid'], v['cells'], v['bias'], v['abs'], v['abs_vert'], v['abs_up']))
        if 'legacy_abs' in v:
            print('[旧标量场]   偏置 {:+.4f}  |误差|均 {:.4f}'.format(
                v['legacy_bias'], v['legacy_abs']))
        print('图 -> ' + a.skyao_volume)
        return
    if a.skyao_volume:
        v = verify_skyao_volume(a.scene, a.background, a.probe_spp, pay=pay)
        fig_skyao_volume(a.scene, v, Path(a.skyao_volume))
        print(f'[skyao 体积] {v["grid"]} = {v["cells"]:,} 格   '
              f'偏置 {v["bias"]:+.4f}  |误差|均 {v["abs"]:.4f}  '
              f'竖直面 {v["abs_vert"]:.4f}  朝上面 {v["abs_up"]:.4f}')
        if 'legacy_abs' in v:
            print(f'[旧标量场]  偏置 {v["legacy_bias"]:+.4f}  |误差|均 {v["legacy_abs"]:.4f}')
        print(f'图 -> {a.skyao_volume}')
        return
    print(f'载荷 {pay["dir"]}')
    print(f'  probe {pay["lighting"]["probes"]}  = {pay["n_probes"]} 颗'
          f'  built {pay["lighting"].get("built")}')
    bp = pay['lighting'].get('baked_params') or {}
    print(f'  逃逸辐射 {bp.get("escape")}  HDR 恢复 method={bp.get("hdr_method")} '
          f'pa={bp.get("hdr_pa")} maxEV={bp.get("max_gain_ev")}')
    print(f'  天穹遮蔽口径 {pay["geometry"].get("sky_sampling")}')

    sk = verify_skyao(a.scene, a.background, a.sky_spp, pay=pay)
    print(f'\n[skyao] skyvis.png vs 参照({a.sky_spp}spp)')
    print(f'  偏置 {sk["bias"]:+.5f}   |误差|均 {sk["abs"]:.5f}'
          f'   竖直面 {sk["abs_vert"]:.5f}   朝上面 {sk["abs_up"]:.5f}')
    print(f'  8bit PNG 的量化下限是 {sk["quant"]:.5f} —— 误差贴着它就说明只剩量化')

    pr = verify_probe(a.scene, a.background, a.probe_spp, a.basis, pay=pay)
    print(f'\n[probe] atlas_{a.basis}.bin vs 参照({a.probe_spp}spp)')
    print(f'  辐射场范围 {pr["rad_range"][0]:.4f}~{pr["rad_range"][1]:.2f}'
          f'   盒内像素 {pr["inbox_frac"]*100:.0f}%')
    print(f'  亮度比中位 {pr["ratio_p50"]:.4f}   典型差 {pr["med_dev"]:.4f}'
          f'   p95 {pr["p95_dev"]:.4f}')
    if a.fig:
        stem = Path(a.fig)
        stem = stem.with_suffix('') if stem.suffix else stem
        f1 = stem.with_name(stem.name + '_skyao.png')
        f2 = stem.with_name(stem.name + '_e.png')
        _fig_skyao(a.scene, sk, f1)
        _fig_e(a.scene, pr, f2)
        print(f'\nskyao 图 -> {f1}')
        print(f'E     图 -> {f2}')


if __name__ == '__main__':
    main()
