# -*- coding: utf-8 -*-
"""解析灯镜像(lights.py)的公式钉 —— 期望值全部**独立手算/独立积分**,
不回环调用被测实现。

夹具三戒(2026-08-26 突变审查后立):
1. 阴影测试的深度场必须**结构化**(常数场让投影公式不可观测 —— py 翻号/
   丢 ppu/xy 互换 全体存活过);
2. 夹具的 shadow_bias 不许等于库缺省(否则「读 lighting.shadowBias」与
   「硬编码缺省」不可分辨);
3. 缺省值要有**专项**(每个测试都写全字段 ⇒ 缺省决议零覆盖,而缺省恰是
   packLights 25/40 vs lightDefaults 25/45 分歧最大的地方)。
"""
from __future__ import annotations

import math

import numpy as np

from tools.lightbake import lights as L

_WHITE = [1.0, 1.0, 1.0]


class _Inp:
    """SceneInput 假体。q 网格按真实像素映射构造(px=cx+x·ppu, py=cy−y·ppu,
    z=深度),world = q@R.T —— 与 input.load 同构。
    ⚠ shadow_bias 缺省取 (44, 210):**故意不等于库缺省 (30.8, 264)**。"""

    def __init__(self, h=16, w=32, scene_per_wu=150.0, depth=None,
                 R=None, shadow_bias=(44.0, 210.0)):
        self.scene_per_wu = scene_per_wu
        self.R = (np.eye(3, dtype='float32') if R is None
                  else np.asarray(R, 'float32'))
        self.ppu = 4.0
        self.cx = w / 2.0
        self.cy = h / 2.0
        self.depth = (np.full((h, w), 10.0, 'float32') if depth is None
                      else np.asarray(depth, 'float32'))
        px = np.arange(w, dtype='float32')[None, :].repeat(h, 0)
        py = np.arange(h, dtype='float32')[:, None].repeat(w, 1)
        self.q = np.stack([(px - self.cx) / self.ppu,
                           (self.cy - py) / self.ppu,
                           self.depth], -1).astype('float32')
        self.world = (self.q @ self.R.T).astype('float32')
        self.shadow_bias = shadow_bias


def _one_px(world_pt=(0.0, 0.0, 0.0), n=(0.0, 1.0, 0.0), sbias=(44.0, 210.0)):
    """单像素场景(无阴影用):world 直接指定。"""
    inp = _Inp(h=1, w=1, shadow_bias=sbias)
    inp.world = np.asarray(world_pt, 'float32').reshape(1, 1, 3)
    inp.q = inp.world.copy()
    a0 = np.full((1, 1), 0.4, 'float32')
    a1 = np.zeros((1, 1, 3), 'float32')
    nrm = np.asarray(n, 'float32').reshape(1, 1, 3)
    return inp, a0, a1, nrm


def _falloff_ref(r2, rng, soft_r):
    return math.exp(-r2 / rng ** 2) / (r2 + soft_r ** 2)


# ------------------------------------------------ 方向约定(lightPacking)

def test_direction_from_angles_z_is_plus_cos_cos():
    """z 分量是 **+cos·cos**(lightPacking 原注:翻号会让全部场景的太阳与
    聚光前后颠倒)。az 0 = 画面深处,90 = 右侧。"""
    assert np.allclose(L.direction_from_angles(0, 0), [0, 0, 1], atol=1e-7)
    assert np.allclose(L.direction_from_angles(0, 90), [1, 0, 0], atol=1e-7)
    assert np.allclose(L.direction_from_angles(90, 123), [0, 1, 0], atol=1e-6)


def test_sun_light_of_first_enabled_directional():
    lights = [{'kind': 'point', 'enabled': True},
              {'kind': 'directional', 'enabled': False, 'id': 'off'},
              {'kind': 'directional', 'enabled': True, 'id': 'sun'},
              {'kind': 'directional', 'id': 'later'}]
    assert L.sun_light_of(lights)['id'] == 'sun'
    assert L.sun_light_of([]) is None


# ------------------------------------------------ 点光(lcFalloff/lcPointLight)

def test_point_light_hand_value():
    """独立手算:qu=1/150,灯在正上 300wu(=2q),range 450wu,软化 15wu。"""
    inp, a0, a1, nrm = _one_px()
    lamp = {'id': 'p', 'kind': 'point', 'enabled': True, 'intensity': 2.0,
            'color': _WHITE, 'pos': [0.0, 300.0, 0.0],
            'range': 450.0, 'softeningRadius': 15.0, 'castShadow': False}
    e = L.eval_scene_lights([lamp], inp, a0, a1, nrm)
    expect = 2.0 * 1.0 * _falloff_ref(4.0, 3.0, 0.1)
    assert np.allclose(e[0, 0], [expect] * 3, rtol=1e-5), (e[0, 0], expect)


def test_point_defaults_range_and_softening():
    """缺省专项:省掉 range/softeningRadius,必须按 packLights 缺省 450/10
    求值(突变审查:此前每个测试都写全字段,缺省决议零覆盖)。"""
    inp, a0, a1, nrm = _one_px()
    lamp = {'kind': 'point', 'intensity': 1.0, 'color': _WHITE,
            'pos': [0.0, 600.0, 0.0]}                 # r=4q;只给必需字段
    e = L.eval_scene_lights([lamp], inp, a0, a1, nrm)
    expect = _falloff_ref(16.0, 450.0 / 150.0, 10.0 / 150.0)
    assert np.allclose(e[0, 0], [expect] * 3, rtol=1e-5), (e[0, 0], expect)


