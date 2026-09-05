# -*- coding: utf-8 -*-
"""世界空间烘焙机的不变量（用**合成几何**跑，不依赖工程数据）：

1. 抛体：永不落到接触面以下、有限时间必静止、触地 / 静止瞬间是硬帧、能量不增；
2. 墙：深度壳非地面像素能把球弹回来（法线反射），球心停在壳前；
3. 手绘：``{x,z,h}`` 控制点跟地形（``y = 地面 + h``），h 在控制点之间线性插值不下沉；
4. 编排：分段链接、相对化、回落 2D 帧与世界帧一一对应（同 atMs）；
5. 确定性：同输入两次烘焙逐字节相同。
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.trajectory_workbench import bake3d  # noqa: E402
from tools.trajectory_workbench.baking import bake_asset  # noqa: E402


class FakeGeom:
    """平地（可选斜坡）+ 一堵在 x = wall_x 处、法线朝 −x 的墙。世界 wu，俯角 45°。"""

    def __init__(self, ground_y: float = 0.0, slope: float = 0.0, wall_x: float | None = None):
        c = math.sqrt(0.5)
        self.rows = [1, 0, 0, 0, c, -c, 0, c, c]
        self.cos_theta = c
        self.has_depth = True
        self.wu_per_q = 880.0
        self.ground_y = ground_y
        self.slope = slope
        self.wall_x = wall_x

    def ground_height(self, x: float, z: float) -> float:
        return self.ground_y + self.slope * z

    def ground_normal(self, x: float, z: float):
        nz = -self.slope
        ln = math.sqrt(1 + nz * nz)
        return (0.0, 1.0 / ln, nz / ln)

    def shell_contact(self, x: float, y: float, z: float):
        if self.wall_x is None:
            return None
        return {"pen_wu": x - self.wall_x, "normal": (-1.0, 0.0, 0.0), "px": 0, "py": 0, "ground_like": False}

    def push_in_front_of_shell(self, x: float, y: float, z: float, margin: float):
        return (self.wall_x - margin, y, z)

    # baking.bake_asset 用到的两个
    def scene_to_world_ground(self, sx: float, sy: float):
        return (sx - 2000.0, self.ground_y, -sy)

    def world_to_scene(self, x: float, y: float, z: float):
        c = self.cos_theta
        return (x + 2000.0, -(c * y + c * z))


def _phys(**over) -> dict:
    seg = {"id": "p", "kind": "physics", "v0": {"x": 120, "y": 300, "z": 40}, "gravity": 900,
           "restitution": 0.5, "rollingFriction": 200, "spin": {"radius": 7}, "stop": {"minSpeed": 30, "maxMs": 6000}}
    seg.update(over)
    return seg


def _pose(x=0.0, y=0.0, z=0.0) -> dict:
    return {"x": x, "y": y, "z": z, "rotation": 0.0, "scaleX": 1.0, "scaleY": 1.0, "alpha": 1.0}


class TestPhysics3D:
    def test_never_below_contact_and_comes_to_rest(self) -> None:
        g = FakeGeom()
        nodes = bake3d.simulate_physics_3d(_phys(), _pose(y=10.0), g, rest_h=10.0)
        assert nodes[-1].grounded and math.hypot(nodes[-1].vx, nodes[-1].vz) < 30
        assert nodes[-1].t < 6.0
        for n in nodes:
            assert n.y >= g.ground_height(n.x, n.z) + 10.0 - 1e-6
            assert n.h >= 10.0 - 1e-9

    def test_touchdowns_are_hard_and_energy_never_increases(self) -> None:
        g = FakeGeom()
        nodes = bake3d.simulate_physics_3d(_phys(), _pose(y=10.0), g, rest_h=10.0)
        hard_touch = [n for n in nodes[1:-1] if n.hard]
        assert hard_touch, "至少有一次触地成硬帧"
        gy = 10.0
        e_prev = None
        for n in nodes:
            e = 0.5 * (n.vx * n.vx + n.vy * n.vy + n.vz * n.vz) + 900.0 * (n.y - gy)
            if e_prev is not None:
                assert e <= e_prev + 1e-6, (n.t, e, e_prev)
            e_prev = e

    def test_restitution_zero_sticks_on_first_touch(self) -> None:
        g = FakeGeom()
        nodes = bake3d.simulate_physics_3d(_phys(restitution=0.0), _pose(y=50.0), g, rest_h=0.0)
        first = next(n for n in nodes if n.grounded)
        after = [n for n in nodes if n.t >= first.t]
        assert all(n.grounded for n in after)

    def test_wall_reflects_and_keeps_center_in_front(self) -> None:
        g = FakeGeom(wall_x=60.0)
        nodes = bake3d.simulate_physics_3d(_phys(v0={"x": 400, "y": 0, "z": 0}, restitution=0.6, radius=7), _pose(y=10.0), g, rest_h=10.0)
        assert max(n.x for n in nodes) <= 60.0 + 1e-6
        assert min(n.vx for n in nodes) < 0, "撞墙后 vx 应反向"

    def test_slope_rolls_downhill_direction_is_consistent(self) -> None:
        g = FakeGeom(slope=0.2)
        nodes = bake3d.simulate_physics_3d(_phys(v0={"x": 0, "y": 200, "z": 0}), _pose(y=10.0, z=0.0), g, rest_h=10.0)
        for n in nodes:
            assert n.y >= g.ground_height(n.x, n.z) + 10.0 - 1e-6


class TestManual3D:
    def test_points_follow_terrain_and_h_is_linear(self) -> None:
        g = FakeGeom(slope=0.1)
        seg = {"id": "m", "kind": "manual", "path": {"points": [{"x": 0, "z": 0, "h": 5}, {"x": 100, "z": 100, "h": 5}, {"x": 200, "z": 0, "h": 40}], "smooth": True},
               "timing": {"durationMs": 1000, "keys": [{"atMs": 0, "progress": 0}, {"atMs": 1000, "progress": 1}]}}
        base = _pose(0.0, g.ground_height(0, 0) + 5.0, 0.0)
        out = bake3d.manual_samples_3d(seg, (0.0, base["y"], 0.0), base, g, hz=60, warnings=[])
        assert out[0]["atMs"] == 0 and abs(out[-1]["atMs"] - 1000) < 1e-9
        for s in out:
            assert abs((s["y"] - g.ground_height(s["x"], s["z"])) - s["h"]) < 1e-9
            assert 5.0 - 1e-9 <= s["h"] <= 40.0 + 1e-9, "h 只在控制点之间线性插值，不许下沉/过冲"
        assert abs(out[-1]["h"] - 40.0) < 1e-6

    def test_roll_direction_follows_screen_x(self) -> None:
        g = FakeGeom()
        seg = {"id": "m", "kind": "manual", "path": {"points": [{"x": 0, "z": 0, "h": 0}, {"x": -100, "z": 0, "h": 0}]},
               "timing": {"durationMs": 500, "keys": []}, "roll": {"radius": 10, "direction": 1}}
        out = bake3d.manual_samples_3d(seg, (0.0, 0.0, 0.0), _pose(), g, hz=60, warnings=[])
        assert abs(out[-1]["rotation"] - math.degrees(100 / 10)) < 1e-6


class TestBakeAssetWorld:
    def _doc(self) -> dict:
        return {
            "id": "t", "space": "world",
            "source": {"segments": [_phys(), {"id": "m", "kind": "manual", "startFrom": "previous",
                                              "path": {"points": [{"x": 0, "z": 0, "h": 0}, {"x": 80, "z": 20, "h": 0}]},
                                              "timing": {"durationMs": 800, "keys": []}}],
                       "bake": {"sampleHz": 60}},
            "authoring": {"sceneId": "fake", "anchor": {"x": 2100, "y": 400}, "contactOffsetY": 7},
        }

    def test_world_and_fallback_frames_align_and_are_relative(self) -> None:
        g = FakeGeom()
        r = bake_asset(self._doc(), g)
        assert not r["warnings"]
        wf, kf = r["worldKeyframes"], r["keyframes"]
        assert len(wf) == len(kf) >= 2
        assert [f["atMs"] for f in wf] == [f["atMs"] for f in kf]
        assert wf[0]["atMs"] == 0 and kf[0]["atMs"] == 0
        assert (wf[0]["x"], wf[0]["y"], wf[0]["z"]) == (0, 0, 0), "首帧相对锚点应为原点"
        assert abs(wf[0]["h"] - r["authoring"]["anchorHeight"]) < 0.011, "h 取 2 位、anchorHeight 取 3 位"
        assert r["authoring"]["anchorHeight"] == pytest.approx(7 / math.sqrt(0.5), abs=1e-3)
        assert len(r["segments"]) == 2 and r["segments"][1]["startMs"] == r["segments"][0]["endMs"]
        assert len(r["preview"]["world"]) == len(r["preview"]["screen"]) > len(wf)

    def test_deterministic(self) -> None:
        g = FakeGeom()
        a = json.dumps(bake_asset(self._doc(), g)["worldKeyframes"], ensure_ascii=False)
        b = json.dumps(bake_asset(self._doc(), g)["worldKeyframes"], ensure_ascii=False)
        assert a == b

    def test_no_depth_scene_warns_and_yields_nothing(self) -> None:
        g = FakeGeom()
        g.has_depth = False
        r = bake_asset(self._doc(), g)
        assert r["keyframes"] == [] and any("深度" in w for w in r["warnings"])
