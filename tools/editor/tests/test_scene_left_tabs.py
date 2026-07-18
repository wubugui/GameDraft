"""左栏「场景 | 实体」双页签（2026-07-18 布局重组二轮，弹窗切换器被否改 tab）流程探针。

场景列表与实体树是两级导航、永不同时使用——页签互斥、各占整栏。从最外层用户入口锁：
真实单击场景项完成切换且**不跳页**（连续浏览不被打断）、双击场景项跳「实体」页、
程序化实体跳转（全局搜索/引用导航消费 select_*_by_id）自动落到「实体」页、
当前场景指示标签跟随、结构锁定（搜索/列表/新建住场景页，模式/过滤/树住实体页）。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class TestSceneLeftTabs(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _bootstrap_editor(self, root: Path) -> SceneEditor:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        # 第二个场景：切换流程需要一个非初始目标；带一个 NPC 供实体跳转探针用
        model.scenes["sc_b"] = {
            "id": "sc_b", "name": "B", "worldWidth": 800, "worldHeight": 600,
            "hotspots": [], "zones": [], "spawnPoints": {},
            "npcs": [{"id": "nb", "name": "NB", "x": 100, "y": 100,
                      "interactionRange": 50}],
        }
        editor = SceneEditor(model)
        editor._refresh_scene_list()
        # itemClicked 族信号只对已 show 的控件派发（离屏实证）；「进入」手势探针
        # 依赖真实 click 信号，统一 show。
        editor._canvas._auto_fit_after_layout = False
        editor.show()
        self._qt_app.processEvents()
        return editor

    def _settle_and_close_editor(self, editor: SceneEditor) -> None:
        canvas = getattr(editor, "_canvas", None)
        if canvas is not None:
            canvas._auto_fit_after_layout = False
            canvas._fit_layout_token += 1
        self._qt_app.processEvents()
        QTest.qWait(360)
        self._qt_app.processEvents()
        editor.close()
        editor.deleteLater()
        self._qt_app.processEvents()

    def _scene_item(self, editor: SceneEditor, sid: str):
        for i in range(editor._scene_list.count()):
            it = editor._scene_list.item(i)
            if it is not None and it.data(Qt.ItemDataRole.UserRole) == sid:
                return it
        return None

    def test_single_click_switches_scene_without_leaving_tab(self) -> None:
        """真实单击场景项：场景切换、当前场景标签跟随、仍停在「场景」页。"""
        with TemporaryDirectory() as td:
            editor = self._bootstrap_editor(Path(td) / "p")
            try:
                self._qt_app.processEvents()
                self.assertEqual(editor._current_scene_id, "sc_a")
                editor._left_tabs.setCurrentIndex(0)

                target = self._scene_item(editor, "sc_b")
                self.assertIsNotNone(target)
                rect = editor._scene_list.visualItemRect(target)
                QTest.mouseClick(
                    editor._scene_list.viewport(), Qt.MouseButton.LeftButton,
                    pos=rect.center())
                self._qt_app.processEvents()

                self.assertEqual(editor._current_scene_id, "sc_b")
                self.assertIn("sc_b", editor._current_scene_lab.toolTip())
                # 单击只切换不跳页：连续浏览场景不被打断
                self.assertEqual(editor._left_tabs.currentIndex(), 0)
            finally:
                self._settle_and_close_editor(editor)

    def test_double_click_scene_jumps_to_entity_tab(self) -> None:
        """快速双击「进入」（itemDoubleClicked 快路径）。

        离屏平台的 mouseDClick 只发孤立 DblClick 事件（无 press 前导），
        QAbstractItemView 见 pressedIndex 无效会把它降级为合成 press、不发
        doubleClicked——按真实平台事件序列先 click 建立 pressedIndex 再 dclick。"""
        with TemporaryDirectory() as td:
            editor = self._bootstrap_editor(Path(td) / "p")
            try:
                self._qt_app.processEvents()
                editor._left_tabs.setCurrentIndex(0)
                target = self._scene_item(editor, "sc_b")
                rect = editor._scene_list.visualItemRect(target)
                QTest.mouseClick(
                    editor._scene_list.viewport(), Qt.MouseButton.LeftButton,
                    pos=rect.center())
                self._qt_app.processEvents()
                self.assertEqual(editor._left_tabs.currentIndex(), 0)
                QTest.mouseDClick(
                    editor._scene_list.viewport(), Qt.MouseButton.LeftButton,
                    pos=rect.center())
                self._qt_app.processEvents()

                self.assertEqual(editor._current_scene_id, "sc_b")
                self.assertEqual(editor._left_tabs.currentIndex(), 1)
            finally:
                self._settle_and_close_editor(editor)

    def test_second_click_on_current_scene_enters_entity_tab(self) -> None:
        """慢速双击 = 两次单击：第一击切换不跳页，第二击（已当前场景）进入实体页。"""
        with TemporaryDirectory() as td:
            editor = self._bootstrap_editor(Path(td) / "p")
            try:
                self._qt_app.processEvents()
                editor._left_tabs.setCurrentIndex(0)
                target = self._scene_item(editor, "sc_b")
                rect = editor._scene_list.visualItemRect(target)
                QTest.mouseClick(
                    editor._scene_list.viewport(), Qt.MouseButton.LeftButton,
                    pos=rect.center())
                self._qt_app.processEvents()
                self.assertEqual(editor._current_scene_id, "sc_b")
                self.assertEqual(editor._left_tabs.currentIndex(), 0)

                QTest.mouseClick(
                    editor._scene_list.viewport(), Qt.MouseButton.LeftButton,
                    pos=rect.center())
                self._qt_app.processEvents()
                self.assertEqual(editor._left_tabs.currentIndex(), 1)
            finally:
                self._settle_and_close_editor(editor)

    def test_programmatic_entity_jump_lands_on_entity_tab(self) -> None:
        """select_npc_by_id（全局搜索/引用导航通路）：切场景 + 跳「实体」页 + 画布选中。"""
        with TemporaryDirectory() as td:
            editor = self._bootstrap_editor(Path(td) / "p")
            try:
                self._qt_app.processEvents()
                editor._left_tabs.setCurrentIndex(0)
                editor.select_npc_by_id("nb", "sc_b")
                self._qt_app.processEvents()

                self.assertEqual(editor._current_scene_id, "sc_b")
                self.assertEqual(editor._left_tabs.currentIndex(), 1)
                it = editor._canvas._entity_items.get("npc:nb")
                self.assertIsNotNone(it)
                self.assertTrue(it.isSelected())
            finally:
                self._settle_and_close_editor(editor)

    def test_programmatic_scene_jump_still_works(self) -> None:
        with TemporaryDirectory() as td:
            editor = self._bootstrap_editor(Path(td) / "p")
            try:
                self._qt_app.processEvents()
                editor.select_scene_by_id("sc_b")
                self._qt_app.processEvents()
                self.assertEqual(editor._current_scene_id, "sc_b")
            finally:
                self._settle_and_close_editor(editor)

    def test_tab_structure_lock(self) -> None:
        """结构锁：搜索/列表/新建住「场景」页，模式/过滤/树住「实体」页。"""
        with TemporaryDirectory() as td:
            editor = self._bootstrap_editor(Path(td) / "p")
            try:
                tabs = editor._left_tabs
                self.assertEqual(tabs.count(), 2)
                self.assertEqual(tabs.tabText(0), "场景")
                self.assertEqual(tabs.tabText(1), "实体")

                def _tab_of(w) -> int:
                    for idx in (0, 1):
                        page = tabs.widget(idx)
                        if page is not None and page.isAncestorOf(w):
                            return idx
                    return -1

                self.assertEqual(_tab_of(editor._scene_search), 0)
                self.assertEqual(_tab_of(editor._scene_list), 0)
                self.assertEqual(_tab_of(editor._btn_new_scene), 0)
                self.assertEqual(_tab_of(editor._tree_mode), 1)
                self.assertEqual(_tab_of(editor._tree_filter), 1)
                self.assertEqual(_tab_of(editor._entity_tree), 1)
            finally:
                self._settle_and_close_editor(editor)


if __name__ == "__main__":
    unittest.main()
