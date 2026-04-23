"""Cook + CookState + CookManager 持久化。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.engine.cook import (
    Cook,
    CookManager,
    CookResult,
    CookState,
    NodeState,
    new_cook_id,
)


def test_new_cook_id_format() -> None:
    cid = new_cook_id()
    assert "_" in cid
    ts, _, suf = cid.rpartition("_")
    assert "T" in ts and ts.endswith("Z")
    assert len(suf) == 6


def test_create_and_load(tmp_path: Path) -> None:
    mgr = CookManager(tmp_path)
    cook = mgr.create()
    assert cook.dir.is_dir()
    assert mgr.list_cook_ids() == [cook.cook_id]
    again = mgr.load(cook.cook_id)
    assert again.cook_id == cook.cook_id


def test_create_duplicate_rejected(tmp_path: Path) -> None:
    mgr = CookManager(tmp_path)
    cook = mgr.create(cook_id="fixed_id")
    with pytest.raises(FileExistsError):
        mgr.create(cook_id="fixed_id")


def test_manifest_round_trip(tmp_path: Path) -> None:
    cook = CookManager(tmp_path).create(cook_id="cid")
    cook.write_manifest(
        graph_path="data/graphs/x.yaml",
        graph_content_hash="abc",
        engine_format_ver="1",
        inputs={"week": 3},
        concurrency={"enabled": True, "max_inflight": 4},
        cache_cfg={"enabled": True},
    )
    m = cook.read_manifest()
    assert m["cook_id"] == "cid"
    assert m["inputs"] == {"week": 3}


def test_state_round_trip(tmp_path: Path) -> None:
    cook = CookManager(tmp_path).create(cook_id="c1")
    s = CookState(status="running")
    s.nodes["a"] = NodeState(status="done", duration_ms=12)
    s.nodes["b"] = NodeState(status="ready")
    cook.save_state(s)
    s2 = cook.load_state()
    assert s2.status == "running"
    assert s2.nodes["a"].status == "done"
    assert s2.nodes["a"].duration_ms == 12
    assert s2.nodes["b"].status == "ready"


def test_timeline_append_and_read(tmp_path: Path) -> None:
    cook = CookManager(tmp_path).create(cook_id="c1")
    cook.append_timeline({"event": "cook.start", "ts": "1"})
    cook.append_timeline({"event": "node.end", "ts": "2", "node_id": "x"})
    rows = cook.read_timeline()
    assert len(rows) == 2
    assert rows[1]["node_id"] == "x"


def test_node_artifacts(tmp_path: Path) -> None:
    cook = CookManager(tmp_path).create(cook_id="c1")
    cook.write_node_artifacts(
        "agents",
        inputs={"x": 1},
        params={"y": 2},
        output_values={"out": [1, 2]},
        mutations=[{"op": "put_json", "key": "world.setting", "payload": {}}],
        cache_key="abc",
        cache_hit=False,
    )
    d = cook.dir / "agents"
    assert (d / "inputs.json").is_file()
    assert (d / "output.json").is_file()
    assert (d / "cache_key.txt").read_text(encoding="utf-8").strip() == "abc"
    assert not (d / "cache_hit.txt").exists()


def test_node_artifacts_cache_hit(tmp_path: Path) -> None:
    cook = CookManager(tmp_path).create(cook_id="c1")
    cook.write_node_artifacts(
        "x", inputs={}, params={}, output_values={},
        mutations=[], cache_key="hit", cache_hit=True,
    )
    assert (cook.dir / "x" / "cache_hit.txt").read_text(encoding="utf-8").strip() == "hit"


def test_result_round_trip(tmp_path: Path) -> None:
    cook = CookManager(tmp_path).create(cook_id="c1")
    cook.write_result(CookResult(
        cook_id="c1", status="completed",
        outputs={"r": [1, 2, 3]}, duration_ms=42,
    ))
    r = cook.read_result()
    assert r["status"] == "completed"
    assert r["outputs"] == {"r": [1, 2, 3]}
