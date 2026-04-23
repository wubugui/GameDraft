"""csim provider list / show / test —— 全用 stub provider，避免外网调用。"""
from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from tools.chronicle_sim_v3.cli.main import app
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run


_runner = CliRunner()


def test_provider_list_stub(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    res = _runner.invoke(app, ["provider", "list", "--run", str(run)])
    assert res.exit_code == 0, res.output
    assert "stub_local" in res.output
    assert "kind=stub" in res.output


def test_provider_list_missing_yaml_errors(tmp_path: Path) -> None:
    """没有 providers.yaml 时 ProviderService 构造即报错。"""
    run = tmp_path / "empty"
    (run / "config").mkdir(parents=True)
    res = _runner.invoke(app, ["provider", "list", "--run", str(run)])
    assert res.exit_code != 0


def test_provider_show_stub_redacts_key(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    res = _runner.invoke(app, ["provider", "show", "stub_local", "--run", str(run)])
    assert res.exit_code == 0, res.output
    assert "stub_local" in res.output
    assert "provider_hash" in res.output
    # 不应有 api_key 原文
    assert '"api_key":' not in res.output
    assert "raw_key" not in res.output


def test_provider_show_unknown(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    res = _runner.invoke(app, ["provider", "show", "no_such", "--run", str(run)])
    assert res.exit_code != 0


def test_provider_test_stub_ok(tmp_path: Path) -> None:
    """stub provider 的 ping 始终 OK。"""
    run = make_stub_run(tmp_path)
    res = _runner.invoke(
        app, ["provider", "test", "stub_local", "--run", str(run), "--timeout", "5"],
    )
    assert res.exit_code == 0, res.output
    assert "OK" in res.output
    assert "stub_local" in res.output


def test_provider_test_unknown(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    res = _runner.invoke(
        app, ["provider", "test", "no_such", "--run", str(run)],
    )
    assert res.exit_code != 0
