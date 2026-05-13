"""可选 LLM 审计：脱敏后记录请求/响应摘要（由 llm_config 与 run_dir 在构建 AgentLLMResources 时决定是否启用）。"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _redact_messages(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for m in messages:
        d = dict(m)
        c = d.get("content", "")
        if len(c) > 12000:
            d["content"] = c[:12000] + f"\n…(截断，原长 {len(c)})"
        out.append(d)
    return out


def _redact_raw(raw: dict[str, Any] | None) -> dict[str, Any] | None:
    if not raw:
        return None
    s = json.dumps(raw, ensure_ascii=False, default=str)
    if len(s) > 8000:
        h = hashlib.sha256(s.encode("utf-8", errors="replace")).hexdigest()[:16]
        return {"_truncated": True, "_sha256_16": h, "_len": len(s)}
    return raw


def append_llm_audit(
    run_dir: Path | None,
    agent_id: str,
    *,
    messages: list[dict[str, str]],
    response_text: str,
    raw: dict[str, Any] | None = None,
    extra: dict[str, Any] | None = None,
) -> None:
    if run_dir is None:
        return
    log_dir = run_dir / "llm_audit"
    log_dir.mkdir(parents=True, exist_ok=True)
    day = datetime.now(timezone.utc).strftime("%Y%m%d")
    path = log_dir / f"{day}.jsonl"
    rt = response_text or ""
    rec = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "agent_id": agent_id,
        "messages": _redact_messages(messages),
        "response_preview": rt[:4000] + ("…" if len(rt) > 4000 else ""),
        "response_len": len(rt),
        "response_sha256_16": hashlib.sha256(rt.encode("utf-8", errors="replace")).hexdigest()[:16],
        "raw": _redact_raw(raw),
    }
    if extra:
        rec["extra"] = extra
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")


def audit_enabled_from_config(llm_config: dict[str, Any] | None) -> bool:
    if not llm_config:
        return False
    aud = llm_config.get("llm_audit")
    if not isinstance(aud, dict):
        return False
    return bool(aud.get("enabled"))
