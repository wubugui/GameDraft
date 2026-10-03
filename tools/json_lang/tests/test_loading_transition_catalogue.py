"""Catalogue authority, schema boundaries and fail-closed authoring validation."""
from __future__ import annotations

from dataclasses import replace
import json
import os
from pathlib import Path

import jsonschema
import pytest

from tools.editor import validator
from tools.editor.project_model import ProjectModel
from tools.editor.shared import loading_transition_catalog as catalogue
from tools.editor.shared.scene_ids import new_scene_skeleton
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.json_lang.build import AUTHORITY_FILES, _fingerprint
from tools.json_lang.extract import extract_language_spec, extract_loading_transition_labels
from tools.json_lang.id_universes import collect_id_universes
from tools.json_lang.schema_build import build_schema

ROOT = Path(__file__).resolve().parents[3]


def authority(root, raw):
    data = root / "src/data"
    data.mkdir(parents=True, exist_ok=True)
    (data / "types.ts").write_text(
        "import type incoming from './loadingTransitions.json';\n"
        "export type LoadingTransitionKind = keyof typeof incoming;\n", encoding="utf-8")
    path = data / "loadingTransitions.json"
    path.write_text(raw, encoding="utf-8")
    return path


def test_new_catalogue_keys_and_labels_flow_to_both_consumers(tmp_path, monkeypatch):
    values = {"future_open": {"label": "未来开幕"}, "future_close": {"label": "未来闭幕"}}
    authority(tmp_path, json.dumps(values, ensure_ascii=False))
    monkeypatch.setattr(catalogue, "__file__", str(tmp_path / "tools/editor/shared/loading_transition_catalog.py"))
    assert extract_loading_transition_labels(tmp_path) == {key: value["label"] for key, value in values.items()}
    assert catalogue.loading_transition_choices() == [(key, value["label"]) for key, value in values.items()]


@pytest.mark.parametrize("raw", ["", "null", "[]", "{}", "[", '{"future":{}}', '{"future":{"label":null}}'])
def test_bad_catalogue_rejected_by_editor_and_schema_extract(tmp_path, monkeypatch, raw):
    authority(tmp_path, raw)
    monkeypatch.setattr(catalogue, "__file__", str(tmp_path / "tools/editor/shared/loading_transition_catalog.py"))
    with pytest.raises(ValueError):
        catalogue.loading_transition_choices()
    with pytest.raises(ValueError):
        extract_loading_transition_labels(tmp_path)


def test_missing_catalogue_fails_both_consumers(tmp_path, monkeypatch):
    authority(tmp_path, "{}").unlink()
    monkeypatch.setattr(catalogue, "__file__", str(tmp_path / "tools/editor/shared/loading_transition_catalog.py"))
    with pytest.raises(OSError):
        catalogue.loading_transition_choices()
    with pytest.raises(OSError):
        extract_loading_transition_labels(tmp_path)


def test_changed_alias_or_unwatched_path_is_a_tripwire(tmp_path):
    authority(tmp_path, '{"future":{"label":"未来"}}')
    types = tmp_path / "src/data/types.ts"
    types.write_text("export type LoadingTransitionKind = 'future';\n", encoding="utf-8")
    with pytest.raises(ValueError, match="JSON"):
        extract_loading_transition_labels(tmp_path)
    types.write_text("import incoming from './other.json';\nexport type LoadingTransitionKind = keyof typeof incoming;\n",
                     encoding="utf-8")
    with pytest.raises(ValueError, match="监视路径"):
        extract_loading_transition_labels(tmp_path)


def test_catalogue_changes_invalidate_watch_fingerprint(tmp_path):
    path = authority(tmp_path, '{"future":{"label":"未来"}}')
    assert "src/data/loadingTransitions.json" in AUTHORITY_FILES
    before = _fingerprint(tmp_path)
    assert str(path) in before
    path.write_text('{"future":{"label":"未来2"}}', encoding="utf-8")
    previous = before[str(path)][0]
    os.utime(path, ns=(previous + 1_000_000_000, previous + 1_000_000_000))
    assert _fingerprint(tmp_path) != before


@pytest.fixture(scope="module")
def language():
    spec = extract_language_spec(ROOT)
    universes = collect_id_universes(ROOT)
    return spec, universes, build_schema(spec, universes)


def test_generated_loading_enum_matches_authority_and_leaves_other_schema_unchanged(language):
    spec, universes, schema = language
    expected = catalogue.loading_transition_choices()
    rule = schema["definitions"]["walk"]["allOf"][1]["then"]["patternProperties"]["^loadingTransition$"]
    assert rule["enum"] == [key for key, _label in expected]
    assert rule["enumDescriptions"] == [label for _key, label in expected]
    before = build_schema(replace(spec, loading_transition_labels={}), universes)
    after = json.loads(json.dumps(schema))
    del after["definitions"]["walk"]["allOf"][1]["then"]["patternProperties"]["^loadingTransition$"]
    assert after == before, "Adding the enum must not change additionalProperties or existing rules"


def test_missing_and_catalogue_values_pass_schema_with_master_guard_contract(language):
    _spec, _universes, schema = language
    check = jsonschema.Draft7Validator(schema)
    assert list(check.iter_errors({"id": "unconfigured", "extra": {"keep": 1}})) == []
    for key, _label in catalogue.loading_transition_choices():
        assert list(check.iter_errors({"loadingTransition": key})) == []
    condition = {"heldProp": "player", "socket": "right_hand",
                 "vitalityOp": "<=", "vitality": "guardSafety"}
    assert list(check.iter_errors({"conditions": [condition]})) == []
    action = {"type": "teachPropGuard", "params": {"vitality": "guardSafety", "text": "护火"}}
    assert list(check.iter_errors({"onEnterActions": [action]})) == []


@pytest.mark.parametrize("value", ["future_transition", None, 3, False, [], {}])
def test_invalid_transition_is_schema_failure_and_validator_error(language, tmp_path, value):
    _spec, _universes, schema = language
    assert list(jsonschema.Draft7Validator(schema).iter_errors({"loadingTransition": value}))
    write_minimal_loadable_project(tmp_path)
    model = ProjectModel()
    model.load_project(tmp_path)
    model.scenes = {"probe": {**new_scene_skeleton("probe"), "loadingTransition": value}}
    errors = [issue for issue in validator.validate(model) if issue.item_id == "probe"
              and issue.message.startswith("loadingTransition ")]
    assert len(errors) == 1 and errors[0].severity == "error"


@pytest.mark.parametrize("exception", [OSError("missing catalogue"), ValueError("bad catalogue")])
def test_catalogue_fault_yields_validator_error(tmp_path, monkeypatch, exception):
    def fail():
        raise exception
    monkeypatch.setattr(validator, "loading_transition_choices", fail)
    write_minimal_loadable_project(tmp_path)
    model = ProjectModel()
    model.load_project(tmp_path)
    errors = [issue for issue in validator.validate(model) if issue.data_type == "loadingTransition"]
    assert len(errors) == 1 and errors[0].severity == "error"
