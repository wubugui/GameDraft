# -*- coding: utf-8 -*-
"""引导去噪(denoise.py)的确定性 / 关闭路径 / 降噪与结构保持。"""
from __future__ import annotations

import numpy as np
import pytest

from tools.lightbake.denoise import denoise_e


def _scene(seed: int = 3, h: int = 96, w: int = 128):
    """两块平面 + 台阶:法线/深度不连续处是必须保住的结构边。"""
    rng = np.random.default_rng(seed)
    depth = np.full((h, w), 5.0, np.float32)
    depth[:, w // 2:] = 8.0
    normal = np.zeros((h, w, 3), np.float32)
    normal[..., 2] = -1.0
    normal[:, w // 2:, 0] = 0.6
    normal[:, w // 2:, 2] = -0.8
    e_clean = np.full((h, w, 3), 0.5, np.float32)
    e_clean[:, w // 2:] = 1.5
    noise = rng.normal(0.0, 0.15, (h, w, 3)).astype(np.float32)
    return e_clean, np.clip(e_clean + noise, 0.0, None), normal, depth


def test_denoise_deterministic_and_off_identity():
    _clean, noisy, nrm, dep = _scene()
    a = denoise_e(noisy, nrm, dep)
    b = denoise_e(noisy, nrm, dep)
    assert np.array_equal(a, b)                    # 逐位确定(#8/#12 的前提)
    off = denoise_e(noisy, nrm, dep, iters=0)
    assert off is noisy                            # 关闭 = 原对象,零改动


def test_denoise_reduces_noise_keeps_edges():
    clean, noisy, nrm, dep = _scene()
    out = denoise_e(noisy, nrm, dep)
    # 噪声(对干净场的 RMSE)显著下降
    rms_in = float(np.sqrt(((noisy - clean) ** 2).mean()))
    rms_out = float(np.sqrt(((out - clean) ** 2).mean()))
    assert rms_out < 0.4 * rms_in, (rms_in, rms_out)
    # 结构边保住:边两侧的均值差不被抹平(左 0.5 / 右 1.5)
    h, w = dep.shape
    left = float(out[:, : w // 2 - 4, 0].mean())
    right = float(out[:, w // 2 + 4:, 0].mean())
    assert abs((right - left) - 1.0) < 0.1, (left, right)


def test_denoise_flat_region_converges_to_mean():
    """无结构平面上,去噪 ≈ 低通:输出方差远小于输入方差。"""
    rng = np.random.default_rng(9)
    h, w = 64, 64
    dep = np.full((h, w), 6.0, np.float32)
    nrm = np.zeros((h, w, 3), np.float32)
    nrm[..., 2] = -1.0
    noisy = (1.0 + rng.normal(0, 0.2, (h, w, 3))).astype(np.float32)
    out = denoise_e(np.clip(noisy, 0, None), nrm, dep)
    assert float(out.var()) < 0.05 * float(noisy.var())
    # 能量近守恒(均值漂移 < 2%)
    assert abs(float(out.mean()) - float(noisy.mean())) < 0.02


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
