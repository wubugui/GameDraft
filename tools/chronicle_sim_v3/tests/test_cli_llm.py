"""csim llm test/test-emb/route/models/usage/audit/cache。"""
from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from tools.chronicle_sim_v3.cli.main import app
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run


_runner = CliRunner()


def test_llm_test_offline_returns_text(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    res = _runner.invoke(
        app,
        ["llm", "test", "--run", str(run), "--model", "offline", "--prompt", "你好"],
    )
    assert res.exit_code == 0, res.output
    assert "[stub" in res.output
    assert (run / "audit" / "llm").exists()


def test_llm_audit_tail(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    _runner.invoke(
        app,
        ["llm", "test", "--run", str(run), "--model", "offline", "--prompt", "x"],
    )
    res = _runner.invoke(app, ["llm", "audit", "tail", "--run", str(run), "-n", "5"])
    assert res.exit_code == 0
    assert "request" in res.output
    assert "response" in res.output


def test_llm_usage_shows_calls(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    _runner.invoke(
        app,
        ["llm", "test", "--run", str(run), "--model", "offline", "--prompt", "x"],
    )
    res = _runner.invoke(app, ["llm", "usage", "--run", str(run)])
    assert res.exit_code == 0
    assert "offline" in res.output
    assert "calls=1" in res.output


def test_llm_route_show(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    res = _runner.invoke(app, ["llm", "route", "show", "--run", str(run)])
    assert res.exit_code == 0
    assert "offline" in res.output
    assert "embed" in res.output


def test_llm_models(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    res = _runner.invoke(app, ["llm", "models", "--run", str(run)])
    assert res.exit_code == 0
    assert "stub" in res.output


def test_llm_test_emb(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    res = _runner.invoke(
        app,
        ["llm", "test-emb", "--run", str(run), "--model", "embed", "--texts", "a,b"],
    )
    assert res.exit_code == 0, res.output
    assert "dim=8" in res.output


def test_llm_cache_stats_and_clear(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    _runner.invoke(
        app,
        ["llm", "test", "--run", str(run), "--model", "offline", "--prompt", "x"],
    )
    res = _runner.invoke(app, ["llm", "cache", "stats", "--run", str(run)])
    assert res.exit_code == 0
    assert "chat=1" in res.output
    res2 = _runner.invoke(app, ["llm", "cache", "clear", "--run", str(run)])
    assert res2.exit_code == 0
    assert "1" in res2.output
