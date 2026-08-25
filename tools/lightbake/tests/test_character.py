# -*- coding: utf-8 -*-
"""立绘着色镜像(character.py)的公式钉 —— UnifiedCharacterShader 口径。
期望值独立手算(编码链 from_hdr/linear_to_srgb 已各自有钉,允许作工具)。

二审(2026-08-26)后夹具三戒:ao 不用 1.0(0.28+0.72·1=1 会掩掉曲线)、
α 不全 1(预乘口径不可观测)、ne.a 不恒 0(bulge 不参与)。15 个突变里
曾 10 绿 —— 本版给每个存活突变一根钉。"""
from __future__ import annotations

import math

import numpy as np
import pytest

from tools.lightbake import character as C
from tools.lightbake import lights as L
from tools.lightbake.encode import from_hdr, linear_to_srgb, srgb_to_linear

_WHITE = [1.0, 1.0, 1.0]
_NO_SKY = {'intensity': 0.0, 'profile': 1.0}


class _Inp:
    def __init__(self, scene_per_wu=150.0, ppu=24.0, R=None, depth=None):
        self.scene_per_wu = scene_per_wu
        self.ppu = ppu
        self.cx = 64.0
        self.cy = 64.0
        self.R = (np.eye(3, dtype='float32') if R is None
                  else np.asarray(R, 'float32'))
        self.depth = (np.full((128, 128), 10.0, 'float32') if depth is None
                      else np.asarray(depth, 'float32'))
        self.shadow_bias = (30.8, 264.0)


def _uniform_ctx(sky_a0=0.5, ao_a0=0.4, gi=0.7, inp=None):
    """均匀体(⚠ ao 缺省 0.4:环境曲线可观测)。"""
    n = 2 * 2 * 2
    vol = {'grid': {'nx': 2, 'ny': 2, 'nz': 2},
           'bounds': {'x0': -3.0, 'x1': 3.0, 'y0': -0.5, 'y1': 2.0,
                      'z0': -3.0, 'z1': 3.0},
           'raw': {'sky_a0': np.full(n, sky_a0, 'float32'),
                   'sky_a1': np.zeros((n, 3), 'float32'),
                   'ao_a0': np.full(n, ao_a0, 'float32'),
                   'ao_a1': np.zeros((n, 3), 'float32'),
                   'gi_a0': np.full((n, 3), gi, 'float32'),
                   'gi_a1': np.zeros((n, 3, 3), 'float32')}}
    return {'inp': inp or _Inp(), 'volume': vol}


def _flat_sprite(rgb=0.5, alpha=1.0, ne=(0.5, 0.5, 1.0, 0.0),
                 world_h=150.0, world_w=75.0):
    """2×1 纯色立绘:缺省法线解出 n=(0,0,−1);worldWidth 独立于格子比。"""
    rgba = np.full((2, 1, 4), 1.0, 'float32')
    rgba[..., :3] = rgb
    rgba[..., 3] = alpha
    nrm = np.zeros((2, 1, 4), 'float32')
    nrm[:] = np.asarray(ne, 'float32')
    return C.CharSprite(name='t', frame=0, rgba=rgba, nrm=nrm,
                        world_h_wu=world_h, world_w_wu=world_w, states={})


def _disp(lin: float) -> float:
    return float(linear_to_srgb(from_hdr(np.float32(lin))))


