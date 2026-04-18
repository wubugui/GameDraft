from __future__ import annotations

import asyncio
import sqlite3
import struct
import warnings
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np

from tools.chronicle_sim.core.runtime import isolation

SCHEMA_EMBED_DIM_KEY = "agent_memory_embed_dim"
_CHROMA_CLIENTS: dict[str, Any] = {}


class EmbeddingSchemaError(RuntimeError):
    """schema_meta 中嵌入维度损坏或与当前向量不一致。"""


def _chroma_persistent_client(chroma_root: Path) -> Any:
    import chromadb

    key = str(chroma_root.resolve())
    if key not in _CHROMA_CLIENTS:
        _CHROMA_CLIENTS[key] = chromadb.PersistentClient(path=key)
    return _CHROMA_CLIENTS[key]


def release_chroma_client_for_run(run_dir: Path) -> None:
    """释放本 run 的 Chroma 客户端缓存，便于删除目录或独占文件。"""
    root = run_dir / "chroma_memory"
    key = str(root.resolve())
    _CHROMA_CLIENTS.pop(key, None)


def release_all_chroma_clients() -> None:
    """进程退出前清空 Chroma 客户端缓存。"""
    _CHROMA_CLIENTS.clear()


def chroma_client_for_run(run_dir: Path) -> Any:
    """run 目录下 chroma_memory 的持久化客户端（与 npc / probe 索引共用根目录）。"""
    root = run_dir / "chroma_memory"
    root.mkdir(parents=True, exist_ok=True)
    return _chroma_persistent_client(root)


def get_npc_chroma_collection(run_dir: Path | None) -> Any | None:
    """打开或创建 npc_memories 集合；失败时告警并返回 None。"""
    if run_dir is None:
        return None
    try:
        client = chroma_client_for_run(run_dir)
        return client.get_or_create_collection(
            name="npc_memories",
            metadata={"hnsw:space": "cosine"},
        )
    except Exception as e:
        warnings.warn(
            f"Chroma 无法打开或创建 npc_memories 集合: {e}",
            UserWarning,
            stacklevel=2,
        )
        return None


def assert_embedding_dim_for_write(conn: sqlite3.Connection, dim: int) -> None:
    """首次写入记录维度；已存在则必须一致；损坏或非整数禁止静默覆盖。"""
    row = conn.execute(
        "SELECT value FROM schema_meta WHERE key = ?",
        (SCHEMA_EMBED_DIM_KEY,),
    ).fetchone()
    if not row or not str(row[0]).strip():
        conn.execute(
            "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)",
            (SCHEMA_EMBED_DIM_KEY, str(dim)),
        )
        return
    try:
        stored = int(row[0])
    except ValueError as e:
        raise EmbeddingSchemaError(
            f"schema_meta[{SCHEMA_EMBED_DIM_KEY}] 非合法整数: {row[0]!r}，请手动修复或重建 run"
        ) from e
    if stored != dim:
        raise EmbeddingSchemaError(
            f"嵌入维度不一致：库内记录 {stored}，当前模型输出 {dim}。"
            "请统一嵌入模型，或删除本 run 下 chroma_memory 并清空 agent_memories.embedding_blob。"
        )


def _get_stored_embedding_dim(conn: sqlite3.Connection) -> int | None:
    row = conn.execute(
        "SELECT value FROM schema_meta WHERE key = ?",
        (SCHEMA_EMBED_DIM_KEY,),
    ).fetchone()
    if not row or not str(row[0]).strip():
        return None
    try:
        return int(row[0])
    except ValueError:
        return None


def purge_chroma_for_owner(run_dir: Path, owner_agent_id: str) -> None:
    """档位降级等场景：删除该 NPC 在 Chroma 中的向量索引。"""
    root = run_dir / "chroma_memory"
    if not root.is_dir():
        return
    try:
        client = _chroma_persistent_client(root)
        coll = client.get_or_create_collection(
            name="npc_memories",
            metadata={"hnsw:space": "cosine"},
        )
        coll.delete(where={"owner": owner_agent_id})
    except Exception as e:
        warnings.warn(
            f"purge_chroma_for_owner 失败 owner={owner_agent_id}: {e}",
            UserWarning,
        )


