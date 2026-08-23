"""实体空间数据（`char_volume.bin`）：密度、validity、dilation、打包。

## 为什么不能存标量

场景侧把法线烘进了产物（逐像素法线固定）；角色的法线**逐像素在变**。喂给它一个
标量等于把角色当成一块朝上的板（实测偏高 61% 且没方向性）。所以对钳位余弦做 L1
展开 `(N·ω)₊ ≈ ¼ + ½(N·ω)`，存 (a₀, a₁)。

## 五个通道

| 通道 | 内容 | 编码 |
|---|---|---|
| 0 | 天穹遮蔽 (a₀,a₁) | R=a₀，GBA=a₁·0.5+0.5 |
| 1 | 局部 AO (a₀,a₁) | 同上 |
| 2..4 | 烘焙 GI 的 RGB (a₀,a₁) | R=log2(a₀)，GBA=a₁/(4a₀)+0.5 |

GI 解码：`a₀=decode_log(R)`，`a₁=(GBA·2-1)·2·a₀`，`E(N)=a₀+a₁·N`。

⚠ GI 通道换一套编码是因为它是 HDR（灶口旁到几十），幅度走对数、方向分开存。
⚠ GI 通道**不是可选项**（除非 `--no-gi`）：场景侧默认 `gi=1`，角色若拿不到同一份
辐照度就只剩天光和灯 —— 未重打光的场景那两项都是 0，角色于是全黑。

## validity + dilation（必做）

新 tracer 对被埋格点给的是**精确的 0**（物理上对），而 41.6% 的格点是被埋的。
三线性会借到这些 0，把贴墙的角色压暗。dilation 用 6-邻域有效格点的均值填 invalid。
"""
from __future__ import annotations

import numpy as np

from . import const
from .gather import _sphere_quadrature
from .trace import trace_ao, trace_points, trace_points_radiance

GRID_CHANNELS = 5


def char_grid_for(world: np.ndarray, char_wu: float, band: float,
                  cells_xz: float = const.CHAR_VOL_CELLS_PER_CHAR_XZ,
                  cells_y: float = const.CHAR_VOL_CELLS_PER_CHAR_Y) -> tuple[int, int, int]:
    """按角色尺寸定格密度（不是按场景尺寸定）。

    要表达的结构（门洞、柱子、檐下、墙沿）是相对角色的。纵向给得更密：`V` 沿高度
    变化比沿水平快。超上限就三维等比降密度（开立方根）。
    """
    px_, py_, pz_ = (world[..., i].ravel() for i in range(3))
    sx = float(np.percentile(px_, 99) - np.percentile(px_, 1))
    sz = float(np.percentile(pz_, 99) - np.percentile(pz_, 1))
    y0 = float(np.percentile(py_, 2)) - 0.02
    y1 = max(float(np.percentile(py_, 60)) + band, y0 + band * 1.5)
    cell_xz = max(char_wu / cells_xz, 1e-4)
    cell_y = max(char_wu / cells_y, 1e-4)
    nx = max(4, int(round(sx / cell_xz)))
    nz = max(4, int(round(sz / cell_xz)))
    ny = max(4, int(round((y1 - y0) / cell_y)))
    total = nx * ny * nz
    if total > const.CHAR_VOL_MAX_CELLS:
        s = (const.CHAR_VOL_MAX_CELLS / total) ** (1.0 / 3.0)
        nx = max(4, int(nx * s)); ny = max(4, int(ny * s)); nz = max(4, int(nz * s))
    return nx, ny, nz


def char_grid_bounds(world: np.ndarray, band: float) -> dict:
    """网格 AABB：x/z 取 1–99 分位，y 覆盖「最低地面 → 较高地面 + 角色带」。

    ⚠ y 要覆盖地面起伏（起伏常常比角色还高），否则远处地面上的角色会落到网格外
    被钳到边界层。
    """
    px_, py_, pz_ = (world[..., i].ravel() for i in range(3))
    x0, x1 = np.percentile(px_, [1, 99])
    z0, z1 = np.percentile(pz_, [1, 99])
    y0 = float(np.percentile(py_, 2)) - 0.02
    y1 = max(float(np.percentile(py_, 60)) + band, y0 + band * 1.5)
    return {'x0': float(x0), 'x1': float(x1), 'y0': y0, 'y1': y1,
            'z0': float(z0), 'z1': float(z1)}


