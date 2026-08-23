"""编码曲线测试：对数往返、字节 0 语义、HDR 展开互逆、升采样在编码域。"""
from __future__ import annotations

import numpy as np
import pytest

from tools.lightbake import const
from tools.lightbake.encode import (decode_base, decode_log_hdr, encode_log_hdr,
                                    from_hdr, pick_log_params, resize_encoded,
                                    roundtrip_log, roundtrip_visibility, to_hdr)


def test_to_hdr_from_hdr_are_inverse():
    # 恒等只在 y < 1 − 1/HDR_MAX 内成立：y=1 被 HDR_MAX 钳到 200（这是设计，见方案 §5.2）
    x = np.linspace(0.0, 0.994, 10001, dtype=np.float32)
    assert np.allclose(from_hdr(to_hdr(x)), x, atol=1e-4)


def test_log_roundtrip_relative_error_bounded():
    # HDR 数据的动态范围实测 ~400 倍（方案 §5.10），远小于编码跨度上界 2^24
    rng = np.random.default_rng(0)
    x = np.abs(rng.lognormal(0, 1.5, size=100_000)).astype(np.float32)
    rt = roundtrip_log(x)
    assert rt['p99_rel'] < 0.05


def test_base_byte_zero_means_exact_zero():
    # base 走 one_sided=True，字节 0 必须解码成精确的 0（不是编码下限）
    x = np.array([0.0, 1e-6, 0.5, 1.0, 5.0], np.float32)
    scale, span = pick_log_params(x, one_sided=True)
    enc = encode_log_hdr(x, scale, span)
    dec = decode_base(enc, scale, span)
    assert dec[0] == 0.0
    # 非 0 字节走正常对数解码
    assert dec[2] == pytest.approx(decode_log_hdr(enc[2:3], scale, span)[0], rel=1e-6)


def test_visibility_roundtrip():
    x = np.linspace(0, 1, 1000, dtype=np.float32)
    rt = roundtrip_visibility(x)
    assert rt['max_255'] <= 0.5


def test_resize_encoded_happens_in_encoded_domain():
    # 升采样在编码域做：对数编码下编码域线性插值 = 线性域几何平均，
    # 与「先解码再插值再编码」不同。这里只锁住「结果形状正确、无 NaN」。
    x = np.abs(np.random.default_rng(1).lognormal(0, 2, size=(16, 16, 3))).astype(np.float32)
    scale, span = pick_log_params(x)
    enc = encode_log_hdr(x, scale, span)
    up = resize_encoded(enc, (32, 32))
    assert up.shape == (32, 32, 3)
    assert np.isfinite(up).all()


def test_pick_log_params_constants_bounds():
    x = np.abs(np.random.default_rng(2).lognormal(0, 5, size=10_000)).astype(np.float32)
    scale, span = pick_log_params(x)
    assert const.HDR_LOG_SPAN_MIN <= span <= const.HDR_LOG_SPAN_MAX
