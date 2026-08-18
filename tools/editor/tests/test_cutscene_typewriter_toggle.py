"""过场台词「逐字显示」开关的编辑器护栏。

契约（运行时权威见 src/systems/CutsceneManager.ts#readTypewriterFlag）：
- 缺省**按台词面分家**：`showDialogue` 逐字、`showSubtitle` 整句；
- **只在偏离缺省时落键**（同 `disabled` 的只写偏离值口径）：对白框取消勾选写
  `typewriter: false`，字幕勾上写 `typewriter: true`，回到缺省即删键；
- 展开表单 / 批量对白对话框重建 dict 时不得把标记弄丢；
- 打开一段带该键的过场不得"打开即脏"。
"""
from __future__ import annotations

import sys
import unittest
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.timeline_editor import TimelineEditor, step_summary_line
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_STEPS: list[dict] = [
    {"kind": "present", "type": "showDialogue", "speaker": "甲", "text": "缺省这句逐字"},
    {"kind": "present", "type": "showDialogue", "speaker": "乙", "text": "这句要砸脸上",
     "typewriter": False},
    {"kind": "present", "type": "showSubtitle", "text": "缺省这条整句", "position": "bottom"},
    {"kind": "present", "type": "showSubtitle", "text": "这条逐字", "position": "bottom",
     "typewriter": True},
]


class TestCutsceneTypewriterToggle(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._td = TemporaryDirectory()
        root = Path(self._td.name) / "p"
        write_minimal_loadable_project(root)
        self.model = ProjectModel()
        self.model.load_project(root)
        self.model.cutscenes[0]["steps"] = deepcopy(_STEPS)
        self.ed = TimelineEditor(self.model)
        self.ed._on_select(0)
        self.ed._set_all_step_collapsed(False)

    def tearDown(self) -> None:
        self._td.cleanup()

    def _dialogue_box(self, idx: int):
        step = self.ed._step_outlines[idx]._step
        assert step is not None
        return step._widgets["__showDialogue__"]._typewriter

    def _subtitle_box(self, idx: int):
        step = self.ed._step_outlines[idx]._step
        assert step is not None
        return step._widgets["_subtitle_typewriter"]

    # ---- 读：缺省态与显式覆盖都要回填对 ----

    def test_checkbox_reflects_data(self) -> None:
        self.assertTrue(self._dialogue_box(0).isChecked())    # 对白框缺省逐字
        self.assertFalse(self._dialogue_box(1).isChecked())   # 显式关掉
        self.assertFalse(self._subtitle_box(2).isChecked())   # 字幕缺省整句
        self.assertTrue(self._subtitle_box(3).isChecked())    # 显式打开

    def test_opening_is_not_dirty(self) -> None:
        """打开即脏是红线：构造期回填不得回打 toggled。"""
        self.assertFalse(self.ed.has_pending_changes())

    # ---- 写：只落偏离缺省的那一侧 ----

    def test_default_side_writes_no_key(self) -> None:
        steps = [ol.to_dict() for ol in self.ed._step_outlines]
        self.assertNotIn("typewriter", steps[0])
        self.assertNotIn("typewriter", steps[2])

    def test_deviating_side_roundtrips(self) -> None:
        steps = [ol.to_dict() for ol in self.ed._step_outlines]
        self.assertIs(steps[1].get("typewriter"), False)
        self.assertIs(steps[3].get("typewriter"), True)

    def test_toggle_dialogue_off_writes_false(self) -> None:
        self._dialogue_box(0).setChecked(False)
        self.assertIs(self.ed._step_outlines[0].to_dict().get("typewriter"), False)
        self.assertTrue(self.ed.has_pending_changes())

    def test_toggle_dialogue_back_to_default_drops_key(self) -> None:
        self._dialogue_box(1).setChecked(True)
        self.assertNotIn("typewriter", self.ed._step_outlines[1].to_dict())

    def test_toggle_subtitle_on_writes_true(self) -> None:
        self._subtitle_box(2).setChecked(True)
        self.assertIs(self.ed._step_outlines[2].to_dict().get("typewriter"), True)

    def test_toggle_subtitle_back_to_default_drops_key(self) -> None:
        self._subtitle_box(3).setChecked(False)
        self.assertNotIn("typewriter", self.ed._step_outlines[3].to_dict())

    def test_movie_slot_subtitle_keeps_flag(self) -> None:
        """黑边槽位版式是另一条序列化分支，别只在经典 position 那条写。"""
        self.model.cutscenes[0]["steps"] = [
            {"kind": "present", "type": "showSubtitle", "text": "黑边上这条",
             "subtitleBand": "movieTop", "subtitleAlign": "center", "typewriter": True},
        ]
        self.ed._on_select(0)
        self.ed._set_all_step_collapsed(False)
        self.assertTrue(self._subtitle_box(0).isChecked())
        self.assertIs(self.ed._step_outlines[0].to_dict().get("typewriter"), True)

    # ---- 大纲摘要：只标偏离缺省的 ----

    def test_summary_marks_only_deviation(self) -> None:
        self.assertNotIn("整句", step_summary_line(_STEPS[0]))
        self.assertIn("整句", step_summary_line(_STEPS[1]))
        self.assertNotIn("逐字", step_summary_line(_STEPS[2]))
        self.assertIn("逐字", step_summary_line(_STEPS[3]))

    # ---- 批量对白编辑不得吞掉标记 ----

    def test_dialogue_run_row_roundtrips_flag(self) -> None:
        from tools.editor.shared.cutscene_dialogue_run_dialog import DialogueRunEditorDialog

        line = {"kind": "present", "type": "showDialogue", "speaker": "甲",
                "text": "一句话", "typewriter": False}
        dlg = DialogueRunEditorDialog([deepcopy(line)], self.model, self.ed, self.ed)
        try:
            self.assertIs(dlg.result_steps()[0].get("typewriter"), False)
            # 展开成完整表单（走 StepWidget）后依然带着
            dlg._rows[0].set_expanded(True)
            self.assertIs(dlg.result_steps()[0].get("typewriter"), False)
        finally:
            dlg.deleteLater()


if __name__ == "__main__":
    unittest.main()
