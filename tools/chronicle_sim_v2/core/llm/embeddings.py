from __future__ import annotations

from typing import Any, Protocol

import httpx


class EmbeddingBackend(Protocol):
    async def embed(self, texts: list[str]) -> list[list[float]]: ...

    async def aclose(self) -> None: ...


class _HttpCloseMixin:
    _client: httpx.AsyncClient

    async def aclose(self) -> None:
        await self._client.aclose()


class OllamaEmbeddingBackend(_HttpCloseMixin):
    """Ollama：/api/embed 优先；支持 input 为字符串数组时批量一次请求。"""

    def __init__(self, host: str, model: str, *, client_kwargs: dict[str, Any] | None = None) -> None:
        self._host = host.rstrip("/")
        self._model = model
        opts: dict[str, Any] = {
            "timeout": httpx.Timeout(connect=30.0, read=300.0, write=300.0, pool=30.0),
            "trust_env": False,
        }
        if client_kwargs:
            opts.update(client_kwargs)
        opts["trust_env"] = False
        self._client = httpx.AsyncClient(**opts)

    async def _embed_one(self, text: str) -> list[float]:
        attempts: list[tuple[str, dict[str, Any]]] = [
            (f"{self._host}/api/embed", {"model": self._model, "input": text}),
            (f"{self._host}/api/embeddings", {"model": self._model, "prompt": text}),
        ]
        last_detail = ""
        for url, body in attempts:
            r = await self._client.post(url, json=body)
            if r.status_code != 200:
                last_detail = f"{url} -> {r.status_code} {r.text[:200]}"
                continue
            data: dict[str, Any] = r.json()
            embs = data.get("embeddings")
            if isinstance(embs, list) and embs and isinstance(embs[0], list):
                return [float(x) for x in embs[0]]
            emb = data.get("embedding")
            if isinstance(emb, list):
                return [float(x) for x in emb]
            last_detail = f"{url} -> 无法解析字段 embeddings/embedding"
        raise RuntimeError(f"Ollama 嵌入失败: {last_detail}")

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        if len(texts) == 1:
            return [await self._embed_one(texts[0])]
        r = await self._client.post(
            f"{self._host}/api/embed",
            json={"model": self._model, "input": texts},
        )
        if r.status_code == 200:
            data = r.json()
            embs = data.get("embeddings")
            if isinstance(embs, list) and len(embs) == len(texts):
                out: list[list[float]] = []
                for row in embs:
                    if not isinstance(row, list):
                        break
                    out.append([float(x) for x in row])
                if len(out) == len(texts):
                    return out
        return [await self._embed_one(t) for t in texts]


class OpenAICompatEmbeddingBackend(_HttpCloseMixin):
    """OpenAI 兼容 POST {base_url}/embeddings（base_url 与 chat 共用，通常含 /v1）。"""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        *,
        client_kwargs: dict[str, Any] | None = None,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._model = model
        opts: dict[str, Any] = {
            "timeout": httpx.Timeout(connect=30.0, read=300.0, write=300.0, pool=30.0),
            "trust_env": False,
        }
        if client_kwargs:
            opts.update(client_kwargs)
        opts["trust_env"] = False
        self._client = httpx.AsyncClient(**opts)
        _k = (api_key or "").strip()
        self._headers = {"Authorization": f"Bearer {_k}"} if _k else {}

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        r = await self._client.post(
            f"{self._base}/embeddings",
            headers=self._headers,
            json={"model": self._model, "input": texts},
        )
        r.raise_for_status()
        data = r.json()
        items = data.get("data") or []
        items = sorted(items, key=lambda x: int(x.get("index", 0)))
        out: list[list[float]] = []
        for it in items:
            emb = it.get("embedding")
            if not isinstance(emb, list):
                raise RuntimeError(f"嵌入项无效: {it!r:.200}")
            out.append([float(x) for x in emb])
        if len(out) != len(texts):
            raise RuntimeError(f"嵌入条数不一致: 请求 {len(texts)} 得到 {len(out)}")
        return out
