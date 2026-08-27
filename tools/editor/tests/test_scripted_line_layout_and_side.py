"""playScriptedDialogue 逐行 `layout` / `speakerSide` 的往返契约。

由来：`ScriptedLinesEditor.to_list()` 是**整条重建**——只保 speaker/text/portrait/voice，
其余键存一次就丢。`speakerSide` 运行时读得到（ActionRegistry 的 `isSpeakerSide(o.speakerSide)`）
却在这儿被吃掉，属于「运行时支持、编辑器丢弃」的静默数据丢失；`layout` 是同一形状的新字段。

两条形态都钉，与 test_action_voice_params 同口径：
最小形态**零注入**（不写默认值制造噪音），填满形态**零丢失**。
另钉一条空行判定：只调了下拉、没写正文的行不许被静默吃掉。
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


def _roundtrip(model: ProjectModel, action: dict, scene_id: str | None) -> dict:
    ed = ActionEditor("test")
    ed.set_project_context(model, scene_id)
    ed.set_data([action])
    out = ed.to_list()
    assert len(out) == 1
    return out[0]


def _act(lines: list[dict], **extra) -> dict:
    return {"type": "playScriptedDialogue", "params": {"lines": lines, **extra}}


class ScriptedLineLayoutAndSideTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls.model = ProjectModel()
        cls.model.load_project(repo_root_from_tests())
        scenes = cls.model.all_scene_ids()
        cls.scene_id = scenes[0] if scenes else None

    def _rt(self, action: dict) -> dict:
        return _roundtrip(self.model, copy.deepcopy(action), self.scene_id)

    # --- 最小形态：不许凭空多键 -------------------------------------------------
    def test_minimal_form_injects_nothing(self) -> None:
        out = self._rt(_act([{"speaker": "", "text": "喂"}]))
        line = out["params"]["lines"][0]
        self.assertNotIn("layout", line, "缺省版式不该写进 JSON")
        self.assertNotIn("speakerSide", line, "缺省分边不该写进 JSON（写了就把自动推导按死）")
        self.assertNotIn("layout", out["params"], "动作级缺省版式同样不该注入")

    # --- 逐行 speakerSide：这条就是被修的那个 bug -------------------------------
    def test_line_speaker_side_survives(self) -> None:
        for side in ("left", "right"):
            with self.subTest(side):
                out = self._rt(_act([{"speaker": "", "text": "喂", "speakerSide": side}]))
                self.assertEqual(out["params"]["lines"][0].get("speakerSide"), side)

    def test_illegal_speaker_side_falls_back_to_auto(self) -> None:
        """非法值当没写——与运行时 isSpeakerSide 同口径，不许原样回写脏数据。"""
        out = self._rt(_act([{"speaker": "", "text": "喂", "speakerSide": "middle"}]))
        self.assertNotIn("speakerSide", out["params"]["lines"][0])

    # --- 逐行 / 动作级 layout ---------------------------------------------------
    def test_line_layout_survives(self) -> None:
        for lay in ("top", "bubble"):
            with self.subTest(lay):
                out = self._rt(_act([{"speaker": "", "text": "喂", "layout": lay}]))
                self.assertEqual(out["params"]["lines"][0].get("layout"), lay)

    def test_action_level_layout_survives(self) -> None:
        out = self._rt(_act([{"speaker": "", "text": "喂"}], layout="bubble"))
        self.assertEqual(out["params"].get("layout"), "bubble")

    def test_action_level_bottom_is_normalized_away(self) -> None:
        """**动作级**是顶层：显式写缺省档等价于不写，回写时收敛，避免同义两形态并存。"""
        out = self._rt(_act([{"speaker": "", "text": "喂"}], layout="bottom"))
        self.assertNotIn("layout", out["params"])

    def test_line_level_bottom_is_a_real_override_and_is_kept(self) -> None:
        """**逐行**是子层：动作级可能是 top，此时行内的 bottom 是真覆盖，不许当缺省吃掉。

        这是这套层级里最容易写反的一条——顶层的 bottom 是「缺省、不写」，
        子层的 bottom 是「覆盖、要写」，混用就会静默丢掉作者的破例。
        """
        out = self._rt(_act([
            {"speaker": "", "text": "甲", "layout": "bottom"},
            {"speaker": "", "text": "乙"},
        ], layout="top"))
        self.assertEqual(out["params"].get("layout"), "top")
        self.assertEqual(
            out["params"]["lines"][0].get("layout"), "bottom",
            "行内显式屏底被当成缺省吃掉了——动作级是屏顶，这一行会跟着变屏顶",
        )
        self.assertNotIn("layout", out["params"]["lines"][1], "没设的行不该被固化")

    # --- 两者共存 + 与既有字段共存 ---------------------------------------------
    def test_all_line_fields_coexist(self) -> None:
        src = _act([{
            "speaker": "", "text": "喂",
            "speakerSide": "right", "layout": "top",
            "voice": "sfx_x", "autoAdvance": "voice",
        }])
        line = self._rt(src)["params"]["lines"][0]
        self.assertEqual(line.get("speakerSide"), "right")
        self.assertEqual(line.get("layout"), "top")
        self.assertEqual(line.get("voice"), "sfx_x")
        self.assertEqual(line.get("autoAdvance"), "voice")
        self.assertEqual(line.get("text"), "喂")

    # --- 空行判定：只调下拉的行不许被吃掉 ---------------------------------------
    def test_row_with_only_a_dropdown_is_not_silently_dropped(self) -> None:
        """与「审查 P3」同一条原则：不许默默吃掉用户的编辑。"""
        for key, val in (("speakerSide", "right"), ("layout", "bubble")):
            with self.subTest(key):
                out = self._rt(_act([{"speaker": "", "text": "", key: val}]))
                lines = out["params"]["lines"]
                self.assertEqual(len(lines), 1, f"只配了 {key} 的行被静默丢弃了")
                self.assertEqual(lines[0].get(key), val)

    def test_truly_empty_row_is_still_dropped(self) -> None:
        """反向：真空行照旧丢弃——上一条不许把这个既有行为一起破坏。"""
        out = self._rt(_act([{"speaker": "", "text": ""}]))
        self.assertEqual(out["params"]["lines"], [])


if __name__ == "__main__":
    unittest.main()
