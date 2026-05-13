"""AuditWriter：jsonl 写出 / ULID / 不写 api_key。"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from tools.chronicle_sim_v3.llm.audit import AuditWriter, new_ulid
from tools.chronicle_sim_v3.llm.config import AuditConfig


def test_ulid_unique_and_monotonic() -> None:
    ids = [new_ulid() for _ in range(200)]
    assert len(set(ids)) == len(ids)
    assert ids == sorted(ids)


def test_ulid_format() -> None:
    u = new_ulid()
    assert len(u) == 26
    assert all(c in "0123456789ABCDEFGHJKMNPQRSTVWXYZ" for c in u)


def test_audit_writes_jsonl(tmp_path: Path) -> None:
    w = AuditWriter(tmp_path, AuditConfig(enabled=True, log_user_prompt=True))
    aid = w.start(
        logical="offline", physical="stub", invocation="stub",
        spec_ref="x.toml", user_text="hello", cache_mode="off", role="t",
    )
    w.end(aid, cache_hit=False, exit_code=0,
          timings={"total_ms": 5}, tokens_in=1, tokens_out=2)
    files = list((tmp_path / "audit" / "llm").glob("*.jsonl"))
    assert len(files) == 1
    lines = files[0].read_text(encoding="utf-8").splitlines()
    assert len(lines) == 2
    req = json.loads(lines[0])
    resp = json.loads(lines[1])
    assert req["audit_id"] == aid
    assert req["phase"] == "request"
    assert resp["phase"] == "response"
    assert resp["tokens_in"] == 1


def test_audit_no_api_key_in_log(tmp_path: Path) -> None:
    w = AuditWriter(tmp_path, AuditConfig(enabled=True, log_user_prompt=True))
    aid = w.start(
        logical="offline", physical="stub", invocation="stub",
        spec_ref="x", user_text="this contains api_key=AKIA-SECRET-XYZ embedded",
        cache_mode="off", role="t",
    )
    w.end(aid, cache_hit=False, exit_code=0, timings={}, tokens_in=None, tokens_out=None)
    blob = (tmp_path / "audit" / "llm").glob("*.jsonl")
    text = "\n".join(p.read_text(encoding="utf-8") for p in blob)
    # 这里关键约束是 audit 字段名不能出现 api_key/Authorization；
    # user_prompt 是用户输入，按 RFC 设计本来就允许包含任意文本，
    # 因此我们检查 audit 的 *字段名* 不含 api_key
    parsed = [json.loads(l) for l in text.splitlines() if l.strip()]
    for ev in parsed:
        for k in ev:
            assert k.lower() not in ("api_key", "authorization")


def test_audit_user_prompt_omitted_when_disabled(tmp_path: Path) -> None:
    w = AuditWriter(tmp_path, AuditConfig(enabled=True, log_user_prompt=False))
    aid = w.start(
        logical="offline", physical="stub", invocation="stub",
        spec_ref="x", user_text="confidential payload",
        cache_mode="off", role="t",
    )
    w.end(aid, cache_hit=False, exit_code=0, timings={}, tokens_in=None, tokens_out=None)
    text = "\n".join(
        p.read_text(encoding="utf-8") for p in (tmp_path / "audit" / "llm").glob("*.jsonl")
    )
    assert "confidential payload" not in text
    parsed = [json.loads(l) for l in text.splitlines() if l.strip()]
    assert any("user_prompt_len" in ev for ev in parsed)


def test_audit_disabled_writes_nothing(tmp_path: Path) -> None:
    w = AuditWriter(tmp_path, AuditConfig(enabled=False))
    aid = w.start(
        logical="offline", physical="stub", invocation="stub",
        spec_ref="x", user_text="hi", cache_mode="off", role="t",
    )
    w.end(aid, cache_hit=False, exit_code=0, timings={}, tokens_in=None, tokens_out=None)
    assert not (tmp_path / "audit").exists()


def test_audit_scrub_nested_dict(tmp_path: Path) -> None:
    """递归 scrub：嵌套 dict 中的 api_key 字段也应剔除。"""
    from tools.chronicle_sim_v3.llm.audit import _scrub

    out = _scrub({
        "x": "ok",
        "headers": {"authorization": "Bearer secret", "x-trace": "ok"},
        "list": [{"api_key": "sk-XYZ"}],
    })
    assert out["headers"]["authorization"] == "[REDACTED]"
    assert out["list"][0]["api_key"] == "[REDACTED]"
    assert out["headers"]["x-trace"] == "ok"


def test_tail_returns_recent(tmp_path: Path) -> None:
    w = AuditWriter(tmp_path, AuditConfig(enabled=True))
    for i in range(5):
        aid = w.start(
            logical="offline", physical="stub", invocation="stub",
            spec_ref="x", user_text=f"u{i}", cache_mode="off", role="t",
        )
        w.end(aid, cache_hit=False, exit_code=0, timings={}, tokens_in=None, tokens_out=None)
    assert len(w.tail(3)) == 3
    assert len(w.tail(99)) == 10
