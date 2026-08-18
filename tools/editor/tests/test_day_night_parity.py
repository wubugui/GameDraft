"""日夜时段缺省清单的跨语言 parity 锁（editor-tools norms 第 8 条）。

两份手工镜像必须逐字一致，任一侧漂移即红：

- 运行时权威：`src/utils/dayTime.ts` 的 `DEFAULT_PHASES`
- 编辑器：`tools/editor/project_model.py` 的 `ProjectModel.DEFAULT_TIME_PHASES`
  （`all_time_phase_ids()` 在 game_config 未配 dayNight 时回落到它）

漏改一处的后果：策划在条件编辑器里看到的缺省时段与运行时实际分段不同——
配出来的 `{timePhase: …}` 恒假，且校验器还会放行（因为它信的是编辑器这份）。

`daylight`（「街上有人」的段）也在锁的范围内：它是未写 `phases` 的 NPC 的缺省归属，
两侧不一致时编辑器会告诉策划"龙套白天在"而运行时其实不在。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from tools.editor.project_model import ProjectModel

_DAY_TIME_TS = Path(__file__).resolve().parents[3] / "src" / "utils" / "dayTime.ts"


def _ts_default_phases(source: str) -> list[tuple[str, str, str, bool]]:
    m = re.search(
        r"export const DEFAULT_PHASES: readonly DayPhaseDef\[\] = \[(.*?)\] as const;",
        source,
        re.S,
    )
    assert m, "dayTime.ts 里找不到 DEFAULT_PHASES"
    rows = re.findall(
        r"\{\s*id:\s*'([^']+)',\s*from:\s*'([^']+)',\s*label:\s*'([^']+)'"
        r"(?:,\s*daylight:\s*(true|false))?\s*\}",
        m.group(1),
    )
    assert rows, "DEFAULT_PHASES 的条目形状变了，parity 提取正则需同步"
    return [(pid, frm, label, daylight == "true") for pid, frm, label, daylight in rows]


class DayNightPhaseParityTests(unittest.TestCase):
    def test_default_phases_match_runtime(self) -> None:
        ts_rows = _ts_default_phases(_DAY_TIME_TS.read_text(encoding="utf-8"))
        self.assertEqual(
            ts_rows,
            list(ProjectModel.DEFAULT_TIME_PHASES),
            "dayTime.ts 的 DEFAULT_PHASES 与 ProjectModel.DEFAULT_TIME_PHASES 漂移了",
        )

    def test_default_table_marks_exactly_one_daylight_phase(self) -> None:
        """内置表必须有且只有 `day` 标 daylight——它就是 2026-08-18 之前那个硬编码常量的语义。"""
        ts_rows = _ts_default_phases(_DAY_TIME_TS.read_text(encoding="utf-8"))
        self.assertEqual([pid for pid, _, _, daylight in ts_rows if daylight], ["day"])

    def test_fallback_used_when_game_config_has_no_day_night(self) -> None:
        """未配 dayNight 时编辑器候选必须非空，且与缺省表一致（否则条件叶下拉是空的）。"""
        model = ProjectModel.__new__(ProjectModel)
        model.game_config = {}
        ids = [pid for pid, _ in model.all_time_phase_ids()]
        self.assertEqual(ids, [pid for pid, _, _, _ in ProjectModel.DEFAULT_TIME_PHASES])

    def test_configured_phases_win_over_fallback(self) -> None:
        model = ProjectModel.__new__(ProjectModel)
        model.game_config = {
            "dayNight": {"phases": [{"id": "zi", "from": "23:00", "label": "子时"}]}
        }
        self.assertEqual([pid for pid, _ in model.all_time_phase_ids()], ["zi"])

    def test_malformed_phase_rows_fall_back_instead_of_yielding_empty(self) -> None:
        """全是坏行时回落缺省——与运行时 resolvePhases 同口径（那边也恒有至少一段）。"""
        model = ProjectModel.__new__(ProjectModel)
        model.game_config = {"dayNight": {"phases": ["坏行", {}, {"id": "  "}]}}
        ids = [pid for pid, _ in model.all_time_phase_ids()]
        self.assertEqual(ids, [pid for pid, _, _, _ in ProjectModel.DEFAULT_TIME_PHASES])


class DaylightPhaseIdsTests(unittest.TestCase):
    """`daylight_phase_ids()` = 未写 phases 的 NPC 的缺省归属，与运行时 daylightPhaseIds 同口径。"""

    def _model(self, game_config: dict) -> ProjectModel:
        model = ProjectModel.__new__(ProjectModel)
        model.game_config = game_config
        return model

    def test_falls_back_to_builtin_when_unconfigured(self) -> None:
        self.assertEqual(self._model({}).daylight_phase_ids(), ["day"])

    def test_reads_marks_from_configured_table(self) -> None:
        model = self._model(
            {
                "dayNight": {
                    "phases": [
                        {"id": "辰", "from": "07:00", "daylight": True},
                        {"id": "午", "from": "11:00", "daylight": True},
                        {"id": "暮", "from": "18:00"},
                        {"id": "夜", "from": "20:00"},
                    ]
                }
            }
        )
        self.assertEqual(model.daylight_phase_ids(), ["辰", "午"])

    def test_configured_table_without_marks_yields_empty_not_builtin(self) -> None:
        """这正是 2026-08-18 那场事故：配了自己的词表却没标 daylight。

        必须返回空（→ 校验器出警告、运行时 fail-open 全时段），
        **绝不能**回落成内置表的 `day`——那个 id 在这张表里根本不存在，判定恒假、整条街空掉。
        """
        model = self._model(
            {"dayNight": {"phases": [{"id": "辰", "from": "07:00"}, {"id": "夜", "from": "20:00"}]}}
        )
        self.assertEqual(model.daylight_phase_ids(), [])

    def test_truthy_but_not_true_is_not_a_mark(self) -> None:
        """只认真布尔 True，与运行时 `p.daylight === true` 同口径。"""
        model = self._model(
            {"dayNight": {"phases": [{"id": "辰", "from": "07:00", "daylight": "true"}]}}
        )
        self.assertEqual(model.daylight_phase_ids(), [])


if __name__ == "__main__":
    unittest.main()