def test_point_cut_threshold_exact():
    """cut 早退阈**贴着 1e-4 测**(此前 r≫range 的版本离阈 4000 个数量级,
    钉的是「很远⇒0」不是阈值):r²/R² = 9.4 ⇒ cut≈8.3e-5 < 1e-4 ⇒ 0;
    r²/R² = 9.0 ⇒ cut≈1.23e-4 ≥ 1e-4 ⇒ 非零。"""
    inp, a0, a1, nrm = _one_px()
    base = {'kind': 'point', 'intensity': 1e3, 'color': _WHITE,
            'range': 450.0, 'softeningRadius': 15.0}
    r_in = 3.0 * math.sqrt(9.0) / 3.0 * 450.0        # = 3.0q → 直接给 wu
    e_in = L.eval_scene_lights(
        [{**base, 'pos': [0.0, math.sqrt(9.0) * 3.0 * 150.0, 0.0]}],
        inp, a0, a1, nrm)                             # r = 9q, r²/R²=9
    e_out = L.eval_scene_lights(
        [{**base, 'pos': [0.0, math.sqrt(9.4) * 3.0 * 150.0, 0.0]}],
        inp, a0, a1, nrm)                             # r²/R² = 9.4
    assert float(e_in[0, 0, 0]) > 0.0
    assert float(np.abs(e_out).max()) == 0.0
    _ = r_in


def test_point_ndl_clamped():
    """N·L 负半球必须钳 0(灯在平面背后)。"""
    inp, a0, a1, nrm = _one_px()
    lamp = {'kind': 'point', 'intensity': 5.0, 'color': _WHITE,
            'pos': [0.0, -300.0, 0.0], 'range': 450.0, 'softeningRadius': 15.0}
    e = L.eval_scene_lights([lamp], inp, a0, a1, nrm)
    assert float(np.abs(e).max()) == 0.0


def test_zero_intensity_skipped():
    inp, a0, a1, nrm = _one_px()
    lamp = {'kind': 'point', 'intensity': 0.0, 'pos': [0, 300, 0]}
    assert float(np.abs(L.eval_scene_lights([lamp], inp, a0, a1, nrm)).max()) \
        == 0.0


def test_unknown_kind_falls_back_to_point():
    """未知 kind 回落成点光(镜像 `LIGHT_KIND_CODE[l.kind] ?? 0`)并出声,
    不许崩(运行时就这么渲染)。"""
    inp, a0, a1, nrm = _one_px()
    base = {'intensity': 2.0, 'color': _WHITE, 'pos': [0.0, 300.0, 0.0],
            'range': 450.0, 'softeningRadius': 15.0}
    notes: list = []
    e_bad = L.eval_scene_lights([{**base, 'kind': 'spotlight', 'id': 'x'}],
                                inp, a0, a1, nrm, notes=notes)
    e_pt = L.eval_scene_lights([{**base, 'kind': 'point'}], inp, a0, a1, nrm)
    assert np.array_equal(e_bad, e_pt)
    assert any('spotlight' in n for n in notes)


# ------------------------------------------------ 聚光(lcSpotLight)

def test_spot_on_axis_equals_point():
    inp, a0, a1, nrm = _one_px()
    base = {'enabled': True, 'intensity': 2.0, 'color': _WHITE,
            'pos': [0.0, 300.0, 0.0], 'range': 450.0, 'softeningRadius': 15.0}
    p = L.eval_scene_lights([{**base, 'kind': 'point'}], inp, a0, a1, nrm)
    s = L.eval_scene_lights([{**base, 'kind': 'spot', 'dir': [0, -1, 0],
                              'innerAngleDeg': 25.0, 'outerAngleDeg': 40.0}],
                            inp, a0, a1, nrm)
    assert np.allclose(p, s, rtol=1e-6)


def test_spot_default_cone_is_pack_lights_25_40():
    """缺省锥角专项:**求值面是 packLights 的 25/40**,不是 lightDefaults
    的 25/45 —— 离轴角选在 cos40 与 cos45 之间才能分辨这两个口径。"""
    inp, a0, a1, nrm = _one_px(world_pt=(1.0, 0.0, 0.0))
    lamp = {'kind': 'spot', 'intensity': 2.0, 'color': _WHITE,
            'pos': [0.0, 300.0, 0.0], 'dir': [0.0, -1.0, 0.0]}  # 缺省锥角
    e = L.eval_scene_lights([lamp], inp, a0, a1, nrm)
    v = np.array([-1.0, 2.0, 0.0])
    r2 = float(v @ v)
    Ld = v / math.sqrt(r2)
    cos_t = float(-Ld @ np.array([0.0, -1.0, 0.0]))   # ≈0.894,∈(cos40,cos25)
    ci, co = math.cos(math.radians(25)), math.cos(math.radians(40))
    t = min(max((cos_t - co) / (ci - co), 0.0), 1.0)
    cone = t * t * (3 - 2 * t)
    expect = 2.0 * float(Ld[1]) * cone * _falloff_ref(r2, 3.0, 10.0 / 150.0)
    assert np.allclose(e[0, 0], [expect] * 3, rtol=1e-5), (e[0, 0], expect)
    # 用 outer=45 的口径算会得出显著不同的值 —— 突变哨兵
    t45 = (cos_t - math.cos(math.radians(45))) / (ci - math.cos(math.radians(45)))
    cone45 = t45 * t45 * (3 - 2 * t45)
    # 25/40 与 25/45 在此角度差 ~1.2% —— 远大于主断言的 rtol 1e-5,足以分辨
    assert abs(cone45 - cone) > 0.008