async def backfill_null_agent_memories(
    conn: sqlite3.Connection,
    run_dir: Path,
    embedding: Any,
    *,
    limit: int = 500,
    sql_lock: asyncio.Lock | None = None,
) -> int:
    """为 embedding_blob 为空的 S/A 存活角色记忆补向量与 Chroma（升格恢复、旧数据等）。"""
    rows = conn.execute(
        """
        SELECT m.id, m.owner_agent_id, m.week, m.content
        FROM agent_memories m
        JOIN agents a ON a.id = m.owner_agent_id
        WHERE m.embedding_blob IS NULL AND length(trim(m.content)) > 0
          AND a.current_tier IN ('S', 'A', 'B') AND a.life_status = 'alive'
        ORDER BY m.id
        LIMIT ?
        """,
        (limit,),
    ).fetchall()
    coll = get_npc_chroma_collection(run_dir)
    done = 0
    for r in rows:
        rid = int(r["id"])
        owner = str(r["owner_agent_id"])
        week = int(r["week"])
        content = str(r["content"])
        vec = (await embedding.embed([content]))[0]
        assert_embedding_dim_for_write(conn, len(vec))
        blob = np.asarray(vec, dtype=np.float32).tobytes()

        async def _upd() -> None:
            if sql_lock:
                async with sql_lock:
                    conn.execute(
                        "UPDATE agent_memories SET embedding_blob = ? WHERE id = ?",
                        (blob, rid),
                    )
            else:
                conn.execute(
                    "UPDATE agent_memories SET embedding_blob = ? WHERE id = ?",
                    (blob, rid),
                )

        await _upd()
        if coll is not None:
            try:
                uid = f"{owner}_{rid}"
                coll.upsert(
                    ids=[uid],
                    embeddings=[vec],
                    documents=[content],
                    metadatas=[{"owner": owner, "week": week, "row_id": rid}],
                )
            except Exception as e:
                warnings.warn(f"Chroma upsert 回填失败 id={rid}: {e}", UserWarning)
        done += 1
    return done


