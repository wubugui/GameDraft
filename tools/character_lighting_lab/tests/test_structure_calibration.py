"""立面约束标定(`calibration='structure'`)。

背景(2026-09-25):崖墓前段 / 前段1 / 后段是"近乎平视看一面峭壁 + 一条窄栈道"。缺省的 'level' 标定
只要求"地面尽量水平",在这种画上塌成一张正对相机的平面(深度 ≈ 常数,路和墙一律 45°):
碰撞、遮挡、手持光源、落雷落点全都失去真实几何,而导出照样成功。'structure' 同时要求作者圈的
路面朝上、其余表面竖直,俯角一起拟合 —— 这里用已知真值的合成峭壁钉住它能把俯角与结构找回来。
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np
import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.character_lighting_lab import pipeline as pl  # noqa: E402

H, W = 144, 256
PPU = 0.22 * W


def _cliff_ledge(pitch_deg: float, noise: float = 0.004, seed: int = 0, bumps: float = 0.0,
                 linear: bool = False):
    """正交俯视相机下的一面峭壁:上段竖直崖壁 → 一条水平栈道(外沿随 x 弯) → 下段竖直崖壁。

    按 q 空间逐像素求射线最先撞到的面(与 pipeline 同一约定:Y = qy·cosθ − d·sinθ,
    Z = −(qy·sinθ + d·cosθ),d 越大越远),再把深度变成 Depth Anything 那种归一化视差。
    返回 (raw, ledge_mask, 真实深度 d)。
    """
    th = math.radians(pitch_deg)
    c, s = math.cos(th), math.sin(th)
    sy = np.arange(H, dtype=np.float64)[:, None]
    sx = np.arange(W, dtype=np.float64)[None, :]
    qy = (H / 2 - sy) / PPU * np.ones((1, W))
    qx = (sx - W / 2) / PPU * np.ones((H, 1))
    # 栈道(Y = 0)在画面中线附近:qy = 0 那一行正好落在 Z = 0
    z_wall = -0.45                                  # 上段崖壁(远)
    z_edge = 0.35 + 0.12 * np.sin(qx * 2.3)         # 栈道外沿 = 下段崖壁(近),沿 x 弯
    d_ledge = qy / math.tan(th)                     # Y = 0
    z_ledge = -(qy * s + d_ledge * c)
    d_up = (-z_wall - qy * s) / c                   # Z = z_wall
    d_lo = (-z_edge - qy * s) / c                   # Z = z_edge
    y_up = qy * c - d_up * s
    y_lo = qy * c - d_lo * s
    inf = np.full_like(qy, np.inf)
    cand = np.stack([
        np.where((z_ledge <= z_edge) & (z_ledge >= z_wall), d_ledge, inf),
        np.where(y_up > 0, d_up, inf),
        np.where(y_lo < 0, d_lo, inf),
    ])
    d = cand.min(0)
    assert np.isfinite(d).all()
    ledge = cand.argmin(0) == 0
    d = d - d.min() + 2.0                           # 平移相机,深度全为正(正交相机下结构不变)
    # 视差:缺省按 1/深度;linear=True 时视差与深度成线性(崖墓后段拟出来就是这种:最优解落在线性极限)
    disp = -d if linear else 1.0 / d
    raw = (disp - disp.min()) / (disp.max() - disp.min())
    rng = np.random.default_rng(seed)
    raw = raw + rng.normal(0, noise, raw.shape)     # 逐像素毛刺
    if bumps > 0:                                   # 岩面起伏:低频、幅度大(单目深度真实的误差形态)
        from scipy.ndimage import gaussian_filter
        b = gaussian_filter(rng.normal(0, 1, raw.shape), 5.0)
        raw = raw + b / b.std() * bumps
    return raw.astype(np.float32), ledge, d


@pytest.mark.parametrize('pitch', [25.0, 40.0])
def test_fit_recovers_pitch_and_structure(pitch):
    raw, ledge, _ = _cliff_ledge(pitch)
    from scipy.ndimage import binary_dilation, binary_erosion
    ground = binary_erosion(ledge, iterations=2)
    walls = binary_erosion(~binary_dilation(ledge, iterations=3), iterations=2)
    fit = pl.fit_structure_calibration(raw, ground, walls, PPU)
    assert abs(fit['pitch_deg'] - pitch) <= 2.5, fit['pitch_deg']
    d = pl.structure_depth(raw, fit['K'], fit['beta'])
    up = pl.up_dot_field(d, PPU, fit['theta'])
    # 路面朝上(中位坡度 < 15°)、崖壁竖直(中位偏离 < 10°)
    assert np.median(up[ground]) > math.cos(math.radians(15))
    assert np.median(np.abs(up[walls])) < math.sin(math.radians(10))


@pytest.mark.parametrize('pitch', [25.0, 40.0])
def test_fit_tolerates_low_frequency_bumps(pitch):
    """单目深度真实的误差形态是低频起伏(岩面鼓包)。实测会把俯角往小拉 3~4°,结构仍对。"""
    raw, ledge, _ = _cliff_ledge(pitch, noise=0.0, bumps=0.01)
    from scipy.ndimage import binary_dilation, binary_erosion
    ground = binary_erosion(ledge, iterations=2)
    walls = binary_erosion(~binary_dilation(ledge, iterations=3), iterations=2)
    fit = pl.fit_structure_calibration(raw, ground, walls, PPU)
    assert abs(fit['pitch_deg'] - pitch) <= 5.0, fit['pitch_deg']
    assert fit['wall_up_abs_median'] < math.sin(math.radians(10))


def test_linear_limit_does_not_collapse_in_float32():
    """2026-09-25 崖墓后段:最优解在"深度 ∝ 视差"的线性极限上。旧写法 1/(s·r+o) 要 s、o 一起趋 0 才够得着,
    深度带着 10¹⁵ 量级的常数,转 float32 后起伏全被舍入吞掉 —— 又塌成一块,而拟合统计照样好看。"""
    raw, ledge, _ = _cliff_ledge(30.0, linear=True)
    P = {**pl.DEFAULTS, 'calibration': 'structure'}
    cal = pl.stage_calibrate_structure(raw, P, np.zeros(raw.shape, bool), ledge)
    assert cal['d'].dtype == np.float32 and np.isfinite(cal['d']).all()
    assert float(cal['d'].std()) > 0.05                      # 真有起伏,不是一块常数
    up = pl.up_dot_field(cal['d'], PPU, cal['theta'])
    assert np.median(up[ledge]) > math.cos(math.radians(20))
    assert abs(math.degrees(cal['theta']) - 30.0) <= 2.5


def test_calibrated_depth_matches_level_family():
    """K/β 写法与 level 的 1/(s·r+o) 只差一个常数(坡度一样)。"""
    r = np.linspace(0, 1, 50)
    s_, o_ = 0.05, 0.06
    K, beta = s_ / o_ ** 2, s_ / o_
    a = pl.calibrated_depth(r, {'s': s_, 'o': o_})
    b = pl.calibrated_depth(r, {'K': K, 'beta': beta, 's': 0, 'o': 0})
    assert np.allclose(a - b, (a - b)[0])


def test_constant_depth_is_the_collapsed_plane():
    """塌掉的那种解(深度常数)在这个判据下路和墙都是 90°−俯角 的斜面 —— 立面约束正是靠这点排除它。"""
    th = math.radians(45.0)
    up = pl.up_dot_field(np.full((H, W), 3.0, np.float32), PPU, th)
    assert np.allclose(up, math.sin(th), atol=1e-5)


def test_structure_needs_author_ground():
    raw, _, _ = _cliff_ledge(30.0)
    P = {**pl.DEFAULTS, 'calibration': 'structure'}
    with pytest.raises(RuntimeError, match='可走区'):
        pl.stage_calibrate_structure(raw, P, np.zeros(raw.shape, bool), np.zeros(raw.shape, bool))


def test_stage_calibrate_structure_end_to_end():
    raw, ledge, _ = _cliff_ledge(30.0)
    P = {**pl.DEFAULTS, 'calibration': 'structure'}
    cal = pl.stage_calibrate_structure(raw, P, np.zeros(raw.shape, bool), ledge)
    assert abs(math.degrees(cal['theta']) - 30.0) <= 2.5
    # 地面中位高度归零、地面掩膜落在路上
    assert abs(float(np.median(cal['Y'][cal['ground_mask']]))) < 1e-3
    assert (cal['ground_mask'] & ~ledge).sum() <= 0.05 * cal['ground_mask'].sum()
    assert cal['structure']['curve'] and cal['structure']['wall_px'] > 0


def test_mode_switches():
    assert pl.calibration_mode({}) == 'level'
    assert pl.effective_relief({**pl.DEFAULTS, 'relief': 1.8}) == 1.8
    assert pl.effective_relief({**pl.DEFAULTS, 'relief': 1.8, 'calibration': 'structure'}) == 1.0
    with pytest.raises(ValueError):
        pl.calibration_mode({'calibration': 'flat'})
