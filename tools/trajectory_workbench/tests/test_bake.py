"""实体轨迹动画烘焙核心的护栏。

这份文件盯四类东西，每一类漏了都是"不报错但画面不对"：

1. **跨语言 parity**（本文件最重要的一条）：Python 采样器与 TS
   ``src/utils/keyframeSampler.ts`` 必须逐位一致。金标是**真的从**
   ``src/utils/keyframeSampler.golden.json`` 读进来的（不是把数字抄一份到这里——
   抄一份就等于把契约劈成两半，TS 侧改了这边照样绿）。
   编辑器规范第 8 条：手工镜像必配**语义级** parity 测试。
2. **物理不变量**：地面永不穿透、总能量单调不增、有限时间内必达静止、触地帧真的
   落进产物、``restitution=0`` 首次触地即贴地。物理错了只表现为"弹得怪"，
   没有任何断言之外的东西会发现。
3. **抽稀误差上界**：抽稀后在任一原始采样点上与密曲线的偏差 ≤ 该通道容差。
   这条不断言的话，抽稀"看起来挺省"但把弹跳磨圆了也一样过。
4. **确定性与往返**：同输入两次烘焙逐字节相同；规范化/反规范化幂等且不产出缺省键。
"""
from __future__ import annotations

import io
import json
import math
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.trajectory_workbench.bake import (  # noqa: E402
    CHANNEL_TOLERANCE_KEY,
    DEFAULT_TOLERANCE,
    SAMPLE_HZ_MAX,
    SAMPLE_HZ_MIN,
    apply_keyframe_easing,
    arc_length_lut,
    bake_samples,
    bake_trajectory,
    decimate_samples,
    eval_timing,
    eval_track,
    point_at_arc,
    resolve_sample_hz,
    resolve_segment_start,
    resolve_tolerance,
    sample_keyframes,
    sample_trajectory_pose,
    simulate_physics,
    simulate_physics_nodes,
    timing_warnings,
)
from tools.trajectory_workbench.model import (  # noqa: E402
    POSE_CHANNELS,
    normalize_keyframe,
    normalize_trajectory,
    sampler_channels,
    write_keyframe,
)

_GOLDEN = _ROOT / "src" / "utils" / "keyframeSampler.golden.json"


def _load_golden() -> list[dict]:
    with io.open(_GOLDEN, encoding="utf-8") as fh:
        return json.load(fh)


# ===========================================================================
# 1. 跨语言 parity
# ===========================================================================

class TestSamplerParity:
    def test_golden_fixture_is_present_and_not_hollowed_out(self) -> None:
        """金标文件本身也是被盯着的：被清空/挪走时要红，而不是让 parity 变成空转。"""
        assert _GOLDEN.exists(), f"跨语言金标不见了：{_GOLDEN}"
        cases = _load_golden()
        assert len(cases) >= 12, "金标 case 少于 12 条，多半是被谁删了"
        for case in cases:
            assert case["samples"], f"{case['name']} 没有采样点"

    @pytest.mark.parametrize("case", _load_golden(), ids=lambda c: c["name"])
    def test_python_sampler_matches_typescript_golden(self, case: dict) -> None:
        """逐 case 对账 ``src/utils/keyframeSampler.golden.json``，容差 1e-9。

        这一条红了**不要动这边的数学**去凑绿：先确认 TS 侧是不是改了契约。
        缓动是二次族、段缓动取起始帧、``span = max(1, Δms)`` —— 三条都是既有行为。
        """
        channels = case["channels"]
        for sample in case["samples"]:
            got = sample_keyframes(
                case["keyframes"],
                sample["tMs"],
                loop=case["loop"],
                default_easing=case["defaultEasing"],
                channels=channels,
            )
            assert set(got.keys()) == set(channels.keys()), (
                f"{case['name']}: 返回键集必须恒等于 channels 键集"
            )
            for name, expect in sample["expect"].items():
                assert got[name] == pytest.approx(expect, abs=1e-9), (
                    f"{case['name']} @ {sample['tMs']}ms 通道 {name}: "
                    f"Python={got[name]!r} TS金标={expect!r}"
                )

    @pytest.mark.parametrize("case", _load_golden(), ids=lambda c: c["name"])
    def test_cursor_path_is_bit_identical_to_full_scan(self, case: dict) -> None:
        """顺播游标只改复杂度，不许改结果（TS 侧同样锁死了这一条）。"""
        cursor = {"i": 0}
        for sample in case["samples"]:
            plain = sample_keyframes(
                case["keyframes"], sample["tMs"], loop=case["loop"],
                default_easing=case["defaultEasing"], channels=case["channels"],
            )
            cursed = sample_keyframes(
                case["keyframes"], sample["tMs"], loop=case["loop"],
                default_easing=case["defaultEasing"], channels=case["channels"],
                cursor=cursor,
            )
            assert plain == cursed, f"{case['name']} @ {sample['tMs']}ms 游标路径不一致"

    def test_easing_family_is_quadratic_not_cubic(self) -> None:
        """缓动族是**二次**。有人"顺手升级"成三次的话这里会红。"""
        assert apply_keyframe_easing(0.5, "easeIn") == pytest.approx(0.25)
        assert apply_keyframe_easing(0.5, "easeOut") == pytest.approx(0.75)
        assert apply_keyframe_easing(0.25, "easeInOut") == pytest.approx(0.125)
        assert apply_keyframe_easing(0.75, "easeInOut") == pytest.approx(0.875)
        # 未知字符串 / None 一律 linear（与 TS 的三元链末端一致）
        assert apply_keyframe_easing(0.3, "bezierMagic") == pytest.approx(0.3)
        assert apply_keyframe_easing(0.3, None) == pytest.approx(0.3)

    def test_empty_track_returns_channel_defaults_instead_of_raising(self) -> None:
        got = sample_keyframes([], 123, channels={"x": 7.0, "alpha": 1.0})
        assert got == {"x": 7.0, "alpha": 1.0}


