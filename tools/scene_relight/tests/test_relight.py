"""scene_relight 核心回归:深度解码契约 / 中性参数≈原图 / 确定性 / 导出落盘。

全部用 tmp_path 合成场景(monkeypatch geometry 的路径常量),不碰工程数据。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.scene_relight import geometry, store          # noqa: E402
from tools.scene_relight.geometry import Scene           # noqa: E402
from tools.scene_relight.presets import PRESETS          # noqa: E402
from tools.scene_relight.relight import (                # noqa: E402
    DEFAULTS, kelvin_rgb, merge_params, relight, rig_from_time)

W, H = 64, 40


def _make_scene(tmp: Path, sid: str = 'testtown', with_depth: bool = True,
                with_mask: bool = False) -> None:
    """合成一个最小场景:渐变背景 + 线性深度斜坡 + 45° 标定。"""
    (tmp / 'assets').mkdir(parents=True, exist_ok=True)
    rt = tmp / 'rt' / sid
    rt.mkdir(parents=True, exist_ok=True)
    rgb = np.zeros((H, W, 3), np.uint8)
    rgb[..., 0] = np.linspace(40, 200, W, dtype=np.uint8)[None, :]
    rgb[..., 1] = 128
    rgb[..., 2] = np.linspace(200, 60, H, dtype=np.uint8)[:, None]
    Image.fromarray(rgb).save(rt / 'background.png')
    # worldWidth 是刻度链的一环：场景坐标 →(native_w/worldWidth)→ 背景像素 →(1/ppu)→ 世界单位
    data: dict = {'id': sid, 'worldWidth': 640.0, 'worldHeight': 400.0,
                  'backgrounds': [{'image': 'background.png', 'x': 0, 'y': 0}]}
    if with_depth:
        d = np.linspace(0.5, 2.5, H, dtype=np.float32)[:, None].repeat(W, 1)  # 底近顶远
        lo, hi = float(d.min()) - 1e-4, float(d.max()) + 1e-4
        raw16 = np.round((d - lo) / (hi - lo) * 65535).astype(np.uint16)
        rg = np.zeros((H, W, 3), np.uint8)
        rg[..., 0] = raw16 >> 8
        rg[..., 1] = raw16 & 0xFF
        Image.fromarray(rg).save(rt / 'raw_depth_rg.png')
        c = s = 0.7071067811865476
        data['depthConfig'] = {
            'depth_map': 'raw_depth_rg.png',
            'M': {'R': [[1, 0, 0], [0, c, -s], [0, s, c]], 'ppu': 20.0,
                  'cx': W / 2.0, 'cy': H / 2.0},
            'depth_mapping': {'invert': False, 'scale': hi - lo, 'offset': lo},
        }
    if with_mask:
        m = np.zeros((H, W), np.uint8)
        m[18:22, 30:34] = 255
        out = tmp / 'out' / sid
        out.mkdir(parents=True, exist_ok=True)
        Image.fromarray(m).save(out / 'emissive_mask.png')
    (tmp / 'assets' / f'{sid}.json').write_text(
        json.dumps(data, ensure_ascii=False), encoding='utf-8')


@pytest.fixture
def town(tmp_path, monkeypatch):
    monkeypatch.setattr(geometry, 'SCENES_JSON', tmp_path / 'assets')
    monkeypatch.setattr(geometry, 'SCENES_RT', tmp_path / 'rt')
    monkeypatch.setattr(geometry, 'OUT', tmp_path / 'out')
    _make_scene(tmp_path, with_mask=True)
    return tmp_path


def test_depth_decode_matches_contract(town):
    s = Scene('testtown')
    d = s.depth_native
    assert d is not None and d.shape == (H, W)
    # 契约:d = (R*256+G)/65535*scale+offset —— 斜坡两端还原
    assert abs(float(d[0, 0]) - 0.5) < 2e-3
    assert abs(float(d[-1, 0]) - 2.5) < 2e-3


def test_neutral_params_are_identity(town):
    s = Scene('testtown')
    out = relight(s, {})                            # DEFAULTS:amb=1.0/6500K,无太阳无雾
    src = np.asarray(Image.open(town / 'rt' / 'testtown' / 'background.png'))
    assert int(np.abs(out.astype(int) - src.astype(int)).max()) <= 1


def test_deterministic_bytes(town):
    s = Scene('testtown')
    a = store.render_png_bytes(s, PRESETS['夜'])
    b = store.render_png_bytes(Scene('testtown'), PRESETS['夜'])
    assert a == b


def test_unknown_param_rejected():
    with pytest.raises(KeyError):
        merge_params({'no_such_knob': 1.0})


def test_all_presets_and_rig_valid():
    for p in PRESETS.values():
        merge_params(p)
    for t in (0.0, 5.9, 6.1, 12.0, 18.7, 19.5, 23.9):
        merge_params(rig_from_time(t))


def test_kelvin_neutral_and_direction():
    assert np.allclose(kelvin_rgb(6500.0), 1.0, atol=1e-6)
    warm, cool = kelvin_rgb(2500.0), kelvin_rgb(12000.0)
    assert warm[0] > warm[2] and cool[2] > cool[0]


def test_emissive_needs_mask_and_gain(town):
    s = Scene('testtown')
    lit = relight(s, {'emis_gain': 4.0})
    off = relight(s, {'emis_gain': 0.0})
    assert int(np.abs(lit.astype(int) - off.astype(int)).max()) > 20   # mask 点亮了
    # mask 区之外远处角落不受灯影响(光晕半径有限)
    assert int(np.abs(lit[:4, :4].astype(int) - off[:4, :4].astype(int)).max()) <= 2


def test_point_lights_illuminate_locally(town):
    """点光源:mask 团附近有入射光、远角没有;灯色吃原图像素色。"""
    from tools.scene_relight.geometry import srgb_to_linear
    from tools.scene_relight.relight import lamp_irradiance, merge_params
    s = Scene('testtown')
    geo = s.geometry((W, H))
    mask = s.emissive_mask((W, H))
    bg_lin = srgb_to_linear(s.bg_srgb)
    p = merge_params({'lamp_int': 1.5, 'lamp_range': 1.0})
    E = lamp_irradiance(geo, mask, bg_lin, p)
    assert float(E[18:22, 28:38].max()) > 0.05      # 灯旁边真的有光
    assert float(E[:3, :3].max()) < 0.01            # 远角接近零(作用半径截断)


def test_scene_without_depth_degrades(town, monkeypatch):
    _make_scene(town, sid='flat', with_depth=False)
    s = Scene('flat')
    assert s.geometry((W, H)) is None
    out = relight(s, PRESETS['夜'])                 # 不炸,退化为调色
    assert out.shape == (H, W, 3)


def test_export_writes_variant_params_and_backup(town):
    s = Scene('testtown')
    res = store.export_variant(s, '夜', PRESETS['夜'])
    dest = town / 'rt' / 'testtown' / 'background_relight_夜.png'
    assert dest.exists() and res['backup'] is None
    assert not dest.with_suffix('.png.tmp').exists()          # 原子写不留尾巴
    assert (town / 'out' / 'testtown' / 'params_夜.json').exists()
    assert res['snippet']['timeVariants']['夜']['backgrounds'][0]['image'] == dest.name
    res2 = store.export_variant(s, '夜', PRESETS['夜'])       # 二次导出必须备份旧变体
    assert res2['backup'] is not None
    assert Path(town / res2['backup']).exists() or Path(res2['backup']).exists()


# ---------------------------------------------------------------- 几何场烘焙

def test_character_scale_derivation(town):
    """刻度链：角色在这张画里占多少 wu，由 worldWidth/native_w/ppu 推出。

    合成场景：worldWidth=640、native_w=64、ppu=20
    ⇒ scene_per_wu = 640 / (64/20) = 200 场景坐标每 wu
    ⇒ 角色 150 场景坐标 = 0.75 wu

    `char_wu` 是**全项目唯一的尺度参照**（每张原画取景远近不同，实测 28 个场景
    0.17–0.97，差 5.7 倍）。这里一度还导出过 `meters_per_wu = 1.7 / char_wu`
    ——那是凭空造的单位，游戏里没有米，2026-08-21 整层删掉。
    """
    from tools.scene_relight.bake import character_band_wu
    s = Scene('testtown')
    sc = character_band_wu(s)
    assert abs(sc['scene_per_wu'] - 200.0) < 1e-6
    assert abs(sc['char_wu'] - 0.75) < 1e-6
    assert abs(sc['band'] - 0.75 * 1.15) < 1e-6
    # 防回退：别再往刻度里塞造出来的单位
    assert 'meters_per_wu' not in sc, sc


def test_bake_produces_all_fields(town):
    from tools.scene_relight.bake import PAYLOAD_VERSION, bake
    r = bake('testtown', grid=(6, 5, 6))
    out = town / 'rt' / 'testtown' / 'lighting2'
    for name in ('normal.png', 'skyvis.png', 'skyvis_grid.bin', 'meta.json'):
        assert (out / name).exists(), name
        assert not (out / name).with_suffix((out / name).suffix + '.tmp').exists()
    meta = json.loads((out / 'meta.json').read_text(encoding='utf-8'))
    assert meta['version'] == PAYLOAD_VERSION
    assert meta['grid']['nx'] == 6 and meta['grid']['ny'] == 5 and meta['grid']['nz'] == 6
    assert 'scale' in meta and meta['scale']['char_wu'] > 0
    n = np.frombuffer((out / 'skyvis_grid.bin').read_bytes(), np.float32)
    assert n.size == 6 * 5 * 6
    assert 0.0 <= n.min() and n.max() <= 1.0
    assert r['band'] > 0


def test_skyvis_grid_increases_with_height(town):
    """物理判据：越高看见的天越多。任何一层比下面一层暗都是几何/march 写错了。"""
    from tools.scene_relight.bake import bake
    bake('testtown', grid=(8, 6, 8))
    out = town / 'rt' / 'testtown' / 'lighting2'
    meta = json.loads((out / 'meta.json').read_text(encoding='utf-8'))
    g = meta['grid']
    v = np.frombuffer((out / 'skyvis_grid.bin').read_bytes(), np.float32) \
        .reshape(g['nx'], g['ny'], g['nz'])
    per_layer = [float(v[:, i, :].mean()) for i in range(g['ny'])]
    assert all(per_layer[i] <= per_layer[i + 1] + 1e-6 for i in range(len(per_layer) - 1)), \
        f'天穹可见性未随高度单调上升: {per_layer}'


def test_skyvis_is_light_independent(town):
    """几何项判据：改任何光照参数都不该影响烘出来的场（否则就不是"烘几何"了）。"""
    from tools.scene_relight.bake import bake
    bake('testtown', grid=(6, 4, 6))
    out = town / 'rt' / 'testtown' / 'lighting2'
    first = (out / 'skyvis_grid.bin').read_bytes()
    px_first = (out / 'skyvis.png').read_bytes()
    bake('testtown', grid=(6, 4, 6))
    assert (out / 'skyvis_grid.bin').read_bytes() == first
    assert (out / 'skyvis.png').read_bytes() == px_first


def test_saved_params_roundtrip(town):
    store.save_params('testtown', '暮', {'ev': -1.25})
    got = store.load_params('testtown', '暮')
    assert got['ev'] == -1.25
    assert got['contrast'] == DEFAULTS['contrast']            # 存的是补全后的完整参数
    assert store.saved_presets('testtown') == ['暮']
