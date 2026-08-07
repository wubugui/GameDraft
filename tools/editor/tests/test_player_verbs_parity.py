"""玩家身体动词镜像清单的跨语言 parity 锁（norms 第 8 条）。

三份手工镜像必须逐字一致，任一侧漂移即红：

- 运行时权威：`src/data/types.ts` 的 `PLAYER_VERBS` / `PLAYER_POSTURES` /
  `PLAYER_VERB_LOGICAL_STATES`
- 编辑器：`tools/editor/shared/player_acts_editor.py`（动词分节）与
  `tools/editor/editors/player_avatar_editor.py`（逻辑名 → clip 行）
- 校验器：`tools/editor/validator.py`（白名单与逻辑名表）

漏改一处的后果：编辑器写得出运行时不认的动词（静默不执行），或校验器放行/误拦。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from tools.editor.editors.player_avatar_editor import _VERB_LOGICAL_ROWS
from tools.editor.shared.player_acts_editor import (
    PLAYER_POSTURES as UI_POSTURES,
    PLAYER_VERBS as UI_VERBS,
)
from tools.editor.validator import (
    PLAYER_POSTURES as VAL_POSTURES,
    PLAYER_VERBS as VAL_VERBS,
    _PLAYER_VERB_LOGICAL_STATES as VAL_LOGICAL,
)

_TYPES_TS = Path(__file__).resolve().parents[3] / "src" / "data" / "types.ts"


def _ts_string_array(source: str, const_name: str) -> list[str]:
    m = re.search(rf"export const {const_name} = \[(.*?)\] as const;", source, re.S)
    assert m, f"types.ts 里找不到 {const_name}"
    return re.findall(r"'([^']+)'", m.group(1))


def _ts_logical_states(source: str) -> dict[str, str]:
    m = re.search(
        r"export const PLAYER_VERB_LOGICAL_STATES: Record<PlayerVerb, string> = \{(.*?)\};",
        source,
        re.S,
    )
    assert m, "types.ts 里找不到 PLAYER_VERB_LOGICAL_STATES"
    return dict(re.findall(r"(\w+):\s*'([^']+)'", m.group(1)))


class PlayerVerbParityTests(unittest.TestCase):
    def setUp(self) -> None:
        self.src = _TYPES_TS.read_text(encoding="utf-8")

    def test_verb_list_matches_runtime(self) -> None:
        ts_verbs = _ts_string_array(self.src, "PLAYER_VERBS")
        self.assertEqual(list(ts_verbs), list(UI_VERBS), "编辑器动词清单与 types.ts 漂移")
        self.assertEqual(set(ts_verbs), set(VAL_VERBS), "校验器动词白名单与 types.ts 漂移")

    def test_posture_list_matches_runtime(self) -> None:
        ts_postures = _ts_string_array(self.src, "PLAYER_POSTURES")
        self.assertEqual(list(ts_postures), list(UI_POSTURES), "编辑器姿态清单漂移")
        self.assertEqual(set(ts_postures), set(VAL_POSTURES), "校验器姿态白名单漂移")
        # 姿态必须是动词的子集（躺/蹲/注视都能被位面 allowedVerbs 管到）
        self.assertTrue(set(ts_postures) <= set(_ts_string_array(self.src, "PLAYER_VERBS")))

    def test_logical_state_map_matches_runtime(self) -> None:
        ts_logical = _ts_logical_states(self.src)
        self.assertEqual(ts_logical, dict(VAL_LOGICAL), "校验器逻辑名表与 types.ts 漂移")
        # 化身编辑器必须为每个动词的逻辑名提供一行（否则该动词永远配不上片段）
        rows = {name for name, _desc in _VERB_LOGICAL_ROWS}
        for verb, logical in ts_logical.items():
            self.assertIn(logical, rows, f"玩家化身编辑器缺动词 '{verb}' 的逻辑名 '{logical}' 行")


if __name__ == "__main__":
    unittest.main()
