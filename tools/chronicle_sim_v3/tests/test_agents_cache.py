"""AgentCacheStore + agent_cache_key: 与 LLM cache 物理分离, runner_kind 进 key。"""
from __future__ import annotations

from pathlib import Path

from tools.chronicle_sim_v3.agents.cache import (
    AGENT_CACHE_FORMAT_VER,
    AgentCacheStore,
    agent_cache_key,
)


def _k(**over) -> str:
    base = dict(
        agent_hash="ah" * 8,
        spec_sha="ss",
        vars_payload={"vars": {"a": 1}, "system_extra": ""},
        output_kind="text",
        runner_kind="simple_chat",
        mode="hash",
    )
    base.update(over)
    return agent_cache_key(**base)


def test_key_stable() -> None:
    assert _k() == _k()


def test_key_changes_on_agent_hash() -> None:
    assert _k(agent_hash="aa" * 8) != _k(agent_hash="bb" * 8)


def test_key_changes_on_runner_kind() -> None:
    """换 runner 不允许复用旧值。"""
    assert _k(runner_kind="simple_chat") != _k(runner_kind="react")
    assert _k(runner_kind="cline") != _k(runner_kind="external")


def test_key_changes_on_vars() -> None:
    assert _k(vars_payload={"vars": {"a": 1}}) != _k(vars_payload={"vars": {"a": 2}})


def test_key_changes_on_output_kind() -> None:
    assert _k(output_kind="text") != _k(output_kind="json_object")


def test_key_changes_on_mode() -> None:
    assert _k(mode="hash") != _k(mode="exact")


def test_format_ver_constant() -> None:
    assert AGENT_CACHE_FORMAT_VER == "1"


def test_store_lookup_roundtrip(tmp_path: Path) -> None:
    s = AgentCacheStore(tmp_path)
    key = "f" * 64
    s.store(
        key,
        physical_agent="cline_real",
        agent_hash="ah" * 8,
        runner_kind="cline",
        result_payload={"text": "hi", "llm_calls_count": None},
    )
    e = s.lookup(key)
    assert e is not None
    assert e["result"]["text"] == "hi"
    assert e["physical_agent"] == "cline_real"
    assert e["runner_kind"] == "cline"
    assert e["agent_hash"] == "ah" * 8


def test_lookup_returns_none_when_absent(tmp_path: Path) -> None:
    s = AgentCacheStore(tmp_path)
    assert s.lookup("z" * 64) is None


def test_stats_count(tmp_path: Path) -> None:
    s = AgentCacheStore(tmp_path)
    assert s.stats() == {"count": 0}
    for i in range(3):
        s.store(
            f"{i:064d}",
            physical_agent="x", agent_hash="ah", runner_kind="simple_chat",
            result_payload={"text": str(i)},
        )
    assert s.stats() == {"count": 3}


def test_clear_returns_count(tmp_path: Path) -> None:
    s = AgentCacheStore(tmp_path)
    for i in range(3):
        s.store(
            f"{i:064d}", physical_agent="x", agent_hash="ah",
            runner_kind="simple_chat", result_payload={"text": str(i)},
        )
    n = s.clear()
    assert n == 3
    assert s.stats() == {"count": 0}


def test_invalidate_by_agent(tmp_path: Path) -> None:
    s = AgentCacheStore(tmp_path)
    for i in range(3):
        s.store(
            f"{i:064d}", physical_agent="cline_real", agent_hash="ah",
            runner_kind="cline", result_payload={"text": str(i)},
        )
    s.store(
        "e" * 64, physical_agent="other", agent_hash="ah",
        runner_kind="simple_chat", result_payload={"text": "keep"},
    )
    assert s.invalidate_by_agent("cline_real") == 3
    assert s.lookup("e" * 64) is not None


def test_cache_lives_under_run_cache_agents(tmp_path: Path) -> None:
    """物理目录与 LLM cache 分离：<run>/cache/agents/."""
    s = AgentCacheStore(tmp_path)
    s.store(
        "a" * 64, physical_agent="x", agent_hash="ah",
        runner_kind="simple_chat", result_payload={"text": "x"},
    )
    assert (tmp_path / "cache" / "agents").is_dir()
