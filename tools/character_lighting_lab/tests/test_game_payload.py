"""查看器的虚拟载荷(`game_payload.py`)== 真导出(`export_runtime` / `export_scene_depth`),逐字节。

查看器迁到 RHI 后,2D 受光预览用的是**游戏的**装载器 + 着色,喂给它的是工作台按导出同式现场变换出来的
虚拟目录(不落盘)。这条链只要漂一点,"实验室里看到的 = 导出后游戏里看到的"就不成立,而且不报错。
所以在沙箱里对同一份合成工作台**真跑一遍导出**(写进临时工程根),把虚拟目录的每个文件与它逐字节 / 逐像素比。

另有 serve 路由的几条:虚拟目录的 404 / 400、运行时场景目录只读转发的字面路径白名单(worktree 里
`public/resources/runtime` 常是 junction,按真实路径判会整片 404)、GLSL 路由已删。
"""
from __future__ import annotations

import io
import json
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.character_lighting_lab import game_payload, pipeline, serve  # noqa: E402
from tools.character_lighting_lab import terrain_compose as tc  # noqa: E402

SID = 'zz_payload'
W, H = 24, 14                  # work
NW, NH = 48, 28                # native
PN = (3, 2, 4)
VOL = (6, 5, 7)


def _f16(rng: np.random.Generator, *shape: int, lo=-0.3, hi=1.5) -> np.ndarray:
    return rng.uniform(lo, hi, size=shape).astype(np.float16)


def _make_workdir(root: Path, with_game_bg: bool, azimuth: float = 0.0) -> Path:
    """合成工作台:manifest + 四分账 probe + 体素卷 + 深度 / 行走面 + 背景。落在 <root>/out/<SID>/background/。"""
    rng = np.random.default_rng(7)
    wd = root / 'out' / SID / 'background'
    wd.mkdir(parents=True)
    pn = PN[0] * PN[1] * PN[2]
    for slot, k in (('l1', 4), ('l2', 9), ('bins', 64)):
        (wd / f'probes_{slot}.bin').write_bytes(_f16(rng, pn, k, 4).tobytes())
        for part in ('amb', 'emit', 'nee'):
            (wd / f'probes_{slot}{part}.bin').write_bytes(_f16(rng, pn, k, 3).tobytes())
    valid = (rng.uniform(size=pn) > 0.3).astype(np.uint8) * 255
    (wd / 'probes_valid.bin').write_bytes(valid.tobytes())
    nx, ny, nz = VOL
    (wd / 'volume.bin').write_bytes(_f16(rng, nz, ny, nx, 4, lo=0, hi=1).tobytes())
    (wd / 'volume_emit.bin').write_bytes(_f16(rng, nz, ny, nx, 4, lo=0, hi=0.2).tobytes())
    yy = np.linspace(0.4, 2.8, H, dtype=np.float32)[:, None].repeat(W, 1)
    (wd / 'front_depth.bin').write_bytes((yy + rng.uniform(-0.05, 0.05, size=(H, W)).astype(np.float32)).tobytes())
    (wd / 'walk_depth.bin').write_bytes((yy * 1.02).astype(np.float32).tobytes())
    walk = np.zeros((5, 6), np.uint8)
    walk[1:4, 1:5] = 255
    Image.fromarray(walk).save(wd / 'walk_mask.png')
    rgb = (rng.uniform(size=(NH, NW, 3)) * 255).astype(np.uint8)
    Image.fromarray(rgb).save(wd / 'background.png')
    c = s = 0.7071067811865476
    man = {
        'name': SID, 'hash': 'abcdef012345',
        'params': {'azimuth_deg': azimuth, 'pitch_deg': 45.0, 'ev': 0.0},
        'work': {'w': W, 'h': H}, 'native': {'w': NW, 'h': NH},
        'cal': {'theta': 0.7853981633974483, 'ppu': 7.5, 'cx': W / 2, 'cy': H / 2},
        'world': {'M': [[1, 0, 0], [0, c, -s], [0, -s, -c]], 'x0': -1.5, 'x1': 1.5, 'y0': -0.2, 'y1': 1.4, 'z0': -1.1, 'z1': 1.3},
        'probes': {'nx': PN[0], 'ny': PN[1], 'nz': PN[2], 'sh_k': 9, 'bin_ob': 8},
        'vol': {'Nx': float(nx), 'Ny': float(ny), 'Nz': float(nz), 'qx_min': -1.6, 'qx_max': 1.6,
                'qy_min': -0.9, 'qy_max': 0.9, 'qz_min': -1.2, 'qz_max': 1.4},
        'ambient': {'sh': [float(v) for v in rng.uniform(-0.1, 0.3, size=27)]},
        'lights': [{'pos': [0.1, 0.2, 0.3], 'normal': [0, 1, 0], 'radiance': [0.5, 0.4, 0.3], 'area': 0.01, 'power': 1e-4}],
        'walk': {'nx': 6, 'nz': 5, 'x0': -1.5, 'z0': -1.1, 'dx': 0.6, 'dz': 0.6},
        'built': '2026-09-28 00:00:00',
    }
    (wd / 'manifest.json').write_text(json.dumps(man), encoding='utf-8')
    scenes = root / 'public' / 'assets' / 'scenes'
    scenes.mkdir(parents=True)
    (scenes / f'{SID}.json').write_text(json.dumps({
        'id': SID, 'worldWidth': 480, 'worldHeight': 280,
        'backgrounds': [{'image': 'background.png'}],
        'depthConfig': {'depth_map': 'raw_depth_rg.png', 'depth_tolerance': 0.07, 'floor_offset': -0.01},
    }), encoding='utf-8')
    rt = root / 'public' / 'resources' / 'runtime' / 'scenes' / SID
    rt.mkdir(parents=True)
    if with_game_bg:
        (rt / 'background.png').write_bytes((wd / 'background.png').read_bytes())
    return wd


