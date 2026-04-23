"""agent 抽屉 — agent.run 主节点 + agent.cline alias。

三层架构后业务节点只见 services.agents（AgentService）；
- agent.run：统一新接口，params.agent 是 agents.yaml routes 中的逻辑名
- agent.cline：保留 alias 兼容 P3 已有 graph yaml；内部强制 agent=cline_default

不直接 import agents.service / runners 以满足 layering 规则；
仅 import agents.types / agents.errors（轻量数据类）。
"""
from __future__ import annotations

from tools.chronicle_sim_v3.agents.errors import AgentError
from tools.chronicle_sim_v3.agents.types import AgentRef, AgentTask
from tools.chronicle_sim_v3.engine.node import (
    NodeBusinessError,
    NodeKindSpec,
    NodeOutput,
    Param,
)
from tools.chronicle_sim_v3.engine.registry import register_node
from tools.chronicle_sim_v3.engine.types import PortSpec


def _legacy_cline_params_to_agent_run(params: dict) -> dict:
    """兼容旧 agent.cline 节点 params → 新统一格式。

    旧格式（v3 P3 已写）：
        agent_spec: <toml>
        llm: { role, model, output: {kind, artifact_filename, json_schema}, cache? }
        system_extra: ""
    新格式（agent.run）：
        agent: <logical id>
        spec:  <toml>
        output: { kind, artifact_filename }
        cache:  off|hash|exact|auto
        role:   <str>
        system_extra: <str>
    """
    spec = params.get("spec") or params.get("agent_spec") or ""
    out_block = dict(params.get("output") or {})
    role = params.get("role") or "agent"
    cache = params.get("cache") or "auto"
    system_extra = str(params.get("system_extra", "") or "")
    legacy_llm = params.get("llm") or {}
    if isinstance(legacy_llm, dict) and legacy_llm:
        if "output" in legacy_llm and not out_block:
            out_block = dict(legacy_llm.get("output") or {})
        if not params.get("role"):
            role = legacy_llm.get("role", role)
        if not params.get("cache"):
            cache = legacy_llm.get("cache", cache)
    if "kind" not in out_block:
        out_block["kind"] = "text"
    return {
        "agent": params.get("agent") or "",
        "spec": str(spec),
        "output": out_block,
        "cache": str(cache),
        "role": str(role),
        "system_extra": system_extra,
    }


async def _run_agent(
    agent_logical: str,
    norm_params: dict,
    inputs: dict,
    services,
) -> NodeOutput:
    if services.agents is None:
        raise NodeBusinessError(
            "agent.* 需要 services.agents；请确保 EngineServices 注入了 AgentService"
        )
    if not agent_logical:
        raise NodeBusinessError("agent.run / agent.cline 需要 params.agent")
    spec_ref = norm_params["spec"]
    if not spec_ref:
        raise NodeBusinessError("agent.run / agent.cline 需要 params.spec")
    out_block = dict(norm_params.get("output") or {})
    output_kind = str(out_block.get("kind", "text"))
    artifact_filename = str(out_block.get("artifact_filename", "") or "")

    ref = AgentRef(
        agent=agent_logical,
        role=str(norm_params.get("role", "agent")),
        output_kind=output_kind,
        artifact_filename=artifact_filename,
        cache=str(norm_params.get("cache", "auto")),
    )
    task = AgentTask(
        spec_ref=spec_ref,
        vars=dict(inputs.get("vars") or {}),
        system_extra=str(norm_params.get("system_extra", "") or ""),
    )
    try:
        result = await services.agents.run(ref, task)
    except AgentError as e:
        raise NodeBusinessError(
            f"agent {agent_logical!r} 执行失败: {e}",
            details={"agent": agent_logical, "error_type": type(e).__name__},
        ) from e
    return NodeOutput(values={
        "text": result.text,
        "parsed": result.parsed,
        "tool_log": result.tool_log,
    })


@register_node
class AgentRunNode:
    spec = NodeKindSpec(
        kind="agent.run",
        category="agent",
        title="Agent 通用调用",
        description=(
            "通过 AgentService 调度任意 runner（cline/simple_chat/react/external）；"
            "agents.yaml 决定路由"
        ),
        inputs=(
            PortSpec(name="vars", type="Json", required=True,
                     doc="prompt 模板变量 + ReAct read_key 数据源"),
        ),
        outputs=(
            PortSpec(name="text", type="Str"),
            PortSpec(name="parsed", type="Json"),
            PortSpec(name="tool_log", type="Json"),
        ),
        params=(
            Param(name="agent", type="str", required=True,
                  doc="agents.yaml routes 中的逻辑名（如 director / npc）"),
            Param(name="spec", type="str", required=True,
                  doc="agent_spec TOML 路径；'_inline' 用 vars.__system/__user"),
            Param(name="output", type="json", required=False,
                  doc='{"kind":"text|json_object|json_array|jsonl","artifact_filename":""}'),
            Param(name="cache", type="str", required=False, default="auto"),
            Param(name="role", type="str", required=False, default="agent"),
            Param(name="system_extra", type="str", required=False, default=""),
        ),
        version="1",
        cacheable=True,
        deterministic=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        agent_logical = str(params.get("agent", "") or "")
        norm = {
            "agent": agent_logical,
            "spec": str(params.get("spec", "") or ""),
            "output": dict(params.get("output") or {}),
            "cache": str(params.get("cache", "auto")),
            "role": str(params.get("role", "agent")),
            "system_extra": str(params.get("system_extra", "") or ""),
        }
        return await _run_agent(agent_logical, norm, inputs, services)


@register_node
class AgentClineAliasNode:
    """agent.cline alias 节点 — 兼容 P3 graph yaml。

    内部固定走 `agent: cline_default`（agents.yaml routes 中必须存在）；
    支持旧 params（agent_spec / llm.{role,model,output,cache}）。
    """

    spec = NodeKindSpec(
        kind="agent.cline",
        category="agent",
        title="Agent (Cline alias)",
        description=(
            "兼容旧 graph 的 alias 节点：内部转 AgentService.run(agent='cline_default')；"
            "新代码请直接用 agent.run"
        ),
        inputs=(
            PortSpec(name="vars", type="Json", required=True,
                     doc="prompt 模板变量"),
        ),
        outputs=(
            PortSpec(name="text", type="Str"),
            PortSpec(name="parsed", type="Json"),
            PortSpec(name="tool_log", type="Json"),
        ),
        params=(
            Param(name="agent", type="str", required=False, default="cline_default",
                  doc="逻辑 agent；默认 cline_default"),
            Param(name="agent_spec", type="str", required=False, default="",
                  doc="兼容旧字段；与 spec 等价"),
            Param(name="spec", type="str", required=False, default="",
                  doc="agent_spec TOML 路径；推荐用 spec 字段"),
            Param(name="llm", type="json", required=False,
                  doc="兼容旧字段：{role, model(忽略), output, cache?}"),
            Param(name="output", type="json", required=False,
                  doc='新统一字段；优先级高于 params.llm.output'),
            Param(name="cache", type="str", required=False, default="auto"),
            Param(name="role", type="str", required=False, default="agent"),
            Param(name="system_extra", type="str", required=False, default=""),
        ),
        version="1",
        cacheable=True,
        deterministic=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        agent_logical = str(params.get("agent") or "cline_default")
        norm = _legacy_cline_params_to_agent_run(dict(params))
        return await _run_agent(agent_logical, norm, inputs, services)
