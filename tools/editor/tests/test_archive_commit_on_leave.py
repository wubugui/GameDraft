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
                 "knownInfo": []},
                {"id": "c1", "name": "Old1", "title": "", "impressions": [],
                 "knownInfo": []},
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

    # ---- 结构操作（加/删/移页、移条目）不丢当前未应用编辑 --------------------

    def _book_model(self, td: Path):
        m = self._model(td)
        m.archive_books = [{
            "id": "b0", "title": "Book0", "totalPages": 2, "pages": [
                {"pageNum": 1, "content": "p1", "entries": [
                    {"id": "e0", "content": "entA"},
                    {"id": "e1", "content": "entB"}]},
                {"pageNum": 2, "content": "p2", "entries": []},
            ]}]
        return m

    def test_add_page_keeps_current_page_edit(self) -> None:
        with TemporaryDirectory() as td:
            m = self._book_model(Path(td) / "p")
            ed = ArchiveEditor(m)
            ed._book_list.setCurrentRow(0)
            ed._page_list.setCurrentRow(0)
            ed._pg_content.setPlainText("EDITED_P1")  # 不点 Apply
            ed._add_page()  # 旧实现会用数据重置表单、丢掉 EDITED_P1
            contents = [p["content"] for p in m.archive_books[0]["pages"]]
            self.assertIn("EDITED_P1", contents)
            self.assertEqual(len(m.archive_books[0]["pages"]), 3)

    def test_move_page_keeps_current_page_edit(self) -> None:
        with TemporaryDirectory() as td:
            m = self._book_model(Path(td) / "p")
            ed = ArchiveEditor(m)
            ed._book_list.setCurrentRow(0)
            ed._page_list.setCurrentRow(1)        # 选第 2 页
            ed._pg_content.setPlainText("EDITED_P2")
            ed._move_page_up()                    # 上移；不得丢 EDITED_P2
            contents = [p["content"] for p in m.archive_books[0]["pages"]]
            self.assertIn("EDITED_P2", contents)

    def test_move_entry_keeps_current_entry_edit(self) -> None:
        with TemporaryDirectory() as td:
            m = self._book_model(Path(td) / "p")
            ed = ArchiveEditor(m)
            ed._book_list.setCurrentRow(0)
            ed._page_list.setCurrentRow(0)
            ed._entry_list.setCurrentRow(1)       # 选 e1
            ed._en_content.setPlainText("EDITED_E1")
            ed._move_entry_up()                   # 上移；不得丢 EDITED_E1
            ents = m.archive_books[0]["pages"][0]["entries"]
            self.assertIn("EDITED_E1", [e["content"] for e in ents])

    # ---- 自动 id 不撞、键序保真 -------------------------------------------

    def test_next_unique_id_avoids_existing(self) -> None:
        from tools.editor.editors.archive_editor import _next_unique_id
        # 删中间项后的状态：char_2 已占用，不能再生成 char_2
        out = _next_unique_id("char", ["char_0", "char_2"])
        self.assertNotIn(out, {"char_0", "char_2"})
        self.assertEqual(_next_unique_id("x", []), "x_0")

    def test_add_char_unique_id_after_mid_delete(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            # 模拟“删掉中间一项”后的列表：char_0 / char_2
            m.archive_characters = [
                {"id": "char_0", "name": "A", "title": "", "impressions": [],
                 "knownInfo": []},
                {"id": "char_2", "name": "C", "title": "", "impressions": [],
                 "knownInfo": []},
            ]
            ed = ArchiveEditor(m)
            ed._add_char()
            ids = [c["id"] for c in m.archive_characters]
            self.assertEqual(len(ids), len(set(ids)), f"id 冲突: {ids}")

    def test_impression_key_order_is_text_first(self) -> None:
        """impressions/knownInfo 内层键序须为 text→conditions，与磁盘一致（往返字节不变）。"""
        from tools.editor.editors.archive_editor import _CondTextGroup
        g = _CondTextGroup("t", {"text": "hi", "conditions": []})
        self.assertEqual(list(g.to_dict().keys()), ["text", "conditions"])
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.archive_characters = [{
                "id": "c0", "name": "N", "title": "T",
                "impressions": [{"text": "hi", "conditions": []}],
                "knownInfo": [],
            }]
            ed = ArchiveEditor(m)
            ed._char_list.setCurrentRow(0)
            ed.flush_to_model()  # 提交后键序不能翻成 conditions→text
            imp = m.archive_characters[0]["impressions"][0]
            self.assertEqual(list(imp.keys()), ["text", "conditions"])

    def test_apply_char_drops_legacy_unlock_conditions(self) -> None:
        """人物解锁只走 addArchiveEntry：保存时清掉历史遗留的 unlockConditions 死字段。"""
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.archive_characters = [{
                "id": "c0", "name": "N", "title": "T", "impressions": [],
                "knownInfo": [], "unlockConditions": [{"flag": "legacy"}],
            }]
            ed = ArchiveEditor(m)
            ed._char_list.setCurrentRow(0)
            ed.flush_to_model()
            self.assertNotIn("unlockConditions", m.archive_characters[0])


if __name__ == "__main__":
    unittest.main()
