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

TOOL = Path(__file__).resolve().parent
OUT = TOOL / 'out'
ROOT = TOOL.parents[1]            # repo root (tools/character_lighting_lab/..)
sys.path.insert(0, str(ROOT))

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
    probe_nx=20, probe_ny=6, probe_nz=14,  # WORLD-space probe grid (x, up, depth)
    probe_dirs=196,
    probe_band=1.6,        # **角色最大活动高度**(世界单位,中位地面往上)= probe 盒顶。
                           # ≈ 角色身高 1.5 + 余量;人只在地上活动,头顶以上没人,
                           # 烘上去就是稀释那 ny 层的竖直分辨率(实测见 world_bounds)。
    fold=1,                # double-sided fold for camera-side rays (0/1)
    semantic_gate=1,       # SAM3 object-gated emitter confidence (0/1)
    relief=1.8,            # structure depth gain relative to the pinned ground
                           # (compensates monocular vertical-contrast compression)
    occluder_tau=0.10,     # pop-out threshold, fraction of depth range
    thickness_k=0.55,      # occluder thickness = k * min(bbox)/ppu
    bg_thickness_q=0.60,   # default slab thickness for background shell (q units)
    ground_up_dot=0.75,    # world-up cosine threshold for ground candidacy
    object_seg=1,          # 图像域物体识别(先扣物体、剩下才是地形);0=退回旧的纯几何猜地面
    object_score_min=0.35, # 实例采信分数门槛(调它不必重跑推理)
    object_groups='',      # 提示词组,逗号分隔;空=默认组(见 object_seg.DEFAULT_GROUPS)
    object_prompts_extra='',  # 本场景额外提示词,逗号分隔
    # 几何兜底默认关:2026-07-23 在 雾津街头(城镇)与 阎王岭山口(山地) 两张图实测
    # **零收益**——它补判的抬升块早已被「朝上+从画面底部洪泛」排除在地面掩膜之外,
    # 却要多标 +14~20% 的画面为物体。真山坡上它还有把地形误判成建筑的风险。
    # 留作 opt-in:某场景 SAM 词表整类漏检时再开。
    object_geom_fallback=0,   # 几何兜底:补判 SAM 漏掉的抬升结构
    ground_max_step_frac=0.04,  # 抬升阈值,占画幅高的比例(尺度无关;街面自身起伏约 1.5%)
    walk_res=160,          # world XZ walk grid resolution (max dimension)
)


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
                'object_seg', 'object_score_min', 'object_groups', 'object_prompts_extra',
                'object_geom_fallback', 'ground_max_step_frac')
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
        return np.load(cache)
    print(f'[depth] inferring with Depth Anything ({model})...', flush=True)
    from tools.scene_depth_editor.depth_estimator import DepthEstimator, MODEL_OPTIONS
    est = DepthEstimator()
    src = Image.open(img_path).convert('RGB')
    res = est.generate_depth(src, MODEL_OPTIONS.get(model, MODEL_OPTIONS['base']),
                             lambda s: print('  ', s, flush=True))
    raw = np.asarray(res.raw_normalized, np.float32)
    cache_dir.mkdir(parents=True, exist_ok=True)
    np.save(cache, raw)
    return raw


