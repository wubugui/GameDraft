"""Cook 生命周期与持久化（RFC v3-engine.md §9）。

只管 IO：cook 目录创建 / manifest / state / timeline / 节点产物。
调度逻辑在 engine/engine.py（P1-5）。
"""
from __future__ import annotations

import datetime as _dt
import json
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from tools.chronicle_sim_v3.engine.canonical import canonical_hash
from tools.chronicle_sim_v3.engine.io import (
    atomic_write_json,
    atomic_write_text,
)


NodeStatus = Literal["pending", "ready", "running", "done", "cached", "failed", "cancelled", "skipped"]


def new_cook_id() -> str:
    """形如 20260422T120000Z_a1b2c3。"""
    ts = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{ts}_{uuid.uuid4().hex[:6]}"


@dataclass
class NodeState:
    status: NodeStatus = "pending"
    started_at: str | None = None
    finished_at: str | None = None
    duration_ms: int = 0
    error: str | None = None

    def to_dict(self) -> dict:
        return {k: v for k, v in self.__dict__.items() if v is not None}


@dataclass
class CookState:
    status: Literal["pending", "running", "completed", "failed", "cancelled"] = "pending"
    started_at: str | None = None
    finished_at: str | None = None
    nodes: dict[str, NodeState] = field(default_factory=dict)
    failed_nodes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "nodes": {k: v.to_dict() for k, v in self.nodes.items()},
            "failed_nodes": self.failed_nodes,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "CookState":
        out = cls(
            status=d.get("status", "pending"),
            started_at=d.get("started_at"),
            finished_at=d.get("finished_at"),
            failed_nodes=list(d.get("failed_nodes", [])),
        )
        for nid, ns in (d.get("nodes") or {}).items():
            out.nodes[nid] = NodeState(**ns)
        return out


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


@dataclass
class CookResult:
    cook_id: str
    status: Literal["completed", "failed", "cancelled"]
    outputs: dict[str, Any] = field(default_factory=dict)
    failed_nodes: list[str] = field(default_factory=list)
    duration_ms: int = 0


class Cook:
    """单个 cook 的持久化助手。状态机由 Engine 推进。"""

    def __init__(self, run_dir: Path, cook_id: str) -> None:
        self.run_dir = Path(run_dir)
        self.cook_id = cook_id
        self.dir = self.run_dir / "cooks" / cook_id
        self._lock = threading.Lock()

    @property
    def state_path(self) -> Path:
        return self.dir / "state.json"

    @property
    def manifest_path(self) -> Path:
        return self.dir / "manifest.json"

    @property
    def timeline_path(self) -> Path:
        return self.dir / "timeline.jsonl"

    @property
    def result_path(self) -> Path:
        return self.dir / "result.json"

    def init_dir(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)

    def write_manifest(
        self,
        *,
        graph_path: str,
        graph_content_hash: str,
        engine_format_ver: str,
        inputs: dict,
        concurrency: dict,
        cache_cfg: dict,
        parent_cook_id: str | None = None,
        branch_overrides: dict | None = None,
    ) -> None:
        m = {
            "cook_id": self.cook_id,
            "created_at": _now_iso(),
            "graph_path": graph_path,
            "graph_content_hash": graph_content_hash,
            "engine_format_ver": engine_format_ver,
            "inputs": inputs,
            "concurrency": concurrency,
            "cache": cache_cfg,
            "parent_cook_id": parent_cook_id,
            "branched_from": parent_cook_id,
            "branch_overrides": branch_overrides,
        }
        atomic_write_json(self.manifest_path, m)

    def read_manifest(self) -> dict:
        if not self.manifest_path.is_file():
            raise FileNotFoundError(self.manifest_path)
        return json.loads(self.manifest_path.read_text(encoding="utf-8"))

    def save_state(self, state: CookState) -> None:
        atomic_write_json(self.state_path, state.to_dict())

    def load_state(self) -> CookState:
        if not self.state_path.is_file():
            raise FileNotFoundError(self.state_path)
        d = json.loads(self.state_path.read_text(encoding="utf-8"))
        return CookState.from_dict(d)

    def append_timeline(self, event: dict) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        line = json.dumps(event, ensure_ascii=False, sort_keys=True)
        with self._lock:
            with open(self.timeline_path, "a", encoding="utf-8", newline="\n") as f:
                f.write(line + "\n")

    def read_timeline(self, n: int | None = None) -> list[dict]:
        if not self.timeline_path.is_file():
            return []
        lines = self.timeline_path.read_text(encoding="utf-8").splitlines()
        if n:
            lines = lines[-n:]
        return [json.loads(l) for l in lines if l.strip()]

    def write_node_artifacts(
        self,
        node_id: str,
        *,
        inputs: Any,
        params: Any,
        output_values: Any,
        mutations: list[dict],
        cache_key: str,
        cache_hit: bool,
    ) -> None:
        d = self.dir / node_id
        d.mkdir(parents=True, exist_ok=True)
        atomic_write_json(d / "inputs.json", _safe_for_json(inputs))
        atomic_write_json(d / "params.json", _safe_for_json(params))
        atomic_write_json(d / "output.json", _safe_for_json(output_values))
        atomic_write_json(d / "mutations.json", mutations)
        atomic_write_text(d / "cache_key.txt", cache_key + "\n")
        if cache_hit:
            atomic_write_text(d / "cache_hit.txt", cache_key + "\n")

    def write_result(self, result: CookResult) -> None:
        atomic_write_json(self.result_path, {
            "cook_id": result.cook_id,
            "status": result.status,
            "outputs": _safe_for_json(result.outputs),
            "failed_nodes": result.failed_nodes,
            "duration_ms": result.duration_ms,
        })

    def read_result(self) -> dict | None:
        if not self.result_path.is_file():
            return None
        return json.loads(self.result_path.read_text(encoding="utf-8"))

    def graph_content_hash(self, graph_yaml_text: str) -> str:
        return canonical_hash({"graph_text": graph_yaml_text})


def _safe_for_json(value: Any) -> Any:
    """避免 dict 中含不可序列化对象（dataclass / Path 等）— 转 str。"""
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, dict):
        return {str(k): _safe_for_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_safe_for_json(v) for v in value]
    return str(value)


class CookManager:
    """枚举 / 创建 / 加载 cook。"""

    def __init__(self, run_dir: Path) -> None:
        self.run_dir = Path(run_dir)

    @property
    def cooks_dir(self) -> Path:
        return self.run_dir / "cooks"

    def list_cook_ids(self) -> list[str]:
        if not self.cooks_dir.is_dir():
            return []
        return sorted(p.name for p in self.cooks_dir.iterdir() if p.is_dir())

    def create(self, cook_id: str | None = None) -> Cook:
        cid = cook_id or new_cook_id()
        if (self.cooks_dir / cid).exists():
            raise FileExistsError(f"cook_id 已存在: {cid}")
        cook = Cook(self.run_dir, cid)
        cook.init_dir()
        return cook

    def load(self, cook_id: str) -> Cook:
        if not (self.cooks_dir / cook_id).is_dir():
            raise FileNotFoundError(f"cook 不存在: {cook_id}")
        return Cook(self.run_dir, cook_id)