def test_spot_cone_smoothstep_hand_value_and_outside():
    inp, a0, a1, nrm = _one_px(world_pt=(1.0, 0.0, 0.0))
    lamp = {'kind': 'spot', 'intensity': 2.0, 'color': _WHITE,
            'pos': [0.0, 300.0, 0.0], 'range': 450.0, 'softeningRadius': 15.0,
            'dir': [0.0, -1.0, 0.0], 'innerAngleDeg': 25.0,
            'outerAngleDeg': 40.0}
    e = L.eval_scene_lights([lamp], inp, a0, a1, nrm)
    v = np.array([-1.0, 2.0, 0.0])
    r2 = float(v @ v)
    Ld = v / math.sqrt(r2)
    cos_t = float(-Ld @ np.array([0.0, -1.0, 0.0]))
    ci, co = math.cos(math.radians(25)), math.cos(math.radians(40))
    t = min(max((cos_t - co) / (ci - co), 0.0), 1.0)
    cone = t * t * (3 - 2 * t)
    expect = 2.0 * float(Ld[1]) * cone * _falloff_ref(r2, 3.0, 0.1)
    assert np.allclose(e[0, 0], [expect] * 3, rtol=1e-5)
    inp2, a0, a1, nrm = _one_px(world_pt=(5.0, 0.0, 0.0))
    e2 = L.eval_scene_lights([lamp], inp2, a0, a1, nrm)
    assert float(np.abs(e2).max()) == 0.0


# ------------------------------------------------ 面光(全链 + 独立积分)

def _area_axes_ref(n, roll):
    """areaAxes 的**独立复刻**(照 GLSL 规格重写,不调被测实现)。"""
    up = (np.array([1.0, 0.0, 0.0]) if abs(n[1]) > 0.95
          else np.array([0.0, 1.0, 0.0]))
    u = np.cross(up, n)
    u = u / np.linalg.norm(u)
    v = np.cross(n, u)
    c, s = math.cos(roll), math.sin(roll)
    return u * c + v * s, v * c - u * s


def _rect_e_numeric(P, N, center, hu, hv, n=900):
    """独立数值积分 E = ∫ cosθ_P·cosθ_L/(π r²) dA(单面,面板法线
    = normalize(cross(hu,hv)) 朝 P 一侧才积)。"""
    g = (np.arange(n) + 0.5) / n * 2 - 1
    uu, vv = np.meshgrid(g, g)
    pts = center[None, None, :] + uu[..., None] * hu + vv[..., None] * hv
    d = pts - P
    r2 = (d * d).sum(-1)
    r = np.sqrt(r2)
    cos_p = np.maximum((d @ N) / r, 0.0)
    fn = np.cross(hu, hv)
    fn = fn / np.linalg.norm(fn)
    cos_l = np.maximum((-(d @ fn)) / r, 0.0)
    dA = (2 * np.linalg.norm(hu)) * (2 * np.linalg.norm(hv)) / (n * n)
    return float((cos_p * cos_l / (np.pi * r2) * dA).sum())


def test_area_full_chain_vs_numeric_integral():
    """面光**全链**(size→×0.5→×qu→areaAxes(roll)→lcAreaLight,含
    dir??orientation 取值序)对着独立积分。此前的回归测试绕过 `_one_lamp_e`
    自造 hu/hv,size/roll/单位链全是覆盖真空 —— 这条补上。
    灯同时带 dir(朝下,正确)与 orientation(朝上,诱饵):packLights 是
    **dir 优先**(P0-1),取反会得 0。"""
    inp, a0, a1, nrm = _one_px(world_pt=(0.4, 0.0, 0.2))
    lamp = {'kind': 'area', 'intensity': 1.7, 'color': _WHITE,
            'pos': [0.0, 300.0, 75.0], 'range': 450.0,
            'dir': [0.0, -1.0, 0.0], 'orientation': [0.0, 1.0, 0.0],
            'size': [200.0, 150.0], 'rollDeg': 35.0, 'twoSided': False}
    e = L.eval_scene_lights([lamp], inp, a0, a1, nrm)
    qu = 1.0 / 150.0
    n_ = np.array([0.0, -1.0, 0.0])
    au, av = _area_axes_ref(n_, math.radians(35.0))
    hu = au * (200.0 * 0.5 * qu)
    hv = av * (150.0 * 0.5 * qu)
    P = np.array([0.4, 0.0, 0.2])
    center = np.array([0.0, 2.0, 0.5])
    d = center - P
    cut = math.exp(-float(d @ d) / 3.0 ** 2)
    expect = 1.7 * _rect_e_numeric(P, np.array([0.0, 1.0, 0.0]),
                                   center, hu, hv) * cut
    assert abs(float(e[0, 0, 0]) - expect) < 3e-3 * expect, \
        (float(e[0, 0, 0]), expect)


