"""新老画布并存期的**数据事故防线**。

方案书 §3.4「死法一（概率最高）」：并存期两份撤销栈各自持同一场景的快照/命令，
在一个画布按 Ctrl+Z 会把另一个画布刚做的改动**静默回滚，且 redo 找不回**。
表现是"用了新画布之后数据反而更容易坏"——一次事故就足以让整个方案被否掉。

代价说清楚并一并锁住：**切画布 = 另一个画布的撤销栈清空**。
语义诚实，好过两个栈互撤。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.editors.scene_v2.changes import EntityProperty, EntityRef
from tools.editor.editors.scene_v2.commands import build_change_fields_command
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.project_model import ProjectModel
from tools.editor.tests.qt_teardown import quiesce_scene_editor
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_SCENE = "并存街"


def _scene() -> dict:
    return {
        "id": _SCENE, "name": _SCENE, "worldWidth": 800, "worldHeight": 600,
        "spawnPoint": {"x": 10, "y": 10},
        "hotspots": [{"id": "h1", "type": "inspect", "x": 100, "y": 100,
                      "interactionRange": 50}],
        "npcs": [], "zones": [],
    }


class CoexistenceUndoTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        self.model = ProjectModel()
        self.model.load_project(root)
        self.model.scenes[_SCENE] = _scene()
        # 两个画布共享**同一个** ProjectModel —— 这正是并存期的真实形态
        self.v1 = SceneEditor(self.model)
        self.v1._load_scene(_SCENE)
        self.v1._canvas._auto_fit_after_layout = False
        self.v2 = SceneEditorV2(self.model)
        self.v2.load_scene(_SCENE)

    def tearDown(self) -> None:
        quiesce_scene_editor(self.v1)
        self.v1.deleteLater()
        self.v2.deleteLater()
        QApplication.processEvents()
        self._tmp.cleanup()

    def hs(self) -> dict:
        return self.model.scenes[_SCENE]["hotspots"][0]

    def _v2_move(self, x: float) -> None:
        ref = EntityRef("hotspot", "h1")
        self.v2.document.push(build_change_fields_command(
            self.v2.document, [ref], [{"x": x}], EntityProperty.POSITION, "移动"))

    def _v1_snapshot_command(self) -> None:
        """在老画布做一次可撤销的改动（走它自己的 capture 出口）。"""
        with self.v1._undo.capture("测试改动"):
            self.hs()["y"] = 555

    # ---- 新画布改 → 老画布的栈必须清空 ------------------------------------

    def test_v2_edit_clears_the_old_canvas_undo_stack(self) -> None:
        self._v1_snapshot_command()
        self.assertGreaterEqual(self.v1._undo.stack.count(), 1,
                                "前置条件：老画布应当有一条撤销记录")

        self._v2_move(300)

        self.assertEqual(
            self.v1._undo.stack.count(), 0,
            "新画布改了数据，老画布的栈没被清 —— 在那边 Ctrl+Z 会把这次改动静默回滚")

    def test_old_canvas_undo_cannot_revert_a_v2_edit(self) -> None:
        """端到端：这正是"用了新画布数据反而更容易坏"的那一幕。"""
        self._v1_snapshot_command()
        self._v2_move(300)
        self.v1._undo.stack.undo()          # 栈已空，应当什么都不做
        self.assertEqual(self.hs()["x"], 300,
                         "老画布的撤销把新画布的编辑回滚掉了")

    # ---- 老画布改 → 新画布的栈必须清空 ------------------------------------

    def test_v1_edit_clears_the_new_canvas_undo_stack(self) -> None:
        self._v2_move(300)
        self.assertEqual(self.v2.document.undo_stack.count(), 1)

        self._v1_snapshot_command()

        self.assertEqual(
            self.v2.document.undo_stack.count(), 0,
            "老画布改了数据，新画布的栈没被清 —— 反向的同一个事故")

    def test_new_canvas_undo_cannot_revert_a_v1_edit(self) -> None:
        self._v2_move(300)
        self._v1_snapshot_command()
        self.v2.editor_undo()
        self.assertEqual(self.hs()["y"], 555,
                         "新画布的撤销把老画布的编辑回滚掉了")

    # ---- 不该误伤 ----------------------------------------------------------

    def test_a_canvas_does_not_clear_its_own_stack(self) -> None:
        self._v2_move(300)
        self._v2_move(310)
        self.assertGreaterEqual(self.v2.document.undo_stack.count(), 1,
                                "画布把自己的撤销历史也清掉了")

    def test_other_scenes_are_untouched(self) -> None:
        """只清同一场景的栈；改甲场景不该毁掉乙场景的撤销历史。"""
        self.model.scenes["别的街"] = dict(_scene(), id="别的街", name="别的街")
        self.v1._refresh_scene_list()
        self.v1._load_scene("别的街")
        with self.v1._undo.capture("别的街改动"):
            self.model.scenes["别的街"]["hotspots"][0]["y"] = 42

        self._v2_move(300)      # 改的是「并存街」

        self.assertGreaterEqual(self.v1._undo.stack.count(), 1,
                                "无关场景的撤销历史被误清了")

    def test_both_canvases_see_the_same_data(self) -> None:
        """并存的前提：同一份 ProjectModel。"""
        self._v2_move(300)
        self.assertIs(self.v1._model, self.v2._model)
        self.assertEqual(self.v1._model.scenes[_SCENE]["hotspots"][0]["x"], 300)


if __name__ == "__main__":
    unittest.main()
