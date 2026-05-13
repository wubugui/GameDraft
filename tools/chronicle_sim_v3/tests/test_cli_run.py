"""csim run init/list/show/delete/fork。"""
from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from tools.chronicle_sim_v3.cli.main import app


_runner = CliRunner()


def test_run_init_creates_structure(tmp_path: Path) -> None:
    rd = tmp_path / "r1"
    res = _runner.invoke(app, ["run", "init", str(rd), "--name", "first"])
    assert res.exit_code == 0, res.output
    assert (rd / "meta.json").is_file()
    assert (rd / "config" / "llm.yaml").is_file()
    assert (rd / "config" / "cook.yaml").is_file()
    meta = json.loads((rd / "meta.json").read_text(encoding="utf-8"))
    assert meta["name"] == "first"
    assert "run_id" in meta


def test_run_init_refuses_existing(tmp_path: Path) -> None:
    rd = tmp_path / "r1"
    _runner.invoke(app, ["run", "init", str(rd), "--name", "first"])
    res = _runner.invoke(app, ["run", "init", str(rd), "--name", "second"])
    assert res.exit_code != 0


def test_run_init_force_overrides(tmp_path: Path) -> None:
    rd = tmp_path / "r1"
    _runner.invoke(app, ["run", "init", str(rd), "--name", "first"])
    res = _runner.invoke(
        app, ["run", "init", str(rd), "--name", "second", "--force"]
    )
    assert res.exit_code == 0
    meta = json.loads((rd / "meta.json").read_text(encoding="utf-8"))
    assert meta["name"] == "second"


def test_run_list(tmp_path: Path) -> None:
    parent = tmp_path / "rs"
    parent.mkdir()
    for n in ("a", "b"):
        _runner.invoke(app, ["run", "init", str(parent / n), "--name", n])
    res = _runner.invoke(app, ["run", "list", str(parent)])
    assert res.exit_code == 0
    assert "a" in res.output and "b" in res.output


def test_run_show(tmp_path: Path) -> None:
    rd = tmp_path / "r1"
    _runner.invoke(app, ["run", "init", str(rd), "--name", "x"])
    res = _runner.invoke(app, ["run", "show", str(rd)])
    assert res.exit_code == 0
    assert '"name": "x"' in res.output


def test_run_delete(tmp_path: Path) -> None:
    rd = tmp_path / "r1"
    _runner.invoke(app, ["run", "init", str(rd), "--name", "x"])
    res = _runner.invoke(app, ["run", "delete", str(rd), "--yes"])
    assert res.exit_code == 0
    assert not rd.exists()


def test_run_fork(tmp_path: Path) -> None:
    src = tmp_path / "src"
    dst = tmp_path / "dst"
    _runner.invoke(app, ["run", "init", str(src), "--name", "src"])
    res = _runner.invoke(
        app, ["run", "fork", str(src), str(dst), "--name", "forked"]
    )
    assert res.exit_code == 0
    assert (dst / "config" / "llm.yaml").is_file()
    meta = json.loads((dst / "meta.json").read_text(encoding="utf-8"))
    assert meta["name"] == "forked"
