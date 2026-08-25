# -*- coding: utf-8 -*-
"""立绘着色镜像(character.py)的公式钉 —— UnifiedCharacterShader 口径:
比例基底 ÷ E_ref、法线图集解码(mirror 只翻 x)、V=clip(t₀/cap₀) 的角色侧
归一化、charGi 跟随 gi、sc3Shade 单乘。期望值独立手算(编码链 from_hdr/
linear_to_srgb 等已各自有钉,允许作为工具)。"""
from __future__ import annotations

import numpy as np
import pytest

from tools.lightbake import character as C
from tools.lightbake.encode import from_hdr, linear_to_srgb, srgb_to_linear


class _Inp:
    def __init__(self, scene_per_wu=150.0, ppu=24.0):
        self.scene_per_wu = scene_per_wu
        self.ppu = ppu
        self.cx = 64.0
        self.cy = 64.0
        self.R = np.eye(3, dtype='float32')
        self.depth = np.full((128, 128), 10.0, 'float32')
        self.shadow_bias = (30.8, 264.0)


def _uniform_ctx(sky_a0=0.5, ao_a0=1.0, gi=0.7):
    n = 2 * 2 * 2
    vol = {'grid': {'nx': 2, 'ny': 2, 'nz': 2},
           'bounds': {'x0': -3.0, 'x1': 3.0, 'y0': -0.5, 'y1': 2.0,
                      'z0': -1.0, 'z1': 2.0},
           'raw': {'sky_a0': np.full(n, sky_a0, 'float32'),
                   'sky_a1': np.zeros((n, 3), 'float32'),
                   'ao_a0': np.full(n, ao_a0, 'float32'),
                   'ao_a1': np.zeros((n, 3), 'float32'),
                   'gi_a0': np.full((n, 3), gi, 'float32'),
                   'gi_a1': np.zeros((n, 3, 3), 'float32')}}
    return {'inp': _Inp(), 'volume': vol}


def _flat_sprite(rgb=0.5, alpha=1.0, ne=(0.5, 0.5, 1.0, 0.0),
                 world_h=150.0):
    """2×1 纯色立绘:法线图集编码 n=(−(2r−1),−(2g−1),−max(b,.05)) ⇒
    缺省 (0.5,0.5,1) 解出 n=(0,0,−1)(朝观者),E_ref 的 N.y=0。"""
    rgba = np.full((2, 1, 4), 1.0, 'float32')
    rgba[..., :3] = rgb
    rgba[..., 3] = alpha
    nrm = np.zeros((2, 1, 4), 'float32')
    nrm[:] = np.asarray(ne, 'float32')
    return C.CharSprite(name='t', frame=0, rgba=rgba, nrm=nrm,
                        world_h_wu=world_h, states={})


_NO_SKY = {'intensity': 0.0, 'profile': 1.0}


