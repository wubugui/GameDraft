"""文档揭示「涂抹生成模糊图」工具：烘焙同尺寸 PNG、写回 runtime、sidecar 可复编。

只覆盖工具本体（画布/烘焙/落盘/sidecar），不依赖主编辑器集成。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPointF
from PySide6.QtGui import QColor, QImage
from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.shared.document_scribble_painter import (
    DocumentScribblePainterDialog,
    sidecar_path_for,
)
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class DocumentScribblePainterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _project_with_clear(self, root: Path) -> tuple[ProjectModel, Path, QImage]:
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        cdir = m.paths.runtime_images_dir / "illustrations"
        cdir.mkdir(parents=True, exist_ok=True)
        clear = QImage(160, 240, QImage.Format.Format_ARGB32)
        clear.fill(QColor("#cdbfa0"))
        cpath = cdir / "clear.png"
        clear.save(str(cpath), "PNG")
        return m, cpath, clear

    def _scribble(self, dlg: DocumentScribblePainterDialog) -> None:
        cv = dlg._canvas
        cv.set_brush_radius(20)
        cv.set_density(8)
        for i in range(15):
            cv._scribble(QPointF(30 + i * 4, 80), QPointF(34 + i * 4, 120))

    def test_bake_writes_same_size_png_and_url(self) -> None:
        with TemporaryDirectory() as td:
            m, cpath, clear = self._project_with_clear(Path(td) / "p")
            dlg = DocumentScribblePainterDialog(m, cpath, doc_id="告示-甲")
            self._scribble(dlg)
            dlg._canvas.set_baseline(0.25)
            dlg._on_accept()
            url = dlg.result_url()
            self.assertTrue(url and url.startswith("/resources/runtime/images/illustrations/"))
            disk = m.paths.url_to_disk(url, kind="media")
            self.assertIsNotNone(disk)
            self.assertTrue(disk.is_file())
            out = QImage(str(disk))
            self.assertEqual(out.size(), clear.size(), "烘焙图必须与清晰图同尺寸")
            self.assertNotEqual(out, clear, "烘焙图应已被涂抹改变")

    def test_sidecar_saved_and_reloaded(self) -> None:
        with TemporaryDirectory() as td:
            m, cpath, _clear = self._project_with_clear(Path(td) / "p")
            dlg = DocumentScribblePainterDialog(m, cpath, doc_id="告示-乙")
            self._scribble(dlg)
            dlg._on_accept()
            sp = sidecar_path_for(m, "告示-乙")
            self.assertIsNotNone(sp)
            self.assertTrue(sp.is_file(), "涂抹图层 sidecar 应保存到 editor_data")
            # 复开应载入 sidecar（同尺寸非空 ink 层）
            dlg2 = DocumentScribblePainterDialog(m, cpath, doc_id="告示-乙")
            ink = dlg2._canvas.ink_image()
            self.assertFalse(ink.isNull())
            self.assertEqual(ink.size(), QImage(str(cpath)).size())

    def test_existing_blur_url_overwritten_in_place(self) -> None:
        with TemporaryDirectory() as td:
            m, cpath, _clear = self._project_with_clear(Path(td) / "p")
            # 先烘一版，拿到 URL，再以该 URL 复烘 → 应原地覆盖同一文件，URL 不变
            dlg = DocumentScribblePainterDialog(m, cpath, doc_id="告示-丙")
            self._scribble(dlg)
            dlg._on_accept()
            url1 = dlg.result_url()
            dlg2 = DocumentScribblePainterDialog(m, cpath, doc_id="告示-丙", existing_blur_url=url1)
            self._scribble(dlg2)
            dlg2._on_accept()
            self.assertEqual(dlg2.result_url(), url1, "已有模糊图应原地覆盖、URL 不变")

    def test_null_clear_raises(self) -> None:
        with TemporaryDirectory() as td:
            m, _cpath, _clear = self._project_with_clear(Path(td) / "p")
            bad = Path(td) / "nope.png"
            with self.assertRaises(ValueError):
                DocumentScribblePainterDialog(m, bad, doc_id="x")


if __name__ == "__main__":
    unittest.main()
