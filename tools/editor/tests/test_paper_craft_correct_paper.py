"""paper_craft：空/未知 correctPaper 不得被静默写成第一种纸张（HIGH-10）。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.paper_craft_editor import PaperCraftEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class PaperCraftCorrectPaperTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path) -> tuple[PaperCraftEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        return PaperCraftEditor(model), model

    def test_empty_correct_paper_round_trips(self) -> None:
        with TemporaryDirectory() as td:
            editor, _ = self._editor(Path(td) / "p")
            editor._order = {
                "title": "t", "description": "", "correctPaper": "",
                "paperOptions": [
                    {"id": "white", "label": "白纸"},
                    {"id": "red", "label": "红纸"},
                ],
                "successScore": 76, "warnScore": 50,
            }
            editor._refresh_order_fields()
            self.assertEqual(editor.correct_paper_combo.currentData(), "",
                             "空 correctPaper 应停在未设置哨兵，而非第一种纸张")
            # 编辑任意字段会触发 _write_order；correctPaper 必须保持空
            editor.order_title.setText("新标题")
            editor._write_order()
            self.assertEqual(editor._order["correctPaper"], "",
                             "编辑其它字段不得把空 correctPaper 静默改成第一种纸张")

    def test_valid_correct_paper_preserved(self) -> None:
        with TemporaryDirectory() as td:
            editor, _ = self._editor(Path(td) / "p")
            editor._order = {
                "title": "t", "description": "", "correctPaper": "red",
                "paperOptions": [
                    {"id": "white", "label": "白纸"},
                    {"id": "red", "label": "红纸"},
                ],
                "successScore": 76, "warnScore": 50,
            }
            editor._refresh_order_fields()
            self.assertEqual(editor.correct_paper_combo.currentData(), "red")
            editor.order_title.setText("新标题")
            editor._write_order()
            self.assertEqual(editor._order["correctPaper"], "red")

    def test_tint_editable_and_feedback_format_preserved(self) -> None:
        # H2: tint 可编辑; H1: 反馈字段可编辑且只在用户改动该字段时写回(格式保真)。
        with TemporaryDirectory() as td:
            editor, _ = self._editor(Path(td) / "p")
            editor._order = {
                "id": "o", "title": "t", "paperOptions": [{"id": "white", "label": "白", "tint": "#f3ead7"}],
                "onSuccessActions": [{"type": "playSfx", "id": "a"}],  # 故意非规范(无 params)
            }
            editor._refresh_order_fields()
            editor.paper_combo.setCurrentIndex(editor.paper_combo.count() - 1)
            editor._select_paper()
            self.assertEqual(editor.paper_tint.hex(), "#f3ead7", "tint 应载入取色器")
            # 仅改标题: onSuccessActions 不得被规范化改写
            editor.order_title.setText("改了标题")
            editor._write_order()
            self.assertEqual(editor._order["onSuccessActions"], [{"type": "playSfx", "id": "a"}],
                             "未触动反馈字段时,动作数组格式必须原样保留")


if __name__ == "__main__":
    unittest.main()
