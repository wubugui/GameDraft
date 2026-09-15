# -*- coding: utf-8 -*-
"""地形合成器 `terrain_compose`：格子判定与运行时同口径、阻挡压过可走、作者层形状闸门、行走面修补。

真实场景那几条（旁挂 == 位图尺寸、合成 == 磁盘）要 DVC 数据，没有就跳过。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.character_lighting_lab import terrain_compose as tc  # noqa: E402


@pytest.fixture
def scene(tmp_path, monkeypatch):
    """临时场景：4×3 的自动网格（中间一列阻挡）+ 空作者层。"""
    monkeypatch.setattr(tc, 'SCENES_RT', tmp_path / 'rt')
    monkeypatch.setattr(tc, 'SCENES_JSON', tmp_path / 'assets')
    (tmp_path / 'assets').mkdir()
    (tmp_path / 'assets' / 'x.json').write_text(json.dumps({'id': 'x', 'depthConfig': {'collision_map': 'collision.png'}}),
                                                encoding='utf-8')
    (tmp_path / 'rt' / 'x').mkdir(parents=True)
    grid = tc.GridMeta(0.0, 0.0, 10.0, 4, 3)
    blocked = np.zeros((3, 4), bool)
    blocked[:, 2] = True
    tc.record_auto('x', blocked, grid)
    return grid


def test_格子判定与运行时同式_floor_与格心():
    g = tc.GridMeta(-5.0, 2.5, 10.0, 4, 3)
    gx, gz = g.cell_of(np.array([-5.0, 4.999, 5.0, 34.9, 35.0]), np.array([2.5, 2.5, 12.4, 12.5, 32.4]))
    assert gx.tolist() == [0, 0, 1, 3, 4] and gz.tolist() == [0, 0, 0, 1, 2]
    assert g.inside(gx, gz).tolist() == [True, True, True, True, False]
    X, Z = g.centers()
    assert X[0, 0] == 0.0 and Z[0, 0] == 7.5 and X.shape == (3, 4)


def test_多边形按格心栅格化():
    g = tc.GridMeta(0.0, 0.0, 10.0, 4, 3)
    # 覆盖 (0..20, 0..20) 的方块 → 左上 2×2 格的格心 (5,5)(15,5)(5,15)(15,15) 在内
    m = tc.rasterize_polygon([[0, 0], [20, 0], [20, 20], [0, 20]], g)
    assert m.sum() == 4 and m[0, 0] and m[1, 1] and not m[0, 2] and not m[2, 0]
    # 三角形只压到一个格心：(5,5) 在 x+z<12 内,(15,5) / (5,15) 不在
    m2 = tc.rasterize_polygon([[0, 0], [12, 0], [0, 12]], g)
    assert m2.sum() == 1 and m2[0, 0]


def test_自动结果_笔刷_多边形_阻挡压过可走(scene):
    grid = scene
    blocked, src, g = tc.compose_collision('x')
    assert g.same(grid)
    assert blocked[:, 2].all() and not blocked[:, 0].any()
    assert src[0, 2] == tc.SRC_AUTO_BLOCK and src[0, 0] == tc.SRC_AUTO_WALK
    doc = tc.load_terrain('x')
    # 笔刷:把 (2,1) 打成可走、(0,0) 打成阻挡
    brush = np.zeros((3, 4), np.uint8)
    brush[1, 2] = tc.BRUSH_WALK
    brush[0, 0] = tc.BRUSH_BLOCK
    tc.write_u8_png(tc.terrain_dir('x') / tc.BRUSH_FILE, brush)
    doc['brush'] = {'file': tc.BRUSH_FILE, **grid.to_dict()}
    # 多边形:可走覆盖整列 2,再来一块阻挡压在 (2,2) 上
    doc['regions'] = [
        {'id': 'r_walk', 'kind': 'walk', 'points': [[20, 0], [30, 0], [30, 30], [20, 30]]},
        {'id': 'r_block', 'kind': 'block', 'points': [[20, 20], [30, 20], [30, 30], [20, 30]]},
    ]
    tc.save_terrain('x', doc)
    blocked, src, _ = tc.compose_collision('x')
    assert not blocked[0, 2] and not blocked[1, 2], '多边形 / 笔刷可走盖掉自动阻挡'
    assert blocked[2, 2], '阻挡多边形压过可走多边形(与顺序无关)'
    assert blocked[0, 0] and src[0, 0] == tc.SRC_BRUSH_BLOCK
    assert src[1, 2] == tc.SRC_REGION_WALK  # 多边形来源标记覆盖笔刷标记
    assert src[2, 2] == tc.SRC_REGION_BLOCK


def test_网格外的自动格子按可走(scene):
    doc = tc.load_terrain('x')
    doc['grid'] = tc.GridMeta(-10.0, -10.0, 10.0, 6, 5).to_dict()     # 比自动网格大一圈
    tc.save_terrain('x', doc)
    blocked, src, g = tc.compose_collision('x')
    assert blocked.shape == (5, 6)
    assert not blocked[0, :].any() and src[0, 0] == tc.SRC_OUTSIDE
    assert blocked[1, 3] and src[1, 3] == tc.SRC_AUTO_BLOCK           # 原 (2, 0) 挪到 (3, 1)


def test_导出写旁挂与位图且尺寸一致(scene, tmp_path):
    r = tc.export_terrain('x')
    png = tc.read_u8_png(tc.SCENES_RT / 'x' / 'collision.png')
    side = json.loads((tc.SCENES_RT / 'x' / tc.SIDECAR_FILE).read_text(encoding='utf-8'))
    assert png.shape == (side['grid_height'], side['grid_width']) == (3, 4)
    assert side['version'] == tc.SIDECAR_VERSION and side['cell_size'] == 10.0
    assert r['blocked_pct'] == pytest.approx(25.0)
    # 预览目录:资源一个字节不动
    before = (tc.SCENES_RT / 'x' / 'collision.png').read_bytes()
    out = tmp_path / 'preview'
    tc.export_terrain('x', out_dir=out)
    assert (out / 'collision.png').exists() and (out / tc.SIDECAR_FILE).exists()
    assert (tc.SCENES_RT / 'x' / 'collision.png').read_bytes() == before


def test_形状闸门():
    good = tc.default_terrain(tc.GridMeta(0, 0, 1, 2, 2))
    assert tc.terrain_problems(good) == []
    bad = dict(good, regions=[{'id': 'a', 'kind': 'walk', 'points': [[0, 0], [1, 0]]},
                              {'id': 'a', 'kind': 'nope', 'points': [[0, 0], [1, 0], [1, 1]]}])
    p = tc.terrain_problems(bad)
    assert any('≥3' in t for t in p) and any('重复' in t for t in p) and any('walk / block' in t for t in p)
    assert tc.terrain_problems({'version': 99}) and tc.terrain_problems([])


def test_旁挂优先于_depthConfig(tmp_path):
    base = tmp_path / 's'
    base.mkdir()
    cfg = {'collision': {'x_min': 1, 'z_min': 2, 'cell_size': 3, 'grid_width': 4, 'grid_height': 5}}
    assert tc.load_collision_meta('s', cfg, base) == tc.GridMeta(1, 2, 3, 4, 5)
    (base / tc.SIDECAR_FILE).write_text(json.dumps({'version': 1, 'x_min': 9, 'z_min': 9, 'cell_size': 1,
                                                    'grid_width': 2, 'grid_height': 2}), encoding='utf-8')
    assert tc.load_collision_meta('s', cfg, base) == tc.GridMeta(9, 9, 1, 2, 2)
    assert tc.load_collision_meta('s', {}, tmp_path / 'none') is None


def _flat_frame():
    theta = np.deg2rad(45.0)
    c, s = np.cos(theta), np.sin(theta)
    R = np.array([[1, 0, 0], [0, c, -s], [0, s, c]], np.float64)
    ppu, W, H = 20.0, 64, 48
    cx, cy = W / 2, H / 2
    k = 10.0                                   # wu / q
    # 平地 Y=0:qy*c - d*s = 0 → d = qy*c/s
    py = np.arange(H, dtype=np.float64)[:, None].repeat(W, 1)
    qy = (cy - py) / ppu
    qx = (np.arange(W, dtype=np.float64)[None, :].repeat(H, 0) - cx) / ppu
    base = (qy * c / s).astype(np.float32)
    frame = {'R': R, 'wu_per_q': k, 'cal': {'ppu': ppu, 'cx': cx, 'cy': cy}}
    return R, k, qx, qy, base, frame


def _world(R, k, qx, qy, d):
    d = d.astype(np.float64)
    return ((R[0, 0] * qx + R[0, 1] * qy + R[0, 2] * d) * k,
            (R[1, 0] * qx + R[1, 1] * qy + R[1, 2] * d) * k,
            (R[2, 0] * qx + R[2, 1] * qy + R[2, 2] * d) * k)


def test_行走面修补_平坦地面抬高一块():
    """平地(Y=0)上把一块压平到 Y=+5 wu:落在台面上的像素 Y≈5,落在朝镜头那面立面上的像素 Z≈-10,
    别处逐字节不动(第一次落到面下 = 可见表面,与遮挡取法一致)。
    (画幅只有 2.4 q 高:抬 50 wu 台面整个跑到画外,只剩立面——所以抬 5。)"""
    R, k, qx, qy, base, frame = _flat_frame()
    # 文档一律网格单位(= wu / k):网格 ±4、多边形 ±1、压平到 0.5 ⇒ 世界里 ±40 / ±10 / 5 wu
    grid = tc.GridMeta(-4.0, -4.0, 0.5, 16, 16)
    doc = tc.default_terrain(grid)
    doc['heightOps'] = [{'id': 'h1', 'kind': 'flatten', 'value': 0.5, 'points': [[-1, -1], [1, -1], [1, 1], [-1, 1]]}]
    out = tc.compose_ground('x', doc, base, frame)
    changed = np.abs(out - base) > 1e-6
    assert changed.any() and changed.mean() < 0.6
    X, Y, Z = _world(R, k, qx, qy, out)
    top = changed & (np.abs(Y - 5.0) < 0.05)
    wall = changed & ~top
    assert top.sum() > 400, '台面像素要有一片'
    assert np.all((X[top] >= -10.05) & (X[top] <= 10.05) & (Z[top] >= -10.05) & (Z[top] <= 10.05))
    # 立面:Z 钉在多边形前沿 z=-10,Y 在 0..5 之间
    assert wall.sum() > 50 and np.allclose(Z[wall], -10.0, atol=0.05) and np.all((Y[wall] > -0.05) & (Y[wall] < 5.05))
    assert np.array_equal(out[~changed], base[~changed])


def test_行走面修补_平滑抬高不留立面():
    """`offset` + 羽化:没有台阶,被改像素的 Y 就是 Δ(X,Z)(0..8 之间),射线交点自洽。"""
    R, k, qx, qy, base, frame = _flat_frame()
    grid = tc.GridMeta(-4.0, -4.0, 0.5, 16, 16)
    doc = tc.default_terrain(grid)
    doc['heightOps'] = [{'id': 'h1', 'kind': 'offset', 'value': 0.8, 'feather': 1.0,
                         'points': [[-1.5, -1.5], [1.5, -1.5], [1.5, 1.5], [-1.5, 1.5]]}]
    out = tc.compose_ground('x', doc, base, frame)
    changed = np.abs(out - base) > 1e-6
    assert changed.any()
    X, Y, Z = _world(R, k, qx, qy, out)
    hf = tc.build_heightfield(base, frame['cal'], R, k)
    want = tc.height_delta_at('x', doc, hf, X, Z, grid, k)
    assert np.allclose(Y[changed], want[changed], atol=0.05)
    assert np.all((Y[changed] > -0.05) & (Y[changed] < 8.05))
    assert np.array_equal(out[~changed], base[~changed])