# ===========================================================================
# 2. 规范化 / 反规范化
# ===========================================================================

class TestNormalizeRoundtrip:
    def test_relational_defaults_are_filled_by_the_consumer(self) -> None:
        """`sortY 缺省 = y`、`scaleX/scaleY 缺省 = scale` —— 采样器给不了，只能这儿补。"""
        out = normalize_keyframe({"atMs": 40, "x": 10, "y": 250, "scale": 1.5})
        assert out["sortY"] == 250
        assert out["scaleX"] == 1.5 and out["scaleY"] == 1.5
        assert out["rotation"] == 0 and out["alpha"] == 1
        # 逐轴覆盖
        out2 = normalize_keyframe({"atMs": 0, "x": 0, "y": 0, "scale": 2, "scaleY": 3})
        assert (out2["scaleX"], out2["scaleY"]) == (2, 3)

    def test_normalized_frame_has_every_pose_channel(self) -> None:
        out = normalize_keyframe({"atMs": 0, "x": 1, "y": 2})
        for ch in POSE_CHANNELS:
            assert ch in out, ch

    def test_write_keyframe_omits_every_default_key(self) -> None:
        frame = write_keyframe({"atMs": 12, "x": 100, "y": 200, "rotation": 0,
                                "scaleX": 1, "scaleY": 1, "alpha": 1, "sortY": 200})
        assert frame == {"atMs": 12, "x": 100, "y": 200}

    def test_write_keyframe_merges_uniform_scale_and_splits_anisotropic(self) -> None:
        merged = write_keyframe({"atMs": 0, "x": 0, "y": 0, "scaleX": 2, "scaleY": 2})
        assert "scale" in merged and "scaleX" not in merged and "scaleY" not in merged
        split = write_keyframe({"atMs": 0, "x": 0, "y": 0, "scaleX": 2, "scaleY": 1})
        assert split["scaleX"] == 2 and split["scaleY"] == 1 and "scale" not in split

    def test_write_keyframe_key_order_is_fixed(self) -> None:
        """键序 = json.dumps 的字节序，属于硬契约。"""
        frame = write_keyframe({"atMs": 5, "x": 1.234, "y": 2.345, "rotation": 30,
                                "scaleX": 2, "scaleY": 3, "alpha": 0.5, "sortY": 999})
        assert list(frame.keys()) == ["atMs", "x", "y", "rotation", "scaleX", "scaleY", "alpha", "sortY"]

    def test_bake_products_never_carry_easing(self) -> None:
        """密帧 + 段缓动 = 缓动两遍。与 parallax 同一硬契约。"""
        frame = write_keyframe(normalize_keyframe(
            {"atMs": 0, "x": 0, "y": 0, "easing": "easeInOut"}))
        assert "easing" not in frame

    def test_write_normalize_roundtrip_is_idempotent(self) -> None:
        disk = [
            {"atMs": 0, "x": 100, "y": 200},
            {"atMs": 250, "x": 150.5, "y": 180.25, "rotation": 45.5, "sortY": 200},
            {"atMs": 500, "x": 200, "y": 200, "scale": 1.25, "alpha": 0.5},
            {"atMs": 750, "x": 250, "y": 200, "scaleX": 2, "scaleY": 0.5},
        ]
        for raw in disk:
            once = write_keyframe(normalize_keyframe(raw))
            twice = write_keyframe(normalize_keyframe(once))
            assert once == twice, f"往返不幂等: {raw}"
            # 缺省键一个都不许冒出来
            if once.get("sortY") is not None:
                assert once["sortY"] != once["y"]
            assert once.get("rotation") != 0
            assert once.get("alpha") != 1
            assert once.get("scale") != 1

    def test_bool_is_not_a_number(self) -> None:
        """``True`` 是 int 的子类；JS 侧 ``typeof true === 'boolean'`` 不算数。"""
        out = normalize_keyframe({"atMs": 0, "x": True, "y": 5})
        assert out["x"] == 0.0

    def test_sample_trajectory_pose_fills_relational_defaults_before_sampling(self) -> None:
        """采样器是哑的：中间帧没写 sortY 时**不能**掉到 0 去。"""
        pose = sample_trajectory_pose(
            [{"atMs": 0, "x": 0, "y": 100}, {"atMs": 100, "x": 0, "y": 300}], 50)
        assert pose["sortY"] == pytest.approx(200.0)
        assert set(pose.keys()) == set(sampler_channels().keys())


