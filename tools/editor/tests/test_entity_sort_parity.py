"""实体 z 序规则的跨语言 parity 锁。

``tools/editor/shared/entity_sort_math.py`` ↔ ``src/rendering/entitySortRule.ts``
是手工镜像 —— 本文件与 ``src/rendering/entitySortRule.test.ts`` 钉死**同一组黄金数值**，
任一侧漂移即红（norms 第 8 条：手工镜像必配语义级 parity；注释写"同口径"不算护栏）。

新增/修改用例时必须同步改两个文件（黄金常量一字不差）。

## 这条规则为什么值得单独上锁

它决定"玩家走过去时挡不挡得住那口井"，是玩家唯一能直接看见的排序结果。抽出来之前
运行时侧**一个测试都没有**，而编辑器画布用的是一张写死的固定层表（NPC 精灵恒 z=-10、
热点展示图恒 z=-4），两边算的根本不是一回事 —— 编辑器里 NPC 永远被热点贴图压住，
策划照着画布排前后关系等于白排。这类"看着对、跑起来不对"的偏差没有任何东西会报错，
只能靠双侧同值用例钉住。
"""
from __future__ import annotations

import math
import re
import unittest
from pathlib import Path

from tools.editor.shared.entity_sort_math import (
    ENTITY_SORT_BAND,
    anchor_collision_polygon_to_world,
    entity_sort_z,
    hotspot_collision_polygon_to_world,
    hotspot_sort_band_of,
    is_valid_zone_polygon,
    npc_sort_band_of,
    point_polygon_vertical_side,
    resolve_entity_sort_band,
    sort_foot_y_of,
)
from tools.editor.shared.entity_transform_math import quad_ground_y_around_foot

REPO = Path(__file__).resolve().parents[3]

# ---- 黄金用例（与 entitySortRule.test.ts 完全一致；改一处必改两处） ----

#: 横跨 x∈[100,200]、y∈[300,400] 的四边形碰撞面
GOLDEN_POLY = [
    {"x": 100, "y": 300},
    {"x": 200, "y": 300},
    {"x": 200, "y": 400},
    {"x": 100, "y": 400},
]

#: (说明, band, y, sort_foot_y, occlusion_polygon, player_foot, 期望 band, 期望 z)
GOLDEN_CASES = [
    # —— 无档位：纯按脚底 y ——
    ("裸实体：z 就是 y", None, 250, None, None, None, None, 250),
    ("裸实体：y 可为负", None, -40, None, None, None, None, -40),
    ("裸实体：y 为 0", None, 0, None, None, None, None, 0),

    # —— 静态档位 ——
    ("静态 back", "back", 250, None, None, None, "back", -ENTITY_SORT_BAND + 250),
    ("静态 front", "front", 250, None, None, None, "front", ENTITY_SORT_BAND + 250),

    # —— sortFootY 覆盖 y（?? 是 nullish：0 也算有效值）——
    ("sortFootY 覆盖 y", None, 250, 377, None, None, None, 377),
    ("sortFootY 为 0 仍生效（不是 falsy 回落）", None, 250, 0, None, None, None, 0),
    ("sortFootY 与 band 叠加", "back", 250, 377, None, None, "back", -ENTITY_SORT_BAND + 377),

    # —— 动态遮挡带：参照点在面下方（更近）→ 物件排到它后面 ——
    ("遮挡：玩家在面下方 → back", None, 350, None, GOLDEN_POLY, (150, 500), "back", -ENTITY_SORT_BAND + 350),
    # —— 参照点在面上方（更远）或站在面上 → 物件排到它前面 ——
    ("遮挡：玩家在面上方 → front", None, 350, None, GOLDEN_POLY, (150, 200), "front", ENTITY_SORT_BAND + 350),
    ("遮挡：玩家站在面上 → front", None, 350, None, GOLDEN_POLY, (150, 350), "front", ENTITY_SORT_BAND + 350),

    # —— 动态覆盖静态 ——
    ("遮挡覆盖静态 front → back", "front", 350, None, GOLDEN_POLY, (150, 500), "back", -ENTITY_SORT_BAND + 350),
    ("遮挡覆盖静态 back → front", "back", 350, None, GOLDEN_POLY, (150, 200), "front", ENTITY_SORT_BAND + 350),

    # —— side is None：参照点 x 在多边形水平跨度之外 → **保留静态档位，不覆盖** ——
    ("跨度外：保留静态 back", "back", 350, None, GOLDEN_POLY, (900, 500), "back", -ENTITY_SORT_BAND + 350),
    ("跨度外：无静态档位则仍无档位", None, 350, None, GOLDEN_POLY, (900, 500), None, 350),

    # —— 没有参照点（编辑器未放探针 / 运行时装配期）：完全不看多边形 ——
    ("无玩家：遮挡多边形不生效", "front", 350, None, GOLDEN_POLY, None, "front", ENTITY_SORT_BAND + 350),

    # —— 退化多边形：点数 < 3 不参与 ——
    ("多边形只有两点：不参与", None, 350, None, [{"x": 100, "y": 300}, {"x": 200, "y": 300}], (150, 500), None, 350),
    ("多边形为空：不参与", None, 350, None, [], (150, 500), None, 350),
]


