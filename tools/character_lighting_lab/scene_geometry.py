"""场景伪世界几何:装载 + 重建 + 天穹 march(只读工程文件,不写任何东西)。

本模块是**几何的单一真相源**——实验室的几何场烘焙(`scene_fields.py`)与
场景重打光工具(`tools/scene_relight`)都从这里取,不许各自再实现一遍。
2026-08-31 之前它住在 `tools/scene_relight/geometry.py`,而那条链其实是
**下游**:深度与标定本来就是本实验室导出的,几何却在另一个工具里重建了一遍。

数据契约(与运行时同源,勿另立口径):

- 背景图   ``public/resources/runtime/scenes/<id>/<backgrounds[0].image>``
- 深度图   ``raw_depth_rg.png``:RG16,raw16 = R*256 + G,
           d = t*scale + offset,t = raw16/65535(``depth_mapping.invert`` 时 t 取 1-t)
- 世界重建 q = ((sx-cx)/ppu, (cy-sy)/ppu, d),world = R @ q
           (**det=+1 游戏约定**;与 ``src/rendering/EntityShadow.ts`` 的 isCollisionAt 同式)

⚠ **必须读 ``raw_depth_rg.png``,不许改用 ``front_depth.bin``。**
本实验室内部那份 float32 深度精度更高,但**运行时 march 的是量化后的 RG16**;
拿未量化的源去烘法线/天穹可见性,烘出来的场就与运行时实际用的深度对不上
——而这两张图存在的全部意义就是与运行时那份深度一致。硬约束,不是保守。

⚠ **两个 M 不许混**(见 ``agent_docs/runtime/mechanisms/coordinate-spaces.md``):
本模块一律用场景 JSON ``depthConfig.M.R``(**det=+1**,着色/游戏约定);
实验室内部 probe/体素那套用的是 ``lighting.json`` 的 det=-1 矩阵,**只给查表用**。
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

ROOT = Path(__file__).resolve().parents[2]
SCENES_JSON = ROOT / 'public' / 'assets' / 'scenes'
SCENES_RT = ROOT / 'public' / 'resources' / 'runtime' / 'scenes'


def srgb_to_linear(x: np.ndarray) -> np.ndarray:
    """sRGB EOTF(与 ``pipeline.srgb_to_linear`` 同式)。x in [0,1]。"""
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
    return np.asarray(Image.fromarray(u8).resize(size, Image.BILINEAR), np.float32) / 255.0


def bake_key(image: str) -> str:
    """背景图名 -> 烘焙目录名(去扩展名的基名)。

    与运行时 ``projectPaths.bakeKeyFromBackground`` 和 ``pipeline._bake_key``
    **同一口径**:一张背景图一套烘焙产物,换时段背景就换一套。
    """
    base = image.replace('\\', '/').rsplit('/', 1)[-1]
    dot = base.rfind('.')
    key = base[:dot] if dot > 0 else base
    if not key:
        raise ValueError('取不出烘焙目录名: %r' % (image,))
    return key


def scene_backgrounds(sid: str) -> list[str]:
    """这个场景**全部时段**的第一层背景图名(去重、保序):顶层 + 各 timeVariants。

    几何场按背景图名分目录,所以这张表就是"要烘几套"的清单。
    ⚠ 只有开了 `dayNight.enabled` 的场景才算时段变体 —— 与运行时
    `sceneAppearance.resolveSceneAppearance` 同口径(没开日夜时变体不生效,
    烘了也没人读)。
    """
    data = scene_paths(sid)['data']
    out = [scene_paths(sid)['bg_name']]
    if (data.get('dayNight') or {}).get('enabled'):
        for v in (data.get('timeVariants') or {}).values():
            bgs = (v or {}).get('backgrounds') or []
            img = bgs[0].get('image') if bgs and isinstance(bgs[0], dict) else None
            if isinstance(img, str) and img.strip() and img not in out:
                out.append(img)
    return out


def scene_paths(sid: str) -> dict:
    j = SCENES_JSON / ('%s.json' % sid)
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
    """扫工程全部场景(身份 = 场景 JSON 文件名)。只报几何相关的状态。"""
    out = []
    for j in sorted(SCENES_JSON.glob('*.json')):
        try:
            data = json.loads(j.read_text(encoding='utf-8'))
        except Exception:                          # noqa: BLE001 — 坏 JSON 不拖垮清单
            continue
        sid = j.stem
        bgs = data.get('backgrounds') or []
        bg_name = (bgs[0].get('image') if bgs and isinstance(bgs[0], dict) else None) or 'background.png'
        cfg = data.get('depthConfig') or {}
        depth_ok = bool(cfg) and (SCENES_RT / sid / cfg.get('depth_map', 'raw_depth_rg.png')).exists()
        out.append({
            'id': sid,
            'name': data.get('name') or sid,
            'bg': bg_name,
            'bg_ok': (SCENES_RT / sid / bg_name).exists(),
            'depth': depth_ok,
        })
    return out


class Scene:
    """一个场景的几何输入:背景 + (可选)伪世界几何。几何按分辨率惰性缓存。"""

    def __init__(self, sid: str, background: str | None = None):
        """`background` 显式指定用哪张背景图(缺省 = 场景当前生效的第一层)。

        日夜项目里一个场景有多张时段原画(`timeVariants[时段].backgrounds[0]`),
        **每一张都要各烘一套几何场** —— 烘焙产物按背景图名分目录,共用一份
        就是"拿白天的法线去照夜原画"。没有这个参数的话只烘得到当前那张。
        """
        self.sid = sid
        p = scene_paths(sid)
        if background:
            p['bg_name'] = background
            p['bg'] = p['rt_dir'] / background
        if not p['bg'].exists():
            raise FileNotFoundError('场景 %s 背景图不存在: %s' % (sid, p['bg']))
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

    # ------------------------------------------------------------ 烘焙落点
    @property
    def bake_dir(self):
        """本场景**当前背景**的烘焙产物目录 ``lighting/<背景基名>/``。

        2026-08-31 起 probe 载荷与几何场同住这一个目录(原先几何场在 ``lighting2/``)。
        """
        return self.rt_dir / 'lighting' / bake_key(self.bg_name)

    def baked_skyvis(self, size: tuple[int, int]) -> np.ndarray | None:
        """烘好的逐像素天穹可见性(``lighting/<key>/skyvis.png``),缺则 None。

        ★ **工具预览优先用它,不要现算**——运行时消费的就是这张图。现算的话
        ``sky_field`` 的高斯半径随预览宽度变,而烘的是固定 512 宽,两边模糊程度不同,
        工具里调好的效果进游戏会略微不一样(实测逐像素平均差 1.19/255)。
        用同一张图 => parity 是**构造性**的,不是碰巧对上的。
        """
        f = self.bake_dir / 'skyvis.png'
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
        hit = self._geo_cache.get(size)
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
        self._geo_cache[size] = geo
        return geo


# ---------------------------------------------------------------- 天穹 march
def sun_dir(elev_deg: float, azim_deg: float) -> np.ndarray:
    """指向光源的世界方向。azim 0 度 = 光从画面正前(+z 深处)射来,90 度 = 从画面右侧。"""
    e = math.radians(elev_deg)
    a = math.radians(azim_deg)
    return np.array([math.cos(e) * math.sin(a), math.sin(e), math.cos(e) * math.cos(a)],
                    np.float32)


def blocked_along(geo: dict, L: np.ndarray) -> np.ndarray:
    """逐像素:沿**世界方向 L** 看出去被挡了没。返回 bool (h,w)。

    走**唯一 tracer**,射线无限长。定向光(太阳/月亮)的投影用这个。
    """
    from .trace import DepthField, trace
    h, w = geo['depth'].shape
    L = np.asarray(L, np.float32)
    L = L / max(float(np.linalg.norm(L)), 1e-9)
    d = np.ascontiguousarray(np.tile((L @ geo['R']).astype(np.float32), (h * w, 1)))
    res = trace(surface_points_q(geo), d, DepthField.from_geo(geo))
    return (~res.escaped).reshape(h, w)


def blocked_toward(geo: dict, target_q: np.ndarray,
                   near_frac: float = 0.98) -> np.ndarray:
    """逐像素:朝 q 空间某个**点**(灯)看过去被挡了没。返回 bool (h,w)。

    射线照样无限长 —— 「灯背后的东西挡不住这盏灯」是对 `t_hit` 的**事后过滤**,
    写在这里、看得见,不是给 tracer 传射程(tracer 没有射程参数,见 trace.py)。
    """
    from .trace import DepthField, trace
    h, w = geo['depth'].shape
    p = surface_points_q(geo)
    delta = np.asarray(target_q, np.float32)[None, :] - p
    dist = np.linalg.norm(delta, axis=1)
    ok = dist > 1e-6
    out = np.zeros(len(p), bool)
    if not ok.any():
        return out.reshape(h, w)
    dirs = np.ascontiguousarray(delta[ok] / dist[ok, None], np.float32)
    res = trace(np.ascontiguousarray(p[ok]), dirs, DepthField.from_geo(geo))
    out[ok] = (~res.escaped) & (res.t_hit < dist[ok] * near_frac)
    return out.reshape(h, w)


def _removed_march_blocked(*_a, **_k):
    """⛔ 2026-09-01 删除:`march_blocked` —— 定步长、定射程、手写 march 循环。

    制作人铁令「那些旧的固定方向计算方法不要再用了,给我废弃掉,
    只准用蒙特卡洛积分器 tracer 计算结果」。判据(步长 15.5 px / 射程 2.2 wu /
    thickness 2.0 wu)在细结构与远处遮挡上都是错的,见 `trace.py` 的对照表。

    替代:`blocked_along`(定向)/ `blocked_toward`(朝某点)/
    `estimators.sky_moments`(天穹遮蔽)—— 全部走唯一 tracer。
    """
    raise RuntimeError('march_blocked 已废弃;改用 blocked_along / blocked_toward '
                       '/ estimators.sky_moments(全部走 trace.py 的唯一 tracer)')


march_blocked = _removed_march_blocked


# ⛔ 2026-09-01 删除:`SKY_ELEVS` / `SKY_AZIMS` —— 6 方位 x 2 仰角的固定方向组。
# 制作人铁令「那些旧的固定方向计算方法不要再用了,给我废弃掉」。
# 它就是旧实现算错的根源:仰角只有 28/58 度(天顶与地平从不采样)、方位只有 6 个,
# 竖直墙面的求积偏差 -28~-38%,绕方位还有 15.5% 的 6 次对称指纹。
# 天穹遮蔽现在一律走 `estimators.sky_moments`(分层 QMC + 位置哈希 + 唯一 tracer)。

def surface_points_q(geo: dict) -> np.ndarray:
    """逐像素表面点的 q 坐标 (h*w, 3) float32 —— 天穹矩与逐像素 E 的射线起点。

    与 `Scene.geometry()` 内部重建 q 的那三行**同一套标定**,不许另抄。
    """
    h, w = geo['depth'].shape
    ppu, cx, cy = geo['ppu'], geo['cx'], geo['cy']
    px = np.arange(w, dtype=np.float32)[None, :]
    py = np.arange(h, dtype=np.float32)[:, None]
    qx = np.broadcast_to((px - cx) / ppu, (h, w))
    qy = np.broadcast_to((cy - py) / ppu, (h, w))
    return np.ascontiguousarray(
        np.stack([qx, qy, geo['depth']], -1).reshape(-1, 3), np.float32)


def sky_moments_field(geo: dict, spp: int | None = None,
                      denoise: bool = True) -> tuple[np.ndarray, np.ndarray]:
    """逐像素天穹遮蔽矩 (a0 (h,w), a1 (h,w,3))。按分辨率缓存进 geo。

    与 3D 网格版是**同一个估计器**(`estimators.sky_moments`)、同一采样器、
    同一位置哈希种子、同一 spp —— 所以格点恰好落在某表面点上时两边逐位相同。
    这是「角色与场景吃同一个遮蔽场」的**结构**保证,不是两处碰巧调得像。
    (旧实现声称同源,实际逐像素乘 `N.d`、网格乘 `d.y`,根本不是一个量。)
    """
    from .const import MOMENT_SPP
    from .denoise import denoise_rgb, denoise_scalar
    from .estimators import sky_moments
    from .trace import DepthField

    spp = MOMENT_SPP if spp is None else int(spp)
    key = ('sky_moments', spp, bool(denoise))
    hit = geo.get(key)
    if hit is not None:
        return hit
    h, w = geo['depth'].shape
    field = DepthField.from_geo(geo)
    a0, a1 = sky_moments(surface_points_q(geo), geo['R'], field, spp=spp)
    a0 = a0.reshape(h, w)
    a1 = a1.reshape(h, w, 3)
    if denoise:
        # 矩是线性量 => 滤波与求值可交换,先滤矩再求 V 是安全的。
        # 引导用 (normal, depth):遮蔽在法线/深度不连续处本来就该不连续,
        # 联合双边正是为了**不**跨这些边平滑(旧实现的无差别高斯会把墙沿的
        # 遮蔽抹到墙外去)。
        a0 = denoise_scalar(a0, geo['normal'], geo['depth'])
        a1 = denoise_rgb(a1, geo['normal'], geo['depth'])
    geo[key] = (a0, a1)
    return a0, a1


def sky_field(geo: dict, px_scale: float = 1.0, spp: int | None = None,
              denoise: bool = True) -> np.ndarray:
    """写进 `skyvis.png` 的那个标量场:`clamp(a0 + a1.N, 0, 1)`。

    语义与旧实现**一致** —— 「相对开阔平地的余弦加权天穹可见度」:
    开阔地面 = 1.0,朝向的衰减留在里面(运行时 `sDay = (1-hemi)+hemi*skyvis`
    这一侧没有任何单独的朝向项,`day.sunIntensity` 全 28 个场景都是 0,
    归一掉朝向 albedo 反解会整个塌掉)。

    换掉的只是**怎么算**:12 条定向射线的偏置求积 -> 无偏 MC(见 estimators)。
    实测(全逃逸构造,对解析真值 `(1+N.up)/2`):

        法线            旧实现   新实现   真值
        朝上开阔地面      1.0000  0.9998  1.0000
        竖直墙面 方位0    0.3575  0.4998  0.5000
        竖直墙面 方位30   0.3096  0.4996  0.5000
        斜面 60 度        0.6088  0.7499  0.7500
        绕方位起伏        15.5%    0.19%   0%

    `px_scale` 已不再使用(去噪是联合双边,不是随预览宽度变的高斯),
    保留形参只为兼容 `tools/scene_relight/relight.py` 的调用点。
    """
    hit = geo.get('sky_e')
    if hit is not None:
        return hit
    from .estimators import sky_vis_of_normal
    a0, a1 = sky_moments_field(geo, spp=spp, denoise=denoise)
    geo['sky_e'] = sky_vis_of_normal(a0, a1, geo['normal'])
    return geo['sky_e']
