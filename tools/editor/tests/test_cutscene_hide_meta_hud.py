"""过场里三把火 / 气味默认**不隐藏**，要隐藏得本过场自己勾（2026-09-12 制作人定调）。

回归基线：HUD 过场期整层淡出，把三把火与气味一并压成 0——而这两样是"冥冥之中被感觉到"
的体感读数，且它们的首现仪式（`debut`）常被编排在过场里，整层淡出等于演给空气看。
现在改成默认留着，纯净镜头由 `hideMetaHud` 逐段声明。本文件守编辑器这一侧：
默认不写键（缺省语义只留在运行时一处）、勾了才写 true、取消勾选要把键删掉。
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


class TestCutsceneHideMetaHud(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._td = TemporaryDirectory()
        root = Path(self._td.name) / "p"
        write_minimal_loadable_project(root)
        self.model = ProjectModel()
        self.model.load_project(root)

    def tearDown(self) -> None:
        self._td.cleanup()

    def _editor_on(self, cs: dict) -> TimelineEditor:
        self.model.cutscenes[0].update(deepcopy(cs))
        ed = TimelineEditor(self.model)
        ed._on_select(0)
        return ed

    def test_absent_key_reads_as_not_hidden(self) -> None:
        ed = self._editor_on({})
        self.assertFalse(
            ed._hide_meta_chk.isChecked(),
            "没写 hideMetaHud 的过场默认不隐藏三把火/气味",
        )
        self.assertFalse(ed.has_pending_changes(), "只是打开一段过场，不该标脏")

    def test_apply_without_ticking_writes_no_key(self) -> None:
        """默认值不落盘：缺省语义只留在运行时一处，数据里不许出现 false。"""
        ed = self._editor_on({})
        self.assertTrue(ed._apply())
        self.assertNotIn("hideMetaHud", self.model.cutscenes[0])

    def test_ticking_marks_dirty_and_writes_true(self) -> None:
        ed = self._editor_on({})
        ed._hide_meta_chk.setChecked(True)
        self.assertTrue(ed.has_pending_changes(), "勾选是真实用户改动，必须标脏")
        self.assertTrue(ed._apply())
        self.assertIs(self.model.cutscenes[0].get("hideMetaHud"), True)

    def test_existing_true_survives_open_and_apply(self) -> None:
        """打开→什么都不改→Apply 不许把它抹掉（重建区静默抹除那一族）。"""
        ed = self._editor_on({"hideMetaHud": True})
        self.assertTrue(ed._hide_meta_chk.isChecked())
        self.assertTrue(ed._apply())
        self.assertIs(self.model.cutscenes[0].get("hideMetaHud"), True)

    def test_unticking_removes_the_key(self) -> None:
        ed = self._editor_on({"hideMetaHud": True})
        ed._hide_meta_chk.setChecked(False)
        self.assertTrue(ed.has_pending_changes())
        self.assertTrue(ed._apply())
        self.assertNotIn("hideMetaHud", self.model.cutscenes[0])


if __name__ == "__main__":
    unittest.main()
