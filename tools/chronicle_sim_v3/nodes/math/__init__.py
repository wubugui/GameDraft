"""math 抽屉 — 数学算子。

P1 子集：math.compare / math.range
"""
from __future__ import annotations

from tools.chronicle_sim_v3.engine.node import (
    NodeBusinessError,
    NodeKindSpec,
    NodeOutput,
    Param,
)
from tools.chronicle_sim_v3.engine.registry import register_node
from tools.chronicle_sim_v3.engine.types import PortSpec


_OPS = {"==", "!=", "<", "<=", ">", ">="}


@register_node
class MathCompare:
    spec = NodeKindSpec(
        kind="math.compare",
        category="math",
        title="math.compare",
        description="比较 a 与 b；op = ==|!=|<|<=|>|>=",
        inputs=(
            PortSpec(name="a", type="Any"),
            PortSpec(name="b", type="Any"),
        ),
        outputs=(PortSpec(name="out", type="Bool"),),
        params=(
            Param(name="op", type="enum", required=True,
                  enum_values=tuple(sorted(_OPS))),
        ),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        op = params["op"]
        if op not in _OPS:
            raise NodeBusinessError(f"math.compare op 非法: {op!r}")
        a, b = inputs["a"], inputs["b"]
        try:
            if op == "==": r = a == b
            elif op == "!=": r = a != b
            elif op == "<": r = a < b
            elif op == "<=": r = a <= b
            elif op == ">": r = a > b
            else: r = a >= b
        except TypeError as e:
            raise NodeBusinessError(f"math.compare: {e}") from e
        return NodeOutput(values={"out": bool(r)})


@register_node
class MathRange:
    spec = NodeKindSpec(
        kind="math.range",
        category="math",
        title="math.range",
        description="生成整数序列 [start, end)，step 控制步长。",
        inputs=(),
        outputs=(PortSpec(name="out", type="List[Int]"),),
        params=(
            Param(name="start", type="int", required=True),
            Param(name="end", type="int", required=True),
            Param(name="step", type="int", required=False, default=1),
        ),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        start = int(params["start"])
        end = int(params["end"])
        step = int(params.get("step", 1))
        if step == 0:
            raise NodeBusinessError("math.range step 不能为 0")
        return NodeOutput(values={"out": list(range(start, end, step))})


@register_node
class MathEval:
    spec = NodeKindSpec(
        kind="math.eval",
        category="math",
        title="math.eval",
        description=(
            "在表达式引擎内求值；vars 通过 ${inputs.X} 暴露。"
            "expr 内仅允许 RFC §7.3 BNF 子集；不接受任意 Python。"
        ),
        inputs=(PortSpec(name="vars", type="Dict"),),
        outputs=(PortSpec(name="out", type="Any"),),
        params=(Param(name="expr", type="expr", required=True),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        from tools.chronicle_sim_v3.engine.expr import evaluate, parse

        expr = parse(params["expr"])
        scope = {
            "ctx": {},
            "nodes": {},
            "item": None,
            "params": params,
            "inputs": inputs.get("vars") or {},
        }
        return NodeOutput(values={"out": evaluate(expr, scope)})
