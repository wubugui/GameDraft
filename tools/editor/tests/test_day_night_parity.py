"""日夜时段缺省清单的跨语言 parity 锁（editor-tools norms 第 8 条）。

两份手工镜像必须逐字一致，任一侧漂移即红：

- 运行时权威：`src/utils/dayTime.ts` 的 `DEFAULT_PHASES`
- 编辑器：`tools/editor/project_model.py` 的 `ProjectModel.DEFAULT_TIME_PHASES`
  （`all_time_phase_ids()` 在 game_config 未配 dayNight 时回落到它）

漏改一处的后果：策划在条件编辑器里看到的缺省时段与运行时实际分段不同——
配出来的 `{timePhase: …}` 恒假，且校验器还会放行（因为它信的是编辑器这份）。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from tools.editor.project_model import ProjectModel

_DAY_TIME_TS = Path(__file__).resolve().parents[3] / "src" / "utils" / "dayTime.ts"


def _ts_default_phases(source: str) -> list[tuple[str, str, str]]:
    m = re.search(
        r"export const DEFAULT_PHASES: readonly DayPhaseDef\[\] = \[(.*?)\] as const;",
        source,
        re.S,
    )
    assert m, "dayTime.ts 里找不到 DEFAULT_PHASES"
    rows = re.findall(
        r"\{\s*id:\s*'([^']+)',\s*from:\s*'([^']+)',\s*label:\s*'([^']+)'\s*\}",
        m.group(1),
    )
    assert rows, "DEFAULT_PHASES 的条目形状变了，parity 提取正则需同步"
    return [(pid, frm, label) for pid, frm, label in rows]


class DayNightPhaseParityTests(unittest.TestCase):
    def test_default_phases_match_runtime(self) -> None:
        ts_rows = _ts_default_phases(_DAY_TIME_TS.read_text(encoding="utf-8"))
        self.assertEqual(
            ts_rows,
            list(ProjectModel.DEFAULT_TIME_PHASES),
            "dayTime.ts 的 DEFAULT_PHASES 与 ProjectModel.DEFAULT_TIME_PHASES 漂移了",
        )

    def test_fallback_used_when_game_config_has_no_day_night(self) -> None:
        """未配 dayNight 时编辑器候选必须非空，且与缺省表一致（否则条件叶下拉是空的）。"""
        model = ProjectModel.__new__(ProjectModel)
        model.game_config = {}
        ids = [pid for pid, _ in model.all_time_phase_ids()]
        self.assertEqual(ids, [pid for pid, _, _ in ProjectModel.DEFAULT_TIME_PHASES])

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
        self.assertEqual(ids, [pid for pid, _, _ in ProjectModel.DEFAULT_TIME_PHASES])


if __name__ == "__main__":
    unittest.main()