def test_area_hemisphere_anchor():
    """解析锚:巨大朝下面板全覆盖上半球 ⇒ Lambert 多边形式 E→1(Σ→2π)。"""
    inp, a0, a1, nrm = _one_px()
    lamp = {'kind': 'area', 'intensity': 1.0, 'color': _WHITE,
            'pos': [0.0, 10.0 * 150, 0.0], 'range': 1e7,
            'orientation': [0.0, -1.0, 0.0], 'size': [1e6, 1e6],
            'twoSided': False}
    e = L.eval_scene_lights([lamp], inp, a0, a1, nrm)
    assert 0.97 < float(e[0, 0, 0]) <= 1.001, e[0, 0]


def test_area_winding_regression_runtime_case():
    """运行时验尸的几何(lightingCore 注释):面板 (950,357,0)、半轴
    150×100、法线朝下、地面点法线 (0,1,0)。期望值锚在**独立数值积分**
    0.128340(运行时注释写 0.1328 是四舍五入实测,差 3.5‰,已裁决)。
    绕向翻错时这里得**负值**(被 max(0) 吃成 0)—— 逐字回归。"""
    n_ = np.array([0.0, -1.0, 0.0])
    hu_u, hv_u = L._area_axes(n_, 0.0)
    hu, hv = hu_u * 150.0, hv_u * 100.0
    c = np.array([950.0, 357.0, 0.0])
    P = np.array([[950.0, 0.0, 0.0]])
    N = np.array([[0.0, 1.0, 0.0]])
    e = L._rect_irradiance(P, N, [c - hu - hv, c - hu + hv,
                                  c + hu + hv, c + hu - hv])
    assert abs(float(e[0]) - 0.128340) < 1e-4, float(e[0])


def test_area_sides_and_two_sided():
    inp, a0, a1, nrm = _one_px()
    base = {'kind': 'area', 'intensity': 1.5, 'color': _WHITE,
            'pos': [0.0, 300.0, 0.0], 'range': 450.0, 'size': [200.0, 150.0]}
    down = L.eval_scene_lights([{**base, 'orientation': [0, -1, 0]}],
                               inp, a0, a1, nrm)
    up = L.eval_scene_lights([{**base, 'orientation': [0, 1, 0]}],
                             inp, a0, a1, nrm)
    two = L.eval_scene_lights([{**base, 'orientation': [0, 1, 0],
                                'twoSided': True}], inp, a0, a1, nrm)
    assert float(down[0, 0, 0]) > 0.0
    assert float(np.abs(up).max()) == 0.0          # 单面背面
    assert np.allclose(two, down, rtol=1e-5)       # 双面 = abs(翻转对称)


# ------------------------------------------------ 平行光与太阳(pass 镜像)

def test_sun_linear_visibility_hand_value():
    """sunVis = 1 − 0.9·(1−clamp(α+β·ω)),α/β 按 §5.5 闭式手算。"""
    inp, _a0, _a1, nrm = _one_px()
    a0 = np.full((1, 1), 0.4, 'float32')
    a1 = np.zeros((1, 1, 3), 'float32')
    a1[..., 1] = 0.3
    sun = {'kind': 'directional', 'enabled': True, 'intensity': 2.0,
           'color': _WHITE, 'elevationDeg': 90.0, 'azimuthDeg': 0.0,
           'castShadow': True}
    e = L.eval_scene_lights([sun], inp, a0, a1, nrm)
    vdir = min(max((8 * 0.4 - 6 * 0.3) + (12 * 0.3 - 12 * 0.4), 0.0), 1.0)
    expect = 2.0 * (1.0 - 0.9 * (1.0 - vdir))
    assert np.allclose(e[0, 0], [expect] * 3, rtol=1e-5), (e[0, 0], expect)
    e2 = L.eval_scene_lights([{**sun, 'castShadow': False}], inp, a0, a1, nrm)
    assert np.allclose(e2[0, 0], [2.0] * 3, rtol=1e-6)


def test_sun_defaults_omitted():
    """缺省专项:太阳只给 intensity/color —— elevationDeg/azimuthDeg 必须按
    45/180 决议,castShadow 必须按 **true**(packLights `?? true` ⇒ 0.9)。"""
    inp, _a0, _a1, nrm = _one_px()
    a0 = np.full((1, 1), 0.4, 'float32')
    a1 = np.zeros((1, 1, 3), 'float32')
    a1[:] = [0.1, 0.3, -0.2]
    sun = {'kind': 'directional', 'enabled': True, 'intensity': 1.0,
           'color': _WHITE}
    e = L.eval_scene_lights([sun], inp, a0, a1, nrm)
    w = np.array([math.cos(math.radians(45)) * math.sin(math.radians(180)),
                  math.sin(math.radians(45)),
                  math.cos(math.radians(45)) * math.cos(math.radians(180))])
    alpha = 8 * 0.4 - 6 * 0.3
    beta = np.array([3 * 0.1, 12 * 0.3 - 12 * 0.4, 3 * -0.2])
    vdir = min(max(alpha + float(beta @ w), 0.0), 1.0)
    expect = 1.0 * float(w[1]) * (1.0 - 0.9 * (1.0 - vdir))   # N=up ⇒ ndl=w_y
    assert np.allclose(e[0, 0], [expect] * 3, rtol=1e-5), (e[0, 0], expect)


