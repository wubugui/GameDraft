"""属性页共享滚动条回归：从长 NPC 页切 Zone 必须从基础属性开始。"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class ScenePropertyScrollResetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def test_tree_selection_from_scrolled_npc_opens_zone_at_top_with_conditions(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            zone_conditions = [{"flag": "story.open", "equals": True}]
            model.scenes = {"sc_a": {
                "id": "sc_a", "name": "场景甲",
                "npcs": [{"id": "n1", "name": "甲", "x": 10, "y": 10, "interactionRange": 50}],
                "hotspots": [],
                "zones": [{
                    "id": "z1", "conditions": zone_conditions,
                    "polygon": [{"x": 0, "y": 0}, {"x": 50, "y": 0}, {"x": 50, "y": 50}],
                    "unknownZone": {"keep": True},
                }],
            }}
            ed = SceneEditor(model)
            try:
                ed.resize(1000, 520)
                ed.show()
                ed._refresh_scene_list()
                ed._load_scene("sc_a")
                QApplication.processEvents()

                def item(ref):
                    for candidate in ed._iter_entity_tree_items():
                        data = candidate.data(0, Qt.ItemDataRole.UserRole)
                        if data and tuple(data) == ref:
                            return candidate
                    raise AssertionError(ref)

                # 最外层交互探针：树选 NPC → 用户滚到底 → 树选 Zone。
                ed._entity_tree.setCurrentItem(item(("npc", "n1")))
                QApplication.processEvents()
                bar = ed._props.verticalScrollBar()
                self.assertGreater(bar.maximum(), 0, "前提：NPC 属性页应足够长，确有可复现滚动位置")
                bar.setValue(bar.maximum())
                self.assertGreater(bar.value(), 0)

                ed._entity_tree.clearSelection()
                ed._entity_tree.setCurrentItem(item(("zone", "z1")))
                QApplication.processEvents()

                self.assertIs(ed._props._stack.currentWidget(), ed._props._zone_panel)
                self.assertEqual(bar.value(), 0, "切入 Zone 必须回到页首，不能继承 NPC 滚动位置")
                self.assertEqual(ed._props._zn_id.text(), "z1")
                self.assertEqual(ed._props._zn_cond.to_list(), zone_conditions)
                self.assertTrue(ed._props._zn_cond_fold.is_expanded(), "已有条件的 Zone 条件区应自动展开")
                self.assertEqual(model.scenes["sc_a"]["zones"][0]["unknownZone"], {"keep": True})
            finally:
                try:
                    ed._scene_npc_anim_timer.stop()
                    ed._patrol_overlay_refresh_timer.stop()
                    ed._canvas._gfx.blockSignals(True)
                except Exception:
                    pass
                ed.close()
                ed.deleteLater()
                QApplication.processEvents()


if __name__ == "__main__":
    unittest.main()
