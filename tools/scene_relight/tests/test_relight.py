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
    data: dict = {'id': sid, 'backgrounds': [{'image': 'background.png', 'x': 0, 'y': 0}]}
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


def test_saved_params_roundtrip(town):
    store.save_params('testtown', '暮', {'ev': -1.25})
    got = store.load_params('testtown', '暮')
    assert got['ev'] == -1.25
    assert got['contrast'] == DEFAULTS['contrast']            # 存的是补全后的完整参数
    assert store.saved_presets('testtown') == ['暮']
