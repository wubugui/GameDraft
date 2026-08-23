"""场景侧 gather 的全部下游：去霾、局部 AO、直射光反解、整体增益、运行时拟合。

`E / base / Bdir / V / vis_linear` 的「积分」在 `trace.py::trace_pixels` 里，本模块
做的是把那份积分加工成可写盘的载荷与诊断量。
"""
from __future__ import annotations

import math

import numpy as np
from scipy.ndimage import gaussian_filter

from . import const


# -------------------------------------------------------------------- 去霾
def fit_haze(lin: np.ndarray, depth: np.ndarray) -> dict:
    """拟合原画里的白天大气散射（aerial perspective）。

    `原画 = 表面辐射·T(d) + 霾·(1-T(d))`。霾不是表面，是被日光照亮的空气。判据是
    暗通道先验：黑表面上剩下的就是霾。按视深分层取暗通道低分位，拟合
    `haze(d) = H·(1-exp(-k·d))`。
    """
    d_lo, d_hi = float(depth.min()), float(depth.max())
    dn = ((depth - d_lo) / max(d_hi - d_lo, 1e-6)).ravel()
    dark = lin.min(-1).ravel()
    edges = np.linspace(0.0, 1.0, 21)
    xs, ys = [], []
    for i in range(20):
        m = (dn >= edges[i]) & (dn < edges[i + 1])
        if m.sum() < 300:
            continue
        xs.append((edges[i] + edges[i + 1]) * 0.5)
        ys.append(float(np.percentile(dark[m], 3)))
    if len(xs) < 4:
        return {'k': 0.0, 'strength': 0.0, 'color': [1.0, 1.0, 1.0],
                'depth_min': d_lo, 'depth_max': d_hi, 'residual': 0.0}
    xs_a = np.asarray(xs, np.float64)
    ys_a = np.asarray(ys, np.float64)
    best = (1e18, 0.0, 0.0)
    for k in np.arange(0.2, 8.001, 0.05):
        b = 1.0 - np.exp(-k * xs_a)
        H = float((b @ ys_a) / max(b @ b, 1e-12))
        r = float(((H * b - ys_a) ** 2).mean())
        if r < best[0]:
            best = (r, float(k), H)
    residual, k, H = best
    far = dn >= 0.85
    if far.sum() > 200:
        c = np.percentile(lin.reshape(-1, 3)[far], 5, axis=0)
    else:
        c = np.array([1.0, 1.0, 1.0], np.float32)
    c = c / max(float(c.mean()), 1e-6)
    return {'k': k, 'strength': max(H, 0.0), 'color': [float(v) for v in c],
            'depth_min': d_lo, 'depth_max': d_hi, 'residual': residual}


def apply_dehaze(lin: np.ndarray, depth: np.ndarray, haze: dict) -> np.ndarray:
    """把拟合出来的白天散射从线性原画里除掉。**逐通道下限法，不是硬钳**。

    ⚠ 硬钳（`max(lin-amount, 0)`）在有颜色的霾下会把蓝绿先清零、红活下来 ⇒ 一片红
    噪点。按下限法钳住时是整体按比例缩小 ⇒ 色度守恒。
    """
    if haze['strength'] <= 0:
        return lin
    dn = np.clip((depth - haze['depth_min'])
                 / max(haze['depth_max'] - haze['depth_min'], 1e-5), 0.0, 1.0)
    trans = np.exp(-haze['k'] * dn)[..., None]
    amount = np.asarray(haze['color'], np.float32)[None, None, :] * (
        haze['strength'] * (1.0 - trans))
    # 每个通道最多拿走自身的 (1-HAZE_KEEP)；再除 trans 还原表面项。
    return ((lin - np.minimum(amount, lin * (1.0 - const.HAZE_KEEP)))
            / np.maximum(trans, 0.15)).astype(np.float32)


# -------------------------------------------------------------------- 局部 AO
def _sphere_quadrature(n_azim: int, n_nodes: int) -> list[tuple[np.ndarray, float]]:
    """全球面 Gauss-Legendre 求积（μ∈[-1,1] × 均匀方位）。"""
    out = []
    nodes, weights = np.polynomial.legendre.leggauss(n_nodes)
    for mu, w in zip(nodes, weights, strict=True):
        y = float(mu)
        horiz = math.sqrt(max(1.0 - y * y, 0.0))
        for k in range(n_azim):
            a = 2.0 * math.pi * k / n_azim
            out.append((np.array([horiz * math.sin(a), y, horiz * math.cos(a)], np.float32),
                        float(w)))
    return out


