"""In-memory ChromaService stub。

为 chroma.* 节点提供最小可测的语义。生产环境换成真实 chromadb 接入。
基于 LLMService.embed 取向量；按 cosine 相似度排序。
"""
from __future__ import annotations

import math
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any


@dataclass
class _Doc:
    id: str
    text: str
    metadata: dict
    vector: list[float] = field(default_factory=list)


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(x * x for x in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


class InMemoryChroma:
    """内存中的简单向量存储。集合按名隔离，每集合 dict[id, _Doc]。"""

    def __init__(self) -> None:
        self._collections: dict[str, dict[str, _Doc]] = defaultdict(dict)

    async def upsert(
        self,
        collection: str,
        docs: list[dict],
        embed_fn,
    ) -> int:
        """upsert 一批 doc；embed_fn(texts) -> list[vector]。"""
        if not docs:
            return 0
        texts = [str(d.get("text", "")) for d in docs]
        vecs = await embed_fn(texts) if texts else []
        store = self._collections[collection]
        for d, v in zip(docs, vecs):
            doc_id = str(d.get("id"))
            if not doc_id:
                continue
            store[doc_id] = _Doc(
                id=doc_id,
                text=str(d.get("text", "")),
                metadata=dict(d.get("metadata") or {}),
                vector=list(v) if isinstance(v, list) else [],
            )
        return len(docs)

    async def search(
        self,
        collection: str,
        query: str,
        n_results: int,
        embed_fn,
    ) -> list[dict]:
        store = self._collections.get(collection, {})
        if not store or not query:
            return []
        qvec = (await embed_fn([query]))[0] if query else []
        scored: list[tuple[float, _Doc]] = []
        for d in store.values():
            scored.append((_cosine(qvec, d.vector), d))
        scored.sort(key=lambda kv: kv[0], reverse=True)
        out = []
        for sim, d in scored[:n_results]:
            out.append({
                "id": d.id,
                "text": d.text,
                "metadata": d.metadata,
                "score": round(sim, 6),
            })
        return out

    def clear(self, collection: str | None = None) -> None:
        if collection:
            self._collections.pop(collection, None)
        else:
            self._collections.clear()

    def count(self, collection: str) -> int:
        return len(self._collections.get(collection, {}))
