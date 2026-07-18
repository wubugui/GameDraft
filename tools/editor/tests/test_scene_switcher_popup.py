"""场景切换器弹窗（2026-07-18 左栏布局重组）流程探针。

布局重组把场景列表从左栏常驻位降级为「切换按钮 + 带搜索弹窗」，实体树独占左栏。
这里从最外层用户入口锁三件事：真实点击按钮弹出弹窗、点选场景项完成切换并收起、
程序化 select_scene_by_id 通路（全局搜索/引用导航消费）不受布局重组影响且按钮跟随。
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


class TestSceneSwitcherPopup(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _bootstrap_editor(self, root: Path) -> SceneEditor:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        # 第二个场景：切换流程需要一个非初始目标
        model.scenes["sc_b"] = {
            "id": "sc_b", "name": "B", "worldWidth": 800, "worldHeight": 600,
            "hotspots": [], "npcs": [], "zones": [], "spawnPoints": {},
        }
        editor = SceneEditor(model)
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

    def test_switch_scene_via_button_and_popup_click(self) -> None:
        """真实点击：切换按钮 → 弹窗可见 → 点场景项 → 场景切换且弹窗收起。"""
        with TemporaryDirectory() as td:
            editor = self._bootstrap_editor(Path(td) / "p")
            try:
                self._qt_app.processEvents()
                # 构造期 _refresh_scene_list 选中首场景（排序后 sc_a）
                self.assertEqual(editor._current_scene_id, "sc_a")
                self.assertFalse(editor._scene_popup.isVisible())

                QTest.mouseClick(
                    editor._scene_switch_btn, Qt.MouseButton.LeftButton)
                self._qt_app.processEvents()
                self.assertTrue(editor._scene_popup.isVisible())
                # 打开弹窗只是对齐 current，不得触发同场景重载改变当前场景
                self.assertEqual(editor._current_scene_id, "sc_a")

                target = None
                for i in range(editor._scene_list.count()):
                    it = editor._scene_list.item(i)
                    if it is not None and it.data(Qt.ItemDataRole.UserRole) == "sc_b":
                        target = it
                        break
                self.assertIsNotNone(target)
                rect = editor._scene_list.visualItemRect(target)
                QTest.mouseClick(
                    editor._scene_list.viewport(), Qt.MouseButton.LeftButton,
                    pos=rect.center())
                self._qt_app.processEvents()

                self.assertEqual(editor._current_scene_id, "sc_b")
                self.assertFalse(editor._scene_popup.isVisible())
                self.assertIn("sc_b", editor._scene_switch_btn.text())
            finally:
                self._settle_and_close_editor(editor)

    def test_select_scene_by_id_still_switches_and_syncs_button(self) -> None:
        """程序化通路（全局搜索/引用导航按方法名派发）：布局重组后必须原样可用。"""
        with TemporaryDirectory() as td:
            editor = self._bootstrap_editor(Path(td) / "p")
            try:
                self._qt_app.processEvents()
                editor.select_scene_by_id("sc_b")
                self._qt_app.processEvents()
                self.assertEqual(editor._current_scene_id, "sc_b")
                self.assertIn("sc_b", editor._scene_switch_btn.text())
                self.assertFalse(editor._scene_popup.isVisible())
            finally:
                self._settle_and_close_editor(editor)

    def test_popup_owns_search_list_and_new_scene_button(self) -> None:
        """结构锁定：搜索框/场景列表/新建按钮都住在弹窗里，不再占左栏常驻空间。"""
        with TemporaryDirectory() as td:
            editor = self._bootstrap_editor(Path(td) / "p")
            try:
                for w in (editor._scene_search, editor._scene_list,
                          editor._btn_new_scene):
                    parent, in_popup = w.parentWidget(), False
                    while parent is not None:
                        if parent is editor._scene_popup:
                            in_popup = True
                            break
                        parent = parent.parentWidget()
                    self.assertTrue(in_popup, f"{w} 不在场景弹窗内")
            finally:
                self._settle_and_close_editor(editor)


if __name__ == "__main__":
    unittest.main()
