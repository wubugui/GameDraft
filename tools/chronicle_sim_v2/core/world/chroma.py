"""ChromaDB 集合管理：ideas 和 world 两个 collection。"""
from __future__ import annotations

import json
import shutil
import warnings
from pathlib import Path
from typing import Any

import chromadb
from chromadb.api.types import EmbeddingFunction


# 部分云厂商（如阿里云 DashScope）单次 embedding 请求条数上限为 10。
_EMBED_API_MAX_BATCH = 10


class _EmbeddingWrapper(EmbeddingFunction):
    """用 OpenAI 兼容 API 做 embedding（支持中文）。"""

    def __init__(self, api_key: str, model: str, base_url: str):
        self._api_key = api_key
        self._model = model
        self._base_url = base_url
        self._client = None

    def _get_client(self):
        if self._client is None:
            from openai import OpenAI
            import httpx
            self._client = OpenAI(
                api_key=self._api_key,
                base_url=self._base_url,
                http_client=httpx.Client(trust_env=False, timeout=60.0),
            )
        return self._client

    def __call__(self, input: list[str]) -> list[list[float]]:
        if not input:
            return []
        client = self._get_client()
        result = []
        batch = []
        for text in input:
            batch.append(text)
            if len(batch) >= _EMBED_API_MAX_BATCH:
                resp = client.embeddings.create(model=self._model, input=batch, encoding_format="float")
                result.extend([d.embedding for d in resp.data])
                batch = []
        if batch:
            resp = client.embeddings.create(model=self._model, input=batch, encoding_format="float")
            result.extend([d.embedding for d in resp.data])
        return result


def _get_embed_function(run_dir: Path) -> _EmbeddingWrapper | None:
    """从 LLM 配置读取 embedding 参数。"""
    cfg_path = run_dir / "config" / "llm_config.json"
    if not cfg_path.is_file():
        return None
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        emb_cfg = cfg.get("embeddings", {})
        if not emb_cfg or not emb_cfg.get("kind"):
            return None
        kind = str(emb_cfg.get("kind", "")).lower()
        if kind == "openai_compat":
            api_key = emb_cfg.get("api_key", "")
            model = emb_cfg.get("model", "text-embedding-v4")
            base_url = emb_cfg.get("base_url", "").rstrip("/")
            if not base_url.endswith("/v1"):
                base_url += "/v1"
            if not api_key or not base_url:
                return None
            return _EmbeddingWrapper(api_key, model, base_url)
        elif kind == "ollama":
            host = emb_cfg.get("ollama_host", "http://127.0.0.1:11434").rstrip("/")
            model = emb_cfg.get("model", "nomic-embed-text")
            # Ollama 的 OpenAI 兼容 embedding API 在 /v1 路径下
            base_url = f"{host}/v1"
            return _EmbeddingWrapper("", model, base_url)
        return None
    except Exception:
        return None


_CHROMA_CLIENTS: dict[str, chromadb.PersistentClient] = {}


def _get_client(persist_dir: str) -> chromadb.PersistentClient:
    key = persist_dir
    if key not in _CHROMA_CLIENTS:
        _CHROMA_CLIENTS[key] = chromadb.PersistentClient(path=persist_dir)
    return _CHROMA_CLIENTS[key]


def _collection(coll_name: str, run_dir: Path, *, create: bool = True) -> Any | None:
    """获取或创建 ChromaDB collection。"""
    persist_dir = str(run_dir / f"{coll_name}_chroma")
    try:
        client = _get_client(persist_dir)
        if create:
            ef = _get_embed_function(run_dir)
            kwargs: dict[str, Any] = {
                "name": coll_name,
                "metadata": {"hnsw:space": "cosine"},
            }
            if ef:
                kwargs["embedding_function"] = ef
            return client.get_or_create_collection(**kwargs)
        else:
            return client.get_collection(name=coll_name)
    except Exception as e:
        warnings.warn(f"Chroma 无法打开 {coll_name} 集合: {e}", UserWarning, stacklevel=2)
        return None


