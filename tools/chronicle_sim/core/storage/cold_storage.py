from __future__ import annotations

import json
import sqlite3
from typing import Any


def freeze_memories(conn: sqlite3.Connection, agent_id: str, week: int, reason: str, rows: list[dict[str, Any]]) -> None:
    conn.execute(
        "INSERT INTO cold_memories (agent_id, frozen_at_week, frozen_reason, payload_json) VALUES (?,?,?,?)",
        (agent_id, week, reason, json.dumps(rows, ensure_ascii=False)),
    )


def freeze_beliefs(conn: sqlite3.Connection, agent_id: str, week: int, rows: list[dict[str, Any]]) -> None:
    conn.execute(
        "INSERT INTO cold_beliefs (agent_id, frozen_at_week, payload_json) VALUES (?,?,?)",
        (agent_id, week, json.dumps(rows, ensure_ascii=False)),
    )


def freeze_agent_state(conn: sqlite3.Connection, agent_id: str, week: int, state: dict[str, Any]) -> None:
    conn.execute(
        "INSERT INTO cold_agent_states (agent_id, frozen_at_week, payload_json) VALUES (?,?,?)",
        (agent_id, week, json.dumps(state, ensure_ascii=False)),
    )


def latest_cold_beliefs(conn: sqlite3.Connection, agent_id: str) -> list[dict[str, Any]] | None:
    row = conn.execute(
        "SELECT payload_json FROM cold_beliefs WHERE agent_id = ? ORDER BY id DESC LIMIT 1",
        (agent_id,),
    ).fetchone()
    if not row:
        return None
    return json.loads(row[0])


def latest_cold_memories(conn: sqlite3.Connection, agent_id: str) -> list[dict[str, Any]] | None:
    row = conn.execute(
        "SELECT payload_json FROM cold_memories WHERE agent_id = ? ORDER BY id DESC LIMIT 1",
        (agent_id,),
    ).fetchone()
    if not row:
        return None
    return json.loads(row[0])


def clear_agent_memories_table(conn: sqlite3.Connection, agent_id: str) -> None:
    conn.execute("DELETE FROM agent_memories WHERE owner_agent_id = ?", (agent_id,))


def clear_beliefs_for_holder(conn: sqlite3.Connection, holder_id: str) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM beliefs WHERE holder_id = ?", (holder_id,)).fetchall()
    out = [dict(r) for r in rows]
    conn.execute("DELETE FROM beliefs WHERE holder_id = ?", (holder_id,))
    return out
