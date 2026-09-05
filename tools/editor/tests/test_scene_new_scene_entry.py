"""「+ 新建场景」从按钮进 —— 新画布要有这个入口，老画布要认中文 id。

两条用户报告（2026-09-03）：新画布页压根没有新建场景的入口，只能切回老画布；
老画布有入口却用「仅字母 / 数字 / 下划线 / 连字符」的正则把中文 id 拦掉，而工程里一大半场景是中文 id。
判定与骨架现在只有 ``shared/scene_ids`` 一份，这里从**最外层用户入口**（按钮 click +
输入弹窗）锁两个画布都接上了它，且落库 / 标脏 / 装载 / 跨画布可见一条不漏。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication, QInputDialog, QMessageBox

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.project_model import ProjectModel
from tools.editor.shared.scene_ids import new_scene_skeleton
from tools.editor.tests.qt_teardown import quiesce_scene_editor
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_OK = QMessageBox.StandardButton.Ok


def _answers(*texts: str):
    """依次回答「场景 id」「显示名」两个弹窗（都点确定）。"""
    return patch.object(QInputDialog, "getText",
                        side_effect=[(t, True) for t in texts])


def _row_ids(list_widget) -> list[str]:
    return [list_widget.item(i).data(Qt.ItemDataRole.UserRole)
            for i in range(list_widget.count())]


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        self.model = ProjectModel()
        self.model.load_project(root)

    def tearDown(self) -> None:
        self._app.processEvents()
        self._tmp.cleanup()


class NewCanvasNewSceneTests(_Base):
    def setUp(self) -> None:
        super().setUp()
        self.page = SceneEditorV2(self.model)

    def tearDown(self) -> None:
        self.page.deleteLater()
        super().tearDown()

    def test_button_creates_marks_dirty_and_loads_the_scene(self) -> None:
        """全新的页（还没装载任何场景）—— 用户遇到的正是这一格。"""
        self.assertEqual(self.page.current_scene_id, "")
        with _answers("义庄二", "义庄二号院"), \
                patch.object(QMessageBox, "warning", return_value=_OK) as warn:
            self.page._btn_new_scene.click()
        warn.assert_not_called()
        self.assertIn("义庄二", self.model.scenes)
        self.assertEqual(self.model.scenes["义庄二"],
                         new_scene_skeleton("义庄二", "义庄二号院"),
                         "骨架必须与共享定义逐字一致（老画布也从那里拿）")
        self.assertIn("义庄二", self.model._dirty_scene_ids,
                      "新场景没进脏桶 = Save All 不写它")
        self.assertTrue(self.model.is_dirty)
        self.assertEqual(self.page.current_scene_id, "义庄二", "建完必须装载它")
        self.assertIsNotNone(self.page.document)
        self.assertIsNotNone(self.page.view)
        cur = self.page._scene_list.currentItem()
        self.assertIsNotNone(cur, "清单要选中新场景")
        self.assertEqual(cur.data(Qt.ItemDataRole.UserRole), "义庄二")
        self.assertIn("义庄二", _row_ids(self.page._scene_list))

    def test_blank_display_name_falls_back_to_id(self) -> None:
        with _answers("野道二", "   "), \
                patch.object(QMessageBox, "warning", return_value=_OK):
            self.page._btn_new_scene.click()
        self.assertEqual(self.model.scenes["野道二"]["name"], "野道二")

    def test_duplicate_id_is_refused_and_nothing_changes(self) -> None:
        self.page.load_scene("sc_a")
        before = dict(self.model.scenes)
        with _answers("sc_b", "不该问到这一步"), \
                patch.object(QMessageBox, "warning", return_value=_OK) as warn:
            self.page._btn_new_scene.click()
        warn.assert_called_once()
        self.assertIn("已存在", warn.call_args.args[2])
        self.assertEqual(self.model.scenes, before)
        self.assertFalse(self.model.is_dirty, "被拒的新建不许标脏")
        self.assertEqual(self.page.current_scene_id, "sc_a", "被拒后不许换场景")

    def test_illegal_id_is_refused_with_the_shared_reason(self) -> None:
        with _answers("a/b", "x"), \
                patch.object(QMessageBox, "warning", return_value=_OK) as warn:
            self.page._btn_new_scene.click()
        warn.assert_called_once()
        self.assertIn("scenes/<id>.json", warn.call_args.args[2])
        self.assertNotIn("a/b", self.model.scenes)
        self.assertFalse(self.model.is_dirty)

    def test_cancel_at_either_prompt_creates_nothing(self) -> None:
        with patch.object(QInputDialog, "getText", return_value=("会被取消", False)), \
                patch.object(QMessageBox, "warning", return_value=_OK):
            self.page._btn_new_scene.click()
        self.assertNotIn("会被取消", self.model.scenes)
        with patch.object(QInputDialog, "getText",
                          side_effect=[("第二次", True), ("名字", False)]), \
                patch.object(QMessageBox, "warning", return_value=_OK):
            self.page._btn_new_scene.click()
        self.assertNotIn("第二次", self.model.scenes)
        self.assertFalse(self.model.is_dirty)

    def test_scene_created_on_new_canvas_shows_up_on_the_old_one(self) -> None:
        """并存期两个页共用一份模型：新画布建的场景，切到老画布（主窗口会调
        reload_from_model）必须列出来，否则用户以为"没建成"再建一次就撞名。"""
        with _answers("河边二", "河边二"), \
                patch.object(QMessageBox, "warning", return_value=_OK):
            self.page._btn_new_scene.click()
        old = SceneEditor(self.model)
        try:
            old.reload_from_model()
            self.assertIn("河边二", _row_ids(old._scene_list))
        finally:
            quiesce_scene_editor(old)
            old.deleteLater()


class OldCanvasNewSceneTests(_Base):
    def setUp(self) -> None:
        super().setUp()
        self.editor = SceneEditor(self.model)
        self.editor._refresh_scene_list()
        self._app.processEvents()

    def tearDown(self) -> None:
        quiesce_scene_editor(self.editor)
        self.editor.deleteLater()
        super().tearDown()

    def test_chinese_id_is_accepted(self) -> None:
        with _answers("城门口二", "城门口二"), \
                patch.object(QMessageBox, "warning", return_value=_OK) as warn:
            self.editor._btn_new_scene.click()
        warn.assert_not_called()
        self.assertIn("城门口二", self.model.scenes)
        self.assertEqual(self.model.scenes["城门口二"],
                         new_scene_skeleton("城门口二", "城门口二"))
        self.assertIn("城门口二", self.model._dirty_scene_ids)
        self.assertEqual(self.editor._current_scene_id, "城门口二")

    def test_path_breaking_id_is_still_refused(self) -> None:
        with _answers("a:b", "x"), \
                patch.object(QMessageBox, "warning", return_value=_OK) as warn:
            self.editor._btn_new_scene.click()
        warn.assert_called_once()
        self.assertNotIn("a:b", self.model.scenes)

    def test_scene_created_on_old_canvas_shows_up_on_the_new_one(self) -> None:
        with _answers("破屋二", "破屋二"), \
                patch.object(QMessageBox, "warning", return_value=_OK):
            self.editor._btn_new_scene.click()
        page = SceneEditorV2(self.model)
        try:
            page.reload_from_model()
            self.assertIn("破屋二", _row_ids(page._scene_list))
        finally:
            page.deleteLater()
