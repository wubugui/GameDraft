from __future__ import annotations

import sqlite3
from typing import Any

from tools.chronicle_sim.core.schema.belief import BeliefRecord
from tools.chronicle_sim.core.storage.sql_like import escape_like_pattern


class BeliefStore:
    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn

    def upsert(self, b: BeliefRecord) -> None:
        self._conn.execute(
            """
            INSERT INTO beliefs (
                holder_id, subject_id, topic, claim_text, source_event_id,
                distortion_level, first_heard_week, last_updated_week, confidence
            ) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(holder_id, subject_id, topic) DO UPDATE SET
                claim_text = excluded.claim_text,
                source_event_id = excluded.source_event_id,
                distortion_level = excluded.distortion_level,
                last_updated_week = excluded.last_updated_week,
                confidence = excluded.confidence
            """,
            (
                b.holder_id,
                b.subject_id,
                b.topic,
                b.claim_text,
                b.source_event_id,
                b.distortion_level,
                b.first_heard_week,
                b.last_updated_week,
                b.confidence,
            ),
        )

    def list_for_holder(self, holder_id: str) -> list[BeliefRecord]:
        rows = self._conn.execute(
            "SELECT * FROM beliefs WHERE holder_id = ?", (holder_id,)
        ).fetchall()
        return [
            BeliefRecord(
                holder_id=r["holder_id"],
                subject_id=r["subject_id"],
                topic=r["topic"],
                claim_text=r["claim_text"],
                source_event_id=r["source_event_id"],
                distortion_level=int(r["distortion_level"]),
                first_heard_week=int(r["first_heard_week"]),
                last_updated_week=int(r["last_updated_week"]),
                confidence=float(r["confidence"]),
            )
            for r in rows
        ]

    def search_text(self, query: str, limit: int = 20) -> list[dict[str, Any]]:
        pat = escape_like_pattern(query)
        q = f"%{pat}%"
        rows = self._conn.execute(
            r"""
            SELECT * FROM beliefs
            WHERE claim_text LIKE ? ESCAPE '\' OR topic LIKE ? ESCAPE '\'
            LIMIT ?
            """,
            (q, q, limit),
        ).fetchall()
        return [dict(r) for r in rows]
