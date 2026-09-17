from copy import deepcopy
from pathlib import Path
import json
import pytest
from tools.vfx_workbench.assets import normalize_effect
from tools.editor.shared.vfx_harassment import harassment_errors


def test_harassment_roundtrip_and_invalid_numbers():
    doc = json.loads((Path(__file__).resolve().parents[3] / 'public/assets/data/vfx/bat_cliff.json').read_text('utf-8'))
    be = next(e['behavior'] for e in doc['emitters'] if 'behavior' in e)
    be['harassment'] = {'radius': 55.125, 'height': 90, 'attackPerSecond': 5.25}
    assert normalize_effect(doc)['emitters'][0]['behavior']['harassment'] == be['harassment']
    for value in (None, {'radius': 0, 'height': 0, 'attackPerSecond': 1}, {'radius': True, 'height': 1, 'attackPerSecond': 1}):
        assert harassment_errors(value)
        bad = deepcopy(doc)
        bad['emitters'][0]['behavior']['harassment'] = value
        with pytest.raises(ValueError, match='harassment'):
            normalize_effect(bad)


def test_workbench_cannot_remove_or_rename_referenced_harassment(tmp_path, monkeypatch):
    from tools.vfx_workbench import assets
    directory = tmp_path / 'public/assets/data/vfx'
    directory.mkdir(parents=True)
    monkeypatch.setattr(assets, 'VFX_DIR', directory)
    doc = json.loads((Path(__file__).resolve().parents[3] / 'public/assets/data/vfx/bat_cliff.json').read_text('utf-8'))
    _, doc, _ = assets.save_asset(doc, base=None)
    emitter = next(e for e in doc['emitters'] if e.get('behavior', {}).get('harassment'))
    ref = f"vfx:{doc['id']}:{emitter['id']}"
    (directory.parent / 'items.json').write_text(json.dumps([{'id': 'amulet', 'healthProtection': {'threatIds': [ref]}}]), 'utf-8')
    original = assets.asset_path(doc['id']).read_bytes()
    changed = deepcopy(doc)
    next(e for e in changed['emitters'] if e['id'] == emitter['id'])['behavior'].pop('harassment')
    for operation in (lambda: assets.save_asset(changed, base=doc), lambda: assets.delete_asset(doc['id']), lambda: assets.rename_asset(doc['id'], 'new_bats')):
        with pytest.raises(ValueError, match='仍被'):
            operation()
        assert assets.asset_path(doc['id']).read_bytes() == original
        assert not assets.asset_path('new_bats').exists()