# ===========================================================================
# 3. 弧长参数化
# ===========================================================================

class TestArcLength:
    def test_polyline_equal_arc_steps_are_exactly_equidistant(self) -> None:
        lut = arc_length_lut([{"x": 0, "y": 0}, {"x": 100, "y": 0}, {"x": 100, "y": 100}])
        assert lut.total == pytest.approx(200.0)
        pts = [point_at_arc(lut, i / 40) for i in range(41)]
        gaps = [math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(40)]
        for gap in gaps:
            assert gap == pytest.approx(5.0, abs=1e-9)

    def test_smooth_equal_arc_steps_are_equidistant_within_tolerance(self) -> None:
        """曲线上等弧长取点，弦长略短于弧长；细分 16 份后误差应在 1% 量级内。"""
        lut = arc_length_lut(
            [{"x": 0, "y": 0}, {"x": 100, "y": 80}, {"x": 220, "y": -40}, {"x": 320, "y": 60}],
            smooth=True,
        )
        pts = [point_at_arc(lut, i / 60) for i in range(61)]
        gaps = [math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) for i in range(60)]
        mean = sum(gaps) / len(gaps)
        assert mean > 0
        for gap in gaps:
            assert abs(gap - mean) / mean < 0.02

    def test_smooth_curve_passes_through_control_points(self) -> None:
        """Catmull-Rom 过点：控制点必须在曲线上（端点用重复端点，首尾也要过）。"""
        ctrl = [(0.0, 0.0), (100.0, 80.0), (220.0, -40.0), (320.0, 60.0)]
        lut = arc_length_lut([{"x": p[0], "y": p[1]} for p in ctrl], smooth=True)
        for s01, expect in zip(lut.vertex_s01, ctrl):
            x, y, _ = point_at_arc(lut, s01)
            assert (x, y) == pytest.approx(expect, abs=1e-6)

    def test_tangent_angle_uses_y_down_convention(self) -> None:
        """Y 向下：向右 = 0°，**向下** = +90°（屏幕上的顺时针为正）。"""
        right = arc_length_lut([{"x": 0, "y": 0}, {"x": 100, "y": 0}])
        assert point_at_arc(right, 0.5)[2] == pytest.approx(0.0)
        down = arc_length_lut([{"x": 0, "y": 0}, {"x": 0, "y": 100}])
        assert point_at_arc(down, 0.5)[2] == pytest.approx(90.0)

    def test_clamps_out_of_range_and_survives_degenerate_paths(self) -> None:
        lut = arc_length_lut([{"x": 10, "y": 20}, {"x": 30, "y": 20}])
        assert point_at_arc(lut, -5)[:2] == pytest.approx((10.0, 20.0))
        assert point_at_arc(lut, 5)[:2] == pytest.approx((30.0, 20.0))
        single = arc_length_lut([{"x": 7, "y": 8}])
        assert point_at_arc(single, 0.5) == (7.0, 8.0, 0.0)
        dupes = arc_length_lut([{"x": 1, "y": 1}, {"x": 1, "y": 1}, {"x": 1, "y": 1}])
        assert point_at_arc(dupes, 0.7) == (1.0, 1.0, 0.0)
        assert arc_length_lut([]).total == 0.0


# ===========================================================================
# 4. 时间曲线 / 通道轨
# ===========================================================================