def bake_local_ao(q: np.ndarray, normal: np.ndarray, R: np.ndarray,
                  ppu: float, cx: float, cy: float,
                  n_azim: int = 12, n_nodes: int = 8) -> np.ndarray:
    """局部环境遮蔽（多次反弹的几何代理）。

        AO(p) = Σ w·V(ω)·(N·ω)₊ / Σ w·(N·ω)₊

    分子分母同一个 N ⇒ 无遮挡时任何朝向恒为 1。与天穹遮蔽是两个不同的问题：
    `V` 问「看得见多少天」（室内≈0，没信号），`AO` 问「有多封闭」（室内才有信号）。
    短程 march 走 `trace_ao`（与体数据 AO 通道同一条）。
    """
    from .trace import trace_ao
    dirs = _sphere_quadrature(n_azim, n_nodes)
    Q = q.reshape(-1, 3).astype(np.float32)
    Nf = normal.reshape(-1, 3).astype(np.float32)
    num = np.zeros(len(Q), np.float64)
    den = np.zeros(len(Q), np.float64)
    for dw, w in dirs:
        dq = (R.T @ dw).astype(np.float32)
        cos = np.clip(Nf @ dw, 0.0, 1.0)
        if cos.max() <= 1e-6:
            den += w * cos
            continue
        dqb = np.broadcast_to(dq, Q.shape)
        vis = trace_ao(Q, dqb, q[..., 2], ppu, cx, cy).astype(np.float64)
        num += w * vis * cos
        den += w * cos
    ao = (num / np.maximum(den, 1e-9)).astype(np.float32).reshape(q.shape[:2])
    ao = gaussian_filter(ao, 0.8)
    return np.clip(ao, 0.0, 1.0)


# -------------------------------------------------------------------- 直射光
def direct_visibility(vfit: np.ndarray, dw: np.ndarray) -> np.ndarray:
    """某个方向的可见度 `V(ω) ≈ clamp(a + b·ω, 0, 1)`。

    ⚠ 定死不再换。可见锥那套（bent 归一化 + 锥半角 + 人为过渡带）天生二值、低 V 处
    成片椒盐黑点。线性重建天生连续、无自由参数。
    """
    return np.clip(vfit[..., 0] + vfit[..., 1:] @ np.asarray(dw, np.float32), 0.0, 1.0)


