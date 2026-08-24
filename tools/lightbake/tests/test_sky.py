# -*- coding: utf-8 -*-
"""天空镜像的锚点测试:§7.4 实测表 + proceduralSky.test.ts 的断言 + 解析锚。"""
from __future__ import annotations

import math

import numpy as np
import pytest

from tools.lightbake.sky import (eval_sh, kelvin_to_linear_rgb, normalized_shape,
                                 project_sh, sh_basis, sky_irradiance_sh)

SUN_W = (0.966, 0.259, 0.0)
W, E, D = (1, 0, 0), (-1, 0, 0), (0, -1, 0)


def _lum(sh: np.ndarray, x, y, z) -> float:
    e = eval_sh(sh, x, y, z)                        # sh: (9,3) → e: (3,)
    return float(0.2126 * e[0] + 0.7152 * e[1] + 0.0722 * e[2])


def _sh(spec: dict, sun=None) -> np.ndarray:
    return sky_irradiance_sh(spec, sun)          # (9,3)


def test_constant_radiance_gives_pi():
    """L ≡ 1 的球面 ⇒ 任意法线的辐照度 = π(Â 卷积的解析锚)。"""
    c = project_sh(lambda x, y, z: np.ones_like(x))
    for n in ((0, 1, 0), (1, 0, 0), (0.6, -0.8, 0), (0, 0, 1)):
        e = float(c @ sh_basis(*(float(v) for v in n)))
        assert abs(e - math.pi) < 0.01


def test_normalized_shape_unity_at_up():
    for p in (0.0, 0.6, 1.0, 2.0, 4.0):
        c = normalized_shape(p)
        assert abs(eval_sh(c, 0, 1, 0) - 1.0) < 1e-9


def test_old_model_rotation_symmetric():
    """§7.4:旧模型 profile=1 朝西 0.3189 = 朝东(绕 up 对称),朝下 0。"""
    sh = _sh({'intensity': 1.0, 'profile': 1.0})
    w, e = _lum(sh, *W), _lum(sh, *E)
    assert abs(w - e) < 1e-4
    assert abs(w - 0.3189) < 0.003
    assert _lum(sh, *D) < 1e-3


def test_dusk_asymmetry_and_chroma():
    """§7.4:黄昏朝西/朝东比值 2.52,朝西色度 [2.02, 0.72, 0.26]。"""
    dusk = {'intensity': 1.0, 'profile': 1.0, 'kelvin': 12000,
            'horizonGain': 1.6, 'horizonSharp': 4, 'horizonKelvin': 2600,
            'glowGain': 3.0, 'glowTight': 3, 'glowKelvin': 2100,
            'groundGain': 0.15, 'groundKelvin': 3000}
    sh = _sh(dusk, SUN_W)
    w, e = _lum(sh, *W), _lum(sh, *E)
    assert 2.3 < w / e < 2.8, f'比值 {w / e:.3f}'
    assert abs(w - 1.6446) < 0.02
    assert abs(e - 0.6522) < 0.02
    ew = eval_sh(sh, *W)
    chroma = ew / max(float(ew.mean()), 1e-9)
    assert np.allclose(chroma, [2.02, 0.72, 0.26], atol=0.05), chroma
    assert abs(_lum(sh, *D) - 0.2801) < 0.01


def test_gains_zero_bitwise_old_path():
    a = _sh({'intensity': 1.3, 'profile': 2.0})
    b = _sh({'intensity': 1.3, 'profile': 2.0,
             'horizonGain': 0.0, 'glowGain': 0.0, 'groundGain': 0.0})
    assert np.array_equal(a, b)


def test_ground_gain_lights_downward():
    off = _sh({'intensity': 1.0, 'profile': 1.0})
    on = _sh({'intensity': 1.0, 'profile': 1.0, 'groundGain': 0.3})
    assert _lum(off, *D) < 1e-3
    assert _lum(on, *D) > 0.05


def test_kelvin_anchor():
    assert np.allclose(kelvin_to_linear_rgb(6500.0), [1, 1, 1], atol=1e-9)
    warm = kelvin_to_linear_rgb(2000.0)
    assert warm[0] > warm[1] > warm[2]
    cool = kelvin_to_linear_rgb(12000.0)
    assert cool[2] > cool[0]


def test_e_up_equals_intensity_all_profiles():
    """归一定义(§7.3):E(up) = intensity,对任意 profile 成立。"""
    for p in (0.0, 0.6, 1.0, 2.0, 4.0):
        sh = _sh({'intensity': 1.3, 'profile': p})
        assert _lum(sh, 0, 1, 0) == pytest.approx(1.3, abs=1e-9), p


def test_real_scene_skies_finite_and_zero_at_zero_intensity():
    """真实场景语料:全部 lighting.sky 投影出有限值;intensity=0 ⇒ 输出恒 0
    (28/28 场景现状正是 intensity=0 —— 「一个字不用改」在数据上的落点)。"""
    import json as _json

    from tools.lightbake.input import SCENES_JSON
    if not SCENES_JSON.exists():
        pytest.skip('本机没有场景数据')
    n_checked = 0
    for j in sorted(SCENES_JSON.glob('*.json')):
        try:
            d = _json.loads(j.read_text(encoding='utf-8'))
        except Exception:                              # noqa: BLE001
            continue
        sky = (d.get('lighting') or {}).get('sky')
        if not isinstance(sky, dict):
            continue
        sh = sky_irradiance_sh(dict(sky))
        assert np.all(np.isfinite(sh)), j.stem
        if not sky.get('intensity'):
            assert np.all(sh == 0.0), j.stem
        n_checked += 1
    assert n_checked >= 10


def test_quadrature_upper_matches_old_density():
    """§7.3:全球面 N_ELEV=128 的上半 64 个 μ 节点 = 旧上半球 N_ELEV=64 逐位。"""
    i = np.arange(128)
    mu_full = -1 + 2 * (i + 0.5) / 128
    j = np.arange(64)
    mu_old = (j + 0.5) / 64
    assert np.array_equal(mu_full[64:], mu_old)


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
