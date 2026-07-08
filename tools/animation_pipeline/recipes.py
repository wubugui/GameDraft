"""Per-action recipes + QA thresholds for the animation production pipeline.

These encode the hard-won rules from the method bake-offs (see README.md):
- anchor mode per action (grounded feet-lock vs vertical free-rise)
- default playback frameRate and target frame budget
- QA gate thresholds (objective, program-checkable)

Externalised as data so an agent tunes THIS file, not the pipeline code.
"""
from __future__ import annotations

# Anchor mode:
#   "grounded" -> feet locked to ground line every frame (walk/run/idle/crouch)
#   "vertical" -> anchor to a FIXED takeoff ground line; body free to rise/fall
#                 within the cell (jump), so vertical motion is preserved
#   "ground_fixed" -> ground constant, body descends/lies (lie_down)
# "airborne": the feet leave the ground (an airborne phase), so the vertical anchor
# must NOT lock the lowest foot to the ground every frame (that flattens the lift/bob).
# Instead hold a fixed ground line and let the body rise. Non-airborne grounded actions
# always have a planted foot -> per-frame foot-lock (feet planted, no vertical bounce).
# feet_stationary: the feet stay strictly planted in one spot (stand/idle/crouch) -> anchor
# the HORIZONTAL on the feet (they are the true fixed point); trunk breathing above must not
# drag them. Locomotion (walk/run) strides -> anchor the trunk instead.
ACTIONS: dict[str, dict] = {
    "idle":      {"anchor": "grounded",     "frameRate": 8,  "loop": True,  "periodic": True,  "airborne": False, "feet_stationary": True},
    "slow_walk": {"anchor": "grounded",     "frameRate": 8,  "loop": True,  "periodic": True,  "airborne": False, "feet_stationary": False},
    "run":       {"anchor": "grounded",     "frameRate": 12, "loop": True,  "periodic": True,  "airborne": True,  "feet_stationary": False},
    "crouch":    {"anchor": "grounded",     "frameRate": 8,  "loop": True,  "periodic": False, "airborne": False, "feet_stationary": True},
    "jump":      {"anchor": "vertical",     "frameRate": 10, "loop": True,  "periodic": False, "airborne": True,  "feet_stationary": False},
    "lie_down":  {"anchor": "ground_fixed", "frameRate": 8,  "loop": True,  "periodic": False, "airborne": False, "feet_stationary": False},
}

# Frame budget per state (upper bound; loop finder may pick fewer for periodic).
MAX_FRAMES_PER_STATE = 16

# Normalisation reference: every state is scaled so its STANDING frame's character
# height equals this many px (removes per-clip generation-scale drift). The 2K solver
# downsamples globally afterward, so this is just a common reference scale.
REF_STANDING_HEIGHT = 560.0

# Atlas
ATLAS_MAX_SIDE = 2048     # hard cap, per side (2K)
CELL_PADDING = 2

# Anchor method: "centroid" (silhouette centroid-x + robust ground line — proven
# sub-pixel on decent clips) or "ecc_form" (torso ECC form-alignment — for clips
# where the silhouette statistic genuinely wobbles; measured to add noise on
# already-stable clips, so NOT the default). See form_align.py + README §anchor.
ANCHOR_METHOD = "centroid"

# ---- form-alignment (precise character-form anchor; see form_align.py) ----
TORSO_BAND = (0.12, 0.58)   # rows (shoulder-line..hip-line) of body height for the torso mask
PRESENCE_CORE = 0.80        # a pixel is "torso core" if body occupies it in >= this frac of frames
SAVGOL_WINDOW = 7           # zero-phase smoothing window for the anchor track (odd)
SAVGOL_POLY = 2
ECC_MAX_ITERS = 200
ECC_EPS = 1e-6
GROUND_PERCENTILE = 82      # robust constant ground line from per-frame foot-line p98 (grounded)
JITTER_P95_MAX = 1.0        # QA: rigid-core inter-frame jitter p95 must be <= this (px)

# ---- QA gate thresholds (objective / program-checkable) ----
QA = {
    "min_frames": 24,             # source clip must have enough frames
    "max_displacement_px": 40,    # in-place: character horizontal drift (raw clip)
    "min_edge_margin_frac": 0.01, # character must not touch frame edge (clipping)
    "max_floating_fragment_pct": 3.0,   # % frames with a detached blob (flag -> agent)
    "max_area_cv": 0.25,          # silhouette area coeff-of-variation (melt/blob proxy)
    "max_matte_holes_pct": 1.0,   # interior wrongly cut (holes) after matting
    "loop_seam_ratio": 1.0,       # periodic: seam dist / adjacent dist must be < 1
    "loop_seam_abs": 6.0,         # low-motion (idle): absolute seam floor
}

# Matting: primary + fallback. fusion = BiRefNet extent + color-key edge (proven best).
MATTE_PRIMARY = "fusion"
MATTE_FALLBACK = "rembg_isnet"   # if BiRefNet unavailable
