"""档案编辑器 list-switch 不丢失编辑(M2 回归)。

切换 角色/传说/文档/书页/书条目 列表选择前,上一项的未应用 UI 编辑必须被提交到模型,
否则作者改了字段直接点下一行就静默丢数据——这是用户最在意的"编辑后数据不可丢失"红线。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.archive_editor import ArchiveEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class ArchiveCommitOnLeaveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        return m

    def test_character_switch_commits_prev_edit(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.archive_characters = [
                {"id": "c0", "name": "Old0", "title": "", "impressions": [],
                 "knownInfo": [], "unlockConditions": []},
                {"id": "c1", "name": "Old1", "title": "", "impressions": [],
                 "knownInfo": [], "unlockConditions": []},
            ]
            ed = ArchiveEditor(m)
            ed._char_list.setCurrentRow(0)
            ed._ch_name.setText("EDITED0")  # 不点 Apply
            ed._char_list.setCurrentRow(1)  # 切换 → 必须提交 c0
            self.assertEqual(m.archive_characters[0]["name"], "EDITED0")
            self.assertEqual(m.archive_characters[1]["name"], "Old1")

    def test_document_switch_commits_prev_edit(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.archive_documents = [
                {"id": "d0", "name": "N0", "content": "", "discoverConditions": []},
                {"id": "d1", "name": "N1", "content": "", "discoverConditions": []},
            ]
            ed = ArchiveEditor(m)
            ed._doc_list.setCurrentRow(0)
            ed._doc_content.setPlainText("DOC0_BODY")
            ed._doc_list.setCurrentRow(1)
            self.assertEqual(m.archive_documents[0]["content"], "DOC0_BODY")

    def test_book_page_and_entry_switch_commit_prev_edit(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.archive_books = [{
                "id": "b0", "title": "Book0", "totalPages": 2, "pages": [
                    {"pageNum": 1, "content": "pageA", "entries": [
                        {"id": "e0", "content": "entA"},
                        {"id": "e1", "content": "entB"}]},
                    {"pageNum": 2, "content": "pageB", "entries": []},
                ]}]
            ed = ArchiveEditor(m)
            ed._book_list.setCurrentRow(0)
            ed._page_list.setCurrentRow(0)
            ed._pg_content.setPlainText("PAGE_A_EDITED")
            ed._entry_list.setCurrentRow(0)
            ed._en_content.setPlainText("ENTRY_A_EDITED")
            ed._entry_list.setCurrentRow(1)  # 提交 entry0
            self.assertEqual(
                m.archive_books[0]["pages"][0]["entries"][0]["content"],
                "ENTRY_A_EDITED")
            ed._page_list.setCurrentRow(1)   # 提交 page0
            self.assertEqual(
                m.archive_books[0]["pages"][0]["content"], "PAGE_A_EDITED")


if __name__ == "__main__":
    unittest.main()
