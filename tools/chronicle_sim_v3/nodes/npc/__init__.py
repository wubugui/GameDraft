"""npc 抽屉 — 角色域算子。

P1 子集：npc.filter_active / npc.partition_by_tier
"""
from __future__ import annotations

from tools.chronicle_sim_v3.engine.node import (
    NodeKindSpec,
    NodeOutput,
    Param,
)
from tools.chronicle_sim_v3.engine.registry import register_node
from tools.chronicle_sim_v3.engine.types import PortSpec


@register_node
class NpcFilterActive:
    spec = NodeKindSpec(
        kind="npc.filter_active",
        category="npc",
        title="过滤活跃 NPC",
        description="保留 life_status == 'alive' 的角色（缺字段视为 alive）。",
        inputs=(PortSpec(name="agents", type="AgentList"),),
        outputs=(PortSpec(name="out", type="AgentList"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        agents = inputs.get("agents") or []
        out = [a for a in agents if (a.get("life_status", "alive") == "alive")]
        return NodeOutput(values={"out": out})


@register_node
class NpcPartitionByTier:
    spec = NodeKindSpec(
        kind="npc.partition_by_tier",
        category="npc",
        title="按 tier 分组",
        description="按 agent.tier 字段分到 S/A/B/C 四组（缺值进 C）。",
        inputs=(PortSpec(name="agents", type="AgentList"),),
        outputs=(
            PortSpec(name="S", type="AgentList"),
            PortSpec(name="A", type="AgentList"),
            PortSpec(name="B", type="AgentList"),
            PortSpec(name="C", type="AgentList"),
        ),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        agents = inputs.get("agents") or []
        groups = {"S": [], "A": [], "B": [], "C": []}
        for a in agents:
            tier = str(a.get("tier", "C")).upper()
            if tier not in groups:
                tier = "C"
            groups[tier].append(a)
        return NodeOutput(values=groups)


# ============================================================================
# P2 新增：npc.location_resolve / npc.context_compose
# ============================================================================


@register_node
class NpcLocationResolve:
    spec = NodeKindSpec(
        kind="npc.location_resolve",
        category="npc",
        title="解析 NPC 当前位置",
        description=(
            "把 agent 的 current_location / location_hint 对齐到 locations 表中的 loc_id。"
            "优先精确匹配 id；其次匹配 name 子串；都失败返回空串。"
        ),
        inputs=(
            PortSpec(name="agent", type="Agent"),
            PortSpec(name="locations", type="LocationList"),
        ),
        outputs=(PortSpec(name="loc_id", type="LocationId"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        agent = inputs.get("agent") or {}
        locations = inputs.get("locations") or []
        candidates = [
            str(agent.get("current_location", "") or ""),
            str(agent.get("location_hint", "") or ""),
            str(agent.get("location", "") or ""),
        ]
        loc_ids = {str(l.get("id", "")) for l in locations if l.get("id")}
        # 1) id 精确
        for c in candidates:
            if c in loc_ids:
                return NodeOutput(values={"loc_id": c})
        # 2) name 子串
        for c in candidates:
            if not c:
                continue
            for l in locations:
                name = str(l.get("name", ""))
                if name and (c in name or name in c):
                    return NodeOutput(values={"loc_id": str(l.get("id", ""))})
        return NodeOutput(values={"loc_id": ""})


@register_node
class NpcContextCompose:
    spec = NodeKindSpec(
        kind="npc.context_compose",
        category="npc",
        title="拼接 NPC 上下文",
        description=(
            "把多段标题→内容拼成统一注入文本。format=headed (## 标题) 或 xml (<title>)。"
        ),
        inputs=(PortSpec(name="parts", type="Dict"),),
        outputs=(PortSpec(name="out", type="Str"),),
        params=(
            Param(name="format", type="enum", required=False, default="headed",
                  enum_values=("headed", "xml")),
        ),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        import json as _json

        parts = inputs.get("parts") or {}
        if not isinstance(parts, dict):
            return NodeOutput(values={"out": ""})
        fmt = params.get("format", "headed")
        out_lines: list[str] = []
        for title in sorted(parts.keys()):
            value = parts[title]
            body = value if isinstance(value, str) else _json.dumps(value, ensure_ascii=False, indent=2)
            if fmt == "xml":
                tag = title.replace(" ", "_")
                out_lines.append(f"<{tag}>\n{body}\n</{tag}>")
            else:
                out_lines.append(f"## {title}\n{body}")
        return NodeOutput(values={"out": "\n\n".join(out_lines)})
