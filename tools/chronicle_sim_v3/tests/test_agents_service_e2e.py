"""AgentService 端到端：cache hit / miss / 错误 / usage / audit / route alias。"""
from __future__ import annotations

from pathlib import Path

import pytest

from tools.chronicle_sim_v3.agents.errors import (
    AgentConfigError,
    AgentRouteError,
    AgentRunnerError,
)
from tools.chronicle_sim_v3.agents.service import AgentService
from tools.chronicle_sim_v3.agents.types import AgentRef, AgentTask
from tools.chronicle_sim_v3.llm.service import LLMService
from tools.chronicle_sim_v3.providers.service import ProviderService
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run


def _build(run: Path) -> tuple[AgentService, LLMService, ProviderService]:
    ps = ProviderService(run)
    llm = LLMService(run, ps, spec_search_root=run)
    svc = AgentService(run, ps, llm_service=llm, spec_search_root=run)
    return svc, llm, ps


@pytest.mark.asyncio
async def test_e2e_cline_offline_basic(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    svc, llm, _ = _build(run)
    res = await svc.run(
        AgentRef(agent="cline_offline", role="t", output_kind="text"),
        AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "hi"}),
    )
    assert res.text
    assert res.runner_kind == "cline"
    assert res.physical_agent == "cline_offline"
    assert res.cache_hit is False
    assert res.llm_calls_count is None
    assert res.agent_run_id
    await svc.aclose()
    await llm.aclose()


@pytest.mark.asyncio
async def test_e2e_cache_hit_second_call(tmp_path: Path) -> None:
    """同一 ref+task 第二次跑应命中缓存（offline route 在 fixture 配 hash 模式）。"""
    run = make_stub_run(tmp_path)
    svc, llm, _ = _build(run)
    ref = AgentRef(
        agent="cline_offline", role="t", output_kind="text", cache="hash",
    )
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "ping"})
    r1 = await svc.run(ref, task)
    r2 = await svc.run(ref, task)
    assert r1.cache_hit is False
    assert r2.cache_hit is True
    assert r2.text == r1.text
    await svc.aclose()
    await llm.aclose()


@pytest.mark.asyncio
async def test_e2e_cache_off_disables_cache(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    svc, llm, _ = _build(run)
    ref = AgentRef(
        agent="cline_offline", role="t", output_kind="text", cache="off",
    )
    task = AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "x"})
    r1 = await svc.run(ref, task)
    r2 = await svc.run(ref, task)
    assert r1.cache_hit is False and r2.cache_hit is False
    await svc.aclose()
    await llm.aclose()


@pytest.mark.asyncio
async def test_e2e_alias_npc_routes_to_cline_default(tmp_path: Path) -> None:
    """逻辑 npc → cline_default（在 stub run 中实际是 cline+stub provider）。"""
    run = make_stub_run(tmp_path)
    svc, llm, _ = _build(run)
    res = await svc.run(
        AgentRef(agent="npc", role="npc", output_kind="text"),
        AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"}),
    )
    assert res.physical_agent == "cline_default"
    assert res.runner_kind == "cline"
    await svc.aclose()
    await llm.aclose()


@pytest.mark.asyncio
async def test_e2e_unknown_agent_raises(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    svc, llm, _ = _build(run)
    with pytest.raises(AgentRouteError):
        await svc.run(
            AgentRef(agent="not_exist", role="t", output_kind="text"),
            AgentTask(spec_ref="_inline", vars={"__user": "u"}),
        )
    await svc.aclose()
    await llm.aclose()


@pytest.mark.asyncio
async def test_e2e_usage_aggregated(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    svc, llm, _ = _build(run)
    ref = AgentRef(
        agent="cline_offline", role="t", output_kind="text", cache="hash",
    )
    for _ in range(3):
        await svc.run(
            ref, AgentTask(spec_ref="_inline",
                           vars={"__system": "s", "__user": "x"}),
        )
    snap = svc.usage.snapshot()
    assert "cline_offline" in snap
    s = snap["cline_offline"]
    # 第一次 miss + 后两次 hit（offline 配置 hash cache 模式）
    assert s["calls"] == 3
    assert s["cache_hits"] >= 1
    await svc.aclose()
    await llm.aclose()


@pytest.mark.asyncio
async def test_e2e_audit_file_written(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    svc, llm, _ = _build(run)
    await svc.run(
        AgentRef(agent="cline_offline", role="t", output_kind="text"),
        AgentTask(spec_ref="_inline", vars={"__system": "s", "__user": "u"}),
    )
    audit_dir = run / "audit" / "agents"
    assert audit_dir.is_dir()
    files = list(audit_dir.glob("*.jsonl"))
    assert files, f"audit jsonl 缺失：{audit_dir}"
    body = files[0].read_text(encoding="utf-8")
    assert "request" in body and "response" in body
    assert "api_key" not in body.lower()
    await svc.aclose()
    await llm.aclose()


@pytest.mark.asyncio
async def test_e2e_react_max_iter_raises(tmp_path: Path) -> None:
    """react_default 在 stub 上不会产出 FINAL → max_iter 后报 AgentRunnerError。"""
    run = make_stub_run(tmp_path)
    svc, llm, _ = _build(run)
    with pytest.raises(AgentRunnerError, match="max_iter"):
        await svc.run(
            AgentRef(agent="react_default", role="probe", output_kind="text"),
            AgentTask(spec_ref="_inline",
                      vars={"__system": "测试角色", "__user": "随便答"}),
        )
    await svc.aclose()
    await llm.aclose()


@pytest.mark.asyncio
async def test_e2e_close_then_run_raises(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    svc, llm, _ = _build(run)
    await svc.aclose()
    with pytest.raises(AgentConfigError):
        await svc.run(
            AgentRef(agent="cline_offline", role="t", output_kind="text"),
            AgentTask(spec_ref="_inline", vars={"__user": "x"}),
        )
    await llm.aclose()
