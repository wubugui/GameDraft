"""data 抽屉 — 通用集合 / 字典 / 列表算子。

P1 子集：filter.where / map.expr / sort.by / take.n / count / list.concat / dict.merge
"""
from __future__ import annotations

from typing import Any

from tools.chronicle_sim_v3.engine.expr import evaluate, parse
from tools.chronicle_sim_v3.engine.node import (
    NodeBusinessError,
    NodeKindSpec,
    NodeOutput,
    Param,
)
from tools.chronicle_sim_v3.engine.registry import register_node
from tools.chronicle_sim_v3.engine.types import PortSpec


def _eval_expr_for_item(expr_str: str, item: Any, params: dict, inputs: dict, ctx: Any) -> Any:
    """对每个 item 在 ${item.X} ${params.X} 等 scope 下求值。"""
    expr = parse(expr_str)
    scope = {
        "item": item,
        "params": params,
        "inputs": inputs,
        "ctx": ctx,
        "nodes": {},
    }
    return evaluate(expr, scope)


@register_node
class FilterWhere:
    spec = NodeKindSpec(
        kind="filter.where",
        category="data",
        title="filter.where",
        description="按表达式过滤列表，保留 expr 求值为真的项。",
        inputs=(PortSpec(name="list", type="List[Any]"),),
        outputs=(PortSpec(name="out", type="List[Any]"),),
        params=(
            Param(name="expr", type="expr", required=True,
                  doc="形如 ${item.life_status == 'alive'}"),
        ),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        items = inputs.get("list") or []
        expr_str = params["expr"]
        out = [it for it in items if _eval_expr_for_item(expr_str, it, params, inputs, ctx)]
        return NodeOutput(values={"out": out})


@register_node
class MapExpr:
    spec = NodeKindSpec(
        kind="map.expr",
        category="data",
        title="map.expr",
        description="对列表每项求 expr，返回结果列表。",
        inputs=(PortSpec(name="list", type="List[Any]"),),
        outputs=(PortSpec(name="out", type="List[Any]"),),
        params=(Param(name="expr", type="expr", required=True),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        items = inputs.get("list") or []
        expr_str = params["expr"]
        out = [_eval_expr_for_item(expr_str, it, params, inputs, ctx) for it in items]
        return NodeOutput(values={"out": out})


@register_node
class SortBy:
    spec = NodeKindSpec(
        kind="sort.by",
        category="data",
        title="sort.by",
        description="按 key_expr 排序。order=asc|desc。",
        inputs=(PortSpec(name="list", type="List[Any]"),),
        outputs=(PortSpec(name="out", type="List[Any]"),),
        params=(
            Param(name="key_expr", type="expr", required=True),
            Param(name="order", type="enum", required=False, default="asc",
                  enum_values=("asc", "desc")),
        ),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        items = list(inputs.get("list") or [])
        key_expr = params["key_expr"]
        order = params.get("order", "asc")
        if order not in ("asc", "desc"):
            raise NodeBusinessError(f"sort.by order 非法: {order!r}")
        try:
            items.sort(
                key=lambda it: _eval_expr_for_item(key_expr, it, params, inputs, ctx),
                reverse=(order == "desc"),
            )
        except TypeError as e:
            raise NodeBusinessError(f"sort.by 不可比较: {e}", details={"order": order}) from e
        return NodeOutput(values={"out": items})


@register_node
class TakeN:
    spec = NodeKindSpec(
        kind="take.n",
        category="data",
        title="take.n",
        description="取列表前 n 项。",
        inputs=(PortSpec(name="list", type="List[Any]"),),
        outputs=(PortSpec(name="out", type="List[Any]"),),
        params=(Param(name="n", type="int", required=True),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        items = inputs.get("list") or []
        n = int(params["n"])
        if n < 0:
            raise NodeBusinessError(f"take.n n 必须 >= 0，得到 {n}")
        return NodeOutput(values={"out": list(items[:n])})


@register_node
class Count:
    spec = NodeKindSpec(
        kind="count",
        category="data",
        title="count",
        description="返回列表长度。",
        inputs=(PortSpec(name="list", type="List[Any]"),),
        outputs=(PortSpec(name="out", type="Int"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        items = inputs.get("list") or []
        return NodeOutput(values={"out": len(items)})


@register_node
class ListConcat:
    spec = NodeKindSpec(
        kind="list.concat",
        category="data",
        title="list.concat",
        description="拼接多个列表为一个；输入 lists 是 List[List[Any]]。",
        inputs=(PortSpec(name="lists", type="List[List[Any]]", multi=True),),
        outputs=(PortSpec(name="out", type="List[Any]"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        lists = inputs.get("lists") or []
        out: list[Any] = []
        for sub in lists:
            if sub is None:
                continue
            if not isinstance(sub, list):
                raise NodeBusinessError(
                    f"list.concat 子项必须是 list，得到 {type(sub).__name__}"
                )
            out.extend(sub)
        return NodeOutput(values={"out": out})


@register_node
class DictMerge:
    spec = NodeKindSpec(
        kind="dict.merge",
        category="data",
        title="dict.merge",
        description="合并多个 dict。strategy=replace|deep。",
        inputs=(PortSpec(name="dicts", type="List[Dict]", multi=True),),
        outputs=(PortSpec(name="out", type="Dict"),),
        params=(
            Param(name="strategy", type="enum", required=False, default="replace",
                  enum_values=("replace", "deep")),
        ),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        dicts = inputs.get("dicts") or []
        strategy = params.get("strategy", "replace")
        out: dict = {}
        for d in dicts:
            if d is None:
                continue
            if not isinstance(d, dict):
                raise NodeBusinessError(
                    f"dict.merge 子项必须是 dict，得到 {type(d).__name__}"
                )
            if strategy == "replace":
                out.update(d)
            else:
                _deep_merge(out, d)
        return NodeOutput(values={"out": out})


def _deep_merge(dst: dict, src: dict) -> None:
    for k, v in src.items():
        if k in dst and isinstance(dst[k], dict) and isinstance(v, dict):
            _deep_merge(dst[k], v)
        else:
            dst[k] = v


# ============================================================================
# P2 新增 11 个：pick.first/nth/where_one + group.by/partition.by + fold +
# take.tail + flatten + set.union/diff + dict.kvs
# ============================================================================


@register_node
class PickFirst:
    spec = NodeKindSpec(
        kind="pick.first",
        category="data",
        title="pick.first",
        description="取列表首项；空列表返回 default。",
        inputs=(PortSpec(name="list", type="List[Any]"),),
        outputs=(PortSpec(name="out", type="Any"),),
        params=(Param(name="default", type="json", required=False, default=None),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        items = inputs.get("list") or []
        if not items:
            return NodeOutput(values={"out": params.get("default")})
        return NodeOutput(values={"out": items[0]})


@register_node
class PickNth:
    spec = NodeKindSpec(
        kind="pick.nth",
        category="data",
        title="pick.nth",
        description="取列表第 n 项（0-based）。索引越界抛错。",
        inputs=(PortSpec(name="list", type="List[Any]"),),
        outputs=(PortSpec(name="out", type="Any"),),
        params=(Param(name="n", type="int", required=True),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        items = inputs.get("list") or []
        n = int(params["n"])
        if n < 0 or n >= len(items):
            raise NodeBusinessError(
                f"pick.nth 越界：n={n} len={len(items)}"
            )
        return NodeOutput(values={"out": items[n]})


@register_node
class PickWhereOne:
    spec = NodeKindSpec(
        kind="pick.where_one",
        category="data",
        title="pick.where_one",
        description="取第一个满足 expr 的项；找不到返回 null。",
        inputs=(PortSpec(name="list", type="List[Any]"),),
        outputs=(PortSpec(name="out", type="Any"),),
        params=(Param(name="expr", type="expr", required=True),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        for it in inputs.get("list") or []:
            if _eval_expr_for_item(params["expr"], it, params, inputs, ctx):
                return NodeOutput(values={"out": it})
        return NodeOutput(values={"out": None})


@register_node
class GroupBy:
    spec = NodeKindSpec(
        kind="group.by",
        category="data",
        title="group.by",
        description="按 key_expr 分组：dict[Str, List[item]]。",
        inputs=(PortSpec(name="list", type="List[Any]"),),
        outputs=(PortSpec(name="out", type="Dict[Str, List[Any]]"),),
        params=(Param(name="key_expr", type="expr", required=True),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        out: dict[str, list[Any]] = {}
        for it in inputs.get("list") or []:
            key = str(_eval_expr_for_item(params["key_expr"], it, params, inputs, ctx))
            out.setdefault(key, []).append(it)
        return NodeOutput(values={"out": out})


@register_node
class PartitionBy:
    """与 group.by 同语义；语义提示：表示『分区』而非『索引』。"""

    spec = NodeKindSpec(
        kind="partition.by",
        category="data",
        title="partition.by",
        description="按 key_expr 分区（与 group.by 语义相同，命名提示为分区）。",
        inputs=(PortSpec(name="list", type="List[Any]"),),
        outputs=(PortSpec(name="out", type="Dict[Str, List[Any]]"),),
        params=(Param(name="key_expr", type="expr", required=True),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        out: dict[str, list[Any]] = {}
        for it in inputs.get("list") or []:
            key = str(_eval_expr_for_item(params["key_expr"], it, params, inputs, ctx))
            out.setdefault(key, []).append(it)
        return NodeOutput(values={"out": out})


@register_node
class Fold:
    spec = NodeKindSpec(
        kind="fold",
        category="data",
        title="fold",
        description=(
            "累计：op_expr 在 scope {acc, item} 中求值，依次替换 acc。"
            "scope 没有 acc 时不可用，本节点把 acc 注入 inputs.acc。"
        ),
        inputs=(
            PortSpec(name="list", type="List[Any]"),
            PortSpec(name="init", type="Any"),
        ),
        outputs=(PortSpec(name="out", type="Any"),),
        params=(Param(name="op_expr", type="expr", required=True,
                       doc="形如 ${inputs.acc + item.value}；acc 通过 inputs.acc 暴露"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        acc = inputs.get("init")
        items = inputs.get("list") or []
        op = params["op_expr"]
        for it in items:
            acc = _eval_expr_for_item(op, it, params, {"acc": acc}, ctx)
        return NodeOutput(values={"out": acc})


@register_node
class TakeTail:
    spec = NodeKindSpec(
        kind="take.tail",
        category="data",
        title="take.tail",
        description="取列表最后 n 项。",
        inputs=(PortSpec(name="list", type="List[Any]"),),
        outputs=(PortSpec(name="out", type="List[Any]"),),
        params=(Param(name="n", type="int", required=True),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        items = inputs.get("list") or []
        n = int(params["n"])
        if n < 0:
            raise NodeBusinessError(f"take.tail n 必须 >= 0：{n}")
        if n == 0:
            return NodeOutput(values={"out": []})
        return NodeOutput(values={"out": list(items[-n:])})


@register_node
class Flatten:
    spec = NodeKindSpec(
        kind="flatten",
        category="data",
        title="flatten",
        description="把 list[list[X]] 展平成 list[X]（一层）。",
        inputs=(PortSpec(name="list", type="List[List[Any]]"),),
        outputs=(PortSpec(name="out", type="List[Any]"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        out: list[Any] = []
        for sub in inputs.get("list") or []:
            if sub is None:
                continue
            if not isinstance(sub, list):
                raise NodeBusinessError(
                    f"flatten 子项必须 list，得到 {type(sub).__name__}"
                )
            out.extend(sub)
        return NodeOutput(values={"out": out})


@register_node
class SetUnion:
    spec = NodeKindSpec(
        kind="set.union",
        category="data",
        title="set.union",
        description="去重并集（保持 a 中顺序，再追加 b 中新增）。",
        inputs=(
            PortSpec(name="a", type="List[Any]"),
            PortSpec(name="b", type="List[Any]"),
        ),
        outputs=(PortSpec(name="out", type="List[Any]"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        a = inputs.get("a") or []
        b = inputs.get("b") or []
        seen: set = set()
        out: list[Any] = []
        for it in a + b:
            key = _hashable(it)
            if key in seen:
                continue
            seen.add(key)
            out.append(it)
        return NodeOutput(values={"out": out})


@register_node
class SetDiff:
    spec = NodeKindSpec(
        kind="set.diff",
        category="data",
        title="set.diff",
        description="a 中保留不在 b 中的项（按可哈希语义比较）。",
        inputs=(
            PortSpec(name="a", type="List[Any]"),
            PortSpec(name="b", type="List[Any]"),
        ),
        outputs=(PortSpec(name="out", type="List[Any]"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        a = inputs.get("a") or []
        b = inputs.get("b") or []
        b_keys = {_hashable(it) for it in b}
        out = [it for it in a if _hashable(it) not in b_keys]
        return NodeOutput(values={"out": out})


@register_node
class DictKvs:
    spec = NodeKindSpec(
        kind="dict.kvs",
        category="data",
        title="dict.kvs",
        description="把 dict 拆成 (keys, values) 两列表（按 key 字典序）。",
        inputs=(PortSpec(name="d", type="Dict"),),
        outputs=(
            PortSpec(name="keys", type="List[Str]"),
            PortSpec(name="values", type="List[Any]"),
        ),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        d = inputs.get("d") or {}
        if not isinstance(d, dict):
            raise NodeBusinessError(
                f"dict.kvs d 必须是 dict，得到 {type(d).__name__}"
            )
        keys = sorted(d.keys())
        return NodeOutput(values={
            "keys": list(keys),
            "values": [d[k] for k in keys],
        })


def _hashable(value: Any):
    """把任意值映射为可 hash 比较键。dict / list 走 canonical_json。"""
    if isinstance(value, (str, int, float, bool, type(None))):
        return value
    if isinstance(value, tuple):
        return tuple(_hashable(v) for v in value)
    from tools.chronicle_sim_v3.engine.canonical import canonical_json

    return canonical_json(value)
