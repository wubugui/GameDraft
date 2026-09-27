"""查看器的数据入口:把**本机工作台**(`out/<场景>/<背景基名>/`)按**游戏载荷格式**现场变换出来,不落盘。

为什么有这一层(2026-09-28 查看器迁到 RHI):查看器的 2D 受光预览改用**游戏自己的**角色受光模块画
(`CharacterLightingSystem` + `CharacterLitSprite` 的 WGSL + `DepthOcclusionFilter`),不再拼一份 GLSL。
游戏模块只认**导出后**的载荷格式(v3:固化 E 的单块图集、Z 切片平铺的体素卷、RG16 行走面 / 深度图),
而查看器看的是**还没导出**的工作台(四分账 probe、3D 体素卷、float 深度)。所以这里按导出的同一套式子
把工作台现场变成「导出了会是什么样」,serve 在 `/api/game_payload/<场景>/<合成参数>/<文件>` 上吐给页面,
页面把这个目录当烘焙目录交给游戏的装载器(`CharacterLightingSystem.load(…, bakeDirOverride)`)。

**不改烘焙 / 导出**:合成式直接调 `pipeline.compose_atlas`、行走面编码调 `terrain_compose.encode_ground`、
重采样调 `pipeline.resize_f`;导出函数里内联的那几段(体素卷平铺、depthConfig 的 R / 深度映射)在这里照抄,
由 `tests/test_game_payload.py` 在沙箱里跑一遍真导出、逐字节对照钉住。

与真导出的差别(都写在报告里,不是 bug):
- 行走面不叠地形工作台的高度修补(`terrain_compose.export_ground` 那一步要读已导出的载荷目录);
- `geometry.json` / `skyao_probe.bin` 是**已导出**那份的原样转发(几何场只有 `scene_fields` 能烘,查看器不重烘);
- depthConfig 里的深度图地址是本服务的虚拟地址。
"""
from __future__ import annotations

import io
import json
import math
import threading
from pathlib import Path

import numpy as np
from PIL import Image

from tools.character_lighting_lab import pipeline

#: 本服务吐给页面的虚拟载荷文件(其余一律 404)
PAYLOAD_FILES = (
    'lighting.json', 'atlas_l1.bin', 'atlas_l2.bin', 'atlas_bin.bin', 'probes_valid.bin',
    'vol_rad.bin', 'vol_emit.bin', 'ground_d.png', 'raw_depth_rg.png', 'depth.json',
    'geometry.json', 'skyao_probe.bin',
)
#: 已导出载荷原样转发的两份(几何场侧的产物)
PASSTHROUGH = ('geometry.json', 'skyao_probe.bin')

_lock = threading.Lock()
_cache: dict[tuple, bytes] = {}
_CACHE_MAX = 24


def compose_key(nee: bool, amb: float) -> str:
    """合成参数 → 路径段(`n0-a1.000`)。只有这两个固化进图集(见 pipeline.BAKED_INTO_ATLAS 的 nee/amb;
    miss_mode 导出时按 0 近似,运行时 RT 另读)。"""
    return f'n{1 if nee else 0}-a{float(amb):.3f}'


def parse_compose(seg: str) -> tuple[bool, float]:
    """`n0-a1.000` → (nee, amb);不认识就抛 ValueError。"""
    parts = seg.split('-')
    if len(parts) != 2 or not parts[0].startswith('n') or not parts[1].startswith('a'):
        raise ValueError(f'合成参数段不认识: {seg!r}')
    nee = parts[0][1:]
    if nee not in ('0', '1'):
        raise ValueError(f'nee 只能是 0/1: {seg!r}')
    amb = float(parts[1][1:])
    if not (math.isfinite(amb) and 0.0 <= amb <= 16.0):
        raise ValueError(f'amb 超范围: {seg!r}')
    return nee == '1', amb


def _stat_sig(*paths: Path) -> tuple:
    out = []
    for p in paths:
        try:
            st = p.stat()
            out.append((str(p), st.st_mtime_ns, st.st_size))
        except OSError:
            out.append((str(p), 0, -1))
    return tuple(out)


def _cached(key: tuple, make) -> bytes:
    with _lock:
        hit = _cache.get(key)
    if hit is not None:
        return hit
    data = make()
    with _lock:
        if len(_cache) >= _CACHE_MAX:
            _cache.pop(next(iter(_cache)))
        _cache[key] = data
    return data


