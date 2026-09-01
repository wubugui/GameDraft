"""probe 正确性判据:**逐像素 E 作 reference,probe 重建必须收敛到它**。

制作人 2026-09-01 定:「可以对场景逐像素烘焙 E,然后再用高密度的体积来烘焙 probe,
这个 probe 在各种基下,给场景着色都必须和直接使用逐像素 E 看起来差不多,才说明
probe 是烘焙正确的。严格来说,在 probe 足够大的时候,两者应该完全等价。
但是这个逐像素烘焙的场景 E **仅仅用于作为 reference,不需要在游戏里实际使用**,
实际要使用的还是 probe!」

所以本模块**不产任何运行时载荷**,只出报告与对照图。

## 判的是什么

同一个被积量,两条独立的路:

    reference   E(x,N) = integral L(w) (N.w)+ dw      逐像素余弦重要性采样,直接算
    probe       E(x,N) = trilinear(格点 SH/bin) 按 N 重建

两者之差只该来自三项,各自有独立的收敛方向:

| 误差项 | 怎么消 | 本模块怎么分离它 |
|---|---|---|
| 三线性插值 | 格密度 -> 无穷 | `sweep()` 扫密度,看误差单调下降 |
| 方向基截断(L1/L2/bin) | 换更高的基 | `bases` 逐基对比,L1 > L2 > bin |
| 蒙特卡洛噪声 | spp -> 无穷 | 两边都加 spp,看误差趋于**基截断的地板** |

**极限一致性**(`limit_consistency`)把插值那一项摘掉:把 probe 直接放在像素自己的
表面点上,再按同一个法线重建。剩下的差就纯粹是基截断 + 噪声 —— 如果这一项都不小,
那不是密度不够,是 gather 或投影写错了。

## ⚠ 量纲

两边都按 **probe 图集的约定**:`E = integral L (N.w)+ dw`,**不除 pi**。
余弦重要性采样自然出的是 `E/pi`,`estimators.gather_scene_e` 里已经乘回去了。
不对齐的话 parity 会稳定差 3.14 倍 —— 而 3.14 倍很容易被某个增益吸收掉,
于是「看起来差不多」而实际上错着。
"""
from __future__ import annotations

import math

import numpy as np

from .const import MOMENT_SPP
from .escape import make_escape_sampler
from .estimators import (gather_probe, gather_scene_e, probe_eval_bins,
                         probe_eval_sh)
from .probe_layout import build_layout, dilate_invalid
from .scene_geometry import Scene, srgb_to_linear
from .trace import DepthField, buried

__all__ = ['reference_e', 'probe_reconstruct', 'compare', 'sweep',
           'limit_consistency']

LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)


def _work_geo(sid: str, work_w: int = 256, background: str | None = None):
    """parity 用的工作分辨率几何 + 线性原画。

    缺省 256 而不是烘焙的 512:参照要跑高 spp,而 parity 关心的是**相对误差**,
    分辨率只影响噪声不影响结论。
    """
    sc = Scene(sid, background=background)
    nw, nh = sc.native
    w = min(work_w, nw)
    h = max(1, round(nh * w / nw))
    geo = sc.geometry((w, h), normal_sigma=max(0.8, 0.8 * (w / 640.0)))
    if geo is None:
        raise RuntimeError(f'场景 {sid} 没有 depthConfig / 深度图')
    from .scene_geometry import resize_rgb
    bg = resize_rgb(sc.bg_srgb, (w, h)) if (w, h) != sc.native else sc.bg_srgb
    return sc, geo, srgb_to_linear(bg).astype(np.float32)


def reference_e(geo: dict, hdr: np.ndarray, escape_of, spp: int) -> np.ndarray:
    """逐像素 reference E,(h,w,3)。**只作参照,不进载荷。**"""
    from .scene_geometry import surface_points_q
    h, w = geo['depth'].shape
    # 法线要 q 空间:采样与 trace 都在 q 里做,省掉来回转的机会性错误。
    n_q = np.ascontiguousarray(
        (geo['normal'].reshape(-1, 3) @ geo['R']).astype(np.float32))
    n_q /= np.maximum(np.linalg.norm(n_q, axis=1, keepdims=True), 1e-9)
    e = gather_scene_e(surface_points_q(geo), n_q, geo['R'],
                       DepthField.from_geo(geo), hdr, escape_of, spp)
    return e.reshape(h, w, 3)


