"""ReAct 工具：read_key / chroma_search / final + render_tools_doc。"""
from __future__ import annotations

import pytest

from tools.chronicle_sim_v3.agents.runners.react_tools import (
    REACT_TOOLS,
    ReactToolCtx,
    render_tools_doc,
    tool_chroma_search,
    tool_final,
    tool_read_key,
)


# -------- read_key --------


@pytest.mark.asyncio
async def test_read_key_simple_path() -> None:
    ctx = ReactToolCtx(vars={"a": {"b": 42}})
    out = await tool_read_key({"key": "a.b"}, ctx)
    assert out == "42"


@pytest.mark.asyncio
async def test_read_key_string_value_returns_json() -> None:
    ctx = ReactToolCtx(vars={"name": "alice"})
    out = await tool_read_key({"key": "name"}, ctx)
    assert out == '"alice"'


@pytest.mark.asyncio
async def test_read_key_dict_value_returns_json() -> None:
    ctx = ReactToolCtx(vars={"x": {"y": [1, 2]}})
    out = await tool_read_key({"key": "x"}, ctx)
    assert "y" in out and "1" in out


@pytest.mark.asyncio
async def test_read_key_missing_returns_error_string() -> None:
    ctx = ReactToolCtx(vars={"a": 1})
    out = await tool_read_key({"key": "missing.path"}, ctx)
    assert out.startswith("ERROR")


@pytest.mark.asyncio
async def test_read_key_list_index() -> None:
    ctx = ReactToolCtx(vars={"items": [10, 20, 30]})
    out = await tool_read_key({"key": "items.1"}, ctx)
    assert out == "20"


@pytest.mark.asyncio
async def test_read_key_list_index_out_of_range() -> None:
    ctx = ReactToolCtx(vars={"items": [10]})
    out = await tool_read_key({"key": "items.5"}, ctx)
    assert "越界" in out


@pytest.mark.asyncio
async def test_read_key_invalid_args() -> None:
    ctx = ReactToolCtx(vars={})
    out = await tool_read_key({}, ctx)
    assert out.startswith("ERROR")
    out2 = await tool_read_key({"key": 123}, ctx)
    assert out2.startswith("ERROR")


# -------- final --------


@pytest.mark.asyncio
async def test_tool_final_returns_text() -> None:
    out = await tool_final({"text": "结论=ok"}, ReactToolCtx())
    assert out == "结论=ok"


@pytest.mark.asyncio
async def test_tool_final_requires_string() -> None:
    out = await tool_final({"text": 123}, ReactToolCtx())
    assert out.startswith("ERROR")


# -------- chroma_search --------


@pytest.mark.asyncio
async def test_chroma_search_no_chroma_injected() -> None:
    out = await tool_chroma_search(
        {"query": "x"}, ReactToolCtx(chroma=None),
    )
    assert "ERROR" in out and "chroma" in out


@pytest.mark.asyncio
async def test_chroma_search_query_required() -> None:
    class _Chr:
        async def search(self, **kw):  # pragma: no cover —— 不该被调
            raise AssertionError("不应到达")
    out = await tool_chroma_search({"query": ""}, ReactToolCtx(chroma=_Chr()))
    assert out.startswith("ERROR")


@pytest.mark.asyncio
async def test_chroma_search_n_validation() -> None:
    class _Chr:
        async def search(self, **kw):
            return ["x"]
    out = await tool_chroma_search(
        {"query": "x", "n": 0}, ReactToolCtx(chroma=_Chr()),
    )
    assert "越界" in out
    out2 = await tool_chroma_search(
        {"query": "x", "n": "abc"}, ReactToolCtx(chroma=_Chr()),
    )
    assert "非整数" in out2


@pytest.mark.asyncio
async def test_chroma_search_calls_through() -> None:
    captured = {}

    class _Chr:
        async def search(self, **kw):
            captured.update(kw)
            return [{"text": "hit"}]

    out = await tool_chroma_search(
        {"query": "needle", "collection": "memo", "n": 3},
        ReactToolCtx(chroma=_Chr()),
    )
    assert captured["query"] == "needle"
    assert captured["collection"] == "memo"
    assert captured["n"] == 3
    assert "hit" in out


@pytest.mark.asyncio
async def test_chroma_search_swallows_backend_error() -> None:
    class _Chr:
        async def search(self, **kw):
            raise RuntimeError("backend down")

    out = await tool_chroma_search(
        {"query": "x"}, ReactToolCtx(chroma=_Chr()),
    )
    assert out.startswith("ERROR") and "RuntimeError" in out


# -------- render_tools_doc --------


def test_render_tools_doc_lists_only_enabled() -> None:
    doc = render_tools_doc(["read_key", "final"])
    assert "<tools>" in doc and "</tools>" in doc
    assert "read_key" in doc
    assert "final" in doc
    assert "chroma_search" not in doc


def test_render_tools_doc_unknown_tool_silently_dropped() -> None:
    doc = render_tools_doc(["bogus", "final"])
    assert "final" in doc
    assert "bogus" not in doc


def test_react_tools_registry_keys() -> None:
    assert set(REACT_TOOLS.keys()) == {"read_key", "chroma_search", "final"}