def solve_direct_light(normal: np.ndarray, vfit: np.ndarray, hdr: np.ndarray,
                       e_ind: np.ndarray) -> dict:
    """从原画反解一个直射光：方向、强度、颜色。

    gather 出的 `E` 只有天空 + 画面反弹，没有任何「光源直接照到 x」的项。画里由
    直射光造成的大尺度明暗除不掉、全留在 base。方向**先拟合再比较**（每个候选方向
    用同一个自由度 L 中位匹配，再比 `std(log base)`）。
    """
    lw = np.array([0.2126, 0.7152, 0.0722], np.float32)
    Il = (hdr @ lw).astype(np.float64)
    El = (e_ind @ lw).astype(np.float64)
    base0 = Il / np.maximum(El, 1e-6)
    sd0 = float(np.std(np.log(np.maximum(base0, 1e-9))))
    best = None
    score_table = []
    for ie in range(const.SUN_SCAN_EL):
        el = (ie + 0.5) / const.SUN_SCAN_EL * (math.pi / 2)
        for ia in range(const.SUN_SCAN_AZ):
            az = 2 * math.pi * ia / const.SUN_SCAN_AZ
            dw = np.array([math.cos(el) * math.sin(az), math.sin(el),
                           math.cos(el) * math.cos(az)], np.float32)
            cosn = np.clip(normal @ dw, 0.0, None).astype(np.float64)
            S = cosn * direct_visibility(vfit, dw).astype(np.float64)
            band = (cosn > 0.35) & (cosn < 0.95)
            if (S > 0).any():
                lit = band & (S > np.percentile(S[S > 0], 70))
                sha = band & (S < np.percentile(S[S > 0], 30))
            else:
                lit, sha = band, band
            if lit.sum() < 2000 or sha.sum() < 2000:
                score_table.append({'el': math.degrees(el), 'az': math.degrees(az),
                                    'sd': None, 'L': None})
                continue

            def ratio(v: float) -> float:
                b = Il / np.maximum(El + v * S, 1e-6)
                return float(np.median(b[lit]) / max(np.median(b[sha]), 1e-12))
            if ratio(0.0) <= 1.0:
                score_table.append({'el': math.degrees(el), 'az': math.degrees(az),
                                    'sd': None, 'L': None})
                continue
            lo, hi = 0.0, 64.0
            while ratio(hi) > 1.0 and hi < 1e5:
                hi *= 2
            for _ in range(40):
                m = 0.5 * (lo + hi)
                if ratio(m) > 1.0:
                    lo = m
                else:
                    hi = m
            L = 0.5 * (lo + hi)
            b = Il / np.maximum(El + L * S, 1e-6)
            sd = float(np.std(np.log(np.maximum(b, 1e-9))))
            score_table.append({'el': math.degrees(el), 'az': math.degrees(az),
                                'sd': sd, 'L': float(L)})
            if best is None or sd < best['sd']:
                best = dict(sd=sd, dir=dw, el=math.degrees(el), az=math.degrees(az),
                            S=S, cosn=cosn)
    if best is None:
        return dict(found=False, note='没有任何方向能解出直射光（阴天 / 室内）',
                    dir=[0.0, 1.0, 0.0], radiance=[0.0, 0.0, 0.0],
                    std_before=sd0, std_after=sd0, drop=0.0, score_table=score_table)
    S = best['S']

    def cost(v: float) -> float:
        b = Il / np.maximum(El + v * S, 1e-6)
        return float(np.std(np.log(np.maximum(b, 1e-9))))
    lo, hi = 0.0, 64.0
    while cost(hi) < cost(hi * 0.5) and hi < 4096:
        hi *= 2
    for _ in range(60):
        a1 = lo + (hi - lo) * 0.382
        b1 = lo + (hi - lo) * 0.618
        if cost(a1) < cost(b1):
            hi = b1
        else:
            lo = a1
    lum = 0.5 * (lo + hi)
    cosn = best['cosn']
    vis = S / np.maximum(cosn, 1e-6)
    lit = (cosn > 0.3) & (vis > 0.8)
    sha = (cosn > 0.3) & (vis < 0.4)
    if sha.sum() > 500 and lit.sum() > 500:
        r = np.array([np.median(hdr[..., c][lit]) / max(np.median(hdr[..., c][sha]), 1e-12)
                      for c in range(3)])
        ch = r / max(r.mean(), 1e-9)
    else:
        ch = np.ones(3)
    ch = np.clip(ch, *const.SUN_CHROMA_CLAMP)
    ch = ch / ch.mean()
    L = (lum * ch / max(float(ch @ lw), 1e-9)).astype(np.float32)
    sd = cost(lum)
    return dict(found=True, dir=[float(v) for v in best['dir']],
                elevation_deg=best['el'], azimuth_deg=best['az'],
                radiance=[float(v) for v in L], chroma=[float(v) for v in ch],
                std_before=sd0, std_after=sd, drop=float(1 - sd / max(sd0, 1e-9)),
                lit_frac=float(np.mean(vis > 0.8)), score_table=score_table)


# -------------------------------------------------------------------- 运行时拟合
def fit_runtime_lights(e: np.ndarray, t0: np.ndarray, ao: np.ndarray) -> dict:
    """求运行时默认灯光强度，使 `E_目标 ≈ E`（未调过的场景画面≈原画）。

        E_目标 = sky·T₀ + ambient·(0.28 + 0.72·AO)

    两个基、非负最小二乘、闭式解。⚠ 不是拟合原画 —— `E` 已被 gather 算定，这里只问
    运行时那两个旋钮要设成多少才能重现这份已算好的辐照度。
    """
    from scipy.optimize import nnls
    sub = (slice(None, None, 3), slice(None, None, 3))
    b1 = t0[sub].ravel().astype(np.float64)
    b2 = np.clip(0.28 + 0.72 * ao[sub], 0.0, 1.2).ravel().astype(np.float64)
    lum = (e[sub] @ np.array([0.2126, 0.7152, 0.0722], np.float32)).ravel().astype(np.float64)
    coef, _res = nnls(np.stack([b1, b2], 1), lum)
    pred = np.stack([b1, b2], 1) @ coef
    rgb = e.reshape(-1, 3).mean(axis=0)
    return {
        'sky': float(coef[0]), 'ambient': float(coef[1]),
        'rel_err': float(np.abs(pred - lum).mean() / max(float(lum.mean()), 1e-9)),
        'e_rgb_mean': [float(v) for v in rgb],
        'e_chroma': [float(v / max(float(rgb.mean()), 1e-9)) for v in rgb],
    }
