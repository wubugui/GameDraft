"""删除昂贵实体前必须确认(UX 修复:防一键误删,不可撤销)。

用 item / shop / archive 作代表,验证 confirm_delete 返回 False 时不删、True 时删。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtWidgets import QApplication

from tools.editor.editors.archive_editor import ArchiveEditor
from tools.editor.editors.item_editor import ItemEditor
from tools.editor.editors.shop_editor import ShopEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class DeleteConfirmationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        return m

    def test_item_delete_gated_by_confirm(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.items = [{"id": "i0", "name": "甲", "type": "consumable", "description": "", "maxStack": 1}]
            ed = ItemEditor(m)
            ed._list.setCurrentRow(0)
            with patch("tools.editor.shared.confirm.confirm_delete", return_value=False):
                ed._delete()
            self.assertEqual(len(m.items), 1, "取消确认时不得删除")
            with patch("tools.editor.shared.confirm.confirm_delete", return_value=True):
                ed._delete()
            self.assertEqual(len(m.items), 0, "确认后应删除")

    def test_shop_delete_gated_by_confirm(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.shops = [{"id": "s0", "name": "店", "items": []}]
            ed = ShopEditor(m)
            ed._list.setCurrentRow(0)
            with patch("tools.editor.shared.confirm.confirm_delete", return_value=False):
                ed._delete()
            self.assertEqual(len(m.shops), 1)

    def test_archive_book_delete_gated_by_confirm(self) -> None:
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.archive_books = [{"id": "b0", "title": "书", "pages": []}]
            ed = ArchiveEditor(m)
            ed._refresh_books()
            ed._book_list.setCurrentRow(0)
            with patch("tools.editor.shared.confirm.confirm_delete", return_value=False):
                ed._del_book()
            self.assertEqual(len(m.archive_books), 1)


if __name__ == "__main__":
    unittest.main()
