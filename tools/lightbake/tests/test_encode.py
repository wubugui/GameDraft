# -*- coding: utf-8 -*-
"""三条编码曲线的往返与互斥性(§4.3 / §5.10)。"""
from __future__ import annotations

import numpy as np
import pytest

from tools.lightbake.encode import (decode_log_hdr, decode_moments, decode_unit,
                                    encode_log_hdr, encode_moments, encode_unit,
                                    from_hdr, linear_to_srgb, pick_log_params,
                                    resize_encoded, srgb_to_linear, to_hdr)


def test_hdr_pair_inverse():
    y = np.linspace(0.0, 0.99, 2000).astype(np.float32)
    assert np.allclose(from_hdr(to_hdr(y)), y, atol=2e-6)


def test_hdr_pair_boundary_pinned():
    """§5.2 恒等式的定义域边界:y < 1−1/HDR_MAX 可逆;y=1 的往返误差是
    Reinhard 上界的已知常数 1/201 ≈ 0.004975(自检 #3 的 255→254 由此而来)。"""
    y = np.array([0.9949, 1.0], np.float32)
    rt = from_hdr(to_hdr(y))
    assert abs(float(rt[0]) - 0.9949) < 2e-6            # 界内可逆
    assert abs(float(rt[1]) - 200.0 / 201.0) < 1e-6     # 界上:200/201,钉死


def test_resize_encoded_is_byte_domain_geometric_mean():
    """resize_encoded 存在的唯一理由:编码域线性插值 = 线性域**几何**平均,
    与「先解码再插值」(算术平均)不等价 —— 直接钉住这件事。"""
    scale, span = 1.0, 16.0
    u8 = np.array([[100, 132]], np.uint8)               # 差 2 档(每档 2^(16/255))
    up = resize_encoded(u8[..., None], (3, 1))[0, :, 0]
    mid = float(up[1])
    assert abs(mid - 116.0) < 1.0                       # 字节域中点
    a = decode_log_hdr(np.array(100, np.uint8), scale, span)
    b = decode_log_hdr(np.array(132, np.uint8), scale, span)
    dec_mid = float(decode_log_hdr(np.array(round(mid), np.uint8), scale, span))
    geo = float(np.sqrt(a * b))
    ari = float((a + b) / 2)
    assert abs(dec_mid - geo) / geo < 0.01              # = 几何平均
    assert abs(dec_mid - ari) / ari > 0.05              # ≠ 算术平均


def test_srgb_roundtrip():
    x = np.linspace(0, 1, 4096).astype(np.float32)
    assert np.allclose(linear_to_srgb(srgb_to_linear(x)), x, atol=2e-6)


def test_log_roundtrip_display_domain():
    """E 类 HDR 量:对数编码往返在显示域(from_hdr)p99 ≤ 2/255。"""
    rng = np.random.default_rng(5)
    e = np.exp(rng.normal(-1.5, 1.6, 300_000)).astype(np.float32)   # 跨 ~12 档
    scale, span = pick_log_params(e)
    q = decode_log_hdr(encode_log_hdr(e, scale, span), scale, span)
    err = np.abs(from_hdr(q) - from_hdr(e)) * 255.0
    assert float(np.percentile(err, 99)) <= 2.0


def test_log_relative_error_constant():
    rng = np.random.default_rng(6)
    e = np.exp(rng.normal(0, 2.0, 100_000)).astype(np.float32)
    scale, span = pick_log_params(e)
    q = decode_log_hdr(encode_log_hdr(e, scale, span), scale, span)
    inside = (e > scale * 2 ** (-span / 2 * 0.95)) & (e < scale * 2 ** (span / 2 * 0.95))
    rel = np.abs(q[inside] - e[inside]) / e[inside]
    # 每级 ln2·span/255,取整半级 ⇒ 上界 ~0.5 级
    assert float(np.percentile(rel, 99)) < np.log(2) * span / 255 * 0.75


def test_unit_roundtrip():
    x = np.random.default_rng(7).uniform(0, 1, 100_000).astype(np.float32)
    q = decode_unit(encode_unit(x))
    assert float(np.abs(q - x).max()) <= 0.5 / 255 + 1e-6


def test_moments_roundtrip():
    rng = np.random.default_rng(8)
    a0 = rng.uniform(0, 0.5, 50_000).astype(np.float32)
    a1 = rng.uniform(-0.5, 0.5, (50_000, 3)).astype(np.float32)
    d0, d1 = decode_moments(encode_moments(a0, a1))
    assert float(np.abs(d0 - a0).max()) <= 0.5 / 510 + 1e-6
    assert float(np.abs(d1 - a1).max()) <= 0.5 / 255 + 1e-6


def test_pick_log_params_no_saturation():
    rng = np.random.default_rng(9)
    e = np.exp(rng.normal(0, 3.0, 100_000)).astype(np.float32)
    scale, span = pick_log_params(e)
    enc = encode_log_hdr(e, scale, span)
    assert (enc == 255).mean() < 0.001                 # 上端不饱和(按数据定跨度)
    assert 8.0 <= span <= 24.0
    # 下端:σ=3 的极宽分布撞 span 上限 24 档,按设计有一撮被钳到字节 0 ——
    # 记录性断言(审查:此前下端行为无覆盖);温和分布应几乎不撞
    assert 0.0 < (enc == 0).mean() < 0.15
    tame = np.exp(rng.normal(0, 1.2, 100_000)).astype(np.float32)
    s2, p2 = pick_log_params(tame)
    assert (encode_log_hdr(tame, s2, p2) == 0).mean() < 0.005


def test_glsl_side_constants_pinned():
    """跨语言金标(轻量):GLSL 侧解码常量直接 regex 钉死 —— 两边同时错的
    盲区至少要抓住「一边改了常量」这半(审查建议的 golden 思路)。"""
    from pathlib import Path
    glsl = (Path(__file__).resolve().parents[3]
            / 'src/rendering/lighting/shadeCore3.glsl')
    if not glsl.exists():
        import pytest as _pytest
        _pytest.skip('shadeCore3.glsl 不在本机')
    src = glsl.read_text(encoding='utf-8')
    assert '1.0 / 200.0' in src                        # sc3ToHdr 的 HDR_MAX
    assert '(px - vec3(0.5)) * span' in src            # sc3DecodeLogHdr 同式
    assert '0.28 + 0.72 * ao' in src                   # 环境项(§6.1)


def test_resize_encoded_stays_in_byte_domain():
    u8 = np.random.default_rng(10).integers(0, 256, (16, 16, 3), dtype=np.uint8)
    up = resize_encoded(u8, (32, 32))
    assert up.shape == (32, 32, 3)
    assert up.dtype == np.float32
    assert 0 <= up.min() and up.max() <= 255


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
