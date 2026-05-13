"""Agent cache —— 与 LLM cache / Node cache 物理分离。

key 含：agent_hash + spec_sha + vars_hash + output_kind + runner_kind
（runner_kind 进 key 防"换 runner 复用错值"）。
"""
from __future__ import annotations

import datetime as _dt
from pathlib import Path

from tools.chronicle_sim_v3.engine.canonical import canonical_json, sha256_hex
from tools.chronicle_sim_v3.engine.io import atomic_write_json, read_json

AGENT_CACHE_FORMAT_VER = "1"


def agent_cache_key(
    *,
    agent_hash: str,
    spec_sha: str,
    vars_payload: dict,
    output_kind: str,
    runner_kind: str,
    mode: str,
) -> str:
    parts = [
        "agent",
        agent_hash,
        spec_sha,
        sha256_hex(canonical_json(vars_payload)),
        output_kind,
        runner_kind,
        mode,
        AGENT_CACHE_FORMAT_VER,
    ]
    return sha256_hex("\x1f".join(parts))


class AgentCacheStore:
    def __init__(self, run_dir: Path) -> None:
        self.run_dir = Path(run_dir)
        self.base = self.run_dir / "cache" / "agents"

    def _path(self, key: str) -> Path:
        return self.base / key[:2] / f"{key}.json"

    def lookup(self, key: str) -> dict | None:
        p = self._path(key)
        if not p.is_file():
            return None
        try:
            return read_json(p)
        except Exception:
            return None

    def store(
        self,
        key: str,
        *,
        physical_agent: str,
        agent_hash: str,
        runner_kind: str,
        result_payload: dict,
    ) -> None:
        entry = {
            "schema": "chronicle_sim_v3/agent_cache@1",
            "key": f"sha256:{key}",
            "physical_agent": physical_agent,
            "agent_hash": agent_hash,
            "runner_kind": runner_kind,
            "created_at": _dt.datetime.now(_dt.timezone.utc)
                .replace(tzinfo=None).isoformat() + "Z",
            "result": result_payload,
        }
        atomic_write_json(self._path(key), entry)

    def stats(self) -> dict[str, int]:
        if not self.base.exists():
            return {"count": 0}
        return {"count": sum(1 for _ in self.base.rglob("*.json"))}

    def clear(self) -> int:
        n = 0
        if not self.base.exists():
            return 0
        for f in self.base.rglob("*.json"):
            try:
                f.unlink()
                n += 1
            except OSError:
                pass
        return n

    def invalidate_by_agent(self, physical_agent: str) -> int:
        n = 0
        if not self.base.exists():
            return 0
        for f in self.base.rglob("*.json"):
            try:
                d = read_json(f)
            except Exception:
                continue
            if d.get("physical_agent") == physical_agent:
                try:
                    f.unlink()
                    n += 1
                except OSError:
                    pass
        return n
