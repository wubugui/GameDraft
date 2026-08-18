"""过场大纲/缩略条摘要必须带说话人的护栏。

由来：`showDialogue` 摘要只印正文，而实际数据里绝大多数台词是「speaker 留空 +
scriptedNpcId 指实体」的写法 —— 折叠着看整段过场，一屏台词分不出谁在说。

契约（说话人回落链与运行时 src/systems/CutsceneManager.ts 同口径）：
- 显式 speaker → scriptedNpcId → 两者都没设 = 旁白；
- `{{player}}` / `{{npc:id}}` 这类纯占位解引用到实体，字面名/混排文本就是显示名本身、原样照搬；
- 摘要露的是**玩家看到的名字**（`storyteller_zhang` → 说书人张叨叨、`player` → 主角缺省名、
  旁白取 `strings.dialogue.narratorLabel`），名字表查不到的 id 才原样显示 id；
- `playScriptedDialogue` 摘要给行数 + 首行「谁说什么」，不再是被截断的 params JSON；
- 并行块折叠标签里的 showDialogue 同样带说话人。
"""
from __future__ import annotations

import unittest

from tools.editor.editors.timeline_editor import (
    parallel_tracks_summary,
    step_summary_line,
)
from tools.editor.shared.cutscene_dialogue_speaker_row import speaker_display_names


class _FakeModel:
    """只喂 speaker_display_names 要的两样：NPC 名字表 + strings。"""

    def __init__(self, npcs: list[tuple[str, str]], strings: dict) -> None:
        self._npcs = npcs
        self.strings = strings

    def all_npc_ids_global(self) -> list[tuple[str, str]]:
        return list(self._npcs)


_NAMES = speaker_display_names(_FakeModel(
    [("storyteller_zhang", "说书人张叨叨"), ("axiu", "阿秀")],
    {"dialogue": {"defaultProtagonistName": "关二狗", "narratorLabel": "旁白"}},
))


def _dlg(**kw) -> dict:
    return {"kind": "present", "type": "showDialogue", **kw}


class TestShowDialogueSpeakerInSummary(unittest.TestCase):
    def test_scripted_npc_id_only_still_shows_speaker(self) -> None:
        """实际数据里的大头形态：speaker 不落键，说话人全靠 scriptedNpcId。"""
        s = step_summary_line(_dlg(scriptedNpcId="player", text="你哪个？"))
        self.assertIn("主角", s)
        self.assertIn("你哪个？", s)
        s2 = step_summary_line(_dlg(scriptedNpcId="storyteller_zhang", text="且听下回"))
        self.assertIn("storyteller_zhang", s2)

    def test_literal_speaker_wins_over_entity(self) -> None:
        s = step_summary_line(
            _dlg(speaker="说书先生", scriptedNpcId="storyteller_zhang", text="那墓门一开"))
        self.assertIn("说书先生", s)

    def test_placeholder_speaker_resolves_to_entity(self) -> None:
        self.assertIn("主角", step_summary_line(_dlg(speaker="{{player}}", text="我熟")))
        self.assertIn("axiu", step_summary_line(_dlg(speaker="{{npc:axiu}}", text="你来了")))
        # `{{npc}}` 没带 id = 跟说话人走 → 回落到 scriptedNpcId，别把占位本身印出来
        s = step_summary_line(_dlg(speaker="{{npc}}", scriptedNpcId="axiu", text="跟着走"))
        self.assertIn("axiu", s)
        self.assertNotIn("{{", s)

    def test_no_speaker_reads_as_narration(self) -> None:
        """speaker 与 scriptedNpcId 都没设，运行时不出名牌 —— 摘要就得说清是旁白。"""
        self.assertIn("旁白", step_summary_line(_dlg(text="天色渐暗。")))

    def test_voice_and_typewriter_suffixes_survive(self) -> None:
        s = step_summary_line(_dlg(scriptedNpcId="player", text="喂", voice="vo_1",
                                   typewriter=False))
        self.assertIn("主角", s)
        self.assertIn("voice:vo_1", s)
        self.assertIn("整句", s)

    def test_parallel_track_fold_label_carries_speaker(self) -> None:
        s = parallel_tracks_summary([
            _dlg(scriptedNpcId="player", text="快跑！"),
            {"kind": "present", "type": "showSubtitle", "text": "远处传来锣声"},
        ])
        self.assertIn("主角", s)
        self.assertIn("快跑！", s)
        self.assertIn("远处传来锣声", s)


