"""flow 抽屉 — 完整实装。

关键依赖：services 必须有 _engine_ref（由 Engine 在 NodeServices 上注入），
flow 节点用它构造 SubgraphRunner。Engine 在 _run_one_node 给 NodeServices
设置 _engine_ref（见 P2 修订）。

P1+P2 总计 9 个：
- flow.foreach
- flow.foreach_with_state（P2 新增）
- flow.fanout_per_agent
- flow.parallel
- flow.when
- flow.switch（P2 新增）
- flow.merge
- flow.subgraph
- flow.barrier（P2 新增）
"""
from __future__ import annotations

from typing import Any

from tools.chronicle_sim_v3.engine.expr import SubgraphRef
from tools.chronicle_sim_v3.engine.node import (
    NodeBusinessError,
    NodeKindSpec,
    NodeOutput,
    Param,
)
from tools.chronicle_sim_v3.engine.registry import register_node
from tools.chronicle_sim_v3.engine.types import PortSpec


def _engine_ref(services) -> Any:
    eng = getattr(services, "_engine_ref", None)
    if eng is None:
        raise NodeBusinessError(
            "flow.* 节点需要 services._engine_ref；请确保通过 Engine 调用，而非裸 NodeServices"
        )
    return eng


def _resolve_subgraph(services, params_body: Any, *, name: str = "body"):
    from tools.chronicle_sim_v3.engine.subgraph import SubgraphLoader

    if isinstance(params_body, SubgraphRef):
        ref = params_body
    elif isinstance(params_body, str):
        ref = SubgraphRef(name=params_body)
    elif isinstance(params_body, dict) and "ref" in params_body:
        ref = SubgraphRef(name=str(params_body["ref"]))
    else:
        raise NodeBusinessError(
            f"flow.* 的 {name} 必须是 SubgraphRef / 子图名 / {{ref: name}}，"
            f"得到 {type(params_body).__name__}"
        )
    loader = SubgraphLoader(services.spec_search_root)
    return loader.load(ref)


