# -*- coding: utf-8 -*-
"""锚点可配之后:圆形物件绕圆心转,滚一圈**不再沉进地面**。

为什么要有这条:锚点可配之前,叠加旋转的支点被硬编码在脚底(精灵 anchor=(0.5,1)),
于是"滚一圈"会把物件整个压到地面线以下 —— 实测一枚 14 wu 的铜钱在半圈处
最低点低于街面 **13.99 wu**(正好一个直径),一圈沉一次,**不报任何错**。
当时只能在数据里存"脚底锚点的摆线"绕开,代价是 `roll` 通道不可用。

现在锚点可配(`NpcDef.anchor`),铜钱把锚点设到圆心即绕圆心转,路径回归直白的
地面线;深度锚由 `contact_offset_y` 推到**真实接地线**而不是圆心高度。
本用例直接拿**真实工程数据**断言,不是合成用例 —— 这条口径一旦回退,验证过场当场沉地。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

from tools.editor.tests.save_test_utils import repo_root_from_tests

SCENE_ID = "雾津街头"
COIN_ID = "npc_验证铜钱"
TRAJ_ID = "coin_drop_demo"
TOL = 1e-6


def _load_scene() -> dict | None:
    p = repo_root_from_tests() / "public" / "assets" / "scenes" / f"{SCENE_ID}.json"
    if not p.is_file():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def _load_asset() -> dict | None:
    """轨迹现在是独立资产 ``public/assets/data/trajectories/<id>.json``（帧相对锚点）。"""
    p = repo_root_from_tests() / "public" / "assets" / "data" / "trajectories" / f"{TRAJ_ID}.json"
    if not p.is_file():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


class CoinRollDoesNotSinkTests(unittest.TestCase):
    def setUp(self) -> None:
        self.scene = _load_scene()
        if self.scene is None:
            self.skipTest("缺真实场景数据")

    def _coin(self) -> dict:
        for n in self.scene.get("npcs") or []:
            if isinstance(n, dict) and n.get("id") == COIN_ID:
                return n
        self.skipTest("验证铜钱不在场景里")
        raise AssertionError

    def _traj(self) -> dict:
        asset = _load_asset()
        if asset is None:
            self.skipTest("轨迹资产不存在")
            raise AssertionError
        self.assertEqual((asset.get("authoring") or {}).get("entity"), {"kind": "npc", "id": COIN_ID},
                         "这条资产是拿验证铜钱烘的，重开现场应指回它")
        return asset

    def test_coin_anchor_is_at_its_centre(self) -> None:
        """圆心锚是"绕圆心转"的**唯一**前提;退回缺省锚点就会沉地。"""
        a = self._coin().get("anchor") or {}
        self.assertAlmostEqual(float(a.get("x", 0.5)), 0.5, places=6)
        self.assertAlmostEqual(
            float(a.get("y", 1.0)), 0.5, places=6,
            msg="铜钱需圆心锚(y=0.5);缺省底中会让滚动沉地",
        )

    def test_lowest_point_never_below_the_contact_line(self) -> None:
        """逐帧:最低点 = 圆心 y + 半径×scaleY,不许低于该帧深度锚(接地线)。

        帧是相对锚点的偏移，y 与 sortY 同减一个锚点 y，不等式不变。"""
        coin, traj = self._coin(), self._traj()
        di = coin.get("displayImage") or {}
        radius = float(di.get("worldHeight", 0)) / 2.0
        self.assertGreater(radius, 0, "铜钱得有世界尺寸")
        worst = None
        for kf in traj.get("keyframes") or []:
            y = float(kf.get("y", 0))
            sy = float(kf.get("sortY", y))
            scale = kf.get("scaleY", kf.get("scale", 1))
            lowest = y + radius * float(scale)
            slack = sy - lowest
            if worst is None or slack < worst[0]:
                worst = (slack, kf.get("atMs"), lowest, sy)
        self.assertIsNotNone(worst, "轨迹得有关键帧")
        slack, at_ms, lowest, sy = worst
        self.assertGreaterEqual(
            slack, -TOL,
            msg=(f"atMs={at_ms} 处沉地 {-slack:.3f} wu"
                 f"(最低点 {lowest:.3f} > 接地线 {sy:.3f})"),
        )

    def test_rolling_segment_uses_the_roll_channel_not_a_cycloid(self) -> None:
        """滚动靠 `roll` 通道 + 直白地面路径 —— 摆线补偿路径是旧绕法,回退即信号。"""
        segs = ((self._traj().get("source") or {}).get("segments")) or []
        roll_segs = [s for s in segs if isinstance(s, dict) and s.get("roll")]
        self.assertTrue(roll_segs, "应有至少一段走 roll 通道")
        for s in roll_segs:
            self.assertNotIn(
                "rotation", s.get("tracks") or {},
                "roll 段不应再手写 rotation 轨(那是补偿路径的遗迹)",
            )


if __name__ == "__main__":
    unittest.main()
