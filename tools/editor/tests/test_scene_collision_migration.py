"""碰撞多边形的加载期归一 —— "两种坐标系"只准存在于这一处。

`collisionPolygon` 早期是世界坐标，后来改成相对锚点的局部坐标 + `collisionPolygonLocal`
标记。老画布的做法是**在每个读点写一个兼容分支**（热点一处、NPC 一处、整组平移一处），
于是"这份是局部还是世界"变成了所有消费者都必须每次记得判断的事 —— 判错就是**静默的
错位**：画面看着对、命中面偏了。

改成加载期一次性归一后，下游可以无条件当局部坐标用。本文件锁三件事：
1. 归一是**语义无损**的（迁移前后运行时算出的世界多边形逐点相同）；
2. **热点与 NPC 都迁**（旧实现只迁热点，这正是 NPC 那条分支活到今天的原因）；
3. 幂等（重复加载安全）。
"""
from __future__ import annotations

import json
import glob
import math
import unittest
from pathlib import Path

from tools.editor.shared.entity_sort_math import anchor_collision_polygon_to_world
from tools.editor.shared.scene_migrations import (
    COLLISION_OWNER_KEYS,
    collision_polygon_world_to_local,
    legacy_world_authored_to_local,
    migrate_scene_collision_to_local,
)

REPO = Path(__file__).resolve().parents[3]


def _world_poly(ent: dict) -> list[dict]:
    """运行时口径算出的世界多边形（迁移前后必须逐点相同）。"""
    return anchor_collision_polygon_to_world(
        float(ent.get("x", 0)), float(ent.get("y", 0)), ent, 1.0) or []


class MigrationIsLosslessTests(unittest.TestCase):
    """迁移不许改变运行时看到的命中面。"""

    def _roundtrip(self, ent: dict) -> None:
        before = _world_poly(ent)
        self.assertTrue(before, "前置条件：迁移前应当能算出世界多边形")
        changed = migrate_scene_collision_to_local({"hotspots": [ent]})
        self.assertTrue(changed, "世界坐标数据应当被迁移")
        self.assertIs(ent["collisionPolygonLocal"], True)
        after = _world_poly(ent)
        self.assertEqual(len(before), len(after))
        for b, a in zip(before, after):
            # 局部坐标写回时按 0.1 取整，故容差取 0.1 量级
            self.assertAlmostEqual(b["x"], a["x"], delta=0.15)
            self.assertAlmostEqual(b["y"], a["y"], delta=0.15)

    def test_plain_entity(self) -> None:
        self._roundtrip({
            "id": "h", "x": 100, "y": 200,
            "collisionPolygon": [{"x": 80, "y": 190}, {"x": 120, "y": 190}, {"x": 100, "y": 220}],
        })

    def test_scaled_entity(self) -> None:
        self._roundtrip({
            "id": "h", "x": 100, "y": 200, "scale": 2.0,
            "collisionPolygon": [{"x": 80, "y": 190}, {"x": 120, "y": 190}, {"x": 100, "y": 220}],
        })

    def test_rotated_entity(self) -> None:
        """变换态下写回的必须是**干净的未变换局部坐标**，不是"看着对"的近似。"""
        self._roundtrip({
            "id": "h", "x": 100, "y": 200, "rotation": 37.0,
            "collisionPolygon": [{"x": 80, "y": 190}, {"x": 120, "y": 190}, {"x": 100, "y": 220}],
        })

    def test_scaled_and_rotated(self) -> None:
        self._roundtrip({
            "id": "h", "x": -40, "y": 15, "scale": 0.6, "rotation": -120.0,
            "collisionPolygon": [{"x": -60, "y": 5}, {"x": -20, "y": 5}, {"x": -40, "y": 35}],
        })


class MigrationCoversEveryFamilyTests(unittest.TestCase):
    """热点与 NPC 都要迁 —— 旧实现只迁热点，NPC 的兼容分支因此活了很久。"""

    def test_both_families_migrate(self) -> None:
        sc = {
            "hotspots": [{"id": "h", "x": 0, "y": 0,
                          "collisionPolygon": [{"x": -5, "y": -5}, {"x": 5, "y": -5}, {"x": 0, "y": 5}]}],
            "npcs": [{"id": "n", "x": 10, "y": 10,
                      "collisionPolygon": [{"x": 5, "y": 5}, {"x": 15, "y": 5}, {"x": 10, "y": 15}]}],
        }
        self.assertTrue(migrate_scene_collision_to_local(sc))
        self.assertIs(sc["hotspots"][0]["collisionPolygonLocal"], True)
        self.assertIs(sc["npcs"][0]["collisionPolygonLocal"], True,
                      "NPC 没被迁 —— 这正是老实现漏掉的那一族")

    def test_owner_keys_match_scene_shape(self) -> None:
        """清单只有一份：加新的带碰撞面实体族时，这条断言会提醒你改迁移表。"""
        self.assertEqual(set(COLLISION_OWNER_KEYS), {"hotspots", "npcs"})


