"""「时段表没标 daylight」的构建期闸（2026-08-18 事故的回归锁）。

事故形状：内容侧把时段表换成 `辰/午/暮/夜`，而运行时「NPC 未写 phases 时的缺省归属」
是代码里硬写的 `['day']`。`'day'` 在新表里不存在 → 白名单判定恒假 → 所有开了日夜的
场景 24 小时空无一人，**且全程没有任何报错**——条件为假就是"不显示"，
肉眼分不出是设计如此还是坏了。整条街空了将近两周才被发现。

运行时侧已改成只认 `daylight` 标记、不认任何时段 id（见 `dayTime.daylightPhaseIds`），
这里锁的是构建期那一半：没标就当面说（律 7 构建期严于运行时）。
"""
from __future__ import annotations

import unittest
from typing import Any

from tools.editor.project_model import ProjectModel
from tools.editor.validator import Issue, _validate_day_night


def _model(game_config: dict[str, Any], scenes: dict[str, Any] | None = None) -> ProjectModel:
    model = ProjectModel.__new__(ProjectModel)
    model.game_config = game_config
    model.scenes = scenes if scenes is not None else {}
    return model


_DAY_NIGHT_SCENE = {"雾津街头": {"dayNight": {"enabled": True}}}
_CHINESE_PHASES = [
    {"id": "辰", "from": "07:00"},
    {"id": "午", "from": "11:00"},
    {"id": "暮", "from": "18:00"},
    {"id": "夜", "from": "20:00"},
]


def _run(game_config: dict[str, Any], scenes: dict[str, Any] | None = None) -> list[Issue]:
    issues: list[Issue] = []
    _validate_day_night(_model(game_config, scenes), issues)
    return issues


class DaylightGateTests(unittest.TestCase):
    def test_the_2026_08_18_accident_is_caught(self) -> None:
        """换了词表、没标 daylight、且真有场景开了日夜 → 必须出警告。"""
        issues = _run({"dayNight": {"phases": _CHINESE_PHASES}}, _DAY_NIGHT_SCENE)
        self.assertEqual([i.severity for i in issues], ["warning"])
        self.assertIn("daylight", issues[0].message)
        self.assertIn("雾津街头", issues[0].message)

    def test_marked_table_is_silent(self) -> None:
        marked = [dict(p, daylight=True) if p["id"] in ("辰", "午") else p for p in _CHINESE_PHASES]
        self.assertEqual(_run({"dayNight": {"phases": marked}}, _DAY_NIGHT_SCENE), [])

    def test_no_day_night_scene_means_no_complaint(self) -> None:
        """没有场景开日夜时整套时段过滤都不生效，标不标都无所谓——别制造噪音警告。"""
        self.assertEqual(_run({"dayNight": {"phases": _CHINESE_PHASES}}, {}), [])
        self.assertEqual(
            _run({"dayNight": {"phases": _CHINESE_PHASES}}, {"义庄": {"dayNight": {}}}), []
        )

    def test_unconfigured_table_falls_back_to_builtin_mark(self) -> None:
        """没配 dayNight = 用内置四段，那张表里 `day` 自带标记，不该报。"""
        self.assertEqual(_run({}, _DAY_NIGHT_SCENE), [])

    def test_non_boolean_daylight_is_an_error(self) -> None:
        """运行时按 `=== true` 判，写 "true" / 1 会被静默当成没标——按 error 拦。"""
        issues = _run(
            {"dayNight": {"phases": [{"id": "辰", "from": "07:00", "daylight": "true"}]}},
            _DAY_NIGHT_SCENE,
        )
        self.assertIn("error", [i.severity for i in issues])
        self.assertTrue(any("daylight" in i.message for i in issues))

    def test_malformed_day_night_block_is_an_error(self) -> None:
        self.assertEqual([i.severity for i in _run({"dayNight": "早上"}, _DAY_NIGHT_SCENE)], ["error"])
        self.assertEqual(
            [i.severity for i in _run({"dayNight": {"phases": "辰午暮夜"}}, _DAY_NIGHT_SCENE)],
            ["error"],
        )


if __name__ == "__main__":
    unittest.main()
