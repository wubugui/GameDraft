"""程序性天空 CPU 镜像测试（对齐 `src/rendering/lighting/skySh.ts`）。"""
from __future__ import annotations

import numpy as np
import pytest

from tools.lightbake.sky import (A_HAT, eval_sh, is_plain_sky, normalized_shape,
                                 sh_basis, sky_irradiance_sh)


def test_sh_basis_first_coeff():
    b = sh_basis(np.array([0.0]), np.array([1.0]), np.array([0.0]))
    assert b[0, 0] == pytest.approx(0.2820948, abs=1e-7)
    # 顺序与 sc3SkyShIrradiance 逐行对应：y 项带 0.4886025
    assert b[0, 1] == pytest.approx(0.4886025, abs=1e-7)


def test_ahat_ramamoorthi():
    assert A_HAT == (np.pi, 2 * np.pi / 3, np.pi / 4)


def test_plain_sky_matches_old_path_bitwise():
    """自检 #10：三个 gain 全 0 时与旧路逐位相同。"""
    sky = {'profile': 2.0, 'intensity': 0.5, 'color': [0.7, 0.8, 1.0]}
    assert is_plain_sky(sky)
    sh = sky_irradiance_sh(sky)
    shape = normalized_shape(2.0)
    expect = shape[:, None] * np.asarray([0.7, 0.8, 1.0], np.float64)[None, :] * 0.5
    assert np.max(np.abs(sh - expect)) <= 1e-12


def test_plain_sky_ignores_gain_knobs_when_zero():
    sky = {'profile': 2.0, 'intensity': 0.5, 'color': [0.7, 0.8, 1.0],
           'horizonGain': 0.0, 'glowGain': 0.0, 'groundGain': 0.0}
    assert is_plain_sky(sky)
    a = sky_irradiance_sh(sky)
    b = sky_irradiance_sh({'profile': 2.0, 'intensity': 0.5, 'color': [0.7, 0.8, 1.0]})
    assert np.array_equal(a, b)


def test_profile_normalized_up_equals_one():
    # 天顶剖面归一到 E(up)=1
    for profile in (0.0, 1.0, 2.0, 4.0):
        shape = normalized_shape(profile)
        e_up = float(eval_sh(shape, 0.0, 1.0, 0.0))
        assert e_up == pytest.approx(1.0, abs=1e-4)


def test_glow_pulls_l1_toward_sun():
    """辉光把 l=1 拉向太阳方位：朝西比朝东亮。"""
    sun = np.array([1.0, 0.0, 0.0], np.float32)  # 太阳在 +X（西）
    sky = {'profile': 1.0, 'intensity': 1.0,
           'glowGain': 1.0, 'glowTight': 8.0, 'glowColor': [1.0, 0.5, 0.3]}
    sh = sky_irradiance_sh(sky, sun)
    lum = np.array([0.2126, 0.7152, 0.0722], np.float32)
    west = float(eval_sh(sh, 1.0, 0.0, 0.0) @ lum)
    east = float(eval_sh(sh, -1.0, 0.0, 0.0) @ lum)
    assert west > east
