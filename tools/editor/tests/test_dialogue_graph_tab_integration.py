"""图对话内嵌 tab 的集成钩子 + 共享控件保值护栏（2026-07-14 审查修复）。

覆盖：
- P2-②：DialogueGraphEditorTab.dirty_state_changed / is_dirty_now / pop_flush_error。
- P3：scripted_lines_editor 空正文行保留已配 speaker/立绘；PortraitRefField 缺 emotion 保值。
"""
from __future__ import annotations

import os
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.editors.dialogue_graph_editor_tab import DialogueGraphEditorTab
from tools.editor.shared.portrait_ref_field import PortraitRefField
from tools.editor.shared.scripted_lines_editor import ScriptedLinesEditor
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

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

    def test_rename_then_edit_save_all_uses_latest_not_stale_snapshot(self) -> None:
        """流程探针：UI 改名 → 继续编辑 → tab flush → model Save All。"""
        from PySide6.QtWidgets import QMessageBox

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            gd = root / "public" / "assets" / "dialogues" / "graphs"
            gd.mkdir(parents=True, exist_ok=True)
            old = gd / "old.json"
            old.write_text(json.dumps({
                "schemaVersion": 1,
                "id": "old",
                "entry": "end",
                "meta": {"title": "old title"},
                "nodes": {"end": {"type": "end"}},
            }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            model = ProjectModel()
            model.load_project(root)
            tab = DialogueGraphEditorTab(model)
            try:
                tab._panel.load_path(old)
                with patch(
                    "tools.dialogue_graph_editor.editor_widget.QInputDialog.getText",
                    return_value=("new", True),
                ), patch(
                    "tools.dialogue_graph_editor.editor_widget.QMessageBox.question",
                    return_value=QMessageBox.StandardButton.Yes,
                ):
                    tab._panel._rename_graph_file_dialog()

                self.assertTrue(old.exists(), "改名只应暂存，Save All 前旧文件仍在")
                self.assertFalse((gd / "new.json").exists())
                self.assertEqual(
                    model.pending_dialogue_graph_edits["new"]["meta"]["title"],
                    "old title",
                )

                # 改名后又改图属性；flush 必须刷新 pending 快照，不能让旧快照反压。
                tab._panel._edit_title.setText("latest title")
                self._pump()
                self.assertTrue(tab.is_dirty_now())
                with patch(
                    "tools.dialogue_graph_editor.editor_widget.QMessageBox.question",
                    return_value=QMessageBox.StandardButton.Yes,
                ):
                    self.assertTrue(tab.flush_to_model(for_save_all=True))
                self.assertEqual(
                    model.pending_dialogue_graph_edits["new"]["meta"]["title"],
                    "latest title",
                )
                from tools.dialogue_graph_editor.flow_layout_store import load_layout_map
                layouts = load_layout_map(root)
                self.assertIn("old.json", layouts, "改名暂存期不得提前丢旧图布局")
                self.assertIn("new.json", layouts, "新 id 布局应可继续编辑")
                with patch(
                    "tools.editor.file_io.StagedJsonWriter.commit",
                    side_effect=OSError("注入的 Save All 提交失败"),
                ):
                    with self.assertRaises(OSError):
                        model.save_all()
                self.assertTrue(old.exists())
                self.assertFalse((gd / "new.json").exists())
                self.assertIn("old.json", load_layout_map(root))
                self.assertIn("new", model.pending_dialogue_graph_edits)
                model.save_all()
                saved = json.loads((gd / "new.json").read_text(encoding="utf-8"))
                self.assertEqual(saved["meta"]["title"], "latest title")
                self.assertFalse(old.exists())
            finally:
                tab.deleteLater()

    def test_delete_button_blocks_referenced_graph_without_touching_model_or_disk(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            gd = root / "public" / "assets" / "dialogues" / "graphs"
            gd.mkdir(parents=True, exist_ok=True)
            target = gd / "used.json"
            target.write_text(json.dumps({
                "schemaVersion": 1, "id": "used", "entry": "end",
                "nodes": {"end": {"type": "end"}},
            }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            scene_path = root / "public" / "assets" / "scenes" / "sc_a.json"
            scene = json.loads(scene_path.read_text(encoding="utf-8"))
            scene["npcs"] = [{"id": "npc", "dialogueGraphId": "used", "dialogueGraphEntry": "end"}]
            scene_path.write_text(json.dumps(scene, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            model = ProjectModel()
            model.load_project(root)
            tab = DialogueGraphEditorTab(model)
            try:
                tab._panel.load_path(target)
                before_disk = target.read_bytes()
                with patch(
                    "tools.dialogue_graph_editor.editor_widget.QMessageBox.warning",
                ) as warning:
                    tab._panel.delete_selected_graph_file()
                self.assertTrue(warning.called)
                self.assertIn("入站引用", str(warning.call_args))
                self.assertEqual(target.read_bytes(), before_disk)
                self.assertEqual(model.pending_dialogue_graph_deletes, set())
                self.assertEqual(model.scenes["sc_a"]["npcs"][0]["dialogueGraphId"], "used")
            finally:
                tab.deleteLater()

    def test_existing_graph_and_item_commit_together_failure_keeps_disk_and_pending(self) -> None:
        """普通已有图也必须等 ProjectModel Save All，不得在 tab.flush 时抢跑写盘。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            gd = root / "public" / "assets" / "dialogues" / "graphs"
            gd.mkdir(parents=True, exist_ok=True)
            graph_path = gd / "normal.json"
            graph_path.write_text(json.dumps({
                "schemaVersion": 1, "id": "normal", "entry": "end",
                "meta": {"title": "before"},
                "nodes": {"end": {"type": "end"}},
            }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            item_path = root / "public" / "assets" / "data" / "items.json"
            graph_before = graph_path.read_bytes()
            item_before = item_path.read_bytes()
            model = ProjectModel()
            model.load_project(root)
            tab = DialogueGraphEditorTab(model)
            try:
                tab._panel.load_path(graph_path)
                tab._panel._edit_title.setText("after")
                self._pump()
                model.items[0]["name"] = "item after"
                model.mark_dirty("item")
                self.assertTrue(tab.flush_to_model(for_save_all=True))

                self.assertEqual(graph_path.read_bytes(), graph_before)
                self.assertEqual(item_path.read_bytes(), item_before)
                self.assertEqual(
                    model.pending_dialogue_graph_edits["normal"]["meta"]["title"],
                    "after",
                )
                self.assertTrue({"dialogue_graph_edits", "item"} <= model._dirty)

                with patch(
                    "tools.editor.file_io.StagedJsonWriter.commit",
                    side_effect=OSError("注入的联合提交失败"),
                ):
                    with self.assertRaises(OSError):
                        model.save_all()
                self.assertEqual(graph_path.read_bytes(), graph_before)
                self.assertEqual(item_path.read_bytes(), item_before)
                self.assertIn("normal", model.pending_dialogue_graph_edits)
                self.assertTrue({"dialogue_graph_edits", "item"} <= model._dirty)

                model.save_all()
                self.assertEqual(
                    json.loads(graph_path.read_text(encoding="utf-8"))["meta"]["title"],
                    "after",
                )
                self.assertEqual(
                    json.loads(item_path.read_text(encoding="utf-8"))[0]["name"],
                    "item after",
                )
                self.assertFalse(model.is_dirty)
                self.assertEqual(model.pending_dialogue_graph_edits, {})
            finally:
                tab.deleteLater()

    def test_staged_existing_graph_baseline_detects_external_edit_after_flush(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            gd = root / "public" / "assets" / "dialogues" / "graphs"
            gd.mkdir(parents=True, exist_ok=True)
            graph_path = gd / "baseline.json"
            graph_path.write_text(json.dumps({
                "schemaVersion": 1, "id": "baseline", "entry": "end",
                "meta": {"title": "before"},
                "nodes": {"end": {"type": "end"}},
            }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            model = ProjectModel()
            model.load_project(root)
            tab = DialogueGraphEditorTab(model)
            try:
                tab._panel.load_path(graph_path)
                tab._panel._edit_title.setText("pending")
                self._pump()
                self.assertTrue(tab.flush_to_model(for_save_all=True))
                baseline_key = model._baseline_key(graph_path)
                self.assertIn(baseline_key, model._file_baselines)

                # flush 之后才有外部程序改盘：MainWindow Save All 的 detect 不得漏掉。
                graph_path.write_text(json.dumps({
                    "schemaVersion": 1, "id": "baseline", "entry": "end",
                    "meta": {"title": "external and longer"},
                    "nodes": {"end": {"type": "end"}},
                }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
                self.assertIn(baseline_key, model.detect_external_changes())
                self.assertEqual(
                    model.pending_dialogue_graph_edits["baseline"]["meta"]["title"],
                    "pending",
                )
            finally:
                tab.deleteLater()

    def test_catalog_signal_is_forwarded_by_tab(self) -> None:
        tab = DialogueGraphEditorTab(self._pm)
        try:
            seen: list[bool] = []
            tab.dialogue_catalog_changed.connect(lambda: seen.append(True))
            tab._panel.catalog_changed.emit()
            self._pump()
            self.assertEqual(seen, [True])
        finally:
            tab.deleteLater()

    def test_navigation_can_open_graph_staged_before_save_all(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            model.pending_dialogue_graph_edits["renamed_live"] = {
                "schemaVersion": 1,
                "id": "renamed_live",
                "entry": "end",
                "nodes": {"end": {"type": "end"}},
            }
            model.mark_dirty("dialogue_graph_edits")
            tab = DialogueGraphEditorTab(model)
            try:
                assert tab._panel is not None
                with patch.object(tab._panel, "load_path") as load_path:
                    tab.open_graph_by_id("renamed_live")
                load_path.assert_called_once()
                self.assertEqual(load_path.call_args.args[0].name, "renamed_live.json")
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
