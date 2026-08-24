# -*- coding: utf-8 -*-
"""采样器组件的自带测试(方案 §5.4):解析可积函数的收敛 + 分布卡方 +
位置哈希的确定性/批次无关性。"""
from __future__ import annotations

import math

import numpy as np
import pytest

from tools.lightbake.sampling import (cosine_hemisphere, point_keys,
                                      uniform_sphere, uniform_upper_hemisphere)


def _pts(n: int, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.uniform(-3, 3, (n, 3)).astype(np.float32)


# -------------------------------------------------- 确定性与批次无关

def test_position_hash_deterministic_and_batch_free():
    pts = _pts(500)
    keys = point_keys(pts)
    assert np.array_equal(keys, point_keys(pts))
    # 子批 ⇒ 与全批切片逐位相同(与批次划分无关)
    sub = point_keys(pts[100:200])
    assert np.array_equal(sub, keys[100:200])
    for s in (0, 3, 7):
        d_full, p_full = uniform_upper_hemisphere(keys, s, 64)
        d_sub, p_sub = uniform_upper_hemisphere(keys[100:200], s, 64)
        assert np.array_equal(d_full[100:200], d_sub)
        assert np.array_equal(p_full[100:200], p_sub)


def test_same_point_same_stream_across_arrays():
    """同一坐标(float32 逐位相同)⇒ 同一方向流 —— 自检 #13 的地基。"""
    pts = _pts(64, seed=4)
    dup = pts.copy()[::-1]                       # 同一批点,倒序另建数组
    ka = point_keys(pts)
    kb = point_keys(dup)
    assert np.array_equal(ka, kb[::-1])
    da, _ = uniform_upper_hemisphere(ka, 5, 64)
    db, _ = uniform_upper_hemisphere(kb, 5, 64)
    assert np.array_equal(da, db[::-1])


def _xi_streams(keys, s, spp):
    """从公开 API 反解三个采样器的 (ξ₁, ξ₂) 流(测独立性用)。

    ⚠ 反解变换要**逐采样器归一到同一空间**(复审纠正):upper/sphere 的
    dirs = [sr·cosφ, μ, sr·sinφ] ⇒ arctan2(x,z) 恢复的是 (0.25−ξ₂)mod1;
    cosine 在 N=up 时 ta=(0,0,1)/tb=(1,0,0) ⇒ 恢复的直接是 ξ₂。
    不归一的话跨采样器同流会因变换不对称而被误判「不同」。
    """
    import math as _m
    du, _ = uniform_upper_hemisphere(keys, s, spp)
    xi1_u = du[:, 1] * spp - s
    xi2_u = (0.25 - np.arctan2(du[:, 0], du[:, 2]) / (2 * _m.pi)) % 1.0
    ds, _ = uniform_sphere(keys, s, spp)
    xi1_s = ((ds[:, 1] + 1.0) * 0.5) * spp - s
    xi2_s = (0.25 - np.arctan2(ds[:, 0], ds[:, 2]) / (2 * _m.pi)) % 1.0
    N = np.tile(np.array([[0.0, 1.0, 0.0]], np.float32), (len(keys), 1))
    dc, _ = cosine_hemisphere(N, keys, s, spp)
    xi1_c = (1.0 - dc[:, 1] ** 2) * spp - s
    xi2_c = (np.arctan2(dc[:, 0], dc[:, 2]) / (2 * _m.pi)) % 1.0
    return {'upper': (xi1_u, xi2_u), 'sphere': (xi1_s, xi2_s),
            'cosine': (xi1_c, xi2_c)}


def test_samplers_have_independent_streams():
    """流独立要**两两逐分量**断言 —— 旧版只比一对数组,恰好放过了
    「盐相邻 + 计数器步 2」的跨采样器撞号(审查逐位实测过)。"""
    pts = _pts(256, seed=6)
    keys = point_keys(pts)
    spp = 16
    streams = {}
    for s in (3, 4):
        for name, (a, b) in _xi_streams(keys, s, spp).items():
            streams[f'{name}.xi1@{s}'] = a
            streams[f'{name}.xi2@{s}'] = b
    names = sorted(streams)
    for i, na in enumerate(names):
        for nb in names[i + 1:]:
            if na.split('@')[0] == nb.split('@')[0]:
                continue                       # 同采样器同分量不同 s 另有分层约束
            diff = float(np.max(np.abs(streams[na] - streams[nb])))
            assert diff > 1e-4, f'流撞号: {na} == {nb}'
    # 点名钉住历史撞号形态(盐差 1 + 计数器步 2):upper.ξ₂(s) vs sphere.ξ₁(s)
    for s in (3, 4):
        st = _xi_streams(keys, s, spp)
        assert float(np.max(np.abs(st['upper'][1] - st['sphere'][0]))) > 1e-4
        assert float(np.max(np.abs(st['sphere'][1] - st['cosine'][0]))) > 1e-4


def test_stratification_exact_buckets():
    """分层的直接断言:第 s 个样本的 u₁ 必落在第 s 个层里
    (审查:此前只靠收敛阈值间接钉,反事实去掉分层只超阈 13%)。"""
    pts = _pts(300, seed=14)
    keys = point_keys(pts)
    spp = 16
    for s in (0, 5, 15):
        st = _xi_streams(keys, s, spp)
        for name, (xi1, _xi2) in st.items():
            assert np.all(xi1 > -1e-3) and np.all(xi1 < 1 + 1e-3), (name, s)


# ---------------------------------------------------------- 单位与 pdf

def test_directions_unit_length():
    pts = _pts(1000, seed=1)
    keys = point_keys(pts)
    N = np.random.default_rng(2).normal(size=(1000, 3))
    N = (N / np.linalg.norm(N, axis=1, keepdims=True)).astype(np.float32)
    for fn in (lambda s: cosine_hemisphere(N, keys, s, 8),
               lambda s: uniform_upper_hemisphere(keys, s, 8),
               lambda s: uniform_sphere(keys, s, 8)):
        for s in range(8):
            d, pdf = fn(s)
            assert np.allclose(np.linalg.norm(d, axis=1), 1.0, atol=2e-6)
            assert np.all(pdf >= 0)


def test_estimator_analytic_integrals():
    """估计量 Σ f/pdf / n 在解析可积函数上收敛到真值。"""
    n, spp = 2000, 256
    pts = _pts(n, seed=8)
    keys = point_keys(pts)

    # ∫_上半球 (ω·up) dω = π,均匀上半球:f/pdf = μ·2π
    acc = np.zeros(n)
    for s in range(spp):
        d, pdf = uniform_upper_hemisphere(keys, s, spp)
        acc += d[:, 1] / pdf
    est = acc / spp
    assert abs(est.mean() - math.pi) < 0.01
    assert np.percentile(np.abs(est - math.pi), 99) < 0.25

    # ∫_球面 1 dω = 4π
    acc = np.zeros(n)
    for s in range(spp):
        d, pdf = uniform_sphere(keys, s, spp)
        acc += 1.0 / pdf
    assert np.allclose(acc / spp, 4 * math.pi, rtol=1e-5)

    # 余弦重要性:∫ (N·ω)₊ dω = π,f/pdf = cos/(cos/π) = π(恒等,验证 pdf 公式)
    N = np.tile(np.array([[0.0, 1.0, 0.0]], np.float32), (n, 1))
    d, pdf = cosine_hemisphere(N, keys, 0, spp)
    cos = np.maximum((d * N).sum(1), 0.0)
    ok = cos > 1e-6
    assert np.allclose(cos[ok] / pdf[ok], math.pi, rtol=1e-4)

    # 余弦采样估计 E = ∫L·cos/π:L(ω)=μ ⇒ 真值 2/3(绕 up)
    acc = np.zeros(n)
    for s in range(spp):
        d, _ = cosine_hemisphere(N, keys, s, spp)
        acc += d[:, 1]
    est = acc / spp
    assert abs(est.mean() - 2.0 / 3.0) < 0.005


def test_distribution_chi_square():
    """μ 分布卡方:均匀上半球的 μ ∈ [0,1] 均匀;球面的 μ ∈ [-1,1] 均匀。"""
    n, spp, bins = 400, 64, 16
    keys = point_keys(_pts(n, seed=12))
    for fn, lo, hi in ((uniform_upper_hemisphere, 0.0, 1.0),
                       (uniform_sphere, -1.0, 1.0)):
        mus = np.concatenate([fn(keys, s, spp)[0][:, 1] for s in range(spp)])
        histo, _ = np.histogram(mus, bins=bins, range=(lo, hi))
        expect = len(mus) / bins
        chi2 = float(((histo - expect) ** 2 / expect).sum())
        # 自由度 15,99.9 分位 ≈ 37.7;分层采样只会更均匀
        assert chi2 < 60.0, f'{fn.__name__} 卡方 {chi2:.1f}'
        # 方位角也查一把
        phis = np.concatenate([np.arctan2(fn(keys, s, spp)[0][:, 0],
                                          fn(keys, s, spp)[0][:, 2])
                               for s in range(0, spp, 8)])
        h2, _ = np.histogram(phis, bins=bins, range=(-math.pi, math.pi))
        e2 = len(phis) / bins
        chi2p = float(((h2 - e2) ** 2 / e2).sum())
        assert chi2p < 80.0, f'{fn.__name__} 方位卡方 {chi2p:.1f}'


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