def _ground_mask_from(d, qy, theta, thresh, prior=None):
    """Up-facing surfaces flood-connected to the frame bottom.

    ``prior`` = 候选地形(物体识别的补集)。给了就先与之取交——朝上判据本身分不开
    「街面」和「屋顶」(两者都朝上、还在 2D 上连成一片),必须靠物体掩膜先切断。
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


def augment_objects_geometric(cal: dict, objects: np.ndarray, P: dict,
                              status=print) -> np.ndarray:
    """几何兜底:把 SAM 漏掉的抬升结构补判为物体。

    语义分割再准也会漏(词表覆盖不到的物件、被裁切的边角楼)。漏一座房子,它就
    整个被烘进地形高度场,角色站到那一列时脚深度取到屋顶——正是这套东西最初的病。
    所以在语义之后加一道纯几何的网:**候选地形里凡是明显高出四周地形的连通块,
    补判为物体**。

    阈值用「抬升量折算成屏幕表观高度,占画幅高的比例」表达,与场景尺度无关
    (实测:雾津街头街面自身起伏约占画幅 1.5%,屋顶高出约 7.6%)。
    """
    Y = cal['Y']
    gm = cal['ground_mask']
    Hg, Wg = Y.shape
    if not gm.any():
        return objects
    # 以已确认地面外推出「四周地形应有的高度」,抬升量相对它算
    Ybase = gaussian_filter(laplace_inpaint(Y, gm, iters=200), 2.0)
    rise_px = (Y - Ybase) * math.cos(cal['theta']) * cal['ppu']
    thr = float(P.get('ground_max_step_frac', 0.04)) * Hg
    cand = (rise_px > thr) & ~objects
    cand = binary_opening(cand, np.ones((3, 3)))
    lab_, n = label(cand)
    min_area = max(64, int(0.0004 * Hg * Wg))
    add = np.zeros_like(objects)
    kept = 0
    for i in range(1, n + 1):
        m = lab_ == i
        if m.sum() < min_area:
            continue
        add |= m
        kept += 1
    if not kept:
        return objects
    add = binary_fill_holes(binary_closing(add, np.ones((5, 5))))
    status(f'[objects] 几何兜底补判 {kept} 块抬升结构 '
           f'(阈值 {thr:.0f}px = 画幅 {P.get("ground_max_step_frac", 0.04)*100:.0f}%, '
           f'+{add.mean() * 100:.1f}% 画面)')
    return objects | add


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


def _ray_box_enter(pos: np.ndarray, dirs_i: np.ndarray, N: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """把每条射线推进到体素盒 [0,N-1] 的入口(slab 求交),返回新起点与"能进盒"掩码。

    为什么需要:伪世界只覆盖画面那一块 q 盒,**画面上边缘以上就没有数据了**。而世界里
    "地面往上 1.5m"(角色头顶)对远处地面来说恰恰落在图外——实测 44~83% 的角色位置如此。
    起点在盒外就一步出界的老写法会让这些 probe 全程 miss、被判废,角色上半身只能退回
    全局环境。盒外是**未观测的空气**(closure 本来就用 J̄ 兜 miss),射线理应能从那儿飞进来
    打到下面的几何——这与"把体素盒往上垫一层空体素"数学等价,但不花一分内存。"""
    d = np.where(np.abs(dirs_i) < 1e-9, 1e-9, dirs_i)
    lo = (0.0 - pos) / d
    hi = ((N - 1).astype(np.float32) - pos) / d
    t_near = np.maximum(np.minimum(lo, hi), 0.0).max(-1)      # 已在盒内 → 0
    t_far = np.maximum(lo, hi).min(-1)
    enters = t_far >= t_near
    return pos + dirs_i * t_near[..., None], enters


def _trace(vol: dict, origins: np.ndarray, dirs: np.ndarray, step=0.9, max_steps=220,
           fold: bool = False):
    """March rays in voxel index space. origins (P,3) index coords, dirs (D,3)
    in q-space (will be scaled per-axis to index space). Returns radiance (P,D,3)
    and hit mask (P,D).
    origins 允许在盒外:先 _ray_box_enter 推进到入口再走(见该函数注释)。
    fold: double-sided paper closure -- camera-side rays (dz<0) are traced with
    the qz component mirrored, so they sample the local OBSERVED half instead
    of exiting instantly. Misses after folding fall to the caller's ambient."""
    if fold:
        dirs = dirs.copy()
        dirs[:, 2] = np.abs(dirs[:, 2])
    Nx, Ny, Nz = vol['Nx'], vol['Ny'], vol['Nz']
    scale = np.array([(Nx - 1) / (vol['qx_max'] - vol['qx_min']),
                      (Ny - 1) / (vol['qy_max'] - vol['qy_min']),
                      (Nz - 1) / (vol['qz_max'] - vol['qz_min'])], np.float32)
    dirs_i = dirs[None, :, :] * scale[None, None, :]
    dl = np.linalg.norm(dirs_i, axis=-1, keepdims=True)
    dirs_i = dirs_i / np.maximum(dl, 1e-9)
    Pn, Dn = origins.shape[0], dirs.shape[0]
    pos = np.repeat(origins[:, None, :], Dn, axis=1).astype(np.float32)
    pos, alive = _ray_box_enter(pos, np.broadcast_to(dirs_i, pos.shape),
                                np.array([Nx, Ny, Nz], np.float32))
    hit = np.zeros((Pn, Dn), bool)
    hidx = np.full((Pn, Dn), -1, np.int64)     # flat voxel index of first hit
    occ3 = vol['occ3']
    for _ in range(max_steps):
        if not alive.any():
            break
        pos += dirs_i * step * alive[..., None]
        xi = np.round(pos[..., 0]).astype(np.int32)
        yi = np.round(pos[..., 1]).astype(np.int32)
        zi = np.round(pos[..., 2]).astype(np.int32)
        inside = (xi >= 0) & (xi < Nx) & (yi >= 0) & (yi < Ny) & (zi >= 0) & (zi < Nz)
        xic = np.clip(xi, 0, Nx - 1); yic = np.clip(yi, 0, Ny - 1); zic = np.clip(zi, 0, Nz - 1)
        solid = occ3[zic, yic, xic] & inside & alive
        if solid.any():
            hidx[solid] = (zic[solid].astype(np.int64) * Ny + yic[solid]) * Nx + xic[solid]
            hit |= solid
        alive &= inside & ~solid
    return hidx, hit


