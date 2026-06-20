"""MapEditor：字段即时提交（无 Apply）+ 切换节点不丢编辑（消除「数据回弹」）+ 布局。

回归点：
- 旧版仅 x/y 即时提交，name/sceneId/unlockConditions 需点 Apply，切换节点会回滚未保存编辑。
- 旧版仅把 4 字段表单放进滚动区，ConditionEditor 在外被挤压重叠。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication, QPlainTextEdit, QScrollArea

from tools.editor.editors.map_editor import MapEditor
from tools.editor.project_model import ProjectModel
from tools.editor.shared.collapsible_section import CollapsibleSection
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


def _is_descendant(child, ancestor) -> bool:
    w = child
    while w is not None:
        if w is ancestor:
            return True
        w = w.parentWidget()
    return False


class TestMapEditorLiveCommit(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if QApplication.instance() is None:
            cls._qt_app = QApplication(sys.argv)
        else:
            cls._qt_app = QApplication.instance()

    def setUp(self) -> None:
        self._editors: list[MapEditor] = []

    def tearDown(self) -> None:
        # 确定性销毁：先静音场景信号，避免 GC 期 selectionChanged 命中半删除的 QGraphicsScene，
        # 再 deleteLater + 抽干事件队列，杜绝跨用例 GC 噪声。
        for ed in self._editors:
            try:
                ed._map_scene.blockSignals(True)
            except Exception:
                pass
            ed.deleteLater()
        self._editors.clear()
        QApplication.processEvents()

    def _editor(self, root: Path) -> tuple[MapEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.map_nodes = [
            {"sceneId": "sc_a", "name": "Alpha", "x": 10, "y": 20, "unlockConditions": []},
            {"sceneId": "sc_b", "name": "Beta", "x": 30, "y": 40, "unlockConditions": []},
        ]
        editor = MapEditor(model)
        editor._refresh()
        self._editors.append(editor)
        return editor, model

    def test_name_commits_live_without_apply(self) -> None:
        with TemporaryDirectory() as td:
            editor, model = self._editor(Path(td) / "p")
            editor._list.setCurrentRow(0)
            editor._m_name.setText("Renamed")
            self.assertEqual(model.map_nodes[0]["name"], "Renamed")
            # 列表项与画布节点标签同步刷新
            self.assertIn("Renamed", editor._list.item(0).text())

    def test_scene_pick_commits_live(self) -> None:
        with TemporaryDirectory() as td:
            editor, model = self._editor(Path(td) / "p")
            editor._list.setCurrentRow(0)
            # 模拟用户在选择器里选了 sc_b（触发 value_changed）
            editor._m_scene.setCurrentIndex(editor._m_scene._ids.index("sc_b"))
            self.assertEqual(model.map_nodes[0]["sceneId"], "sc_b")

    def test_conditions_commit_live(self) -> None:
        with TemporaryDirectory() as td:
            editor, model = self._editor(Path(td) / "p")
            editor._list.setCurrentRow(0)
            editor._m_cond.set_data([{"flag": "f_test", "value": True}])
            editor._m_cond.changed.emit()  # 模拟用户在条件编辑器内的改动
            self.assertEqual(
                model.map_nodes[0]["unlockConditions"], editor._m_cond.to_list()
            )
            self.assertTrue(model.map_nodes[0]["unlockConditions"])

    def test_no_revert_on_node_switch(self) -> None:
        with TemporaryDirectory() as td:
            editor, model = self._editor(Path(td) / "p")
            editor._list.setCurrentRow(0)
            editor._m_name.setText("Edited0")
            # 切到另一个节点再切回——编辑必须仍在（旧版会回弹丢失）
            editor._list.setCurrentRow(1)
            self.assertEqual(editor._m_name.text(), "Beta")
            editor._list.setCurrentRow(0)
            self.assertEqual(editor._m_name.text(), "Edited0")
            self.assertEqual(model.map_nodes[0]["name"], "Edited0")

    def test_selection_does_not_writeback_during_load(self) -> None:
        with TemporaryDirectory() as td:
            editor, model = self._editor(Path(td) / "p")
            before = (
                model.map_nodes[0]["sceneId"],
                model.map_nodes[0]["name"],
                list(model.map_nodes[0]["unlockConditions"]),
            )
            editor._list.setCurrentRow(0)  # 纯选择不得回写 name/sceneId/conditions
            self.assertEqual(model.map_nodes[0]["sceneId"], before[0])
            self.assertEqual(model.map_nodes[0]["name"], before[1])
            self.assertEqual(model.map_nodes[0]["unlockConditions"], before[2])

    def test_condition_editor_lives_inside_scroll_area(self) -> None:
        with TemporaryDirectory() as td:
            editor, _ = self._editor(Path(td) / "p")
            scrolls = editor.findChildren(QScrollArea)
            self.assertTrue(scrolls)
            host = next(
                (sa.widget() for sa in scrolls if _is_descendant(editor._m_cond, sa.widget())),
                None,
            )
            self.assertIsNotNone(
                host, "unlockConditions ConditionEditor 必须位于滚动区内，避免被挤压重叠"
            )

    def test_expert_fallback_collapsed_by_default(self) -> None:
        with TemporaryDirectory() as td:
            editor, _ = self._editor(Path(td) / "p")
            extra = editor._m_cond._extra_json
            self.assertIsInstance(extra, QPlainTextEdit)
            section = next(
                (s for s in editor._m_cond.findChildren(CollapsibleSection)
                 if _is_descendant(extra, s)),
                None,
            )
            self.assertIsNotNone(section, "专家兜底粘贴区必须收进可折叠区块")
            self.assertFalse(section.is_expanded(), "专家兜底默认应折叠，避免长期占大片空白")

    def test_expert_fallback_still_round_trips_while_collapsed(self) -> None:
        with TemporaryDirectory() as td:
            editor, _ = self._editor(Path(td) / "p")
            editor._list.setCurrentRow(0)
            # 折叠态下专家粘贴内容仍须被读出（折叠只隐藏、不清空）
            editor._m_cond._extra_json.setPlainText('{"flag": "f_expert"}')
            self.assertIn({"flag": "f_expert"}, editor._m_cond.to_list())

    def test_refresh_preserves_selection(self) -> None:
        # 回归 HIGH-9：_refresh() 里 scene.clear() 触发 selectionChanged 把 _current_idx
        # 清成 -1，旧实现末尾恢复块成死代码、选择丢失。快照修复后选择须存活。
        with TemporaryDirectory() as td:
            editor, model = self._editor(Path(td) / "p")
            editor._list.setCurrentRow(1)
            self.assertEqual(editor._current_idx, 1)
            editor._refresh()
            self.assertEqual(editor._current_idx, 1, "_refresh 后选中行必须保留")
            self.assertTrue(editor._node_graphics[1].isSelected())

    def test_scene_change_marks_map_needs_refresh_when_hidden(self) -> None:
        # 回归：别处改场景后地图连线过期；data_changed('scene') 须标记待刷新。
        with TemporaryDirectory() as td:
            editor, model = self._editor(Path(td) / "p")
            editor.hide()
            editor._needs_refresh = False
            editor._on_model_data_changed("scene", "sc_a")
            self.assertTrue(editor._needs_refresh, "场景变更须让地图标记待刷新")
            # 地图自身的 'map' 变更不应触发外部刷新（避免拖拽中自我打断）
            editor._needs_refresh = False
            editor._on_model_data_changed("map", "")
            self.assertFalse(editor._needs_refresh)

    def test_condition_tree_height_is_compact(self) -> None:
        from tools.editor.shared import condition_expr_tree as cet
        # 回归护栏：树滚动区下限不得再膨胀回旧的 640（凭空占大片空白）。
        self.assertLessEqual(cet._CONDITION_EXPR_TREE_SCROLL_MIN_HEIGHT, 240)


if __name__ == "__main__":
    unittest.main()
