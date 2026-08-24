# -*- coding: utf-8 -*-
"""实体空间数据的构造性测试(§5.9):合成场里的解析锚、dilation、打包往返。"""
from __future__ import annotations

import numpy as np
import pytest

from tools.lightbake.trace import DepthField
from tools.lightbake.volume import (_neighbor_fill, bake_volume, char_grid_for,
                                    grid_points)

UP = np.array([0.0, 1.0, 0.0], np.float32)


def _open_air_setup():
    """深度平面推到 10.0、格点全部悬在 [0.3, 0.9]:所有射线要么出画要么前穿,
    全部逃逸 —— 天穹 a₀ 精确 0.5、AO ≡ 1、GI ≡ 天空常色(解析锚)。"""
    h, w = 64, 64
    depth = np.full((h, w), 10.0, np.float32)
    field = DepthField.build(depth, ppu=16.0, cx=32.0, cy=32.0)
    R = np.eye(3, dtype=np.float32)
    rng = np.random.default_rng(3)
    world = np.stack([rng.uniform(-1, 1, (40, 40)),
                      rng.uniform(-0.5, 0.5, (40, 40)),
                      rng.uniform(0.3, 0.9, (40, 40))], -1).astype(np.float32)
    return field, R, world


def test_open_air_analytic_anchors():
    field, R, world = _open_air_setup()
    hdr = np.full(field.depth.shape + (3,), 0.7, np.float32)
    sky_c = np.array([0.2, 0.4, 0.6], np.float32)

    def sky_of(dw):
        return np.broadcast_to(sky_c, dw.shape)

    out = bake_volume(world, R, field, hdr, sky_of, char_wu=0.17, band=0.2,
                      spp=64)
    raw = out['raw']
    # 全逃逸 ⇒ a₀ = ⟨esc⟩/2 = 0.5 **精确**
    assert np.all(raw['sky_a0'] == 0.5)
    # T(up) = a₀ + a₁ᵧ ≈ 1。逐点抖动 sd≈5.6e-4 ⇒ 9520 点的 max ≈ 3.5σ,
    # 门按逐点 4e-3 + 均值 5e-4(§10 #2 的 2e-3 门是**开阔格点均值**口径)。
    t_up = raw['sky_a0'] + raw['sky_a1'] @ UP
    assert np.abs(t_up - 1.0).max() < 4e-3
    assert abs(float(t_up.mean()) - 1.0) < 5e-4
    # AO:范围内无命中 ⇒ a₀ = 1 精确、AO(N) ≈ 1
    assert np.all(raw['ao_a0'] == 1.0)
    ao_up = raw['ao_a0'] + raw['ao_a1'] @ UP
    assert np.abs(ao_up - 1.0).max() < 2e-2
    assert abs(float(ao_up.mean()) - 1.0) < 1e-3
    # GI:全逃逸 ⇒ a₀ = 天空常色 精确;E(up) ≈ 常色
    assert np.allclose(raw['gi_a0'], sky_c[None, :], atol=1e-6)
    e_up = raw['gi_a0'] + np.einsum('ncd,d->nc', raw['gi_a1'], UP)
    assert np.abs(e_up - sky_c[None, :]).max() < 2e-2
    assert np.abs(e_up.mean(0) - sky_c).max() < 1e-3
    # 全部有效,无需 dilation
    assert out['validity_coverage'] == 1.0
    assert out['dilation_iters'] == 0
    # 自检数与 §10 门一致
    assert abs(out['selfcheck']['open_a0'] - 0.5) <= 1e-3
    assert abs(out['selfcheck']['open_T_up'] - 1.0) <= 2e-3


