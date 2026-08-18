"""action 侧配音参数（voice / autoAdvance）的往返契约：头顶气泡四个 + 逐行台词。

加可选参数最经典的破口是「最小形态打开→保存凭空多键」——把没配的配音写成
`voice: ""`，运行时就多出一条查不到的 sfx 警告。这里两条形态都钉：
最小形态零注入、填满形态零丢失。
"""
from __future__ import annotations

import copy
import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.shared.action_editor import ActionEditor
from tools.editor.tests.save_test_utils import repo_root_from_tests

_BUBBLE_ACTIONS = (
    ("showEmote", {"target": "player", "emote": "！"}),
    ("showSpeechBubble", {"target": "player", "text": "喂"}),
    ("showEmoteAndWait", {"target": "player", "emote": "！"}),
    ("showSpeechBubbleAndWait", {"target": "player", "text": "喂"}),
)


def _roundtrip(model: ProjectModel, action: dict, scene_id: str | None) -> dict:
    ed = ActionEditor("test")
    ed.set_project_context(model, scene_id)
    ed.set_data([action])
    out = ed.to_list()
    assert len(out) == 1
    return out[0]


class BubbleVoiceParamTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls.model = ProjectModel()
        cls.model.load_project(repo_root_from_tests())
        scenes = cls.model.all_scene_ids()
        cls.scene_id = scenes[0] if scenes else None

    def test_minimal_form_does_not_inject_voice_keys(self) -> None:
        for act, params in _BUBBLE_ACTIONS:
            with self.subTest(act):
                out = _roundtrip(self.model, {"type": act, "params": dict(params)}, self.scene_id)
                self.assertNotIn("voice", out["params"])
                self.assertNotIn("autoAdvance", out["params"])

    def test_voice_spec_roundtrips(self) -> None:
        for act, params in _BUBBLE_ACTIONS:
            with self.subTest(act):
                src = {"type": act, "params": {**params, "voice": "sfx_x"}}
                out = _roundtrip(self.model, copy.deepcopy(src), self.scene_id)
                self.assertEqual(out["params"].get("voice"), "sfx_x")

    def test_wait_variants_roundtrip_auto_advance(self) -> None:
        for act, params in _BUBBLE_ACTIONS:
            if not act.endswith("AndWait"):
                continue
            with self.subTest(act):
                src = {
                    "type": act,
                    "params": {**params, "voice": {"id": "sfx_x", "hold": True}, "autoAdvance": "voice"},
                }
                out = _roundtrip(self.model, copy.deepcopy(src), self.scene_id)
                self.assertEqual(out["params"].get("voice"), {"id": "sfx_x", "hold": True})
                self.assertEqual(out["params"].get("autoAdvance"), "voice")

    def test_non_wait_variants_have_no_advance_control(self) -> None:
        """非阻塞气泡不提供推进方式（没有「本拍结束」这个时刻）——控件不得凭空写这个键。"""
        for act, params in _BUBBLE_ACTIONS:
            if act.endswith("AndWait"):
                continue
            with self.subTest(act):
                out = _roundtrip(
                    self.model,
                    {"type": act, "params": {**params, "voice": "sfx_x"}},
                    self.scene_id,
                )
                self.assertNotIn("autoAdvance", out["params"])


class ScriptedLineVoiceTests(unittest.TestCase):
    """playScriptedDialogue 的逐行配音：与图对话拍、过场字幕同一套键与语义。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls.model = ProjectModel()
        cls.model.load_project(repo_root_from_tests())
        scenes = cls.model.all_scene_ids()
        cls.scene_id = scenes[0] if scenes else None

    def test_lines_without_voice_stay_without_voice(self) -> None:
        src = {"type": "playScriptedDialogue", "params": {
            "lines": [{"speaker": "", "text": "一句话"}],
        }}
        out = _roundtrip(self.model, copy.deepcopy(src), self.scene_id)
        self.assertEqual(out["params"]["lines"], [{"speaker": "", "text": "一句话"}])

    def test_per_line_voice_and_advance_roundtrip(self) -> None:
        src = {"type": "playScriptedDialogue", "params": {
            "lines": [
                {"speaker": "", "text": "起头这句短", "voice": {"id": "v_long", "hold": True}},
                {"speaker": "", "text": "这句跟着配音走", "autoAdvance": "voice"},
            ],
        }}
        out = _roundtrip(self.model, copy.deepcopy(src), self.scene_id)
        self.assertEqual(out["params"]["lines"][0].get("voice"), {"id": "v_long", "hold": True})
        self.assertEqual(out["params"]["lines"][1].get("autoAdvance"), "voice")

    def test_voice_only_line_is_not_dropped_as_empty(self) -> None:
        """只配了配音、正文还没写的行不算空行——静默丢掉就是吃掉策划的编辑。"""
        src = {"type": "playScriptedDialogue", "params": {
            "lines": [{"speaker": "", "text": "", "voice": "v_a"}],
        }}
        out = _roundtrip(self.model, copy.deepcopy(src), self.scene_id)
        self.assertEqual(len(out["params"]["lines"]), 1)
        self.assertEqual(out["params"]["lines"][0].get("voice"), "v_a")


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
