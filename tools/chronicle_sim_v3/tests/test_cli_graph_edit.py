"""P2-10 graph 编辑 CLI 测试。"""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest
from typer.testing import CliRunner

from tools.chronicle_sim_v3.cli.main import app

_runner = CliRunner()


def _write(p: Path, content: str) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(textwrap.dedent(content), encoding="utf-8")


_BASE_GRAPH = """\
schema: chronicle_sim_v3/graph@1
id: g
spec:
  nodes:
    a:
      kind: read.world.agents
    c:
      kind: count
      in:
        list: ${nodes.a.out}
"""


def test_new_creates_skeleton(tmp_path: Path) -> None:
    out = tmp_path / "x.yaml"
    res = _runner.invoke(app, ["graph", "new", "myg", "--out", str(out)])
    assert res.exit_code == 0
    assert out.is_file()
    text = out.read_text(encoding="utf-8")
    assert "id: myg" in text
    assert "schema:" in text


def test_new_refuses_existing(tmp_path: Path) -> None:
    out = tmp_path / "x.yaml"
    out.write_text("dummy")
    res = _runner.invoke(app, ["graph", "new", "x", "--out", str(out)])
    assert res.exit_code != 0


def test_add_node_inserts(tmp_path: Path) -> None:
    p = tmp_path / "g.yaml"
    _write(p, _BASE_GRAPH)
    res = _runner.invoke(
        app, ["graph", "add-node", str(p), "--kind", "filter.where", "--id", "f"]
    )
    assert res.exit_code == 0
    assert "f:" in p.read_text(encoding="utf-8")


def test_add_node_unknown_kind_rejected(tmp_path: Path) -> None:
    p = tmp_path / "g.yaml"
    _write(p, _BASE_GRAPH)
    res = _runner.invoke(
        app, ["graph", "add-node", str(p), "--kind", "nope.bad", "--id", "x"]
    )
    assert res.exit_code != 0


def test_add_node_duplicate_id(tmp_path: Path) -> None:
    p = tmp_path / "g.yaml"
    _write(p, _BASE_GRAPH)
    res = _runner.invoke(
        app, ["graph", "add-node", str(p), "--kind", "count", "--id", "a"]
    )
    assert res.exit_code != 0


def test_remove_node(tmp_path: Path) -> None:
    p = tmp_path / "g.yaml"
    _write(p, _BASE_GRAPH)
    res = _runner.invoke(app, ["graph", "remove-node", str(p), "c"])
    assert res.exit_code == 0
    # 用 GraphLoader 重新加载验证更稳
    from tools.chronicle_sim_v3.engine.graph import GraphLoader
    spec = GraphLoader().load(p)
    assert "c" not in spec.nodes
    assert "a" in spec.nodes


def test_connect(tmp_path: Path) -> None:
    p = tmp_path / "g.yaml"
    _write(p, """\
        schema: g@1
        id: g
        spec:
          nodes:
            a: {kind: read.world.agents}
            f:
              kind: count
    """)
    res = _runner.invoke(app, ["graph", "connect", str(p), "a.out", "f.list"])
    assert res.exit_code == 0
    text = p.read_text(encoding="utf-8")
    assert "${nodes.a.out}" in text


def test_disconnect(tmp_path: Path) -> None:
    p = tmp_path / "g.yaml"
    _write(p, _BASE_GRAPH)
    res = _runner.invoke(app, ["graph", "disconnect", str(p), "a.out", "c.list"])
    assert res.exit_code == 0
    text = p.read_text(encoding="utf-8")
    assert "${nodes.a.out}" not in text


def test_set_param_int_parsing(tmp_path: Path) -> None:
    p = tmp_path / "g.yaml"
    _write(p, """\
        schema: g@1
        id: g
        spec:
          nodes:
            t:
              kind: take.n
    """)
    res = _runner.invoke(app, ["graph", "set-param", str(p), "t", "n=5"])
    assert res.exit_code == 0
    assert "n: 5" in p.read_text(encoding="utf-8")


def test_set_param_bool(tmp_path: Path) -> None:
    p = tmp_path / "g.yaml"
    _write(p, """\
        schema: g@1
        id: g
        spec:
          nodes:
            d:
              kind: dict.merge
    """)
    res = _runner.invoke(app, ["graph", "set-param", str(p), "d", "strategy=replace"])
    assert res.exit_code == 0


def test_set_expr(tmp_path: Path) -> None:
    p = tmp_path / "g.yaml"
    _write(p, _BASE_GRAPH)
    res = _runner.invoke(
        app, ["graph", "set-expr", str(p), "c.list", "${nodes.a.out}"]
    )
    assert res.exit_code == 0
    assert "${nodes.a.out}" in p.read_text(encoding="utf-8")


def test_rename_updates_references(tmp_path: Path) -> None:
    p = tmp_path / "g.yaml"
    _write(p, _BASE_GRAPH)
    res = _runner.invoke(app, ["graph", "rename", str(p), "a", "agents_v2"])
    assert res.exit_code == 0
    text = p.read_text(encoding="utf-8")
    assert "agents_v2:" in text
    assert "${nodes.agents_v2.out}" in text
    assert "${nodes.a.out}" not in text


def test_pack_as_subgraph(tmp_path: Path) -> None:
    p = tmp_path / "g.yaml"
    _write(p, _BASE_GRAPH + "  result:\n    n: ${nodes.c.out}\n")
    sub_dir = tmp_path / "subs"
    res = _runner.invoke(
        app,
        ["graph", "pack-as-subgraph", str(p),
         "--select", "a,c", "--name", "agent_count",
         "--out-dir", str(sub_dir)],
    )
    assert res.exit_code == 0, res.output
    sub_path = sub_dir / "agent_count.yaml"
    assert sub_path.is_file()
    sub_text = sub_path.read_text(encoding="utf-8")
    assert "id: agent_count" in sub_text
    main_text = p.read_text(encoding="utf-8")
    assert "flow.subgraph" in main_text
    # 原图 result 应被改写
    assert "${nodes.sub_agent_count.out.out_c_out}" in main_text
