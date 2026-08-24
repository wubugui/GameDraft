# -*- coding: utf-8 -*-
"""gather 估计器与优化路径的等价性(§5.5 / §5.6 / §5.12)。"""
from __future__ import annotations

import math

import numpy as np
import pytest

from tools.lightbake.gather import (GatherCache, combine_e, sky_moments,
                                    vdir_coeffs, vis_of_normal)
from tools.lightbake.sampling import point_keys
from tools.lightbake.trace import DepthField

UP = np.array([0.0, 1.0, 0.0], np.float32)


def _open_field():
    depth = np.full((48, 48), 10.0, np.float32)
    return DepthField.build(depth, ppu=12.0, cx=24.0, cy=24.0)


def test_sky_moments_open_air_exact():
    """全逃逸 ⇒ a₀ = 0.5 精确(估计器与归一化的解析锚)。"""
    field = _open_field()
    pts = np.stack([np.linspace(-1, 1, 200), np.linspace(-1, 1, 200),
                    np.full(200, 0.5)], 1).astype(np.float32)
    a0, a1 = sky_moments(pts, np.eye(3, dtype=np.float32), field, spp=64)
    assert np.all(a0 == 0.5)
    t_up = a0 + a1 @ UP
    # 逐点门与 spp 匹配:spp=64 时 mean(μ) 的 sd≈5.6e-4,200 点 max≈3σ
    assert np.abs(t_up - 1.0).max() < 4e-3


def test_vdir_constructive_sanity():
    """vis ≡ 1 ⇒ a₀=½、a₁=(0,½,0) ⇒ α=1、β=0 ⇒ V_dir ≡ 1(§5.5 构造性自检)。"""
    a0 = np.full(5, 0.5, np.float32)
    a1 = np.tile(np.array([0.0, 0.5, 0.0], np.float32), (5, 1))
    alpha, beta = vdir_coeffs(a0, a1)
    assert np.allclose(alpha, 1.0, atol=1e-6)
    assert np.allclose(beta, 0.0, atol=1e-6)
    n = np.tile(UP, (5, 1))
    assert np.allclose(vis_of_normal(a0, a1, n), 1.0, atol=1e-6)


def test_combine_e_constant_fastpath_matches_generic():
    """常色快路(逃逸计数×常色)≡ 逐 spp 生成方向的通用路(同一批元素求和,
    差只在 f64 求和结合序,≤ 1e-12 相对)。"""
    rng = np.random.default_rng(11)
    n, spp, h, w = 30 * 40, 16, 30, 40
    normals = rng.normal(size=(n, 3))
    normals = (normals / np.linalg.norm(normals, axis=1, keepdims=True)
               ).astype(np.float32)
    keys = point_keys(rng.uniform(-1, 1, (n, 3)).astype(np.float32))
    cache = GatherCache(hit_sum=rng.uniform(0, 2, (n, 3)),
                        esc_mask=rng.random((n, spp)) < 0.4, spp=spp,
                        keys=keys, normals=normals, shape_hw=(h, w))
    c = np.array([0.31, 0.55, 0.87], np.float32)

    def generic(dw):
        return np.broadcast_to(c, dw.shape)

    def marked(dw):
        return np.broadcast_to(c, dw.shape)
    marked.constant_rgb = c

    e_generic = combine_e(cache, generic)
    e_fast = combine_e(cache, marked)
    assert np.allclose(e_fast, e_generic, rtol=1e-6, atol=1e-7)
    # 快路确实免方向:标记函数不该被以逐批方向调用 —— 用计数器验证
    calls = {'n': 0}

    def counting(dw):
        calls['n'] += 1
        return np.broadcast_to(c, dw.shape)
    counting.constant_rgb = c
    combine_e(cache, counting)
    assert calls['n'] == 0


def test_combine_e_is_reestimation_identity():
    """自检 #12 的机制:同 cache 同天空两次 combine ⇒ 逐位相同。"""
    rng = np.random.default_rng(12)
    n, spp = 500, 8
    normals = np.tile(UP, (n, 1))
    keys = point_keys(rng.uniform(-1, 1, (n, 3)).astype(np.float32))
    cache = GatherCache(hit_sum=rng.uniform(0, 1, (n, 3)),
                        esc_mask=rng.random((n, spp)) < 0.5, spp=spp,
                        keys=keys, normals=normals, shape_hw=(20, 25))

    def sky(dw):
        d = np.atleast_2d(dw)
        return np.stack([0.2 + 0.1 * d[:, 1]] * 3, 1)

    a = combine_e(cache, sky)
    b = combine_e(cache, sky)
    assert np.array_equal(a, b)


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
