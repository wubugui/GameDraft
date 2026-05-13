"""Graph 加载、校验、规范化（RFC v3-engine.md §7）。

GraphSpec 是图的内存表示：节点字典 + 边表 + 顶层 inputs/outputs + GUI 块。
GraphLoader 负责：
- 读 YAML → GraphSpec（pydantic 校验）
- 静态校验（kind 注册 / 表达式可解析 / 端口标签兼容 / DAG / reads/writes 实例化）
- 规范化（key 顺序固定 / canonical 写出，便于 GUI / CLI diff 为零）

P1 不做 subgraph 展开实现（flow.subgraph 节点的 ref 字段保留为 SubgraphRef
占位，等到 P1-6 flow 节点真正展开）；P1-3 仅做静态校验与基本结构。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from io import StringIO
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field, model_validator
from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap

from tools.chronicle_sim_v3.engine.errors import ValidationError
from tools.chronicle_sim_v3.engine.expr import (
    PresetRef,
    SubgraphRef,
    parse,
)
from tools.chronicle_sim_v3.engine.io import dump_yaml_str, read_yaml
from tools.chronicle_sim_v3.engine.registry import get_node_class, list_kinds
from tools.chronicle_sim_v3.engine.types import PortSpec, can_connect, parse_tag


# ---------- pydantic schema ----------


class GraphPort(BaseModel):
    """顶层 inputs / outputs 端口声明。"""

    type: str = "Any"
    required: bool = True
    default: Any = None
    doc: str = ""


class NodeRef(BaseModel):
    """节点引用（YAML 中 spec.nodes.<id>:）。"""

    kind: str
    in_: dict[str, Any] = Field(alias="in", default_factory=dict)
    params: dict[str, Any] = Field(default_factory=dict)
    when: str | None = None

    model_config = {"populate_by_name": True}


class Edge(BaseModel):
    src: str  # "node_id.port"
    dst: str  # "node_id.port"

    @classmethod
    def from_pair(cls, src: str, dst: str) -> "Edge":
        return cls(src=src, dst=dst)


class GraphSpec(BaseModel):
    schema_version: str = Field(alias="schema")
    id: str
    title: str = ""
    description: str = ""
    inputs: dict[str, GraphPort] = Field(default_factory=dict)
    outputs: dict[str, GraphPort] = Field(default_factory=dict)
    nodes: dict[str, NodeRef] = Field(default_factory=dict)
    edges: list[Edge] = Field(default_factory=list)
    result: dict[str, str] = Field(default_factory=dict)
    gui: dict[str, Any] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


# ---------- 表达式静态扫描 ----------


# 匹配 ${nodes.<id>.<port>...}：只取前两段；id/port 都不含 dot。
# `${nodes.x.y.z}` → (x, y)；剩下 `.z` 是 port 的属性深取，不影响依赖图
_NODES_REF_RE = re.compile(
    r"\$\{\s*nodes\.([a-zA-Z_][a-zA-Z0-9_]*)\.([a-zA-Z_][a-zA-Z0-9_]*)"
)


def _walk_strings(value: Any):
    """yield 任意嵌套结构里的所有字符串叶子节点。"""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _walk_strings(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from _walk_strings(v)


def _extract_nodes_refs(value: Any) -> list[tuple[str, str]]:
    """从表达式 ${nodes.X.Y} 抽出 (X, Y) 列表。"""
    out: list[tuple[str, str]] = []
    for s in _walk_strings(value):
        for m in _NODES_REF_RE.finditer(s):
            out.append((m.group(1), m.group(2)))
    return out


def _validate_expressions_in(value: Any, path_label: str) -> list[str]:
    """对所有 ${...} 字符串做语法检查。返回错误描述列表。"""
    errors: list[str] = []
    for s in _walk_strings(value):
        if "${" not in s:
            continue
        # 整段是 ${...} 才能 parse；混合字符串也尝试逐个 placeholder 扫
        try:
            parse(s)
        except Exception as e:
            # 混合字符串模式：parse 不接受；逐个 placeholder 拆解校验
            for m in re.finditer(r"\$\{([^}]+)\}", s):
                try:
                    parse("${" + m.group(1) + "}")
                except Exception as e2:
                    errors.append(f"{path_label}: 表达式非法 {m.group(0)!r}: {e2}")
            # 若整段都是单 placeholder 但仍 fail（如 mixed），上面已收集
            if "${" in s and "}" in s and not re.fullmatch(r"\$\{[^}]+\}", s.strip()):
                # 混合字符串 RFC 不允许
                errors.append(f"{path_label}: 不允许混合 placeholder 字符串 {s!r}")
    return errors


# ---------- GraphLoader ----------


_TOP_KEY_ORDER = [
    "schema", "id", "title", "description",
    "inputs", "outputs", "spec", "gui",
]


class GraphLoader:
    """加载与校验。所有 IO 走 engine/io.py。"""

    def load(self, path: str | Path) -> GraphSpec:
        raw = read_yaml(path)
        return self._load_dict(raw, source=str(path))

    def load_text(self, text: str) -> GraphSpec:
        from tools.chronicle_sim_v3.engine.io import read_yaml_text

        raw = read_yaml_text(text)
        return self._load_dict(raw, source="<text>")

    def _load_dict(self, raw: Any, *, source: str) -> GraphSpec:
        if not isinstance(raw, dict):
            raise ValidationError(f"{source}: graph 顶层必须 mapping")
        plain = _to_plain(raw)
        # spec.nodes / spec.edges / spec.result 嵌在 spec 块里
        spec_block = plain.pop("spec", {}) or {}
        merged = {**plain}
        if isinstance(spec_block, dict):
            merged["nodes"] = spec_block.get("nodes", {})
            merged["edges"] = [
                Edge(src=str(e.get("from", "")), dst=str(e.get("to", "")))
                for e in (spec_block.get("edges") or [])
            ]
            merged["result"] = spec_block.get("result", {})
        try:
            return GraphSpec.model_validate(merged)
        except Exception as e:
            raise ValidationError(f"{source}: graph schema 校验失败: {e}") from e

    def validate(self, spec: GraphSpec, *, registry_check: bool = True) -> list[str]:
        """返回错误列表（空 = OK）。`registry_check=False` 测试用，跳过 kind 检查。"""
        errors: list[str] = []
        # 1. kind 已注册
        if registry_check:
            registered = set(list_kinds())
            for nid, nref in spec.nodes.items():
                if nref.kind not in registered:
                    errors.append(f"节点 {nid!r}: 未注册的 kind {nref.kind!r}")
        # 2. 表达式可解析
        for nid, nref in spec.nodes.items():
            errors.extend(_validate_expressions_in(nref.in_, f"node[{nid}].in"))
            errors.extend(_validate_expressions_in(nref.params, f"node[{nid}].params"))
            if nref.when:
                errors.extend(_validate_expressions_in(nref.when, f"node[{nid}].when"))
        # 3. ${nodes.X.Y} 中 X 存在 / Y 是 X 的 output 端口
        if registry_check:
            for nid, nref in spec.nodes.items():
                refs = _extract_nodes_refs(nref.in_) + _extract_nodes_refs(nref.params)
                for src_id, src_port in refs:
                    if src_id not in spec.nodes:
                        errors.append(
                            f"node[{nid}] 引用未知节点 {src_id!r}.{src_port}"
                        )
                        continue
                    src_kind = spec.nodes[src_id].kind
                    try:
                        src_cls = get_node_class(src_kind)
                    except ValidationError:
                        continue  # kind 错误已在前面报
                    if src_port not in src_cls.spec.output_names():
                        errors.append(
                            f"node[{nid}] 引用 {src_id}.{src_port}，"
                            f"但 {src_kind!r} 没有此 output 端口"
                        )
        # 4. 端口标签兼容（仅对 ${nodes.X.Y} 形态做精确检查）
        if registry_check:
            for nid, nref in spec.nodes.items():
                try:
                    dst_cls = get_node_class(nref.kind)
                except ValidationError:
                    continue
                dst_inputs: dict[str, PortSpec] = {p.name: p for p in dst_cls.spec.inputs}
                for in_port, value in nref.in_.items():
                    if in_port not in dst_inputs:
                        errors.append(
                            f"node[{nid}].in.{in_port}: kind {nref.kind!r} 无此 input 端口"
                        )
                        continue
                    # 端口标签兼容只对『直连』情形检查：
                    # value 本身是单一 placeholder 字符串 "${nodes.X.Y}"
                    # 嵌套在 dict/list 里的引用是数据组装，不属于端口直连
                    if not (isinstance(value, str) and value.strip().startswith("${nodes.")):
                        continue
                    refs = _extract_nodes_refs(value)
                    if len(refs) != 1:
                        continue
                    src_id, src_port = refs[0]
                    if src_id not in spec.nodes:
                        continue
                    src_kind = spec.nodes[src_id].kind
                    try:
                        src_cls = get_node_class(src_kind)
                    except ValidationError:
                        continue
                    src_port_spec = next(
                        (p for p in src_cls.spec.outputs if p.name == src_port),
                        None,
                    )
                    if src_port_spec is None:
                        continue
                    dst_port_spec = dst_inputs[in_port]
                    if not can_connect(
                        parse_tag(src_port_spec.type),
                        parse_tag(dst_port_spec.type),
                    ):
                        errors.append(
                            f"node[{nid}].in.{in_port}: 端口标签不兼容 "
                            f"{src_id}.{src_port}({src_port_spec.type}) "
                            f"→ {nid}.{in_port}({dst_port_spec.type})"
                        )
        # 5. DAG（无环）
        if registry_check:
            errors.extend(self._detect_cycle(spec))
        return errors

    def _detect_cycle(self, spec: GraphSpec) -> list[str]:
        """对 ${nodes.X.Y} 引用建图做拓扑序检查。"""
        deps: dict[str, set[str]] = {nid: set() for nid in spec.nodes}
        for nid, nref in spec.nodes.items():
            for src_id, _ in _extract_nodes_refs(nref.in_):
                if src_id in deps and src_id != nid:
                    deps[nid].add(src_id)
            for src_id, _ in _extract_nodes_refs(nref.params):
                if src_id in deps and src_id != nid:
                    deps[nid].add(src_id)
        # Kahn
        indeg = {n: 0 for n in deps}
        rev: dict[str, set[str]] = {n: set() for n in deps}
        for n, ds in deps.items():
            for d in ds:
                rev[d].add(n)
                indeg[n] += 1
        ready = [n for n, k in indeg.items() if k == 0]
        seen = 0
        while ready:
            n = ready.pop()
            seen += 1
            for nb in rev[n]:
                indeg[nb] -= 1
                if indeg[nb] == 0:
                    ready.append(nb)
        if seen < len(deps):
            stuck = sorted(n for n, k in indeg.items() if k > 0)
            return [f"图存在环：涉及节点 {stuck}"]
        return []

    def topo_order(self, spec: GraphSpec) -> list[str]:
        """返回拓扑序节点 id 列表（按字典序作为 tie-breaker）。"""
        deps: dict[str, set[str]] = {nid: set() for nid in spec.nodes}
        for nid, nref in spec.nodes.items():
            for src_id, _ in _extract_nodes_refs(nref.in_):
                if src_id in deps and src_id != nid:
                    deps[nid].add(src_id)
            for src_id, _ in _extract_nodes_refs(nref.params):
                if src_id in deps and src_id != nid:
                    deps[nid].add(src_id)
        indeg = {n: len(d) for n, d in deps.items()}
        rev: dict[str, set[str]] = {n: set() for n in deps}
        for n, ds in deps.items():
            for d in ds:
                rev[d].add(n)
        ready = sorted(n for n, k in indeg.items() if k == 0)
        order: list[str] = []
        while ready:
            n = ready.pop(0)
            order.append(n)
            for nb in sorted(rev[n]):
                indeg[nb] -= 1
                if indeg[nb] == 0:
                    ready.append(nb)
                    ready.sort()
        if len(order) != len(deps):
            raise ValidationError("topo_order: 图存在环")
        return order

    def normalize_inplace(self, spec: GraphSpec) -> None:
        """节点 id 字典序、edges 排序。pydantic 模型不可变，重建 nodes dict。"""
        sorted_nodes = {k: spec.nodes[k] for k in sorted(spec.nodes.keys())}
        spec.nodes = sorted_nodes
        spec.edges = sorted(spec.edges, key=lambda e: (e.src, e.dst))

    def write(self, spec: GraphSpec, path: str | Path) -> None:
        """canonical 写出：顶层键固定顺序、spec.nodes 字典序、edges 排序。"""
        self.normalize_inplace(spec)
        data = self._to_yaml_dict(spec)
        text = dump_yaml_str(data)
        if not text.endswith("\n"):
            text += "\n"
        from tools.chronicle_sim_v3.engine.io import atomic_write_text

        atomic_write_text(path, text)

    def _to_yaml_dict(self, spec: GraphSpec) -> dict:
        out = CommentedMap()
        out["schema"] = spec.schema_version
        out["id"] = spec.id
        if spec.title:
            out["title"] = spec.title
        if spec.description:
            out["description"] = spec.description
        if spec.inputs:
            out["inputs"] = {k: v.model_dump(exclude_none=True) for k, v in spec.inputs.items()}
        if spec.outputs:
            out["outputs"] = {k: v.model_dump(exclude_none=True) for k, v in spec.outputs.items()}
        spec_block: dict[str, Any] = {"nodes": {}}
        for nid in sorted(spec.nodes.keys()):
            n = spec.nodes[nid]
            entry: dict[str, Any] = {"kind": n.kind}
            if n.in_:
                entry["in"] = n.in_
            if n.params:
                entry["params"] = n.params
            if n.when:
                entry["when"] = n.when
            spec_block["nodes"][nid] = entry
        if spec.edges:
            spec_block["edges"] = [{"from": e.src, "to": e.dst} for e in spec.edges]
        if spec.result:
            spec_block["result"] = spec.result
        out["spec"] = spec_block
        if spec.gui:
            out["gui"] = spec.gui
        return out


def _to_plain(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(k): _to_plain(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_to_plain(v) for v in value]
    return value