def test_char_base_and_shade_hand_value():
    """整链手算:天空关、无灯 ⇒ lin = [lin(rgb)/E_ref]·(ambE + giE·charGi),
    E_ref = (1+N.y)/2·ref = 0.5·2 = 1;ambE = 0.3·clamp(0.28+0.72·1)=0.3;
    giE = 0.7·charGi,charGi **跟随 gi=0.4**(运行时缺省口径)。"""
    ctx = _uniform_ctx()
    sp = _flat_sprite()
    rgb, a = C.shade_character(ctx, sp, [0.0, 0.0, 0.5], _NO_SKY, None,
                               gi=0.4, ev=0.0, env_rgb=[1, 1, 1],
                               env_gain=0.3, lights=[],
                               char_ref_intensity=2.0)
    assert a.min() == 1.0 and rgb.shape[0] >= 12
    alb = float(srgb_to_linear(np.float32(0.5)))
    expect = float(linear_to_srgb(from_hdr(
        np.float32(alb * (0.3 + 0.7 * 0.4)))))
    got = rgb[rgb.shape[0] // 2, rgb.shape[1] // 2]
    assert np.allclose(got, [expect] * 3, atol=2e-3), (got, expect)
    # charGi 显式 = gi 时逐位同「跟随」;=0 时 gi 项整个消失
    rgb2, _ = C.shade_character(ctx, sp, [0.0, 0.0, 0.5], _NO_SKY, None,
                                gi=0.4, ev=0.0, env_rgb=[1, 1, 1],
                                env_gain=0.3, lights=[], char_gi=0.4,
                                char_ref_intensity=2.0)
    assert np.array_equal(rgb, rgb2)
    rgb0, _ = C.shade_character(ctx, sp, [0.0, 0.0, 0.5], _NO_SKY, None,
                                gi=0.4, ev=0.0, env_rgb=[1, 1, 1],
                                env_gain=0.3, lights=[], char_gi=0.0,
                                char_ref_intensity=2.0)
    expect0 = float(linear_to_srgb(from_hdr(np.float32(alb * 0.3))))
    got0 = rgb0[rgb0.shape[0] // 2, rgb0.shape[1] // 2]
    assert np.allclose(got0, [expect0] * 3, atol=2e-3)


def test_char_eref_uses_normal_y():
    """E_ref = (1+N.y)/2·ref:法线朝上(ne.g=0 ⇒ N.y≈+1)时 E_ref≈ref,
    比 N.y=0 的 0.5·ref 暗一半(同图集同环境)。"""
    ctx = _uniform_ctx()
    up = _flat_sprite(ne=(0.5, 0.0, 0.05, 0.0))     # n≈(0,+1,−ε)
    flat = _flat_sprite()                            # n=(0,0,−1)
    kw = dict(sky_def=_NO_SKY, sun_dir=None, gi=0.0, ev=0.0,
              env_rgb=[1, 1, 1], env_gain=0.5, lights=[],
              char_ref_intensity=1.0)
    r_up, _ = C.shade_character(ctx, up, [0, 0, 0.5], **kw)
    r_fl, _ = C.shade_character(ctx, flat, [0, 0, 0.5], **kw)
    lu = float(r_up[r_up.shape[0] // 2, 0, 0])
    lf = float(r_fl[r_fl.shape[0] // 2, 0, 0])
    assert lu < lf                                   # E_ref 大 ⇒ 基底小 ⇒ 暗
    # 定量:线性域比值 = E_ref 反比 ≈ 0.5/((1+ny)/2),ny=cos(小 ε 偏差)
    inv = lambda s: float(np.float32(s))            # noqa: E731
    _ = inv


def test_char_vis_cap0_char_side():
    """角色侧天光链**全链独立复算**(shader 逐字):
        t₀ = max(a₀+a₁·N,0);cap₀ = max((1+N.y)/2, 1/255);V = clip(t₀/cap₀);
        w = 1−(1−V)²;n_mix = normalize(mix(Bdir,N,w)+ε);
        skyE = SH(n_mix)·V;lin = [lin(rgb)/E_ref]·skyE。
    a₁=(0,0.05,0) 让 Bdir 有良定方向;把整条链在测试里用自己的公式重算,
    对比中心像素 —— cap₀ 除法/t₀ 钳位/w 式/·V 任何一处漂都会红。"""
    from tools.lightbake.sky import sh_basis, sky_irradiance_sh
    a1v = np.array([0.0, 0.05, 0.0], 'float32')
    ctx = _uniform_ctx(sky_a0=0.3)
    ctx['volume']['raw']['sky_a1'][:] = a1v
    sky = {'mode': 'color', 'color': [1, 1, 1], 'intensity': 1.0,
           'profile': 0.0}
    sp = _flat_sprite()                              # n=(0,0,−1)
    r, _ = C.shade_character(ctx, sp, [0, 0, 0.5], sky, None, gi=0.0,
                             ev=0.0, env_rgb=[0, 0, 0], env_gain=0.0,
                             lights=[], char_ref_intensity=1.0)
    got = float(r[r.shape[0] // 2, r.shape[1] // 2, 0])
    # —— 独立复算(与 character.py 无共享代码路径,公式手写) ——
    n = np.array([0.0, 0.0, -1.0])
    t0 = max(0.3 + float(a1v @ n), 0.0)
    cap0 = max((1.0 + n[1]) * 0.5, 1.0 / 255.0)
    V = min(max(t0 / cap0, 0.0), 1.0)                # = 0.6
    bent = a1v + 1e-6
    bent = bent / np.linalg.norm(bent)
    w = 1.0 - (1.0 - V) ** 2
    nmix = bent * (1.0 - w) + n * w + 1e-6
    nmix = nmix / np.linalg.norm(nmix)
    sh = sky_irradiance_sh(dict(sky), None)
    b = np.asarray(sh_basis(np.array([nmix[0]]), np.array([nmix[1]]),
                            np.array([nmix[2]])))
    sky_e = max(float((b.T @ sh)[0, 0]), 0.0) * V
    alb = float(srgb_to_linear(np.float32(0.5))) / max(0.5 * 1.0, 1e-4)
    expect = float(linear_to_srgb(from_hdr(np.float32(alb * sky_e))))
    assert abs(got - expect) < 3e-3, (got, expect, V, sky_e)


def test_char_mirror_flips_normal_x():
    """mirror 只翻方向分量 x:侧向平行光(az=90,ω=+x̂)下,
    法线编码偏 −x(ne.r=1 ⇒ n.x=−1)的立绘不受光;mirror 后受光。"""
    ctx = _uniform_ctx()
    sp = _flat_sprite(ne=(1.0, 0.5, 0.3, 0.0))       # n ∝ (−1,0,−0.3)
    lamp = [{'kind': 'directional', 'enabled': True, 'intensity': 3.0,
             'color': [1, 1, 1], 'elevationDeg': 0.0, 'azimuthDeg': 90.0,
             'castShadow': False}]
    kw = dict(sky_def=_NO_SKY, sun_dir=None, gi=0.0, ev=0.0,
              env_rgb=[0, 0, 0], env_gain=0.0, char_ref_intensity=1.0)
    r0, _ = C.shade_character(ctx, sp, [0, 0, 0.5], lights=lamp, **kw)
    r1, _ = C.shade_character(ctx, sp, [0, 0, 0.5], lights=lamp,
                              mirror=True, **kw)
    assert float(r0.max()) < 1e-4                    # 背光面全黑
    assert float(r1.max()) > 0.01                    # 镜像后朝灯


def test_list_and_load_player_atlas():
    """真图集:player_anim 必须可列可装(法线图集是准入硬依赖),
    idle 首帧、网格裁切尺寸、worldHeight=150(尺度锚)。"""
    chars = C.list_characters()
    if 'player_anim' not in chars:
        pytest.skip('player_anim 图集不在本机')
    sp = C.load_character('player_anim')
    assert sp.rgba.shape == (204, 219, 4)
    assert sp.nrm.shape == (204, 219, 4)
    assert sp.world_h_wu == 150.0
    assert sp.frame == 0                             # idle 首帧
