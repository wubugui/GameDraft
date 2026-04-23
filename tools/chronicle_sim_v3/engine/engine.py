"""Engine 调度核心（RFC v3-engine.md §8）。

P1 范围：
- run(graph, inputs, cook_id) → CookResult
- 单线程 + LLM 让出（concurrency.enabled=False 时完全串行）
- 缓存命中检查 + commit mutation + unlock 下游
- resume(cook_id)：把中断的 running 节点重设为 ready 续跑
- branch 留 P5

不做：
- subgraph / fanout 静态展开（在 GraphLoader 阶段做；P1-6 落地 flow 节点时实现）
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import hashlib
import inspect
from dataclasses import dataclass, field
from pathlib import Path
from time import monotonic
from typing import Any

from tools.chronicle_sim_v3.engine.cancel import CancelToken
from tools.chronicle_sim_v3.engine.canonical import canonical_hash, sha256_hex
from tools.chronicle_sim_v3.engine.context import ContextStore, Mutation
from tools.chronicle_sim_v3.engine.cook import (
    Cook,
    CookManager,
    CookResult,
    CookState,
    NodeState,
)
from tools.chronicle_sim_v3.engine.errors import EngineError, ValidationError
from tools.chronicle_sim_v3.engine.eventbus import CookEvent, EventBus
from tools.chronicle_sim_v3.engine.expr import (
    PresetRef,
    SubgraphRef,
    evaluate,
    parse,
)
from tools.chronicle_sim_v3.engine.graph import (
    GraphLoader,
    GraphSpec,
    NodeRef,
    _extract_nodes_refs,
)
from tools.chronicle_sim_v3.engine.io import dump_yaml_str
from tools.chronicle_sim_v3.engine.node import (
    NodeBusinessError,
    NodeCookError,
    NodeKindSpec,
    NodeOutput,
    NodeServices,
)
from tools.chronicle_sim_v3.engine.node_audit import NodeAuditWriter
from tools.chronicle_sim_v3.engine.node_cache import (
    ENGINE_FORMAT_VER,
    NodeCacheStore,
    compute_cache_key,
    instantiate_reads,
    jsonable_to_mutation,
)
from tools.chronicle_sim_v3.engine.registry import get_node_class
from tools.chronicle_sim_v3.engine.services import EngineServices


@dataclass
class _NodeRuntime:
    """单个节点在 cook 内的运行期数据。"""

    node_id: str
    nref: NodeRef
    spec: NodeKindSpec
    deps: set[str] = field(default_factory=set)  # 依赖的上游 node id
    rdeps: set[str] = field(default_factory=set)  # 下游
    inputs: dict[str, Any] = field(default_factory=dict)  # 已解析输入
    output: NodeOutput | None = None
    cache_key: str = ""
    cache_hit: bool = False
    started_at: float = 0.0
    duration_ms: int = 0


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


class Engine:
    """单 Run 内 cook 的执行器。"""

    def __init__(
        self,
        run_dir: Path,
        services: EngineServices | None = None,
        *,
        eventbus: EventBus | None = None,
    ) -> None:
        self.run_dir = Path(run_dir)
        self.services = services or EngineServices()
        self.bus = eventbus or EventBus()
        self.cs = ContextStore(self.run_dir, run_id=self._derive_run_id())
        self.node_cache = NodeCacheStore(self.run_dir)
        self.audit = NodeAuditWriter(self.run_dir)
        self.cooks = CookManager(self.run_dir)

    def _derive_run_id(self) -> str:
        meta = self.run_dir / "meta.json"
        if meta.is_file():
            try:
                import json

                d = json.loads(meta.read_text(encoding="utf-8"))
                return str(d.get("run_id", ""))
            except Exception:
                pass
        return ""

    # ---------- 公共入口 ----------

    async def run(
        self,
        graph: GraphSpec,
        inputs: dict[str, Any],
        *,
        cook_id: str | None = None,
        cancel: CancelToken | None = None,
        cache_enabled: bool = True,
        concurrency_enabled: bool = True,
        max_inflight: int = 4,
        graph_path: str = "",
    ) -> CookResult:
        cancel = cancel or CancelToken()
        # 1. 静态校验
        loader = GraphLoader()
        errs = loader.validate(graph)
        if errs:
            raise ValidationError("; ".join(errs))

        # 2. 准备 cook
        cook = self.cooks.create(cook_id=cook_id)
        graph_yaml_text = dump_yaml_str({"id": graph.id, "nodes": {
            nid: {"kind": n.kind, "in": n.in_, "params": n.params}
            for nid, n in graph.nodes.items()
        }})
        cook.write_manifest(
            graph_path=graph_path,
            graph_content_hash=canonical_hash(graph_yaml_text),
            engine_format_ver=ENGINE_FORMAT_VER,
            inputs=inputs,
            concurrency={"enabled": concurrency_enabled, "max_inflight": max_inflight},
            cache_cfg={"enabled": cache_enabled},
        )

        runtimes = self._build_runtimes(graph)
        state = CookState(status="running", started_at=_now_iso())
        for nid in runtimes:
            state.nodes[nid] = NodeState(
                status="ready" if not runtimes[nid].deps else "pending",
            )
        cook.save_state(state)
        self.bus.emit({"event": CookEvent.cook_start.value, "cook_id": cook.cook_id,
                        "ts": _now_iso(), "inputs": inputs})
        cook.append_timeline({"event": "cook.start", "ts": _now_iso(),
                               "cook_id": cook.cook_id, "inputs": inputs})

        nodes_outputs: dict[str, dict] = {}
        t_start = monotonic()
        try:
            await self._drive(
                runtimes, state, cook, inputs, nodes_outputs, cancel,
                cache_enabled=cache_enabled,
                concurrency_enabled=concurrency_enabled,
                max_inflight=max_inflight,
                graph=graph,
            )
        except EngineError:
            state.status = "failed"
            cook.save_state(state)
            self.bus.emit({"event": CookEvent.cook_end.value, "cook_id": cook.cook_id,
                            "ts": _now_iso(), "status": "failed"})
            cook.append_timeline({"event": "cook.end", "ts": _now_iso(),
                                   "cook_id": cook.cook_id, "status": "failed"})
            raise

        finished_iso = _now_iso()
        if cancel.is_set():
            state.status = "cancelled"
        elif state.failed_nodes:
            state.status = "failed"
        else:
            state.status = "completed"
        state.finished_at = finished_iso
        cook.save_state(state)

        # 解析顶层 result（cancel/failed 时仅尽力而为）
        if state.status == "completed":
            outputs = self._resolve_top_outputs(graph, nodes_outputs, inputs)
        else:
            outputs = {}
        result = CookResult(
            cook_id=cook.cook_id,
            status=state.status if state.status in ("completed", "failed", "cancelled") else "completed",
            outputs=outputs,
            failed_nodes=list(state.failed_nodes),
            duration_ms=int((monotonic() - t_start) * 1000),
        )
        cook.write_result(result)
        self.bus.emit({"event": CookEvent.cook_end.value, "cook_id": cook.cook_id,
                        "ts": finished_iso, "status": result.status})
        cook.append_timeline({"event": "cook.end", "ts": finished_iso,
                               "cook_id": cook.cook_id, "status": result.status,
                               "duration_ms": result.duration_ms})
        return result

    async def resume(
        self,
        cook_id: str,
        graph: GraphSpec,
        *,
        cancel: CancelToken | None = None,
    ) -> CookResult:
        """中断后续跑：把 running 节点重设为 ready，再走 _drive。"""
        cancel = cancel or CancelToken()
        cook = self.cooks.load(cook_id)
        manifest = cook.read_manifest()
        state = cook.load_state()
        if state.status == "completed":
            existing = cook.read_result()
            if existing:
                return CookResult(
                    cook_id=cook.cook_id,
                    status=existing.get("status", "completed"),
                    outputs=existing.get("outputs", {}),
                    failed_nodes=existing.get("failed_nodes", []),
                    duration_ms=existing.get("duration_ms", 0),
                )

        runtimes = self._build_runtimes(graph)
        # done / cached 保留；running 退回 ready；failed 也重试一次
        for nid, ns in list(state.nodes.items()):
            if ns.status in ("running", "failed"):
                state.nodes[nid] = NodeState(status="ready")
        # 标 pending 节点的 ready 状态由 _drive 推
        for nid in runtimes:
            if nid not in state.nodes:
                state.nodes[nid] = NodeState(
                    status="ready" if not runtimes[nid].deps else "pending"
                )
        state.status = "running"
        state.failed_nodes = []
        cook.save_state(state)

        # 重建 nodes_outputs：从已 done 节点的 output.json 读
        nodes_outputs: dict[str, dict] = {}
        for nid, ns in state.nodes.items():
            if ns.status in ("done", "cached"):
                p = cook.dir / nid / "output.json"
                if p.is_file():
                    import json

                    nodes_outputs[nid] = json.loads(p.read_text(encoding="utf-8"))
        inputs = manifest.get("inputs", {})
        t_start = monotonic()
        try:
            await self._drive(
                runtimes, state, cook, inputs, nodes_outputs, cancel,
                cache_enabled=manifest.get("cache", {}).get("enabled", True),
                concurrency_enabled=manifest.get("concurrency", {}).get("enabled", True),
                max_inflight=manifest.get("concurrency", {}).get("max_inflight", 4),
                graph=graph,
            )
        except EngineError:
            state.status = "failed"
            cook.save_state(state)
            raise

        if cancel.is_set():
            state.status = "cancelled"
        elif state.failed_nodes:
            state.status = "failed"
        else:
            state.status = "completed"
        state.finished_at = _now_iso()
        cook.save_state(state)
        outputs = self._resolve_top_outputs(graph, nodes_outputs, inputs) if state.status == "completed" else {}
        result = CookResult(
            cook_id=cook.cook_id, status=state.status, outputs=outputs,
            failed_nodes=list(state.failed_nodes),
            duration_ms=int((monotonic() - t_start) * 1000),
        )
        cook.write_result(result)
        return result

    # ---------- 内部 ----------

    def _build_runtimes(self, graph: GraphSpec) -> dict[str, _NodeRuntime]:
        out: dict[str, _NodeRuntime] = {}
        for nid, nref in graph.nodes.items():
            cls = get_node_class(nref.kind)
            rt = _NodeRuntime(node_id=nid, nref=nref, spec=cls.spec)
            for src_id, _ in _extract_nodes_refs(nref.in_):
                if src_id in graph.nodes and src_id != nid:
                    rt.deps.add(src_id)
            for src_id, _ in _extract_nodes_refs(nref.params):
                if src_id in graph.nodes and src_id != nid:
                    rt.deps.add(src_id)
            out[nid] = rt
        for nid, rt in out.items():
            for d in rt.deps:
                if d in out:
                    out[d].rdeps.add(nid)
        return out

    async def _drive(
        self,
        runtimes: dict[str, _NodeRuntime],
        state: CookState,
        cook: Cook,
        cook_inputs: dict[str, Any],
        nodes_outputs: dict[str, dict],
        cancel: CancelToken,
        *,
        cache_enabled: bool,
        concurrency_enabled: bool,
        max_inflight: int,
        graph: GraphSpec,
    ) -> None:
        """主循环。串行 / 并发由 concurrency_enabled 控制。"""
        sem = asyncio.Semaphore(max_inflight if concurrency_enabled else 1)

        # 计算每个节点的剩余依赖数（从已完成的 nodes_outputs 倒推）
        remaining: dict[str, int] = {}
        for nid, rt in runtimes.items():
            done_count = sum(
                1 for d in rt.deps if state.nodes.get(d, NodeState()).status in ("done", "cached")
            )
            remaining[nid] = len(rt.deps) - done_count

        ready: asyncio.Queue = asyncio.Queue()
        for nid, rt in runtimes.items():
            ns = state.nodes[nid]
            if ns.status in ("done", "cached", "failed", "cancelled", "skipped"):
                continue
            if remaining[nid] == 0:
                state.nodes[nid].status = "ready"
                ready.put_nowait(nid)
        cook.save_state(state)

        running_tasks: set[asyncio.Task] = set()
        completed_count = sum(
            1 for ns in state.nodes.values()
            if ns.status in ("done", "cached", "failed", "cancelled", "skipped")
        )
        total = len(runtimes)

        while completed_count < total:
            if cancel.is_set():
                # 等待 in-flight 完成
                if running_tasks:
                    await asyncio.wait(running_tasks)
                break
            # 启动 ready 队列上的所有节点（受 sem 限流）
            while not ready.empty() and (concurrency_enabled or not running_tasks):
                nid = ready.get_nowait()
                rt = runtimes[nid]
                state.nodes[nid].status = "running"
                state.nodes[nid].started_at = _now_iso()
                cook.save_state(state)
                self.bus.emit({"event": CookEvent.node_start.value,
                                "cook_id": cook.cook_id, "node_id": nid,
                                "ts": state.nodes[nid].started_at})
                cook.append_timeline({"event": "node.start", "ts": state.nodes[nid].started_at,
                                       "cook_id": cook.cook_id, "node_id": nid})
                t = asyncio.create_task(
                    self._run_one_node(rt, sem, cook, cook_inputs, nodes_outputs,
                                        cancel, cache_enabled=cache_enabled,
                                        graph=graph)
                )
                running_tasks.add(t)
            if not running_tasks:
                # 没有 ready 可启动，且 in-flight 也空 → 死锁或全部完成
                break

            done, _ = await asyncio.wait(
                running_tasks, return_when=asyncio.FIRST_COMPLETED,
            )
            for t in done:
                running_tasks.discard(t)
                try:
                    nid, status = t.result()
                except Exception as e:
                    # 不应该到这里：_run_one_node 自己包了异常
                    raise EngineError(f"未预期异常: {e}") from e
                completed_count += 1
                rt = runtimes[nid]
                state.nodes[nid].status = status
                state.nodes[nid].finished_at = _now_iso()
                state.nodes[nid].duration_ms = rt.duration_ms
                if status == "failed":
                    state.failed_nodes.append(nid)
                    cook.save_state(state)
                    # fail-fast
                    if running_tasks:
                        await asyncio.wait(running_tasks)
                    return
                cook.save_state(state)
                # unlock 下游
                if status in ("done", "cached"):
                    for child in rt.rdeps:
                        remaining[child] -= 1
                        if remaining[child] == 0 and state.nodes[child].status == "pending":
                            state.nodes[child].status = "ready"
                            ready.put_nowait(child)
                    cook.save_state(state)

    async def _run_one_node(
        self,
        rt: _NodeRuntime,
        sem: asyncio.Semaphore,
        cook: Cook,
        cook_inputs: dict[str, Any],
        nodes_outputs: dict[str, dict],
        cancel: CancelToken,
        *,
        cache_enabled: bool,
        graph: GraphSpec,
    ) -> tuple[str, str]:
        """跑单个节点：解析 inputs → cache 检查 → cook → commit mutation。

        返回 (node_id, status)；status ∈ done | cached | failed | cancelled。
        """
        async with sem:
            t_start = monotonic()
            try:
                if cancel.is_set():
                    return rt.node_id, "cancelled"
                # 1. 解析输入
                resolved_inputs = self._resolve_inputs(rt.nref, nodes_outputs, cook_inputs)
                rt.inputs = resolved_inputs
                # 2. params（也支持 ${ctx.X} / ${nodes.X.Y} 解析）
                resolved_params = self._resolve_params(rt.nref, nodes_outputs, cook_inputs)
                # 3. when 短路
                if rt.nref.when:
                    cond = self._eval_top_expr(
                        rt.nref.when, nodes_outputs, cook_inputs,
                    )
                    if not cond:
                        rt.duration_ms = int((monotonic() - t_start) * 1000)
                        cook.write_node_artifacts(
                            rt.node_id,
                            inputs=resolved_inputs, params=resolved_params,
                            output_values={}, mutations=[],
                            cache_key="", cache_hit=False,
                        )
                        nodes_outputs[rt.node_id] = {}
                        cook.append_timeline({"event": "node.skipped", "ts": _now_iso(),
                                               "cook_id": cook.cook_id, "node_id": rt.node_id})
                        return rt.node_id, "skipped"
                # 4. cache key
                week = cook_inputs.get("week") if isinstance(cook_inputs.get("week"), int) else None
                reads_keys = instantiate_reads(
                    rt.spec.reads, resolved_inputs, resolved_params,
                    self.cs.run_id, week,
                )
                cache_key = compute_cache_key(
                    rt.spec, resolved_inputs, resolved_params, reads_keys, self.cs,
                )
                rt.cache_key = cache_key
                # 5. cache lookup
                if cache_enabled and rt.spec.cacheable and rt.spec.deterministic:
                    entry = self.node_cache.lookup(cache_key)
                    if entry:
                        # 命中 → commit mutations + 写产物 + 标 cached
                        muts = [jsonable_to_mutation(m) for m in entry.get("mutations", [])]
                        self.cs.commit(muts)
                        nodes_outputs[rt.node_id] = entry.get("values", {})
                        rt.cache_hit = True
                        rt.duration_ms = int((monotonic() - t_start) * 1000)
                        cook.write_node_artifacts(
                            rt.node_id,
                            inputs=resolved_inputs, params=resolved_params,
                            output_values=entry.get("values", {}),
                            mutations=[m for m in entry.get("mutations", [])],
                            cache_key=cache_key, cache_hit=True,
                        )
                        self.bus.emit({"event": CookEvent.node_cache_hit.value,
                                        "cook_id": cook.cook_id, "node_id": rt.node_id,
                                        "in_hash": cache_key, "ts": _now_iso()})
                        cook.append_timeline({"event": "node.cache_hit", "ts": _now_iso(),
                                               "cook_id": cook.cook_id, "node_id": rt.node_id,
                                               "in_hash": cache_key})
                        self.audit.write(
                            cook_id=cook.cook_id, node_id=rt.node_id,
                            node_kind=rt.spec.kind, node_version=rt.spec.version,
                            status="cached", duration_ms=rt.duration_ms,
                            in_hash=cache_key,
                            out_hash=canonical_hash(entry.get("values", {})),
                            cache_hit=True, mutations_count=len(muts),
                        )
                        cook.append_timeline({"event": "node.end", "ts": _now_iso(),
                                               "cook_id": cook.cook_id, "node_id": rt.node_id,
                                               "status": "cached", "duration_ms": rt.duration_ms})
                        return rt.node_id, "cached"
                # 6. 实际 cook
                node_inst = get_node_class(rt.spec.kind)()
                node_services = NodeServices(
                    agents=self.services.agents,
                    _llm=self.services._llm,
                    rng=self._derive_rng(rt.node_id, cook.cook_id),
                    clock=self.services.clock,
                    chroma=self.services.chroma,
                    eventbus=self.bus,
                    spec_search_root=self.services.spec_search_root,
                )
                # flow.* 节点需要拿到本 Engine 引用以构造嵌套 SubgraphRunner
                setattr(node_services, "_engine_ref", self)
                ctx = self.cs.read_view(week=week)
                if cancel.is_set():
                    return rt.node_id, "cancelled"
                try:
                    output = await node_inst.cook(
                        ctx, resolved_inputs, resolved_params, node_services, cancel,
                    )
                except NodeBusinessError as e:
                    rt.duration_ms = int((monotonic() - t_start) * 1000)
                    self.bus.emit({"event": CookEvent.node_failed.value,
                                    "cook_id": cook.cook_id, "node_id": rt.node_id,
                                    "ts": _now_iso(), "error": str(e)})
                    cook.append_timeline({"event": "node.failed", "ts": _now_iso(),
                                           "cook_id": cook.cook_id, "node_id": rt.node_id,
                                           "status": "failed", "error": str(e),
                                           "details": e.details})
                    self.audit.write(
                        cook_id=cook.cook_id, node_id=rt.node_id,
                        node_kind=rt.spec.kind, node_version=rt.spec.version,
                        status="failed", duration_ms=rt.duration_ms,
                        in_hash=cache_key, out_hash="",
                        cache_hit=False, mutations_count=0,
                        error=str(e),
                    )
                    return rt.node_id, "failed"
                except Exception as e:
                    rt.duration_ms = int((monotonic() - t_start) * 1000)
                    self.bus.emit({"event": CookEvent.node_failed.value,
                                    "cook_id": cook.cook_id, "node_id": rt.node_id,
                                    "ts": _now_iso(), "error": repr(e)})
                    cook.append_timeline({"event": "node.failed", "ts": _now_iso(),
                                           "cook_id": cook.cook_id, "node_id": rt.node_id,
                                           "status": "failed", "error": repr(e)})
                    self.audit.write(
                        cook_id=cook.cook_id, node_id=rt.node_id,
                        node_kind=rt.spec.kind, node_version=rt.spec.version,
                        status="failed", duration_ms=rt.duration_ms,
                        in_hash=cache_key, out_hash="",
                        cache_hit=False, mutations_count=0,
                        error=repr(e),
                    )
                    return rt.node_id, "failed"
                # 7. commit
                if output.mutations:
                    self.cs.commit(output.mutations)
                    self.bus.emit({"event": CookEvent.mutation_commit.value,
                                    "cook_id": cook.cook_id, "node_id": rt.node_id,
                                    "count": len(output.mutations), "ts": _now_iso()})
                # 8. cache store（确定性 & cacheable）
                if cache_enabled and rt.spec.cacheable and rt.spec.deterministic:
                    self.node_cache.store(
                        cache_key, rt.spec, output.values, output.mutations,
                        in_hash_components={
                            "inputs": canonical_hash(resolved_inputs),
                            "params": canonical_hash(resolved_params),
                            "reads": {k: self.cs.slice_hash(k) for k in reads_keys},
                        },
                    )
                rt.output = output
                nodes_outputs[rt.node_id] = output.values
                rt.duration_ms = int((monotonic() - t_start) * 1000)
                cook.write_node_artifacts(
                    rt.node_id,
                    inputs=resolved_inputs, params=resolved_params,
                    output_values=output.values,
                    mutations=[_mutation_dict(m) for m in output.mutations],
                    cache_key=cache_key, cache_hit=False,
                )
                self.bus.emit({"event": CookEvent.node_end.value,
                                "cook_id": cook.cook_id, "node_id": rt.node_id,
                                "ts": _now_iso(), "status": "done",
                                "duration_ms": rt.duration_ms})
                cook.append_timeline({"event": "node.end", "ts": _now_iso(),
                                       "cook_id": cook.cook_id, "node_id": rt.node_id,
                                       "status": "done", "duration_ms": rt.duration_ms,
                                       "in_hash": cache_key,
                                       "out_hash": canonical_hash(output.values)})
                self.audit.write(
                    cook_id=cook.cook_id, node_id=rt.node_id,
                    node_kind=rt.spec.kind, node_version=rt.spec.version,
                    status="done", duration_ms=rt.duration_ms,
                    in_hash=cache_key, out_hash=canonical_hash(output.values),
                    cache_hit=False, mutations_count=len(output.mutations),
                )
                return rt.node_id, "done"
            finally:
                pass

    def _derive_rng(self, node_id: str, cook_id: str):
        seed = sha256_hex(f"{self.cs.run_id}|{cook_id}|{node_id}").encode("ascii")
        return self.services.rng_factory(seed[:16])

    def _resolve_inputs(
        self,
        nref: NodeRef,
        nodes_outputs: dict[str, dict],
        cook_inputs: dict[str, Any],
    ) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for k, v in nref.in_.items():
            out[k] = self._resolve_value(v, nodes_outputs, cook_inputs)
        return out

    def _resolve_params(
        self,
        nref: NodeRef,
        nodes_outputs: dict[str, dict],
        cook_inputs: dict[str, Any],
    ) -> dict[str, Any]:
        out: dict[str, Any] = {}
        preserve_item = (
            nref.kind in {"flow.foreach", "flow.fanout_per_agent"}
        )
        for k, v in nref.params.items():
            if preserve_item and k == "body_inputs":
                out[k] = self._resolve_value(
                    v, nodes_outputs, cook_inputs, preserve_item_refs=True,
                )
            else:
                out[k] = self._resolve_value(v, nodes_outputs, cook_inputs)
        return out

    def _resolve_value(
        self,
        value: Any,
        nodes_outputs: dict[str, dict],
        cook_inputs: dict[str, Any],
        *,
        preserve_item_refs: bool = False,
    ) -> Any:
        """递归解析容器 / 字面量 / placeholder。"""
        if isinstance(value, str) and "${" in value:
            if preserve_item_refs and "${item" in value:
                return value
            return self._eval_top_expr(value, nodes_outputs, cook_inputs)
        if isinstance(value, dict):
            return {
                k: self._resolve_value(
                    v,
                    nodes_outputs,
                    cook_inputs,
                    preserve_item_refs=preserve_item_refs,
                )
                for k, v in value.items()
            }
        if isinstance(value, list):
            return [
                self._resolve_value(
                    v,
                    nodes_outputs,
                    cook_inputs,
                    preserve_item_refs=preserve_item_refs,
                )
                for v in value
            ]
        return value

    def _eval_top_expr(
        self,
        expr_str: str,
        nodes_outputs: dict[str, dict],
        cook_inputs: dict[str, Any],
    ) -> Any:
        ast = parse(expr_str)
        if ast.kind == "plain":
            return ast.raw
        if ast.kind == "subgraph_ref":
            return SubgraphRef(name=ast.payload)
        if ast.kind == "preset_ref":
            topic, _, name = ast.payload.partition("/")
            return PresetRef(topic=topic, name=name)
        scope = {
            "ctx": {"week": cook_inputs.get("week"), "run_id": self.cs.run_id},
            "nodes": nodes_outputs,
            "inputs": cook_inputs,
            "params": {},
            "item": None,
        }
        return evaluate(ast, scope)

    def _resolve_top_outputs(
        self,
        graph: GraphSpec,
        nodes_outputs: dict[str, dict],
        cook_inputs: dict[str, Any],
    ) -> dict[str, Any]:
        if not graph.result:
            return {}
        return {
            name: self._resolve_value(expr, nodes_outputs, cook_inputs)
            for name, expr in graph.result.items()
        }


def _mutation_dict(m: Mutation) -> dict:
    return {
        "op": m.op,
        "key": m.key,
        "payload": m.payload,
        "payload_path": str(m.payload_path) if m.payload_path else None,
        "new_key": m.new_key,
    }