def delete_collection(coll_name: str, run_dir: Path) -> bool:
    """删除 collection 及其持久化目录。"""
    persist_dir = str(run_dir / f"{coll_name}_chroma")
    try:
        client = _get_client(persist_dir)
        try:
            client.delete_collection(name=coll_name)
        except Exception:
            pass
        p = Path(persist_dir)
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)
        _CHROMA_CLIENTS.pop(persist_dir, None)
        return True
    except Exception as e:
        warnings.warn(f"Chroma 删除 {coll_name} 失败: {e}", UserWarning)
        return False


def rebuild_ideas_collection(run_dir: Path) -> int:
    """重建设定库 collection，返回重新索引的条目数。"""
    delete_collection("ideas", run_dir)

    # 直接从 manifest 和 MD 文件读取，避免 circular import
    manifest_path = run_dir / "ideas" / "manifest.json"
    if not manifest_path.is_file():
        coll = get_ideas_collection(run_dir)
        return 0

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    ids, docs, metas = [], [], []
    for item in manifest:
        idea_id = item.get("id", "")
        md_path = run_dir / "ideas" / f"{idea_id}.md"
        if not md_path.is_file():
            continue
        content = md_path.read_text(encoding="utf-8")
        # 解析 frontmatter
        title = item.get("title", md_path.stem)
        source = item.get("source", "manual")
        body = content
        if content.startswith("---"):
            parts = content.split("---", 2)
            if len(parts) >= 3:
                body = parts[2].strip()
        if body:
            ids.append(idea_id)
            docs.append(body)
            metas.append({"title": title, "source": source})

    coll = get_ideas_collection(run_dir)
    if coll is None or not ids:
        return 0
    _upsert_batch(coll, ids, docs, metadatas=metas)
    return len(ids)


def rebuild_world_collection(run_dir: Path) -> int:
    """重建世界 collection，返回重新索引的文档数。"""
    delete_collection("world", run_dir)
    from tools.chronicle_sim_v2.core.world.fs import list_dir as fs_list, read_json, read_text
    coll = get_world_collection(run_dir)
    if coll is None:
        return 0
    ids, docs, metas = [], [], []
    # 索引事件、记忆、总结
    try:
        weeks_dir = run_dir / "chronicle"
        if weeks_dir.is_dir():
            for w in sorted(weeks_dir.iterdir()):
                if w.is_dir() and w.name.startswith("week_"):
                    # 事件
                    ev_dir = w / "events"
                    if ev_dir.is_dir():
                        for f in sorted(ev_dir.iterdir()):
                            if f.suffix == ".json":
                                data = read_json(run_dir, f"chronicle/{w.name}/events/{f.name}")
                                if data:
                                    ids.append(f"{w.name}_ev_{f.stem}")
                                    docs.append(json.dumps(data, ensure_ascii=False))
                                    metas.append({"kind": "event", "week": w.name})
                    # 总结
                    summary_path = w / "summary.md"
                    if summary_path.is_file():
                        txt = summary_path.read_text(encoding="utf-8")
                        ids.append(f"{w.name}_summary")
                        docs.append(txt)
                        metas.append({"kind": "summary", "week": w.name})
                    # 谣言
                    rumors_path = w / "rumors.json"
                    if rumors_path.is_file():
                        data = read_json(run_dir, f"chronicle/{w.name}/rumors.json")
                        if data is not None:
                            ids.append(f"{w.name}_rumors")
                            docs.append(json.dumps(data, ensure_ascii=False))
                            metas.append({"kind": "rumors", "week": w.name})
                    # 意图
                    intent_dir = w / "intents"
                    if intent_dir.is_dir():
                        for f in sorted(intent_dir.iterdir()):
                            if f.suffix == ".json":
                                data = read_json(run_dir, f"chronicle/{w.name}/intents/{f.name}")
                                if data:
                                    ids.append(f"{w.name}_intent_{f.stem}")
                                    docs.append(json.dumps(data, ensure_ascii=False))
                                    metas.append({"kind": "intent", "week": w.name})
    except Exception:
        pass
    if ids:
        _upsert_batch(coll, ids, docs, metadatas=metas)
    return len(ids)


