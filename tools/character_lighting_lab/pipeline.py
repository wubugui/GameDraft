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
    distance_transform_edt, gaussian_filter, grey_closing, label, maximum_filter,
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
    ppu_ratio=0.22,        # ppu = ppu_ratio * W_G
    ev=0.0,                # scene exposure EV
    max_gain_ev=math.log2(10.0),  # HDR emitter max boost
    vol_nx=192, vol_nz=64, # voxel grid (ny derived from aspect)
    probe_nx=20, probe_ny=6, probe_nz=14,  # WORLD-space probe grid (x, up, depth)
    probe_dirs=196,
    probe_band=2.6,        # probe volume: ground .. ground + band (world units)
    fold=1,                # double-sided fold for camera-side rays (0/1)
    semantic_gate=1,       # SAM3 object-gated emitter confidence (0/1)
    relief=1.8,            # structure depth gain relative to the pinned ground
                           # (compensates monocular vertical-contrast compression)
    occluder_tau=0.10,     # pop-out threshold, fraction of depth range
    thickness_k=0.55,      # occluder thickness = k * min(bbox)/ppu
    bg_thickness_q=0.60,   # default slab thickness for background shell (q units)
    ground_up_dot=0.75,    # world-up cosine threshold for ground candidacy
    walk_res=160,          # world XZ walk grid resolution (max dimension)
)


def world_matrix(theta: float) -> np.ndarray:
    """M: q -> world.  Xw=qx; Yw=qy c - qz s; Zw=-(qy s + qz c).

    q (x right, y up, z away) is LEFT-handed; the Z negation makes the world
    RIGHT-handed so GL viewers don't mirror it. M stays orthogonal (det=-1):
    transpose==inverse and isometry both still hold."""
    c, s = math.cos(theta), math.sin(theta)
    return np.array([[1, 0, 0], [0, c, -s], [0, -s, -c]], np.float64)


# ---------------------------------------------------------------- helpers
def srgb_to_linear(x):
    x = np.asarray(x, np.float32)
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4).astype(np.float32)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / max(e1 - e0, 1e-9), 0.0, 1.0)
    return (t * t * (3.0 - 2.0 * t)).astype(np.float32)


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
def stage_depth(img_path: Path, cache_dir: Path, h: str) -> np.ndarray:
    cache = cache_dir / f'raw_depth_{h}.npy'
    if cache.exists():
        return np.load(cache)
    print('[depth] inferring with Depth Anything (base)...', flush=True)
    from tools.scene_depth_editor.depth_estimator import DepthEstimator, MODEL_OPTIONS
    est = DepthEstimator()
    src = Image.open(img_path).convert('RGB')
    res = est.generate_depth(src, MODEL_OPTIONS['base'], lambda s: print('  ', s, flush=True))
    raw = np.asarray(res.raw_normalized, np.float32)
    cache_dir.mkdir(parents=True, exist_ok=True)
    np.save(cache, raw)
    return raw


def _ground_mask_from(d, qy, theta, thresh):
    """Up-facing surfaces flood-connected to the frame bottom."""
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
    lab, _ = label(cand)
    bottom = np.unique(lab[-8:, :]); bottom = bottom[bottom != 0]
    mask = np.isin(lab, bottom)
    mask = binary_closing(mask, np.ones((5, 5)))
    return mask if mask.sum() >= 500 else cand


def stage_calibrate(raw: np.ndarray, P: dict) -> dict:
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
        mask = _ground_mask_from(d, qy, theta, P['ground_up_dot'])

    d = (1.0 / (a_best * raw + b_best)).astype(np.float32)
    o = float(np.median(qy[mask] / math.tan(theta) - d[mask])) if mask.any() else 0.0
    d = d + o
    Y = (qy * math.cos(theta) - d * math.sin(theta)).astype(np.float32)
    return dict(s=a_best, o=b_best, theta=theta, ppu=ppu, cx=cx, cy=cy,
                d=d, Y=Y, ground_mask=mask, qy=qy, depth_shift=o,
                ground_y_p95=float(np.percentile(np.abs(Y[mask]), 95)) if mask.any() else -1.0)


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


