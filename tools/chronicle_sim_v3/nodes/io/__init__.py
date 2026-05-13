"""io 抽屉 — read.world.* / read.chronicle.* / read.config.* / read.ideas.* / write.*

P1 已注册：read.world.setting / read.world.agents / read.chronicle.events
P2 补全 22 个：
- read.world.* 剩余 6: pillars/anchors/agent/factions/locations/edges/bible_text (8 总-2 已有=6)
- read.chronicle.* 剩余 11: intents/intent/drafts/rumors/summary/observation/public_digest/beliefs/intent_outcome/weeks/month
- read.config.* 3: event_types/pacing/rumor_sim
- read.ideas.* 2: list/body
- write.* 11: world.agent/edges + chronicle.intent/draft/event/rumors/summary/observation/public_digest/belief/intent_outcome/month
"""
from __future__ import annotations

from typing import Any

from tools.chronicle_sim_v3.engine.context import Mutation
from tools.chronicle_sim_v3.engine.io import read_yaml
from tools.chronicle_sim_v3.engine.node import (
    NodeBusinessError,
    NodeKindSpec,
    NodeOutput,
    Param,
)
from tools.chronicle_sim_v3.engine.registry import register_node
from tools.chronicle_sim_v3.engine.types import PortSpec
from tools.chronicle_sim_v3.engine.keymap import is_listing_key, is_text_key


# ============================================================================
# read.world.* — P1 已有 setting / agents；P2 新增 7 个
# ============================================================================


