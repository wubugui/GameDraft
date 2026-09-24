"""透视缩放数学镜像的跨语言 parity 锁（深度轴模型）。

`tools/editor/shared/entity_transform_math.py::perspective_scale_at` ↔
`src/utils/perspectiveScale.ts::perspectiveScaleAt` 是手工镜像——本文件与
`src/utils/perspectiveScale.test.ts` 钉死**同一组黄金数值**，任一侧漂移即红
（norms 第 8 条：手工镜像必配语义级 parity）。

新增/修改用例时必须同步改两个文件（黄金常量一字不差）。

编辑器 UI 层（深度箭头拖拽 / 命中面幽灵轮廓）的流程探针见
test_perspective_axis_editor.py。
"""
from __future__ import annotations

import math
import unittest

from tools.editor.shared.entity_transform_math import (
    entity_participates_perspective,
    entity_perspective_factor,
    has_perspective_scale,
    perspective_axis_data,
    perspective_camera_follow_info,
    perspective_camera_zoom_ratio_at,
    perspective_scale_at,
)

# 竖直轴（近端底部大 → 远端顶部小），复现旧"水平线"行为
VERT = {"near": {"x": 0, "y": 500, "scale": 1.0}, "far": {"x": 0, "y": 100, "scale": 0.5}}
# 45° 斜街：等缩放等值线垂直于轴（fx+fy 相同 → 系数相同）
DIAG = {"near": {"x": 100, "y": 100, "scale": 1.0}, "far": {"x": 500, "y": 500, "scale": 0.4}}
# 竖直轴带中途点（非线性纵深）
MID = {
    "near": {"x": 0, "y": 0, "scale": 0.2},
    "far": {"x": 0, "y": 200, "scale": 1.0},
    "midStops": [{"pos": 0.5, "scale": 0.4}],
}
DEGEN = {"near": {"x": 0, "y": 0, "scale": 1.0}, "far": {"x": 0, "y": 0, "scale": 0.5}}
TINY = {"near": {"x": 0, "y": 0, "scale": 0.001}, "far": {"x": 0, "y": 100, "scale": 0.001}}

# (cfg, foot_x, foot_y, 期望系数)（黄金常量，与 TS 侧完全一致）
GOLDEN = [
    (VERT, 0, 500, 1.0),
    (VERT, 0, 100, 0.5),
    (VERT, 0, 300, 0.75),
    (VERT, 999, 300, 0.75),
    (VERT, 0, 600, 1.0),
    (VERT, 0, 0, 0.5),
    (DIAG, 100, 100, 1.0),
    (DIAG, 500, 500, 0.4),
    (DIAG, 300, 300, 0.7),
    (DIAG, 100, 500, 0.7),
    (DIAG, 500, 100, 0.7),
    (DIAG, 0, 0, 1.0),
    (DIAG, 700, 700, 0.4),
    (MID, 0, 0, 0.2),
    (MID, 0, 100, 0.4),
    (MID, 0, 150, 0.7),
    (MID, 0, 200, 1.0),
    (MID, 0, 50, 0.3),
    (DEGEN, 0, 0, 1.0),
    (TINY, 0, 50, 0.01),
    (VERT, float("nan"), 300, 1.0),
    (None, 0, 300, 1.0),
]


