"""挂点位姿解算的跨语言 parity 锁（norms 第 8 条）。

``tools/editor/shared/animation_sockets.py::socket_pose_to_local`` 是
``src/data/animationSockets.ts::socketPoseToLocal`` 的手工镜像——编辑器画布按 Python 侧
画标记、游戏按 TS 侧摆挂件，两边漂一点就是"编辑器里对齐了、游戏里差半个身位"。

本文件与 ``src/data/animationSockets.test.ts`` 钉死**同一组黄金数值**，任一侧漂移即红。
改用例必须同步改两个文件。

另钉：sidecar 读写往返（空集删文件、缺省值不落键、指纹随图集刷新）与插值/复制的语义。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from tools.editor.shared.animation_sockets import (
    SOCKETS_SCHEMA_VERSION,
    copy_pose_between_slots,
    empty_socket_set,
    fingerprint_matches,
    fingerprint_of_anim,
    interpolate_poses,
    interpolate_poses as _interp,  # noqa: F401  (可读性：下方按语义各自命名)
    load_socket_set,
    normalize_pose,
    sanitize_socket_set,
    save_socket_set,
    socket_pose_to_local,
    sockets_path_for_bundle,
)

# ---- 黄金用例（与 animationSockets.test.ts 的「挂点位姿解算」一节完全一致）----
HOST = dict(world_width=100.0, world_height=200.0, depth_scale=1.0, facing=1, visual_lift_y=0.0)

ANIM = {
    "cols": 9,
    "rows": 10,
    "cellWidth": 219,
    "cellHeight": 204,
    "atlasFrames": [{"width": 219, "height": 204}] * 89,
}


class SocketPoseParityTests(unittest.TestCase):
    def test_center_bottom_is_foot_origin(self) -> None:
        p = socket_pose_to_local({"x": 0.5, "y": 1}, **HOST)
        self.assertEqual((p["x"], p["y"]), (0.0, 0.0))

    def test_cell_top_is_one_body_height_up(self) -> None:
        self.assertEqual(socket_pose_to_local({"x": 0.5, "y": 0}, **HOST)["y"], -200.0)

    def test_mirror_flips_x_to_other_side(self) -> None:
        self.assertEqual(socket_pose_to_local({"x": 1, "y": 1}, **HOST)["x"], 50.0)
        self.assertEqual(
            socket_pose_to_local({"x": 1, "y": 1}, **{**HOST, "facing": -1})["x"], -50.0,
        )

    def test_mirror_negates_angle(self) -> None:
        self.assertEqual(
            socket_pose_to_local({"x": 0.5, "y": 0.5, "angle": 30}, **HOST)["angleDeg"], 30.0)
        self.assertEqual(
            socket_pose_to_local(
                {"x": 0.5, "y": 0.5, "angle": 30}, **{**HOST, "facing": -1})["angleDeg"], -30.0)

    def test_depth_scale_shrinks_position_and_size(self) -> None:
        p = socket_pose_to_local({"x": 1, "y": 0}, **{**HOST, "depth_scale": 0.5})
        self.assertEqual((p["x"], p["y"], p["scale"]), (25.0, -100.0, 0.5))

    def test_visual_lift_carries_attachment(self) -> None:
        p = socket_pose_to_local({"x": 0.5, "y": 1}, **{**HOST, "visual_lift_y": -40})
        self.assertEqual(p["y"], -40.0)

    def test_illegal_depth_scale_falls_back_to_one(self) -> None:
        self.assertEqual(socket_pose_to_local({"x": 1, "y": 1}, **{**HOST, "depth_scale": 0})["x"], 50.0)
        self.assertEqual(
            socket_pose_to_local({"x": 1, "y": 1}, **{**HOST, "depth_scale": float("nan")})["scale"], 1.0)


class SocketSidecarRoundtripTests(unittest.TestCase):
    def test_fingerprint_matches_anim(self) -> None:
        fp = fingerprint_of_anim(ANIM)
        self.assertEqual(
            fp, {"cols": 9, "rows": 10, "slotCount": 89})
        self.assertTrue(fingerprint_matches(fp, fingerprint_of_anim(ANIM)))
        self.assertFalse(fingerprint_matches(fp, fingerprint_of_anim({**ANIM, "cols": 10})))
        # 格子像素尺寸**不进**指纹：换分辨率重导但网格没动，标注依然有效，不该误杀
        self.assertTrue(fingerprint_matches(fp, fingerprint_of_anim({**ANIM, "cellWidth": 438})))
        # 缺 cellWidth 的包（全库有 8 个）两侧算出的指纹必须一致，否则挂点永远判失效
        no_cell = {k: v for k, v in ANIM.items() if k not in ("cellWidth", "cellHeight")}
        self.assertEqual(fingerprint_of_anim(no_cell), fingerprint_of_anim(ANIM))

    def test_defaults_not_written(self) -> None:
        """angle=0 / front=False 不落键——往返干净，也与 TS 侧解析一致。"""
        self.assertEqual(normalize_pose({"x": 0.5, "y": 0.5, "angle": 0, "front": False}),
                         {"x": 0.5, "y": 0.5})
        self.assertEqual(normalize_pose({"x": 0.5, "y": 0.5, "angle": -12, "front": True, "frame": 2.0}),
                         {"x": 0.5, "y": 0.5, "angle": -12.0, "front": True, "frame": 2})

    def test_bad_pose_dropped_not_fatal(self) -> None:
        self.assertIsNone(normalize_pose({"x": "bad", "y": 1}))
        self.assertIsNone(normalize_pose(None))

    def test_sanitize_refreshes_fingerprint_and_drops_empties(self) -> None:
        out = sanitize_socket_set(
            {"atlas": {"cols": 1}, "sockets": {
                "h": {"label": " 右手 ", "poses": {"3": {"x": 0.1, "y": 0.2}}},
                "empty": {"poses": {}},
                "bad": {"poses": {"0": {"x": "x"}}},
            }},
            ANIM,
        )
        self.assertEqual(out["atlas"], fingerprint_of_anim(ANIM))
        self.assertEqual(set(out["sockets"]), {"h"})
        self.assertEqual(out["sockets"]["h"]["label"], "右手")
        self.assertEqual(out["schemaVersion"], SOCKETS_SCHEMA_VERSION)

    def test_save_load_roundtrip_and_empty_deletes_file(self) -> None:
        with TemporaryDirectory() as td:
            path = sockets_path_for_bundle(Path(td), "player_anim")
            path.parent.mkdir(parents=True, exist_ok=True)
            data = sanitize_socket_set(
                {"sockets": {"h": {"poses": {"0": {"x": 0.62, "y": 0.55, "angle": -12, "front": True}}}}},
                ANIM,
            )
            save_socket_set(path, data)
            self.assertTrue(path.is_file())
            self.assertEqual(load_socket_set(path), data)
            # 末尾换行 + 中文不转义（write_json 约定）
            raw = path.read_text(encoding="utf-8")
            self.assertTrue(raw.endswith("\n"))

            # 清空挂点 → 删文件，不留空壳
            save_socket_set(path, empty_socket_set(ANIM))
            self.assertFalse(path.is_file())
            self.assertIsNone(load_socket_set(path))

    def test_load_missing_or_broken_is_none(self) -> None:
        with TemporaryDirectory() as td:
            p = Path(td) / "sockets.json"
            self.assertIsNone(load_socket_set(p))
            p.write_text("{ not json", encoding="utf-8")
            self.assertIsNone(load_socket_set(p))


class SocketAuthoringHelpersTests(unittest.TestCase):
    def _set(self) -> dict:
        return {"sockets": {"h": {"poses": {
            "0": {"x": 0.0, "y": 0.0, "angle": 0, "front": True},
            "4": {"x": 1.0, "y": 1.0, "angle": 40},
        }}}}

    def test_copy_pose_between_slots(self) -> None:
        data = self._set()
        self.assertTrue(copy_pose_between_slots(data, "h", 0, 1))
        self.assertEqual(data["sockets"]["h"]["poses"]["1"], data["sockets"]["h"]["poses"]["0"])
        self.assertFalse(copy_pose_between_slots(data, "h", 99, 2), "源帧没标注就不该复制")
        self.assertFalse(copy_pose_between_slots(data, "缺席挂点", 0, 1))

    def test_interpolate_fills_only_gaps(self) -> None:
        data = self._set()
        filled = interpolate_poses(data, "h", [0, 1, 2, 3, 4])
        self.assertEqual(filled, 3)
        poses = data["sockets"]["h"]["poses"]
        self.assertAlmostEqual(poses["2"]["x"], 0.5)
        self.assertAlmostEqual(poses["2"]["y"], 0.5)
        self.assertAlmostEqual(poses["2"]["angle"], 20.0)
        # front/frame 是离散量，跟起点走而不是插值
        self.assertTrue(poses["2"]["front"])
        # 端点不动
        self.assertEqual(poses["0"]["x"], 0.0)
        self.assertEqual(poses["4"]["x"], 1.0)

    def test_interpolate_needs_two_keys(self) -> None:
        self.assertEqual(interpolate_poses({"sockets": {"h": {"poses": {"0": {"x": 0, "y": 0}}}}},
                                           "h", [0, 1, 2]), 0)

    def test_interpolate_does_not_overwrite_authored(self) -> None:
        data = self._set()
        data["sockets"]["h"]["poses"]["2"] = {"x": 0.9, "y": 0.9}
        interpolate_poses(data, "h", [0, 1, 2, 3, 4])
        self.assertEqual(data["sockets"]["h"]["poses"]["2"]["x"], 0.9, "已标注的帧不许被插值覆盖")


class SocketJsonShapeTests(unittest.TestCase):
    def test_written_shape_matches_runtime_contract(self) -> None:
        """写出来的形状必须是运行时 parseSocketSet 认的那套（键名逐字对齐）。"""
        data = sanitize_socket_set(
            {"sockets": {"right_hand": {"label": "右手", "poses": {"0": {"x": 0.6, "y": 0.5}}}}}, ANIM)
        text = json.dumps(data, ensure_ascii=False)
        for key in ('"schemaVersion"', '"atlas"', '"sockets"', '"poses"', '"cols"', '"slotCount"'):
            self.assertIn(key, text)
        self.assertIn('"右手"', text, "中文不得转义")


if __name__ == "__main__":
    unittest.main()