def stage_hdr(rgb_srgb: np.ndarray, P: dict, sem_gate: np.ndarray | None = None) -> dict:
    """Unified LDR->HDR, returns display-linear radiance (1.0 = display white),
    plus the gain field and stats/histograms for the viewer's audit panel.
    sem_gate: optional [0,1] SAM3 object gate multiplied into the confidence
    (the statistical model already carries the daylight/scene gate)."""
    linear = srgb_to_linear(rgb_srgb)
    luma100 = (linear @ LUMA_W) * 100.0
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
    if sem_gate is not None:
        conf = conf * np.clip(sem_gate, 0, 1)
    gain_ev = float(P['max_gain_ev']) * np.power(conf, 0.72)
    rad = (linear * np.power(2.0, gain_ev)[..., None]).astype(np.float32)
    # NEE split: base = observed painting (all real bounces), emit = synthetic
    # emissive delta added by the HDR boost. rad == base + emit exactly.
    base = linear.astype(np.float32)
    emit = (rad - base).astype(np.float32)

    def hist(vals, lo=-6.0, hi=6.0, bins=64):
        h, _ = np.histogram(np.log2(np.maximum(vals, 1e-4)), bins=bins, range=(lo, hi))
        return (h / max(h.max(), 1)).round(4).tolist()

    luma_out = (rad @ LUMA_W) * 100.0
    stats = dict(
        p50_nits=float(p50), p99_nits=float(p99), daylight_score=daylight,
        emitter_pixel_pct=float(np.mean(conf > 0.35) * 100.0),
        max_gain_applied_ev=float(gain_ev.max()),
        hist_pre=hist(luma100 / 100.0), hist_post=hist(luma_out / 100.0),
        hist_lo=-6.0, hist_hi=6.0,
    )
    return dict(rad=rad, base=base, emit=emit,
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


def _trace(vol: dict, origins: np.ndarray, dirs: np.ndarray, step=0.9, max_steps=220,
           fold: bool = False):
    """March rays in voxel index space. origins (P,3) index coords, dirs (D,3)
    in q-space (will be scaled per-axis to index space). Returns radiance (P,D,3)
    and hit mask (P,D).
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
    alive = np.ones((Pn, Dn), bool)
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
    """WORLD-space AABB of the character-relevant band: ground .. ground+band."""
    theta = cal['theta']
    M = world_matrix(theta)
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
    y0 = float(np.percentile(Yg, 2)) - 0.15
    y1 = float(np.percentile(Yg, 98)) + float(P['probe_band'])
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
        xi = np.clip(np.round(pos[act, 0]).astype(np.int32), 0, Nx - 1)
        yi = np.clip(np.round(pos[act, 1]).astype(np.int32), 0, Ny - 1)
        zi = np.clip(np.round(pos[act, 2]).astype(np.int32), 0, Nz - 1)
        hitb = occ3[zi, yi, xi]
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
    inside_solid = occ[zc, yc, xc]
    nz_, ny_, nx_ = idx_near[0][zc, yc, xc], idx_near[1][zc, yc, xc], idx_near[2][zc, yc, xc]
    do_snap = inside_solid
    origins[do_snap, 0] = nx_[do_snap].astype(np.float32)
    origins[do_snap, 1] = ny_[do_snap].astype(np.float32)
    origins[do_snap, 2] = nz_[do_snap].astype(np.float32)
    valid = ~off_grid

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


def stage_walk_world(cal: dict, lay: dict, vol: dict, wb: dict, P: dict) -> dict:
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
    for h in (0.35, 0.8, 1.3):
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
    raw_native = stage_depth(img_path, out_dir, h)
    Hg = round(src.height * W_G / src.width)
    raw = resize_f(raw_native, (W_G, Hg))
    rgb_srgb = np.asarray(src.resize((W_G, Hg), Image.Resampling.LANCZOS), np.float32) / 255.0

    cal = stage_calibrate(raw, P)
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
    vol = stage_voxelize(cal, lay, hdr['base'], hdr['emit'], rad_bg, P)
    wb = world_bounds(cal, lay, P)
    lights = stage_lights(cal, lay, hdr['emit'], wb, P)
    amb = stage_ambient(vol, cal, lay, P)
    probes = stage_probes(vol, amb, wb, lights, P)
    walk = stage_walk_world(cal, lay, vol, wb, P)
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
        point_count=int(len(cloud)),
        mesh=dict(verts=int(len(mesh['verts'])), tris=int(len(mesh['idx']))),
        built=time.strftime('%Y-%m-%d %H:%M:%S'),
    )
    (out_dir / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    save_audit(out_dir, rgb_srgb, cal, lay, vol, walk['mask'])
    print(f'[done] {out_dir}')


def export_runtime(name: str) -> Path:
    """P1 数据通道:把实验室烘焙结果变换成游戏运行时载荷,写入
    public/resources/runtime/scenes/<name>/lighting/。纯文件变换,不重烘。

    载荷 = lighting.json(标定/世界/probe网格/ambient/光源/背景哈希防腐门)
         + probes_l2{,amb,nee}.bin(L2 三分账,f16)
         + ground_d.png(行走面深度场,RG16 编码,work-res)"""
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

    for f in ('probes_l2.bin', 'probes_l2amb.bin', 'probes_l2nee.bin'):
        (dest / f).write_bytes((src_dir / f).read_bytes())

    W, Hh = man['work']['w'], man['work']['h']
    d_walk = np.frombuffer((src_dir / 'walk_depth.bin').read_bytes(), np.float32).reshape(Hh, W)
    d_lo, d_hi = float(d_walk.min()), float(d_walk.max())
    n16 = np.round((d_walk - d_lo) / max(d_hi - d_lo, 1e-6) * 65535).astype(np.uint16)
    rg = np.zeros((Hh, W, 3), np.uint8)
    rg[..., 0] = n16 >> 8
    rg[..., 1] = n16 & 0xFF
    Image.fromarray(rg).save(dest / 'ground_d.png', optimize=True)

    payload = dict(
        version=1,
        background_sha1=bg_hash,               # 防腐门:游戏背景重画即失配禁用
        work=man['work'], cal=man['cal'], world=man['world'],
        probes={k: man['probes'][k] for k in ('nx', 'ny', 'nz')},
        ambient_sh=man['ambient']['sh'],
        lights=man.get('lights', []),
        ground_d=dict(min=d_lo, max=d_hi),
        baked_params=man['params'],
        built=man['built'],
    )
    (dest / 'lighting.json').write_text(
        json.dumps(payload, ensure_ascii=False, indent=1) + '\n')
    print(f'[export] {dest}')
    return dest


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
