# -*- coding: utf-8 -*-
"""解析灯镜像(lights.py)的公式钉 —— 每一条都对着 lightingCore.glsl /
lightPacking.ts / SceneLightingPass / UnifiedCharacterShader 的**数值口径**,
期望值在测试里独立手算,不回环调用被测实现。"""
from __future__ import annotations

import math

import numpy as np

from tools.lightbake import lights as L


class _Inp:
    """最小 SceneInput 假体。单位链:scene_per_wu = wu / q 单位。"""

    def __init__(self, h=16, w=32, scene_per_wu=150.0, depth_val=10.0):
        self.scene_per_wu = scene_per_wu
        self.R = np.eye(3, dtype='float32')
        self.ppu = 4.0
        self.cx = w / 2.0
        self.cy = h / 2.0
        self.depth = np.full((h, w), depth_val, 'float32')
        px = np.arange(w, dtype='float32')[None, :].repeat(h, 0)
        py = np.arange(h, dtype='float32')[:, None].repeat(w, 1)
        self.q = np.stack([(px - self.cx) / self.ppu,
                           (self.cy - py) / self.ppu,
                           np.full((h, w), depth_val, 'float32')],
                          -1).astype('float32')
        self.world = self.q.copy()          # R = I ⇒ world ≡ q
        self.shadow_bias = (30.8, 264.0)


def _one_px(world_pt=(0.0, 0.0, 0.0), n=(0.0, 1.0, 0.0)):
    inp = _Inp(h=1, w=1)
    inp.world = np.asarray(world_pt, 'float32').reshape(1, 1, 3)
    inp.q = inp.world.copy()
    a0 = np.full((1, 1), 0.4, 'float32')
    a1 = np.zeros((1, 1, 3), 'float32')
    nrm = np.asarray(n, 'float32').reshape(1, 1, 3)
    return inp, a0, a1, nrm


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
    """独立手算:qu=1/150,灯在正上 300wu(=2q),range 450wu,软化 15wu。
    E = intensity·ndl·[exp(−r²/R²)/(r²+soft)]·vis,全按 GLSL 式手抄。"""
    inp, a0, a1, nrm = _one_px()
    lamp = {'id': 'p', 'kind': 'point', 'enabled': True, 'intensity': 2.0,
            'color': [1.0, 1.0, 1.0], 'pos': [0.0, 300.0, 0.0],
            'range': 450.0, 'softeningRadius': 15.0, 'castShadow': False}
    e = L.eval_scene_lights([lamp], inp, a0, a1, nrm)
    r2, rng, soft = 4.0, 3.0, 0.1 ** 2
    expect = 2.0 * 1.0 * (math.exp(-r2 / rng ** 2) / (r2 + soft))
    assert np.allclose(e[0, 0], [expect] * 3, rtol=1e-5), (e[0, 0], expect)


def test_point_light_cut_early_out():
    """pass 早退②:cut < 1e-4 的像素贡献恒 0(lcAreaLight 同阈提前)。"""
    inp, a0, a1, nrm = _one_px()
    lamp = {'kind': 'point', 'intensity': 100.0, 'color': [1, 1, 1],
            'pos': [0.0, 45000.0, 0.0], 'range': 450.0,   # r=300q ≫ range 3q
            'softeningRadius': 15.0}
    e = L.eval_scene_lights([lamp], inp, a0, a1, nrm)
    assert float(np.abs(e).max()) == 0.0


def test_zero_intensity_skipped():
    inp, a0, a1, nrm = _one_px()
    lamp = {'kind': 'point', 'intensity': 0.0, 'pos': [0, 300, 0]}
    assert float(np.abs(L.eval_scene_lights([lamp], inp, a0, a1, nrm)).max()) \
        == 0.0


# ------------------------------------------------ 聚光(lcSpotLight)

