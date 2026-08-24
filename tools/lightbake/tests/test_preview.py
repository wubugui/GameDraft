# -*- coding: utf-8 -*-
"""preview.py(§6.1 CPU 镜像,唯一实现)的构造性测试。"""
from __future__ import annotations

import numpy as np
import pytest

from tools.lightbake.encode import srgb_to_linear, to_hdr
from tools.lightbake.preview import TIME_PRESETS, base_of_ctx, shade_final


class _FakeInp:
    def __init__(self, bg):
        h, w = bg.shape[:2]
        self.work = (w, h)
        self.native = (w, h)
        self.bg_srgb = bg


def _fake_ctx(seed: int = 3, h: int = 24, w: int = 32):
    rng = np.random.default_rng(seed)
    bg = rng.uniform(0.05, 0.9, (h, w, 3)).astype(np.float32)
    e_q = rng.uniform(0.2, 2.0, (h, w, 3)).astype(np.float32)
    a0 = rng.uniform(0.1, 0.5, (h, w)).astype(np.float32)
    a1 = rng.uniform(-0.3, 0.3, (h, w, 3)).astype(np.float32)
    a1[..., 1] = np.abs(a1[..., 1])
    n = rng.normal(size=(h, w, 3))
    n = (n / np.linalg.norm(n, axis=-1, keepdims=True)).astype(np.float32)
    return {'inp': _FakeInp(bg), 'e_q': e_q, 'moments_smooth': (a0, a1),
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


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
