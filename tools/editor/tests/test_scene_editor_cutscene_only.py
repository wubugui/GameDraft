from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import ScenePropertyPanel
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


class TestSceneEditorCutsceneOnly(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if QApplication.instance() is None:
            cls._qt_app = QApplication(sys.argv)
        else:
            cls._qt_app = QApplication.instance()

    def _model(self, root: Path) -> ProjectModel:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        return model

    def test_unbound_hotspot_does_not_look_cutscene_only_after_apply(self) -> None:
        with TemporaryDirectory() as td:
            panel = ScenePropertyPanel(self._model(Path(td) / "p"))
            hs = {
                "id": "h0",
                "type": "inspect",
                "label": "",
                "x": 0,
                "y": 0,
                "interactionRange": 50,
                "data": {"text": ""},
            }

            panel.load_hotspot_props(hs)
            self.assertFalse(panel._hs_cutscene_only.isEnabled())
            self.assertFalse(panel._hs_cutscene_only.isChecked())

            panel._write_hotspot_widgets_to_dict(panel._staging_hotspot)
            self.assertNotIn("cutsceneOnly", panel._staging_hotspot)

    def test_bound_hotspot_can_toggle_shared_cutscene_entity(self) -> None:
        with TemporaryDirectory() as td:
            panel = ScenePropertyPanel(self._model(Path(td) / "p"))
            hs = {
                "id": "h0",
                "type": "inspect",
                "label": "",
                "x": 0,
                "y": 0,
                "interactionRange": 50,
                "cutsceneIds": ["cut_ok"],
                "data": {"text": ""},
            }

            panel.load_hotspot_props(hs)
            self.assertTrue(panel._hs_cutscene_only.isEnabled())
            self.assertTrue(panel._hs_cutscene_only.isChecked())

            panel._hs_cutscene_only.setChecked(False)
            panel._write_hotspot_widgets_to_dict(panel._staging_hotspot)
            self.assertEqual(panel._staging_hotspot["cutsceneIds"], ["cut_ok"])
            self.assertIs(panel._staging_hotspot["cutsceneOnly"], False)

    def test_clear_hotspot_cutscene_ids_removes_binding_semantics(self) -> None:
        with TemporaryDirectory() as td:
            panel = ScenePropertyPanel(self._model(Path(td) / "p"))
            hs = {
                "id": "h0",
                "type": "inspect",
                "label": "",
                "x": 0,
                "y": 0,
                "interactionRange": 50,
                "cutsceneIds": ["cut_ok"],
                "cutsceneOnly": False,
                "data": {"text": ""},
            }

            panel.load_hotspot_props(hs)
            panel._clear_hs_cutscene_ids()
            panel._write_hotspot_widgets_to_dict(panel._staging_hotspot)

            self.assertEqual(panel._hs_cutscene_ids_pending, [])
            self.assertFalse(panel._hs_cutscene_only.isEnabled())
            self.assertFalse(panel._hs_cutscene_only.isChecked())
            self.assertNotIn("cutsceneIds", panel._staging_hotspot)
            self.assertNotIn("cutsceneOnly", panel._staging_hotspot)


if __name__ == "__main__":
    unittest.main()
