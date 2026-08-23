"""tracer 全部集中在这里，**两条 march、各只有一份代码**：

1. `trace_rays` —— §5.4 的「唯一 tracer」（长程、不截断）。`trace_pixels`（入口 A）/
   `trace_points`（入口 B）/ `trace_points_radiance`（GI 通道）三个入口共用同一段 march。
2. `trace_ao` —— §5.8 的 AO 短程 march（`AO_LENGTH=0.25` 的截断是**设计不是 bug**）。
   场景侧 `bake_local_ao` 与体数据 AO 通道都走它。

两条是**两个不同的问题**（看得见多少天 vs 有多封闭），§5.8 明确不可混用。

## `trace_rays` 的终止条件（三个，全精确，**没有射程参数**）

```
1. 命中：  bias < pen < MARCH_THICKNESS          穿透进可见壳
2. 出画：  sx ∉ [0, w-1)  或  sy ∉ [0, h-1)
3. 前穿：  q_z ≤ d_min - 1e-3                    深度跑到全场景最前，再也不可能打中
```

⚠ **`MARCH_LENGTH` 这个概念在新 baker 里不存在。** 离线计算没有任何理由截断。
实测旧法（96 方向均匀求积 + 2.4 截断）偏差 0.1346 > MC 16spp 噪声 0.1120。

⚠ **出画语义：出画即逃逸，不做任何启发式。** 曾经有个 `inside` 门（出画默认未被挡），
室内画幅填满墙面时射线从侧边出画照样算「看见天」，室内 `corr(log亮度, T₀)` 变成负的。
现在零自由参数，让数据决定。

## 入口 A：`trace_pixels` —— 从每个像素表面出发

有法线 ⇒ 余弦重要性采样，`pdf ∝ (N·ω)₊/π` ⇒ 估计量就是样本的算术平均。

## 入口 B：`trace_points` —— 从任意空间点出发

没有法线 ⇒ **均匀上半球采样**（pdf = 1/2π），结果对任意运行时法线求值。

契约测试（`tests/test_trace.py`）：同一批点、同一批**给定**方向，两个入口必须给出
**逐位相同**的逃逸判定。这条是「角色贴得住背景」的构造性保证。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from . import const


@dataclass
class GatherResult:
    """`trace_pixels` 一趟出的四个量（同一个积分的不同投影）。"""

    e: np.ndarray          # (h,w,3) 余弦加权均值辐照度
    vis: np.ndarray        # (h,w)   天穹可见度 V = ⟨esc∧up⟩/cap₀(N)
    bent: np.ndarray       # (h,w,3) bent 方向（平均未遮挡方向）
    vfit: np.ndarray       # (h,w,4) 可见度线性重建 (a, b)


def trace_rays(pts_q: np.ndarray, dirs_q: np.ndarray, depth: np.ndarray,
               R: np.ndarray, ppu: float, cx: float, cy: float,
               sky_rad: np.ndarray | None = None,
               hdr: np.ndarray | None = None,
               seed: int = const.GATHER_SEED) -> tuple[np.ndarray, np.ndarray | None]:
    """**唯一的射线推进核心**。两个入口都调用它。

    参数
    ----
    pts_q : (N,3) 起点（q 空间：屏幕对齐 + 深度）。
    dirs_q : (N,3) 方向（q 空间，未归一没关系 —— 只按 t 参数推进）。
    sky_rad / hdr : 给则返回逐射线辐射（命中 = hdr[命中像素]，逃逸 = sky_rad）。

    返回
    ----
    escaped : (N,) bool，True = 逃逸。
    rad : (N,3) float32 或 None（未给 sky_rad/hdr 时）。
    """
    N = len(pts_q)
    Q = np.ascontiguousarray(pts_q, np.float32)
    D = np.ascontiguousarray(dirs_q, np.float32)
    dep = np.ascontiguousarray(depth, np.float32)
    step = np.float32(const.GATHER_STEP_PX / ppu)
    bias = np.float32(const.MARCH_BIAS)
    grow = np.float32(const.MARCH_BIAS_GROWTH)
    thickness = np.float32(const.MARCH_THICKNESS)
    dmin = float(dep.min())
    h, w = dep.shape

    ox, oy, oz = Q[:, 0].copy(), Q[:, 1].copy(), Q[:, 2].copy()
    dx, dy, dz = D[:, 0].copy(), D[:, 1].copy(), D[:, 2].copy()
    rad = None
    if sky_rad is not None and hdr is not None:
        rad = np.ascontiguousarray(sky_rad, np.float32).copy()
        img = hdr.astype(np.float32)
    escaped = np.ones(N, np.bool_)
    idx = np.arange(N)
    tc = np.zeros(N, np.float32)

    while idx.size:
        tc += step
        zq = oz + dz * tc
        sx = (ox + dx * tc) * ppu + cx
        sy = cy - (oy + dy * tc) * ppu
        keep = ((sx >= 0) & (sx < w - 1) & (sy >= 0) & (sy < h - 1)
                & (zq > dmin - 1e-3))
        if not keep.all():
            idx = idx[keep]
            if idx.size == 0:
                break
            ox, oy, oz, dx, dy, dz, tc = (a[keep] for a in (ox, oy, oz, dx, dy, dz, tc))
            zq, sx, sy = zq[keep], sx[keep], sy[keep]
        xi = np.rint(sx).astype(np.int32)
        yi = np.rint(sy).astype(np.int32)
        pen = zq - dep[yi, xi]
        hit = (pen > bias + grow * tc) & (pen < thickness)
        if hit.any():
            hid = idx[hit]
            escaped[hid] = False
            if rad is not None:
                rad[hid] = img[yi[hit], xi[hit]]
            k = ~hit
            idx = idx[k]
            if idx.size == 0:
                break
            ox, oy, oz, dx, dy, dz, tc = (a[k] for a in (ox, oy, oz, dx, dy, dz, tc))
    return escaped, (rad if rad is not None else None)


def _pixel_ray_escape(q: np.ndarray, dq: np.ndarray, depth: np.ndarray,
                      R: np.ndarray, ppu: float, cx: float, cy: float) -> np.ndarray:
    """入口 A 的射线逃逸判定（薄包装，`trace_rays` 的一个子集）。"""
    escaped, _ = trace_rays(q, dq, depth, R, ppu, cx, cy)
    return escaped


def _point_ray_escape(pts_q: np.ndarray, dq: np.ndarray, depth: np.ndarray,
                      R: np.ndarray, ppu: float, cx: float, cy: float) -> np.ndarray:
    """入口 B 的射线逃逸判定（薄包装，`trace_rays` 的一个子集）。"""
    escaped, _ = trace_rays(pts_q, dq, depth, R, ppu, cx, cy)
    return escaped


def trace_pixels(q: np.ndarray, normal: np.ndarray, R: np.ndarray,
                 ppu: float, cx: float, cy: float, hdr: np.ndarray, sky_of,
                 spp: int = const.GATHER_SPP,
                 seed: int = const.GATHER_SEED) -> GatherResult:
    """伪世界 final gather —— 蒙特卡洛 + 余弦重要性采样 + 不截断射线。

        E(x) = ∫ L_in(x,ω)(N·ω)₊ dω ÷ ∫ (N·ω)₊ dω
        L_in = HDR 原画(命中点) / 天空(ω)(逃逸)

    按 `pdf ∝ (N·ω)₊/π` 采样，估计量就是样本算术平均。同一趟顺带出天穹可见度
    `V`、bent 方向 `Bdir`、可见度线性重建 `vfit`（同一批光线做加权最小二乘）。
    """
    h, w = q.shape[:2]
    P = h * w
    Nf = normal.reshape(-1, 3).astype(np.float32)
    Q = q.reshape(-1, 3).astype(np.float32)
    Rf = R.astype(np.float32)

    # 逐像素切线基（世界系，法线为 +Z）
    upv = np.where(np.abs(Nf[:, 1:2]) < 0.9,
                   np.array([[0.0, 1.0, 0.0]], np.float32),
                   np.array([[1.0, 0.0, 0.0]], np.float32))
    TA = np.cross(upv, Nf)
    TA /= np.maximum(np.linalg.norm(TA, axis=1, keepdims=True), 1e-8)
    TA = TA.astype(np.float32)
    TB = np.cross(Nf, TA).astype(np.float32)

    rng = np.random.default_rng(seed)
    acc = np.zeros((P, 3), np.float64)
    vis_num = np.zeros(P, np.float64)
    bent = np.zeros((P, 3), np.float64)
    # 可见度线性重建的样本矩
    m_s1 = np.zeros((P, 3), np.float64)
    m_s2 = np.zeros((P, 6), np.float64)          # 对称阵上三角 xx,yy,zz,xy,xz,yz
    m_t0 = np.zeros(P, np.float64)
    m_t1 = np.zeros((P, 3), np.float64)

    for s in range(spp):
        # 分层（ξ₁ 跨样本）+ 逐像素抖动的余弦重要性采样
        u1 = ((s + rng.random(P)) / spp).astype(np.float32)
        u2 = rng.random(P).astype(np.float32)
        r = np.sqrt(u1)
        phi = np.float32(2.0 * math.pi) * u2
        dw = (TA * (r * np.cos(phi))[:, None] + TB * (r * np.sin(phi))[:, None]
              + Nf * np.sqrt(np.maximum(1.0 - u1, 0.0))[:, None])
        # world = q @ R.T ⇒ 方向变换 dq = dw @ R（R 正交，转置即逆）
        dq = dw @ Rf
        sky = sky_of(dw).astype(np.float32)
        escaped, rad = trace_rays(Q, dq, q[..., 2], R, ppu, cx, cy, sky_rad=sky, hdr=hdr)
        acc += rad
        up_esc = escaped & (dw[:, 1] > 0.0)
        vis_num += up_esc
        bent += up_esc[:, None] * dw
        e64 = escaped.astype(np.float64)
        m_s1 += dw
        m_s2[:, 0] += dw[:, 0] * dw[:, 0]; m_s2[:, 1] += dw[:, 1] * dw[:, 1]
        m_s2[:, 2] += dw[:, 2] * dw[:, 2]; m_s2[:, 3] += dw[:, 0] * dw[:, 1]
        m_s2[:, 4] += dw[:, 0] * dw[:, 2]; m_s2[:, 5] += dw[:, 1] * dw[:, 2]
        m_t0 += e64
        m_t1 += e64[:, None] * dw

    e = (acc / spp).reshape(h, w, 3).astype(np.float32)
    cap0 = np.maximum((1.0 + Nf[:, 1]) * 0.5, 1.0 / 255.0)
    vis = np.clip(vis_num / spp / cap0, 0.0, 1.0).reshape(h, w).astype(np.float32)
    bn = bent / np.maximum(np.linalg.norm(bent, axis=1, keepdims=True), 1e-9)
    dead = np.linalg.norm(bent, axis=1) < 1e-9
    bn[dead] = Nf[dead]
    bn = bn.reshape(h, w, 3).astype(np.float32)

    # 可见度线性重建：逐像素解 4×4（岭正则 1e-3·spp 对角）
    A = np.empty((P, 4, 4), np.float64)
    A[:, 0, 0] = spp
    A[:, 0, 1:] = m_s1; A[:, 1:, 0] = m_s1
    A[:, 1, 1] = m_s2[:, 0]; A[:, 2, 2] = m_s2[:, 1]; A[:, 3, 3] = m_s2[:, 2]
    A[:, 1, 2] = A[:, 2, 1] = m_s2[:, 3]
    A[:, 1, 3] = A[:, 3, 1] = m_s2[:, 4]
    A[:, 2, 3] = A[:, 3, 2] = m_s2[:, 5]
    rhs = np.empty((P, 4), np.float64)
    rhs[:, 0] = m_t0; rhs[:, 1:] = m_t1
    A[:, 1, 1] += 1e-3 * spp; A[:, 2, 2] += 1e-3 * spp; A[:, 3, 3] += 1e-3 * spp
    vfit = np.linalg.solve(A, rhs[..., None])[..., 0].astype(np.float32).reshape(h, w, 4)

    # 出锅后高斯滤波；Bdir 滤完重新归一
    from scipy.ndimage import gaussian_filter
    vis = gaussian_filter(vis, 0.8)
    for c in range(3):
        bn[..., c] = gaussian_filter(bn[..., c], 0.8)
        e[..., c] = gaussian_filter(e[..., c], 0.8)
    for c in range(4):
        vfit[..., c] = gaussian_filter(vfit[..., c], 0.8)
    bn /= np.maximum(np.linalg.norm(bn, axis=-1, keepdims=True), 1e-9)
    return GatherResult(e=e, vis=np.clip(vis, 0, 1), bent=bn.astype(np.float32), vfit=vfit)


def trace_points(pts_q: np.ndarray, R: np.ndarray, depth: np.ndarray,
                 ppu: float, cx: float, cy: float,
                 spp: int = const.CHAR_VOL_SPP,
                 seed: int = const.GATHER_SEED) -> tuple[np.ndarray, np.ndarray]:
    """任意一批空间点的天穹可见度矩 —— 与 `trace_pixels` 逐字同一条射线。

        M₀ = ∫_{ω·up>0} V(ω) dω       M₁ = ∫_{ω·up>0} V(ω)·ω dω
        a₀ = M₀/4π = ⟨esc⟩/2          a₁ = M₁/2π = ⟨esc·ω⟩
        T(N) = a₀ + a₁·N              V(N) = T(N)/cap₀(N)

    无遮挡时 a₀=0.5、a₁=(0,½,0) ⇒ T(up)=1，构造性精确。均匀上半球采样（pdf=1/2π）。
    """
    P = len(pts_q)
    if P == 0:
        return np.zeros(0, np.float32), np.zeros((0, 3), np.float32)
    Rf = np.asarray(R, np.float32)
    rng = np.random.default_rng(seed)
    m0 = np.zeros(P, np.float64)
    m1 = np.zeros((P, 3), np.float64)
    for s in range(spp):
        u1 = ((s + rng.random(P)) / spp).astype(np.float32)
        u2 = rng.random(P).astype(np.float32)
        mu = u1
        sr = np.sqrt(np.maximum(1.0 - mu * mu, 0.0))
        phi = np.float32(2.0 * math.pi) * u2
        dw = np.stack([sr * np.cos(phi), mu, sr * np.sin(phi)], 1).astype(np.float32)
        dq = dw @ Rf
        escaped, _ = trace_rays(pts_q, dq, depth, R, ppu, cx, cy)
        e64 = escaped.astype(np.float64)
        m0 += e64
        m1 += e64[:, None] * dw
    a0 = (m0 / spp) * (2.0 * math.pi) / (4.0 * math.pi)
    a1 = (m1 / spp) * (2.0 * math.pi) / (2.0 * math.pi)
    return a0.astype(np.float32), a1.astype(np.float32)


def trace_points_radiance(pts_q: np.ndarray, R: np.ndarray, depth: np.ndarray,
                          ppu: float, cx: float, cy: float,
                          hdr: np.ndarray, sky_of,
                          spp: int = const.CHAR_VOL_SPP,
                          seed: int = const.GATHER_SEED) -> tuple[np.ndarray, np.ndarray]:
    """空间点的**全球面**辐照度矩（GI 通道用）。与 `trace_points` 同一条射线核心。

        a₀ = ⟨L⟩        （全球面均匀采样的均值）
        a₁ = 2·⟨L·ω⟩    L = HDR(命中) / 天空(逃逸)
        E(N) = a₀ + a₁·N

    与场景侧 `E = ∫L(N·ω)₊/∫(N·ω)₊` 是同一个量在 L1 基下的展开（对 (N·ω)₊ 做
    `¼ + ½(N·ω)` 展开 ⇒ a₀=⟨L⟩、a₁=2⟨L·ω⟩）。
    """
    P = len(pts_q)
    if P == 0:
        return np.zeros((0, 3), np.float32), np.zeros((0, 3, 3), np.float32)
    Rf = np.asarray(R, np.float32)
    rng = np.random.default_rng(seed)
    a0 = np.zeros((P, 3), np.float64)
    a1 = np.zeros((P, 3, 3), np.float64)
    for s in range(spp):
        u1 = ((s + rng.random(P)) / spp).astype(np.float32)
        u2 = rng.random(P).astype(np.float32)
        # 全球面均匀采样：μ = ω·up ∈ [-1,1]
        mu = u1 * 2.0 - 1.0
        sr = np.sqrt(np.maximum(1.0 - mu * mu, 0.0))
        phi = np.float32(2.0 * math.pi) * u2
        dw = np.stack([sr * np.cos(phi), mu, sr * np.sin(phi)], 1).astype(np.float32)
        dq = dw @ Rf
        sky = sky_of(dw).astype(np.float32)
        escaped, rad = trace_rays(pts_q, dq, depth, R, ppu, cx, cy, sky_rad=sky, hdr=hdr)
        a0 += rad
        a1 += rad[:, :, None] * dw[:, None, :]
    a0 = (a0 / spp).astype(np.float32)
    a1 = (2.0 * a1 / spp).astype(np.float32)
    return a0, a1


def trace_ao(origins_q: np.ndarray, dirs_q: np.ndarray, depth: np.ndarray,
             ppu: float, cx: float, cy: float,
             length: float = const.AO_LENGTH,
             steps: int = const.AO_STEPS) -> np.ndarray:
    """**唯一的** AO 短程 march（§5.8）：逐点版本，返回 1 = 未被挡。

    ⚠ 这是与 `trace_rays` **刻意不同**的第二条 march：AO 问的是「局部封闭度」，
    `AO_LENGTH=0.25` 的截断是**设计不是 bug**（§5.8 原文）。它与长程天穹 tracer 是
    两个不同的问题，不可混用。场景侧 `bake_local_ao` 与体数据 AO 通道都走这里。

    ⚠ 出画语义：出画一律算**未被挡**。我们看不到画幅外 ≠ 这个点更封闭，而且 AO
    只走 0.25 q，能出画的只有紧贴边框那一圈。
    """
    h, w = depth.shape
    N = len(origins_q)
    blocked = np.zeros(N, np.bool_)
    step = length / steps
    for i in range(1, steps + 1):
        t = step * i
        px = (origins_q[:, 0] + dirs_q[:, 0] * t) * ppu + cx
        py = cy - (origins_q[:, 1] + dirs_q[:, 1] * t) * ppu
        inside = (px >= 0) & (px < w) & (py >= 0) & (py < h)
        xi = np.clip(np.rint(px), 0, w - 1).astype(np.int32)
        yi = np.clip(np.rint(py), 0, h - 1).astype(np.int32)
        pen = (origins_q[:, 2] + dirs_q[:, 2] * t) - depth[yi, xi]
        bias = const.MARCH_BIAS + const.MARCH_BIAS_GROWTH * t
        blocked |= inside & (pen > bias) & (pen < const.MARCH_THICKNESS)
    return ~blocked
