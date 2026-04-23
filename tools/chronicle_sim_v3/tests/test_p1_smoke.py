"""P1 端到端 smoke：跑 data/graphs/p1_smoke.yaml。"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from typer.testing import CliRunner

from tools.chronicle_sim_v3.cli.main import app
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run


_runner = CliRunner()
_SMOKE_GRAPH = (
    Path(__file__).resolve().parents[1] / "data" / "graphs" / "p1_smoke.yaml"
)


def _seed_agents(rd: Path) -> None:
    a = rd / "world" / "agents"
    a.mkdir(parents=True, exist_ok=True)
    (a / "s1.json").write_text(json.dumps({"id": "s1", "tier": "S", "life_status": "alive"}))
    (a / "s2.json").write_text(json.dumps({"id": "s2", "tier": "S", "life_status": "alive"}))
    (a / "a1.json").write_text(json.dumps({"id": "a1", "tier": "A", "life_status": "alive"}))
    (a / "dead.json").write_text(json.dumps({"id": "dead", "tier": "S", "life_status": "dead"}))


def test_smoke_yaml_validates() -> None:
    res = _runner.invoke(app, ["graph", "validate", str(_SMOKE_GRAPH)])
    assert res.exit_code == 0, res.output


def test_smoke_yaml_e2e(tmp_path: Path) -> None:
    rd = make_stub_run(tmp_path)
    _seed_agents(rd)
    res = _runner.invoke(
        app,
        ["cook", "run", str(_SMOKE_GRAPH), "--run", str(rd),
         "--input", "week=1", "--cook-id", "smoke1"],
    )
    assert res.exit_code == 0, res.output
    assert "status:  completed" in res.output
    # 验证产物
    cook_dir = rd / "cooks" / "smoke1"
    assert (cook_dir / "result.json").is_file()
    result = json.loads((cook_dir / "result.json").read_text(encoding="utf-8"))
    assert result["status"] == "completed"
    assert result["outputs"]["s_count"] == 2  # 两个 alive 的 S
    assert isinstance(result["outputs"]["text"], str)
    # 节点产物
    for nid in ("agents", "alive", "by_tier", "s_count", "summary"):
        assert (cook_dir / nid / "output.json").is_file()
    # timeline
    tl = cook_dir / "timeline.jsonl"
    text = tl.read_text(encoding="utf-8")
    assert "cook.start" in text
    assert "cook.end" in text


def test_smoke_yaml_cache_replay(tmp_path: Path) -> None:
    """二次跑应触发 cache_hit（除 agent.cline 节点外）。"""
    rd = make_stub_run(tmp_path)
    _seed_agents(rd)
    _runner.invoke(
        app,
        ["cook", "run", str(_SMOKE_GRAPH), "--run", str(rd),
         "--input", "week=1", "--cook-id", "r1"],
    )
    _runner.invoke(
        app,
        ["cook", "run", str(_SMOKE_GRAPH), "--run", str(rd),
         "--input", "week=1", "--cook-id", "r2"],
    )
    # 至少 agents / alive / by_tier / s_count 命中
    hits = sorted(p.parent.name for p in (rd / "cooks" / "r2").rglob("cache_hit.txt"))
    assert "agents" in hits
    assert "alive" in hits
    assert "by_tier" in hits
    assert "s_count" in hits
    # agent.cline deterministic=False，不应命中（除非显式 cache=hash）
    assert "summary" not in hits
