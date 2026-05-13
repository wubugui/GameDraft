"""csim cook / graph / node CLI 测试。"""
from __future__ import annotations

import json
import textwrap
from pathlib import Path

from typer.testing import CliRunner

from tools.chronicle_sim_v3.cli.main import app


_runner = CliRunner()


_GRAPH = """\
schema: g@1
id: smoke
spec:
  nodes:
    agents:
      kind: read.world.agents
    cnt:
      kind: count
      in:
        list: ${nodes.agents.out}
  result:
    n: ${nodes.cnt.out}
"""


def _seed_run_with_graph(tmp_path: Path) -> tuple[Path, Path]:
    rd = tmp_path / "run"
    rd.mkdir()
    (rd / "config").mkdir()
    (rd / "config" / "providers.yaml").write_text(
        "schema: chronicle_sim_v3/providers@1\n"
        "providers:\n"
        "  stub_local: {kind: stub}\n",
        encoding="utf-8",
    )
    (rd / "config" / "llm.yaml").write_text(
        "schema: chronicle_sim_v3/llm@1\n"
        "models:\n"
        "  stub: {provider: stub_local, invocation: stub}\n"
        "  embed: {provider: stub_local, invocation: stub}\n"
        "routes: {offline: stub, embed: embed}\n",
        encoding="utf-8",
    )
    a = rd / "world" / "agents"
    a.mkdir(parents=True)
    (a / "x.json").write_text(json.dumps({"id": "x"}))
    (a / "y.json").write_text(json.dumps({"id": "y"}))
    g = tmp_path / "g.yaml"
    g.write_text(textwrap.dedent(_GRAPH), encoding="utf-8")
    return rd, g


def test_graph_show(tmp_path: Path) -> None:
    _, g = _seed_run_with_graph(tmp_path)
    res = _runner.invoke(app, ["graph", "show", str(g)])
    assert res.exit_code == 0
    out = json.loads(res.output)
    assert out["id"] == "smoke"
    assert "agents" in out["nodes"]


def test_graph_validate_ok(tmp_path: Path) -> None:
    _, g = _seed_run_with_graph(tmp_path)
    res = _runner.invoke(app, ["graph", "validate", str(g)])
    assert res.exit_code == 0
    assert "OK" in res.output


def test_graph_validate_fails(tmp_path: Path) -> None:
    g = tmp_path / "bad.yaml"
    g.write_text("schema: g@1\nid: x\nspec: {nodes: {n: {kind: nonexistent}}}\n")
    res = _runner.invoke(app, ["graph", "validate", str(g)])
    assert res.exit_code != 0


def test_graph_format_idempotent(tmp_path: Path) -> None:
    _, g = _seed_run_with_graph(tmp_path)
    _runner.invoke(app, ["graph", "format", str(g)])
    a = g.read_bytes()
    _runner.invoke(app, ["graph", "format", str(g)])
    b = g.read_bytes()
    assert a == b


def test_graph_dot(tmp_path: Path) -> None:
    _, g = _seed_run_with_graph(tmp_path)
    res = _runner.invoke(app, ["graph", "dot", str(g)])
    assert res.exit_code == 0
    assert "digraph G" in res.output
    assert "agents" in res.output


def test_node_list_includes_p1(tmp_path: Path) -> None:
    res = _runner.invoke(app, ["node", "list"])
    assert res.exit_code == 0
    for k in ("read.world.agents", "count", "agent.cline", "filter.where"):
        assert k in res.output


def test_node_list_filter_category(tmp_path: Path) -> None:
    res = _runner.invoke(app, ["node", "list", "--category", "io"])
    assert res.exit_code == 0
    assert "read.world.agents" in res.output
    assert "filter.where" not in res.output


def test_node_show(tmp_path: Path) -> None:
    res = _runner.invoke(app, ["node", "show", "npc.filter_active"])
    assert res.exit_code == 0
    assert "npc.filter_active" in res.output
    assert "AgentList" in res.output


def test_node_docs_md(tmp_path: Path) -> None:
    res = _runner.invoke(app, ["node", "docs", "count", "--md"])
    assert res.exit_code == 0
    assert "# `count`" in res.output


def test_cook_run_end_to_end(tmp_path: Path) -> None:
    rd, g = _seed_run_with_graph(tmp_path)
    res = _runner.invoke(
        app, ["cook", "run", str(g), "--run", str(rd), "--input", "week=1"]
    )
    assert res.exit_code == 0, res.output
    assert "status:  completed" in res.output
    assert '"n": 2' in res.output


def test_cook_list_and_timeline(tmp_path: Path) -> None:
    rd, g = _seed_run_with_graph(tmp_path)
    _runner.invoke(app, ["cook", "run", str(g), "--run", str(rd), "--cook-id", "c1"])
    res_list = _runner.invoke(app, ["cook", "list", "--run", str(rd)])
    assert "c1" in res_list.output
    assert "completed" in res_list.output
    res_tl = _runner.invoke(app, ["cook", "timeline", "c1", "--run", str(rd)])
    assert res_tl.exit_code == 0
    assert "cook.start" in res_tl.output
    assert "cook.end" in res_tl.output


def test_cook_output(tmp_path: Path) -> None:
    rd, g = _seed_run_with_graph(tmp_path)
    _runner.invoke(app, ["cook", "run", str(g), "--run", str(rd), "--cook-id", "c1"])
    res = _runner.invoke(app, ["cook", "output", "c1", "cnt", "--run", str(rd)])
    assert res.exit_code == 0
    assert "2" in res.output


def test_cook_show(tmp_path: Path) -> None:
    rd, g = _seed_run_with_graph(tmp_path)
    _runner.invoke(app, ["cook", "run", str(g), "--run", str(rd), "--cook-id", "c1"])
    res = _runner.invoke(app, ["cook", "show", "c1", "--run", str(rd)])
    assert res.exit_code == 0
    assert "c1" in res.output


def test_cook_run_with_no_cache(tmp_path: Path) -> None:
    rd, g = _seed_run_with_graph(tmp_path)
    _runner.invoke(app, ["cook", "run", str(g), "--run", str(rd), "--cook-id", "c1"])
    _runner.invoke(app, ["cook", "run", str(g), "--run", str(rd), "--cook-id", "c2", "--no-cache"])
    # 第二次不缓存 → c2 无 cache_hit
    hits = list((rd / "cooks" / "c2").rglob("cache_hit.txt"))
    assert hits == []


def test_cook_resume(tmp_path: Path) -> None:
    rd, g = _seed_run_with_graph(tmp_path)
    _runner.invoke(app, ["cook", "run", str(g), "--run", str(rd), "--cook-id", "c1"])
    # 删 result.json 模拟未完成
    (rd / "cooks" / "c1" / "result.json").unlink()
    state = (rd / "cooks" / "c1" / "state.json")
    d = json.loads(state.read_text())
    d["status"] = "running"
    d["nodes"]["cnt"]["status"] = "running"
    state.write_text(json.dumps(d))
    res = _runner.invoke(
        app, ["cook", "resume", str(g), "c1", "--run", str(rd)]
    )
    assert res.exit_code == 0
    assert "completed" in res.output
