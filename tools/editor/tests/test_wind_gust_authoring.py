from __future__ import annotations
import copy
import os
from pathlib import Path
import pytest
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtWidgets import QApplication
from tools.editor.project_model import ProjectModel
from tools.editor.shared.action_editor import ActionEditor
from tools.editor.shared.wind_gust_validation import wind_gust_errors


@pytest.mark.parametrize("params", [
    {"speedMultiplier": 4, "durationMs": 2200},
    {"speedMultiplier": 3.123456789, "durationMs": 2000, "attackMs": 0, "releaseMs": 250.123456789,
     "id": "wind_missing_preserved", "volume": 0, "wait": True, "future": 1},
])
def test_gust_authoring_roundtrip(params):
    app = QApplication.instance() or QApplication([])
    model = ProjectModel()
    model.load_project(Path(__file__).resolve().parents[3])
    original = {"type": "sceneWindGust", "params": copy.deepcopy(params)}
    editor = ActionEditor("gust")
    editor.set_project_context(model, "跑马梁")
    editor.set_data([original])
    assert editor.to_list() == [original]
    saved = editor.to_list()
    editor.set_data(saved)
    assert editor.to_list() == saved
    editor.deleteLater()
    app.processEvents()


@pytest.mark.parametrize("params", [
    {"speedMultiplier": 0, "durationMs": 1000},
    {"speedMultiplier": 2, "durationMs": 1000, "attackMs": 900, "releaseMs": 200},
    {"speedMultiplier": 2, "durationMs": 1000, "volume": .8},
    {"speedMultiplier": 2, "durationMs": float("nan")},
])
def test_gust_rejects_invalid_authoring(params):
    assert wind_gust_errors(params)