def test_spot_on_axis_equals_point():
    """正对轴心 cone=1 ⇒ 聚光退化为点光(smoothstep 上沿)。"""
    inp, a0, a1, nrm = _one_px()
    base = {'enabled': True, 'intensity': 2.0, 'color': [1, 1, 1],
            'pos': [0.0, 300.0, 0.0], 'range': 450.0, 'softeningRadius': 15.0}
    p = L.eval_scene_lights([{**base, 'kind': 'point'}], inp, a0, a1, nrm)
    s = L.eval_scene_lights([{**base, 'kind': 'spot', 'dir': [0, -1, 0],
                              'innerAngleDeg': 25.0, 'outerAngleDeg': 40.0}],
                            inp, a0, a1, nrm)
    assert np.allclose(p, s, rtol=1e-6)


def test_spot_cone_smoothstep_hand_value():
    """离轴:cone = smoothstep(cos40°, cos25°, cosθ),θ 从几何独立手算。"""
    inp, a0, a1, nrm = _one_px(world_pt=(1.0, 0.0, 0.0))
    lamp = {'kind': 'spot', 'intensity': 2.0, 'color': [1, 1, 1],
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
    ndl = max(float(Ld[1]), 0.0)
    expect = 2.0 * ndl * cone * (math.exp(-r2 / 9.0) / (r2 + 0.01))
    assert np.allclose(e[0, 0], [expect] * 3, rtol=1e-5)
    # 完全出锥 ⇒ 0
    inp2, a0, a1, nrm = _one_px(world_pt=(5.0, 0.0, 0.0))
    e2 = L.eval_scene_lights([lamp], inp2, a0, a1, nrm)
    assert float(np.abs(e2).max()) == 0.0


# ------------------------------------------------ 面光(lcRectIrradiance/lcAreaLight)

def test_area_hemisphere_anchor():
    """解析锚:巨大朝下面板全覆盖上半球 ⇒ Lambert 多边形式 E→1(Σ→2π)。"""
    inp, a0, a1, nrm = _one_px()
    lamp = {'kind': 'area', 'intensity': 1.0, 'color': [1, 1, 1],
            'pos': [0.0, 10.0 * 150, 0.0], 'range': 1e7,
            'orientation': [0.0, -1.0, 0.0], 'size': [1e6, 1e6],
            'twoSided': False}
    e = L.eval_scene_lights([lamp], inp, a0, a1, nrm)
    assert 0.97 < float(e[0, 0, 0]) <= 1.001, e[0, 0]


def test_area_winding_regression_runtime_case():
    """运行时验尸的几何(lightingCore 注释):面板 (950,357,0)、半轴
    150×100、法线朝下、地面点法线 (0,1,0)。期望值锚在**独立数值积分**
    ∫cosθ_P·cosθ_L/(πr²)dA = 0.128340(4000² 采样,与闭式逐位一致;
    运行时注释写的 0.1328 是四舍五入的实测口径,差 3.5‰,已裁决)。
    绕向翻错时这里得 **负值**(被 max(0) 吃成 0)—— 逐字回归。"""
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
    """单面:背面 0;双面:abs(与朝向翻转对称)。"""
    inp, a0, a1, nrm = _one_px()
    base = {'kind': 'area', 'intensity': 1.5, 'color': [1, 1, 1],
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


# ------------------------------------------------ 平行光与太阳遮蔽(pass 镜像)

def test_sun_linear_visibility_hand_value():
    """sunVis = 1 − 0.9·(1−clamp(α+β·ω)),α/β 按 §5.5 闭式手算
    (α=8a₀−6a₁ᵧ, βᵧ=12a₁ᵧ−12a₀)。el=90 ⇒ ω=(0,1,0),ndl=1。"""
    inp, _a0, _a1, nrm = _one_px()
    a0 = np.full((1, 1), 0.4, 'float32')
    a1 = np.zeros((1, 1, 3), 'float32')
    a1[..., 1] = 0.3
    sun = {'kind': 'directional', 'enabled': True, 'intensity': 2.0,
           'color': [1.0, 1.0, 1.0], 'elevationDeg': 90.0,
           'azimuthDeg': 0.0, 'castShadow': True}
    e = L.eval_scene_lights([sun], inp, a0, a1, nrm)
    alpha = 8 * 0.4 - 6 * 0.3
    beta_y = 12 * 0.3 - 12 * 0.4
    vdir = min(max(alpha + beta_y, 0.0), 1.0)      # = 0.2
    expect = 2.0 * 1.0 * (1.0 - 0.9 * (1.0 - vdir))
    assert np.allclose(e[0, 0], [expect] * 3, rtol=1e-5), (e[0, 0], expect)
    # castShadow=False ⇒ strength 0 ⇒ vis 1
    sun2 = {**sun, 'castShadow': False}
    e2 = L.eval_scene_lights([sun2], inp, a0, a1, nrm)
    assert np.allclose(e2[0, 0], [2.0] * 3, rtol=1e-6)


def test_extra_directional_vis_one():
    """额外 directional(非第一盏)vis≡1(pass 逐字:不再 march、不吃 V_dir)。"""
    inp, a0, a1, nrm = _one_px()
    a1[..., 1] = -0.4                                # 让 V_dir 很低
    sun = {'kind': 'directional', 'enabled': True, 'intensity': 0.0,
           'elevationDeg': 90.0, 'castShadow': True}
    moon = {'kind': 'directional', 'enabled': True, 'intensity': 1.0,
            'color': [1, 1, 1], 'elevationDeg': 90.0, 'azimuthDeg': 0.0,
            'castShadow': True}
    e = L.eval_scene_lights([sun, moon], inp, a0, a1, nrm)
    assert np.allclose(e[0, 0], [1.0] * 3, rtol=1e-6)   # 不被 V_dir 打折


# ------------------------------------------------ 阴影判据(两侧两套,分歧要钉死)

def test_scene_shadow_criterion_no_thick():
    """场景侧(shadowPrefix):被挡 ⟺ ∃点 pen > bias,**没有 thick 上限**。
    bias=30.8wu·qu≈0.205q:pen 0.1 不挡、0.3 挡、2.8 也挡(无窗)。"""
    inp = _Inp(depth_val=10.0)
    q_flat = np.array([[0.0, 0.0, 3.0]])
    lq = np.array([-2.0, 0.0, 3.0])
    bias_q = 30.8 / 150.0
    inp.depth[:] = 2.9                                  # pen=0.1 < bias
    assert L._scene_lamp_visibility(inp, q_flat, lq, bias_q)[0] == 1.0
    inp.depth[:] = 2.7                                  # pen=0.3 > bias
    assert L._scene_lamp_visibility(inp, q_flat, lq, bias_q)[0] == 0.0
    inp.depth[:] = 0.2                                  # pen=2.8:场景侧照样挡
    assert L._scene_lamp_visibility(inp, q_flat, lq, bias_q)[0] == 0.0


def test_char_shadow_thick_window():
    """角色侧(ucLightVisibility→lcMarchVisibility):pen 必须落在
    (bias, thick) **窗**内才算挡 —— pen 超过 thick(墙背后的空气)不挡。"""
    inp = _Inp(depth_val=10.0)
    bias0_q, thick_q = 30.8 / 150.0, 264.0 / 150.0
    q0 = np.array([0.0, 0.0, 0.0])
    lq = np.array([0.0, 0.0, 3.0])                      # 灯在深处,march 穿 z
    inp.depth[:] = 0.2                                  # pen∈窗 ⇒ 挡
    assert L._char_lamp_visibility(inp, q0, lq, bias0_q, thick_q) == 0.0
    q0b = np.array([0.0, 0.0, -2.0])                    # 抬高 pen 超 thick
    inp.depth[:] = -4.0
    pen_max = 3.0 * 0.92 + 2.0 - 2.0                    # ≈ q.z − d 的量级
    assert pen_max > thick_q                            # 构造自检
    q0c = np.array([0.0, 0.0, 2.5])
    lq_c = np.array([0.0, 0.0, 5.0])
    inp.depth[:] = 0.2                                  # pen ≈ 2.5..4.8 > thick
    assert L._char_lamp_visibility(inp, q0c, lq_c, bias0_q, thick_q) == 1.0
    _ = q0b


def test_shadow_vis_cache_reuse_and_invalidate():
    """vis_cache:同灯位复用(改深度不重算 ⇒ 结果不变);挪灯 = 新键重算。"""
    inp = _Inp(h=2, w=2, depth_val=10.0)
    inp.world = np.zeros((2, 2, 3), 'float32')
    inp.q = np.zeros((2, 2, 3), 'float32')
    a0 = np.full((2, 2), 0.4, 'float32')
    a1 = np.zeros((2, 2, 3), 'float32')
    nrm = np.tile(np.array([0, 1, 0], 'float32'), (2, 2, 1))
    lamp = {'kind': 'point', 'intensity': 2.0, 'color': [1, 1, 1],
            'pos': [0.0, 300.0, 0.0], 'range': 450.0, 'softeningRadius': 15.0,
            'castShadow': True}
    cache: dict = {}
    e1 = L.eval_scene_lights([lamp], inp, a0, a1, nrm, vis_cache=cache)
    assert len(cache) == 1 and float(e1.max()) > 0
    inp.depth[:] = -10.0                                # 全遮的深度
    e2 = L.eval_scene_lights([lamp], inp, a0, a1, nrm, vis_cache=cache)
    assert np.array_equal(e1, e2)                       # 缓存命中,未重 march
    lamp2 = {**lamp, 'pos': [0.0, 310.0, 0.0]}
    L.eval_scene_lights([lamp2], inp, a0, a1, nrm, vis_cache=cache)
    assert len(cache) == 2                              # 挪灯 ⇒ 新键


# ------------------------------------------------ 实体侧(探针)

def test_probe_point_matches_scene_formula():
    """探针(实体口径)与场景侧同一公式:无阴影点光在同一 P/N 上逐值相等。"""
    inp, a0, a1, nrm = _one_px()
    lamp = {'kind': 'point', 'intensity': 2.0, 'color': [1, 1, 1],
            'pos': [0.0, 300.0, 0.0], 'range': 450.0, 'softeningRadius': 15.0,
            'castShadow': False}
    scene = L.eval_scene_lights([lamp], inp, a0, a1, nrm)
    N = np.array([0, 1, 0], 'float32').reshape(1, 1, 3)
    probe = L.eval_probe_lights([lamp], N, [0.0, 0.0, 0.0], inp,
                                0.4, np.zeros(3, 'float32'))
    assert np.allclose(scene, probe, rtol=1e-6)


def test_probe_char_shadow_blocks():
    """探针灯阴影走角色侧 march:构造遮挡 ⇒ 贡献 0;同几何场景口径也应挡。"""
    inp = _Inp(depth_val=0.2)
    lamp = {'kind': 'point', 'intensity': 2.0, 'color': [1, 1, 1],
            'pos': [0.0, 0.0, 450.0], 'range': 1500.0,
            'softeningRadius': 15.0, 'castShadow': True}
    N = np.array([0, 0, 1], 'float32').reshape(1, 1, 3)
    probe = L.eval_probe_lights([lamp], N, [0.0, 0.0, 0.0], inp,
                                0.4, np.zeros(3, 'float32'))
    assert float(np.abs(probe).max()) == 0.0


# ------------------------------------------------ 缺省/换型(编辑面,同口径镜像)

def test_default_light_mirror():
    d = L.default_light(3, 'spot')
    assert d['id'] == 'light_3' and d['innerAngleDeg'] == 25.0 \
        and d['outerAngleDeg'] == 45.0 and d['range'] == 450.0
    dd = L.default_light(1, 'directional')
    assert 'pos' not in dd and dd['intensity'] == 0.4 and dd['kelvin'] == 7000.0
    da = L.default_light(1, 'area')
    assert da['size'] == [135.0, 90.0] and da['twoSided'] is False


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
    d = L.retype_light(spot, 'directional')
    assert 'pos' not in d and 'range' not in d and d['intensity'] == 3.3
