"""三把火数值作者面：创建、清空、重开、未改动保真、保存校验。"""
from __future__ import annotations
import copy
import os
from pathlib import Path
import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtWidgets import QApplication
from tools.editor.project_model import ProjectModel
from tools.editor.shared.action_editor import ActionEditor, ActionRow
from tools.editor.shared.health_forms import HealthConfigForm, OptionalHealthNumber, ABSENT
from tools.editor.shared.health_validation import health_action_errors

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture(scope="module")
def app():
    return QApplication.instance() or QApplication([])


@pytest.fixture(scope="module")
def model(app):
    model = ProjectModel()
    model.load_project(ROOT)
    return model


@pytest.mark.parametrize("action", [
    {"type": "lockHealth", "params": {"id": "tutorial", "min": 20}},
    {"type": "lockHealth", "params": {"id": "freeze", "min": 0, "max": 0, "scope": "persistent", "future": 3}},
    {"type": "setMaxHealth", "params": {"amount": 200.125678}},
    {"type": "setRetryCheckpoint", "params": {"id": "ridge"}},
    {"type": "unlockHealth", "params": {"id": "missing-but-preserved"}},
    {"type": "applyHealthProtection", "params": {"id": "charm", "seconds": 30}},
    {"type": "applyHealthProtection", "params": {"id": "charm", "seconds": 30, "kind": "yin", "reduction": 0.123456789, "maxHealthBonus": 60}},
    {"type": "removeHealthProtection", "params": {"id": "charm"}},
    {"type": "inflictHealthDamage", "params": {"amount": 12.5, "kind": "yin", "sourceId": "ghost"}},
])
def test_action_roundtrip(model, action):
    editor = ActionEditor("health")
    editor.set_project_context(model, "跑马梁")
    editor.set_data([copy.deepcopy(action)])
    try:
        assert editor.to_list() == [action]
    finally:
        editor.deleteLater()


def test_clear_optional_bounds_does_not_resurrect_original(app):
    row = ActionRow({"type": "lockHealth", "params": {"id": "tutorial", "min": 20, "max": 60}})
    try:
        field = row._param_widgets["min"]
        assert isinstance(field, OptionalHealthNumber)
        field.enabled.setChecked(False)
        assert row.to_dict()["params"] == {"id": "tutorial", "max": 60}
        field.enabled.setChecked(True)
        field.spin.setValue(0)
        assert row.to_dict()["params"]["min"] == 0
    finally:
        row.deleteLater()


def test_optional_number_untouched_precision_and_clear(app):
    field = OptionalHealthNumber(0.123456789)
    assert field.value() == 0.123456789
    field.enabled.setChecked(False)
    assert field.value() is ABSENT
    field.enabled.setChecked(True)
    field.spin.setValue(0)
    assert field.value() == 0


def test_config_fields_preserve_unknowns_and_remove_override(model):
    original = {"maxHealth": 150.123456789, "deathThreshold": 0, "future": {"a": 1}}
    form = HealthConfigForm(model, original)
    assert form.value() == original
    form.numbers["maxHealth"].enabled.setChecked(False)
    assert form.value() == {"deathThreshold": 0, "future": {"a": 1}}
    reopened = HealthConfigForm(model, form.value())
    assert reopened.value() == form.value()


def test_item_passive_protection_can_save_clear_and_reopen(model):
    from tools.editor.editors.item_editor import ItemEditor
    original_items = copy.deepcopy(model.items)
    try:
        model.items = [{"id": "charm", "name": "护身符", "type": "key", "description": "", "maxStack": 1,
                        "healthProtection": {"reduction": 0.75, "kinds": ["yin"], "future": 7}}]
        page = ItemEditor(model)
        page.select_by_id("charm")
        assert page._health_form is None
        page._health_section.set_expanded(True)
        assert not page._is_dirty()
        page._health_form.bonus.enabled.setChecked(True)
        page._health_form.bonus.spin.setValue(60)
        page.commit_pending_on_leave()
        assert model.items[0]["healthProtection"]["maxHealthBonus"] == 60
        assert model.items[0]["healthProtection"]["future"] == 7
        page._on_select(0)
        page._health_form.enabled.setChecked(False)
        page.flush_to_model()
        assert "healthProtection" not in model.items[0]
        page._on_select(0)
        assert not page._health_form.enabled.isChecked()
        page.deleteLater()
    finally:
        model.items = original_items


@pytest.mark.parametrize("kind,params", [
    ("lockHealth", {"id": "tutorial"}),
    ("lockHealth", {"id": "tutorial", "min": 60, "max": 20}),
    ("lockHealth", {"id": "tutorial", "min": -1}),
    ("setMaxHealth", {"amount": 0}),
    ("applyHealthProtection", {"id": "charm", "seconds": -1}),
    ("applyHealthProtection", {"id": "charm", "seconds": 1, "reduction": 1.1}),
    ("inflictHealthDamage", {"amount": 1, "kind": "typo", "sourceId": "ghost"}),
])
def test_invalid_authoring_is_rejected(kind, params):
    assert health_action_errors(kind, params)


def test_config_page_lazy_open_flush_and_discard(model):
    from tools.editor.editors.game_config_editor import GameConfigEditor
    original = copy.deepcopy(model.game_config)
    try:
        model.game_config["health"] = {"maxHealth": 100, "deathThreshold": 0}
        page = GameConfigEditor(model)
        assert page._health_form is None
        page._health_section.set_expanded(True)
        field = page._health_form.numbers["maxHealth"]
        field.spin.setValue(220)
        page.commit_pending_on_leave()
        assert model.game_config["health"]["maxHealth"] == 220
        field.spin.setValue(400)
        page._load()  # 与 Discard 共用回滚入口
        page.flush_to_model()
        assert model.game_config["health"]["maxHealth"] == 220
        page.deleteLater()
    finally:
        model.game_config = original