class PerspectiveScaleParityTests(unittest.TestCase):
    def test_scale_at_golden(self) -> None:
        for cfg, fx, fy, want in GOLDEN:
            got = perspective_scale_at(cfg, fx, fy)
            self.assertAlmostEqual(got, want, places=6, msg=f"cfg={cfg!r} ({fx},{fy})")

    def test_axis_validity(self) -> None:
        self.assertIsNone(perspective_axis_data(None))
        self.assertIsNone(perspective_axis_data(DEGEN))  # 退化轴
        self.assertIsNone(perspective_axis_data({"near": VERT["near"]}))  # 缺 far
        self.assertFalse(has_perspective_scale(DEGEN))
        self.assertTrue(has_perspective_scale(VERT))
        # 布尔不是数值（与 TS typeof number 同口径）
        self.assertIsNone(perspective_axis_data(
            {"near": {"x": True, "y": 0, "scale": 1}, "far": {"x": 1, "y": 1, "scale": 1}}))
        # 非法 midStops（pos 越界/scale≤0）被跳过，仍生效
        cfg = {"near": {"x": 0, "y": 0, "scale": 1}, "far": {"x": 0, "y": 100, "scale": 0.5},
               "midStops": [{"pos": 1.5, "scale": 0.7}, {"pos": 0.5, "scale": 0}]}
        a = perspective_axis_data(cfg)
        self.assertIsNotNone(a)
        self.assertEqual([p for p, _ in a[5]], [0.0, 1.0])  # 两个非法 mid 都被剔除

    def test_participation_contract(self) -> None:
        self.assertTrue(entity_participates_perspective({}, "npc"))
        self.assertFalse(entity_participates_perspective({"renderRaw": True}, "npc"))
        self.assertTrue(entity_participates_perspective(
            {"renderRaw": True, "perspectiveScaleEnabled": True}, "npc"))
        self.assertFalse(entity_participates_perspective(
            {"perspectiveScaleEnabled": False}, "npc"))
        self.assertFalse(entity_participates_perspective({}, "hotspot"))
        self.assertTrue(entity_participates_perspective(
            {"perspectiveScaleEnabled": True}, "hotspot"))

    def test_entity_factor(self) -> None:
        npc = {"x": 0, "y": 300}
        self.assertAlmostEqual(entity_perspective_factor(VERT, npc, "npc"), 0.75, places=6)
        # foot 覆盖（巡逻瞬时位置）：斜轴需要 x,y 都传
        self.assertAlmostEqual(
            entity_perspective_factor(DIAG, {"x": 0, "y": 0}, "npc", 300, 300), 0.7, places=6)
        # 不参与 → 恒 1
        self.assertEqual(entity_perspective_factor(VERT, {"x": 0, "y": 300}, "hotspot"), 1.0)
        # 坐标非法 → 1
        self.assertEqual(entity_perspective_factor(VERT, {"x": "z", "y": 300}, "npc"), 1.0)
        self.assertTrue(math.isfinite(entity_perspective_factor(None, npc, "npc")))



# ---------------------------------------------------------------------------
# 相机跟随透视（需求清单 A3.5）——黄金数值与 src/utils/perspectiveScale.test.ts 一字不差
# ---------------------------------------------------------------------------

# 竖直轴 f: 2.0 →(0.5) 1.0 → 0.5；f(0.25)=1.5、f(0.75)=0.75
FOLLOW_AXIS = {
    "near": {"x": 0, "y": 0, "scale": 2.0},
    "far": {"x": 0, "y": 100, "scale": 0.5},
    "midStops": [{"pos": 0.5, "scale": 1.0}],
}
FOLLOW_ALL = dict(FOLLOW_AXIS, cameraFollow={"maxZoomRatio": 10})
FOLLOW_OFF_FIRST = dict(FOLLOW_AXIS, cameraFollow={"firstSegment": False, "maxZoomRatio": 10})
FOLLOW_OFF_SECOND = dict(
    FOLLOW_AXIS,
    midStops=[{"pos": 0.5, "scale": 1.0, "cameraFollow": False}],
    cameraFollow={"maxZoomRatio": 10},
)
FOLLOW_REF_MID = dict(FOLLOW_AXIS, cameraFollow={"refPos": 0.5, "maxZoomRatio": 10})
FOLLOW_CLAMPED = dict(FOLLOW_AXIS, cameraFollow={})

# (cfg, foot_x, foot_y, 期望 zoom 倍数)
FOLLOW_GOLDEN = [
    (FOLLOW_ALL, 0, 0, 1.0),
    (FOLLOW_ALL, 0, 25, 4 / 3),
    (FOLLOW_ALL, 0, 50, 2.0),
    (FOLLOW_ALL, 0, 75, 8 / 3),
    (FOLLOW_ALL, 0, 100, 4.0),
    (FOLLOW_ALL, 0, -50, 1.0),
    (FOLLOW_ALL, 0, 500, 4.0),
    (FOLLOW_OFF_FIRST, 0, 25, 1.0),
    (FOLLOW_OFF_FIRST, 0, 50, 1.0),
    (FOLLOW_OFF_FIRST, 0, 75, 4 / 3),
    (FOLLOW_OFF_FIRST, 0, 100, 2.0),
    (FOLLOW_OFF_SECOND, 0, 25, 4 / 3),
    (FOLLOW_OFF_SECOND, 0, 50, 2.0),
    (FOLLOW_OFF_SECOND, 0, 75, 2.0),
    (FOLLOW_OFF_SECOND, 0, 100, 2.0),
    (FOLLOW_REF_MID, 0, 0, 0.5),
    (FOLLOW_REF_MID, 0, 50, 1.0),
    (FOLLOW_REF_MID, 0, 100, 2.0),
    (FOLLOW_CLAMPED, 0, 25, 4 / 3),
    (FOLLOW_CLAMPED, 0, 50, 1.5),
    (FOLLOW_CLAMPED, 0, 100, 1.5),
]