def test_sun_vdir_clamped_to_one():
    """α+β·ω > 1 必须钳到 1(去掉 clamp 会把 sunVis 抬过 1)。"""
    inp, _a0, _a1, nrm = _one_px()
    a0 = np.full((1, 1), 0.2, 'float32')
    a1 = np.zeros((1, 1, 3), 'float32')
    a1[..., 1] = 0.6                                # α+β_y = 2.8 → clamp 1
    sun = {'kind': 'directional', 'enabled': True, 'intensity': 2.0,
           'color': _WHITE, 'elevationDeg': 90.0, 'azimuthDeg': 0.0,
           'castShadow': True}
    e = L.eval_scene_lights([sun], inp, a0, a1, nrm)
    assert np.allclose(e[0, 0], [2.0] * 3, rtol=1e-6), e[0, 0]


def test_extra_directional_vis_one():
    """额外 directional(非第一盏)vis≡1(pass 逐字)。"""
    inp, a0, a1, nrm = _one_px()
    a1[..., 1] = -0.4
    sun = {'kind': 'directional', 'enabled': True, 'intensity': 0.0,
           'elevationDeg': 90.0, 'castShadow': True}
    moon = {'kind': 'directional', 'enabled': True, 'intensity': 1.0,
            'color': _WHITE, 'elevationDeg': 90.0, 'azimuthDeg': 0.0,
            'castShadow': True}
    e = L.eval_scene_lights([sun, moon], inp, a0, a1, nrm)
    assert np.allclose(e[0, 0], [1.0] * 3, rtol=1e-6)


# ------------------------------------------------ 场景侧阴影(判据 + 投影可观测)

def test_scene_shadow_criterion_no_thick():
    """场景侧:被挡 ⟺ ∃点 pen > bias,**没有 thick 上限**。"""
    inp = _Inp()
    q_flat = np.array([[0.0, 0.0, 3.0]])
    lq = np.array([-2.0, 0.0, 3.0])
    bias_q = 30.8 / 150.0
    inp.depth[:] = 2.9                                  # pen=0.1 < bias
    assert L._scene_lamp_visibility(inp, q_flat, lq, bias_q)[0] == 1.0
    inp.depth[:] = 2.7                                  # pen=0.3 > bias
    assert L._scene_lamp_visibility(inp, q_flat, lq, bias_q)[0] == 0.0
    inp.depth[:] = 0.2                                  # pen=2.8:场景侧照样挡
    assert L._scene_lamp_visibility(inp, q_flat, lq, bias_q)[0] == 0.0


def test_scene_shadow_projection_observable():
    """结构化深度场钉投影公式(突变审查:常数场下 py 翻号/丢 ppu/xy 互换
    全体存活)。遮挡块贴在**像素端**(rows 3..5 × cols 14..16):正确路径
    (row4 · cols8..16)在 t→0 就撞上;py 翻号的路径从 row12 斜向灯端、
    经过 cols14..16 时还在 rows 10..12,永远够不着遮挡块 —— 翻号/丢 ppu/
    xy 互换全部漏挡(灯端公式是另一条,故意做成非对称几何)。"""
    depth = np.full((16, 32), 10.0, 'float32')
    depth[3:6, 14:17] = 0.2
    inp = _Inp(depth=depth)
    q_flat = np.array([[0.0, 1.0, 3.0]])            # px=16, py=8−4=4
    lq = np.array([-2.0, 1.0, 3.0])                 # px=8, 同 row
    assert L._scene_lamp_visibility(inp, q_flat, lq, 30.8 / 150.0)[0] == 0.0
    # 控制组:遮挡块挪到 rows 9..12(翻号那条路径才会撞上)⇒ 不挡
    depth2 = np.full((16, 32), 10.0, 'float32')
    depth2[9:13, 14:17] = 0.2
    inp2 = _Inp(depth=depth2)
    assert L._scene_lamp_visibility(inp2, q_flat, lq, 30.8 / 150.0)[0] == 1.0


def test_scene_shadow_thin_occluder_dense_steps():
    """薄遮挡(段前 5%–10%)必须被缺省步数抓住 —— 步数塌到个位数就漏。"""
    depth = np.full((16, 32), 10.0, 'float32')
    depth[:, 14:16] = 0.2                           # px 14..15 的窄墙
    inp = _Inp(depth=depth)
    q_flat = np.array([[0.0, 0.0, 3.0]])            # px=16
    lq = np.array([-4.0, 0.0, 3.0])                 # px=0:墙在段前 ~6%
    assert L._scene_lamp_visibility(inp, q_flat, lq, 30.8 / 150.0)[0] == 0.0


def test_eval_reads_scene_shadow_bias():
    """bias 必须来自 `inp.shadow_bias`(场景 lighting.shadowBias):
    pen=0.3q 在缺省 bias(0.205q)下被挡,在本场景 bias=60wu(0.4q)下不挡。
    夹具缺省 (44,210) 本就 ≠ 库缺省 —— 硬编码常量的突变在这里现形。"""
    depth = np.full((16, 32), 2.7, 'float32')
    depth[8, 16] = 3.0                              # 目标像素的表面深度
    lamp = {'id': 'l', 'kind': 'point', 'intensity': 5.0, 'color': _WHITE,
            'pos': [-300.0, 0.0, 450.0], 'range': 450.0,
            'softeningRadius': 15.0, 'castShadow': True}
    a0 = np.full((16, 32), 0.4, 'float32')
    a1 = np.zeros((16, 32, 3), 'float32')
    nrm = np.tile(np.array([-1, 0, 0], 'float32'), (16, 32, 1))  # 朝灯
    inp_hi = _Inp(depth=depth, shadow_bias=(60.0, 300.0))   # bias 0.4 > pen
    e_hi = L.eval_scene_lights([lamp], inp_hi, a0, a1, nrm)
    assert float(e_hi[8, 16].max()) > 0.0
    inp_lo = _Inp(depth=depth, shadow_bias=(30.8, 264.0))   # bias 0.205 < pen
    e_lo = L.eval_scene_lights([lamp], inp_lo, a0, a1, nrm)
    assert float(e_lo[8, 16].max()) == 0.0