def probe_reconstruct(layout, coeff: np.ndarray, valid: np.ndarray,
                      world_pts: np.ndarray, normals_q: np.ndarray,
                      basis: str) -> np.ndarray:
    """按**运行时着色器 `probeE` 的口径**从 probe 网格重建 E。

    三线性权重、flat 索引、valid 门、`wsum` 归一 —— 逐条对着
    `CharacterShadingFilter.probeE` 抄。自己另写一套等于在验证两份代码碰巧
    写得一样,不是在验证 probe 对不对。
    """
    nx, ny, nz = layout.grid
    b = layout.bounds
    wmin = np.array([b['x0'], b['y0'], b['z0']], np.float32)
    wscale = np.array([(nx - 1) / max(b['x1'] - b['x0'], 1e-5),
                       (ny - 1) / max(b['y1'] - b['y0'], 1e-5),
                       (nz - 1) / max(b['z1'] - b['z0'], 1e-5)], np.float32)
    pn = np.array([nx, ny, nz], np.int32)
    t = np.clip((world_pts - wmin) * wscale, 0.0, pn - 1.001)
    b0 = t.astype(np.int32)
    f = t - b0
    n = len(world_pts)
    esum = np.zeros((n, 3), np.float64)
    wsum = np.zeros(n, np.float64)
    ev = probe_eval_bins if basis == 'bins' else probe_eval_sh
    for c in range(8):
        off = np.array([c & 1, (c >> 1) & 1, (c >> 2) & 1], np.int32)
        pi = np.minimum(b0 + off, pn - 1)
        w = (np.where(off[0], f[:, 0], 1 - f[:, 0])
             * np.where(off[1], f[:, 1], 1 - f[:, 1])
             * np.where(off[2], f[:, 2], 1 - f[:, 2]))
        flat = pi[:, 0] * (ny * nz) + pi[:, 1] * nz + pi[:, 2]
        w = w * (valid[flat] > 0.002)
        m = w > 1e-5
        if not m.any():
            continue
        esum[m] += ev(coeff[flat[m]], normals_q[m]) * w[m, None]
        wsum[m] += w[m]
    out = np.zeros((n, 3), np.float32)
    ok = wsum > 1e-4
    out[ok] = (esum[ok] / wsum[ok, None]).astype(np.float32)
    return out


def _stats(ref: np.ndarray, got: np.ndarray, mask: np.ndarray) -> dict:
    """误差统计。**两套并列,因为它们讲的不是一回事**(2026-09-01 吃过亏)。

    - `ratio_p50` / `ratio_med_dev`:逐像素比值 `got/ref` 的中位、以及 `|1-比值|`
      的中位。这才是「典型像素差多少」,也是对照图上看到的那个数。
    - `mean` / `p95`:`|Δ亮度| ÷ 全图亮度中位`。它是**绝对**误差除以一个全局尺度,
      被最亮的区域和几何边缘那几条细线整个拽上去。

    实测雾津街头 11.76 万颗 probe:`ratio_med_dev = 0.022`(典型像素差 2.2%,
    比值中位 0.991 几乎无偏)而 `mean = 0.11` —— 差 5 倍,因为误差是**重尾**的:
    绝大多数像素几乎完全吻合,少数落在深度不连续的边上差很多。
    只报 `mean` 会让人以为烘焙是错的(当场就误导过一次)。

    暗部为什么不用逐像素相对误差当主指标:分母趋 0 会炸成无意义的大数。
    所以 `ratio_*` 只在**亮度高于 p2** 的像素上算(调用方已经筛过一道)。
    """
    r = ref.reshape(-1, 3)[mask] @ LUMA
    g = got.reshape(-1, 3)[mask] @ LUMA
    scale = max(float(np.median(r)), 1e-6)
    d = np.abs(g - r) / scale
    lit = r > max(np.percentile(r, 2), 1e-6)
    ratio = g[lit] / np.maximum(r[lit], 1e-9)
    # 色度差单列:亮度对上了而颜色跑了,是另一类错(基截断不该改色度)
    rc = ref.reshape(-1, 3)[mask] / np.maximum(r[:, None], 1e-6)
    gc = got.reshape(-1, 3)[mask] / np.maximum(g[:, None], 1e-6)
    return {'ratio_p50': float(np.median(ratio)),
            'ratio_med_dev': float(np.median(np.abs(ratio - 1.0))),
            'ratio_p95_dev': float(np.percentile(np.abs(ratio - 1.0), 95)),
            'mean': float(d.mean()), 'p50': float(np.percentile(d, 50)),
            'p95': float(np.percentile(d, 95)), 'max': float(d.max()),
            'bias': float((g - r).mean() / scale),
            'chroma_p95': float(np.percentile(np.abs(gc - rc).max(1), 95)),
            'ref_median': float(np.median(r))}


