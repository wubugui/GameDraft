"""音频 System SFX 跳转 / 下拉刷新 / confirm_close + Strings 部分命中(审查 P2/P3)。

- System SFX 子页第 0 列是 cellWidget(IdRefSelector),select_by_id 必须走 _key_at
  才能命中,并返回 bool(导航诚实化)。
- SFX 子页 Apply 后 System SFX 的 sfx id 下拉候选立即刷新。
- Audio confirm_close:Discard 回滚 UI,不复活被放弃的编辑。
- string_editor.select_by_pointer 区分完整命中(True)/部分命中("partial:…")/未命中(False)。
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QMessageBox

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        m = ProjectModel()
        m.load_project(root)
        return m


class TestAudioSystemSfxNav(_Base):
    def test_select_by_id_hits_system_sfx_key(self) -> None:
        from tools.editor.editors.audio_editor import AudioEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.audio_config["systemSfx"] = {"questAccepted": "sfx_ding"}
            ed = AudioEditor(m)
            # System SFX 子页键在 cellWidget 里,item(r,0) 恒 None——此前恒失败
            self.assertTrue(ed.select_by_id("questAccepted"))
            # 断言"切到了 System SFX 那一页"，不是"切到了第 3 页"——
            # 页序会随频道增减变化，钉死数字的断言迟早红在无关改动上
            self.assertIs(
                ed._tabs.widget(ed._tabs.currentIndex()), ed.system_sfx_tab(),
                "应切到 System SFX 子页")

    def test_select_by_id_miss_returns_false(self) -> None:
        from tools.editor.editors.audio_editor import AudioEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.audio_config["systemSfx"] = {"questAccepted": "sfx_ding"}
            ed = AudioEditor(m)
            self.assertFalse(ed.select_by_id("does_not_exist"))

    def test_select_by_id_hits_channel_id(self) -> None:
        from tools.editor.editors.audio_editor import AudioEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.audio_config["bgm"] = {"bgm_town": {"src": "/resources/runtime/audio/a.wav"}}
            ed = AudioEditor(m)
            self.assertTrue(ed.select_by_id("bgm_town"))
            self.assertEqual(ed._tabs.currentIndex(), 0)

    def test_sfx_apply_refreshes_system_sfx_choices(self) -> None:
        from tools.editor.editors.audio_editor import (
            AudioEditor, AudioIdPreviewSelector,
        )
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.audio_config["sfx"] = {}
            m.audio_config["systemSfx"] = {"questAccepted": ""}
            ed = AudioEditor(m)
            # 按名取，不按下标：加一个频道页就会把下标全顶偏（加 voice 页时踩过）
            sfx_tab = ed.channel_tab("sfx")
            sys_tab = ed.system_sfx_tab()
            # 在 SFX 子页新增一行 id,Apply
            sfx_tab.add_row("sfx_new")
            sfx_tab._apply()  # 触发 applied → sys_tab.refresh_sfx_choices
            self.assertIn("sfx_new", m.all_audio_ids("sfx"))
            # System SFX 第 0 行的 sfx 选择器候选应立即含 sfx_new
            sel = sys_tab._table.cellWidget(0, 1)
            self.assertIsInstance(sel, AudioIdPreviewSelector)
            self.assertIn(
                "sfx_new", sel.item_ids(),
                f"SFX 子页 Apply 后 System SFX 候选应立即含新 id;实际={sel.item_ids()}")

    def test_confirm_close_discard_rolls_back(self) -> None:
        from tools.editor.editors.audio_editor import AudioEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.audio_config["bgm"] = {"bgm_a": {"src": "/resources/runtime/audio/a.wav"}}
            ed = AudioEditor(m)
            # 在 BGM 子页新增一行未 Apply
            bgm = ed.channel_tab("bgm")
            bgm.add_row("bgm_unsaved")
            self.assertTrue(ed._is_dirty())
            with patch.object(QMessageBox, "question",
                              return_value=QMessageBox.StandardButton.Discard):
                self.assertTrue(ed.confirm_close(None))
            self.assertFalse(ed._is_dirty(), "Discard 后应回滚 UI,不再判脏")
            self.assertTrue(ed.flush_to_model())
            self.assertNotIn("bgm_unsaved", m.audio_config.get("bgm", {}),
                             "被放弃的编辑不得经统一 flush 复活")


class TestArchiveConfirmClose(_Base):
    def test_discard_rolls_back_and_neutralizes(self) -> None:
        from tools.editor.editors.archive_editor import ArchiveEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.archive_characters = [
                {"id": "c0", "name": "Old0", "title": "", "impressions": [],
                 "knownInfo": []},
            ]
            ed = ArchiveEditor(m)
            ed._refresh_chars()
            ed._char_list.setCurrentRow(0)
            ed._ch_name.setText("被放弃的编辑")  # 未 Apply
            dirty_before = "archive" in m._dirty
            with patch.object(QMessageBox, "question",
                              return_value=QMessageBox.StandardButton.Discard):
                self.assertTrue(ed.confirm_close(None))
            # 模型内容回滚,统一 flush 不复活被放弃编辑
            self.assertEqual(m.archive_characters[0]["name"], "Old0")
            self.assertEqual("archive" in m._dirty, dirty_before,
                             "Discard 后不得残留 archive 伪脏")
            ed.flush_to_model()
            self.assertEqual(m.archive_characters[0]["name"], "Old0")

    def test_no_edit_no_prompt(self) -> None:
        from tools.editor.editors.archive_editor import ArchiveEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.archive_characters = [
                {"id": "c0", "name": "Old0", "title": "", "impressions": [],
                 "knownInfo": []},
            ]
            ed = ArchiveEditor(m)
            ed._refresh_chars()
            ed._char_list.setCurrentRow(0)
            called = {"q": False}
            with patch.object(QMessageBox, "question",
                              side_effect=lambda *a, **k: called.__setitem__("q", True)):
                self.assertTrue(ed.confirm_close(None))
            self.assertFalse(called["q"], "无编辑时不应弹保存询问")


class TestStringPartialHit(_Base):
    def test_full_partial_miss(self) -> None:
        from tools.editor.editors.string_editor import StringEditor
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            m.strings = {"ui": {"ok": "确定", "cancel": "取消"}}
            ed = StringEditor(m)
            ed._refresh()
            # 完整命中
            self.assertIs(ed.select_by_pointer(["ui", "ok"]), True)
            # 部分命中:分类在,末级键不在
            res = ed.select_by_pointer(["ui", "missing_key"])
            self.assertIsInstance(res, str)
            self.assertTrue(res.startswith("partial:"))
            self.assertIn("ui", res)
            # 彻底未命中
            self.assertIs(ed.select_by_pointer(["nope"]), False)


if __name__ == "__main__":
    unittest.main()


class TestAudioColumnsPopulated(unittest.TestCase):
    """打开面板时「引用」列必须已经填好——四个频道页一个都不能漏。

    由来：给音频面板加「配音」页时，我把 `refresh_reference_counts()` 挤到了
    `return` 后面变成死代码，四个页的引用列**全空**，而全套 1489 条测试一条没红——
    因为没有任何测试断言过"这一列有值"。用户开面板一眼就看见了，测试却看不见。

    必须拿**真实工程**测：引用统计对空工程返回空字典，而空字典时留空是设计内行为
    （"还没扫过"≠"扫过了是 0"）。拿最小 fixture 测会得到一条恒绿的假护栏。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        from tools.editor.project_model import ProjectModel
        from tools.editor.tests.save_test_utils import repo_root_from_tests

        cls._pm = ProjectModel()
        cls._pm.load_project(repo_root_from_tests())

    def test_reference_column_filled_on_open_for_every_channel(self) -> None:
        from tools.editor.editors.audio_editor import AudioEditor, _COL_REFS
        from tools.editor.shared import audio_library as lib

        ed = AudioEditor(self._pm)
        self.addCleanup(ed.deleteLater)
        for ch in lib.AUDIO_CHANNELS:
            tab = ed.channel_tab(ch)
            self.assertGreater(tab._table.rowCount(), 0, f"{ch} 页应有行")
            blank = [
                r for r in range(tab._table.rowCount())
                if (tab._table.item(r, _COL_REFS) is None
                    or not tab._table.item(r, _COL_REFS).text().strip())
            ]
            self.assertEqual(
                blank, [],
                f"{ch} 页有 {len(blank)} 行的「引用」列是空的——引用统计没跑"
                f"（0 次也要显示 '0'，空白表示压根没算）",
            )