def get_ideas_collection(run_dir: Path) -> Any | None:
    """获取设定库 ChromaDB collection。"""
    return _collection("ideas", run_dir)


def get_world_collection(run_dir: Path) -> Any | None:
    """获取世界内容 ChromaDB collection。"""
    return _collection("world", run_dir)


def add_idea(
    run_dir: Path,
    idea_id: str,
    text: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    """添加/更新设定到 ChromaDB。"""
    coll = get_ideas_collection(run_dir)
    if coll is None:
        return
    _upsert_batch(coll, [idea_id], [text], metadatas=[metadata or {}])


def add_world_doc(
    run_dir: Path,
    doc_id: str,
    text: str,
    metadata: dict[str, Any] | None = None,
) -> None:
    """添加/更新世界内容到 ChromaDB。"""
    coll = get_world_collection(run_dir)
    if coll is None:
        return
    _upsert_batch(coll, [doc_id], [text], metadatas=[metadata or {}])


def _upsert_batch(
    collection: Any,
    ids: list[str],
    documents: list[str],
    embeddings: list[list[float]] | None = None,
    metadatas: list[dict] | None = None,
) -> None:
    """批量 upsert 到 ChromaDB collection。"""
    if not ids:
        return
    # Chroma 会把整批 documents 一次交给 embedding 函数；云 API 常有单批条数上限。
    chunk = _EMBED_API_MAX_BATCH
    for i in range(0, len(ids), chunk):
        sl = slice(i, i + chunk)
        kwargs: dict[str, Any] = {
            "ids": ids[sl],
            "documents": documents[sl],
        }
        if embeddings is not None:
            kwargs["embeddings"] = embeddings[sl]
        if metadatas is not None:
            kwargs["metadatas"] = metadatas[sl]
        try:
            collection.upsert(**kwargs)
        except Exception as e:
            warnings.warn(f"ChromaDB upsert 失败: {e}", UserWarning)


def search_ideas(
    run_dir: Path,
    query: str,
    n_results: int = 5,
) -> list[dict[str, Any]]:
    """语义搜索设定库。"""
    coll = get_ideas_collection(run_dir)
    if coll is None:
        return []
    try:
        res = coll.query(query_texts=[query], n_results=n_results, include=["documents", "metadatas"])
    except Exception:
        return []
    docs = (res.get("documents") or [[]])[0]
    metas = (res.get("metadatas") or [[]])[0]
    ids = (res.get("ids") or [[]])[0]
    return [{"document": d, "metadata": m, "id": id_} for d, m, id_ in zip(docs, metas, ids) if m]


def search_world(
    run_dir: Path,
    query: str,
    n_results: int = 5,
) -> list[dict[str, Any]]:
    """语义搜索世界内容。"""
    coll = get_world_collection(run_dir)
    if coll is None:
        return []
    try:
        res = coll.query(query_texts=[query], n_results=n_results, include=["documents", "metadatas"])
    except Exception:
        return []
    docs = (res.get("documents") or [[]])[0]
    metas = (res.get("metadatas") or [[]])[0]
    ids = (res.get("ids") or [[]])[0]
    return [{"document": d, "metadata": m, "id": id_} for d, m, id_ in zip(docs, metas, ids) if m]


def release_all_clients() -> None:
    """释放所有 ChromaDB 客户端（应用退出时调用）。"""
    _CHROMA_CLIENTS.clear()


def is_embedding_configured(run_dir: Path) -> bool:
    """检测嵌入模型是否已正确配置。"""
    return _get_embed_function(run_dir) is not None