@register_node
class FlowMerge:
    spec = NodeKindSpec(
        kind="flow.merge",
        category="flow",
        title="flow.merge",
        description="多入合并为列表（multi 输入端口）。",
        inputs=(PortSpec(name="inputs", type="List[Any]", multi=True),),
        outputs=(PortSpec(name="out", type="List[Any]"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        v = inputs.get("inputs")
        if v is None:
            return NodeOutput(values={"out": []})
        if not isinstance(v, list):
            raise NodeBusinessError(
                f"flow.merge inputs 应为 list，得到 {type(v).__name__}"
            )
        return NodeOutput(values={"out": list(v)})


@register_node
class FlowForeach:
    spec = NodeKindSpec(
        kind="flow.foreach",
        category="flow",
        title="flow.foreach",
        description="对 over 每项跑一次 body 子图，收集 outputs 为列表。",
        inputs=(PortSpec(name="over", type="List[Any]"),),
        outputs=(PortSpec(name="collected", type="List[Any]"),),
        params=(
            Param(name="body", type="subgraph_ref", required=True),
            Param(name="body_inputs", type="json", required=False, default={}),
        ),
        version="1",
        cacheable=True,
        # 子图可能含 agent.cline / random.* 等非确定节点；
        # 引擎默认不命中，需要节点 params 显式 cache 才开（待 P5 加 cache 字段）
        deterministic=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        from tools.chronicle_sim_v3.engine.subgraph import SubgraphRunner

        eng = _engine_ref(services)
        sub_spec = _resolve_subgraph(services, params["body"])
        body_inputs = params.get("body_inputs", {}) or {}
        runner = SubgraphRunner(eng)
        collected = []
        for item in (inputs.get("over") or []):
            r = await runner.run(sub_spec, body_inputs, cancel=cancel, item=item)
            collected.append(r)
        return NodeOutput(values={"collected": collected})


@register_node
class FlowForeachWithState:
    spec = NodeKindSpec(
        kind="flow.foreach_with_state",
        category="flow",
        title="flow.foreach_with_state",
        description=(
            "带累积状态的 foreach：每次迭代 body 收 ${item} 与 ${inputs.state}，"
            "返回 dict 必含 'state' 字段以更新累积。"
        ),
        inputs=(
            PortSpec(name="over", type="List[Any]"),
            PortSpec(name="init_state", type="Any"),
        ),
        outputs=(
            PortSpec(name="final_state", type="Any"),
            PortSpec(name="collected", type="List[Any]"),
        ),
        params=(Param(name="body", type="subgraph_ref", required=True),),
        version="1",
        cacheable=True,
        deterministic=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        from tools.chronicle_sim_v3.engine.subgraph import SubgraphRunner

        eng = _engine_ref(services)
        sub_spec = _resolve_subgraph(services, params["body"])
        runner = SubgraphRunner(eng)
        state = inputs.get("init_state")
        collected = []
        for item in (inputs.get("over") or []):
            r = await runner.run(
                sub_spec, {"state": state}, cancel=cancel, item=item,
            )
            if isinstance(r, dict) and "state" in r:
                state = r["state"]
            collected.append(r)
        return NodeOutput(values={"final_state": state, "collected": collected})


@register_node
class FlowFanoutPerAgent:
    spec = NodeKindSpec(
        kind="flow.fanout_per_agent",
        category="flow",
        title="flow.fanout_per_agent",
        description="foreach 的 agent 专用便利节点；item 是 agent dict。",
        inputs=(PortSpec(name="over", type="AgentList"),),
        outputs=(PortSpec(name="collected", type="List[Any]"),),
        params=(
            Param(name="body", type="subgraph_ref", required=True),
            Param(name="body_inputs", type="json", required=False, default={}),
        ),
        version="1",
        cacheable=True,
        deterministic=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        from tools.chronicle_sim_v3.engine.subgraph import SubgraphRunner

        eng = _engine_ref(services)
        sub_spec = _resolve_subgraph(services, params["body"])
        body_inputs = params.get("body_inputs", {}) or {}
        runner = SubgraphRunner(eng)
        collected = []
        for agent in (inputs.get("over") or []):
            r = await runner.run(sub_spec, body_inputs, cancel=cancel, item=agent)
            collected.append(r)
        return NodeOutput(values={"collected": collected})


@register_node
class FlowParallel:
    spec = NodeKindSpec(
        kind="flow.parallel",
        category="flow",
        title="flow.parallel",
        description=(
            "children 列表中的每个 SubgraphRef 串行跑一次（v3 单线程，不真正并发）；"
            "outputs 是 dict[label, sub_result]。"
        ),
        inputs=(),
        outputs=(PortSpec(name="outputs", type="Json"),),
        params=(Param(name="children", type="json", required=True,
                       doc="dict[label, SubgraphRef] 或 list[{name, ref}]"),),
        version="1",
        cacheable=True,
        deterministic=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        from tools.chronicle_sim_v3.engine.subgraph import SubgraphRunner

        eng = _engine_ref(services)
        runner = SubgraphRunner(eng)
        children = params["children"]
        out: dict[str, Any] = {}
        if isinstance(children, dict):
            items = list(children.items())
        elif isinstance(children, list):
            items = []
            for i, c in enumerate(children):
                if isinstance(c, dict):
                    items.append((str(c.get("name", i)), c.get("ref")))
                else:
                    items.append((str(i), c))
        else:
            raise NodeBusinessError("flow.parallel children 必须是 dict 或 list")
        for label, body in items:
            sub_spec = _resolve_subgraph(services, body, name=f"children[{label}]")
            r = await runner.run(sub_spec, {}, cancel=cancel)
            out[label] = r
        return NodeOutput(values={"outputs": out})


@register_node
class FlowWhen:
    spec = NodeKindSpec(
        kind="flow.when",
        category="flow",
        title="flow.when",
        description=(
            "condition 为真才跑 body 子图；condition 为假返回 out=null, triggered=false。"
            "节点级跳过另见 NodeRef.when 字段。"
        ),
        inputs=(PortSpec(name="condition", type="Bool"),),
        outputs=(
            PortSpec(name="out", type="Optional[Json]"),
            PortSpec(name="triggered", type="Bool"),
        ),
        params=(Param(name="body", type="subgraph_ref", required=True),),
        version="1",
        cacheable=True,
        deterministic=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        from tools.chronicle_sim_v3.engine.subgraph import SubgraphRunner

        cond = bool(inputs.get("condition", False))
        if not cond:
            return NodeOutput(values={"out": None, "triggered": False})
        eng = _engine_ref(services)
        sub_spec = _resolve_subgraph(services, params["body"])
        r = await SubgraphRunner(eng).run(sub_spec, {}, cancel=cancel)
        return NodeOutput(values={"out": r, "triggered": True})


@register_node
class FlowSwitch:
    spec = NodeKindSpec(
        kind="flow.switch",
        category="flow",
        title="flow.switch",
        description=(
            "按 selector 选 cases[selector]（SubgraphRef）跑；"
            "未命中走 cases['_default']（如有），否则返回 null。"
        ),
        inputs=(PortSpec(name="selector", type="Any"),),
        outputs=(PortSpec(name="out", type="Any"),),
        params=(Param(name="cases", type="json", required=True,
                       doc="dict[label, SubgraphRef]; 可含 _default 兜底"),),
        version="1",
        cacheable=True,
        deterministic=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        from tools.chronicle_sim_v3.engine.subgraph import SubgraphRunner

        eng = _engine_ref(services)
        cases = params["cases"]
        if not isinstance(cases, dict):
            raise NodeBusinessError("flow.switch cases 必须是 dict")
        sel = inputs.get("selector")
        body = cases.get(str(sel), cases.get("_default"))
        if body is None:
            return NodeOutput(values={"out": None})
        sub_spec = _resolve_subgraph(services, body, name="case")
        r = await SubgraphRunner(eng).run(sub_spec, {"selector": sel}, cancel=cancel)
        return NodeOutput(values={"out": r})


@register_node
class FlowSubgraph:
    spec = NodeKindSpec(
        kind="flow.subgraph",
        category="flow",
        title="flow.subgraph",
        description="引用并跑另一个 graph 文件，子图 outputs 透传为本节点的 'out'。",
        inputs=(),
        outputs=(PortSpec(name="out", type="Any"),),
        params=(
            Param(name="ref", type="subgraph_ref", required=True),
            Param(name="inputs", type="json", required=False, default={}),
        ),
        version="1",
        cacheable=True,
        deterministic=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        from tools.chronicle_sim_v3.engine.subgraph import SubgraphRunner

        eng = _engine_ref(services)
        sub_spec = _resolve_subgraph(services, params["ref"], name="ref")
        sub_inputs = params.get("inputs", {}) or {}
        r = await SubgraphRunner(eng).run(sub_spec, sub_inputs, cancel=cancel)
        return NodeOutput(values={"out": r})


@register_node
class FlowBarrier:
    spec = NodeKindSpec(
        kind="flow.barrier",
        category="flow",
        title="flow.barrier",
        description="等齐 children 子图全部完成（无数据传递）；用于 cook 内部同步。",
        inputs=(),
        outputs=(PortSpec(name="done", type="Trigger"),),
        params=(Param(name="children", type="json", required=True,
                       doc="list[SubgraphRef]"),),
        version="1",
        cacheable=True,
        deterministic=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        from tools.chronicle_sim_v3.engine.subgraph import SubgraphRunner

        eng = _engine_ref(services)
        runner = SubgraphRunner(eng)
        children = params["children"]
        if not isinstance(children, list):
            raise NodeBusinessError("flow.barrier children 必须是 list")
        for c in children:
            sub_spec = _resolve_subgraph(services, c, name="child")
            await runner.run(sub_spec, {}, cancel=cancel)
        return NodeOutput(values={"done": True})