def test_eval_world_to_q_uses_R_not_transpose():
    """R≠I 的场景:灯位世界→q 必须走 qᵀ=wᵀR(input 的 world=q@R.T 之逆)。
    正确变换下灯的 march 段穿过遮挡条带(挡);用 R.T 的突变把灯投到画面
    另一侧,段避开条带(不挡)。"""
    R = np.array([[0, 0, -1], [0, 1, 0], [1, 0, 0]], 'float32')  # 绕 y 90°
    depth = np.full((16, 32), 10.0, 'float32')
    depth[3:6, 8:12] = 0.2                          # 条带
    depth[4, 16] = 3.0                              # 目标像素表面
    inp = _Inp(depth=depth, R=R)
    # 目标像素 (py=4,px=16):q=(0,1,3)。灯要落在 q=(−2,1,3) ⇒
    # w = (q 的逆变换):q=w@R ⇒ w=q@R.T = (−3,1,2)…直接解:w=(wx,wy,wz),
    # q=(wz,wy,−wx) ⇒ wz=−2, wy=1, wx=−3。
    lamp = {'id': 'l', 'kind': 'point', 'intensity': 5.0, 'color': _WHITE,
            'pos': [-3.0 * 150, 1.0 * 150, -2.0 * 150], 'range': 450.0,
            'softeningRadius': 15.0, 'castShadow': True}
    a0 = np.full((16, 32), 0.4, 'float32')
    a1 = np.zeros((16, 32, 3), 'float32')
    # 世界系里 L = 光−P = (0,0,−2)·150 → N 取 (0,0,−1) 正对灯
    nrm = np.tile(np.array([0, 0, -1], 'float32'), (16, 32, 1))
    e = L.eval_scene_lights([lamp], inp, a0, a1, nrm)
    assert float(e[4, 16].max()) == 0.0             # 被条带挡
    depth2 = depth.copy()
    depth2[3:6, 8:12] = 10.0                        # 清掉条带 ⇒ 亮(自检)
    e2 = L.eval_scene_lights([lamp], _Inp(depth=depth2, R=R), a0, a1, nrm)
    assert float(e2[4, 16].max()) > 0.0


def test_shadow_vis_cache_reuse_and_invalidate():
    """vis_cache:同灯复用(改深度不重算 ⇒ 结果不变);挪灯/改 range 都是
    新键(range 决定活像素域,不进键会让扩圈吃到旧图)。"""
    inp = _Inp(h=2, w=2)
    inp.world = np.zeros((2, 2, 3), 'float32')
    inp.q = np.zeros((2, 2, 3), 'float32')
    a0 = np.full((2, 2), 0.4, 'float32')
    a1 = np.zeros((2, 2, 3), 'float32')
    nrm = np.tile(np.array([0, 1, 0], 'float32'), (2, 2, 1))
    lamp = {'kind': 'point', 'intensity': 2.0, 'color': _WHITE,
            'pos': [0.0, 300.0, 0.0], 'range': 450.0, 'softeningRadius': 15.0,
            'castShadow': True}
    cache: dict = {}
    e1 = L.eval_scene_lights([lamp], inp, a0, a1, nrm, vis_cache=cache)
    assert len(cache) == 1 and float(e1.max()) > 0
    inp.depth[:] = -10.0
    e2 = L.eval_scene_lights([lamp], inp, a0, a1, nrm, vis_cache=cache)
    assert np.array_equal(e1, e2)                   # 缓存命中,未重 march
    L.eval_scene_lights([{**lamp, 'pos': [0.0, 310.0, 0.0]}],
                        inp, a0, a1, nrm, vis_cache=cache)
    assert len(cache) == 2                          # 挪灯 ⇒ 新键
    L.eval_scene_lights([{**lamp, 'range': 600.0}],
                        inp, a0, a1, nrm, vis_cache=cache)
    assert len(cache) == 3                          # 改 range ⇒ 新键


def test_light_count_cap_and_shadow_slab_cap():
    """运行时的两道截断必须镜像:>24 盏丢弃(打包告警);castShadow 的灯
    打包下标 ≥8 强制不投影(线扫只有两张 slab)。"""
    inp, a0, a1, nrm = _one_px()
    dummies = [{'id': f'd{i}', 'kind': 'point', 'intensity': 0.0,
                'pos': [0, 300, 0]} for i in range(24)]
    big = {'id': 'late', 'kind': 'point', 'intensity': 100.0,
           'color': _WHITE, 'pos': [0.0, 300.0, 0.0], 'range': 450.0,
           'softeningRadius': 15.0}
    notes: list = []
    e = L.eval_scene_lights(dummies + [big], inp, a0, a1, nrm, notes=notes)
    assert float(np.abs(e).max()) == 0.0            # 第 25 盏被丢
    assert any('超上限' in n for n in notes)
    # slab:9 盏全遮几何的 castShadow 灯 —— 前 8 盏被影子归零,第 9 盏强制亮
    depth = np.full((16, 32), 2.0, 'float32')
    depth[8, 16] = 3.0
    inp2 = _Inp(depth=depth, shadow_bias=(30.8, 264.0))
    a0g = np.full((16, 32), 0.4, 'float32')
    a1g = np.zeros((16, 32, 3), 'float32')
    ng = np.tile(np.array([-1, 0, 0], 'float32'), (16, 32, 1))   # 朝灯
    lamps = [{'id': f'c{i}', 'kind': 'point', 'intensity': 2.0,
              'color': _WHITE, 'pos': [-300.0, 0.0, 450.0], 'range': 450.0,
              'softeningRadius': 15.0, 'castShadow': True} for i in range(9)]
    notes2: list = []
    e8 = L.eval_scene_lights(lamps[:8], inp2, a0g, a1g, ng, notes=notes2)
    assert float(e8[8, 16].max()) == 0.0            # 前 8 盏:真被挡
    e9 = L.eval_scene_lights(lamps, inp2, a0g, a1g, ng, notes=notes2)
    assert float(e9[8, 16].max()) > 0.0             # 第 9 盏:阴影强制关 ⇒ 亮
    assert any('线扫不覆盖' in n for n in notes2)


