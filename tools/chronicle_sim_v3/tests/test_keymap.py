"""key ↔ path 双向映射测试。"""
from __future__ import annotations

from pathlib import Path

import pytest

from tools.chronicle_sim_v3.engine.errors import ValidationError
from tools.chronicle_sim_v3.engine.keymap import (
    is_listing_key,
    is_text_key,
    key_to_path,
    parse_key,
    path_to_key,
    scan_keys,
)


def test_parse_key_static() -> None:
    assert parse_key("world.setting") == ("world.setting", {})


def test_parse_key_single_param() -> None:
    assert parse_key("world.agent:npc_guan") == ("world.agent", {"_": "npc_guan"})


def test_parse_key_multi_params() -> None:
    base, p = parse_key("chronicle.beliefs:week=3,agent_id=npc_guan")
    assert base == "chronicle.beliefs"
    assert p == {"week": "3", "agent_id": "npc_guan"}


def test_parse_key_invalid() -> None:
    with pytest.raises(ValidationError):
        parse_key("UPPERCASE.bad")
    with pytest.raises(ValidationError):
        parse_key("")


def test_key_to_path_world(tmp_path: Path) -> None:
    assert key_to_path("world.setting", tmp_path).name == "setting.json"
    assert key_to_path("world.agents", tmp_path).name == "agents"
    assert key_to_path("world.agent:npc_guan", tmp_path).name == "npc_guan.json"


def test_key_to_path_chronicle(tmp_path: Path) -> None:
    p = key_to_path("chronicle.events:week=3", tmp_path)
    assert "week_003" in str(p)
    assert p.name == "events"
    p2 = key_to_path("chronicle.event:week=3,id=evt_x", tmp_path)
    assert p2.name == "evt_x.json"
    p3 = key_to_path("chronicle.beliefs:week=12,agent_id=A", tmp_path)
    assert "week_012" in str(p3)
    assert p3.name == "A.json"


def test_key_to_path_text_files(tmp_path: Path) -> None:
    p = key_to_path("chronicle.summary:week=4", tmp_path)
    assert p.name == "summary.md"
    p2 = key_to_path("chronicle.month:n=2", tmp_path)
    assert p2.name == "month_02.md"


def test_key_to_path_unknown_raises(tmp_path: Path) -> None:
    with pytest.raises(ValidationError):
        key_to_path("totally.unknown.base", tmp_path)


def test_key_to_path_missing_param_raises(tmp_path: Path) -> None:
    with pytest.raises((ValidationError, KeyError)):
        key_to_path("chronicle.event:week=3", tmp_path)  # 缺 id


def test_path_to_key_roundtrip_world(tmp_path: Path) -> None:
    keys = [
        "world.setting",
        "world.pillars",
        "world.edges",
        "world.agent:npc_guan",
        "world.faction:f1",
        "world.location:loc_main",
    ]
    for k in keys:
        p = key_to_path(k, tmp_path)
        assert path_to_key(p, tmp_path) == k


def test_path_to_key_roundtrip_chronicle(tmp_path: Path) -> None:
    keys = [
        "chronicle.event:week=3,id=evt_x",
        "chronicle.intent:week=10,id=npc_a",
        "chronicle.draft:week=1,id=d1",
        "chronicle.rumors:week=2",
        "chronicle.summary:week=5",
        "chronicle.observation:week=7",
        "chronicle.public_digest:week=8",
        "chronicle.beliefs:week=3,agent_id=A",
        "chronicle.intent_outcome:week=4,agent_id=B",
        "chronicle.month:n=12",
    ]
    for k in keys:
        p = key_to_path(k, tmp_path)
        assert path_to_key(p, tmp_path) == k


def test_path_to_key_outside_run_dir_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValidationError):
        path_to_key(Path("/etc/hosts"), tmp_path)


def test_is_listing_key() -> None:
    assert is_listing_key("world.agents")
    assert is_listing_key("chronicle.events:week=3")
    assert not is_listing_key("world.setting")
    assert not is_listing_key("chronicle.summary:week=3")


def test_is_text_key() -> None:
    assert is_text_key("chronicle.summary:week=1")
    assert is_text_key("chronicle.month:n=1")
    assert is_text_key("ideas.entry:id=foo")
    assert not is_text_key("world.setting")


def test_scan_keys_world_agents(tmp_path: Path) -> None:
    d = tmp_path / "world" / "agents"
    d.mkdir(parents=True)
    (d / "a.json").write_text("{}")
    (d / "b.json").write_text("{}")
    keys = scan_keys("world.agents", tmp_path)
    assert keys == ["world.agent:a", "world.agent:b"]


def test_scan_keys_chronicle_events(tmp_path: Path) -> None:
    d = tmp_path / "chronicle" / "week_003" / "events"
    d.mkdir(parents=True)
    (d / "evt_a.json").write_text("{}")
    (d / "evt_b.json").write_text("{}")
    keys = scan_keys("chronicle.events:week=3", tmp_path)
    assert keys == [
        "chronicle.event:week=3,id=evt_a",
        "chronicle.event:week=3,id=evt_b",
    ]


def test_scan_keys_weeks(tmp_path: Path) -> None:
    for n in (1, 3, 5):
        (tmp_path / "chronicle" / f"week_{n:03d}").mkdir(parents=True)
    keys = scan_keys("chronicle.weeks", tmp_path)
    assert keys == ["week=1", "week=3", "week=5"]


def test_scan_keys_empty(tmp_path: Path) -> None:
    assert scan_keys("world.agents", tmp_path) == []
    assert scan_keys("chronicle.events:week=99", tmp_path) == []


def test_scan_keys_unknown(tmp_path: Path) -> None:
    with pytest.raises(ValidationError):
        scan_keys("unknown.base", tmp_path)
