"""ReActRunner: parse_react_output + 多轮循环（用 fake LLMService）。"""
from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from tools.chronicle_sim_v3.agents.errors import (
    AgentConfigError,
    AgentRunnerError,
)
from tools.chronicle_sim_v3.agents.resolver import ResolvedAgent
from tools.chronicle_sim_v3.agents.runners.base import AgentRunnerContext
from tools.chronicle_sim_v3.agents.runners.react import (
    ReActRunner,
    parse_react_output,
)
from tools.chronicle_sim_v3.agents.types import AgentTask, NullAgentObserver
from tools.chronicle_sim_v3.llm.errors import LLMError
from tools.chronicle_sim_v3.llm.types import LLMResult
from tools.chronicle_sim_v3.providers.service import ProviderService
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run


# -------- parse_react_output --------


def test_parse_final() -> None:
    out = parse_react_output("THOUGHT: ok\nFINAL: 答案=42\n")
    assert out["kind"] == "final"
    assert out["thought"] == "ok"
    assert out["final"].startswith("答案=42")


def test_parse_tool() -> None:
    out = parse_react_output(
        'THOUGHT: 想想\nTOOL: read_key\nARGS: {"key": "vars.x"}\n'
    )
    assert out["kind"] == "tool"
    assert out["tool"] == "read_key"
    assert out["args"] == {"key": "vars.x"}


def test_parse_tool_invalid_json_args_keeps_raw() -> None:
    out = parse_react_output("THOUGHT: t\nTOOL: read_key\nARGS: {not json}\n")
    assert out["kind"] == "tool"
    assert out["args"].get("_parse_error") is True


def test_parse_malformed() -> None:
    out = parse_react_output("Hello world\nNo protocol keys here.")
    assert out["kind"] == "malformed"


# -------- 多轮循环（fake LLM）--------


def _agent(**over) -> ResolvedAgent:
    base = dict(
        logical="probe", physical="react_default", runner_kind="react",
        provider_id=None, llm_route="offline", model_id="", timeout_sec=60,
        config={"max_iter": 4, "tools": ["read_key", "final"]},
        agent_hash="ah" * 8,
    )
    base.update(over)
    return ResolvedAgent(**base)


class _ScriptedLLM:
    """按脚本顺序返回 LLMResult.text；用于 ReAct 循环测试。"""

    def __init__(self, scripts: list[str]) -> None:
        self.scripts = list(scripts)
        self.calls = 0

    async def chat(self, ref, prompt, **kw) -> LLMResult:
        if self.calls >= len(self.scripts):
            raise AssertionError(f"超出脚本：第 {self.calls} 次调用未配台词")
        text = self.scripts[self.calls]
        self.calls += 1
        return LLMResult(text=text, parsed=None, exit_code=0)


def _ctx(run: Path, llm: Any) -> AgentRunnerContext:
    return AgentRunnerContext(
        run_dir=run, spec_search_root=run,
        provider_service=ProviderService(run),
        llm_service=llm, observer=NullAgentObserver(),
    )


@pytest.mark.asyncio
async def test_react_one_shot_final(tmp_path: Path) -> None:
    """一轮 LLM 直接 FINAL → llm_calls_count=1。"""
    run = make_stub_run(tmp_path)
    llm = _ScriptedLLM(["THOUGHT: 直接答\nFINAL: 答案=hello"])
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    res = await ReActRunner().run_task(_agent(), task, "text", "", _ctx(run, llm), 30)
    assert res.text == "答案=hello"
    assert res.llm_calls_count == 1
    assert res.runner_kind == "react"
    assert len(res.tool_log) == 1
    assert res.tool_log[0]["kind"] == "final"


