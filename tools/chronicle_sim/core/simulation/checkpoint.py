from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

from tools.chronicle_sim.core.storage.snapshot import build_full_snapshot, load_week_snapshot, save_week_snapshot
from tools.chronicle_sim.core.storage.sql_identifiers import require_chronicle_table, validate_column_identifiers


def rollback_to_week(conn: sqlite3.Connection, week_number: int, run_dir: Path) -> None:
    snap = load_week_snapshot(conn, week_number)
    if not snap:
        raise ValueError(f"无第 {week_number} 周快照")
    data = snap.get("data") if isinstance(snap, dict) and "data" in snap else snap
    if not isinstance(data, dict):
        raise ValueError("快照格式错误")
    tables_ordered = [
        "probe_sessions",
        "director_decisions",
        "summaries",
        "rumors",
        "event_witnesses",
        "events",
        "week_intents",
        "beliefs",
        "agent_memories",
        "tier_changes",
        "cold_agent_states",
        "cold_beliefs",
        "cold_memories",
        "social_graph_edges",
        "relationships",
        "anchor_events",
        "npc_state_cards",
        "agents",
        "locations",
        "factions",
        "event_types",
        "runs",
    ]
    conn.execute("PRAGMA foreign_keys = OFF")
    for t in tables_ordered:
        try:
            tn = require_chronicle_table(t)
            conn.execute(f"DELETE FROM {tn}")
        except sqlite3.OperationalError:
            pass
    for t, rows in data.items():
        if t not in tables_ordered or not isinstance(rows, list):
            continue
        try:
            tn = require_chronicle_table(t)
        except ValueError:
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            cols = list(row.keys())
            validate_column_identifiers(cols)
            placeholders = ",".join("?" * len(cols))
            col_names = ",".join(cols)
            try:
                conn.execute(
                    f"INSERT OR REPLACE INTO {tn} ({col_names}) VALUES ({placeholders})",
                    [row[c] for c in cols],
                )
            except sqlite3.OperationalError:
                pass
    conn.execute("PRAGMA foreign_keys = ON")
    conn.commit()
    path = run_dir / "snapshots" / f"week_{week_number:03d}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(snap, ensure_ascii=False, indent=2), encoding="utf-8")
