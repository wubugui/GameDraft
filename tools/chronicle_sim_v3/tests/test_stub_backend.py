"""StubBackend 占位响应稳定性。"""
from __future__ import annotations

import asyncio

import pytest

from tools.chronicle_sim_v3.llm.backend.base import CancelToken
from tools.chronicle_sim_v3.llm.backend.stub import StubBackend, StubEmbedBackend
from tools.chronicle_sim_v3.llm.types import OutputSpec, Prompt, ResolvedModel


def _resolved() -> ResolvedModel:
    return ResolvedModel(
        logical="offline", physical="stub",
        provider_id="stub_local", invocation="stub",
        base_url="", api_key="", model_id="", extra={},
        route_hash="abcdef0123456789",
    )


async def _invoke(b, kind: str, text: str = "你好世界"):
    return await b.invoke(
        _resolved(),
        Prompt(spec_ref="data/agent_specs/x.toml", vars={"k": 1}),
        rendered_system="sys",
        rendered_user=text,
        output=OutputSpec(kind=kind),  # type: ignore[arg-type]
        timeout_sec=10,
        cancel=CancelToken(),
    )


def test_stub_text_stable() -> None:
    b = StubBackend(fixed_seed=42)
    a = asyncio.run(_invoke(b, "text"))
    c = asyncio.run(_invoke(b, "text"))
    assert a.text == c.text
    assert a.exit_code == 0


def test_stub_seed_changes_output() -> None:
    a = asyncio.run(_invoke(StubBackend(fixed_seed=1), "text"))
    b = asyncio.run(_invoke(StubBackend(fixed_seed=2), "text"))
    assert a.text != b.text


def test_stub_json_object_parses() -> None:
    import json

    r = asyncio.run(_invoke(StubBackend(), "json_object"))
    obj = json.loads(r.text)
    assert obj["ok"] is True
    assert "echo" in obj


def test_stub_jsonl_two_lines() -> None:
    r = asyncio.run(_invoke(StubBackend(), "jsonl"))
    lines = [l for l in r.text.splitlines() if l.strip()]
    assert len(lines) == 2


def test_stub_embed_dim_stable() -> None:
    b = StubEmbedBackend(fixed_seed=7)
    out1 = asyncio.run(b.invoke(_resolved(), ["a", "b", "c"], 10, CancelToken()))
    out2 = asyncio.run(b.invoke(_resolved(), ["a", "b", "c"], 10, CancelToken()))
    assert out1 == out2
    assert all(len(v) == 8 for v in out1)


def test_stub_embed_per_text_unique() -> None:
    b = StubEmbedBackend(fixed_seed=7)
    out = asyncio.run(b.invoke(_resolved(), ["a", "b"], 10, CancelToken()))
    assert out[0] != out[1]
