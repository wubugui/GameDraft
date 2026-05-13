"""Agent 调用审计 — `<run>/audit/agents/<YYYYMMDD>.jsonl`。

复用 llm/audit.py 的 ULID 与 _scrub 实现，避免重复造轮。
"""
from __future__ import annotations

import datetime as _dt
import json
import threading
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v3.agents.config import AgentAuditConfig
from tools.chronicle_sim_v3.llm.audit import _scrub, new_ulid


def _utcnow() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)


class AgentAuditWriter:
    def __init__(self, run_dir: Path, cfg: AgentAuditConfig | None = None) -> None:
        self.run_dir = Path(run_dir)
        self.cfg = cfg or AgentAuditConfig()
        self._lock = threading.Lock()

    def _today_path(self) -> Path:
        day = _utcnow().strftime("%Y%m%d")
        return self.run_dir / "audit" / "agents" / f"{day}.jsonl"

    def _append(self, event: dict) -> None:
        if not self.cfg.enabled:
            return
        p = self._today_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(_scrub(event), ensure_ascii=False, sort_keys=True)
        with self._lock:
            with open(p, "a", encoding="utf-8", newline="\n") as f:
                f.write(line + "\n")

    def start(
        self,
        *,
        logical: str,
        physical: str,
        runner_kind: str,
        spec_ref: str,
        user_text: str,
        cache_mode: str,
        role: str,
    ) -> str:
        agent_run_id = new_ulid()
        body = {
            "agent_run_id": agent_run_id,
            "ts": _utcnow().isoformat() + "Z",
            "phase": "request",
            "logical": logical,
            "physical": physical,
            "runner_kind": runner_kind,
            "spec_ref": spec_ref,
            "cache_mode": cache_mode,
            "role": role,
        }
        if self.cfg.log_user_prompt:
            body["user_prompt"] = user_text[: self.cfg.log_user_prompt_max_chars]
        else:
            body["user_prompt_len"] = len(user_text)
        self._append(body)
        return agent_run_id

    def end(
        self,
        agent_run_id: str,
        *,
        cache_hit: bool,
        exit_code: int,
        timings: dict[str, int],
        llm_calls_count: int | None = None,
        error_tag: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        body = {
            "agent_run_id": agent_run_id,
            "ts": _utcnow().isoformat() + "Z",
            "phase": "response",
            "cache_hit": cache_hit,
            "exit_code": exit_code,
            "timings": timings,
            "llm_calls_count": llm_calls_count,
        }
        if error_tag:
            body["error_tag"] = error_tag
        if extra:
            body["extra"] = extra
        self._append(body)

    def tail(self, n: int = 20) -> list[dict]:
        p = self._today_path()
        if not p.is_file():
            return []
        lines = p.read_text(encoding="utf-8").splitlines()
        return [json.loads(l) for l in lines[-n:] if l.strip()]