def compare(sid: str, *, work_w: int = 256, ref_spp: int = 512,
            probe_spp: int = 512, cells_per_char_xz: float | None = None,
            dims: tuple[int, int, int] | None = (20, 6, 14),
            max_probes: int = 60_000,
            escape: dict | None = None, background: str | None = None,
            bases: tuple[str, ...] = ('l1', 'l2', 'bins'),
            verbose: bool = True) -> dict:
    """一次完整对照:逐像素 reference vs 各基下的 probe 重建。"""
    from .scene_fields import character_band_wu
    sc, geo, lin = _work_geo(sid, work_w, background)
    escape_of = make_escape_sampler(escape)
    field = DepthField.from_geo(geo)
    h, w = geo['depth'].shape
    R = geo['R']

    ref = reference_e(geo, lin, escape_of, ref_spp)

    scale = character_band_wu(sc)
    char_wu = scale['char_wu']
    # bins 那张是 (n,64,3) float64 —— 20 万颗就是 300 MB 一张,扫密度会爆内存。
    # parity 关心的是误差随密度的**趋势**,6 万颗(现役的 36 倍)足够看出来。
    kw: dict = {'band': scale['band'], 'max_probes': int(max_probes)}
    if cells_per_char_xz is not None:
        kw['cells_per_char_xz'] = cells_per_char_xz
        kw['dims'] = None
    else:
        kw['dims'] = dims
    layout = build_layout('uniform_grid', geo['pos'].reshape(-1, 3), char_wu, **kw)

    pts_q = np.ascontiguousarray(layout.world_pos @ R, np.float32)
    act = ~buried(pts_q, field)
    g = gather_probe(np.ascontiguousarray(pts_q[act]), R, field,
                     {'base': lin}, escape_of, spp=probe_spp)
    nxyz = layout.grid
    n = len(pts_q)

    def _scat(a):
        o = np.zeros((n, *a.shape[1:]), np.float32)
        o[act] = a
        return o

    sh = _scat(g['base']['sh'] + g['esc']['sh'])
    bn = _scat(g['base']['bins'] + g['esc']['bins'])
    filled, _ = dilate_invalid(act.reshape(nxyz),
                               [sh.reshape(*nxyz, 9, 3), bn.reshape(*nxyz, -1, 3)])
    valid = filled.reshape(-1).astype(np.float32)

    n_q = (geo['normal'].reshape(-1, 3) @ R).astype(np.float32)
    n_q /= np.maximum(np.linalg.norm(n_q, axis=1, keepdims=True), 1e-9)
    wpts = geo['pos'].reshape(-1, 3).astype(np.float32)
    # 只比 probe 盒**盖得住**的像素:盒外的像素被 clamp 到边界层,
    # 差多少完全取决于盒切在哪,与 probe 算得对不对无关。
    b = layout.bounds
    inbox = np.ones(len(wpts), bool)
    for i, (lo, hi) in enumerate((('x0', 'x1'), ('y0', 'y1'), ('z0', 'z1'))):
        inbox &= (wpts[:, i] >= b[lo]) & (wpts[:, i] <= b[hi])

    out: dict = {'scene': sid, 'work': [w, h], 'grid': list(nxyz),
                 'probes': n, 'char_wu': char_wu, 'cell': layout.cell_size(),
                 'inbox_frac': float(inbox.mean()), 'note': layout.note,
                 'hit_rate': g['hit_rate'], 'bases': {}}
    for bas in bases:
        coeff = bn if bas == 'bins' else (sh[:, :4] if bas == 'l1' else sh)
        got = probe_reconstruct(layout, coeff, valid, wpts, n_q, bas)
        out['bases'][bas] = _stats(ref, got.reshape(h, w, 3), inbox)
    if verbose:
        _print_compare(out)
    return out


