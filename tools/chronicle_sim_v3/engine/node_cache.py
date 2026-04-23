"""节点级 cache（RFC v3-engine.md §10）。

与 LLM cache 物理分离：
- LLM cache 在 `<run>/cache/llm/`（已在 P0-5 实装）
- 节点 cache 在 `<run>/cache/nodes/<sha[:2]>/<sha>.json`

cache key 严格按 §10.2 全 component。
"""
from __future__ import annotations

import datetime as _dt
import json
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v3.engine.canonical import canonical_hash, sha256_hex
from tools.chronicle_sim_v3.engine.context import ContextStore, Mutation
from tools.chronicle_sim_v3.engine.io import (
    atomic_write_json,
    read_json,
)
from tools.chronicle_sim_v3.engine.node import NodeKindSpec


ENGINE_FORMAT_VER = "1"


def instantiate_reads(
    template_keys: frozenset[str],
    inputs: dict,
    params: dict,
    ctx_run_id: str,
    week: int | None,
) -> list[str]:
    """把 reads 模板里的 ${...} 实例化为具体 key。

    P1 暂支持最常见两种占位：`${inputs.X}` `${params.X}`。
    `${ctx.week}` / `${item.X}` / 通配 `*` 在 P3 节点扩展时再补。
    """
    out: list[str] = []
    scope_inputs = inputs or {}
    scope_params = params or {}
    for tmpl in sorted(template_keys):
        out.append(_substitute(tmpl, scope_inputs, scope_params, week))
    return out


def _substitute(template: str, inputs: dict, params: dict, week: int | None) -> str:
    """简化的占位替换；不走 expr 引擎（reads 模板限定语法）。"""
    text = template
    # ${inputs.X} 替换
    while "${inputs." in text:
        i = text.find("${inputs.")
        j = text.find("}", i)
        if j < 0:
            break
        name = text[i + len("${inputs.") : j]
        v = inputs.get(name, "")
        text = text[:i] + str(v) + text[j + 1 :]
    while "${params." in text:
        i = text.find("${params.")
        j = text.find("}", i)
        if j < 0:
            break
        name = text[i + len("${params.") : j]
        v = params.get(name, "")
        text = text[:i] + str(v) + text[j + 1 :]
    if "${ctx.week}" in text and week is not None:
        text = text.replace("${ctx.week}", str(week))
    return text


def compute_cache_key(
    spec: NodeKindSpec,
    inputs: dict,
    params: dict,
    reads_keys: list[str],
    cs: ContextStore,
    *,
    agent_spec_hash: str = "",
    llm_route_hash: str = "",
    subgraph_hash: str = "",
) -> str:
    """RFC §10.2 full key。"""
    components = [
        spec.kind,
        spec.version,
        canonical_hash(_normalize_inputs(inputs)),
        canonical_hash(params),
        cs.slice_hash_combined(reads_keys),
        agent_spec_hash,
        llm_route_hash,
        subgraph_hash,
        ENGINE_FORMAT_VER,
    ]
    return sha256_hex("\x1f".join(components))


def _normalize_inputs(inputs: dict) -> dict:
    """inputs 中可能含 NodeOutput 等非 JSON 值；强制 canonical_hash 可吞下。"""
    out: dict = {}
    for k, v in inputs.items():
        out[k] = v
    return out


class NodeCacheStore:
    def __init__(self, run_dir: Path) -> None:
        self.run_dir = Path(run_dir)
        self.base = self.run_dir / "cache" / "nodes"

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
        spec: NodeKindSpec,
        values: dict,
        mutations: list[Mutation],
        in_hash_components: dict,
    ) -> None:
        entry = {
            "schema": "chronicle_sim_v3/cache_entry@1",
            "key": f"sha256:{key}",
            "node_kind": spec.kind,
            "node_version": spec.version,
            "engine_format_ver": ENGINE_FORMAT_VER,
            "created_at": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            "in_hash_components": in_hash_components,
            "values": values,
            "mutations": [_mutation_to_jsonable(m) for m in mutations],
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


def _mutation_to_jsonable(m: Mutation) -> dict:
    return {
        "op": m.op,
        "key": m.key,
        "payload": m.payload,
        "payload_path": str(m.payload_path) if m.payload_path else None,
        "new_key": m.new_key,
    }


def jsonable_to_mutation(d: dict) -> Mutation:
    return Mutation(
        op=d["op"],
        key=d["key"],
        payload=d.get("payload"),
        payload_path=Path(d["payload_path"]) if d.get("payload_path") else None,
        new_key=d.get("new_key"),
    )
