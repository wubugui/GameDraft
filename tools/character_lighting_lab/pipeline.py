#!/usr/bin/env python3
"""Character lighting tool - offline pipeline.

Input: one scene background image.
Output: out/<scene>/ with everything the WebGL viewer needs:
  depth, no-plane auto calibration, completed occupancy+radiance voxel volume,
  ambient closure (J-bar, SH L2), probe caches (SH L1 / SH L2 / octa bins),
  walkable mask, ground-depth field, front-depth field for occlusion.

Conventions (locked, keep in sync with viewer shaders):
  screen: sx right, sy down (pixels at work resolution W_G)
  q-space: qx=(sx-cx)/ppu, qy=(cy-sy)/ppu (up positive), qz=d (bigger = farther)
  world:   Y_world = qy*cos(theta) - qz*sin(theta)   (theta = camera pitch)
  depth:   d = s*(1-raw) + o, raw in [0,1] near=high (Depth Anything)
  volume grid axes: (ix->qx right, iy->qy up, iz->qz away)
Radiance is stored display-linear: 1.0 == display white (100 nit * 2^EV).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import (
    binary_closing, binary_dilation, binary_erosion, binary_fill_holes,
    binary_opening, distance_transform_edt, gaussian_filter, grey_closing, label,
    maximum_filter,
)


# ---------------------------------------------------------------------------
# 原子落盘(2026-08-31 审计必修):桌面壳把烘焙子进程塞进了 kill-on-close 的
# Job Object,关窗 = 在**任意指令处** TerminateProcess。直接 write_bytes 先截断
# 后写入,中途被杀会在 runtime/scenes/<id>/lighting/ 留下**长度不足但看着正常**
# 的 .bin,无任何标记(改桌面壳之前,孤儿进程反而会把产物写完)。
# 一切"游戏要读的产物"必须先写 .tmp 再 os.replace 就位——替换是原子的,
# 被杀只留 .tmp,正式名下永远是完整旧版或完整新版。
# ---------------------------------------------------------------------------
def _awrite(dest: Path, data: bytes) -> None:
    tmp = dest.with_suffix(dest.suffix + '.tmp')
    tmp.write_bytes(data)
    try:
        from tools.atomic_io import retry_transient   # Windows 句柄占用退避(见该模块头注)
        retry_transient(os.replace, tmp, dest)
    except ImportError:                               # 裸脚本方式跑(无 repo root):os.replace 同样原子
        os.replace(tmp, dest)


def _awrite_text(dest: Path, text: str) -> None:
    _awrite(dest, text.encode('utf-8'))


def _asave(img, dest: Path, **kw) -> None:
    """PIL 图的原子落盘:save 进内存 buffer 再 _awrite 就位。"""
    import io
    buf = io.BytesIO()
    img.save(buf, format='PNG', **kw)
    _awrite(dest, buf.getvalue())


TOOL = Path(__file__).resolve().parent
OUT = TOOL / 'out'
ROOT = TOOL.parents[1]            # repo root (tools/character_lighting_lab/..)
sys.path.insert(0, str(ROOT))

# 蒙特卡洛烘焙(2026-09-01):tracer / 采样器 / 估计器都在同目录的独立模块里,
# probe 与天穹遮蔽共用同一份 —— 判据只有一处,见 trace.py 的铁律。
from tools.character_lighting_lab.const import PROBE_SPP        # noqa: E402
from tools.character_lighting_lab.estimators import AK          # noqa: E402

W_G = 512                 # working geometry resolution (width)
MAX_GAIN_EV = math.log2(10.0)
LUMA_W = np.array([0.2126, 0.7152, 0.0722], np.float32)

DEFAULTS = dict(
    pitch_deg=45.0,
    azimuth_deg=0.0,       # camera azimuth: rotates the world about the up axis
    ppu_ratio=0.22,        # ppu = ppu_ratio * W_G
    depth_model='base',    # depth-anything variant: small | base | large
    depth_scale_adj=1.0,   # manual trim on top of the auto calibration
    depth_offset_adj=0.0,
    col_h_lo=0.35,         # collision occupancy probe heights above local ground
    col_h_hi=1.3,
    ev=0.0,                # scene exposure EV
    max_gain_ev=math.log2(10.0),  # HDR emitter max boost
    hdr_method=0,          # LDR→HDR 恢复法:0 emitter门 / 1 逆Reinhard / 2 gamma / 3 亮度扩展
    hdr_pa=0.7,            # 方法参数(1=展开硬度 / 2=gamma强度 / 3=起始亮度阈值)
    vol_nx=192, vol_nz=64, # voxel grid (ny derived from aspect)
    # ---- probe:分布与积分,2026-09-01 起都是烘焙期参数,不再是写死的常量 ----
    probe_strategy='uniform_grid',   # 见 probe_layout.STRATEGIES('legacy_fixed' 供 A/B)
    probe_dims=None,                 # None = 按角色高度推密度;给元组则显式指定格数
    #: 横纵**解耦**(制作人 2026-09-01:「纵向 2 格够了,水平必须提起来」)。
    probe_cells_per_char_xz=4.0,     # 横向:每个角色高几格
    probe_cells_per_char_y=2.0,      # 纵向:每个角色高几格
    #: probe 盒总高 = 角色身高 x 这个数。**不覆盖全场景最高点** —— 上面没有角色。
    probe_height_chars=2.0,
    probe_max=200_000,               # 格数上限(载荷体积护栏)
    probe_spp=256,                   # 每颗 probe 的方向样本数(分层 QMC)
    #: NEE+MIS(发光体第二采样器,无偏,2026-09-01 从 lighting-rebuild 分支补课):
    #: 缺省开;画面没有阈上发光体时 build_nee 返回 None,自动退纯 BSDF 老路。
    probe_nee=True,
    #: 发光体判定阈(本管线辐射标度:恢复上限 maxEV=5,全场最亮 ~30;
    #: 分支的 4.0 是它 200-1200 标度下的值,直接用会漏中亮像素。实测 破屋
    #: 4.0->1.0: 256spp p90 33%->27%,1024spp 12.7%->8.8%;0.25 无进一步增益)。
    probe_nee_threshold=1.0,
    #: Cycles 系逐样本亮度钳(有偏)。None=关;NEE 开着时只兜极端余量。
    probe_clamp=None,
    #: probe 体重建层(3D 联合双边)趟数。**缺省关**:实测三版 sigma 口径
    #: (线性/log/SVGF方差)在极端动态范围场上要么偏能量要么加跑间方差,
    #: 收敛正路是下面的自适应细化;滤波仅留作应急选项。
    probe_filter_iters=0,
    #: 自适应细化(无偏):第一轮后挑 DC 相对噪声 > rel 阈的格,以 mult x spp
    #: 独立随机流重采,按样本数加权合并。挑格上限 frac(时间护栏)。
    probe_refine_rel=0.05,
    probe_refine_mult=4,
    probe_refine_frac=0.15,
    #: 逃逸辐射:射线跑出伪世界带走多少。**缺省纯黑**(制作人 2026-09-01)。
    #: 可选 {'mode':'color'|'skybox'|'scene_derived', ...},见 escape.py。
    escape={'mode': 'black'},
    probe_band=None,       # 角色可达高度带(wu);None = 由角色实高推出(char_wu*1.15)。
                           # ⚠ 旧值写死 1.6,建立在"角色高 1.5 wu"的假设上,而实测
                           #   角色是 0.17~0.97 wu —— 6 层里有 5 层烘在够不着的空中。
    # ⚠ 已废弃(留名只为读旧 manifest 不炸):probe_nx/ny/nz -> probe_dims、
    #   probe_dirs -> probe_spp、fold -> 已删(见 stage_probes 的表)。
    probe_nx=20, probe_ny=6, probe_nz=14,
    probe_dirs=196,
    fold=1,                # ⛔ 已无消费者:朝相机的射线不再镜像,老实逃逸
    semantic_gate=1,       # SAM3 object-gated emitter confidence (0/1)
    relief=1.8,            # structure depth gain relative to the pinned ground
                           # (compensates monocular vertical-contrast compression)
    occluder_tau=0.10,     # pop-out threshold, fraction of depth range
    thickness_k=0.55,      # occluder thickness = k * min(bbox)/ppu
    bg_thickness_q=0.60,   # default slab thickness for background shell (q units)
    ground_up_dot=0.75,    # world-up cosine threshold for ground candidacy
    object_score_min=0.35, # 实例采信分数门槛(调它不必重跑推理)
    object_groups='',      # 提示词组,逗号分隔;空=默认组(见 object_seg.DEFAULT_GROUPS)
    object_prompts_extra='',  # 本场景额外提示词,逗号分隔
    walk_res=160,          # world XZ walk grid resolution (max dimension)
)


#: 站位体检用的角色世界尺寸,与游戏 player 动画 anim.json 的 worldWidth/Height 同源
PLAYER_WORLD_W = 142.235294
PLAYER_WORLD_H = 155.0

EDIT_RANGE_Q = 2.0     # depth brush delta range: +-2 q units, u16 encoded (32768 = 0)


def load_depth_edit(out_dir: Path, shape: tuple[int, int]) -> np.ndarray | None:
    """RG16 编码(浏览器 canvas 只能可靠读写 8bit 通道,故 r*256+g):
    delta_q = (u16-32768)/32768 * EDIT_RANGE_Q"""
    p = out_dir / 'depth_edit.png'
    if not p.exists():
        return None
    img = np.asarray(Image.open(p).convert('RGB'), np.float32)
    e16 = img[..., 0] * 256.0 + img[..., 1]
    if e16.shape != shape:
        e16 = resize_f(e16, (shape[1], shape[0]))
    return ((e16 - 32768.0) / 32768.0 * EDIT_RANGE_Q).astype(np.float32)


def load_object_edit(out_dir: Path, shape: tuple[int, int]) -> np.ndarray | None:
    """人工物体覆写层(work 分辨率 u8):1=强制算物体 2=强制算地形 0=听自动的。
    与 depth/collision 两层同款,随场景持久化、重烘不丢。"""
    p = out_dir / 'object_edit.png'
    if not p.exists():
        return None
    e = np.asarray(Image.open(p).convert('L'), np.uint8)
    if e.shape != shape:
        e = np.asarray(Image.fromarray(e).resize((shape[1], shape[0]), Image.Resampling.NEAREST), np.uint8)
    return e


def load_collision_edit(out_dir: Path, shape: tuple[int, int]) -> np.ndarray | None:
    """0 = auto, 1 = force-walkable, 2 = force-blocked (work-res, screen space)."""
    p = out_dir / 'collision_edit.png'
    if not p.exists():
        return None
    # 直读红通道:convert('L') 的亮度加权会把 R=2 压成 1(阻挡静默变可走,踩过)
    e = np.asarray(Image.open(p).convert('RGB'), np.uint8)[..., 0]
    if e.shape != shape:
        e = np.asarray(Image.fromarray(e).resize((shape[1], shape[0]), Image.Resampling.NEAREST), np.uint8)
    return e


def geometry_signature(out_dir: Path, h: str, P: dict) -> str:
    """Everything that shapes the mesh/world. Lighting baked under a different
    signature => stale, the viewer must nag for a rebake."""
    geo_keys = ('pitch_deg', 'azimuth_deg', 'ppu_ratio', 'depth_model',
                'depth_scale_adj', 'depth_offset_adj', 'col_h_lo', 'col_h_hi',
                'relief', 'occluder_tau', 'thickness_k',
                'bg_thickness_q', 'ground_up_dot', 'vol_nx', 'vol_nz', 'walk_res',
                'object_score_min', 'object_groups', 'object_prompts_extra')
    parts = [h] + [f'{k}={P[k]}' for k in geo_keys]
    for f in ('depth_edit.png', 'collision_edit.png', 'object_edit.png'):
        fp = out_dir / f
        parts.append(f'{f}:{hashlib.sha1(fp.read_bytes()).hexdigest()[:10]}' if fp.exists() else f'{f}:-')
    return hashlib.sha1('|'.join(parts).encode()).hexdigest()[:16]


def world_matrix(theta: float, azimuth: float = 0.0) -> np.ndarray:
    """M: q -> world.  Base: Xw=qx; Yw=qy c - qz s; Zw=-(qy s + qz c),
    then rotated about world-up by the camera azimuth.

    q (x right, y up, z away) is LEFT-handed; the Z negation makes the world
    RIGHT-handed so GL viewers don't mirror it. M stays orthogonal (det=-1):
    transpose==inverse and isometry both still hold."""
    c, s = math.cos(theta), math.sin(theta)
    M = np.array([[1, 0, 0], [0, c, -s], [0, -s, -c]], np.float64)
    if abs(azimuth) > 1e-9:
        ca, sa = math.cos(azimuth), math.sin(azimuth)
        Ry = np.array([[ca, 0, sa], [0, 1, 0], [-sa, 0, ca]], np.float64)
        M = Ry @ M
    return M


# ---------------------------------------------------------------- helpers
def srgb_to_linear(x):
    x = np.asarray(x, np.float32)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / max(e1 - e0, 1e-9), 0.0, 1.0)
    return (t * t * (3.0 - 2.0 * t)).astype(np.float32)


def resize_nn(a, size):
    """最近邻缩放:实例 id / 标签图专用(双线性会把 id 混成不存在的编号)。"""
    return np.asarray(Image.fromarray(np.asarray(a)).resize(size, Image.Resampling.NEAREST))


def resize_f(a, size):
    return np.asarray(Image.fromarray(np.asarray(a, np.float32), 'F').resize(size, Image.Resampling.BILINEAR), np.float32)


def img_hash(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()[:12]


def fib_sphere(n: int) -> np.ndarray:
    i = np.arange(n, dtype=np.float64) + 0.5
    phi = math.pi * (3.0 - math.sqrt(5.0)) * i
    z = 1.0 - 2.0 * i / n
    r = np.sqrt(np.maximum(0.0, 1.0 - z * z))
    return np.stack([r * np.cos(phi), r * np.sin(phi), z], -1).astype(np.float32)


def sh_basis(dirs: np.ndarray) -> np.ndarray:
    """Real SH basis l<=2, dirs (N,3) -> (N,9)."""
    x, y, z = dirs[:, 0], dirs[:, 1], dirs[:, 2]
    return np.stack([
        np.full_like(x, 0.282095),
        0.488603 * y, 0.488603 * z, 0.488603 * x,
        1.092548 * x * y, 1.092548 * y * z,
        0.315392 * (3 * z * z - 1.0),
        1.092548 * x * z, 0.546274 * (x * x - y * y),
    ], -1).astype(np.float32)


def laplace_inpaint(field: np.ndarray, known: np.ndarray, iters=400) -> np.ndarray:
    """Diffuse known values into unknown region (Jacobi). Cheap and robust."""
    f = field.copy().astype(np.float32)
    unk = ~known
    if not unk.any():
        return f
    # init unknown with nearest known value for faster convergence
    idx = distance_transform_edt(unk, return_distances=False, return_indices=True)
    f[unk] = f[tuple(i[unk] for i in idx)]
    for _ in range(iters):
        avg = 0.25 * (np.roll(f, 1, 0) + np.roll(f, -1, 0) + np.roll(f, 1, 1) + np.roll(f, -1, 1))
        f[unk] = avg[unk]
    return f


# ---------------------------------------------------------------- stages
def stage_depth(img_path: Path, cache_dir: Path, h: str, model: str = 'base') -> np.ndarray:
    cache = cache_dir / (f'raw_depth_{h}.npy' if model == 'base' else f'raw_depth_{h}_{model}.npy')
    if cache.exists():
        # 阶段标签也要在缓存分支打:否则查看器的阶段清单会把"用了缓存"显示成"跳过",
        # 让人以为深度没跑(实测就是这个误导)。
        print(f'[depth] 用缓存 ({model})', flush=True)
        return np.load(cache)
    print(f'[depth] inferring with Depth Anything ({model})...', flush=True)
    from tools.character_lighting_lab.depth_estimator import DepthEstimator, MODEL_OPTIONS
    est = DepthEstimator()
    src = Image.open(img_path).convert('RGB')
    res = est.generate_depth(src, MODEL_OPTIONS.get(model, MODEL_OPTIONS['base']),
                             lambda s: print('  ', s, flush=True))
    raw = np.asarray(res.raw_normalized, np.float32)
    cache_dir.mkdir(parents=True, exist_ok=True)
    np.save(cache, raw)
    return raw


def _ground_mask_from(d, qy, theta, thresh, prior=None):
    """地面掩膜 = 语义(prior) ∩ 几何(朝上 + 从画面底部洪泛)。

    **两路证据缺一不可**(2026-07-23 实测):
    - 只用几何:朝上判据分不开街面与屋顶(都朝上、2D 上还连成一片),屋顶被烘进地形;
      而且 `ground_up_dot=0.75` 等价于「坡度 < 41.4°」,陡坡看不见。
    - 只用语义:雾津街头门槛 0.15 时干净(污染 1.5%),但 temple 这种暗色室内**没有
      可用门槛**——0.15 会把 55% 的真地板当物体吃掉,0.35 又留 42% 污染。
    交集在 雾津街头/temple/阎王岭山口 三张上污染都 ≤1.3%。所以几何这路不是「旧方案
    残留」,是与语义正交的第二路证据;两路各有盲区,别再想着删掉哪一路。
    """
    d_su = np.gradient(d, axis=1)
    d_sv = np.gradient(d, axis=0)
    ppu_dummy = 1.0  # gradients in q handled via caller scale; use per-pixel here
    # per-qx / per-qy depth gradients need ppu; caller passes qy grid so derive:
    # qy step per pixel row:
    ppu = 1.0 / abs(qy[0, 0] - qy[1, 0]) if qy.shape[0] > 1 else 1.0
    dqx = d_su * ppu
    dqy = -d_sv * ppu
    n_up = (-dqy * math.cos(theta) - math.sin(theta))
    up_dot = -n_up / np.sqrt(dqx * dqx + dqy * dqy + 1.0)
    cand = up_dot > thresh
    if prior is not None:
        cand &= prior
    lab, _ = label(cand)
    bottom = np.unique(lab[-8:, :]); bottom = bottom[bottom != 0]
    mask = np.isin(lab, bottom)
    mask = binary_closing(mask, np.ones((5, 5)))
    return mask if mask.sum() >= 500 else cand


def stage_calibrate(raw: np.ndarray, P: dict, ground_prior: np.ndarray | None = None) -> dict:
    """No-plane auto calibration with a disparity-affine model.

    Depth Anything outputs affine-invariant *disparity*; model depth as
    d = 1/(a*raw + b). (a,b) minimize robust mean |grad Y|^2 over the ground
    mask ("ground as level as possible on average") via coarse->fine grid
    search -- anchor-free, and real relief is KEPT (no flattening applied).
    o then sets median ground height to 0 (defines the world origin).
    """
    Hg, Wg = raw.shape
    theta = math.radians(P['pitch_deg'])
    ppu = P['ppu_ratio'] * Wg
    cx, cy = Wg / 2.0, Hg / 2.0
    sy = np.arange(Hg, dtype=np.float32)[:, None]
    qy = ((cy - sy) / ppu * np.ones((1, Wg))).astype(np.float32)

    # initial mask: lower 65% with low depth texture
    g2r = np.hypot(np.gradient(raw, axis=1), np.gradient(raw, axis=0))
    mask = np.zeros(raw.shape, bool)
    mask[int(Hg * 0.35):, :] = True
    mask &= g2r < np.percentile(g2r, 70)
    if ground_prior is not None:
        mask &= ground_prior

    def objective(a, b, m):
        d = 1.0 / (a * raw + b)
        Y = qy * math.cos(theta) - d * math.sin(theta)
        gy = np.gradient(Y, axis=0); gx = np.gradient(Y, axis=1)
        r = np.hypot(gx, gy)[m]
        med = np.median(r)
        return float(np.mean(np.minimum(r, 3.0 * med + 1e-9) ** 2)), None

    a_best, b_best = 1.0, 0.5
    for it in range(2):
        sub = mask & (np.random.default_rng(7).random(mask.shape) < min(1.0, 30000 / max(mask.sum(), 1)))
        lo_a, hi_a, lo_b, hi_b = 0.05, 30.0, 0.02, 8.0
        for zoom in range(3):
            As = np.geomspace(lo_a, hi_a, 24); Bs = np.geomspace(lo_b, hi_b, 24)
            best = (1e18, a_best, b_best)
            for a in As:
                for b in Bs:
                    e, _ = objective(a, b, sub)
                    if e < best[0]:
                        best = (e, a, b)
            _, a_best, b_best = best
            lo_a, hi_a = a_best / 2.5, a_best * 2.5
            lo_b, hi_b = b_best / 2.5, b_best * 2.5
        d = (1.0 / (a_best * raw + b_best)).astype(np.float32)
        mask = _ground_mask_from(d, qy, theta, P['ground_up_dot'], prior=ground_prior)

    d = (1.0 / (a_best * raw + b_best)).astype(np.float32)
    o = float(np.median(qy[mask] / math.tan(theta) - d[mask])) if mask.any() else 0.0
    d = d + o
    Y = (qy * math.cos(theta) - d * math.sin(theta)).astype(np.float32)
    return dict(s=a_best, o=b_best, theta=theta, ppu=ppu, cx=cx, cy=cy,
                d=d, Y=Y, ground_mask=mask, qy=qy, depth_shift=o,
                ground_y_p95=float(np.percentile(np.abs(Y[mask]), 95)) if mask.any() else -1.0)


def refresh_ground_mask(cal: dict, objects: np.ndarray, P: dict) -> None:
    """物体掩膜变了之后就地刷新地面掩膜与地面零点(不重跑昂贵的 (a,b) 网格搜索——
    标定是在已经 98%+ 干净的掩膜上拟合的,补判那点残差不足以挪动全局解)。"""
    theta = cal['theta']
    gm = _ground_mask_from(cal['d'], cal['qy'], theta, P['ground_up_dot'], prior=~objects)
    if not gm.any():
        return
    # 地面中位高度重新归零(与 stage_calibrate 末尾同式,这里补增量)
    o = float(np.median(cal['qy'][gm] / math.tan(theta) - cal['d'][gm]))
    cal['d'] = (cal['d'] + o).astype(np.float32)
    cal['Y'] = (cal['qy'] * math.cos(theta) - cal['d'] * math.sin(theta)).astype(np.float32)
    cal['ground_mask'] = gm
    cal['depth_shift'] = cal.get('depth_shift', 0.0) + o
    cal['ground_y_p95'] = float(np.percentile(np.abs(cal['Y'][gm]), 95))


def check_geometry_sanity(cal: dict, lay: dict, objects: np.ndarray, status=print) -> None:
    """烘焙期几何自检:把「结构相对地面的抬升」折算成屏幕表观高度,与画幅高比。

    **画面里的东西不可能比画面本身还高。** 越界就说明这一层出了问题——俯角填错、
    深度尺度失控,或单目近端被反比映射放飞(temple 曾出现屋檐折算「离地 3300px」
    而画幅只有 1143px)。这个判据尺度无关、不依赖任何人工标注,烘一次就顺手验一次。

    只报警不阻断:重建有救不回来的场景,值不值得用是人的判断。
    """
    Hg, _ = cal['d'].shape
    rise_px = (cal['Y'] - lay['Yg']) * math.cos(cal['theta']) * cal['ppu']
    p99 = float(np.percentile(rise_px, 99))
    over = float(np.mean(rise_px > Hg))
    msg = (f'[sanity] 结构表观高度 p99={p99:.0f}px / 画幅 {Hg}px = {p99 / Hg:.2f}×, '
           f'超画幅像素 {over * 100:.1f}%')
    if p99 > 1.5 * Hg or over > 0.05:
        status(f'{msg}  ⚠ 越界:重建的近端被放飞,遮挡会把角色整片吞掉。'
               f'检查俯角/深度缩放,或看是不是物体识别漏了大块结构')
    else:
        status(msg + '  ✓')
    if objects is not None and objects.any():
        # 物体像素相对地面的抬升中位:纯诊断,给人看的量,不设阈值
        med = float(np.median(rise_px[objects]))
        status(f'[sanity] 物体像素抬升中位 {med:.0f}px = 画幅 {med / Hg * 100:.1f}%')


def stage_layers(cal: dict, rgb_lin: np.ndarray, P: dict) -> dict:
    """Occluder pop-out detection, thickness, hidden background inpaint,
    ground field extension (non-planar)."""
    d = cal['d']; Hg, Wg = d.shape
    theta = cal['theta']; ppu = cal['ppu']
    drange = float(d.max() - d.min() + 1e-6)
    tau = P['occluder_tau'] * drange

    size = max(9, int(Wg / 10) | 1)
    bg_close = grey_closing(d, size=(size, size))
    occ = (bg_close - d) > tau
    occ &= ~cal['ground_mask']
    occ = binary_closing(occ, np.ones((3, 3)))
    occ = binary_fill_holes(occ)

    # thickness per component (q units)
    thick = np.zeros_like(d)
    lab, nl = label(occ)
    for i in range(1, nl + 1):
        ys, xs = np.where(lab == i)
        if len(ys) < 20:
            occ[ys, xs] = False
            continue
        mind = min(xs.max() - xs.min(), ys.max() - ys.min()) + 1
        thick[ys, xs] = np.clip(P['thickness_k'] * mind / ppu, 0.05, 2.5)

    # ground world-height field, extended everywhere (NON-PLANAR)
    Yg = laplace_inpaint(cal['Y'], cal['ground_mask'], iters=300)
    Yg = gaussian_filter(Yg, 2.0)
    # walk-surface depth along each pixel ray: Y(q)=qy c - d s = Yg -> d
    d_walk = (cal['qy'] * math.cos(theta) - Yg) / math.sin(theta)

    # hidden background layer: depth+color diffused from non-occluded neighbours
    known = ~occ
    d_bg = laplace_inpaint(d, known, iters=300)
    d_bg = np.maximum(d_bg, d + thick + 0.02)          # stay behind the occluder
    d_bg = np.minimum(d_bg, d_walk + 0.02)             # never beyond the ground
    c_bg = np.stack([laplace_inpaint(rgb_lin[..., c], known, iters=200) for c in range(3)], -1)

    return dict(occ=occ, thick=thick.astype(np.float32), Yg=Yg.astype(np.float32),
                d_walk=d_walk.astype(np.float32), d_bg=d_bg.astype(np.float32),
                c_bg=c_bg.astype(np.float32))


def _hdr_recover(linear: np.ndarray, conf: np.ndarray, method: int, pa: float, max_ev: float) -> np.ndarray:
    """LDR→HDR 恢复:全图 rad(display-linear HDR)。与查看器 hdrRad() 逐式对应,
    保证"实验室预览的方法 = 烘焙用的方法"。method:0 emitter门 / 1 逆Reinhard /
    2 全局gamma / 3 亮度扩展。pa=方法参数,max_ev=HDR最大EV。"""
    lum = np.maximum(linear @ LUMA_W, 1e-5)[..., None]
    if method == 1:            # 逆Reinhard 全局高光展开(Banterle 式)
        k = float(np.clip(pa, 0.0, 0.985))
        return (linear / np.maximum(1.0 - k * lum, 0.015)).astype(np.float32)
    if method == 2:            # 全局 gamma 展开
        g = 1.0 + (0.34 - 1.0) * float(np.clip(pa, 0.0, 1.0))   # mix(1, 0.34, pa)
        return (np.power(np.maximum(linear, 0.0), g) * (2.0 ** (max_ev * 0.12))).astype(np.float32)
    if method == 3:            # 亮度扩展映射(Rempel/Banterle 式)
        lo = float(np.clip(pa, 0.0, 0.9))
        e = smoothstep(lo, min(lo + 0.35, 1.0), lum)
        return (linear * (1.0 + (2.0 ** max_ev - 1.0) * e)).astype(np.float32)
    # 0 emitter门(conf 驱动;当前保守法)
    return (linear * np.power(2.0, max_ev * np.power(conf, 0.72))[..., None]).astype(np.float32)


def stage_hdr(rgb_srgb: np.ndarray, P: dict, sem_gate: np.ndarray | None = None) -> dict:
    """LDR→HDR 恢复 + 语义分离(2026-07-23 重做)。

    架构(用户拍板):①按选定方法把整张 LDR 恢复成 HDR `rad`;②`mask` = **纯 SAM3
    语义分割**(哪些像素是发光物体,零亮度参与);③`emit = rad × mask`(直接光源)、
    `base = rad × (1−mask)`(背景照明)。两张一路带到体素/probe。
    ⚠ 语义 mask 绝不能掺亮度——emitter conf 只作方法0的恢复驱动与 gain场可视化,不当 mask。"""
    linear = srgb_to_linear(rgb_srgb)
    print(f'[hdr] 恢复方法 {int(P.get("hdr_method", 0))} '
          f'(pa={float(P.get("hdr_pa", 0.7)):.2f}, maxEV={float(P.get("max_gain_ev", 0)):.2f})',
          flush=True)
    luma100 = (linear @ LUMA_W) * 100.0
    # emitter 置信度(仅方法0恢复 + gain场热力;不乘语义,不当 mask)
    log_l = np.log2(np.maximum(luma100, 0.03))
    w = luma100.shape[1]
    ls = log_l - gaussian_filter(log_l, sigma=max(1.2, w / 320.0), mode='reflect')
    ll = log_l - gaussian_filter(log_l, sigma=max(4.0, w / 70.0), mode='reflect')
    local = smoothstep(0.18, 0.90, ls) * smoothstep(0.55, 2.10, ll)
    p50, p99, p9999 = np.percentile(luma100, [50, 99, 99.99])
    broad = float(np.mean(luma100 > 28.0) * 100.0)
    daylight = max(float(smoothstep(0.80, 3.0, np.float32(broad))),
                   float(smoothstep(4.0, 12.0, np.float32(p50))))
    absb = smoothstep(12.0, 60.0, luma100)
    relb = smoothstep(float(p99), max(float(p99) + 1e-4, float(p9999)), luma100)
    conf = np.clip((1.0 - daylight) * local * np.maximum(absb, relb * 0.72), 0, 1)

    # ① 恢复:全图 rad(方法可选)
    method = int(P.get('hdr_method', 0))
    pa = float(P.get('hdr_pa', 0.7))
    max_ev = float(P['max_gain_ev'])
    rad = _hdr_recover(linear, conf, method, pa, max_ev)

    # ② 语义 mask(纯 SAM3;无门控则空 mask=无直接光,全归背景)
    if sem_gate is not None:
        mask = np.clip(sem_gate, 0, 1).astype(np.float32)
    else:
        mask = np.zeros(luma100.shape, np.float32)
        print('[hdr] ⚠ 无语义门控(SAM3)→ 无直接光 mask,全辐射归背景。'
              '开「语义门控」重烘才能分离光源。')

    # ③ 分离:emit=直接光源、base=背景照明
    m3 = mask[..., None]
    emit = (rad * m3).astype(np.float32)
    base = (rad * (1.0 - m3)).astype(np.float32)

    # gain_ev 场(供 gain场缩略图:方法0=真实提升,其余给展开量指示)
    gain_ev = (max_ev * np.power(conf, 0.72)).astype(np.float32)

    def hist(vals, lo=-6.0, hi=6.0, bins=64):
        h, _ = np.histogram(np.log2(np.maximum(vals, 1e-4)), bins=bins, range=(lo, hi))
        return (h / max(h.max(), 1)).round(4).tolist()

    luma_out = (rad @ LUMA_W) * 100.0
    stats = dict(
        p50_nits=float(p50), p99_nits=float(p99), daylight_score=daylight,
        hdr_method=method,
        emitter_pixel_pct=float(np.mean(conf > 0.35) * 100.0),
        mask_pixel_pct=float(np.mean(mask > 0.35) * 100.0),
        max_gain_applied_ev=float(gain_ev.max()),
        hist_pre=hist(luma100 / 100.0), hist_post=hist(luma_out / 100.0),
        hist_lo=-6.0, hist_hi=6.0,
    )
    return dict(rad=rad, base=base, emit=emit, mask=mask,
                gain_ev=gain_ev.astype(np.float32), stats=stats)


def stage_voxelize(cal: dict, lay: dict, base_front: np.ndarray, emit_front: np.ndarray,
                   base_bg: np.ndarray, P: dict) -> dict:
    """Dual radiance fields for the NEE split: base (painting, all real bounces)
    and emit (synthetic emissive delta). base+emit == old full radiance."""
    d = cal['d']; Hg, Wg = d.shape
    ppu = cal['ppu']; cx, cy = cal['cx'], cal['cy']
    qx_min, qx_max = (0 - cx) / ppu, (Wg - 1 - cx) / ppu
    qy_min, qy_max = (cy - (Hg - 1)) / ppu, (cy - 0) / ppu
    z_lo = float(min(d.min(), lay['d_walk'].min()));  z_hi = float(max((d + lay['thick']).max(), lay['d_walk'].max()))
    zr = z_hi - z_lo
    qz_min, qz_max = z_lo - 0.10 * zr, z_hi + 0.15 * zr

    Nx = int(P['vol_nx']); Nz = int(P['vol_nz'])
    Ny = max(16, round(Nx * (qy_max - qy_min) / (qx_max - qx_min)))
    occ3 = np.zeros((Nz, Ny, Nx), bool)
    rad3 = np.zeros((Nz, Ny, Nx, 3), np.float32)
    emi3 = np.zeros((Nz, Ny, Nx, 3), np.float32)
    wgt3 = np.zeros((Nz, Ny, Nx), np.float32)

    sxg, syg = np.meshgrid(np.arange(Wg, dtype=np.float32), np.arange(Hg, dtype=np.float32))
    qx = (sxg - cx) / ppu
    qyp = (cy - syg) / ppu
    ix = np.clip(((qx - qx_min) / (qx_max - qx_min) * (Nx - 1)).round().astype(np.int32), 0, Nx - 1)
    iy = np.clip(((qyp - qy_min) / (qy_max - qy_min) * (Ny - 1)).round().astype(np.int32), 0, Ny - 1)

    def z_of(q):  # q depth -> float z index
        return (q - qz_min) / (qz_max - qz_min) * (Nz - 1)

    zg = np.arange(Nz, dtype=np.float32)[:, None, None]

    def paint(z0, z1, col, emit=None, only=None):
        m3 = (zg >= z_of(z0)[None]) & (zg <= z_of(z1)[None])   # (Nz,Hg,Wg)
        if only is not None:
            m3 &= only[None]
        zi, yi, xi = np.where(m3)
        occ3[zi, iy[yi, xi], ix[yi, xi]] = True
        np.add.at(rad3, (zi, iy[yi, xi], ix[yi, xi]), col[yi, xi])
        if emit is not None:
            np.add.at(emi3, (zi, iy[yi, xi], ix[yi, xi]), emit[yi, xi])
        np.add.at(wgt3, (zi, iy[yi, xi], ix[yi, xi]), 1.0)

    t_front = np.where(lay['occ'], lay['thick'], P['bg_thickness_q']).astype(np.float32)
    paint(d, d + t_front, base_front, emit=emit_front)
    paint(lay['d_bg'], lay['d_bg'] + P['bg_thickness_q'], base_bg, only=lay['occ'])
    gcol = np.where(lay['occ'][..., None], base_bg, base_front)
    paint(np.maximum(lay['d_walk'], d - 0.01), np.full_like(d, qz_max), gcol)

    nz = wgt3 > 0
    rad3[nz] /= wgt3[nz][..., None]
    emi3[nz] /= wgt3[nz][..., None]
    print(f'[voxel] grid {Nx}x{Ny}x{Nz}, solid {occ3.mean()*100:.1f}%, '
          f'emit voxels {(emi3.max(-1) > 1e-4).mean()*100:.2f}%')
    return dict(occ3=occ3, rad3=rad3, emi3=emi3, Nx=Nx, Ny=Ny, Nz=Nz,
                qx_min=qx_min, qx_max=qx_max, qy_min=qy_min, qy_max=qy_max,
                qz_min=qz_min, qz_max=qz_max)


# ---------------------------------------------------------------------------
# 2026-09-01 删除:`_ray_box_enter` / `_trace` / `_gather_at` —— 体素 DDA 那一套。
# probe gather 改走 `trace.py` 的唯一 tracer(直接 march 深度场,亚像素步长,
# 三条精确终止),体素 index 空间里 0.9 步长 + round 采样会整段跳过 1 体素厚的墙。
# 体素卷本身**没删**(`stage_voxelize` 照旧产 vol_rad/vol_emit),运行时 RT 模式还在读。
# ---------------------------------------------------------------------------

def stage_lights(cal: dict, lay: dict, emit_front: np.ndarray, wb: dict, P: dict,
                 luma_tau=2e-3, max_lights=48, split_wu=0.9) -> list[dict]:
    """Extract explicit NEE light surfels from the emissive delta field:
    connected components of emit luminance, split when larger than split_wu,
    kept by power, described in WORLD space (pos/normal/radiance/area)."""
    Hg, Wg = cal['d'].shape
    ppu, cx, cy = cal['ppu'], cal['cx'], cal['cy']
    M = wb['M']
    lum = emit_front @ LUMA_W
    mask = lum > luma_tau
    if not mask.any():
        return []
    lab, nl = label(mask)
    d = cal['d']
    d_su = np.gradient(d, axis=1); d_sv = np.gradient(d, axis=0)
    px_area = (1.0 / ppu) ** 2                       # world area per pixel (approx)
    sxg, syg = np.meshgrid(np.arange(Wg, dtype=np.float32), np.arange(Hg, dtype=np.float32))

    def make_surfel(ys, xs):
        w = lum[ys, xs]
        wsum = float(w.sum())
        if wsum <= 0:
            return None
        q = np.stack([(xs - cx) / ppu, (cy - ys) / ppu, d[ys, xs]], -1)
        Xw = q @ M.T
        pos = (Xw * w[:, None]).sum(0) / wsum
        # height-field normal in q, averaged, -> world
        dqx = d_su[ys, xs] * ppu; dqy = -d_sv[ys, xs] * ppu
        nq = np.stack([-dqx, -dqy, -np.ones_like(dqx)], -1)
        nq /= np.linalg.norm(nq, axis=-1, keepdims=True)
        nw = (nq @ M.T).mean(0)
        nw /= max(np.linalg.norm(nw), 1e-6)
        area = len(ys) * px_area
        Lrgb = emit_front[ys, xs].mean(0)            # mean emissive radiance
        power = float((emit_front[ys, xs] @ LUMA_W).sum() * px_area)
        return dict(pos=[float(v) for v in pos], normal=[float(v) for v in nw],
                    radiance=[float(v) for v in Lrgb], area=float(area), power=power)

    surfels = []
    for i in range(1, nl + 1):
        ys, xs = np.where(lab == i)
        if len(ys) < 3:
            continue
        # world-size split: big components (windows) become a grid of surfels
        q = np.stack([(xs - cx) / ppu, (cy - ys) / ppu, d[ys, xs]], -1)
        Xw = q @ M.T
        ext = Xw.max(0) - Xw.min(0)
        nsx = max(1, int(np.ceil(ext[0] / split_wu)))
        nsy = max(1, int(np.ceil(max(ext[1], ext[2]) / split_wu)))
        if nsx * nsy == 1:
            s = make_surfel(ys, xs)
            if s: surfels.append(s)
        else:
            gx = np.clip(((Xw[:, 0] - Xw[:, 0].min()) / max(ext[0], 1e-6) * nsx).astype(int), 0, nsx - 1)
            key = np.clip(((Xw[:, 1] - Xw[:, 1].min()) / max(ext[1], 1e-6) * nsy).astype(int), 0, nsy - 1) * nsx + gx
            for k in np.unique(key):
                m = key == k
                if m.sum() < 3: continue
                s = make_surfel(ys[m], xs[m])
                if s: surfels.append(s)
    surfels.sort(key=lambda s: -s['power'])
    surfels = surfels[:max_lights]
    print(f'[lights] {len(surfels)} NEE surfels, total power {sum(s["power"] for s in surfels):.3f}')
    return surfels


def stage_ambient(escape_of, P: dict) -> dict:
    """逃逸辐射的 SH-L2 投影 —— 运行时 `uAmbSH`(**辐亮度**系数,A_l 在着色器里乘)。

    2026-09-01 重写。旧实现是 J̄:在 3 个点各射 768 条进体素卷,把命中到的辐射
    平均成一个全局 SH,当作「miss 方向该收到多少光」。两个问题:

    1. **它是从画面反推逃逸辐射的**。射线已经离开伪世界了,画面里没有任何东西
       能回答它带走多少辐射。`lighting-rebuild` 的设计文档为这类做法记过一次
       翻车(`estimate_sky_radiance`),明令不许以任何形式复活。
    2. 命中率只有 60~70%,也就是**每颗 probe 有 30~40% 的方向吃同一个全局常数**,
       叠上 SH-L2 的低频截断 ⇒ 平。

    现在它就是 `escape.make_escape_sampler` 给的那个剖面的球谐投影 ——
    逃逸辐射是**烘焙期的自由输入**(缺省纯黑),probe 与 RT 两条路吃同一份。
    """
    dirs = fib_sphere(4096)          # 纯求积节点,不 march
    L = np.asarray(escape_of(dirs), np.float64)
    B = sh_basis(dirs).astype(np.float64)
    sh = (B[:, :, None] * L[:, None, :]).mean(0) * (4.0 * math.pi)
    mean = L.mean(0)
    print(f'[ambient] 逃逸辐射 {_escape_desc(P)}  mean {np.round(mean, 4)}')
    return dict(sh=sh.astype(np.float32), mean=mean.astype(np.float32),
                hit_fraction=0.0)


def _escape_desc(P: dict) -> str:
    from tools.character_lighting_lab.escape import describe
    return describe(P.get('escape'))


A_L = np.array([math.pi, 2.0 * math.pi / 3.0, math.pi / 4.0], np.float32)


def world_bounds(cal: dict, lay: dict, P: dict, band: float | None = None,
                 char_wu: float | None = None, height_chars: float = 2.0) -> dict:
    """probe 盒的世界 AABB。x/z 取地面片的世界范围;**y 的高度 = 角色身高 x height_chars**。

    制作人 2026-09-01:「这个 probe 总高度就不应该覆盖全场景最高点,
    而是只覆盖角色身高的 2 倍即可。」

    盒高是**显式的常数倍角色高**,不再由「地面起伏 + band」拼出来:后者在起伏大的
    场景里会把盒子撑高,层距被稀释,而多出来的那一截**根本没有角色**。
    `world_top`(画面最高点)只留作诊断打印,不参与定界。

    历史(别再走回去):
    - 最早写死 `probe_band = 1.6 wu`,建立在「角色高 1.5 wu」的假设上,而实测
      角色 **0.17~0.97 wu** —— 6 层里 5 层烘在够不着的空中(纵向跨 0.48 层);
    - 接着改成 `g98 + band`,盒高变成「地面起伏 + 一个角色高」——比 1.6 好得多,
      但仍然让起伏决定盒高,起伏大的场景照样稀释;
    - 现在:盒高 = `height_chars x char_wu`,与场景起伏解耦。
      起伏大到兜不住时**大声报**,不默默把上半身钳到顶层。
    """
    theta = cal['theta']
    M = world_matrix(theta, math.radians(float(P.get('azimuth_deg', 0.0))))
    Hg, Wg = cal['d'].shape
    ppu, cx, cy = cal['ppu'], cal['cx'], cal['cy']
    sxg, syg = np.meshgrid(np.arange(Wg, dtype=np.float32), np.arange(Hg, dtype=np.float32))
    qx = (sxg - cx) / ppu
    qyp = (cy - syg) / ppu
    # ground surface in world (every pixel: extended walk surface)
    q_ground = np.stack([qx, qyp, lay['d_walk']], -1).reshape(-1, 3)
    Xg = q_ground @ M.T
    Yg = lay['Yg']
    x0, x1 = float(Xg[:, 0].min()), float(Xg[:, 0].max())
    z0, z1 = float(Xg[:, 2].min()), float(Xg[:, 2].max())
    # 世界最高点 = 可见前表面的世界 Y 上界(P99.9 去掉单像素噪点毛刺),只用作常识上界
    Yfront = (np.stack([qx, qyp, cal['d']], -1).reshape(-1, 3) @ M.T)[:, 1]
    world_top = float(np.percentile(Yfront, 99.9))
    g02, g50, g98 = (float(v) for v in np.percentile(Yg, [2, 50, 98]))
    # 角色最大活动高度(地面往上)。2026-09-01 起由调用方按**角色实高**推出后传进来;
    # P['probe_band'] 只是显式覆写(缺省 None)。写死 1.6 的老路见 DEFAULTS 的警告。
    if band is None:
        band = P.get('probe_band')
    if band is None:
        raise ValueError('world_bounds: 缺 band —— 调用方要按角色实高推出再传进来'
                         '(probe_layout 的语义),不许回落到写死的 1.6')
    band = float(band)
    # ⚠ 2026-09-01:这四个边界原本写死为 0.15 / 0.30 / 3.0 / 0.80 wu ——
    #   与 `probe_band=1.6` 同源,全是按「角色高 1.5 wu」定的。角色实高 0.17~0.97 wu 时
    #   它们**反而成为约束**:band 缩到 0.20 了,`y0+0.80` 那条硬地板又把盒子撑回 0.8 wu,
    #   6 层里照样有 4 层烘在够不着的空中,密度旋钮被静默架空。
    #   现在一律按 band 表达 —— 括号里是旧值除以旧 band(1.6)得到的同一比例。
    # ---- 盒高 = **地面起伏 + 角色身高 x height_chars**(制作人 2026-09-01 定)----
    # 上界跟的是**地面**(P98),不是画面最高点 —— 「不覆盖全场景最高点」的意图保住了;
    # 但盒子必须把「站在最高地面上的人」整个装进去,否则他上半身落到网格外被钳到顶层
    # (旧 probe 系统的原病)。
    #
    # ⚠ 纯 `height_chars x char` 的写法**不够**:实测 bridge_underpass 地面起伏
    #   0.374 wu 已经超过「角色 0.170 x2 = 0.341」的盒高,站高处的角色整个人在盒外。
    #   平地场景(雾津街头起伏 0.121)看不出来,有坡的场景直接翻车。
    char_h = float(char_wu) if char_wu else float(band)
    head_room = float(height_chars) * char_h      # 最高地面之上要留几个角色高
    y0 = g02 - 0.05 * char_h                      # 脚下留一点(人站地面上,地下没人)
    y1 = g98 + head_room
    relief = g98 - g02
    fits = '✓' if y1 >= g98 + char_h - 1e-6 else '⚠ 头顶仍被钳(不该发生,查 g98)'
    print(f'[bounds] 地面 P2/P50/P98 {g02:.3f}/{g50:.3f}/{g98:.3f}  '
          f'起伏 {relief:.3f}  世界最高点 {world_top:.2f}(仅诊断)')
    print(f'[bounds] 盒高 = 起伏 {relief:.3f} + 角色 {char_h:.3f}x{height_chars:g} = '
          f'{y1-y0:.3f} wu  → probe 盒 y[{y0:.3f},{y1:.3f}]  {fits}')
    return dict(M=M, x0=x0, x1=x1, y0=y0, y1=y1, z0=z0, z1=z1)


def _world_to_volidx(Xw: np.ndarray, wb: dict, vol: dict) -> np.ndarray:
    q = Xw @ wb['M']            # M orthonormal: inverse = transpose; X@M == (M.T@X.T).T
    ix = (q[..., 0] - vol['qx_min']) / (vol['qx_max'] - vol['qx_min']) * (vol['Nx'] - 1)
    iy = (q[..., 1] - vol['qy_min']) / (vol['qy_max'] - vol['qy_min']) * (vol['Ny'] - 1)
    iz = (q[..., 2] - vol['qz_min']) / (vol['qz_max'] - vol['qz_min']) * (vol['Nz'] - 1)
    return np.stack([ix, iy, iz], -1).astype(np.float32)


def _nee_visible(pts_q: np.ndarray, light_q: np.ndarray, field) -> np.ndarray:
    """(n,) bool:每颗 probe 到某个光源 surfel 的可见性。走**唯一 tracer**。

    2026-09-01 取代 `_visible_to`(体素 index 空间里 0.9 体素步长 + round 采样,
    1 体素厚的墙会被整段跳过)。与 gather 用的是同一套 bias/步长,不会出现
    「gather 说挡了、NEE 说没挡」这种自相矛盾。

    ⚠ **射线照样无限长**。「灯背后的东西挡不住这盏灯」是对 `t_hit` 的**事后过滤**,
    不是给 tracer 传射程 —— tracer 没有射程参数,也不该有(见 trace.py)。
    过滤写在这里、看得见;塞进 tracer 就变成了它的固有性质,下一个人抄走就错了。
    """
    from tools.character_lighting_lab.trace import trace as _tr
    delta = light_q[None, :] - pts_q
    dist = np.linalg.norm(delta, axis=1)
    ok = dist > 1e-6
    vis = np.ones(len(pts_q), bool)
    if not ok.any():
        return vis
    d = np.ascontiguousarray(delta[ok] / dist[ok, None], np.float32)
    res = _tr(np.ascontiguousarray(pts_q[ok]), d, field)
    # 事后过滤:挡光的只算「在灯之前」命中的(0.98 留一点自遮蔽余量)
    vis[ok] = res.escaped | (res.t_hit >= dist[ok] * 0.98)
    return vis


def stage_probes(cal: dict, lay: dict, hdr: dict, wb: dict, lights: list[dict],
                 P: dict, escape_of, char_wu: float) -> dict:
    """probe 体的方向化辐照度 —— 蒙特卡洛 gather + 唯一 tracer。

    2026-09-01 重写。**载荷形式一字未动**(仍是 20 项 f16 图集 + valid + world_pos,
    `export_runtime` 与运行时着色器都不用改),换的全是怎么算:

    | | 旧 | 新 |
    |---|---|---|
    | 场景表示 | 192x107x64 占据体素(深度壳挤出的板) | 直接 march 深度场,亚像素步长 |
    | 求交 | 0.9 体素定步长 + round 采样 | `trace.py` 唯一 tracer,三条精确终止 |
    | 方向 | 196 条 Fibonacci,**所有 probe 共用同一批** | 分层 QMC + 位置哈希抖动 |
    | 朝相机的射线 | `fold`:qz 取绝对值掰到背面 | 老实逃逸,取 `escape_of` |
    | miss | 全局 J̄(从画面反推) | 逃逸辐射模块(缺省纯黑) |
    | 埋在几何里的 probe | 吸附到最近实心 + `valid` 恒 1 | 剔除不 march + **dilation 填** |
    | 分布 | 写死 20x6x14 / band 1.6 wu | `probe_layout` 模块,密度可调 |

    ## 为什么删掉 `fold`

    旧写法 `dirs[:,2] = abs(dirs[:,2])` 把朝相机那半球的射线全掰到背面,
    于是「正面的光 = 背面的光镜像」。角色站在亮窗户前面,脸上是身后墙的颜色。
    那不是近似,是编造 —— 伪世界确实不知道相机这一侧有什么,正确答案是
    「按逃逸处理,拿烘焙期给定的逃逸辐射」,而不是照镜子。

    ## 为什么不再做实心吸附

    旧写法把埋在几何里的 probe **挪到**最近的空心格再采样,但载荷里记的还是
    原格点的位置 —— 运行时三线性按原格点插值,拿到的却是别处采的值。
    现在:埋了就不采(精确的 0),交给 `dilate_invalid` 用有效邻居填。
    这是 AAA 探针体系的标准做法(Unity Dilation / UE validity)。
    """
    from tools.character_lighting_lab.const import GATHER_SEED
    from tools.character_lighting_lab.estimators import gather_probe, sh_basis as _shb
    from tools.character_lighting_lab.estimators import octa_bin_normals
    from tools.character_lighting_lab.probe_layout import build_layout, dilate_invalid
    from tools.character_lighting_lab.trace import DepthField, buried

    M = wb['M']
    field = DepthField.build(cal['d'], cal['ppu'], cal['cx'], cal['cy'])

    # ---- 布点(策略可换;盒沿用 world_bounds 那一个,别在这再算第二份)----
    Hg, Wg = cal['d'].shape
    sxg, syg = np.meshgrid(np.arange(Wg, dtype=np.float32),
                           np.arange(Hg, dtype=np.float32))
    q_ground = np.stack([(sxg - cal['cx']) / cal['ppu'],
                         (cal['cy'] - syg) / cal['ppu'],
                         lay['d_walk']], -1).reshape(-1, 3)
    world_surface = (q_ground @ M.T).astype(np.float32)
    layout = build_layout(
        str(P.get('probe_strategy', 'uniform_grid')), world_surface, char_wu,
        dims=P.get('probe_dims'),
        band=P.get('probe_band'),
        bounds={k: float(wb[k]) for k in ('x0', 'x1', 'y0', 'y1', 'z0', 'z1')},
        cells_per_char_xz=float(P.get('probe_cells_per_char_xz', 4.0)),
        cells_per_char_y=float(P.get('probe_cells_per_char_y', 2.0)),
        height_chars=float(P.get('probe_height_chars', 2.0)),
        max_probes=int(P.get('probe_max', 200_000)))
    Nx, Ny, Nz = layout.grid
    world_pos = layout.world_pos
    pts_q = np.ascontiguousarray(world_pos @ M, np.float32)   # world -> q(M 正交)

    # ---- validity:埋在可见壳后面的格点根本不 march(算了也会被 dilation 覆盖)----
    inv = buried(pts_q, field)
    act = ~inv
    n = len(pts_q)
    spp = int(P.get('probe_spp', PROBE_SPP))
    t0 = time.time()
    # NEE 光源表:base+emit 合并亮度建表(发光能量在哪张图里都被选取密度覆盖);
    # 没有阈上发光体 → None → 纯 BSDF 老路,逐位不变。
    nee_ctx = None
    if bool(P.get('probe_nee', True)):
        from tools.character_lighting_lab.nee import build_nee
        nee_ctx = build_nee(np.asarray(hdr['base'], np.float32)
                            + np.asarray(hdr['emit'], np.float32), field,
                            threshold=float(P.get('probe_nee_threshold', 1.0)))
    clamp = P.get('probe_clamp')
    clamp = float(clamp) if clamp is not None else None
    g = gather_probe(np.ascontiguousarray(pts_q[act]), M, field,
                     {'base': hdr['base'], 'emit': hdr['emit']},
                     escape_of, spp=spp, nee_ctx=nee_ctx, clamp=clamp)

    # ---- 自适应细化(无偏):高方差格独立流重采,按样本数加权合并 ----
    refine_rel = float(P.get('probe_refine_rel', 0.05))
    refine_mult = int(P.get('probe_refine_mult', 4))
    refine_frac = float(P.get('probe_refine_frac', 0.15))
    n_ref = 0
    if refine_rel > 0 and refine_mult > 1:
        from tools.character_lighting_lab.nee import LUMA as _LU
        dc_act = np.maximum(g['base']['sh'][:, 0, :] @ _LU, 1e-6)
        rel = np.sqrt(np.maximum(g['dc_var'], 0.0)) / dc_act
        sel = rel > refine_rel
        cap = max(1, int(refine_frac * len(dc_act)))
        if int(sel.sum()) > cap:
            thr = np.partition(rel, -cap)[-cap]
            sel = rel >= thr
        n_ref = int(sel.sum())
        if n_ref:
            pts_sel = np.ascontiguousarray(pts_q[act][sel])
            spp2 = spp * (refine_mult - 1)      # 合并后总样本 = spp*mult
            g2 = gather_probe(pts_sel, M, field,
                              {'base': hdr['base'], 'emit': hdr['emit']},
                              escape_of, spp=spp2, nee_ctx=nee_ctx,
                              clamp=clamp, seed=GATHER_SEED ^ 0x9E3779B9)
            w1 = spp / (spp + spp2)
            w2 = spp2 / (spp + spp2)
            for k in ('base', 'emit', 'esc', 'cov'):
                for part in ('sh', 'bins'):
                    g[k][part][sel] = (w1 * g[k][part][sel]
                                       + w2 * g2[k][part])
            g['dc_var'][sel] = (w1 * w1 * g['dc_var'][sel]
                                + w2 * w2 * g2['dc_var'])

    nb = octa_bin_normals()
    B = len(nb)

    def _scatter(a_act: np.ndarray) -> np.ndarray:
        """活格子集的结果散回全量(被埋格留 0,随后由 dilation 填)。"""
        out = np.zeros((n, *a_act.shape[1:]), np.float32)
        out[act] = a_act
        return out

    sh_base = _scatter(g['base']['sh'])
    sh_emit = _scatter(g['emit']['sh'])
    sh_amb = _scatter(g['esc']['sh'])
    sh_cov = _scatter(g['cov']['sh'])
    bn_base = _scatter(g['base']['bins'])
    bn_emit = _scatter(g['emit']['bins'])
    bn_amb = _scatter(g['esc']['bins'])
    bn_cov = _scatter(g['cov']['bins'])
    dc_var = np.zeros(n, np.float64)
    dc_var[act] = g['dc_var']

    # ---- 重建层:3D 联合双边(只滤有效格,引导=主 E 的 DC 亮度;cov/解析灯不滤)----
    fit = int(P.get('probe_filter_iters', 2))
    if fit > 0 and act.any():
        from tools.character_lighting_lab.denoise import filter_probe_grid
        from tools.character_lighting_lab.nee import LUMA as _LUMA
        guide = (sh_base[:, 0, :] @ _LUMA).astype(np.float64)
        (sh_base, sh_emit, sh_amb,
         bn_base, bn_emit, bn_amb) = filter_probe_grid(
            [x.reshape(Nx, Ny, Nz, *x.shape[1:]) for x in
             (sh_base, sh_emit, sh_amb, bn_base, bn_emit, bn_amb)],
            guide, act, (Nx, Ny, Nz), iters=fit, dc_var=dc_var)
        (sh_base, sh_emit, sh_amb, bn_base, bn_emit, bn_amb) = [
            x.reshape(n, *x.shape[3:]) for x in
            (sh_base, sh_emit, sh_amb, bn_base, bn_emit, bn_amb)]

    # ---- NEE:光源 surfel 的解析直射项(仍是分账,运行时 shading.nee 才启用)----
    # ⚠ 2026-09-01 修:旧实现把**世界系**方向 `d_i` 投到与 base/emit 同一组
    #   球谐上,而那组球谐是 **q 空间**的(着色器用 q 空间法线查)。两个空间混投
    #   一律不报错,只是方向全拧。当前 28 个场景 `shading.nee=0` 走的是 emit 分账,
    #   所以没暴露出来 —— 谁把 nee 打开就正中 CLAUDE.md 铁律 0 那一类。
    nee_sh = np.zeros((n, 9, 3), np.float32)
    nee_bins = np.zeros((n, B, 3), np.float32)
    for li in lights:
        lpos = np.array(li['pos'], np.float32)
        Le = np.array(li['radiance'], np.float32)
        delta = lpos[None] - world_pos
        r2 = np.maximum((delta ** 2).sum(1), 0.04)
        d_w = delta / np.sqrt(r2)[:, None]                    # 世界方向
        d_q = (d_w @ M).astype(np.float32)                    # -> q 空间(投影就在这)
        vis = _nee_visible(pts_q, (lpos @ M).astype(np.float32), field).astype(np.float32)
        # 各向同性 surfel(火焰/窗口朝各个方向发光),小球截面 A/r^2
        W = (vis * li['area'] / r2)[:, None] * Le[None]
        nee_sh += (_shb(d_q) * AK[None, :])[:, :, None] * W[:, None, :]
        nee_bins += np.maximum(d_q @ nb.T, 0.0)[:, :, None] * W[:, None, :]

    # ---- dilation:被埋格点用 6-邻域有效格的均值填(必做,见 probe_layout)----
    def _g3(a):
        return a.reshape(Nx, Ny, Nz, *a.shape[1:])
    fields = [_g3(x) for x in (sh_base, sh_emit, sh_amb, sh_cov,
                               bn_base, bn_emit, bn_amb, bn_cov,
                               nee_sh, nee_bins)]
    filled, iters = dilate_invalid(act.reshape(Nx, Ny, Nz), fields)
    coverage = float(act.mean())
    valid = filled.reshape(-1)

    # ---- 组装成载荷的 20 项(布局与旧版逐字段一致)----
    E_l1 = np.concatenate([sh_base[:, :4], sh_cov[:, :4, None]], -1)     # (P,4,4)
    E_l2 = np.concatenate([sh_base, sh_cov[:, :, None]], -1)             # (P,9,4)
    E_bins = np.concatenate([bn_base, bn_cov[..., None]], -1)            # (P,B,4)

    print(f'[probes] {n} 颗 x {spp}spp  {time.time()-t0:.1f}s  '
          f'分布={layout.strategy}  {Nx}x{Ny}x{Nz}  '
          f'NEE={"开" if nee_ctx is not None else "关"}  细化 {n_ref} 格')
    print(f'[probes] {layout.note}')
    print(f'[probes] 命中率 {g["hit_rate"]*100:.1f}%  有效格 {coverage*100:.1f}% '
          f'(dilation {iters} 轮补到 {valid.mean()*100:.1f}%)  '
          f'逃逸辐射 {_escape_desc(P)}  灯 {len(lights)} 盏')
    return dict(nx=Nx, ny=Ny, nz=Nz,
                gx=np.linspace(layout.bounds['x0'], layout.bounds['x1'], Nx),
                gy=np.linspace(layout.bounds['y0'], layout.bounds['y1'], Ny),
                gz=np.linspace(layout.bounds['z0'], layout.bounds['z1'], Nz),
                valid=valid, world_pos=world_pos.astype(np.float32),
                layout=layout, hit_rate=g['hit_rate'], coverage=coverage,
                l1=E_l1.astype(np.float16), l2=E_l2.astype(np.float16),
                bins=E_bins.astype(np.float16),
                l1amb=sh_amb[:, :4].astype(np.float16),
                l2amb=sh_amb.astype(np.float16),
                binsamb=bn_amb.astype(np.float16),
                l1emit=sh_emit[:, :4].astype(np.float16),
                l2emit=sh_emit.astype(np.float16),
                binsemit=bn_emit.astype(np.float16),
                l1nee=nee_sh[:, :4].astype(np.float16),
                l2nee=nee_sh.astype(np.float16),
                binsnee=nee_bins.astype(np.float16))


def stage_character(P: dict, out_dir: Path):
    """Shared character assets: albedo frame + bulged normal/offset map."""
    ch = TOOL / 'char'
    ch.mkdir(exist_ok=True)
    alb_p, nrm_p = ch / 'albedo.png', ch / 'normal.png'
    if alb_p.exists() and nrm_p.exists():
        print('[char] 复用已有 albedo/normal', flush=True)   # 与 [depth] 一致:缓存也报阶段
        return
    atlas = Image.open(ROOT / 'public/resources/runtime/animation/player_anim/atlas.png').convert('RGBA')
    anim = json.loads((ROOT / 'public/resources/runtime/animation/player_anim/anim.json').read_text())
    cw, chh = atlas.width // int(anim['cols']), atlas.height // int(anim['rows'])
    frame = atlas.crop((4 * cw, 0, 5 * cw, chh))
    frame.save(alb_p)
    a = np.asarray(frame, np.float32)[..., 3] / 255.0
    mask = a > 0.05
    dist = distance_transform_edt(mask)
    prof = dist / max(dist.max(), 1e-6)
    prof = gaussian_filter(np.sqrt(prof), 3.0) * mask
    hpx = prof * frame.width * 0.35                    # bulge toward camera, px
    gy_, gx_ = np.gradient(hpx)
    n = np.stack([gx_, -gy_, -np.ones_like(hpx) * 6.0], -1)  # z toward camera (negative qz)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    enc = np.zeros((*hpx.shape, 4), np.uint8)
    enc[..., 0] = np.round((n[..., 0] * 0.5 + 0.5) * 255)
    enc[..., 1] = np.round((n[..., 1] * 0.5 + 0.5) * 255)
    enc[..., 2] = np.round((-n[..., 2]) * 255)         # store |nz|
    enc[..., 3] = np.round(np.clip(prof, 0, 1) * 255)  # bulge profile
    Image.fromarray(enc, 'RGBA').save(nrm_p)
    print('[char] baked albedo + bulged normal map')


def stage_walk_world(cal: dict, lay: dict, vol: dict, wb: dict, P: dict,
                     col_edit: np.ndarray | None = None) -> dict:
    """WORLD-space walk grid on the (non-planar) ground field.
    blocked == solid occupancy in the body column ABOVE the local ground --
    decoupled from screen occlusion: walking BEHIND a foreground object is legal."""
    Hg, Wg = cal['d'].shape
    theta = cal['theta']; M = wb['M']
    ppu, cx, cy = cal['ppu'], cal['cx'], cal['cy']
    res = int(P['walk_res'])
    spanx, spanz = wb['x1'] - wb['x0'], wb['z1'] - wb['z0']
    if spanx >= spanz:
        nx = res; nz = max(24, round(res * spanz / spanx))
    else:
        nz = res; nx = max(24, round(res * spanx / spanz))

    # splat every pixel's extended ground point into the world grid
    sxg, syg = np.meshgrid(np.arange(Wg, dtype=np.float32), np.arange(Hg, dtype=np.float32))
    q = np.stack([(sxg - cx) / ppu, (cy - syg) / ppu, lay['d_walk']], -1).reshape(-1, 3)
    Xw = q @ M.T
    gx = np.clip(((Xw[:, 0] - wb['x0']) / max(spanx, 1e-6) * (nx - 1)).round().astype(np.int32), 0, nx - 1)
    gz = np.clip(((Xw[:, 2] - wb['z0']) / max(spanz, 1e-6) * (nz - 1)).round().astype(np.int32), 0, nz - 1)
    ysum = np.zeros((nz, nx), np.float64); cnt = np.zeros((nz, nx), np.float64)
    np.add.at(ysum, (gz, gx), Xw[:, 1]); np.add.at(cnt, (gz, gx), 1.0)
    has = cnt > 0
    ygrid = np.zeros((nz, nx), np.float32)
    ygrid[has] = (ysum[has] / cnt[has]).astype(np.float32)
    ygrid = laplace_inpaint(ygrid, has, iters=150)

    # blocked test 1: solid occupancy in the body column above local ground
    ZZ, XXi = np.meshgrid(np.arange(nz), np.arange(nx), indexing='ij')
    Xc = wb['x0'] + XXi / max(nx - 1, 1) * spanx
    Zc = wb['z0'] + ZZ / max(nz - 1, 1) * spanz
    blocked = np.zeros((nz, nx), bool)
    h_lo, h_hi = float(P.get('col_h_lo', 0.35)), float(P.get('col_h_hi', 1.3))
    for h in (h_lo, (h_lo + h_hi) / 2, h_hi):
        Pw = np.stack([Xc, ygrid + h, Zc], -1)
        vi = _world_to_volidx(Pw, wb, vol)
        ii = np.clip(vi.round().astype(np.int32),
                     [0, 0, 0], [vol['Nx'] - 1, vol['Ny'] - 1, vol['Nz'] - 1])
        blocked |= vol['occ3'][ii[..., 2], ii[..., 1], ii[..., 0]]
    # blocked test 2 (hollow structures): if the VISIBLE surface that projects
    # onto this ground cell stands well above the local ground, a building/prop
    # covers the cell even though its interior voxels are empty.
    q_surf = np.stack([(np.meshgrid(np.arange(Wg), np.arange(Hg))[0].astype(np.float32) - cx) / ppu,
                       (cy - np.meshgrid(np.arange(Wg), np.arange(Hg))[1].astype(np.float32)) / ppu,
                       cal['d']], -1).reshape(-1, 3)
    Xs = q_surf @ M.T
    gxs = np.clip(((Xs[:, 0] - wb['x0']) / max(spanx, 1e-6) * (nx - 1)).round().astype(np.int32), 0, nx - 1)
    gzs = np.clip(((Xs[:, 2] - wb['z0']) / max(spanz, 1e-6) * (nz - 1)).round().astype(np.int32), 0, nz - 1)
    # highest surface point projecting into each cell
    ymax = np.full((nz, nx), -np.inf, np.float32)
    np.maximum.at(ymax, (gzs, gxs), Xs[:, 1].astype(np.float32))
    covered = np.isfinite(ymax) & ((ymax - ygrid) > 0.45)
    walk = has & ~blocked & ~covered
    walk = binary_closing(walk, np.ones((3, 3)))
    # manual collision brush (screen-space strokes -> world cells; block beats walk)
    if col_edit is not None and (col_edit > 0).any():
        fw = np.zeros((nz, nx), np.int32); fb = np.zeros((nz, nx), np.int32)
        m1 = (col_edit.reshape(-1) == 1); m2 = (col_edit.reshape(-1) == 2)
        np.add.at(fw, (gz[m1], gx[m1]), 1)
        np.add.at(fb, (gz[m2], gx[m2]), 1)
        walk = (walk | (fw > 0)) & ~(fb > 0)
        print(f'[walk] collision brush: +walk cells {(fw>0).sum()}, +block cells {(fb>0).sum()}')
    print(f'[walk] world grid {nx}x{nz}, walkable {walk.mean()*100:.0f}%')
    return dict(nx=nx, nz=nz, y=ygrid, mask=walk,
                x0=wb['x0'], z0=wb['z0'], dx=spanx / max(nx - 1, 1), dz=spanz / max(nz - 1, 1))


def stage_mesh(cal: dict, lay: dict, rgb_srgb: np.ndarray, wb: dict, P: dict,
               stride=2, edge_q=0.55) -> dict:
    """Triangulated WORLD-space mesh of the reconstruction, three layers:
    tag0 visible shell / tag1 hidden background / tag2 extended ground.
    Triangles are dropped across depth discontinuities > edge_q (post-relief):
    the resulting holes are the honest 'unobserved' regions."""
    Hg, Wg = cal['d'].shape
    ppu, cx, cy = cal['ppu'], cal['cx'], cal['cy']
    M = wb['M']
    sxg, syg = np.meshgrid(np.arange(0, Wg, stride, dtype=np.float32),
                           np.arange(0, Hg, stride, dtype=np.float32))
    gh, gw = sxg.shape
    sub = (slice(0, Hg, stride), slice(0, Wg, stride))

    all_verts, all_idx = [], []
    vbase = 0

    def layer(depth, col01, mask, tag):
        nonlocal vbase
        d = depth[sub]
        q = np.stack([(sxg - cx) / ppu, (cy - syg) / ppu, d], -1).reshape(-1, 3)
        Xw = (q @ M.T).astype(np.float32)
        c8 = np.clip(col01[sub].reshape(-1, 3) * 255, 0, 255).astype(np.uint8)
        tagc = np.full((len(c8), 1), tag, np.uint8)
        verts = np.concatenate([np.ascontiguousarray(Xw).view(np.uint8).reshape(len(c8), 12),
                                c8, tagc], 1)
        m = mask[sub] if mask is not None else np.ones((gh, gw), bool)
        # cell corner ids
        r, c = np.meshgrid(np.arange(gh - 1), np.arange(gw - 1), indexing='ij')
        v00 = r * gw + c; v10 = v00 + 1; v01 = v00 + gw; v11 = v01 + 1
        d2 = d.reshape(-1)
        ok = m[:-1, :-1] & m[:-1, 1:] & m[1:, :-1] & m[1:, 1:]
        dmax = np.maximum.reduce([d2[v00], d2[v10], d2[v01], d2[v11]])
        dmin = np.minimum.reduce([d2[v00], d2[v10], d2[v01], d2[v11]])
        ok &= (dmax - dmin) < edge_q
        t1 = np.stack([v00[ok], v10[ok], v11[ok]], -1)
        t2 = np.stack([v00[ok], v11[ok], v01[ok]], -1)
        idx = (np.concatenate([t1, t2], 0) + vbase).astype(np.uint32)
        all_verts.append(verts); all_idx.append(idx)
        vbase += len(verts)

    layer(cal['d'], rgb_srgb, None, 0)
    hid_col = np.power(np.clip(lay['c_bg'], 0, 1), 1 / 2.2)
    layer(lay['d_bg'], hid_col, lay['occ'], 1)
    gcol = np.tile(np.array([[.16, .42, .24]], np.float32), (Hg * Wg, 1)).reshape(Hg, Wg, 3)
    layer(lay['d_walk'], gcol, lay['occ'], 2)

    verts = np.concatenate(all_verts, 0)
    idx = np.concatenate(all_idx, 0)
    print(f'[mesh] {len(verts)} verts, {len(idx)} tris')
    return dict(verts=verts, idx=idx)


def stage_pointcloud(cal: dict, lay: dict, rgb_srgb: np.ndarray, wb: dict, stride=2) -> np.ndarray:
    """Decimated world point cloud for the 3D inspector:
    visible shell (true color) + hidden background layer (inpainted, dimmed tag)."""
    Hg, Wg = cal['d'].shape
    ppu, cx, cy = cal['ppu'], cal['cx'], cal['cy']
    sxg, syg = np.meshgrid(np.arange(0, Wg, stride, dtype=np.float32),
                           np.arange(0, Hg, stride, dtype=np.float32))
    sub = (slice(0, Hg, stride), slice(0, Wg, stride))
    def pts(depth, col, tag):
        q = np.stack([(sxg - cx) / ppu, (cy - syg) / ppu, depth[sub]], -1).reshape(-1, 3)
        Xw = (q @ wb['M'].T).astype(np.float32)
        c8 = np.clip(col[sub].reshape(-1, 3) * 255, 0, 255).astype(np.uint8)
        tagc = np.full((len(c8), 1), tag, np.uint8)
        return np.concatenate([np.ascontiguousarray(Xw).view(np.uint8).reshape(len(c8), 12),
                               c8, tagc], 1)
    front = pts(cal['d'], rgb_srgb, 0)
    occm = lay['occ'][sub].reshape(-1)
    hidden = pts(lay['d_bg'], np.power(np.clip(lay['c_bg'], 0, 1), 1 / 2.2), 1)[occm]
    ground = pts(lay['d_walk'], np.tile(np.array([[.2, .55, .3]], np.float32), (Hg, Wg)).reshape(Hg, Wg, 3), 2)
    gm = lay['occ'][sub].reshape(-1)          # ground points only where hidden behind occluders
    return np.concatenate([front, hidden, ground[gm]], 0)


# ---------------------------------------------------------------- audit image
def _norm01(a):
    a = np.asarray(a, np.float32)
    lo, hi = np.percentile(a, [1, 99])
    return np.clip((a - lo) / max(hi - lo, 1e-6), 0, 1)


def _cmap(a01):
    """tiny turbo-ish ramp, (H,W)->(H,W,3) uint8"""
    stops = np.array([[15, 15, 60], [40, 90, 200], [30, 200, 210],
                      [230, 220, 40], [220, 40, 30]], np.float32)
    t = np.clip(a01, 0, 1) * (len(stops) - 1)
    i = np.minimum(t.astype(int), len(stops) - 2)
    f = (t - i)[..., None]
    return (stops[i] * (1 - f) + stops[i + 1] * f).astype(np.uint8)


def save_audit(out_dir, img_rgb, cal, lay, vol, walk):
    Hg, Wg = cal['d'].shape
    panels = []
    src = (np.clip(img_rgb, 0, 1) * 255).astype(np.uint8)
    panels.append(('source', src))
    panels.append(('depth', _cmap(_norm01(cal['d']))))
    ym = _cmap(_norm01(cal['Y']))
    ym[cal['ground_mask']] = (ym[cal['ground_mask']] * 0.5 + np.array([255, 40, 40]) * 0.5).astype(np.uint8)
    panels.append(('worldY+ground', ym))
    panels.append(('occluders', np.repeat((lay['occ'] * 255).astype(np.uint8)[..., None], 3, -1)))
    walk_img = np.asarray(Image.fromarray((walk * 255).astype(np.uint8)).resize((Wg, Hg), Image.Resampling.NEAREST))
    panels.append(('walkable(world)', np.repeat(walk_img[..., None], 3, -1)))
    mid = vol['occ3'][:, :, vol['Nx'] // 2].astype(np.uint8) * 255   # (Nz,Ny)
    slice_img = np.repeat(np.asarray(
        Image.fromarray(mid.T[::-1]).resize((Wg, Hg), Image.Resampling.NEAREST),
        np.uint8)[..., None], 3, -1)
    panels.append(('volume x-slice', slice_img))
    cols = 3
    rows = (len(panels) + cols - 1) // cols
    canvas = Image.new('RGB', (Wg * cols + 8 * (cols + 1), (Hg + 22) * rows + 8), (16, 20, 24))
    from PIL import ImageDraw
    dr = ImageDraw.Draw(canvas)
    for i, (title, arr) in enumerate(panels):
        r, c = divmod(i, cols)
        x = 8 + c * (Wg + 8); y = 8 + r * (Hg + 22)
        canvas.paste(Image.fromarray(arr), (x, y + 16))
        dr.text((x, y + 2), title, fill=(230, 230, 230))
    canvas.save(out_dir / 'audit.png')


def work_dir(name: str, background: str | None = None) -> Path:
    """烘焙工作目录:`out/<场景>/<背景基名>/`。

    2026-08-30 起**背景是烘焙的一等参数**(制作人:要能自由烘同一场景的白天与夜晚)。
    原来是 `out/<场景>/`,烘第二张背景会把第一张的中间产物(深度缓存、物体分割、
    manifest)**整个覆盖**掉 —— 于是"同一场景两份光照数据"根本存不住。

    `background` 不传时取场景 JSON 的 backgrounds[0];仍找不到就退回老口径
    `out/<场景>/`,旧工作目录零影响。
    """
    if background is None:
        background = scene_background(name)
    key = _bake_key(background) if background else None
    if not key:
        return OUT / name
    per_bg = OUT / name / key
    # 真回落(2026-08-30 审查抓到:原来只在 key 为空时回落,而 key 永远非空 ——
    # docstring 声称的回落是假的,存量扁平工作目录一律 FileNotFoundError)。
    # 判据用 manifest.json:它是 build 的产物清单,三个导出函数都读它。
    if not (per_bg / 'manifest.json').exists() and (OUT / name / 'manifest.json').exists():
        return OUT / name
    return per_bg


#: 角色在场景坐标里的固定高度(与 scene_fields.DEFAULT_CHAR_SCENE_H 同一约定)。
CHAR_SCENE_H = 150.0


def scene_char_wu(name: str, ppu_work: float, work_w: int = W_G) -> float | None:
    """角色在这张画里占多少 **wu** —— probe 分布与盒高的唯一尺度参照。

    刻度链:场景坐标 --(native_w / worldWidth)--> 背景像素 --(1/ppu)--> 世界单位。
    ppu 随分辨率线性缩放,所以 `native_w / ppu_native == work_w / ppu_work`,
    用工作分辨率那一对算是等价的。

    取不到场景 JSON(实验室可以烘工程外的任意图)时返回 None,
    调用方回落到显式 `probe_band`。
    """
    import json as _json
    f = ROOT / 'public' / 'assets' / 'scenes' / f'{name}.json'
    if not f.exists() or ppu_work <= 0:
        return None
    try:
        world_w = float(_json.loads(f.read_text(encoding='utf-8')).get('worldWidth') or 0.0)
    except Exception:                                # noqa: BLE001 — 坏 JSON 不拖垮烘焙
        return None
    if world_w <= 0:
        return None
    scene_per_wu = world_w / (work_w / ppu_work)     # 一个世界单位 = 多少场景坐标
    return CHAR_SCENE_H / scene_per_wu


def scene_background(name: str) -> str:
    """场景 JSON 的 backgrounds[0].image;取不到则老口径 background.png。"""
    import json as _json
    f = ROOT / 'public' / 'assets' / 'scenes' / f'{name}.json'
    if f.exists():
        try:
            bgs = (_json.loads(f.read_text(encoding='utf-8')).get('backgrounds') or [])
            img = bgs[0].get('image') if bgs and isinstance(bgs[0], dict) else None
            if isinstance(img, str) and img.strip():
                return img
        except Exception:
            pass
    return 'background.png'


def _bake_key(image: str) -> str:
    """图名 → 烘焙目录基名。与运行时 bakeKeyFromBackground / 校验器同口径。

    ⚠ 先 strip:TS 版对输入 trim 过,不跟着做就会把 '   ' 当成合法目录名
    (parity 测试抓到的真实漂移)。空值必须抛错 —— 静默返回 '' 会让路径塌成
    `<场景>/lighting/`,恰好命中**旧的扁平布局**,把"图名错了"伪装成"加载成功"。
    """
    image = (image or '').strip()
    base = image.replace(chr(92), '/').split('/')[-1]
    dot = base.rfind('.')
    key = base[:dot] if dot > 0 else base
    if not key:
        raise ValueError(f'取不出烘焙基名: {image!r}')
    return key


# ---------------------------------------------------------------- main build
def build(img_path: Path, name: str, params: dict, background: str | None = None):
    """烘一张背景。`background` 指明这是该场景的哪张图(缺省=场景当前 backgrounds[0])，
    决定工作目录落在 `out/<场景>/<图名>/` —— 白天与夜晚各一份，互不覆盖。"""
    P = {**DEFAULTS, **params}
    out_dir = work_dir(name, background if background is not None else img_path.name)
    out_dir.mkdir(parents=True, exist_ok=True)
    h = img_hash(img_path)

    src = Image.open(img_path).convert('RGB')
    raw_native = stage_depth(img_path, out_dir, h, model=str(P.get('depth_model', 'base')))
    Hg = round(src.height * W_G / src.width)
    raw = resize_f(raw_native, (W_G, Hg))
    rgb_srgb = np.asarray(src.resize((W_G, Hg), Image.Resampling.LANCZOS), np.float32) / 255.0

    # ① 物体识别(只看图,不依赖深度)。地形 = 扣掉物体之后剩下的部分——
    #    朝上判据分不开街面与屋顶,必须先由这一步切断,否则房子会被烘进地形高度场。
    from tools.character_lighting_lab.object_seg import object_mask, segment_objects
    if True:
        obj_ids_native, obj_meta = segment_objects(img_path, out_dir, h, P)
        obj_ids = resize_nn(obj_ids_native, (W_G, Hg))
        obj_edit = load_object_edit(out_dir, (Hg, W_G))
        objects = object_mask(obj_ids, obj_meta, P, obj_edit)
        np.save(out_dir / 'object_mask.npy', objects)
        print(f'[objects] 物体占画面 {objects.mean() * 100:.1f}%,候选地形 {(~objects).mean() * 100:.1f}%')

    cal = stage_calibrate(raw, P, ground_prior=None if objects is None else ~objects)
    cal['objects'] = objects if objects is not None else np.zeros(raw.shape, bool)
    # 手动深度映射微调(叠加在自动解上;旧工具 dm_scale/dm_offset 的对应物)
    dsa, doa = float(P.get('depth_scale_adj', 1.0)), float(P.get('depth_offset_adj', 0.0))
    if abs(dsa - 1.0) > 1e-4 or abs(doa) > 1e-4:
        theta0 = cal['theta']
        cal['d'] = (cal['d'] * dsa + doa).astype(np.float32)
        cal['Y'] = (cal['qy'] * math.cos(theta0) - cal['d'] * math.sin(theta0)).astype(np.float32)
        print(f'[calib] manual trim: xscale {dsa:.3f}, offset {doa:+.3f}')
    print(f"[calib] s={cal['s']:.4f} o={cal['o']:.4f} ground|Y|p95={cal['ground_y_p95']:.4f} "
          f"ground={cal['ground_mask'].mean()*100:.0f}%")
    sem = None
    if int(P.get('semantic_gate', 1)):
        from tools.character_lighting_lab.semantic_gate import emitter_gate
        gate_full = emitter_gate(img_path, out_dir, h)
        if gate_full is not None:
            sem = resize_f(gate_full, (W_G, Hg))
    hdr = stage_hdr(rgb_srgb, P, sem_gate=sem)
    lay = stage_layers(cal, hdr['base'], P)   # bg layer inpaints BASE (no emitter smear)
    check_geometry_sanity(cal, lay, cal.get('objects'))   # relief 之前量:纯净重建的体检
    rad_bg = lay['c_bg']
    # relief gain: amplify structure depth relative to the pinned ground field
    # (ground itself is unchanged; monocular models compress vertical contrast)
    k = float(P['relief'])
    if abs(k - 1.0) > 1e-3:
        cal['d'] = (lay['d_walk'] + (cal['d'] - lay['d_walk']) * k).astype(np.float32)
        lay['d_bg'] = np.maximum(lay['d_walk'] + (lay['d_bg'] - lay['d_walk']) * k,
                                 cal['d'] + 0.02).astype(np.float32)
        theta = cal['theta']
        cal['Y'] = (cal['qy'] * math.cos(theta) - cal['d'] * math.sin(theta)).astype(np.float32)
    # manual depth-brush edit layer (authored in the viewer, survives rebakes)
    edit = load_depth_edit(out_dir, cal['d'].shape)
    if edit is not None:
        cal['d'] = (cal['d'] + edit).astype(np.float32)
        theta = cal['theta']
        cal['Y'] = (cal['qy'] * math.cos(theta) - cal['d'] * math.sin(theta)).astype(np.float32)
        print(f'[edit] depth brush applied, |delta| max {np.abs(edit).max():.3f} q, '
              f'edited px {(np.abs(edit) > 1e-3).sum()}')
    vol = stage_voxelize(cal, lay, hdr['base'], hdr['emit'], rad_bg, P)
    # probe 盒高由**角色实高**推出(不是写死的 1.6);拿不到场景 JSON 才用显式覆写。
    char_wu = scene_char_wu(name, cal['ppu'])
    band = P.get('probe_band')
    if band is None:
        if char_wu is None:
            raise RuntimeError(
                f'{name}: 取不到 worldWidth,推不出角色高度 ⇒ probe 盒高无从谈起。'
                f'显式传 --probe-band <wu>,或先把场景 JSON 的 worldWidth 补上。')
        band = char_wu * 1.15                        # 头顶留一点余量
    if char_wu is None:
        char_wu = float(band) / 1.15                 # 只用于密度推导的回落
    print(f'[scale] 角色 {char_wu:.3f} wu  probe 带 {float(band):.3f} wu')
    wb = world_bounds(cal, lay, P, band=band, char_wu=char_wu,
                      height_chars=float(P.get('probe_height_chars', 2.0)))
    lights = stage_lights(cal, lay, hdr['emit'], wb, P)
    from tools.character_lighting_lab.escape import make_escape_sampler
    escape_of = make_escape_sampler(P.get('escape'), root=ROOT,
                                    hdr=hdr['base'], depth=cal['d'])
    amb = stage_ambient(escape_of, P)
    probes = stage_probes(cal, lay, hdr, wb, lights, P, escape_of, char_wu)
    walk = stage_walk_world(cal, lay, vol, wb, P,
                            col_edit=load_collision_edit(out_dir, cal['d'].shape))
    cloud = stage_pointcloud(cal, lay, rgb_srgb, wb)
    mesh = stage_mesh(cal, lay, rgb_srgb, wb, P)
    stage_character(P, out_dir)

    # ---- write outputs
    _asave(src, out_dir / 'background.png') if not (out_dir / 'background.png').exists() else None
    _awrite(out_dir / 'front_depth.bin', cal['d'].astype(np.float32).tobytes())
    _awrite(out_dir / 'walk_depth.bin', lay['d_walk'].astype(np.float32).tobytes())
    _asave(Image.fromarray((walk['mask'] * 255).astype(np.uint8)), out_dir / 'walk_mask.png')
    _awrite(out_dir / 'walk_y.bin', walk['y'].astype(np.float32).tobytes())
    rgba = np.concatenate([vol['rad3'], vol['occ3'][..., None].astype(np.float32)], -1)
    _awrite(out_dir / 'volume.bin', rgba.astype(np.float16).tobytes())
    rgba_e = np.concatenate([vol['emi3'], np.zeros_like(vol['emi3'][..., :1])], -1)
    _awrite(out_dir / 'volume_emit.bin', rgba_e.astype(np.float16).tobytes())
    for k in ('l1', 'l2', 'bins', 'l1amb', 'l2amb', 'binsamb',
              'l1emit', 'l2emit', 'binsemit', 'l1nee', 'l2nee', 'binsnee'):
        _awrite(out_dir / f'probes_{k}.bin', probes[k].tobytes())
    _awrite(out_dir / 'probes_valid.bin', (probes['valid'].astype(np.uint8) * 255).tobytes())
    _awrite(out_dir / 'probes_pos.bin', probes['world_pos'].tobytes())
    _awrite(out_dir / 'points.bin', cloud.tobytes())
    _awrite(out_dir / 'mesh_verts.bin', mesh['verts'].tobytes())
    _awrite(out_dir / 'mesh_idx.bin', mesh['idx'].tobytes())
    # gain map as 8-bit heat png (for the HDR overlay)
    g01 = np.clip(hdr['gain_ev'] / max(float(P['max_gain_ev']), 1e-6), 0, 1)
    _asave(Image.fromarray((g01 * 255).astype(np.uint8)), out_dir / 'gain.png')
    # 语义 mask(纯 SAM3)8-bit:查看器「光源分割图」直接显示这张,分离直接光的依据
    _asave(Image.fromarray((np.clip(hdr['mask'], 0, 1) * 255).astype(np.uint8)), out_dir / 'mask.png')
    # inpainted hidden-layer colour as display-sRGB texture (mesh skinning)
    hid8 = np.clip(np.power(np.clip(lay['c_bg'], 0, 1), 1 / 2.2) * 255, 0, 255).astype(np.uint8)
    _asave(Image.fromarray(hid8), out_dir / 'hidden.png')

    manifest = dict(
        name=name, hash=h, params=P, work=dict(w=W_G, h=Hg),
        native=dict(w=src.width, h=src.height),
        cal=dict(s=cal['s'], o=cal['o'], theta=cal['theta'], ppu=cal['ppu'],
                 cx=cal['cx'], cy=cal['cy'], ground_y_p95=cal['ground_y_p95']),
        vol={k: (float(vol[k]) if isinstance(vol[k], (int, float, np.floating)) else int(vol[k]))
             for k in ('Nx', 'Ny', 'Nz', 'qx_min', 'qx_max', 'qy_min', 'qy_max', 'qz_min', 'qz_max')},
        world=dict(M=wb['M'].tolist(), x0=wb['x0'], x1=wb['x1'], y0=wb['y0'], y1=wb['y1'],
                   z0=wb['z0'], z1=wb['z1']),
        walk=dict(nx=walk['nx'], nz=walk['nz'], x0=walk['x0'], z0=walk['z0'],
                  dx=walk['dx'], dz=walk['dz']),
        ambient=dict(sh=amb['sh'].reshape(-1).tolist(), mean=amb['mean'].tolist(),
                     hit_fraction=amb['hit_fraction']),
        probes=dict(nx=probes['nx'], ny=probes['ny'], nz=probes['nz'],
                    gx=list(map(float, probes['gx'])), gy=list(map(float, probes['gy'])),
                    gz=list(map(float, probes['gz']))),
        hdr=hdr['stats'],
        lights=lights,
        geometry_sig=geometry_signature(out_dir, h, P),
        point_count=int(len(cloud)),
        mesh=dict(verts=int(len(mesh['verts'])), tris=int(len(mesh['idx']))),
        built=time.strftime('%Y-%m-%d %H:%M:%S'),
    )
    _awrite_text(out_dir / 'manifest.json', json.dumps(manifest, ensure_ascii=False, indent=1))
    save_audit(out_dir, rgb_srgb, cal, lay, vol, walk['mask'])
    print(f'[done] {out_dir}')


# 非 bake 着色参数(运行时可调那套)的导出默认:与查看器 UI 默认一致,唯 mode
# 交付默认 L2(RT 是对比模式);查看器「⇪ 导出照明」会传面板当前值覆盖这套。
# ⚠ pgain(预览亮度)是实验室显示增益(背景+人同乘),纯预览设施,**永不导出**
# ——游戏只消费 β 作角色曝光,背景是原画不动,乘 pgain 会破坏人:背景比例。
SHADING_DEFAULTS = dict(
    mode=2, spp=64, step=0.9, msteps=160,
    fold=1, miss_mode=0, nee=0,
    beta=0.0, amb=1.0,
    bulge=0.22, flatten=0.0,
    # E 色度权重:0=只借场景明暗(luma)、角色保留自己颜色不被场景色染;1=完整彩色 E
    eChroma=0.0,
    # 角色 GI 底光增益(0~10):只乘 probe/RT 的 E,不乘实体灯与测试太阳——
    # β 是"曝光"(乘一切),这个是"GI 有多强"(制作人 2026-09-01 点名要独立旋钮)
    giStrength=1.0,
)


def _normalize_shading(shading: dict | None) -> dict:
    out = dict(SHADING_DEFAULTS)
    for k, v in (shading or {}).items():
        if k not in SHADING_DEFAULTS:
            continue
        out[k] = int(v) if isinstance(SHADING_DEFAULTS[k], int) else float(v)
    out['mode'] = min(3, max(0, out['mode']))
    return out


#: 固化进 probe 图集的 compose 输入(v3):改这些必须重导出照明,单存参数改不动已烤好的 E
BAKED_INTO_ATLAS = ('nee', 'amb', 'miss_mode')


def export_shading_params(name: str, shading: dict | None = None) -> Path:
    """只更新已导出场景的 shading 块(运行时着色参数),**不碰 probe 图集/地面场/体素卷**。

    与 export_runtime 的分工:导出照明=重新产出 probe 数据(固化 E),本函数=只存那几个
    运行时小参数(beta/eChroma/bulge/flatten/mode/RT 那组)。因此拒绝三种情况,避免写出
    「lighting.json 声称的值 ≠ 图集实际按其固化的值」这种自相矛盾的载荷:
      1. 该场景还没导出过照明(无 lighting.json)——没有可打补丁的对象;
      2. 载荷是旧版 v2——运行时本就禁用,单补参数救不回来,得重导出;
      3. 改了 nee/amb/miss_mode——它们已烤进固化 E(见 BAKED_INTO_ATLAS),
         只有重导出照明才能真正生效。
    """
    dest = (ROOT / 'public' / 'resources' / 'runtime' / 'scenes' / name / 'lighting'
            / _bake_key(scene_background(name)))
    if not (dest / 'lighting.json').exists():          # 迁移期回落扁平布局
        dest = ROOT / 'public' / 'resources' / 'runtime' / 'scenes' / name / 'lighting'
    f = dest / 'lighting.json'
    if not f.exists():
        raise RuntimeError(f'{name} 还没导出过照明——先点「导出照明」完整导一次')
    meta = json.loads(f.read_text())
    if int(meta.get('version') or 0) < 3:
        raise RuntimeError(
            f'{name} 的载荷是旧版 v{meta.get("version")}(运行时已禁用)——'
            f'需点「导出照明」重导出为 v3 固化,单存参数救不回来')
    old = meta.get('shading') or {}
    # 来路没带的键**保留现值**而不是打回默认——F2 侧新增的运行时键(如 giStrength)
    # 实验室面板可能还没有;纯 _normalize_shading(shading) 会把它们静默重置。
    new = _normalize_shading({**old, **(shading or {})})
    changed = [k for k in BAKED_INTO_ATLAS if old.get(k) != new[k]]
    if changed:
        raise RuntimeError(
            f'{"/".join(changed)} 已固化进 probe 图集,单存参数改不动它——'
            f'要改这些请点「导出照明」重导出')
    meta['shading'] = new
    _awrite_text(f, json.dumps(meta, ensure_ascii=False, indent=1) + '\n')
    print(f'[export-params] {f}')
    return f




def export_runtime(name: str, shading: dict | None = None,
                   background: str | None = None) -> Path:
    """数据通道:把实验室烘焙结果变换成游戏运行时载荷,写入
    public/resources/runtime/scenes/<name>/lighting/。纯文件变换,不重烘。

    v2(运行时逐像素着色全量数据,与查看器 CHAR_FS 同源):
      lighting.json          标定/世界/probe网格/vol维度/ambient/光源/哈希门
                             + shading 块(非 bake 着色参数=场景配置;游戏 F2
                             打开即此值,F2 改动只是运行时测试)
      atlas_l1|l2|bin.bin    probe 图集,列块 [base+cov|amb|emit|nee],f16 RGBA
                             (与查看器 atlas4() 同布局,K=4/9/64)
      probes_valid.bin       u8 0/255 × Pn
      vol_rad.bin|vol_emit.bin  体素卷 Z 切片平铺 2D 图集,f16 RGBA
                             (行=y,列=x,切片按 tiles_x 横排;alpha=占据/0)
      ground_d.png           行走面深度场,RG16 编码,work-res"""
    src_dir = work_dir(name, background)
    man = json.loads((src_dir / 'manifest.json').read_text())
    scene_dir = ROOT / 'public' / 'resources' / 'runtime' / 'scenes' / name
    # 2026-08-30「背景与烘焙绑死」:产物落 lighting/<背景基名>/,哈希也对这张图算。
    # 入参优先 —— 烘夜景时场景当前背景仍是白天那张,读场景会导错落点。
    bg_name = background or scene_background(name)
    game_bg = scene_dir / bg_name
    bg_hash = man['hash']
    if game_bg.exists():
        # the lab copy is a PIL re-encode (bytes differ, pixels must not):
        # stamp the GAME file's hash, but only after pixel-level identity check.
        a = np.asarray(Image.open(game_bg).convert('RGB'))
        b = np.asarray(Image.open(src_dir / 'background.png').convert('RGB'))
        if a.shape != b.shape or not np.array_equal(a, b):
            raise RuntimeError(
                f'游戏背景 {game_bg} 与实验室烘焙输入像素不一致——'
                f'背景已改动,先在实验室重烘该场景再导出')
        bg_hash = img_hash(game_bg)
    dest = scene_dir / 'lighting' / _bake_key(bg_name)
    dest.mkdir(parents=True, exist_ok=True)
    # v1 遗留文件清理(被 atlas_*.bin 取代)
    for f in ('probes_l2.bin', 'probes_l2amb.bin', 'probes_l2nee.bin'):
        (dest / f).unlink(missing_ok=True)

    P = man['probes']
    Pn = P['nx'] * P['ny'] * P['nz']

    def _read_probe(stem: str, K: int, ch: int) -> np.ndarray:
        raw = np.frombuffer((src_dir / f'probes_{stem}.bin').read_bytes(), np.float16)
        return raw.reshape(Pn, K, ch)

    # 导出即固化(v3):用当前 shading 的 nee/amb 把 4 分账(base/amb/emit/nee)compose 成
    # 单一最终 E 的球谐系数——miss_mode=0 时着色是分账的线性组合,SH 域可精确合成。
    # 游戏运行时只查这一块、不再逐帧组合(nee/miss_mode/amb 固化进 E,游戏侧不消费)。
    # 实验室预览不受影响:viewer 读的是 OUT/ 的分账缓存,走自己的实时组合。
    # miss_mode=1 的 /cov 是逐方向非线性、无法在 SH 域精确合成——按 miss_mode=0 近似并告警。
    sh_c = _normalize_shading(shading)
    _nee_on = sh_c['nee'] > 0
    _amb_w = float(sh_c['amb'])
    if sh_c['miss_mode'] > 0:
        print('  [warn] miss_mode=1 无法在 SH 域精确固化(/cov 逐方向),按 miss_mode=0 近似导出')

    def _atlas4(stem: str, K: int) -> None:
        """固化:base + (nee开?nee:emit) + amb×权重 → 单块最终 E 球谐(K 列 RGBA,α 未用)。"""
        out = compose_atlas(_read_probe(stem, K, 4)[:, :, :3],
                            _read_probe(f'{stem}emit', K, 3),
                            _read_probe(f'{stem}nee', K, 3),
                            _read_probe(f'{stem}amb', K, 3),
                            nee_on=_nee_on, amb_w=_amb_w)
        _awrite(dest / f'atlas_{"bin" if stem == "bins" else stem}.bin', out.tobytes())

    _atlas4('l1', 4)
    _atlas4('l2', 9)
    _atlas4('bins', 64)
    _awrite(dest / 'probes_valid.bin', (src_dir / 'probes_valid.bin').read_bytes())

    V = man['vol']
    Nx, Ny, Nz = int(V['Nx']), int(V['Ny']), int(V['Nz'])
    tiles_x = int(math.ceil(math.sqrt(Nz)))
    tiles_y = int(math.ceil(Nz / tiles_x))

    def _tile_volume(fname: str, out_name: str) -> None:
        vol = np.frombuffer((src_dir / fname).read_bytes(), np.float16).reshape(Nz, Ny, Nx, 4)
        atlas = np.zeros((tiles_y * Ny, tiles_x * Nx, 4), np.float16)
        for z in range(Nz):
            ty, tx = divmod(z, tiles_x)
            atlas[ty * Ny:(ty + 1) * Ny, tx * Nx:(tx + 1) * Nx] = vol[z]
        _awrite(dest / out_name, atlas.tobytes())

    _tile_volume('volume.bin', 'vol_rad.bin')
    _tile_volume('volume_emit.bin', 'vol_emit.bin')

    W, Hh = man['work']['w'], man['work']['h']
    d_walk = np.frombuffer((src_dir / 'walk_depth.bin').read_bytes(), np.float32).reshape(Hh, W)
    d_lo, d_hi = float(d_walk.min()), float(d_walk.max())
    n16 = np.round((d_walk - d_lo) / max(d_hi - d_lo, 1e-6) * 65535).astype(np.uint16)
    rg = np.zeros((Hh, W, 3), np.uint8)
    rg[..., 0] = n16 >> 8
    rg[..., 1] = n16 & 0xFF
    _asave(Image.fromarray(rg), dest / 'ground_d.png', optimize=True)

    payload = dict(
        version=3,                             # v3:probe 图集为固化最终 E(单块球谐,非分账)
        background_sha1=bg_hash,               # 防腐门:游戏背景重画即失配禁用
        work=man['work'], cal=man['cal'], world=man['world'],
        probes={k: P[k] for k in ('nx', 'ny', 'nz')},
        vol=dict(nx=Nx, ny=Ny, nz=Nz, tiles_x=tiles_x, tiles_y=tiles_y,
                 qx_min=V['qx_min'], qx_max=V['qx_max'],
                 qy_min=V['qy_min'], qy_max=V['qy_max'],
                 qz_min=V['qz_min'], qz_max=V['qz_max']),
        ambient_sh=man['ambient']['sh'],
        lights=man.get('lights', []),
        ground_d=dict(min=d_lo, max=d_hi),
        shading=_normalize_shading(shading),
        baked_params=man['params'],
        built=man['built'],
    )
    _awrite_text(dest / 'lighting.json',
                 json.dumps(payload, ensure_ascii=False, indent=1) + '\n')
    print(f'[export] {dest}')
    return dest


def terrain_preview(name: str, background: str | None = None) -> dict:
    """秒级地形预览 + 站位体检 —— 圈两笔就能看结果,不用陪跑整条烘焙管线。

    为什么能秒级:视差→深度那两个参数 (a,b) 已在 manifest 里,**不必重跑网格搜索**——
    它是在已经很干净的掩膜上拟合的全局解,人工改几块不足以挪动它;而地面零点(中位
    归零)本来就是每次重算的廉价量。于是只剩「掩膜 + 调和外推」,秒级。

    **它给不了什么**(别当成重烘):可走掩膜/碰撞图要 stage_voxelize 的体素占据来做
    遮挡测试,不在快通道里。所以"能不能走"仍然必须完整重烘。

    产出两张图:
    - terrain_preview.png  地形高度场(蓝低→红高)。改完覆写层先看它对不对。
    - occupancy_preview.png 站位体检:按**运行时同一套遮挡口径**(直立 quad @ 行走面
      脚点深度 − 0.045)算"角色站这儿被吃掉几成",绿→红。地形对不对不是目的,
      遮挡对不对才是。
    """
    src_dir = work_dir(name, background)
    man = json.loads((src_dir / 'manifest.json').read_text())
    P = {**DEFAULTS, **man['params']}
    scene_json = ROOT / 'public' / 'assets' / 'scenes' / f'{name}.json'
    scene = json.loads(scene_json.read_text(encoding='utf-8')) if scene_json.exists() else {}
    img_path = ROOT / 'public' / 'resources' / 'runtime' / 'scenes' / name / 'background.png'
    h = img_hash(img_path)
    W, Hh = man['work']['w'], man['work']['h']
    cal_m = man['cal']
    theta, ppu, cx, cy = cal_m['theta'], cal_m['ppu'], cal_m['cx'], cal_m['cy']

    raw = resize_f(stage_depth(img_path, src_dir, h, model=str(P['depth_model'])), (W, Hh))
    d = (1.0 / (cal_m['s'] * raw + cal_m['o'])).astype(np.float32)
    sy = np.arange(Hh, dtype=np.float32)[:, None]
    qy = ((cy - sy) / ppu * np.ones((1, W))).astype(np.float32)

    from tools.character_lighting_lab.object_seg import object_mask, segment_objects
    ids_native, meta = segment_objects(img_path, src_dir, h, P)
    objects = object_mask(resize_nn(ids_native, (W, Hh)), meta, P,
                          load_object_edit(src_dir, (Hh, W)))

    gm = _ground_mask_from(d, qy, theta, P['ground_up_dot'], prior=~objects)
    if gm.any():                       # 地面中位高度归零(与 stage_calibrate 末尾同式)
        d = (d + float(np.median(qy[gm] / math.tan(theta) - d[gm]))).astype(np.float32)
    Y = (qy * math.cos(theta) - d * math.sin(theta)).astype(np.float32)
    Yg = gaussian_filter(laplace_inpaint(Y, gm, iters=300), 2.0)
    d_walk = ((qy * math.cos(theta) - Yg) / math.sin(theta)).astype(np.float32)

    # 场景深度按运行时口径:relief 之后(游戏 raw_depth_rg.png 就是这个)
    k = float(P['relief'])
    d_front = d_walk + (d - d_walk) * k if abs(k - 1.0) > 1e-3 else d

    # ---- 站位体检:与三个滤镜同式 spriteDepth = footD + dps*(sy-syFoot) - bias ----
    dps = math.tan(theta) / ppu
    bias = 0.045
    char_h_px, char_w_px = Hh * 0.0, W * 0.0
    ww, wh = scene.get('worldWidth'), scene.get('worldHeight')
    if ww and wh:                       # 角色在 work 分辨率下的像素尺寸(与游戏同源)
        char_w_px = PLAYER_WORLD_W / ww * W
        char_h_px = PLAYER_WORLD_H / wh * Hh
    char_w_px = max(char_w_px, 4.0); char_h_px = max(char_h_px, 4.0)
    step = max(4, int(W / 90))
    occ_map = np.full((Hh, W), np.nan, np.float32)
    vals = []
    eps = 0.15 * dps * char_h_px
    for fy in range(int(Hh * 0.25), Hh, step):
        for fx in range(4, W - 4, step):
            if abs(d_front[fy, fx] - d_walk[fy, fx]) > eps:
                continue                # 脚下不是可见地面(站在物体上)→ 不计
            x0 = max(0, int(fx - char_w_px / 2)); x1 = min(W, int(fx + char_w_px / 2))
            y0 = max(0, int(fy - char_h_px)); y1 = fy
            if x1 - x0 < 2 or y1 - y0 < 2:
                continue
            rows = np.arange(y0, y1, dtype=np.float32)[:, None]
            sprite = d_walk[fy, fx] + dps * (rows - fy) - bias
            frac = float((d_front[y0:y1, x0:x1] < sprite).mean())
            occ_map[max(0, fy - step // 2):fy + step // 2,
                    max(0, fx - step // 2):fx + step // 2] = frac
            vals.append(frac)

    def _save(arr, path, cmap_bad=None):
        Image.fromarray(arr).save(path, optimize=True)

    n = (Yg - Yg.min()) / max(float(Yg.max() - Yg.min()), 1e-6)
    _save(_cmap(n), src_dir / 'terrain_preview.png')
    vis = np.zeros((Hh, W, 3), np.uint8)
    ok = ~np.isnan(occ_map)
    f = np.nan_to_num(occ_map)
    vis[..., 0] = np.where(ok, (f * 255), 30).astype(np.uint8)
    vis[..., 1] = np.where(ok, ((1 - f) * 255), 30).astype(np.uint8)
    vis[..., 2] = np.where(ok, 40, 36).astype(np.uint8)
    _save(vis, src_dir / 'occupancy_preview.png')

    v = np.array(vals) if vals else np.zeros(1)
    stats = dict(
        samples=len(vals),
        full_occluded=float(np.mean(v > 0.9)),
        heavy=float(np.mean(v > 0.5)),
        median=float(np.median(v)),
        mean=float(v.mean()),
        ground_mask=float(gm.mean()),
        objects=float(objects.mean()),
        terrain_p95=float(np.percentile(Yg, 95)),
        terrain_max=float(Yg.max()),
    )
    (src_dir / 'terrain_preview.json').write_text(json.dumps(stats, ensure_ascii=False, indent=1) + '\n')
    print(f'[terrain] {name}: 可见地面站位 {len(vals)},全遮挡 {stats["full_occluded"]*100:.1f}%,'
          f'重度 {stats["heavy"]*100:.1f}%,中位 {stats["median"]:.3f}')
    return stats


def export_scene_depth(name: str, background: str | None = None) -> dict:
    """接管旧场景深度工具:把实验室的有效深度(标定+起伏+笔刷编辑)导出为
    游戏运行时消费的 depthConfig 契约 —— RG16 深度图 + M(游戏 det+1 约定)+
    depth_mapping + 最佳拟合 floor 线 + 方形 cell 碰撞网格;既有手调参数保值。"""
    src_dir = work_dir(name, background)
    man = json.loads((src_dir / 'manifest.json').read_text())
    scene_media = ROOT / 'public' / 'resources' / 'runtime' / 'scenes' / name
    scene_json_path = ROOT / 'public' / 'assets' / 'scenes' / f'{name}.json'
    if not scene_json_path.exists():
        raise RuntimeError(f'场景 JSON 不存在: {scene_json_path}(先在主编辑器建场景)')
    game_bg = scene_media / (background or scene_background(name))
    if game_bg.exists():
        a = np.asarray(Image.open(game_bg).convert('RGB'))
        b = np.asarray(Image.open(src_dir / 'background.png').convert('RGB'))
        if a.shape != b.shape or not np.array_equal(a, b):
            raise RuntimeError('游戏背景与实验室烘焙输入像素不一致——先重烘再导出')

    W, Hh = man['work']['w'], man['work']['h']
    nw, nh = man['native']['w'], man['native']['h']
    theta = man['cal']['theta']
    scale_px = nw / W
    ppu_nat = man['cal']['ppu'] * scale_px

    d = np.frombuffer((src_dir / 'front_depth.bin').read_bytes(), np.float32).reshape(Hh, W)
    d_walk = np.frombuffer((src_dir / 'walk_depth.bin').read_bytes(), np.float32).reshape(Hh, W)

    # ---- 深度图:原生分辨率 RG16,线性 mapping(invert:false) ----
    d_nat = resize_f(d, (nw, nh))
    d_lo = float(d_nat.min()) - 1e-4
    d_hi = float(d_nat.max()) + 1e-4
    raw16 = np.round((d_nat - d_lo) / (d_hi - d_lo) * 65535).astype(np.uint16)
    rg = np.zeros((nh, nw, 3), np.uint8)
    rg[..., 0] = raw16 >> 8
    rg[..., 1] = raw16 & 0xFF
    old_scene = json.loads(scene_json_path.read_text())
    old_cfg = old_scene.get('depthConfig') or {}
    depth_name = old_cfg.get('depth_map', 'raw_depth_rg.png')
    _asave(Image.fromarray(rg), scene_media / depth_name, optimize=True)

    # ---- 直立 quad 的深度梯度(遮挡唯一还用的 shader 参数) ----
    # floor_depth_A/B 那条最小二乘拟合直线**已废除**:运行时的脚点深度一律取
    # lighting/ground_d.png 逐点采样(那条直线在多层街巷可偏出 200+ 行地面)。
    depth_per_sy = math.tan(theta) / ppu_nat

    # ---- 碰撞:实验室世界网格 → 游戏方形 cell 网格(注意 lab Z 翻转还原) ----
    wk = man['walk']
    # ⚠ 曾经写的是 `src_dir.parent / name` —— 那在扁平布局下恰好等于 src_dir,
    #   按背景分目录之后会解析成 out/<场景>/<场景>/，必崩。直接用 src_dir。
    mask_img = np.asarray(Image.open(src_dir / 'walk_mask.png').convert('L'), np.uint8)
    walk = mask_img > 127                              # (nz, nx) lab-world grid
    cell = float(max(wk['dx'], wk['dz']))
    z_lab_min, z_lab_max = wk['z0'], wk['z0'] + (wk['nz'] - 1) * wk['dz']
    # game wz = -lab z(实验室为 GL 右手系翻了 Z;游戏约定 det=+1)
    gz_min, gz_max = -z_lab_max, -z_lab_min
    gx_min = wk['x0']
    gw = int(math.ceil((wk['nx'] - 1) * wk['dx'] / cell)) + 1
    gh = int(math.ceil((gz_max - gz_min) / cell)) + 1
    col = np.zeros((gh, gw), np.uint8)
    for gj in range(gh):
        wz_game = gz_min + gj * cell
        z_lab = -wz_game
        zi = int(round((z_lab - wk['z0']) / wk['dz']))
        for gi in range(gw):
            wx = gx_min + gi * cell
            xi = int(round((wx - wk['x0']) / wk['dx']))
            ok = 0 <= zi < wk['nz'] and 0 <= xi < wk['nx'] and walk[zi, xi]
            col[gj, gi] = 0 if ok else 255            # 255 = blocked(红通道)
    col_name = old_cfg.get('collision_map', 'collision.png')
    _asave(Image.fromarray(col), scene_media / col_name, optimize=True)

    # ---- depthConfig 写回场景 JSON(编辑器往返约定,手调参数保值) ----
    c, s = math.cos(theta), math.sin(theta)
    az = math.radians(float(man['params'].get('azimuth_deg', 0.0)))
    R_base = np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])
    if abs(az) > 1e-9:
        ca, sa = math.cos(az), math.sin(az)
        R_base = np.array([[ca, 0, sa], [0, 1, 0], [-sa, 0, ca]]) @ R_base
    cfg = {
        'depth_map': depth_name,
        'collision_map': col_name,
        'M': {'R': [[float(v) for v in row] for row in R_base],
              'ppu': ppu_nat, 'cx': nw / 2.0, 'cy': nh / 2.0},
        'depth_mapping': {'invert': False, 'scale': d_hi - d_lo, 'offset': d_lo},
        'shader': {'depth_per_sy': depth_per_sy},
        'collision': {'x_min': float(gx_min), 'z_min': float(gz_min),
                      'cell_size': cell, 'grid_width': gw, 'grid_height': gh,
                      'height_offset': float((old_cfg.get('collision') or {}).get('height_offset', 0.0))},
        'depth_tolerance': float(old_cfg.get('depth_tolerance', 0.05)),
        'floor_offset': float(old_cfg.get('floor_offset', 0.0)),
    }
    old_scene['depthConfig'] = cfg
    _awrite_text(scene_json_path, json.dumps(old_scene, ensure_ascii=False, indent=2) + '\n')
    print(f'[export-depth] {scene_json_path.name}: depth {nw}x{nh}, '
          f'depth_per_sy={depth_per_sy:.6f}, collision {gw}x{gh} cell={cell:.3f}')
    return cfg


def build_radiance_field(bg_path: Path, work_wh: tuple[int, int], P: dict) -> dict:
    """烘焙用的辐射场 —— **唯一构造处**。烘焙与校验都必须调这里。

    2026-09-01 制作人:「你要确保 ref 计算是正确的,输入的 radiance 源要和 baker
    里一样的 HDR!必须要对齐,否则输入都不一样,对比无意义。」

    ⚠ 这不是假想的风险:第一版 `rebake_lighting` 用 `Image.LANCZOS` 缩图,
    而校验侧用 `resize_rgb`(**BILINEAR**)—— 两个不同的重采样出两个不同的辐射场,
    于是「盘上的 E」和「参照 E」比的根本不是同一件事,而数字看着还挺像回事。
    LANCZOS 还是整个实验室里的异类(`resize_rgb` / `resize_f` 一律 BILINEAR)。

    所以:**只有这一个函数造辐射场**,两边共用。再加一道哈希门(见
    `radiance_sha1`)—— 对齐这件事要能被**证明**,不能靠"我保证"。
    """
    from .scene_geometry import resize_rgb
    img = Image.open(bg_path).convert('RGB')
    rgb = np.asarray(img, np.float32) / 255.0
    if img.size != tuple(work_wh):
        rgb = resize_rgb(rgb, tuple(work_wh))
    return stage_hdr(rgb, P, sem_gate=None)


def radiance_sha1(rad: np.ndarray) -> str:
    """辐射场的内容哈希。写进 `baked_params`,校验时复算比对 —— 不一致即拒绝比较。"""
    return hashlib.sha1(np.ascontiguousarray(rad, np.float32).tobytes()).hexdigest()[:12]


def compose_atlas(base: np.ndarray, emit: np.ndarray, nee: np.ndarray,
                  amb: np.ndarray, *, nee_on: bool, amb_w: float) -> np.ndarray:
    """四分账 → 运行时图集的**唯一**合成式:`base + (nee开?nee:emit) + amb*w`。

    `export_runtime` 与 `rebake_lighting` 都调这里 —— 两处各抄一遍的话,
    「只重烘光照」这条路就会悄悄产出和正规导出不一样的图集。
    返回 (P,K,4) f16,alpha 未用(留 0,与旧版逐字节一致)。
    """
    final = (np.asarray(base, np.float32)
             + np.asarray(nee if nee_on else emit, np.float32)
             + np.asarray(amb, np.float32) * float(amb_w))
    out = np.zeros((*final.shape[:2], 4), np.float16)
    out[:, :, :3] = final.astype(np.float16)
    return out


def rebake_lighting(name: str, background: str | None = None,
                    params: dict | None = None) -> Path:
    """**只重烘光照**(probe 图集 + ambient),不重估深度、不重跑语义分割。

    ## 为什么要有这条路

    改的是光照算法时,重估深度是**错的**:`pipeline.build` 会用 Depth Anything
    重新出一份深度,而 `scene_fields`(天穹遮蔽)读的是运行时那份量化过的
    `raw_depth_rg.png`。两边一旦不是同一份深度,probe 与场景就吃着不同的几何 ——
    这类失配没有任何报错,只是"光的走向有点怪"。

    本函数从**已发行的运行时数据**反推所有几何输入,保证与 `scene_fields` 逐字同源:

    - `cal.d`   <- `raw_depth_rg.png`(原生 RG16)按 depthConfig 解码后重采样到工作分辨率
                   —— 与 `scene_geometry.Scene.geometry()` 同一条路;
    - `d_walk`  <- `lighting/<key>/ground_d.png` + `lighting.json.ground_d.{min,max}`;
    - `M/theta` <- `lighting.json.world.M` / `cal.theta`(实验室 det=-1 那套,查表用);
    - 辐射     <- 运行时背景图 + `baked_params` 里原来那套 HDR 恢复参数。

    ⚠ **不产语义门控**(SAM3 未装):`emit` 恒 0、`base` 拿到全部辐射。
    合成式是 `base + emit + amb`,所以**图集逐位不受影响**;受影响的只有
    `lighting.json.lights`(NEE 光源面元),因此这里**原样保留旧值**,
    不把它清空 —— 那是 RT 调试档 `gatherRT` 在读的。

    不碰:`vol_rad/vol_emit.bin`(体素卷,深度与背景没变则仍然有效)、
    `ground_d.png`、`raw_depth_rg.png`、场景 JSON 的 `depthConfig`。
    """
    from tools.character_lighting_lab.escape import make_escape_sampler
    from tools.character_lighting_lab.scene_geometry import Scene

    scene_dir = ROOT / 'public' / 'resources' / 'runtime' / 'scenes' / name
    bg_name = background or scene_background(name)
    dest = scene_dir / 'lighting' / _bake_key(bg_name)
    lj = dest / 'lighting.json'
    if not lj.exists():
        raise RuntimeError(f'{lj} 不存在 —— 本函数只重烘光照,'
                           f'第一次烘请走完整的 build + export_runtime')
    man = json.loads(lj.read_text(encoding='utf-8'))

    # 沿用这张画原来的 HDR/曝光/几何口径,但**不许继承 probe 那几个**:
    # 它们的语义 2026-09-01 变了(`probe_band=None` = 由角色实高推出),
    # 而存量 `baked_params` 里躺着 `probe_band: 1.6` —— 整份继承会把要杀掉的
    # 那个值**原地复活**,日志照打「角色活动高 1.600」而一切看着正常。
    # (第一次跑就踩了:烘出来仍是「角色纵向跨 0.48 层」。)
    _STALE = {'probe_band', 'probe_nx', 'probe_ny', 'probe_nz', 'probe_dirs',
              'fold', 'probe_strategy', 'probe_dims', 'probe_spp',
              'probe_cells_per_char_xz', 'probe_cells_per_char_y',
              'probe_height_chars', 'probe_max', 'escape'}
    P = dict(DEFAULTS)
    P.update({k: v for k, v in (man.get('baked_params') or {}).items()
              if k in DEFAULTS and k not in _STALE})
    P.update(params or {})                           # 显式传参永远最高优先级
    W, Hh = int(man['work']['w']), int(man['work']['h'])

    # ---- 几何:一律从运行时那份量化深度反推(与 scene_fields 同源)----
    sc = Scene(name, background=bg_name)
    geo = sc.geometry((W, Hh))
    if geo is None:
        raise RuntimeError(f'{name} 没有 depthConfig / 深度图,无法只重烘光照')
    theta = float(man['cal']['theta'])
    M = np.asarray(man['world']['M'], np.float32)    # 实验室 det=-1 那套(查表用)
    cal = {'d': np.ascontiguousarray(geo['depth'], np.float32),
           'ppu': geo['ppu'], 'cx': geo['cx'], 'cy': geo['cy'], 'theta': theta}
    sxg, syg = np.meshgrid(np.arange(W, dtype=np.float32),
                           np.arange(Hh, dtype=np.float32))
    cal['qy'] = ((cal['cy'] - syg) / cal['ppu']).astype(np.float32)
    qx = ((sxg - cal['cx']) / cal['ppu']).astype(np.float32)

    g = np.asarray(Image.open(dest / 'ground_d.png').convert('RGB'), np.float32)
    n16 = g[..., 0] * 256.0 + g[..., 1]
    gd = man['ground_d']
    d_walk = (n16 / 65535.0 * (gd['max'] - gd['min']) + gd['min']).astype(np.float32)
    if d_walk.shape != cal['d'].shape:
        d_walk = resize_f(d_walk, (W, Hh))
    q_ground = np.stack([qx, cal['qy'], d_walk], -1).reshape(-1, 3)
    Yg = (q_ground @ M.T)[:, 1].reshape(Hh, W).astype(np.float32)
    lay = {'d_walk': d_walk, 'Yg': Yg}
    cal['Y'] = (cal['qy'] * math.cos(theta) - cal['d'] * math.sin(theta)).astype(np.float32)

    # ---- 辐射:运行时那张背景 + 原来那套 HDR 恢复参数;无语义门控 ----
    hdr = build_radiance_field(scene_dir / bg_name, (W, Hh), P)   # 唯一构造处
    rad_sha = radiance_sha1(hdr['base'])
    print(f'[radiance] 范围 {hdr["base"].min():.4f}~{hdr["base"].max():.3f}  sha1 {rad_sha}')

    # ---- probe 盒:band 由**角色实高**推出(不是写死的 1.6)----
    char_wu = scene_char_wu(name, cal['ppu'], W)
    band = P.get('probe_band')
    if band is None:
        if char_wu is None:
            raise RuntimeError(f'{name}: 取不到 worldWidth,推不出角色高度;'
                               f'显式传 probe_band')
        band = char_wu * 1.15
    if char_wu is None:
        char_wu = float(band) / 1.15
    wb = world_bounds(cal, lay, P, band=band, char_wu=char_wu,
                      height_chars=float(P.get('probe_height_chars', 2.0)))
    wb['M'] = M                                      # 用发行版那份 M,别另生成一个
    print(f'[scale] 角色 {char_wu:.3f} wu  probe 带 {float(band):.3f} wu')

    escape_of = make_escape_sampler(P.get('escape'), root=ROOT,
                                    hdr=hdr['base'], depth=cal['d'])
    amb = stage_ambient(escape_of, P)
    lights = man.get('lights') or []                 # 原样保留(见 docstring)
    pr = stage_probes(cal, lay, hdr, wb, lights, P, escape_of, char_wu)

    sh_c = _normalize_shading(man.get('shading'))
    nee_on = sh_c['nee'] > 0
    amb_w = float(sh_c['amb'])
    for stem, K in (('l1', 4), ('l2', 9), ('bins', 64)):
        out = compose_atlas(pr[stem][:, :, :3], pr[f'{stem}emit'], pr[f'{stem}nee'],
                            pr[f'{stem}amb'], nee_on=nee_on, amb_w=amb_w)
        _awrite(dest / f'atlas_{"bin" if stem == "bins" else stem}.bin', out.tobytes())
    _awrite(dest / 'probes_valid.bin', (pr['valid'].astype(np.uint8) * 255).tobytes())

    # ⚠ M **原样回写**,不许过一趟 float32 再 float() —— 那会把
    #   0.7071067811865476 降成 0.7071067690849304。语义没变,但这是无谓的精度损失,
    #   而且让每次重烘的 diff 都多出三行噪声(第一次跑就这么写错了)。
    man['world'] = dict(M=man['world']['M'],
                        x0=wb['x0'], x1=wb['x1'], y0=wb['y0'], y1=wb['y1'],
                        z0=wb['z0'], z1=wb['z1'])
    man['probes'] = {'nx': pr['nx'], 'ny': pr['ny'], 'nz': pr['nz']}
    man['ambient_sh'] = amb['sh'].reshape(-1).tolist()
    bp = dict(man.get('baked_params') or {})
    bp.update({k: P[k] for k in ('probe_strategy', 'probe_dims', 'probe_spp',
                                 'probe_cells_per_char_xz', 'probe_cells_per_char_y',
                                 'probe_height_chars', 'probe_max')})
    bp['probe_band'] = float(band)
    bp['escape'] = P.get('escape')
    bp['char_wu'] = float(char_wu)
    bp['probe_hit_rate'] = pr['hit_rate']
    # 辐射场的内容哈希:校验侧复算后必须逐位对上,否则"参照"和"盘上的"
    # 根本不是同一个输入,比出来的数一律无意义(见 build_radiance_field)。
    bp['radiance_sha1'] = rad_sha
    # ⚠ **只许写 ASCII 的结构化数字,不许把人话塞进运行时载荷。**
    #   第一版写了 `probe_layout_note`(带中文和 ⚠),而 `lighting.json` 历来是纯 ASCII,
    #   `tools/editor/validator.py` 读它时没指定编码 => Windows 按 GBK 解 => 整份载荷
    #   在校验器里报 "解析失败",而游戏侧(fetch + UTF-8)一切正常 —— 最难查的一类。
    cell = pr['layout'].cell_size()
    bp['probe_cell_wu'] = [float(v) for v in cell]
    bp['probe_layers_per_char'] = float(char_wu / max(cell[1], 1e-9))
    bp['probe_coverage'] = float(pr['coverage'])
    man['baked_params'] = bp
    bp.pop('probe_layout_note', None)                # 早期版本塞过人话,清掉(见上)
    man['built'] = time.strftime('%Y-%m-%d %H:%M:%S')
    man['rebaked_lighting_only'] = True              # 留痕:这份不是完整 build 产的
    text = json.dumps(man, ensure_ascii=False, indent=1) + '\n'
    # 硬闸:`lighting.json` 历来是纯 ASCII,而 validator 读它时没指定编码
    # (Windows 按 GBK 解)。写进一个非 ASCII 字符就会让校验器报「解析失败」,
    # 而游戏侧 fetch+UTF-8 一切正常 —— 与其等下次踩,不如在这里当场炸。
    try:
        text.encode('ascii')
    except UnicodeEncodeError as exc:
        raise RuntimeError(
            f'lighting.json 里出现了非 ASCII 字符({exc.object[exc.start:exc.end]!r}) —— '
            f'运行时载荷只放 ASCII 的结构化数据,人话写到日志或 geometry.json 去') from exc
    _awrite_text(lj, text)
    print(f'[rebake] {dest}')
    return dest


def _parse_escape(spec: str, intensity: float) -> dict:
    """`--escape` 的取值 -> `escape.make_escape_sampler` 的 spec。

    缺省是 black(制作人 2026-09-01)。`scene_derived` 是**显式**选项且带警告:
    历史上从画面反推逃逸辐射翻过车,见 escape.py 的模块文档。
    """
    s = spec.strip()
    low = s.lower()
    if low == 'black':
        return {'mode': 'black'}
    if low == 'white':
        return {'mode': 'color', 'color': [1.0, 1.0, 1.0], 'intensity': intensity}
    if low == 'scene_derived':
        return {'mode': 'scene_derived', 'intensity': intensity}
    if ',' in s:
        rgb = [float(v) for v in s.split(',')]
        if len(rgb) != 3:
            raise SystemExit(f'--escape 的颜色要三个数,收到 {spec!r}')
        return {'mode': 'color', 'color': rgb, 'intensity': intensity}
    return {'mode': 'skybox', 'file': s, 'intensity': intensity}


def main():
    # Windows 控制台默认 GBK,本模块的日志与帮助文本里有中文和 ⚠ —— 不 reconfigure
    # 就会在 `--help` 或任意一条中文日志上抛 UnicodeEncodeError 而**整个烘焙中断**
    # (与 scene_fields.main 同一处理)。
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser()
    ap.add_argument('image', type=Path)
    ap.add_argument('--name', default=None)
    ap.add_argument('--export-runtime', action='store_true',
                    help='烘焙后同时导出游戏运行时载荷')
    ap.add_argument('--export-depth', action='store_true',
                    help='同时导出深度/碰撞(depthConfig)。⚠ 重烘后**必须**跟着导，'
                         '否则新 ground_d 配旧 collision.png,出生点会落进墙里')
    ap.add_argument('--background', default=None,
                    help='这是该场景的哪张背景(如 background_relight_夜.png);'
                         '缺省=场景当前 backgrounds[0]。决定工作目录与导出落点')
    # ⚠ 自动生成只对**标量**缺省有效。`probe_dims`(元组)/`escape`(字典)/
    #   `probe_band`(None)三个的 `type=type(v)` 会分别变成 tuple/dict/NoneType,
    #   传参当场炸 —— 它们下面显式声明。
    _MANUAL = {'probe_dims', 'escape', 'probe_band'}
    for k, v in DEFAULTS.items():
        if k in _MANUAL:
            continue
        ap.add_argument(f'--{k}', type=type(v), default=None)

    g = ap.add_argument_group('probe 分布(烘焙期可调,见 probe_layout.py)')
    g.add_argument('--probe-dims', dest='probe_dims', default=None,
                   help='显式格数 "nx,ny,nz"(缺省 20,6,14 = 现役载荷大小);'
                        '传 auto 则按角色高度推密度')
    g.add_argument('--probe-band', dest='probe_band', type=float, default=None,
                   help='角色可达高度带(wu)。缺省由**角色实高**推出(char_wu*1.15)。'
                        '⚠ 别再手填 1.6,那是"角色高 1.5 wu"的遗留假设,'
                        '实测角色 0.17~0.97 wu')

    e = ap.add_argument_group('逃逸辐射(射线跑出画外带走多少,见 escape.py)')
    e.add_argument('--escape', default=None,
                   help='black(缺省) | white | "r,g,b" | 某张 equirect 天空图路径 | '
                        'scene_derived ⚠(从画面反推,慎用)')
    e.add_argument('--escape-intensity', dest='escape_intensity', type=float,
                   default=1.0)

    args = ap.parse_args()
    params = {k: getattr(args, k) for k in DEFAULTS
              if k not in _MANUAL and getattr(args, k) is not None}

    if args.probe_dims is not None:
        if args.probe_dims.strip().lower() in ('auto', 'none', ''):
            params['probe_dims'] = None          # 按 probe_cells_per_char_xz 推密度
        else:
            xs = [int(v) for v in args.probe_dims.replace('x', ',').split(',')]
            if len(xs) != 3:
                raise SystemExit(f'--probe-dims 要三个数,收到 {args.probe_dims!r}')
            params['probe_dims'] = tuple(xs)
    if args.probe_band is not None:
        params['probe_band'] = args.probe_band
    if args.escape is not None:
        params['escape'] = _parse_escape(args.escape, args.escape_intensity)
    name = args.name or args.image.stem
    bg = args.background or args.image.name
    build(args.image.resolve(), name, params, background=bg)
    if args.export_runtime:
        export_runtime(name, background=bg)
    if args.export_depth:
        export_scene_depth(name, background=bg)


if __name__ == '__main__':
    main()
