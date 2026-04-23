"""tier 抽屉 — NPC 层级管理（3 个）。

P2 简化策略（catalog 标 P3 的复杂逻辑这里给最小可用版）：
- tier.apply_pending：扫描 world.agents 找 pending_tier 字段，应用为 tier，清掉 pending_tier
- tier.archive：把 chronicle 中 agent 相关条目复制到 cold_storage（Mutation 仅写元信息条目）
- tier.restore：相反操作（占位：仅写还原标记）
"""
from __future__ import annotations

from typing import Any

from tools.chronicle_sim_v3.engine.context import Mutation
from tools.chronicle_sim_v3.engine.node import (
    NodeKindSpec,
    NodeOutput,
)
from tools.chronicle_sim_v3.engine.registry import register_node
from tools.chronicle_sim_v3.engine.types import PortSpec


@register_node
class TierApplyPending:
    spec = NodeKindSpec(
        kind="tier.apply_pending",
        category="tier",
        title="tier.apply_pending",
        description=(
            "扫描 world.agents，把 pending_tier 字段应用为 tier，"
            "并清掉 pending_tier。返回变更摘要列表。"
        ),
        inputs=(),
        outputs=(PortSpec(name="changes", type="List[Json]"),),
        reads=frozenset({"world.agents"}),
        writes=frozenset({"world.agent:*"}),
        version="1",
        cacheable=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        agents = ctx.world_agents()
        changes: list[dict] = []
        muts: list[Mutation] = []
        for a in agents:
            pending = a.get("pending_tier")
            if not pending:
                continue
            old = a.get("tier", "C")
            new_a = dict(a)
            new_a["tier"] = pending
            new_a.pop("pending_tier", None)
            muts.append(Mutation(op="put_json", key=f"world.agent:{a.get('id')}", payload=new_a))
            changes.append({"agent_id": a.get("id"), "from": old, "to": pending})
        return NodeOutput(values={"changes": changes}, mutations=muts)


@register_node
class TierArchive:
    spec = NodeKindSpec(
        kind="tier.archive",
        category="tier",
        title="tier.archive",
        description=(
            "把 agent 标为 cold_storage（占位最小实现：只写 world.agent 上的 archived=True 标记）。"
        ),
        inputs=(PortSpec(name="agent_id", type="AgentId"),),
        outputs=(),
        reads=frozenset({"world.agent:${inputs.agent_id}"}),
        writes=frozenset({"world.agent:${inputs.agent_id}"}),
        version="1",
        cacheable=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        aid = str(inputs.get("agent_id", ""))
        if not aid:
            return NodeOutput()
        a = ctx.world_agent(aid) or {"id": aid}
        new_a = dict(a)
        new_a["archived"] = True
        return NodeOutput(mutations=[Mutation(op="put_json", key=f"world.agent:{aid}", payload=new_a)])


@register_node
class TierRestore:
    spec = NodeKindSpec(
        kind="tier.restore",
        category="tier",
        title="tier.restore",
        description="还原 archive：清掉 world.agent 上的 archived 标记。",
        inputs=(PortSpec(name="agent_id", type="AgentId"),),
        outputs=(),
        reads=frozenset({"world.agent:${inputs.agent_id}"}),
        writes=frozenset({"world.agent:${inputs.agent_id}"}),
        version="1",
        cacheable=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        aid = str(inputs.get("agent_id", ""))
        if not aid:
            return NodeOutput()
        a = ctx.world_agent(aid)
        if a is None:
            return NodeOutput()
        new_a = dict(a)
        new_a.pop("archived", None)
        return NodeOutput(mutations=[Mutation(op="put_json", key=f"world.agent:{aid}", payload=new_a)])
