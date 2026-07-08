"""QA gate — the part that "takes responsibility".

Two layers, combined (see README §qa):
  PROGRAM (this file): cheap, objective. Either HARD-FAILs a clip (dims, in-place
    displacement, edge clipping, atlas>2K) or raises FLAGS for the agent (floating
    fragment via connected-components, silhouette-area melt proxy, matte holes).
  AGENT (schema below, called by produce.py / a skill): adjudicates the flags and
    judges what programs can't see (prop held & intact, action correct, identity,
    style, orientation). Fed the program flags so it looks where they point.

Verdicts: HARD_FAIL (reject, no agent spend) | FLAG_FOR_AGENT | PROGRAM_PASS.
Proven to catch the real defects the old metric-only QA missed (detached spearhead
12.5%, ghost-ring 17.4%) while passing the regenerated clean clips.
"""
from __future__ import annotations
import json
import subprocess
from pathlib import Path

import numpy as np
import cv2

from . import recipes


# Structured schema the AGENT judge must return (used by produce.py / skill).
AGENT_SCHEMA = {
    "type": "object",
    "required": ["verdict"],
    "properties": {
        "prop_held_all_frames": {"type": "boolean"},
        "prop_intact": {"type": "boolean"},
        "floating_confirmed": {"type": "boolean"},
        "action_correct": {"type": "boolean"},
        "identity_ok": {"type": "boolean"},
        "style_ok": {"type": "boolean"},
        "orientation_side_view": {"type": "boolean"},
        "melt_confirmed": {"type": "boolean"},
        "verdict": {"enum": ["accept", "reject"]},
        "confidence": {"type": "number"},
        "defect_frames": {"type": "array", "items": {"type": "integer"}},
    },
}


def _read(video: str):
    s = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,nb_read_frames", "-count_frames", "-of", "json", video],
        capture_output=True, check=True).stdout)["streams"][0]
    w, h = int(s["width"]), int(s["height"])
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-pix_fmt", "rgb24",
                          "-f", "rawvideo", "-"], capture_output=True, check=True).stdout
    fs = w * h * 3
    n = len(raw) // fs
    return np.frombuffer(raw[:n * fs], np.uint8).reshape((n, h, w, 3)), w, h, n


def _mask(fr):
    h, w, _ = fr.shape
    c = max(8, min(h, w) // 32)
    bg = np.median(np.concatenate([fr[:c, :c].reshape(-1, 3), fr[:c, -c:].reshape(-1, 3),
                                   fr[-c:, :c].reshape(-1, 3), fr[-c:, -c:].reshape(-1, 3)]), 0)
    d = np.abs(fr.astype(np.int16) - bg)
    return ((d.max(2) > 20) & (d.sum(2) > 38)).astype(np.uint8)


def program_gate(video: str, action: str = "run") -> dict:
    """Run objective program checks on a stabilized clip."""
    Q = recipes.QA
    frames, w, h, n = _read(video)
    checks, flags = [], []

    def add(name, val, thr, ok, hard=False):
        checks.append({"name": name, "value": val, "thr": thr, "pass": bool(ok), "hard": hard})

    add("frame_count", n, f">={Q['min_frames']}", n >= Q["min_frames"], hard=True)

    cxs, areas, frag = [], [], 0
    minmarg = 1.0
    for f in frames:
        m = _mask(f)
        ys, xs = np.where(m)
        if len(xs) < 50:
            continue
        cxs.append((xs.min() + xs.max()) / 2 / w)
        areas.append(m.sum() / m.size)
        minmarg = min(minmarg, xs.min() / w, (w - 1 - xs.max()) / w, ys.min() / h, (h - 1 - ys.max()) / h)
        num, _, stats, _ = cv2.connectedComponentsWithStats(
            cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)), 8)
        if num > 2:
            sizes = sorted(stats[1:, cv2.CC_STAT_AREA], reverse=True)
            if len(sizes) >= 2 and sizes[1] > 0.02 * sizes[0] and sizes[1] > 120:
                frag += 1

    drift = (max(cxs) - min(cxs)) * w if cxs else 999
    add("displacement_px", round(drift, 1), f"<={Q['max_displacement_px']}",
        drift <= Q["max_displacement_px"], hard=True)
    add("edge_margin_frac", round(minmarg, 3), f">={Q['min_edge_margin_frac']}",
        minmarg >= Q["min_edge_margin_frac"], hard=True)

    fragpct = 100 * frag / max(1, n)
    add("floating_fragment_%", round(fragpct, 1), f"<={Q['max_floating_fragment_pct']}",
        fragpct <= Q["max_floating_fragment_pct"])
    if fragpct > Q["max_floating_fragment_pct"]:
        flags.append(f"floating fragments in {fragpct:.0f}% of frames (detached prop / stray artifact?)")

    acv = float(np.std(areas) / max(1e-6, np.mean(areas))) if areas else 9
    add("area_cv", round(acv, 3), f"<={Q['max_area_cv']}", acv <= Q["max_area_cv"])
    if acv > Q["max_area_cv"]:
        flags.append(f"silhouette area unstable (cv={acv:.2f}) — possible melt/blob")

    hard_fail = [c["name"] for c in checks if c["hard"] and not c["pass"]]
    soft_fail = [c["name"] for c in checks if not c["hard"] and not c["pass"]]
    verdict = "HARD_FAIL" if hard_fail else ("FLAG_FOR_AGENT" if soft_fail else "PROGRAM_PASS")
    return {"clip": Path(video).name, "action": action, "verdict": verdict,
            "hard_fail": hard_fail, "flags": flags, "checks": checks}


def atlas_gate(anim_json: str, atlas_png: str) -> dict:
    """Objective checks on the produced atlas (the game-usable artifact)."""
    from PIL import Image
    anim = json.loads(Path(anim_json).read_text())
    W, H = Image.open(atlas_png).size
    cols, rows = anim["cols"], anim["rows"]
    cw, ch = anim["cellWidth"], anim["cellHeight"]
    af = anim.get("atlasFrames", [])
    maxidx = max((max(s["frames"]) for s in anim["states"].values()), default=-1)
    checks = [
        {"name": "atlas_within_2k", "pass": W <= recipes.ATLAS_MAX_SIDE and H <= recipes.ATLAS_MAX_SIDE, "value": [W, H]},
        {"name": "grid_matches_png", "pass": cols * cw == W and rows * ch == H, "value": [cols * cw, rows * ch]},
        {"name": "indices_in_range", "pass": maxidx < cols * rows and maxidx < len(af), "value": maxidx},
    ]
    return {"anim": Path(anim_json).name, "verdict": "PASS" if all(c["pass"] for c in checks) else "FAIL",
            "checks": checks}


if __name__ == "__main__":
    import sys
    for a in sys.argv[1:]:
        v, act = (a.split("::") + ["run"])[:2]
        print(json.dumps(program_gate(v, act), ensure_ascii=False))
