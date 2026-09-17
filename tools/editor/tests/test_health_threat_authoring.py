from __future__ import annotations
import os
from pathlib import Path
import pytest
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from PySide6.QtWidgets import QApplication
from tools.editor.project_model import ProjectModel
from tools.editor.shared.health_threat_form import HealthThreatSection


@pytest.fixture(scope="module")
def model():
    app = QApplication.instance() or QApplication([])
    m = ProjectModel()
    m.load_project(Path(__file__).resolve().parents[3])
    yield m
    assert app is not None


def test_threat_create_clear_reopen(model):
    section = HealthThreatSection(model)
    entity = {"id": "caller"}
    section.load_entity(entity, "跑马梁")
    section.write_to(entity)
    assert entity == {"id": "caller"}
    section.set_expanded(True)
    section.form.enabled.setChecked(True)
    section.form.fields["id"].setText("ridge_caller")
    section.form.fields["attackPerSecond"].spin.setValue(3.5)
    section.form.fields["nearRadius"].enabled.setChecked(True)
    section.form.fields["nearRadius"].spin.setValue(40)
    section.form.fields["nearAttackPerSecond"].enabled.setChecked(True)
    section.form.fields["nearAttackPerSecond"].spin.setValue(400)
    section.write_to(entity)
    assert entity["healthThreat"] == {"id": "ridge_caller", "kind": "yin", "boundaryRadius": 240,
        "damageRadius": 180, "attackPerSecond": 3.5, "nearRadius": 40, "nearAttackPerSecond": 400}
    section.load_entity(entity, "跑马梁")
    section.form.fields["nearAttackPerSecond"].enabled.setChecked(False)
    section.write_to(entity)
    assert "nearAttackPerSecond" not in entity["healthThreat"]
    section.form.enabled.setChecked(False)
    section.write_to(entity)
    assert "healthThreat" not in entity
    section.deleteLater()


def test_threat_untouched_roundtrip_keeps_precision_and_unknowns(model):
    raw = {"id": "caller", "healthThreat": {"id": "ghost", "kind": "yin", "boundaryRadius": 240,
        "damageRadius": 180, "attackPerSecond": 0.123456789, "future": [1, 2], "nightOnly": False}}
    section = HealthThreatSection(model)
    section.load_entity(raw, "跑马梁")
    section.set_expanded(True)
    out = {}
    section.write_to(out)
    assert out["healthThreat"] == raw["healthThreat"]
    section.form.fields["id"].setText("renamed")
    section.write_to(out)
    assert out["healthThreat"]["attackPerSecond"] == 0.123456789
    assert out["healthThreat"]["future"] == [1, 2]
    section.deleteLater()


def test_environment_fire_create_and_roundtrip(model):
    from tools.editor.shared.fire_protection_form import EnvironmentFireSection, FireProtectionConfigForm
    section = EnvironmentFireSection(model)
    out = {"id": "campfire"}
    section.load_entity(out, "跑马梁")
    section.set_expanded(True)
    section.form.enabled.setChecked(True)
    section.form.burning.setCurrentIndex(section.form.burning.findData(False))
    section.write_to(out)
    assert out["fireProtection"] == {"radius": 180, "requiresBurning": False}
    out["fireProtection"].update(radius=123.123456789, future="keep")
    section.load_entity(out, "跑马梁")
    result = {}
    section.write_to(result)
    assert result["fireProtection"] == out["fireProtection"]
    section.form.enabled.setChecked(False)
    section.write_to(result)
    assert "fireProtection" not in result
    cfg = FireProtectionConfigForm(model, {"heldPropIds": ["missing"], "lossGraceSeconds": 0.123456789, "future": True})
    assert cfg.value()["lossGraceSeconds"] == 0.123456789
    cfg.props.setCurrentRow(0)
    cfg._remove()
    assert cfg.value() == {"heldPropIds": [], "lossGraceSeconds": 0.123456789, "future": True}
    section.deleteLater()
    cfg.deleteLater()


def test_threat_signal_catalog_rename_delete_undo():
    from tools.editor.tests.test_signal_refactor import FakeModel
    from tools.editor.shared.signal_refactor import rename_signal, delete_signal, undo_delete
    from tools.editor.shared.narrative_catalog import _collect_emitted_signal_ids
    from tools.editor.shared.prop_preset_refs import rename_prop_references, scan_prop_usages
    from copy import deepcopy
    m = FakeModel()
    m.scenes = {"ridge": {"id": "ridge", "npcs": [{"id": "ghost", "healthThreat": {
        "id": "threat", "enteredSignal": "sig_a", "repelledSignal": "sig_a"}}]}}
    m.game_config = {"health": {"fireProtection": {"heldPropIds": ["torch"]}}}
    out = set()
    _collect_emitted_signal_ids(m.scenes, out)
    assert out == {"sig_a"}
    rename_signal(m, "sig_a", "renamed")
    threat = m.scenes["ridge"]["npcs"][0]["healthThreat"]
    assert threat["enteredSignal"] == threat["repelledSignal"] == "renamed"
    before = deepcopy(m.scenes)
    _, undo = delete_signal(m, "renamed", force=True)
    assert "enteredSignal" not in threat and "repelledSignal" not in threat
    undo_delete(m, undo)
    assert m.scenes == before
    assert scan_prop_usages(m, "torch")
    assert rename_prop_references(m, "torch", "new_torch") == 1
    assert m.game_config["health"]["fireProtection"]["heldPropIds"] == ["new_torch"]