def test_gi_uniform_environment_equals_scene_e():
    """辐射恒为 L₀ 的环境(天空与命中同色)⇒ E(N) ≡ L₀ —— 与场景 E 同量纲。"""
    h, w = 64, 64
    depth = np.full((h, w), 1.0, np.float32)
    field = DepthField.build(depth, ppu=16.0, cx=32.0, cy=32.0)
    R = np.eye(3, dtype=np.float32)
    rng = np.random.default_rng(4)
    world = np.stack([rng.uniform(-0.8, 0.8, (20, 20)),
                      rng.uniform(-0.8, 0.8, (20, 20)),
                      rng.uniform(0.5, 0.9, (20, 20))], -1).astype(np.float32)
    L0 = np.array([0.9, 0.9, 0.9], np.float32)
    hdr = np.broadcast_to(L0, (h, w, 3)).copy()

    def sky_of(dw):
        return np.broadcast_to(L0, dw.shape)

    out = bake_volume(world, R, field, hdr, sky_of, char_wu=0.17, band=0.2,
                      spp=64)
    raw = out['raw']
    assert np.allclose(raw['gi_a0'], L0[None, :], atol=1e-6)
    # GI 打包 → 解码 → 多方向求值(x/z 分量的编解码此前零覆盖,审查纠正)
    from tools.lightbake.encode import decode_log_hdr
    gs, gp = out['gi_scale'], out['gi_span']
    pk = out['packed'].reshape(5, -1, 4)
    dec0 = np.stack([decode_log_hdr(pk[2 + c, :, 0], gs, gp)
                     for c in range(3)], 1)
    dec1 = np.stack([(pk[2 + c, :, 1:].astype(np.float32) / 255.0 - 0.5) * 2.0
                     * (2.0 * dec0[:, c, None]) for c in range(3)], 1)
    for nvec in ((0, 1, 0), (1, 0, 0), (0, 0, -1)):
        nv = np.asarray(nvec, np.float64)
        e_dec = dec0.astype(np.float64) + np.einsum('ncd,d->nc',
                                                    dec1.astype(np.float64), nv)
        e_raw = raw['gi_a0'] + np.einsum('ncd,d->nc',
                                         raw['gi_a1'].astype(np.float64), nv)
        typ = max(float(np.median(np.abs(e_raw))), 1e-6)
        p99 = float(np.percentile(np.abs(e_dec - e_raw) / (np.abs(e_raw) + typ), 99))
        assert p99 < 0.05, (nvec, p99)
    # ⚠ 逐点容差按噪声结构分:μ 是分层的(纵向矩噪声 ~1e-3),φ 不分层
    #   (§5.4 采样伪代码如此),侧向矩逐点 sd = 2·L₀·sd(mean ωₓ) ≈ 0.13。
    #   逐点只对纵向收紧;侧向验均值(无偏)与分位。
    e_up = raw['gi_a0'] + np.einsum('ncd,d->nc', raw['gi_a1'], UP.astype(np.float64))
    assert np.abs(e_up - L0[None, :]).max() < 2e-2
    for n in ((1, 0, 0), (0, 0, -1)):
        e_n = raw['gi_a0'] + np.einsum('ncd,d->nc', raw['gi_a1'],
                                       np.asarray(n, np.float64))
        assert np.abs(e_n.mean(0) - L0).max() < 5e-3, n
        assert float(np.percentile(np.abs(e_n - L0[None, :]), 50)) < 0.12, n


def test_dilation_end_to_end_with_buried_cells():
    """含被埋格点的合成场跑完整 bake_volume(审查纠正:此前 validity+dilation
    支路只在脱离主流程的数组上单测)。"""
    h, w = 64, 64
    depth = np.full((h, w), 1.0, np.float32)
    field = DepthField.build(depth, ppu=16.0, cx=32.0, cy=32.0)
    R = np.eye(3, dtype=np.float32)
    rng = np.random.default_rng(6)
    world = np.stack([rng.uniform(-1, 1, (30, 30)),
                      rng.uniform(-0.5, 0.5, (30, 30)),
                      rng.uniform(0.8, 1.6, (30, 30))], -1).astype(np.float32)
    hdr = np.full((h, w, 3), 0.5, np.float32)
    out = bake_volume(
        world, R, field, hdr,
        lambda dw: np.broadcast_to(np.float32(0.3),
                                   (np.atleast_2d(dw).shape[0], 3)),
        char_wu=0.17, band=0.2, spp=16)
    assert 0.0 < out['validity_coverage'] < 1.0
    assert out['dilation_iters'] >= 1
    assert out['residual_invalid'] == 0.0
    inv = out['raw']['invalid']
    assert inv.any()
    # 被埋格点不再是精确 0(有效邻居均值填过,「精确的 0」不许漏进画面)
    assert float(out['raw']['sky_a0'][inv].mean()) > 0.0


