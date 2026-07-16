"""water_minigame：删除实体不得把被删实体的动作串台进顶上来补位的实体（数据损坏）。

历史根因：ActionEditor 懒回写按行号取 ents[row]，删除后行号整体上移，残留的
（被删实体的）onPick/onPullSuccess/onPullFail 被刷进错误实体。修复为按身份回写。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtWidgets import QApplication

from tools.editor.editors.water_minigame_editor import WaterMinigameEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class WaterMinigameDeleteCorruptionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list[WaterMinigameEditor] = []
        # 删除已加确认弹窗;测试里默认确认删除。
        p = patch("tools.editor.shared.confirm.confirm_delete", return_value=True)
        p.start()
        self.addCleanup(p.stop)

    def tearDown(self) -> None:
        for ed in self._editors:
            ed.deleteLater()
        self._editors.clear()
        QApplication.processEvents()

    def _editor(self, root: Path) -> tuple[WaterMinigameEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.water_minigames_index = [{"id": "wm1", "file": "wm1.json"}]
        model.water_minigames_instances = {"wm1": {
            "id": "wm1", "bounds": {"w": 100, "h": 100},
            "entities": [
                {"id": "e0", "sprite": "", "onPick": [{"type": "A"}], "onPullSuccess": [], "onPullFail": []},
                {"id": "e1", "sprite": "", "onPick": [{"type": "B"}], "onPullSuccess": [], "onPullFail": []},
                {"id": "e2", "sprite": "", "onPick": [{"type": "C"}], "onPullSuccess": [], "onPullFail": []},
            ],
        }}
        ed = WaterMinigameEditor(model)
        ed._inst_list_w.setCurrentRow(0)
        self._editors.append(ed)
        return ed, model

    def _ents(self, model):
        return model.water_minigames_instances["wm1"]["entities"]

    def _types(self, actions):
        return [a.get("type") for a in actions or []]

    def test_delete_middle_does_not_taint_shifted_entity(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_canvas_entity_selected(1)
            ed._ae_pick.set_data([{"type": "TAINT"}])  # 未回写的编辑，针对将被删的 e1
            ed._selected_ent_row = 1
            ed._remove_entity()
            ents = self._ents(model)
            self.assertEqual([e["id"] for e in ents], ["e0", "e2"])
            self.assertEqual(self._types(ents[0]["onPick"]), ["A"])
            # e2 顶上来补 index1，必须保留自己的 C，绝不能继承被删 e1 的 TAINT
            self.assertEqual(self._types(ents[1]["onPick"]), ["C"])

    def test_delete_first_does_not_taint_shifted_entity(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_canvas_entity_selected(0)
            ed._ae_pick.set_data([{"type": "TAINT"}])
            ed._selected_ent_row = 0
            ed._remove_entity()
            ents = self._ents(model)
            self.assertEqual([e["id"] for e in ents], ["e1", "e2"])
            self.assertEqual(self._types(ents[0]["onPick"]), ["B"])
            self.assertEqual(self._types(ents[1]["onPick"]), ["C"])


if __name__ == "__main__":
    unittest.main()
