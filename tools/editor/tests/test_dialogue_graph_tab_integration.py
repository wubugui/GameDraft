"""图对话内嵌 tab 的集成钩子 + 共享控件保值护栏（2026-07-14 审查修复）。

覆盖：
- P2-②：DialogueGraphEditorTab.dirty_state_changed / is_dirty_now / pop_flush_error。
- P3：scripted_lines_editor 空正文行保留已配 speaker/立绘；PortraitRefField 缺 emotion 保值。
"""
from __future__ import annotations

import os
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.editors.dialogue_graph_editor_tab import DialogueGraphEditorTab
from tools.editor.shared.portrait_ref_field import PortraitRefField
from tools.editor.shared.scripted_lines_editor import ScriptedLinesEditor

_PROJECT_ROOT = Path(__file__).resolve().parents[3]


class DialogueGraphTabHooksTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _pump(self) -> None:
        for _ in range(5):
            self._app.processEvents()

    def test_dirty_signal_and_is_dirty_now(self) -> None:
        tab = DialogueGraphEditorTab(self._pm)
        try:
            seen: list[bool] = []
            tab.dirty_state_changed.connect(seen.append)
            self.assertFalse(tab.is_dirty_now())
            tab._panel.create_new_graph_draft()
            self._pump()
            self.assertTrue(tab.is_dirty_now())
            self.assertTrue(seen and seen[-1] is True, f"未收到脏态信号：{seen}")
        finally:
            tab.deleteLater()

    def test_untouched_new_draft_flush_skips_and_keeps_dirty(self) -> None:
        tab = DialogueGraphEditorTab(self._pm)
        try:
            tab._panel.create_new_graph_draft()
            self._pump()
            # Save All 语义：未编辑草稿跳过写盘、返回 True、保留脏态、无失败原因
            self.assertTrue(tab.flush_to_model(for_save_all=True))
            self.assertTrue(tab.is_dirty_now())
            self.assertEqual(tab.pop_flush_error(), "")
        finally:
            tab.deleteLater()

    def test_pop_flush_error_after_failed_save(self) -> None:
        tab = DialogueGraphEditorTab(self._pm)
        try:
            tab._panel.create_new_graph_draft()
            self._pump()
            # 编辑一下，使其不再是「未编辑草稿」，从而 flush 会真的尝试 save()
            tab._panel._model.add_node("x", {"type": "end"})
            # 让 save() 失败：直接注入失败原因 + 打桩 save 返回 False，
            # 断言 flush 组装出中文降级原因供主窗 pop。
            tab._panel.save = lambda: False  # type: ignore[method-assign]
            tab._panel.last_save_failure_reason = lambda: "图有 1 处校验错误，未确认强制保存"  # type: ignore[method-assign]
            self.assertFalse(tab.flush_to_model(for_save_all=True))
            msg = tab.pop_flush_error()
            self.assertIn("图对话", msg)
            self.assertIn("保存被跳过", msg)
            self.assertIn("仍保留在图对话编辑器中", msg)
            # pop 后清空
            self.assertEqual(tab.pop_flush_error(), "")
        finally:
            tab.deleteLater()


class ScriptedLinesEmptyTextTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def test_empty_text_with_speaker_is_kept(self) -> None:
        ed = ScriptedLinesEditor(
            [{"speaker": "阿秀", "text": ""}], model=self._pm, scene_id=None
        )
        try:
            out = ed.to_list()
            self.assertEqual(len(out), 1, f"配了 speaker 的空文本行被丢：{out}")
            self.assertEqual(out[0]["speaker"], "阿秀")
        finally:
            ed.deleteLater()

    def test_fully_empty_row_is_dropped(self) -> None:
        ed = ScriptedLinesEditor([{"speaker": "", "text": ""}], model=self._pm)
        try:
            self.assertEqual(ed.to_list(), [])
        finally:
            ed.deleteLater()


class PortraitRefFieldFidelityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def test_missing_emotion_is_preserved_verbatim(self) -> None:
        field = PortraitRefField(_PROJECT_ROOT, {"slug": "someset"})
        try:
            self.assertEqual(field.to_ref(), {"slug": "someset"})
        finally:
            field.deleteLater()

    def test_empty_dict_portrait_preserved(self) -> None:
        field = PortraitRefField(_PROJECT_ROOT, {})
        try:
            self.assertEqual(field.to_ref(), {})
        finally:
            field.deleteLater()

    def test_none_is_still_none(self) -> None:
        field = PortraitRefField(_PROJECT_ROOT, None)
        try:
            self.assertIsNone(field.to_ref())
        finally:
            field.deleteLater()


if __name__ == "__main__":
    unittest.main()