@pytest.fixture
def sandbox(tmp_path, monkeypatch):
    monkeypatch.setattr(pipeline, 'ROOT', tmp_path)
    monkeypatch.setattr(pipeline, 'OUT', tmp_path / 'out')
    # 导出里连带的地形合成 / 行走面基底两步会写地形作者层,与这里比的文件无关:沙箱里不跑
    monkeypatch.setattr(tc, 'record_ground_base', lambda *a, **k: None)
    monkeypatch.setattr(tc, 'export_ground', lambda *a, **k: [])
    monkeypatch.setattr(tc, 'record_auto', lambda *a, **k: None)
    monkeypatch.setattr(tc, 'export_terrain', lambda *a, **k: {})
    game_payload._cache.clear()
    return tmp_path


def _virtual(name: str, nee: bool = False, amb: float = 1.0) -> bytes:
    hit = game_payload.payload_file(SID, game_payload.compose_key(nee, amb), name, '/virt')
    assert hit is not None, name
    return hit[0]


def _pixels(png: bytes) -> np.ndarray:
    return np.asarray(Image.open(io.BytesIO(png)).convert('RGBA'))


@pytest.mark.parametrize('with_game_bg', [False, True])
@pytest.mark.parametrize('nee,amb', [(False, 1.0), (True, 0.35)])
def test_虚拟载荷_与真导出逐字节相同(sandbox, with_game_bg, nee, amb):
    _make_workdir(sandbox, with_game_bg)
    dest = pipeline.export_runtime(SID, shading={'nee': 1 if nee else 0, 'amb': amb})
    for name in ('atlas_l1.bin', 'atlas_l2.bin', 'atlas_bin.bin', 'probes_valid.bin',
                 'vol_rad.bin', 'vol_emit.bin', 'ground_d.png'):
        assert _virtual(name, nee, amb) == (dest / name).read_bytes(), name
    real = json.loads((dest / 'lighting.json').read_text(encoding='utf-8'))
    virt = json.loads(_virtual('lighting.json', nee, amb))
    assert virt == real
    if with_game_bg:   # 游戏背景与工作台副本像素相同 → 盖游戏文件的哈希(与导出同一判据)
        assert virt['background_sha1'] == pipeline.img_hash(game_payload.game_background(SID))