class MemoryStore:
    def __init__(
        self,
        conn: sqlite3.Connection,
        owner_agent_id: str,
        *,
        run_dir: Path | None = None,
        embedding: Any | None = None,
        telemetry_log: Callable[[str], None] | None = None,
        sql_lock: asyncio.Lock | None = None,
    ) -> None:
        self._conn = conn
        self.owner_agent_id = owner_agent_id
        self._embedding = embedding
        self._run_dir = run_dir
        self._telemetry_log = telemetry_log
        self._sql_lock = sql_lock
        self._chroma_collection: Any | None = None
        if run_dir is not None and embedding is not None:
            self._chroma_collection = get_npc_chroma_collection(run_dir)

    def _tlog(self, msg: str) -> None:
        if self._telemetry_log:
            self._telemetry_log(f"{self.owner_agent_id}: {msg}")

    @property
    def has_vector_memory(self) -> bool:
        return self._embedding is not None

    def write(self, week: int, content: str, caller_id: str | None = None) -> None:
        cid = caller_id or self.owner_agent_id
        isolation.assert_same_owner(cid, self.owner_agent_id)
        self._conn.execute(
            "INSERT INTO agent_memories (owner_agent_id, week, content) VALUES (?,?,?)",
            (self.owner_agent_id, week, content),
        )

    async def write_with_embedding(
        self, week: int, content: str, caller_id: str | None = None
    ) -> None:
        cid = caller_id or self.owner_agent_id
        isolation.assert_same_owner(cid, self.owner_agent_id)
        if self._sql_lock:
            async with self._sql_lock:
                self.write(week, content, caller_id=cid)
                row = self._conn.execute(
                    """
                    SELECT id FROM agent_memories
                    WHERE owner_agent_id = ? ORDER BY id DESC LIMIT 1
                    """,
                    (self.owner_agent_id,),
                ).fetchone()
        else:
            self.write(week, content, caller_id=cid)
            row = self._conn.execute(
                """
                SELECT id FROM agent_memories
                WHERE owner_agent_id = ? ORDER BY id DESC LIMIT 1
                """,
                (self.owner_agent_id,),
            ).fetchone()
        if not row:
            return
        rid = int(row["id"])
        if not self._embedding:
            return
        try:
            vec = (await self._embedding.embed([content]))[0]
        except Exception as e:
            warnings.warn(
                f"写入记忆嵌入失败 owner={self.owner_agent_id} row={rid}: {e}",
                UserWarning,
            )
            self._tlog(f"写入向量跳过：嵌入请求失败（{e}）")
            return
        try:
            assert_embedding_dim_for_write(self._conn, len(vec))
        except EmbeddingSchemaError as e:
            self._tlog(str(e))
            raise
        blob = np.asarray(vec, dtype=np.float32).tobytes()
        if self._sql_lock:
            async with self._sql_lock:
                self._conn.execute(
                    "UPDATE agent_memories SET embedding_blob = ? WHERE id = ?",
                    (blob, rid),
                )
        else:
            self._conn.execute(
                "UPDATE agent_memories SET embedding_blob = ? WHERE id = ?",
                (blob, rid),
            )
        if self._chroma_collection is not None:
            uid = f"{self.owner_agent_id}_{rid}"
            try:
                self._chroma_collection.upsert(
                    ids=[uid],
                    embeddings=[vec],
                    documents=[content],
                    metadatas=[{"owner": self.owner_agent_id, "week": week, "row_id": rid}],
                )
            except Exception as e:
                warnings.warn(
                    f"Chroma upsert 失败 owner={self.owner_agent_id} id={rid}: {e}",
                    UserWarning,
                )
                self._tlog(f"Chroma写入失败 id={rid}（{e}）")

    def recent(self, limit: int = 20, caller_id: str | None = None) -> list[dict[str, Any]]:
        cid = caller_id or self.owner_agent_id
        isolation.assert_same_owner(cid, self.owner_agent_id)
        rows = self._conn.execute(
            "SELECT * FROM agent_memories WHERE owner_agent_id = ? ORDER BY id DESC LIMIT ?",
            (self.owner_agent_id, limit),
        ).fetchall()
        return [dict(r) for r in rows]

    async def recent_locked(self, limit: int = 20, caller_id: str | None = None) -> list[dict[str, Any]]:
        if self._sql_lock:
            async with self._sql_lock:
                return self.recent(limit=limit, caller_id=caller_id)
        return self.recent(limit=limit, caller_id=caller_id)

    async def recall_semantic(
        self,
        query: str,
        *,
        limit: int = 10,
        recency_k: int = 2,
        caller_id: str | None = None,
    ) -> list[dict[str, Any]]:
        """语义检索 + 最近条混合；无嵌入后端时退回 recent。"""
        cid = caller_id or self.owner_agent_id
        isolation.assert_same_owner(cid, self.owner_agent_id)
        if not self._embedding:
            return await self.recent_locked(limit=limit, caller_id=cid)
        try:
            qv = (await self._embedding.embed([query]))[0]
        except Exception as e:
            detail = (str(e) or "").strip() or repr(e)
            warnings.warn(
                f"查询嵌入失败，退回时间序记忆 owner={self.owner_agent_id}: {detail}",
                UserWarning,
            )
            self._tlog(f"语义检索退回时间序：查询嵌入失败（{detail}）")
            return await self.recent_locked(limit=limit, caller_id=cid)
        q = np.asarray(qv, dtype=np.float64)
        qn = float(np.linalg.norm(q)) + 1e-12
        expected_dim = _get_stored_embedding_dim(self._conn)
        if expected_dim is not None and len(qv) != expected_dim:
            warnings.warn(
                f"查询向量维度 {len(qv)} 与库记录 {expected_dim} 不一致，退回时间序记忆。",
                UserWarning,
            )
            self._tlog(
                f"语义检索退回时间序：查询向量维度 {len(qv)} 与库记录 {expected_dim} 不一致"
            )
            return await self.recent_locked(limit=limit, caller_id=cid)

        merged_ids: list[int] = []
        seen: set[int] = set()

        async def _rec_rows() -> list[sqlite3.Row]:
            if self._sql_lock:
                async with self._sql_lock:
                    return self._conn.execute(
                        """
                        SELECT id FROM agent_memories
                        WHERE owner_agent_id = ? ORDER BY id DESC LIMIT ?
                        """,
                        (self.owner_agent_id, recency_k),
                    ).fetchall()
            return self._conn.execute(
                """
                SELECT id FROM agent_memories
                WHERE owner_agent_id = ? ORDER BY id DESC LIMIT ?
                """,
                (self.owner_agent_id, recency_k),
            ).fetchall()

        for r in await _rec_rows():
            rid = int(r["id"])
            if rid not in seen:
                seen.add(rid)
                merged_ids.append(rid)

        semantic_ids: list[int] = []
        if self._chroma_collection is not None:
            try:
                nq = min(max(limit * 2, 16), 64)
                res = self._chroma_collection.query(
                    query_embeddings=[qv],
                    n_results=nq,
                    where={"owner": self.owner_agent_id},
                    include=["metadatas"],
                )
                metas = (res.get("metadatas") or [[]])[0]
                for meta in metas:
                    if meta and "row_id" in meta:
                        semantic_ids.append(int(meta["row_id"]))
            except Exception as e:
                warnings.warn(
                    f"Chroma query 失败 owner={self.owner_agent_id}，将尝试暴力检索: {e}",
                    UserWarning,
                )
                self._tlog(f"Chroma 查询失败，改本地向量暴力检索（{e}）")
                semantic_ids = []

        if not semantic_ids:
            semantic_ids = await self._semantic_ids_bruteforce_async(q, qn, limit * 2, expected_dim)

        for rid in semantic_ids:
            if rid not in seen:
                seen.add(rid)
                merged_ids.append(rid)

        merged_ids = merged_ids[:limit]
        if not merged_ids:
            self._tlog("语义检索无合并结果，退回时间序记忆")
            return await self.recent_locked(limit=limit, caller_id=cid)

        placeholders = ",".join("?" * len(merged_ids))

        async def _fetch_merged() -> list[sqlite3.Row]:
            if self._sql_lock:
                async with self._sql_lock:
                    return self._conn.execute(
                        f"""
                        SELECT * FROM agent_memories
                        WHERE owner_agent_id = ? AND id IN ({placeholders})
                        """,
                        (self.owner_agent_id, *merged_ids),
                    ).fetchall()
            return self._conn.execute(
                f"""
                SELECT * FROM agent_memories
                WHERE owner_agent_id = ? AND id IN ({placeholders})
                """,
                (self.owner_agent_id, *merged_ids),
            ).fetchall()

        rows = await _fetch_merged()
        by_id = {int(r["id"]): dict(r) for r in rows}
        return [by_id[i] for i in merged_ids if i in by_id]

    async def _semantic_ids_bruteforce_async(
        self,
        q: np.ndarray,
        qn: float,
        cap: int,
        expected_dim: int | None,
    ) -> list[int]:
        if self._sql_lock:
            async with self._sql_lock:
                rows = self._conn.execute(
                    """
                    SELECT id, embedding_blob FROM agent_memories
                    WHERE owner_agent_id = ? AND embedding_blob IS NOT NULL
                    """,
                    (self.owner_agent_id,),
                ).fetchall()
        else:
            rows = self._conn.execute(
                """
                SELECT id, embedding_blob FROM agent_memories
                WHERE owner_agent_id = ? AND embedding_blob IS NOT NULL
                """,
                (self.owner_agent_id,),
            ).fetchall()
        scored: list[tuple[float, int]] = []
        for r in rows:
            blob = r["embedding_blob"]
            if not blob:
                continue
            raw = bytes(blob)
            n = len(raw) // 4
            if expected_dim is not None and n != expected_dim:
                continue
            v = np.array(struct.unpack(f"{n}f", raw[: n * 4]), dtype=np.float64)
            vn = float(np.linalg.norm(v)) + 1e-12
            sim = float(np.dot(q, v) / (qn * vn))
            scored.append((sim, int(r["id"])))
        scored.sort(key=lambda x: -x[0])
        return [i for _, i in scored[:cap]]

    def dump_all_rows(self) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT * FROM agent_memories WHERE owner_agent_id = ?",
            (self.owner_agent_id,),
        ).fetchall()
        return [dict(r) for r in rows]
