"""过场步骤「禁用」开关（只记录、不播放）的编辑器护栏。

契约（运行时权威见 src/systems/CutsceneManager.ts#isStepDisabled）：
- 禁用 = 步骤 dict 上写 `disabled: true`；启用 = **删键**（缺省即启用，不写 false）；
- 开关只在大纲行上（顶层与并行子轨同一个控件），展开表单后不得把标记弄丢；
- 打开一段带禁用步的过场不得"打开即脏"。

护栏从最外层用户入口进：点行上的真按钮，不直接调 setter。
"""
from __future__ import annotations

import sys
import unittest
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.timeline_editor import TimelineEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_STEPS: list[dict] = [
    {"kind": "present", "type": "waitTime", "duration": 500},
    {"kind": "present", "type": "showTitle", "text": "第一天", "duration": 2000,
     "disabled": True},
    {"kind": "parallel", "tracks": [
        {"kind": "present", "type": "flashWhite", "duration": 200},
        {"kind": "present", "type": "waitTime", "duration": 300, "disabled": True},
    ]},
]


class TestCutsceneStepDisable(unittest.TestCase):
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

    def tearDown(self) -> None:
        self._td.cleanup()

    # ---- 读 ----

    def test_loads_flag_from_data(self) -> None:
        rows = self.ed._step_outlines
        self.assertFalse(rows[0].is_step_disabled())
        self.assertTrue(rows[1].is_step_disabled())
        self.assertTrue(rows[1]._btn_disable.isChecked())

    def test_opening_disabled_cutscene_is_not_dirty(self) -> None:
        """打开即脏是红线：构造期回填按钮状态不得回打 toggled。"""
        self.assertFalse(self.ed.has_pending_changes())

    # ---- 写 ----

    def test_row_button_sets_and_clears_flag(self) -> None:
        row = self.ed._step_outlines[0]
        row._btn_disable.click()
        self.assertIs(row.to_dict().get("disabled"), True)
        self.assertTrue(self.ed.has_pending_changes())

        row._btn_disable.click()
        # 启用态删键，不写 false
        self.assertNotIn("disabled", row.to_dict())

    def test_toggle_while_collapsed_survives_expand(self) -> None:
        """折叠行还没建表单：切换后再展开，标记必须跟着走（快照是旧的）。"""
        row = self.ed._step_outlines[0]
        self.assertIsNone(row._step)
        row._btn_disable.click()
        row.set_collapsed(False)
        self.assertIsNotNone(row._step)
        self.assertIs(row.to_dict().get("disabled"), True)

    def test_flag_survives_expand_all(self) -> None:
        """展开全部走 StepWidget 控件路径：重建 dict 时不得漏掉标记。"""
        self.ed._set_all_step_collapsed(False)
        steps = [ol.to_dict() for ol in self.ed._step_outlines]
        self.assertNotIn("disabled", steps[0])
        self.assertIs(steps[1].get("disabled"), True)
        self.assertNotIn("disabled", steps[2]["tracks"][0])
        self.assertIs(steps[2]["tracks"][1].get("disabled"), True)

    def test_parallel_track_row_has_its_own_toggle(self) -> None:
        """并行子轨也是大纲行：可单独禁用一条轨。"""
        self.ed._set_all_step_collapsed(False)
        par = self.ed._step_outlines[2]
        assert par._step is not None
        track0 = par._step._child_outlines[0]
        track0._btn_disable.click()
        steps = [ol.to_dict() for ol in self.ed._step_outlines]
        self.assertIs(steps[2]["tracks"][0].get("disabled"), True)
        self.assertNotIn("disabled", steps[2])  # 只禁这一轨，不牵连整组

    def test_copy_step_keeps_flag(self) -> None:
        row = self.ed._step_outlines[1]
        row._do_copy()
        self.assertIs(self.ed._step_outlines[2].to_dict().get("disabled"), True)

    # ---- 批量对白编辑不得吞掉标记 ----

    def test_dialogue_run_row_roundtrips_flag(self) -> None:
        from tools.editor.shared.cutscene_dialogue_run_dialog import (
            DialogueRunEditorDialog, new_dialogue_step,
        )
        line = {"kind": "present", "type": "showDialogue", "speaker": "甲",
                "text": "一句话", "disabled": True}
        dlg = DialogueRunEditorDialog([deepcopy(line)], self.model, self.ed, self.ed)
        try:
            self.assertEqual(dlg.result_steps()[0].get("disabled"), True)
            # 展开成完整表单（走 StepWidget）后依然带着
            dlg._rows[0].set_expanded(True)
            self.assertEqual(dlg.result_steps()[0].get("disabled"), True)
            # 以禁用句为模板新起一句：新句必须是启用的
            self.assertNotIn("disabled", new_dialogue_step(line))
        finally:
            dlg.deleteLater()


if __name__ == "__main__":
    unittest.main()
