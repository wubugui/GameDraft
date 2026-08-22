"""几何场烘焙:法线 / 天穹可见性(逐像素 + 3D 网格)/ 命中图。

**烘的全是几何项**——只依赖深度场与标定,与时刻、天气、灯全无关。
光怎么变都不用重烘(需求 R1 的落地形式)。产物落 `runtime/scenes/<id>/lighting2/`。

| 产物 | 内容 | 消费方 |
|---|---|---|
| `normal.png` | 场景法线 RGB8(xy 映射到 0..1,z 取 \\|z\\|) | 场景光照 pass |
| `skyvis.png` | 逐像素天穹可见性 R8 | 场景光照 pass |
| `skyvis_grid.bin` | **3D** 天穹可见性,`(nx,ny,nz)` f32 C 序 | 角色照明(三线性插值) |
| `gi_hitmap.bin` | **3D 网格逐方向的命中点**,RGBA8(u,v,命中标志,255) | GI gather(查当前重打光结果) |
| `meta.json` | 网格参数 / 世界 AABB / M / 标定 / background_sha1 / 版本 | 两者 |

3D 网格是角色"吃天光遮蔽"的落地(需求 R4):角色按自己的伪世界位置插值,
头脚高度差天然被网格表达,不需要"脚点采样 + 高度补偿"那种近似。
3840 个标量 = 15 KB,比现有 probe atlas 小两个数量级。

命中图同理是**几何项**:烘的是"往那个方向看会撞到哪面墙",与光无关。
运行时拿它去查当前的重打光结果,就得到「角色如何被 relight 后的场景照亮」
——这正是制作人给 GI 下的定义,不需要真的多次反弹。
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.atomic_io import retry_transient                      # noqa: E402

from .geometry import Scene, resize_f, resize_rgb                # noqa: E402
from .relight import _SKY_AZIMS, _SKY_ELEVS, sun_dir             # noqa: E402

#: 载荷代次。改任何产物布局都要 +1,并同步 validate.py 与运行时消费端。
PAYLOAD_VERSION = 1

#: 烘焙工作分辨率(宽);天穹可见性是低频量,不需要原生分辨率。
WORK_W = 512

#: 角色带缺省不写死——由**角色真实世界高度**推出(见 character_band_wu)。
#: ⚠ 旧 probe 管线的 `probe_band=1.6` 建立在"角色高 1.5 wu"的假设上,而实测
#:   角色高 **0.17–0.97 wu**(逐场景,取决于取景远近)——旧值大了几倍,
#:   竖直分辨率因此几乎全浪费在角色够不着的空中。本模块不复制该错误。
DEFAULT_BAND = None

#: 角色高度的场景坐标缺省值(player_anim 的 worldHeight)
DEFAULT_CHAR_SCENE_H = 150.0

#: 3D 网格分辨率。载荷极小(f32 标量),竖直方向给足
DEFAULT_GRID = (24, 10, 16)


def _atomic_bytes(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.tmp')
    tmp.write_bytes(data)
    retry_transient(os.replace, tmp, dest)


def _march_blocked_from(q0: np.ndarray, dir_q: np.ndarray, depth: np.ndarray,
                        ppu: float, cx: float, cy: float,
                        steps: int, length: float,
                        bias0: float, thick: float) -> np.ndarray:
    """从**任意** q 空间起点沿 dir_q march 深度场,返回逐点 blocked 布尔。

    与 `relight._march_blocked` 同一套判据,区别只在起点:那个从每个像素自己的
    表面出发(逐像素),这个从空间中任意一批点出发(供 3D 网格用)。

    q0: (N,3) 起点;dir_q: (3,) 方向(已归一,q 空间);depth: (h,w) 深度场。
    """
    h, w = depth.shape
    step = length / max(steps, 1)
    blocked = np.zeros(len(q0), bool)
    for i in range(1, steps + 1):
        q = q0 + dir_q[None, :] * (step * i)
        px = q[:, 0] * ppu + cx
        py = cy - q[:, 1] * ppu
        inside = (px >= 0) & (px < w) & (py >= 0) & (py < h)
        xi = np.clip(px, 0, w - 1).astype(np.int32)
        yi = np.clip(py, 0, h - 1).astype(np.int32)
        pen = q[:, 2] - depth[yi, xi]
        bias = bias0 + 0.02 * step * i
        blocked |= inside & (pen > bias) & (pen < thick)
    return blocked


#: GI gather 的方向数。16 个方向 × 3840 个网格点 = 61440 次 march，烘一次约 3 秒。
#: 运行时只在**脏时**各查一次纹理，不 march。
GI_DIRS = 16


def _gi_directions() -> np.ndarray:
    """GI gather 的方向集（q 空间）。

    分布刻意**偏向水平与下方**：角色接到的反弹光大头来自被照亮的**地面**与**近处墙面**，
    正上方那半球是天空——那已经由 `skyvis` 单独记账了，再采一遍就是重复计。
    """
    dirs = []
    for elev_deg in (-35.0, -5.0, 25.0):          # 俯视地面 / 平视墙面 / 略仰
        n = 6 if elev_deg < 20 else 4
        e = math.radians(elev_deg)
        for k in range(n):
            a = 2.0 * math.pi * k / n
            dirs.append([math.cos(e) * math.sin(a), math.sin(e), math.cos(e) * math.cos(a)])
    return np.asarray(dirs[:GI_DIRS], np.float32)


def bake_gi_hitmap(geo: dict, grid: tuple[int, int, int], bounds: dict) -> dict:
    """3D 网格逐方向的**命中点**（work px 的归一化 UV）。

    ## 为什么烘的是"命中哪儿"而不是"收到多少光"

    命中几何**与光无关**——摆灯、改时刻、调天光都不改变"从这个点往那个方向看会撞到哪面墙"。
    所以它和法线 / 天穹可见性是同一类东西：离线烘一次，**光怎么变都不用重烘**。
    运行时拿这张表去查**当前**的重打光结果，就得到"角色如何被 relight 后的场景照亮"
    ——这正是制作人给 GI 下的定义（2026-08-20：「我们说的 gi 就是角色如何被
    relighting 后的场景照亮」，不需要真的多次反弹）。

    ## 布局

    RGBA8，宽 `nx*nz`、高 `ny*ndir`：`R=u  G=v  B=命中标志(255/0)  A=255`。

    · 平铺与 `skyvis_grid` 同规则（列 = `x + z*nx`），方向沿高度方向叠：
      行 = `dir*ny + y`。运行时 `texelFetch` 取，插值自己算。
    · 8 位 UV 在 512 宽的工作图上误差 ≈ 2 px。反弹是**低频**项，这点误差看不出来，
      换来的是本仓库已验证的 `rgba8unorm` 格式——整数纹理要 `usampler2D`，
      多一套复杂度换不来可见收益。

    返回 uint8 数组 `(ny*ndir, nx*nz, 4)`。
    """
    nx, ny, nz = grid
    R = geo['R']
    depth = geo['depth']
    ppu, cx, cy = geo['ppu'], geo['cx'], geo['cy']
    h, w = depth.shape

    gx = np.linspace(bounds['x0'], bounds['x1'], nx)
    gy = np.linspace(bounds['y0'], bounds['y1'], ny)
    gz = np.linspace(bounds['z0'], bounds['z1'], nz)
    X, Y, Z = np.meshgrid(gx, gy, gz, indexing='ij')
    world = np.stack([X.ravel(), Y.ravel(), Z.ravel()], -1).astype(np.float32)
    q0 = world @ R                                   # world → q

    dirs_w = _gi_directions()
    ndir = len(dirs_w)
    steps, length, bias0, thick = 20, 2.6, 0.05, 2.0
    step = length / steps

    def to_grid_rows(flat: np.ndarray) -> np.ndarray:
        """(nx*ny*nz,) C 序 → (ny, nx*nz)，列 = x + z*nx（与 skyvis_grid 同规则）。"""
        a = flat.reshape(nx, ny, nz)
        packed = np.empty((ny, nx * nz), a.dtype)
        for z in range(nz):
            packed[:, z * nx:(z + 1) * nx] = a[:, :, z].T
        return packed

    out = np.zeros((ny * ndir, nx * nz, 4), np.uint8)
    out[..., 3] = 255
    for di, d_w in enumerate(dirs_w):
        d_q = (R.T @ d_w).astype(np.float32)
        hit_px = np.full(len(q0), -1.0, np.float32)
        hit_py = np.full(len(q0), -1.0, np.float32)
        pending = np.ones(len(q0), bool)
        for i in range(1, steps + 1):
            q = q0 + d_q[None, :] * (step * i)
            px = q[:, 0] * ppu + cx
            py = cy - q[:, 1] * ppu
            inside = (px >= 0) & (px < w) & (py >= 0) & (py < h)
            xi = np.clip(px, 0, w - 1).astype(np.int32)
            yi = np.clip(py, 0, h - 1).astype(np.int32)
            pen = q[:, 2] - depth[yi, xi]
            bias = bias0 + 0.02 * step * i
            # **第一次**命中就定下来——沿光线最近的那面才是看得见的那面
            newly = pending & inside & (pen > bias) & (pen < thick)
            hit_px[newly] = px[newly]
            hit_py[newly] = py[newly]
            pending &= ~newly
            if not pending.any():
                break
        got = hit_px >= 0
        u = np.zeros(len(q0), np.uint8)
        v = np.zeros(len(q0), np.uint8)
        u[got] = np.clip(hit_px[got] / max(w - 1, 1) * 255.0, 0, 255).astype(np.uint8)
        v[got] = np.clip(hit_py[got] / max(h - 1, 1) * 255.0, 0, 255).astype(np.uint8)
        r0 = di * ny
        out[r0:r0 + ny, :, 0] = to_grid_rows(u)
        out[r0:r0 + ny, :, 1] = to_grid_rows(v)
        out[r0:r0 + ny, :, 2] = to_grid_rows(got.astype(np.uint8) * 255)
    return {
        'data': out,
        'dirs': [[float(x) for x in d] for d in dirs_w],
        'size': [nx * nz, ny * ndir],
        'hit_rate': float((out[..., 2] > 0).mean()),
    }


def fit_day_hemi(scene: Scene, sky: np.ndarray, size: tuple[int, int]) -> dict:
    """从原画拟合出**它自己的遮蔽响应** `day_hemi`。

    ## 为什么必须拟合而不能拍脑袋

    原画里已经画了白天的遮蔽(巷子本来就暗)。重打光的式子是 `原画 × S_new/S_day`,
    `S_day` 的职责就是把那份遮蔽**除干净**。若 `day_hemi` 填小了,画里剩的遮蔽没除净,
    夜里的 `amb_hemi` 再加一份 ⇒ **遮蔽被算两遍**,角落黑得不合理、开阔地却几乎没变暗
    ——症状就是"地面还那么亮、角落又那么黑"。

    ## 判据

    光除干净了,反解出的反射率就**不该再与天穹可见性相关**(同一种材质,在巷子里
    和在空地上的 albedo 应该一样)。所以在 hemi ∈ [0,1] 上最小化
    `|corr(log 反射率, 天穹可见性)|`。

    实测雾津街头与码头白天**独立得到同一个值 0.90**(而拍脑袋的 0.35 残留相关性 0.31–0.35)。
    """
    from .geometry import srgb_to_linear
    lum = np.array([0.2126, 0.7152, 0.0722], np.float32)
    bg = resize_rgb(scene.bg_srgb, size) if size != scene.native else scene.bg_srgb
    y = np.log(np.maximum(srgb_to_linear(bg) @ lum, 1e-4))
    s = sky - float(sky.mean())
    s_std = float(sky.std()) + 1e-9

    best = (1e9, 0.5)
    for hemi in np.arange(0.0, 1.0001, 0.02):
        shade = np.log(np.maximum((1.0 - hemi) + hemi * sky, 1e-4))
        r = y - shade
        a = r - r.mean()
        c = abs(float((a * s).mean() / (a.std() * s_std + 1e-9)))
        if c < best[0]:
            best = (c, float(hemi))
    return {'day_hemi': best[1], 'residual_corr': best[0]}


def fit_albedo_mean(scene: Scene, sky: np.ndarray, day_hemi: float,
                    haze: dict, size: tuple[int, int]) -> dict:
    """反解出原画的**平均反射率**。这是角色标定常数 `radianceScale` 的地基。

    ## 为什么需要它

    重打光后的场景 = `原画 ÷ S_day × S_new` = `A_scene × S_new`,
    其中 `A_scene := 原画/S_day` 就是反解出来的反射率场。
    角色那边是 `A_char × S_new × radianceScale` —— **两边的 S_new 是同一个**,
    所以能不能对上,只取决于两边反射率的尺度对不对得齐。

    角色贴图是美术按"白天看上去的样子"画的,平均线性反射率经验上落在 0.25 附近。
    于是 `radianceScale = mean(A_scene) / 0.25`:场景反射率偏暗(石板巷子)时把角色压下来,
    偏亮(白墙码头)时把角色提上去。缺这一步角色会**系统性**偏亮或偏暗,
    而且怎么调灯都对不上 —— 因为错的是尺度不是光。

    ⚠ 必须先去霾再反解。霾是空气不是表面,把它算进反射率会让远景反射率虚高,
    整个均值被拉偏(实测雾津街头远/近亮度比 4.32)。
    """
    from .geometry import srgb_to_linear
    lum = np.array([0.2126, 0.7152, 0.0722], np.float32)
    bg = resize_rgb(scene.bg_srgb, size) if size != scene.native else scene.bg_srgb
    lin = srgb_to_linear(bg) @ lum

    # 去霾:与运行时 shader 逐步同式(原画 = 表面×T + 霾×(1−T))
    if haze and haze.get('strength', 0) > 0:
        geo_ = scene.geometry(size)
        if geo_ is not None:
            d = geo_['depth']
            dn = np.clip((d - haze['depth_min'])
                         / max(haze['depth_max'] - haze['depth_min'], 1e-5), 0.0, 1.0)
            T = np.exp(-haze['k'] * dn)
            hz_lum = float(np.asarray(haze['color'], np.float32) @ lum)
            lin = np.maximum(lin - hz_lum * haze['strength'] * (1.0 - T), 0.0) / np.maximum(T, 0.15)

    s_day = (1.0 - day_hemi) + day_hemi * sky
    a = lin / np.maximum(s_day, 1e-4)
    # 分位数而非算术均值:高光/天空那一小撮极亮像素会把均值拉飞
    return {
        'albedo_mean': float(np.median(a)),
        'albedo_p25': float(np.percentile(a, 25)),
        'albedo_p75': float(np.percentile(a, 75)),
    }


def fit_haze(scene: Scene, geo: dict, size: tuple[int, int]) -> dict:
    """拟合原画里的**白天大气散射**(aerial perspective)。

    ## 为什么必须去掉它

    `原画 = 表面辐射 × T(d) + 白天的霾 × (1−T(d))`。霾**不是表面**,是被日光照亮的空气。
    重打光只处理表面项,霾就会在夜里继续亮着 —— 实测雾津街头远景比近景亮 **4.32 倍**,
    而"远处一片亮灰"正是大脑判定「这是白天」最强的信号之一。
    结果就是无论怎么压暗调冷,看着永远像**低亮度的白天**。

    与表面项的「除掉白天光」严格对称:这是「**除掉白天的散射**」。

    ## 判据(暗通道先验)

    黑表面上剩下的就是霾。所以按视深分层取**暗通道的低分位**,
    拟合 `haze(d) = H·(1 − exp(−k·d))`。
    """
    from .geometry import srgb_to_linear
    bg = resize_rgb(scene.bg_srgb, size) if size != scene.native else scene.bg_srgb
    lin = srgb_to_linear(bg)
    d = geo['depth']
    d_lo, d_hi = float(d.min()), float(d.max())
    dn = ((d - d_lo) / max(d_hi - d_lo, 1e-6)).ravel()
    dark = lin.min(-1).ravel()

    edges = np.linspace(0.0, 1.0, 21)
    xs, ys = [], []
    for i in range(20):
        m = (dn >= edges[i]) & (dn < edges[i + 1])
        if m.sum() < 300:
            continue
        xs.append((edges[i] + edges[i + 1]) * 0.5)
        ys.append(float(np.percentile(dark[m], 3)))
    if len(xs) < 4:
        return {'k': 0.0, 'strength': 0.0, 'color': [1.0, 1.0, 1.0],
                'depth_min': d_lo, 'depth_max': d_hi, 'residual': 0.0}
    xs_a = np.asarray(xs, np.float64)
    ys_a = np.asarray(ys, np.float64)
    best = (1e18, 0.0, 0.0)
    for k in np.arange(0.2, 8.001, 0.05):
        b = 1.0 - np.exp(-k * xs_a)
        H = float((b @ ys_a) / max(b @ b, 1e-12))
        r = float(((H * b - ys_a) ** 2).mean())
        if r < best[0]:
            best = (r, float(k), H)
    residual, k, H = best

    far = dn >= 0.85
    if far.sum() > 200:
        c = np.percentile(lin.reshape(-1, 3)[far], 5, axis=0)
    else:
        c = np.array([1.0, 1.0, 1.0], np.float32)
    c = c / max(float(c.mean()), 1e-6)                 # 归一色度
    return {'k': k, 'strength': max(H, 0.0), 'color': [float(v) for v in c],
            'depth_min': d_lo, 'depth_max': d_hi, 'residual': residual}


def character_band_wu(scene: Scene, char_scene_h: float = DEFAULT_CHAR_SCENE_H) -> dict:
    """角色在这张画里占多少 **wu**,以及据此推出的可达高度带。

    刻度链:场景坐标 --(native_w / worldWidth)--> 背景像素 --(1/ppu)--> 世界单位。

    ⚠ `char_wu` **不是**摆灯的尺度参照。它只反映这张画的**取景远近**:角色固定
      150 场景坐标高,而 `worldWidth` 逐场景 700–4000,于是 char_wu 从 0.17
      变到 0.97。世界单位本身没变——`ppu` 逐场景从 220 变到 573,正是为了把
      **每张背景都标定成同一个世界宽度**(25/28 个场景是 4.5455 wu = 50/11)。
      摆灯该看的是 `native.w / ppu`。

    ⚠ 这里一度还导出过 `meters_per_wu = 1.7 / char_wu`(「假设角色 1.7 米高」)。
      那是凭空造的单位——**游戏里没有米,只有 wu**,2026-08-21 整层删掉。
    """
    data = json.loads(scene_json_path(scene).read_text(encoding='utf-8'))
    world_w = float(data.get('worldWidth') or 0.0)
    nw = scene.native[0]
    ppu = float(scene.cfg['ppu']) if scene.cfg else 0.0
    if world_w <= 0 or ppu <= 0:
        raise RuntimeError('缺 worldWidth 或 depthConfig.M.ppu,无法推角色刻度')
    scene_per_wu = world_w / (nw / ppu)          # 一个世界单位 = 多少场景坐标
    char_wu = char_scene_h / scene_per_wu
    return {
        'char_wu': char_wu,
        'scene_per_wu': scene_per_wu,
        'band': char_wu * 1.15,                  # 头顶留一点余量
    }


def scene_json_path(scene: Scene) -> Path:
    from .geometry import SCENES_JSON
    return SCENES_JSON / f'{scene.sid}.json'


def bake_skyvis_grid(geo: dict, grid: tuple[int, int, int], band: float) -> dict:
    """3D 天穹可见性网格。返回 {'data': (nx,ny,nz) f32, 'bounds': {...}}。

    判据与逐像素版 `sky_field` **同源**(同一组方向、同一套 march),
    这是"角色与场景吃同一个遮蔽场"的前半条保证。
    """
    nx, ny, nz = grid
    pos = geo['pos']
    R = geo['R']
    depth = geo['depth']
    ppu, cx, cy = geo['ppu'], geo['cx'], geo['cy']

    # 世界 AABB:x/z 取可见面的 1~99 分位(掐掉边缘外推的野值)
    px_ = pos[..., 0].ravel()
    py_ = pos[..., 1].ravel()
    pz_ = pos[..., 2].ravel()
    x0, x1 = np.percentile(px_, [1, 99])
    z0, z1 = np.percentile(pz_, [1, 99])
    # y:覆盖「最低地面 → 最高地面 + 角色带」。
    # ⚠ 地面本身的起伏(p2..p60)常常比角色还高,必须一并覆盖,否则远处地面上的角色
    #   会落到网格外被钳到边界层(旧 probe 系统踩过:远端角色有效插值权重为 0)。
    y0 = float(np.percentile(py_, 2)) - 0.02
    y1 = float(np.percentile(py_, 60)) + band
    y1 = max(y1, y0 + band * 1.5)

    gx = np.linspace(x0, x1, nx)
    gy = np.linspace(y0, y1, ny)
    gz = np.linspace(z0, z1, nz)
    X, Y, Z = np.meshgrid(gx, gy, gz, indexing='ij')
    world = np.stack([X.ravel(), Y.ravel(), Z.ravel()], -1).astype(np.float32)
    q = world @ R                      # world → q(R 正交 ⇒ 转置即逆)

    up_norm = 0.0
    acc = np.zeros(len(q), np.float32)
    for elev in _SKY_ELEVS:
        for azim in _SKY_AZIMS:
            d_w = sun_dir(elev, azim)
            d_q = (R.T @ d_w).astype(np.float32)
            blocked = _march_blocked_from(q, d_q, depth, ppu, cx, cy,
                                          steps=16, length=2.2, bias0=0.05, thick=2.0)
            # 网格点在空气中,没有自身法线 ⇒ 权重只用方向的向上分量(半球余弦)
            wgt = max(float(d_w[1]), 0.0)
            acc += (~blocked).astype(np.float32) * wgt
            up_norm += wgt
    vis = (acc / max(up_norm, 1e-6)).reshape(nx, ny, nz)
    return {
        'data': np.clip(vis, 0.0, 1.0).astype(np.float32),
        'bounds': {'x0': float(x0), 'x1': float(x1),
                   'y0': float(y0), 'y1': float(y1),
                   'z0': float(z0), 'z1': float(z1)},
    }


def bake(sid: str, grid: tuple[int, int, int] = DEFAULT_GRID,
         band: float | None = DEFAULT_BAND, work_w: int = WORK_W) -> dict:
    """烘一个场景的全部几何场。band 缺省由角色真实高度推出。"""
    from .relight import sky_field

    scene = Scene(sid)
    nw, nh = scene.native
    w = min(work_w, nw)
    h = max(1, round(nh * w / nw))
    geo = scene.geometry((w, h), normal_sigma=max(0.8, 0.8 * (w / 640.0)))
    if geo is None:
        raise RuntimeError(f'场景 {sid} 没有 depthConfig / 深度图,无法烘几何场')
    scale = character_band_wu(scene)
    if band is None:
        band = scale['band']

    out = scene.rt_dir / 'lighting2'

    # ---- 法线 ----
    n = geo['normal']
    nrm = np.zeros((h, w, 3), np.uint8)
    nrm[..., 0] = np.round((n[..., 0] * 0.5 + 0.5) * 255).astype(np.uint8)
    nrm[..., 1] = np.round((n[..., 1] * 0.5 + 0.5) * 255).astype(np.uint8)
    nrm[..., 2] = np.round(np.abs(n[..., 2]) * 255).astype(np.uint8)
    import io
    buf = io.BytesIO()
    Image.fromarray(nrm).save(buf, format='PNG', optimize=True)
    _atomic_bytes(out / 'normal.png', buf.getvalue())

    # ---- 逐像素天穹可见性 ----
    sky = sky_field(geo, w / 640.0)
    buf = io.BytesIO()
    Image.fromarray(np.round(np.clip(sky, 0, 1) * 255).astype(np.uint8), mode='L') \
        .save(buf, format='PNG', optimize=True)
    _atomic_bytes(out / 'skyvis.png', buf.getvalue())

    # ---- 原画自己的遮蔽响应（决定"除掉多少白天光"，见 fit_day_hemi）----
    day = fit_day_hemi(scene, sky, (w, h))
    # ---- 原画里的白天大气散射（决定"除掉多少白天的霾"，见 fit_haze）----
    haze = fit_haze(scene, geo, (w, h))

    # ---- 反解反射率（角色标定常数的地基，见 fit_albedo_mean）----
    alb = fit_albedo_mean(scene, sky, day['day_hemi'], haze, (w, h))

    # ---- 3D 天穹可见性网格 ----
    g = bake_skyvis_grid(geo, grid, band)
    _atomic_bytes(out / 'skyvis_grid.bin', g['data'].tobytes())

    # ---- GI 命中图（几何项，与光无关；运行时拿它查当前的重打光结果）----
    gi = bake_gi_hitmap(geo, grid, g['bounds'])
    _atomic_bytes(out / 'gi_hitmap.bin', gi['data'].tobytes())

    # ---- meta ----
    bg_sha1 = hashlib.sha1(scene_bg_bytes(scene)).hexdigest()[:12]
    meta = {
        'version': PAYLOAD_VERSION,
        'background_sha1': bg_sha1,
        'work': {'w': w, 'h': h},
        'native': {'w': nw, 'h': nh},
        'cal': {'ppu': geo['ppu'], 'cx': geo['cx'], 'cy': geo['cy']},
        'M': [[float(v) for v in row] for row in geo['R']],
        'grid': {'nx': grid[0], 'ny': grid[1], 'nz': grid[2], **g['bounds']},
        'band': band,
        # 刻度链:角色在这张画里占多少 wu。**本项目唯一的尺度参照**——
        # 每张原画取景远近不同,同一个角色跨 28 个场景占 0.17–0.97 wu(差 5.7 倍),
        # 摆灯、估半径时对着它比。(这里一度还导出过 meters_per_wu = 1.7/char_wu,
        #  那是凭空造的单位——游戏里没有米,已删。)
        'scale': {'char_wu': scale['char_wu'], 'scene_per_wu': scale['scene_per_wu']},
        # ★ 原画自己的遮蔽响应。场景 lighting.day.hemi 应当取它，**别拍脑袋填**——
        #   填小了会把画里没除净的遮蔽和夜里新加的遮蔽叠起来（角落黑两遍）。
        'day_hemi': day['day_hemi'],
        'day_hemi_residual_corr': day['residual_corr'],
        # ★ 画内白天大气散射。不除掉它，远景在夜里会继续发亮 ——
        #   "远处一片亮灰"是判定"这是白天"最强的信号之一。
        'haze': haze,
        # ★ 反解出的原画反射率。角色的 radianceScale 缺省 = albedo_mean / 0.25
        #   （除数是角色图集的**实测**平均反射率 0.0381，不是教科书的 0.25）。
        #   缺它角色会**系统性**偏亮/偏暗，且怎么调灯都对不上——错的是尺度不是光。
        'albedo': alb,
        'sky_dirs': {'elevs': list(_SKY_ELEVS), 'azims': list(_SKY_AZIMS)},
        # GI 命中图：3D 网格逐方向撞到的 work px（归一化 u16，miss=0xFFFF）。
        # ★ 与光**无关**的几何项——摆灯 / 改时刻 / 调天光都不用重烘。
        #   运行时拿它去查**当前**的重打光结果，就得到「角色如何被 relight 后的场景照亮」。
        'gi': {'dirs': gi['dirs'], 'ndir': len(gi['dirs']),
               'work': {'w': w, 'h': h}, 'size': gi['size'],
               'hit_rate': gi['hit_rate']},
        'depth_range': list(geo['d_range']),
    }
    _atomic_bytes(out / 'meta.json',
                  (json.dumps(meta, ensure_ascii=False, indent=1) + '\n').encode('utf-8'))

    return {
        'dest': str(out),
        'scale': scale,
        'band': band,
        'day': day,
        'haze': haze,
        'albedo': alb,
        'gi': {'ndir': len(gi['dirs']), 'hit_rate': gi['hit_rate'],
               'bytes': int(gi['data'].nbytes)},
        'skyvis_px': {'min': float(sky.min()), 'max': float(sky.max()),
                      'mean': float(sky.mean())},
        'skyvis_grid': {'min': float(g['data'].min()), 'max': float(g['data'].max()),
                        'mean': float(g['data'].mean()),
                        'count': int(g['data'].size)},
        'bounds': g['bounds'],
        'bytes': sum(f.stat().st_size for f in out.iterdir() if f.is_file()),
    }


def scene_bg_bytes(scene: Scene) -> bytes:
    return (scene.rt_dir / scene.bg_name).read_bytes()


def main() -> None:
    import argparse
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(prog='scene_relight.bake')
    ap.add_argument('--scene')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--band', type=float, default=None,
                    help='角色可达高度带(wu)。缺省由角色真实高度推出,别手填 1.6')
    ap.add_argument('--work-w', type=int, default=WORK_W)
    args = ap.parse_args()

    from .geometry import list_scenes
    if args.all:
        sids = [s['id'] for s in list_scenes() if s['bg_ok'] and s['depth']]
    elif args.scene:
        sids = [args.scene]
    else:
        raise SystemExit('要 --scene <id> 还是 --all ?')

    for sid in sids:
        try:
            r = bake(sid, band=args.band, work_w=args.work_w)
        except Exception as e:                       # noqa: BLE001
            print(f'{sid}: 失败 {type(e).__name__}: {e}')
            continue
        px = r['skyvis_px']
        gr = r['skyvis_grid']
        sc = r['scale']
        print(f"{sid}: → lighting2/ ({r['bytes']/1024:.0f} KB)")
        print(f"   刻度 角色 {sc['char_wu']:.3f} wu(摆灯的尺度参照)"
              f"  角色带 {r['band']:.3f} wu")
        hz = r['haze']
        print(f"   逐像素天穹可见性 {px['min']:.2f}–{px['max']:.2f} 均 {px['mean']:.2f}"
              f"  网格 {gr['count']} 点 均 {gr['mean']:.2f}")
        print(f"   画内遮蔽响应 day_hemi={r['day']['day_hemi']:.2f}"
              f"  白天大气散射 k={hz['k']:.2f} H={hz['strength']:.4f}")


if __name__ == '__main__':
    main()
