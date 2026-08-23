"""场景装载与伪世界几何重建（只读工程文件，不写任何东西）。

数据契约（与运行时同源，勿另立口径）：
- 背景图 `public/resources/runtime/scenes/<sid>/<backgrounds[0].image>`
- 深度图 `raw_depth_rg.png`：RG16 打包，`raw16 = R*256 + G`，`d = t*scale + offset`
- 世界重建 `q = ((sx-cx)/ppu, (cy-sy)/ppu, d)`，`world = q @ Rᵀ`（R 正交 ⇒ 转置即逆）
- 法线用 `edge_safe_normals`（不跨深度断崖），全值域世界法线

★ 唯一的外部依赖面：别的模块不许直接碰 `tools/scene_relight`。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

from . import const
from .encode import resize_f

ROOT = Path(__file__).resolve().parents[2]
SCENES_JSON = ROOT / 'public' / 'assets' / 'scenes'
SCENES_RT = ROOT / 'public' / 'resources' / 'runtime' / 'scenes'

#: 角色在场景坐标里固定的身高（wu 的刻度链起点）。
DEFAULT_CHAR_SCENE_H = 150.0


@dataclass
class SceneInput:
    sid: str
    native: tuple[int, int]       # (w, h) 原画原生分辨率
    work: tuple[int, int]         # (w, h) 工作分辨率
    bg_srgb: np.ndarray           # (h,w,3) 原生分辨率 sRGB 0..1
    depth: np.ndarray             # (h,w) work 分辨率
    world: np.ndarray             # (h,w,3) work，世界坐标
    normal: np.ndarray            # (h,w,3) work，全值域世界法线，edge-safe
    q: np.ndarray                 # (h,w,3) work，q 空间（屏幕对齐 + 深度）
    R: np.ndarray                 # 3×3 正交
    ppu: float
    cx: float
    cy: float
    char_wu: float
    band: float
    scene_per_wu: float
    depth_native: np.ndarray = field(default=None)  # (h,w) 原生深度


def scene_paths(sid: str) -> dict:
    j = SCENES_JSON / f'{sid}.json'
    data = json.loads(j.read_text(encoding='utf-8'))
    bgs = data.get('backgrounds') or []
    bg_name = (bgs[0].get('image') if bgs and isinstance(bgs[0], dict) else None) or 'background.png'
    return {
        'json': j, 'data': data,
        'bg': SCENES_RT / sid / bg_name, 'bg_name': bg_name,
        'rt_dir': SCENES_RT / sid,
        'depth_cfg': data.get('depthConfig'),
    }


def list_scenes() -> list[dict]:
    """扫工程全部场景（身份 = 场景 JSON 文件名，与 character_lighting_lab 同口径）。"""
    out = []
    for j in sorted(SCENES_JSON.glob('*.json')):
        try:
            data = json.loads(j.read_text(encoding='utf-8'))
        except Exception:                                  # noqa: BLE001
            continue
        sid = j.stem
        bgs = data.get('backgrounds') or []
        bg_name = (bgs[0].get('image') if bgs and isinstance(bgs[0], dict) else None) or 'background.png'
        bg = SCENES_RT / sid / bg_name
        cfg = data.get('depthConfig') or {}
        depth_ok = bool(cfg) and (SCENES_RT / sid / cfg.get('depth_map', 'raw_depth_rg.png')).exists()
        out.append({'id': sid, 'name': data.get('name') or sid, 'bg': bg_name,
                    'bg_ok': bg.exists(), 'depth': depth_ok})
    return out


def edge_safe_normals(world: np.ndarray, R: np.ndarray) -> np.ndarray:
    """伪世界高度场的法线，**不跨深度断层**。

    中心差分会横跨前景/背景的深度断崖，把每一条剪影都变成一圈假倒角。这里前向与
    后向切线**都指向图像轴正方向**，取更短的那条：只要有一侧还落在同一个可见表面
    上，导数就留在那个面上。

    全值域世界法线（`n = tex*2-1` 的编码源）。
    """
    fx = np.roll(world, -1, axis=1) - world
    bx = world - np.roll(world, 1, axis=1)
    use_fx = np.linalg.norm(fx, axis=-1) <= np.linalg.norm(bx, axis=-1)
    dx = np.where(use_fx[..., None], fx, bx)
    dx[:, 0] = fx[:, 0]
    dx[:, -1] = bx[:, -1]

    fy = np.roll(world, -1, axis=0) - world
    by = world - np.roll(world, 1, axis=0)
    use_fy = np.linalg.norm(fy, axis=-1) <= np.linalg.norm(by, axis=-1)
    dy = np.where(use_fy[..., None], fy, by)
    dy[0] = fy[0]
    dy[-1] = by[-1]

    n = np.cross(dx, dy)
    n /= np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-8)
    # 朝相机一侧：相机看向 +z（q 空间），世界里是 R 的第三列
    facing = -R[:, 2]
    flip = (n @ facing) < 0
    n[flip] *= -1.0
    return n.astype(np.float32)


def character_band_wu(data: dict, native_w: int, ppu_native: float) -> dict:
    """角色在这张画里占多少 wu，以及据此推出的可达高度带。

    刻度链：场景坐标 --(native_w/worldWidth)--> 背景像素 --(1/ppu)--> 世界单位。
    `char_wu` 只反映取景远近（角色固定 150 场景坐标高，worldWidth 逐场景 700–4000）。
    """
    world_w = float(data.get('worldWidth') or 0.0)
    if world_w <= 0 or ppu_native <= 0:
        raise RuntimeError('缺 worldWidth 或 depthConfig.M.ppu，无法推角色刻度')
    scene_per_wu = world_w / (native_w / ppu_native)
    char_wu = DEFAULT_CHAR_SCENE_H / scene_per_wu
    return {'char_wu': char_wu, 'scene_per_wu': scene_per_wu,
            'band': char_wu * 1.15}   # 头顶留一点余量


def load(sid: str, work_w: int = const.WORK_W) -> SceneInput:
    """从工程读入一个场景的烘焙输入。无深度场景抛 RuntimeError。"""
    p = scene_paths(sid)
    if not p['bg'].exists():
        raise FileNotFoundError(f'场景 {sid} 背景图不存在: {p["bg"]}')
    img = Image.open(p['bg']).convert('RGB')
    native = img.size                       # (w, h)
    bg_srgb = np.asarray(img, np.float32) / 255.0
    cfg = p['depth_cfg']
    if not cfg:
        raise RuntimeError(f'{sid}: 没有 depthConfig / 深度图，无法烘 G-buffer')
    dp = p['rt_dir'] / cfg.get('depth_map', 'raw_depth_rg.png')
    if not dp.exists():
        raise RuntimeError(f'{sid}: 深度图不存在 {dp}')

    # §3.2 深度解码（逐字照抄，不许改）
    rg = np.asarray(Image.open(dp).convert('RGB'), np.uint16)
    raw = rg[..., 0] * 256 + rg[..., 1]
    t = raw.astype(np.float32) / 65535.0
    dm = cfg.get('depth_mapping') or {}
    if dm.get('invert'):
        t = 1.0 - t
    d_native = t * float(dm.get('scale', 1.0)) + float(dm.get('offset', 0.0))
    if d_native.shape[::-1] != native:
        d_native = resize_f(d_native, native)

    m = cfg['M']
    R = np.asarray(m['R'], np.float32)
    ppu_native = float(m['ppu'])
    cx_native = float(m['cx'])
    cy_native = float(m['cy'])

    nw, nh = native
    w = min(work_w, nw)
    h = max(1, round(nh * w / nw))
    s = w / nw
    ppu = ppu_native * s
    cx = cx_native * s
    cy = cy_native * s

    depth = resize_f(d_native, (w, h)) if (w, h) != native else d_native

    px = np.arange(w, dtype=np.float32)[None, :].repeat(h, 0)
    py = np.arange(h, dtype=np.float32)[:, None].repeat(w, 1)
    qx = (px - cx) / ppu
    qy = (cy - py) / ppu
    q = np.stack([qx, qy, depth], -1).astype(np.float32)
    world = (q @ R.T).astype(np.float32)
    normal = edge_safe_normals(world, R)

    band = character_band_wu(p['data'], nw, ppu_native)

    return SceneInput(
        sid=sid, native=native, work=(w, h), bg_srgb=bg_srgb,
        depth=depth, world=world, normal=normal, q=q,
        R=R, ppu=ppu, cx=cx, cy=cy,
        char_wu=band['char_wu'], band=band['band'], scene_per_wu=band['scene_per_wu'],
        depth_native=d_native,
    )
