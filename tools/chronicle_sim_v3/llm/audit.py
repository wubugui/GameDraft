"""LLM 调用审计 — `<run>/audit/llm/<YYYYMMDD>.jsonl`。

设计：
- 每次调用一对 request / response 事件，共享 audit_id（ULID）
- ULID = 48bit 时间 + 80bit 随机，base32 (Crockford)；保证按时间单调
- 审计写入永不包含 api_key；user_prompt 按 audit.log_user_prompt 决定，截断
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import secrets
import threading
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v3.llm.config import AuditConfig


_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
_ULID_LOCK = threading.Lock()
_LAST_TS_MS = 0
_LAST_RAND = 0


def _b32_encode(value: int, length: int) -> str:
    chars: list[str] = []
    for _ in range(length):
        chars.append(_CROCKFORD[value & 31])
        value >>= 5
    return "".join(reversed(chars))


def _utcnow() -> _dt.datetime:
    return _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None)


def new_ulid() -> str:
    """ULID — Crockford base32，单调（同毫秒内随机部分递增）。"""
    global _LAST_TS_MS, _LAST_RAND
    with _ULID_LOCK:
        ts_ms = int(_utcnow().timestamp() * 1000)
        if ts_ms <= _LAST_TS_MS:
            ts_ms = _LAST_TS_MS
            _LAST_RAND += 1
            rand = _LAST_RAND & ((1 << 80) - 1)
        else:
            _LAST_TS_MS = ts_ms
            rand = secrets.randbits(80)
            _LAST_RAND = rand
        ts_part = _b32_encode(ts_ms, 10)
        rand_part = _b32_encode(rand, 16)
        return ts_part + rand_part


_FORBIDDEN_KEYS = {"api_key", "authorization"}


def _scrub(d: Any) -> Any:
    """递归剔除 api_key / authorization 字段（避免误写）。"""
    if isinstance(d, dict):
        return {
            k: ("[REDACTED]" if k.lower() in _FORBIDDEN_KEYS else _scrub(v))
            for k, v in d.items()
        }
    if isinstance(d, list):
        return [_scrub(v) for v in d]
    return d


class AuditWriter:
    """每日 jsonl 追加。线程安全（粗粒度锁，I/O 不是瓶颈）。"""

    def __init__(self, run_dir: Path, cfg: AuditConfig | None = None) -> None:
        self.run_dir = Path(run_dir)
        self.cfg = cfg or AuditConfig()
        self._lock = threading.Lock()

    def _today_path(self) -> Path:
        day = _utcnow().strftime("%Y%m%d")
        return self.run_dir / "audit" / "llm" / f"{day}.jsonl"

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
        invocation: str,
        spec_ref: str,
        user_text: str,
        cache_mode: str,
        role: str,
    ) -> str:
        audit_id = new_ulid()
        body = {
            "audit_id": audit_id,
            "ts": _utcnow().isoformat() + "Z",
            "phase": "request",
            "logical": logical,
            "physical": physical,
            "invocation": invocation,
            "spec_ref": spec_ref,
            "cache_mode": cache_mode,
            "role": role,
        }
        if self.cfg.log_user_prompt:
            body["user_prompt"] = user_text[: self.cfg.log_user_prompt_max_chars]
        else:
            body["user_prompt_len"] = len(user_text)
        self._append(body)
        return audit_id

    def end(
        self,
        audit_id: str,
        *,
        cache_hit: bool,
        exit_code: int,
        timings: dict[str, int],
        tokens_in: int | None,
        tokens_out: int | None,
        error_tag: str | None = None,
    ) -> None:
        body = {
            "audit_id": audit_id,
            "ts": _utcnow().isoformat() + "Z",
            "phase": "response",
            "cache_hit": cache_hit,
            "exit_code": exit_code,
            "timings": timings,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
        }
        if error_tag:
            body["error_tag"] = error_tag
        self._append(body)

    def tail(self, n: int = 20) -> list[dict]:
        """读最近 n 条事件（按文件追加序）。"""
        p = self._today_path()
        if not p.is_file():
            return []
        lines = p.read_text(encoding="utf-8").splitlines()
        return [json.loads(l) for l in lines[-n:] if l.strip()]