class EntitySortGoldenParityTests(unittest.TestCase):
    """与 TS 侧同值同序的黄金用例。"""

    def test_golden_cases(self) -> None:
        for (name, band, y, foot, poly, player, want_band, want_z) in GOLDEN_CASES:
            with self.subTest(name):
                self.assertEqual(
                    resolve_entity_sort_band(band, poly, player), want_band,
                    f"{name}：band 判定与 TS 不一致")
                self.assertEqual(
                    entity_sort_z(band, y, foot, poly, player), want_z,
                    f"{name}：z 与 TS 不一致")

    def test_bands_never_overlap(self) -> None:
        """三档区间绝不重叠（世界高度上限按 100000 取，远大于任何真实场景）。"""
        h = 100_000
        self.assertLess(entity_sort_z("back", h), entity_sort_z(None, -h))
        self.assertLess(entity_sort_z(None, h), entity_sort_z("front", -h))


class VerticalSideMirrorTests(unittest.TestCase):
    """``pointPolygonVerticalSide`` 的四态语义（None 是有语义的第四态）。"""

    def test_four_states(self) -> None:
        self.assertEqual(point_polygon_vertical_side(GOLDEN_POLY, 150, 200), "above")
        self.assertEqual(point_polygon_vertical_side(GOLDEN_POLY, 150, 500), "below")
        self.assertEqual(point_polygon_vertical_side(GOLDEN_POLY, 150, 350), "inside")
        self.assertIsNone(point_polygon_vertical_side(GOLDEN_POLY, 900, 350))

    def test_degenerate(self) -> None:
        self.assertIsNone(point_polygon_vertical_side([], 0, 0))
        self.assertIsNone(point_polygon_vertical_side(GOLDEN_POLY[:2], 150, 350))

    def test_edge_x_is_inclusive(self) -> None:
        """含端点判定（``<=``）：正好站在多边形左右边界上也算命中。"""
        self.assertIsNotNone(point_polygon_vertical_side(GOLDEN_POLY, 100, 350))
        self.assertIsNotNone(point_polygon_vertical_side(GOLDEN_POLY, 200, 350))


class ZonePolygonValidityTests(unittest.TestCase):
    def test_rejects_short_and_nonfinite(self) -> None:
        self.assertTrue(is_valid_zone_polygon(GOLDEN_POLY))
        self.assertFalse(is_valid_zone_polygon(GOLDEN_POLY[:2]))
        self.assertFalse(is_valid_zone_polygon(None))
        self.assertFalse(is_valid_zone_polygon(
            [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 0, "y": float("nan")}]))

    def test_rejects_non_numeric(self) -> None:
        """TS 侧 ``typeof p.x !== 'number'`` 拒绝字符串；Python 侧还要额外拦 bool。"""
        self.assertFalse(is_valid_zone_polygon(
            [{"x": "0", "y": 0}, {"x": 1, "y": 0}, {"x": 0, "y": 1}]))
        self.assertFalse(is_valid_zone_polygon(
            [{"x": True, "y": 0}, {"x": 1, "y": 0}, {"x": 0, "y": 1}]))


class CollisionPolygonToWorldTests(unittest.TestCase):
    """``anchorCollisionPolygonToWorld`` 的两种 authored 坐标系 × 透视系数。"""

    def test_local_authored_no_transform(self) -> None:
        d = {"x": 10, "y": 20, "collisionPolygonLocal": True,
             "collisionPolygon": [{"x": -5, "y": -5}, {"x": 5, "y": -5}, {"x": 0, "y": 5}]}
        got = hotspot_collision_polygon_to_world(d)
        self.assertEqual(got, [{"x": 5.0, "y": 15.0}, {"x": 15.0, "y": 15.0}, {"x": 10.0, "y": 25.0}])

    def test_world_authored_no_transform_is_passthrough(self) -> None:
        poly = [{"x": 1, "y": 2}, {"x": 3, "y": 4}, {"x": 5, "y": 6}]
        d = {"x": 10, "y": 20, "collisionPolygon": poly}
        self.assertEqual(hotspot_collision_polygon_to_world(d), poly)

    def test_extra_scale_expands_around_anchor(self) -> None:
        """透视系数绕锚点等比放大 —— 判遮挡带必须用这一份，不是 authored 那份。"""
        d = {"x": 0, "y": 0, "collisionPolygonLocal": True,
             "collisionPolygon": [{"x": -10, "y": -10}, {"x": 10, "y": -10}, {"x": 0, "y": 10}]}
        got = anchor_collision_polygon_to_world(0, 0, d, 2.0)
        self.assertEqual(got, [{"x": -20.0, "y": -20.0}, {"x": 20.0, "y": -20.0}, {"x": 0.0, "y": 20.0}])

    def test_invalid_polygon_returns_none(self) -> None:
        self.assertIsNone(hotspot_collision_polygon_to_world({"x": 0, "y": 0}))
        self.assertIsNone(hotspot_collision_polygon_to_world(
            {"x": 0, "y": 0, "collisionPolygon": [{"x": 0, "y": 0}]}))