class CameraFollowParityTest(unittest.TestCase):
    def test_golden(self) -> None:
        for cfg, fx, fy, want in FOLLOW_GOLDEN:
            with self.subTest(cfg=cfg, foot=(fx, fy)):
                self.assertAlmostEqual(
                    perspective_camera_zoom_ratio_at(cfg, fx, fy), want, places=6)

    def test_no_key_means_no_follow(self) -> None:
        """不写 cameraFollow 键 = 不跟随（运行时一次 zoom 都不多写）。"""
        for cfg in (VERT, MID, FOLLOW_AXIS, None, {"cameraFollow": "x"}):
            self.assertIsNone(perspective_camera_follow_info(cfg))
            self.assertEqual(perspective_camera_zoom_ratio_at(cfg, 0, 50), 1.0)

    def test_degenerate_axis_with_key(self) -> None:
        self.assertIsNone(perspective_camera_follow_info(dict(DEGEN, cameraFollow={})))
        self.assertIsNone(perspective_camera_follow_info(
            {"near": VERT["near"], "cameraFollow": {}}))

    def test_info_fields(self) -> None:
        info = perspective_camera_follow_info(FOLLOW_CLAMPED)
        self.assertAlmostEqual(info["raw_ratio_at_far"], 4.0, places=6)
        self.assertAlmostEqual(info["max_zoom_ratio"], 1.5, places=6)
        self.assertEqual(info["ref_pos"], 0.0)
        segs = info["segments"]
        self.assertEqual([(s["from_pos"], s["to_pos"]) for s in segs], [(0.0, 0.5), (0.5, 1.0)])
        self.assertEqual([s["follow"] for s in segs], [True, True])
        self.assertAlmostEqual(segs[0]["ratio_at_to"], 2.0, places=6)
        self.assertAlmostEqual(segs[1]["ratio_at_to"], 4.0, places=6)
        off = perspective_camera_follow_info(FOLLOW_OFF_SECOND)
        self.assertEqual([s["follow"] for s in off["segments"]], [True, False])
        self.assertAlmostEqual(off["raw_ratio_at_far"], 2.0, places=6)

    def test_midstops_order_immunity(self) -> None:
        """开关挂在停靠点上 ⇒ midStops 乱序结果不变（独立段数组会静默错位）。"""
        ordered = {
            "near": {"x": 0, "y": 0, "scale": 2.0},
            "far": {"x": 0, "y": 100, "scale": 0.5},
            "midStops": [
                {"pos": 0.25, "scale": 1.5, "cameraFollow": False},
                {"pos": 0.5, "scale": 1.0},
            ],
            "cameraFollow": {"maxZoomRatio": 10},
        }
        shuffled = dict(ordered, midStops=[ordered["midStops"][1], ordered["midStops"][0]])
        for y in (0, 10, 25, 40, 50, 75, 100):
            with self.subTest(y=y):
                self.assertAlmostEqual(
                    perspective_camera_zoom_ratio_at(shuffled, 0, y),
                    perspective_camera_zoom_ratio_at(ordered, 0, y), places=9)
        self.assertAlmostEqual(perspective_camera_zoom_ratio_at(ordered, 0, 25), 4 / 3, places=6)
        self.assertAlmostEqual(perspective_camera_zoom_ratio_at(ordered, 0, 50), 4 / 3, places=6)
        self.assertAlmostEqual(perspective_camera_zoom_ratio_at(ordered, 0, 100), 8 / 3, places=6)

    def test_position_determined_not_direction(self) -> None:
        """正走反走同一点景别一样，且关闭段边界不跳变。"""
        ys = [0, 20, 49.999, 50, 50.001, 80, 100]
        fwd = [perspective_camera_zoom_ratio_at(FOLLOW_OFF_SECOND, 0, y) for y in ys]
        bwd = [perspective_camera_zoom_ratio_at(FOLLOW_OFF_SECOND, 0, y) for y in reversed(ys)]
        self.assertEqual(list(reversed(bwd)), fwd)
        self.assertAlmostEqual(
            perspective_camera_zoom_ratio_at(FOLLOW_OFF_SECOND, 0, 50.001),
            perspective_camera_zoom_ratio_at(FOLLOW_OFF_SECOND, 0, 49.999), places=4)


if __name__ == "__main__":
    unittest.main()
