import copy
import json

import pytest

from tools.vfx_workbench import assets
from tools.editor.shared.vfx_timing import timing_problems


def document():
    return {"id": "timing", "prewarmSeconds": [1, 4], "future": {"keep": [3, 1]}, "emitters": [{
        "id": "smoke", "appearance": {"image": "/smoke.png", "sizeWu": 10},
        "spawn": {"max": 20, "rate": 3, "intervalJitter": 0.35},
    }]}


def test_timing_save_load_roundtrip_preserves_unknowns_and_other_effects(tmp_path, monkeypatch):
    monkeypatch.setattr(assets, "VFX_DIR", tmp_path)
    other = tmp_path / "untouched.json"; other.write_bytes(b'{"keep": 1}')
    doc = document(); before = copy.deepcopy(doc)
    path, saved, _ = assets.save_asset(doc)
    assert assets.load_asset("timing") == saved == before
    assert not timing_problems(saved)
    assert other.read_bytes() == b'{"keep": 1}'
    assert doc == before
    assert json.loads(path.read_text(encoding="utf-8"))["prewarmSeconds"] == [1, 4]


@pytest.mark.parametrize("value", [None, [3, 1], [-1, 2], [0, 16], [True, 2], [0, float("nan")]])
def test_invalid_warmup_rejected_by_both_gates(value):
    doc = document(); doc["prewarmSeconds"] = value
    assert timing_problems(doc)
    with pytest.raises(ValueError, match="prewarmSeconds"):
        assets.normalize_effect(doc)


@pytest.mark.parametrize("value", [None, True, -0.1, 1, float("inf")])
def test_invalid_jitter_rejected_by_both_gates(value):
    doc = document(); doc["emitters"][0]["spawn"]["intervalJitter"] = value
    assert timing_problems(doc)
    with pytest.raises(ValueError, match="intervalJitter"):
        assets.normalize_effect(doc)
