"""场景 id 准入判定（`shared/scene_ids`）—— 新老画布共用的那一份。

由来：老画布「新建场景」用「仅字母 / 数字 / 下划线 / 连字符」的正则拦 id，而工程里一大半场景是中文 id
（义庄 / 城门口 / 雾津街头 …），运行时与校验器都认。这里钉死：**只按 id 真正会变成的
东西（文件名 / 限定引用 / 命令行参数）来拒**，此外一律放行。
"""
from __future__ import annotations

import unittest

from tools.editor.shared.scene_ids import new_scene_skeleton, scene_id_problem


class AcceptsRealWorldIdsTests(unittest.TestCase):
    def test_ids_shaped_like_the_real_project_pass(self) -> None:
        for sid in ("义庄", "城隍庙夜", "梦_饭屋", "雾津街头", "临江崖墓挂壁小道",
                    "码头白天", "test_room_a", "bridge-underpass", "序章·街巷", "第2幕"):
            self.assertIsNone(scene_id_problem(sid, ()), sid)

    def test_dot_inside_is_fine(self) -> None:
        self.assertIsNone(scene_id_problem("v1.5_街", ()))


class RejectsWhatWouldBreakTests(unittest.TestCase):
    def test_empty(self) -> None:
        self.assertIsNotNone(scene_id_problem("", ()))

    def test_whitespace_anywhere(self) -> None:
        for sid in ("a b", " 义庄", "义庄 ", "a\tb", "a\nb"):
            self.assertIn("空白", scene_id_problem(sid, ()) or "", repr(sid))

    def test_path_separators(self) -> None:
        for sid in ("a/b", "a\\b", "../x"):
            # 断言到具体原因：光断"非 None"的话，一个被写成退格符的 "a\b" 也会
            # 靠控制字符那条规则混过去。
            self.assertIn("scenes/<id>.json", scene_id_problem(sid, ()) or "", repr(sid))

    def test_colon_is_reserved_for_qualified_refs(self) -> None:
        self.assertIn("sceneId:groupId", scene_id_problem("街:组", ()) or "")

    def test_windows_illegal_characters(self) -> None:
        for ch in '<>"|?*':
            self.assertIsNotNone(scene_id_problem(f"街{ch}", ()), ch)

    def test_dot_names(self) -> None:
        for sid in (".", "..", ".hidden", "trailing."):
            self.assertIsNotNone(scene_id_problem(sid, ()), sid)

    def test_control_characters(self) -> None:
        self.assertIsNotNone(scene_id_problem("a\x01b", ()))

    def test_windows_reserved_device_names(self) -> None:
        for sid in ("CON", "con", "Nul", "COM1", "lpt9", "con.backup"):
            self.assertIsNotNone(scene_id_problem(sid, ()), sid)
        self.assertIsNone(scene_id_problem("console", ()), "只拦整词，不拦前缀")

    def test_exact_duplicate(self) -> None:
        self.assertIn("已存在", scene_id_problem("义庄", ["义庄"]) or "")

    def test_case_only_difference_counts_as_duplicate(self) -> None:
        """Windows / macOS 文件系统不分大小写：Teahouse.json 与 teahouse.json 是同一个文件。"""
        msg = scene_id_problem("Teahouse", ["teahouse"])
        self.assertIsNotNone(msg)
        self.assertIn("大小写", msg)

    def test_existing_accepts_the_scenes_dict_directly(self) -> None:
        self.assertIsNotNone(scene_id_problem("a", {"a": {}}))
        self.assertIsNone(scene_id_problem("b", {"a": {}}))


class SkeletonTests(unittest.TestCase):
    def test_skeleton_is_the_old_canvas_shape(self) -> None:
        sk = new_scene_skeleton("义庄二", "")
        self.assertEqual(sk["id"], "义庄二")
        self.assertEqual(sk["name"], "义庄二", "留空显示名要回落到 id")
        self.assertEqual(sk["worldWidth"], 0)
        self.assertEqual(sk["worldHeight"], 0)
        self.assertEqual(sk["backgrounds"], [])
        self.assertEqual(sk["spawnPoint"], {"x": 400.0, "y": 400.0})
        for key in ("hotspots", "npcs", "zones"):
            self.assertEqual(sk[key], [])

    def test_skeleton_keeps_explicit_name(self) -> None:
        self.assertEqual(new_scene_skeleton("x", " 义庄 ")["name"], "义庄")

    def test_each_call_returns_a_fresh_object(self) -> None:
        a, b = new_scene_skeleton("x"), new_scene_skeleton("x")
        self.assertIsNot(a, b)
        self.assertIsNot(a["hotspots"], b["hotspots"])