def test_volume_ao_filter_equals_explicit_range_trace():
    """契约 7 在体侧的落点:`esc | t_hit > AO_RANGE` ≡ 显式 max_distance 截断。"""
    import math as _m

    from tools.lightbake.const import AO_RANGE
    from tools.lightbake.sampling import point_keys, uniform_sphere
    from tools.lightbake.trace import trace
    h, w = 64, 64
    depth = np.full((h, w), 1.0, np.float32)
    field = DepthField.build(depth, ppu=16.0, cx=32.0, cy=32.0)
    R = np.eye(3, dtype=np.float32)
    rng = np.random.default_rng(7)
    # 近距遮挡:距平面 0.03–0.15 q,命中 t 真的跨越 AO_RANGE=0.25
    world = np.stack([rng.uniform(-0.8, 0.8, (12, 12)),
                      rng.uniform(-0.8, 0.8, (12, 12)),
                      rng.uniform(0.85, 0.97, (12, 12))], -1).astype(np.float32)
    out = bake_volume(
        world, R, field, np.full((h, w, 3), 0.5, np.float32),
        lambda dw: np.zeros((np.atleast_2d(dw).shape[0], 3), np.float32),
        char_wu=0.17, band=0.2, spp=8)
    pts_q = out['raw']['pts_q']
    keys = point_keys(pts_q)
    hit_seen = False
    for s in (0, 3):
        dirs, _ = uniform_sphere(keys, s, 8)
        full = trace(pts_q, dirs @ R, field, max_distance=_m.inf)
        rng_t = trace(pts_q, dirs @ R, field, max_distance=AO_RANGE)
        esc_filter = full.escaped | (full.t_hit > AO_RANGE)
        assert np.array_equal(esc_filter, rng_t.escaped)
        hit_seen = hit_seen or bool((~esc_filter).any())
    assert hit_seen, '测试空转:没有任何近距命中'


def test_char_grid_density_and_cap():
    rng = np.random.default_rng(5)
    world = np.stack([rng.uniform(0, 4.5, (100, 100)),
                      rng.uniform(0, 0.8, (100, 100)),
                      rng.uniform(0, 3.0, (100, 100))], -1).astype(np.float32)
    grid, bounds = char_grid_for(world, char_wu=0.17, band=0.2)
    nx, ny, nz = grid
    assert nx * ny * nz <= 200_000
    assert min(nx, ny, nz) >= 4
    # 横向格宽 ≈ char_wu/3
    cell = (bounds['x1'] - bounds['x0']) / nx
    assert abs(cell - 0.17 / 3) / (0.17 / 3) < 0.15
    pts = grid_points(grid, bounds)
    assert pts.shape == (nx * ny * nz, 3)
    assert pts.dtype == np.float32


def test_neighbor_fill_dilation():
    valid = np.ones((4, 4, 4), np.bool_)
    valid[1:3, 1:3, 1:3] = False                      # 内部 2×2×2 无效岛
    f = np.zeros((4, 4, 4, 1), np.float64)
    f[valid] = 2.0                                    # 有效格全 2
    v2, iters = _neighbor_fill(valid, [f])
    assert v2.all()
    assert iters >= 1
    assert np.allclose(f, 2.0)                        # 均值填充只能是 2

    # 完全无效(除一个角):要多轮才灌满,且值全来自那个角
    valid = np.zeros((5, 1, 1), np.bool_)
    valid[0] = True
    f = np.zeros((5, 1, 1, 1), np.float64)
    f[0] = 7.0
    v2, iters = _neighbor_fill(valid, [f])
    assert v2.all() and iters == 4
    assert np.allclose(f, 7.0)


def test_packed_layout_and_channel0_shared_encoding():
    field, R, world = _open_air_setup()
    hdr = np.full(field.depth.shape + (3,), 0.5, np.float32)
    out = bake_volume(world, R, field, hdr,
                      lambda dw: np.broadcast_to(np.float32(0.3), dw.shape[:1] + (3,))
                      if dw.ndim > 1 else np.full(3, 0.3, np.float32),
                      char_wu=0.17, band=0.2, spp=16)
    nx, ny, nz = (out['grid'][k] for k in ('nx', 'ny', 'nz'))
    assert out['packed'].shape == (5, nx, ny, nz, 4)
    # 通道 0 与 sky_moments.png 逐字同一套:R = 2·a₀ = 255(a₀=0.5 顶满)
    assert np.all(out['packed'][0, ..., 0] == 255)
    # 通道 1:R = a₀,全 1 ⇒ 255
    assert np.all(out['packed'][1, ..., 0] == 255)


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
