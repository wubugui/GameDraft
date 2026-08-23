"""tracer 测试：契约（逐位相同）、终止条件、确定性、无遮挡矩。"""
from __future__ import annotations

import numpy as np
import pytest

from tools.lightbake.trace import (_pixel_ray_escape, _point_ray_escape, trace_rays,
                                   trace_points)


def _flat_scene(depth_val: float = 0.0, size: int = 20, ppu: float = 10.0):
    depth = np.full((size, size), depth_val, np.float32)
    R = np.eye(3, dtype=np.float32)
    cx = cy = size / 2.0
    return depth, R, ppu, cx, cy


def test_contract_pixel_and_point_escape_bitwise():
    """同一批点、同一批给定方向，两个入口必须给出逐位相同的逃逸判定。"""
    depth, R, ppu, cx, cy = _flat_scene()
    q = np.array([[0.0, 0.0, 0.0], [0.5, 0.3, 0.1], [-0.2, 0.4, 0.7]], np.float32)
    d = np.array([[0.1, 0.2, 0.3], [0.3, -0.2, 0.5], [-0.1, 0.05, 0.9]], np.float32)
    a = _pixel_ray_escape(q, d, depth, R, ppu, cx, cy)
    b = _point_ray_escape(q, d, depth, R, ppu, cx, cy)
    assert np.array_equal(a, b)


def test_termination_hit_front_pass():
    """命中 / 前穿 / 出画三个终止条件。"""
    depth, R, ppu, cx, cy = _flat_scene(depth_val=0.0)
    # 表面点（q_z=0），朝深处打 → 命中（逃逸=False）
    q_on = np.array([[0.0, 0.0, 0.0]], np.float32)
    esc_deep, _ = trace_rays(q_on, np.array([[0.0, 0.0, 1.0]], np.float32),
                             depth, R, ppu, cx, cy)
    assert not esc_deep[0]
    # 朝前打 → 前穿（逃逸=True）
    esc_front, _ = trace_rays(q_on, np.array([[0.0, 0.0, -1.0]], np.float32),
                              depth, R, ppu, cx, cy)
    assert esc_front[0]
    # 侧向出画 → 逃逸=True（出画语义）
    esc_side, _ = trace_rays(q_on, np.array([[5.0, 0.0, 0.0]], np.float32),
                             depth, R, ppu, cx, cy)
    assert esc_side[0]


def test_trace_rays_deterministic():
    depth, R, ppu, cx, cy = _flat_scene()
    q = np.random.default_rng(0).normal(size=(64, 3)).astype(np.float32)
    # 方向取有界、非轴向的，保证每条射线都在几步内命中/出画/前穿
    d = np.random.default_rng(1).normal(size=(64, 3)).astype(np.float32)
    d = d / np.maximum(np.linalg.norm(d, axis=1, keepdims=True), 1e-6)
    d += np.array([[1e-3, 1e-3, 1e-3]], np.float32)
    a, _ = trace_rays(q, d, depth, R, ppu, cx, cy)
    b, _ = trace_rays(q, d, depth, R, ppu, cx, cy)
    assert np.array_equal(a, b)


def test_world_up_maps_to_front_with_pitch_R():
    """方向变换约定：world = q @ Rᵀ ⇒ dq = dw @ R（不是 dw @ Rᵀ）。

    45° 俯仰（雾津同款 R）下 world 的「上」应映射到 q 空间的「前」（dq_z<0）——
    朝上打逃逸、朝下打命中。这条锁住 trace_pixels 里的方向变换，防止再写反。
    """
    c = 0.7071067811865476
    R = np.array([[1, 0, 0], [0, c, -c], [0, c, c]], np.float32)
    depth = np.zeros((20, 20), np.float32)
    ppu, cx, cy = 10.0, 10.0, 10.0
    q_on = np.array([[0.0, 0.0, 0.0]], np.float32)

    dq_up = np.array([[0.0, 1.0, 0.0]], np.float32) @ R
    assert dq_up[0, 2] < 0  # world up → 朝前（dq_z<0）
    esc_up, _ = trace_rays(q_on, dq_up, depth, R, ppu, cx, cy)
    assert esc_up[0]

    dq_down = np.array([[0.0, -1.0, 0.0]], np.float32) @ R
    assert dq_down[0, 2] > 0  # world down → 朝深（dq_z>0）
    esc_down, _ = trace_rays(q_on, dq_down, depth, R, ppu, cx, cy)
    assert not esc_down[0]


def test_trace_points_open_sky_moments():
    """无遮挡：a₀=⟨esc⟩/2=0.5，a₁≈(0,½,0)，T(up)=a₀+a₁·up≈1（构造性自检）。

    点在「全场景最前」（q_z = dmin−1）⇒ 所有上半球射线前穿逃逸，1 步内收工。
    """
    depth, R, ppu, cx, cy = _flat_scene(depth_val=0.0)
    pts = np.array([[0.0, 0.0, -1.0]], np.float32)  # dmin=0，点在最前
    a0, a1 = trace_points(pts, R, depth, ppu, cx, cy, spp=512)
    assert a0[0] == pytest.approx(0.5, abs=1e-5)
    assert a1[0, 1] == pytest.approx(0.5, abs=2e-2)
    t_up = a0[0] + a1[0, 1]
    assert t_up == pytest.approx(1.0, abs=3e-3)