class MigrationIsIdempotentTests(unittest.TestCase):
    def test_second_run_is_a_noop(self) -> None:
        sc = {"hotspots": [{"id": "h", "x": 0, "y": 0,
                            "collisionPolygon": [{"x": 1, "y": 2}, {"x": 3, "y": 4}, {"x": 5, "y": 6}]}]}
        self.assertTrue(migrate_scene_collision_to_local(sc))
        snapshot = json.dumps(sc, sort_keys=True)
        self.assertFalse(migrate_scene_collision_to_local(sc), "第二次不该再报改动")
        self.assertEqual(json.dumps(sc, sort_keys=True), snapshot, "幂等被破坏")

    def test_degenerate_polygon_untouched(self) -> None:
        """点数 <3 是"没有碰撞面"，不是"坐标系不对"，不许打标。"""
        sc = {"npcs": [{"id": "n", "x": 0, "y": 0, "collisionPolygon": [{"x": 1, "y": 1}]}]}
        self.assertFalse(migrate_scene_collision_to_local(sc))
        self.assertNotIn("collisionPolygonLocal", sc["npcs"][0])


class RealProjectDataIsAlreadyLocalTests(unittest.TestCase):
    """真实工程数据的现状锁：全部已是局部坐标。

    这条如果红了，说明有人（或某个 AI 生成的数据）又写进了世界坐标形状 ——
    加载期会把它迁掉，但**磁盘上那份仍是旧形状**，值得当场知道。
    """

    def test_no_world_space_collision_left_on_disk(self) -> None:
        offenders: list[str] = []
        for path in sorted(glob.glob(str(REPO / "public/assets/scenes/*.json"))):
            sc = json.loads(Path(path).read_text(encoding="utf-8"))
            for key in COLLISION_OWNER_KEYS:
                for ent in sc.get(key) or []:
                    if not isinstance(ent, dict):
                        continue
                    poly = ent.get("collisionPolygon")
                    if isinstance(poly, list) and len(poly) >= 3 \
                            and ent.get("collisionPolygonLocal") is not True:
                        offenders.append(f"{Path(path).name}:{key}:{ent.get('id')}")
        self.assertEqual(offenders, [], f"磁盘上仍有世界坐标碰撞面：{offenders}")


class TwoConversionsMustNotBeMergedTests(unittest.TestCase):
    """world→local 有**两个**，用错是静默错位。这条防止后人"顺手合并"。

    - 拖拽写回：输入是画布上的点（已含实例 transform）→ 必须**反变换**
    - 旧数据迁移：输入是 transform **之前**的 authored 点 → 必须**纯平移**

    老实现用反变换去做迁移，一个 `scale: 2` 的实体命中面会被缩小一半，而画面
    完全看不出来。库里恰好没有这种数据，所以这个 bug 从来没被触发过。
    """

    ENT = {"x": 100, "y": 100, "scale": 2.0}
    PT = [{"x": 110, "y": 100}]

    def test_the_two_conversions_disagree_under_transform(self) -> None:
        drag = collision_polygon_world_to_local(self.ENT, self.PT)
        legacy = legacy_world_authored_to_local(self.ENT, self.PT)
        self.assertEqual(legacy, [{"x": 10.0, "y": 0.0}], "迁移必须是纯平移")
        self.assertEqual(drag, [{"x": 5.0, "y": 0.0}], "拖拽写回必须反变换（除以 scale）")
        self.assertNotEqual(drag, legacy, "两者在变换态下必须不同，否则说明被合并了")

    def test_they_agree_when_there_is_no_transform(self) -> None:
        """无变换时两者恰好相同 —— 这正是这个 bug 能长期潜伏的原因。"""
        plain = {"x": 100, "y": 100}
        self.assertEqual(
            collision_polygon_world_to_local(plain, self.PT),
            legacy_world_authored_to_local(plain, self.PT))

    def test_migration_uses_the_translation_one(self) -> None:
        ent = dict(self.ENT, id="h",
                   collisionPolygon=[{"x": 110, "y": 100}, {"x": 90, "y": 100}, {"x": 100, "y": 120}])
        migrate_scene_collision_to_local({"hotspots": [ent]})
        self.assertEqual(ent["collisionPolygon"][0], {"x": 10.0, "y": 0.0},
                         "迁移用错了转换（用了反变换），命中面会被缩放系数吃掉")


class SharedMathIsNotDuplicatedTests(unittest.TestCase):
    """world→local 的数学只准有一份。"""

    def test_scene_editor_reuses_the_shared_helper(self) -> None:
        from tools.editor.editors import scene_editor as se
        self.assertIs(
            se._hotspot_collision_world_to_local, collision_polygon_world_to_local,
            "scene_editor 又长出了第二份 world→local 实现")
        self.assertIs(
            se._migrate_scene_hotspot_collision_to_local, migrate_scene_collision_to_local,
            "scene_editor 又长出了第二份迁移实现")


class InverseIsExactForCleanInputTests(unittest.TestCase):
    """无变换时 world→local 就是纯平移，不该引入任何漂移。"""

    def test_no_transform_is_pure_translation(self) -> None:
        ent = {"x": 30, "y": -12}
        got = collision_polygon_world_to_local(
            ent, [{"x": 40, "y": -2}, {"x": 20, "y": -22}])
        self.assertEqual(got, [{"x": 10.0, "y": 10.0}, {"x": -10.0, "y": -10.0}])

    def test_rotation_is_inverted_not_applied(self) -> None:
        """转 90° 的实体：世界上正右方的点，局部应当在正上方（-y），不是正右。"""
        ent = {"x": 0, "y": 0, "rotation": 90.0}
        got = collision_polygon_world_to_local(ent, [{"x": 0, "y": 10}])
        self.assertAlmostEqual(got[0]["x"], 10.0, delta=0.05)
        self.assertAlmostEqual(got[0]["y"], 0.0, delta=0.05)
        self.assertFalse(math.isnan(got[0]["x"]))


if __name__ == "__main__":
    unittest.main()
