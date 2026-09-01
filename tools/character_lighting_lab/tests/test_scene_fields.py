"""几何场烘焙的回归:产物齐全 / 刻度链 / 物理判据 / 与光无关 / 落点统一。

全部用 tmp_path 合成场景（`synthetic.make_scene`），不碰工程数据。
2026-08-31 从 `tools/scene_relight/tests/test_relight.py` 随烘焙一起迁过来。
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

from tools.character_lighting_lab.scene_fields import (  # noqa: E402
    FIELD_FILES, FIELD_FILES_LIVE, PAYLOAD_VERSION, bake, character_band_wu,
)
from tools.character_lighting_lab.scene_geometry import Scene  # noqa: E402
from tools.character_lighting_lab.tests.synthetic import make_scene, patch_roots  # noqa: E402


@pytest.fixture
def town(tmp_path, monkeypatch):
    patch_roots(monkeypatch, tmp_path)
    make_scene(tmp_path)
    return tmp_path


def _bake_dir(town_path: Path) -> Path:
    return town_path / 'rt' / 'testtown' / 'lighting' / 'background'


def test_刻度链_角色在这张画里占多少wu(town):
    """合成场景：worldWidth=640、native_w=64、ppu=20
    ⇒ scene_per_wu = 640 / (64/20) = 200 场景坐标每 wu
    ⇒ 角色 150 场景坐标 = 0.75 wu

    `char_wu` 反映的是**取景远近**（实测 28 个场景 0.17–0.97，差 5.7 倍）。
    这里一度还导出过 `meters_per_wu = 1.7 / char_wu` —— 那是凭空造的单位，
    游戏里没有米，2026-08-21 整层删掉。
    """
    sc = character_band_wu(Scene('testtown'))
    assert abs(sc['scene_per_wu'] - 200.0) < 1e-6
    assert abs(sc['char_wu'] - 0.75) < 1e-6
    assert abs(sc['band'] - 0.75 * 1.15) < 1e-6
    assert 'meters_per_wu' not in sc, sc


def test_产物齐全且落在与probe同一个目录(town):
    """落点统一是这次收束的**核心断言**：一张背景图 = 一个目录。

    产物散在 `lighting/` 与 `lighting2/` 两处曾经是常态，代价不是"不好看"——
    打包规则、校验器、迁移脚本各写一套路径，其中任何一处少写一层目录就是
    **整批载荷静默不进包**（2026-08-31 真发生过，见 build 的护栏测试）。
    """
    r = bake('testtown', grid=(6, 5, 6))
    out = _bake_dir(town)
    assert Path(r['dest']) == out
    assert not (town / 'rt' / 'testtown' / 'lighting2').exists(), '不该再产 lighting2/'
    for name in FIELD_FILES:
        f = out / name
        assert f.exists(), name
        assert not f.with_suffix(f.suffix + '.tmp').exists(), f'{name} 留了临时文件'

    meta = json.loads((out / 'geometry.json').read_text(encoding='utf-8'))
    assert meta['version'] == PAYLOAD_VERSION
    assert meta['grid']['nx'] == 6 and meta['grid']['ny'] == 5 and meta['grid']['nz'] == 6
    assert 'scale' in meta and meta['scale']['char_wu'] > 0
    n = np.frombuffer((out / 'skyvis_grid.bin').read_bytes(), np.float32)
    assert n.size == 6 * 5 * 6
    assert 0.0 <= n.min() and n.max() <= 1.0
    assert r['band'] > 0


def test_两个哈希门都写进了载荷(town):
    """背景重画 / 深度重导而没重烘 = **静默错**，只能靠这两个哈希抓。"""
    import hashlib
    bake('testtown', grid=(4, 3, 4))
    meta = json.loads((_bake_dir(town) / 'geometry.json').read_text(encoding='utf-8'))
    rt = town / 'rt' / 'testtown'
    assert meta['background_sha1'] == hashlib.sha1(
        (rt / 'background.png').read_bytes()).hexdigest()[:12]
    assert meta['depth_sha1'] == hashlib.sha1(
        (rt / 'raw_depth_rg.png').read_bytes()).hexdigest()[:12]


def test_运行时真读的那几个是live清单的子集(town):
    """`FIELD_FILES_LIVE` 是打包规则与校验器的依据，别让它和实际产物分家。"""
    bake('testtown', grid=(4, 3, 4))
    out = _bake_dir(town)
    assert set(FIELD_FILES_LIVE) <= set(FIELD_FILES)
    for name in FIELD_FILES_LIVE:
        assert (out / name).exists(), name


def test_天穹可见性随高度单调上升(town):
    """物理判据：越高看见的天越多。任何一层比下面一层暗都是几何/march 写错了。

    ⚠ 必须用 `shape='ground'`（真水平地面 + 一堵挡光墙）。缺省那个 fixture
    在世界系里是**一面竖直平板**（`world_z` 只跨 0.035 wu），墙上方的格点
    直接埋进几何里，天穹可见度**本就该**随高度下降 —— 2026-09-01 换成无偏 MC
    之后这一点暴露了出来（旧实现靠 2.2 wu 的射程截断把它糊住了：射程短到
    墙根本挡不了几根射线，于是恰好"通过"了这个测试）。
    没有遮挡物的无限平面天穹可见度与高度**无关**，也测不出单调性。
    """
    make_scene(town, sid='testtown', shape='ground')
    bake('testtown', grid=(8, 6, 8))
    out = _bake_dir(town)
    g = json.loads((out / 'geometry.json').read_text(encoding='utf-8'))['grid']
    v = np.frombuffer((out / 'skyvis_grid.bin').read_bytes(), np.float32) \
        .reshape(g['nx'], g['ny'], g['nz'])
    per_layer = [float(v[:, i, :].mean()) for i in range(g['ny'])]
    assert all(per_layer[i] <= per_layer[i + 1] + 1e-6 for i in range(len(per_layer) - 1)), \
        f'天穹可见性未随高度单调上升: {per_layer}'


def test_烘出来的场与光照参数无关(town):
    """几何项判据：重烘两次必须逐字节相同（否则就不是"烘几何"了）。"""
    bake('testtown', grid=(6, 4, 6))
    out = _bake_dir(town)
    first = (out / 'skyvis_grid.bin').read_bytes()
    px_first = (out / 'skyvis.png').read_bytes()
    bake('testtown', grid=(6, 4, 6))
    assert (out / 'skyvis_grid.bin').read_bytes() == first
    assert (out / 'skyvis.png').read_bytes() == px_first


def test_换背景就换目录(town):
    """时段原画各有各的几何场——共用一份就是"拿白天的法线去照夜原画"。"""
    make_scene(town, sid='testtown')
    sj = town / 'assets' / 'testtown.json'
    data = json.loads(sj.read_text(encoding='utf-8'))
    (town / 'rt' / 'testtown' / 'night.png').write_bytes(
        (town / 'rt' / 'testtown' / 'background.png').read_bytes())
    data['backgrounds'] = [{'image': 'night.png', 'x': 0, 'y': 0}]
    sj.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    r = bake('testtown', grid=(4, 3, 4))
    assert Path(r['dest']).name == 'night'
    assert (town / 'rt' / 'testtown' / 'lighting' / 'night' / 'geometry.json').exists()


def test_时段变体也要各烘一套(town):
    """日夜项目里一个场景有多张时段原画，**每一张都要各烘一套几何场**。

    漏掉夜那张的后果是：白天一切正常，夜里运行时是"没烘载荷"⇒ 整套光照安静禁用。
    白天好好的，所以极难联想到是烘漏了。
    """
    from tools.character_lighting_lab.scene_fields import bake_scene
    from tools.character_lighting_lab.scene_geometry import scene_backgrounds

    sj = town / 'assets' / 'testtown.json'
    data = json.loads(sj.read_text(encoding='utf-8'))
    rt = town / 'rt' / 'testtown'
    (rt / 'night.png').write_bytes((rt / 'background.png').read_bytes())
    data['dayNight'] = {'enabled': True}
    data['timeVariants'] = {'夜': {'backgrounds': [{'image': 'night.png', 'x': 0, 'y': 0}]}}
    sj.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')

    assert scene_backgrounds('testtown') == ['background.png', 'night.png']
    rs = bake_scene('testtown', grid=(4, 3, 4))
    assert [Path(r['dest']).name for r in rs] == ['background', 'night']
    for key in ('background', 'night'):
        assert (rt / 'lighting' / key / 'geometry.json').exists(), key


def test_没开日夜时变体不算数(town):
    """与运行时 `resolveSceneAppearance` 同口径：没开 dayNight 的场景，变体不生效，
    烘了也没人读 —— 别白烘一套出来让人以为它在生效。"""
    from tools.character_lighting_lab.scene_geometry import scene_backgrounds
    sj = town / 'assets' / 'testtown.json'
    data = json.loads(sj.read_text(encoding='utf-8'))
    data['timeVariants'] = {'夜': {'backgrounds': [{'image': 'night.png', 'x': 0, 'y': 0}]}}
    data.pop('dayNight', None)
    sj.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    assert scene_backgrounds('testtown') == ['background.png']
