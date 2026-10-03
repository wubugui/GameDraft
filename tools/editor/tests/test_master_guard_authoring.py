"""Merged authoring still exposes real guard thresholds and their two readers."""
from pathlib import Path
import json

import pytest
from PySide6.QtWidgets import QApplication

from tools.dialogue_graph_editor.dialogue_condition_text import held_prop_leaf_text
from tools.editor.shared.animation_contact_ao import animation_contact_ao_enabled
from tools.editor.shared.vitality_threshold_field import VitalityThresholdField
from tools.editor.validator import _prop_player_control_issues
from tools.narrative_xref.phrases import _held_prop_phrase

ROOT = Path(__file__).resolve().parents[3]


@pytest.mark.parametrize("value,valid", [(0.6, True), (0.637, True), (0, False), (1, False),
                                         (-0.1, False), (1.1, False), (None, False), (True, False), ("0.6", False)])
def test_preset_guard_safety_matches_strict_runtime_open_interval(value, valid):
    issues = []
    _prop_player_control_issues({"guardSafety": value}, "probe", {}, issues)
    errors = [issue for issue in issues if "playerControl.guardSafety" in issue.message]
    assert (errors == []) is valid
    assert all(issue.severity == "error" for issue in errors)


@pytest.mark.parametrize("op", ["<", "<=", ">", ">="])
def test_both_condition_readers_name_the_shared_guard_threshold(op):
    leaf = {"heldProp": "player", "vitalityOp": op, "vitality": "guardSafety"}
    for reader in (held_prop_leaf_text, _held_prop_phrase):
        text = reader(leaf)
        assert f"火势{op}预设安全线" in text
        assert "guardSafety" not in text
        assert f"火势{op}0.637" in reader({**leaf, "vitality": 0.637})


@pytest.mark.parametrize("value", [0.637123, "guardSafety", "future", None, {"z": 1, "a": 2}])
def test_threshold_selector_preserves_raw_then_explicit_choice(value):
    app = QApplication.instance() or QApplication([])
    widget = VitalityThresholdField()
    try:
        widget.setValue(value)
        assert widget.value() == value
        widget.source.setCurrentIndex(widget.source.findData("guardSafety"))
        assert widget.value() == "guardSafety"
        widget.source.setCurrentIndex(widget.source.findData("number"))
        widget.number.setValue(0.75)
        assert widget.value() == 0.75
    finally:
        widget.deleteLater()
        app.processEvents()


def test_animation_ao_default_state_names_are_catalogue_driven_and_explicit_bool_wins():
    defaults = json.loads((ROOT / "src/data/animationContactAoDefaults.json").read_text(encoding="utf-8"))
    enabled = set(defaults["enabledStates"])
    for name in [*enabled, "new_state", "slow_walk", "idle_alias"]:
        assert animation_contact_ao_enabled(name) is (name in enabled)
        assert animation_contact_ao_enabled(name, {"contactAoEnabled": True}) is True
        assert animation_contact_ao_enabled(name, {"contactAoEnabled": False}) is False
        for bad in (None, "false", 0, 1):
            assert animation_contact_ao_enabled(name, {"contactAoEnabled": bad}) is (name in enabled)
