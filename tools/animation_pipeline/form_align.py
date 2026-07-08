"""Precise character-FORM alignment (replaces silhouette-centroid+footline anchor).

Researched + adversarially-verified method (see README §anchor-v2):
- Horizontal: register each frame to ONE per-clip reference on a FIXED torso-band
  mask (pixels present in >=80% of frames INTERSECT a torso rectangle -> excludes
  swinging arms/legs/coat/prop), via masked phase-correlation (integer seed) then
  cv2.findTransformECC MOTION_TRANSLATION on the Sobel-gradient image (sub-pixel).
  This locks the torso TEXTURE, not a silhouette statistic, so per-frame shape
  change no longer drags the anchor. Savitzky-Golay zero-phase smoothing on the
  track; MAD outlier gate for leg-swap/bad-ECC frames.
- Vertical: a robust per-clip CONSTANT ground line (replaces the per-frame p98
  foot-line that wobbled). Feet lock; the body's real bob stays in the pixels.

Rejected by the research for our data: pose keypoints (slide/flip on OOD side-view
AI figures), skimage masked phase-corr sub-pixel (masked path is integer-only),
affine/euclidean ECC (lets shape-change bleed into the warp).
"""
from __future__ import annotations
import numpy as np
import cv2

from . import recipes

try:
    from scipy.signal import savgol_filter
    from skimage.registration import phase_cross_correlation
    _HAVE = True
except Exception:  # pragma: no cover
    _HAVE = False


def _alpha(rgba):
    return rgba[:, :, 3].astype(np.float32) / 255


def _grad(rgba):
    a = _alpha(rgba)
    g = cv2.cvtColor(rgba[:, :, :3], cv2.COLOR_RGB2GRAY).astype(np.float32) * (a > 0.05)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return cv2.magnitude(gx, gy)


def _torso_mask(alphas, band=None, presence=None):
    band = band or recipes.TORSO_BAND
    presence = presence if presence is not None else recipes.PRESENCE_CORE
    pres = np.mean([(a > 0.5).astype(np.float32) for a in alphas], axis=0)
    ys, xs = np.where(pres > 0.05)
    if len(ys) < 10:
        return None
    top, bot = ys.min(), ys.max()
    bh = max(1, bot - top)
    core = pres >= presence
    rect = np.zeros_like(core)
    rect[int(top + band[0] * bh):int(top + band[1] * bh), :] = True
    m = (core & rect).astype(np.uint8)
    m = cv2.erode(m, np.ones((3, 3), np.uint8))
    if int(m.sum()) < 400:                       # under-constrained -> widen to full core
        m = cv2.erode(core.astype(np.uint8), np.ones((3, 3), np.uint8))
    return m if int(m.sum()) >= 400 else None


def _smooth(v, n):
    if n < 5:
        return v
    w = min(recipes.SAVGOL_WINDOW, n if n % 2 == 1 else n - 1)
    w = max(3, w if w % 2 == 1 else w - 1)
    try:
        return savgol_filter(v, w, recipes.SAVGOL_POLY)
    except Exception:
        return v