# ------------------------------------------------ 角色侧阴影(march 参数逐个钉)

def test_char_shadow_thick_window():
    """角色侧:pen 必须落在 (bias, thick) **窗**内才算挡。"""
    inp = _Inp(shadow_bias=(30.8, 264.0))
    bias0_q, thick_q = 30.8 / 150.0, 264.0 / 150.0
    inp.depth[:] = 0.2
    q0 = np.array([0.0, 0.0, 0.0])
    lq = np.array([0.0, 0.0, 3.0])                  # pen∈窗 ⇒ 挡
    assert L._char_lamp_visibility(inp, q0, lq, bias0_q, thick_q) == 0.0
    q0c = np.array([0.0, 0.0, 2.5])
    lq_c = np.array([0.0, 0.0, 5.0])                # pen≈2.5.. > thick ⇒ 不挡
    assert L._char_lamp_visibility(inp, q0c, lq_c, bias0_q, thick_q) == 1.0


def test_char_march_len_092_stops_short():
    """marchLen = len·0.92:最后 8% 里的遮挡体够不着(逐字镜像);
    len·1.0 的突变会踩进 col24。"""
    depth = np.full((16, 32), 10.0, 'float32')
    depth[8, 24] = 8.4                              # 只在终点像素:pen=1.6∈窗
    inp = _Inp(depth=depth, shadow_bias=(30.8, 264.0))
    q0 = np.array([0.0, 0.0, 0.0])
    lq = np.array([2.0, 0.0, 10.0])                 # px 16→24;正确实现最远采 23
    assert L._char_lamp_visibility(inp, q0, lq, 30.8 / 150.0,
                                   264.0 / 150.0) == 1.0


def test_char_march_16_steps_granularity():
    """16 步的第 1 步(t=0.92/16)落在 col16 —— 8 步的突变第 1 步已到
    col17,漏掉这面墙。"""
    depth = np.full((16, 32), 10.0, 'float32')
    depth[8, 16] = 0.2                              # i=1 采样点:pen=0.375∈窗
    inp = _Inp(depth=depth, shadow_bias=(30.8, 264.0))
    q0 = np.array([0.0, 0.0, 0.0])
    lq = np.array([2.0, 0.0, 10.0])
    assert L._char_lamp_visibility(inp, q0, lq, 30.8 / 150.0,
                                   264.0 / 150.0) == 0.0


def test_char_march_bias_grows_with_step():
    """bias = bias0 + 0.02·st·i:i=1 处窗下沿 0.2165,pen=0.21 落在增长段
    里(0.205 < 0.21 < 0.2165)⇒ 不挡;去掉增长的突变会判挡。"""
    st = 10.0 * 0.92 / 16
    z1 = st * 1.0                                   # i=1 的射线深度
    depth = np.full((16, 32), 10.0, 'float32')
    depth[8, 16] = np.float32(z1 - 0.21)            # pen=0.21
    inp = _Inp(depth=depth, shadow_bias=(30.8, 264.0))
    q0 = np.array([0.0, 0.0, 0.0])
    lq = np.array([2.0, 0.0, 10.0])
    assert L._char_lamp_visibility(inp, q0, lq, 30.8 / 150.0,
                                   264.0 / 150.0) == 1.0


# ------------------------------------------------ 实体侧(探针 = 角色口径)

def test_probe_point_hand_value():
    """探针点光独立手算(不回环调用场景 eval)。"""
    inp = _Inp()
    lamp = {'kind': 'point', 'intensity': 2.0, 'color': _WHITE,
            'pos': [0.0, 300.0, 0.0], 'range': 450.0, 'softeningRadius': 15.0,
            'castShadow': False}
    N = np.array([0, 1, 0], 'float32').reshape(1, 1, 3)
    probe = L.eval_probe_lights([lamp], N, [0.0, 0.0, 0.0], inp)
    expect = 2.0 * _falloff_ref(4.0, 3.0, 0.1)
    assert np.allclose(probe[0, 0], [expect] * 3, rtol=1e-5)


