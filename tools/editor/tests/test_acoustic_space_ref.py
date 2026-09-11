# -*- coding: utf-8 -*-
"""场景 acousticSpace → acoustic_spaces.json 的引用校验。

为什么必须有这道门（2026-09-07 补）：这层引用**运行时不报错、不回落**，
写错一个字只是这个场景彻底没有回音，而在此之前六道收尾门一个都查不到它
（`grep acousticSpace tools/ scripts/ schemas` 零命中）。属于典型的
「通道外的写法运行时被静默跳过」。

判据用**线上全集**，不是手写样例：现网每个写了 acousticSpace 的场景都必须命中。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SPACES = REPO / "public" / "assets" / "data" / "acoustic_spaces.json"
SCENES = REPO / "public" / "assets" / "scenes"


def _space_ids() -> set[str]:
    if not SPACES.exists():
        return set()
    data = json.loads(SPACES.read_text(encoding="utf-8"))
    spaces = data.get("spaces")
    return {str(k) for k in spaces} if isinstance(spaces, dict) else set()


class AcousticSpaceRefTests(unittest.TestCase):
    def test_spaces_file_parses_and_has_entries(self) -> None:
        self.assertTrue(SPACES.exists(), f"缺文件: {SPACES}")
        ids = _space_ids()
        self.assertGreater(len(ids), 0, "acoustic_spaces.json 没有任何 spaces 条目")

    def test_every_space_has_required_shape(self) -> None:
        data = json.loads(SPACES.read_text(encoding="utf-8"))
        for name, sp in (data.get("spaces") or {}).items():
            with self.subTest(space=name):
                self.assertIn("listener", sp, "缺 listener")
                self.assertIsInstance(sp.get("reflectors"), list, "reflectors 须为数组")
                self.assertGreater(len(sp["reflectors"]), 0, "至少要有一个反射面")
                for i, r in enumerate(sp["reflectors"]):
                    self.assertEqual(len(r.get("a", [])), 2, f"reflectors[{i}].a 须为二元组")
                    self.assertEqual(len(r.get("b", [])), 2, f"reflectors[{i}].b 须为二元组")
                    self.assertGreater(float(r.get("height", 0)), 0, f"reflectors[{i}].height 须为正")
                    for k in ("absorb", "rough"):
                        v = float(r.get(k, 0))
                        self.assertGreaterEqual(v, 0.0, f"reflectors[{i}].{k} 越界")
                        self.assertLessEqual(v, 1.0, f"reflectors[{i}].{k} 越界")

    def test_all_scene_references_resolve(self) -> None:
        """现网全集断言：每个写了 acousticSpace 的场景都必须命中一个已定义的空间。"""
        ids = _space_ids()
        referenced: dict[str, str] = {}
        for path in sorted(SCENES.glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            ref = data.get("acousticSpace")
            if ref is None:
                continue
            referenced[path.stem] = str(ref)
        self.assertGreater(len(referenced), 0, "没有任何场景引用声学空间，这条断言就形同虚设")
        for scene, ref in referenced.items():
            with self.subTest(scene=scene):
                self.assertTrue(str(ref).strip(), "acousticSpace 不能是空串；不用就删字段")
                self.assertIn(
                    ref, ids,
                    f"场景 {scene} 的 acousticSpace {ref!r} 不在 acoustic_spaces.json；"
                    f"运行时会安静地按无空间处理，回音整个消失",
                )

    def test_checker_warns_when_space_was_authored_in_another_scene(self) -> None:
        """强绑允许（制作人 2026-09-08），但必须让人看见：记 warning 不记 error。"""
        from tools.editor.validator import check_acoustic_space_ref as check

        spaces = {"峡谷": {"authoring": {"sceneId": "崖墓前段"}, "listener": {"x": 0, "z": 0}, "reflectors": []}}
        with self.subTest("同一场景不报"):
            self.assertEqual(check("崖墓前段", {"acousticSpace": "峡谷"}, {"峡谷"}, spaces), [])
        with self.subTest("别的场景记 warning"):
            got = check("崖墓前段1", {"acousticSpace": "峡谷"}, {"峡谷"}, spaces)
            self.assertEqual(len(got), 1)
            self.assertEqual(got[0].severity, "warning")
            self.assertIn("崖墓前段", got[0].message)
        with self.subTest("没给定义时不查（兼容旧调用）"):
            self.assertEqual(check("崖墓前段1", {"acousticSpace": "峡谷"}, {"峡谷"}), [])

    def test_defs_checker_catches_v1_leftovers_and_bad_scale(self) -> None:
        """v1 残留 = 两套坐标系并存，距离整体错 88 倍而不报错 —— 必须是 error。"""
        from tools.editor.validator import check_acoustic_space_defs as check

        good = {"a": {"authoring": {"sceneId": "s1"}, "distanceScale": 12, "listener": {"x": 0, "z": 0}, "reflectors": []}}
        self.assertEqual(check(good, {"s1"}), [])
        got = check({"a": {**good["a"], "anchor": {"x": 0, "y": 0}, "wuPerMeter": 88}}, {"s1"})
        self.assertEqual([g.severity for g in got], ["error", "error"])
        got = check({"a": {**good["a"], "distanceScale": 0}}, {"s1"})
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0].severity, "error")
        got = check({"a": {**good["a"], "authoring": {"sceneId": "不存在"}}}, {"s1"})
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0].severity, "warning")

    def test_defs_checker_validates_v3_sources_and_binding(self) -> None:
        """v3：听者绑定 mode 非法 / entity 缺 entityId 记 error；sources 缺 id、id 重复、缺 x/z 记 error；v2 单个 source 残留记 warning。"""
        from tools.editor.validator import check_acoustic_space_defs as check

        base = {"authoring": {"sceneId": "s1"}, "distanceScale": 1, "listener": {"x": 0, "z": 0}, "reflectors": []}
        ok = {"a": {**base, "listenerBinding": {"mode": "entity", "entityId": "npc1"},
                    "sources": [{"id": "s", "x": 1, "z": 2}], "direct": {"refDistanceM": 7}}}
        self.assertEqual(check(ok, {"s1"}), [])
        got = check({"a": {**base, "listenerBinding": {"mode": "npc"}}}, {"s1"})
        self.assertEqual([g.severity for g in got], ["error"])
        got = check({"a": {**base, "listenerBinding": {"mode": "entity"}}}, {"s1"})
        self.assertEqual([g.severity for g in got], ["warning"])   # 运行时回落玩家，不是坏数据
        got = check({"a": {**base, "sources": [{"id": "s", "x": 1, "z": 2}, {"id": "s", "x": 3, "z": 4}, {"x": 1}]}}, {"s1"})
        self.assertEqual(sorted(g.severity for g in got), ["error", "error"])
        got = check({"a": {**base, "source": {"x": 1, "z": 2}}}, {"s1"})
        self.assertEqual([g.severity for g in got], ["warning"])

    def test_defs_checker_accepts_shipped_library(self) -> None:
        """现网那份库必须是干净的 v2。"""
        from tools.editor.validator import check_acoustic_space_defs as check

        data = json.loads(SPACES.read_text(encoding="utf-8"))
        scene_ids = {p.stem for p in SCENES.glob("*.json")}
        got = [g for g in check(data.get("spaces") or {}, scene_ids) if g.severity == "error"]
        self.assertEqual(got, [], [g.message for g in got])

    def test_checker_flags_unknown_reference(self) -> None:
        """校验器必须真能抓到打错的键 —— **抓不到的门等于没有**。

        检查抽成了纯函数 `check_acoustic_space_ref`，正是为了让这条断言成立：
        用整个 validate() 去测要一个完整 ProjectModel，测不动就只能 skip，
        而 skip 掉的恰恰是这道门唯一的价值。
        """
        from tools.editor.validator import check_acoustic_space_ref as check

        ids = {"山谷_大", "棺龛墙"}

        with self.subTest("正确的键不报"):
            self.assertEqual(check("s", {"acousticSpace": "山谷_大"}, ids), [])
        with self.subTest("没写字段不报"):
            self.assertEqual(check("s", {}, ids), [])

        with self.subTest("打错字必须报 error"):
            got = check("s", {"acousticSpace": "山谷_打错了"}, ids)
            self.assertEqual(len(got), 1)
            self.assertEqual(got[0].severity, "error")
            self.assertIn("山谷_打错了", got[0].message)
            # 报错要写清后果，否则看的人不知道为什么这是 error
            self.assertIn("回音", got[0].message)

        with self.subTest("空字符串必须报"):
            got = check("s", {"acousticSpace": "   "}, ids)
            self.assertEqual(len(got), 1)
            self.assertEqual(got[0].severity, "error")

        with self.subTest("库为空时不能默默放过"):
            got = check("s", {"acousticSpace": "山谷_大"}, set())
            self.assertEqual(len(got), 1)
            self.assertEqual(got[0].severity, "error")

    def test_checker_validates_listener_binding(self) -> None:
        """听者绑定也要拦：mode 非法、entity 缺 id —— 后者运行时会静默回落到玩家。"""
        from tools.editor.validator import check_acoustic_space_ref as check

        ids = {"山谷_大"}
        with self.subTest("合法 mode 不报"):
            for m in ("player", "camera", "entity", "fixed"):
                scene = {"acousticListener": {"mode": m}}
                if m == "entity":
                    scene["acousticListener"]["entityId"] = "npc_a"
                self.assertEqual(check("s", scene, ids), [])
        with self.subTest("非法 mode 报 error"):
            got = check("s", {"acousticListener": {"mode": "瞎写的"}}, ids)
            self.assertEqual(len(got), 1)
            self.assertEqual(got[0].severity, "error")
        with self.subTest("entity 缺 entityId 报 error"):
            got = check("s", {"acousticListener": {"mode": "entity"}}, ids)
            self.assertEqual(len(got), 1)
            self.assertIn("静默回落", got[0].message)
        with self.subTest("entityId 不在本场景只记 warning"):
            got = check("s", {
                "npcs": [{"id": "npc_a"}],
                "acousticListener": {"mode": "entity", "entityId": "不存在"},
            }, ids)
            self.assertEqual(len(got), 1)
            self.assertEqual(got[0].severity, "warning")
        with self.subTest("两个问题同时报，不互相吞"):
            got = check("s", {
                "acousticSpace": "不存在的空间",
                "acousticListener": {"mode": "瞎写的"},
            }, ids)
            self.assertEqual(len(got), 2)

    def test_checker_validates_base_depth(self) -> None:
        """\u57fa\u51c6\u89c6\u8ddd\uff1a\u975e\u6b63\u6570\u62e6\u6b7b\uff1b\u65e0\u6d88\u8d39\u8005\u65f6\u63d0\u9192\u3002

        \u5199\u4e86 0 / \u8d1f\u6570\u8fd0\u884c\u65f6\u6309"\u6ca1\u7ed9"\u56de\u843d\u5230\u5168\u5c40 600\uff0c\u800c\u4f5c\u8005\u4ee5\u4e3a\u81ea\u5df1\u628a\u542c\u8005\u8d34\u5230\u4e86\u8138\u4e0a\u3002
        """
        from tools.editor.validator import check_acoustic_space_ref as check

        ids = {"\u5c71\u8c37_\u5927"}
        with self.subTest("camera + \u6b63\u6570\u4e0d\u62a5"):
            self.assertEqual(
                check("s", {"acousticListener": {"mode": "camera", "backAtBaseZoomWu": 900}}, ids), [])
        with self.subTest("\u914d\u4e86\u900f\u89c6\u7ebf\u65f6 player \u4e5f\u4e0d\u62a5"):
            self.assertEqual(check("s", {
                "perspectiveScale": {"near": {"x": 0, "y": 0, "scale": 1},
                                     "far": {"x": 10, "y": 10, "scale": 0.5}},
                "acousticListener": {"mode": "player", "backAtBaseZoomWu": 450},
            }, ids), [])
        for bad in (0, -5, "600", True, None):
            with self.subTest(bad=bad):
                got = check("s", {"acousticListener": {"mode": "camera",
                                                       "backAtBaseZoomWu": bad}}, ids)
                self.assertEqual(len(got), 1)
                self.assertEqual(got[0].severity, "error")
        with self.subTest("\u65e2\u4e0d\u662f camera \u53c8\u6ca1\u900f\u89c6\u7ebf \u21d2 warning"):
            got = check("s", {"acousticListener": {"mode": "player",
                                                   "backAtBaseZoomWu": 450}}, ids)
            self.assertEqual(len(got), 1)
            self.assertEqual(got[0].severity, "warning")

    def test_checker_accepts_every_shipped_reference(self) -> None:
        """把纯函数直接架到现网全集上跑一遍 —— 与 validate() 走的是同一段逻辑。"""
        from tools.editor.validator import check_acoustic_space_ref as check

        ids = _space_ids()
        for path in sorted(SCENES.glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            if data.get("acousticSpace") is None:
                continue
            with self.subTest(scene=path.stem):
                self.assertEqual(check(path.stem, data, ids), [])


if __name__ == "__main__":
    unittest.main()