class TestTimingAndTracks:
    def test_empty_keys_is_uniform_speed(self) -> None:
        assert eval_timing([], 0, 1000) == pytest.approx(0.0)
        assert eval_timing([], 500, 1000) == pytest.approx(0.5)
        assert eval_timing([], 5000, 1000) == pytest.approx(1.0)
        assert eval_timing([], -5, 1000) == pytest.approx(0.0)

    def test_progress_is_clamped_and_monotonic_even_for_garbage_input(self) -> None:
        keys = [
            {"atMs": 0, "progress": -3},
            {"atMs": 400, "progress": 4},
            {"atMs": 200, "progress": 0.1},  # atMs 倒退
        ]
        values = [eval_timing(keys, t, 1000) for t in range(0, 1001, 25)]
        assert all(0.0 <= v <= 1.0 for v in values)
        assert all(b >= a - 1e-12 for a, b in zip(values, values[1:]))

    def test_timing_warnings_surface_what_eval_silently_clamped(self) -> None:
        warns = timing_warnings(
            [{"atMs": 0, "progress": 0}, {"atMs": 200, "progress": 1.4},
             {"atMs": 100, "progress": 0.2}],
            1000,
        )
        assert any("越界" in w for w in warns)
        assert any("非降" in w for w in warns)
        assert any("倒放" in w for w in warns)
        assert timing_warnings([{"atMs": 0, "progress": 0}], 0)

    def test_timing_uses_segment_easing_from_the_starting_key(self) -> None:
        keys = [{"atMs": 0, "progress": 0, "easing": "easeIn"}, {"atMs": 1000, "progress": 1}]
        assert eval_timing(keys, 500, 1000) == pytest.approx(0.25)

    def test_eval_track_falls_back_to_the_incoming_pose(self) -> None:
        assert eval_track(None, 500, 3.5) == pytest.approx(3.5)
        assert eval_track([], 500, 3.5) == pytest.approx(3.5)
        keys = [{"atMs": 0, "value": 0}, {"atMs": 1000, "value": 100}]
        assert eval_track(keys, 250, 0) == pytest.approx(25.0)


# ===========================================================================
# 5. 物理不变量
# ===========================================================================

def _bouncing_segment(**over) -> dict:
    seg = {
        "kind": "physics",
        "id": "phys",
        "startFrom": "explicit",
        "start": {"x": 200, "y": 300},
        # Y 向下：往上抛 vy 为负；groundY 是个较大的 y。
        "v0": {"x": 180, "y": -320},
        "gravity": 900,
        "groundY": 520,
        "restitution": 0.55,
        "tangentialDamping": 0.08,
        "rollingFriction": 140,
        "spin": {"radius": 12, "omega0": 220},
        "stop": {"minSpeed": 8, "maxMs": 20000},
    }
    seg.update(over)
    return seg


_START_POSE = {"x": 200, "y": 300, "rotation": 0, "scaleX": 1, "scaleY": 1, "alpha": 1, "sortY": 300}


