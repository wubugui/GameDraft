# -*- coding: utf-8 -*-
"""样条金标：前端 `worldCurveSamples`（common.js）与烘焙机 `bake3d._arc_lut3/_point_at3` 逐位相同。

审查（2026-09-04）抓到过前端按样条参数插 h、烘焙机按归一弧长插 h 的 10% 偏差——两份实现之间从此有这道门。
烘焙机的弧长表建在 (x, z, h) 三元组上（`manual_samples_3d` 就是这么喂的），前端同构；取点时 h 按归一弧长线性插。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.trajectory_workbench.bake3d import _arc_lut3, _point_at3  # noqa: E402

_EVAL = _ROOT / "tools" / "trajectory_workbench" / "viewer" / "tests" / "worldcurve_eval.cjs"

CASES = [
    ("三点平滑", [(0, 0, 0), (100, 0, 50), (200, 0, 0)], True),
    ("四点平滑不等距", [(0, 0, 3), (30, 40, 20), (200, 10, 20), (260, -80, 0)], True),
    ("折线", [(0, 0, 0), (50, 50, 10), (120, -20, 30)], False),
    ("两点", [(0, 0, 5), (100, 0, 5)], True),
    ("连续重复点", [(0, 0, 0), (0, 0, 0), (60, 30, 12), (90, 90, 0)], True),
]


def _js_samples(pts, smooth):
    r = subprocess.run(["node", str(_EVAL), json.dumps(pts), "1" if smooth else "0"],
                       capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


@pytest.mark.skipif(shutil.which("node") is None, reason="没有 node")
@pytest.mark.parametrize("name,pts,smooth", CASES, ids=[c[0] for c in CASES])
def test_world_curve_matches_bake3d(name, pts, smooth) -> None:
    js = _js_samples(pts, smooth)
    lut = _arc_lut3([tuple(map(float, p)) for p in pts], smooth)
    assert len(js) == len(lut.pts), (name, len(js), len(lut.pts))
    for k, smp in enumerate(js):
        s01 = smp["s01"]
        if lut.total > 0:
            assert abs(lut.s[k] / lut.total - s01) < 1e-9, (name, k, "s01")
        x, z, h = _point_at3(lut, s01)
        assert abs(x - smp["x"]) < 1e-6 and abs(z - smp["z"]) < 1e-6, (name, k, (x, z), (smp["x"], smp["z"]))
        assert abs(h - smp["h"]) < 1e-6, (name, k, h, smp["h"])
