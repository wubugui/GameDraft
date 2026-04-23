"""AgentResolver: logical→physical, agent_hash 稳定性。"""
from __future__ import annotations

import textwrap

import pytest

from tools.chronicle_sim_v3.agents.config import load_agents_config_text
from tools.chronicle_sim_v3.agents.errors import AgentRouteError
from tools.chronicle_sim_v3.agents.resolver import AgentResolver


_AGENTS = """\
schema: chronicle_sim_v3/agents@1
agents:
  cline_real:
    runner: cline
    provider: ds
    model_id: qwen3.5-plus
    timeout_sec: 600
    config:
      cline_verbose: true
  simple_default:
    runner: simple_chat
    llm_route: smart
    timeout_sec: 60
  react_default:
    runner: react
    llm_route: smart
    config:
      max_iter: 5
routes:
  npc: cline_real
  director: simple_default
  probe: react_default
"""


def _r() -> AgentResolver:
    return AgentResolver(load_agents_config_text(textwrap.dedent(_AGENTS)))


def test_resolve_route_to_physical() -> None:
    r = _r()
    a = r.resolve("npc")
    assert a.logical == "npc"
    assert a.physical == "cline_real"
    assert a.runner_kind == "cline"
    assert a.provider_id == "ds"
    assert a.llm_route is None
    assert a.model_id == "qwen3.5-plus"
    assert a.timeout_sec == 600
    assert a.config.get("cline_verbose") is True
    assert len(a.agent_hash) == 16


def test_resolve_simple_chat_uses_llm_route() -> None:
    r = _r()
    a = r.resolve("director")
    assert a.runner_kind == "simple_chat"
    assert a.provider_id is None
    assert a.llm_route == "smart"


def test_resolve_react_uses_llm_route() -> None:
    r = _r()
    a = r.resolve("probe")
    assert a.runner_kind == "react"
    assert a.config.get("max_iter") == 5


def test_resolve_unknown_logical_raises() -> None:
    r = _r()
    with pytest.raises(AgentRouteError):
        r.resolve("nonexistent_role")


def test_resolve_logical_falls_back_to_physical_when_no_route() -> None:
    """logical 未在 routes 中，但等于物理 agent 名 → 直接通过。"""
    r = _r()
    a = r.resolve("react_default")
    assert a.physical == "react_default"


def test_agent_hash_stable_across_calls() -> None:
    r = _r()
    h1 = r.resolve("npc").agent_hash
    h2 = r.resolve("npc").agent_hash
    assert h1 == h2


def test_agent_hash_changes_when_provider_changes() -> None:
    """改 provider 应让 agent_hash 变化。"""
    a1 = _r().resolve("npc").agent_hash
    a2 = AgentResolver(
        load_agents_config_text(
            textwrap.dedent(_AGENTS).replace("provider: ds", "provider: ds2")
        )
    ).resolve("npc").agent_hash
    assert a1 != a2


def test_agent_hash_changes_when_runner_changes() -> None:
    a1 = _r().resolve("director").agent_hash
    bad = textwrap.dedent(_AGENTS).replace(
        "  simple_default:\n    runner: simple_chat\n    llm_route: smart\n",
        "  simple_default:\n    runner: react\n    llm_route: smart\n",
    )
    a2 = AgentResolver(load_agents_config_text(bad)).resolve("director").agent_hash
    assert a1 != a2


def test_list_logical_and_physical_sorted() -> None:
    r = _r()
    assert r.list_logical() == sorted(["npc", "director", "probe"])
    assert r.list_physical() == sorted([
        "cline_real", "simple_default", "react_default"
    ])
