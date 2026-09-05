# -*- coding: utf-8 -*-
"""bake3d 的护栏（审查 2026-09-04 第二轮）：

- 存储 h 整体偏负（换场景没搬对）时，形状**在起点对齐之后**才钳 0——高度剖面保持，而不是读进来逐点压平；
- 钻地要出 warning；采样点落在行走面范围之外要出 warning。
"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.trajectory_workbench.bake3d import bake_world_samples, manual_samples_3d  # noqa: E402
from tools.trajectory_workbench.tests.test_bake3d import FakeGeom  # noqa: E402


class BoundedGeom(FakeGeom):
    def ground_bounds(self):
        return (-500.0, 500.0, -500.0, 500.0)


def _seg(points, seg_id="m"):
    return {"id": seg_id, "kind": "manual", "startFrom": "anchor",
            "path": {"points": [{"x": x, "z": z, "h": h} for x, z, h in points], "smooth": False},
            "timing": {"durationMs": 1000, "keys": [{"atMs": 0, "progress": 0}, {"atMs": 1000, "progress": 1}]}}


def test_negative_stored_h_keeps_profile_after_start_alignment() -> None:
    geom = FakeGeom()
    base = {"rotation": 0.0, "scaleX": 1.0, "scaleY": 1.0, "alpha": 1.0}
    good = _seg([(0, 0, 10), (100, 0, 90), (200, 0, 10)])
    bad = _seg([(0, 0, 10 - 300), (100, 0, 90 - 300), (200, 0, 10 - 300)])   # 整体偏负 300：形状一样
    w1: list[str] = []
    w2: list[str] = []
    a = manual_samples_3d(good, (0.0, 10.0, 0.0), base, geom, hz=60, warnings=w1)
    b = manual_samples_3d(bad, (0.0, 10.0, 0.0), base, geom, hz=60, warnings=w2)
    assert [round(s["h"], 6) for s in a] == [round(s["h"], 6) for s in b], "起点对齐后剖面必须一致"
    assert max(s["h"] for s in b) > 80, "弧高不能被压平"
    assert not w1 and not w2, "对齐后没有点钻地就不该报警"


def test_below_ground_after_alignment_is_clamped_and_reported() -> None:
    geom = FakeGeom()
    base = {"rotation": 0.0, "scaleX": 1.0, "scaleY": 1.0, "alpha": 1.0}
    seg = _seg([(0, 0, 10), (100, 0, -40), (200, 0, 10)])    # 中点真的在地下
    warnings: list[str] = []
    out = manual_samples_3d(seg, (0.0, 10.0, 0.0), base, geom, hz=60, warnings=warnings)
    assert min(s["h"] for s in out) >= 0
    assert any("钻到地面以下" in w for w in warnings)


def test_samples_outside_ground_bounds_warn() -> None:
    geom = BoundedGeom()
    traj = {"source": {"segments": [_seg([(0, 0, 0), (400, 0, 0), (900, 0, 0)])], "bake": {"sampleHz": 30}}}
    res = bake_world_samples(traj, geom, anchor_world=(0.0, 0.0, 0.0), rest_h=0.0)
    assert res.samples
    assert any("行走面范围之外" in w for w in res.warnings), res.warnings
    inside = {"source": {"segments": [_seg([(0, 0, 0), (100, 0, 0)])], "bake": {"sampleHz": 30}}}
    res2 = bake_world_samples(inside, geom, anchor_world=(0.0, 0.0, 0.0), rest_h=0.0)
    assert not any("行走面范围之外" in w for w in res2.warnings)
