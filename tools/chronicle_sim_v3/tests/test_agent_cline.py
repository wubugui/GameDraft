"""agent.cline alias 节点 + agent.run 节点 + flow.merge / flow 占位节点。

三层架构后：业务节点只见 services.agents（AgentService）；
- agent.cline 是 alias，内部走 cline_default
- agent.run 是统一入口
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.agents.service import AgentService
from tools.chronicle_sim_v3.engine.context import ContextStore
from tools.chronicle_sim_v3.engine.node import (
    NodeBusinessError,
    NodeServices,
)
from tools.chronicle_sim_v3.engine.registry import get_node_class
from tools.chronicle_sim_v3.llm.service import LLMService
from tools.chronicle_sim_v3.providers.service import ProviderService
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run
import tools.chronicle_sim_v3.nodes  # noqa: F401


def _cook_sync(node_cls, ctx, inputs=None, params=None, services=None):
    inst = node_cls()
    services = services or NodeServices()
    return asyncio.run(inst.cook(ctx, inputs or {}, params or {}, services, None))


def _make_services(run: Path):
    ps = ProviderService(run)
    llm = LLMService(run, ps)
    agents = AgentService(run, ps, llm_service=llm, spec_search_root=run)
    return NodeServices(agents=agents, _llm=llm, spec_search_root=run), agents, llm


@pytest.mark.asyncio
async def test_agent_cline_alias_with_stub(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    services, agents, llm = _make_services(run)
    cs = ContextStore(run)
    cls = get_node_class("agent.cline")
    inst = cls()
    out = await inst.cook(
        cs.read_view(),
        {"vars": {"__system": "你是测试", "__user": "你好"}},
        {
            "agent_spec": "_inline",
            "llm": {
                "role": "test",
                "model": "offline",
                "output": {"kind": "text"},
            },
        },
        services,
        None,
    )
    assert out.values["text"]
    assert out.values["parsed"] == out.values["text"]
    assert out.values["tool_log"] == []
    await agents.aclose()
    await llm.aclose()


@pytest.mark.asyncio
async def test_agent_run_with_stub(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    services, agents, llm = _make_services(run)
    cs = ContextStore(run)
    cls = get_node_class("agent.run")
    inst = cls()
    out = await inst.cook(
        cs.read_view(),
        {"vars": {"__system": "你是测试", "__user": "你好"}},
        {
            "agent": "cline_offline",
            "spec": "_inline",
            "role": "smoke",
            "output": {"kind": "text"},
        },
        services,
        None,
    )
    assert out.values["text"]
    await agents.aclose()
    await llm.aclose()


def test_agent_cline_requires_agents_service(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("agent.cline")
    with pytest.raises(NodeBusinessError, match="services.agents"):
        _cook_sync(
            cls, cs.read_view(),
            inputs={"vars": {}},
            params={"agent_spec": "_inline", "llm": {"output": {"kind": "text"}}},
        )


def test_agent_run_spec_deterministic_false() -> None:
    cls = get_node_class("agent.run")
    assert cls.spec.deterministic is False
    assert cls.spec.cacheable is True


def test_agent_cline_spec_deterministic_false() -> None:
    cls = get_node_class("agent.cline")
    assert cls.spec.deterministic is False
    assert cls.spec.cacheable is True


def test_flow_merge(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("flow.merge")
    out = _cook_sync(cls, cs.read_view(), inputs={"inputs": [1, 2, 3]})
    assert out.values["out"] == [1, 2, 3]


def test_flow_merge_empty(tmp_path: Path) -> None:
    cs = ContextStore(tmp_path)
    cls = get_node_class("flow.merge")
    out = _cook_sync(cls, cs.read_view(), inputs={})
    assert out.values["out"] == []


def test_flow_subgraph_requires_engine_ref(tmp_path: Path) -> None:
    """flow.subgraph 在裸 NodeServices（无 _engine_ref）下应报错。"""
    cs = ContextStore(tmp_path)
    cls = get_node_class("flow.subgraph")
    with pytest.raises(NodeBusinessError, match="_engine_ref"):
        _cook_sync(cls, cs.read_view(), params={"ref": "x"})