class BandDerivationAsymmetryTests(unittest.TestCase):
    """热点与 NPC 的档位派生**刻意不对称** —— 抹平即与运行时不一致。"""

    def _hs(self, **di) -> dict:
        base = {"image": "a.png", "worldWidth": 10, "worldHeight": 20, "spriteSort": "back"}
        base.update(di)
        return {"id": "h", "x": 0, "y": 0, "displayImage": base}

    def test_hotspot_requires_texture_loaded(self) -> None:
        """运行时 ``displaySprite !== null``；编辑器画紫色缺件框时两边都该没档位。"""
        self.assertEqual(hotspot_sort_band_of(self._hs(), texture_loaded=True), "back")
        self.assertIsNone(hotspot_sort_band_of(self._hs(), texture_loaded=False))

    def test_hotspot_requires_image_and_positive_size(self) -> None:
        self.assertIsNone(hotspot_sort_band_of(self._hs(image=""), texture_loaded=True))
        self.assertIsNone(hotspot_sort_band_of(self._hs(worldWidth=0), texture_loaded=True))
        self.assertIsNone(hotspot_sort_band_of(self._hs(worldHeight=0), texture_loaded=True))

    def test_hotspot_without_display_image_has_no_band(self) -> None:
        self.assertIsNone(hotspot_sort_band_of({"id": "h", "x": 0, "y": 0}, texture_loaded=True))

    def test_npc_does_not_require_sprite_loaded(self) -> None:
        """NPC 只看 def.spriteSort —— 与热点侧的不对称是运行时的真实语义。"""
        self.assertEqual(npc_sort_band_of({"spriteSort": "front"}), "front")
        self.assertEqual(npc_sort_band_of({"spriteSort": "back"}), "back")
        self.assertIsNone(npc_sort_band_of({}))
        self.assertIsNone(npc_sort_band_of({"spriteSort": "middle"}))


class SortFootYTests(unittest.TestCase):
    """``entitySortFootY`` 只在旋转态存在，否则回落锚点 y。"""

    def test_no_rotation_returns_none(self) -> None:
        self.assertIsNone(sort_foot_y_of({"y": 100}, 10, 20))
        self.assertIsNone(sort_foot_y_of({"y": 100, "rotation": 0}, 10, 20))

    def test_zero_height_returns_none(self) -> None:
        """热点无展示图 / NPC 动画包缺件 → 运行时 getWorldSize()=0，退化而不是硬算。"""
        self.assertIsNone(sort_foot_y_of({"y": 100, "rotation": 30}, 10, 0))

    def test_rotated_uses_quad_ground_line(self) -> None:
        d = {"y": 100, "rotation": 30}
        want = quad_ground_y_around_foot(100, 10, 20, math.radians(30))
        self.assertEqual(sort_foot_y_of(d, 10, 20), want)
        self.assertGreater(want, 100, "旋转后 quad 的接地线应低于（y 大于）锚点")


class QuadGroundYMirrorTests(unittest.TestCase):
    """``quadGroundYAroundFoot`` 的镜像口径。"""

    def test_no_rotation_is_identity(self) -> None:
        self.assertEqual(quad_ground_y_around_foot(42.0, 10, 20, 0), 42.0)

    def test_90_degrees_half_width_below_anchor(self) -> None:
        """转 90°：底中锚 quad 的接地线落到锚点下方半个**宽**处。"""
        got = quad_ground_y_around_foot(0.0, 10, 20, math.radians(90))
        self.assertAlmostEqual(got, 5.0, places=9)


class SourceMirrorGuardTests(unittest.TestCase):
    """规则必须只有一处 —— 运行时不得再就地手写一份。"""

    def test_renderer_delegates_to_the_rule_module(self) -> None:
        src = (REPO / "src/rendering/Renderer.ts").read_text(encoding="utf-8")
        self.assertIn("entitySortZ", src, "Renderer 应调用抽出的规则函数")
        self.assertNotIn(
            "10_000_000", src,
            "Renderer 里不该再出现档位常量字面量——规则已抽到 entitySortRule.ts")

    def test_band_constant_matches_ts(self) -> None:
        ts = (REPO / "src/rendering/entitySortRule.ts").read_text(encoding="utf-8")
        m = re.search(r"ENTITY_SORT_BAND\s*=\s*([0-9_]+)", ts)
        self.assertIsNotNone(m, "entitySortRule.ts 提不到 ENTITY_SORT_BAND")
        self.assertEqual(int(m.group(1).replace("_", "")), ENTITY_SORT_BAND)


if __name__ == "__main__":
    unittest.main()
