"""Core post-processing: matted frames -> anchored, scale-normalised, loop-selected
frames -> 2K-budget uniform-grid atlas + anim.json (game-ready).

Anchor (proven, see README §anchor): horizontal = silhouette-centroid / foot-centre;
vertical = robust foot-line (p98) for grounded actions, fixed takeoff line for
vertical/ground_fixed. Cross-state: scale-normalise to a common standing height.
Runtime pins each cell at anchor (0.5,1) = bottom-centre, so we compose feet at the
cell bottom, body horizontally centred. 2K solver caps atlas at 2048/side.
Reuses tools/video_to_atlas/atlas_core.py for anim.json (format fidelity).
"""
from __future__ import annotations
import json
import math
import subprocess
import sys
from pathlib import Path
from typing import Optional

import numpy as np
import cv2

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent / "video_to_atlas"))
import atlas_core  # noqa: E402

from . import recipes
from .matting import matte_rgba


# ---------- io ----------
def read_frames(video: str | Path, idxs: Optional[list[int]] = None):
    v = str(video)
    s = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,nb_read_frames", "-count_frames", "-of", "json", v],
        capture_output=True, check=True).stdout)["streams"][0]
    w, h = int(s["width"]), int(s["height"])
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", v, "-pix_fmt", "rgb24",
                          "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape((-1, h, w, 3))
    if idxs is None:
        return fr, w, h
    return np.stack([fr[i] for i in idxs]), w, h


def _alpha_mask(alpha: np.ndarray, thr: float = 0.5):
    ys, xs = np.where(alpha > thr)
    return xs, ys


# ---------- anchor ----------
def anchor_of(alpha: np.ndarray, mode: str, fixed_ground: Optional[float] = None):
    """Return (anchor_x, anchor_y, bbox). anchor_x = centroid-x (feet-centred body);
    anchor_y = per-frame foot-line for grounded, else the fixed takeoff line."""
    xs, ys = _alpha_mask(alpha)
    if len(xs) < 50:
        return None
    ax = float(xs.mean())
    if mode == "grounded" or fixed_ground is None:
        ay = float(np.percentile(ys, 98))
    else:
        ay = float(fixed_ground)
    return ax, ay, (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))


def standing_height(video: str | Path, method: str) -> float:
    fr, _, _ = read_frames(video, [3])
    a = matte_rgba(fr[0], method)[:, :, 3].astype(np.float32) / 255
    _, ys = _alpha_mask(a)
    return float(ys.max() - ys.min() + 1) if len(ys) else 1.0


