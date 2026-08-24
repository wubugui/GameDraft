# -*- coding: utf-8 -*-
"""输入层(§3 契约)的真数据冒烟:深度解码、伪世界重建、edge-safe 法线、角色刻度。"""
from __future__ import annotations

import numpy as np
import pytest

from tools.lightbake import input as li

SID = '雾津街头'


@pytest.fixture(scope='module')
def scene():
    try:
        return li.load(SID)
    except FileNotFoundError as exc:
        pytest.skip(f'场景数据不在本机: {exc}')


def test_shapes_and_types(scene):
    w, h = scene.work
    assert scene.depth.shape == (h, w)
    assert scene.world.shape == (h, w, 3)
    assert scene.normal.shape == (h, w, 3)
    assert scene.q.shape == (h, w, 3)
    assert scene.depth.dtype == np.float32
    nw, nh = scene.native
    assert scene.bg_srgb.shape == (nh, nw, 3)
    assert w == min(1024, nw)


def test_rotation_orthonormal(scene):
    R = scene.R
    assert np.allclose(R @ R.T, np.eye(3), atol=1e-5)
    # world = R·q(行向量:world = q @ Rᵀ)
    got = scene.q.reshape(-1, 3)[:1000] @ R.T
    assert np.allclose(got, scene.world.reshape(-1, 3)[:1000], atol=1e-5)


def test_normals_unit_and_facing(scene):
    n = scene.normal.reshape(-1, 3)
    assert np.allclose(np.linalg.norm(n, axis=1), 1.0, atol=1e-4)
    facing = -scene.R[:, 2]
    assert np.mean(n @ facing >= -1e-6) > 0.999


def test_char_scale(scene):
    assert scene.char_wu > 0
    assert scene.band == pytest.approx(scene.char_wu * 1.15)
    # 25/28 个场景标定成同一世界宽度 50/11 ≈ 4.5455(character_band_wu 注释)
    assert 0.05 < scene.char_wu < 2.0


def test_list_bakeable_contains_reference():
    ids = li.list_bakeable()
    if not ids:
        pytest.skip('本机没有场景数据')
    assert SID in ids
    assert len(ids) >= 20


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