def _print_compare(r: dict) -> None:
    c = r['cell']
    print(f"\n=== {r['scene']}  {r['work'][0]}x{r['work'][1]}  "
          f"probe {r['grid'][0]}x{r['grid'][1]}x{r['grid'][2]} = {r['probes']} 颗 ===")
    print(f"  角色 {r['char_wu']:.3f} wu  格 {c[0]:.3f}/{c[1]:.3f}/{c[2]:.3f} wu  "
          f"角色纵向跨 {r['char_wu']/max(c[1],1e-9):.2f} 层  "
          f"盒内像素 {r['inbox_frac']*100:.0f}%  命中率 {r['hit_rate']*100:.0f}%")
    print(f"  {'基':<6}{'比值中位':>10}{'典型差':>9}{'差p95':>9}"
          f"{'│':>3}{'均值(重尾)':>12}{'偏置':>9}{'色度p95':>10}")
    for k, s in r['bases'].items():
        print(f"  {k:<6}{s['ratio_p50']:10.4f}{s['ratio_med_dev']:9.4f}"
              f"{s['ratio_p95_dev']:9.4f}{'│':>3}{s['mean']:12.4f}"
              f"{s['bias']:+9.4f}{s['chroma_p95']:10.4f}")
    print('  「典型差」= |got/ref - 1| 的中位,对照图上看到的就是它;'
          '「均值」被几何边缘的重尾拽高,别当典型值读')


def sweep(sid: str, densities=(1.0, 2.0, 3.0, 4.5), **kw) -> list[dict]:
    """扫 probe 密度:误差必须随密度**单调下降**。

    这是「probe 足够大时两者等价」那句话的可证伪形式。不降 = 有系统性错误,
    加多少 probe 都救不回来(那时候该查 gather / 投影 / 坐标系,不是加密度)。
    """
    out = []
    for d in densities:
        out.append(compare(sid, cells_per_char_xz=d, dims=None, **kw))
    print(f'\n--- {sid} 密度扫描(每角色高几格 -> 各基的平均相对误差)---')
    print(f"  {'密度':>6}{'probe 数':>10}{'纵向跨层':>10}"
          + ''.join(f'{b + " 典型差":>12}' for b in out[0]['bases']))
    for d, r in zip(densities, out):
        c = r['cell']
        print(f"  {d:6.1f}{r['probes']:10d}{r['char_wu']/max(c[1],1e-9):10.2f}"
              + ''.join(f"{s['ratio_med_dev']:12.4f}" for s in r['bases'].values()))
    return out


