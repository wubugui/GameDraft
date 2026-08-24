"""场景侧 gather 与全部逐点估计器(方案 §5.1 / §5.5–§5.8 / §5.11)。

所有消费者一律长这样,没有第二种形态(§8):

    ω, pdf = <某个采样器>(...)
    r = trace(origins_q, ω @ R, field, max_distance=<inf 或有理由的有限值>)
    <把 r.escaped / r.hit_yx / r.t_hit 归约成要的量 —— 要什么都从这份全记录拿>

归约全部在 numpy 主线程按固定顺序做(float64 累加)⇒ 产物逐位与线程数无关。

`sky_moments` 是**场景逐像素与体格点共用的同一个估计器**(§5.9 极限一致性
铁律 1/3 的实现处):同一采样器 + 位置哈希种子 + 同一 spp ⇒ 格点恰好落在
某表面点上时与该像素逐位相同(自检 #13)。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.ndimage import gaussian_filter

from .const import (AO_RANGE, AO_SPP, GATHER_GAIN_MAX, GATHER_GAIN_PERCENTILE,
                    HAZE_KEEP, MOMENT_SPP, SUN_CHROMA_CLAMP, SUN_SCAN_AZ,
                    SUN_SCAN_EL)
from .encode import LUMA
from .nee import NeeContext, pdf_light, sample_light
from .sampling import (cosine_hemisphere, point_keys, tangent_basis,
                       uniform_sphere, uniform_upper_hemisphere)
from .trace import DepthField, trace

UP = np.array([0.0, 1.0, 0.0], np.float32)


# ================================================================ 去霾 §5.1

def fit_haze(lin: np.ndarray, depth: np.ndarray) -> dict:
    """拟合原画里的白天大气散射(暗通道先验,按视深分箱)。"""
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
        # 退化分支也带 'H':同一函数只许出一种 schema(复审纠正)
        return {'k': 0.0, 'H': 0.0, 'strength': 0.0, 'color': [1.0, 1.0, 1.0],
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
    # H 原始拟合值单独记(§4.4 要求;strength 是钳过的,负值被吞时回溯要看得见)
    return {'k': k, 'H': float(H), 'strength': max(H, 0.0),
            'color': [float(v) for v in c],
            'depth_min': d_lo, 'depth_max': d_hi, 'residual': residual}


def apply_dehaze(lin: np.ndarray, depth: np.ndarray, haze: dict) -> np.ndarray:
    """把白天散射从线性原画里除掉。**逐通道按自身留下限,不是硬钳**(§5.1):
    硬钳会在暗部非对称清零(蓝绿先死红活下来 ⇒ 红噪点);下限法钳住时整体
    按比例缩小 ⇒ 色度守恒。"""
    if haze['strength'] <= 0:
        return lin
    dn = np.clip((depth - haze['depth_min'])
                 / max(haze['depth_max'] - haze['depth_min'], 1e-5), 0.0, 1.0)
    trans = np.exp(-haze['k'] * dn)[..., None]
    amount = np.asarray(haze['color'], np.float32)[None, None, :] * (
        haze['strength'] * (1.0 - trans))
    return ((lin - np.minimum(amount, lin * (1.0 - HAZE_KEEP)))
            / np.maximum(trans, 0.15)).astype(np.float32)


# ======================================================== E gather §5.5

@dataclass
class GatherCache:
    """§5.12 天空重估的缓存:天空只影响逃逸的射线,命中半 march 一次定死。

        E = (hit_sum + Σ_逃逸 sky(ω_s)) / spp

    方向不用存 —— 采样是位置哈希确定性的,重估时按同一种子重生成;
    keys/normals/shape 随缓存携带,调用方**不可能**传错配的数组
    (重估 ≡ 全新 bake 的构造性由此闭合)。只活在 GUI 会话内存,不落盘。
    """

    hit_sum: np.ndarray        # (n,3) float64,逐点命中辐射和(固定顺序累加)
    esc_mask: np.ndarray       # (n,spp) bool,逐点×逐样本逃逸位
    spp: int
    keys: np.ndarray           # (n,) uint64 位置键(重生成方向用)
    normals: np.ndarray        # (n,3) f32(余弦采样的切线框架)
    shape_hw: tuple[int, int]


def clamp_rows(contrib: np.ndarray, clamp: float | None) -> np.ndarray:
    """Cycles「Clamp Indirect」同款(有偏,可开关):单样本贡献的**亮度**上限,
    超限整行等比缩(保色度)。与 NEE 正交,逐策略样本各自钳;
    clamp=None(缺省)原样返回 —— 关闭路径逐位不变。场景 E 与体 GI 共用。"""
    if clamp is None:
        return contrib
    lum = contrib @ LUMA.astype(np.float64)
    f = np.minimum(1.0, clamp / np.maximum(lum, 1e-9))
    return contrib * f[:, None]


def nee_mis_downweight(contrib: np.ndarray, nee_ctx: NeeContext, res,
                       hit: np.ndarray, origins_q: np.ndarray,
                       d_q: np.ndarray, pdf_b: np.ndarray) -> None:
    """BSDF 样本命中发光体 → balance heuristic 的 BSDF 半权重(原地降权)。
    场景与体 GI 共用的**唯一实现**;pdf_light 与光源样本分母同一个函数
    ⇒ 两侧权重逐点归一,无偏。

    配对类 = **壳体素箱的射线弦**(nee.py 模块文档):march 命中点必在其
    texel 的箱内 ⇒ 弦恒非空 ⇒ 每一发发光体命中都有正的光源密度,横向命中
    (伪世界表面间传输的主体)不再漏网;近场 r<r_min 密度 0 ⇒ 权重自动 = 1。
    §15 记录了三版口径的验尸:容差配对砍半、逐像素配对空转、薄平面方格
    在真实场景 in-support 趋零。"""
    hit_idx = np.where(hit)[0]
    if len(hit_idx) == 0:
        return
    e_idx = nee_ctx.sel_map[res.hit_yx[hit_idx, 0], res.hit_yx[hit_idx, 1]]
    em = e_idx >= 0
    if not em.any():
        return
    rows = hit_idx[em]
    pl = pdf_light(nee_ctx, origins_q[rows], d_q[rows])
    pb = pdf_b[rows].astype(np.float64)
    contrib[rows] *= (pb / np.maximum(pb + pl, 1e-300))[:, None]


def _nee_scene_light(nee_ctx: NeeContext, q_pts: np.ndarray,
                     normals: np.ndarray, keys: np.ndarray, s: int, spp: int,
                     R: np.ndarray, field: DepthField,
                     hdr: np.ndarray) -> np.ndarray:
    """场景侧光源样本贡献(n,3 f64,已含 MIS 权):
    C = w_L · L · cosθ_r / (π · pdf_L) —— E 的 ÷π 约定下与 BSDF 样本同量纲。
    光源样本就是第二个方向采样器:march 打到哪、就取哪的辐射
    (逃逸 = f_hit 的合法零样本)—— 可见性完全在被积函数里,零判据。"""
    j, dl_q, r, pl = sample_light(nee_ctx, q_pts, keys, s, spp)
    cos_r = np.maximum(
        np.einsum('ij,ij->i', dl_q @ R.T, normals), 0.0).astype(np.float64)
    out = np.zeros((len(q_pts), 3), np.float64)
    valid = (pl > 0.0) & (cos_r > 0.0)
    if not valid.any():
        return out
    idx = np.where(valid)[0]
    vres = trace(np.ascontiguousarray(q_pts[idx]),
                 np.ascontiguousarray(dl_q[idx]), field,
                 max_distance=math.inf)
    vis = ~vres.escaped
    if not vis.any():
        return out
    rows = idx[vis]
    L = hdr[vres.hit_yx[vis, 0], vres.hit_yx[vis, 1]].astype(np.float64)
    pb = cos_r[rows] / math.pi
    w_l = pl[rows] / np.maximum(pl[rows] + pb, 1e-300)
    out[rows] = L * (w_l * cos_r[rows] / (math.pi * pl[rows]))[:, None]
    return out


def gather_scene_e(q_pts: np.ndarray, normals: np.ndarray, R: np.ndarray,
                   field: DepthField, hdr: np.ndarray, spp: int,
                   shape_hw: tuple[int, int], progress=None,
                   nee_ctx: NeeContext | None = None,
                   clamp: float | None = None) -> GatherCache:
    """伪世界 final gather 的 march 半(与天空无关的那半)。

    `nee_ctx`(NEE+MIS,无偏)与 `clamp`(Cycles 系亮度钳,有偏)都只改
    hit_sum 的累积 —— 逃逸位与天空半原样,GatherCache 结构、combine_e、
    §5.12 重估(#12)全部不动;两者都关时逐位 = 旧路。

        E(x) = ∫ L_in·(N·ω)₊ dω ÷ ∫ (N·ω)₊ dω      (分母 ≡ π,§5.5)

    余弦重要性采样(pdf = cos/π)下估计量 = 样本平均 —— `Σ f/pdf / n` 的
    pdf 恰好约掉的特例;首个样本上有断言钉住这一恒等,换采样器时立刻暴露。
    """
    n = len(q_pts)
    keys = point_keys(q_pts)
    basis = tangent_basis(normals)
    hit_sum = np.zeros((n, 3), np.float64)
    esc_mask = np.empty((n, spp), np.bool_)
    for s in range(spp):
        dirs, pdf = cosine_hemisphere(normals, keys, s, spp, basis=basis)
        if s == 0 and n:
            k = min(n, 1024)
            cos = np.maximum(np.einsum('ij,ij->i', dirs[:k], normals[:k]), 0.0)
            assert np.allclose(pdf[:k], cos / math.pi, atol=1e-6), (
                'cosine_hemisphere 的 pdf ≠ cos/π —— E = mean(L) 特例失效(§5.5),'
                '换了采样器要改回 Σ f/pdf/n 的通式')
        # 天在无穷远:命中/出画/前穿三条精确终止就是积分的边界,无理由截断
        d_q = dirs @ R
        res = trace(q_pts, d_q, field, max_distance=math.inf)
        esc_mask[:, s] = res.escaped
        hit = ~res.escaped
        contrib = np.zeros((n, 3), np.float64)
        contrib[hit] = hdr[res.hit_yx[hit, 0], res.hit_yx[hit, 1]]
        if nee_ctx is not None:
            nee_mis_downweight(contrib, nee_ctx, res, hit, q_pts, d_q, pdf)
            light = _nee_scene_light(nee_ctx, q_pts, normals, keys, s, spp,
                                     R, field, hdr)
            hit_sum += clamp_rows(light, clamp)
        hit_sum += clamp_rows(contrib, clamp)
        if progress:
            progress('gather', s + 1, spp)
    return GatherCache(hit_sum=hit_sum, esc_mask=esc_mask, spp=spp,
                       keys=keys, normals=np.ascontiguousarray(normals),
                       shape_hw=tuple(shape_hw))


def combine_e(cache: GatherCache, sky_of) -> np.ndarray:
    """march 缓存 + 天空 → E(work 分辨率,已做 σ=0.8 出锅平滑)。

    §5.12:换天空只走这半,全程无 march;同种子下与全新 bake **逐位相同**
    (自检 #12 钉住)—— 因为全新 bake 也走的就是本函数(单一实现 ⇒ 结构性等价)。

    常色快路:天空方向无关时逃逸半 = 逃逸计数 × 常色,免去逐 spp 重生成方向
    (实测把重组从 ~2.6s 压到 ~0.1s,GUI「边调边看」的主通路)。
    """
    n, spp = cache.esc_mask.shape
    sky_acc = np.zeros((n, 3), np.float64)
    const_c = getattr(sky_of, 'constant_rgb', None)
    if const_c is not None:
        cnt = cache.esc_mask.sum(1).astype(np.float64)
        sky_acc = cnt[:, None] * np.asarray(const_c, np.float64)[None, :]
    else:
        basis = tangent_basis(cache.normals)
        for s in range(spp):
            dirs, _pdf = cosine_hemisphere(cache.normals, cache.keys, s, spp,
                                           basis=basis)
            esc = cache.esc_mask[:, s]
            if esc.any():
                sky_acc[esc] += np.asarray(sky_of(dirs[esc]), np.float64)
    h, w = cache.shape_hw
    e = ((cache.hit_sum + sky_acc) / spp).reshape(h, w, 3).astype(np.float32)
    for c in range(3):
        e[..., c] = gaussian_filter(e[..., c], 0.8)
    return e


# ==================================================== 遮蔽矩 §5.5 / §5.9

def sky_moments(pts_q: np.ndarray, R: np.ndarray, field: DepthField,
                spp: int = MOMENT_SPP, progress=None) -> tuple[np.ndarray, np.ndarray]:
    """任意一批空间点的遮蔽矩 (a₀, a₁) —— 场景逐像素与体格点**同一个估计器**。

        M₀ = ∫_{ω·up>0} vis dω          M₁ = ∫_{ω·up>0} vis·ω dω
        a₀ = M₀/4π                       a₁ = M₁/2π

    估计量 `Σ f/pdf / n`(均匀上半球 pdf = 1/2π)。点的属性、法线无关;
    位置哈希种子 ⇒ 与批次/调用方无关(极限一致性铁律 3,自检 #13)。
    """
    n = len(pts_q)
    if n == 0:
        return np.zeros(0, np.float32), np.zeros((0, 3), np.float32)
    keys = point_keys(pts_q)
    m0 = np.zeros(n, np.float64)
    m1 = np.zeros((n, 3), np.float64)
    inv4pi = 1.0 / (4.0 * math.pi)
    inv2pi = 1.0 / (2.0 * math.pi)
    for s in range(spp):
        dirs, pdf = uniform_upper_hemisphere(keys, s, spp)
        # 天在无穷远,任何有限射程都是错的(§5.8 对照表)⇒ max_distance=inf
        res = trace(pts_q, dirs @ R, field, max_distance=math.inf)
        f_over_pdf = res.escaped.astype(np.float64) / pdf.astype(np.float64)
        m0 += f_over_pdf
        m1 += f_over_pdf[:, None] * dirs.astype(np.float64)
        if progress:
            progress('moments', s + 1, spp)
    a0 = (m0 / spp * inv4pi).astype(np.float32)
    a1 = (m1 / spp * inv2pi).astype(np.float32)
    return a0, a1


def smooth_moments(a0: np.ndarray, a1: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """出锅平滑 σ=0.8(§5.5:矩是线性量,滤波与求值可交换,安全)。只用于 2D 图。"""
    a0s = gaussian_filter(a0, 0.8).astype(np.float32)
    a1s = np.stack([gaussian_filter(a1[..., c], 0.8) for c in range(3)],
                   -1).astype(np.float32)
    return a0s, a1s


# ---------------------------------------------- 矩 → 运行时三个量(闭式)

def cap0(normals: np.ndarray) -> np.ndarray:
    """天穹分子在完全无遮挡时的解析值 `(1+N·up)/2`(§5.5,逐角度验证过)。
    除以它之后 V=1 =「把朝向允许看到的天全看到了」;SkySH(N) 已算过朝向,
    V 里再含一次就是同一件事扣两遍。1/255 只防 N 朝正下的 0/0。"""
    return np.maximum((1.0 + normals[..., 1]) * 0.5, 1.0 / 255.0).astype(np.float32)


def vis_of_normal(a0: np.ndarray, a1: np.ndarray, normals: np.ndarray) -> np.ndarray:
    """V(N) = clamp(T(N)/cap₀, 0, 1),T(N) = a₀ + a₁·N。"""
    t = a0 + np.einsum('...i,...i->...', a1, normals)
    return np.clip(t / cap0(normals), 0.0, 1.0).astype(np.float32)


def bent_of_moments(a1: np.ndarray, normals: np.ndarray) -> np.ndarray:
    """Bdir = normalize(a₁);|a₁|≈0 时退回 N(那儿 V≈0,方向不参与)。"""
    ln = np.linalg.norm(a1, axis=-1, keepdims=True)
    bent = np.where(ln > 1e-6, a1 / np.maximum(ln, 1e-9), normals)
    return bent.astype(np.float32)


def vdir_coeffs(a0: np.ndarray, a1: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """定向可见度 V_dir(ω) = clamp(α + β·ω, 0, 1) 的闭式系数(§5.5):

        α = 8a₀ − 6a₁ᵧ    βᵧ = 12a₁ᵧ − 12a₀    βₓ = 3a₁ₓ    β_z = 3a₁_z

    vis 在上半球均匀测度下对基 {1, ω} 的正交投影 —— Gram 矩阵是常数,
    一次求逆写死,零自由参数。构造性自检:vis≡1 ⇒ α=1、β=0。
    """
    alpha = 8.0 * a0 - 6.0 * a1[..., 1]
    beta = np.empty(a1.shape, np.float32)
    beta[..., 0] = 3.0 * a1[..., 0]
    beta[..., 1] = 12.0 * a1[..., 1] - 12.0 * a0
    beta[..., 2] = 3.0 * a1[..., 2]
    return alpha.astype(np.float32), beta


def vis_of_dir(a0: np.ndarray, a1: np.ndarray, dw: np.ndarray) -> np.ndarray:
    """某个方向的宏观可见度(macro_vis)。dw: (3,) 或与 a0 广播的 (...,3)。

    闭式的**唯一** Python 表达处 —— pipeline / GUI / report 一律走这里,
    不许各抄一遍 `clip(α+β·ω)`。
    """
    alpha, beta = vdir_coeffs(a0, a1)
    d = np.asarray(dw, np.float32)
    dot = (np.einsum('...i,i->...', beta, d) if d.ndim == 1
           else np.einsum('...i,...i->...', beta, d))
    return np.clip(alpha + dot, 0.0, 1.0).astype(np.float32)


def compose_sun_e(e_ind: np.ndarray, normal: np.ndarray, a0: np.ndarray,
                  a1: np.ndarray, sun: dict) -> np.ndarray:
    """E = E_间接 + 太阳辐亮度·(N·ω_s)₊·V_dir(ω_s)(§5.6 末式)。

    pipeline 与 GUI 重估路径调**同一份** —— 组合半的「重估 ≡ 全新 bake」
    靠单一实现,不靠两处代码碰巧写得一样。
    """
    if not sun.get('found'):
        return e_ind
    sdir = np.asarray(sun['dir'], np.float32)
    s_term = (np.clip(normal @ sdir, 0.0, None)
              * vis_of_dir(a0, a1, sdir)).astype(np.float32)
    return (e_ind + np.asarray(sun['radiance'], np.float32)[None, None, :]
            * s_term[..., None]).astype(np.float32)


# ============================================================ 局部 AO §5.8

def local_ao(pts_q: np.ndarray, normals: np.ndarray, R: np.ndarray,
             field: DepthField, spp: int = AO_SPP, *,
             progress=None) -> np.ndarray:
    """局部环境遮蔽(多次反弹的几何代理):

        AO(p) = Σ (esc/pdf)·(N·ω)₊ / Σ (1/pdf)·(N·ω)₊        全球面均匀采样

    分子分母同一个 N ⇒ 无遮挡时任何朝向恒为 1(AO 是「半径 r 内开了多少」,
    与朝向无关)。唯一消费者是环境光(近场多次反弹),不乘直接光、不乘天光。

    max_distance=AO_RANGE 是 **AO 这个积分定义的一部分**(§5.8):AO 问的就是
    「半径 r 之内有多封闭」,r 就是问题的一部分 —— 与天穹遮蔽(天在无穷远,
    任何射程都是错的)是两个不同的问题。语义仍 ≡ 全程 trace 后按 t_hit ≤ r
    过滤(契约测试 7),这里显式传有限值纯为性能。
    """
    n = len(pts_q)
    keys = point_keys(pts_q)
    num = np.zeros(n, np.float64)
    den = np.zeros(n, np.float64)
    for s in range(spp):
        dirs, pdf = uniform_sphere(keys, s, spp)
        cos = np.maximum(np.einsum('ij,ij->i', dirs, normals), 0.0).astype(np.float64)
        w = cos / pdf.astype(np.float64)
        den += w
        # 权重恒 0(cos ≤ 0,约一半)的射线不 march —— 逐位不改结果
        # (num 里它们乘 0),白省一半 AO 射线(效率审查)。
        m = cos > 0.0
        if not m.any():
            continue
        # §5.8:AO_RANGE 是 **AO 积分定义的一部分**(问「半径 r 内有多封闭」,
        # r 就是问题的一部分),积分因此有界;语义 ≡ t_hit ≤ r 事后过滤(契约 7)。
        res = trace(np.ascontiguousarray(pts_q[m]),
                    np.ascontiguousarray(dirs[m]) @ R, field,
                    max_distance=AO_RANGE)
        esc = np.zeros(n, np.float64)
        esc[m] = res.escaped
        num += esc * w
        if progress:
            progress('ao', s + 1, spp)
    ao = (num / np.maximum(den, 1e-9)).astype(np.float32)
    return np.clip(ao, 0.0, 1.0)


# ====================================================== 直射光反解 §5.6

def solve_direct_light(normal: np.ndarray, a0: np.ndarray, a1: np.ndarray,
                       hdr: np.ndarray, e_ind: np.ndarray,
                       progress=None) -> dict:
    """从原画反解一个直射光:方向、强度、颜色。方向遮蔽由遮蔽矩闭式导出。

    先拟合再比较:每个候选方向用同一个自由度(标量 L,中位匹配解出),
    再比拟合后 std(log base)。meta 记**完整评分表**,「落回中心」能一眼看出。
    """
    lw = LUMA
    Il = (hdr @ lw).astype(np.float64)
    El = (e_ind @ lw).astype(np.float64)
    base0 = Il / np.maximum(El, 1e-6)
    sd0 = float(np.std(np.log(np.maximum(base0, 1e-9))))
    alpha, beta = vdir_coeffs(a0, a1)
    best = None
    scan: list[dict] = []
    for ie in range(SUN_SCAN_EL):
        el = (ie + 0.5) / SUN_SCAN_EL * (math.pi / 2)
        for ia in range(SUN_SCAN_AZ):
            az = 2 * math.pi * ia / SUN_SCAN_AZ
            dw = np.array([math.cos(el) * math.sin(az), math.sin(el),
                           math.cos(el) * math.cos(az)], np.float32)
            entry = {'elevation_deg': round(math.degrees(el), 2),
                     'azimuth_deg': round(math.degrees(az), 2),
                     'sd': None, 'L': None, 'note': ''}
            scan.append(entry)
            cosn = np.clip(normal @ dw, 0.0, None).astype(np.float64)
            vdir = np.clip(alpha + beta @ dw, 0.0, 1.0).astype(np.float64)
            S = cosn * vdir
            band = (cosn > 0.35) & (cosn < 0.95)
            pos = S > 0
            if not pos.any():
                entry['note'] = 'S 全 0'
                continue
            lit = band & (S > np.percentile(S[pos], 70))
            sha = band & (S < np.percentile(S[pos], 30))
            if lit.sum() < 2000 or sha.sum() < 2000:
                entry['note'] = '样本不足'
                continue
            # 掩码只抽一次:二分的每次中位都在小数组上算(同一批元素,
            # 数值与全图掩码逐位相同;实测把扫描从 ~17s 压到量级更低)
            il_l, el_l, s_l = Il[lit], El[lit], S[lit]
            il_s, el_s, s_s = Il[sha], El[sha], S[sha]

            def ratio(v: float) -> float:
                bl = il_l / np.maximum(el_l + v * s_l, 1e-6)
                bs = il_s / np.maximum(el_s + v * s_s, 1e-6)
                return float(np.median(bl) / max(np.median(bs), 1e-12))

            if ratio(0.0) <= 1.0:
                entry['note'] = '无正向反差'
                continue
            lo, hi = 0.0, 64.0
            while ratio(hi) > 1.0 and hi < 1e5:
                hi *= 2
            if ratio(hi) > 1.0:
                # 倍增到上限比值仍 >1:中位匹配无解,二分只会收敛到上限、
                # 记下一个没有意义的巨大 L。这种方向不参赛,评分表里写明。
                entry['note'] = '未收敛(中位匹配在 L≤1e5 内无解)'
                continue
            for _ in range(40):
                m = 0.5 * (lo + hi)
                if ratio(m) > 1.0:
                    lo = m
                else:
                    hi = m
            L = 0.5 * (lo + hi)
            b = Il / np.maximum(El + L * S, 1e-6)
            sd = float(np.std(np.log(np.maximum(b, 1e-9))))
            entry['sd'] = round(sd, 5)
            entry['L'] = round(L, 4)
            if best is None or sd < best['sd']:
                best = dict(sd=sd, dir=dw, el=math.degrees(el),
                            az=math.degrees(az), S=S, cosn=cosn)
        if progress:
            progress('sun', ie + 1, SUN_SCAN_EL)
    if best is None:
        return dict(found=False, note='没有任何方向能解出直射光(阴天/室内)',
                    dir=[0.0, 1.0, 0.0], radiance=[0.0, 0.0, 0.0],
                    std_before=sd0, std_after=sd0, drop=0.0, scan=scan)
    S = best['S']

    def cost(v: float) -> float:
        b = Il / np.maximum(El + v * S, 1e-6)
        return float(np.std(np.log(np.maximum(b, 1e-9))))

    lo, hi = 0.0, 64.0
    while cost(hi) < cost(hi * 0.5) and hi < 4096:
        hi *= 2
    for _ in range(60):
        p1 = lo + (hi - lo) * 0.382
        p2 = lo + (hi - lo) * 0.618
        if cost(p1) < cost(p2):
            hi = p2
        else:
            lo = p1
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
    # ⚠ 色度必须钳:方向不准时逐通道解会跑到边界,钳住让它露出来
    ch = np.clip(ch, *SUN_CHROMA_CLAMP)
    ch = ch / ch.mean()
    L = (lum * ch / max(float(ch @ lw), 1e-9)).astype(np.float32)
    sd = cost(lum)
    return dict(found=True, dir=[float(v) for v in best['dir']],
                elevation_deg=best['el'], azimuth_deg=best['az'],
                radiance=[float(v) for v in L], chroma=[float(v) for v in ch],
                std_before=sd0, std_after=sd, drop=float(1 - sd / max(sd0, 1e-9)),
                lit_frac=float(np.mean(vis > 0.8)), scan=scan)


# ================================================== 整体增益与曝光 §5.7/§5.11

def gather_gain_of(hdr: np.ndarray, e: np.ndarray) -> float:
    """尺度约定:k = p95(max_c(hdr/E)) 钳 [1, MAX],让 base 的 p95 落在 1。
    只是约定,不是对 base 的物理主张(base 是工程量不是 albedo)。"""
    ratio = (hdr / np.maximum(e, 1e-4)).max(-1)
    return float(np.clip(np.percentile(ratio, GATHER_GAIN_PERCENTILE),
                         1.0, GATHER_GAIN_MAX))


def exposure_of(e: np.ndarray) -> dict:
    """§5.11 每场景测量量。单位锚是定理(E=1 ⇒ 白面落显示 0.5),不进这里;
    这里只出这张画的相对读数。"""
    lum = e @ LUMA
    p50 = float(np.percentile(lum, 50))
    return {'ev_paint': float(math.log2(max(p50, 1e-9))),
            'e_p95': float(np.percentile(lum, 95))}