class TestPhysicsInvariants:
    def test_ground_is_never_penetrated(self) -> None:
        """一个都不许穿：积分节点、重采样、烘出来的帧，三层都查。"""
        seg = _bouncing_segment()
        ground = seg["groundY"]
        run = simulate_physics_nodes(seg, _START_POSE)
        for node in run.nodes:
            assert node.y <= ground + 1e-6, f"t={node.t_sec} y={node.y} 穿透了 {ground}"
        for sample in simulate_physics(seg, _START_POSE, hz=60):
            assert sample["y"] <= ground + 1e-6
        traj = {"id": "t", "target": {"kind": "npc", "id": "coin"},
                "source": {"segments": [seg]}}
        for frame in bake_trajectory(traj):
            assert frame["y"] <= ground + 1e-9

    def test_total_energy_never_increases(self) -> None:
        """辛欧拉 + 精确 TOI 的结果：平动比能逐节点单调不增。

        反过来写积分次序、或者"穿一点再拉回地面"，这条立刻破——而且画面上只表现为
        球越弹越高，没有任何报错。
        """
        run = simulate_physics_nodes(_bouncing_segment(), _START_POSE)
        energies = [run.energy(n) for n in run.nodes]
        assert len(energies) > 50
        for i in range(len(energies) - 1):
            assert energies[i + 1] <= energies[i] + 1e-9, (
                f"第 {i} → {i + 1} 个节点能量上涨：{energies[i]} → {energies[i + 1]}"
            )
        assert energies[-1] < energies[0]

    def test_comes_to_rest_well_inside_max_ms(self) -> None:
        """有限时间内必达静止（而不是靠 maxMs 一刀砍停）。"""
        seg = _bouncing_segment()
        run = simulate_physics_nodes(seg, _START_POSE)
        last = run.nodes[-1]
        assert last.t_sec * 1000.0 < seg["stop"]["maxMs"] - 1.0, "是被 maxMs 砍停的，不是自己停的"
        assert last.grounded
        assert math.hypot(last.vx, last.vy) < seg["stop"]["minSpeed"]
        assert last.hard, "静止瞬间必须是关键帧"

    def test_impact_instants_are_hard_and_survive_into_the_product(self) -> None:
        """触地瞬间必须活到落盘的帧里 —— 不然抽稀会把弹跳的尖角磨圆。"""
        seg = _bouncing_segment()
        run = simulate_physics_nodes(seg, _START_POSE)
        impacts = [n for n in run.nodes[1:-1] if n.hard]
        assert len(impacts) >= 3, "这组参数应该弹好几下"
        for node in impacts:
            assert node.y == pytest.approx(seg["groundY"], abs=1e-9), "触地帧必须正好在地面上"

        samples = simulate_physics(seg, _START_POSE, hz=60)
        hard_ms = {round(s["atMs"], 6) for s in samples if s["hard"]}
        for node in impacts:
            assert round(node.t_sec * 1000.0, 6) in hard_ms

        traj = {"id": "t", "target": {"kind": "npc", "id": "coin"},
                "source": {"segments": [seg]}}
        baked_ms = {f["atMs"] for f in bake_trajectory(traj)}
        for node in impacts:
            assert int(round(node.t_sec * 1000.0)) in baked_ms, (
                f"触地 {node.t_sec * 1000:.2f}ms 没进烘焙产物"
            )

    def test_zero_restitution_settles_on_first_contact(self) -> None:
        seg = _bouncing_segment(restitution=0.0, spin=None)
        run = simulate_physics_nodes(seg, _START_POSE)
        contacts = [n for n in run.nodes[1:] if n.hard]
        assert contacts, "至少要触地一次"
        first = contacts[0]
        assert first.grounded, "restitution=0 必须首次触地即贴地"
        assert first.vy == pytest.approx(0.0, abs=1e-12)
        assert first.y == pytest.approx(seg["groundY"], abs=1e-9)

    def test_perfectly_elastic_ball_is_bounded_by_max_ms(self) -> None:
        """restitution=1 物理上就是永不停 —— 只能靠 maxMs 收口，但绝不许穿地或增能。"""
        seg = _bouncing_segment(restitution=1.0, tangentialDamping=0.0,
                                rollingFriction=0.0, stop={"minSpeed": 1, "maxMs": 3000})
        run = simulate_physics_nodes(seg, _START_POSE)
        assert run.nodes[-1].t_sec * 1000.0 == pytest.approx(3000.0, abs=1e-6)
        energies = [run.energy(n) for n in run.nodes]
        for i in range(len(energies) - 1):
            assert energies[i + 1] <= energies[i] + 1e-9
        for node in run.nodes:
            assert node.y <= seg["groundY"] + 1e-6

    def test_sort_y_is_pinned_to_ground_for_the_whole_flight(self) -> None:
        """腾空时深度按**落点**算 —— 这就是 sortY 这个通道存在的理由。"""
        seg = _bouncing_segment()
        for sample in simulate_physics(seg, _START_POSE, hz=60):
            assert sample["sortY"] == pytest.approx(seg["groundY"])

    def test_rolling_slaves_spin_to_velocity(self) -> None:
        """滚动期 ω = deg(vx / r)：纯滚动约束，不再是自由的 omega0。"""
        seg = _bouncing_segment(v0={"x": 200, "y": 0}, restitution=0.0,
                                spin={"radius": 20, "omega0": 999})
        run = simulate_physics_nodes(seg, _START_POSE)
        rolling = [n for n in run.nodes if n.grounded and abs(n.vx) > 1e-6]
        assert rolling
        for node in rolling:
            assert node.omega == pytest.approx(math.degrees(node.vx / 20), abs=1e-9)

    def test_physics_is_decoupled_from_sample_rate(self) -> None:
        """改 sampleHz 只改帧的疏密，**不改物理**。"""
        seg = _bouncing_segment()
        low = simulate_physics(seg, _START_POSE, hz=12)
        high = simulate_physics(seg, _START_POSE, hz=240)
        assert len(high) > len(low)
        assert low[-1]["atMs"] == pytest.approx(high[-1]["atMs"], abs=1e-9)
        assert low[-1]["x"] == pytest.approx(high[-1]["x"], abs=1e-9)
        assert low[-1]["y"] == pytest.approx(high[-1]["y"], abs=1e-9)


# ===========================================================================
# 6. 抽稀
# ===========================================================================

def _max_channel_error(samples: list[dict], kept_idx: list[int], channel: str) -> float:
    """抽稀后按**线性**回放（烘焙产物恒无 easing）重建，取所有密采样点上的最大偏差。

    按**下标**而不是按时刻重建：段边界上允许出现两个 `atMs` 相同的采样点
    （作者面真实的瞬时跳变，见 `test_sort_y_jumps_at_the_physics_boundary`），
    按时刻查表会把其中一个判成"错了 100"，那是量法的问题不是抽稀的问题。
    """
    worst = 0.0
    for a, b in zip(kept_idx, kept_idx[1:]):
        t0 = samples[a]["atMs"]
        dt = samples[b]["atMs"] - t0
        v0 = samples[a][channel]
        dv = samples[b][channel] - v0
        for k in range(a + 1, b):
            interp = v0 + dv * ((samples[k]["atMs"] - t0) / dt) if dt > 0 else v0
            worst = max(worst, abs(samples[k][channel] - interp))
    return worst


