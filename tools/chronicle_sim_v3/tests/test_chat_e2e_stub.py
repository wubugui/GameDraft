"""端到端 chat 走 stub backend 验证 LLMResult 全字段。"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.llm.service import LLMService
from tools.chronicle_sim_v3.llm.types import LLMRef, OutputSpec, Prompt
from tools.chronicle_sim_v3.providers.service import ProviderService
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run


def _llm(run: Path) -> LLMService:
    ps = ProviderService(run)
    return LLMService(run, ps)


@pytest.mark.asyncio
async def test_chat_e2e_text(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    svc = _llm(run)
    ref = LLMRef(role="test", model="offline", output=OutputSpec("text"))
    p = Prompt(spec_ref="_inline", vars={"__system": "你是测试", "__user": "你好"})
    r = await svc.chat(ref, p)
    assert r.text
    assert r.exit_code == 0
    assert r.audit_id
    assert r.physical_model == "stub"
    assert r.timings.get("total_ms", 0) >= 0
    # audit 与 usage
    assert (run / "audit" / "llm").exists()
    assert svc.usage.stats.by_route["offline"].calls == 1
    await svc.aclose()


@pytest.mark.asyncio
async def test_chat_e2e_json_object(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    svc = _llm(run)
    ref = LLMRef(role="t", model="offline", output=OutputSpec("json_object"))
    p = Prompt(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    r = await svc.chat(ref, p)
    assert isinstance(r.parsed, dict)
    assert r.parsed.get("ok") is True
    await svc.aclose()


@pytest.mark.asyncio
async def test_chat_e2e_jsonl(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    svc = _llm(run)
    ref = LLMRef(role="t", model="offline", output=OutputSpec("jsonl"))
    p = Prompt(spec_ref="_inline", vars={"__system": "s", "__user": "u"})
    r = await svc.chat(ref, p)
    # jsonl 有 say + final
    assert r.parsed is not None
    await svc.aclose()


@pytest.mark.asyncio
async def test_embed_e2e(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    svc = _llm(run)
    out = await svc.embed("embed", ["a", "b", "c"])
    assert len(out) == 3
    assert all(len(v) == 8 for v in out)
    # 第二次应全部命中 cache
    out2 = await svc.embed("embed", ["a", "b", "c"])
    assert out == out2
    assert svc.cache.stats()["embed"] == 3
    await svc.aclose()
