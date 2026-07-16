"""Save All 不连坐 + 导航诚实化 流程护栏(审查 P1-11 / P1-16 / 导航契约)。

P1-11:单面板 flush 返回 False 不再 raise 中断全局——记录跳过原因、继续其余面板
flush 与 model.save_all(),保存后弹警告列出被跳过面板。
P1-16:lore 档案跳转经 _lore_entries() 归一化,不再恒返 False。
导航契约:_nav_hit_generic 消费 select_* 的 True/False/None 三态,分别报
「已定位」/「未找到…请重新搜索」(不聚光)/「已打开页」(不聚光)。
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("GAMEDRAFT_EDITOR_NO_LSP", "1")

from PySide6.QtWidgets import QApplication, QMessageBox

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class _StubGoodPanel:
    """flush 成功的桩面板。"""

    def __init__(self) -> None:
        self.flushed = False

    def flush_to_model(self, for_save_all: bool = False) -> bool:
        self.flushed = True
        return True


class _StubBadPanel:
    """flush 返回 False + 带 pop_flush_error 原因的桩面板。"""

    def __init__(self, reason: str) -> None:
        self._reason = reason
        self.flushed = False

    def flush_to_model(self, for_save_all: bool = False) -> bool:
        self.flushed = True
        return False

    def pop_flush_error(self) -> str:
        return self._reason


class _StubTypeErrorInBody:
    """flush **接受** for_save_all 但**函数体内**抛 TypeError(如坏数据 int(None))。

    E 修复(对抗组 V5):旧的 catch-TypeError-retry 会把体内 TypeError 误当旧签名、
    回退再调一次 flush——累加型 flush 被静默执行两次。修复后必须只调 1 次并记为失败。
    """

    def __init__(self) -> None:
        self.calls = 0

    def flush_to_model(self, for_save_all: bool = False) -> bool:
        self.calls += 1
        int(None)  # 体内 TypeError(模拟坏数据),而非签名不匹配
        return True


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _window(self, root: Path):
        """构造 MainWindow 但只在模型层加载工程——绕过 win.load_project 的
        _populate_tabs(它会实例化内嵌 Web 编辑器,在离屏无头下阻塞)。测试只关心
        Save All / flush / 导航的流程逻辑,面板用桩替换。"""
        from tools.editor.main_window import MainWindow
        write_minimal_loadable_project(root)
        win = MainWindow()
        win._model.load_project(root)
        self.addCleanup(win.deleteLater)
        return win


class TestSaveAllNoCascade(_Base):
    def test_bad_panel_does_not_block_other_buckets(self) -> None:
        with TemporaryDirectory() as td:
            win = self._window(Path(td) / "p")
            good = _StubGoodPanel()
            bad = _StubBadPanel("图对话:外部冲突,用户选择不覆盖")
            # 用桩面板替换真实实例栈,并制造一处真实脏数据(item)确认照常落盘
            win._editor_instances = [good, bad]
            win._editor_labels = ["Item", "图对话"]
            win._model.items.append(
                {"id": "i_new", "name": "x", "type": "consumable",
                 "description": "", "maxStack": 1})
            win._model.mark_dirty("item")

            warned: list = []
            saved = {"called": False}
            orig_save = win._model.save_all

            def _track_save():
                saved["called"] = True
                orig_save()

            with patch.object(QMessageBox, "warning",
                              side_effect=lambda *a, **k: warned.append(a)):
                with patch.object(win._model, "save_all", side_effect=_track_save):
                    ok = win._save_all()

            self.assertTrue(ok, "有面板被跳过时 Save All 仍应完成其余保存")
            self.assertTrue(good.flushed, "健康面板照常 flush")
            self.assertTrue(bad.flushed, "坏面板也被调用(不是提前中断)")
            self.assertTrue(saved["called"], "model.save_all 必须照常执行(不被一票否决)")
            self.assertTrue(warned, "被跳过的面板必须弹警告告知")
            joined = " ".join(str(x) for a in warned for x in a)
            self.assertIn("图对话", joined)
            self.assertIn("外部冲突", joined)
            # item 桶已落盘、脏标记已清
            self.assertNotIn("item", win._model._dirty)

    def test_all_good_panels_no_warning(self) -> None:
        with TemporaryDirectory() as td:
            win = self._window(Path(td) / "p")
            win._editor_instances = [_StubGoodPanel(), _StubGoodPanel()]
            win._editor_labels = ["Item", "图对话"]
            warned: list = []
            with patch.object(QMessageBox, "warning",
                              side_effect=lambda *a, **k: warned.append(a)):
                ok = win._save_all()
            self.assertTrue(ok)
            self.assertEqual(warned, [], "全部成功时不应弹被跳过警告")


class TestFlushReturnsSkipList(_Base):
    def test_flush_editors_returns_skipped(self) -> None:
        with TemporaryDirectory() as td:
            win = self._window(Path(td) / "p")
            win._editor_instances = [
                _StubGoodPanel(), _StubBadPanel("原因A"),
            ]
            win._editor_labels = ["Item", "图对话"]
            ok, skipped = win._flush_editors_to_model()
            self.assertTrue(ok)
            self.assertEqual(len(skipped), 1)
            name, reason = skipped[0]
            self.assertEqual(name, "图对话")
            self.assertIn("原因A", reason)

    def test_flush_exception_is_recorded_not_raised(self) -> None:
        class _Boom:
            def flush_to_model(self, for_save_all: bool = False) -> bool:
                raise RuntimeError("炸了")

        with TemporaryDirectory() as td:
            win = self._window(Path(td) / "p")
            after = _StubGoodPanel()
            win._editor_instances = [_Boom(), after]
            win._editor_labels = ["坏页", "Item"]
            ok, skipped = win._flush_editors_to_model()
            self.assertTrue(ok, "异常面板不应中断整个 flush")
            self.assertTrue(after.flushed, "异常面板之后的面板仍被 flush")
            self.assertEqual(len(skipped), 1)
            self.assertIn("炸了", skipped[0][1])

    def test_typeerror_in_flush_body_not_double_called(self) -> None:
        """E 修复(V5):flush 接受 for_save_all 但体内抛 TypeError 时,只调 1 次、记为
        失败、不中断其余面板。旧的 catch-TypeError-retry 会二次执行(call count=2)。"""
        with TemporaryDirectory() as td:
            win = self._window(Path(td) / "p")
            boom = _StubTypeErrorInBody()
            after = _StubGoodPanel()
            win._editor_instances = [boom, after]
            win._editor_labels = ["坏页", "Item"]
            ok, skipped = win._flush_editors_to_model()
            self.assertTrue(ok, "体内 TypeError 不应中断整个 flush")
            self.assertEqual(boom.calls, 1, "flush 只能被调 1 次——绝不回退重试二次执行")
            self.assertTrue(after.flushed, "体内 TypeError 面板之后的面板仍被 flush")
            self.assertEqual(len(skipped), 1)
            self.assertEqual(skipped[0][0], "坏页")
            self.assertIn("flush 异常", skipped[0][1])


class TestLoreNavigationAndHonesty(_Base):
    def test_lore_select_entry_locates(self) -> None:
        """P1-16:lore 是 dict(categories+entries),select_entry 须归一化后命中。"""
        from tools.editor.editors.archive_editor import ArchiveEditor
        with TemporaryDirectory() as td:
            m = ProjectModel()
            write_minimal_loadable_project(Path(td) / "p")
            m.load_project(Path(td) / "p")
            m.archive_lore = {
                "categories": {"legend": "传说"},
                "entries": [
                    {"id": "lore_a", "title": "甲", "content": "", "category": "legend"},
                    {"id": "lore_b", "title": "乙", "content": "", "category": "legend"},
                ],
            }
            ed = ArchiveEditor(m)
            ed._refresh_lore()
            self.assertTrue(ed.select_entry("lore", "lore_b"))
            self.assertEqual(ed._lore_list.currentRow(), 1)
            self.assertFalse(ed.select_entry("lore", "nonexistent"))

    def test_lore_select_clears_filter(self) -> None:
        from tools.editor.editors.archive_editor import ArchiveEditor
        with TemporaryDirectory() as td:
            m = ProjectModel()
            write_minimal_loadable_project(Path(td) / "p")
            m.load_project(Path(td) / "p")
            m.archive_lore = {
                "entries": [
                    {"id": "lore_a", "title": "甲", "content": ""},
                    {"id": "lore_b", "title": "乙", "content": ""},
                ],
            }
            ed = ArchiveEditor(m)
            ed._refresh_lore()
            ed._lore_search.setText("甲")  # 过滤到只剩 lore_a
            self.assertTrue(ed.select_entry("lore", "lore_b"))
            self.assertEqual(ed._lore_search.text(), "", "定位前应清空过滤框")
            self.assertFalse(ed._lore_list.item(1).isHidden(), "目标行必须可见")

    def test_nav_hit_generic_three_states(self) -> None:
        with TemporaryDirectory() as td:
            win = self._window(Path(td) / "p")

            class _BoolPanel:
                def __init__(self, ret):
                    self._ret = ret
                def select_by_id(self, sid, *a):
                    return self._ret

            # True → 已定位
            win._editor_instances = [_BoolPanel(True)]
            win._editor_labels = ["Item"]
            with patch.object(win, "_show_page_by_label",
                              return_value=win._editor_instances[0]):
                ok, note = win._nav_hit_generic("Item", "x")
            self.assertIs(ok, True)
            self.assertIn("已定位", note)

            # False → 未找到,请重新搜索(不聚光)
            win._editor_instances = [_BoolPanel(False)]
            with patch.object(win, "_show_page_by_label",
                              return_value=win._editor_instances[0]):
                ok, note = win._nav_hit_generic("Item", "x")
            self.assertIs(ok, False)
            self.assertIn("未找到", note)

            # None(旧接口)→ 已打开页(不聚光)
            win._editor_instances = [_BoolPanel(None)]
            with patch.object(win, "_show_page_by_label",
                              return_value=win._editor_instances[0]):
                ok, note = win._nav_hit_generic("Item", "x")
            self.assertIsNone(ok)
            self.assertIn("已打开", note)


if __name__ == "__main__":
    unittest.main()
