"""AgentAuditWriter + AgentUsageStore: jsonl 写出 / 字段命名 / 关闭开关 / usage 统计。"""
from __future__ import annotations

import json
from pathlib import Path

from tools.chronicle_sim_v3.agents.audit import AgentAuditWriter
from tools.chronicle_sim_v3.agents.config import AgentAuditConfig
from tools.chronicle_sim_v3.agents.usage import AgentUsageStore


def test_audit_writes_jsonl(tmp_path: Path) -> None:
    w = AgentAuditWriter(tmp_path, AgentAuditConfig(enabled=True, log_user_prompt=True))
    aid = w.start(
        logical="npc", physical="cline_real", runner_kind="cline",
        spec_ref="x.toml", user_text="hello", cache_mode="off", role="npc",
    )
    w.end(aid, cache_hit=False, exit_code=0,
          timings={"total_ms": 12}, llm_calls_count=None)
    files = list((tmp_path / "audit" / "agents").glob("*.jsonl"))
    assert len(files) == 1
    lines = files[0].read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    req, resp = json.loads(lines[0]), json.loads(lines[1])
    assert req["agent_run_id"] == aid
    assert req["phase"] == "request"
    assert req["runner_kind"] == "cline"
    assert req["logical"] == "npc"
    assert req["physical"] == "cline_real"
    assert resp["phase"] == "response"
    assert resp["timings"]["total_ms"] == 12


def test_audit_user_prompt_omitted_when_disabled(tmp_path: Path) -> None:
    w = AgentAuditWriter(tmp_path, AgentAuditConfig(enabled=True, log_user_prompt=False))
    aid = w.start(
        logical="x", physical="x", runner_kind="simple_chat",
        spec_ref="s", user_text="confidential", cache_mode="off", role="r",
    )
    w.end(aid, cache_hit=False, exit_code=0, timings={})
    text = "\n".join(
        p.read_text(encoding="utf-8") for p in (tmp_path / "audit" / "agents").glob("*.jsonl")
    )
    assert "confidential" not in text
    parsed = [json.loads(l) for l in text.splitlines() if l.strip()]
    assert any("user_prompt_len" in ev for ev in parsed)


def test_audit_disabled_writes_nothing(tmp_path: Path) -> None:
    w = AgentAuditWriter(tmp_path, AgentAuditConfig(enabled=False))
    aid = w.start(
        logical="x", physical="x", runner_kind="simple_chat",
        spec_ref="s", user_text="hi", cache_mode="off", role="r",
    )
    w.end(aid, cache_hit=False, exit_code=0, timings={})
    assert not (tmp_path / "audit").exists()


def test_audit_no_api_key_field_in_output(tmp_path: Path) -> None:
    """字段名不允许出现 api_key / authorization。"""
    w = AgentAuditWriter(tmp_path, AgentAuditConfig(enabled=True, log_user_prompt=True))
    aid = w.start(
        logical="x", physical="x", runner_kind="simple_chat",
        spec_ref="s", user_text="x", cache_mode="off", role="r",
    )
    w.end(aid, cache_hit=False, exit_code=0, timings={})
    blob = list((tmp_path / "audit" / "agents").glob("*.jsonl"))
    text = "\n".join(p.read_text(encoding="utf-8") for p in blob)
    parsed = [json.loads(l) for l in text.splitlines() if l.strip()]
    for ev in parsed:
        for k in ev:
            assert k.lower() not in ("api_key", "authorization")


def test_audit_tail_returns_recent(tmp_path: Path) -> None:
    w = AgentAuditWriter(tmp_path, AgentAuditConfig(enabled=True))
    for i in range(4):
        aid = w.start(
            logical="x", physical="x", runner_kind="simple_chat",
            spec_ref="s", user_text=f"u{i}", cache_mode="off", role="r",
        )
        w.end(aid, cache_hit=False, exit_code=0, timings={})
    assert len(w.tail(3)) == 3
    assert len(w.tail(99)) == 8


def test_audit_lives_under_audit_agents_separate_from_llm(tmp_path: Path) -> None:
    """物理路径与 LLM audit 分离：<run>/audit/agents/."""
    w = AgentAuditWriter(tmp_path, AgentAuditConfig(enabled=True))
    aid = w.start(
        logical="x", physical="x", runner_kind="simple_chat",
        spec_ref="s", user_text="x", cache_mode="off", role="r",
    )
    w.end(aid, cache_hit=False, exit_code=0, timings={})
    assert (tmp_path / "audit" / "agents").is_dir()


def test_audit_records_error_tag(tmp_path: Path) -> None:
    w = AgentAuditWriter(tmp_path, AgentAuditConfig(enabled=True))
    aid = w.start(
        logical="x", physical="x", runner_kind="cline",
        spec_ref="s", user_text="x", cache_mode="off", role="r",
    )
    w.end(aid, cache_hit=False, exit_code=1, timings={"total_ms": 5},
          error_tag="AgentRunnerError")
    text = "\n".join(
        p.read_text(encoding="utf-8") for p in (tmp_path / "audit" / "agents").glob("*.jsonl")
    )
    assert "AgentRunnerError" in text


def test_usage_records_calls() -> None:
    u = AgentUsageStore()
    u.record(physical="cline_real", cache_hit=False, latency_ms=100, llm_calls=None)
    u.record(physical="cline_real", cache_hit=True, latency_ms=0, llm_calls=None)
    u.record(physical="simple_default", cache_hit=False, latency_ms=50, llm_calls=2)
    snap = u.snapshot()
    assert snap["cline_real"]["calls"] == 2
    assert snap["cline_real"]["cache_hits"] == 1
    assert snap["cline_real"]["total_ms"] == 100
    assert snap["simple_default"]["calls"] == 1
    assert snap["simple_default"]["llm_calls_total"] == 2


def test_usage_records_errors() -> None:
    u = AgentUsageStore()
    u.record(physical="x", cache_hit=False, latency_ms=10, error=True)
    snap = u.snapshot()
    assert snap["x"]["errors"] == 1
    assert snap["x"]["calls"] == 1
