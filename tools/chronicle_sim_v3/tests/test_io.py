"""engine/io.py：YAML round-trip / atomic 写。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.engine.io import (
    atomic_write_json,
    atomic_write_text,
    dump_yaml_str,
    read_json,
    read_yaml,
    read_yaml_text,
    write_yaml_canonical,
)


def test_yaml_roundtrip_preserves_content(tmp_path: Path) -> None:
    p = tmp_path / "x.yaml"
    src = "a: 1\nb:\n  - x\n  - y\nname: 中文\n"
    p.write_text(src, encoding="utf-8")
    data = read_yaml(p)
    out = dump_yaml_str(data)
    assert "中文" in out
    assert "a: 1" in out
    assert read_yaml_text(out) == data


def test_yaml_canonical_key_order(tmp_path: Path) -> None:
    p = tmp_path / "x.yaml"
    write_yaml_canonical(p, {"z": 1, "a": 2, "m": 3}, key_order=["a", "z"])
    text = p.read_text(encoding="utf-8")
    lines = [l.split(":")[0] for l in text.splitlines() if l and not l.startswith(" ")]
    assert lines == ["a", "z", "m"]


def test_yaml_canonical_round_trip_byte_stable(tmp_path: Path) -> None:
    p = tmp_path / "x.yaml"
    data = {"a": 1, "b": [1, 2, 3], "c": {"x": "y"}}
    write_yaml_canonical(p, data, key_order=["a", "b", "c"])
    first = p.read_bytes()
    loaded = read_yaml(p)
    write_yaml_canonical(p, dict(loaded), key_order=["a", "b", "c"])
    second = p.read_bytes()
    assert first == second


def test_atomic_write_text_creates_parents(tmp_path: Path) -> None:
    p = tmp_path / "deep" / "deeper" / "x.txt"
    atomic_write_text(p, "hi")
    assert p.read_text(encoding="utf-8") == "hi"


def test_atomic_write_text_no_tmp_left_on_success(tmp_path: Path) -> None:
    p = tmp_path / "x.txt"
    atomic_write_text(p, "ok")
    leftovers = [c for c in tmp_path.iterdir() if c.name.startswith(".tmp_")]
    assert leftovers == []


def test_atomic_write_text_no_tmp_left_on_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import os

    real_replace = os.replace
    calls = {"n": 0}

    def boom(src, dst):
        calls["n"] += 1
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(RuntimeError):
        atomic_write_text(tmp_path / "x.txt", "data")
    leftovers = [c for c in tmp_path.iterdir() if c.name.startswith(".tmp_")]
    assert leftovers == []
    monkeypatch.setattr(os, "replace", real_replace)


def test_atomic_write_json_round_trip(tmp_path: Path) -> None:
    p = tmp_path / "x.json"
    data = {"b": 2, "a": 1, "list": [1, 2, 3]}
    atomic_write_json(p, data)
    loaded = read_json(p)
    assert loaded == data
    text = p.read_text(encoding="utf-8")
    assert text.endswith("\n")
    keys_in_order = [k for k in json.loads(text)]
    assert keys_in_order == sorted(data.keys())


def test_read_yaml_empty_file_returns_dict(tmp_path: Path) -> None:
    p = tmp_path / "empty.yaml"
    p.write_text("", encoding="utf-8")
    assert read_yaml(p) == {}