class TestDecimation:
    @pytest.mark.parametrize("tolerance", [None, {"pos": 2.0, "rot": 5.0}])
    def test_error_stays_within_tolerance_on_every_dense_sample(self, tolerance) -> None:
        traj = _two_segment_trajectory()
        dense = bake_samples(traj, anchor={"x": 100, "y": 300})
        tol = dict(dense.tolerance)
        if tolerance:
            tol.update(tolerance)
        for i, sample in enumerate(dense.samples):
            sample["_i"] = i  # decimate 只看七通道 / atMs / hard，这个键是惰性的
        kept = decimate_samples(dense.samples, tol)
        kept_idx = [s["_i"] for s in kept]
        assert 2 <= len(kept) < len(dense.samples), "抽稀既要真的省，也不能只剩两帧"
        for ch in POSE_CHANNELS:
            limit = tol[CHANNEL_TOLERANCE_KEY[ch]]
            worst = _max_channel_error(dense.samples, kept_idx, ch)
            assert worst <= limit + 1e-9, f"通道 {ch} 抽稀偏差 {worst} 超过容差 {limit}"

    def test_looser_tolerance_keeps_fewer_frames(self) -> None:
        dense = bake_samples(_two_segment_trajectory(), anchor={"x": 100, "y": 300})
        tight = decimate_samples(dense.samples, {"pos": 0.1, "rot": 0.1, "scale": 0.001, "alpha": 0.001})
        loose = decimate_samples(dense.samples, {"pos": 20.0, "rot": 30.0, "scale": 0.5, "alpha": 0.5})
        assert len(loose) < len(tight)

    def test_hard_samples_are_never_dropped(self) -> None:
        dense = bake_samples(_two_segment_trajectory(), anchor={"x": 100, "y": 300})
        hard = [s["atMs"] for s in dense.samples if s["hard"]]
        kept = {s["atMs"] for s in decimate_samples(
            dense.samples, {"pos": 1e6, "rot": 1e6, "scale": 1e6, "alpha": 1e6})}
        assert hard, "这条轨迹应该有 hard 采样点（段首尾 / 作者 key / 触地）"
        for t in hard:
            assert t in kept

    def test_resolve_helpers_clamp_garbage(self) -> None:
        assert resolve_sample_hz(None) == 60
        assert resolve_sample_hz(1) == SAMPLE_HZ_MIN
        assert resolve_sample_hz(100000) == SAMPLE_HZ_MAX
        assert resolve_sample_hz("nope") == 60
        assert resolve_tolerance(None) == DEFAULT_TOLERANCE
        assert resolve_tolerance({"tolerance": {"pos": 0}}) == DEFAULT_TOLERANCE
        assert resolve_tolerance({"tolerance": {"pos": 3}})["pos"] == 3


# ===========================================================================
# 7. 烘焙：分段链接 / 确定性 / 落形
# ===========================================================================

def _two_segment_trajectory() -> dict:
    """手绘（带 roll + alpha 轨）→ 抛体，覆盖两种段与段间链接。"""
    return {
        "id": "traj_demo",
        "label": "演示",
        "target": {"kind": "npc", "id": "coin_a"},
        "keyframes": [],
        "source": {
            "segments": [
                {
                    "kind": "manual",
                    "id": "m1",
                    "startFrom": "anchor",
                    "path": {"points": [{"x": 100, "y": 300}, {"x": 300, "y": 300},
                                        {"x": 420, "y": 420}], "smooth": False},
                    "timing": {"durationMs": 1200, "keys": [
                        {"atMs": 0, "progress": 0, "easing": "easeInOut"},
                        {"atMs": 1200, "progress": 1},
                    ]},
                    "tracks": {"alpha": [{"atMs": 0, "value": 1}, {"atMs": 1200, "value": 0.2}]},
                    "roll": {"radius": 14},
                },
                _bouncing_segment(id="p1", startFrom="previous", start=None,
                                  stop={"minSpeed": 8, "maxMs": 6000}),
            ],
            "bake": {"sampleHz": 60},
        },
    }


def _straight_chain_trajectory() -> dict:
    """两段直线，第二段 ``startFrom:'previous'`` —— 整条应当是一条匀速直线。

    第二段的 path 故意画在别处 (500,500)→(600,500)：路径是**形状**，锚点由
    `startFrom` 决定，所以它会被平移到第一段末点接上。
    """
    return {
        "id": "chain",
        "target": {"kind": "player"},
        "keyframes": [],
        "source": {
            "segments": [
                {"kind": "manual", "id": "a", "startFrom": "explicit", "start": {"x": 0, "y": 0},
                 "path": {"points": [{"x": 0, "y": 0}, {"x": 100, "y": 0}]},
                 "timing": {"durationMs": 1000, "keys": []}},
                {"kind": "manual", "id": "b", "startFrom": "previous",
                 "path": {"points": [{"x": 500, "y": 500}, {"x": 600, "y": 500}]},
                 "timing": {"durationMs": 1000, "keys": []}},
            ],
            "bake": {"sampleHz": 60},
        },
    }


