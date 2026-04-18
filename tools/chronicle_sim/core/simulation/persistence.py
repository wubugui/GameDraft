from __future__ import annotations

import json
import sqlite3
import warnings
from typing import Any

from tools.chronicle_sim.core.schema.event_record import EventRecord


def _agent_ids_in_db(conn: sqlite3.Connection) -> set[str]:
    return {r[0] for r in conn.execute("SELECT id FROM agents").fetchall()}


def filter_event_record_witnesses(conn: sqlite3.Connection, rec: EventRecord) -> EventRecord:
    """丢弃 agents 表中不存在的见证人，避免 event_witnesses 外键失败（模型常编造路人 id）。"""
    valid = _agent_ids_in_db(conn)
    kept = [w for w in rec.witness_accounts if w.agent_id in valid]
    dropped = len(rec.witness_accounts) - len(kept)
    if dropped:
        bad = {w.agent_id for w in rec.witness_accounts if w.agent_id not in valid}
        warnings.warn(
            f"事件 {rec.id}: 已丢弃 {dropped} 条见证（agent_id 不在 agents 表）: {sorted(bad)[:8]}",
            stacklevel=2,
        )
    return rec.model_copy(update={"witness_accounts": kept})


def persist_event_record(conn: sqlite3.Connection, rec: EventRecord) -> None:
    rec = filter_event_record_witnesses(conn, rec)
    conn.execute("DELETE FROM event_witnesses WHERE event_id = ?", (rec.id,))
    conn.execute(
        """
        INSERT OR REPLACE INTO events (
            id, week_number, location_id, type_id, truth_json, director_draft_json,
            witness_accounts_json, rumor_versions_json, tags_json, supernatural_level
        ) VALUES (?,?,?,?,?,?,?,?,?,?)
        """,
        (
            rec.id,
            rec.week_number,
            rec.location_id,
            rec.type_id,
            json.dumps(rec.truth_json, ensure_ascii=False),
            json.dumps(rec.director_draft_json, ensure_ascii=False),
            json.dumps([w.model_dump() for w in rec.witness_accounts], ensure_ascii=False),
            json.dumps(rec.rumor_versions, ensure_ascii=False),
            json.dumps(rec.tags, ensure_ascii=False),
            rec.supernatural_level,
        ),
    )
    for w in rec.witness_accounts:
        conn.execute(
            """
            INSERT INTO event_witnesses (event_id, agent_id, account_text, supernatural_hint)
            VALUES (?,?,?,?)
            """,
            (rec.id, w.agent_id, w.account_text, w.supernatural_hint),
        )


def persist_week_intent(
    conn: sqlite3.Connection,
    agent_id: str,
    week: int,
    mood_delta: str,
    intent_text: str,
    target_ids: list[str],
    hints: list[str],
) -> None:
    conn.execute(
        """
        INSERT OR REPLACE INTO week_intents (agent_id, week, mood_delta, intent_text, target_ids_json, relationship_hints_json)
        VALUES (?,?,?,?,?,?)
        """,
        (
            agent_id,
            week,
            mood_delta,
            intent_text,
            json.dumps(target_ids, ensure_ascii=False),
            json.dumps(hints, ensure_ascii=False),
        ),
    )


def load_active_sa_agent_ids(conn: sqlite3.Connection) -> list[str]:
    """返回 S/A/B 档 agent id（名称保留以兼容旧代码）。"""
    rows = conn.execute(
        "SELECT id FROM agents WHERE current_tier IN ('S','A','B')"
    ).fetchall()
    return [r[0] for r in rows]


def fetch_intents_for_week(conn: sqlite3.Connection, week: int) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM week_intents WHERE week = ?", (week,)).fetchall()
    return [dict(r) for r in rows]


def events_for_week_json(
    conn: sqlite3.Connection,
    week: int,
    *,
    max_rows: int = 80,
    max_chars: int = 120_000,
) -> str:
    total_row = conn.execute(
        "SELECT COUNT(*) AS c FROM events WHERE week_number = ?", (week,)
    ).fetchone()
    total = int(total_row["c"]) if total_row else 0
    rows = conn.execute(
        "SELECT * FROM events WHERE week_number = ? ORDER BY id LIMIT ?",
        (week, max_rows),
    ).fetchall()
    blobs: list[dict[str, Any]] = [dict(r) for r in rows]
    meta = {
        "row_cap": max_rows,
        "char_budget": max_chars,
        "db_total_events_this_week": total,
    }
    while blobs:
        payload = {"events": blobs, "_truncation": {**meta, "included_rows": len(blobs)}}
        s = json.dumps(payload, ensure_ascii=False)
        if len(s) <= max_chars:
            return s
        blobs = blobs[:-1]
    return json.dumps(
        {
            "events": [],
            "_truncation": {**meta, "included_rows": 0, "error": "超限裁剪后为空"},
        },
        ensure_ascii=False,
    )