def _centroid_anchor(alphas, mode, airborne=False, feet_stationary=False):
    """Robust anchor (default). Horizontal: for in-place actions (grounded/vertical)
    a CONSTANT torso-band centroid-x -> zero horizontal drift/jitter, and the band
    excludes the swinging spear/legs (full-silhouette centroid gets yanked by them);
    lie_down (ground_fixed) tracks per-frame (the body genuinely translates). Vertical:
    a CONSTANT ground line (grounded: robust percentile of the per-frame foot-line;
    others: the takeoff/standing line) -> kills the per-frame foot-line bob."""
    n = len(alphas)
    # Per-frame trunk-x = MEDIAN x of the torso-row band. Median (not mean) resists the
    # thin diagonally-held spear that crosses the band and yanks a mean/centroid; the
    # presence-core >=80% overlap is useless here (it's always-filled -> constant ->
    # tracks nothing). Full-silhouette centroid is dragged by spear+striding legs.
    tx = np.full(n, np.nan); ctr = np.full(n, np.nan); p98 = np.full(n, np.nan); fx = np.full(n, np.nan)
    for i, a in enumerate(alphas):
        ys, xs = np.where(a > 0.5)
        if len(xs) == 0:
            continue
        ctr[i] = float(xs.mean())
        p98[i] = float(np.percentile(ys, 98))
        top = ys.min(); hh = max(1, ys.max() - top)
        band = (ys > top + 0.15 * hh) & (ys < top + 0.50 * hh)
        tx[i] = float(np.median(xs[band])) if band.any() else ctr[i]
        foot = ys > top + 0.88 * hh                 # bottom 12% = the feet
        fx[i] = float(np.median(xs[foot])) if foot.any() else ctr[i]

    def _fill(v):
        m = np.nanmedian(v)
        return np.where(np.isnan(v), m, v)
    tx, ctr, p98, fx = _fill(tx), _fill(ctr), _fill(p98), _fill(fx)

    def _despike(v):                                # kill single-frame outliers, keep the track
        return np.array([float(np.median(v[max(0, i - 1):i + 2])) for i in range(n)]) if n >= 3 else v

    # HORIZONTAL:
    #  - feet-stationary (idle/stand/crouch): anchor on the FEET (bottom 12% centroid). The
    #    feet are strictly planted, so this locks them dead-still; the trunk breathes above.
    #    (Anchoring the trunk instead lets the stationary feet drift under the swaying trunk.)
    #  - locomotion (walk/run/jump): feet stride, so anchor the trunk (torso-band median-x);
    #    NOT a constant (preserves the source trunk swing -> drift), NOT full centroid (yanked
    #    by spear/legs).
    #  - lie_down: body genuinely translates -> full centroid.
    if feet_stationary:
        ax = _despike(fx)
    elif mode == "ground_fixed":
        ax = ctr
    else:
        ax = _despike(tx)

    # VERTICAL:
    #  - continuous-contact grounded (walk/idle/crouch): pin the per-frame lowest foot to a
    #    fixed ground line EVERY frame -> feet planted, no bounce. (A constant offset would
    #    only shift uniformly and preserve the source's vertical wobble = the bounce.)
    #  - airborne (run/jump): the feet leave the ground, so DON'T lock the lowest foot each
    #    frame (that flattens the lift). Hold a fixed ground line (deepest foot contact) and
    #    let the body rise/fall naturally.
    if mode == "grounded" and not airborne:         # walk/idle/crouch: lowest foot == ground
        ay = _despike(p98)
    elif mode == "grounded" and airborne:           # run: fixed ground at deepest contact
        ay = np.full(n, float(np.percentile(p98, 85)))
    else:                                           # vertical (jump) / ground_fixed (lie)
        ay = np.full(n, float(p98[0]))
    return ax, ay, "centroid"


def form_align(rgba_frames, mode, method=None, airborne=False, feet_stationary=False):
    """rgba_frames: list of HxWx4 (already scale-normalised). mode: recipes anchor mode.
    airborne: action has an airborne phase (run/jump) -> vertical must not foot-lock per frame.
    feet_stationary: feet are strictly planted (idle/stand/crouch) -> anchor horizontal on the
    feet. method: recipes.ANCHOR_METHOD ("centroid" default | "ecc_form").
    Returns (ax[], ay[], method_used) per-frame anchor in frame pixel coords."""
    method = method or recipes.ANCHOR_METHOD
    n = len(rgba_frames)
    alphas = [_alpha(f) for f in rgba_frames]
    if method == "centroid" or not _HAVE:
        return _centroid_anchor(alphas, mode, airborne, feet_stationary)

    # per-frame foot-line (for the vertical ground constant)
    p98 = []
    for a in alphas:
        ys = np.where(a > 0.5)[0]
        p98.append(float(np.percentile(ys, 98)) if len(ys) else 0.0)
    p98 = np.array(p98)

    tmask = _torso_mask(alphas)
    if tmask is None:
        return _centroid_anchor(alphas, mode, airborne, feet_stationary)

    mb = tmask.astype(bool)
    grads = [_grad(f) for f in rgba_frames]
    areas = np.array([float((a > 0.5).sum()) for a in alphas])
    ref = int(np.argmin(np.abs(areas - np.median(areas))))
    rg = grads[ref]
    H, W = alphas[0].shape
    crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, recipes.ECC_MAX_ITERS, recipes.ECC_EPS)

    txs = np.zeros(n)
    prev = 0.0
    for i in range(n):
        if i == ref:
            prev = 0.0
            continue
        try:
            sh, _, _ = phase_cross_correlation(rg, grads[i], reference_mask=mb, moving_mask=mb)
            seed = float(-sh[1])
        except Exception:
            seed = prev
        warp = np.array([[1, 0, seed], [0, 1, 0]], np.float32)
        try:
            _, warp = cv2.findTransformECC(rg, grads[i], warp, cv2.MOTION_TRANSLATION, crit, tmask, 5)
            tx = float(warp[0, 2])
        except cv2.error:
            tx = seed
        if abs(tx - prev) > 0.3 * W:             # MAD-style outlier gate
            tx = prev
        txs[i] = tx
        prev = tx

    xs_ref = np.where(mb)[1]
    ax_ref = float(xs_ref.mean())
    ax = ax_ref + _smooth(txs, n)

    # vertical: robust constant ground line (kills the per-frame p98 wobble)
    if mode == "grounded":
        ground = float(np.percentile(p98, recipes.GROUND_PERCENTILE))
    else:                                        # vertical (jump) / ground_fixed (lie): takeoff/standing line
        ground = float(p98[0])
    ay = np.full(n, ground)
    return ax, ay, "ecc_form"