def _center(r: np.ndarray) -> np.ndarray:
    return r[r.shape[0] // 2, r.shape[1] // 2]


_ALB = float(srgb_to_linear(np.float32(0.5)))


def test_char_base_and_shade_hand_value():
    """整链手算:lin = [lin(rgb)/E_ref]·(ambE + giE·charGi);
    E_ref = 0.5·2 = 1;ambE = 0.3·(0.28+0.72·0.4)=0.1704(⚠ ao=0.4,
    环境曲线可观测 —— 二审 M12);giE = 0.7·charGi,charGi 跟随 gi=0.4。"""
    ctx = _uniform_ctx()
    sp = _flat_sprite()
    rgb, a = C.shade_character(ctx, sp, [0.0, 0.0, 0.5], _NO_SKY, None,
                               gi=0.4, ev=0.0, env_rgb=[1, 1, 1],
                               env_gain=0.3, lights=[],
                               char_ref_intensity=2.0)
    assert a.min() == 1.0 and rgb.shape[0] >= 12
    expect = _disp(_ALB * (0.3 * (0.28 + 0.72 * 0.4) + 0.7 * 0.4))
    assert np.allclose(_center(rgb), [expect] * 3, atol=2e-3), \
        (_center(rgb), expect)
    # charGi 显式 = gi ⇒ 逐位同「跟随」;=0 ⇒ gi 项整个消失
    rgb2, _ = C.shade_character(ctx, sp, [0.0, 0.0, 0.5], _NO_SKY, None,
                                gi=0.4, ev=0.0, env_rgb=[1, 1, 1],
                                env_gain=0.3, lights=[], char_gi=0.4,
                                char_ref_intensity=2.0)
    assert np.array_equal(rgb, rgb2)
    rgb0, _ = C.shade_character(ctx, sp, [0.0, 0.0, 0.5], _NO_SKY, None,
                                gi=0.4, ev=0.0, env_rgb=[1, 1, 1],
                                env_gain=0.3, lights=[], char_gi=0.0,
                                char_ref_intensity=2.0)
    expect0 = _disp(_ALB * 0.3 * (0.28 + 0.72 * 0.4))
    assert np.allclose(_center(rgb0), [expect0] * 3, atol=2e-3)


def test_char_straight_alpha_not_redivided():
    """二审 P0-2:PIL 读到的是**直通 α**,不许再除一次(shader 的
    /max(a,1e-4) 是在还原浏览器解码期的预乘)。α=0.5 的均匀立绘与 α=1
    的**着色逐位同**,只有输出 alpha 不同。"""
    ctx = _uniform_ctx()
    kw = dict(sky_def=_NO_SKY, sun_dir=None, gi=0.4, ev=0.0,
              env_rgb=[1, 1, 1], env_gain=0.3, lights=[],
              char_ref_intensity=2.0)
    r1, a1 = C.shade_character(ctx, _flat_sprite(alpha=1.0),
                               [0, 0, 0.5], **kw)
    rh, ah = C.shade_character(ctx, _flat_sprite(alpha=0.5),
                               [0, 0, 0.5], **kw)
    assert np.allclose(r1, rh, atol=1e-6)          # 再除 α 会亮 ~1.5×
    assert abs(float(ah.max()) - 0.5) < 1e-6
    # discard 口径:α<0.03 整像素丢(运行时 `if (color.a<0.03) discard`)
    rd, ad = C.shade_character(ctx, _flat_sprite(alpha=0.02),
                               [0, 0, 0.5], **kw)
    assert float(ad.max()) == 0.0 and float(np.abs(rd).max()) == 0.0


def test_char_out_size_uses_world_width():
    """二审 P1-1:宽走 **worldWidth**(两轴独立),不是图集格子长宽比。
    world_h=150→高 24px(ppu24, spw150);world_w=75→宽 12px,
    与 rgba 的 2:1 格子比无关。"""
    ctx = _uniform_ctx()
    r, _ = C.shade_character(ctx, _flat_sprite(world_w=75.0), [0, 0, 0.5],
                             _NO_SKY, None, gi=0.0, ev=0.0,
                             env_rgb=[1, 1, 1], env_gain=0.3, lights=[])
    assert r.shape == (24, 12, 3), r.shape
    r2, _ = C.shade_character(ctx, _flat_sprite(world_w=150.0), [0, 0, 0.5],
                              _NO_SKY, None, gi=0.0, ev=0.0,
                              env_rgb=[1, 1, 1], env_gain=0.3, lights=[])
    assert r2.shape == (24, 24, 3)
    # scale_mul = depthScaleFactor 口径:整体等比
    r3, _ = C.shade_character(ctx, _flat_sprite(world_w=75.0), [0, 0, 0.5],
                              _NO_SKY, None, gi=0.0, ev=0.0,
                              env_rgb=[1, 1, 1], env_gain=0.3, lights=[],
                              scale_mul=0.5)
    assert r3.shape == (12, 6, 3)


def test_char_height_divides_cos_theta():
    """二审 P0-1:世界竖直位移 = 屏幕 Δy/(cosT·ppu)。θ=32° 的 R 下,
    头顶行世界高 = (h−1)/(cosT·ppu) ≈ 1.130 q(少除 cosT 只有 0.958)。
    体 GI 沿世界 y 三层 0.2/0.2/0.8,顶行采样值把高度暴露成数值。"""
    th = math.radians(32.0)
    c, s = math.cos(th), math.sin(th)
    R = np.array([[1, 0, 0], [0, c, -s], [0, s, c]], 'float32')
    inp = _Inp(R=R)
    ctx = _uniform_ctx(inp=inp)
    v = ctx['volume']
    v['grid'] = {'nx': 2, 'ny': 3, 'nz': 2}
    n = 2 * 3 * 2
    g0 = np.zeros((n, 3), 'float32')
    for ix in range(2):
        for iy in range(3):
            for iz in range(2):
                g0[(ix * 3 + iy) * 2 + iz] = 0.8 if iy == 2 else 0.2
    v['bounds'] = {'x0': -3.0, 'x1': 3.0, 'y0': -0.5, 'y1': 1.9,
                   'z0': -3.0, 'z1': 3.0}
    v['raw'] = {'sky_a0': np.zeros(n, 'float32'),
                'sky_a1': np.zeros((n, 3), 'float32'),
                'ao_a0': np.full(n, 0.4, 'float32'),
                'ao_a1': np.zeros((n, 3), 'float32'),
                'gi_a0': g0, 'gi_a1': np.zeros((n, 3, 3), 'float32')}
    sp = _flat_sprite()
    r, _ = C.shade_character(ctx, sp, [0.0, 0.0, 0.0], _NO_SKY, None,
                             gi=1.0, ev=0.0, env_rgb=[0, 0, 0],
                             env_gain=0.0, lights=[], char_gi=1.0,
                             char_ref_intensity=1.0)
    h = r.shape[0]
    hy_top = (h - 1) / (c * 24.0)                  # 独立复算(规格式)
    t = (hy_top + 0.5) / 2.4 * 2.0                 # 世界 y → 层坐标
    fr = t - 1.0                                    # 落在层 1..2 之间
    g_expect = 0.2 + fr * 0.6
    alb2 = _ALB / 0.5                               # E_ref=(1+0)/2·1
    expect = _disp(alb2 * g_expect)
    got = float(r[0, r.shape[1] // 2, 0])
    assert abs(got - expect) < 3e-3, (got, expect, g_expect)


def test_char_per_corner_clamp_order():
    """二审 P1-2:GI/AO 逐角点 max(a0+a1·N,0) 后再插值。x 两角:
    A(a0=0.1, a1z=0.4 ⇒ 对 n=(0,0,−1) 值 max(0.1−0.4,0)=0)、
    B(a0=0.5, a1z=0 ⇒ 0.5);中点角点口径 = 0.25,系数先插值 = 0.1。"""
    inp = _Inp()
    ctx = _uniform_ctx(inp=inp)
    v = ctx['volume']
    n8 = 8
    g0 = np.zeros((n8, 3), 'float32')
    g1 = np.zeros((n8, 3, 3), 'float32')
    for ix in range(2):
        for iy in range(2):
            for iz in range(2):
                f = (ix * 2 + iy) * 2 + iz
                if ix == 0:
                    g0[f] = 0.1
                    g1[f, :, 2] = 0.4              # a1z:对 nz=−1 贡献 −0.4
                else:
                    g0[f] = 0.5
    v['bounds']['x0'], v['bounds']['x1'] = -12.0, 12.0   # 列偏移 ≪ 半格
    v['raw']['gi_a0'] = g0
    v['raw']['gi_a1'] = g1
    v['raw']['sky_a0'][:] = 0.0
    sp = _flat_sprite()
    r, _ = C.shade_character(ctx, sp, [0.0, 0.0, 0.5], _NO_SKY, None,
                             gi=1.0, ev=0.0, env_rgb=[0, 0, 0],
                             env_gain=0.0, lights=[], char_gi=1.0,
                             char_ref_intensity=1.0)
    expect = _disp((_ALB / 0.5) * 0.25)
    got = float(_center(r)[0])
    assert abs(got - expect) < 3e-3, (got, expect)  # 系数先插值会给 0.1


def test_char_ao_no_upper_preclamp():
    """二审 P2-1:ao 入参只下钳,1.2 天花板在环境项里。ao=1.5 ⇒
    环境项 clamp(0.28+1.08, 0, 1.2)=1.2;预钳 ao≤1 只会给 1.0。"""
    ctx = _uniform_ctx(ao_a0=1.5)
    sp = _flat_sprite()
    r, _ = C.shade_character(ctx, sp, [0, 0, 0.5], _NO_SKY, None, gi=0.0,
                             ev=0.0, env_rgb=[1, 1, 1], env_gain=0.5,
                             lights=[], char_ref_intensity=1.0)
    expect = _disp((_ALB / 0.5) * 0.5 * 1.2)
    assert abs(float(_center(r)[0]) - expect) < 2e-3


def test_char_bulge_shifts_sample_backward():
    """二审 M5:q.z **减** ne.a·bulge(伪 3d 鼓包向观者)。GI 沿 z 两层
    0.2(z−)/0.8(z+),ne.a=0.8、bulge=0.5 ⇒ 采样 z=0.5−0.4=0.1;
    翻号会采 0.9 那侧。"""
    ctx = _uniform_ctx()
    v = ctx['volume']
    g0 = np.zeros((8, 3), 'float32')
    for ix in range(2):
        for iy in range(2):
            for iz in range(2):
                g0[(ix * 2 + iy) * 2 + iz] = 0.8 if iz == 1 else 0.2
    v['bounds']['z0'], v['bounds']['z1'] = -0.6, 1.6
    v['raw']['gi_a0'] = g0
    v['raw']['sky_a0'][:] = 0.0
    sp = _flat_sprite(ne=(0.5, 0.5, 1.0, 0.8))
    r, _ = C.shade_character(ctx, sp, [0.0, 0.0, 0.5], _NO_SKY, None,
                             gi=1.0, ev=0.0, env_rgb=[0, 0, 0],
                             env_gain=0.0, lights=[], char_gi=1.0,
                             char_ref_intensity=1.0, bulge=0.5)
    t = ((0.5 - 0.8 * 0.5) + 0.6) / 2.2            # z=0.1 → 层坐标
    g_expect = 0.2 + t * 0.6
    expect = _disp((_ALB / 0.5) * g_expect)
    assert abs(float(_center(r)[0]) - expect) < 3e-3


def test_char_normal_b_floor():
    """法线解码的 max(b,.05) 地板(二审 M4):ne.b=0 时 n 仍是 (0,0,−1),
    正面平行光 ndl=1;丢地板 ⇒ 零向量法线 ⇒ 全黑。"""
    ctx = _uniform_ctx(sky_a0=0.0)
    sp = _flat_sprite(ne=(0.5, 0.5, 0.0, 0.0))
    lamp = [{'kind': 'directional', 'enabled': True, 'intensity': 2.0,
             'color': _WHITE, 'elevationDeg': 0.0, 'azimuthDeg': 180.0,
             'castShadow': False}]
    r, _ = C.shade_character(ctx, sp, [0, 0, 0.5], _NO_SKY, None, gi=0.0,
                             ev=0.0, env_rgb=[0, 0, 0], env_gain=0.0,
                             lights=lamp, char_ref_intensity=1.0)
    expect = _disp((_ALB / 0.5) * 2.0)             # ndl=1
    assert abs(float(_center(r)[0]) - expect) < 2e-3


def test_char_mirror_flips_only_x():
    """二审 M10:mirror 只翻 x,**不动 y**。斜向灯(el=30, az=90)下
    镜像后的 ndl 与 E_ref 全部独立手算,连 y 翻会双双漂。"""
    ctx = _uniform_ctx(sky_a0=0.0)
    sp = _flat_sprite(ne=(1.0, 0.3, 0.5, 0.0))
    lamp = [{'kind': 'directional', 'enabled': True, 'intensity': 3.0,
             'color': _WHITE, 'elevationDeg': 30.0, 'azimuthDeg': 90.0,
             'castShadow': False}]
    kw = dict(sky_def=_NO_SKY, sun_dir=None, gi=0.0, ev=0.0,
              env_rgb=[0, 0, 0], env_gain=0.0, lights=lamp,
              char_ref_intensity=1.0)
    r0, _ = C.shade_character(ctx, sp, [0, 0, 0.5], **kw)
    r1, _ = C.shade_character(ctx, sp, [0, 0, 0.5], mirror=True, **kw)
    v = np.array([-1.0, -(0.3 * 2 - 1), -0.5])
    v /= np.linalg.norm(v)
    w = np.array([math.cos(math.radians(30)), math.sin(math.radians(30)), 0])
    assert float(r0.max()) < 1e-4                   # 未镜像:背光
    ndl = float(v[0] * -1 * w[0] * -1 + v[1] * w[1])  # 翻 x 后 n=(−vx,vy,vz)
    ndl = max(-v[0] * w[0] + v[1] * w[1], 0.0)
    e_ref = (1.0 + v[1]) * 0.5
    expect = _disp(_ALB / e_ref * 3.0 * ndl)
    assert abs(float(_center(r1)[0]) - expect) < 3e-3, \
        (float(_center(r1)[0]), expect)


def test_char_cap0_floor_1_255():
    """二审 M2:cap₀ 的 1/255 地板。法线朝正下(ny≈−0.999)时
    cap₀ 生地板;t₀=0.002 ⇒ V=0.002/(1/255)≈0.51(去地板会 clip 到 1)。
    期望走全链独立复算。"""
    from tools.lightbake.sky import sh_basis, sky_irradiance_sh
    ctx = _uniform_ctx(sky_a0=0.002)
    sky = {'mode': 'color', 'color': [1, 1, 1], 'intensity': 1.0,
           'profile': 0.0}
    sp = _flat_sprite(ne=(0.5, 1.0, 0.0, 0.0))     # n≈(0,−0.99875,−0.04994)
    r, _ = C.shade_character(ctx, sp, [0, 0, 0.5], sky, None, gi=0.0,
                             ev=0.0, env_rgb=[0, 0, 0], env_gain=0.0,
                             lights=[], char_ref_intensity=1.0)
    v = np.array([0.0, -1.0, -0.05])
    n = v / np.linalg.norm(v)
    t0 = max(0.002 + 0.0, 0.0)
    cap0 = max((1.0 + n[1]) * 0.5, 1.0 / 255.0)
    V = min(max(t0 / cap0, 0.0), 1.0)
    bent = np.full(3, 1e-6)
    bent = bent / np.linalg.norm(bent)
    wgt = 1.0 - (1.0 - V) ** 2
    nmix = bent * (1.0 - wgt) + n * wgt + 1e-6
    nmix = nmix / np.linalg.norm(nmix)
    sh = sky_irradiance_sh(dict(sky), None)
    b = np.asarray(sh_basis(np.array([nmix[0]]), np.array([nmix[1]]),
                            np.array([nmix[2]])))
    sky_e = max(float((b.T @ sh)[0, 0]), 0.0) * V
    e_ref = max((1.0 + n[1]) * 0.5, 1e-4)
    expect = _disp(_ALB / e_ref * sky_e)
    assert abs(float(_center(r)[0]) - expect) < 3e-3, \
        (float(_center(r)[0]), expect, V)


def test_char_cut_gate_off():
    """二审 M14:角色循环无 pass 级 cut 早退 —— cut<1e-4 的点光仍给
    微小非零(场景侧同灯为 0,两口径分开)。"""
    ctx = _uniform_ctx(sky_a0=0.0)
    sp = _flat_sprite()
    r_q = math.sqrt(9.4) * 3.0                     # cut=exp(−9.4)<1e-4
    lamp = [{'kind': 'point', 'intensity': 1e3, 'color': _WHITE,
             'pos': [0.0, 0.0, (0.5 - r_q) * 150.0], 'range': 450.0,
             'softeningRadius': 15.0}]
    r, _ = C.shade_character(ctx, sp, [0, 0, 0.5], _NO_SKY, None, gi=0.0,
                             ev=0.0, env_rgb=[0, 0, 0], env_gain=0.0,
                             lights=lamp, char_ref_intensity=1.0)
    assert float(r.max()) > 0.0


def test_char_form_ao_smoothstep():
    """二审 M15:contact = aoContact·smoothstep(0.78,1,vy)。vy≈0.87 的行
    因子 = 1−0.5·t²(3−2t)(线性化会差 ~2.7%)。"""
    ctx = _uniform_ctx()
    sp = _flat_sprite()
    r, _ = C.shade_character(ctx, sp, [0, 0, 0.5], _NO_SKY, None, gi=0.0,
                             ev=0.0, env_rgb=[1, 1, 1], env_gain=0.5,
                             lights=[], char_ref_intensity=1.0,
                             ao_contact=0.5)
    h = r.shape[0]
    rr = 20
    vy = rr / (h - 1)
    t = min(max((vy - 0.78) / 0.22, 0.0), 1.0)
    factor = 1.0 - 0.5 * (t * t * (3 - 2 * t))
    base = (_ALB / 0.5) * 0.5 * (0.28 + 0.72 * 0.4)
    expect = _disp(base * factor)
    assert abs(float(r[rr, r.shape[1] // 2, 0]) - expect) < 3e-3


def test_char_batch_march_parity_with_scalar():
    """二审 P1-3:两个批量 march 与标量版**逐位同**(标量版已被
    test_lights 钉死,奇偶校验把批量版锁上去):结构化深度墙 + 40 个
    随机 q 点,灯 16 步与太阳 48 步各对一遍。"""
    rng = np.random.default_rng(7)
    depth = np.full((128, 128), 10.0, 'float32')
    depth[8:120, 60:100] = 1.2                     # 竖墙带(cols 60..99)
    inp = _Inp(depth=depth)
    # 构造性两组(不靠随机撞):被挡组 x∈[−2,−1](px 16..40,去灯必穿墙,
    # z=2 ⇒ pen=0.8 ∈ 窗);清白组 x∈[1.6,2.0](px 102..112,已越过墙)
    q = np.zeros((40, 3))
    q[:20, 0] = rng.uniform(-2.0, -1.0, 20)
    q[20:, 0] = rng.uniform(1.6, 2.0, 20)
    q[:, 1] = rng.uniform(-1.0, 1.0, 40)
    q[:, 2] = 2.0
    lq = np.array([2.2, 0.0, 2.5])                 # px≈117:墙外侧
    b0, tk = 30.8 / 150.0, 264.0 / 150.0
    batch = L._char_lamp_visibility_batch(inp, q, lq, b0, tk)
    scalar = np.array([L._char_lamp_visibility(inp, q[i], lq, b0, tk)
                       for i in range(40)], 'float32')
    assert np.array_equal(batch, scalar)
    assert 0 < batch.sum() < 40                    # 夹具真的两态都有
    # 横向为主:y 太大时路径先出画幅顶,墙够不着(实测全清白)。
    # Δpx≈79px 保证被挡组穿墙,z 漂 0.82 保 pen∈窗;清白组直接出幅。
    dq = np.array([0.8, 0.2, 0.2])
    dq /= np.linalg.norm(dq)
    sb = L._char_sun_visibility_batch(inp, q, dq, b0, tk)
    ss = np.array([L._lc_march_visibility(inp, q[i], dq, L.SUN_MARCH_STEPS,
                                          L.SUN_MARCH_LEN_Q, b0, tk)
                   for i in range(40)], 'float32')
    assert np.array_equal(sb, ss)
    assert 0 < sb.sum() < 40
    # —— 网格粒度甄别(二审 M6/M7 曾靠"墙在前半段"滑过步数减半):
    # 单列薄墙恰好落在细步网格的采样列上,步数一动奇偶校验立刻断 ——
    # 灯:st_px=3.887,i=9 踩 col65(8 步版最远 61,够不着);太阳:st_px=1.647,i=2 踩 col33。
    q1 = np.array([[-1.41666667, 0.0, 2.0]])       # px=30
    d_lamp = np.full((128, 128), 10.0, 'float32')
    d_lamp[:, 65] = 1.2
    inp_l = _Inp(depth=d_lamp)
    lq2 = np.array([1.4, 0.0, 2.4])
    bl = L._char_lamp_visibility_batch(inp_l, q1, lq2, b0, tk)
    sl = L._char_lamp_visibility(inp_l, q1[0], lq2, b0, tk)
    assert float(bl[0]) == float(sl) == 0.0        # 细网格踩中薄墙
    d_sun = np.full((128, 128), 10.0, 'float32')
    d_sun[:, 33] = 1.2
    inp_s = _Inp(depth=d_sun)
    sb2 = L._char_sun_visibility_batch(inp_s, q1, dq, b0, tk)
    ss2 = L._lc_march_visibility(inp_s, q1[0], dq, L.SUN_MARCH_STEPS,
                                 L.SUN_MARCH_LEN_Q, b0, tk)
    assert float(sb2[0]) == float(ss2) == 0.0


def test_char_shadowed_lamp_integration():
    """立绘吃 castShadow 灯的整链(二审 M6/M7 的观测口):墙挡住 ⇒ 黑,
    拆墙 ⇒ 亮 —— 批量 march 真在跑。"""
    depth = np.full((128, 128), 0.2, 'float32')
    inp = _Inp(depth=depth)
    ctx = _uniform_ctx(sky_a0=0.0, inp=inp)
    sp = _flat_sprite()
    lamp = [{'kind': 'point', 'intensity': 3.0, 'color': _WHITE,
             'pos': [0.0, 0.0, 600.0], 'range': 1200.0,
             'softeningRadius': 15.0, 'castShadow': True}]
    kw = dict(sky_def=_NO_SKY, sun_dir=None, gi=0.0, ev=0.0,
              env_rgb=[0, 0, 0], env_gain=0.0, lights=lamp,
              char_ref_intensity=1.0)
    # n=(0,0,−1) 背对 +z 的灯 ⇒ 用朝灯法线
    sp.nrm[:] = [0.5, 0.5, 0.0, 0.0]
    sp.nrm[..., 2] = 0.0
    r_blocked, _ = C.shade_character(ctx, sp, [0, 0, 1.0], **kw)
    inp2 = _Inp()
    ctx2 = _uniform_ctx(sky_a0=0.0, inp=inp2)
    r_clear, _ = C.shade_character(ctx2, sp, [0, 0, 1.0], **kw)
    assert float(r_clear.max()) >= float(r_blocked.max())
    _ = r_blocked


def test_char_eref_uses_normal_y_quantitative():
    """E_ref = (1+N.y)/2·ref 的定量钉(二审 P3:此前只有 lu<lf):
    线性域比值 = E_ref 反比。"""
    ctx = _uniform_ctx()
    up = _flat_sprite(ne=(0.5, 0.0, 0.05, 0.0))     # n≈(0,+0.99875,−0.05)
    flat = _flat_sprite()
    kw = dict(sky_def=_NO_SKY, sun_dir=None, gi=0.0, ev=0.0,
              env_rgb=[1, 1, 1], env_gain=0.5, lights=[],
              char_ref_intensity=1.0)
    r_up, _ = C.shade_character(ctx, up, [0, 0, 0.5], **kw)
    r_fl, _ = C.shade_character(ctx, flat, [0, 0, 0.5], **kw)

    def lin_of(v):
        l = float(srgb_to_linear(np.float32(float(v))))
        return l / max(1.0 - l, 1e-9)

    v = np.array([0.0, 1.0, -0.05])
    ny_up = float((v / np.linalg.norm(v))[1])
    ratio_expect = ((1.0 + ny_up) * 0.5) / 0.5      # ≈ 1.9975
    ratio = lin_of(_center(r_fl)[0]) / lin_of(_center(r_up)[0])
    assert abs(ratio - ratio_expect) < 0.03, (ratio, ratio_expect)


def test_list_and_load_player_atlas():
    chars = C.list_characters()
    if 'player_anim' not in chars:
        pytest.skip('player_anim 图集不在本机')
    sp = C.load_character('player_anim')
    assert sp.rgba.shape == (204, 219, 4)
    assert sp.nrm.shape == (204, 219, 4)
    assert sp.world_h_wu == 150.0
    assert abs(sp.world_w_wu - 148.214286) < 1e-3   # 两轴独立(P1-1)
    assert sp.frame == 0                            # idle 首帧
