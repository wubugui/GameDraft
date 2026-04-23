"""LLM cache：key 稳定性 + lookup/store + 关闭开关。"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.llm.backend.stub import StubBackend
from tools.chronicle_sim_v3.llm.cache import (
    CacheStore,
    chat_cache_key,
    embed_cache_key,
)
from tools.chronicle_sim_v3.llm.service import LLMService
from tools.chronicle_sim_v3.llm.types import LLMRef, OutputSpec, Prompt, ResolvedModel
from tools.chronicle_sim_v3.providers.service import ProviderService
from tools.chronicle_sim_v3.tests._fixtures import make_stub_run


def _r(route_hash="rh1") -> ResolvedModel:
    return ResolvedModel(
        logical="offline", physical="stub",
        provider_id="stub_local", invocation="stub",
        base_url="", api_key="", model_id="", extra={},
        route_hash=route_hash,
    )


def _llm(run: Path) -> LLMService:
    ps = ProviderService(run)
    return LLMService(run, ps)


def test_chat_key_stable_same_inputs() -> None:
    a = chat_cache_key(_r(), "spec_sha", "sys", "usr", OutputSpec("text"), "hash")
    b = chat_cache_key(_r(), "spec_sha", "sys", "usr", OutputSpec("text"), "hash")
    assert a == b


def test_chat_key_changes_on_user() -> None:
    a = chat_cache_key(_r(), "spec_sha", "sys", "u1", OutputSpec("text"), "hash")
    b = chat_cache_key(_r(), "spec_sha", "sys", "u2", OutputSpec("text"), "hash")
    assert a != b


def test_chat_key_changes_on_route_hash() -> None:
    a = chat_cache_key(_r("rh1"), "s", "sys", "usr", OutputSpec("text"), "hash")
    b = chat_cache_key(_r("rh2"), "s", "sys", "usr", OutputSpec("text"), "hash")
    assert a != b


def test_chat_key_changes_on_mode() -> None:
    a = chat_cache_key(_r(), "s", "sys", "usr", OutputSpec("text"), "hash")
    b = chat_cache_key(_r(), "s", "sys", "usr", OutputSpec("text"), "exact")
    assert a != b


def test_embed_key_stable() -> None:
    a = embed_cache_key(_r(), "abc")
    b = embed_cache_key(_r(), "abc")
    assert a == b
    assert embed_cache_key(_r(), "abc") != embed_cache_key(_r(), "abd")


def test_store_lookup_roundtrip(tmp_path: Path) -> None:
    s = CacheStore(tmp_path)
    s.store(
        "abcdef" * 10 + "0000",
        "chat",
        physical_model="stub",
        route_hash="rh1",
        result_payload={"text": "hi"},
    )
    e = s.lookup("abcdef" * 10 + "0000", "chat")
    assert e is not None
    assert e["result"]["text"] == "hi"
    assert e["physical_model"] == "stub"


def test_lookup_returns_none_when_absent(tmp_path: Path) -> None:
    s = CacheStore(tmp_path)
    assert s.lookup("nope" * 16, "chat") is None


@pytest.mark.asyncio
async def test_service_cache_hit_replay(tmp_path: Path) -> None:
    """offline 路由配 cache=hash；第二次同 prompt 应命中。"""
    run = make_stub_run(tmp_path)
    svc = _llm(run)
    ref = LLMRef(role="t", model="offline", output=OutputSpec("text"))
    p = Prompt(spec_ref="_inline", vars={"__system": "s", "__user": "hello"})
    r1 = await svc.chat(ref, p)
    r2 = await svc.chat(ref, p)
    assert r1.text == r2.text
    assert r1.cache_hit is False
    assert r2.cache_hit is True
    assert svc.cache.stats()["chat"] == 1
    await svc.aclose()


@pytest.mark.asyncio
async def test_service_cache_disabled_global(tmp_path: Path) -> None:
    run = make_stub_run(tmp_path)
    cfg_path = run / "config" / "llm.yaml"
    cfg_path.write_text(
        cfg_path.read_text(encoding="utf-8").replace("enabled: true", "enabled: false", 1),
        encoding="utf-8",
    )
    svc = _llm(run)
    ref = LLMRef(role="t", model="offline", output=OutputSpec("text"))
    p = Prompt(spec_ref="_inline", vars={"__system": "s", "__user": "x"})
    await svc.chat(ref, p)
    await svc.chat(ref, p)
    assert svc.cache.stats()["chat"] == 0
    await svc.aclose()


@pytest.mark.asyncio
async def test_ref_cache_off_overrides(tmp_path: Path) -> None:
    """ref.cache='off' 应跳过 cache，即使 route 默认 hash。"""
    run = make_stub_run(tmp_path)
    svc = _llm(run)
    ref = LLMRef(role="t", model="offline", output=OutputSpec("text"), cache="off")
    p = Prompt(spec_ref="_inline", vars={"__system": "s", "__user": "x"})
    await svc.chat(ref, p)
    await svc.chat(ref, p)
    assert svc.cache.stats()["chat"] == 0
    await svc.aclose()
