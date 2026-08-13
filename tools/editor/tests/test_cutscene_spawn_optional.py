"""过场的出生点是可选的，UI 必须让人看得出来、也点得回去。

回归基线：`targetSpawnPoint` 空值本来就合法（同场景不挪玩家、就地开演），但表单把空值
写成「默认 (spawnPoint)」、且只有打开弹窗选第一行才回得去 → 策划读成"必填"。
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


class TestCutsceneSpawnOptional(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._td = TemporaryDirectory()
        root = Path(self._td.name) / "p"
        write_minimal_loadable_project(root)
        self.model = ProjectModel()
        self.model.load_project(root)
        self.scene_id = sorted(self.model.all_scene_ids())[0]
        sc = self.model.scenes[self.scene_id]
        sc.setdefault("spawnPoints", {})["spawn_x"] = {"x": 100, "y": 200}

    def tearDown(self) -> None:
        self._td.cleanup()

    def _editor_on(self, cs: dict) -> TimelineEditor:
        self.model.cutscenes[0].update(deepcopy(cs))
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        return ed

    def test_unset_spawn_reads_as_play_in_place(self) -> None:
        """没指定出生点时，展示的是"就地开演"，不是"默认 spawnPoint"。"""
        ed = self._editor_on({"targetScene": self.scene_id})
        self.assertEqual(ed._spawn_key, "")
        self.assertIn("就地开演", ed._spawn_display.text())
        self.assertNotIn("默认 (spawnPoint)", ed._spawn_display.text())

    def test_no_target_scene_also_reads_as_play_in_place(self) -> None:
        ed = self._editor_on({})
        self.model.cutscenes[0].pop("targetScene", None)
        ed._on_select(0)
        self.assertIn("就地开演", ed._spawn_display.text())
        self.assertFalse(ed._spawn_pick_btn.isEnabled(), "没目标场景时选出生点无意义")

    def test_clear_button_puts_it_back_to_unset(self) -> None:
        """点「清除」一步回到不指定，并标脏；Apply 后 JSON 里不留 targetSpawnPoint 键。"""
        ed = self._editor_on(
            {"targetScene": self.scene_id, "targetSpawnPoint": "spawn_x"})
        self.assertEqual(ed._spawn_key, "spawn_x")
        self.assertTrue(ed._spawn_clear_btn.isEnabled())

        ed._spawn_clear_btn.click()
        self.assertEqual(ed._spawn_key, "")
        self.assertIn("就地开演", ed._spawn_display.text())
        self.assertFalse(ed._spawn_clear_btn.isEnabled(), "已经是不指定就没得清")
        self.assertTrue(ed.has_pending_changes(), "清除是真实用户改动，必须标脏")

        self.assertTrue(ed._apply())
        self.assertNotIn("targetSpawnPoint", self.model.cutscenes[0])

    def test_clear_button_disabled_when_already_unset(self) -> None:
        ed = self._editor_on({"targetScene": self.scene_id})
        self.assertFalse(ed._spawn_clear_btn.isEnabled())
        ed._spawn_clear_btn.click()
        self.assertFalse(ed.has_pending_changes(), "点不动的按钮不该把工程标脏")

    def test_picker_names_the_empty_row_for_cutscenes(self) -> None:
        """弹窗第一行在过场语境下必须说「不指定」，而不是 switchScene 的「默认 spawnPoint」。"""
        from tools.editor.editors.scene_editor import TargetSpawnPickerDialog

        dlg = TargetSpawnPickerDialog(
            self.model, self.scene_id, "", None,
            empty_label="不指定（就地开演，不挪玩家）",
            empty_hint="第一项「不指定」= 同场景不挪玩家。",
        )
        self.assertEqual(dlg._list.item(0).text(), "不指定（就地开演，不挪玩家）")
        self.assertEqual(dlg._list.item(0).data(0x0100), "")  # UserRole
        dlg.deleteLater()

    def test_picker_default_wording_unchanged_for_switch_scene(self) -> None:
        """switchScene 那条路径语义不同（一定落人），文案不能被过场的改动带跑。"""
        from tools.editor.editors.scene_editor import TargetSpawnPickerDialog

        dlg = TargetSpawnPickerDialog(self.model, self.scene_id, "", None)
        self.assertEqual(dlg._list.item(0).text(), "默认（spawnPoint）")
        dlg.deleteLater()


if __name__ == "__main__":
    unittest.main()
