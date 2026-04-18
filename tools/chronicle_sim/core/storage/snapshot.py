from __future__ import annotations

import base64
import json
import sqlite3
from pathlib import Path
from typing import Any

from tools.chronicle_sim.core.storage.sql_identifiers import require_chronicle_table


def _cell_for_json(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, memoryview):
        return _cell_for_json(v.tobytes())
    if isinstance(v, bytes):
        return {
            "__chronicle_blob_b64__": base64.standard_b64encode(v).decode("ascii"),
        }
    return v


def dump_table(conn: sqlite3.Connection, table: str) -> list[dict[str, Any]]:
    t = require_chronicle_table(table)
    rows = conn.execute(f"SELECT * FROM {t}").fetchall()
    out: list[dict[str, Any]] = []
    for r in rows:
        d: dict[str, Any] = {}
        for k in r.keys():
            d[str(k)] = _cell_for_json(r[k])
        out.append(d)
    return out


def build_full_snapshot(conn: sqlite3.Connection) -> dict[str, Any]:
    tables = [
        "runs",
        "agents",
        "tier_changes",
        "cold_memories",
        "cold_beliefs",
        "cold_agent_states",
        "npc_state_cards",
        "factions",
        "locations",
        "relationships",
        "social_graph_edges",
        "beliefs",
        "anchor_events",
        "event_types",
        "events",
        "event_witnesses",
        "rumors",
        "week_intents",
        "summaries",
        "director_decisions",
        "agent_memories",
    ]
    snap: dict[str, Any] = {}
    for t in tables:
        try:
            snap[t] = dump_table(conn, t)
        except sqlite3.OperationalError:
            snap[t] = []
    return snap


def save_week_snapshot(conn: sqlite3.Connection, week_number: int) -> None:
    snap = build_full_snapshot(conn)
    conn.execute(
        """
        INSERT OR REPLACE INTO week_snapshots (week_number, snapshot_json)
        VALUES (?,?)
        """,
        (week_number, json.dumps(snap, ensure_ascii=False)),
    )


def load_week_snapshot(conn: sqlite3.Connection, week_number: int) -> dict[str, Any] | None:
    row = conn.execute(
        "SELECT snapshot_json FROM week_snapshots WHERE week_number = ?",
        (week_number,),
    ).fetchone()
    if not row:
        return None
    return json.loads(row[0])


def write_snapshot_json(path: Path, week_number: int, conn: sqlite3.Connection) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    snap = build_full_snapshot(conn)
    path.write_text(
        json.dumps({"week": week_number, "data": snap}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