# ---------- loop selection ----------
def _aligned_gray(frames: np.ndarray) -> np.ndarray:
    h, w = frames.shape[1:3]
    out = []
    tx, ty = w // 2, int(h * 0.72)
    for fr in frames:
        a = matte_rgba(fr, "color_key")[:, :, 3].astype(np.float32) / 255  # cheap for loop only
        xs, ys = _alpha_mask(a)
        if len(xs) < 50:
            out.append(np.zeros((h, w), np.float32)); continue
        cx, gy = xs.mean(), np.percentile(ys, 98)
        M = np.float32([[1, 0, tx - cx], [0, 1, ty - gy]])
        g = cv2.cvtColor(fr, cv2.COLOR_RGB2GRAY).astype(np.float32)
        out.append(cv2.warpAffine(g, M, (w, h)))
    return np.array([cv2.resize(s, (w // 4, h // 4)) for s in out])


def find_loop(frames: np.ndarray, periodic: bool, max_frames: int,
              pmin: int = 8, pmax: int = 64) -> list[int]:
    """Return frame indices (into `frames`) forming a seamless loop.
    Periodic: detect motion period, pick cleanest single-period window (skips lead-in).
    Non-periodic: bracket the action between matching (standing) endpoints."""
    n = len(frames)
    if n <= max_frames:
        return list(range(n))
    S = _aligned_gray(frames)
    D = np.stack([np.abs(S - S[i]).reshape(n, -1).mean(1) for i in range(n)])
    if periodic:
        pmax_ = min(pmax, n - 2)
        P = min(range(pmin, pmax_), key=lambda p: np.mean([D[t, t + p] for t in range(n - p)]))
        s = min(range(0, n - P), key=lambda s: D[s, s + P])
        rng = list(range(s, s + P))
    else:
        # widest window whose endpoints match (both ~standing), s in head third, e in tail third
        best, bs, be = 1e9, 0, n - 1
        for s in range(0, n // 3):
            for e in range(2 * n // 3, n):
                if e - s < n // 3:
                    continue
                score = D[s, e] - 0.002 * (e - s)  # prefer matching + wider
                if score < best:
                    best, bs, be = score, s, e
        rng = list(range(bs, be + 1))
    if len(rng) <= max_frames:
        return rng
    sel = np.linspace(0, len(rng) - 1, max_frames).round().astype(int)
    return [rng[i] for i in sel]


# ---------- build character atlas ----------
def build_character(clips: dict[str, str | Path], out_dir: str | Path,
                    world_w: float = 100.0, world_h: Optional[float] = None,
                    matte_method: Optional[str] = None) -> dict:
    """clips: {state_name -> stabilized mp4}. Writes atlas.png + anim.json to out_dir.
    Returns a summary dict (atlas dims, grid, per-state frame ranges)."""
    out_dir = Path(out_dir); out_dir.mkdir(parents=True, exist_ok=True)
    mm = matte_method or recipes.MATTE_PRIMARY
    pad = recipes.CELL_PADDING

    from .form_align import form_align
    composed = []   # (state, rgba_scaled, ax, ay, bbox)
    order = []
    anchor_methods: dict[str, str] = {}
    for state, clip in clips.items():
        rec = recipes.ACTIONS.get(state, {"anchor": "grounded", "periodic": True})
        frames_all, w, h = read_frames(clip)
        sel = find_loop(frames_all, rec.get("periodic", True), recipes.MAX_FRAMES_PER_STATE)
        frames = frames_all[sel]
        s_norm = recipes.REF_STANDING_HEIGHT / standing_height(clip, mm)
        rgbas = []
        for fr in frames:
            rgba = matte_rgba(fr, mm)
            nw, nh = max(1, int(round(w * s_norm))), max(1, int(round(h * s_norm)))
            rgbas.append(cv2.resize(rgba, (nw, nh), interpolation=cv2.INTER_AREA))
        # precise character-FORM alignment (torso ECC + robust ground line), per state
        ax_arr, ay_arr, method = form_align(rgbas, rec["anchor"], airborne=rec.get("airborne", False),
                                            feet_stationary=rec.get("feet_stationary", False))
        anchor_methods[state] = method
        for rgba, ax, ay in zip(rgbas, ax_arr, ay_arr):
            a2 = rgba[:, :, 3].astype(np.float32) / 255
            xs, ys = _alpha_mask(a2)
            if len(xs) < 50:
                continue
            bbox = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
            composed.append((state, rgba, float(ax), float(ay), bbox)); order.append(state)

    if not composed:
        raise RuntimeError("no composable frames")

    # anchored extents (symmetric x around centred anchor; above/below y)
    L = R = A = B = 0.0
    for _, _, ax, ay, (x0, y0, x1, y1) in composed:
        L = max(L, ax - x0); R = max(R, x1 - ax); A = max(A, ay - y0); B = max(B, y1 - ay)
    content_w = 2 * max(L, R); content_h = A + B
    n = len(composed)
    sol = _solve_2k(n, content_w, content_h, pad)
    if sol is None:
        raise RuntimeError("cannot fit even one cell within 2K")
    s = sol["scale"]; cw, ch = sol["cell_w"], sol["cell_h"]; cols, rows = sol["cols"], sol["rows"]

    cells = []; content_sizes = []
    ax_cell = cw / 2; ay_cell = ch - pad - B * s
    for _, rgba, ax, ay, (x0, y0, x1, y1) in composed:
        rs = cv2.resize(rgba, (max(1, int(round(rgba.shape[1] * s))),
                               max(1, int(round(rgba.shape[0] * s)))), interpolation=cv2.INTER_AREA)
        axs, ays = ax * s, ay * s
        cell = np.zeros((ch, cw, 4), np.uint8)
        dx, dy = int(round(ax_cell - axs)), int(round(ay_cell - ays))
        H, W = rs.shape[:2]
        sx0, sy0, ex0, ey0 = max(0, dx), max(0, dy), min(cw, dx + W), min(ch, dy + H)
        if ex0 > sx0 and ey0 > sy0:
            cell[sy0:ey0, sx0:ex0] = rs[sy0 - dy:ey0 - dy, sx0 - dx:ex0 - dx]
        cells.append(cell)
        content_sizes.append((int((x1 - x0) * s), int((y1 - y0) * s)))

    atlas = np.zeros((rows * ch, cols * cw, 4), np.uint8)
    for i, cell in enumerate(cells):
        c, r = i % cols, i // cols
        atlas[r * ch:(r + 1) * ch, c * cw:(c + 1) * cw] = cell
    from PIL import Image
    Image.fromarray(atlas, "RGBA").save(out_dir / "atlas.png")

    # states -> frame index lists (composition order)
    per: dict[str, list[int]] = {st: [] for st in clips}
    for i, st in enumerate(order):
        per[st].append(i)
    states = {st: {"frames": idxs,
                   "frameRate": recipes.ACTIONS.get(st, {}).get("frameRate", 8),
                   "loop": recipes.ACTIONS.get(st, {}).get("loop", True)}
              for st, idxs in per.items() if idxs}
    meta = {"frameIndexBase": 0, "frameCount": n, "cols": cols, "rows": rows,
            "cellWidth": cw, "cellHeight": ch, "exportFps": 12,
            "frames": [{"contentWidth": content_sizes[i][0], "contentHeight": content_sizes[i][1],
                        "cellWidth": cw, "cellHeight": ch} for i in range(n)]}
    anim = atlas_core.export_gamedraft_anim_multi(meta, "atlas.png", world_w, world_h, states)
    (out_dir / "anim.json").write_text(atlas_core._dump_json_text(anim), encoding="utf-8")

    return {"frames": n, "scale": round(s, 4), "cell": [cw, ch], "grid": [cols, rows],
            "atlas": [cols * cw, rows * ch], "anchor_methods": anchor_methods,
            "states": {k: v["frames"] for k, v in states.items()}}


def _solve_2k(n_frames, content_w, content_h, pad=2, max_side=recipes.ATLAS_MAX_SIDE):
    def cap_at(sc):
        cw = math.ceil(content_w * sc) + 2 * pad
        ch = math.ceil(content_h * sc) + 2 * pad
        if cw > max_side or ch > max_side:
            return None, cw, ch, 0, 0
        cols, rows = max_side // cw, max_side // ch
        return cols * rows, cw, ch, cols, rows
    lo, hi, best = 0.001, 1.0, None
    for _ in range(40):
        mid = (lo + hi) / 2
        cap, cw, ch, cols, rows = cap_at(mid)
        if cap is not None and cap >= n_frames:
            best = dict(scale=mid, cell_w=cw, cell_h=ch, cols=cols, rows=rows); lo = mid
        else:
            hi = mid
    return best
