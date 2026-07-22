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


if __name__ == "__main__":
    unittest.main()