@register_node
class ReadWorldSetting:
    spec = NodeKindSpec(
        kind="read.world.setting", category="io",
        title="读 world.setting", description="读取世界设定 JSON。",
        inputs=(), outputs=(PortSpec(name="out", type="Json"),),
        reads=frozenset({"world.setting"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.world_setting()})


@register_node
class ReadSchemaKey:
    spec = NodeKindSpec(
        kind="read.schema.key", category="io",
        title="按 schema key 读内容",
        description="按完整 schema key 读取单条记录或文本内容；要求 key 不是 listing key。",
        inputs=(PortSpec(name="key", type="Str"),),
        outputs=(PortSpec(name="out", type="Any"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        key = str(inputs.get("key", "") or "")
        if not key:
            raise NodeBusinessError("read.schema.key 需要输入 key")
        if is_listing_key(key):
            raise NodeBusinessError(f"read.schema.key 不接受 listing key: {key}")
        return NodeOutput(values={"out": ctx.read_key(key)})


@register_node
class ReadSchemaListing:
    spec = NodeKindSpec(
        kind="read.schema.listing", category="io",
        title="按 schema listing 读列表",
        description="按完整 schema listing key 列举并读取所有子项。",
        inputs=(PortSpec(name="key", type="Str"),),
        outputs=(PortSpec(name="out", type="List[Any]"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        key = str(inputs.get("key", "") or "")
        if not key:
            raise NodeBusinessError("read.schema.listing 需要输入 key")
        if not is_listing_key(key):
            raise NodeBusinessError(f"read.schema.listing 需要 listing key，得到: {key}")
        return NodeOutput(values={"out": ctx.read_listing(key)})


@register_node
class WriteSchemaJson:
    spec = NodeKindSpec(
        kind="write.schema.json", category="io",
        title="按 schema key 写 JSON",
        description="按完整 schema key 写入任意 JSON 内容；要求 key 不是 listing key。",
        inputs=(
            PortSpec(name="key", type="Str"),
            PortSpec(name="payload", type="Any"),
        ),
        outputs=(PortSpec(name="key", type="Str"),),
        version="1",
        cacheable=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        key = str(inputs.get("key", "") or "")
        if not key:
            raise NodeBusinessError("write.schema.json 需要输入 key")
        if is_listing_key(key):
            raise NodeBusinessError(f"write.schema.json 不接受 listing key: {key}")
        mut = Mutation(op="put_json", key=key, payload=inputs.get("payload"))
        return NodeOutput(values={"key": key}, mutations=[mut])


@register_node
class WriteSchemaText:
    spec = NodeKindSpec(
        kind="write.schema.text", category="io",
        title="按 schema key 写文本",
        description="按完整 schema key 写入文本内容；要求 key 不是 listing key 且目标是 text key。",
        inputs=(
            PortSpec(name="key", type="Str"),
            PortSpec(name="text", type="Str"),
        ),
        outputs=(PortSpec(name="key", type="Str"),),
        version="1",
        cacheable=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        key = str(inputs.get("key", "") or "")
        if not key:
            raise NodeBusinessError("write.schema.text 需要输入 key")
        if is_listing_key(key):
            raise NodeBusinessError(f"write.schema.text 不接受 listing key: {key}")
        if not is_text_key(key):
            raise NodeBusinessError(f"write.schema.text 需要 text key，得到: {key}")
        mut = Mutation(op="put_text", key=key, payload=str(inputs.get("text", "") or ""))
        return NodeOutput(values={"key": key}, mutations=[mut])


@register_node
class DeleteSchemaKey:
    spec = NodeKindSpec(
        kind="delete.schema.key", category="io",
        title="删除 schema key",
        description="删除完整 schema key 对应的单条内容；不接受 listing key。",
        inputs=(PortSpec(name="key", type="Str"),),
        outputs=(PortSpec(name="key", type="Str"),),
        version="1",
        cacheable=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        key = str(inputs.get("key", "") or "")
        if not key:
            raise NodeBusinessError("delete.schema.key 需要输入 key")
        if is_listing_key(key):
            raise NodeBusinessError(f"delete.schema.key 不接受 listing key: {key}")
        mut = Mutation(op="delete", key=key)
        return NodeOutput(values={"key": key}, mutations=[mut])


@register_node
class ReadWorldAgents:
    spec = NodeKindSpec(
        kind="read.world.agents", category="io",
        title="读 world.agents", description="读取所有 agent 列表。",
        inputs=(), outputs=(PortSpec(name="out", type="AgentList"),),
        reads=frozenset({"world.agents"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.world_agents()})


@register_node
class ReadWorldPillars:
    spec = NodeKindSpec(
        kind="read.world.pillars", category="io",
        title="读 world.pillars", description="读取世界『支柱』列表。",
        inputs=(), outputs=(PortSpec(name="out", type="Json"),),
        reads=frozenset({"world.pillars"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.world_pillars()})


@register_node
class ReadWorldAnchors:
    spec = NodeKindSpec(
        kind="read.world.anchors", category="io",
        title="读 world.anchors", description="读取叙事锚点列表。",
        inputs=(), outputs=(PortSpec(name="out", type="Json"),),
        reads=frozenset({"world.anchors"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.world_anchors()})


@register_node
class ReadWorldAgent:
    spec = NodeKindSpec(
        kind="read.world.agent", category="io",
        title="读单个 agent", description="按 agent_id 读取单个 agent。",
        inputs=(), outputs=(PortSpec(name="out", type="Agent"),),
        params=(Param(name="agent_id", type="str", required=True),),
        reads=frozenset({"world.agent:${params.agent_id}"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        aid = str(params["agent_id"])
        a = ctx.world_agent(aid)
        if a is None:
            raise NodeBusinessError(f"world.agent:{aid} 不存在")
        return NodeOutput(values={"out": a})


@register_node
class ReadWorldFactions:
    spec = NodeKindSpec(
        kind="read.world.factions", category="io",
        title="读 world.factions", description="读取所有势力。",
        inputs=(), outputs=(PortSpec(name="out", type="FactionList"),),
        reads=frozenset({"world.factions"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.world_factions()})


@register_node
class ReadWorldLocations:
    spec = NodeKindSpec(
        kind="read.world.locations", category="io",
        title="读 world.locations", description="读取所有地点。",
        inputs=(), outputs=(PortSpec(name="out", type="LocationList"),),
        reads=frozenset({"world.locations"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.world_locations()})


@register_node
class ReadWorldEdges:
    spec = NodeKindSpec(
        kind="read.world.edges", category="io",
        title="读 world.edges", description="读取社交关系边。",
        inputs=(), outputs=(PortSpec(name="out", type="EdgeList"),),
        reads=frozenset({"world.edges"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.world_edges()})


@register_node
class ReadWorldBibleText:
    spec = NodeKindSpec(
        kind="read.world.bible_text", category="io",
        title="读世界圣经文本", description="拼接 setting/pillars/factions/locations/anchors 为 LLM 注入文本。",
        inputs=(), outputs=(PortSpec(name="out", type="Str"),),
        reads=frozenset({
            "world.setting", "world.pillars", "world.anchors",
            "world.factions", "world.locations",
        }), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        import json

        parts: list[str] = []
        s = ctx.world_setting()
        if s:
            parts.append("# 世界设定\n" + json.dumps(s, ensure_ascii=False, indent=2))
        pillars = ctx.world_pillars()
        if pillars:
            parts.append("# 支柱\n" + json.dumps(pillars, ensure_ascii=False, indent=2))
        anchors = ctx.world_anchors()
        if anchors:
            parts.append("# 锚点\n" + json.dumps(anchors, ensure_ascii=False, indent=2))
        factions = ctx.world_factions()
        if factions:
            lines = [f"- {f.get('id')}: {f.get('name', '')} {f.get('summary', '')}" for f in factions]
            parts.append("# 势力\n" + "\n".join(lines))
        locations = ctx.world_locations()
        if locations:
            lines = [f"- {l.get('id')}: {l.get('name', '')}" for l in locations]
            parts.append("# 地点\n" + "\n".join(lines))
        return NodeOutput(values={"out": "\n\n".join(parts)})


# ============================================================================
# read.chronicle.* — P1 已有 events；P2 新增 11 个
# ============================================================================


@register_node
class ReadChronicleEvents:
    spec = NodeKindSpec(
        kind="read.chronicle.events", category="io",
        title="读 chronicle.events",
        description="读取指定周的所有事件。",
        inputs=(PortSpec(name="week", type="Week"),),
        outputs=(PortSpec(name="out", type="EventList"),),
        reads=frozenset({"chronicle.events:week=${inputs.week}"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        week = int(inputs["week"])
        return NodeOutput(values={"out": ctx.chronicle_events(week)})


@register_node
class ReadChronicleIntents:
    spec = NodeKindSpec(
        kind="read.chronicle.intents", category="io",
        title="读 chronicle.intents", description="读取指定周的所有意图。",
        inputs=(PortSpec(name="week", type="Week"),),
        outputs=(PortSpec(name="out", type="IntentList"),),
        reads=frozenset({"chronicle.intents:week=${inputs.week}"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.chronicle_intents(int(inputs["week"]))})


@register_node
class ReadChronicleIntent:
    spec = NodeKindSpec(
        kind="read.chronicle.intent", category="io",
        title="读单个 intent",
        description="按 week + agent_id 读取一个 intent。",
        inputs=(
            PortSpec(name="week", type="Week"),
            PortSpec(name="agent_id", type="AgentId"),
        ),
        outputs=(PortSpec(name="out", type="Intent"),),
        reads=frozenset({"chronicle.intent:week=${inputs.week},id=${inputs.agent_id}"}),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        v = ctx.read_key(
            f"chronicle.intent:week={int(inputs['week'])},id={inputs['agent_id']}"
        )
        if v is None:
            raise NodeBusinessError(
                f"chronicle.intent week={inputs['week']} agent={inputs['agent_id']} 不存在"
            )
        return NodeOutput(values={"out": v})


@register_node
class ReadChronicleDrafts:
    spec = NodeKindSpec(
        kind="read.chronicle.drafts", category="io",
        title="读 chronicle.drafts",
        description="读取指定周所有草稿事件。",
        inputs=(PortSpec(name="week", type="Week"),),
        outputs=(PortSpec(name="out", type="DraftList"),),
        reads=frozenset({"chronicle.drafts:week=${inputs.week}"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.chronicle_drafts(int(inputs["week"]))})


@register_node
class ReadChronicleRumors:
    spec = NodeKindSpec(
        kind="read.chronicle.rumors", category="io",
        title="读 chronicle.rumors",
        description="读取指定周谣言列表。",
        inputs=(PortSpec(name="week", type="Week"),),
        outputs=(PortSpec(name="out", type="RumorList"),),
        reads=frozenset({"chronicle.rumors:week=${inputs.week}"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.chronicle_rumors(int(inputs["week"]))})


@register_node
class ReadChronicleSummary:
    spec = NodeKindSpec(
        kind="read.chronicle.summary", category="io",
        title="读 chronicle.summary",
        description="读取指定周总结文本。",
        inputs=(PortSpec(name="week", type="Week"),),
        outputs=(PortSpec(name="out", type="Str"),),
        reads=frozenset({"chronicle.summary:week=${inputs.week}"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.chronicle_summary(int(inputs["week"]))})


@register_node
class ReadChronicleObservation:
    spec = NodeKindSpec(
        kind="read.chronicle.observation", category="io",
        title="读 chronicle.observation",
        description="读取指定周观测档。",
        inputs=(PortSpec(name="week", type="Week"),),
        outputs=(PortSpec(name="out", type="Json"),),
        reads=frozenset({"chronicle.observation:week=${inputs.week}"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.chronicle_observation(int(inputs["week"]))})


@register_node
class ReadChroniclePublicDigest:
    spec = NodeKindSpec(
        kind="read.chronicle.public_digest", category="io",
        title="读 chronicle.public_digest",
        description="读取指定周公开摘要。",
        inputs=(PortSpec(name="week", type="Week"),),
        outputs=(PortSpec(name="out", type="Json"),),
        reads=frozenset({"chronicle.public_digest:week=${inputs.week}"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.chronicle_public_digest(int(inputs["week"]))})


@register_node
class ReadChronicleBeliefs:
    spec = NodeKindSpec(
        kind="read.chronicle.beliefs", category="io",
        title="读 chronicle.beliefs",
        description="读取指定 agent 在指定周的信念列表。",
        inputs=(
            PortSpec(name="week", type="Week"),
            PortSpec(name="agent_id", type="AgentId"),
        ),
        outputs=(PortSpec(name="out", type="BeliefList"),),
        reads=frozenset({"chronicle.beliefs:week=${inputs.week},agent_id=${inputs.agent_id}"}),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={
            "out": ctx.chronicle_beliefs(int(inputs["week"]), str(inputs["agent_id"]))
        })


@register_node
class ReadChronicleIntentOutcome:
    spec = NodeKindSpec(
        kind="read.chronicle.intent_outcome", category="io",
        title="读 intent outcome",
        description="读取意图执行结果。",
        inputs=(
            PortSpec(name="week", type="Week"),
            PortSpec(name="agent_id", type="AgentId"),
        ),
        outputs=(PortSpec(name="out", type="Json"),),
        reads=frozenset({"chronicle.intent_outcome:week=${inputs.week},agent_id=${inputs.agent_id}"}),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={
            "out": ctx.chronicle_intent_outcome(int(inputs["week"]), str(inputs["agent_id"]))
        })


@register_node
class ReadChronicleWeeks:
    spec = NodeKindSpec(
        kind="read.chronicle.weeks", category="io",
        title="读已知周列表",
        description="返回 chronicle/ 下已存在的 week 编号列表。",
        inputs=(), outputs=(PortSpec(name="out", type="List[Int]"),),
        reads=frozenset({"chronicle.weeks"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.chronicle_weeks_list()})


@register_node
class ReadChronicleMonth:
    spec = NodeKindSpec(
        kind="read.chronicle.month", category="io",
        title="读 chronicle.month",
        description="读取指定月编年史文本。",
        inputs=(),
        outputs=(PortSpec(name="out", type="Str"),),
        params=(Param(name="n", type="int", required=True),),
        reads=frozenset({"chronicle.month:n=${params.n}"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        v = ctx.read_key(f"chronicle.month:n={int(params['n'])}")
        return NodeOutput(values={"out": v or ""})


# ============================================================================
# read.config.* — 3 个
# ============================================================================


def _load_v3_data_yaml(rel: str) -> Any:
    """从 v3 包内 data/ 读 yaml 配置（事件类型 / pacing / rumor_sim）。"""
    from pathlib import Path

    pkg_root = Path(__file__).resolve().parents[2]
    p = pkg_root / "data" / rel
    if not p.is_file():
        return {}
    return read_yaml(p)


@register_node
class ReadConfigEventTypes:
    spec = NodeKindSpec(
        kind="read.config.event_types", category="io",
        title="读 event_types 表",
        description="读取出厂事件类型表 data/event_types.yaml。",
        inputs=(), outputs=(PortSpec(name="out", type="EventTypeList"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        v = _load_v3_data_yaml("event_types.yaml")
        if isinstance(v, dict):
            v = v.get("event_types", []) or []
        return NodeOutput(values={"out": list(v) if isinstance(v, list) else []})


@register_node
class ReadConfigPacing:
    spec = NodeKindSpec(
        kind="read.config.pacing", category="io",
        title="读 pacing 配置",
        description="读取节奏配置（默认 default preset）。",
        inputs=(), outputs=(PortSpec(name="out", type="Pacing"),),
        params=(Param(name="preset", type="str", required=False, default="default"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        preset = str(params.get("preset", "default"))
        v = _load_v3_data_yaml(f"presets/pacing/{preset}.yaml")
        if not v:
            v = _load_v3_data_yaml("pacing.yaml") or {}
        return NodeOutput(values={"out": v})


@register_node
class ReadConfigRumorSim:
    spec = NodeKindSpec(
        kind="read.config.rumor_sim", category="io",
        title="读 rumor_sim 配置",
        description="读取谣言模拟参数。",
        inputs=(), outputs=(PortSpec(name="out", type="Json"),),
        params=(Param(name="preset", type="str", required=False, default="default"),),
        version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        preset = str(params.get("preset", "default"))
        v = _load_v3_data_yaml(f"presets/rumor_sim/{preset}.yaml")
        if not v:
            v = _load_v3_data_yaml("rumor_sim.yaml") or {}
        return NodeOutput(values={"out": v})


# ============================================================================
# read.ideas.* — 2 个
# ============================================================================


@register_node
class ReadIdeasList:
    spec = NodeKindSpec(
        kind="read.ideas.list", category="io",
        title="读 ideas.list",
        description="读取 ideas/manifest.json。",
        inputs=(), outputs=(PortSpec(name="out", type="List[Json]"),),
        reads=frozenset({"ideas.list"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.ideas_list()})


@register_node
class ReadIdeasBody:
    spec = NodeKindSpec(
        kind="read.ideas.body", category="io",
        title="读 ideas.body",
        description="按 idea_id 读取 markdown 正文。",
        inputs=(), outputs=(PortSpec(name="out", type="Str"),),
        params=(Param(name="idea_id", type="str", required=True),),
        reads=frozenset({"ideas.entry:id=${params.idea_id}"}), version="1",
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        return NodeOutput(values={"out": ctx.ideas_body(str(params["idea_id"]))})


# ============================================================================
# write.* — 11 个；cacheable=False；每个产 1 个 mutation
# ============================================================================


def _write_node(
    *, kind: str, title: str, desc: str,
    inputs: tuple[PortSpec, ...], writes_template: str,
    payload_extractor=None, op: str = "put_json",
):
    """生成 write.* 节点类（避免 11 个几乎一样的 class 重复）。"""

    class _Node:
        spec = NodeKindSpec(
            kind=kind, category="io",
            title=title, description=desc,
            inputs=inputs,
            outputs=(PortSpec(name="key", type="Str"),),
            writes=frozenset({writes_template}),
            version="1",
            cacheable=False,
        )

        async def cook(self, ctx, inputs_, params, services, cancel):
            real_key = _instantiate(writes_template, inputs_, params)
            payload = payload_extractor(inputs_) if payload_extractor else inputs_.get("payload")
            mut = Mutation(op=op, key=real_key, payload=payload)
            return NodeOutput(values={"key": real_key}, mutations=[mut])

    _Node.__name__ = "Write_" + kind.replace(".", "_")
    return _Node


def _instantiate(template: str, inputs: dict, params: dict) -> str:
    """简化：只支持 ${inputs.X} / ${inputs.X.Y} / ${params.X}。"""
    text = template
    while "${inputs." in text:
        i = text.find("${inputs.")
        j = text.find("}", i)
        if j < 0:
            break
        path = text[i + len("${inputs.") : j]
        v: Any = inputs
        for part in path.split("."):
            if isinstance(v, dict):
                v = v.get(part, "")
            else:
                v = getattr(v, part, "")
        text = text[:i] + str(v) + text[j + 1 :]
    while "${params." in text:
        i = text.find("${params.")
        j = text.find("}", i)
        if j < 0:
            break
        path = text[i + len("${params.") : j]
        v = params.get(path.split(".")[0], "")
        for part in path.split(".")[1:]:
            if isinstance(v, dict):
                v = v.get(part, "")
        text = text[:i] + str(v) + text[j + 1 :]
    return text


WriteWorldAgent = register_node(_write_node(
    kind="write.world.agent", title="写 world.agent",
    desc="按 agent.id 写入单个 agent JSON。",
    inputs=(PortSpec(name="agent", type="Agent"),),
    writes_template="world.agent:${inputs.agent.id}",
    payload_extractor=lambda i: i["agent"],
))

WriteWorldSetting = register_node(_write_node(
    kind="write.world.setting", title="写 world.setting",
    desc="覆盖写世界设定 JSON。",
    inputs=(PortSpec(name="payload", type="Json"),),
    writes_template="world.setting",
    payload_extractor=lambda i: i["payload"],
))

WriteWorldPillars = register_node(_write_node(
    kind="write.world.pillars", title="写 world.pillars",
    desc="覆盖写世界支柱列表。",
    inputs=(PortSpec(name="pillars", type="Json"),),
    writes_template="world.pillars",
    payload_extractor=lambda i: i["pillars"],
))

WriteWorldAnchors = register_node(_write_node(
    kind="write.world.anchors", title="写 world.anchors",
    desc="覆盖写叙事锚点列表。",
    inputs=(PortSpec(name="anchors", type="Json"),),
    writes_template="world.anchors",
    payload_extractor=lambda i: i["anchors"],
))

WriteWorldFaction = register_node(_write_node(
    kind="write.world.faction", title="写 world.faction",
    desc="按 faction.id 写入单个势力 JSON。",
    inputs=(PortSpec(name="faction", type="Json"),),
    writes_template="world.faction:${inputs.faction.id}",
    payload_extractor=lambda i: i["faction"],
))

WriteWorldLocation = register_node(_write_node(
    kind="write.world.location", title="写 world.location",
    desc="按 location.id 写入单个地点 JSON。",
    inputs=(PortSpec(name="location", type="Json"),),
    writes_template="world.location:${inputs.location.id}",
    payload_extractor=lambda i: i["location"],
))

WriteWorldEdges = register_node(_write_node(
    kind="write.world.edges", title="写 world.edges",
    desc="覆盖写整张社交边表。",
    inputs=(PortSpec(name="edges", type="EdgeList"),),
    writes_template="world.edges",
    payload_extractor=lambda i: i["edges"],
))

WriteChronicleIntent = register_node(_write_node(
    kind="write.chronicle.intent", title="写 chronicle.intent",
    desc="按 intent.agent_id 写一个 intent JSON。",
    inputs=(
        PortSpec(name="week", type="Week"),
        PortSpec(name="intent", type="Intent"),
    ),
    writes_template="chronicle.intent:week=${inputs.week},id=${inputs.intent.agent_id}",
    payload_extractor=lambda i: i["intent"],
))

WriteChronicleDraft = register_node(_write_node(
    kind="write.chronicle.draft", title="写 chronicle.draft",
    desc="按 draft.id 写一个草稿事件 JSON。",
    inputs=(
        PortSpec(name="week", type="Week"),
        PortSpec(name="draft", type="Draft"),
    ),
    writes_template="chronicle.draft:week=${inputs.week},id=${inputs.draft.id}",
    payload_extractor=lambda i: i["draft"],
))

WriteChronicleEvent = register_node(_write_node(
    kind="write.chronicle.event", title="写 chronicle.event",
    desc="按 event.id 写一条事件 JSON。",
    inputs=(
        PortSpec(name="week", type="Week"),
        PortSpec(name="event", type="Event"),
    ),
    writes_template="chronicle.event:week=${inputs.week},id=${inputs.event.id}",
    payload_extractor=lambda i: i["event"],
))

WriteChronicleRumors = register_node(_write_node(
    kind="write.chronicle.rumors", title="写 chronicle.rumors",
    desc="覆盖写一周的谣言列表。",
    inputs=(
        PortSpec(name="week", type="Week"),
        PortSpec(name="rumors", type="RumorList"),
    ),
    writes_template="chronicle.rumors:week=${inputs.week}",
    payload_extractor=lambda i: i["rumors"],
))

WriteChronicleSummary = register_node(_write_node(
    kind="write.chronicle.summary", title="写 chronicle.summary",
    desc="写一周总结文本（Markdown）。",
    inputs=(
        PortSpec(name="week", type="Week"),
        PortSpec(name="text", type="Str"),
    ),
    writes_template="chronicle.summary:week=${inputs.week}",
    payload_extractor=lambda i: i["text"],
    op="put_text",
))

WriteChronicleObservation = register_node(_write_node(
    kind="write.chronicle.observation", title="写 chronicle.observation",
    desc="写一周观测档 JSON。",
    inputs=(
        PortSpec(name="week", type="Week"),
        PortSpec(name="payload", type="Json"),
    ),
    writes_template="chronicle.observation:week=${inputs.week}",
    payload_extractor=lambda i: i["payload"],
))

WriteChroniclePublicDigest = register_node(_write_node(
    kind="write.chronicle.public_digest", title="写 chronicle.public_digest",
    desc="写一周公开摘要 JSON。",
    inputs=(
        PortSpec(name="week", type="Week"),
        PortSpec(name="payload", type="Json"),
    ),
    writes_template="chronicle.public_digest:week=${inputs.week}",
    payload_extractor=lambda i: i["payload"],
))

WriteChronicleBelief = register_node(_write_node(
    kind="write.chronicle.belief", title="写 chronicle.belief",
    desc="按 (week, agent_id) 写信念列表。",
    inputs=(
        PortSpec(name="week", type="Week"),
        PortSpec(name="agent_id", type="AgentId"),
        PortSpec(name="beliefs", type="BeliefList"),
    ),
    writes_template="chronicle.beliefs:week=${inputs.week},agent_id=${inputs.agent_id}",
    payload_extractor=lambda i: i["beliefs"],
))

WriteChronicleIntentOutcome = register_node(_write_node(
    kind="write.chronicle.intent_outcome", title="写 intent outcome",
    desc="按 (week, agent_id) 写意图执行结果。",
    inputs=(
        PortSpec(name="week", type="Week"),
        PortSpec(name="agent_id", type="AgentId"),
        PortSpec(name="payload", type="Json"),
    ),
    writes_template="chronicle.intent_outcome:week=${inputs.week},agent_id=${inputs.agent_id}",
    payload_extractor=lambda i: i["payload"],
))

WriteChronicleMonth = register_node(_write_node(
    kind="write.chronicle.month", title="写 chronicle.month",
    desc="按 n 写月编年史 markdown。",
    inputs=(PortSpec(name="text", type="Str"),),
    writes_template="chronicle.month:n=${params.n}",
    payload_extractor=lambda i: i["text"],
    op="put_text",
))


# 修复：write.chronicle.month 需要 n 作为 param（catalog 里 inputs 写的 n: int，
# 但 n 应当是 param 而不是 input）。这里 inputs 只有 text，n 来自 params。
# 因此重新注册带 n param 的版本。
WriteChronicleMonth.spec = NodeKindSpec(
    kind="write.chronicle.month", category="io",
    title="写 chronicle.month",
    description="按 n 写月编年史 markdown。",
    inputs=(PortSpec(name="text", type="Str"),),
    outputs=(PortSpec(name="key", type="Str"),),
    params=(Param(name="n", type="int", required=True),),
    writes=frozenset({"chronicle.month:n=${params.n}"}),
    version="1", cacheable=False,
)
