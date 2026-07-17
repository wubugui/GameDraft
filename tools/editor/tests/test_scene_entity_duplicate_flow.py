"""场景实体「复制实体（本场景）」流程探针：从最外层用户入口进。

模拟用户实操：画布点中实体 →（可选）在属性面板改字段不 Apply → 触发工具栏
「重构 → 复制实体」QAction。断言模型层结果：副本存在且携带未 Apply 的编辑
（commit-on-leave 先行，P1-01 家族门控）、几何偏移、脏桶入账、画布回选副本。
引擎级契约（取号/剥离/撤销/守卫）由 test_entity_refactor.py 锁定，这里只锁
"用户那条路走得通"。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class TestSceneEntityDuplicateFlow(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _bootstrap_editor(self, root: Path) -> tuple[SceneEditor, str]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        sid = next(iter(model.scenes.keys()))
        sc = model.scenes[sid]
        sc.setdefault("npcs", []).append({
            "id": "n0", "name": "N0", "x": 100, "y": 100,
            "interactionRange": 50,
        })
        sc.setdefault("hotspots", []).append({
            "id": "h0", "type": "inspect", "label": "", "x": 200, "y": 200,
            "interactionRange": 50, "data": {"text": ""},
        })
        editor = SceneEditor(model)
        editor._load_scene(sid)
        return editor, sid

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

    def test_duplicate_npc_via_action_carries_pending_edit(self) -> None:
        """画布选中 → 面板改 name 不 Apply → 触发复制：副本必须带上未 Apply 的编辑。"""
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor(Path(td) / "p")
            try:
                # 画布选中的既有测试样板：图元 setSelected + 选中槽（信号本体从
                # 鼠标事件发出，离屏测试直接调槽，与 test_npc_patrol_add_crash 一致）
                it = editor._canvas._entity_items["npc:n0"]
                it.setSelected(True)
                editor._on_item_selected("npc", "n0")
                self._qt_app.processEvents()
                self.assertIs(
                    editor._props._stack.currentWidget(), editor._props._npc_panel)

                editor._props._npc_name.setText("巡夜人甲")
                self._qt_app.processEvents()

                editor._act_duplicate.trigger()
                self._qt_app.processEvents()

                npcs = editor._model.scenes[sid]["npcs"]
                self.assertEqual([n["id"] for n in npcs], ["n0", "n0_copy"])
                # commit-on-leave 先行：原实体与副本都携带未 Apply 的 name
                self.assertEqual(npcs[0].get("name"), "巡夜人甲")
                self.assertEqual(npcs[1].get("name"), "巡夜人甲")
                # 几何偏移落位
                self.assertEqual((npcs[1]["x"], npcs[1]["y"]), (140, 140))
                # 脏桶入账（落盘走 Save All）
                self.assertTrue(editor._model.is_dirty)
                self.assertIn(sid, editor._model._dirty_scene_ids)
                # 画布回选副本（用户可立即拖动摆位）
                dup_item = editor._canvas._entity_items.get("npc:n0_copy")
                self.assertIsNotNone(dup_item)
                self.assertTrue(dup_item.isSelected())
            finally:
                self._settle_and_close_editor(editor)

    def test_duplicate_hotspot_via_action(self) -> None:
        with TemporaryDirectory() as td:
            editor, sid = self._bootstrap_editor(Path(td) / "p")
            try:
                it = editor._canvas._entity_items["hotspot:h0"]
                it.setSelected(True)
                editor._on_item_selected("hotspot", "h0")
                self._qt_app.processEvents()

                editor._act_duplicate.trigger()
                self._qt_app.processEvents()

                hss = editor._model.scenes[sid]["hotspots"]
                self.assertEqual([h["id"] for h in hss], ["h0", "h0_copy"])
                # deepcopy 独立：改副本嵌套 data 不污染原实体
                hss[1]["data"]["text"] = "副本改动"
                self.assertEqual(hss[0]["data"].get("text"), "")
            finally:
                self._settle_and_close_editor(editor)

    def test_duplicate_shortcut_registered_on_editor(self) -> None:
        """Ctrl+D 必须挂在编辑器本体（弹出菜单里的 QAction 默认只在菜单可见时生效）。"""
        with TemporaryDirectory() as td:
            editor, _sid = self._bootstrap_editor(Path(td) / "p")
            try:
                self.assertEqual(
                    editor._act_duplicate.shortcut().toString(), "Ctrl+D")
                self.assertIn(editor._act_duplicate, editor.actions())
            finally:
                self._settle_and_close_editor(editor)


if __name__ == "__main__":
    unittest.main()