def _grid_points(bounds: dict, nx: int, ny: int, nz: int, R: np.ndarray):
    gx = np.linspace(bounds['x0'], bounds['x1'], nx)
    gy = np.linspace(bounds['y0'], bounds['y1'], ny)
    gz = np.linspace(bounds['z0'], bounds['z1'], nz)
    X, Y, Z = np.meshgrid(gx, gy, gz, indexing='ij')
    pts_world = np.stack([X.ravel(), Y.ravel(), Z.ravel()], -1).astype(np.float32)
    pts_q = (pts_world @ R).astype(np.float32)
    return pts_q, pts_world


def _compute_validity(pts_q: np.ndarray, depth: np.ndarray,
                      ppu: float, cx: float, cy: float) -> np.ndarray:
    """`invalid = pen₀ > MARCH_BIAS`（埋在可见壳后面）。"""
    h, w = depth.shape
    px = pts_q[:, 0] * ppu + cx
    py = cy - pts_q[:, 1] * ppu
    xi = np.clip(np.rint(px), 0, w - 1).astype(np.int32)
    yi = np.clip(np.rint(py), 0, h - 1).astype(np.int32)
    in_frame = (px >= 0) & (px < w - 1) & (py >= 0) & (py < h - 1)
    pen = pts_q[:, 2] - depth[yi, xi]
    invalid = in_frame & (pen > const.MARCH_BIAS)
    return ~invalid


def _dilate(a0: np.ndarray, a1: np.ndarray, valid: np.ndarray,
            max_iter: int | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray, int]:
    """反复用 6-邻域有效格点的均值填 invalid，直到没有 invalid 与 valid 相邻。

    a0: (nch, nx, ny, nz)，a1: (nch, nx, ny, nz, 3)，valid: (nx, ny, nz)。
    返回 (a0, a1, valid, 迭代次数)。"""
    valid = valid.copy()
    a0 = a0.copy().astype(np.float64)
    a1 = a1.copy().astype(np.float64)
    nch = a0.shape[0]
    if max_iter is None:
        max_iter = max(200, sum(valid.shape))
    iters = 0
    for _ in range(max_iter):
        cnt = np.zeros(valid.shape, np.int16)
        sum0 = np.zeros(a0.shape, np.float64)
        sum1 = np.zeros(a1.shape, np.float64)
        for ax in range(3):
            for off in (-1, 1):
                src = [slice(None)] * 3
                dst = [slice(None)] * 3
                if off == -1:
                    dst[ax] = slice(1, None); src[ax] = slice(0, -1)
                else:
                    dst[ax] = slice(0, -1); src[ax] = slice(1, None)
                nv = np.zeros(valid.shape, bool)
                nv[tuple(dst)] = valid[tuple(src)]
                cnt += nv
                n0 = np.zeros(a0.shape)
                n0[(slice(None),) + tuple(dst)] = a0[(slice(None),) + tuple(src)]
                sum0 += nv[None] * n0
                n1 = np.zeros(a1.shape)
                n1[(slice(None),) + tuple(dst)] = a1[(slice(None),) + tuple(src)]
                sum1 += nv[None, ..., None] * n1
        fill = (~valid) & (cnt > 0)
        if not fill.any():
            break
        a0[:, fill] = sum0[:, fill] / cnt[fill]
        a1[:, fill] = sum1[:, fill] / cnt[fill][..., None]
        valid[fill] = True
        iters += 1
    return a0, a1, valid, iters