def limit_consistency(sid: str, *, work_w: int = 128, spp: int = 1024,
                      n_pts: int = 2048, escape: dict | None = None) -> dict:
    """极限一致性:probe **就放在像素自己的表面点上**,再按同一法线重建。

    把三线性插值那一项摘掉之后,剩的差只该是方向基截断 + MC 噪声。
    这一项如果都不小,那不是密度不够 —— 是 gather 或投影写错了,
    加多少 probe 都没用。所以它是比 `sweep` 更根本的判据。

    ## 实测基线(码头白天,2026-09-01,逃逸辐射纯黑)

        基     平均误差   偏置     spp 256 -> 4096 的趋势
        l1     0.232    +0.166   0.2405 -> 0.2322(截断地板)
        l2     0.031    +0.013   0.0792 -> 0.0314(随 spp 收敛)
        bins   0.126    +0.103   0.1451 -> 0.1258(偏置纹丝不动)

    **L2 是现役档**(24/29 个场景 `shading.mode=2`),3% 就是整条链对上了的证据:
    采样器、tracer、SH 投影、A_l 卷积、不除 pi 的量纲约定,错任何一个都到不了 3%。

    ⚠ **bins 在这里比 L2 差不是 bug**,是本测试的摆位对 bins 特别不利:
    probe 落在**表面点上**时,朝向表面内侧的射线一步就打中这块表面自己,
    于是 E 沿方向有一个「地平线台阶」(背后是自己那块亮表面,前面是天)。
    8x8 八面体图的角分辨率约 45 度,跨不过这个台阶,相邻 bin 会把表面自身的辐射
    插进来 => 系统性偏亮。SH 存的本来就是**与余弦叶卷积过**的量,截断误差只落在
    辐射的高频细节上,不落在这个台阶上,所以反而不受影响。

    bins 的累加与重建本身已用解析算例验过是**精确**的:各向同性 L=1 时
    E(n) 恒等于 pi,64 个系数与任意法线上的重建都是 3.14159,偏置 -0.00%。
    真实摆位(probe 在空气里)看 `compare` / `sweep`,不看这里。
    """
    _sc, geo, lin = _work_geo(sid, work_w)
    escape_of = make_escape_sampler(escape)
    field = DepthField.from_geo(geo)
    R = geo['R']
    from .scene_geometry import surface_points_q
    pts = surface_points_q(geo)
    n_q = (geo['normal'].reshape(-1, 3) @ R).astype(np.float32)
    n_q /= np.maximum(np.linalg.norm(n_q, axis=1, keepdims=True), 1e-9)
    rng = np.random.default_rng(20260901)
    sel = rng.choice(len(pts), size=min(n_pts, len(pts)), replace=False)
    p = np.ascontiguousarray(pts[sel])
    nn = np.ascontiguousarray(n_q[sel])

    ref = gather_scene_e(p, nn, R, field, lin, escape_of, spp)
    g = gather_probe(p, R, field, {'base': lin}, escape_of, spp=spp)
    sh = g['base']['sh'] + g['esc']['sh']
    bn = g['base']['bins'] + g['esc']['bins']
    m = np.ones(len(p), bool)
    res = {'scene': sid, 'points': len(p), 'spp': spp, 'bases': {
        'l1': _stats(ref, probe_eval_sh(sh[:, :4], nn), m),
        'l2': _stats(ref, probe_eval_sh(sh, nn), m),
        'bins': _stats(ref, probe_eval_bins(bn, nn), m)}}
    print(f"\n=== {sid} 极限一致性(probe 落在像素上,{len(p)} 点 x {spp}spp)===")
    print('  只剩「方向基截断 + MC 噪声」,没有插值误差')
    print(f"  {'基':<6}{'平均':>9}{'p50':>9}{'p95':>9}{'偏置':>9}")
    for k, s in res['bases'].items():
        print(f"  {k:<6}{s['mean']:9.4f}{s['p50']:9.4f}{s['p95']:9.4f}{s['bias']:+9.4f}")
    return res


def main() -> None:
    import argparse
    import sys
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(
        prog='character_lighting_lab.parity',
        description='probe 正确性判据:逐像素 E 作 reference(不进游戏)')
    ap.add_argument('--scene', required=True)
    ap.add_argument('--background')
    ap.add_argument('--work-w', type=int, default=256)
    ap.add_argument('--ref-spp', type=int, default=512)
    ap.add_argument('--probe-spp', type=int, default=512)
    ap.add_argument('--sweep', action='store_true', help='扫密度,看误差是否单调下降')
    ap.add_argument('--limit', action='store_true', help='极限一致性(摘掉插值误差)')
    ap.add_argument('--max-probes', type=int, default=60_000)
    a = ap.parse_args()
    kw = dict(work_w=a.work_w, ref_spp=a.ref_spp, probe_spp=a.probe_spp,
              background=a.background, max_probes=a.max_probes)
    if a.limit:
        limit_consistency(a.scene, work_w=min(a.work_w, 128), spp=a.probe_spp)
    if a.sweep:
        sweep(a.scene, **kw)
    if not a.sweep and not a.limit:
        compare(a.scene, **kw)


if __name__ == '__main__':
    main()
