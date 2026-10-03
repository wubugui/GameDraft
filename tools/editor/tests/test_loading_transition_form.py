"""Actual scene-page events and save/reload preserve transition and master fields."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from PySide6.QtCore import Qt
from PySide6.QtTest import QTest
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import ScenePropertyPanel
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.project_model import ProjectModel
from tools.editor.shared.loading_transition_catalog import loading_transition_choices
from tools.editor.shared.scene_ids import new_scene_skeleton
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

UNKNOWN_VALUES = ("future_transition", None, ["future", 3], {"z": 1, "a": {"z": 2, "a": 3}}, False, 23)


@pytest.fixture
def scene_page(tmp_path):
    app = QApplication.instance() or QApplication([])
    project = tmp_path / "project"
    write_minimal_loadable_project(project)
    scene = new_scene_skeleton("transition_probe", "转场验收")
    scene["contactAoDirection"] = {"mode": "manual", "azimuthDeg": 123.456, "elevationDeg": 5.678,
                                   "future": {"z": 2, "a": 1}}
    scene["playerContactAo"] = {"dirSource": "binding", "fadeInMs": 0, "fadeOutMs": 600.123,
                                 "future": {"z": 2, "a": 1}}
    scene["onEnterActions"] = [
        {"type": "teachPropGuard", "params": {"vitality": "guardSafety", "text": "按住 Q 护火"}},
        {"type": "lockPropState", "params": {"target": "player", "socket": "right_hand",
                                                 "lock": "lit", "lifetime": "scope"}},
    ]
    path = project / "public/assets/scenes/transition_probe.json"
    path.write_text(json.dumps(scene, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    model = ProjectModel()
    model.load_project(project)
    page = SceneEditorV2(model)
    page.resize(1280, 800)
    page.show()
    assert page.load_scene("transition_probe")
    app.processEvents()
    yield app, page, model, path, scene
    page.deleteLater()


def choose(combo, index):
    combo.setFocus()
    QTest.keyClick(combo, Qt.Key.Key_Home)
    for _ in range(index):
        QTest.keyClick(combo, Qt.Key.Key_Down)
    QApplication.processEvents()


def field(scene):
    return "loadingTransition" in scene, copy.deepcopy(scene.get("loadingTransition"))


@pytest.mark.parametrize("value", UNKNOWN_VALUES)
def test_unknown_load_refresh_noop_save_preserves_bytes(scene_page, value):
    _app, page, model, path, original = scene_page
    original["loadingTransition"] = copy.deepcopy(value)
    path.write_text(json.dumps(original, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    model.load_project(path.parents[3])
    before = path.read_bytes()
    assert page.load_scene("transition_probe")
    assert not model.is_dirty
    page.reload_refs_from_model()
    assert not model.is_dirty
    panel = page._props
    assert panel._loading_transition_selection() == (True, value)
    assert "未知" in panel._sc_loading_transition.currentText()
    out = copy.deepcopy(model.scenes["transition_probe"])
    panel._flush_scene_widgets_into(out)
    assert field(out) == (True, value)
    if isinstance(value, dict):
        assert list(out["loadingTransition"]) == list(value)
        assert list(out["loadingTransition"]["a"]) == list(value["a"])
    assert page.flush_to_model()
    model.save_all()
    assert path.read_bytes() == before


def test_catalogue_keyboard_choices_save_reload_and_preserve_master_fields(scene_page):
    _app, page, model, path, original = scene_page
    combo = page._props._sc_loading_transition
    assert combo.itemText(0) == "不配置（随机）"
    assert combo.itemData(0) is None
    assert combo.currentIndex() == 0 and not model.is_dirty
    before = path.read_bytes()
    assert page.flush_to_model()
    model.save_all()
    assert path.read_bytes() == before
    for kind, label in loading_transition_choices():
        choose(combo, combo.findData(kind))
        assert combo.currentText() == label
        assert model.scenes["transition_probe"]["loadingTransition"] == kind
        assert "transition_probe" in model._dirty_scene_ids
        model.save_all()
        disk = json.loads(path.read_text(encoding="utf-8"))
        assert disk["loadingTransition"] == kind
        for key in ("contactAoDirection", "playerContactAo", "onEnterActions"):
            assert disk[key] == original[key], key
        fresh = ProjectModel()
        fresh.load_project(path.parents[3])
        assert fresh.scenes["transition_probe"] == disk
    choose(combo, 0)
    assert "loadingTransition" not in model.scenes["transition_probe"]
    model.save_all()
    assert "loadingTransition" not in json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("value", UNKNOWN_VALUES)
def test_explicit_default_deletes_unknown_value_on_disk(scene_page, value):
    _app, page, model, path, _original = scene_page
    model.scenes["transition_probe"]["loadingTransition"] = copy.deepcopy(value)
    assert page.load_scene("transition_probe")
    choose(page._props._sc_loading_transition, 0)
    assert "loadingTransition" not in model.scenes["transition_probe"]
    model.save_all()
    assert "loadingTransition" not in json.loads(path.read_text(encoding="utf-8"))


def test_new_scene_button_default_omits_transition(scene_page):
    app, page, model, path, _original = scene_page
    with patch("PySide6.QtWidgets.QInputDialog.getText", side_effect=[("new_transition_probe", True), ("新场景", True)]):
        page._btn_new_scene.click()
    app.processEvents()
    assert page._props._sc_loading_transition.currentIndex() == 0
    assert "loadingTransition" not in model.scenes["new_transition_probe"]
    model.save_all()
    new_path = path.with_name("new_transition_probe.json")
    assert "loadingTransition" not in json.loads(new_path.read_text(encoding="utf-8"))


def test_staging_choice_then_return_to_original_unknown_restores_raw(scene_page):
    _app, _page, model, _path, original = scene_page
    original["loadingTransition"] = {"z": 1, "a": 2}
    panel = ScenePropertyPanel(model)
    panel.load_scene_props(original)
    index = panel._sc_loading_transition.currentIndex()
    staged = copy.deepcopy(original)
    kind = loading_transition_choices()[0][0]
    choose(panel._sc_loading_transition, panel._sc_loading_transition.findData(kind))
    panel._flush_scene_widgets_into(staged)
    assert staged["loadingTransition"] == kind
    choose(panel._sc_loading_transition, index)
    panel._flush_scene_widgets_into(staged)
    assert field(staged) == field(original)
    assert list(staged["loadingTransition"]) == ["z", "a"]
    panel.deleteLater()
