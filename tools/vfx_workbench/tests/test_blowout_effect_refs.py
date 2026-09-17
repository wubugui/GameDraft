# -*- coding: utf-8 -*-
"""风吹灭块（挂件预设 ``blowout`` / ``states[*].blowout``）的越线动作 ``onEmberActions`` / ``onOutActions``
里的 ``playPropVfx``，在粒子工作台这一侧**算效果引用**。

漏扫 = 工作台里把"火把被风吹灭时冒的那口烟"改名 / 删掉，游戏里风一吹灭静默不冒烟。
写盘一律在临时目录（``assets.VFX_DIR`` / ``placements.LIB_ROOT`` / ``placements.REF_ROOT`` 全指到 tmp）。
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.vfx_workbench import assets, placements  # noqa: E402


def _effect(eid: str) -> dict:
    return {"id": eid, "emitters": [{"id": "a", "appearance": {"image": "/x.png", "sizeWu": 4},
                                     "spawn": {"max": 3, "burst": 3}}]}


@pytest.fixture()
def world(tmp_path, monkeypatch):
    monkeypatch.setattr(assets, "VFX_DIR", tmp_path / "vfx")
    monkeypatch.setattr(placements, "LIB_ROOT", tmp_path / "libroot")
    monkeypatch.setattr(placements, "REF_ROOT", tmp_path / "refroot")
    for eid in ("smoke", "sparks"):
        assets.save_asset(_effect(eid))
    data = tmp_path / "refroot" / "public" / "assets" / "data"
    data.mkdir(parents=True)
    doc = {"torch": {
        "blowout": {"windSpeed": 8, "drainSeconds": 4, "recoverSeconds": 3, "emberBelow": 0.35,
                    "onEmberActions": [{"type": "playPropVfx", "params": {"effect": "sparks"}}],
                    "onOutActions": [
                        {"type": "runActions", "params": {"actions": [
                            {"type": "playPropVfx",
                             "params": {"target": "player", "socket": "right_hand", "effect": "smoke"}}]}},
                        {"type": "playPropVfx", "params": {"effect": "smoke"}}]},
        "states": {"lit": {}, "guarding": {"blowout": {
            "windSpeed": 14, "drainSeconds": 4, "recoverSeconds": 3,
            "onOutActions": [{"type": "playPropVfx", "params": {"effect": "smoke", "point": [0.5, 0.1]}}]}}},
    }}
    raw = json.dumps(doc, ensure_ascii=False).encode("utf-8")
    (data / "prop_presets.json").write_bytes(raw)
    return data / "prop_presets.json", raw


def test_play_prop_vfx_in_blowout_lists_counts_as_effect_reference(world) -> None:
    path, raw = world
    refs = placements.external_refs_to_effect("smoke")
    assert [(r["kind"], r.get("action"), r["where"]) for r in refs] == [
        ("action", "playPropVfx", "torch.blowout.onOutActions[0].params.actions[0]"),
        ("action", "playPropVfx", "torch.blowout.onOutActions[1]"),
        ("action", "playPropVfx", "torch.states.guarding.blowout.onOutActions[0]"),
    ], refs
    assert all(r["file"] == "public/assets/data/prop_presets.json" for r in refs)
    assert [r["where"] for r in placements.external_refs_to_effect("sparks")] == ["torch.blowout.onEmberActions[0]"]


def test_blowout_refs_guard_rename_and_delete_without_touching_the_preset(world) -> None:
    path, raw = world
    with pytest.raises(ValueError) as e:
        placements.rename_effect("smoke", "smoke2")
    assert "playPropVfx" in str(e.value) and "prop_presets.json" in str(e.value), str(e.value)
    assert (assets.VFX_DIR / "smoke.json").is_file() and not (assets.VFX_DIR / "smoke2.json").exists()
    r = placements.delete_effect("sparks", with_placements=False)
    assert r["deleted"] is False and r["needConfirm"] is True and len(r["externalRefs"]) == 1
    assert (assets.VFX_DIR / "sparks.json").is_file()
    assert path.read_bytes() == raw, "工作台不写挂件预设"
