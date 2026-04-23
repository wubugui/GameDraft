"""chroma 抽屉 — 向量检索（4 个）。

依赖：services.chroma 必须是 InMemoryChroma 或同接口实例；services._llm（内部 LLM）
必须可用以做嵌入。chroma.* 是基础设施节点，按设计允许访问 services._llm 的
embed 通道（业务玩法节点仍只能走 services.agents）。
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


def _ensure_services(services, *, need_llm: bool = True):
    if services.chroma is None:
        raise NodeBusinessError("chroma.* 节点需要 services.chroma；请注入 InMemoryChroma 或等价实现")
    if need_llm and services._llm is None:
        raise NodeBusinessError("chroma.* 节点需要 services._llm 做嵌入（embed）")


def _embed_fn(services):
    """返回 async (texts) -> list[vector]，调用 LLMService.embed。

    chroma.* 节点是基础设施层，按 RFC 允许走 services._llm.embed
    （业务玩法节点应只调 services.agents）。
    """
    async def _fn(texts):
        return await services._llm.embed("embed", texts)

    return _fn


@register_node
class ChromaUpsert:
    spec = NodeKindSpec(
        kind="chroma.upsert",
        category="chroma",
        title="chroma.upsert",
        description=(
            "upsert docs 到指定 collection；docs 每项 {id, text, metadata?}。"
            "嵌入走 LLMService.embed('embed', texts)。"
        ),
        inputs=(PortSpec(name="docs", type="List[Json]"),),
        outputs=(PortSpec(name="count", type="Int"),),
        params=(Param(name="collection", type="str", required=True),),
        version="1",
        cacheable=False,  # upsert 是副作用，不缓存
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        _ensure_services(services)
        col = str(params["collection"])
        docs = inputs.get("docs") or []
        n = await services.chroma.upsert(col, docs, _embed_fn(services))
        return NodeOutput(values={"count": n})


@register_node
class ChromaSearch:
    spec = NodeKindSpec(
        kind="chroma.search",
        category="chroma",
        title="chroma.search",
        description="按 query 在 collection 中检索 top-n_results 条。",
        inputs=(PortSpec(name="query", type="Str"),),
        outputs=(PortSpec(name="out", type="List[Json]"),),
        params=(
            Param(name="collection", type="str", required=True),
            Param(name="n_results", type="int", required=False, default=5),
        ),
        version="1",
        cacheable=True,
        deterministic=True,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        _ensure_services(services)
        col = str(params["collection"])
        q = str(inputs.get("query", ""))
        n = int(params.get("n_results", 5))
        out = await services.chroma.search(col, q, n, _embed_fn(services))
        return NodeOutput(values={"out": out})


@register_node
class ChromaRebuildWorld:
    spec = NodeKindSpec(
        kind="chroma.rebuild_world",
        category="chroma",
        title="chroma.rebuild_world",
        description=(
            "全量重建 world 集合：从 ctx.world_agents/factions/locations 拼 doc 灌入 'world' 集合。"
        ),
        inputs=(),
        outputs=(PortSpec(name="count", type="Int"),),
        reads=frozenset({"world.agents", "world.factions", "world.locations"}),
        version="1",
        cacheable=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        _ensure_services(services)
        services.chroma.clear("world")
        docs: list[dict] = []
        for a in ctx.world_agents():
            docs.append({
                "id": f"agent:{a.get('id')}",
                "text": " ".join(filter(None, [
                    str(a.get("name") or ""),
                    str(a.get("summary") or ""),
                    str(a.get("background") or ""),
                ])),
                "metadata": {"kind": "agent", "id": a.get("id")},
            })
        for f in ctx.world_factions():
            docs.append({
                "id": f"faction:{f.get('id')}",
                "text": " ".join(filter(None, [
                    str(f.get("name") or ""),
                    str(f.get("summary") or ""),
                ])),
                "metadata": {"kind": "faction", "id": f.get("id")},
            })
        for l in ctx.world_locations():
            docs.append({
                "id": f"location:{l.get('id')}",
                "text": " ".join(filter(None, [
                    str(l.get("name") or ""),
                    str(l.get("description") or ""),
                ])),
                "metadata": {"kind": "location", "id": l.get("id")},
            })
        n = await services.chroma.upsert("world", docs, _embed_fn(services))
        return NodeOutput(values={"count": n})


@register_node
class ChromaRebuildIdeas:
    spec = NodeKindSpec(
        kind="chroma.rebuild_ideas",
        category="chroma",
        title="chroma.rebuild_ideas",
        description="全量重建 ideas 集合：以 ctx.ideas_list + ideas_body 灌入。",
        inputs=(),
        outputs=(PortSpec(name="count", type="Int"),),
        reads=frozenset({"ideas.list"}),
        version="1",
        cacheable=False,
    )

    async def cook(self, ctx, inputs, params, services, cancel):
        _ensure_services(services)
        services.chroma.clear("ideas")
        docs: list[dict] = []
        for entry in ctx.ideas_list():
            iid = str(entry.get("id", ""))
            if not iid:
                continue
            body = ctx.ideas_body(iid)
            docs.append({
                "id": f"idea:{iid}",
                "text": (str(entry.get("title") or "") + "\n" + (body or "")).strip(),
                "metadata": {"kind": "idea", "id": iid},
            })
        n = await services.chroma.upsert("ideas", docs, _embed_fn(services))
        return NodeOutput(values={"count": n})
