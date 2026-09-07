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
