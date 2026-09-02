"""外部直写之后，新画布必须**当场**重投影 —— 不是等切页，更不是等重开编辑器。

这一族的固定形状（2026-09-02 实测复现）：在老画布删掉一个热点，新画布照旧画着它 ——
图元还能点中、还能选中，再删提示"没有此实体"，只有重开编辑器才消失。

根因不是删除逻辑：新画布的图元账本是**纯 push** 的，只由本文档的变更事件驱动，没有
任何轮询。外部直写（老画布的删除 / 快照撤销、坐标点选器、Task 编排）不经过本文档的
命令层；`broadcast_external_scene_write` 此前又只清撤销栈不重投影 —— "数据变了"这件事
只告诉了撤销栈，没告诉画面。`_apply_presence` 对查不到的实体一律显示，幽灵还被强制可见。

下面每条都从**真实入口**进（老画布的删除按钮、面板的 `scene_directly_written`、
跨页广播），断言的是画布账本，不是"某个函数被调了"。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.editors.scene_undo import broadcast_external_scene_write
from tools.editor.editors.scene_v2.changes import (
    EntityProperty,
    EntityRef,
    SceneReloaded,
)
from tools.editor.editors.scene_v2.commands import build_change_fields_command
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.project_model import ProjectModel
from tools.editor.tests.qt_teardown import quiesce_scene_editor
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_SCENE = "外写街"
_OTHER = "外写巷"

_H1 = EntityRef("hotspot", "h1")
_H2 = EntityRef("hotspot", "h2")


def _scene(sid: str) -> dict:
    return {
        "id": sid, "name": sid, "worldWidth": 800, "worldHeight": 600,
        "spawnPoint": {"x": 10, "y": 10},
        "hotspots": [
            {"id": "h1", "type": "inspect", "x": 100, "y": 100, "interactionRange": 50},
            {"id": "h2", "type": "inspect", "x": 200, "y": 100, "interactionRange": 50},
        ],
        "npcs": [], "zones": [],
    }


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
        self.model.scenes[_SCENE] = _scene(_SCENE)
        self.model.scenes[_OTHER] = _scene(_OTHER)
        self.page = SceneEditorV2(self.model)
        self.page.load_scene(_SCENE)
        self.events: list = []
        self.page.document.changed.connect(self.events.append)

    def tearDown(self) -> None:
        self.page.deleteLater()
        QApplication.processEvents()
        self._tmp.cleanup()

    def _reloads(self) -> int:
        return sum(1 for e in self.events if isinstance(e, SceneReloaded))

    def _external_delete(self, sid: str, hid: str) -> None:
        """模拟一个**不经本文档命令层**的删除：就地改名册，再走跨页广播。"""
        lst = self.model.scenes[sid]["hotspots"]
        lst[:] = [h for h in lst if h.get("id") != hid]
        broadcast_external_scene_write(sid, origin=None)


class ExternalWriteReprojectionTests(_Base):
    def test_external_delete_drops_the_item_at_once(self) -> None:
        """老画布删了实体，新画布不能等到切页 / 重开才把图元拆掉。"""
        self.assertIsNotNone(self.page.view.item_for(_H1, "handle"), "前置条件")
        self._external_delete(_SCENE, "h1")
        self.assertEqual(self.page.view.items_of(_H1), [],
                         "数据里已经没有 h1，画布上还画着它（幽灵图元）")
        self.assertIsNotNone(self.page.view.item_for(_H2, "handle"),
                             "重投影把没删的实体一并弄没了")

    def test_the_ghost_is_no_longer_selectable_or_deletable(self) -> None:
        """幽灵的第二个症状：还能选中，再删提示"没有此实体"。现在它根本不在账上。"""
        self._external_delete(_SCENE, "h1")
        self.assertFalse(self.page.select_entity("hotspot", "h1"))
        self.assertFalse(self.page.delete_selected())

    def test_external_delete_prunes_the_selection_and_clears_the_stack(self) -> None:
        self.page.document.set_selection([_H1])
        self.page.document.push(build_change_fields_command(
            self.page.document, [_H1], [{"x": 150}], EntityProperty.POSITION, "移动"))
        self.assertEqual(self.page.document.undo_stack.count(), 1, "前置条件")
        self._external_delete(_SCENE, "h1")
        self.assertEqual(self.page.document.selection, (),
                         "选择集里还留着已经不存在的实体 —— 面板会继续显示它")
        self.assertEqual(self.page.document.undo_stack.count(), 0,
                         "跨过外部直写的字段级命令没被清掉，撤销会把那次直写连带撤回")

    def test_reprojection_is_in_place(self) -> None:
        """场景 dict 对象没换 → 原地重投影，Document / View 都保住（视口不丢）。"""
        doc, view = self.page.document, self.page.view
        self._external_delete(_SCENE, "h1")
        self.assertIs(self.page.document, doc)
        self.assertIs(self.page.view, view)
        self.assertEqual(self._reloads(), 1, "重投影应当恰好一次")

    def test_a_write_to_another_scene_leaves_this_canvas_alone(self) -> None:
        self._external_delete(_OTHER, "h1")
        self.assertEqual(self._reloads(), 0, "别的场景被改，本页不该重投影")
        self.assertIsNotNone(self.page.view.item_for(_H1, "handle"))

    def test_entity_tree_follows_the_external_delete(self) -> None:
        from PySide6.QtCore import Qt
        from PySide6.QtWidgets import QTreeWidgetItemIterator

        self._external_delete(_SCENE, "h1")
        rows: set = set()
        it = QTreeWidgetItemIterator(self.page._tree)
        while it.value():
            data = it.value().data(0, Qt.ItemDataRole.UserRole)
            if data is not None:
                rows.add(tuple(data))
            it += 1
        self.assertNotIn(("hotspot", "h1"), rows, "实体树还列着已删的实体")
        self.assertIn(("hotspot", "h2"), rows)


class PickerWriteTests(_Base):
    """坐标点选器一族直写当前场景 → 面板发 `scene_directly_written`。"""

    def test_picker_write_on_the_current_scene_reprojects_once_in_place(self) -> None:
        doc = self.page.document
        self.model.scenes[_SCENE]["hotspots"].pop(0)      # 点选器那样的裸直写
        self.page._props.scene_directly_written.emit(_SCENE)
        self.assertIs(self.page.document, doc, "对象没换却整份重建了 —— 视口与撤销历史一起没")
        self.assertEqual(self._reloads(), 1,
                         "文档清栈重投影一次、页面又 reload 一次 —— 同一份数据重建了两遍")
        self.assertEqual(self.page.view.items_of(_H1), [])

    def test_picker_write_after_the_scene_object_was_replaced_rebuilds(self) -> None:
        """对象被换掉（Task 编排 / 导入）时文档层认不出来，必须整份重建。"""
        doc = self.page.document
        self.model.scenes[_SCENE] = dict(self.model.scenes[_SCENE])
        self.page._props.scene_directly_written.emit(_SCENE)
        self.assertIsNot(self.page.document, doc, "场景域被替换了却还在用旧 Document")

    def test_picker_write_to_another_scene_is_a_no_op(self) -> None:
        doc = self.page.document
        self.page._props.scene_directly_written.emit(_OTHER)
        self.assertIs(self.page.document, doc)
        self.assertEqual(self._reloads(), 0)


class OldCanvasDeleteReachesTheNewCanvasTests(unittest.TestCase):
    """两个画布共享同一个 ProjectModel（并存期的真实形态）：老画布按钮删，新画布当场掉。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        self.model = ProjectModel()
        self.model.load_project(root)
        self.model.scenes[_SCENE] = _scene(_SCENE)
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

    def test_deleting_on_the_old_canvas_removes_the_item_from_the_new_canvas(self) -> None:
        self.assertIsNotNone(self.v2.view.item_for(_H1, "handle"), "前置条件")
        with patch("tools.editor.shared.confirm.confirm_delete", lambda *a, **k: True):
            self.v1._select_scene_entity_by_kind("hotspot", "h1", _SCENE)
            QApplication.processEvents()
            self.v1._delete_selected()
        QApplication.processEvents()
        self.assertEqual(
            [h["id"] for h in self.model.scenes[_SCENE]["hotspots"]], ["h2"],
            "前置条件：老画布真的删掉了")
        self.assertEqual(self.v2.view.items_of(_H1), [],
                         "老画布删了，新画布还画着它 —— 只有重开编辑器才消失的那个幽灵")
        self.assertIsNotNone(self.v2.view.item_for(_H2, "handle"))


if __name__ == "__main__":
    unittest.main()
