"""ProjectModel.save_all 契约：无 dirty 不写盘；校验失败不写盘；按 dirty 增量写。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel


class TestProjectSaveAll(unittest.TestCase):
    """需要 Qt Gui 上下文：ProjectModel(QObject) / QUndoStack。"""

    @classmethod
    def setUpClass(cls) -> None:
        if QApplication.instance() is None:
            cls._qt_app = QApplication(sys.argv)
        else:
            cls._qt_app = QApplication.instance()

    def _temp_project_root(self, tmp_root: Path) -> Path:
        root = Path(tmp_root) / "pj"
        (root / "public" / "assets" / "data").mkdir(parents=True, exist_ok=True)
        (root / "public" / "assets" / "scenes").mkdir(parents=True, exist_ok=True)
        return root

    def test_clean_save_skips_writes(self) -> None:
        with TemporaryDirectory() as td:
            root = self._temp_project_root(Path(td))
            m = ProjectModel()
            m.project_path = root
            m.cutscenes = [{"id": "c1"}]
            written: list[Path] = []

            def cap(p: Path, _data):
                written.append(Path(p))

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value=None,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value=None,
            ), patch(
                "tools.editor.project_model.write_json", side_effect=cap,
            ):
                m.save_all()
            self.assertEqual(written, [])

    def test_validation_error_no_write(self) -> None:
        with TemporaryDirectory() as td:
            root = self._temp_project_root(Path(td))
            m = ProjectModel()
            m.project_path = root
            m.cutscenes = []
            m.mark_dirty("cutscene")
            calls: list[tuple[str, Path]] = []

            def fail_write(p: Path, _data):
                calls.append(("write", Path(p)))

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value="引用校验失败 stub",
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value=None,
            ), patch(
                "tools.editor.project_model.write_json", side_effect=fail_write,
            ):
                with self.assertRaises(ValueError):
                    m.save_all()
            self.assertEqual(calls, [])
            self.assertTrue(m.is_dirty)

    def test_only_cutscene_dirty_writes_cutscene_index_only(self) -> None:
        with TemporaryDirectory() as td:
            root = self._temp_project_root(Path(td))
            m = ProjectModel()
            m.project_path = root
            m.cutscenes = [{"id": "cz", "steps": []}]
            m.mark_dirty("cutscene")

            paths: list[Path] = []

            def capture(p: Path, _data):
                paths.append(Path(p))

            with patch(
                "tools.editor.shared.ref_validator.validate_refs_for_save",
                return_value=None,
            ), patch(
                "tools.editor.scenarios_catalog_validate.validate_scenarios_catalog_for_save",
                return_value=None,
            ), patch(
                "tools.editor.project_model.write_json", side_effect=capture,
            ):
                m.save_all()

            data_root = root / "public" / "assets" / "data"
            cut_path = data_root / "cutscenes" / "index.json"
            self.assertEqual(paths, [cut_path])
            self.assertFalse(m.is_dirty)
