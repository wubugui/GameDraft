"""挂件预设状态的进入时动作（`prop_presets.json` 的 `states[*].onEnterActions`，2026-09-15 燃烧物契约）
在语言大脑里的可见性。

json_lang 刻意**不建模文档结构**（结构无关深扫描），所以这里没有、也不该有一份"挂件预设 schema"——
要钉的是：这个新位置上的动作树**自动**被三件事看见：

1. 动作数组宿主键实证扫描（`onEnterActions` 出现在宿主键里 → 补全给动作骨架）；
2. schema 的 action 签名深扫描（未登记的动作类型当场报违例）；
3. 查引用（状态动作里引用的 id 能被找出来）。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.json_lang.extract import extract_language_spec
from tools.json_lang.id_universes import collect_id_universes
from tools.json_lang.refs import find_refs
from tools.json_lang.schema_build import build_schema

REPO = Path(__file__).resolve().parents[3]


def _root(tmp_path: Path, on_enter: list) -> tuple[Path, dict]:
    data = tmp_path / "public/assets/data"
    data.mkdir(parents=True)
    (tmp_path / "public/assets/scenes").mkdir(parents=True)
    (tmp_path / "public/assets/dialogues/graphs").mkdir(parents=True)
    doc = {
        "torch": {
            "image": "/resources/runtime/images/props/torch.png",
            "firePoint": [0.5, 0.05],
            "flame": {"image": "/resources/runtime/images/ui/three_fires_sheet.png",
                      "cols": 12, "frames": 64, "height": 30},
            "states": {"lit": {"burn": 1}, "out": {"burn": 0, "onEnterActions": on_enter}},
        },
    }
    (data / "prop_presets.json").write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    return tmp_path, doc


def test_on_enter_actions_is_discovered_as_an_action_host_key(tmp_path: Path) -> None:
    root, _ = _root(tmp_path, [{"type": "playSfx", "params": {"id": "sfx_torch_out"}}])
    assert "onEnterActions" in collect_id_universes(root).action_host_keys


def test_refs_inside_state_actions_are_found(tmp_path: Path) -> None:
    root, _ = _root(tmp_path, [{"type": "playSfx", "params": {"id": "sfx_torch_out"}}])
    refs = find_refs(root, "sfx_torch_out")
    assert [r.pointer for r in refs] == ["/torch/states/out/onEnterActions/0/params/id"]


def test_schema_checks_actions_inside_state_on_enter_actions(tmp_path: Path) -> None:
    jsonschema = pytest.importorskip("jsonschema")
    spec = extract_language_spec(REPO)
    bad_root, bad_doc = _root(tmp_path / "bad", [{"type": "__definitely_not_registered__", "params": {}}])
    schema = build_schema(spec, collect_id_universes(bad_root))
    errors = list(jsonschema.Draft7Validator(schema).iter_errors(bad_doc))
    assert errors, "状态进入动作里的未登记动作类型必须被 schema 深扫描看见"

    good_root, good_doc = _root(tmp_path / "good", [{"type": "playSfx", "params": {"id": "x"}}])
    schema = build_schema(spec, collect_id_universes(good_root))
    assert list(jsonschema.Draft7Validator(schema).iter_errors(good_doc)) == []