class TestBake:
    def test_first_frame_is_zero_and_last_is_total_duration(self) -> None:
        traj = _two_segment_trajectory()
        dense = bake_samples(traj, anchor={"x": 100, "y": 300})
        frames = bake_trajectory(traj, anchor={"x": 100, "y": 300})
        assert frames[0]["atMs"] == 0
        assert frames[-1]["atMs"] == int(round(dense.total_ms))
        ats = [f["atMs"] for f in frames]
        assert ats == sorted(ats), "atMs 必须升序"

    def test_output_is_byte_for_byte_deterministic(self) -> None:
        traj = _two_segment_trajectory()
        a = json.dumps(bake_trajectory(traj, anchor={"x": 100, "y": 300}), ensure_ascii=False)
        b = json.dumps(bake_trajectory(traj, anchor={"x": 100, "y": 300}), ensure_ascii=False)
        assert a == b

    def test_no_frame_carries_easing(self) -> None:
        for frame in bake_trajectory(_two_segment_trajectory(), anchor={"x": 100, "y": 300}):
            assert "easing" not in frame

    def test_segments_are_chained_end_to_start(self) -> None:
        dense = bake_samples(_two_segment_trajectory(), anchor={"x": 100, "y": 300})
        assert len(dense.segments) == 2
        for prev, nxt in zip(dense.segments, dense.segments[1:]):
            assert nxt["start"] == pytest.approx(prev["end"], abs=1e-9)
            assert nxt["startMs"] == pytest.approx(prev["endMs"], abs=1e-9)

    def test_chained_straight_segments_stay_continuous_across_the_boundary(self) -> None:
        """段边界左右极限一致：两段直线接起来必须是一条直线，位置/旋转/缩放全连续。"""
        traj = _straight_chain_trajectory()
        dense = bake_samples(traj)
        boundary = dense.segments[0]["endMs"]
        for sample in dense.samples:
            assert sample["x"] == pytest.approx(sample["atMs"] * 0.1, abs=1e-6)
            assert sample["y"] == pytest.approx(0.0, abs=1e-9)
        left = [s for s in dense.samples if s["atMs"] < boundary][-1]
        right = [s for s in dense.samples if s["atMs"] > boundary][0]
        at = [s for s in dense.samples if s["atMs"] == pytest.approx(boundary)]
        assert len(at) == 1, "重合的段边界帧应当并成一个"
        for ch in ("rotation", "scaleX", "scaleY", "alpha"):
            assert left[ch] == pytest.approx(right[ch], abs=1e-9), f"{ch} 在段边界跳变了"
        # 匀速直线烘完只该剩骨架：起点、段边界（hard，恒留）、终点 —— 一帧不多。
        frames = bake_trajectory(traj)
        assert frames == [
            {"atMs": 0, "x": 0, "y": 0},
            {"atMs": 1000, "x": 100, "y": 0},
            {"atMs": 2000, "x": 200, "y": 0},
        ]

    def test_sort_y_jumps_at_the_physics_boundary_on_purpose(self) -> None:
        """手绘段 `sortY = y`、抛体段 `sortY = groundY` —— 交界处的跳变是**语义**不是 bug。

        含义是"从这一刻起我是个抛射物，深度按落点算"。两个同 `atMs` 的帧都留着，
        回放成一次瞬时切换（采样器 span 下限 1ms），而不是被偷偷抹平成一段斜坡。
        """
        dense = bake_samples(_two_segment_trajectory(), anchor={"x": 100, "y": 300})
        boundary = dense.segments[0]["endMs"]
        at_boundary = [s for s in dense.samples if s["atMs"] == pytest.approx(boundary)]
        assert len(at_boundary) == 2, "位置连续但 sortY 跳变 ⇒ 边界两帧都该留"
        assert at_boundary[0]["sortY"] == pytest.approx(at_boundary[0]["y"])
        assert at_boundary[1]["sortY"] == pytest.approx(520.0)
        assert at_boundary[0]["x"] == pytest.approx(at_boundary[1]["x"], abs=1e-9)
        assert at_boundary[0]["y"] == pytest.approx(at_boundary[1]["y"], abs=1e-9)

    def test_non_position_channels_chain_too(self) -> None:
        """第二段没写 scale 轨时，必须**接着**第一段的末缩放走，不是跳回 1。"""
        traj = _straight_chain_trajectory()
        traj["source"]["segments"][0]["tracks"] = {
            "scale": [{"atMs": 0, "value": 1}, {"atMs": 1000, "value": 2.5}]}
        dense = bake_samples(traj)
        tail = [s for s in dense.samples if s["atMs"] >= dense.segments[1]["startMs"]]
        for sample in tail:
            assert sample["scaleX"] == pytest.approx(2.5, abs=1e-9)
            assert sample["scaleY"] == pytest.approx(2.5, abs=1e-9)

    def test_manual_path_is_anchored_to_the_resolved_start(self) -> None:
        """路径是形状：`startFrom:'anchor'` 时整条被平移到实体处。"""
        traj = _straight_chain_trajectory()
        traj["source"]["segments"] = [traj["source"]["segments"][0]]
        traj["source"]["segments"][0]["startFrom"] = "entity"
        dense = bake_samples(traj, anchor={"x": 640, "y": 480})
        assert dense.samples[0]["x"] == pytest.approx(640.0)
        assert dense.samples[0]["y"] == pytest.approx(480.0)
        assert dense.samples[-1]["x"] == pytest.approx(740.0)

    def test_roll_derives_rotation_from_travelled_arc_length(self) -> None:
        """纯滚动：转角 = 路程 / 半径（types.ts 明说"按路程"）。"""
        traj = _straight_chain_trajectory()
        traj["source"]["segments"] = [traj["source"]["segments"][0]]
        traj["source"]["segments"][0]["roll"] = {"radius": 10}
        dense = bake_samples(traj)
        assert dense.samples[-1]["rotation"] == pytest.approx(math.degrees(100.0 / 10.0), abs=1e-6)
        traj["source"]["segments"][0]["roll"] = {"radius": 10, "direction": -1}
        flipped = bake_samples(traj)
        assert flipped.samples[-1]["rotation"] == pytest.approx(-math.degrees(10.0), abs=1e-6)

    def test_polyline_corner_becomes_a_keyframe(self) -> None:
        """折线拐角必须钉成帧：采样点没落在拐角上时抽稀也救不回来。"""
        traj = {
            "id": "corner", "target": {"kind": "player"}, "keyframes": [],
            "source": {"segments": [{
                "kind": "manual", "id": "c", "startFrom": "explicit", "start": {"x": 0, "y": 0},
                "path": {"points": [{"x": 0, "y": 0}, {"x": 400, "y": 0}, {"x": 400, "y": 400}]},
                "timing": {"durationMs": 800, "keys": []},
            }], "bake": {"sampleHz": 10}},
        }
        frames = bake_trajectory(traj)
        corner = [f for f in frames if f["x"] == pytest.approx(400.0) and f["y"] == pytest.approx(0.0)]
        assert corner, f"拐角 (400, 0) 没进产物：{frames}"

    def test_empty_source_returns_nothing_instead_of_wiping_hand_authored_frames(self) -> None:
        traj = {"id": "x", "target": {"kind": "player"}, "keyframes": [{"atMs": 0, "x": 1, "y": 2}]}
        assert bake_trajectory(traj) == []
        assert bake_samples(traj).warnings

    def test_unknown_segment_kind_is_reported_not_crashed(self) -> None:
        traj = {"id": "x", "target": {"kind": "player"},
                "source": {"segments": [{"kind": "teleport", "id": "z"}]}}
        result = bake_samples(traj)
        assert result.samples == []
        assert any("teleport" in w for w in result.warnings)

    def test_start_resolution_ladder(self) -> None:
        seg = {"startFrom": "anchor", "start": {"x": 9, "y": 9},
               "path": {"points": [{"x": 5, "y": 5}]}}
        assert resolve_segment_start(seg, index=0, prev_end=None, anchor=(1, 2)) == (1.0, 2.0)
        assert resolve_segment_start(seg, index=0, prev_end=(3, 4), anchor=None) == (3.0, 4.0)
        assert resolve_segment_start(seg, index=0, prev_end=None, anchor=None) == (9.0, 9.0)
        bare = {"startFrom": "anchor", "path": {"points": [{"x": 5, "y": 6}]}}
        assert resolve_segment_start(bare, index=0, prev_end=None, anchor=None) == (5.0, 6.0)
        assert resolve_segment_start({}, index=0, prev_end=(7, 8), anchor=(1, 1)) == (1.0, 1.0)
        assert resolve_segment_start({}, index=1, prev_end=(7, 8), anchor=(1, 1)) == (7.0, 8.0)


# ===========================================================================
# 8. 规范化
# ===========================================================================

class TestNormalize:
    def test_normalize_trajectory_keeps_source_and_unknown_keys(self) -> None:
        raw = {"id": " t ", "target": {"kind": "bogus", "id": "x"},
               "keyframes": [{"atMs": 0, "x": 1, "y": 2}],
               "source": {"segments": [{"kind": "manual"}]},
               "somethingNew": 42}
        out = normalize_trajectory(raw)
        assert out["id"] == "t"
        assert out["target"] == {"kind": "npc", "id": "x"}  # 非法 kind 落到 npc
        assert out["source"]["segments"][0]["kind"] == "manual"
        assert out["somethingNew"] == 42
        assert out["keyframes"][0]["sortY"] == 2  # 已填满
        assert raw["keyframes"][0] == {"atMs": 0, "x": 1, "y": 2}, "不许改入参"
