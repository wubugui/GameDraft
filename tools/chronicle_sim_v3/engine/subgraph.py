"""子图加载与运行（RFC v3-engine.md §7.4 / §8.3 的简化版）。

设计要点：
- SubgraphLoader 按 ref 名查 `data/subgraphs/<name>.yaml`，找不到再查 `data/graphs/<name>.yaml`
- PresetLoader 查 `data/presets/<topic>/<name>.yaml` 返回 dict
- SubgraphRunner 用『轻量嵌套 cook』跑子图：
    - 不持久化（不写 cooks/<id>/ 目录）
    - 共用父 Engine 的 ContextStore / NodeCache / EventBus / EngineServices
    - inputs 由 flow 节点传入；outputs 取 graph.result 解析后的 dict
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from tools.chronicle_sim_v3.engine.cancel import CancelToken
from tools.chronicle_sim_v3.engine.errors import ValidationError
from tools.chronicle_sim_v3.engine.expr import (
    PresetRef,
    SubgraphRef,
    evaluate,
    parse,
)
from tools.chronicle_sim_v3.engine.graph import (
    GraphLoader,
    GraphSpec,
    _extract_nodes_refs,
)
from tools.chronicle_sim_v3.engine.io import read_yaml
from tools.chronicle_sim_v3.engine.node import (
    NodeBusinessError,
    NodeServices,
)
from tools.chronicle_sim_v3.engine.registry import get_node_class


_DEFAULT_DIRS = ("data/subgraphs", "data/graphs")
_DEFAULT_PRESETS_DIR = "data/presets"


def _v3_pkg_root() -> Path:
    return Path(__file__).resolve().parents[1]


class SubgraphLoader:
    """SubgraphRef → GraphSpec。

    搜索顺序：
    1. spec_search_root / data/subgraphs/<name>.yaml
    2. spec_search_root / data/graphs/<name>.yaml
    3. v3_pkg_root / data/subgraphs/<name>.yaml
    4. v3_pkg_root / data/graphs/<name>.yaml

    spec_search_root 由 EngineServices.spec_search_root 提供（通常是 run_dir）。
    """

    def __init__(self, search_root: Path | None = None) -> None:
        self.search_root = Path(search_root) if search_root else None
        self._loader = GraphLoader()

    def _search_paths(self, ref: SubgraphRef) -> list[Path]:
        out: list[Path] = []
        roots: list[Path] = []
        if self.search_root:
            roots.append(self.search_root)
        roots.append(_v3_pkg_root())
        for root in roots:
            for sub in _DEFAULT_DIRS:
                out.append(root / sub / f"{ref.name}.yaml")
        return out

    def load(self, ref: SubgraphRef) -> GraphSpec:
        for p in self._search_paths(ref):
            if p.is_file():
                return self._loader.load(p)
        raise ValidationError(
            f"未找到子图 {ref.name!r}；已搜索 {self._search_paths(ref)}"
        )


class PresetLoader:
    """PresetRef → dict。"""

    def __init__(self, search_root: Path | None = None) -> None:
        self.search_root = Path(search_root) if search_root else None

    def _search_paths(self, ref: PresetRef) -> list[Path]:
        out: list[Path] = []
        roots: list[Path] = []
        if self.search_root:
            roots.append(self.search_root)
        roots.append(_v3_pkg_root())
        for root in roots:
            out.append(root / _DEFAULT_PRESETS_DIR / ref.topic / f"{ref.name}.yaml")
        return out

    def load(self, ref: PresetRef) -> dict:
        for p in self._search_paths(ref):
            if p.is_file():
                v = read_yaml(p)
                if not isinstance(v, dict):
                    raise ValidationError(f"preset 顶层必须 mapping: {p}")
                return v
        raise ValidationError(
            f"未找到 preset {ref.topic}/{ref.name}；已搜索 {self._search_paths(ref)}"
        )


class SubgraphRunner:
    """轻量子图执行：复用父 ContextStore / NodeCache / EventBus，不写 cook 目录。

    用于 flow.foreach / flow.subgraph / flow.parallel 等节点。
    """

    def __init__(self, parent_engine: Any) -> None:
        # parent_engine: tools.chronicle_sim_v3.engine.engine.Engine
        self.parent = parent_engine

    async def run(
        self,
        spec: GraphSpec,
        inputs: dict[str, Any],
        *,
        cancel: CancelToken | None = None,
        cache_enabled: bool = True,
        item: Any = None,
    ) -> dict[str, Any]:
        """跑子图并返回顶层 result（dict）。

        子图节点状态全在内存，不写 state.json / output.json。
        节点依然过 NodeCache 命中检查（共享父 cache 池）。
        """
        cancel = cancel or CancelToken()
        # 校验：复用 GraphLoader.validate（registry 必须就位）
        loader = GraphLoader()
        errs = loader.validate(spec)
        if errs:
            raise ValidationError(f"subgraph {spec.id!r} 校验失败: {errs}")

        order = loader.topo_order(spec)
        nodes_outputs: dict[str, dict] = {}

        for nid in order:
            if cancel.is_set():
                raise NodeBusinessError(f"subgraph {spec.id!r} 被取消")
            nref = spec.nodes[nid]
            cls = get_node_class(nref.kind)
            # 解析 inputs / params（支持 ${item.X} / ${inputs.X} / ${nodes.X.Y}）
            scope_extra = {"item": item, "inputs": inputs}
            r_inputs = self._resolve_dict(nref.in_, nodes_outputs, scope_extra)
            r_params = self._resolve_dict(nref.params, nodes_outputs, scope_extra)
            # when 短路
            if nref.when:
                cond = self._resolve_value(nref.when, nodes_outputs, scope_extra)
                if not cond:
                    nodes_outputs[nid] = {}
                    continue
            # 执行
            inst = cls()
            services = NodeServices(
                agents=self.parent.services.agents,
                _llm=self.parent.services._llm,
                rng=self.parent._derive_rng(nid, "subgraph"),
                clock=self.parent.services.clock,
                chroma=self.parent.services.chroma,
                eventbus=self.parent.bus,
                spec_search_root=self.parent.services.spec_search_root,
            )
            # flow.* 嵌套节点需要 _engine_ref 才能再启动子图
            setattr(services, "_engine_ref", self.parent)
            ctx = self.parent.cs.read_view(week=inputs.get("week"))
            output = await inst.cook(ctx, r_inputs, r_params, services, cancel)
            if output.mutations:
                self.parent.cs.commit(output.mutations)
            nodes_outputs[nid] = output.values

        # 解析 result
        if not spec.result:
            return {}
        return {
            name: self._resolve_value(expr, nodes_outputs, {"inputs": inputs, "item": item})
            for name, expr in spec.result.items()
        }

    def _resolve_dict(
        self,
        d: dict,
        nodes_outputs: dict[str, dict],
        scope_extra: dict,
    ) -> dict:
        return {k: self._resolve_value(v, nodes_outputs, scope_extra) for k, v in d.items()}

    def _resolve_value(
        self,
        value: Any,
        nodes_outputs: dict[str, dict],
        scope_extra: dict,
    ) -> Any:
        if isinstance(value, str) and "${" in value:
            ast = parse(value)
            if ast.kind == "plain":
                return ast.raw
            if ast.kind == "subgraph_ref":
                return SubgraphRef(name=ast.payload)
            if ast.kind == "preset_ref":
                topic, _, name = ast.payload.partition("/")
                return PresetRef(topic=topic, name=name)
            scope = {
                "ctx": {"week": scope_extra.get("inputs", {}).get("week"),
                         "run_id": self.parent.cs.run_id},
                "nodes": nodes_outputs,
                "inputs": scope_extra.get("inputs", {}),
                "params": {},
                "item": scope_extra.get("item"),
            }
            return evaluate(ast, scope)
        if isinstance(value, dict):
            return {k: self._resolve_value(v, nodes_outputs, scope_extra) for k, v in value.items()}
        if isinstance(value, list):
            return [self._resolve_value(v, nodes_outputs, scope_extra) for v in value]
        return value
