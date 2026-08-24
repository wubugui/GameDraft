# -*- coding: utf-8 -*-
"""输入层的**零外部依赖**合成用例(审查纠正:原测试全是数据条件式,
资产不在本机时全 skip 报绿 —— §3.2/§3.3/§3.4 必须有不吃真数据的直接覆盖)。"""
from __future__ import annotations

import json

import numpy as np
import pytest
from PIL import Image

from tools.lightbake import input as li


def _write_scene(tmp_path, sid='synt', *, w=64, h=48, scale=2.5, offset=-1.2,
                 invert=False, raw16=None, bake_sky=None, world_width=700.0,
                 R=None, cx=None, cy=None, depth_mapping=True):
    scenes_json = tmp_path / 'assets'
    scenes_rt = tmp_path / 'rt'
    (scenes_rt / sid).mkdir(parents=True, exist_ok=True)
    scenes_json.mkdir(parents=True, exist_ok=True)
    # 背景
    bg = np.full((h, w, 3), 128, np.uint8)
    Image.fromarray(bg).save(scenes_rt / sid / 'background.png')
    # 深度:raw16 = R*256 + G(§3.2)
    if raw16 is None:
        rng = np.random.default_rng(3)
        raw16 = rng.integers(0, 65536, (h, w), dtype=np.uint32)
    rg = np.zeros((h, w, 3), np.uint8)
    rg[..., 0] = raw16 // 256
    rg[..., 1] = raw16 % 256
    Image.fromarray(rg).save(scenes_rt / sid / 'raw_depth_rg.png')
    data = {
        'backgrounds': [{'image': 'background.png'}],
        'worldWidth': world_width,
        'depthConfig': {
            'M': {'R': (R if R is not None else np.eye(3)).tolist(),
                  'ppu': 32.0,
                  'cx': w / 2 if cx is None else cx,
                  'cy': h / 2 if cy is None else cy},
            **({'depth_mapping': {'scale': scale, 'offset': offset,
                                  'invert': invert}} if depth_mapping else {}),
        },
        'lighting': ({'bakeSky': bake_sky} if bake_sky else {}),
    }
    (scenes_json / f'{sid}.json').write_text(
        json.dumps(data, ensure_ascii=False), encoding='utf-8')
    return raw16


@pytest.fixture()
def synt(tmp_path, monkeypatch):
    monkeypatch.setattr(li, 'SCENES_JSON', tmp_path / 'assets')
    monkeypatch.setattr(li, 'SCENES_RT', tmp_path / 'rt')
    return tmp_path


def test_depth_decode_formula_both_invert_branches(synt):
    """§3.2 逐字:d = t·scale + offset,t = raw/65535(invert 时 1−t)。"""
    for invert in (False, True):
        raw16 = _write_scene(synt, sid=f'd{invert}', scale=3.7, offset=-2.1,
                             invert=invert)
        sc = li.load(f'd{invert}')
        t = raw16.astype(np.float64) / 65535.0
        if invert:
            t = 1.0 - t
        expect = (t * 3.7 - 2.1).astype(np.float32)
        assert np.allclose(sc.depth, expect, atol=1e-5)


def test_missing_depth_mapping_raises(synt):
    _write_scene(synt, sid='nomap', depth_mapping=False)
    with pytest.raises(RuntimeError, match='depth_mapping'):
        li.load('nomap')


def test_non_orthogonal_R_raises(synt):
    R = np.eye(3)
    R[0, 1] = 0.3
    _write_scene(synt, sid='badR', R=R)
    with pytest.raises(RuntimeError, match='正交'):
        li.load('badR')


def test_off_center_calibration_raises(synt):
    """28/28 场景实测不变量:标定中心 = 画幅中心;偏离 = 素材对被拆散。"""
    _write_scene(synt, sid='offc', cx=10.0)
    with pytest.raises(RuntimeError, match='画幅中心'):
        li.load('offc')


