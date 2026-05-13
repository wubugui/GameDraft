"""SimpleChatRunner: 走 LLMService.chat 一次, llm_calls_count=1。"""
from __future__ import annotations

from pathlib import Path

import pytest

from tools.chronicle_sim_v3.agents.errors import (
    AgentConfigError,
    AgentRunnerError,
)
from tools.chronicle_sim_v3.agents.resolver import ResolvedAgent
from tools.chronicle_sim_v3.agents.runners.base import AgentRunnerContext
from tools.chronicle_sim_v3.agents.runners.simple_chat import SimpleChatRunner
from tools.chronicle_sim_v3.agents.types import AgentTask, NullAgentObserver
from tools.chronicle_sim_v3.llm.errors import LLMError
from tools.chronicle_sim_v3.llm.service import LLMService
from tools.chronicle_sim_v3.llm.types import LLMResult
from tools.chronicle_sim_v3.providers.service import ProviderService
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run


def _agent(**over) -> ResolvedAgent:
    base = dict(
        logical="director", physical="simple_default", runner_kind="simple_chat",
        provider_id=None, llm_route="offline", model_id="", timeout_sec=60,
        config={}, agent_hash="ah" * 8,
    )
    base.update(over)
    return ResolvedAgent(**base)


def _ctx(run: Path, llm: LLMService | None) -> AgentRunnerContext:
    return AgentRunnerContext(
        run_dir=run, spec_search_root=run,
        provider_service=ProviderService(run),
        llm_service=llm, observer=NullAgentObserver(),
    )


@pytest.mark.asyncio
async def test_simple_chat_basic(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    ps = ProviderService(run)
    llm = LLMService(run, ps)
    runner = SimpleChatRunner()
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    res = await runner.run_task(
        _agent(), task, "text", "", _ctx(run, llm), timeout_sec=30,
    )
    assert res.text
    assert res.exit_code == 0
    assert res.llm_calls_count == 1
    assert res.runner_kind == "simple_chat"
    assert res.physical_agent == "simple_default"
    await llm.aclose()


@pytest.mark.asyncio
async def test_simple_chat_requires_llm_route(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    llm = LLMService(run, ProviderService(run))
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    with pytest.raises(AgentConfigError, match="llm_route"):
        await SimpleChatRunner().run_task(
            _agent(llm_route=None), task, "text", "", _ctx(run, llm), 30,
        )
    await llm.aclose()


@pytest.mark.asyncio
async def test_simple_chat_requires_llm_service(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    with pytest.raises(AgentConfigError, match="llm_service"):
        await SimpleChatRunner().run_task(
            _agent(), task, "text", "", _ctx(run, None), 30,
        )


class _BoomLLM:
    """假的 LLMService，用来验证 LLMError 被包装为 AgentRunnerError。"""

    async def chat(self, ref, prompt, **kw):
        raise LLMError("simulated network error")


@pytest.mark.asyncio
async def test_simple_chat_wraps_llm_error(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    ctx = AgentRunnerContext(
        run_dir=run, spec_search_root=run,
        provider_service=ProviderService(run),
        llm_service=_BoomLLM(), observer=NullAgentObserver(),
    )
    with pytest.raises(AgentRunnerError, match="simple_chat"):
        await SimpleChatRunner().run_task(_agent(), task, "text", "", ctx, 30)


@pytest.mark.asyncio
async def test_simple_chat_propagates_output_kind(tmp_path: Path) -> None:
    """output_kind=json_object 应被传到 LLMRef.output。"""
    run = make_stub_run(tmp_path)
    captured = {}

    class _CaptureLLM:
        async def chat(self, ref, prompt, **kw):
            captured["output_kind"] = ref.output.kind
            captured["model"] = ref.model
            return LLMResult(text='{"ok": true}', parsed={"ok": True}, exit_code=0)

    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    ctx = AgentRunnerContext(
        run_dir=run, spec_search_root=run,
        provider_service=ProviderService(run),
        llm_service=_CaptureLLM(), observer=NullAgentObserver(),
    )
    res = await SimpleChatRunner().run_task(
        _agent(), task, "json_object", "", ctx, timeout_sec=30,
    )
    assert captured["output_kind"] == "json_object"
    assert captured["model"] == "offline"
    assert res.parsed == {"ok": True}
    assert res.llm_calls_count == 1
