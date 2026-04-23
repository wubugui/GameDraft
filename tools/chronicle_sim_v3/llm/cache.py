"""LLM cache（与节点 cache 物理分离；RFC v3-llm.md §7）。

key 计算严格按 §7.2 全 component。
- chat：route_hash + spec_sha + system_hash + user_hash + output_dict + mode + format_ver
- embed：route_hash + text_hash + format_ver

存储：<run>/cache/llm/{chat|embed}/<sha[:2]>/<sha>.json，原子写。
"""
from __future__ import annotations

import datetime as _dt
from pathlib import Path
from typing import Literal

from tools.chronicle_sim_v3.engine.canonical import canonical_json, sha256_hex
from tools.chronicle_sim_v3.engine.io import atomic_write_json, read_json
from tools.chronicle_sim_v3.llm.types import OutputSpec, ResolvedModel


LLM_CACHE_FORMAT_VER = "1"


def chat_cache_key(
    resolved: ResolvedModel,
    spec_sha: str,
    rendered_system: str,
    rendered_user: str,
    output: OutputSpec,
    mode: Literal["off", "hash", "exact"],
) -> str:
    """RFC §7.2 chat 模式键计算。

    spec_sha 由调用方提供（render.load_spec 时算好）。
    """
    parts = [
        "chat",
        resolved.route_hash,
        spec_sha,
        sha256_hex(rendered_system),
        sha256_hex(rendered_user),
        canonical_json(output.to_dict()),
        mode,
        LLM_CACHE_FORMAT_VER,
    ]
    return sha256_hex("\x1f".join(parts))


def embed_cache_key(resolved: ResolvedModel, text: str) -> str:
    parts = [
        "embed",
        resolved.route_hash,
        sha256_hex(text),
        LLM_CACHE_FORMAT_VER,
    ]
    return sha256_hex("\x1f".join(parts))


class CacheStore:
    """LLM 缓存文件存储。"""

    def __init__(self, run_dir: Path) -> None:
        self.run_dir = Path(run_dir)
        self.base = self.run_dir / "cache" / "llm"

    def _path(self, key: str, kind: Literal["chat", "embed"]) -> Path:
        return self.base / kind / key[:2] / f"{key}.json"

    def lookup(self, key: str, kind: Literal["chat", "embed"]) -> dict | None:
        p = self._path(key, kind)
        if not p.is_file():
            return None
        try:
            return read_json(p)
        except Exception:
            return None

    def store(
        self,
        key: str,
        kind: Literal["chat", "embed"],
        physical_model: str,
        route_hash: str,
        result_payload: dict,
    ) -> None:
        entry = {
            "schema": "chronicle_sim_v3/llm_cache@1",
            "key": f"sha256:{key}",
            "kind": kind,
            "physical_model": physical_model,
            "route_hash": route_hash,
            "created_at": _dt.datetime.now(_dt.timezone.utc).replace(tzinfo=None).isoformat() + "Z",
            "result": result_payload,
        }
        atomic_write_json(self._path(key, kind), entry)

    def stats(self) -> dict[str, int]:
        out = {"chat": 0, "embed": 0}
        for kind in out:
            d = self.base / kind
            if d.exists():
                out[kind] = sum(1 for _ in d.rglob("*.json"))
        return out

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