def _gather_at(vol_field: np.ndarray, hidx: np.ndarray) -> np.ndarray:
    """Sample a (Nz,Ny,Nx,3) field at flat hit indices; misses -> 0."""
    flat = vol_field.reshape(-1, 3)
    out = np.zeros((*hidx.shape, 3), np.float32)
    m = hidx >= 0
    out[m] = flat[hidx[m]]
    return out


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


def stage_ambient(vol: dict, cal: dict, lay: dict, P: dict) -> dict:
    """J-bar: gather at a few free points near character height around centre,
    renormalized over hits, projected to SH L2 on radiance."""
    theta = cal['theta']
    dirs = fib_sphere(768)
    # sample points: centre of walkable area at ~0.8 world units above ground
    Hg, Wg = cal['d'].shape
    ys, xs = np.where(cal['ground_mask'])
    pts = []
    for f in ((0.5, 0.5), (0.35, 0.6), (0.65, 0.6)):
        j = int(len(xs) * f[0]) if len(xs) else 0
        sx, sy = (xs[j], ys[j]) if len(xs) else (Wg // 2, int(Hg * 0.7))
        qx = (sx - cal['cx']) / cal['ppu']; qyv = (cal['cy'] - sy) / cal['ppu']
        dz = lay['d_walk'][sy, sx] - 0.8 * math.sin(theta) / 1.0  # lift ~0.8 wu toward camera
        ix = (qx - vol['qx_min']) / (vol['qx_max'] - vol['qx_min']) * (vol['Nx'] - 1)
        iy = (qyv + 0.8 * math.cos(theta) / 1.0 - vol['qy_min']) / (vol['qy_max'] - vol['qy_min']) * (vol['Ny'] - 1)
        iz = (dz - vol['qz_min']) / (vol['qz_max'] - vol['qz_min']) * (vol['Nz'] - 1)
        pts.append([ix, iy, iz])
    hidx, hit = _trace(vol, np.array(pts, np.float32), dirs)
    L = _gather_at(vol['rad3'], hidx) + _gather_at(vol['emi3'], hidx)   # J-bar sees FULL
    hits = hit.reshape(-1)
    Lf = L.reshape(-1, 3)[hits]
    df = np.repeat(dirs[None], len(pts), 0).reshape(-1, 3)[hits]
    if len(Lf) < 10:
        sh = np.zeros((9, 3), np.float32); mean = np.zeros(3, np.float32)
    else:
        B = sh_basis(df)
        sh = (B[:, :, None] * Lf[:, None, :]).mean(0) * (4.0 * math.pi)
        mean = Lf.mean(0)
    print(f'[ambient] hit fraction {hits.mean()*100:.1f}%, mean {mean.round(3)}')
    return dict(sh=sh.astype(np.float32), mean=mean, hit_fraction=float(hits.mean()))


A_L = np.array([math.pi, 2.0 * math.pi / 3.0, math.pi / 4.0], np.float32)


def world_bounds(cal: dict, lay: dict, P: dict) -> dict:
    """WORLD-space AABB of the character-relevant band: ground .. ground+band.

    这就是 probe 盒。x/z 取地面片的世界范围;y **由"人能到哪"定死**:

    - 下界:最低地面往下一点点(人站地面上,地下没人)。
    - 上界:**中位地面 + 角色最大活动高度**(`probe_band`,默认 1.6 ≈ 角色身高 1.5 + 余量)。
      人只在地上活动,头顶以上没人,烘上去纯浪费层数。

    别再按"地面 + 一个宽带"或"顶到画面/体素盒"去摊——实测(bridge,6 层,对角色
    身上 0.1~1.55m 与射线真值比):盒顶 1.35~1.6 平均误差 8.4%,摊到 2.45/2.85 是
    12.4%/11.1%(层距被稀释),压到世界最高点 1.10 又太紧(头顶被钳,17%)。
    层数就那么几层,**盒顶贴着人的头顶**时最准。

    地面起伏大时用 g98+0.3 兜底(站高处的人头顶也得有层);再套一道常识上界
    "不超过世界最高点 3m"。盒**不必**整个落在体素盒(画面盒)内——盒外由 _trace
    的射线-盒求交正常采样(见 _ray_box_enter),但那是兜底,不是往天上放 probe 的理由。"""
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
    band = float(P['probe_band'])                 # 角色最大活动高度(地面往上)
    y0 = g02 - 0.15
    y1 = max(g50 + band, g98 + 0.30)              # 头顶为界;地面起伏大时抬一点兜底
    y1 = min(y1, world_top + 3.0)                 # 常识上界:人不会比世界最高点还高 3m
    y1 = max(y1, y0 + 0.80)                       # 别塌成一张饼
    print(f'[bounds] 地面 P2/P50/P98 {g02:.2f}/{g50:.2f}/{g98:.2f}  世界最高点 {world_top:.2f}  '
          f'角色活动高 {band}  → probe 盒 y[{y0:.2f},{y1:.2f}]')
    return dict(M=M, x0=x0, x1=x1, y0=y0, y1=y1, z0=z0, z1=z1)


def _world_to_volidx(Xw: np.ndarray, wb: dict, vol: dict) -> np.ndarray:
    q = Xw @ wb['M']            # M orthonormal: inverse = transpose; X@M == (M.T@X.T).T
    ix = (q[..., 0] - vol['qx_min']) / (vol['qx_max'] - vol['qx_min']) * (vol['Nx'] - 1)
    iy = (q[..., 1] - vol['qy_min']) / (vol['qy_max'] - vol['qy_min']) * (vol['Ny'] - 1)
    iz = (q[..., 2] - vol['qz_min']) / (vol['qz_max'] - vol['qz_min']) * (vol['Nz'] - 1)
    return np.stack([ix, iy, iz], -1).astype(np.float32)


def _visible_to(vol: dict, origins_idx: np.ndarray, target_idx: np.ndarray,
                step=0.9, eps_vox=1.8) -> np.ndarray:
    """Per-origin visibility toward one target point (all in voxel index space)."""
    delta = target_idx[None, :] - origins_idx
    dist = np.linalg.norm(delta, axis=1)
    dirn = delta / np.maximum(dist[:, None], 1e-6)
    nmax = np.maximum(((dist - eps_vox) / step), 0).astype(np.int32)
    pos = origins_idx.astype(np.float32).copy()
    blocked = np.zeros(len(origins_idx), bool)
    alive = nmax > 0
    occ3 = vol['occ3']
    Nx, Ny, Nz = vol['Nx'], vol['Ny'], vol['Nz']
    for s in range(int(nmax.max()) if len(nmax) else 0):
        act = alive & (s < nmax) & ~blocked
        if not act.any():
            break
        pos[act] += dirn[act] * step
        rx, ry, rz = (np.round(pos[act, i]).astype(np.int32) for i in (0, 1, 2))
        # 盒外的采样点不算遮挡(老写法 clip 到盒面,会把盒面上的实心误判成挡光)
        ins = ((rx >= 0) & (rx < Nx) & (ry >= 0) & (ry < Ny) & (rz >= 0) & (rz < Nz))
        xi = np.clip(rx, 0, Nx - 1); yi = np.clip(ry, 0, Ny - 1); zi = np.clip(rz, 0, Nz - 1)
        hitb = occ3[zi, yi, xi] & ins
        idx = np.where(act)[0]
        blocked[idx[hitb]] = True
    return ~blocked


def stage_probes(vol: dict, amb: dict, wb: dict, lights: list[dict], P: dict) -> dict:
    """WORLD-axis-aligned probe volume over the reachable band. Gathers happen
    in the q voxel grid (isometric to world), interpolation axes are world."""
    Nx, Ny, Nz = int(P['probe_nx']), int(P['probe_ny']), int(P['probe_nz'])
    gx = np.linspace(wb['x0'], wb['x1'], Nx)
    gy = np.linspace(wb['y0'], wb['y1'], Ny)
    gz = np.linspace(wb['z0'], wb['z1'], Nz)
    PX, PY, PZ = np.meshgrid(gx, gy, gz, indexing='ij')
    world_pos = np.stack([PX, PY, PZ], -1).reshape(-1, 3)
    origins = _world_to_volidx(world_pos, wb, vol)
    occ = vol['occ3']
    idx_near = distance_transform_edt(occ, return_distances=False, return_indices=True)
    oi = origins.round().astype(np.int32)
    zc = np.clip(oi[:, 2], 0, vol['Nz'] - 1)
    yc = np.clip(oi[:, 1], 0, vol['Ny'] - 1)
    xc = np.clip(oi[:, 0], 0, vol['Nx'] - 1)
    off_grid = ((oi[:, 0] != np.clip(oi[:, 0], 0, vol['Nx'] - 1)) |
                (oi[:, 1] != np.clip(oi[:, 1], 0, vol['Ny'] - 1)) |
                (oi[:, 2] != np.clip(oi[:, 2], 0, vol['Nz'] - 1)))
    # 实心吸附只对**盒内**的 probe 做:盒外的原点是合法的(角色带高过画面上沿),
    # 拿盒面上的实心去判它"埋在墙里"再吸附,只会把它拽回盒里、丢掉真实位置。
    inside_solid = occ[zc, yc, xc] & ~off_grid
    nz_, ny_, nx_ = idx_near[0][zc, yc, xc], idx_near[1][zc, yc, xc], idx_near[2][zc, yc, xc]
    do_snap = inside_solid
    origins[do_snap, 0] = nx_[do_snap].astype(np.float32)
    origins[do_snap, 1] = ny_[do_snap].astype(np.float32)
    origins[do_snap, 2] = nz_[do_snap].astype(np.float32)
    # 盒外 probe 不再判废:_trace 会把射线推进到盒入口再走,它们照样采到下方的几何,
    # miss 由 closure 的 J̄ 兜住——这正是"画面上沿以上是开阔空气"的正确答案。
    # valid 保留在载荷里(格式不变),现在恒为 1;着色器因此不再丢角、也不会突然掉回全局环境。
    valid = np.ones(len(origins), bool)

    dirs = fib_sphere(int(P['probe_dirs']))
    t0 = time.time()
    hidx, hit = _trace(vol, origins, dirs, fold=bool(P['fold']))
    # FOUR-way split, all runtime-combinable without rebake:
    #   E_base    -- cosine gather over the painting (all real bounces)
    #   E_emitray -- cosine gather over the emissive delta (NEE OFF path)
    #   E_nee     -- analytic per-light direct term with visibility (NEE ON path)
    #   E_amb+cov -- closure machinery (unchanged semantics)
    mdirs = dirs.copy(); mdirs[:, 2] = np.abs(mdirs[:, 2])
    Bm = sh_basis(mdirs)
    Lmiss = np.clip(Bm @ amb['sh'], 0, None)          # (D,3)
    miss = (~hit).astype(np.float32)
    hitf = hit.astype(np.float32)
    L_base = _gather_at(vol['rad3'], hidx)
    L_emit = _gather_at(vol['emi3'], hidx)

    dw = 4.0 * math.pi / dirs.shape[0]
    B = sh_basis(dirs)                                # (D,9)
    lofk = np.array([0, 1, 1, 1, 2, 2, 2, 2, 2])
    Ak = A_L[lofk]
    Esh_base = np.einsum('dk,pdc->pkc', B, L_base) * dw * Ak[None, :, None]
    Esh_emit = np.einsum('dk,pdc->pkc', B, L_emit) * dw * Ak[None, :, None]
    Esh_amb = np.einsum('dk,pd,dc->pkc', B, miss, Lmiss) * dw * Ak[None, :, None]
    cov_sh = np.einsum('dk,pd->pk', B, hitf) * dw * Ak[None, :]      # (P,9)

    # bins basis
    ob = 8
    uu, vv = np.meshgrid((np.arange(ob) + 0.5) / ob * 2 - 1, (np.arange(ob) + 0.5) / ob * 2 - 1)
    nz = 1.0 - np.abs(uu) - np.abs(vv)
    nx = np.where(nz >= 0, uu, (1 - np.abs(vv)) * np.sign(uu))
    ny = np.where(nz >= 0, vv, (1 - np.abs(uu)) * np.sign(vv))
    nrm = np.stack([nx, ny, nz], -1).reshape(-1, 3)
    nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
    cosw = np.clip(nrm @ dirs.T, 0, None) * dw        # (64,D)
    Eb_base = np.einsum('nd,pdc->pnc', cosw, L_base)
    Eb_emit = np.einsum('nd,pdc->pnc', cosw, L_emit)
    Eb_amb = np.einsum('nd,pd,dc->pnc', cosw, miss, Lmiss)
    cov_b = np.einsum('nd,pd->pn', cosw, hitf) / math.pi

    # ---- NEE: analytic direct from light surfels, exact SH/bin projection ----
    # probe world positions of the actual (snapped) gather points
    snapped_q = np.stack([
        origins[:, 0] / (vol['Nx'] - 1) * (vol['qx_max'] - vol['qx_min']) + vol['qx_min'],
        origins[:, 1] / (vol['Ny'] - 1) * (vol['qy_max'] - vol['qy_min']) + vol['qy_min'],
        origins[:, 2] / (vol['Nz'] - 1) * (vol['qz_max'] - vol['qz_min']) + vol['qz_min'],
    ], -1)
    snapped_world = snapped_q @ wb['M'].T
    Pn = len(origins)
    nee_sh = np.zeros((Pn, 9, 3), np.float32)
    nee_bins = np.zeros((Pn, 64, 3), np.float32)
    for li in lights:
        lpos = np.array(li['pos'], np.float32)
        lnrm = np.array(li['normal'], np.float32)
        Le = np.array(li['radiance'], np.float32)
        delta = lpos[None] - snapped_world
        r2 = np.maximum((delta ** 2).sum(1), 0.04)
        d_i = delta / np.sqrt(r2)[:, None]
        # ISOTROPIC surfels (flames/windows glow in all directions), matching the
        # ray path where emissive voxels return radiance direction-independently.
        # A one-sided Lambert cos_e killed flames whose height-field normal faces
        # the camera; small-sphere cross-section A/r^2 is the consistent model.
        lt_idx = _world_to_volidx(lpos[None], wb, vol)[0]
        V = _visible_to(vol, origins, lt_idx).astype(np.float32)
        W = (V * li['area'] / r2)[:, None] * Le[None]                 # (P,3)
        Bi = sh_basis(d_i)                                            # (P,9)
        nee_sh += (Bi * Ak[None, :])[:, :, None] * W[:, None, :]
        cosb = np.clip(nrm @ d_i.T, 0, None)                          # (64,P)
        nee_bins += cosb.T[:, :, None] * W[:, None, :]

    E_l1 = np.concatenate([Esh_base[:, :4], cov_sh[:, :4, None]], -1)   # (P,4,4)
    E_l2 = np.concatenate([Esh_base, cov_sh[:, :, None]], -1)           # (P,9,4)
    E_l1_amb = Esh_amb[:, :4]
    E_l2_amb = Esh_amb
    E_bins = np.concatenate([Eb_base, cov_b[..., None]], -1)            # (P,64,4)
    E_bins_amb = Eb_amb
    E_l1_emit, E_l2_emit, E_bins_emit = Esh_emit[:, :4], Esh_emit, Eb_emit
    E_l1_nee, E_l2_nee, E_bins_nee = nee_sh[:, :4], nee_sh, nee_bins

    print(f'[probes] {origins.shape[0]} world probes x {dirs.shape[0]} dirs '
          f'(fold={int(bool(P["fold"]))}, lights={len(lights)}) in {time.time()-t0:.1f}s, '
          f'nee mean {float(nee_sh[:, 0, :].mean()):.4f}')
    print(f'[probes] box y[{wb["y0"]:.2f},{wb["y1"]:.2f}] band={float(P["probe_band"])} '
          f'({(wb["y1"]-wb["y0"])/max(Ny-1,1):.2f}m/层)  盒外(画面外空气,靠射线-盒求交采样) '
          f'{off_grid.mean()*100:.1f}%  实心吸附 {inside_solid.mean()*100:.1f}%  '
          f'命中率 {hit.mean()*100:.1f}%')
    return dict(nx=Nx, ny=Ny, nz=Nz, gx=gx, gy=gy, gz=gz, valid=valid,
                world_pos=snapped_world.astype(np.float32),
                l1=E_l1.astype(np.float16), l2=E_l2.astype(np.float16),
                bins=E_bins.astype(np.float16),
                l1amb=E_l1_amb.astype(np.float16), l2amb=E_l2_amb.astype(np.float16),
                binsamb=E_bins_amb.astype(np.float16),
                l1emit=E_l1_emit.astype(np.float16), l2emit=E_l2_emit.astype(np.float16),
                binsemit=E_bins_emit.astype(np.float16),
                l1nee=E_l1_nee.astype(np.float16), l2nee=E_l2_nee.astype(np.float16),
                binsnee=E_bins_nee.astype(np.float16))


def stage_character(P: dict, out_dir: Path):
    """Shared character assets: albedo frame + bulged normal/offset map."""
    ch = TOOL / 'char'
    ch.mkdir(exist_ok=True)
    alb_p, nrm_p = ch / 'albedo.png', ch / 'normal.png'
    if alb_p.exists() and nrm_p.exists():
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


# ---------------------------------------------------------------- main build
def build(img_path: Path, name: str, params: dict):
    P = {**DEFAULTS, **params}
    out_dir = OUT / name
    out_dir.mkdir(parents=True, exist_ok=True)
    h = img_hash(img_path)

    src = Image.open(img_path).convert('RGB')
    raw_native = stage_depth(img_path, out_dir, h, model=str(P.get('depth_model', 'base')))
    Hg = round(src.height * W_G / src.width)
    raw = resize_f(raw_native, (W_G, Hg))
    rgb_srgb = np.asarray(src.resize((W_G, Hg), Image.Resampling.LANCZOS), np.float32) / 255.0

    # ① 物体识别(只看图,不依赖深度)。地形 = 扣掉物体之后剩下的部分——
    #    朝上判据分不开街面与屋顶,必须先由这一步切断,否则房子会被烘进地形高度场。
    objects = None
    if int(P.get('object_seg', 1)):
        from tools.character_lighting_lab.object_seg import object_mask, segment_objects
        obj_ids_native, obj_meta = segment_objects(img_path, out_dir, h, P)
        obj_ids = resize_nn(obj_ids_native, (W_G, Hg))
        obj_edit = load_object_edit(out_dir, (Hg, W_G))
        objects = object_mask(obj_ids, obj_meta, P, obj_edit)
        np.save(out_dir / 'object_mask.npy', objects)
        print(f'[objects] 物体占画面 {objects.mean() * 100:.1f}%,候选地形 {(~objects).mean() * 100:.1f}%')

    cal = stage_calibrate(raw, P, ground_prior=None if objects is None else ~objects)
    if objects is not None and int(P.get('object_geom_fallback', 1)):
        aug = augment_objects_geometric(cal, objects, P)
        if aug.sum() > objects.sum():
            objects = aug
            refresh_ground_mask(cal, objects, P)
            np.save(out_dir / 'object_mask.npy', objects)
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
    wb = world_bounds(cal, lay, P)
    lights = stage_lights(cal, lay, hdr['emit'], wb, P)
    amb = stage_ambient(vol, cal, lay, P)
    probes = stage_probes(vol, amb, wb, lights, P)
    walk = stage_walk_world(cal, lay, vol, wb, P,
                            col_edit=load_collision_edit(out_dir, cal['d'].shape))
    cloud = stage_pointcloud(cal, lay, rgb_srgb, wb)
    mesh = stage_mesh(cal, lay, rgb_srgb, wb, P)
    stage_character(P, out_dir)

    # ---- write outputs
    src.save(out_dir / 'background.png') if not (out_dir / 'background.png').exists() else None
    (out_dir / 'front_depth.bin').write_bytes(cal['d'].astype(np.float32).tobytes())
    (out_dir / 'walk_depth.bin').write_bytes(lay['d_walk'].astype(np.float32).tobytes())
    Image.fromarray((walk['mask'] * 255).astype(np.uint8)).save(out_dir / 'walk_mask.png')
    (out_dir / 'walk_y.bin').write_bytes(walk['y'].astype(np.float32).tobytes())
    rgba = np.concatenate([vol['rad3'], vol['occ3'][..., None].astype(np.float32)], -1)
    (out_dir / 'volume.bin').write_bytes(rgba.astype(np.float16).tobytes())
    rgba_e = np.concatenate([vol['emi3'], np.zeros_like(vol['emi3'][..., :1])], -1)
    (out_dir / 'volume_emit.bin').write_bytes(rgba_e.astype(np.float16).tobytes())
    for k in ('l1', 'l2', 'bins', 'l1amb', 'l2amb', 'binsamb',
              'l1emit', 'l2emit', 'binsemit', 'l1nee', 'l2nee', 'binsnee'):
        (out_dir / f'probes_{k}.bin').write_bytes(probes[k].tobytes())
    (out_dir / 'probes_valid.bin').write_bytes((probes['valid'].astype(np.uint8) * 255).tobytes())
    (out_dir / 'probes_pos.bin').write_bytes(probes['world_pos'].tobytes())
    (out_dir / 'points.bin').write_bytes(cloud.tobytes())
    (out_dir / 'mesh_verts.bin').write_bytes(mesh['verts'].tobytes())
    (out_dir / 'mesh_idx.bin').write_bytes(mesh['idx'].tobytes())
    # gain map as 8-bit heat png (for the HDR overlay)
    g01 = np.clip(hdr['gain_ev'] / max(float(P['max_gain_ev']), 1e-6), 0, 1)
    Image.fromarray((g01 * 255).astype(np.uint8)).save(out_dir / 'gain.png')
    # 语义 mask(纯 SAM3)8-bit:查看器「光源分割图」直接显示这张,分离直接光的依据
    Image.fromarray((np.clip(hdr['mask'], 0, 1) * 255).astype(np.uint8)).save(out_dir / 'mask.png')
    # inpainted hidden-layer colour as display-sRGB texture (mesh skinning)
    hid8 = np.clip(np.power(np.clip(lay['c_bg'], 0, 1), 1 / 2.2) * 255, 0, 255).astype(np.uint8)
    Image.fromarray(hid8).save(out_dir / 'hidden.png')

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
    (out_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
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
)


def _normalize_shading(shading: dict | None) -> dict:
    out = dict(SHADING_DEFAULTS)
    for k, v in (shading or {}).items():
        if k not in SHADING_DEFAULTS:
            continue
        out[k] = int(v) if isinstance(SHADING_DEFAULTS[k], int) else float(v)
    out['mode'] = min(3, max(0, out['mode']))
    return out


def export_runtime(name: str, shading: dict | None = None) -> Path:
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
    src_dir = OUT / name
    man = json.loads((src_dir / 'manifest.json').read_text())
    scene_dir = ROOT / 'public' / 'resources' / 'runtime' / 'scenes' / name
    game_bg = scene_dir / 'background.png'
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
    dest = scene_dir / 'lighting'
    dest.mkdir(parents=True, exist_ok=True)
    # v1 遗留文件清理(被 atlas_*.bin 取代)
    for f in ('probes_l2.bin', 'probes_l2amb.bin', 'probes_l2nee.bin'):
        (dest / f).unlink(missing_ok=True)

    P = man['probes']
    Pn = P['nx'] * P['ny'] * P['nz']

    def _read_probe(stem: str, K: int, ch: int) -> np.ndarray:
        raw = np.frombuffer((src_dir / f'probes_{stem}.bin').read_bytes(), np.float16)
        return raw.reshape(Pn, K, ch)

    def _atlas4(stem: str, K: int) -> None:
        """查看器 atlas4() 的离线版:列块 [base+cov | amb | emit | nee]。"""
        main = _read_probe(stem, K, 4)
        out = np.zeros((Pn, K * 4, 4), np.float16)
        out[:, :K, :] = main
        for bi, acc in enumerate(('amb', 'emit', 'nee')):
            block = _read_probe(f'{stem}{acc}', K, 3)
            sl = slice(K * (bi + 1), K * (bi + 2))
            out[:, sl, :3] = block
            out[:, sl, 3] = np.float16(1.0)
        (dest / f'atlas_{"bin" if stem == "bins" else stem}.bin').write_bytes(out.tobytes())

    _atlas4('l1', 4)
    _atlas4('l2', 9)
    _atlas4('bins', 64)
    (dest / 'probes_valid.bin').write_bytes((src_dir / 'probes_valid.bin').read_bytes())

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
        (dest / out_name).write_bytes(atlas.tobytes())

    _tile_volume('volume.bin', 'vol_rad.bin')
    _tile_volume('volume_emit.bin', 'vol_emit.bin')

    W, Hh = man['work']['w'], man['work']['h']
    d_walk = np.frombuffer((src_dir / 'walk_depth.bin').read_bytes(), np.float32).reshape(Hh, W)
    d_lo, d_hi = float(d_walk.min()), float(d_walk.max())
    n16 = np.round((d_walk - d_lo) / max(d_hi - d_lo, 1e-6) * 65535).astype(np.uint16)
    rg = np.zeros((Hh, W, 3), np.uint8)
    rg[..., 0] = n16 >> 8
    rg[..., 1] = n16 & 0xFF
    Image.fromarray(rg).save(dest / 'ground_d.png', optimize=True)

    payload = dict(
        version=2,
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
    (dest / 'lighting.json').write_text(
        json.dumps(payload, ensure_ascii=False, indent=1) + '\n')
    print(f'[export] {dest}')
    return dest


def export_scene_depth(name: str) -> dict:
    """接管旧场景深度工具:把实验室的有效深度(标定+起伏+笔刷编辑)导出为
    游戏运行时消费的 depthConfig 契约 —— RG16 深度图 + M(游戏 det+1 约定)+
    depth_mapping + 最佳拟合 floor 线 + 方形 cell 碰撞网格;既有手调参数保值。"""
    src_dir = OUT / name
    man = json.loads((src_dir / 'manifest.json').read_text())
    scene_media = ROOT / 'public' / 'resources' / 'runtime' / 'scenes' / name
    scene_json_path = ROOT / 'public' / 'assets' / 'scenes' / f'{name}.json'
    if not scene_json_path.exists():
        raise RuntimeError(f'场景 JSON 不存在: {scene_json_path}(先在主编辑器建场景)')
    game_bg = scene_media / 'background.png'
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
    Image.fromarray(rg).save(scene_media / depth_name, optimize=True)

    # ---- floor 线(遗留线性字段):非平面地面的最佳拟合,按原生 sy ----
    sy_nat = (np.arange(Hh, dtype=np.float64) + 0.5) * (nh / Hh)
    row_d = np.median(d_walk, axis=1)
    A_, B_ = np.polyfit(sy_nat, row_d, 1)
    depth_per_sy = math.tan(theta) / ppu_nat

    # ---- 碰撞:实验室世界网格 → 游戏方形 cell 网格(注意 lab Z 翻转还原) ----
    wk = man['walk']
    mask_img = np.asarray(Image.open(src_dir.parent / name / 'walk_mask.png').convert('L'), np.uint8)
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
    Image.fromarray(col).save(scene_media / col_name, optimize=True)

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
        'shader': {'depth_per_sy': depth_per_sy,
                   'floor_depth_A': float(A_), 'floor_depth_B': float(B_)},
        'collision': {'x_min': float(gx_min), 'z_min': float(gz_min),
                      'cell_size': cell, 'grid_width': gw, 'grid_height': gh,
                      'height_offset': float((old_cfg.get('collision') or {}).get('height_offset', 0.0))},
        'depth_tolerance': float(old_cfg.get('depth_tolerance', 0.05)),
        'floor_offset': float(old_cfg.get('floor_offset', 0.0)),
    }
    old_scene['depthConfig'] = cfg
    scene_json_path.write_text(json.dumps(old_scene, ensure_ascii=False, indent=2) + '\n')
    print(f'[export-depth] {scene_json_path.name}: depth {nw}x{nh}, '
          f'floor A={A_:.5f} B={B_:.3f}, collision {gw}x{gh} cell={cell:.3f}')
    return cfg


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('image', type=Path)
    ap.add_argument('--name', default=None)
    ap.add_argument('--export-runtime', action='store_true',
                    help='烘焙后同时导出游戏运行时载荷')
    for k, v in DEFAULTS.items():
        ap.add_argument(f'--{k}', type=type(v), default=None)
    args = ap.parse_args()
    params = {k: getattr(args, k) for k in DEFAULTS if getattr(args, k) is not None}
    name = args.name or args.image.stem
    build(args.image.resolve(), name, params)
    if args.export_runtime:
        export_runtime(name)


if __name__ == '__main__':
    main()
