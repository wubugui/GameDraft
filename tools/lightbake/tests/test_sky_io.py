# -*- coding: utf-8 -*-
"""§5.3 逃逸辐射侧的测试:RGBE 解码、RLE/轴序守卫、取样器契约
(审查纠正:此前这半个模块零覆盖)。"""
from __future__ import annotations

import numpy as np
import pytest

from tools.lightbake.encode import srgb_to_linear, to_hdr
from tools.lightbake.sky import load_skybox, make_sky_sampler


def _write_hdr(path, h, w, rgbe_bytes, axes=b'-Y %d +X %d'):
    head = b'#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n' + (axes % (h, w)) + b'\n'
    path.write_bytes(head + rgbe_bytes)


def test_flat_rgbe_roundtrip(tmp_path):
    h, w = 4, 8
    rng = np.random.default_rng(2)
    rgbe = rng.integers(0, 256, (h, w, 4), dtype=np.uint8)
    rgbe[..., 3] = rng.integers(120, 150, (h, w))
    rgbe[0, 0] = [10, 20, 30, 0]                     # e=0 ⇒ 精确 0
    f = tmp_path / 'a.hdr'
    _write_hdr(f, h, w, rgbe.tobytes())
    img = load_skybox(f)
    assert img.shape == (h, w, 3)
    expect = rgbe[..., :3].astype(np.float64) * np.where(
        rgbe[..., 3:4] > 0, 2.0 ** (rgbe[..., 3:4].astype(np.float64) - 136), 0.0)
    assert np.allclose(img, expect, rtol=1e-6)
    assert np.all(img[0, 0] == 0.0)


def test_rle_hdr_rejected_even_when_oversized(tmp_path):
    """RLE 对不可压数据会膨胀 —— 尺寸单边判据挡不住,必须按扫描线头显式拒绝。"""
    h, w = 2, 200
    payload = bytearray([0x02, 0x02, (w >> 8) & 0xFF, w & 0xFF])
    payload += bytes(w * h * 4)                      # 填到超过 flat 尺寸
    f = tmp_path / 'rle.hdr'
    _write_hdr(f, h, w, bytes(payload))
    with pytest.raises(ValueError, match='RLE'):
        load_skybox(f)


def test_nonstandard_axis_order_rejected(tmp_path):
    f = tmp_path / 'ax.hdr'
    head = b'#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n+X 8 -Y 4\n'
    f.write_bytes(head + bytes(4 * 8 * 4))
    with pytest.raises(ValueError, match='轴序'):
        load_skybox(f)


def test_truncated_flat_rejected(tmp_path):
    f = tmp_path / 'tr.hdr'
    _write_hdr(f, 4, 8, bytes(4 * 8 * 4 - 10))
    with pytest.raises(ValueError, match='不足'):
        load_skybox(f)


def test_8bit_skybox_path(tmp_path):
    from PIL import Image
    rng = np.random.default_rng(5)
    img8 = rng.integers(0, 256, (4, 8, 3), dtype=np.uint8)
    f = tmp_path / 'sky.png'
    Image.fromarray(img8).save(f)
    got = load_skybox(f)
    expect = to_hdr(srgb_to_linear(img8.astype(np.float32) / 255.0))
    assert np.allclose(got, expect, atol=1e-6)


def test_color_sampler_contract(tmp_path):
    s = make_sky_sampler({'mode': 'color', 'color': [0.2, 0.4, 0.8],
                          'intensity': 0.5}, tmp_path)
    single = s(np.array([0, 1, 0], np.float32))
    batch = s(np.random.default_rng(1).normal(size=(7, 3)).astype(np.float32))
    assert single.shape == (3,)
    assert batch.shape == (7, 3)
    assert np.allclose(single, [0.1, 0.2, 0.4])
    assert np.allclose(batch, single[None, :])
    # 常色标记与取样值逐值一致(combine_e 快路的依赖)
    assert np.array_equal(np.asarray(s.constant_rgb), single)
    # 返回值只读:批量是 broadcast 视图,禁原地改
    with pytest.raises(ValueError):
        batch[0, 0] = 9.0


def test_skybox_sampler_lookup(tmp_path):
    """equirect 最近取样:朝上 → 顶行,朝下 → 底行;批/单形状一致。"""
    h, w = 4, 8
    rgbe = np.zeros((h, w, 4), np.uint8)
    rgbe[..., 3] = 136                                # f = 1 ⇒ 值 = 尾数字节
    rgbe[0, :, 0] = 200                               # 顶行红
    rgbe[-1, :, 2] = 100                              # 底行蓝
    f = tmp_path / 's.hdr'
    _write_hdr(f, h, w, rgbe.tobytes())
    s = make_sky_sampler({'mode': 'skybox', 'file': str(f), 'intensity': 1.0},
                         tmp_path)
    up = s(np.array([0.0, 1.0, 0.0], np.float32))
    down = s(np.array([0.0, -1.0, 0.0], np.float32))
    assert up[0] == pytest.approx(200.0) and up[2] == 0.0
    assert down[2] == pytest.approx(100.0) and down[0] == 0.0
    batch = s(np.array([[0, 1, 0], [0, -1, 0]], np.float32))
    assert np.allclose(batch[0], up) and np.allclose(batch[1], down)


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