def test_pseudo_world_and_scale_chain(synt):
    _write_scene(synt, sid='chain', world_width=700.0, w=64, h=48)
    sc = li.load('chain')
    # 刻度链:scene_per_wu = worldWidth / (native_w / ppu_native)
    assert sc.scene_per_wu == pytest.approx(700.0 / (64 / 32.0))
    assert sc.char_wu == pytest.approx(150.0 / sc.scene_per_wu)
    # ppu/cx/cy 等比缩放(work == native 时 s=1)
    assert (sc.ppu, sc.cx, sc.cy) == (32.0, 32.0, 24.0)
    # world = R·q(R=I ⇒ world ≡ q)
    assert np.allclose(sc.world, sc.q, atol=1e-6)


def test_resolve_sky_spec_three_branches(synt):
    _write_scene(synt, sid='sky1', bake_sky={'mode': 'color',
                                             'color': [0.2, 0.3, 0.4],
                                             'intensity': 0.5})
    sc = li.load('sky1')
    s = li.resolve_sky_spec(sc)
    assert s['_source'] == 'scene' and s['color'] == [0.2, 0.3, 0.4]
    s = li.resolve_sky_spec(sc, {'mode': 'color', 'color': [1, 0, 0],
                                 'intensity': 1.0})
    assert s['_source'] == 'override' and s['color'] == [1, 0, 0]
    _write_scene(synt, sid='sky0')
    s = li.resolve_sky_spec(li.load('sky0'))
    assert s['_source'] == 'default'
    # 深拷贝:改返回值不许污染 DEFAULT_SKY
    s['color'][0] = 999.0
    from tools.lightbake.const import DEFAULT_SKY
    assert DEFAULT_SKY['color'][0] == 1.0


def test_edge_safe_normals_no_bevel_at_cliff():
    """§3.4 的功能性质:深度断崖两侧法线保持各自平面法线(中心差分会倒角)。"""
    h, w = 32, 32
    z = np.full((h, w), 1.0, np.float32)
    z[:, 16:] = 2.0                       # 竖直断崖
    xs = np.arange(w, dtype=np.float32)[None, :].repeat(h, 0) / 16.0
    ys = np.arange(h, dtype=np.float32)[:, None].repeat(w, 1) / 16.0
    world = np.stack([xs, ys, z], -1)
    R = np.eye(3, dtype=np.float32)
    n = li.edge_safe_normals(world, R)
    expect = np.array([0, 0, -1], np.float32)   # 朝相机(-R[:,2])
    assert np.allclose(n, expect[None, None, :], atol=1e-5), (
        '断崖处法线被带飞(edge-safe 差分失效)')


def test_edge_safe_normals_matches_reference_impl():
    """漂移护栏:与 tools/scene_relight/bake_gbuffer.edge_safe_normals 逐位一致
    (§3.4 要求「带过来」;两份拷贝日后漂移要立刻炸)。"""
    bg = pytest.importorskip('tools.scene_relight.bake_gbuffer')
    rng = np.random.default_rng(9)
    world = rng.uniform(-2, 2, (40, 50, 3)).astype(np.float32)
    R = np.eye(3, dtype=np.float32)
    a = li.edge_safe_normals(world.copy(), R)
    b = bg.edge_safe_normals(world.copy(), R)
    assert np.array_equal(a, b)


def test_char_scale_matches_authority():
    """真数据交叉验证(有资产才跑):与 tools/scene_relight/bake.character_band_wu
    逐值相等。"""
    bake = pytest.importorskip('tools.scene_relight.bake')
    geometry = pytest.importorskip('tools.scene_relight.geometry')
    try:
        sc = li.load('雾津街头')
        ref = bake.character_band_wu(geometry.Scene('雾津街头'))
    except (FileNotFoundError, RuntimeError):
        pytest.skip('本机没有场景数据')
    assert sc.char_wu == pytest.approx(ref['char_wu'])
    assert sc.scene_per_wu == pytest.approx(ref['scene_per_wu'])
    assert sc.band == pytest.approx(ref['band'])


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