class TestScriptedDialogueSummary(unittest.TestCase):
    def _step(self, params: dict) -> dict:
        return {"kind": "action", "type": "playScriptedDialogue", "params": params}

    def test_lines_summary_replaces_params_json(self) -> None:
        s = step_summary_line(self._step({
            "scriptedNpcId": "player",
            "lines": [
                {"speaker": "", "text": "这院子怎么这么静……"},
                {"speaker": "阿秀", "text": "因为没人敢住。"},
            ],
        }))
        self.assertIn("2行", s)
        self.assertIn("主角", s)
        self.assertIn("这院子怎么这么静", s)
        # 首行之外还有别的说话人 → 提示有几个，别让人以为整段都是一个人在说
        self.assertIn("+1人", s)
        self.assertNotIn('{"lines"', s)

    def test_single_speaker_has_no_extra_marker(self) -> None:
        s = step_summary_line(self._step({"lines": [{"speaker": "旁白", "text": "风停了。"}]}))
        self.assertIn("1行", s)
        self.assertIn("旁白", s)
        self.assertNotIn("人", s.replace("旁白", ""))

    def test_empty_lines_is_explicit(self) -> None:
        self.assertIn("无台词", step_summary_line(self._step({"lines": []})))

    def test_names_table_applies_to_lines(self) -> None:
        s = step_summary_line(self._step({
            "scriptedNpcId": "player",
            "lines": [{"speaker": "{{npc:axiu}}", "text": "你终于来了。"}],
        }), _NAMES)
        self.assertIn("阿秀", s)


class TestSpeakerDisplayNames(unittest.TestCase):
    """摘要要的是玩家看到的名字，不是内部 id。"""

    def test_entity_id_becomes_display_name(self) -> None:
        s = step_summary_line(_dlg(scriptedNpcId="storyteller_zhang", text="且听下回"), _NAMES)
        self.assertIn("说书人张叨叨", s)
        self.assertNotIn("storyteller_zhang", s)

    def test_placeholder_speaker_also_becomes_name(self) -> None:
        s = step_summary_line(_dlg(speaker="{{npc:axiu}}", text="你来了"), _NAMES)
        self.assertIn("阿秀", s)

    def test_player_uses_project_protagonist_name(self) -> None:
        s = step_summary_line(_dlg(scriptedNpcId="player", text="你哪个？"), _NAMES)
        self.assertIn("关二狗", s)

    def test_narrator_label_comes_from_strings(self) -> None:
        names = speaker_display_names(_FakeModel(
            [], {"dialogue": {"narratorLabel": "解说"}}))
        self.assertIn("解说", step_summary_line(_dlg(text="天色渐暗。"), names))

    def test_unknown_id_falls_back_to_raw_id(self) -> None:
        """悬垂引用要看得见 id —— 那是找回哪条数据写错了的唯一线索。"""
        s = step_summary_line(_dlg(scriptedNpcId="ghost_npc_404", text="？"), _NAMES)
        self.assertIn("ghost_npc_404", s)

    def test_literal_speaker_is_never_looked_up(self) -> None:
        s = step_summary_line(
            _dlg(speaker="???", scriptedNpcId="axiu", text="后生，你就是关二狗？"), _NAMES)
        self.assertIn("???", s)
        self.assertNotIn("阿秀", s)

    def test_parallel_tracks_use_names(self) -> None:
        s = parallel_tracks_summary(
            [_dlg(scriptedNpcId="storyteller_zhang", text="快跑！")], _NAMES)
        self.assertIn("说书人张叨叨", s)


if __name__ == "__main__":
    unittest.main()