def _png(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def _manifest(wd: Path) -> dict:
    return json.loads((wd / 'manifest.json').read_text(encoding='utf-8'))


def _scene_json(sid: str) -> dict:
    f = pipeline.ROOT / 'public' / 'assets' / 'scenes' / f'{sid}.json'
    try:
        return json.loads(f.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def game_background(sid: str) -> Path:
    return pipeline.ROOT / 'public' / 'resources' / 'runtime' / 'scenes' / sid / pipeline.scene_background(sid)


def exported_dir(sid: str) -> Path:
    """已导出载荷目录(几何场转发用):`runtime/scenes/<id>/lighting/<背景基名>/`。"""
    return (pipeline.ROOT / 'public' / 'resources' / 'runtime' / 'scenes' / sid / 'lighting'
            / pipeline._bake_key(pipeline.scene_background(sid)))


def background_sha1(sid: str, wd: Path, man: dict) -> str:
    """与 export_runtime 同一判据:游戏背景与实验室副本**像素**相同 → 盖游戏文件的哈希;否则盖工作台的哈希
    (运行时对上游戏背景会判「过期」——那正是真相:工作台是按旧画烘的)。"""
    game_bg = game_background(sid)
    lab_bg = wd / 'background.png'
    if not game_bg.exists() or not lab_bg.exists():
        return str(man['hash'])

    def make() -> bytes:
        a = np.asarray(Image.open(game_bg).convert('RGB'))
        b = np.asarray(Image.open(lab_bg).convert('RGB'))
        same = a.shape == b.shape and np.array_equal(a, b)
        return (pipeline.img_hash(game_bg) if same else str(man['hash'])).encode('ascii')

    return _cached(('bgsha', _stat_sig(game_bg, lab_bg), str(man['hash'])), make).decode('ascii')


def _read_probe(wd: Path, stem: str, pn: int, k: int, ch: int) -> np.ndarray:
    raw = np.frombuffer((wd / f'probes_{stem}.bin').read_bytes(), np.float16)
    return raw.reshape(pn, k, ch)


def _atlas(wd: Path, man: dict, slot: str, nee: bool, amb: float) -> bytes:
    """与 export_runtime._atlas4 同式(直接调 pipeline.compose_atlas)。slot:l1 / l2 / bins。"""
    P = man['probes']
    pn = int(P['nx']) * int(P['ny']) * int(P['nz'])
    k = 4 if slot == 'l1' else int(P.get('sh_k', 9)) if slot == 'l2' else 64
    out = pipeline.compose_atlas(_read_probe(wd, slot, pn, k, 4)[:, :, :3],
                                 _read_probe(wd, f'{slot}emit', pn, k, 3),
                                 _read_probe(wd, f'{slot}nee', pn, k, 3),
                                 _read_probe(wd, f'{slot}amb', pn, k, 3),
                                 nee_on=nee, amb_w=amb)
    return out.tobytes()


def _tiles(nz: int) -> tuple[int, int]:
    tx = int(math.ceil(math.sqrt(nz)))
    return tx, int(math.ceil(nz / tx))


def _tile_volume(wd: Path, man: dict, fname: str) -> bytes:
    """与 export_runtime._tile_volume 同式:Z 切片横向平铺成 2D 图集(行=y 列=x)。"""
    V = man['vol']
    nx, ny, nz = int(V['Nx']), int(V['Ny']), int(V['Nz'])
    tx, ty = _tiles(nz)
    vol = np.frombuffer((wd / fname).read_bytes(), np.float16).reshape(nz, ny, nx, 4)
    atlas = np.zeros((ty * ny, tx * nx, 4), np.float16)
    for z in range(nz):
        r, c = divmod(z, tx)
        atlas[r * ny:(r + 1) * ny, c * nx:(c + 1) * nx] = vol[z]
    return atlas.tobytes()


def _ground(wd: Path, man: dict) -> tuple[bytes, float, float]:
    from tools.character_lighting_lab import terrain_compose as tc
    w, h = int(man['work']['w']), int(man['work']['h'])
    path = wd / 'walk_depth.bin'

    def make() -> bytes:
        d = np.frombuffer(path.read_bytes(), np.float32).reshape(h, w)
        png, lo, hi = tc.encode_ground(d)
        return json.dumps({'lo': lo, 'hi': hi}).encode('utf-8') + b'\n' + png

    blob = _cached(('ground', _stat_sig(path)), make)
    head, png = blob.split(b'\n', 1)
    rng = json.loads(head)
    return png, float(rng['lo']), float(rng['hi'])


def depth_config(sid: str, wd: Path, man: dict, depth_url: str) -> tuple[dict, bytes]:
    """「导出深度」会写进场景 JSON 的 depthConfig + 原生分辨率 RG16 深度图(与 export_scene_depth 同式),
    外加 `depth_map` 指向本服务的虚拟地址。"""
    W, Hh = int(man['work']['w']), int(man['work']['h'])
    nw, nh = int(man['native']['w']), int(man['native']['h'])
    theta = float(man['cal']['theta'])
    ppu_nat = float(man['cal']['ppu']) * (nw / W)
    path = wd / 'front_depth.bin'

    def make() -> bytes:
        d = np.frombuffer(path.read_bytes(), np.float32).reshape(Hh, W)
        d_nat = pipeline.resize_f(d, (nw, nh))
        lo = float(d_nat.min()) - 1e-4
        hi = float(d_nat.max()) + 1e-4
        raw16 = np.round((d_nat - lo) / (hi - lo) * 65535).astype(np.uint16)
        rg = np.zeros((nh, nw, 3), np.uint8)
        rg[..., 0] = raw16 >> 8
        rg[..., 1] = raw16 & 0xFF
        return json.dumps({'lo': lo, 'hi': hi}).encode('utf-8') + b'\n' + _png(rg)

    blob = _cached(('depth', _stat_sig(path), nw, nh), make)
    head, png = blob.split(b'\n', 1)
    rng = json.loads(head)
    c, s = math.cos(theta), math.sin(theta)
    R = np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])
    az = math.radians(float(man['params'].get('azimuth_deg', 0.0)))
    if abs(az) > 1e-9:
        ca, sa = math.cos(az), math.sin(az)
        R = np.array([[ca, 0, sa], [0, 1, 0], [-sa, 0, ca]]) @ R
    old = (_scene_json(sid).get('depthConfig') or {})
    cfg = {
        'depth_map': depth_url,
        'M': {'R': [[float(v) for v in row] for row in R], 'ppu': ppu_nat, 'cx': nw / 2.0, 'cy': nh / 2.0},
        'depth_mapping': {'invert': False, 'scale': rng['hi'] - rng['lo'], 'offset': rng['lo']},
        'shader': {'depth_per_sy': math.tan(theta) / ppu_nat},
        'depth_tolerance': float(old.get('depth_tolerance', 0.05)),
        'floor_offset': float(old.get('floor_offset', 0.0)),
    }
    return cfg, png