def bake_char_volume(depth: np.ndarray, R: np.ndarray, ppu: float, cx: float, cy: float,
                     world: np.ndarray, band: float, hdr: np.ndarray, sky_of,
                     char_wu: float, no_gi: bool = False,
                     grid: tuple[int, int, int] | None = None,
                     char_spp: int = const.CHAR_VOL_SPP) -> dict:
    """3D 方向性传输网格（L1 / bent-normal 形式）。见模块 docstring。"""
    nx, ny, nz = grid if grid is not None else char_grid_for(world, char_wu, band)
    bounds = char_grid_bounds(world, band)
    pts_q, _ = _grid_points(bounds, nx, ny, nz, R)
    n_pts = len(pts_q)
    nch = GRID_CHANNELS if not no_gi else 2

    # ---- 通道 0：天穹遮蔽，走 `trace_points`（与场景侧逐字同一条射线）----
    sky_a0, sky_a1 = trace_points(pts_q, R, depth, ppu, cx, cy, spp=char_spp)
    a0 = np.zeros((nch, n_pts), np.float64)
    a1 = np.zeros((nch, n_pts, 3), np.float64)
    a0[0] = sky_a0
    a1[0] = sky_a1

    # ---- 通道 1：局部 AO（短程、全球面，march 走唯一的 `trace_ao`）----
    ao_dirs = _sphere_quadrature(12, 8)
    ao_m0 = np.zeros(n_pts, np.float64)
    ao_m1 = np.zeros((n_pts, 3), np.float64)
    ao_norm = 0.0
    for dw, w in ao_dirs:
        dq = (R.T @ dw).astype(np.float32)
        vis = trace_ao(pts_q, np.broadcast_to(dq, pts_q.shape), depth, ppu, cx, cy).astype(np.float64)
        ao_m0 += w * vis
        ao_m1 += (w * vis)[:, None] * dw[None, :].astype(np.float64)
        ao_norm += w
    # 无遮挡时 AO(N)=1 方向无关 ⇒ a₀=⟨vis⟩（全球面均值）、a₁=2⟨vis·ω⟩。
    a0[1] = ao_m0 / max(ao_norm, 1e-9)
    a1[1] = 2.0 * ao_m1 / max(ao_norm, 1e-9)

    # ---- 通道 2..4：烘焙 GI（全球面、不截断、与场景侧同一份辐照度）----
    gi_a0 = np.zeros((n_pts, 3), np.float32)
    gi_a1 = np.zeros((n_pts, 3, 3), np.float32)
    if not no_gi:
        gi_a0, gi_a1 = trace_points_radiance(pts_q, R, depth, ppu, cx, cy, hdr, sky_of,
                                             spp=char_spp)
    a0[2:5] = gi_a0.T
    a1[2:5] = gi_a1.transpose(1, 0, 2)

    # ---- validity + dilation ----
    valid = _compute_validity(pts_q, depth, ppu, cx, cy)
    coverage = float(valid.mean())
    # 先升到 3D 网格做 dilation，再拍回 (nch, n_pts) 打包
    a0d = a0.reshape(nch, nx, ny, nz)
    a1d = a1.reshape(nch, nx, ny, nz, 3)
    validd = valid.reshape(nx, ny, nz)
    a0d, a1d, validd, dil_iters = _dilate(a0d, a1d, validd)
    a0 = a0d.reshape(nch, n_pts)
    a1 = a1d.reshape(nch, n_pts, 3)

    a0 = a0.astype(np.float32)
    a1 = a1.astype(np.float32)

    # ---- RGBA8 打包 ----
    packed = np.empty((nch, n_pts, 4), np.uint8)
    # 天穹 / AO：R=a₀，GBA=a₁·0.5+0.5（a₁ ∈ [-1,1]）
    packed[0:2, :, 0] = np.round(np.clip(a0[0:2], 0.0, 1.0) * 255.0)
    packed[0:2, :, 1:] = np.round(np.clip(a1[0:2] * 0.5 + 0.5, 0.0, 1.0) * 255.0)

    gi_scale, gi_span = 1.0, const.HDR_LOG_SPAN_MIN
    if not no_gi:
        from .encode import pick_log_params, encode_log_hdr, decode_log_hdr
        g0 = np.maximum(a0[2:5], 0.0)
        g1 = a1[2:5]
        gi_scale, gi_span = pick_log_params(g0)
        packed[2:5, :, 0] = encode_log_hdr(g0, gi_scale, gi_span)
        rel = g1 / np.maximum(g0, 1e-6)[..., None] * 0.5        # → [-1,1] 名义
        packed[2:5, :, 1:] = np.round(np.clip(rel * 0.5 + 0.5, 0.0, 1.0) * 255.0)

        # ---- 编解码自检（GI 通道与其余通道编码不同，任一处漂了只是整体偏掉）----
        dec_a0 = decode_log_hdr(packed[2:5, :, 0], gi_scale, gi_span)
        dec_rel = (packed[2:5, :, 1:].astype(np.float32) / 255.0 - 0.5) * 2.0
        dec_a1 = dec_rel * 2.0 * dec_a0[..., None]
        up_v = np.array([0.0, 1.0, 0.0], np.float32)
        ref = g0 + g1 @ up_v
        got = dec_a0 + dec_a1 @ up_v
        typ = max(float(np.median(np.abs(ref))), 1e-6)
        gi_err = float(np.percentile(np.abs(got - ref) / (np.abs(ref) + typ), 99))
    else:
        gi_err = 0.0

    packed = packed.reshape(nch, nx, ny, nz, 4)

    # ---- 自检：无遮挡格点复现解析真值 ----
    up = np.array([0.0, 1.0, 0.0], np.float32)
    t_up = a0[0] + a1[0] @ up
    horiz = np.array([0.0, 0.0, 1.0], np.float32)
    t_hz = a0[0] + a1[0] @ horiz
    k = max(1, len(t_up) // 100)
    open_idx = np.argsort(t_up)[-k:]

    return {
        'packed': packed,
        'bounds': bounds,
        'grid': {'nx': nx, 'ny': ny, 'nz': nz},
        'gi_scale': float(gi_scale), 'gi_span': float(gi_span),
        'validity_coverage': coverage,
        'dilation_iters': dil_iters,
        'a0': a0.reshape(nch, nx, ny, nz),
        'a1': a1.reshape(nch, nx, ny, nz, 3),
        'valid': validd,
        'selfcheck': {
            'gi_codec_p99_rel': gi_err,
            'open_T_up': float(t_up[open_idx].mean()),
            'open_T_horizontal': float(t_hz[open_idx].mean()),
            'open_a0': float(a0[0][open_idx].mean()),
            'T_up_min': float(t_up.min()), 'T_up_max': float(t_up.max()),
            'T_up_mean': float(t_up.mean()),
        },
    }


def sample_transfer(a0: np.ndarray, a1: np.ndarray, bounds: dict,
                    nx: int, ny: int, nz: int, pts_world: np.ndarray,
                    channel: int) -> tuple[np.ndarray, np.ndarray]:
    """三线性采样某通道的 (a₀, a₁)（与运行时 `ucSkyAt` 逐字同一套，clamp 到边界）。

    a0: (nch,nx,ny,nz)，a1: (nch,nx,ny,nz,3)。返回 (a0, a1) 各 (N,) / (N,3)。
    """
    lo = np.array([bounds['x0'], bounds['y0'], bounds['z0']], np.float32)
    hi = np.array([bounds['x1'], bounds['y1'], bounds['z1']], np.float32)
    n = np.array([nx, ny, nz], np.float32)
    t = np.clip((pts_world - lo) / np.maximum(hi - lo, 1e-5), 0.0, 1.0)
    f = t * (n - 1.0)
    i0 = np.floor(f).astype(np.int32)
    fr = (f - i0).astype(np.float32)
    nmax = np.array([nx, ny, nz], np.int32) - 1
    i0 = np.clip(i0, 0, nmax)
    i1 = np.minimum(i0 + 1, nmax)

    def corner(ix, iy, iz):
        return (a0[channel, ix, iy, iz], a1[channel, ix, iy, iz])

    c000, d000 = corner(i0[:, 0], i0[:, 1], i0[:, 2])
    c100, d100 = corner(i1[:, 0], i0[:, 1], i0[:, 2])
    c010, d010 = corner(i0[:, 0], i1[:, 1], i0[:, 2])
    c110, d110 = corner(i1[:, 0], i1[:, 1], i0[:, 2])
    c001, d001 = corner(i0[:, 0], i0[:, 1], i1[:, 2])
    c101, d101 = corner(i1[:, 0], i0[:, 1], i1[:, 2])
    c011, d011 = corner(i0[:, 0], i1[:, 1], i1[:, 2])
    c111, d111 = corner(i1[:, 0], i1[:, 1], i1[:, 2])

    fx, fy, fz = fr[:, 0], fr[:, 1], fr[:, 2]
    a0x00 = c000 + (c100 - c000) * fx
    a0x10 = c010 + (c110 - c010) * fx
    a0x01 = c001 + (c101 - c001) * fx
    a0x11 = c011 + (c111 - c011) * fx
    a0xy0 = a0x00 + (a0x10 - a0x00) * fy
    a0xy1 = a0x01 + (a0x11 - a0x01) * fy
    a0s = a0xy0 + (a0xy1 - a0xy0) * fz

    d = [d000, d100, d010, d110, d001, d101, d011, d111]
    def tril(v0, v1, v2, v3, v4, v5, v6, v7):
        x00 = v0 + (v1 - v0) * fx[..., None]
        x10 = v2 + (v3 - v2) * fx[..., None]
        x01 = v4 + (v5 - v4) * fx[..., None]
        x11 = v6 + (v7 - v6) * fx[..., None]
        xy0 = x00 + (x10 - x00) * fy[..., None]
        xy1 = x01 + (x11 - x01) * fy[..., None]
        return xy0 + (xy1 - xy0) * fz[..., None]
    a1s = tril(*d)

    return a0s.astype(np.float32), a1s.astype(np.float32)
