"""场景装载与伪世界几何重建(只读工程文件,不写任何东西)。

数据契约(与运行时同源,勿另立口径):
- 背景图   public/resources/runtime/scenes/<id>/<backgrounds[0].image>
- 深度图   raw_depth_rg.png:RG16,raw16 = R*256 + G,
           d = t*scale + offset,t = raw16/65535(depth_mapping.invert 时 t 取 1-t)
- 世界重建 q = ((sx-cx)/ppu, (cy-sy)/ppu, d),world = R @ q
           (det=+1 游戏约定;与 src/rendering/EntityShadow.ts 的 isCollisionAt 同式)
- 没有 depthConfig 的场景仍可装载:geo 为 None,重打光核心退化为纯调色+发光。
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

ROOT = Path(__file__).resolve().parents[2]
SCENES_JSON = ROOT / 'public' / 'assets' / 'scenes'
SCENES_RT = ROOT / 'public' / 'resources' / 'runtime' / 'scenes'
OUT = Path(__file__).resolve().parent / 'out'


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    """sRGB EOTF(与 character_lighting_lab.pipeline 同式)。x∈[0,1]。"""
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)


def linear_to_srgb(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055).astype(np.float32)


def resize_f(a: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """float32 单通道图重采样(PIL F 模式双线性),size=(w,h)。"""
    return np.asarray(Image.fromarray(a, mode='F').resize(size, Image.BILINEAR), np.float32)


def resize_rgb(a: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """float32 RGB(0..1)重采样。"""
    u8 = a if a.dtype == np.uint8 else np.round(np.clip(a, 0, 1) * 255).astype(np.uint8)
    r = np.asarray(Image.fromarray(u8).resize(size, Image.BILINEAR), np.float32) / 255.0
    return r


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
    """扫工程全部场景(身份=场景 JSON 文件名,与 character_lighting_lab 同口径)。"""
    out = []
    for j in sorted(SCENES_JSON.glob('*.json')):
        try:
            data = json.loads(j.read_text(encoding='utf-8'))
        except Exception:                          # noqa: BLE001 — 坏 JSON 不拖垮清单
            continue
        sid = j.stem
        bgs = data.get('backgrounds') or []
        bg_name = (bgs[0].get('image') if bgs and isinstance(bgs[0], dict) else None) or 'background.png'
        bg = SCENES_RT / sid / bg_name
        cfg = data.get('depthConfig') or {}
        depth_ok = bool(cfg) and (SCENES_RT / sid / cfg.get('depth_map', 'raw_depth_rg.png')).exists()
        variants = sorted(p.name for p in (SCENES_RT / sid).glob('background_relight_*.png')) \
            if (SCENES_RT / sid).is_dir() else []
        out.append({
            'id': sid,
            'name': data.get('name') or sid,
            'bg': bg_name,
            'bg_ok': bg.exists(),
            'depth': depth_ok,
            'mask': (OUT / sid / 'emissive_mask.png').exists(),
            'variants': variants,
        })
    return out


class Scene:
    """一个场景的重打光输入:背景 + (可选)伪世界几何。全部惰性缓存按分辨率取。"""

    def __init__(self, sid: str):
        self.sid = sid
        p = scene_paths(sid)
        if not p['bg'].exists():
            raise FileNotFoundError(f'场景 {sid} 背景图不存在: {p["bg"]}')
        img = Image.open(p['bg']).convert('RGB')
        self.native = img.size                       # (w, h)
        self.bg_srgb = np.asarray(img, np.float32) / 255.0
        self.rt_dir = p['rt_dir']
        self.bg_name = p['bg_name']

        cfg = p['depth_cfg']
        self.depth_native = None
        self.cfg = None
        if cfg:
            dp = p['rt_dir'] / cfg.get('depth_map', 'raw_depth_rg.png')
            if dp.exists():
                rg = np.asarray(Image.open(dp).convert('RGB'), np.uint16)
                raw = rg[..., 0] * 256 + rg[..., 1]
                t = raw.astype(np.float32) / 65535.0
                dm = cfg.get('depth_mapping') or {}
                if dm.get('invert'):
                    t = 1.0 - t
                d = t * float(dm.get('scale', 1.0)) + float(dm.get('offset', 0.0))
                # 深度图与背景图原则上同尺寸;不同就重采样对齐背景
                if d.shape[::-1] != self.native:
                    d = resize_f(d, self.native)
                self.depth_native = d
                m = cfg['M']
                self.cfg = {
                    'R': np.asarray(m['R'], np.float32),
                    'ppu': float(m['ppu']), 'cx': float(m['cx']), 'cy': float(m['cy']),
                }
        self._geo_cache: dict[tuple[int, int], dict] = {}

    # ---------------------------------------------------------------- mask
    def emissive_mask(self, size: tuple[int, int]) -> np.ndarray | None:
        """手绘发光 mask(out/<sid>/emissive_mask.png,白=发光),缺省 None。"""
        f = OUT / self.sid / 'emissive_mask.png'
        if not f.exists():
            return None
        m = np.asarray(Image.open(f).convert('L'), np.float32) / 255.0
        if m.shape[::-1] != size:
            m = resize_f(m, size)
        return m

    # ---------------------------------------------------------- 烘好的几何场
    def baked_skyvis(self, size: tuple[int, int]) -> np.ndarray | None:
        """烘好的逐像素天穹可见性(`lighting2/skyvis.png`),缺则 None。

        ★ **工具预览优先用它,不要现算**——运行时消费的就是这张图。现算的话
        `sky_field` 的高斯半径随预览宽度变,而烘的是固定 512 宽,两边模糊程度不同,
        工具里调好的效果进游戏会略微不一样(实测逐像素平均差 1.19/255)。
        用同一张图 ⇒ parity 是**构造性**的,不是碰巧对上的。
        """
        f = self.rt_dir / 'lighting2' / 'skyvis.png'
        if not f.exists():
            return None
        m = np.asarray(Image.open(f).convert('L'), np.float32) / 255.0
        if m.shape[::-1] != size:
            m = resize_f(m, size)
        return m

    # ------------------------------------------------------------- geometry
    def geometry(self, size: tuple[int, int], normal_sigma: float = 2.0) -> dict | None:
        """按目标分辨率重建伪世界几何:pos/normal/depth。无深度场景返回 None。

        normal_sigma 是**该分辨率下**的法线平滑(px);几何缓存按 (w,h) 存,
        同尺寸重复调用零成本(normal_sigma 首次生效)。
        """
        if self.depth_native is None:
            return None
        key = size
        hit = self._geo_cache.get(key)
        if hit is not None:
            return hit
        w, h = size
        nw, nh = self.native
        d = resize_f(self.depth_native, size) if size != self.native else self.depth_native
        cfg = self.cfg
        R = cfg['R']
        # 目标分辨率下的等效标定(按横向缩放;纵横比与原图一致)
        s = w / nw
        ppu = cfg['ppu'] * s
        cx = cfg['cx'] * s
        cy = cfg['cy'] * s
        px = np.arange(w, dtype=np.float32)[None, :].repeat(h, 0)
        py = np.arange(h, dtype=np.float32)[:, None].repeat(w, 1)
        qx = (px - cx) / ppu
        qy = (cy - py) / ppu
        q = np.stack([qx, qy, d], -1)                      # (h,w,3)
        pos = q @ R.T                                       # world = R @ q
        # 法线:平滑后的世界位置梯度叉积;朝相机一侧(view = R@(0,0,1) 指向更深)
        ps = gaussian_filter(pos, sigma=(normal_sigma, normal_sigma, 0))
        dx = np.gradient(ps, axis=1)
        dy = np.gradient(ps, axis=0)
        n = np.cross(dy, dx)
        view = R @ np.array([0, 0, 1], np.float32)          # 朝场景深处
        flip = (n @ view) > 0
        n[flip] *= -1.0
        ln = np.linalg.norm(n, axis=-1, keepdims=True)
        n = n / np.maximum(ln, 1e-6)
        geo = {
            'depth': d, 'pos': pos, 'normal': n.astype(np.float32),
            'R': R, 'ppu': ppu, 'cx': cx, 'cy': cy,
            'd_range': (float(d.min()), float(d.max())),
        }
        self._geo_cache[key] = geo
        return geo
