import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
import json
import pytest
from PySide6.QtWidgets import QApplication
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.shared.survival_save_validation import survival_save_errors
from tools.editor.shared.health_forms import health_handle_rows


@pytest.fixture()
def model(tmp_path):
    app = QApplication.instance() or QApplication([])
    write_minimal_loadable_project(tmp_path)
    model = ProjectModel()
    model.load_project(tmp_path)
    yield model
    assert app is not None


def test_invalid_numbers_block_all_writes_before_commit(model):
    path = model.data_path / "game_config.json"
    original = path.read_bytes()
    model.game_config["health"] = {"maxHealth": -1}
    model.mark_dirty("config")
    with pytest.raises(ValueError, match="夜间生存"):
        model.save_all()
    assert path.read_bytes() == original


def test_dirty_scope_keeps_unrelated_invalid_scene_out_of_save_gate(model):
    model.scenes["untouched"] = {"id": "untouched", "hotspots": [{"id": "bad", "healthThreat": {"attackPerSecond": -1}}]}
    model.mark_dirty("scene", "sc_a")
    assert not survival_save_errors(model, {"scene"})


def test_narrative_declarations_are_visible_to_selectors_and_references(model):
    model.narrative_graphs = {"graphs": [{"id": "story", "states": {"teach": {"onEnterActions": [
        {"type": "lockHealth", "params": {"id": "teach", "min": 20}},
        {"type": "unlockHealth", "params": {"id": "teach"}},
    ]}}}]}
    assert ("teach", "teach") in health_handle_rows(model, "lockHealth")
    assert not survival_save_errors(model, {"narrative_graphs"})
    model.narrative_graphs["graphs"][0]["states"]["teach"]["onEnterActions"].pop(0)
    assert any("teach" in error for error in survival_save_errors(model, {"narrative_graphs"}))


def test_fire_config_is_not_mistaken_for_a_hotspot_component(model):
    model.game_config["health"] = {"fireProtection": {"heldPropIds": [], "lossGraceSeconds": .1}}
    assert not survival_save_errors(model, {"config"})


def test_threat_rename_or_delete_refuses_dangling_item_before_writing(model):
    from copy import deepcopy
    scene = model.scenes['sc_a']
    scene.setdefault('npcs', []).append({'id': 'ghost', 'name': 'ghost', 'x': 10, 'y': 10,
        'healthThreat': {'id': 'caller', 'kind': 'yin', 'boundaryRadius': 100, 'damageRadius': 80, 'attackPerSecond': 3}})
    model.items = [{'id': 'amulet', 'name': '护身物', 'healthProtection': {'threatIds': ['caller'], 'reduction': .5}}]
    threat = scene['npcs'][-1]['healthThreat']
    before = deepcopy(threat)
    for replacement in ({**before, 'id': 'new_caller'}, None):
        if replacement is None:
            scene['npcs'][-1].pop('healthThreat', None)
        else:
            scene['npcs'][-1]['healthThreat'] = replacement
        errors = survival_save_errors(model, {'scene'})
        assert any('amulet' in e and 'caller' in e for e in errors)
    scene['npcs'][-1]['healthThreat'] = {**before, 'id': 'new_caller'}
    model.items[0]['healthProtection']['threatIds'] = ['new_caller']
    assert not survival_save_errors(model, {'scene', 'item'})


def test_vfx_harassment_is_a_selectable_protection_source(model):
    from tools.editor.shared.health_forms import health_source_rows
    model.vfx_effects = {'bats': {'id': 'bats', 'emitters': [{'id': 'flock', 'behavior': {'harassment': {'radius': 20, 'height': 90, 'attackPerSecond': 5}}}]}}
    model.items = [{'id': 'amulet', 'healthProtection': {'threatIds': ['vfx:bats:flock'], 'kinds': ['fright'], 'reduction': 1}}]
    assert 'vfx:bats:flock' in dict(health_source_rows(model))
    assert not survival_save_errors(model, {'item'})