def lighting_meta(sid: str, wd: Path, man: dict, nee: bool, amb: float) -> dict:
    """与 export_runtime 写的 lighting.json 同形(v3)。shading 只带固化进图集的 nee / amb(其余取缺省;
    页面逐帧用面板值覆盖运行时参数)。"""
    V = man['vol']
    nx, ny, nz = int(V['Nx']), int(V['Ny']), int(V['Nz'])
    tx, ty = _tiles(nz)
    P = man['probes']
    _png_bytes, lo, hi = _ground(wd, man)
    return dict(
        version=3,
        background_sha1=background_sha1(sid, wd, man),
        work=man['work'], cal=man['cal'], world=man['world'],
        probes={k: P[k] for k in ('nx', 'ny', 'nz')},
        vol=dict(nx=nx, ny=ny, nz=nz, tiles_x=tx, tiles_y=ty,
                 qx_min=V['qx_min'], qx_max=V['qx_max'],
                 qy_min=V['qy_min'], qy_max=V['qy_max'],
                 qz_min=V['qz_min'], qz_max=V['qz_max']),
        ambient_sh=man['ambient']['sh'],
        lights=man.get('lights', []),
        ground_d=dict(min=lo, max=hi),
        shading=pipeline._normalize_shading({'nee': 1 if nee else 0, 'amb': amb}),
        baked_params=man['params'],
        built=man['built'],
    )


def payload_file(sid: str, compose: str, name: str, base_url: str) -> tuple[bytes, str] | None:
    """(字节, Content-Type);场景没工作台 / 文件不在表里 / 转发件不存在 → None(404)。

    `base_url` = 这个虚拟目录自己的 URL(depthConfig.depth_map 要指回来)。"""
    if name not in PAYLOAD_FILES:
        return None
    nee, amb = parse_compose(compose)
    wd = pipeline.work_dir(sid)
    if not (wd / 'manifest.json').exists():
        return None
    man = _manifest(wd)
    if name in PASSTHROUGH:
        f = exported_dir(sid) / name
        if not f.is_file():
            return None
        return f.read_bytes(), 'application/json' if name.endswith('.json') else 'application/octet-stream'
    if name == 'lighting.json':
        body = json.dumps(lighting_meta(sid, wd, man, nee, amb), ensure_ascii=False, indent=1) + '\n'
        return body.encode('utf-8'), 'application/json; charset=utf-8'
    if name == 'depth.json':
        cfg, _ = depth_config(sid, wd, man, f'{base_url}/raw_depth_rg.png')
        return json.dumps(cfg, ensure_ascii=False).encode('utf-8'), 'application/json; charset=utf-8'
    if name == 'raw_depth_rg.png':
        return depth_config(sid, wd, man, '')[1], 'image/png'
    if name == 'ground_d.png':
        return _ground(wd, man)[0], 'image/png'
    if name == 'probes_valid.bin':
        return (wd / 'probes_valid.bin').read_bytes(), 'application/octet-stream'
    if name in ('vol_rad.bin', 'vol_emit.bin'):
        src = 'volume.bin' if name == 'vol_rad.bin' else 'volume_emit.bin'
        data = _cached(('vol', _stat_sig(wd / src)), lambda: _tile_volume(wd, man, src))
        return data, 'application/octet-stream'
    slot = {'atlas_l1.bin': 'l1', 'atlas_l2.bin': 'l2', 'atlas_bin.bin': 'bins'}[name]
    srcs = [wd / f'probes_{slot}{s}.bin' for s in ('', 'emit', 'nee', 'amb')]
    data = _cached(('atlas', slot, nee, round(amb, 6), _stat_sig(*srcs)), lambda: _atlas(wd, man, slot, nee, amb))
    return data, 'application/octet-stream'
