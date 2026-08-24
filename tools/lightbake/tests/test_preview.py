# -*- coding: utf-8 -*-
"""preview.py(§6.1 CPU 镜像,唯一实现)的构造性测试。"""
from __future__ import annotations

import numpy as np
import pytest

from tools.lightbake.encode import srgb_to_linear, to_hdr
from tools.lightbake.preview import TIME_PRESETS, base_of_ctx, shade_final


class _FakeInp:
    def __init__(self, bg, normal=None):
        h, w = bg.shape[:2]
        self.work = (w, h)
        self.native = (w, h)
        self.bg_srgb = bg
        if normal is None:
            normal = np.zeros((h, w, 3), np.float32)
            normal[..., 1] = 1.0
        self.normal = normal


def _fake_ctx(seed: int = 3, h: int = 24, w: int = 32):
    rng = np.random.default_rng(seed)
    bg = rng.uniform(0.05, 0.9, (h, w, 3)).astype(np.float32)
    e_q = rng.uniform(0.2, 2.0, (h, w, 3)).astype(np.float32)
    a0 = rng.uniform(0.1, 0.5, (h, w)).astype(np.float32)
    a1 = rng.uniform(-0.3, 0.3, (h, w, 3)).astype(np.float32)
    a1[..., 1] = np.abs(a1[..., 1])
    n = rng.normal(size=(h, w, 3))
    n = (n / np.linalg.norm(n, axis=-1, keepdims=True)).astype(np.float32)
    return {'inp': _FakeInp(bg, n), 'e_q': e_q, 'moments_smooth': (a0, a1),
            'normal': n}, bg


def test_identity_anchor_gi1_no_sky():
    """gi=1 + 天光 0 ⇒ 逐字节回原画(除 255 饱和位)—— §5.7 恒等在预览镜像
    上的构造性体现(base 现算除法精确抵消 E)。"""
    ctx, bg = _fake_ctx()
    base, bg2 = base_of_ctx(ctx)
    assert np.array_equal(bg, bg2)
    a0, a1 = ctx['moments_smooth']
    img = shade_final(base, ctx['e_q'], a0, a1, ctx['normal'],
                      {'intensity': 0.0, 'profile': 1.0}, None,
                      gi=1.0, ev=0.0)
    got = np.round(np.clip(img, 0, 1) * 255).astype(np.int16)
    ref = np.round(np.clip(bg, 0, 1) * 255).astype(np.int16)
    sat = ref >= 254                       # Reinhard 界的 255→254(§5.7 已知位)
    assert int((got[~sat] != ref[~sat]).sum()) == 0


def test_sky_only_monotone_and_positive():
    """gi=0 纯天光:强度翻倍 ⇒ 亮度单调不降;全零天空 ⇒ 全黑。"""
    ctx, _bg = _fake_ctx(seed=9)
    base, _ = base_of_ctx(ctx)
    a0, a1 = ctx['moments_smooth']
    dark = shade_final(base, ctx['e_q'], a0, a1, ctx['normal'],
                       {'intensity': 0.0, 'profile': 1.0}, None, gi=0.0)
    assert float(dark.max()) == 0.0
    lo = shade_final(base, ctx['e_q'], a0, a1, ctx['normal'],
                     {'intensity': 0.3, 'profile': 1.0}, None, gi=0.0)
    hi = shade_final(base, ctx['e_q'], a0, a1, ctx['normal'],
                     {'intensity': 0.6, 'profile': 1.0}, None, gi=0.0)
    assert float((hi - lo).min()) > -1e-6


def test_presets_render_all():
    ctx, _bg = _fake_ctx(seed=5)
    base, _ = base_of_ctx(ctx)
    a0, a1 = ctx['moments_smooth']
    for _name, sky, sun, ev in TIME_PRESETS:
        img = shade_final(base, ctx['e_q'], a0, a1, ctx['normal'], sky, sun,
                          gi=0.15, ev=ev)
        assert np.isfinite(img).all()
        assert img.shape == ctx['e_q'].shape


def test_identity_check_ignores_saturated_bytes():
    """审查 P-1:identity_check 自己的合同(255 饱和位除外)此前没执行。"""
    from tools.lightbake.preview import identity_check
    ctx, _bg = _fake_ctx(seed=13)
    ctx['inp'].bg_srgb[0, 0] = 1.0             # 制造一个纯饱和像素
    assert identity_check(ctx) == 0


def test_base_is_unclamped_division():
    """审查 P-2:§5.7 铁令 —— base = to_hdr(原画)/E_q,纯除法无钳位。
    极小 E_q 下 base·E_q 仍须精确还原 to_hdr(原画)。"""
    from tools.lightbake.encode import srgb_to_linear, to_hdr
    ctx, bg = _fake_ctx(seed=17)
    ctx['e_q'] = np.full_like(ctx['e_q'], 1e-9)
    base, _ = base_of_ctx(ctx)
    assert np.allclose(base * ctx['e_q'], to_hdr(srgb_to_linear(bg)),
                       rtol=1e-5)


def test_degenerate_mix_normalized_like_glsl():
    """审查 P-4:Bdir=−N 且 w=0.5 的退化处,必须与 sc3SkyIrradiance 的
    normalize(mix+1e-6) 同款 —— 求值方向是 (1,1,1)/√3,不是原点。"""
    from tools.lightbake.preview import sky_response
    from tools.lightbake.sky import sh_basis, sky_irradiance_sh
    h, w = 4, 4
    # f32 复算镜像:挑 a0 使 |2w−1| ≪ ε=1e-6,ε 向量真正主导退化方向
    a0v = np.float32(0.49289323)
    v_pix = np.float32(a0v) - np.float32(0.2)
    wgt = np.float32(1.0) - (np.float32(1.0) - v_pix) ** 2
    mixy = np.float32(2.0) * wgt - np.float32(1.0)
    assert abs(float(mixy)) < 1e-6, float(mixy)   # 构造前提
    a0 = np.full((h, w), a0v, np.float32)
    a1 = np.zeros((h, w, 3), np.float32)
    a1[..., 1] = -0.2
    normal = np.zeros((h, w, 3), np.float32)
    normal[..., 1] = 1.0
    sky = {'intensity': 1.0, 'profile': 1.0}
    e_sky = sky_response(a0, a1, normal, sky)
    # 独立推导 GLSL 口径的退化方向:normalize(mix + ε向量)
    vdir = np.array([1e-6, float(mixy) + 1e-6, 1e-6], np.float64)
    vdir = vdir / np.linalg.norm(vdir)
    sh = sky_irradiance_sh(dict(sky), None)
    b = np.asarray(sh_basis(np.array([vdir[0]]), np.array([vdir[1]]),
                            np.array([vdir[2]])))
    expect = np.maximum(b.T @ sh, 0.0)[0] * float(v_pix)
    assert np.all(np.isfinite(e_sky))
    assert np.allclose(e_sky[0, 0], expect, rtol=5e-3), (e_sky[0, 0], expect)


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