@pytest.mark.asyncio
async def test_react_tool_then_final(tmp_path: Path) -> None:
    """第 1 轮 TOOL=read_key → 第 2 轮 FINAL；llm_calls_count=2。"""
    run = make_stub_run(tmp_path)
    llm = _ScriptedLLM([
        'THOUGHT: 取个 key\nTOOL: read_key\nARGS: {"key": "name"}',
        "THOUGHT: 拼答案\nFINAL: name=alice",
    ])
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u",
                                               "name": "alice"})
    res = await ReActRunner().run_task(_agent(), task, "text", "", _ctx(run, llm), 30)
    assert res.text == "name=alice"
    assert res.llm_calls_count == 2
    assert res.tool_log[0]["tool"] == "read_key"
    assert res.tool_log[0]["observation_len"] > 0


@pytest.mark.asyncio
async def test_react_max_iter_exceeded(tmp_path: Path) -> None:
    """全部 iter 都返回 TOOL 不 FINAL → 抛 AgentRunnerError。"""
    run = make_stub_run(tmp_path)
    looping = ['THOUGHT: x\nTOOL: read_key\nARGS: {"key": "name"}'] * 10
    llm = _ScriptedLLM(looping)
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u",
                                               "name": "x"})
    with pytest.raises(AgentRunnerError, match="max_iter"):
        await ReActRunner().run_task(
            _agent(config={"max_iter": 3, "tools": ["read_key", "final"]}),
            task, "text", "", _ctx(run, llm), 30,
        )
    assert llm.calls == 3


@pytest.mark.asyncio
async def test_react_unknown_tool_observation(tmp_path: Path) -> None:
    """模型调用未启用的 tool → 不抛错，OBSERVATION 反馈给下一轮。"""
    run = make_stub_run(tmp_path)
    llm = _ScriptedLLM([
        'THOUGHT: x\nTOOL: chroma_search\nARGS: {"query": "x"}',  # not in enabled tools
        "THOUGHT: 改主意\nFINAL: 我放弃",
    ])
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    res = await ReActRunner().run_task(_agent(), task, "text", "", _ctx(run, llm), 30)
    assert res.text == "我放弃"
    assert res.tool_log[0].get("error") == "tool_not_enabled"


@pytest.mark.asyncio
async def test_react_unknown_tool_at_config_time(tmp_path: Path) -> None:
    """config.tools 列了不存在的 tool 名 → AgentConfigError。"""
    run = make_stub_run(tmp_path)
    llm = _ScriptedLLM(["THOUGHT: x\nFINAL: x"])
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    with pytest.raises(AgentConfigError, match="未知工具"):
        await ReActRunner().run_task(
            _agent(config={"max_iter": 3, "tools": ["bogus_tool"]}),
            task, "text", "", _ctx(run, llm), 30,
        )


@pytest.mark.asyncio
async def test_react_requires_llm_route(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    with pytest.raises(AgentConfigError, match="llm_route"):
        await ReActRunner().run_task(
            _agent(llm_route=None),
            task, "text", "", _ctx(run, _ScriptedLLM([])), 30,
        )


@pytest.mark.asyncio
async def test_react_requires_llm_service(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    with pytest.raises(AgentConfigError, match="llm_service"):
        await ReActRunner().run_task(_agent(), task, "text", "", _ctx(run, None), 30)


class _BoomLLM:
    async def chat(self, ref, prompt, **kw):
        raise LLMError("network down")


@pytest.mark.asyncio
async def test_react_wraps_llm_error(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    with pytest.raises(AgentRunnerError, match="LLM"):
        await ReActRunner().run_task(_agent(), task, "text", "", _ctx(run, _BoomLLM()), 30)


@pytest.mark.asyncio
async def test_react_malformed_then_final(tmp_path: Path) -> None:
    """malformed → OBSERVATION 反馈 → 下一轮 FINAL。"""
    run = make_stub_run(tmp_path)
    llm = _ScriptedLLM([
        "garbage no protocol",
        "THOUGHT: 重试\nFINAL: 抱歉",
    ])
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    res = await ReActRunner().run_task(_agent(), task, "text", "", _ctx(run, llm), 30)
    assert res.text == "抱歉"
    assert res.llm_calls_count == 2
    assert res.tool_log[0]["kind"] == "malformed"
