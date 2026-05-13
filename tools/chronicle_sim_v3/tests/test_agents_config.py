"""agents.yaml 加载与字段约束。"""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.agents.config import (
    AgentDef,
    AgentsConfig,
    load_agents_config,
    load_agents_config_text,
)
from tools.chronicle_sim_v3.agents.errors import AgentConfigError


_OK = """\
schema: chronicle_sim_v3/agents@1
agents:
  cline_real:
    runner: cline
    provider: ds
    model_id: qwen3.5-plus
    timeout_sec: 600
  simple_default:
    runner: simple_chat
    llm_route: smart
    timeout_sec: 60
  react_default:
    runner: react
    llm_route: smart
    config:
      max_iter: 8
      tools: [read_key, final]
  external_default:
    runner: external
    provider: ds
    config:
      executable: /usr/bin/echo
      argv_template: ["${input_file}"]
routes:
  npc: cline_real
  director: cline_real
limiter:
  per_runner:
    cline: 1
    simple_chat: 4
"""


def test_load_minimal_ok() -> None:
    cfg = load_agents_config_text(_OK)
    assert isinstance(cfg, AgentsConfig)
    assert set(cfg.agents.keys()) == {
        "cline_real", "simple_default", "react_default", "external_default"
    }
    assert cfg.routes["npc"] == "cline_real"
    assert cfg.limiter.per_runner["cline"] == 1


def test_unknown_runner_rejected() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/agents@1
        agents:
          x: {runner: anthropic_cli, provider: p1}
        """)
    with pytest.raises(AgentConfigError):
        load_agents_config_text(bad)


def test_cline_must_have_provider() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/agents@1
        agents:
          x: {runner: cline, llm_route: smart}
        """)
    with pytest.raises(AgentConfigError, match="provider"):
        load_agents_config_text(bad)


def test_external_must_have_provider() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/agents@1
        agents:
          x:
            runner: external
            llm_route: smart
            config: {executable: /bin/echo, argv_template: []}
        """)
    with pytest.raises(AgentConfigError, match="provider"):
        load_agents_config_text(bad)


def test_simple_chat_must_have_llm_route() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/agents@1
        agents:
          x: {runner: simple_chat, provider: p1}
        """)
    with pytest.raises(AgentConfigError, match="llm_route"):
        load_agents_config_text(bad)


def test_react_must_have_llm_route() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/agents@1
        agents:
          x: {runner: react, provider: p1}
        """)
    with pytest.raises(AgentConfigError, match="llm_route"):
        load_agents_config_text(bad)


def test_provider_and_llm_route_xor() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/agents@1
        agents:
          x: {runner: cline, provider: p1, llm_route: smart}
        """)
    with pytest.raises(AgentConfigError, match="provider"):
        load_agents_config_text(bad)


def test_neither_provider_nor_llm_route_rejected() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/agents@1
        agents:
          x: {runner: cline}
        """)
    with pytest.raises(AgentConfigError):
        load_agents_config_text(bad)


def test_routes_must_reference_existing_agent() -> None:
    bad = textwrap.dedent("""\
        schema: chronicle_sim_v3/agents@1
        agents:
          x: {runner: simple_chat, llm_route: smart}
        routes:
          npc: nonexistent
        """)
    with pytest.raises(AgentConfigError, match="未在 agents 注册"):
        load_agents_config_text(bad)


def test_literal_api_key_rejected() -> None:
    bad = _OK + "\nx_secret:\n    api_key: sk-abc\n"
    with pytest.raises(AgentConfigError, match="api_key"):
        load_agents_config_text(bad)


def test_load_from_file(tmp_path: Path) -> None:
    cfg_dir = tmp_path / "config"
    cfg_dir.mkdir()
    (cfg_dir / "agents.yaml").write_text(_OK, encoding="utf-8")
    cfg = load_agents_config(tmp_path)
    assert "cline_real" in cfg.agents


def test_load_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(AgentConfigError, match="不存在"):
        load_agents_config(tmp_path)


def test_default_limiter_per_runner_caps() -> None:
    cfg = load_agents_config_text(textwrap.dedent("""\
        schema: chronicle_sim_v3/agents@1
        agents:
          x: {runner: simple_chat, llm_route: smart}
        """))
    pr = cfg.limiter.per_runner
    assert pr["cline"] == 1
    assert pr["simple_chat"] == 4
    assert pr["react"] == 2
    assert pr["external"] == 1


def test_agent_def_direct_construction_xor_check() -> None:
    with pytest.raises(ValueError):
        AgentDef(runner="cline")  # 既无 provider 也无 llm_route
    with pytest.raises(ValueError):
        AgentDef(runner="cline", provider="p", llm_route="r")
    a = AgentDef(runner="cline", provider="p")
    assert a.runner == "cline" and a.provider == "p"
    b = AgentDef(runner="simple_chat", llm_route="r")
    assert b.runner == "simple_chat" and b.llm_route == "r"