@pytest.mark.parametrize('azimuth', [0.0, 17.0])
def test_虚拟深度_与导出深度同一份(sandbox, azimuth):
    _make_workdir(sandbox, True, azimuth)
    cfg = pipeline.export_scene_depth(SID)
    real_png = (sandbox / 'public' / 'resources' / 'runtime' / 'scenes' / SID / 'raw_depth_rg.png').read_bytes()
    virt_cfg = json.loads(_virtual('depth.json'))
    assert virt_cfg['depth_map'] == '/virt/raw_depth_rg.png'
    assert json.dumps(virt_cfg['M'], sort_keys=True) == json.dumps(cfg['M'], sort_keys=True)
    assert virt_cfg['depth_mapping'] == cfg['depth_mapping']
    assert virt_cfg['shader'] == cfg['shader']
    assert (virt_cfg['depth_tolerance'], virt_cfg['floor_offset']) == (0.07, -0.01)
    assert np.array_equal(_pixels(_virtual('raw_depth_rg.png'))[..., :3], _pixels(real_png)[..., :3])


def test_合成参数段(sandbox):
    assert game_payload.compose_key(False, 1) == 'n0-a1.000'
    assert game_payload.parse_compose('n1-a0.350') == (True, 0.35)
    for bad in ('n2-a1', 'x0-a1', 'n0-a-1', 'n0-a99', 'n0'):
        with pytest.raises(ValueError):
            game_payload.parse_compose(bad)


def test_几何场原样转发_没有就是没有(sandbox):
    _make_workdir(sandbox, True)
    assert game_payload.payload_file(SID, 'n0-a1.000', 'geometry.json', '/v') is None
    d = game_payload.exported_dir(SID)
    d.mkdir(parents=True)
    (d / 'geometry.json').write_text('{"M": [[1,0,0],[0,1,0],[0,0,1]]}', encoding='utf-8')
    (d / 'skyao_probe.bin').write_bytes(b'\x01\x02')
    assert game_payload.payload_file(SID, 'n0-a1.000', 'geometry.json', '/v')[0] == (d / 'geometry.json').read_bytes()
    assert game_payload.payload_file(SID, 'n0-a1.000', 'skyao_probe.bin', '/v')[0] == b'\x01\x02'
    assert game_payload.payload_file(SID, 'n0-a1.000', 'manifest.json', '/v') is None     # 不在表里


# ─────────────────────────────────────────────────────────── serve 路由

@pytest.fixture
def served(sandbox, monkeypatch):
    _make_workdir(sandbox, True)
    monkeypatch.setattr(serve, 'SCENES_RT', sandbox / 'public' / 'resources' / 'runtime' / 'scenes')
    srv = ThreadingHTTPServer(('127.0.0.1', 0), serve.H)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    yield f'http://127.0.0.1:{srv.server_address[1]}'
    srv.shutdown()
    srv.server_close()


def _get(url: str) -> tuple[int, bytes]:
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def test_serve_虚拟目录路由(served):
    from urllib.parse import quote
    base = f'{served}/api/game_payload/{quote(SID)}/n0-a1.000'
    st, body = _get(f'{base}/lighting.json')
    assert st == 200 and json.loads(body)['version'] == 3
    st, body = _get(f'{base}/depth.json')
    assert st == 200 and json.loads(body)['depth_map'] == f'/api/game_payload/{quote(SID)}/n0-a1.000/raw_depth_rg.png'
    assert _get(f'{base}/nope.bin')[0] == 404
    assert _get(f'{served}/api/game_payload/{quote(SID)}/n9-a1/lighting.json')[0] == 400
    assert _get(f'{served}/api/game_payload/%2E%2E/n0-a1.000/lighting.json')[0] == 404
    assert _get(f'{served}/api/game_payload/{quote(SID)}/n0-a1.000')[0] == 404


def test_serve_运行时场景目录_只读转发字面路径(served, sandbox):
    from urllib.parse import quote
    st, body = _get(f'{served}/resources/runtime/scenes/{quote(SID)}/background.png')
    assert st == 200 and body == (sandbox / 'public' / 'resources' / 'runtime' / 'scenes' / SID / 'background.png').read_bytes()
    assert serve.runtime_scene_file(f'/resources/runtime/scenes/{SID}/../../x.png') is None
    assert serve.runtime_scene_file(f'/resources/runtime/scenes/{SID}/a.exe') is None
    assert serve.runtime_scene_file('/resources/runtime/scenes/x.png') is None
    assert _get(f'{served}/resources/runtime/scenes/{quote(SID)}/missing.png')[0] == 404


def test_serve_GLSL_路由已删_包路由在(served):
    assert _get(f'{served}/api/char_shade_core.js')[0] == 404
    assert _get(f'{served}/favicon.ico')[0] == 204
    assert _get(f'{served}/viewer/_gen/charlab.bundle.js')[0] == 404
