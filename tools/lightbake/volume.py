"""实体空间数据 `char_volume.bin`(方案 §5.9)。

极限一致性(§5.9 三铁律,验收令 §6.3 的结构手段):

1. 同一被估对象:每个空间点的 vis(ω),由唯一 tracer 定义;
2. 同一表示与求值:体网格通道 0 与逐像素 `sky_moments.png` 存的都是 (a₀,a₁),
   V/Bdir/V_dir 由同一组闭式导出;
3. 同一估计器:天穹矩直接调 `gather.sky_moments` —— **与场景逐像素同一个函数**、
   同一采样器、位置哈希种子、同一 spp ⇒ 格点落在表面点上时与像素逐位相同(自检 #13)。

AO 与 GI 共享**一次**全球面全记录 trace(§5.4「一次 trace 带回一切」):
GI 从 `hit_yx` 取辐射,AO = 按 `t_hit ≤ AO_RANGE` 事后过滤(契约测试 7 的语义)。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .const import (AO_RANGE, CELLS_PER_CHAR_XZ, CELLS_PER_CHAR_Y,
                    CHAR_VOL_MAX_CELLS, CHAR_VOL_SPP, MOMENT_SPP)
from .encode import decode_log_hdr, encode_log_hdr, encode_moments, pick_log_params
from .gather import sky_moments
from .sampling import point_keys, uniform_sphere
from .trace import DepthField, buried, trace

UP = np.array([0.0, 1.0, 0.0], np.float32)

#: 通道数与含义(§5.9):0 天穹矩 / 1 局部 AO 矩 / 2..4 烘焙 GI 的 RGB 矩。
CHANNELS = ('sky_moments', 'ao_moments', 'gi_r', 'gi_g', 'gi_b')


@dataclass
class VolumeGiCache:
    """§5.12 同一套缓存机制在体数据上的对应物(GUI 重估用,不落盘)。

    GI 对天空逐格线性:`m·_hit` 是命中半(march 一次定死),
    逃逸半按 `esc_mask` + 位置哈希重生成的方向重组。
    数组按**活格子集**(act)存 —— 被埋格点根本没 march(dilation 会覆盖)。
    """

    m0_hit: np.ndarray        # (n_act,3) float64 —— Σ rad/pdf 的命中部分
    m1_hit: np.ndarray        # (n_act,3,3) float64 —— Σ (rad/pdf)⊗ω 的命中部分
    esc_mask: np.ndarray      # (n_act,spp) bool
    act: np.ndarray           # (n,) bool —— 活格掩码(~buried)
    spp: int


def char_grid_for(world: np.ndarray, char_wu: float, band: float,
                  cells_xz: float = CELLS_PER_CHAR_XZ,
                  cells_y: float | None = None) -> tuple[tuple[int, int, int], dict]:
    """按角色高度定格密度(§5.9)。返回 ((nx,ny,nz), bounds)。

    `cells_xz` 即 CLI `--vol-density`(每角色高几格,横向);纵向缺省取 2 倍
    (V 沿高度变化比沿水平快,§9 的 3/6 配比)。
    """
    if cells_y is None:
        cells_y = cells_xz * (CELLS_PER_CHAR_Y / CELLS_PER_CHAR_XZ)
    px_, py_, pz_ = (world[..., i].ravel() for i in range(3))
    x0, x1 = (float(v) for v in np.percentile(px_, [1, 99]))
    z0, z1 = (float(v) for v in np.percentile(pz_, [1, 99]))
    y0 = float(np.percentile(py_, 2)) - 0.02
    y1 = max(float(np.percentile(py_, 60)) + band, y0 + band * 1.5)
    cell_xz = max(char_wu / cells_xz, 1e-4)
    cell_y = max(char_wu / cells_y, 1e-4)
    nx = max(4, int(round((x1 - x0) / cell_xz)))
    nz = max(4, int(round((z1 - z0) / cell_xz)))
    ny = max(4, int(round((y1 - y0) / cell_y)))
    total = nx * ny * nz
    if total > CHAR_VOL_MAX_CELLS:
        s = (CHAR_VOL_MAX_CELLS / total) ** (1.0 / 3.0)
        nx = max(4, int(nx * s))
        ny = max(4, int(ny * s))
        nz = max(4, int(nz * s))
    bounds = {'x0': x0, 'x1': x1, 'y0': y0, 'y1': y1, 'z0': z0, 'z1': z1}
    return (nx, ny, nz), bounds


def grid_points(grid: tuple[int, int, int], bounds: dict) -> np.ndarray:
    """格点世界坐标,(nx·ny·nz, 3) float32,C 序 (x, y, z)。"""
    nx, ny, nz = grid
    gx = np.linspace(bounds['x0'], bounds['x1'], nx)
    gy = np.linspace(bounds['y0'], bounds['y1'], ny)
    gz = np.linspace(bounds['z0'], bounds['z1'], nz)
    X, Y, Z = np.meshgrid(gx, gy, gz, indexing='ij')
    return np.stack([X.ravel(), Y.ravel(), Z.ravel()], -1).astype(np.float32)


# ------------------------------------------------------ validity + dilation

_SHIFTS = ((0, 1), (0, -1), (1, 1), (1, -1), (2, 1), (2, -1))


def _neighbor_fill(valid: np.ndarray, fields: list[np.ndarray],
                   max_iters: int = 64) -> tuple[np.ndarray, int]:
    """反复用 6-邻域**有效**格点的均值填 invalid,直到没有 invalid 与 valid
    相邻(或达上限)。AAA 探针体系的标准手段(Unity Dilation / UE validity):
    新 tracer 对被埋格点给的是精确 0,三线性会借到,把贴墙的角色压暗 ——
    不做就是把「精确的 0」直接漏进画面(§5.9,必做不是可选)。"""
    valid = valid.copy()
    it = 0
    while it < max_iters and not valid.all():
        cnt = np.zeros(valid.shape, np.float64)
        sums = [np.zeros(f.shape, np.float64) for f in fields]
        for axis, sgn in _SHIFTS:
            src = [slice(None)] * 3
            dst = [slice(None)] * 3
            if sgn > 0:
                src[axis] = slice(1, None)
                dst[axis] = slice(None, -1)
            else:
                src[axis] = slice(None, -1)
                dst[axis] = slice(1, None)
            src_t, dst_t = tuple(src), tuple(dst)
            vsrc = valid[src_t]
            cnt[dst_t] += vsrc
            w = vsrc.astype(np.float64)[..., None]   # 每方向转一次,不进字段循环
            for f, acc in zip(fields, sums, strict=True):
                acc[dst_t] += f[src_t] * w
        fill = (~valid) & (cnt > 0)
        if not fill.any():
            break
        for f, acc in zip(fields, sums, strict=True):
            c = cnt[fill]
            f[fill] = (acc[fill] / (c[:, None] if f.ndim == 4 else c)).astype(f.dtype)
        valid |= fill
        it += 1
    return valid, it


# ------------------------------------------------------------- 主入口

def bake_volume(world: np.ndarray, R: np.ndarray, field: DepthField,
                hdr_gained: np.ndarray, sky_of_gained, char_wu: float, band: float,
                *, spp: int = CHAR_VOL_SPP, no_gi: bool = False,
                cells_xz: float = CELLS_PER_CHAR_XZ,
                want_cache: bool = False,
                progress=None) -> dict:
    """烘一份实体空间数据。`hdr_gained` / `sky_of_gained` 必须已整体乘
    `gather_gain` —— 辐射场要和场景侧同一个尺度(§5.9:gain 逐场景 1–12,
    只乘一半会让角色逐场景偏亮/偏暗,极难查)。"""
    grid, bounds = char_grid_for(world, char_wu, band, cells_xz=cells_xz)
    nx, ny, nz = grid
    pts_w = grid_points(grid, bounds)
    pts_q = np.ascontiguousarray(pts_w @ R, np.float32)   # R 正交,转置即逆
    n = len(pts_q)

    # ---- validity 先判:被埋格点(实测 40–50%)**根本不 march** ----
    # 它们的值随后一律被 dilation 的有效邻居均值覆盖,先算就是算了扔
    # (效率审查);位置哈希种子保证子集与全量逐点逐位一致(契约 2)。
    inv = buried(pts_q, field)
    act = ~inv
    validity_coverage = float(act.mean())
    pts_act = np.ascontiguousarray(pts_q[act])
    n_act = len(pts_act)

    # ---- 通道 0:天穹矩 —— 与场景逐像素**同一个函数**(极限一致性铁律) ----
    # ⚠ spp 钉死 MOMENT_SPP(铁律 3:场景逐像素与体格点必须同值),
    #   形参 spp 只管 AO/GI 那趟。
    sky_a0 = np.zeros(n, np.float32)
    sky_a1 = np.zeros((n, 3), np.float32)
    sky_a0[act], sky_a1[act] = sky_moments(pts_act, R, field, spp=MOMENT_SPP,
                                           progress=progress)

    # ---- 通道 1 + 2..4:一次全球面全记录 trace,AO/GI 同时带回 ----
    keys = point_keys(pts_act)
    ao_m0 = np.zeros(n_act, np.float64)
    ao_m1 = np.zeros((n_act, 3), np.float64)
    gi_m0_hit = np.zeros((n_act, 3), np.float64)
    gi_m1_hit = np.zeros((n_act, 3, 3), np.float64)
    gi_m0_sky = np.zeros((n_act, 3), np.float64)
    gi_m1_sky = np.zeros((n_act, 3, 3), np.float64)
    esc_mask = np.empty((n_act, spp), np.bool_)
    for s in range(spp):
        dirs, pdf = uniform_sphere(keys, s, spp)
        # 采样器契约(§5.4):估计量统一 Σ f/pdf / n —— 不许把 pdf 写死成
        # 常数,换采样器时这里要自动跟上(审查纠正)。
        inv_pdf = 1.0 / pdf.astype(np.float64)
        d64 = dirs.astype(np.float64)
        # GI 的积分边界就是命中/出画/前穿三条精确终止 ⇒ max_distance=inf;
        # AO 的 r 是问题定义的一部分(§5.8),按 t_hit ≤ AO_RANGE 事后过滤
        # (语义 ≡ 显式截断,契约测试 7),一次 trace 两个消费者。
        res = trace(pts_act, dirs @ R, field, max_distance=math.inf)
        esc_mask[:, s] = res.escaped
        esc_ao = (res.escaped | (res.t_hit > AO_RANGE)).astype(np.float64)
        ao_m0 += esc_ao * inv_pdf
        ao_m1 += (esc_ao * inv_pdf)[:, None] * d64
        if not no_gi:
            hit = ~res.escaped
            rad = np.zeros((n_act, 3), np.float64)  # 非命中处恒 0,无需再掩码
            if hit.any():
                rad[hit] = hdr_gained[res.hit_yx[hit, 0], res.hit_yx[hit, 1]]
            contrib = rad * inv_pdf[:, None]
            gi_m0_hit += contrib
            gi_m1_hit += contrib[:, :, None] * d64[:, None, :]
            if res.escaped.any():
                srad = np.zeros((n_act, 3), np.float64)
                srad[res.escaped] = np.asarray(
                    sky_of_gained(dirs[res.escaped]), np.float64)
                scontrib = srad * inv_pdf[:, None]
                gi_m0_sky += scontrib
                gi_m1_sky += scontrib[:, :, None] * d64[:, None, :]
        if progress:
            progress('volume', s + 1, spp)

    # AO 矩:a₀ = M₀/4π = ⟨esc⟩ ∈ [0,1],a₁ = M₁/2π,无遮挡 ⇒ AO(N) ≡ 1
    ao_a0 = np.zeros(n, np.float32)
    ao_a1 = np.zeros((n, 3), np.float32)
    ao_a0[act] = (ao_m0 / spp / (4.0 * math.pi)).astype(np.float32)
    ao_a1[act] = (ao_m1 / spp / (2.0 * math.pi)).astype(np.float32)
    # GI 矩(逐色):a₀ = M₀/4π = ⟨L⟩,a₁ = M₁/2π;E(N) = a₀ + a₁·N,
    # 辐射恒为 L₀ 时 E ≡ L₀ —— 与场景侧 E 同一量纲(§5.5 的 ÷π 约定)。
    gi_a0 = np.zeros((n, 3), np.float32)
    gi_a1 = np.zeros((n, 3, 3), np.float32)
    gi_a0[act] = ((gi_m0_hit + gi_m0_sky) / spp / (4.0 * math.pi)
                  ).astype(np.float32)
    gi_a1[act] = ((gi_m1_hit + gi_m1_sky) / spp / (2.0 * math.pi)
                  ).astype(np.float32)

    # ---- dilation(必做,§5.9)----
    valid3 = (~inv).reshape(nx, ny, nz)
    # ⚠ 标量场也造成 (...,1) 形状:_neighbor_fill 原地写这些数组,
    #   `arr[..., None]` 这种**视图外的新数组**会让填充悄悄丢掉。
    f_sky0 = sky_a0.reshape(nx, ny, nz, 1).astype(np.float64)
    f_sky1 = sky_a1.reshape(nx, ny, nz, 3).astype(np.float64)
    f_ao0 = ao_a0.reshape(nx, ny, nz, 1).astype(np.float64)
    f_ao1 = ao_a1.reshape(nx, ny, nz, 3).astype(np.float64)
    f_gi0 = gi_a0.reshape(nx, ny, nz, 3).astype(np.float64)
    f_gi1 = gi_a1.reshape(nx, ny, nz, 3, 3).astype(np.float64).reshape(nx, ny, nz, 9)
    valid_after, dil_iters = _neighbor_fill(
        valid3, [f_sky0, f_sky1, f_ao0, f_ao1, f_gi0, f_gi1])
    # dilation 撞迭代上限时残留的 invalid 不许无声漏进产物(审查纠正):
    # 记进 meta,check #6 据此报警。
    residual_invalid = float(1.0 - valid_after.mean())
    sky_a0d = f_sky0.reshape(-1).astype(np.float32)
    sky_a1d = f_sky1.reshape(-1, 3).astype(np.float32)
    ao_a0d = f_ao0.reshape(-1).astype(np.float32)
    ao_a1d = f_ao1.reshape(-1, 3).astype(np.float32)
    gi_a0d = f_gi0.reshape(-1, 3).astype(np.float32)
    gi_a1d = f_gi1.reshape(-1, 3, 3).astype(np.float32)

    # ---- 打包:5 通道 × RGBA8,C 序 (channel, x, y, z, rgba) ----
    packed = np.empty((len(CHANNELS), n, 4), np.uint8)
    # 通道 0:与 sky_moments.png 逐字同一套编码(§4.2)
    packed[0] = encode_moments(sky_a0d, sky_a1d).reshape(n, 4)
    # 通道 1:AO 矩。a₀ 是全球面 M₀/4π ∈ [0,1](不是天穹的 [0,½]),
    # 所以 R 存 a₀ 本值。a₁ 的**期望**界 ±½,估计量硬界 |a₁| ≤ 2a₀
    # (φ 不分层的 MC 噪声可越 ±½,§5.4 采样口径)—— 钳位命中数记进自检。
    packed[1, :, 0] = np.round(np.clip(ao_a0d, 0.0, 1.0) * 255.0).astype(np.uint8)
    packed[1, :, 1:] = np.round(np.clip(ao_a1d + 0.5, 0.0, 1.0) * 255.0).astype(np.uint8)
    ao_a1_clamped = int((np.abs(ao_a1d) > 0.5 + 1e-6).sum())
    # 通道 2..4:GI。幅度走对数(HDR,§5.9),方向 GBA = a₁/(4a₀)+½。
    if no_gi or n_act == 0:
        # --no-gi(或全场被埋 n_act=0)的显式零约定:R=0、GBA=128(a₁=0);
        # scale/span 取定值,运行时凭 meta.no_gi 跳过 2..4 通道。绝不让
        # pick_log_params 的空输入回落值把 0 解码成 0.0625 底噪;
        # n_act=0 时编解码自检也没有被测物,一并置 None(复审纠正)。
        packed[2:, :, 0] = 0
        packed[2:, :, 1:] = 128
        gi_scale, gi_span = 1.0, 8.0
        gi_codec_p99 = None
    else:
        g0 = np.maximum(gi_a0d, 0.0)                   # (n,3)
        gi_scale, gi_span = pick_log_params(g0)
        for c in range(3):
            packed[2 + c, :, 0] = encode_log_hdr(g0[:, c], gi_scale, gi_span)
            rel = gi_a1d[:, c, :] / np.maximum(g0[:, c, None] * 4.0, 1e-6)
            packed[2 + c, :, 1:] = np.round(np.clip(rel + 0.5, 0.0, 1.0) * 255.0
                                            ).astype(np.uint8)
        # GI 编解码自检(§5.9:编码与其余通道不同,漂了不报错只 offset 亮度)
        dec0 = np.stack([decode_log_hdr(packed[2 + c, :, 0], gi_scale, gi_span)
                         for c in range(3)], 1)
        dec1 = np.stack([(packed[2 + c, :, 1:].astype(np.float32) / 255.0 - 0.5)
                         * 2.0 * (2.0 * dec0[:, c, None]) for c in range(3)], 1)
        ref = gi_a0d + gi_a1d @ UP
        got = dec0 + dec1 @ UP
        typ = max(float(np.median(np.abs(ref))), 1e-6)
        gi_codec_p99 = float(np.percentile(
            np.abs(got - ref) / (np.abs(ref) + typ), 99))

    # ---- 构造性自检:最开阔格点复现解析真值(§5.9)----
    # 选集用与被检验量正交的判据:a₀ == 0.5 的**精确等值集**(全逃逸 ⇒
    # a₀ 精确 0.5,可精确判定;在被检验的 T(up) 上做 argsort 选择会引入
    # 选择偏差,吃掉容差预算 —— 审查纠正)。无精确开阔格点才回落 top-1%。
    t_up = sky_a0d + sky_a1d @ UP
    exact_open = (~inv) & (sky_a0d == np.float32(0.5))
    if int(exact_open.sum()) >= 10:
        open_idx = np.where(exact_open)[0]
        open_sel = f'a0==0.5 精确集({len(open_idx)})'
    else:
        k = max(1, n // 100)
        open_idx = np.argpartition(t_up, -k)[-k:]    # 只要均值,不需要排序
        open_sel = 'top-1%(无精确开阔格点)'
    selfcheck = {
        'open_a0': float(sky_a0d[open_idx].mean()),
        'open_T_up': float(t_up[open_idx].mean()),
        'open_selection': open_sel,
        'gi_codec_p99_soft_rel': gi_codec_p99,
        'ao_open_a0': float(ao_a0d[open_idx].mean()),
        'ao_a1_clamped': ao_a1_clamped,
    }

    return {
        'packed': packed.reshape(len(CHANNELS), nx, ny, nz, 4),
        'grid': {'nx': nx, 'ny': ny, 'nz': nz},
        'bounds': bounds,
        'channels': list(CHANNELS),
        'gi_scale': float(gi_scale), 'gi_span': float(gi_span),
        'validity_coverage': validity_coverage,
        'residual_invalid': residual_invalid,
        'dilation_iters': dil_iters,
        'spp': spp, 'moment_spp': MOMENT_SPP,
        'no_gi': bool(no_gi),
        'selfcheck': selfcheck,
        # 未打包的原始矩(check.py 与 report 用;不落盘)
        'raw': {'sky_a0': sky_a0d, 'sky_a1': sky_a1d,
                'ao_a0': ao_a0d, 'ao_a1': ao_a1d,
                'gi_a0': gi_a0d, 'gi_a1': gi_a1d,
                'pts_q': pts_q, 'invalid': inv},
        # §5.12 的体侧缓存机制留有结构(VolumeGiCache),GUI 目前只重估场景 E,
        # 默认不驻留 ~17MB 的死数据(want_cache 开)。
        'cache': (VolumeGiCache(m0_hit=gi_m0_hit, m1_hit=gi_m1_hit,
                                esc_mask=esc_mask, act=act, spp=spp)
                  if want_cache else None),
    }