def test_probe_uses_char_criterion_not_scene():
    """判据甄别:整片深度 0.2、探针悬在 z=2.5 —— 沿 z 向灯 march 的 pen
    从 2.3 起步,**全部超出 thick 窗**(墙背后的空气):角色判据放行,
    场景判据(无窗)照挡。探针必须亮,同灯同几何的场景像素必须黑。"""
    depth = np.full((16, 32), 0.2, 'float32')
    inp = _Inp(depth=depth, shadow_bias=(30.8, 264.0))
    lamp = {'id': 'l', 'kind': 'point', 'intensity': 2.0, 'color': _WHITE,
            'pos': [0.0, 0.0, 750.0], 'range': 1500.0,
            'softeningRadius': 15.0, 'castShadow': True}
    N = np.array([0, 0, 1], 'float32').reshape(1, 1, 3)
    probe = L.eval_probe_lights([lamp], N, [0.0, 0.0, 2.5], inp)
    assert float(probe.max()) > 0.0                 # 角色 thick 窗放行
    # 场景像素 [8,16]:q=(0,0,0.2)(表面即深度场),march 向灯 pen 恒 >bias
    a0 = np.full((16, 32), 0.4, 'float32')
    a1 = np.zeros((16, 32, 3), 'float32')
    nrm = np.tile(np.array([0, 0, 1], 'float32'), (16, 32, 1))   # 朝灯
    e = L.eval_scene_lights([lamp], inp, a0, a1, nrm)
    assert float(e[8, 16].max()) == 0.0             # 场景无窗判据:挡


def test_probe_sun_marches_like_character():
    """探针太阳 = 角色口径 **march**(48 步 / len 3.5 / 同 bias/thick 窗),
    不是体积 V_dir(审查 P1-4)。天花板使 blocked=0 ⇒ sunVis=0.1。"""
    depth = np.full((16, 32), 2.0, 'float32')       # march 向上撞它:pen=1.0∈窗
    depth[8, 16] = 3.0                              # 探针脚下像素(不参与)
    inp = _Inp(depth=depth, shadow_bias=(30.8, 264.0))
    sun = {'kind': 'directional', 'enabled': True, 'intensity': 2.0,
           'color': _WHITE, 'elevationDeg': 90.0, 'azimuthDeg': 0.0}
    N = np.array([0, 1, 0], 'float32').reshape(1, 1, 3)
    probe = L.eval_probe_lights([sun], N, [0.0, 0.0, 3.0], inp)
    expect = 2.0 * 1.0 * (1.0 - 0.9 * (1.0 - 0.0))  # castShadow 缺省 true
    assert np.allclose(probe[0, 0], [expect] * 3, rtol=1e-5), probe[0, 0]
    # 无天花板 ⇒ blocked=1 ⇒ 全亮(控制组)
    probe2 = L.eval_probe_lights([sun], N, [0.0, 0.0, 3.0], _Inp())
    assert np.allclose(probe2[0, 0], [2.0] * 3, rtol=1e-5)


def test_probe_no_cut_gate():
    """角色循环没有 pass 级 cut 早退(P2-12):cut<1e-4 处探针给微小非零,
    场景给 0 —— 两侧口径分开钉。"""
    inp, a0, a1, nrm = _one_px()
    lamp = {'kind': 'point', 'intensity': 1e3, 'color': _WHITE,
            'pos': [0.0, math.sqrt(9.4) * 3.0 * 150.0, 0.0],
            'range': 450.0, 'softeningRadius': 15.0}
    scene = L.eval_scene_lights([lamp], inp, a0, a1, nrm)
    assert float(np.abs(scene).max()) == 0.0
    N = np.array([0, 1, 0], 'float32').reshape(1, 1, 3)
    probe = L.eval_probe_lights([lamp], N, [0.0, 0.0, 0.0], _Inp())
    assert float(probe.max()) > 0.0


# ------------------------------------------------ 缺省/换型(编辑面镜像)

def test_default_light_mirror():
    d = L.default_light(3, 'spot')
    assert d['id'] == 'light_3' and d['innerAngleDeg'] == 25.0 \
        and d['outerAngleDeg'] == 45.0 and d['range'] == 450.0
    dd = L.default_light(1, 'directional')
    assert 'pos' not in dd and dd['intensity'] == 0.4 and dd['kelvin'] == 7000.0
    da = L.default_light(1, 'area')
    assert da['size'] == [135.0, 90.0] and da['twoSided'] is False
    # 面光不吃软化(C.y 装自转角)—— 缺省就不该带,免得作者以为自己调了
    assert 'softeningRadius' not in da


def test_retype_field_hygiene():
    spot = {'id': 'x', 'kind': 'spot', 'enabled': False, 'intensity': 3.3,
            'kelvin': 1800.0, 'castShadow': True, 'pos': [1, 2, 3],
            'range': 600.0, 'softeningRadius': 20.0, 'dir': [0, -1, 0],
            'innerAngleDeg': 10.0, 'outerAngleDeg': 20.0}
    area = L.retype_light(spot, 'area')
    assert area['kind'] == 'area' and 'dir' not in area \
        and 'innerAngleDeg' not in area and 'orientation' in area
    assert area['pos'] == [1, 2, 3] and area['intensity'] == 3.3 \
        and area['castShadow'] is True and area['enabled'] is False
    # lightDefaults.retype:softeningRadius 只随进点/聚,面光丢弃
    assert 'softeningRadius' not in area
    assert area['pos'] is not spot['pos']            # list 拷一层,不共享引用
    d = L.retype_light(spot, 'directional')
    assert 'pos' not in d and 'range' not in d and d['intensity'] == 3.3
    back = L.retype_light(area, 'point')
    assert 'softeningRadius' in back                 # 回点光补缺省
