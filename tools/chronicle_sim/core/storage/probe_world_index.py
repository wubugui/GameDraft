"""Probe 用世界文本索引：Chroma 向量检索 events / summaries。"""
from __future__ import annotations

import json
import sqlite3
import warnings
from pathlib import Path
from typing import Any

from tools.chronicle_sim.core.runtime.memory_store import (
    SCHEMA_EMBED_DIM_KEY,
    assert_embedding_dim_for_write,
    chroma_client_for_run,
)

PROBE_WORLD_COLLECTION = "probe_world"
PROBE_INDEX_SIG_KEY = "probe_world_index_sig"


def get_probe_world_collection(run_dir: Path | None) -> Any | None:
    if run_dir is None:
        return None
    try:
        client = chroma_client_for_run(run_dir)
        return client.get_or_create_collection(
            name=PROBE_WORLD_COLLECTION,
            metadata={"hnsw:space": "cosine"},
        )
    except Exception as e:
        warnings.warn(f"Chroma 无法打开 probe_world 集合: {e}", UserWarning, stacklevel=2)
        return None


def _compute_index_sig(conn: sqlite3.Connection) -> str:
    ev = conn.execute("SELECT COUNT(*) AS c FROM events").fetchone()
    sm = conn.execute("SELECT COUNT(*) AS c FROM summaries").fetchone()
    last = conn.execute("SELECT id FROM events ORDER BY rowid DESC LIMIT 1").fetchone()
    lid = str(last["id"]) if last else ""
    return f"{int(ev['c'])}:{int(sm['c'])}:{lid}"


async def ensure_probe_world_index(
    conn: sqlite3.Connection,
    run_dir: Path,
    embedding: Any,
) -> None:
    coll = get_probe_world_collection(run_dir)
    if coll is None:
        return
    sig = _compute_index_sig(conn)
    row = conn.execute(
        "SELECT value FROM schema_meta WHERE key = ?",
        (PROBE_INDEX_SIG_KEY,),
    ).fetchone()
    try:
        n_docs = int(coll.count())
    except Exception:
        n_docs = 0
    if row and str(row[0]) == sig and n_docs > 0:
        return

    try:
        existing = coll.get(include=[])
        ids = existing.get("ids") or []
        if ids:
            coll.delete(ids=list(ids))
    except Exception as e:
        warnings.warn(f"清空 probe_world 旧索引失败，将尝试直接覆盖: {e}", UserWarning)

    batch_ids: list[str] = []
    batch_docs: list[str] = []
    batch_meta: list[dict[str, Any]] = []

    for r in conn.execute(
        "SELECT id, week_number, type_id, truth_json FROM events ORDER BY week_number, id"
    ).fetchall():
        tid = str(r["type_id"] or "")
        tj = r["truth_json"] or "{}"
        try:
            obj = json.loads(tj) if isinstance(tj, str) else tj
            note = ""
            if isinstance(obj, dict):
                note = str(obj.get("what_happened") or obj.get("note") or "")[:1200]
        except json.JSONDecodeError:
            note = str(tj)[:1200]
        doc = f"{tid} {note}".strip() or tid
        eid = str(r["id"])
        batch_ids.append(f"evt:{eid}")
        batch_docs.append(doc[:4000])
        batch_meta.append(
            {
                "kind": "event",
                "ref_id": eid,
                "week_number": int(r["week_number"] or 0),
            }
        )

    for r in conn.execute(
        "SELECT scope, week_start, week_end, text FROM summaries ORDER BY week_start, scope"
    ).fetchall():
        scope = str(r["scope"] or "")
        ws = int(r["week_start"] or 0)
        we = int(r["week_end"] or 0)
        txt = str(r["text"] or "")[:4000]
        if not txt.strip():
            continue
        sid = f"sum:{scope}:{ws}:{we}"
        batch_ids.append(sid)
        batch_docs.append(f"{scope} 第{ws}-{we}周 {txt}")
        batch_meta.append(
            {
                "kind": "summary",
                "ref_id": sid,
                "scope": scope,
                "week_start": ws,
                "week_end": we,
            }
        )

    if not batch_docs:
        conn.execute(
            "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)",
            (PROBE_INDEX_SIG_KEY, sig),
        )
        return

    chunk = 40
    first = True
    for i in range(0, len(batch_docs), chunk):
        part_docs = batch_docs[i : i + chunk]
        part_ids = batch_ids[i : i + chunk]
        part_meta = batch_meta[i : i + chunk]
        vecs = await embedding.embed(part_docs)
        if first and vecs:
            assert_embedding_dim_for_write(conn, len(vecs[0]))
            first = False
        try:
            coll.upsert(ids=part_ids, embeddings=vecs, documents=part_docs, metadatas=part_meta)
        except Exception as e:
            warnings.warn(f"probe_world upsert 失败 offset={i}: {e}", UserWarning)

    conn.execute(
        "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)",
        (PROBE_INDEX_SIG_KEY, sig),
    )


async def search_probe_world(
    conn: sqlite3.Connection,
    run_dir: Path,
    embedding: Any,
    query: str,
    *,
    week_min: int | None = None,
    week_max: int | None = None,
    limit: int = 10,
) -> list[dict[str, Any]]:
    coll = get_probe_world_collection(run_dir)
    if coll is None:
        return []
    row = conn.execute(
        "SELECT value FROM schema_meta WHERE key = ?",
        (SCHEMA_EMBED_DIM_KEY,),
    ).fetchone()
    if row:
        try:
            expected = int(row[0])
        except ValueError:
            expected = None
    else:
        expected = None
    try:
        qv = (await embedding.embed([query]))[0]
    except Exception as e:
        warnings.warn(f"probe_world 查询嵌入失败: {e}", UserWarning)
        return []
    if expected is not None and len(qv) != expected:
        warnings.warn(
            f"probe_world 查询向量维度 {len(qv)} 与库记录 {expected} 不一致，跳过向量检索。",
            UserWarning,
        )
        return []
    try:
        res = coll.query(
            query_embeddings=[qv],
            n_results=min(max(limit * 4, 24), 80),
            include=["documents", "metadatas", "distances"],
        )
    except Exception as e:
        warnings.warn(f"probe_world query 失败: {e}", UserWarning)
        return []
    metas = (res.get("metadatas") or [[]])[0]
    docs = (res.get("documents") or [[]])[0]
    out: list[dict[str, Any]] = []
    for meta, doc in zip(metas, docs):
        if not meta:
            continue
        kind = str(meta.get("kind", ""))
        if kind == "event":
            wk = int(meta.get("week_number", 0))
            if week_min is not None and wk < week_min:
                continue
            if week_max is not None and wk > week_max:
                continue
            out.append(
                {
                    "kind": "event",
                    "id": str(meta.get("ref_id", "")),
                    "week": wk,
                    "snippet": (doc or "")[:220],
                }
            )
        elif kind == "summary":
            ws = int(meta.get("week_start", 0))
            we = int(meta.get("week_end", 0))
            if week_min is not None and we < week_min:
                continue
            if week_max is not None and ws > week_max:
                continue
            out.append(
                {
                    "kind": "summary",
                    "scope": str(meta.get("scope", "")),
                    "snippet": (doc or "")[:280],
                }
            )
        if len(out) >= limit:
            break
    return out
