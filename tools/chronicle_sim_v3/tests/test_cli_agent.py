"""csim agent list/show/test/route/usage/audit/cache —— 全部 stub 路径。"""
from __future__ import annotations

import json
from pathlib import Path

from typer.testing import CliRunner

from tools.chronicle_sim_v3.cli.main import app
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run


_runner = CliRunner()


def _test_run(tmp_path: Path) -> Path:
    return make_stub_run(tmp_path)


def test_agent_list(tmp_path: Path) -> None:
    res = _runner.invoke(
        app, ["agent", "list", "--run", str(_test_run(tmp_path))],
    )
    assert res.exit_code == 0, res.output
    assert "simple_chat_offline" in res.output
    assert "react_default" in res.output


def test_agent_show(tmp_path: Path) -> None:
    res = _runner.invoke(
        app, ["agent", "show", "simple_chat_offline", "--run",
              str(_test_run(tmp_path))],
    )
    assert res.exit_code == 0, res.output
    body = json.loads(res.output)
    assert body["physical"] == "simple_chat_offline"
    assert body["runner_kind"] == "simple_chat"
    assert body["llm_route"] == "offline"
    assert body["agent_hash"]


def test_agent_show_logical_resolves_to_physical(tmp_path: Path) -> None:
    """传逻辑名 npc 应解析到 cline_default。"""
    res = _runner.invoke(
        app, ["agent", "show", "npc", "--run", str(_test_run(tmp_path))],
    )
    assert res.exit_code == 0, res.output
    body = json.loads(res.output)
    assert body["logical"] == "npc"
    assert body["physical"] == "cline_default"


def test_agent_route_show(tmp_path: Path) -> None:
    res = _runner.invoke(
        app, ["agent", "route", "show", "--run", str(_test_run(tmp_path))],
    )
    assert res.exit_code == 0, res.output
    assert "npc:" in res.output
    assert "cline_default" in res.output


def test_agent_test_simple_chat_offline(tmp_path: Path) -> None:
    run = _test_run(tmp_path)
    res = _runner.invoke(app, [
        "agent", "test",
        "--run", str(run),
        "--agent", "simple_chat_offline",
        "--spec", "_inline",
        "--var", "__system=hi",
        "--var", "__user=ping",
        "--cache", "off",
        "--output", "text",
    ])
    assert res.exit_code == 0, res.output
    body = json.loads(res.output)
    assert body["text"]
    assert body["runner_kind"] == "simple_chat"
    assert body["physical_agent"] == "simple_chat_offline"
    assert body["cache_hit"] is False
    assert body["llm_calls_count"] == 1


def test_agent_audit_tail(tmp_path: Path) -> None:
    run = _test_run(tmp_path)
    _runner.invoke(app, [
        "agent", "test",
        "--run", str(run), "--agent", "simple_chat_offline",
        "--spec", "_inline", "--var", "__user=x", "--cache", "off",
    ])
    res = _runner.invoke(
        app, ["agent", "audit", "tail", "--n", "5", "--run", str(run)],
    )
    assert res.exit_code == 0
    assert "request" in res.output


def test_agent_audit_tail_empty(tmp_path: Path) -> None:
    run = _test_run(tmp_path)
    res = _runner.invoke(
        app, ["agent", "audit", "tail", "--run", str(run)],
    )
    assert res.exit_code == 0
    assert "no audit yet" in res.output


def test_agent_usage_after_test(tmp_path: Path) -> None:
    """同进程 invoke：usage 由 typer CliRunner 子调用维护，
    跨调用不持久化；本测试只校验 CLI 通路 + 输出格式。"""
    run = _test_run(tmp_path)
    res = _runner.invoke(app, ["agent", "usage", "--run", str(run)])
    assert res.exit_code == 0


def test_agent_cache_stats_and_clear(tmp_path: Path) -> None:
    run = _test_run(tmp_path)
    _runner.invoke(app, [
        "agent", "test",
        "--run", str(run), "--agent", "simple_chat_offline",
        "--spec", "_inline", "--var", "__user=ping",
        "--cache", "hash",
    ])
    res = _runner.invoke(app, ["agent", "cache", "stats", "--run", str(run)])
    assert res.exit_code == 0, res.output
    res2 = _runner.invoke(app, ["agent", "cache", "clear", "--run", str(run)])
    assert res2.exit_code == 0
    assert "cleared=" in res2.output


def test_agent_cache_invalidate(tmp_path: Path) -> None:
    run = _test_run(tmp_path)
    _runner.invoke(app, [
        "agent", "test",
        "--run", str(run), "--agent", "simple_chat_offline",
        "--spec", "_inline", "--var", "__user=ping",
        "--cache", "hash",
    ])
    res = _runner.invoke(app, [
        "agent", "cache", "invalidate", "simple_chat_offline",
        "--run", str(run),
    ])
    assert res.exit_code == 0
    assert "invalidated=" in res.output


def test_agent_route_set_advisory(tmp_path: Path) -> None:
    """route set 不直接动盘，只输出提示。"""
    run = _test_run(tmp_path)
    res = _runner.invoke(app, [
        "agent", "route", "set", "npc", "simple_chat_offline",
        "--run", str(run),
    ])
    assert res.exit_code == 0
    # 提示走的是 stderr
    assert "agents.yaml" in (res.output + (res.stderr or ""))


def test_agent_test_unknown_agent(tmp_path: Path) -> None:
    run = _test_run(tmp_path)
    res = _runner.invoke(app, [
        "agent", "test",
        "--run", str(run), "--agent", "no_such",
        "--spec", "_inline", "--var", "__user=x",
    ])
    assert res.exit_code != 0
