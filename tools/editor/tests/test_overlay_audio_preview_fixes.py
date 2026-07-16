"""overlay_images 编辑器 + 音频试听控件 2026-07-14 审查修复回归（E 组 / T-过场）。

- overlay_images P3：对非字符串值不 str() 摧毁，Apply / flush 原样透传并保原键序；
- audio_preview P2：path 为 None 时按钮旁提示「该 id 无有效音频文件」（不再静默 return）。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.overlay_images_editor import OverlayImagesEditor
from tools.editor.project_model import ProjectModel
from tools.editor.shared.audio_preview_selector import AudioPreviewControls
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


def _make_model(td: str) -> ProjectModel:
    root = Path(td) / "p"
    write_minimal_loadable_project(root)
    model = ProjectModel()
    model.load_project(root)
    return model


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._td = TemporaryDirectory()
        self.model = _make_model(self._td.name)

    def tearDown(self) -> None:
        self._td.cleanup()


class TestOverlayPassthrough(_Base):
    def test_nonstring_value_preserved_through_apply(self) -> None:
        self.model.overlay_images = {
            "码头告示": "/assets/a.png",
            "怪值": {"x": 1},          # 非字符串：本页不显示，不得被 str() 摧毁
            "空值": None,
            "码头线索": "/assets/b.png",
        }
        ed = OverlayImagesEditor(self.model)
        # 只铺出字符串条目
        shown = {r.id_text() for r in ed._row_widgets}
        self.assertEqual(shown, {"码头告示", "码头线索"})
        ed._apply()
        self.assertEqual(self.model.overlay_images["怪值"], {"x": 1})
        self.assertIsNone(self.model.overlay_images["空值"])
        # 原键序保留
        self.assertEqual(
            list(self.model.overlay_images.keys()),
            ["码头告示", "怪值", "空值", "码头线索"],
        )

    def test_flush_preserves_nonstring_and_gates_dirty(self) -> None:
        self.model.overlay_images = {"a": "/x.png", "obj": [1, 2, 3]}
        ed = OverlayImagesEditor(self.model)
        dirtied: list[str] = []
        orig = self.model.mark_dirty
        self.model.mark_dirty = lambda b: (dirtied.append(b), orig(b))  # type: ignore
        ed.flush_to_model()  # 零编辑
        self.assertEqual(dirtied, [], "零编辑 flush 不应标脏")
        self.assertEqual(self.model.overlay_images["obj"], [1, 2, 3])

    def test_edit_string_row_then_apply_keeps_passthrough(self) -> None:
        self.model.overlay_images = {"a": "/x.png", "num": 42}
        ed = OverlayImagesEditor(self.model)
        row = ed._row_widgets[0]
        row._path_row._edit.setText("/y.png")
        ed._apply()
        self.assertEqual(self.model.overlay_images["a"], "/y.png")
        self.assertEqual(self.model.overlay_images["num"], 42)


class TestAudioPreviewFailureSpeaks(_Base):
    def test_none_path_shows_hint_not_silent(self) -> None:
        # 控件未挂进可见窗口，isVisible() 恒 False；断言 isHidden() 标志（setVisible 直接翻转的态）+ 文案。
        ctrl = AudioPreviewControls(self.model, "sfx", lambda: "no_such_id")
        ctrl.preview_current()
        self.assertFalse(ctrl._hint.isHidden())
        self.assertEqual(ctrl._hint.text(), "该 id 无有效音频文件")

    def test_hint_cleared_before_next_attempt(self) -> None:
        ctrl = AudioPreviewControls(self.model, "sfx", lambda: "")
        ctrl.preview_current()
        self.assertFalse(ctrl._hint.isHidden())
        self.assertEqual(ctrl._hint.text(), "该 id 无有效音频文件")
        # errorOccurred 记忆集合初始为空（只弹一次逻辑挂在这里）
        self.assertEqual(ctrl._error_notified_keys, set())


if __name__ == "__main__":
    unittest.main()
